# Modular component registration and static-asset serving in Flask — final answer

**Target under analysis (pinned):** `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`, `git HEAD = 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`git describe --tags` → `3.1.1-30-g85c5d93c`), `CHANGES.rst:1` = `Version 3.2.0`, installed dist version `3.2.0.dev0`, Python 3.13.9 / pytest 8.4.0. All line numbers below refer to this revision; the working tree was verified clean before and after every operation (`git status -s` empty).

---

## 1. One-paragraph answer

**There is no “component registry” in Flask — the modularity in this codebase is (a) *inheritance of one shared registration protocol* plus (b) an explicit *I/O-boundary split*, not a container or plugin registry of components.** The shared registration base is `Scaffold` (`src/flask/sansio/scaffold.py:52`), a class whose docstring says verbatim “Common behavior shared between :class:`~flask.Flask` and :class:`~flask.blueprints.Blueprint`.” Both component kinds inherit it: `class App(Scaffold)` (`src/flask/sansio/app.py:59`, sub-classed by the concrete application `class Flask(App)` at `src/flask/app.py:81`) and `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:119`, sub-classed by the concrete `class Blueprint(SansioBlueprint)` at `src/flask/blueprints.py:18`). `Scaffold` holds *all* registration state (`view_functions`, `error_handler_spec`, `before/after/teardown_request_funcs`, `template_context_processors`, `url_value_preprocessors`, `url_default_functions`) and the entire registration API (`route`/`get`/`post`/…/`add_url_rule`/`endpoint`/`errorhandler`) **plus the static-asset configuration state** (`static_folder`, `static_url_path`, `has_static_folder`). Static-asset **serving**, by contrast, is deliberately kept *out* of `sansio/`, because `src/flask/sansio/README.md` bans I/O and Flask globals in that package; instead there are **two separate concrete implementations** — `Flask.send_static_file` (`src/flask/app.py:308`) and `Blueprint.send_static_file` (`src/flask/blueprints.py:82`) — which `diff` proves are character-for-character identical, each carrying the docstring “Note this is a duplicate of the same method in the Flask class.” Caching stays consistent across both component kinds by a three-part mechanism: each `send_static_file` copy computes `max_age = self.get_send_file_max_age(filename)` and passes it explicitly to `send_from_directory`; each `get_send_file_max_age` copy reads the **single source of truth** `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` (normalizing `timedelta → int seconds`); and the generic helper `flask.helpers._prepare_send_file_kwargs` (`src/flask/helpers.py:387`) only falls back to `current_app.get_send_file_max_age` when the caller passed `max_age=None` — which is precisely why the blueprint copy *must* compute the value itself. Route registration happens at two different lifecycle points for the two component kinds: the app registers eagerly inside `Flask.__init__` (`app.py:262-279`, via a `lambda` holding a `weakref.ref(self)` to avoid a reference cycle, issue #3761), while the blueprint registers deferring-to-app-time inside `Blueprint.register()` (`sansio/blueprints.py:320-328`), where `BlueprintSetupState.add_url_rule` prefixes the rule with the URL prefix and the endpoint with the blueprint name.

---

## 2. The boundary: where the split is drawn

### 2.1 The rule that forces the split — `src/flask/sansio/README.md` (whole file)

```markdown
# Sansio

This folder contains code that can be used by alternative Flask
implementations, for example Quart. The code therefore cannot do any
IO, nor be part of a likely IO path. Finally this code cannot use the
Flask globals.
```

`sansio/` contains exactly three Python modules: `app.py`, `blueprints.py`, `scaffold.py` (plus `README.md`). Because the serving hooks need `current_app` (a Flask global) and `send_from_directory` (I/O), they cannot live in the shared base — hence duplication instead of sharing.

### 2.2 The three layers of the architecture

| Layer | Where | What it owns | Lifecycle |
|---|---|---|---|
| **(a) shared config/registration state** | `Scaffold` (`sansio/scaffold.py:52`) | registration dicts + API, and `_static_folder` / `_static_url_path` / `static_folder` / `static_url_path` / `has_static_folder` | at object construction |
| **(b) eager app-side route registration** | concrete `Flask.__init__` (`app.py:262-279`) | rule `f"{self.static_url_path}/<path:filename>"`, endpoint `"static"`, `host=static_host`, `view_func` a `lambda` over a `weakref` | immediately, inside `Flask(...)` |
| **(c) deferred blueprint-side route registration** | `sansio/blueprints.py` `Blueprint.register` (`:320-328`) → `BlueprintSetupState.add_url_rule` (`:87-117`) | rule `f"{self.static_url_path}/<path:filename>"` and endpoint `"static"`, later prefixed | per `app.register_blueprint(bp)` call |

### 2.3 Layer (b), verbatim — `src/flask/app.py:262-279`

```python
        # Add a static route using the provided static_url_path, static_host,
        # and static_folder if there is a configured static_folder.
        # Note we do this without checking if static_folder exists.
        # For one, it might be created while the server is running (e.g. during
        # development). Also, Google App Engine stores static files somewhere
        if self.has_static_folder:
            assert bool(static_host) == host_matching, (
                "Invalid static_host/host_matching combination"
            )
            # Use a weakref to avoid creating a reference cycle between the app
            # and the view function (see #3761).
            self_ref = weakref.ref(self)
            self.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                endpoint="static",
                host=static_host,
                view_func=lambda **kw: self_ref().send_static_file(**kw),  # type: ignore # noqa: B950
            )
```

`weakref` is imported at `src/flask/app.py:7`. `Flask.__init__` begins at `app.py:226`; the `static_url_path` super-argument is passed at `app.py:241`.

### 2.4 Layer (c), verbatim — `src/flask/sansio/blueprints.py:320-328`

```python
        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)

        if self.has_static_folder:
            state.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                view_func=self.send_static_file,  # type: ignore[attr-defined]
                endpoint="static",
            )
```

and the object that performs the name/prefix resolution, `BlueprintSetupState.add_url_rule`, `src/flask/sansio/blueprints.py:87-117`:

```python
    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: ft.RouteCallable | None = None,
        **options: t.Any,
    ) -> None:
        """A helper method to register a rule (and optionally a view function)
        to the application.  The endpoint is automatically prefixed with the
        blueprint's name.
        """
        if self.url_prefix is not None:
            if rule:
                rule = "/".join((self.url_prefix.rstrip("/"), rule.lstrip("/")))
            else:
                rule = self.url_prefix
        options.setdefault("subdomain", self.subdomain)
        if endpoint is None:
            endpoint = _endpoint_from_view_func(view_func)  # type: ignore
        defaults = self.url_defaults
        if "defaults" in options:
            defaults = dict(defaults, **options.pop("defaults"))

        self.app.add_url_rule(
            rule,
            f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."),
            view_func,
            defaults=defaults,
            **options,
        )
```

`Blueprint.register` is called from the app side by a one-line body in `App.register_blueprint` (`src/flask/sansio/app.py:570`):

```python
        blueprint.register(self, options)
```

**Runtime strings observed (from the reproduction run, §5.3):** the app rule resolves to `('/static/<path:filename>', 'static')`; the blueprint rule resolves to `('/admin/static/<path:filename>', 'admin.static')` for a blueprint with `url_prefix="/admin"`.

### 2.5 Evidence that the app half is layered too

`src/flask/sansio/app.py:282-299` accepts `static_host` but never uses it — it is only consumed by the concrete `Flask` when adding the route:

```python
    def __init__(
        self,
        import_name: str,
        static_url_path: str | None = None,
        static_folder: str | os.PathLike[str] | None = "static",
        static_host: str | None = None,
        host_matching: bool = False,
        subdomain_matching: bool = False,
        template_folder: str | os.PathLike[str] | None = "templates",
        instance_path: str | None = None,
        instance_relative_config: bool = False,
        root_path: str | None = None,
    ) -> None:
        super().__init__(
            import_name=import_name,
            static_folder=static_folder,
            static_url_path=static_url_path,
            template_folder=template_folder,
            root_path=root_path,
        )
```

The internal grep confirms `static_host` occurs in `sansio/app.py` only as a parameter/docstring (lines 132-135, 287) and is otherwise unused, while `host_matching` is consumed at `sansio/app.py:405`: `self.url_map = self.url_map_class(host_matching=host_matching)`.

### 2.6 The shared static-asset configuration surface — `src/flask/sansio/scaffold.py:220-269` (verbatim, re-read from disk)

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError

    @property
    def static_folder(self) -> str | None:
        """The absolute path to the configured static folder. ``None``
        if no static folder is set.
        """
        if self._static_folder is not None:
            return os.path.join(self.root_path, self._static_folder)
        else:
            return None

    @static_folder.setter
    def static_folder(self, value: str | os.PathLike[str] | None) -> None:
        if value is not None:
            value = os.fspath(value).rstrip(r"\/")

        self._static_folder = value

    @property
    def has_static_folder(self) -> bool:
        """``True`` if :attr:`static_folder` is set.

        .. versionadded:: 0.5
        """
        return self.static_folder is not None

    @property
    def static_url_path(self) -> str | None:
        """The URL prefix that the static route will be accessible from.

        If it was not configured during init, it is derived from
        :attr:`static_folder`.
        """
        if self._static_url_path is not None:
            return self._static_url_path

        if self.static_folder is not None:
            basename = os.path.basename(self.static_folder)
            return f"/{basename}".rstrip("/")

        return None

    @static_url_path.setter
    def static_url_path(self, value: str | None) -> None:
        if value is not None:
            value = value.rstrip("/")

        self._static_url_path = value
```

Class-level slots at `sansio/scaffold.py:70-73`:

```python
    cli: Group
    name: str
    _static_folder: str | None = None
    _static_url_path: str | None = None
```

---

## 3. The registration protocol shared by both component kinds

### 3.1 `Scaffold` method surface (line numbers verified by grep in this checkout)

| Method (in `sansio/scaffold.py`) | `@setupmethod` line | `def` line |
|---|---|---|
| `__repr__` | — | 217 |
| `_check_setup_finished` (abstract) | — | 220 |
| `static_folder` (property) | — | 223 (`@property`) / 224 (`def`) |
| `static_folder` (setter) | — | 233/234 |
| `has_static_folder` | — | 240/241 |
| `static_url_path` (property) | — | 248/249 |
| `static_url_path` (setter) | — | 264/265 |
| `_method_route` | — | 284 |
| `get` | 295 | 296 |
| `post` | 303 | 304 |
| `put` | 311 | 312 |
| `delete` | 319 | 320 |
| `patch` | 327 | 328 |
| `route` | 335 | 336 |
| `add_url_rule` (abstract, `raise NotImplementedError`) | 367 | 368 |
| `endpoint` | 435 | 436 |
| `before_request` | 459 | 460 |
| `after_request` | 486 | 487 |
| `teardown_request` | 507 | 508 |
| `context_processor` | 541 | 542 |
| `url_value_preprocessor` | 558 | 559 |
| `url_defaults` | 583 | 584 |
| `errorhandler` | 597 | 598 |
| `register_error_handler` | 641 | 642 |

The base `add_url_rule` is abstract (`sansio/scaffold.py:417-418` → `raise NotImplementedError`), so each component kind supplies its own: `App.add_url_rule` at `sansio/app.py:605` (writes `self.url_map.add(rule_obj)` and `self.view_functions[endpoint] = view_func`) and `Blueprint.add_url_rule` at `sansio/blueprints.py:413` (rejects a `.` in the endpoint then `self.record(...)` a deferred call). `Scaffold.__init__` (`sansio/scaffold.py:75-215`) creates the seven registration dicts; `Blueprint._merge_blueprint_funcs` (`sansio/blueprints.py:379-410`) later merges the blueprint’s dicts into the app under `name`-prefixed keys.

### 3.2 The phase guard is shared; the phase definition differs per component

`setupmethod` (`src/flask/sansio/scaffold.py:42-49`) verbatim:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

Two different `_check_setup_finished` implementations sit behind it.

**App phase** — `src/flask/sansio/app.py:413-421` verbatim:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_first_request:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called"
                " on the application. It has already handled its first"
                " request, any changes will not be applied"
                " consistently.\n"
                "Make sure all imports, decorators, functions, etc."
                " needed to set up the application are done before"
                " running it."
            )
```

**Blueprint phase** — `src/flask/sansio/blueprints.py:213-222` verbatim:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```

`_got_registered_once = False` is a class attribute at `sansio/blueprints.py:172` and is set `True` in `Blueprint.register` at `sansio/blueprints.py:320`; `_got_first_request = False` is set at `sansio/app.py:411`. **Runtime proof of both guards** (reproduction step 7, §5.3): registering a blueprint after the app handled a request raises the app-phase message; decorating a `route` on a blueprint after registration raises the blueprint-phase message.

### 3.3 The two component kinds in the class hierarchy

Runtime MRO from the scratch introspection script:

```
Flask.__mro__      : ['Flask', 'App', 'Scaffold', 'object']
Blueprint.__mro__  : ['Blueprint', 'Blueprint', 'Scaffold', 'object']
Scaffold.__mro__   : ['Scaffold', 'object']

Scaffold defines send_static_file?             False
Scaffold defines get_send_file_max_age?        False
Scaffold defines has_static_folder?            True
Concrete Flask defines __init__?               True
Concrete Flask defines send_static_file?       True
Concrete Flask defines get_send_file_max_age?  True
Concrete Blueprint defines __init__?           True
Concrete Blueprint defines send_static_file?   True
Concrete Blueprint defines get_send_file_max_age? True
```

(`Blueprint.__mro__` prints the name twice because the concrete `flask.Blueprint` subclasses `flask.sansio.blueprints.Blueprint` in a different module.)

---

## 4. The caching contract: how consistency is preserved despite the split

### 4.1 Two separate, byte-identical `send_static_file` bodies

`src/flask/app.py:308-329` verbatim (the `blueprints.py:82-103` copy is character-for-character identical — `diff` exit 0):

```python
    def send_static_file(self, filename: str) -> Response:
        """The view function used to serve files from
        :attr:`static_folder`. A route is automatically registered for
        this view at :attr:`static_url_path` if :attr:`static_folder` is
        set.

        Note this is a duplicate of the same method in the Flask
        class.

        .. versionadded:: 0.5

        """
        if not self.has_static_folder:
            raise RuntimeError("'static_folder' must be set to serve static_files.")

        # send_file only knows to call get_send_file_max_age on the app,
        # call it here so it works for blueprints too.
        max_age = self.get_send_file_max_age(filename)
        return send_from_directory(
            t.cast(str, self.static_folder), filename, max_age=max_age
        )
```

### 4.2 Two separate, byte-identical `get_send_file_max_age` bodies

`src/flask/app.py:281-306` verbatim (identical to `blueprints.py:55-80`, `diff` exit 0):

```python
    def get_send_file_max_age(self, filename: str | None) -> int | None:
        """Used by :func:`send_file` to determine the ``max_age`` cache
        value for a given file path if it wasn't passed.

        By default, this returns :data:`SEND_FILE_MAX_AGE_DEFAULT` from
        the configuration of :data:`~flask.current_app`. This defaults
        to ``None``, which tells the browser to use conditional requests
        instead of a timed cache, which is usually preferable.

        Note this is a duplicate of the same method in the Flask
        class.

        .. versionchanged:: 2.0
            The default configuration is ``None`` instead of 12 hours.

        .. versionadded:: 0.9
        """
        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]

        if value is None:
            return None

        if isinstance(value, timedelta):
            return int(value.total_seconds())

        return value  # type: ignore[no-any-return]
```

### 4.3 The three-part mechanism

**(i) Load-bearing duplication with an explicit justification.** Both copies carry the in-body comment:

```
        # send_file only knows to call get_send_file_max_age on the app,
        # call it here so it works for blueprints too.
```

and both carry the docstring line “Note this is a duplicate of the same method in the Flask class.” (grep for `"Note this is a duplicate"` → exactly 4 hits: `app.py:290`, `app.py:314`, `blueprints.py:64`, `blueprints.py:88`). The duplication is deliberate: `sansio/` is banned from `current_app` and I/O (§2.1), so a single shared base implementation is not permitted.

**(ii) Single source of truth + normalization.** Both `get_send_file_max_age` bodies read exactly one config key, `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` (`app.py:298`, `blueprints.py:72`), and apply the same normalization: `None → None`; `timedelta → int(value.total_seconds())`; otherwise the raw value. The config default is declared once in `Flask.default_config` at `src/flask/app.py:201`:

```python
            "SEND_FILE_MAX_AGE_DEFAULT": None,
```

There are **zero readers of `SEND_FILE_MAX_AGE_DEFAULT` in `sansio/`**.

**(iii) The generic helper only defaults to the app hook when no `max_age` was given.** `src/flask/helpers.py:387-398` verbatim:

```python
def _prepare_send_file_kwargs(**kwargs: t.Any) -> dict[str, t.Any]:
    if kwargs.get("max_age") is None:
        kwargs["max_age"] = current_app.get_send_file_max_age

    kwargs.update(
        environ=request.environ,
        use_x_sendfile=current_app.config["USE_X_SENDFILE"],
        response_class=current_app.response_class,
        _root_path=current_app.root_path,
    )
    return kwargs
```

It is called by both `send_file` (`helpers.py:400`, call site `:512`) and `send_from_directory` (`helpers.py:526`, call site `:566`). Because the fallback is hard-wired to `current_app.get_send_file_max_age`, a bare `send_file`/`send_from_directory` can only ever see the **app** hook — which is exactly why `Blueprint.send_static_file` must call `self.get_send_file_max_age(filename)` and pass `max_age` explicitly. The `send_file` docstring records this history: `.. versionchanged:: 0.9  ``cache_timeout`` defaults to :meth:`Flask.get_send_file_max_age`.`

### 4.4 Historical origin of the contract — `CHANGES.rst:1292-1301`

```
-   ``Flask`` and ``Blueprint`` now provide a ``get_send_file_max_age``
    hook for subclasses to override behavior of serving static files
    from Flask when using ``Flask.send_static_file`` (used for the
    default static file handler) and ``helpers.send_file``. This hook is
    provided a filename, which for example allows changing cache
    controls by file extension. The default max-age for ``send_file``
    and static files can be configured through a new
    ``SEND_FILE_MAX_AGE_DEFAULT`` configuration variable, which is used
    in the default ``get_send_file_max_age`` implementation.
```

### 4.5 The documented config knob — `docs/config.rst:251-261`

```rst
.. py:data:: SEND_FILE_MAX_AGE_DEFAULT

    When serving files, set the cache control max age to this number of
    seconds. Can be a :class:`datetime.timedelta` or an ``int``.
    Override this value on a per-file basis using
    :meth:`~flask.Flask.get_send_file_max_age` on the application or
    blueprint.

    If ``None``, ``send_file`` tells the browser to use conditional
    requests will be used instead of a timed cache, which is usually
    preferable.

    Default: ``None``
```

---

## 5. Verification results

### 5.1 Duplication / consumer audit (counts are integers, not adjectives)

| Quantity | Count | Locations |
|---|---|---|
| `def send_static_file` in `src/` | **2** | `app.py:308`, `blueprints.py:82` |
| `def get_send_file_max_age` in `src/` | **2** | `app.py:281`, `blueprints.py:55` |
| `send_static_file` / `get_send_file_max_age` definitions in `sansio/` | **0** | — (`sansio/blueprints.py:326` only *references* `self.send_static_file` as a `view_func`) |
| Static-route registration sites (`f"{self.static_url_path}/<path:filename>"`) | **2** | `app.py:275` (eager), `sansio/blueprints.py:325` (deferred) |
| `endpoint="static"` literals | **2** | `app.py:276`, `sansio/blueprints.py:327` |
| `has_static_folder` definition sites | **1** | `sansio/scaffold.py:241` |
| `has_static_folder` consumption sites | **4** | registration: `app.py:267`, `sansio/blueprints.py:323`; guards: `app.py:320`, `blueprints.py:94` |
| `SEND_FILE_MAX_AGE_DEFAULT` occurrences in `src/` | **5** | default `app.py:201`; readers `app.py:298`, `blueprints.py:72`; docstring mentions `app.py:285`, `blueprints.py:59` |
| `SEND_FILE_MAX_AGE_DEFAULT` readers in `sansio/` | **0** | — |
| `"Note this is a duplicate"` occurrences | **4** | `app.py:290,314`, `blueprints.py:64,88` |
| `def send_static_file` bodies differing (`diff`) | **0** (identical) | `diff` exit 0 |
| `def get_send_file_max_age` bodies differing (`diff`) | **0** (identical) | `diff` exit 0 |

### 5.2 Upstream regression tests pinning the architecture — all pass

Plan §3 command, verbatim output:

```
$ .venv/Scripts/python.exe -m pytest tests/test_basic.py tests/test_blueprints.py tests/test_helpers.py -k "static or max_age" -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 224 items / 213 deselected / 11 selected

tests/test_basic.py::test_static_files PASSED                            [  9%]
tests/test_basic.py::test_static_url_path PASSED                         [ 18%]
tests/test_basic.py::test_static_url_path_with_ending_slash PASSED       [ 27%]
tests/test_basic.py::test_static_url_empty_path PASSED                   [ 36%]
tests/test_basic.py::test_static_url_empty_path_default PASSED           [ 45%]
tests/test_basic.py::test_static_folder_with_pathlib_path PASSED         [ 54%]
tests/test_basic.py::test_static_folder_with_ending_slash PASSED         [ 63%]
tests/test_basic.py::test_static_route_with_host_matching PASSED         [ 72%]
tests/test_blueprints.py::test_templates_and_static PASSED               [ 81%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [ 90%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [100%]

===================== 11 passed, 213 deselected in 0.25s ======================
EXIT=0
```

Per-claim narrow runs (all `EXIT=0`):

```
$ pytest tests/test_basic.py -k "static" -v
collected 130 items / 122 deselected / 8 selected
tests/test_basic.py::test_static_files PASSED                            [ 12%]
tests/test_basic.py::test_static_url_path PASSED                         [ 25%]
tests/test_basic.py::test_static_url_path_with_ending_slash PASSED       [ 37%]
tests/test_basic.py::test_static_url_empty_path PASSED                   [ 50%]
tests/test_basic.py::test_static_url_empty_path_default PASSED           [ 62%]
tests/test_basic.py::test_static_folder_with_pathlib_path PASSED         [ 75%]
tests/test_basic.py::test_static_folder_with_ending_slash PASSED         [ 87%]
tests/test_basic.py::test_static_route_with_host_matching PASSED         [100%]
====================== 8 passed, 122 deselected in 0.19s ======================

$ pytest tests/test_blueprints.py -k "static or max_age" -v
collected 60 items / 58 deselected / 2 selected
tests/test_blueprints.py::test_templates_and_static PASSED               [ 50%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [100%]
====================== 2 passed, 58 deselected in 0.16s =======================

$ pytest tests/test_helpers.py -k "static" -v
collected 34 items / 33 deselected / 1 selected
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [100%]
====================== 1 passed, 33 deselected in 0.14s =======================

$ pytest tests/test_basic.py::test_app_freed_on_zero_refcount -v
collected 1 item
tests/test_basic.py::test_app_freed_on_zero_refcount PASSED              [100%]
============================== 1 passed in 0.04s ==============================
```

**The C7 precedence case, verbatim from `tests/test_blueprints.py:223-244`:**

```python
def test_default_static_max_age(app):
    class MyBlueprint(flask.Blueprint):
        def get_send_file_max_age(self, filename):
            return 100

    blueprint = MyBlueprint("blueprint", __name__, static_folder="static")
    app.register_blueprint(blueprint)

    # try/finally, in case other tests use this app for Blueprint tests.
    max_age_default = app.config["SEND_FILE_MAX_AGE_DEFAULT"]
    try:
        with app.test_request_context():
            unexpected_max_age = 3600
            if app.config["SEND_FILE_MAX_AGE_DEFAULT"] == unexpected_max_age:
                unexpected_max_age = 7200
            app.config["SEND_FILE_MAX_AGE_DEFAULT"] = unexpected_max_age
            rv = blueprint.send_static_file("index.html")
            cc = parse_cache_control_header(rv.headers["Cache-Control"])
            assert cc.max_age == 100
            rv.close()
    finally:
        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = max_age_default
```

**The C4 weakref guarantee, verbatim from `tests/test_basic.py:1931-1943`:**

```python
@require_cpython_gc
def test_app_freed_on_zero_refcount():
    # A Flask instance should not create a reference cycle that prevents CPython
    # from freeing it when all external references to it are released (see #3761).
    gc.disable()
    try:
        app = flask.Flask(__name__)
        assert app.view_functions["static"]
        weak = weakref.ref(app)
        assert weak() is not None
        del app
        assert weak() is None
    finally:
        gc.enable()
```

**The blueprint-static fixture, verbatim from `tests/test_apps/blueprintapp/apps/admin/__init__.py` (whole file):**

```python
from flask import Blueprint
from flask import render_template

admin = Blueprint(
    "admin",
    __name__,
    url_prefix="/admin",
    template_folder="templates",
    static_folder="static",
)


@admin.route("/")
def index():
    return render_template("admin/index.html")


@admin.route("/index2")
def index2():
    return render_template("./admin/index.html")
```

**Full suite, both modes:** `.venv/Scripts/python.exe -m pytest` → `489 passed in 2.13s` (exit 0); `.venv/Scripts/python.exe -m pytest -vv -rA --tb=long -p no:randomly` → `489 passed in 2.24s` (exit 0, saved verbatim to `/tmp/pytest_full_vv.txt`, 1453 lines / 105,024 bytes). The captured `PASSES` blocks contain deliberately-raised exception tracebacks from negative-path tests (e.g. `test_error_handler_no_match`); no test failed.

### 5.3 Independent behavioural reproduction — 28/28 checks passed

Scratch script `experiments/data/flask-src-scratch/repro_static_architecture.py` (written **outside** the `flask-src` checkout; the whole `experiments/data/` tree is gitignored by `.gitignore:33`). Verbatim resolved rule/endpoint/max-age table:

```
==============================================================================
flask: D:\...\flask-src\src\flask\__init__.py
SCRATCH: D:\...\flask-src-scratch
TESTS  : D:\...\flask-src\tests
==============================================================================

--- step 1: eager app-side registration + weakref (C4) ---
[PASS] C4: exactly one rule with endpoint 'static' :: [('/static/<path:filename>', 'static')]
[PASS] C4: rule literal == '/static/<path:filename>' :: [('/static/<path:filename>', 'static')]
[PASS] C4: view_functions['static'] exists :: <function Flask.__init__.<locals>.<lambda> at 0x...>
[PASS] C4: view closure holds a weakref.ref to the app (issue #3761) :: ['ReferenceType']

--- step 2: deferred blueprint-side registration (C5) ---
[PASS] C5: blueprint static rule prefixed to '/admin/static/<path:filename>' :: [('/admin/static/<path:filename>', 'admin.static')]
[PASS] C5: url_for('admin.static', filename='test.txt') :: '/admin/static/test.txt'
[PASS] C5: GET /admin/static/test.txt serves blueprint file :: status=200 data=b'Admin File\n'
[PASS] C5: GET /admin/static/css/test.css (nested) serves blueprint file :: status=200 data=b'/* nested file */\n'

--- step 3: consistent caching across both components (C6) ---
[PASS] C6: config=None -> app max_age=None / blueprint max_age=None :: app(header='no-cache', max_age=None) bp(header='no-cache', max_age=None)
[PASS] C6: default None -> conditional-cache on BOTH paths (no-cache, no max-age) :: app='no-cache' bp='no-cache'
[PASS] C6: config=3600 -> app max_age=3600 / blueprint max_age=3600 :: app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)
[PASS] C6: config=7200 -> app max_age=7200 / blueprint max_age=7200 :: app(header='public, max-age=7200', max_age=7200) bp(header='public, max-age=7200', max_age=7200)
[PASS] C6: config=datetime.timedelta(seconds=3600) -> app max_age=3600 / blueprint max_age=3600 :: app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)

--- step 4: per-component hook wins over shared config (C7) ---
[PASS] C7: blueprint hook 100 beats config 3600 on blueprint path :: blueprint header='public, max-age=100' max_age=100
[PASS] C7: app path still reads config 3600 (hooks are independent) :: app header='public, max-age=3600' max_age=3600

--- step 5: flask.send_file/send_from_directory fall back to current_app only (C8) ---
[PASS] C8: send_from_directory(no max_age) picks up the APP hook (999) :: header='public, max-age=999' max_age=999
[PASS] C8: explicit max_age=42 bypasses get_send_file_max_age entirely :: header='public, max-age=42' max_age=42
[PASS] C8: blueprint.send_static_file uses the BLUEPRINT hook (100), not the app hook (999) :: header='public, max-age=100' max_age=100

--- step 6: negative / boundary cases ---
   app3 static rules: [('/static/<path:filename>', 'static'), ('/static/<path:filename>', 'noprefix.static')]
[PASS] 6a: blueprint without url_prefix registers endpoint 'noprefix.static' at '/static/<path:filename>' :: [...]
[PASS] 6a: blueprint-only file unreachable under /static (app rule takes precedence) -> 404 :: status=404
[PASS] 6a: /static/index.html still serves the APP static folder :: status=200 data=b'<h1>Hello World!</h1>\n'
[PASS] 6b: send_static_file with static_folder=None raises RuntimeError :: "'static_folder' must be set to serve static_files."
[PASS] 6b: static_folder=None -> no 'static' endpoint at all :: []
[PASS] 6c: static_host without host_matching raises AssertionError :: 'Invalid static_host/host_matching combination'
[PASS] 6c: host_matching=True without static_host raises AssertionError :: 'Invalid static_host/host_matching combination'
[PASS] 6c: host_matching=True + static_host -> static rule carries the host :: [('/static/<path:filename>', 'static')]

--- step 7: shared setupmethod guard (bonus: discovered during run 1) ---
[PASS] 7: register_blueprint after first request raises AssertionError (app-phase guard) :: "The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the application are done before running it."
[PASS] 7: blueprint.route after registration raises AssertionError (blueprint-phase guard) :: "The setup method 'route' can no longer be called on the blueprint 'late2'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
==============================================================================
TOTAL CHECKS: 28   PASS: 28   FAIL: 0
ALL ASSERTIONS PASSED
EXIT=0
```

**Honest disclosure of a failed run and non-zero exits.** Before the passing run, the first draft of the reproduction script crashed (exit 1) because it called `app.register_blueprint(...)` *after* a request had been served. The crash was a harness-ordering defect, not a falsification, and it produced genuinely new evidence (the shared `setupmethod` guard, now step 7). The traceback was preserved byte-for-byte in `repro_static_architecture.py.run1-raw`:

```
AssertionError: The setup method 'register_blueprint' can no longer be called on the application.
It has already handled its first request, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the application are done before running it.
```

Two further non-zero exits were likewise self-inflicted and are reported rather than hidden: a probe of `flask.__version__` raised `AttributeError: module 'flask' has no attribute '__version__'` (on this dev branch the attribute was removed; version is exposed via `importlib.metadata`, reported as `3.2.0.dev0`), and the first `mro_check.py` attempt had a `NameError`, fixed immediately. No tracked file in `flask-src` was modified at any point.

### 5.4 Claim verdicts C1–C9

| # | Claim | Verdict | Basis |
|---|---|---|---|
| C1 | `Scaffold` is the single shared base for `App`/`Flask` and `Blueprint` | **confirmed** | `sansio/scaffold.py:52`; `sansio/app.py:59`; `sansio/blueprints.py:119`; runtime MRO |
| C2 | Static-asset **config** state lives in `Scaffold` | **confirmed** | `sansio/scaffold.py:70-73, 220-269`; `has_static_folder` defined once, consumed 4× |
| C3 | Static-asset **serving** is outside `sansio/` as two explicit duplicates | **confirmed** | 2+2 definitions, `diff` = identical, `sansio/README.md` ban, 4 self-labelling docstrings |
| C4 | App route registered eagerly in `Flask.__init__`, endpoint `"static"`, `host=static_host`, lambda + weakref (#3761) | **confirmed** | `app.py:262-279`; runtime `[('/static/<path:filename>', 'static')]`; closure `['ReferenceType']`; `test_app_freed_on_zero_refcount` passes |
| C5 | Blueprint route registered lazily per `register()`; prefixed to `<url_prefix>/static/<path:filename>` / `<name>.static` | **confirmed** | `sansio/blueprints.py:320-328, 87-117`; runtime `[('/admin/static/<path:filename>', 'admin.static')]`; `url_for` → `/admin/static/test.txt` |
| C6 | Caching consistent: both copies call `self.get_send_file_max_age`; both read `SEND_FILE_MAX_AGE_DEFAULT` with `timedelta` normalization | **confirmed** | both bodies quoted in §4; runtime max-age table identical on both paths for `None/3600/7200/timedelta(hours=1)` |
| C7 | Blueprint subclass hook wins over app config | **confirmed** | `test_default_static_max_age` passes; runtime: blueprint path `max-age=100` while app path stays `3600` |
| C8 | Plain `send_file`/`send_from_directory` fall back to `current_app.get_send_file_max_age` only | **confirmed** | `helpers.py:387-398`; runtime: no-`max_age` call picks up app hook 999; explicit `max_age=42` bypasses it entirely |
| C9 | Blueprint static off by default (`static_folder=None`) and unreachable without `url_prefix` because the app’s `/static` rule wins | **confirmed** | `sansio/blueprints.py:174-192`; runtime: no-prefix blueprint file under `/static` → 404 while app file serves 200 |

**Nothing falsified, nothing left unverified.**

---

## 6. Two honest caveats

### 6.1 Blueprint static files are unreachable without a `url_prefix`

`docs/blueprints.rst:191-217` verbatim:

```rst
Static Files
````````````

A blueprint can expose a folder with static files by providing the path
to the folder on the filesystem with the ``static_folder`` argument.
It is either an absolute path or relative to the blueprint's location::

    admin = Blueprint('admin', __name__, static_folder='static')

By default the rightmost part of the path is where it is exposed on the
web. This can be changed with the ``static_url_path`` argument. Because the
folder is called ``static`` here it will be available at the
``url_prefix`` of the blueprint + ``/static``. If the blueprint
has the prefix ``/admin``, the static URL will be ``/admin/static``.

The endpoint is named ``blueprint_name.static``. You can generate URLs
to it with :func:`url_for` like you would with the static folder of the
application::

    url_for('admin.static', filename='style.css')

However, if the blueprint does not have a ``url_prefix``, it is not
possible to access the blueprint's static folder. This is because the
URL would be ``/static`` in this case, and the application's ``/static``
route takes precedence. Unlike template folders, blueprint static
folders are not searched if the file does not exist in the application
static folder.
```

The same caveat is in the code’s own docstring at `sansio/blueprints.py:144-146`. Runtime confirmation (§5.3 step 6a): a no-prefix blueprint registers a second rule `('/static/<path:filename>', 'noprefix.static')`, but `/static/<file>` still resolves to the app’s rule — the blueprint-only file returns **404** while `/static/index.html` returns the app’s file with `200`. So “consistent caching across both components” is a statement about the *mechanism* (shared config key + parallel hooks), **not** about blueprint static assets always being reachable.

### 6.2 The docstring in `app.py` is self-referentially wrong (a stale copy-paste artifact)

Both `flask/app.py:290` and `flask/app.py:314` say, inside `class Flask` itself:

```
        Note this is a duplicate of the same method in the Flask
        class.
```

That sentence is only true from the *blueprint* side (the blueprint copy duplicates the Flask method). In `app.py` it is a copy-paste remnant; the bodies are identical, so `diff` cannot distinguish them, and the docstrings are the only textual evidence of which class was written first. This matters because the duplication is **load-bearing**: `helpers._prepare_send_file_kwargs` hard-wires the default hook to `current_app.get_send_file_max_age` (`helpers.py:389`) and `sansio/README.md` forbids `current_app`/I/O in the shared base, so “fixing” the apparent redundancy by deleting one copy or hoisting it into `Scaffold` would silently change caching behaviour for exactly one component kind. The safe reading is: two methods, identical bodies, both required.

A third, smaller caveat worth stating: `sansio/app.py:282-299` accepts `static_host` but never consumes it (only the concrete `Flask` uses it at `app.py:277`); the `bool(static_host) == host_matching` invariant is asserted at `app.py:268-270`, verified at runtime in step 6c. And the runner-up caveat from the risk list: `pytest-randomly` is **not** installed here (absent from `pyproject.toml`/`uv.lock` deps), so the `-p no:randomly` flag in the second full-suite run was a no-op guard, not an active plugin.

---

## 7. Adversarial pass — checks 1–5, each resolved

1. **Is “modular component registration” over-claiming? → Supported as a corrected framing.** Grep over `src/flask/` for `register_component|component_registry|plugin_registry|register_plugin|entry_points` yields exactly one hit — `src/flask/cli.py:604: for ep in importlib.metadata.entry_points(group="flask.commands"):` — a **CLI subcommand** discovery hook (`flask.cli._load_plugin_commands`, `cli.py:600-611`), not a component/static-asset registry. Grep for `component` yields exactly one hit, the unrelated comment `src/flask/sansio/app.py:210: #: If a secret key is set, cryptographic components can use this to`. Grep for `registry|registrar|entry point` yields exactly the two prose docstring mentions (`app.py:84`, `sansio/app.py:62`: “…will act as a central registry for the view functions, the URL rules, template configuration and much more”). The answer therefore states “shared base class + two component kinds”, never “plugin system”. Extension in Flask is by subclassing `Flask`/`Blueprint`.
2. **“Both components register a static route” — true at both levels, with a stated default asymmetry → Supported.** App: `if self.has_static_folder:` (`app.py:267`) with `static_folder="static"` as the `Flask.__init__` default (`app.py:231`), i.e. **on** by default. Blueprint: `if self.has_static_folder:` (`sansio/blueprints.py:323`) with `static_folder=None` as the `Blueprint.__init__` default (`sansio/blueprints.py:179`), i.e. **off/opt-in**. The asymmetry is stated in §5.4 C9 and in the `Blueprint` docstring (`sansio/blueprints.py:140-143`: “Blueprint static files are disabled by default”). Runtime: `Flask(__name__, static_folder=None)` produces **zero** `static` endpoints.
3. **`max_age` (a `send_file` argument) vs `get_send_file_max_age` (a hook) → Supported as distinct.** `max_age` is the parameter of `send_file` (`helpers.py:408`) and `send_from_directory` (via `**kwargs`); `get_send_file_max_age` is the overridable hook on `Flask`/`Blueprint`. `_prepare_send_file_kwargs` sets the hook as default **only** when `kwargs.get("max_age") is None` (`helpers.py:388-389`). Runtime proof: an explicit `max_age=42` yields `max-age=42`, bypassing `get_send_file_max_age` entirely, while omitting `max_age` picks up the app hook (999).
4. **Wording “duplicated”, not “shared”, for the serving methods → Supported.** `grep -rn "def send_static_file" src/flask/` → exactly `app.py:308` and `blueprints.py:82`; `diff` of the two bodies exits 0 (identical), and both docstrings self-declare duplication (4 hits). `Scaffold` defines neither method (runtime introspection: `Scaffold defines send_static_file? False`). The answer uses “duplicated” throughout.
5. **Runtime rule/endpoint strings equal the source literals → Supported.** Source literals: `f"{self.static_url_path}/<path:filename>"` + `"static"` at `app.py:275-276` and `sansio/blueprints.py:325,327`. Runtime: app resolves to `('/static/<path:filename>', 'static')`; blueprint resolves to `('/admin/static/<path:filename>', 'admin.static')` — the `admin.` prefix and the `/admin` rule prefix are produced solely by `BlueprintSetupState.add_url_rule`’s f-string (`f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")`) and its `"/".join((self.url_prefix.rstrip("/"), rule.lstrip("/")))`.

All five checks ended in “supported”; the two surviving caveats (§6) are stated in the answer body, not merely in planning notes.

---

## 8. Line-number reconciliation (plan → verified checkout)

Where the planning document’s approximate anchors differed from the verified checkout, the **verified** numbers are used above and the corrections are recorded here: `SEND_FILE_MAX_AGE_DEFAULT` readers are `app.py:298` / `blueprints.py:72` (the plan’s `285`/`59` are the *docstring* mentions); `Scaffold` static properties occupy `scaffold.py:220-269` (plan said `223-269`); `Blueprint.__init__`’s `super().__init__` call is `sansio/blueprints.py:190`; `BlueprintSetupState.add_url_rule` is `sansio/blueprints.py:87-117` (plan said `84-117`); `is not in the public docs` — `Scaffold` has no `docs/api.rst` entry, while `BlueprintSetupState` is publicly re-exported (`src/flask/blueprints.py:14`, `# noqa`). No correction changes any mechanism claim; all nine claims remain confirmed by both static inspection and independent behavioural reproduction.
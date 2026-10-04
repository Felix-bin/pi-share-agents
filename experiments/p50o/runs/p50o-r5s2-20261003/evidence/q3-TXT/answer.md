## Answer: Flask's `Scaffold`-based component registration — how static serving is declared once and registered twice, with identical caching

### 0. Terminology mapping (stated up front, because the question's words are not Flask's words)

"Modular component" = **`Blueprint`**; "main application framework" = **`Flask`**. The codebase never says "modular component registration architecture," but its docs define the vocabulary for exactly this pairing:

> `docs/blueprints.rst:1-20`
> ```
> Modular Applications with Blueprints
> ====================================
> ...
> Flask uses a concept of *blueprints* for making application components and
> supporting common patterns within an application or across applications.
> ...
> A :class:`Blueprint` object works similarly to a :class:`Flask`
> application object, but it is not actually an application.  Rather it is a
> *blueprint* of how to construct or extend an application.
> ```
> `docs/blueprints.rst:49-55`
> ```
> The basic concept of blueprints is that they record operations to execute
> when registered on an application.
> ```

And the static-asset subsystem is not a class at all — it is **configuration declared once on a shared base (`Scaffold`) plus exactly one `add_url_rule` call per component**. Exhaustively:

> `grep "path:filename"` over the whole repo returns exactly two hits (executor R4):
> ```
> src/flask/app.py:275:                 f"{self.static_url_path}/<path:filename>",
> src/flask/sansio/blueprints.py:325:                 f"{self.static_url_path}/<path:filename>",
> ```
> and `grep "SEND_FILE_MAX_AGE_DEFAULT"` over `src/flask/*.py` returns exactly two config reads:
> ```
> src/flask/app.py:201:            "SEND_FILE_MAX_AGE_DEFAULT": None,
> src/flask/app.py:298:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
> src/flask/blueprints.py:72:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
> ```

**There is no separate static-server class/module.** Yes — that absence is the architecture.

Verified scope: this is the upstream Pallets repo, `HEAD = 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, `pyproject.toml:2-3` → `name = "Flask"`, `version = "3.2.0.dev"`, `requires-python = ">=3.10"`, `werkzeug>=3.1.0`. Executor R0 re-confirmed: `git status -s` empty, `git stash list` empty, `Python 3.13.9`, `flask 3.2.0.dev0`, `werkzeug 3.1.3`, `pytest 8.4.0`, installed via `flask.pth` → `...\flask-src\src`.

---

### 1. The shared base: `Scaffold` owns the static contract

`src/flask/sansio/scaffold.py:52-73`:

```python
class Scaffold:
    """Common behavior shared between :class:`~flask.Flask` and
    :class:`~flask.blueprints.Blueprint`.

    :param import_name: The import name of the module where this object
        is defined. Usually :attr:`__name__` should be used.
    :param static_folder: Path to a folder of static files to serve.
        If this is set, a static route will be added.
    :param static_url_path: URL prefix for the static route.
    :param template_folder: Path to a folder containing template files.
        for rendering. If this is set, a Jinja loader will be added.
    :param root_path: The path that static, template, and resource files
        are relative to. Typically not set, it is discovered based on
        the ``import_name``.

    .. versionadded:: 2.0
    """

    cli: Group
    name: str
    _static_folder: str | None = None
    _static_url_path: str | None = None
```

Both constructors just forward these two knobs upward (`scaffold.py:75-88`: `self.static_folder = static_folder` / `self.static_url_path = static_url_path`), and the properties are the single source of asset semantics (`scaffold.py:223-269`):

```python
    @property
    def static_folder(self) -> str | None:
        """The absolute path to the configured static folder. ``None``
        if no static folder is set.
        """
        if self._static_folder is not None:
            return os.path.join(self.root_path, self._static_folder)
        else:
            return None
    ...
    @property
    def has_static_folder(self) -> bool:
        """``True`` if :attr:`static_folder` is set. ..."""
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
```

`add_url_rule` on the base is deliberately abstract (`scaffold.py:368` → `raise NotImplementedError`); the base *describes* assets, it never registers them.

Why this matters: because the description lives in one place, a `Blueprint(..., static_folder="static", url_prefix="/admin")` and a `Flask(..., static_folder="static")` derive their URL prefixes, folder resolution and enable/disable decision from the *same* code — which is the precondition for the caching parity in §4.

Inheritance chain:
- `src/flask/sansio/app.py:59` — `class App(Scaffold):` → `src/flask/app.py:81` — `class Flask(App):`
- `src/flask/sansio/blueprints.py:119` — `class Blueprint(Scaffold):` → `src/flask/blueprints.py:18` — `class Blueprint(SansioBlueprint):`

The `sansio` split exists so alternative frameworks (Quart) can reuse registration logic without I/O:

> `src/flask/sansio/README.md` (whole file)
> ```
> # Sansio
>
> This folder contains code that can be used by alternative Flask
> implementations, for example Quart. The code therefore cannot do any
> IO, nor be part of a likely IO path. Finally this code cannot use the
> Flask globals.
> ```

That constraint is what forces the split in §2/§3: **registration is transport-agnostic (sansio), file serving is WSGI-specific (`flask/app.py`, `flask/blueprints.py`).**

---

### 2. App side — eager registration inside `Flask.__init__`

`src/flask/app.py:262-279` (the whole static block, verbatim):

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

Three design points captured: the endpoint is literally `"static"` (the framework owns `/static`); a `weakref` lambda breaks the app↔view-function cycle (#3761); and the rule string is built from the same `static_url_path` the blueprint uses.

**Nuance the evidence makes explicit:** the *sansio* `App.__init__` (`src/flask/sansio/app.py:282-301`) does **not** register anything — it forwards the config to `Scaffold` and nothing more. Through `sansio/app.py:377-411` (`self.blueprints: dict[str, Blueprint] = {}`, `self.url_map = self.url_map_class(host_matching=host_matching)`) there is no `add_url_rule` call and **no read of `static_host`**; `static_host` appears only in the signature and is consumed solely at `src/flask/app.py:277`. So: the sansio layer *describes*, the WSGI `Flask` class *registers*.

---

### 3. Component side — deferred registration through `BlueprintSetupState` + `record()`

A blueprint cannot touch the URL map at definition time (there is no app yet), so every operation is queued. Four mechanisms, all verified:

**(a) Deferral primitives** — `src/flask/sansio/blueprints.py:224-244`:

```python
    @setupmethod
    def record(self, func: DeferredSetupFunction) -> None:
        """Registers a function that is called when the blueprint is
        registered on the application.  This function is called with the
        state as argument as returned by the :meth:`make_setup_state`
        method.
        """
        self.deferred_functions.append(func)

    @setupmethod
    def record_once(self, func: DeferredSetupFunction) -> None:
        """Works like :meth:`record` but wraps the function in another
        function that will ensure the function is only called once.  If the
        blueprint is registered a second time on the application, the
        function passed is not called.
        """

        def wrapper(state: BlueprintSetupState) -> None:
            if state.first_registration:
                func(state)

        self.record(update_wrapper(wrapper, func))
```

Every route decorator funnels here — `src/flask/sansio/blueprints.py:413-434`:

```python
        self.record(
            lambda s: s.add_url_rule(
                rule,
                endpoint,
                view_func,
                provide_automatic_options=provide_automatic_options,
                **options,
            )
        )
```

**(b) The temporary holder that supplies prefix/subdomain/name namespacing** — `src/flask/sansio/blueprints.py:34-40` and `:87-117`:

```python
class BlueprintSetupState:
    """Temporary holder object for registering a blueprint with the
    application.  An instance of this class is created by the
    :meth:`~flask.Blueprint.make_setup_state` method and later passed
    to all register callback functions.
    """
```
```python
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

This is why the blueprint's `endpoint="static"` becomes **`admin.static`**: the endpoint string is namespaced here, not at the call site.

**(c) The single registration hook** — `src/flask/sansio/blueprints.py:273-335`, containing the deferred static block at `:323-328`:

```python
    def register(self, app: App, options: dict[str, t.Any]) -> None:
        """Called by :meth:`Flask.register_blueprint` to register all
        views and callbacks registered on the blueprint with the
        application. Creates a :class:`.BlueprintSetupState` and calls
        each :meth:`record` callback with it.
        ...
        """
        name_prefix = options.get("name_prefix", "")
        self_name = options.get("name", self.name)
        name = f"{name_prefix}.{self_name}".lstrip(".")

        if name in app.blueprints:
            ...
            raise ValueError(...)

        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
        first_name_registration = name not in app.blueprints

        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)

        if self.has_static_folder:
            state.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                view_func=self.send_static_file,  # type: ignore[attr-defined]
                endpoint="static",
            )

        # Merge blueprint data into parent.
        if first_bp_registration or first_name_registration:
            self._merge_blueprint_funcs(app, name)

        for deferred in self.deferred_functions:
            deferred(state)
```

Note the rule string is **byte-identical** to the app's (`f"{self.static_url_path}/<path:filename>"`), the endpoint is again literally `"static"`, and the `# type: ignore[attr-defined]` is a load-bearing marker: **`send_static_file` does not exist on the sansio `Blueprint`** — it lives in the WSGI subclass `src/flask/blueprints.py:82`. Registration is transport-agnostic; serving is WSGI-specific.

**(d) Merging and nesting** — `src/flask/sansio/blueprints.py:379-408` (`_merge_blueprint_funcs`) namespaces before/after-request, teardown, error handlers and template processors under the blueprint name (`key = name if key is None else f"{name}.{key}"`); nested blueprints compose prefixes/subdomains before recursing (`:337-377`):

```python
            if state.url_prefix is not None and bp_url_prefix is not None:
                bp_options["url_prefix"] = (
                    state.url_prefix.rstrip("/") + "/" + bp_url_prefix.lstrip("/")
                )
            ...
            bp_options["name_prefix"] = name
            blueprint.register(app, bp_options)
```

**App-side entry point is a one-line delegation** — `src/flask/sansio/app.py:570-593`:

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on the application. ...
        Calls the blueprint's :meth:`~flask.Blueprint.register` method after
        recording the blueprint in the application's :attr:`blueprints`.
        """
        blueprint.register(self, options)
```

Observed URL map (executor R3, probe setup):

```
--- app.url_map (rule -> endpoint) ---
  /static/<path:filename>                  -> static
  /admin/static/<path:filename>            -> admin.static
```

So: **two components, two rules, one shared description, two different registration timings** (eager at `Flask.__init__`, deferred to `register_blueprint`).

---

### 4. Caching consistency — why both components behave identically

#### (a) The implemented duplication is literal, and mechanical proof exists

Executor R4 ran `diff` on the two method blocks:

```
$ diff <(sed -n '281,328p' src/flask/app.py) <(sed -n '55,102p' src/flask/blueprints.py)
diff exit=0  (0 == byte-identical)
```

The 48-line block `get_send_file_max_age` + `send_static_file` is **byte-for-byte identical** between `src/flask/app.py:281-328` and `src/flask/blueprints.py:55-102`. Verbatim (from `src/flask/blueprints.py:55-102`; the app copy is the same text):

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

Both docstrings say **"Note this is a duplicate of the same method in the Flask class."** — in *both* files, on *both* methods. The duplication is acknowledged in-source, i.e. **intentional, not accidental**.

Note the indirection above: the blueprint's `get_send_file_max_age` reads `current_app.config[...]`, i.e. **the blueprint has no config of its own**. Config parity is structural — there is only one config object (`Flask.default_config`, `src/flask/app.py:178-210`):

```python
            "MAX_FORM_MEMORY_SIZE": 500_000,
            "MAX_FORM_PARTS": 1_000,
            "SEND_FILE_MAX_AGE_DEFAULT": None,
            "TRAP_BAD_REQUEST_ERRORS": None,
```

#### (b) Why the duplication is *necessary*: werkzeug hard-wires the app hook

`src/flask/helpers.py:387-397`:

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

and the terminal implementation says so in plain English — `.venv/Lib/site-packages/werkzeug/utils.py:500-513`:

```python
    rv.cache_control.no_cache = True

    # Flask will pass app.get_send_file_max_age, allowing its send_file
    # wrapper to not have to deal with paths.
    if callable(max_age):
        max_age = max_age(path)

    if max_age is not None:
        if max_age > 0:
            rv.cache_control.no_cache = None
            rv.cache_control.public = True

        rv.cache_control.max_age = max_age
        rv.expires = int(time() + max_age)  # type: ignore
```

Werkzeug calls **`app.get_send_file_max_age`** only. Since a `Blueprint` is not an app, `Blueprint.send_static_file` must pre-resolve `max_age` itself before delegating — hence the in-source comment *"send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too."* Then it calls `send_from_directory` (`src/flask/helpers.py:565-567`), which likewise injects the app hook via `_prepare_send_file_kwargs`, and werkzeug's `send_from_directory` (`utils.py:538-582`) safe-joins and delegates to `send_file`:

```python
    if "_root_path" in kwargs:
        path_str = os.path.join(kwargs["_root_path"], path_str)

    if not os.path.isfile(path_str):
        raise NotFound()

    return send_file(path_str, environ, **kwargs)
```

So the whole terminal chain — `Cache-Control`, `Expires`, ETag, `make_conditional` (`werkzeug/utils.py:521-523`), ranges — is **shared**, and the app/blueprint duplication exists purely to feed it the right `max_age`.

#### (c) Recorded design intent

`CHANGES.rst:1292-1300`:

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

`CHANGES.rst:587-590` (the 2.0 switch to conditional-by-default):

```
-   ``send_file`` sets ``conditional=True`` and ``max_age=None`` by
    default. ``Cache-Control`` is set to ``no-cache`` if ``max_age`` is
    not set, otherwise ``public``. This tells browsers to validate
    conditional requests instead of using a timed cache. :pr:`3828`
```

`docs/config.rst:250-262` states parity as a documented promise — note it says **"on the application or blueprint"**:

```
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

#### (d) Observed parity — direct reproduction (executor Step 8, 25/25 checks, exit 0)

| Config `SEND_FILE_MAX_AGE_DEFAULT` | `GET /static/test.txt` (app) | `GET /admin/static/test.txt` (blueprint) |
|---|---|---|
| `None` | `Cache-Control: 'no-cache'`, `max_age=None, no_cache=True, public=False` | `Cache-Control: 'no-cache'`, same |
| `3600` | `Cache-Control: 'public, max-age=3600'`, `Expires: 'Sat, 03 Oct 2026 15:01:29 GMT'` | `Cache-Control: 'public, max-age=3600'`, same `Expires` |
| `timedelta(minutes=30)` | `Cache-Control: 'public, max-age=1800'` | `Cache-Control: 'public, max-age=1800'` |

Byte-equal headers were asserted, not just eyeballed:

```
[PASS] A2 app vs blueprint Cache-Control identical (config None)
        app='no-cache' blueprint='no-cache'
[PASS] B2 app vs blueprint Cache-Control identical (config 3600)
        app='public, max-age=3600' blueprint='public, max-age=3600'
[PASS] C2 app vs blueprint identical (timedelta config)
        app='public, max-age=1800' blueprint='public, max-age=1800'
```

**Conditional-request parity** — same ETag string on both routes, both returning 304:

```
  app        If-None-Match: '"1790423795.4026809-11-3478601501"' -> 304
  app        If-Modified-Since: 'Sat, 26 Sep 2026 11:56:35 GMT' -> 304
  blueprint  If-None-Match: '"1790423795.4026809-11-3478601501"' -> 304
  blueprint  If-Modified-Since: 'Sat, 26 Sep 2026 11:56:35 GMT' -> 304
```

**Subclass-override parity** — the hook beats config identically on both sides:

```
=== probe F: subclass override parity (get_send_file_max_age -> 100, config=3600) ===
  app        GET /static/test.txt -> 200  Cache-Control: 'public, max-age=100'
  blueprint  GET /admin/static/test.txt -> 200  Cache-Control: 'public, max-age=100'
```

**Endpoint naming parity:**

```
  url_for('static', filename='test.txt')       = '/static/test.txt'
  url_for('admin.static', filename='test.txt') = '/admin/static/test.txt'
```

Executable test evidence (executor R1/R2):

```
$ .venv/Scripts/python.exe -m pytest tests/test_blueprints.py::test_templates_and_static \
      tests/test_blueprints.py::test_default_static_max_age tests/test_helpers.py -q
....................................                                     [100%]
36 passed in 0.46s
$ .venv/Scripts/python.exe -m pytest tests/test_basic.py -q
130 passed in 1.03s
$ .venv/Scripts/python.exe -m pytest -q
489 passed in 3.45s
```

The relevant tests encode the same claim in-repo:
- `tests/test_blueprints.py:176-212` (`test_templates_and_static`) GETs `/admin/static/test.txt` and `/admin/static/css/test.css`, sets `app.config["SEND_FILE_MAX_AGE_DEFAULT"] = expected_max_age`, asserts `parse_cache_control_header(rv.headers["Cache-Control"]).max_age == expected_max_age`, and asserts `flask.url_for("admin.static", filename="test.txt") == "/admin/static/test.txt"` — i.e. **the app's config drives the blueprint's cache header**.
- `tests/test_blueprints.py:223-244` (`test_default_static_max_age`) — `class MyBlueprint(flask.Blueprint): def get_send_file_max_age(self, filename): return 100` beats a nonzero config; `assert cc.max_age == 100`.
- `tests/test_helpers.py:39-90` (`TestSendfile.test_static_file`) — the app-side mirror, including `class StaticFileApp(flask.Flask): def get_send_file_max_age(self, filename): return 10`.

**Critical semantic caveat (do not paraphrase as "no caching"):** `SEND_FILE_MAX_AGE_DEFAULT = None` means *conditional* caching, per the docstring — *"This defaults to ``None``, which tells the browser to use conditional requests instead of a timed cache, which is usually preferable."* Observed literally as `Cache-Control: no-cache` **plus** `ETag` and `Last-Modified` and working 304s (above). The werkzeug param doc agrees: *"If set, ``Cache-Control`` will be ``public``, otherwise it will be ``no-cache`` to prefer conditional caching"* (`utils.py:369-371`).

---

### 5. Consequences of the architecture (both observable)

**(a) Symmetric extension points.** Because both classes declare `get_send_file_max_age(filename)`, a subclass on either side controls caching by file (e.g. by extension — the documented motivation in `CHANGES.rst:1292-1300`). Verified on both routes (probe F) and by two committed tests (above). `send_static_file` raising `RuntimeError("'static_folder' must be set to serve static_files.")` is likewise duplicated and symmetric.

**(b) The `/static` precedence rule when a blueprint has no `url_prefix`.** Documented at `docs/blueprints.rst:191-217`:

> ```
> The endpoint is named ``blueprint_name.static``. You can generate URLs
> to it with :func:`url_for` like you would with the static folder of the
> application::
>
>     url_for('admin.static', filename='style.css')
>
> However, if the blueprint does not have a ``url_prefix``, it is not
> possible to access the blueprint's static folder. This is because the
> URL would be ``/static`` in this case, and the application's ``/static``
> route takes precedence. Unlike template folders, blueprint static
> folders are not searched if the file does not exist in the application
> static folder.
> ```

and restated in the `Blueprint` docstring (`src/flask/sansio/blueprints.py:145-147`): *"If the blueprint does not have a ``url_prefix``, the app's static route will take precedence, and the blueprint's static files won't be accessible."*

This follows directly from §1: the blueprint's `static_url_path` derives to `/static` from the folder basename, so both rules land on the same URL — and the app's rule was registered first. Executor probe G turned this into the **first executable check** of the rule (retriever F11 had noted `grep -i "precedence" tests/` finds only `test_errorhandler_precedence`, i.e. no test covers it):

```
  np_bp.static_url_path = '/static'
  app2.url_map:
    /static/<path:filename>                  -> static
    /static/<path:filename>                  -> noprefix.static
  GET /static/test.txt     -> 200, body=b'Admin File\n'  (app fixture file is b'Admin File\n')
[PASS] G /static/test.txt serves the APP file, not the blueprint's 'BP FILE'
  GET /static/bp-only.txt  -> 404  (blueprint-only file)
[PASS] G blueprint-only file unreachable at /static (shadowed by app rule)
```

Both rules are present in the map (the blueprint rule *is* registered — the architecture is intact), but the app's rule wins matching. **Version note:** this is a behavior of the recorded SHA `85c5d93c`; it is version-sensitive (CHANGES has touched static-rule edge cases repeatedly, e.g. `700-703`, `821-825`, `639-640`), so it should not be stated as universal.

---

### 6. Fidelity ledger, intentional-trade-off flag, and known gaps

| Claim | Support |
|---|---|
| Shared base owns static config | `sansio/scaffold.py:52-73`, `:75-88`, `:223-269`; quoted |
| App registers eagerly | `app.py:262-279`; quoted; URL map observed |
| Blueprint defers via `record`/`BlueprintSetupState`/`register` | `sansio/blueprints.py:34-40`, `:224-244`, `:273-335`, `:413-434`; quoted |
| Endpoint namespacing `admin.static` | `sansio/blueprints.py:87-117`; probe E observed |
| Sansio `App` registers nothing | `sansio/app.py:282-301`, `:377-411`; retriever F4 |
| Identical `get_send_file_max_age`/`send_static_file` | `app.py:281-328` vs `blueprints.py:55-102`; quoted + `diff` exit 0 |
| One config object | `app.py:178-210`, `:298`; `blueprints.py:72`; grep = 2 reads |
| werkzeug hard-wires app hook | `helpers.py:387-397`; `werkzeug/utils.py:500-513`; quoted |
| `None` ⇒ `no-cache` + ETag/304, not "no caching" | `app.py:285-289` docstring; `werkzeug/utils.py:369-371`; probe A/D observed |
| `timedelta` ⇒ seconds | source `isinstance(value, timedelta)`; probe C observed `1800` |
| Overrides symmetric | probes F (both), `tests/test_blueprints.py:223-244`, `tests/test_helpers.py:39-90`; 36/36 pass |
| Precedence rule | `docs/blueprints.rst:191-217`, `sansio/blueprints.py:145-147`; probe G observed (no committed test exists) |

**The duplication is a designed consequence, not a defect.** It is documented in-source on both methods ("Note this is a duplicate of the same method in the Flask class."), explained by the `sansio` no-I/O constraint, and forced by werkzeug's single-hook signature. A summarizer that reports it as an accident or a bug would contradict `CHANGES.rst:1292-1300`.

**Honest bounds:**
- Everything above is tied to `HEAD = 85c5d93c`; the repo is a pristine upstream checkout (executor R0/R5: `git status --porcelain` empty, no stash, HEAD unchanged, scratch script and temp blueprint dir deleted — no untracked artifacts left).
- The no-`url_prefix` precedence rule and the `no-cache`→`public, max-age=3600` transition were flagged by the retriever as **unverified** (F12: no shell tooling) and are now **observed** (probes A/B/G); nothing was left inferred.
- Two verbatim API gotchas worth carrying forward: at this SHA `flask.__version__` raises `AttributeError: module 'flask' has no attribute '__version__'` (use `importlib.metadata.version("flask")`), and `werkzeug.http.parse_cache_control_header()` defaults to `RequestCacheControl` (no `.public`/`.no_cache` response attrs) — use `rv.cache_control`, whose absent flags read `False`, not `None`. The executor's first two probe runs failed on these probe-authoring issues, not on Flask behavior; the corrected run was 25/25.
- No source edit was made or warranted: the question is descriptive and this checkout is not ours to modify.
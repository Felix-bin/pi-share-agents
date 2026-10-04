# Flask's Modular Static-Asset Registration vs. Framework Core

## The complete answer

Flask's static-asset machinery is split across a **three-tier architecture** introduced deliberately in 3.0.0: a single shared `Scaffold` base holding static-path configuration state, two sans-IO (`App`, `Blueprint`) bases in `src/flask/sansio/` that own registration and merge logic, and two concrete WSGI classes (`Flask(App)`, `Blueprint(SansioBlueprint)`) in `src/flask/` that own the I/O tier (request/response objects, `cli`, `send_static_file`, `get_send_file_max_age`). Registration **diverges by lifecycle** — the app registers its `static` route eagerly in `__init__`, while the blueprint defers it to `register()` through `BlueprintSetupState.add_url_rule` — yet **caching stays consistent** because both concrete classes carry byte-for-byte identical `send_static_file`/`get_send_file_max_age` bodies that read the same `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` key and both funnel through the same `flask.helpers.send_from_directory`. The whole design is anchored by the changelog: `CHANGES.rst:100-101` — **"Restructure the code such that the Flask (app) and Blueprint classes have Sans-IO bases. :pr:`5127`"** (Version 3.0.0, released 2023-09-30).

Below, every claim is tied to its quoted supporting passage.

---

## 1. The architectural intent is explicitly named in the changelog

`CHANGES.rst:92-103`:

```
Version 3.0.0
-------------

Released 2023-09-30

-   Remove previously deprecated code. :pr:`5223`
-   Deprecate the ``__version__`` attribute. Use feature detection, or
    ``importlib.metadata.version("flask")``, instead. :issue:`5230`
-   Restructure the code such that the Flask (app) and Blueprint
    classes have Sans-IO bases. :pr:`5127`
-   Allow self as an argument to url_for. :pr:`5264`
-   Require Werkzeug >= 3.0.0.
```

This is the "modular component registration architecture" at issue: a sans-IO core plus concrete WSGI layers. The modular split is deliberate, not incidental.

The boundary rule is restated as a follow-up fix in `CHANGES.rst:65-66` (Version 3.0.3, released 2024-04-07):

```
-   Don't initialize the ``cli`` attribute in the sansio scaffold, but rather in
    the ``Flask`` concrete class. :pr:`5270`
```

And the sans-IO tier's governing constraint lives in `src/flask/sansio/README.md:1-6` (full file):

```
# Sansio

This folder contains code that can be used by alternative Flask
implementations, for example Quart. The code therefore cannot do any
IO, nor be part of a likely IO path. Finally this code cannot use the
Flask globals.
```

So the sans-IO tier must not do I/O, must not be in a likely I/O path, and **must not use the Flask globals** (`current_app`, `request`, `g`, etc.). This is precisely why `send_static_file`/`get_send_file_max_age` — which call `current_app.config[...]` and `send_from_directory` — live in the concrete `src/flask/` classes, not in `src/flask/sansio/`.

---

## 2. The three-tier stack, established from the module map and inheritance graph

`src/flask/` contains the concrete WSGI-layer modules (`app.py`, `blueprints.py`, plus `helpers.py`, `ctx.py`, `wrappers.py`, `cli.py`, etc.), while `src/flask/sansio/` contains exactly three Python modules — `scaffold.py` (shared base), `app.py` (sans-IO app base), `blueprints.py` (sans-IO blueprint base) — plus `README.md`.

The class-definition sites (from grep):

```
src/flask/sansio/scaffold.py:52: class Scaffold:
src/flask/sansio/app.py:59: class App(Scaffold):
src/flask/sansio/blueprints.py:119: class Blueprint(Scaffold):
src/flask/app.py:81: class Flask(App):
src/flask/blueprints.py:18: class Blueprint(SansioBlueprint):
```

The runtime MRO confirms the full graph:

```
Flask   MRO: ['flask.app.Flask', 'flask.sansio.app.App', 'flask.sansio.scaffold.Scaffold', 'builtins.object']
Blueprint MRO: ['flask.blueprints.Blueprint', 'flask.sansio.blueprints.Blueprint', 'flask.sansio.scaffold.Scaffold', 'builtins.object']
issubclass(Flask, App): True
issubclass(App, Scaffold): True
issubclass(Blueprint, SansioBlueprint): True
issubclass(SansioBlueprint, Scaffold): True
```

The import wiring is visible at `src/flask/app.py:44-45`:

```python
from .sansio.app import App
from .sansio.scaffold import _sentinel
```

and at `src/flask/blueprints.py:10-12`:

```python
from .sansio.blueprints import Blueprint as SansioBlueprint
from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
from .sansio.scaffold import _sentinel
```

The `sansio/app.py:31-34` imports pull in the back-edge to `Scaffold`:

```python
from .scaffold import _endpoint_from_view_func
from .scaffold import find_package
from .scaffold import Scaffold
from .scaffold import setupmethod
```

Note the blueprint setup state is re-exported with `# noqa` at `src/flask/blueprints.py:11`: the public `flask.blueprints.BlueprintSetupState` name *is* the sans-IO one (`flask.sansio.blueprints`), deliberately surfaced through the concrete module.

**Boundary classification table:**

| Module | Tier | Class defined | Why it belongs there |
|---|---|---|---|
| `src/flask/sansio/scaffold.py` | Tier 1 — shared sans-IO base | `Scaffold` (`:52`) | Holds `static_folder`/`static_url_path`/`has_static_folder` state and the `_check_setup_finished` abstract contract. No `current_app`/`request` usage. |
| `src/flask/sansio/app.py` | Tier 2 — sans-IO app | `App(Scaffold)` (`:59`) | Owns `url_map`, `view_functions`, `add_url_rule`, `register_blueprint`, `_check_setup_finished` (`:413`). `default_config` is a forward declaration only (`:279`). |
| `src/flask/sansio/blueprints.py` | Tier 2 — sans-IO blueprint | `Blueprint(Scaffold)` (`:119`), `BlueprintSetupState` (`:34`) | Owns `deferred_functions`, `record`/`record_once`, `register()` (`:273`), and `BlueprintSetupState.add_url_rule` (`:87`). Contains deferred static registration at `:323-328`. |
| `src/flask/app.py` | Tier 3 — concrete WSGI app | `Flask(App)` (`:81`) | Owns `request_class`/`response_class`/`session_interface` (`:212-224`), `cli = cli.AppGroup()` (`:256`), the eager static route (`:267-279`), and the duplicated `get_send_file_max_age` (`:281`) / `send_static_file` (`:308`). |
| `src/flask/blueprints.py` | Tier 3 — concrete WSGI blueprint | `Blueprint(SansioBlueprint)` (`:18`) | Owns `cli = AppGroup()` (`:49`) and the duplicated `get_send_file_max_age` (`:55`) / `send_static_file` (`:82`). |

---

## 3. A single shared `Scaffold` holds static-path configuration state

`src/flask/sansio/scaffold.py:52-73` (class docstring and class attributes):

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

`Scaffold.__init__` (`sansio/scaffold.py:75-100`) lands the static config in the shared base:

```python
    def __init__(
        self,
        import_name: str,
        static_folder: str | os.PathLike[str] | None = None,
        static_url_path: str | None = None,
        template_folder: str | os.PathLike[str] | None = None,
        root_path: str | None = None,
    ):
        ...
        self.static_folder = static_folder
        self.static_url_path = static_url_path
```

The `static_folder` property/setter and `has_static_folder` at `src/flask/sansio/scaffold.py:223-246`:

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
```

And the `static_url_path` property/setter at `src/flask/sansio/scaffold.py:248-269`:

```python
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

**Proof this is not duplicated:** grep for `has_static_folder` returns exactly one definition and four consumers:

```
src/flask/sansio/scaffold.py:241: def has_static_folder(self) -> bool:      # the single definition
src/flask/app.py:267: if self.has_static_folder:                             # app eager registration
src/flask/app.py:320: if not self.has_static_folder:                         # app send_static_file guard
src/flask/blueprints.py:94: if not self.has_static_folder:                   # blueprint send_static_file guard
src/flask/sansio/blueprints.py:323: if self.has_static_folder:               # blueprint deferred registration
```

The runtime check confirms ownership decisively:

```
static_folder on Flask mro: ['flask.sansio.scaffold.Scaffold']
static_url_path on Flask mro: ['flask.sansio.scaffold.Scaffold']
has_static_folder on Flask mro: ['flask.sansio.scaffold.Scaffold']
```

The shared *state and predicate* live once in `Scaffold`; only the *registration lifecycle* is split. Both `App.__init__` (`sansio/app.py:282-301`) and `Blueprint.__init__` (`sansio/blueprints.py:180-193`) merely forward `static_folder`/`static_url_path` to `super().__init__(...)`, which is `Scaffold.__init__`.

---

## 4. Registration diverges by lifecycle: app **eager**, blueprint **deferred**

### (a) App registers the `static` route eagerly in its constructor

`src/flask/app.py:252-279` (the full block, including the `cli` init that 3.0.3 moved here):

```python
        #: The Click command group for registering CLI commands for this
        #: object. The commands are available from the ``flask`` command
        #: once the application has been discovered and blueprints have
        #: been registered.
        self.cli = cli.AppGroup()

        # Set the name of the Click group in case someone wants to add
        # the app's commands to another CLI tool.
        self.cli.name = self.name

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

Key points:
- The rule is `f"{self.static_url_path}/<path:filename>"` with the **literal endpoint name `"static"`**.
- The view function is a lambda closing over `weakref.ref(self)`, explicitly to break the app↔view-function reference cycle (`#3761`).
- The assertion `assert bool(static_host) == host_matching` is the host-matching constraint, and it is nested inside `if self.has_static_folder:`, so it only fires when a static route would actually be created.
- The comment "Note we do this without checking if static_folder exists" documents the eager-registration decision.

Runtime confirmation that the route exists at construction:

```
view_functions keys after Flask(): ['static']
'static' eager endpoint present: True
url_map rules: ['/static/<path:filename>']
url_for("static", filename="index.html") = /static/index.html
```

### (b) Blueprint registers its `static` route lazily, at `register()` time

`src/flask/sansio/blueprints.py:315-336`:

```python
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

Contrasts with the app path:
- The rule string is constructed identically, and the endpoint is again literally `"static"`, but it is passed through `state.add_url_rule`, not `self.add_url_rule`.
- The view function is `self.send_static_file`, **not** a weakref lambda, carrying a `# type: ignore[attr-defined]` because `send_static_file` is defined only on the concrete `src/flask/blueprints.py` subclass.
- Registration happens only inside `register()`, i.e. lazily at `app.register_blueprint(bp)` time, not at `Blueprint(...)` construction time.
- It is registered *before* `self._merge_blueprint_funcs(app, name)` and *before* the user's `deferred_functions` are drained.

Runtime confirmation that the blueprint route appears only after registration:

```
app view functions before register: ['static']
'admin.static' before register: False
routes before register: ['/static/<path:filename>']

app view functions after register: ['admin.static', 'static']
'admin.static' after register: True
routes after register: ['/admin/static/<path:filename>', '/static/<path:filename>']
url_for("admin.static", filename="test.txt") = /admin/static/test.txt
```

The dispatch chain is `Flask.register_blueprint` → `blueprint.register(self, options)` (sans-IO, `sansio/app.py:569-595`):

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        ...
        blueprint.register(self, options)
```

### (c) The `BlueprintSetupState.add_url_rule` endpoint-prefixing bridge

`src/flask/sansio/blueprints.py:87-116`:

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

The endpoint passed in as `"static"` (line 327) is rewritten at line 112 to `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")`. For a blueprint named `admin` registered with no `name_prefix` and no `name` override, this evaluates to `".admin.static".lstrip(".")` = `"admin.static"` — exactly the endpoint asserted in the tests.

### (d) Both paths terminate in the same `App.add_url_rule`

`src/flask/sansio/app.py:604-661` shows the terminal call mutating `self.url_map` and `self.view_functions`:

```python
        rule_obj = self.url_rule_class(rule, methods=methods, **options)
        rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]

        self.url_map.add(rule_obj)
        if view_func is not None:
            old_func = self.view_functions.get(endpoint)
            if old_func is not None and old_func != view_func:
                raise AssertionError(
                    "View function mapping is overwriting an existing"
                    f" endpoint function: {endpoint}"
                )
            self.view_functions[endpoint] = view_func
```

So the divergence is purely about *when* that terminal call happens and *what endpoint string* is used.

Note the asymmetry with ordinary blueprint rules: `Blueprint.add_url_rule` (`sansio/blueprints.py:412-441`) defers via `self.record(lambda s: s.add_url_rule(...))`, while the static rule bypasses that generic deferred mechanism and calls `state.add_url_rule(...)` directly inside `register()`.

### (e) The lifecycle split mirrors the `_check_setup_finished` contract

The `Scaffold` declares the abstract contract at `sansio/scaffold.py:220-221`:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

Each sans-IO subclass supplies its own "setup is frozen" trigger. App — `sansio/app.py:413-423`:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_first_request:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called"
                " on the application. It has already handled its first"
                " request, any changes will not be applied"
                " consistently.\n"
                ...
```

Blueprint — `sansio/blueprints.py:213-221`:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                ...
```

Grep confirms exactly two implementations:

```
src/flask/sansio/app.py:413: def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/blueprints.py:213: def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/scaffold.py:46: self._check_setup_finished(f_name)
src/flask/sansio/scaffold.py:220: def _check_setup_finished(self, f_name: str) -> None:
```

App's trigger is *first request served*; the blueprint's is *registered at least once* — the same lifecycle split governing static registration.

---

## 5. Caching stays consistent: identical bodies, one shared config key, one shared send helper

### (a) The duplicated `get_send_file_max_age`

App side `src/flask/app.py:281-306`:

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

Blueprint side `src/flask/blueprints.py:55-80` is byte-for-byte identical (same docstring including the same "Note this is a duplicate of the same method in the Flask class."). Runtime `inspect.getsource` comparison confirmed:

```
get_send_file_max_age identical bodies?: True
```

### (b) The duplicated `send_static_file`

App side `src/flask/app.py:308-328`:

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

Blueprint side `src/flask/blueprints.py:82-102` is byte-for-byte identical, including the same reason comment. Runtime comparison confirmed:

```
send_static_file identical?: True
```

### (c) The self-labelling duplication markers

Grep `duplicate of the same method` yields exactly four hits — two per file, one for each duplicated method:

```
src/flask/app.py:290: Note this is a duplicate of the same method in the Flask
src/flask/app.py:314: Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:64: Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:88: Note this is a duplicate of the same method in the Flask
```

(The note appearing *inside* the `Flask` class at `app.py:290` reads "duplicate of the same method in the Flask class" — a pre-existing docstring-wording artifact of the copy direction. It is the clearest textual marker that the two bodies were produced by duplication rather than abstraction.)

Ownership checks confirm both methods exist only in the concrete tier:

```
send_static_file on Flask mro: ['flask.app.Flask']
send_static_file on Blueprint mro: ['flask.blueprints.Blueprint']
get_send_file_max_age on Flask mro: ['flask.app.Flask']
get_send_file_max_age on Blueprint mro: ['flask.blueprints.Blueprint']
SansioBlueprint owns send_static_file?: False
SansioBlueprint owns get_send_file_max_age?: False
Scaffold owns send_static_file?: False
```

### (d) The single shared config key

`SEND_FILE_MAX_AGE_DEFAULT` is defined once, at `src/flask/app.py:201`, inside `default_config = ImmutableDict({...})`:

```python
            "SEND_FILE_MAX_AGE_DEFAULT": None,
```

and consumed identically by both concrete classes — `src/flask/app.py:298` and `src/flask/blueprints.py:72`:

```python
        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
```

Because a Flask app's config is global to the app, a blueprint-served file reads the **same** app config value an app-served file reads. That is the mechanism that keeps caching uniform despite the duplicated method bodies. Runtime confirmation:

```
Default SEND_FILE_MAX_AGE_DEFAULT: None
```

### (e) The shared send primitive

Both concrete components import and call the same helper — `src/flask/app.py:43` and `src/flask/blueprints.py:9`:

```python
from .helpers import send_from_directory
```

`src/flask/helpers.py:526-567` shows it wraps Werkzeug:

```python
def send_from_directory(
    directory: os.PathLike[str] | str,
    path: os.PathLike[str] | str,
    **kwargs: t.Any,
) -> Response:
    """Send a file from within a directory using :func:`send_file`.
    ...
    .. versionadded:: 2.0
        Moved the implementation to Werkzeug. This is now a wrapper to
        pass some Flask-specific arguments.
    ...
    """
    return werkzeug.utils.send_from_directory(  # type: ignore[return-value]
        directory, path, **_prepare_send_file_kwargs(**kwargs)
    )
```

Neither duplicated `send_static_file` re-implements file serving; only the max-age resolution is duplicated.

### (f) *Why* the duplication cannot simply be hoisted into `Scaffold`

`src/flask/helpers.py:387-397` reveals the mechanism:

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

When no explicit `max_age` is given, `_prepare_send_file_kwargs` passes `current_app.get_send_file_max_age` (a bound method of the **app**) as the `max_age` callable to Werkzeug. Therefore an app-served file automatically picks up an app-level override; but a blueprint-served file would *not*, because `current_app` is the app, not the blueprint. So the blueprint's `send_static_file` must proactively compute `max_age = self.get_send_file_max_age(filename)` and pass it explicitly — causing `kwargs.get("max_age") is None` to be `False` and skipping the app-callable substitution. The comment at `src/flask/app.py:323-324` / `src/flask/blueprints.py:97-98` says exactly this:

```
        # send_file only knows to call get_send_file_max_age on the app,
        # call it here so it works for blueprints too.
```

The duplication cannot be hoisted into `Scaffold` because (1) the sans-IO tier cannot use `current_app` (per `sansio/README.md`), and (2) the concrete tier has different "who gets to override" semantics for app vs. blueprint. This is the deliberate trade-off the in-code note marks.

---

## 6. `cli` ownership: annotation in `Scaffold`, instantiation in the concrete classes

`src/flask/sansio/scaffold.py:70` annotates only:

```python
    cli: Group
```

Runtime confirms it is annotation-only:

```
'cli' in Scaffold.__dict__?: False
Scaffold annotations cli: Group
```

The concrete classes create the Click groups — `src/flask/app.py:256`:

```python
        self.cli = cli.AppGroup()
```

and `src/flask/blueprints.py:49`:

```python
        self.cli = AppGroup()
```

Runtime confirms `Flask __init__ sets cli: True` and `Blueprint concrete __init__ sets cli AppGroup: True`. This exactly matches the changelog entry `CHANGES.rst:65-66`.

Two other benign conventions worth noting:
- `default_config: dict[str, t.Any]` is only annotated on the sans-IO `App` (`sansio/app.py:279`), while `src/flask/app.py:178-210` supplies the actual `ImmutableDict`. Consumer `sansio/app.py:494` (`defaults = dict(self.default_config)`) relies on the concrete subclass.
- `src/flask/sansio/blueprints.py:326` — `view_func=self.send_static_file,  # type: ignore[attr-defined]` — is the single clearest tier-boundary bleed in the static-asset code path: the sans-IO `Blueprint.register()` names a method supplied only by its concrete subclass. It is structurally inescapable (`send_static_file` requires `current_app`, which the README forbids) and explicitly acknowledged by the `# type: ignore`.

---

## 7. The tested contract

**App static route and endpoint name** — `tests/test_basic.py:1403-1409`:

```python
def test_static_files(app, client):
    rv = client.get("/static/index.html")
    assert rv.status_code == 200
    assert rv.data.strip() == b"<h1>Hello World!</h1>"
    with app.test_request_context():
        assert flask.url_for("static", filename="index.html") == "/static/index.html"
    rv.close()
```

**Blueprint static serving, `url_for`, and max-age propagation** — `tests/test_blueprints.py:176-220` (key assertions):

```python
    rv = client.get("/admin/static/test.txt")
    assert rv.data.strip() == b"Admin File"
    ...
    rv = client.get("/admin/static/css/test.css")
    assert rv.data.strip() == b"/* nested file */"
    ...
        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = expected_max_age
        rv = client.get("/admin/static/css/test.css")
        cc = parse_cache_control_header(rv.headers["Cache-Control"])
        assert cc.max_age == expected_max_age
    ...
    with app.test_request_context():
        assert (
            flask.url_for("admin.static", filename="test.txt")
            == "/admin/static/test.txt"
        )
```

**Blueprint subclass override wins over app config** — `tests/test_blueprints.py:223-244`:

```python
def test_default_static_max_age(app):
    class MyBlueprint(flask.Blueprint):
        def get_send_file_max_age(self, filename):
            return 100

    blueprint = MyBlueprint("blueprint", __name__, static_folder="static")
    app.register_blueprint(blueprint)
    ...
            app.config["SEND_FILE_MAX_AGE_DEFAULT"] = unexpected_max_age
            rv = blueprint.send_static_file("index.html")
            cc = parse_cache_control_header(rv.headers["Cache-Control"])
            assert cc.max_age == 100
```

**`None` → `3600` on both app handler and direct `send_file`** — `tests/test_helpers.py:44-63`:

```python
    def test_static_file(self, app, req_ctx):
        # Default max_age is None.

        # Test with static file handler.
        rv = app.send_static_file("index.html")
        assert rv.cache_control.max_age is None
        ...
        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 3600

        # Test with static file handler.
        rv = app.send_static_file("index.html")
        assert rv.cache_control.max_age == 3600
```

**Host-matching constraint** — production `src/flask/app.py:268-270` and test `tests/test_basic.py:1468-1486`, which asserts `url_for("static", filename="index.html", _external=True) == "http://example.com/static/index.html"` and raises `AssertionError` for the two invalid combinations while allowing `host_matching=True, static_folder=None`.

### Executed verification

The four validating tests plus the host-matching test were run under pytest and **all passed**:

```
tests/test_basic.py::test_static_files PASSED                            [ 12%]
tests/test_basic.py::test_static_url_path PASSED                         [ 25%]
tests/test_basic.py::test_static_route_with_host_matching PASSED         [ 37%]
tests/test_blueprints.py::test_templates_and_static PASSED               [ 50%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [ 62%]
tests/test_helpers.py::TestSendfile::test_send_file PASSED               [ 75%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [ 87%]
tests/test_helpers.py::TestSendfile::test_send_from_directory PASSED     [100%]

============================== 8 passed in 0.38s ==============================
```

Runtime behaviour was also reproduced directly:

```
GET /static/index.html status: 200 data: b'<h1>Hello World!</h1>'
url_for static == /static/index.html: True
blueprint /admin/static/test.txt status: 200 data: b'Admin File'
blueprint /admin/static/css/test.css status: 200 data: b'/* nested file */'
url_for admin.static == /admin/static/test.txt: True
default SEND_FILE_MAX_AGE_DEFAULT on app: None
blueprint-served cc.max_age after config=3600: 3600
```

The blueprint subclass override test:

```
blueprint subclass override cc.max_age (expect 100, app config=3600): 100
app-served max_age with same config (expect 3600): 3600
```

Host-matching + weakref cycle break:

```
  AssertionError for {'static_host': 'example.com'} -> Invalid static_host/host_matching combination
  AssertionError for {'host_matching': True} -> Invalid static_host/host_matching combination
  host_matching=True static_folder=None -> NO error (as expected)

app.view_functions['static'] truthy: True
weakref alive before del: True
weakref dead after del (no cycle): True
```

The weakref behaviour is guarded by `tests/test_basic.py:1931-1944` (`test_app_freed_on_zero_refcount`):

```python
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

---

## Conclusion

**(a)** A single `Scaffold` in `src/flask/sansio/scaffold.py` holds `static_folder`, `static_url_path`, and `has_static_folder` — one definition, four consumers.

**(b)** Two sans-IO bases — `App` (`sansio/app.py:59`) and `Blueprint` (`sansio/blueprints.py:119`) — own `add_url_rule`, `register_blueprint`/`register`, the deferred-function machinery, and the `BlueprintSetupState` bridge.

**(c)** Two concrete WSGI classes — `Flask(App)` (`app.py:81`) and `Blueprint(SansioBlueprint)` (`blueprints.py:18`) — own request/response objects, `session_interface`, `cli`, `send_static_file`, and `get_send_file_max_age`.

**(d)** Registration diverges by lifecycle: the app registers the `static` route eagerly in `__init__` (`app.py:267-279`, guarded by `if self.has_static_folder:` with the `weakref.ref` anti-cycle and the host-matching assertion); the blueprint defers it to `register()` through `BlueprintSetupState.add_url_rule` (`sansio/blueprints.py:323-328`), which prefixes the endpoint to `"<bp>.static"` at `sansio/blueprints.py:112`. Both paths terminate in the same sans-IO `App.add_url_rule`.

**(e)** Caching stays consistent because both concrete classes carry identical `send_static_file`/`get_send_file_max_age` bodies that read the same `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` (default `None` at `app.py:201`) and both funnel through the same `flask.helpers.send_from_directory`, with the in-code note "this is a duplicate of the same method in the Flask class" marking the deliberate trade-off that lets blueprints override `get_send_file_max_age` (test at `test_blueprints.py:223-244`). The reason is spelled out at `app.py:323-324`/`blueprints.py:97-98`: "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too."

**(f)** The whole architecture is anchored by the changelog line **"Restructure the code such that the Flask (app) and Blueprint classes have Sans-IO bases. :pr:`5127`"** (`CHANGES.rst:100-101`), with the boundary rules restated at `CHANGES.rst:65-66` (the `cli` fix) and `src/flask/sansio/README.md:3-6` ("This folder contains code that can be used by alternative Flask implementations, for example Quart. The code therefore cannot do any IO, nor be part of a likely IO path. Finally this code cannot use the Flask globals.").
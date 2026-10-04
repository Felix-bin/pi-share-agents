# Flask's modular static-serving architecture: `Blueprint` + shared `Scaffold` + deferred registration + a duplicated `get_send_file_max_age` hook contract

**One-sentence answer.** The "modular component" is `flask.Blueprint`; it and `flask.Flask` both inherit their static-asset configuration from one shared base, `flask.sansio.scaffold.Scaffold`, but they do **not** share a serving implementation — each registers its own static URL rule through the same registration pipeline (`app.register_blueprint` → `Blueprint.register` → `BlueprintSetupState.add_url_rule` → `App.add_url_rule`), each serves through its **own byte-identical copy** of `send_static_file`, and both copies resolve caching through a **byte-identical copy** of `get_send_file_max_age` that reads the single config key `SEND_FILE_MAX_AGE_DEFAULT` off the `current_app` proxy — so app-level static files and blueprint-level static files are rendered with identical `Cache-Control` semantics by construction, not by abstraction.

**Scope and revision.** All claims below are about the checkout at `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`, which is `pallets/flask`, detached at **`85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`** (`.git/HEAD` contents; confirmed by `git rev-parse HEAD` in the execution record below). `pyproject.toml:1-3`:

```toml
[project]
name = "Flask"
version = "3.2.0.dev"
```

`CHANGES.rst:1-8`:

```
Version 3.2.0
-------------

Unreleased

-   Drop support for Python 3.9. :pr:`5730`
-   Remove previously deprecated code: ``__version__``. :pr:`5648`
```

The nearest released version above this checkout is `CHANGES.rst:10` `Version 3.1.1` / `Released 2025-05-13`. `requires-python = ">=3.10"`, `werkzeug>=3.1.0` (`pyproject.toml`). This answer is about Flask itself, not the SYNAPSE repos in the surrounding workspace.

---

## 1. The modular component and the shared base: `Blueprint` and `Scaffold`

`Scaffold` is explicitly documented as the common base of both components — `src/flask/sansio/scaffold.py:52-88`:

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

    def __init__(
        self,
        import_name: str,
        static_folder: str | os.PathLike[str] | None = None,
        static_url_path: str | None = None,
        template_folder: str | os.PathLike[str] | None = None,
        root_path: str | None = None,
    ):
        #: The name of the package or module that this object belongs
        #: to. Do not change this once it is set by the constructor.
        self.import_name = import_name

        self.static_folder = static_folder
        self.static_url_path = static_url_path
```

The entire static-related surface of `Scaffold` is three properties (`src/flask/sansio/scaffold.py:223-269`, verbatim):

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

This is *why an app and a blueprint can each own a `static_folder` with identical normalization rules*: `os.fspath` + strip trailing slashes on the folder, `root_path`-join on read, and a `static_url_path` derived from the folder's basename (trailing slash stripped) when not given. `_endpoint_from_view_func` (`src/flask/sansio/scaffold.py:701-707`) is the endpoint fallback used later in the setup-state funnel:

```python
def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
    """Internal helper that returns the default endpoint for a given
    function.  This always is the function name.
    """
    assert view_func is not None, "expected view func if endpoint is not provided."
    return view_func.__name__
```

Both subclasses are thin over this base. The concrete `Blueprint` inherits through the sans-IO one: `src/flask/sansio/blueprints.py:119` `class Blueprint(Scaffold)` (docstring at `:119-172`), and `src/flask/blueprints.py:18` `class Blueprint(SansioBlueprint)` (`src/flask/blueprints.py:1-16` imports). The app likewise: `src/flask/sansio/app.py:59-61` `class App(Scaffold)`, and `src/flask/app.py:81-99` `class Flask(App)`. Both pass static parameters straight down to `Scaffold.__init__` — `src/flask/sansio/blueprints.py:174-211` and `src/flask/sansio/app.py:283-303`:

```python
    def __init__(
        self,
        import_name: str,
        static_url_path: str | None = None,
        static_folder: str | os.PathLike[str] | None = "static",
        static_host: str | None = None,
        ...
    ) -> None:
        super().__init__(
            import_name=import_name,
            static_folder=static_folder,
            static_url_path=static_url_path,
            template_folder=template_folder,
            root_path=root_path,
        )
```

**Crucially, `Scaffold` defines no `send_static_file` and no `get_send_file_max_age`, and does not register any route.** Verified by repo-wide grep in the execution record: `send_static_file` occurs in exactly four source locations — `src/flask/app.py:278` (a call in the weakref lambda), `src/flask/app.py:308` (definition), `src/flask/blueprints.py:82` (definition), `src/flask/sansio/blueprints.py:326` (the registration site, carrying `# type: ignore[attr-defined]`) — and `grep` in `src/flask/sansio/scaffold.py` for the serving hooks returned **no matches** (`grep-exit=1`). The rest of `Scaffold.__init__` only initializes `template_folder`, `root_path` (via `get_root_path`), `view_functions`, `error_handler_spec`, `before_request_funcs`, `after_request_funcs`, `teardown_request_funcs`, `template_context_processors`, `url_value_preprocessors`, `url_default_functions` — none of it static-related.

---

## 2. Separation happens at registration, not at serving

A blueprint never has its static files served *by the app's* static machinery. Registration is a deferred-callback replay that injects a blueprint-owned rule and a blueprint-owned view function into the app's URL map. Three hops, all cited:

**Hop 1 — the app's public entry point** (`src/flask/sansio/app.py:570-595`):

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on the application. Keyword
        arguments passed to this method will override the defaults set on the
        blueprint.

        Calls the blueprint's :meth:`~flask.Blueprint.register` method after
        recording the blueprint in the application's :attr:`blueprints`.
        ...
        """
        blueprint.register(self, options)
```

**Hop 2 — the deferred registration and the static-route injection** (`src/flask/sansio/blueprints.py:273-336`; `Blueprint.register`'s key block at `:311-336`):

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
        ...
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

Every ordinary blueprint route is *deferred* rather than registered immediately — `src/flask/sansio/blueprints.py:413-442`:

```python
    @setupmethod
    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: ft.RouteCallable | None = None,
        provide_automatic_options: bool | None = None,
        **options: t.Any,
    ) -> None:
        """Register a URL rule with the blueprint. See :meth:`.Flask.add_url_rule` for
        full documentation.

        The URL rule is prefixed with the blueprint's URL prefix. The endpoint name,
        used with :func:`url_for`, is prefixed with the blueprint's name.
        """
        if endpoint and "." in endpoint:
            raise ValueError("'endpoint' may not contain a dot '.' character.")

        if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
            raise ValueError("'view_func' name may not contain a dot '.' character.")

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

**Hop 3 — the funnel that prefixes both rule and endpoint** (`src/flask/sansio/blueprints.py:87-118`, `BlueprintSetupState.add_url_rule`):

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

So with `admin = Blueprint("admin", __name__, url_prefix="/admin", static_folder="static")` (the canonical fixture, `tests/test_apps/blueprintapp/apps/admin/__init__.py`, whole file):

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

the rule `f"{self.static_url_path}/<path:filename>"` becomes `/admin/static/<path:filename>` (via the `url_prefix` join) and the endpoint `"static"` becomes `admin.static` (via `f"{name_prefix}.{name}.{endpoint}"`). Both land in `App.add_url_rule` (`src/flask/sansio/app.py:604-663`), which adds the Werkzeug rule to `self.url_map` and stores `self.view_functions[endpoint] = view_func` under an overwrite guard:

```python
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

**The app-level route is the mirror image**, registered in `Flask.__init__` at construction time rather than at registration time (`src/flask/app.py:262-279`):

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

Same shape, different owner: endpoint `static` (unprefixed), view function a weakref-bound lambda onto **the app's own** `send_static_file`. The declared contract for the component-level static folder is in the sans-IO `Blueprint` docstring (`src/flask/sansio/blueprints.py:140-147`):

```
    :param static_folder: A folder with static files that should be
        served by the blueprint's static route. The path is relative to
        the blueprint's root path. Blueprint static files are disabled
        by default.
    :param static_url_path: The url to serve static files from.
        Defaults to ``static_folder``. If the blueprint does not have
        a ``url_prefix``, the app's static route will take precedence,
        and the blueprint's static files won't be accessible.
```

**No generic plugin/extension registry exists.** The whole mechanism is exactly those four hops plus the callback list `self.deferred_functions: list[DeferredSetupFunction] = []` (`src/flask/sansio/blueprints.py:193`). There is no shared `StaticFileMixin` and no shared static route function; inventing one would contradict `src/flask/sansio/blueprints.py:326`.

---

## 3. Why serving is duplicated rather than inherited: the sans-IO split

`src/flask/sansio/README.md` (whole file):

```
# Sansio

This folder contains code that can be used by alternative Flask
implementations, for example Quart. The code therefore cannot do any
IO, nor be part of a likely IO path. Finally this code cannot use the
Flask globals.
```

The sans-IO `Blueprint` (`src/flask/sansio/blueprints.py`) cannot call `current_app` and cannot do file IO, so it cannot implement serving. Its registration site therefore carries a `# type: ignore[attr-defined]` on `self.send_static_file`. The concrete implementations live only in the IO-capable layers:

- `src/flask/blueprints.py:82` — `class Blueprint(SansioBlueprint)` (line 18), imports `current_app` and `send_from_directory` (`src/flask/blueprints.py:1-16`):

```python
from .cli import AppGroup
from .globals import current_app
from .helpers import send_from_directory
from .sansio.blueprints import Blueprint as SansioBlueprint
from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
from .sansio.scaffold import _sentinel
```

- `src/flask/app.py:308` — `class Flask(App)` (line 81).

The concretely imported `flask.blueprints.Blueprint` is what `src/flask/__init__.py` exports as the public `Blueprint`; `send_file`, `send_from_directory`, and `url_for` are re-exported from `helpers` there too. The `sansio/` directory contains exactly `app.py`, `blueprints.py`, `scaffold.py`, `README.md` — the two-layer split is deliberate and visible in the tree.

---

## 4. Consistent caching: one config key, two byte-identical hooks, both read through `current_app`

Both classes carry their own copy of the hook, and both docstrings say so explicitly — "Note this is a duplicate of the same method in the Flask class". The `Blueprint` copy (`src/flask/blueprints.py:55-80`):

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

The `Flask` copy (`src/flask/app.py:281-306`) is **byte-identical**, including the odd self-referential "duplicate of the same method in the Flask class" note (an upstream docstring artifact inside `app.py` itself). The execution record proves it rather than asserting it:

```
=== duplicate-of note occurrences ===
src/flask/app.py:290:        Note this is a duplicate of the same method in the Flask
src/flask/app.py:314:        Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:64:        Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:88:        Note this is a duplicate of the same method in the Flask

=== diff: Flask.get_send_file_max_age vs Blueprint.get_send_file_max_age ===
IDENTICAL (app.py:281-306 == blueprints.py:55-80)
```

The config key's only default is `None` — `src/flask/app.py:201` (inside `default_config`, `src/flask/app.py:184-222`):

```python
            "SEND_FILE_MAX_AGE_DEFAULT": None,
```

and the key is read at exactly two places in `src/` — `src/flask/app.py:298` and `src/flask/blueprints.py:72` — both via `current_app.config`, never `self.config`:

```
=== CLAIM 4: SEND_FILE_MAX_AGE_DEFAULT in src ===
src/flask/app.py:201:            "SEND_FILE_MAX_AGE_DEFAULT": None,
src/flask/app.py:285:        By default, this returns :data:`SEND_FILE_MAX_AGE_DEFAULT` from
src/flask/app.py:298:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
src/flask/blueprints.py:59:        By default, this returns :data:`SEND_FILE_MAX_AGE_DEFAULT` from
src/flask/blueprints.py:72:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
```

`current_app` is an app-context-scoped `LocalProxy` (`src/flask/globals.py:26-35`):

```python
app_ctx: AppContext = LocalProxy(  # type: ignore[assignment]
    _cv_app, unbound_message=_no_app_msg
)
current_app: Flask = LocalProxy(  # type: ignore[assignment]
    _cv_app, "app", unbound_message=_no_app_msg
)
```

That proxy is *the* single mechanism that keeps the two components' caching behaviour provably identical: a blueprint static request is handled inside an app context, so the blueprint's hook reads the **serving app's** `SEND_FILE_MAX_AGE_DEFAULT`. There is no per-blueprint configuration channel; the only way for a blueprint to differ is to subclass and override the hook (Section 7).

Historical rationale, `CHANGES.rst:1292-1300` (Version 0.9 section):

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

Documented in `docs/config.rst:250-262`:

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

---

## 5. The two `send_static_file` bodies, and why each must call its *own* hook explicitly

The two serving methods are also byte-identical (execution record: `diff` → zero output, `app.py:308-328 == blueprints.py:82-102`). The `Blueprint` copy (`src/flask/blueprints.py:82-102`):

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

The `Flask` copy (`src/flask/app.py:308-328`) is identical, comment included. The comment is the crux. The generic send pipeline installs the **app-bound callable** whenever `max_age` is not supplied (`src/flask/helpers.py:387-397`):

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

So a caller of `send_file` who passes no `max_age` gets `current_app.get_send_file_max_age` — which "only knows" about the app. Therefore a blueprint that merely forwarded a blueprint-bound callable would have its own hook ignored; instead, both `send_static_file` implementations pre-resolve `max_age = self.get_send_file_max_age(filename)` and hand a **concrete value** into `send_from_directory`. `send_file`'s contract for that parameter (`src/flask/helpers.py:446-448`):

```
    :param max_age: How long the client should cache the file, in
        seconds. If set, ``Cache-Control`` will be ``public``, otherwise
        it will be ``no-cache`` to prefer conditional caching.
```

`send_file`'s body (`src/flask/helpers.py:511-524`):

```python
    return werkzeug.utils.send_file(  # type: ignore[return-value]
        **_prepare_send_file_kwargs(
            path_or_file=path_or_file,
            environ=request.environ,
            mimetype=mimetype,
            as_attachment=as_attachment,
            download_name=download_name,
            conditional=conditional,
            etag=etag,
            last_modified=last_modified,
            max_age=max_age,
        )
    )
```

`send_from_directory` (`src/flask/helpers.py:526-567`), which is what both static hooks call:

```python
def send_from_directory(
    directory: os.PathLike[str] | str,
    path: os.PathLike[str] | str,
    **kwargs: t.Any,
) -> Response:
    """Send a file from within a directory using :func:`send_file`.

    .. code-block:: python

        @app.route("/uploads/<path:name>")
        def download_file(name):
            return send_from_directory(
                app.config['UPLOAD_FOLDER'], name, as_attachment=True
            )

    This is a secure way to serve files from a folder, such as static
    files or uploads. Uses :func:`~werkzeug.security.safe_join` to
    ensure the path coming from the client is not maliciously crafted to
    point outside the specified directory.

    If the final path does not point to an existing regular file,
    raises a 404 :exc:`~werkzeug.exceptions.NotFound` error.

    :param directory: The directory that ``path`` must be located under,
        relative to the current application's root path. This *must not*
        be a value provided by the client, otherwise it becomes insecure.
    :param path: The path to the file to send, relative to
        ``directory``.
    :param kwargs: Arguments to pass to :func:`send_file`.

    .. versionchanged:: 2.0
        ``path`` replaces the ``filename`` parameter.

    .. versionadded:: 2.0
        Moved the implementation to Werkzeug. This is now a wrapper to
        pass some Flask-specific arguments.

    .. versionadded:: 0.5
    """
    return werkzeug.utils.send_from_directory(  # type: ignore[return-value]
        directory, path, **_prepare_send_file_kwargs(**kwargs)
    )
```

The terminal hop is Werkzeug, which treats a callable `max_age` by invoking it with the path, then sets `Cache-Control` (`.venv/Lib/site-packages/werkzeug/utils.py:500-513`; installed `werkzeug-3.1.3`):

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

That is the full chain: blueprint `send_static_file` → blueprint `get_send_file_max_age` → `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` → `send_from_directory` → `_prepare_send_file_kwargs` → `werkzeug.utils.send_from_directory` → `werkzeug.utils.send_file` → `cache_control.max_age`.

---

## 6. Documented contract: `docs/blueprints.rst` "Static Files"

`docs/blueprints.rst:191-217`, verbatim:

```
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

---

## 7. Override uniformity, proven by tests

**Same config ⇒ same `Cache-Control` for blueprint static, plus prefixed `url_for`** — `tests/test_blueprints.py::test_templates_and_static` (`tests/test_blueprints.py:176-221`):

```python
def test_templates_and_static(test_apps):
    from blueprintapp import app

    client = app.test_client()

    rv = client.get("/")
    assert rv.data == b"Hello from the Frontend"
    rv = client.get("/admin/")
    assert rv.data == b"Hello from the Admin"
    rv = client.get("/admin/index2")
    assert rv.data == b"Hello from the Admin"
    rv = client.get("/admin/static/test.txt")
    assert rv.data.strip() == b"Admin File"
    rv.close()
    rv = client.get("/admin/static/css/test.css")
    assert rv.data.strip() == b"/* nested file */"
    rv.close()

    # try/finally, in case other tests use this app for Blueprint tests.
    max_age_default = app.config["SEND_FILE_MAX_AGE_DEFAULT"]
    try:
        expected_max_age = 3600
        if app.config["SEND_FILE_MAX_AGE_DEFAULT"] == expected_max_age:
            expected_max_age = 7200
        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = expected_max_age
        rv = client.get("/admin/static/css/test.css")
        cc = parse_cache_control_header(rv.headers["Cache-Control"])
        assert cc.max_age == expected_max_age
        rv.close()
    finally:
        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = max_age_default

    with app.test_request_context():
        assert (
            flask.url_for("admin.static", filename="test.txt")
            == "/admin/static/test.txt"
        )

    with app.test_request_context():
        with pytest.raises(TemplateNotFound) as e:
            flask.render_template("missing.html")
        assert e.value.name == "missing.html"

    with flask.Flask(__name__).test_request_context():
        assert flask.render_template("nested/nested.txt") == "I'm nested"
```

**Per-class hook override wins for blueprint static** — `tests/test_blueprints.py::test_default_static_max_age` (`tests/test_blueprints.py:223-245`):

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

**App static route and generic `send_file` agree, and an app-subclass hook applies to both** — `tests/test_helpers.py::TestSendfile::test_static_file` (`tests/test_helpers.py:45-91`):

```python
    def test_static_file(self, app, req_ctx):
        # Default max_age is None.

        # Test with static file handler.
        rv = app.send_static_file("index.html")
        assert rv.cache_control.max_age is None
        rv.close()

        # Test with direct use of send_file.
        rv = flask.send_file("static/index.html")
        assert rv.cache_control.max_age is None
        rv.close()

        app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 3600

        # Test with static file handler.
        rv = app.send_static_file("index.html")
        assert rv.cache_control.max_age == 3600
        rv.close()

        # Test with direct use of send_file.
        rv = flask.send_file("static/index.html")
        assert rv.cache_control.max_age == 3600
        rv.close()

        # Test with pathlib.Path.
        rv = app.send_static_file(FakePath("index.html"))
        assert rv.cache_control.max_age == 3600
        rv.close()

        class StaticFileApp(flask.Flask):
            def get_send_file_max_age(self, filename):
                return 10

        app = StaticFileApp(__name__)

        with app.test_request_context():
            # Test with static file handler.
            rv = app.send_static_file("index.html")
            assert rv.cache_control.max_age == 10
            rv.close()

            # Test with direct use of send_file.
            rv = flask.send_file("static/index.html")
            assert rv.cache_control.max_age == 10
            rv.close()
```

Supporting fixtures: `tests/conftest.py:44-68` defines the `app` fixture with `root_path` at the tests dir (so `static/` resolves to `tests/static`), plus `app_ctx`, `req_ctx`, `client`; `tests/test_apps/blueprintapp/__init__.py` (whole file) registers both blueprints:

```python
from flask import Flask

app = Flask(__name__)
app.config["DEBUG"] = True
from blueprintapp.apps.admin import admin  # noqa: E402
from blueprintapp.apps.frontend import frontend  # noqa: E402

app.register_blueprint(admin)
app.register_blueprint(frontend)
```

and the sibling component `tests/test_apps/blueprintapp/apps/frontend/__init__.py` (whole file) has **no** `static_folder`, confirming blueprint static is disabled by default:

```python
from flask import Blueprint
from flask import render_template

frontend = Blueprint("frontend", __name__, template_folder="templates")

@frontend.route("/")
def index():
    return render_template("frontend/index.html")

@frontend.route("/missing")
def missing_template():
    return render_template("missing_template.html")
```

The served assets in the fixture are `tests/test_apps/blueprintapp/apps/admin/static/` → `css/` (`test.css`) and `test.txt`.

---

## 8. Caveats and edge cases (each labelled as to whether it is tested, documented-only, or execution-verified)

1. **Default `max_age` is `None` ⇒ conditional requests, not a timed cache.** Both hooks return `value` unchanged when the config is `None`; `send_file`'s docstring says "If set, `Cache-Control` will be `public`, otherwise it will be `no-cache` to prefer conditional caching" (`src/flask/helpers.py:446-448`); `docs/config.rst` says "If `None`, `send_file` tells the browser to use conditional requests will be used instead of a timed cache"; `CHANGES.rst:587-590` (Version 2.0): "`send_file` sets `conditional=True` and `max_age=None` by default. `Cache-Control` is set to `no-cache` if `max_age` is not set, otherwise `public`." Execution-verified: at default config both app and blueprint static responses returned exactly `'no-cache'`.
2. **Blueprint static folders are off by default and are *not* searched as a fallback.** `static_folder` defaults to `None` on `Blueprint` (`src/flask/sansio/blueprints.py:174-182`) and the injection is guarded by `if self.has_static_folder` (`src/flask/sansio/blueprints.py:323`); `docs/blueprints.rst:215-217` states "Unlike template folders, blueprint static folders are not searched if the file does not exist in the application static folder." Execution-verified: a file present only in the blueprint's folder returned **404** when requested via the app's `/static/...` route.
3. **Without `url_prefix`, the blueprint's `/static` loses to the app's `/static`.** Documented at `docs/blueprints.rst:212-215` and in the `Blueprint` docstring (`src/flask/sansio/blueprints.py:140-147`: "If the blueprint does not have a `url_prefix`, the app's static route will take precedence, and the blueprint's static files won't be accessible"). **Documented only — no test covers it.** The execution record's grep of `tests/test_blueprints.py` for `url_prefix` gave 20 hits, all ordinary route/prefix tests, none of them this precedence case. Execution-verified behaviour: with a prefix-less blueprint both rules `/static/<path:filename>` appear in the URL map and the app's file is served; the app's rule is registered first (during `Flask.__init__`, `src/flask/app.py:262-279`) while blueprint rules are appended later at `register_blueprint` time, which is consistent with the documented precedence — but I have not separately verified Werkzeug's tie-breaking rule-by-rule, so treat the *mechanism* as read-only inference and the *outcome* as verified.
4. **`static_url_path` defaults to the folder basename** (trailing slash stripped): `src/flask/sansio/scaffold.py:249-262`, `basename = os.path.basename(self.static_folder); return f"/{basename}".rstrip("/")`. Related edge-case history: `CHANGES.rst:639-640` ("The static route will not catch all URLs if the `Flask` `static_folder` argument ends with a slash. :issue:`3452`"), `CHANGES.rst:700-703` (support `static_url_path` ending with a slash; support empty `static_folder` without an empty `static_url_path`), `CHANGES.rst:476-477,628-629` (`pathlib.Path` support for `static_folder`). Covered on the app side by `tests/test_basic.py:1412-1486` (`test_static_url_path`, `test_static_url_path_with_ending_slash`, `test_static_url_empty_path`, `test_static_url_empty_path_default`, `test_static_folder_with_pathlib_path`, `test_static_folder_with_ending_slash`, `test_static_route_with_host_matching` — the last asserting `assert bool(static_host) == host_matching` both ways).
5. **The endpoint is `<blueprint_name>.static` and supports `url_for`.** `docs/blueprints.rst:207-213`; test `test_templates_and_static` asserts `flask.url_for("admin.static", filename="test.txt") == "/admin/static/test.txt"`. Execution-verified in the repro below: `url_for('bp.static', filename='index.html')` → `/bp/static/index.html`.
6. **Per-blueprint cache policy is impossible by configuration.** That is a direct consequence of the hooks reading `current_app.config`, not `self.config` (cited in Section 4). The only route to a different blueprint cache policy is subclassing and overriding `get_send_file_max_age` (as `test_default_static_max_age` does).
7. **A blueprint hook returning `None` silently falls back to the app's value.** Because `send_static_file` passes the concrete `None` on, `_prepare_send_file_kwargs` sees a falsy `max_age` and substitutes the callable `current_app.get_send_file_max_age` (`src/flask/helpers.py:388-389`). Execution-verified: a blueprint subclass returning `None` while the app config was `3600` produced `public, max-age=3600` on the routed blueprint static request — the blueprint's `None` was ignored. This is a **coincidence of the two defaults matching**, not an enforced invariant; the two hooks are kept in lockstep only by discipline and by the `diff`-verifiable identity of their bodies.

---

## 9. Execution verification (what was actually run, not merely read)

**Environment.** `.venv/` is a dev install pointed at this checkout: `.venv/Lib/site-packages/flask.pth` contains exactly

```
D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src
```

and `.venv/pyvenv.cfg` is

```
home = C:\Users\oobbee\AppData\Roaming\uv\python\cpython-3.13.9-windows-x86_64-none
implementation = CPython
uv = 0.9.5
version_info = 3.13.9
include-system-site-packages = false
prompt = flask
```

Interpreter CPython 3.13.9, pytest 8.4.0, werkzeug 3.1.3. Note there is a *second* environment, `experiments/data/venv`, whose `venv-freeze.txt` points Flask at `experiments/data/worktree/flask` (`-e git+https://github.com/Felix-bin/pi-share-agents.git@291a0f2...#egg=Flask&subdirectory=experiments/data/worktree/flask`) — that is a different Flask copy and was **not** used.

**Command 1 — the plan's targeted run** (exit 0):

```
$ cd "D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src" && ./.venv/Scripts/python.exe -m pytest tests/test_blueprints.py::test_templates_and_static tests/test_blueprints.py::test_default_static_max_age "tests/test_helpers.py::TestSendfile::test_static_file" -q

...                                                                      [100%]
3 passed in 0.19s
```

Verbose twin (exit 0):

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 3 items

tests/test_blueprints.py::test_templates_and_static PASSED               [ 33%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [ 66%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [100%]

============================== 3 passed in 0.22s ==============================
```

**Command 2 — the two whole modules**, `./.venv/Scripts/python.exe -m pytest tests/test_blueprints.py tests/test_helpers.py -v`, exit 0. Every one of the 94 collected items passed, including the six static-related ones:

```
tests/test_blueprints.py::test_templates_and_static PASSED               [ 18%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [ 19%]
tests/test_blueprints.py::test_templates_list PASSED                     [ 20%]
tests/test_helpers.py::TestSendfile::test_send_file PASSED               [ 64%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [ 65%]
tests/test_helpers.py::TestSendfile::test_send_from_directory PASSED     [ 67%]
...
============================= 94 passed in 0.52s ==============================
```

**Command 3 — the entire suite**, `./.venv/Scripts/python.exe -m pytest -v`, exit 0. Summary line, verbatim:

```
============================= 489 passed in 2.16s =============================
```

(The transcript's full per-test listing is 489 lines long; the load-bearing lines are the four `test_basic.py` static tests at 17–19% — `test_static_files PASSED`, `test_static_url_path PASSED`, `test_static_url_path_with_ending_slash PASSED`, `test_static_url_empty_path PASSED`, `test_static_url_empty_path_default PASSED`, `test_static_folder_with_pathlib_path PASSED`, `test_static_folder_with_ending_slash PASSED`, `test_static_route_with_host_matching PASSED` — together with the blueprint/helper lines quoted above and the terminal summary. One raw console line, `test_json.py::test_bad_request_debug_message[False]`, appears twice in the streamed transcript due to a transcription artifact; the summary line is the authority: 489 collected, 489 passed.)

**Command 4 — the direct repro** (`repro_static.py` in a `mktemp -d` temp dir; script verbatim, exit 0):

```python
import os, tempfile, flask
from werkzeug.http import parse_cache_control_header

tmp = tempfile.mkdtemp(prefix="flask-static-repro-")
os.makedirs(os.path.join(tmp, "static"))
os.makedirs(os.path.join(tmp, "bp_static"))
with open(os.path.join(tmp, "static", "index.html"), "w") as f:
    f.write("APP-STATIC-BODY")
with open(os.path.join(tmp, "bp_static", "index.html"), "w") as f:
    f.write("BP-STATIC-BODY")

class MyBlueprint(flask.Blueprint):
    def get_send_file_max_age(self, filename):
        return 100

app = flask.Flask("repro", root_path=tmp, static_folder="static")
bp = flask.Blueprint("bp", "repro", url_prefix="/bp",
                     static_folder=os.path.join(tmp, "bp_static"),
                     static_url_path="/static")
bp2 = MyBlueprint("bp2", "repro", url_prefix="/bp2",
                  static_folder=os.path.join(tmp, "bp_static"),
                  static_url_path="/static")
app.register_blueprint(bp)
app.register_blueprint(bp2)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 3600
app.testing = True

c = app.test_client()
a = c.get("/static/index.html")
b = c.get("/bp/static/index.html")
d = c.get("/bp2/static/index.html")
print("tmpdir                 :", tmp)
print("app  /static/index.html:", a.status_code, repr(a.headers.get("Cache-Control")), a.data)
print("bp   /bp/static/...    :", b.status_code, repr(b.headers.get("Cache-Control")), b.data)
print("bp2  /bp2/static/...   :", d.status_code, repr(d.headers.get("Cache-Control")), d.data, "(subclass hook -> 100)")
print("app vs bp Cache-Control equal:", a.headers.get("Cache-Control") == b.headers.get("Cache-Control"))
print("app max_age == 3600    :", parse_cache_control_header(a.headers["Cache-Control"]).max_age == 3600)
print("bp  max_age == 3600    :", parse_cache_control_header(b.headers["Cache-Control"]).max_age == 3600)
print("bp2 max_age == 100     :", parse_cache_control_header(d.headers["Cache-Control"]).max_age == 100)
with app.test_request_context():
    print("url_for('bp.static')   :", flask.url_for("bp.static", filename="index.html"))
    print("url_for('static')      :", flask.url_for("static", filename="index.html"))
# default config (None) => no-cache on both
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = None
a2 = c.get("/static/index.html"); b2 = c.get("/bp/static/index.html")
print("default None app       :", repr(a2.headers.get("Cache-Control")))
print("default None bp        :", repr(b2.headers.get("Cache-Control")))
```

Output (exit 0):

```
tmpdir                 : C:\Users\oobbee\AppData\Local\Temp\flask-static-repro-9vssppp_
app  /static/index.html: 200 'public, max-age=3600' b'APP-STATIC-BODY'
bp   /bp/static/...    : 200 'public, max-age=3600' b'BP-STATIC-BODY'
bp2  /bp2/static/...   : 200 'public, max-age=100' b'BP-STATIC-BODY' (subclass hook -> 100)
app vs bp Cache-Control equal: True
app max_age == 3600    : True
bp  max_age == 3600    : True
bp2 max_age == 100     : True
url_for('bp.static')   : /bp/static/index.html
url_for('static')      : /static/index.html
default None app       : 'no-cache'
default None bp        : 'no-cache'
EXIT_STATUS=0
```

**Command 5 — the edge-case repro** (`edge_static.py`; script and output verbatim, exit 0):

```python
import os, tempfile, flask
from werkzeug.http import parse_cache_control_header

tmp = tempfile.mkdtemp(prefix="flask-static-edge-")
os.makedirs(os.path.join(tmp, "static"))
os.makedirs(os.path.join(tmp, "bp_static"))
open(os.path.join(tmp, "static", "index.html"), "w").write("APP-static-body")
open(os.path.join(tmp, "static", "onlyapp.txt"), "w").write("ONLY IN APP")
open(os.path.join(tmp, "bp_static", "index.html"), "w").write("BP-static-body")
open(os.path.join(tmp, "bp_static", "onlybp.txt"), "w").write("ONLY IN BP")

# (A) blueprint WITHOUT url_prefix, static folder named "bp_static" -> no conflict
appA = flask.Flask("edgeA", root_path=tmp, static_folder="static")
bpA = flask.Blueprint("bpA", "edgeA",
                      static_folder=os.path.join(tmp, "bp_static"),
                      static_url_path="/static")
appA.register_blueprint(bpA)
appA.testing = True
cA = appA.test_client()
print("(A) no-url_prefix bp registered; rules:")
for r in sorted(str(r) for r in appA.url_map.iter_rules()):
    print("      ", r)
r = cA.get("/static/index.html")
print("    GET /static/index.html ->", r.status_code, r.data)
r2 = cA.get("/static/onlybp.txt")
print("    GET /static/onlybp.txt (bp-only file, app folder lacks it) ->", r2.status_code, r2.data)

# (B) blueprint static_url_path same as app's, WITH url_prefix -> distinct rules
appB = flask.Flask("edgeB", root_path=tmp, static_folder="static")
bpB = flask.Blueprint("bpB", "edgeB", url_prefix="/bp",
                      static_folder=os.path.join(tmp, "bp_static"),
                      static_url_path="/static")
appB.register_blueprint(bpB)
appB.testing = True
cB = appB.test_client()
print("(B) with url_prefix '/bp'; rules:")
for r in sorted(str(r) for r in appB.url_map.iter_rules()):
    print("      ", r)
print("    GET /static/index.html ->", cB.get("/static/index.html").data)
print("    GET /bp/static/index.html ->", cB.get("/bp/static/index.html").data)

# (C) blueprint hook returns None while app config = 3600 -> which wins?
class NoneBlueprint(flask.Blueprint):
    def get_send_file_max_age(self, filename):
        return None

appC = flask.Flask("edgeC", root_path=tmp, static_folder="static")
bpC = NoneBlueprint("bpC", "edgeC", url_prefix="/bp",
                    static_folder=os.path.join(tmp, "bp_static"),
                    static_url_path="/static")
appC.register_blueprint(bpC)
appC.config["SEND_FILE_MAX_AGE_DEFAULT"] = 3600
appC.testing = True
cC = appC.test_client()
h = cC.get("/bp/static/index.html").headers["Cache-Control"]
print("(C) bp hook returns None, app config 3600 -> bp Cache-Control:", repr(h),
      "max_age:", parse_cache_control_header(h).max_age)
h2 = cC.get("/static/index.html").headers["Cache-Control"]
print("    app route Cache-Control:", repr(h2))
```

```
(A) no-url_prefix bp registered; rules:
       /static/<path:filename>
       /static/<path:filename>
    GET /static/index.html -> 200 b'APP-static-body'
    GET /static/onlybp.txt (bp-only file, app folder lacks it) -> 404 b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
(B) with url_prefix '/bp'; rules:
       /bp/static/<path:filename>
       /static/<path:filename>
    GET /static/index.html -> b'APP-static-body'
    GET /bp/static/index.html -> b'BP-static-body'
(C) bp hook returns None, app config 3600 -> bp Cache-Control: 'public, max-age=3600' max_age: 3600
    app route Cache-Control: 'public, max-age=3600'
EXIT_STATUS=0
```

**Command 6 — claim-by-claim greps** (exit 0 throughout):

```
=== CLAIM 1: Scaffold docstring + static surface ===
52:class Scaffold:
53:    """Common behavior shared between :class:`~flask.Flask` and
72:    _static_folder: str | None = None
73:    _static_url_path: str | None = None
224:    def static_folder(self) -> str | None:
228:        if self._static_folder is not None:
229:            return os.path.join(self.root_path, self._static_folder)
234:    def static_folder(self, value: str | os.PathLike[str] | None) -> None:
238:        self._static_folder = value
241:    def has_static_folder(self) -> bool:
249:    def static_url_path(self) -> str | None:
255:        if self._static_url_path is not None:
256:            return self._static_url_path
265:    def static_url_path(self, value: str | None) -> None:
269:        self._static_url_path = value
EXIT=0
=== CLAIM 3: send_static_file occurrences repo-wide ===
src/flask/app.py:278:                view_func=lambda **kw: self_ref().send_static_file(**kw),  # type: ignore # noqa: B950
src/flask/app.py:308:    def send_static_file(self, filename: str) -> Response:
src/flask/blueprints.py:82:    def send_static_file(self, filename: str) -> Response:
src/flask/sansio/blueprints.py:326:                view_func=self.send_static_file,  # type: ignore[attr-defined]
Binary file src/flask/sansio/__pycache__/blueprints.cpython-311.pyc matches
Binary file src/flask/sansio/__pycache__/blueprints.cpython-312.pyc matches
Binary file src/flask/sansio/__pycache__/blueprints.cpython-313.pyc matches
Binary file src/flask/sansio/__pycache__/blueprints.cpython-314.pyc matches
Binary file src/flask/__pycache__/app.cpython-311.pyc matches
Binary file src/flask/__pycache__/app.cpython-312.pyc matches
Binary file src/flask/__pycache__/app.cpython-313.pyc matches
Binary file src/flask/__pycache__/app.cpython-314.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-311.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-312.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-313.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-314.pyc matches
EXIT=0
=== CLAIM 4: SEND_FILE_MAX_AGE_DEFAULT in src ===
src/flask/app.py:201:            "SEND_FILE_MAX_AGE_DEFAULT": None,
src/flask/app.py:285:        By default, this returns :data:`SEND_FILE_MAX_AGE_DEFAULT` from
src/flask/app.py:298:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
src/flask/blueprints.py:59:        By default, this returns :data:`SEND_FILE_MAX_AGE_DEFAULT` from
src/flask/blueprints.py:72:        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]
(… __pycache__ binary matches elided by grep as above …)
EXIT=0
=== CLAIM 5: _prepare_send_file_kwargs ===
387:def _prepare_send_file_kwargs(**kwargs: t.Any) -> dict[str, t.Any]:
400:def send_file(
512:        **_prepare_send_file_kwargs(
526:def send_from_directory(
566:        directory, path, **_prepare_send_file_kwargs(**kwargs)
EXIT=0
=== CLAIM 2: register / setup-state funnel ===
src/flask/sansio/blueprints.py:87:    def add_url_rule(
src/flask/sansio/blueprints.py:246:    def make_setup_state(
src/flask/sansio/blueprints.py:256:    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
src/flask/sansio/blueprints.py:273:    def register(self, app: App, options: dict[str, t.Any]) -> None:
src/flask/sansio/blueprints.py:323:        if self.has_static_folder:
src/flask/sansio/blueprints.py:326:                view_func=self.send_static_file,  # type: ignore[attr-defined]
src/flask/sansio/blueprints.py:413:    def add_url_rule(
src/flask/sansio/app.py:570:    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
src/flask/sansio/app.py:605:    def add_url_rule(
src/flask/sansio/app.py:651:        rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
src/flask/app.py:267:        if self.has_static_folder:
src/flask/app.py:320:        if not self.has_static_folder:
src/flask/app.py:1311:        ctx = request_ctx._get_current_object()  # type: ignore[attr-defined]
src/flask/blueprints.py:94:        if not self.has_static_folder:
EXIT=0
```

`grep` inside `src/flask/sansio/scaffold.py` for the serving hooks returned no matches (`grep-exit=1`). And the two method-pair diffs:

```
=== diff: Flask.get_send_file_max_age vs Blueprint.get_send_file_max_age ===
IDENTICAL (app.py:281-306 == blueprints.py:55-80)

=== diff: Flask.send_static_file vs Blueprint.send_static_file ===
IDENTICAL (app.py:308-328 == blueprints.py:82-102)
```

Both `diff -u` invocations produced **zero output**.

---

## 10. Truth labels for the execution claims

Per this workspace's four-tier discipline:

| Claim | Status |
|---|---|
| `Blueprint` is the modular component; `Scaffold` is the shared base owning `static_folder`/`static_url_path`/`has_static_folder` + normalization, and defines **no** serving hook or route | **已实现且已验证** (static grep + full suite) |
| Separation happens at registration: `Flask.register_blueprint` → `Blueprint.register` → `BlueprintSetupState.add_url_rule` → `App.add_url_rule`, with the app's own route registered in `Flask.__init__` via a weakref lambda | **已实现且已验证** |
| The sans-IO split is why serving is duplicated: `src/flask/sansio/blueprints.py:326` carries `# type: ignore[attr-defined]`; real definitions only at `src/flask/blueprints.py:82` and `src/flask/app.py:308` | **已实现且已验证** |
| Consistent caching = one config key read through `current_app`; the two `get_send_file_max_age` bodies and the two `send_static_file` bodies are byte-identical (`diff` → zero output) | **已实现且已验证** |
| Each component must pre-resolve `max_age` because `send_file`'s generic path installs `current_app.get_send_file_max_age` (`src/flask/helpers.py:387-397`) | **已实现且已验证** |
| Subclass hook override works for a routed blueprint static request (`/bp2/static/index.html` → `public, max-age=100` while `/static/index.html` → `max-age=3600`), and for app static + `send_file` (`TestSendfile::test_static_file`) | **已实现且已验证** |
| End-to-end `Cache-Control` equality at the same config: both `'public, max-age=3600'`, string-equal `True`; at default `None` both `'no-cache'` | **已实现且已验证** |
| No-`url_prefix` blueprint loses `/static` to the app; blueprint static is **not** a fallback lookup (bp-only file → 404) | **已实现且已验证（行为）**；文档契约见 `docs/blueprints.rst:212-217`；**测试覆盖缺口**如实记录（`tests/test_blueprints.py` 内无此用例） |
| A blueprint hook returning `None` silently falls back to the app's value — a coincidence of matching defaults, not an enforced invariant | **已实现且已验证** |
| `endpoint` is `<blueprint_name>.static` and supports `url_for` | **已实现且已验证** |
| Werkzeug's exact tie-breaking for two same-path rules as the reason for app precedence | **只有读取证据**（registration-order inference from the cited code sites; outcome verified, mechanism not separately tested) |

**Nothing in the checkout was edited.** The only files created were two throwaway scripts inside a `mktemp -d` temp directory (paths reported above; both outside the repo).

**Provenance note.** This answer was derived entirely from the source tree, tests, docs, and executed commands of the pinned checkout. The `experiments/data/swe-qa/` directory present beside it (see the `experiments/data/` listing: `flask-src/`, `musique_ans_v1.0_dev.jsonl`, `swe-qa/`, `venv/`, `venv-freeze.txt`, `worktree/`) was not opened, and a grep for the task's own phrasing (`modular component registration`) across the plugin repo returned `No matches found` — the question text does not appear in the checked-out repo outside whatever harness file may hold it.

**Failures or anomalies: none.** Every command exited 0; the targeted three tests, the two full test modules (94 passed), and the entire suite (489 passed) are all green.
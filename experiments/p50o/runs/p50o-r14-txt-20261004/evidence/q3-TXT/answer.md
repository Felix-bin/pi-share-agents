# Answer: The modular component registration architecture in Flask @ `85c5d93` (Flask 3.2.0.dev)

**Commit described:** `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (checkout `experiments/data/flask-src`), which `pyproject.toml` dates as `version = "3.2.0.dev"`. Repo identity, verbatim:

`flask-src/.git/logs/HEAD`:
```
0000000000000000000000000000000000000000 d73fa1cdcbd8b1465c151db8924ba58b1dd14e35 Super User <root@LAPTOP-GD72BTDF.localdomain> 1790423793 +0800	clone: from https://github.com/pallets/flask
d73fa1cdcbd8b1465c151db8924ba58b1dd14e35 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642 Super User <root@LAPTOP-GD72BTDF.localdomain> 1790423798 +0800	checkout: moving from main to 85c5d93
```
`flask-src/pyproject.toml:1-4`:
```
[project]
name = "Flask"
version = "3.2.0.dev"
description = "A simple framework for building complex web applications."
```

---

## 1. Direct answer (one paragraph)

Flask separates *static-asset serving* by component by making the application and the blueprint two **independently-subclassable registration components** over one shared base class, `Scaffold`, while keeping caching identical through a deliberately **duplicated cache hook** reading a **single app-level config key**. Concretely:

* The **shared registration base** is `Scaffold` (`src/flask/sansio/scaffold.py:52`), which owns the static-asset *geometry* — `static_folder`, `has_static_folder`, `static_url_path`, `jinja_loader`, and the `@setupmethod` guard (`src/flask/sansio/scaffold.py:42-48`) — and the shared registration dictionaries (`view_functions`, `before_request_funcs`, …) created in `Scaffold.__init__`. The class graph is `Flask → App → Scaffold → object` and `Blueprint → Blueprint(sansio) → Scaffold → object`, empirically confirmed by the MRO probe below.
* The **main application framework** (`Flask`, `src/flask/app.py:81`) registers its static route **eagerly**, inside `Flask.__init__`, at `src/flask/app.py:267-279`: endpoint exactly `"static"`, rule `"{static_url_path}/<path:filename>"`, view function a `weakref`-closing lambda `lambda **kw: self_ref().send_static_file(**kw)`.
* The **modular component** (`Blueprint`, `src/flask/sansio/blueprints.py:119`) registers its static route **lazily/deferred**, at `Blueprint.register` (`src/flask/sansio/blueprints.py:323-328`), by handing the rule to a `BlueprintSetupState` (`src/flask/sansio/blueprints.py:34`), whose `add_url_rule` (`src/flask/sansio/blueprints.py:87-117`) applies the URL prefix and the `{name_prefix}.{name}.` endpoint prefix before calling `App.add_url_rule`. A blueprint's static folder is **off by default** (`static_folder=None`), unlike the app's `"static"`.
* **Consistent caching across both components** is preserved by *duplication plus an explicit call*, not by inheritance: `get_send_file_max_age` is defined twice, byte-identically, on `Flask` (`src/flask/app.py:281-306`) and on `Blueprint` (`src/flask/blueprints.py:55-80`), and both `send_static_file` implementations (`src/flask/app.py:308-328`, `src/flask/blueprints.py:82-102`) call **their own** `self.get_send_file_max_age(filename)` and pass the result as `max_age=` into `send_from_directory`. Both hooks read the same single key, `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` (default `None` at `src/flask/app.py:201`). The explicit call is **required**, not cosmetic, because the generic helper path `_prepare_send_file_kwargs` (`src/flask/helpers.py:387-398`) can reach **only the app's** hook (`kwargs["max_age"] = current_app.get_send_file_max_age`), which is exactly what the in-code comment says: `# send_file only knows to call get_send_file_max_age on the app, / # call it here so it works for blueprints too.`

The behavioral verification (fresh run, 28/28 checks) confirms this end-to-end: for `SEND_FILE_MAX_AGE_DEFAULT ∈ {None, 3600, 7200, timedelta(hours=1)}` the app route `/static/…` and the blueprint route `/admin/static/…` emit the **same** `Cache-Control` max-age, while a per-component hook override on the blueprint (100) beats config 3600 on the blueprint path only, and the generic `send_from_directory` fallback still reaches the app hook only.

---

## 2. The two components side by side

| Property | Main app component: `Flask` | Modular component: `Blueprint` |
|---|---|---|
| Class | `class Flask(App)` — `src/flask/app.py:81`; `class App(Scaffold)` — `src/flask/sansio/app.py:59` | `class Blueprint(SansioBlueprint)` — `src/flask/blueprints.py:18`; `class Blueprint(Scaffold)` — `src/flask/sansio/blueprints.py:119` |
| Shared base | `Scaffold` (`src/flask/sansio/scaffold.py:52`) | `Scaffold` (`src/flask/sansio/scaffold.py:52`) |
| When static route is registered | **Eagerly**, in `Flask.__init__` (`src/flask/app.py:267-279`) | **Deferred**, in `Blueprint.register` (`src/flask/sansio/blueprints.py:323-328`) through `BlueprintSetupState.add_url_rule` |
| Registration channel | direct `self.add_url_rule(...)` (the app *is* the app) | `state.add_url_rule(...)` → `self.app.add_url_rule(...)` with prefixing (`sansio/blueprints.py:87-117`) |
| Rule | `f"{self.static_url_path}/<path:filename>"` → `/static/<path:filename>` | `f"{self.static_url_path}/<path:filename>"` with `url_prefix` joined → `/admin/static/<path:filename>` |
| Endpoint | `"static"` (literal) | `"static"` relative → `"{name_prefix}.{name}.static"` → `admin.static` |
| View function | `lambda **kw: self_ref().send_static_file(**kw)` wrapping a `weakref.ref(self)` (issue #3761) | `self.send_static_file` (bound method, passed by reference) |
| Default `static_folder` | `"static"` (`src/flask/app.py:228`) — on unless disabled | `None` (`src/flask/sansio/blueprints.py:177`) — **off by default** |
| Default `static_url_path` | derived in `Scaffold.static_url_path` (`/` + basename of folder) | same derivation in `Scaffold.static_url_path` |
| Cache hook | `Flask.get_send_file_max_age` — `src/flask/app.py:281` | `Blueprint.get_send_file_max_age` — `src/flask/blueprints.py:55` |
| Static view | `Flask.send_static_file` — `src/flask/app.py:308` | `Blueprint.send_static_file` — `src/flask/blueprints.py:82` |
| Setup guard specialization | `App._check_setup_finished` checks `self._got_first_request` (`sansio/app.py:413-423`) | `Blueprint._check_setup_finished` checks `self._got_registered_once` (`sansio/blueprints.py:213-221`) |

The `run2-raw` log's resolution table (quoted in full in §6 below) shows the two routes coexisting in one `url_map`:
```
PASS  C4: exactly one rule with endpoint 'static'
      [('/static/<path:filename>', 'static')]
PASS  C5: blueprint static rule prefixed to '/admin/static/<path:filename>'
      [('/admin/static/<path:filename>', 'admin.static')]
```

---

## 3. The architecture, with the code that implements it

### 3.1 The shared base: `Scaffold` (registration base + static geometry)

`src/flask/sansio/scaffold.py:42-73` (verbatim):
```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))


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

The static-asset geometry shared by both components — `src/flask/sansio/scaffold.py:217-278` (verbatim):
```python
    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.name!r}>"

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

    @cached_property
    def jinja_loader(self) -> BaseLoader | None:
        """The Jinja loader for this object's templates. By default this
        is a class :class:`jinja2.loaders.FileSystemLoader` to
        :attr:`template_folder` if it is set.

        .. versionadded:: 0.5
        """
        if self.template_folder is not None:
            return FileSystemLoader(os.path.join(self.root_path, self.template_folder))
        else:
            return None
```

`Scaffold.__init__` (`src/flask/sansio/scaffold.py:75-108`) assigns the shared static geometry and the shared registration dicts; verbatim head:
```python
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

        #: The path to the templates folder, relative to
        #: :attr:`root_path`, to add to the template loader. ``None`` if
        #: templates should not be added.
        self.template_folder = template_folder

        if root_path is None:
            root_path = get_root_path(self.import_name)

        #: Absolute path to the package on the filesystem. Used to look
        #: up resources contained in the package.
        self.root_path = root_path

        #: A dictionary mapping endpoint names to view functions.
        ...
        self.view_functions: dict[str, ft.RouteCallable] = {}
```
(the rest of that body creates `error_handler_spec` (118-123), `before_request_funcs` (130-132), `after_request_funcs` (139-141), `teardown_request_funcs` (148-150), `template_context_processors` (157-160, seeded `{None: [_default_template_ctx_processor]}`), `url_value_preprocessors` (168-171), `url_default_functions` (178-180).)

The `sansio`/`Scaffold` split is mandated by `src/flask/sansio/README.md` (whole file):
```
# Sansio

This folder contains code that can be used by alternative Flask
implementations, for example Quart. The code therefore cannot do any
IO, nor be part of a likely IO path. Finally this code cannot use the
Flask globals.
```

Both components subclass it; the class graph is anchored by:
* `src/flask/sansio/app.py:31-34` →
  ```
  from .scaffold import _endpoint_from_view_func
  from .scaffold import find_package
  from .scaffold import Scaffold
  from .scaffold import setupmethod
  ```
  and `src/flask/sansio/app.py:59` → `class App(Scaffold):`
* `src/flask/blueprints.py:10,18` →
  ```
  from .sansio.blueprints import Blueprint as SansioBlueprint
  ...
  class Blueprint(SansioBlueprint):
  ```
* `src/flask/app.py:39` → `from .sansio.app import App`; `src/flask/app.py:81` → `class Flask(App):`

The probe `mro_check.py` (whole file, `experiments/data/flask-src-scratch/mro_check.py`) prints the graph and proves where the cache hook lives:
```python
import flask, flask.sansio.app, flask.sansio.blueprints, flask.sansio.scaffold
print("Flask.__mro__      :", [c.__name__ for c in flask.Flask.__mro__])
print("Blueprint.__mro__  :", [c.__name__ for c in flask.Blueprint.__mro__])
Scaffold = flask.sansio.scaffold.Scaffold
print("Scaffold.__mro__   :", [c.__name__ for c in Scaffold.__mro__])
print()
print("Scaffold defines send_static_file?            ", 'send_static_file' in Scaffold.__dict__)
print("Scaffold defines get_send_file_max_age?       ", 'get_send_file_max_age' in Scaffold.__dict__)
print("Scaffold defines has_static_folder?           ", 'has_static_folder' in Scaffold.__dict__)
print("Concrete Flask defines __init__?              ", '__init__' in flask.Flask.__dict__)
print("Concrete Flask defines send_static_file?      ", 'send_static_file' in flask.Flask.__dict__)
print("Concrete Flask defines get_send_file_max_age? ", 'get_send_file_max_age' in flask.Flask.__dict__)
print("Concrete Blueprint defines __init__?          ", '__init__' in flask.Blueprint.__dict__)
print("Concrete Blueprint defines send_static_file?  ", 'send_static_file' in flask.Blueprint.__dict__)
print("Concrete Blueprint defines get_send_file_max_age?", 'get_send_file_max_age' in flask.Blueprint.__dict__)
app = flask.Flask(__name__)
bp = flask.Blueprint("b", __name__)
print()
print("-- registration data structures: first MRO class holding the attr --")
for name in ("view_functions","before_request_funcs","after_request_funcs","teardown_request_funcs","error_handler_spec","url_value_preprocessors","template_context_processors","cli"):
    owner = next((c.__name__ for c in flask.Flask.__mro__ if name in c.__dict__), "<class slot? no>")
    print(f"  {name:34s} -> {owner}")
print()
print("app.view_functions attr exists:", hasattr(app, "view_functions"))
print("bp.view_functions attr exists :", hasattr(bp, "view_functions"))
print("Scaffold defines 'json'?      ", 'json' in Scaffold.__dict__)
print("Flask defines 'json'?         ", 'json' in flask.Flask.__dict__)
```

Fresh output (`mro_check.run-static-arch.txt`, CMD 42):
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

-- registration data structures: first MRO class holding the attr --
  view_functions                     -> <class slot? no>
  before_request_funcs               -> <class slot? no>
  after_request_funcs                -> <class slot? no>
  teardown_request_funcs             -> <class slot? no>
  error_handler_spec                 -> <class slot? no>
  url_value_preprocessors            -> <class slot? no>
  template_context_processors        -> <class slot? no>
  cli                                -> <class slot? no>

app.view_functions attr exists: True
bp.view_functions attr exists : True
Scaffold defines 'json'?       False
Flask defines 'json'?          False
```
> This is decisive on the version-specific shape: **`Scaffold` does *not* define `get_send_file_max_age` or `send_static_file` at `85c5d93`**; it defines the geometry (`has_static_folder`). `<class slot? no>` is expected for the registration dicts — they are per-instance attributes assigned in `Scaffold.__init__`, not class attributes.

The `@setupmethod` guard is *shared* but *specialized* per component through the abstract `_check_setup_finished`:

`src/flask/sansio/app.py:409-423`:
```python
        # tracks internally if the application already handled at least one
        # request.
        self._got_first_request = False

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
`src/flask/sansio/blueprints.py:172,213-221`:
```python
    _got_registered_once = False
    ...
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

### 3.2 The main framework's **eager** static registration (`Flask.__init__`)

`src/flask/app.py:226-279` (verbatim):
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
    ):
        super().__init__(
            import_name=import_name,
            static_url_path=static_url_path,
            static_folder=static_folder,
            static_host=static_host,
            host_matching=host_matching,
            subdomain_matching=subdomain_matching,
            template_folder=template_folder,
            instance_path=instance_path,
            instance_relative_config=instance_relative_config,
            root_path=root_path,
        )

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
Anchors inside this block: `:262` first comment line, `:267 if self.has_static_folder:`, `:268-270` the assert, `:271` `# Use a weakref…`, `:273 self_ref = weakref.ref(self)`, `:274 self.add_url_rule(`, `:275` f-string, `:276 endpoint="static",`, `:277 host=static_host,`, `:278` the lambda.

The app-side cache hook and static view — `src/flask/app.py:281-328` (verbatim):
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

The single app-level cache key — `src/flask/app.py:198-201`, inside `default_config = ImmutableDict({...})`:
```python
            "MAX_CONTENT_LENGTH": None,
            "MAX_FORM_MEMORY_SIZE": 500_000,
            "MAX_FORM_PARTS": 1_000,
            "SEND_FILE_MAX_AGE_DEFAULT": None,
```

### 3.3 The modular component's **deferred** static registration (`Blueprint.register` → `BlueprintSetupState`)

`src/flask/sansio/blueprints.py:87-117` — `BlueprintSetupState.add_url_rule`, the deferred→app channel (verbatim):
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

`src/flask/sansio/blueprints.py:273-330` — `register()` head + deferred static block (verbatim):
```python
    def register(self, app: App, options: dict[str, t.Any]) -> None:
        """Called by :meth:`Flask.register_blueprint` to register all
        views and callbacks registered on the blueprint with the
        application. Creates a :class:`.BlueprintSetupState` and calls
        each :meth:`record` callback with it.

        :param app: The application this blueprint is being registered
            with.
        :param options: Keyword arguments forwarded from
            :meth:`~Flask.register_blueprint`.

        .. versionchanged:: 2.3
            Nested blueprints now correctly apply subdomains.

        .. versionchanged:: 2.1
            Registering the same blueprint with the same name multiple
            times is an error.

        .. versionchanged:: 2.0.1
            Nested blueprints are registered with their dotted name.
            This allows different blueprints with the same name to be
            nested at different locations.

        .. versionchanged:: 2.0.1
            The ``name`` option can be used to change the (pre-dotted)
            name the blueprint is registered with. This allows the same
            blueprint to be registered multiple times with unique names
            for ``url_for``.
        """
        name_prefix = options.get("name_prefix", "")
        self_name = options.get("name", self.name)
        name = f"{name_prefix}.{self_name}".lstrip(".")

        if name in app.blueprints:
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(
                f"The name '{self_name}' is already registered for"
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )

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
The static block is exactly at `:323-328`. Note `register` is **not** decorated with `@setupmethod` (contrast `App.register_blueprint`, `@setupmethod` at `sansio/app.py:569`); it is the moment the blueprint transitions from the blueprint phase to the app phase, and `_got_registered_once = True` at `:320` flips the blueprint's own guard.

Blueprint static files are **off by default** — `src/flask/sansio/blueprints.py:174-211` (verbatim):
```python
    def __init__(
        self,
        name: str,
        import_name: str,
        static_folder: str | os.PathLike[str] | None = None,
        static_url_path: str | None = None,
        template_folder: str | os.PathLike[str] | None = None,
        url_prefix: str | None = None,
        subdomain: str | None = None,
        url_defaults: dict[str, t.Any] | None = None,
        root_path: str | None = None,
        cli_group: str | None = _sentinel,  # type: ignore[assignment]
    ):
        super().__init__(
            import_name=import_name,
            static_folder=static_folder,
            static_url_path=static_url_path,
            template_folder=template_folder,
            root_path=root_path,
        )

        if not name:
            raise ValueError("'name' may not be empty.")

        if "." in name:
            raise ValueError("'name' may not contain a dot '.' character.")

        self.name = name
        self.url_prefix = url_prefix
        self.subdomain = subdomain
        self.deferred_functions: list[DeferredSetupFunction] = []

        if url_defaults is None:
            url_defaults = {}

        self.url_values_defaults = url_defaults
        self.cli_group = cli_group
        self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
```

The documented precedence caveat, `src/flask/sansio/blueprints.py:138-147` (verbatim, from the `Blueprint` docstring):
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

`Blueprint.add_url_rule` records a **deferred lambda** rather than adding a rule immediately — `src/flask/sansio/blueprints.py:413-435` (verbatim):
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

The modular component's caching half is a **duplicate** of the app's — `src/flask/blueprints.py:55-102` (verbatim):
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

**Byte-identity of the two duplicated bodies**, CMD 25:
```
diff <(sed -n '281,328p' src/flask/app.py) <(sed -n '55,102p' src/flask/blueprints.py)
diff exit:0 (0 = byte-identical)
```

### 3.4 Why the explicit call in `send_static_file` is required (the caching-consistency device)

`src/flask/helpers.py:387-398` (verbatim) — the generic helper can reach **only the app's** hook:
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

`src/flask/helpers.py:565-567` — tail of `send_from_directory` (verbatim):
```python
    return werkzeug.utils.send_from_directory(  # type: ignore[return-value]
        directory, path, **_prepare_send_file_kwargs(**kwargs)
    )
```
Its docstring (`src/flask/helpers.py:531-…`) says: *"This is a secure way to serve files from a folder, such as static files or uploads. Uses `safe_join` to ensure the path coming from the client is not maliciously crafted to point outside the specified directory."*

Where `max_age` finally becomes `Cache-Control` — installed Werkzeug 3.1.3, `flask-src/.venv/Lib/site-packages/werkzeug/utils.py:500-513` (verbatim):
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
That werkzeug comment — *"Flask will pass app.get_send_file_max_age, allowing its send_file wrapper to not have to deal with paths"* — is exactly the constraint the duplicated `send_static_file` works around.

### 3.5 The documentation contract

`docs/config.rst:250-262` (verbatim, incl. the trailing `Default:` line at `:262`):
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

`docs/blueprints.rst:191-215` (verbatim) — the modular static component as documented:
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

`docs/quickstart.rst:337-353` (verbatim) — the app-side contract:
```
Static Files
------------

Dynamic web applications also need static files.  That's usually where
the CSS and JavaScript files are coming from.  Ideally your web server is
configured to serve them for you, but during development Flask can do that
as well.  Just create a folder called :file:`static` in your package or next to
your module and it will be available at ``/static`` on the application.

To generate URLs for static files, use the special ``'static'`` endpoint name::

    url_for('static', filename='style.css')

The file has to be stored on the filesystem as :file:`static/style.css`.
```

---

## 4. The caching flow, in prose

For **either** component, serving a static file at `85c5d93` follows this exact chain:

1. **Route resolution.** The app contributes `/static/<path:filename>` with endpoint `static`; the blueprint contributes `/admin/static/<path:filename>` with endpoint `admin.static`. They are two distinct rules in one `app.url_map`.
2. **`send_static_file`** is the view (`Flask.send_static_file`, `src/flask/app.py:308`; `Blueprint.send_static_file`, `src/flask/blueprints.py:82`). It first guards `if not self.has_static_folder: raise RuntimeError("'static_folder' must be set to serve static_files.")`.
3. **`self.get_send_file_max_age(filename)`** is called **explicitly by the component itself** — `Flask`'s call reaches `Flask.get_send_file_max_age`; `Blueprint`'s call reaches `Blueprint.get_send_file_max_age`. This is the *only* way a blueprint can route its caching through its own hook, because the generic helper path binds to `current_app` (next step).
4. **The hook reads the single app-level key** `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` — one default declaration at `src/flask/app.py:201`, one read in each of the two hooks. `None` ⇒ return `None`; `timedelta` ⇒ return `int(value.total_seconds())`; otherwise return the raw int.
5. **`max_age=` is passed explicitly into `send_from_directory`** (`max_age = self.get_send_file_max_age(filename)` then `send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)`).
6. **The helper passes the explicit value through.** `send_from_directory` (`src/flask/helpers.py:526`) calls `werkzeug.utils.send_from_directory(directory, path, **_prepare_send_file_kwargs(**kwargs))`; in `_prepare_send_file_kwargs`, `if kwargs.get("max_age") is None:` is **false** (it was just set), so `current_app.get_send_file_max_age` is **not** substituted, and the component's value survives.
7. **Werkzeug emits `Cache-Control`.** In `werkzeug/utils.py:500-513`: `no_cache = True` initially; if `max_age` is a callable it is invoked (Flask's app-hook fallback); if `max_age is not None` and `> 0` then `no_cache = None` and `public = True`, and `max_age` is written to `rv.cache_control.max_age` (and `rv.expires`). Result: `None` ⇒ `Cache-Control: no-cache` (conditional requests, no `max-age`); `3600` ⇒ `public, max-age=3600`.
8. **The generic fallback path (`flask.send_file` / `flask.send_from_directory` WITHOUT `max_age`) binds to the app only.** `_prepare_send_file_kwargs` sets `kwargs["max_age"] = current_app.get_send_file_max_age`, i.e. the app hook — so a blueprint can only customize its own static caching via `Blueprint.send_static_file`'s explicit call, never via the global helpers. This is the mechanical reason for the deliberate duplication.

The run's own flow table confirms the whole chain, per config value (run-2 log, §6):
```
PASS  C6: config=None -> app max_age=None / blueprint max_age=None
      app(header='no-cache', max_age=None) bp(header='no-cache', max_age=None)
PASS  C6: config=3600 -> app max_age=3600 / blueprint max_age=3600
      app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)
PASS  C6: config=7200 -> app max_age=7200 / blueprint max_age=7200
      app(header='public, max-age=7200', max_age=7200) bp(header='public, max-age=7200', max_age=7200)
PASS  C6: config=datetime.timedelta(seconds=3600) -> app max_age=3600 / blueprint max_age=3600
      app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)
```

---

## 5. Caveats: what the “consistent” guarantee does and does not cover

1. **Consistency is about cache-*age* derivation, not routing symmetry.** `Cache-Control` max-age is identical across both components under the shared config key, but routing is deliberately asymmetric (see 2–4 below).
2. **No-`url_prefix` blueprint static is shadowed, not merged.** A blueprint with `static_folder` but no `url_prefix` registers its rule at `/static/<path:filename>` (endpoint `noprefix.static`), which collides with the app's `/static/<path:filename>` rule; the app rule takes precedence and a blueprint-only file 404s. Verbatim from `docs/blueprints.rst:209-215`: *"However, if the blueprint does not have a ``url_prefix``, it is not possible to access the blueprint's static folder. This is because the URL would be ``/static`` in this case, and the application's ``/static`` route takes precedence. Unlike template folders, blueprint static folders are not searched if the file does not exist in the application static folder."* The run confirms it:
   ```
   [PASS] 6a: blueprint without url_prefix registers endpoint 'noprefix.static' at '/static/<path:filename>' :: [('/static/<path:filename>', 'static'), ('/static/<path:filename>', 'noprefix.static')]
   [PASS] 6a: blueprint-only file unreachable under /static (app rule takes precedence) -> 404 :: status=404 (expected 404; file exists only in SCRATCH/static)
   [PASS] 6a: /static/index.html still serves the APP static folder :: status=200 data=b'<h1>Hello World!</h1>\n'
   ```
3. **An explicit `max_age=` bypasses the hook entirely.** If a caller passes `max_age=42` to `send_file`/`send_from_directory`, `_prepare_send_file_kwargs` leaves it alone and werkzeug writes `42`:
   ```
   [PASS] C8: explicit max_age=42 bypasses get_send_file_max_age entirely :: header='public, max-age=42' max_age=42
   ```
4. **`flask.send_file` / `send_from_directory` fall back to the app hook only** — a blueprint hook cannot influence them. The run's C8 evidence:
   ```
   [PASS] C8: send_from_directory(no max_age) picks up the APP hook (999) :: header='public, max-age=999' max_age=999
   [PASS] C8: blueprint.send_static_file uses the BLUEPRINT hook (100), not the app hook (999) :: header='public, max-age=100' max_age=100
   ```
5. **Per-component override still works** — a `Blueprint` subclass overriding `get_send_file_max_age` returns 100 even when config says 3600, while the app path still reads config:
   ```
   [PASS] C7: blueprint hook 100 beats config 3600 on blueprint path :: blueprint header='public, max-age=100' max_age=100
   [PASS] C7: app path still reads config 3600 (hooks are independent) :: app header='public, max-age=3600' max_age=3600
   ```
6. **Boundary behavior.** `static_folder=None` ⇒ no `static` endpoint at all and `send_static_file` raises `RuntimeError("'static_folder' must be set to serve static_files.")`; `static_host` without `host_matching` (and vice versa) ⇒ `AssertionError("Invalid static_host/host_matching combination")`:
   ```
   [PASS] 6b: send_static_file with static_folder=None raises RuntimeError :: "'static_folder' must be set to serve static_files."
   [PASS] 6b: static_folder=None -> no 'static' endpoint at all :: []
   [PASS] 6c: static_host without host_matching raises AssertionError :: 'Invalid static_host/host_matching combination'
   [PASS] 6c: host_matching=True without static_host raises AssertionError :: 'Invalid static_host/host_matching combination'
   [PASS] 6c: host_matching=True + static_host -> static rule carries the host :: [('/static/<path:filename>', 'static')]
   ```
7. **The shared `@setupmethod` guard is phase-specific.** Registering a blueprint after the first request raises the *app*-phase message; calling `bp.route` after registration raises the *blueprint*-phase message:
   ```
   [PASS] 7: register_blueprint after first request raises AssertionError (app-phase guard) :: "The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the application are done before running it."
   [PASS] 7: blueprint.route after registration raises AssertionError (blueprint-phase guard) :: "The setup method 'route' can no longer be called on the blueprint 'late2'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
   ```
8. **Version-specific trap, stated explicitly:** at this commit the cache hook lives on the **concrete** classes `Flask` and `Blueprint`, **not** on `Scaffold`. `grep` over `src/flask/sansio/scaffold.py` for `send_static_file|get_send_file_max_age|SEND_FILE_MAX_AGE_DEFAULT|send_from_directory` returns **no matches** (grep exit 1), and the MRO probe prints `Scaffold defines get_send_file_max_age? False`. An answer written from a later Flask release would wrongly claim `Scaffold.get_send_file_max_age`.
9. **Quirk worth naming:** both duplicated docstrings say *"Note this is a duplicate of the same method in the Flask class."* — including `Flask.get_send_file_max_age`'s own docstring (`src/flask/app.py:290-291`), i.e. the Flask-class copy carries a note claiming to be a duplicate of the Flask class. This is a real copy-paste artifact of this commit; the behavior is nonetheless proven by the byte-identity check and by the run.

---

## 6. The exact words of the in-code comments that prove intent

From `src/flask/app.py:323-324` (and byte-identically `src/flask/blueprints.py:97-98`):
```python
        # send_file only knows to call get_send_file_max_age on the app,
        # call it here so it works for blueprints too.
```

From `src/flask/app.py:271-272`:
```python
            # Use a weakref to avoid creating a reference cycle between the app
            # and the view function (see #3761).
```

From `src/flask/sansio/blueprints.py:138-147` (the documented precedence caveat, quoted in full in §5.2).

---

## 7. Behavioral verification (fresh, this session)

All runs used `flask-src/.venv/Scripts/python.exe` (whose `flask.pth` → `flask-src/src`); the harness's first printed line proves `flask.__file__` resolves inside the checkout, so the results describe commit `85c5d93` and not an installed site-package. No writes occurred inside `flask-src/`.

### 7.1 The 28-check harness log — `repro_static_architecture.py.run2-raw` (CMD 39, exit 0)

```
==============================================================================
flask: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
SCRATCH: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src-scratch
TESTS  : D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\tests
==============================================================================

--- step 1: eager app-side registration + weakref (C4) ---
[PASS] C4: exactly one rule with endpoint 'static' :: [('/static/<path:filename>', 'static')]
[PASS] C4: rule literal == '/static/<path:filename>' :: [('/static/<path:filename>', 'static')]
[PASS] C4: view_functions['static'] exists :: <function Flask.__init__.<locals>.<lambda> at 0x000001EA54B104A0>
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
[PASS] 6a: blueprint without url_prefix registers endpoint 'noprefix.static' at '/static/<path:filename>' :: [('/static/<path:filename>', 'static'), ('/static/<path:filename>', 'noprefix.static')]
[PASS] 6a: blueprint-only file unreachable under /static (app rule takes precedence) -> 404 :: status=404 (expected 404; file exists only in SCRATCH/static)
[PASS] 6a: /static/index.html still serves the APP static folder :: status=200 data=b'<h1>Hello World!</h1>\n'
[PASS] 6b: send_static_file with static_folder=None raises RuntimeError :: "'static_folder' must be set to serve static_files."
[PASS] 6b: static_folder=None -> no 'static' endpoint at all :: []
[PASS] 6c: static_host without host_matching raises AssertionError :: 'Invalid static_host/host_matching combination'
[PASS] 6c: host_matching=True without static_host raises AssertionError :: 'Invalid static_host/host_matching combination'
[PASS] 6c: host_matching=True + static_host -> static rule carries the host :: [('/static/<path:filename>', 'static')]

--- step 7: shared setupmethod guard (bonus: discovered during run 1) ---
[PASS] 7: register_blueprint after first request raises AssertionError (app-phase guard) :: "The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the application are done before running it."
   full guard message:
   The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.
   Make sure all imports, decorators, functions, etc. needed to set up the application are done before running it.
[PASS] 7: blueprint.route after registration raises AssertionError (blueprint-phase guard) :: "The setup method 'route' can no longer be called on the blueprint 'late2'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
   full guard message:
   The setup method 'route' can no longer be called on the blueprint 'late2'. It has already been registered at least once, any changes will not be applied consistently.
   Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.

==============================================================================
RESOLVED RULE / ENDPOINT / MAX-AGE TABLE
==============================================================================
PASS  C4: exactly one rule with endpoint 'static'
      [('/static/<path:filename>', 'static')]
PASS  C4: rule literal == '/static/<path:filename>'
      [('/static/<path:filename>', 'static')]
PASS  C4: view_functions['static'] exists
      <function Flask.__init__.<locals>.<lambda> at 0x000001EA54B104A0>
PASS  C4: view closure holds a weakref.ref to the app (issue #3761)
      ['ReferenceType']
PASS  C5: blueprint static rule prefixed to '/admin/static/<path:filename>'
      [('/admin/static/<path:filename>', 'admin.static')]
PASS  C5: url_for('admin.static', filename='test.txt')
      '/admin/static/test.txt'
PASS  C5: GET /admin/static/test.txt serves blueprint file
      status=200 data=b'Admin File\n'
PASS  C5: GET /admin/static/css/test.css (nested) serves blueprint file
      status=200 data=b'/* nested file */\n'
PASS  C6: config=None -> app max_age=None / blueprint max_age=None
      app(header='no-cache', max_age=None) bp(header='no-cache', max_age=None)
PASS  C6: default None -> conditional-cache on BOTH paths (no-cache, no max-age)
      app='no-cache' bp='no-cache'
PASS  C6: config=3600 -> app max_age=3600 / blueprint max_age=3600
      app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)
PASS  C6: config=7200 -> app max_age=7200 / blueprint max_age=7200
      app(header='public, max-age=7200', max_age=7200) bp(header='public, max-age=7200', max_age=7200)
PASS  C6: config=datetime.timedelta(seconds=3600) -> app max_age=3600 / blueprint max_age=3600
      app(header='public, max-age=3600', max_age=3600) bp(header='public, max-age=3600', max_age=3600)
PASS  C7: blueprint hook 100 beats config 3600 on blueprint path
      blueprint header='public, max-age=100' max_age=100
PASS  C7: app path still reads config 3600 (hooks are independent)
      app header='public, max-age=3600' max_age=3600
PASS  C8: send_from_directory(no max_age) picks up the APP hook (999)
      header='public, max-age=999' max_age=999
PASS  C8: explicit max_age=42 bypasses get_send_file_max_age entirely
      header='public, max-age=42' max_age=42
PASS  C8: blueprint.send_static_file uses the BLUEPRINT hook (100), not the app hook (999)
      header='public, max-age=100' max_age=100
PASS  6a: blueprint without url_prefix registers endpoint 'noprefix.static' at '/static/<path:filename>'
      [('/static/<path:filename>', 'static'), ('/static/<path:filename>', 'noprefix.static')]
PASS  6a: blueprint-only file unreachable under /static (app rule takes precedence) -> 404
      status=404 (expected 404; file exists only in SCRATCH/static)
PASS  6a: /static/index.html still serves the APP static folder
      status=200 data=b'<h1>Hello World!</h1>\n'
PASS  6b: send_static_file with static_folder=None raises RuntimeError
      "'static_folder' must be set to serve static_files."
PASS  6b: static_folder=None -> no 'static' endpoint at all
      []
PASS  6c: static_host without host_matching raises AssertionError
      'Invalid static_host/host_matching combination'
PASS  6c: host_matching=True without static_host raises AssertionError
      'Invalid static_host/host_matching combination'
PASS  6c: host_matching=True + static_host -> static rule carries the host
      [('/static/<path:filename>', 'static')]
PASS  7: register_blueprint after first request raises AssertionError (app-phase guard)
      "The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the application are done before running it."
PASS  7: blueprint.route after registration raises AssertionError (blueprint-phase guard)
      "The setup method 'route' can no longer be called on the blueprint 'late2'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
==============================================================================
TOTAL CHECKS: 28   PASS: 28   FAIL: 0
ALL ASSERTIONS PASSED
PIPELINE_EXIT:0
```

### 7.2 The three upstream test locks (CMD 41, exit 0) — `pytest-locks-static-arch-run2.txt`

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 3 items

tests/test_blueprints.py::test_templates_and_static PASSED               [ 33%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [ 66%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [100%]

============================== 3 passed in 0.37s ==============================
PIPELINE_EXIT:0
```

Those tests assert exactly the architecture described. `tests/test_blueprints.py:176-212` (`test_templates_and_static`, verbatim):
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
```

`tests/test_blueprints.py:223-245` (`test_default_static_max_age`, verbatim) — the per-component hook lock:
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

`tests/test_helpers.py:45-89` (`TestSendfile.test_static_file`, verbatim) — the app-side lock, including the `send_file` app-hook fallback:
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

The fixtures these tests use — `tests/conftest.py:44-51` (verbatim):
```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app
```
and the blueprint fixture `tests/test_apps/blueprintapp/apps/admin/__init__.py` (whole file):
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
Static fixtures present (verified): `tests/static/` = `config.json`, `config.toml`, `index.html`; `tests/test_apps/blueprintapp/apps/admin/static/` = `css/`, `test.txt` (and `css/test.css`).

### 7.3 Full upstream suite (CMD 43 + CMD 44)

Normal verbosity, summary line: `489 passed in 3.48s`, `PIPELINE_EXIT:0`. Maximum verbosity `-vv -rA` → `PYTEST_EXIT:0`; the four target node IDs appear as:
```
93:tests/test_basic.py::test_static_files PASSED                            [ 17%]
94:tests/test_basic.py::test_static_url_path PASSED                         [ 17%]
95:tests/test_basic.py::test_static_url_path_with_ending_slash PASSED       [ 17%]
99:tests/test_basic.py::test_static_folder_with_ending_slash PASSED         [ 18%]
100:tests/test_basic.py::test_static_route_with_host_matching PASSED        [ 19%]
176:tests/test_blueprints.py::test_templates_and_static PASSED               [ 34%]
177:tests/test_blueprints.py::test_default_static_max_age PASSED             [ 34%]
300:tests/test_helpers.py::TestSendfile::test_static_file PASSED             [ 59%]
1048:PASSED tests/test_basic.py::test_static_files
1049:PASSED tests/test_basic.py::test_static_url_path
1050:PASSED tests/test_basic.py::test_static_url_path_with_ending_slash
1054:PASSED tests/test_basic.py::test_static_folder_with_ending_slash
1055:PASSED tests/test_basic.py::test_static_route_with_host_matching
1131:PASSED tests/test_blueprints.py::test_templates_and_static
1132:PASSED tests/test_blueprints.py::test_default_static_max_age
1255:PASSED tests/test_helpers.py::TestSendfile::test_static_file
```
Tail: `489 passed in 4.35s`; `grep -c "PASSED"` = 978 (= 489 progress + 489 `-rA`), `grep -c "FAILED"` = **0**. Full log `flask-src-scratch/pytest-full-static-arch-vv-rA.txt`, 1452 lines / 104,999 bytes, sha256 `eb47a2afe64a924033b6dc7997c4c7f989c9b5920a28a26df9febc500ebc5ac2`.

### 7.4 Post-run integrity

CMD 47 (after all runs): `git status --porcelain=v1 -uall` → `?? flask_mut2_i417ar2x/mutated_test.py` (the pre-existing, unrelated mutation fixture); `git rev-parse HEAD` → `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`; `git diff --stat` → **empty**. The preserved run-1 artifact hash is identical before and after (`ec6c51d2c435ba4db00ea4424ab9a8d81c7d15cd37d372ea4e9ed6033ffff365`), i.e. `repro_static_architecture.py.run1-raw` was **not** overwritten; the run wrote a new file `repro_static_architecture.py.run2-raw` (sha256 `52398226ebc7a17fa37901a68c53cae36d9f7a003b8a86f54aac85bb1909fe9d`, 10,141 bytes). New artifacts (all under `experiments/data/flask-src-scratch/` only):

| file | bytes | sha256 | what it is |
|---|---|---|---|
| `repro_static_architecture.py.run2-raw` | 10141 | `52398226ebc7a17fa37901a68c53cae36d9f7a003b8a86f54aac85bb1909fe9d` | the 28/28 verification log |
| `mro_check.run-static-arch.txt` | 1351 | `d449f20ffefe8ef7c4afb15af206532e8d43ae2cdbd929a6a959f03df2059978` | MRO + "hook not on Scaffold" |
| `pytest-locks-static-arch-run2.txt` | 740 | `859203e6b000a7f5276f953547b1a367cd220b3755b85ac5b5f8b01e994dadac` | 3 upstream locks |
| `pytest-full-static-arch-normal.txt` | 2495 | `46c87f5e6d44c2dac40cc99125a55f476bfc10551edfdf44f0c5db66561a6c4c` | full suite run 1 |
| `pytest-full-static-arch-vv-rA.txt` | 104999 | `eb47a2afe64a924033b6dc7997c4c7f989c9b5920a28a26df9febc500ebc5ac2` | full suite run 2 |

Note on the harness provenance: its docstring says the run-1 crash was an ordering defect (`register_blueprint` after the first request tripped the shared guard). Quoted in full from `repro_static_architecture.py:1-17`:
```
"""Independent behavioural reproduction (naive-executor, plan section 4).

Runs against the flask checkout at
  D:/.../experiments/data/flask-src  @ 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642

Never writes inside flask-src/. Scratch dir only.

RUN-2 REVISION NOTE (naive-executor): run 1 crashed in step 4 because the script
called `app.register_blueprint(bp_override)` *after* `client.get(...)` had already
served a request -- and Flask's shared `setupmethod` guard then raised
AssertionError ("The setup method 'register_blueprint' can no longer be called on
the application. It has already handled its first request..."). The raw run-1
traceback is preserved verbatim in the executor report and the run-1 script copy
`repro_static_architecture.py.run1-raw`. This is a harness ordering defect, not a
falsification of C7: all registrations are now done before the first request, and
the guard itself is additionally asserted as its own check (step 7), since it is
direct evidence for the shared `setupmethod`/`_check_setup_finished` mechanism.
"""
```
(`run1-raw` turned out to be a *script copy* with no traceback text; the scratch dir contains no `Traceback` outside the `pytest-full-*.txt` logs.)

---

## 8. Evidence table (`file:line` for every claim)

| # | Claim | Evidence |
|---|---|---|
| 1 | Shared base is `Scaffold`, common to `Flask`/`Blueprint` | `src/flask/sansio/scaffold.py:52` + docstring lines 53-54: `class Scaffold:` / `"""Common behavior shared between :class:`~flask.Flask` and :class:`~flask.blueprints.Blueprint`.` |
| 2 | `Scaffold` owns static geometry (folder/url path/has_static_folder/jinja_loader) | `src/flask/sansio/scaffold.py:224-278` |
| 3 | `Scaffold` does **not** own the cache hook or static view | grep in `scaffold.py` for `send_static_file\|get_send_file_max_age\|SEND_FILE_MAX_AGE_DEFAULT\|send_from_directory` → no matches; `mro_check.run-static-arch.txt`: `Scaffold defines get_send_file_max_age? False`, `Scaffold defines send_static_file? False`, `Scaffold defines has_static_folder? True` |
| 4 | Shared `@setupmethod` guard delegating to `_check_setup_finished` | `src/flask/sansio/scaffold.py:42-48` |
| 5 | Guard specialization, app phase | `src/flask/sansio/app.py:409-423` (`self._got_first_request = False`, then `_check_setup_finished`) |
| 6 | Guard specialization, blueprint phase | `src/flask/sansio/blueprints.py:172` (`_got_registered_once = False`) and `:213-221` |
| 7 | Class graph `Flask → App → Scaffold` | `src/flask/app.py:39` (`from .sansio.app import App`), `src/flask/app.py:81` (`class Flask(App):`), `src/flask/sansio/app.py:59` (`class App(Scaffold):`), `src/flask/sansio/app.py:33` (`from .scaffold import Scaffold`) |
| 8 | Class graph `Blueprint → SansioBlueprint → Scaffold` | `src/flask/blueprints.py:10` (`from .sansio.blueprints import Blueprint as SansioBlueprint`), `src/flask/blueprints.py:18` (`class Blueprint(SansioBlueprint):`), `src/flask/sansio/blueprints.py:119` (`class Blueprint(Scaffold):`) |
| 9 | Empirical MRO | `mro_check.run-static-arch.txt`: `Flask.__mro__ : ['Flask', 'App', 'Scaffold', 'object']`; `Blueprint.__mro__ : ['Blueprint', 'Blueprint', 'Scaffold', 'object']` |
| 10 | App registers static route **eagerly** in `__init__` | `src/flask/app.py:267-279` (`if self.has_static_folder:` … `self.add_url_rule(f"{self.static_url_path}/<path:filename>", endpoint="static", host=static_host, view_func=lambda **kw: self_ref().send_static_file(**kw))`) |
| 11 | App static view is `weakref`-closing (issue #3761) | `src/flask/app.py:271-273` (`# Use a weakref…` / `self_ref = weakref.ref(self)`); run: `PASS C4: view closure holds a weakref.ref … ['ReferenceType']` |
| 12 | App default `static_folder` is `"static"` | `src/flask/app.py:228` |
| 13 | App route resolves to exactly one `/static/<path:filename>` endpoint `static` | run: `PASS C4: exactly one rule with endpoint 'static' :: [('/static/<path:filename>', 'static')]` |
| 14 | Blueprint registers static route **deferred** in `register` | `src/flask/sansio/blueprints.py:323-328` |
| 15 | Deferred channel is `BlueprintSetupState.add_url_rule` (prefixing rule + endpoint) | `src/flask/sansio/blueprints.py:87-117` |
| 16 | Blueprint route URL/endpoint | run: `PASS C5: blueprint static rule prefixed to '/admin/static/<path:filename>' :: [('/admin/static/<path:filename>', 'admin.static')]`; `PASS C5: url_for('admin.static', filename='test.txt') :: '/admin/static/test.txt'` |
| 17 | Blueprint static is **off by default** | `src/flask/sansio/blueprints.py:177` (`static_folder: str \| os.PathLike[str] \| None = None`) + docstring `:138-143` (`Blueprint static files are disabled by default.`) |
| 18 | Blueprint `add_url_rule` records a deferred lambda | `src/flask/sansio/blueprints.py:413-435` |
| 19 | `register` is not `@setupmethod` (contrast app) | `src/flask/sansio/blueprints.py:273` (no decorator) vs `src/flask/sansio/app.py:569` (`@setupmethod` on `register_blueprint`) |
| 20 | Cache hook duplicated on both concrete classes | `src/flask/app.py:281` (`def get_send_file_max_age`) and `src/flask/blueprints.py:55` (`def get_send_file_max_age`) |
| 21 | The two bodies are byte-identical | CMD 25: `diff <(sed -n '281,328p' src/flask/app.py) <(sed -n '55,102p' src/flask/blueprints.py)` → `diff exit:0 (0 = byte-identical)` |
| 22 | Both hooks read the one config key | `src/flask/app.py:298` and `src/flask/blueprints.py:72`: `value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` |
| 23 | Single default declaration | `src/flask/app.py:201`: `"SEND_FILE_MAX_AGE_DEFAULT": None,` inside `default_config` (`:198-201`) |
| 24 | Both `send_static_file`s call their own hook | `src/flask/app.py:325` and `src/flask/blueprints.py:99`: `max_age = self.get_send_file_max_age(filename)` |
| 25 | Both `send_static_file`s guard missing folder | `src/flask/app.py:320-321` and `src/flask/blueprints.py:96-97`: `raise RuntimeError("'static_folder' must be set to serve static_files.")`; run: `PASS 6b: send_static_file with static_folder=None raises RuntimeError` |
| 26 | Generic helper binds only the app hook | `src/flask/helpers.py:387-398` (`kwargs["max_age"] = current_app.get_send_file_max_age`) |
| 27 | Passing `max_age` explicitly suppresses the fallback | `src/flask/helpers.py:388-389` (`if kwargs.get("max_age") is None:`) + `helpers.py:565-567` (return calls `**_prepare_send_file_kwargs(**kwargs)`); run: `PASS C8: explicit max_age=42 bypasses get_send_file_max_age entirely` |
| 28 | werkzeug turns `max_age` into `Cache-Control` | `.venv/Lib/site-packages/werkzeug/utils.py:500-513` (Werkzeug 3.1.3) |
| 29 | Parity across config values | run: `PASS C6` ×5 (`None`/`3600`/`7200`/`timedelta(hours=1)` — identical app & bp headers) |
| 30 | Per-component override works | `tests/test_blueprints.py:223-245`; run: `PASS C7: blueprint hook 100 beats config 3600 …` and `PASS C7: app path still reads config 3600 …` |
| 31 | No-`url_prefix` blueprint is shadowed | `src/flask/sansio/blueprints.py:144-147` + `docs/blueprints.rst:209-215`; run: `PASS 6a: blueprint-only file unreachable under /static … -> 404` |
| 32 | `static_host`/`host_matching` invariant | `src/flask/app.py:268-270`; run: `PASS 6c` ×2 AssertionError + host-carrying rule |
| 33 | Setup guard messages (both phases) | `src/flask/sansio/app.py:413-423`, `src/flask/sansio/blueprints.py:213-221`; run: `PASS 7` ×2 with the literal messages |
| 34 | Upstream locks pass | CMD 41: `3 passed in 0.37s`; CMD 43/44: `489 passed`, `0 FAILED` |
| 35 | Provenance: `Scaffold` introduced in 2.0.0 for `Flask`/`Blueprint` consistency (issue #3215) | `CHANGES.rst:527` (`Version 2.0.0`) + `:570-573` (quoted in §9) |
| 36 | Docs contract that both components expose the hook | `docs/config.rst:250-262` |
| 37 | Blueprint static docs (endpoint `blueprint_name.static`, shadowing caveat) | `docs/blueprints.rst:191-215` |

---

## 9. Version / provenance

The shared-base refactor being described is documented in the repo’s own changelog, `CHANGES.rst:527` and `:570-573` (verbatim):
```
Version 2.0.0
...
-   The ``Scaffold`` class provides a common API for the ``Flask`` and
    ``Blueprint`` classes. ``Blueprint`` information is stored in
    attributes just like ``Flask``, rather than opaque lambda functions.
    This is intended to improve consistency and maintainability.
    :issue:`3215`
```
Surrounding context (`CHANGES.rst:520-590`) also records, at `:578-581`: *"``send_file`` and ``send_from_directory`` are wrappers around the implementations in ``werkzeug.utils``. :pr:`3828`"* and at `:586-590`: *"``send_file`` sets ``conditional=True`` and ``max_age=None`` by default. ``Cache-Control`` is set to ``no-cache`` if ``max_age`` is not set, otherwise ``public``."*

So: the refactor is a **2.0.0** change (issue #3215), where `Scaffold` became the common API for `Flask` and `Blueprint`; the code described here is that architecture as it exists on `main` at `85c5d93`, version `3.2.0.dev`. At this commit the caching hook has **not** yet been hoisted onto `Scaffold` — it is duplicated on `Flask` (`src/flask/app.py:281`) and `Blueprint` (`src/flask/blueprints.py:55`), with the parity preserved by duplication plus the explicit `max_age = self.get_send_file_max_age(filename)` call in each `send_static_file`.

---

## 10. Falsification pass — each claim with “what would make this false”

| Claim | Falsifier | Status against run-2 log |
|---|---|---|
| The app registers its static route eagerly, exactly one endpoint `static` at `/static/<path:filename>`. | Finding zero or more than one app rule with endpoint `static` (e.g. a rule registered at import time under a different endpoint). | **Not falsified.** `PASS C4: exactly one rule with endpoint 'static' :: [('/static/<path:filename>', 'static')]` |
| The app's `static` view is a `weakref`-closing lambda, not a direct bound method (anti-reference-cycle device #3761). | `view_functions['static']` being a bound method, or the closure containing no `weakref.ref`. | **Not falsified.** `PASS C4: view_functions['static'] exists :: <function Flask.__init__.<locals>.<lambda> …>`; `PASS C4: view closure holds a weakref.ref to the app (issue #3761) :: ['ReferenceType']` |
| The blueprint registers its static route only at `register()` time, via `BlueprintSetupState.add_url_rule`, producing `/admin/static/<path:filename>` with endpoint `admin.static`. | The blueprint rule existing before `register_blueprint`, or resolving to endpoint `static`/no prefix, or not serving. | **Not falsified.** `PASS C5: blueprint static rule prefixed to '/admin/static/<path:filename>' :: [('/admin/static/<path:filename>', 'admin.static')]`; `PASS C5: GET /admin/static/test.txt serves blueprint file :: status=200 data=b'Admin File\n'`; `PASS C5: GET /admin/static/css/test.css (nested) :: status=200` |
| Caching parity: for every config value the app route and blueprint route emit the same max-age. | Any config value yielding different max-ages on `/static/…` vs `/admin/static/…`; or `None`/`no-cache` differing between the two. | **Not falsified.** All 5 C6 checks pass: `None`→(`no-cache`,`no-cache`); `3600`→(`public, max-age=3600`) both; `7200`→(`public, max-age=7200`) both; `timedelta(hours=1)`→(`public, max-age=3600`) both |
| The cache hook is per-component (blueprint override independent of the app). | `bp_override.send_static_file` returning 3600 instead of 100, or the app path returning 100. | **Not falsified.** `PASS C7: blueprint hook 100 beats config 3600 on blueprint path :: blueprint header='public, max-age=100'`; `PASS C7: app path still reads config 3600 :: app header='public, max-age=3600'` |
| `flask.send_from_directory` without `max_age` falls back to the **app** hook only, and a blueprint hook cannot influence it. | `flask.send_from_directory` returning 100 (the blueprint hook) rather than 999. | **Not falsified.** `PASS C8: send_from_directory(no max_age) picks up the APP hook (999) :: header='public, max-age=999'` |
| An explicit `max_age=` bypasses the hook chain entirely. | `max_age=42` producing anything other than 42, or the hook being invoked anyway. | **Not falsified.** `PASS C8: explicit max_age=42 bypasses get_send_file_max_age entirely :: header='public, max-age=42'` |
| Blueprint `send_static_file` uses the blueprint hook, not the app's. | `blueprint.send_static_file` returning 999 rather than 100. | **Not falsified.** `PASS C8: blueprint.send_static_file uses the BLUEPRINT hook (100), not the app hook (999) :: header='public, max-age=100'` |
| A blueprint without `url_prefix` is shadowed by the app's `/static` route (no fallback search). | A blueprint-only file becoming reachable at `/static/…` (status 200). | **Not falsified.** `PASS 6a: blueprint-only file unreachable under /static … -> 404 :: status=404`; `PASS 6a: /static/index.html still serves the APP static folder :: status=200` |
| `static_folder=None` ⇒ no `static` endpoint and `RuntimeError` from `send_static_file`. | A `static` endpoint existing, or a different exception/no exception. | **Not falsified.** `PASS 6b: static_folder=None -> no 'static' endpoint at all :: []`; `PASS 6b: send_static_file with static_folder=None raises RuntimeError` |
| `static_host` without `host_matching` (and vice versa) raises the documented `AssertionError`; with both, the rule carries the host. | No exception, a different message, or the host not appearing. | **Not falsified.** `PASS 6c` ×3 |
| The `@setupmethod` guard is shared but phase-specific (two distinct messages). | Either phase raising the other's message or not raising. | **Not falsified.** `PASS 7` ×2 with the exact component-specific literals |
| **The cache hook is NOT on `Scaffold` at this commit.** | `Scaffold.__dict__` containing `get_send_file_max_age`/`send_static_file`, or `src/flask/sansio/scaffold.py` containing those names. | **Not falsified.** grep of `scaffold.py` → no matches (exit 1); `mro_check` prints `Scaffold defines get_send_file_max_age? False`, `Scaffold defines send_static_file? False`; `Scaffold defines has_static_folder? True` |
| The duplicated bodies are byte-identical. | `diff` returning non-zero. | **Not falsified.** `diff exit:0 (0 = byte-identical)` |
| Upstream tests lock this behavior. | Any of the 3 node IDs failing, or the full suite failing. | **Not falsified.** `3 passed in 0.37s`; full suite `489 passed` with `grep -c "FAILED"` = 0 |
| The verified code is the checkout, not an installed package. | `flask.__file__` outside `flask-src/src/flask`, or the interpreter’s `.pth` pointing elsewhere. | **Not falsified.** Harness prints `flask: …\flask-src\src\flask\__init__.py`; `.venv/Lib/site-packages/flask.pth` → `…\flask-src\src`; the alternate `experiments/data/venv` is Linux-only and points at `worktree/flask/src`, so it was excluded |

**Checks that could not be executed / were deliberately not executed, reported rather than dropped:**
- **A stored run-1 traceback does not exist.** `repro_static_architecture.py.run1-raw` is a script copy, not captured output; grep for `Traceback` in the scratch dir matches only `pytest-full-*.txt`. Claim 7.4 rests on the run-2 log and the docstring, both quoted.
- **`experiments/data/swe-qa/Benchmark/flask.jsonl` (the answer key) was not opened** at any point; the only `swe-qa/` file touched was `repo_commit.txt` (commit pins only).
- **`flask-src/flask_mut2_i417ar2x/mutated_test.py` was read but is not evidence.** It is a subdomain/`url_for` probe (whole file: `app.route("/", subdomain="<company_id>")`, asserts `b"xxx" == response.data`), unrelated to static assets or caching, and `flask-src/` was left byte-for-byte untouched (post-run `git diff --stat` empty; HEAD still `85c5d93`).

---

### Anchor corrections worth stating in any citation of this answer

Direct reads of the checkout found the following plan anchors slightly off; the line numbers used throughout this answer are the **verified** ones: `class Flask(App)` is `src/flask/app.py:81` (not 36); `class Blueprint(SansioBlueprint)` is `src/flask/blueprints.py:18` (not 17); the blueprint static block is `src/flask/sansio/blueprints.py:323-328` (not 305-328); the `send_from_directory` return is `src/flask/helpers.py:565-567` (not 600-604); the `app` fixture is `tests/conftest.py:44-51` (decorator 44, def 45); `test_templates_and_static` is `tests/test_blueprints.py:176`; `test_default_static_max_age` is `tests/test_blueprints.py:223`; the `docs/config.rst` block is `:250-262`; the app guard is `src/flask/sansio/app.py:413-423` (with `_got_first_request = False` at `:409-411`). All other cited anchors matched the file contents exactly.
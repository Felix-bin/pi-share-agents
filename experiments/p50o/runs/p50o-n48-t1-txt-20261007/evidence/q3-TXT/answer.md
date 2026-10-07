# Modular Component Registration Architecture: the Sans-IO / `Scaffold` Split

The architecture in this repository is a **two-layer split** that runs through every component (and therefore through static asset serving as well): an I/O-free, global-free "Sans-IO" layer under `src/flask/sansio/`, and a thin I/O layer that subclasses it. Both `Flask` and `Blueprint` share one registration base, `Scaffold`; static asset serving is registered as its own step on each component; and caching stays consistent across both because the two components carry **deliberately duplicated** caching methods that read the **same** config key.

---

## 1. The two-layer Sans-IO split

The contract for the lower layer is stated in `src/flask/sansio/README.md` (entire file):

> # Sansio
>
> This folder contains code that can be used by alternative Flask
> implementations, for example Quart. The code therefore cannot do any
> IO, nor be part of a likely IO path. Finally this code cannot use the
> Flask globals.

The class hierarchy mirrors that statement exactly (verified in this tree):

```
src/flask/app.py:81:            class Flask(App):
src/flask/blueprints.py:18:     class Blueprint(SansioBlueprint):
src/flask/sansio/app.py:59:     class App(Scaffold):
src/flask/sansio/blueprints.py:119: class Blueprint(Scaffold):
src/flask/sansio/scaffold.py:52:  class Scaffold:
```

So `Flask` → `App` → `Scaffold`, and the public `Blueprint` → `SansioBlueprint` → `Scaffold`. The upper classes add the I/O and global-state halves. `CHANGES.rst` records the provenance:

> - Restructure the code such that the Flask (app) and Blueprint
>   classes have Sans-IO bases. :pr:`5127`

---

## 2. `Scaffold` — the shared registration base ("the main application framework")

`src/flask/sansio/scaffold.py:52` opens with a docstring that names both components explicitly:

```python
class Scaffold:
    """Scaffold represents a generic container for routes, before/after
    request handlers, and other functionality that is shared between
    :class:`~flask.Flask` and :class:`~flask.Blueprint`.

    Methods and attributes marked with ``@setupmethod`` must only be called
    during setup, before the first request is handled.

    .. versionadded:: 2.3
    """
```

This is where the *registration architecture itself* lives. `Scaffold.__init__` (lines 75–105) establishes the per-object contract — `import_name`, `root_path` (resolved from `import_name` when not given), `static_folder`, `static_url_path`, `template_folder`:

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
        #: to. In most cases this is the ``name`` parameter ...
        self.import_name = import_name

        self.static_folder = static_folder  # type: ignore[assignment]
        self.static_url_path = static_url_path
        ...
        self.root_path = root_path
```

`Scaffold` also owns:

- the **shared per-object registries** (`self.view_functions`, `self.error_handler_spec`, `self.before_request_funcs`, `self.after_request_funcs`, `self.teardown_request_funcs`, `self.template_context_processors`, `self.url_value_preprocessors`, `self.url_default_functions`);
- the **static-path API** (`static_folder`, `static_url_path`, `has_static_folder` — lines 224–269);
- the **Jinja loader** property (`jinja_loader`, lines 272–293);
- the **route decorators** `route`/`get`/`post`/`put`/`delete`/`patch` plus an abstract `add_url_rule` (line 368) that subclasses must implement;
- the **`setupmethod` guard** (line 42):

```python
def setupmethod(f: F) -> F:
    """Wraps a method so that it performs a check in debug mode if the
    first request was already handled.
    """

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f.__name__)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`CHANGES.rst` describes this consolidation:

> - The ``Scaffold`` class provides a common API for the ``Flask`` and
>   ``Blueprint`` classes. ``Blueprint`` information is stored in
>   attributes just like ``Flask``, rather than opaque lambda functions.
>   This is intended to improve consistency and maintainability.

Crucially, **`Scaffold` defines none of the caching machinery.** A grep for `SEND_FILE_MAX_AGE_DEFAULT|get_send_file_max_age|send_static_file` in `src/flask/sansio/scaffold.py` returns no matches — the base layer holds only the static *path* properties, not the static *serving/caching* behavior.

The I/O-free app core, `src/flask/sansio/app.py`, is `App(Scaffold)` and declares the abstract hooks the concrete `Flask` must fill in:

```python
class App(Scaffold):
    """The application object, follows the Sans-IO pattern. ...

    .. versionadded:: 2.3
    """
    ...
    #: The default config dict for the application.
    default_config: dict[str, t.Any] = {}

    #: The class that is used for response objects.
    response_class: type[Response]
```

`App` also implements the shared `register_blueprint` (line 570) and the shared `add_url_rule` (line 605) that both the app's and the blueprint's static routes ultimately reach:

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        ...
        blueprint.register(self, options)
```

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

---

## 3. `Blueprint` — the modular component; registration is *deferred*

`sansio/blueprints.py` defines the modular component. A blueprint cannot touch an app at decoration time; instead it **records setup callbacks** into `deferred_functions` and applies them later, when the app registers it:

```python
    @setupmethod
    def record(self, func: DeferredSetupFunction) -> None:
        """Registers a function that is called when the blueprint is
        registered on the application.  This function is called with the
        state as argument as returned by the :meth:`make_setup_state`
        method.
        """
        self.deferred_functions.append(func)
```

`Blueprint.add_url_rule` simply wraps `record`; and `BlueprintSetupState`, the temporary holder created by `make_setup_state`, is what actually prefixes the rule with `url_prefix` and the endpoint with `name_prefix.name.`:

```python
class BlueprintSetupState:
    """Temporary holder object for registering a blueprint with the
    application. ..."""

    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: t.Callable | None = None,
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
            endpoint = _endpoint_from_view_func(view_func)
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

Nested blueprints follow the same "record, don't execute" pattern — `Blueprint.register_blueprint` just appends `(blueprint, options)` to `self._blueprints`.

---

## 4. Static asset serving is registered as its **own step** during `Blueprint.register` — this is the "separation"

The literal intersection of "modular component registration" and "static asset serving" is this block in `Blueprint.register` (`src/flask/sansio/blueprints.py`, lines 323–327), which fires **before** the deferred setup callbacks are replayed and registers the blueprint's static route as a distinct rule with a distinct endpoint:

```python
        if self.has_static_folder:
            state.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                view_func=self.send_static_file,  # type: ignore[attr-defined]
                endpoint="static",
            )
```

The surrounding `register` method shows the sequence — record the blueprint, build setup state, register the static route, merge hooks, *then* replay the deferred functions:

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

The **main application framework** registers *its own* static route independently, during `Flask.__init__` (`src/flask/app.py`, lines 267–279), with `endpoint="static"`, an optional `host=static_host`, and a weakref-backed view function to avoid a reference cycle:

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

Two components, two independent registration steps:

| Component | Registered where | Rule | Endpoint |
|---|---|---|---|
| App (`Flask`) | `Flask.__init__` (`app.py:267`) | `{static_url_path}/<path:filename>` | `static` |
| Blueprint | `Blueprint.register` (`sansio/blueprints.py:323`) | `{url_prefix}{static_url_path}/<path:filename>` | `{blueprint_name}.static` |

Because each is a separate registration step, they compose (or collide) predictably. The blueprint docstring documents the deliberate consequence:

```python
    :param static_url_path: The url to serve static files from.
        Defaults to ``static_folder``. If the blueprint does not have
        a ``url_prefix``, the app's static route will take precedence,
        and the blueprint's static files won't be accessible.
```

and `docs/blueprints.rst`'s "Static Files" section states the same behavior for end users.

---

## 5. Consistent caching is preserved across both components by deliberate duplication + one shared config key

This is the key correctness point, and it is easy to get wrong: the consistency is **not** achieved by inheritance or a shared helper — `Scaffold` defines neither method. It is achieved by two **byte-for-byte duplicated method pairs** (one on `Flask`, one on the I/O `Blueprint`) that read the **same** config key.

The app-side pair (`src/flask/app.py`, lines 281–329):

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
        ...
        """
        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]

        if value is None:
            return None

        if isinstance(value, timedelta):
            return int(value.total_seconds())

        return value  # type: ignore[no-any-return]

    def send_static_file(self, filename: str) -> Response:
        """The view function used to serve files from
        :attr:`static_folder`. ...

        Note this is a duplicate of the same method in the Flask
        class.
        ...
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

The blueprint-side pair (`src/flask/blueprints.py`, lines 55–102) is identical; its `send_static_file` carries the same explanatory comment ("`send_file` only knows to call `get_send_file_max_age` on the app, call it here so it works for blueprints too") and its docstring likewise says "Note this is a duplicate of the same method in the Flask class." The executor verified this by direct diff:

```
$ diff -u <app.py 281-317> <blueprints.py 55-91>     # get_send_file_max_age bodies
diff EXIT=0          # byte-identical
$ diff -u <app.py 308-330> <blueprints.py 82-104>    # send_static_file bodies
diff EXIT=0          # byte-identical
```

The single shared key is declared once, on the app's config (`src/flask/app.py:201`):

```python
            "SEND_FILE_MAX_AGE_DEFAULT": None,
```

and is documented in `docs/config.rst`:

> Default cache control max age to use with :meth:`~flask.Flask.get_send_file_max_age` (and :func:`~flask.send_file`), in seconds as a :class:`~datetime.timedelta` or as an integer. Override this value on a per-file basis using the :meth:`~flask.Flask.get_send_file_max_age` hook on :class:`~flask.Flask` and :class:`~flask.Blueprint`. Defaults to ``None``, which tells the browser to use conditional requests instead of a timed cache, which is usually preferable.

### Why the duplication (and the explicit `max_age`) is necessary

The shared send path (`src/flask/helpers.py`) resolves `max_age` from **`current_app` only**:

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

and `send_from_directory` feeds those kwargs to Werkzeug:

```python
def send_from_directory(
    directory: os.PathLike[str] | str,
    path: os.PathLike[str] | str,
    **kwargs: t.Any,
) -> Response:
    """Send a file from within a directory using :func:`send_file`."""
    return werkzeug.utils.send_from_directory(
        directory, path, **_prepare_send_file_kwargs(**kwargs)
    )
```

Because Werkzeug can only reach `current_app.get_send_file_max_age`, a blueprint would silently lose its own override. The fix is that `Blueprint.send_static_file` calls `self.get_send_file_max_age(filename)` **itself** and passes the result down as `max_age`. Same code + same `SEND_FILE_MAX_AGE_DEFAULT` key ⇒ the app's static route and every blueprint static route cache identically, while subclasses on *either* class can still override the hook. `CHANGES.rst` records this design as intentional:

> - ``Flask`` and ``Blueprint`` now provide a ``get_send_file_max_age``
>   hook for subclasses to override behavior of serving static files
>   from Flask when using ``Flask.send_static_file`` (used for the
>   default static file handler) and ``helpers.send_file``. ... The default max-age for ``send_file``
>   and static files can be configured through a new
>   ``SEND_FILE_MAX_AGE_DEFAULT`` configuration variable, which is used
>   in the default ``get_send_file_max_age`` implementation.

---

## 6. Endpoint naming and the `open_resource` counterparts

- **Endpoint naming** follows from `BlueprintSetupState.add_url_rule`'s `f"{name_prefix}.{name}.{endpoint}".lstrip(".")`. A blueprint named `admin` produces the endpoint `admin.static`, addressable via `flask.url_for("admin.static", filename="test.txt")` → `/admin/static/test.txt`, while the app's endpoint stays plain `static`.
- **`open_resource`** applies the exact same "shared signature, per-component implementation" pattern: `Flask.open_resource` and the I/O `Blueprint.open_resource` (`src/flask/blueprints.py:104`) both open a file relative to `self.root_path`, described as "The blueprint-relative equivalent of the app's `:meth:`~.Flask.open_resource` method." The I/O `Blueprint` also repeats the app-level `__init__` wrapper (setting up `self.cli = AppGroup()`) around `SansioBlueprint`.

---

## 7. Runtime verification (executed against this working tree)

The focused tests were run and pass:

```
$ pytest "tests/test_helpers.py::TestSendfile" -v
tests/test_helpers.py::TestSendfile::test_send_file PASSED               [ 33%]
tests/test_helpers.py::TestSendfile::test_static_file PASSED             [ 66%]
tests/test_helpers.py::TestSendfile::test_send_from_directory PASSED     [100%]
============================== 3 passed in 0.26s ==============================
EXIT=0

$ pytest "tests/test_blueprints.py::test_templates_and_static" "tests/test_blueprints.py::test_default_static_max_age" -v
tests/test_blueprints.py::test_templates_and_static PASSED               [ 50%]
tests/test_blueprints.py::test_default_static_max_age PASSED             [100%]
============================== 2 passed in 0.29s ==============================
EXIT=0
```

A scratch script registered a blueprint with the same static folder as the app and confirmed separate rules, separate endpoints, and identical cache semantics:

```
rules:
   /static/<path:filename> -> static
   /admin/static/<path:filename> -> admin.static
/static/test.txt status= 200 Cache-Control= public, max-age=1234
/admin/static/test.txt status= 200 Cache-Control= public, max-age=1234
url_for('static')       = /static/test.txt
url_for('admin.static') = /admin/static/test.txt
outside-request url_for -> RuntimeError: Working outside of application context.
EXIT=0
```

Both the app static route and the blueprint static route report `max-age=1234` from the single `SEND_FILE_MAX_AGE_DEFAULT` config value, and the two endpoints are `static` and `admin.static`. The full suite was run twice with fresh bytecode and passed (`489 passed`, `EXIT=0`) — the only errors logged are Flask's own captured log lines from tests that deliberately trigger exceptions.

---

## Summary

The architecture that separates static asset serving from the main application framework while preserving consistent caching is:

1. **A two-layer Sans-IO split** — `src/flask/sansio/` holds I/O-free, global-free `Scaffold`, `App`, `Blueprint`; `Flask(App)` and the public `Blueprint(SansioBlueprint)` add the I/O and global halves.
2. **`Scaffold` as the shared registration base** — it owns `import_name`/`root_path`, the `static_folder`/`static_url_path`/`has_static_folder` API, the per-object registries and route decorators, and the `setupmethod` guard; but **no caching logic**.
3. **Blueprint as the modular, deferred-registration component** — it records setup callbacks and applies prefixes at registration time via `BlueprintSetupState`.
4. **Static serving is its own registration step on each component** — `Blueprint.register`'s `if self.has_static_folder:` block registers `{static_url_path}/<path:filename>` → `send_static_file` under endpoint `static` (exposed as `{name}.static`), independently of the app's own static rule added in `Flask.__init__`.
5. **Caching consistency comes from deliberate byte-for-byte duplication plus one shared config key** — `Flask` and the I/O `Blueprint` each define identical `get_send_file_max_age`/`send_static_file` pairs (both docstrings say "Note this is a duplicate of the same method in the Flask class"), both read `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, and `send_static_file` passes `max_age` down explicitly because Werkzeug's shared send path can only reach `current_app`. Same code, same key ⇒ identical `Cache-Control` on the app's and every blueprint's static route, with overridable hooks on either class.
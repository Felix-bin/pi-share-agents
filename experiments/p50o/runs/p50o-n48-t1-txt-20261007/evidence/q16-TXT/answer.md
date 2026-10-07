# How deferred blueprint filter registration reaches the Jinja environment despite `url_prefix`

## Short answer

`Blueprint.add_app_template_filter` never touches Jinja at call time. It builds a closure, `register_template(state)`, whose only environment access is `state.app.jinja_env.filters[name or f.__name__] = f`, and hands it to `record_once`, which appends it to the blueprint's `deferred_functions` list. When the blueprint is later mounted, `Flask.register_blueprint` → `Blueprint.register` builds a `BlueprintSetupState` and runs `for deferred in self.deferred_functions: deferred(state)`. That state object *does* carry `url_prefix`, but the filter closure never reads it — the sole consumer of `BlueprintSetupState.url_prefix` is `BlueprintSetupState.add_url_rule`, which prefixes **route rules**. The filter therefore lands in the application's single, cached, app-global Jinja `Environment.filters` mapping, which is exactly the object every render entry point (`render_template` et al.) consults. The prefix governs routing only; filter registration is app-wide by design.

---

## 1. The deferred-registration primitive: `record` / `record_once` / `deferred_functions`

The concrete `src/flask/blueprints.py` contains **no** filter methods — a grep for `template_filter|add_app_template|filters|jinja_env` there returns zero matches, and the class is just:

```python
from .sansio.blueprints import Blueprint as SansioBlueprint
from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
from .sansio.scaffold import _sentinel

if t.TYPE_CHECKING:  # pragma: no cover
    from .wrappers import Response


class Blueprint(SansioBlueprint):
```

Everything lives in the sans-io base. The deferred-registration machinery (`src/flask/sansio/blueprints.py`):

```python
DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]
```

```python
    _got_registered_once = False

    def __init__(
        self,
        name: str,
        import_name: str,
        ...
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
```

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

    def make_setup_state(
        self, app: App, options: dict[str, t.Any], first_registration: bool = False
    ) -> BlueprintSetupState:
        """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
        object that is later passed to the register callback functions.
        Subclasses can override this to return a subclass of the setup state.
        """
        return BlueprintSetupState(self, app, options, first_registration)
```

**Key points:** `record_once` is the "deferred registration" primitive. It stores a wrapper closure in `self.deferred_functions`; nothing touches an app until registration. The `state.first_registration` gate means the wrapped function (the filter writer) runs only on the blueprint's *first* registration. The state is a plain callable contract: `DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]`.

The `@setupmethod` decorator (`src/flask/sansio/scaffold.py`, lines 57–65) wraps every registration method so it calls `_check_setup_finished` first:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

Since `record`, `record_once`, `app_template_filter`, `add_app_template_filter` are all `@setupmethod`-decorated, calling `bp.add_app_template_filter(...)` after `register()` has set `_got_registered_once = True` raises `AssertionError`. **Filters must be added before `app.register_blueprint`.** This is verified live below.

---

## 2. The filter methods and their deferred closure

`src/flask/sansio/blueprints.py`, lines 443–475:

```python
    @setupmethod
    def app_template_filter(
        self, name: str | None = None
    ) -> t.Callable[[T_template_filter], T_template_filter]:
        """Register a template filter, available in any template rendered by the
        application. Equivalent to :meth:`.Flask.template_filter`.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """

        def decorator(f: T_template_filter) -> T_template_filter:
            self.add_app_template_filter(f, name=name)
            return f

        return decorator

    @setupmethod
    def add_app_template_filter(
        self, f: ft.TemplateFilterCallable, name: str | None = None
    ) -> None:
        """Register a template filter, available in any template rendered by the
        application. Works like the :meth:`app_template_filter` decorator. Equivalent to
        :meth:`.Flask.add_template_filter`.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """

        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.filters[name or f.__name__] = f

        self.record_once(register_template)
```

The docstring itself states the semantics: *"available in any template rendered by the application"* — i.e. **application-wide**, not scoped to the blueprint's prefix. The closure reads only `state.app` (and, via the `record_once` wrapper, `state.first_registration`). It writes into `state.app.jinja_env.filters[...]` and **never reads `state.url_prefix`**.

The sibling app-level helpers use the identical pattern:
- `add_app_template_test` → `state.app.jinja_env.tests[...]`, `self.record_once(register_template)`
- `add_app_template_global` → `state.app.jinja_env.globals[...]`, `self.record_once(register_template)`
- `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults` — all `self.record_once(lambda s: s.app.<app-wide-structure>...)`.

---

## 3. `BlueprintSetupState`: `url_prefix` is captured once and consumed only by routing

`src/flask/sansio/blueprints.py`, lines 34–113:

```python
class BlueprintSetupState:
    """Temporary holder object for registering a blueprint with the
    application.  An instance of this class is created by the
    :meth:`~flask.Blueprint.make_setup_state` method and later passed
    to all register callback functions.
    """

    def __init__(
        self,
        blueprint: Blueprint,
        app: App,
        options: t.Any,
        first_registration: bool,
    ) -> None:
        #: a reference to the current application
        self.app = app

        #: a reference to the blueprint that created this setup state.
        self.blueprint = blueprint

        #: a dictionary with all options that were passed to the
        #: :meth:`~flask.Flask.register_blueprint` method.
        self.options = options

        #: as blueprints can be registered multiple times with the
        #: application and not everything wants to be registered
        #: multiple times on it, this attribute can be used to figure
        #: out if the blueprint was registered in the past already.
        self.first_registration = first_registration

        subdomain = self.options.get("subdomain")
        if subdomain is None:
            subdomain = self.blueprint.subdomain

        #: The subdomain that the blueprint should be active for, ``None``
        #: otherwise.
        self.subdomain = subdomain

        url_prefix = self.options.get("url_prefix")
        if url_prefix is None:
            url_prefix = self.blueprint.url_prefix
        #: The prefix that should be used for all URLs defined on the
        #: blueprint.
        self.url_prefix = url_prefix

        self.name = self.options.get("name", blueprint.name)
        self.name_prefix = self.options.get("name_prefix", "")

        #: A dictionary with URL defaults that is added to each and every
        #: URL that was defined with the blueprint.
        self.url_defaults = dict(self.blueprint.url_values_defaults)
        self.url_defaults.update(self.options.get("url_defaults", ()))
```

Lines 87–117, the one and only reader of `state.url_prefix`:

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

A grep over the whole file confirms this: `url_prefix` occurs at lines 72–77 (capture in `__init__`), 98/100/102 (`add_url_rule`), 181/202 (stored on the `Blueprint` itself), and 351–374 (nested-blueprint prefix merge). **No filter code path reads it.** A verified grep:

```
$ grep -n "url_prefix" src/flask/sansio/blueprints.py
72:        url_prefix = self.options.get("url_prefix")
73:        if url_prefix is None:
74:            url_prefix = self.blueprint.url_prefix
77:        self.url_prefix = url_prefix
98:        if self.url_prefix is not None:
100:                rule = "/".join((self.url_prefix.rstrip("/"), rule.lstrip("/")))
102:                rule = self.url_prefix
146,153  (Blueprint docstring)
181:        url_prefix: str | None = None
202:        self.url_prefix = url_prefix                      # stored on the Blueprint
351-374  (nested-blueprint bp_options["url_prefix"] merge)   exit=0
```

Note also that `Blueprint.add_url_rule` defers a lambda that calls `s.add_url_rule(...)` (`s` being the state), so **route rules flow through `BlueprintSetupState.add_url_rule` — the only path that applies `url_prefix`.**

---

## 4. `Blueprint.register`: where the deferred loop fires

`src/flask/sansio/blueprints.py`, lines 273–335 (docstring collapsed; body verbatim):

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

Then lines 336–377 handle CLI registration and merge nested-blueprint prefixes — `state.url_prefix` is used **only** to compose URL prefixes for child blueprints:

```python
        for blueprint, bp_options in self._blueprints:
            bp_options = bp_options.copy()
            bp_url_prefix = bp_options.get("url_prefix")
            bp_subdomain = bp_options.get("subdomain")
            ...
            if bp_url_prefix is None:
                bp_url_prefix = blueprint.url_prefix

            if state.url_prefix is not None and bp_url_prefix is not None:
                bp_options["url_prefix"] = (
                    state.url_prefix.rstrip("/") + "/" + bp_url_prefix.lstrip("/")
                )
            elif bp_url_prefix is not None:
                bp_options["url_prefix"] = bp_url_prefix
            elif state.url_prefix is not None:
                bp_options["url_prefix"] = state.url_prefix

            bp_options["name_prefix"] = name
            blueprint.register(app, bp_options)
```

And `_merge_blueprint_funcs` (lines 379–410) merges only error handlers, view functions, request/context/url-handler dicts — **filters are not part of it**:

```python
    def _merge_blueprint_funcs(self, app: App, name: str) -> None:
        def extend(
            bp_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
            parent_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
        ) -> None:
            for key, values in bp_dict.items():
                key = name if key is None else f"{name}.{key}"
                parent_dict[key].extend(values)

        for key, value in self.error_handler_spec.items():
            key = name if key is None else f"{name}.{key}"
            value = defaultdict(
                dict,
                {
                    code: {exc_class: func for exc_class, func in code_values.items()}
                    for code, code_values in value.items()
                },
            )
            app.error_handler_spec[key] = value

        for endpoint, func in self.view_functions.items():
            app.view_functions[endpoint] = func

        extend(self.before_request_funcs, app.before_request_funcs)
        extend(self.after_request_funcs, app.after_request_funcs)
        extend(
            self.teardown_request_funcs,
            app.teardown_request_funcs,
        )
        extend(self.url_default_functions, app.url_default_functions)
        extend(self.url_value_preprocessors, app.url_value_preprocessors)
        extend(self.template_context_processors, app.template_context_processors)
```

**So the order is:** `state = self.make_setup_state(app, options, first_bp_registration)` is where `url_prefix` enters the state; the loop `for deferred in self.deferred_functions: deferred(state)` is what fires `register_template(state)`. `first_bp_registration` — computed as "no previously registered blueprint *is* this object" — feeds `state.first_registration`, which is exactly the gate `record_once` installed.

---

## 5. The app-side entry point and the app-global Jinja environment

`src/flask/sansio/app.py`, lines 569–603 (excerpt):

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on the application. Keyword
        arguments passed to this method will override the defaults set on the
        blueprint.

        Calls the blueprint's :meth:`~flask.Blueprint.register` method after
        recording the blueprint in the application's :attr:`blueprints`.

        :param blueprint: The blueprint to register.
        :param url_prefix: Blueprint routes will be prefixed with this.
        :param subdomain: Blueprint routes will match on this subdomain.
        :param url_defaults: Blueprint routes will use these default values for
            view arguments.
        :param options: Additional keyword arguments are passed to
            :class:`~flask.blueprints.BlueprintSetupState`. They can be
            accessed in :meth:`~flask.Blueprint.record` callbacks.
        ...
        """
        blueprint.register(self, options)
```

Note the `url_prefix` docstring: *"Blueprint **routes** will be prefixed with this"* — routing, not filters. `register_blueprint` passes the whole `options` dict (including `url_prefix="/py"`) into `blueprint.register`.

The app-level analog writes to the very same mapping:

```python
    @setupmethod
    def add_template_filter(
        self, f: ft.TemplateFilterCallable, name: str | None = None
    ) -> None:
        """Register a custom template filter.  Works exactly like the
        :meth:`template_filter` decorator.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """
        self.jinja_env.filters[name or f.__name__] = f
```

`App.jinja_env` is one cached, application-global `Environment` (`src/flask/sansio/app.py`, lines 469–481):

```python
    @cached_property
    def jinja_env(self) -> Environment:
        """The Jinja environment used to load templates.

        The environment is created the first time this property is
        accessed. Changing :attr:`jinja_options` after that will have no
        effect.
        """
        return self.create_jinja_environment()

    def create_jinja_environment(self) -> Environment:
        raise NotImplementedError()
```

The concrete `Flask.create_jinja_environment` (`src/flask/app.py`, lines 385–417) builds that single env and populates its globals/filters:

```python
    def create_jinja_environment(self) -> Environment:
        """Create the Jinja environment based on :attr:`jinja_options`
        and the various Jinja-related methods of the app. Changing
        :attr:`jinja_options` after this will have no effect. Also adds
        Flask-related globals and filters to the environment.
        ...
        """
        options = dict(self.jinja_options)

        if "autoescape" not in options:
            options["autoescape"] = self.select_jinja_autoescape

        if "auto_reload" not in options:
            auto_reload = self.config["TEMPLATES_AUTO_RELOAD"]

            if auto_reload is None:
                auto_reload = self.debug

            options["auto_reload"] = auto_reload

        rv = self.jinja_environment(self, **options)
        rv.globals.update(
            url_for=self.url_for,
            get_flashed_messages=get_flashed_messages,
            config=self.config,
            # request, session and g are normally added with the
            # context processor for efficiency reasons but for imported
            # templates we also want the proxies in there.
            request=request,
            session=session,
            g=g,
        )
        rv.policies["json.dumps_function"] = self.json.dumps
        return rv
```

**Why this matters:** because the property is lazily created on first access, the blueprint's deferred callback — which runs during `register_blueprint` and accesses `state.app.jinja_env` — creates/uses the same env object that `render_template` later consults. One shared environment, no per-blueprint namespacing.

And render time resolves through exactly that object (`src/flask/templating.py`, lines 126–162):

```python
def _render(app: Flask, template: Template, context: dict[str, t.Any]) -> str:
    app.update_template_context(context)
    before_render_template.send(
        app, _async_wrapper=app.ensure_sync, template=template, context=context
    )
    rv = template.render(context)
    template_rendered.send(
        app, _async_wrapper=app.ensure_sync, template=template, context=context
    )
    return rv


def render_template(
    template_name_or_list: str | Template | list[str | Template],
    **context: t.Any,
) -> str:
    """Render a template by name with the given context.

    :param template_name_or_list: The name of the template to render. If
        a list is given, the first name to exist will be rendered.
    :param context: the variables to make available in the template.
    """
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.get_or_select_template(template_name_or_list)
    return _render(app, template, context)
```

`render_template_string` uses `app.jinja_env.from_string(source)`; `stream_template` / `stream_template_string` likewise resolve via `app.jinja_env`. Every render entry point resolves filters through the object `register_template` mutated; **`url_prefix` is absent from all of them.** (The `DispatchingJinjaLoader` at the top of the file is blueprint-aware, but that governs template *location*, not the shared `filters` dict.)

---

## 6. The (small) role of the two locks, restated

- **Blueprint-side lock:** `@setupmethod` + `Blueprint._check_setup_finished` raise if `_got_registered_once` is `True`. This guarantees the filter closure is appended to `deferred_functions` *before* `register()` fires the loop — otherwise the writer would never run. It also means you cannot retroactively add a filter after mounting; the mechanism relies on registration being a one-shot setup phase.
- **`record_once` gate:** `register_template` is wrapped so it executes only when `state.first_registration` is `True`. Registering the same blueprint again under a different prefix does **not** re-run or clobber the filter registration.

---

## 7. Tests that prove the intent

`tests/test_blueprints.py` — all mount with `url_prefix="/py"` and still assert the filter lives in `app.jinja_env.filters` and renders:

```python
def test_template_filter(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    assert "my_reverse" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["my_reverse"] == my_reverse
    assert app.jinja_env.filters["my_reverse"]("abcd") == "dcba"
```

```python
def test_add_template_filter(app):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse)
    app.register_blueprint(bp, url_prefix="/py")
    assert "my_reverse" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["my_reverse"] == my_reverse
    assert app.jinja_env.filters["my_reverse"]("abcd") == "dcba"
```

```python
def test_template_filter_with_name(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter("strrev")
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    assert "strrev" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["strrev"] == my_reverse
    assert app.jinja_env.filters["strrev"]("abcd") == "dcba"


def test_add_template_filter_with_name(app):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse, "strrev")
    app.register_blueprint(bp, url_prefix="/py")
    assert "strrev" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["strrev"] == my_reverse
    assert app.jinja_env.filters["strrev"]("abcd") == "dcba"
```

The rendered-template proof — note the route is at `/`, **not** `/py/...`, yet the filter resolves:

```python
def test_template_filter_with_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def super_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"
```

```python
def test_template_filter_after_route_with_template(app, client):
    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def super_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    rv = client.get("/")
    assert rv.data == b"dcba"
```

```python
def test_add_template_filter_with_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    def super_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(super_reverse)
    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"
```

```python
def test_template_filter_with_name_and_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter("super_reverse")
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"


def test_add_template_filter_with_name_and_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse, "super_reverse")
    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"
```

Template `tests/templates/template_filter.html` (entire file):

```jinja
{{ value|super_reverse }}
```

The double-registration-under-two-prefixes behavior in `tests/test_blueprints.py` lines 1033–1044:

```python
    bp.register_blueprint(bp2, url_prefix="/a", name="sub")
    app.register_blueprint(bp, url_prefix="/a")
    app.register_blueprint(bp, url_prefix="/b", name="alt")

    assert client.get("/a/").data == b"bp.index"
    assert client.get("/b/").data == b"alt.index"
    assert client.get("/a/a/").data == b"bp.sub.index2"
    assert client.get("/b/a/").data == b"alt.sub.index2"
    assert client.get("/a/error").data == b"Error"
    assert client.get("/b/error").data == b"Error"
```

And the changelog wording is explicit about the scope (`CHANGES.rst`, lines 1265–1273):

```
-   Blueprints now have a decorator to add custom template filters
    application wide, ``Blueprint.app_template_filter``.
-   The Flask and Blueprint classes now have a non-decorator method for
    adding custom template filters application wide,
    ``Flask.add_template_filter`` and
    ``Blueprint.add_app_template_filter``.
```

---

## 8. Execution evidence

### 8.1 Environment note

Every run had to be prefixed with `PYTHONPATH="$(pwd)/src"` because the shared `.venv`'s editable install points at a different checkout: `./.venv/Scripts/python.exe -c "import flask; print(flask.__file__)"` printed a path *outside* the working directory. With `PYTHONPATH` set to the working tree's `src`, `import flask` resolves to the working-tree copy, and the script additionally asserts `flask.__file__` is the working-tree copy and inserts `<cwd>/src` on `sys.path`. No source or test file was edited.

### 8.2 Self-contained reproduction script — final PASS run, exit 0 (full output, unedited)

```
$ ./.venv/Scripts/python.exe _executor_deferred_filter_check.py
flask module file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q16-TXT\seal\src\flask\__init__.py
--- before register_blueprint ---
  'my_reverse' in app.jinja_env.filters: False
  'my_shout' in app.jinja_env.filters: False
  'rev2' in app.jinja_env.filters: False
  'super_reverse' in app.jinja_env.filters: False
  bp.deferred_functions length: 5
  bp.deferred_functions length after record_once probe: 6
--- after register_blueprint(bp, url_prefix='/py') ---
  'my_reverse' in app.jinja_env.filters: True
  'my_shout' in app.jinja_env.filters: True
  'rev2' in app.jinja_env.filters: True
  'super_reverse' in app.jinja_env.filters: True
  app.jinja_env is the env captured before registration: True
  filters['my_reverse'] is my_reverse: True
  filters['my_shout'] is my_shout: True
  filters['rev2'] is another_reverse: True
  record_once probe observed first_registration values: [True]
  my_reverse('abcd') -> 'dcba'
  app.jinja_env.from_string('{{ value|my_reverse }}').render(value='abcd') -> 'dcba'
--- second registration: same bp, name='bp2', url_prefix='/other' ---
  bp.deferred_functions length before: 6
  bp.deferred_functions length after: 6
  'my_reverse' in app.jinja_env.filters: True
  filters['my_reverse'] is my_reverse: True
  record_once probe observed first_registration values: [True]
  re-render '{{ value|my_reverse }}' -> 'dcba'
--- post-registration blueprint setup attempt ---
  bp.add_app_template_filter raised AssertionError, first line:
    The setup method 'add_app_template_filter' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
  'too_late' ended up in app.jinja_env.filters: False
--- requests ---
  GET / (app route, not under any blueprint prefix) -> 200 b'dcba'
  url_map rules: ['/', '/other/hello', '/py/hello', '/static/<path:filename>']
  GET /py/hello -> 200 b'hello-from-bp'
  GET /other/hello -> 200 b'hello-from-bp'
--- post-first-request app setup attempt ---
  app.register_blueprint raised AssertionError, first line:
    The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.
ALL CHECKS PASSED
EXIT=0
```

What this establishes, mechanically:

- **Negative control:** before `register_blueprint`, none of the four blueprint filters exist in `app.jinja_env.filters`; `bp.deferred_functions` already holds the closures (5, then 6 after the probe).
- **After `register_blueprint(bp, url_prefix="/py")`:** all four are present, and `app.jinja_env` **is the very same `Environment` object** instantiated before registration.
- **Filter callables are identical objects** (`is`) to the registered functions; `my_reverse('abcd')` → `'dcba'`; `from_string("{{ value|my_reverse }}")` → `'dcba'`.
- **Prefix separation:** `url_map` contains both `/py/hello` and `/other/hello` (plus the app-level `/`), while the filter is available from a route at `/` that is *not* under any prefix — `GET /` returned `b'dcba'`. Routing is prefixed; the filter is not scoped.
- **`record_once` fires once:** the probe recorded `[True]` only; the second registration (`name='bp2'`, `url_prefix='/other'`) left `deferred_functions` unchanged at 6, re-observed `[True]`, and preserved filter identity/resolution.
- **Two distinct locks verified live:** post-registration `bp.add_app_template_filter(...)` raises `AssertionError` naming `add_app_template_filter` (blueprint lock, `_got_registered_once`), and post-first-request `app.register_blueprint(...)` raises `AssertionError` (app lock, `_got_first_request`). Neither added the late filter.

(For completeness: the first two script runs exited 1 due to *script* defects — run 1 omitted the `super_reverse` name the repo template uses, run 2 issued a request before the second registration and hit the genuine app-side first-request lock — and were fixed by run 3 above.)

### 8.3 Focused pytest subset — 9 passed, exit 0

```
$ PYTHONPATH="$(pwd)/src" ./.venv/Scripts/python.exe -m pytest -v \
    tests/test_blueprints.py::test_template_filter \
    tests/test_blueprints.py::test_add_template_filter \
    tests/test_blueprints.py::test_template_filter_with_name \
    tests/test_blueprints.py::test_add_template_filter_with_name \
    tests/test_blueprints.py::test_template_filter_with_template \
    tests/test_blueprints.py::test_template_filter_after_route_with_template \
    tests/test_blueprints.py::test_add_template_filter_with_template \
    tests/test_blueprints.py::test_template_filter_with_name_and_template \
    tests/test_blueprints.py::test_add_template_filter_with_name_and_template
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- ...\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q16-TXT\seal
configfile: pyproject.toml
collecting ... collected 9 items

tests/test_blueprints.py::test_template_filter PASSED                    [ 11%]
tests/test_blueprints.py::test_add_template_filter PASSED                [ 22%]
tests/test_blueprints.py::test_template_filter_with_name PASSED          [ 33%]
tests/test_blueprints.py::test_add_template_filter_with_name PASSED      [ 44%]
tests/test_blueprints.py::test_template_filter_with_template PASSED      [ 55%]
tests/test_blueprints.py::test_template_filter_after_route_with_template PASSED [ 66%]
tests/test_blueprints.py::test_add_template_filter_with_template PASSED  [ 77%]
tests/test_blueprints.py::test_template_filter_with_name_and_template PASSED [ 88%]
tests/test_blueprints.py::test_add_template_filter_with_name_and_template PASSED [100%]

============================== 9 passed in 0.24s ==============================
EXIT=0
```

### 8.4 Full `tests/` suite (run twice) — 489 passed, exit 0

```
$ PYTHONPATH="$(pwd)/src" ./.venv/Scripts/python.exe -m pytest
...
tests\test_blueprints.py ............................................... [ 40%]
.............                                                            [ 43%]
...
tests\test_templating.py ................................                [ 90%]
...
============================= 489 passed in 5.88s =============================
EXIT=0
```

The verbose rerun (`-vv -rA --tb=long`) likewise ended with `489 passed in 5.90s` (EXIT=0); every one of the 489 individual lines reads `PASSED`, including all nine blueprint filter tests, the app-level `tests/test_templating.py::test_template_filter*` equivalents, and `test_basic.py::test_no_setup_after_first_request`. One environment artifact was observed: some `-vv` annotations and traceback frames show absolute paths from when the tree's `__pycache__` was created; `rootdir`, `configfile`, `testpaths`, collected node IDs and all Flask frames are under the working directory, and results are identical in both runs.

### 8.5 Out-of-scope item, run separately and labelled

```
$ PYTHONPATH="$(pwd)/src" ./.venv/Scripts/python.exe flask_mut2_i417ar2x/mutated_test.py
=== OUT OF SCOPE (subdomain routing, not filter/url_prefix) ===
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>...'
Traceback (most recent call last):
  File "...\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
AssertionError: status 404
EXIT=1
```

That file targets subdomain routing (`subdomain="<company_id>"`, `subdomain_matching=False`, `SERVER_NAME`). It is **not** part of the filter/`url_prefix` question and is not folded into the conclusion above; pytest never collects it (outside `testpaths`, not named `test_*.py`/`*_test.py`).

---

## 9. The mechanism, end to end

1. `Blueprint.add_app_template_filter` (`src/flask/sansio/blueprints.py:461`) defines the closure `register_template(state)` which does `state.app.jinja_env.filters[name or f.__name__] = f`, and passes it to `self.record_once(register_template)` (line 475). It touches no Jinja object yet.
2. `record_once` (line 233) wraps it with `if state.first_registration:` and delegates to `record` (line 224), which appends to `self.deferred_functions: list[DeferredSetupFunction]` (declared line 204). `@setupmethod` (`scaffold.py:57`) + `_check_setup_finished` (line 213) enforce that this happens before registration.
3. `Flask.register_blueprint` (`sansio/app.py:570`) forwards `**options` — including `url_prefix="/py"` — as `options` into `blueprint.register(self, options)`.
4. `Blueprint.register` (line 273) computes `first_bp_registration`, sets `self._got_registered_once = True`, builds `state = self.make_setup_state(app, options, first_bp_registration)`, then runs `for deferred in self.deferred_functions: deferred(state)` (line 334).
5. `BlueprintSetupState.__init__` (line 41) captures `self.url_prefix = options.get("url_prefix")` (falling back to `blueprint.url_prefix`) — but `register_template` never reads it. The **only** consumer of `state.url_prefix` is `BlueprintSetupState.add_url_rule` (line 87), which prefixes route rules, plus the nested-blueprint prefix merge in `register`.
6. Because `register_template` writes into `state.app.jinja_env.filters`, the filter lands in the application's single cached `Environment` (`sansio/app.py:470`, built by `app.py:385`) — the same object `render_template` (`templating.py:138`) and `render_template_string`/`stream_template*` resolve filters through.

**Conclusion:** `url_prefix` and filter registration share the `BlueprintSetupState` object but operate on different targets — the URL map versus the Jinja environment. The prefix is consumed solely by `BlueprintSetupState.add_url_rule`; the deferred filter callback ignores it entirely and writes directly to the app-global `jinja_env.filters`. That is why a blueprint mounted with a URL path prefix still contributes its app-level filters to every template the application renders, and why the `record_once` gate ensures a second mount under another prefix neither duplicates nor removes the entry.
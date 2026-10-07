# How blueprint-registered template processing functions reach the shared Jinja environment

**Answer in one sentence:** a blueprint cannot touch an app at decoration time, so `Blueprint.app_template_filter` / `app_template_test` / `app_template_global` (and their `add_app_template_*` forms) do **not** write the filter/test/global into any blueprint-local structure — they build a closure `register_template(state)` whose body is `state.app.jinja_env.{filters,tests,globals}[name or f.__name__] = f`, push it onto the blueprint's `deferred_functions` list via `record_once`, and that closure is executed later by `Blueprint.register` with a `BlueprintSetupState` that carries `state.app`; because `App.jinja_env` is a `@cached_property` returning one per-app `Environment` instance, and every public render helper resolves templates through `current_app.jinja_env`, the write lands directly in the very dicts the renderer consults — so it is visible in every template rendered afterwards.

The chain has six links, each quoted below with file and line.

---

## Link 1 — Deferred recording: the blueprint queues a closure instead of writing a filter

### 1a. The queue

`src/flask/sansio/blueprints.py:204` (inside `Blueprint.__init__`):

```python
        self.deferred_functions: list[DeferredSetupFunction] = []
```

`src/flask/sansio/blueprints.py:223-244`:

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

`src/flask/sansio/blueprints.py:246-253`:

```python
    def make_setup_state(
        self, app: App, options: dict[str, t.Any], first_registration: bool = False
    ) -> BlueprintSetupState:
        """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
        object that is later passed to the register callback functions.
        Subclasses can override this to return a subclass of the setup state.
        """
        return BlueprintSetupState(self, app, options, first_registration)
```

(Voicings in the handover cite `record_once` at "~259"; the verified anchor in this tree is `record_once` at **line 233** and `record` at **line 224** — confirmed both by grep of `src/flask/sansio/blueprints.py` and by reading lines 221-253. The assignment lines in the three registration methods are 473/511/549; the enclosing `record_once(...)` calls are 475/513/551.)

### 1b. Why deferral is required

The class docstring states the design contract, `src/flask/sansio/blueprints.py:119-135`:

```python
class Blueprint(Scaffold):
    """Represents a blueprint, a collection of routes and other
    app-related functions that can be registered on a real application
    later.

    A blueprint is an object that allows defining application functions
    without requiring an application object ahead of time. It uses the
    same decorators as :class:`~flask.Flask`, but defers the need for an
    application by recording them for later registration.

    Decorating a function with a blueprint creates a deferred function
    that is called with :class:`~flask.blueprints.BlueprintSetupState`
    when the blueprint is registered on an application.
```

A blueprint has no `app` while it is being defined; `record_once` is therefore the only place the "when we finally know the app" work can live.

### 1c. The three registration entry points — filter

`src/flask/sansio/blueprints.py:443-475`:

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

### 1d. Test

`src/flask/sansio/blueprints.py:477-513`:

```python
    @setupmethod
    def app_template_test(
        self, name: str | None = None
    ) -> t.Callable[[T_template_test], T_template_test]:
        """Register a template test, available in any template rendered by the
        application. Equivalent to :meth:`.Flask.template_test`.

        .. versionadded:: 0.10

        :param name: the optional name of the test, otherwise the
                     function name will be used.
        """

        def decorator(f: T_template_test) -> T_template_test:
            self.add_app_template_test(f, name=name)
            return f

        return decorator

    @setupmethod
    def add_app_template_test(
        self, f: ft.TemplateTestCallable, name: str | None = None
    ) -> None:
        """Register a template test, available in any template rendered by the
        application. Works like the :meth:`app_template_test` decorator. Equivalent to
        :meth:`.Flask.add_template_test`.

        .. versionadded:: 0.10

        :param name: the optional name of the test, otherwise the
                     function name will be used.
        """

        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.tests[name or f.__name__] = f

        self.record_once(register_template)
```

### 1e. Global

`src/flask/sansio/blueprints.py:515-551`:

```python
    @setupmethod
    def app_template_global(
        self, name: str | None = None
    ) -> t.Callable[[T_template_global], T_template_global]:
        """Register a template global, available in any template rendered by the
        application. Equivalent to :meth:`.Flask.template_global`.

        .. versionadded:: 0.10

        :param name: the optional name of the global, otherwise the
                     function name will be used.
        """

        def decorator(f: T_template_global) -> T_template_global:
            self.add_app_template_global(f, name=name)
            return f

        return decorator

    @setupmethod
    def add_app_template_global(
        self, f: ft.TemplateGlobalCallable, name: str | None = None
    ) -> None:
        """Register a template global, available in any template rendered by the
        application. Works like the :meth:`app_template_global` decorator. Equivalent to
        :meth:`.Flask.add_template_global`.

        .. versionadded:: 0.10

        :param name: the optional name of the global, otherwise the
                     function name will be used.
        """

        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.globals[name or f.__name__] = f

        self.record_once(register_template)
```

**Mechanism facts established here.** (i) The object stored is a *closure over `f` and `name`*, not `f` itself — verified by probe: `queued is rev? False`, `queued __name__ (via update_wrapper): register_template`. (ii) The write target is `state.app.jinja_env`, i.e. the **application's** environment; nothing blueprint-local is involved. (iii) Storage goes through `record_once`, so execution is gated on `state.first_registration`. (iv) The registry key is `name or f.__name__`.

### 1f. Adjacent API, for contrast (context processors)

The blueprint also has app-wide *context processor* registration, but it does not use the environment at all — `src/flask/sansio/blueprints.py:583-593`:

```python
    @setupmethod
    def app_context_processor(
        self, f: T_template_context_processor
    ) -> T_template_context_processor:
        """Like :meth:`context_processor`, but for templates rendered by every view, not
        only by the blueprint. Equivalent to :meth:`.Flask.context_processor`.
        """
        self.record_once(
            lambda s: s.app.template_context_processors.setdefault(None, []).append(f)
        )
        return f
```

By contrast the *blueprint-scoped* form, `src/flask/sansio/scaffold.py:541-556`:

```python
    @setupmethod
    def context_processor(
        self,
        f: T_template_context_processor,
    ) -> T_template_context_processor:
        """Registers a template context processor function. These functions run before
        rendering a template. The keys of the returned dict are added as variables
        available in the template.

        This is available on both app and blueprint objects. When used on an app, this
        is called for every rendered template. When used on a blueprint, this is called
        for templates rendered from the blueprint's views. To register with a blueprint
        and affect every template, use :meth:`.Blueprint.app_context_processor`.
        """
        self.template_context_processors[None].append(f)
        return f
```

This is what makes `filters`/`tests`/`globals` special: they are **not** blueprint-scoped tables merged by name, they are app-global Jinja environment dicts.

---

## Link 2 — Replay at registration: `Blueprint.register` runs the queued closures with a state that carries `app`

### 2a. The state object

`src/flask/sansio/blueprints.py:34-70`:

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
```

(`self.app = app` at line 50; `self.first_registration` at line 62.)

### 2b. The replay loop

`src/flask/sansio/blueprints.py:273-335`:

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

Verified anchors in this tree: `first_bp_registration` at **line 316**, `self._got_registered_once = True` at **320**, `state = self.make_setup_state(app, options, first_bp_registration)` at **321**, and the single execution point `for deferred in self.deferred_functions: deferred(state)` at **lines 334-335**. `deferred_functions.append(func)` is line 230 and the replay loop the only read of that list is line 334:

```
$ grep -n "deferred_functions" src/flask/sansio/blueprints.py
204:        self.deferred_functions: list[DeferredSetupFunction] = []
230:        self.deferred_functions.append(func)
334:        for deferred in self.deferred_functions:
```

**Mechanism facts:** this is the *only* point where the three template closures execute; `state` is built by `make_setup_state(app, options, first_bp_registration)` and therefore carries `state.app`; `first_registration` is `not any(bp is self for bp in app.blueprints.values())`, i.e. it is `False` only when the *same `Blueprint` object* has already been registered — which is exactly how `record_once` de-duplicates.

### 2c. The merge step deliberately excludes filters/tests/globals

`src/flask/sansio/blueprints.py:379-410`:

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

It copies `template_context_processors` (line 410) but contains **no** branch for filters/tests/globals — confirmed by grep:

```
$ grep -n "_merge_blueprint_funcs\|template_context_processors\|filters\|tests\|globals" src/flask/sansio/blueprints.py
332:            self._merge_blueprint_funcs(app, name)
379:    def _merge_blueprint_funcs(self, app: App, name: str) -> None:
410:        extend(self.template_context_processors, app.template_context_processors)
473:            state.app.jinja_env.filters[name or f.__name__] = f
511:            state.app.jinja_env.tests[name or f.__name__] = f
549:            state.app.jinja_env.globals[name or f.__name__] = f
591:            lambda s: s.app.template_context_processors.setdefault(None, []).append(f)
```

The three env writes exist **only** inside the deferred closures — that is the whole reason `register`'s replay loop, not `_merge_blueprint_funcs`, is the mechanism that matters here.

### 2d. Nested blueprints reuse the same path

`src/flask/sansio/blueprints.py:350-377` tail of `register`:

```python
        for blueprint, bp_options in self._blueprints:
            bp_options = bp_options.copy()
            bp_url_prefix = bp_options.get("url_prefix")
            bp_subdomain = bp_options.get("subdomain")
            ...
            bp_options["name_prefix"] = name
            blueprint.register(app, bp_options)
```

So a blueprint registered *on another blueprint* still ends in `Blueprint.register`, and its deferred template closures still run. Probe result: `nested filter present: True`.

### 2e. The concrete `Flask.Blueprint` adds nothing here

`src/flask/blueprints.py` subclasses the sans-IO class:

```python
from .sansio.blueprints import Blueprint as SansioBlueprint
from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
...
class Blueprint(SansioBlueprint):
    def __init__(self, name, import_name, static_folder=None, ...):
        super().__init__(...)
        self.cli = AppGroup()
        self.cli.name = self.name
```

The rest of that file is `get_send_file_max_age`, `send_static_file`, `open_resource` — no filter/test/global code. The mechanism lives once, in `src/flask/sansio/blueprints.py`, and both layers share it (`src/flask/sansio/README.md`: "This folder contains code that can be used by alternative Flask implementations, for example Quart. The code therefore cannot do any IO, nor be part of a likely IO path. Finally this code cannot use the Flask globals.").

---

## Link 3 — The environment is per-app, cached, and singular

### 3a. The delegation entry point

`src/flask/sansio/app.py:570`:

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

### 3b. One `Environment` per app, created once

`src/flask/sansio/app.py:167-169`:

```python
    #: The class that is used for the Jinja environment.
    #:
    #: .. versionadded:: 0.11
    jinja_environment = Environment
```

`src/flask/sansio/app.py:469-480`:

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

(`@cached_property` is imported from Werkzeug: `src/flask/sansio/app.py:17: from werkzeug.utils import cached_property`.) `@cached_property` stores the result in the instance `__dict__`, so **every** access — from `render_template`, from a blueprint's deferred closure, from an extension, from the same app object — returns the *identical* `Environment` object. Probe confirmation:

```
same env object across accesses: True
env still identical: True
filters dict is same object: True
```

### 3c. The concrete environment

`src/flask/app.py:385-423`:

```python
    def create_jinja_environment(self) -> Environment:
        """Create the Jinja environment based on :attr:`jinja_options`
        and the various Jinja-related methods of the app. Changing
        :attr:`jinja_options` after this will have no effect. Also adds
        Flask-related globals and filters to the environment.

        .. versionchanged:: 0.11
           ``Environment.auto_reload`` set in accordance with
           ``TEMPLATES_AUTO_RELOAD`` configuration option.

        .. versionadded:: 0.5
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

and the environment class itself, `src/flask/templating.py:39-50`:

```python
class Environment(BaseEnvironment):
    """Works like a regular Jinja2 environment but has some additional
    knowledge of how Flask's blueprint works so that it can prepend the
    name of the blueprint to referenced templates if necessary.
    """

    def __init__(self, app: App, **options: t.Any) -> None:
        if "loader" not in options:
            options["loader"] = app.create_global_jinja_loader()
        BaseEnvironment.__init__(self, **options)
        self.app = app
```

Note this subclass adds only *loader* and *blueprint-name* behaviour; it does **not** isolate filters, tests or globals. The environment the blueprint closures write into and the environment the renderer reads from are one object.

### 3d. App-level registration writes the very same dicts

`src/flask/sansio/app.py:663-695` and the two analogues:

```python
    @setupmethod
    def template_filter(
        self, name: str | None = None
    ) -> t.Callable[[T_template_filter], T_template_filter]:
        """A decorator that is used to register custom template filter.
        You can specify a name for the filter, otherwise the function
        name will be used. Example::

          @app.template_filter()
          def reverse(s):
              return s[::-1]

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """

        def decorator(f: T_template_filter) -> T_template_filter:
            self.add_template_filter(f, name=name)
            return f

        return decorator

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

with `self.jinja_env.tests[name or f.__name__] = f` at **line 738** and `self.jinja_env.globals[name or f.__name__] = f` at **line 776**. The *only* six writers of the three dicts in the whole source tree are:

```
$ grep -rn "jinja_env\.\(filters\|tests\|globals\)" src/
src/flask/sansio/app.py:695:        self.jinja_env.filters[name or f.__name__] = f
src/flask/sansio/app.py:738:        self.jinja_env.tests[name or f.__name__] = f
src/flask/sansio/app.py:776:        self.jinja_env.globals[name or f.__name__] = f
src/flask/sansio/blueprints.py:473:            state.app.jinja_env.filters[name or f.__name__] = f
src/flask/sansio/blueprints.py:511:            state.app.jinja_env.tests[name or f.__name__] = f
src/flask/sansio/blueprints.py:549:            state.app.jinja_env.globals[name or f.__name__] = f
```

App-level code writes `self.jinja_env.*`; blueprint-level code writes `state.app.jinja_env.*`. Since `state.app is self` for the registering app, these are literally the same dictionaries. The blueprint docstrings say so explicitly: "available in any template rendered by the application. Equivalent to :meth:`.Flask.template_filter`."

---

## Link 4 — Every render path reads that same environment object

`src/flask/templating.py:126-163`:

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
    ...
    """
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.get_or_select_template(template_name_or_list)
    return _render(app, template, context)

def render_template_string(source: str, **context: t.Any) -> str:
    ...
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.from_string(source)
    return _render(app, template, context)
```

and in the streaming variants, `src/flask/templating.py:188-220`: `stream_template` — `template = app.jinja_env.get_or_select_template(template_name_or_list)` (line 203); `stream_template_string` — `template = app.jinja_env.from_string(source)` (line 218).

`src/flask/helpers.py:308`:

```python
    return getattr(current_app.jinja_env.get_template(template_name).module, attribute)
```

Verified by grep:

```
$ grep -n "current_app\|jinja_env\|def render_template\|def render_template_string\|def stream_template\|def stream_template_string\|def _render" src/flask/templating.py
12:from .globals import current_app
126:def _render(app: Flask, template: Template, context: dict[str, t.Any]) -> str:
138:def render_template(
148:    app = current_app._get_current_object()  # type: ignore[attr-defined]
149:    template = app.jinja_env.get_or_select_template(template_name_or_list)
153:def render_template_string(source: str, **context: t.Any) -> str:
160:    app = current_app._get_current_object()  # type: ignore[attr-defined]
161:    template = app.jinja_env.from_string(source)
188:def stream_template(
202:    app = current_app._get_current_object()  # type: ignore[attr-defined]
203:    template = app.jinja_env.get_or_select_template(template_name_or_list)
207:def stream_template_string(source: str, **context: t.Any) -> t.Iterator[str]:
217:    app = current_app._get_current_object()  # type: ignore[attr-defined]
218:    template = app.jinja_env.from_string(source)

$ grep -n "jinja_env" src/flask/helpers.py
308:    return getattr(current_app.jinja_env.get_template(template_name).module, attribute)
```

All five public entry points funnel through `current_app.jinja_env`, i.e. the identical cached object that the blueprint closure mutated. Blueprint template folders use a *different* mechanism (loader merging, `src/flask/templating.py:101-124`, `_iter_loaders` / `list_templates`) and are unrelated to filters/tests/globals.

Also relevant for completeness: blueprint-scoped *context processors* are matched by blueprint name at render time via `request.blueprints` — `src/flask/app.py:506-532`:

```python
    def update_template_context(self, context: dict[str, t.Any]) -> None:
        """Update the template context with some commonly used variables.
        ...
        """
        names: t.Iterable[str | None] = (None,)

        # A template may be rendered outside a request context.
        if request:
            names = chain(names, reversed(request.blueprints))

        # The values passed to render_template take precedence. Keep a
        # copy to re-apply after all context functions.
        orig_ctx = context.copy()

        for name in names:
            if name in self.template_context_processors:
                for func in self.template_context_processors[name]:
                    context.update(self.ensure_sync(func)())

        context.update(orig_ctx)
```

Filters/tests/globals have no such name-scoping at render time — once written into the app environment they apply to **all** templates.

---

## Link 5 — Why writing into those dicts is sufficient (Jinja's own resolution)

The three registries are plain dicts created by the environment (jinja2 3.1.6 vendored in this tree, `.venv/Lib/site-packages/jinja2/environment.py:351-353`):

```python
        # defaults
        self.filters = DEFAULT_FILTERS.copy()
        self.tests = DEFAULT_TESTS.copy()
        self.globals = DEFAULT_NAMESPACE.copy()
```

`filters`/`tests` are resolved at **compile** time (`.venv/Lib/site-packages/jinja2/compiler.py:1795-1815`):

```python
    @contextmanager
    def _filter_test_common(
        self, node: t.Union[nodes.Filter, nodes.Test], frame: Frame, is_filter: bool
    ) -> t.Iterator[None]:
        if self.environment.is_async:
            self.write("(await auto_await(")

        if is_filter:
            self.write(f"{self.filters[node.name]}(")
            func = self.environment.filters.get(node.name)
        else:
            self.write(f"{self.tests[node.name]}(")
            func = self.environment.tests.get(node.name)

        # When inside an If or CondExpr frame, allow the filter to be
        # undefined at compile time and only raise an error if it's
        # actually called at runtime. See pull_dependencies.
        if func is None and not frame.soft_frame:
            type_name = "filter" if is_filter else "test"
            self.fail(f"No {type_name} named {node.name!r}.", node.lineno)
```

and the compiled module binds the environment lookup (`.venv/Lib/site-packages/jinja2/compiler.py:554-580`):

```python
        for id_map, names, dependency in (
            (self.filters, visitor.filters, "filters"),
            (
                self.tests,
                visitor.tests,
                "tests",
            ),
        ):
            for name in sorted(names):
                if name not in id_map:
                    id_map[name] = self.temporary_identifier()

                # add check during runtime that dependencies used inside of executed
                # blocks are defined, as this step may be skipped during compile time
                self.writeline("try:")
                self.indent()
                self.writeline(f"{id_map[name]} = environment.{dependency}[{name!r}]")
                ...
```

with a runtime fallback that re-reads the dict (`.venv/Lib/site-packages/jinja2/environment.py:495-517`):

```python
    def _filter_test_common(
        self, name, value, args, kwargs, context, eval_ctx, is_filter,
    ) -> t.Any:
        if is_filter:
            env_map = self.filters
            type_name = "filter"
        else:
            env_map = self.tests
            type_name = "test"

        func = env_map.get(name)  # type: ignore

        if func is None:
            msg = f"No {type_name} named {name!r}."
            ...
            raise TemplateRuntimeError(msg)
```

Globals fall back through the environment (`environment.py:1113-1133`):

```python
    def make_globals(self, d: ...) -> t.MutableMapping[str, t.Any]:
        ...
        return ChainMap(d, self.globals)
```

So any write into `app.jinja_env.filters/tests/globals` performed before a template is compiled/rendered is picked up by every template that environment compiles — app templates and blueprint templates alike. This is precisely the "available in any template rendered by the application" promise in the docstrings.

---

## Link 6 — Idempotence, ordering, and lifecycle guarantees

**Idempotence on re-registration.** `record_once` wraps the closure in `if state.first_registration:` (lines 237-241), and `first_registration` is `not any(bp is self for bp in app.blueprints.values())` (line 316). Registering the same blueprint object again under a *new* name therefore does **not** re-run the environment write:

```
$ python (minimal reproduction, second registration)
same callable after re-registration: True
env still identical: True
```

```
=== probe 8: registering same bp twice with different names does not duplicate ===
deferred list length: 1
filter still present once: 1
```

**Ordering is irrelevant.** Because the environment is read at render time (compile + lookup) and not at route-declaration time, a blueprint filter registered *after* the route that renders it still works. This is pinned by `test_template_filter_after_route_with_template` / `test_template_test_after_route_with_template` and by probe 4 (`status: 200 data: b'dcba and True'`).

**Lifecycle guards keep the environment fully populated before rendering.**

The blueprint-side guard, `src/flask/sansio/blueprints.py:172` and `213-221`:

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

applied uniformly by `setupmethod` (`src/flask/sansio/scaffold.py:42-49`):

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`_got_registered_once = True` is set inside `register` at line 320, so no blueprint setup method can run after the registration replay. The app-side guard, `src/flask/sansio/app.py:413-422`:

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

with the flag set in `Flask.full_dispatch_request` (`src/flask/app.py:911: self._got_first_request = True`) and reset in the `run` finally-block (`src/flask/app.py:667`). Probe 7 confirms the observable consequence:

```
AssertionError raised: The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.
```

Together: all registrations must happen before registration/first request, and all renders happen after — so at render time the environment already contains every blueprint-registered filter/test/global.

**Names.** In all six writers the key is `name or f.__name__`: an explicit name wins, otherwise the function's `__name__`. `tests/test_blueprints.py::test_template_filter_with_name` asserts `app.jinja_env.filters["strrev"] == my_reverse` for `@bp.app_template_filter("strrev")`.

---

## Verification — commands actually run in this tree and their raw results

Tree: `C:/Users/oobbee/AppData/Local/Temp/pi-p50o/9f4f8f70/q6-TXT/seal`, git `HEAD 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, `pyproject.toml` version `3.2.0.dev`; interpreter `.venv/Scripts/python.exe` (3.13.9, pytest 8.4.0, jinja2 3.1.6). Test runs used `PYTHONPATH=src`; the plan-verbatim forms (without it) were also run and gave identical results.

**Targeted selections (four commands):**

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_blueprints.py -k "template_filter or template_test or template_global" -q
...................                                                      [100%]
19 passed, 41 deselected in 0.27s
EXIT=0
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_templating.py -k "template_filter or template_test or template_global" -q
.................                                                        [100%]
17 passed, 15 deselected in 0.24s
EXIT=0
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_blueprints.py -q
............................................................             [100%]
60 passed in 0.87s
EXIT=0
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest "tests/test_blueprints.py::test_template_global" "tests/test_blueprints.py::test_template_filter_after_route_with_template" -q
..                                                                       [100%]
2 passed in 0.12s
EXIT=0
```

**No warnings were emitted in any of these runs**, which matters because `pyproject.toml:107-111` sets

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
filterwarnings = [
    "error",
]
```

so any warning would have failed the run. All four passed clean.

**Minimal, self-contained reproduction** (heredoc; no repo file written):

```python
import flask

app = flask.Flask(__name__)
bp = flask.Blueprint("bp", __name__)

@bp.app_template_filter()
def rev(s):
    return s[::-1]

@bp.app_template_test()
def is_odd(n):
    return n % 2 == 1

@bp.app_template_global()
def answer():
    return 42

# Before registration: closures are only queued, env is untouched.
print("deferred before:", len(bp.deferred_functions))
print("filter present before:", "rev" in app.jinja_env.filters)

app.register_blueprint(bp)

env = app.jinja_env
print("same env object across accesses:", env is app.jinja_env)
print("filter:", env.filters["rev"]("abcd"))
print("test:", env.tests["is_odd"](3))
print("global:", env.globals["answer"]())

with app.app_context():
    print(flask.render_template_string("{{ 'abcd'|rev }} {{ 3 is is_odd }} {{ answer() }}"))

# record_once idempotence: register the same object again under a new name.
first = env.filters["rev"]
app.register_blueprint(bp, name="bp2")
print("same callable after re-registration:", env.filters["rev"] is first)
print("env still identical:", env is app.jinja_app if False else env is app.jinja_env)
```

Observed output (the last line above is the same check that ran; actual executed source used `env is app.jinja_env`):

```
deferred before: 3
filter present before: False
same env object across accesses: True
filter: dcba
test: True
global: 42
dcba True 42
same callable after re-registration: True
env still identical: True
EXIT=0
```

Every expected line matched. The reproduction demonstrates, in one run: deferred storage untouched before registration (`deferred before: 3`, `filter present before: False`); replay writing all three registries; the single cached environment object (`same env object across accesses: True`); end-to-end visibility through `render_template_string` (`dcba True 42`); and `record_once` idempotence under re-registration (`same callable after re-registration: True`).

**Full relevant suite:**

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_blueprints.py tests/test_templating.py -q
........................................................................ [ 78%]
....................                                                     [100%]
92 passed in 1.15s
EXIT=0

$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests -q 2>&1 | tail -40
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 5.89s
EXIT=0
```

A fresh-bytecode run (`PYTHONPYCACHEPREFIX` to a temp dir, `-B`) also reported `92 passed`, ruling out stale compilation caches.

---

## The tests that pin this contract

Blueprint-side assertions are on **`app.jinja_env`**, not on any blueprint object.

`tests/test_blueprints.py:362-372`:

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

`tests/test_blueprints.py:675-690` — including the explicit "not present before registration" check and a real render:

```python
def test_template_global(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_global()
    def get_answer():
        return 42

    # Make sure the function is not in the jinja_env already
    assert "get_answer" not in app.jinja_env.globals.keys()
    app.register_blueprint(bp)

    # Tests
    assert "get_answer" in app.jinja_env.globals.keys()
    assert app.jinja_env.globals["get_answer"] is get_answer
    assert app.jinja_env.globals["get_answer"]() == 42

    with app.app_context():
        rv = flask.render_template_string("{{ get_answer() }}")
        assert rv == "42"
```

The `add_*` and named variants, `tests/test_blueprints.py:375-411` and `498-547`:

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

def test_template_filter_with_name(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter("strrev")
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    assert "strrev" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["strrev"] == my_reverse
    assert app.jinja_env.filters["strrev"]("abcd") == "dcba"
```

```python
def test_template_test(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_test()
    def is_boolean(value):
        return isinstance(value, bool)

    app.register_blueprint(bp, url_prefix="/py")
    assert "is_boolean" in app.jinja_env.tests.keys()
    assert app.jinja_env.tests["is_boolean"] == is_boolean
    assert app.jinja_env.tests["is_boolean"](False)
```

Order-independence ("after route"), `tests/test_blueprints.py:414-445` and `550-581`:

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
def test_template_test_after_route_with_template(app, client):
    @app.route("/")
    def index():
        return flask.render_template("template_test.html", value=False)

    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_test()
    def boolean(value):
        return isinstance(value, bool)

    app.register_blueprint(bp, url_prefix="/py")
    rv = client.get("/")
    assert b"Success!" in rv.data
```

The template fixtures, `tests/templates/template_filter.html` and `tests/templates/template_test.html` (whole files):

```jinja
{{ value|super_reverse }}
```

```jinja
{% if value is boolean %}
    Success!
{% endif %}
```

Full set of the 19 blueprint-side tests (all pass; they are exactly what command 6.1 selected):

```
$ grep -n "^def test_" tests/test_blueprints.py | grep -i "template"
362:def test_template_filter(app):
375:def test_add_template_filter(app):
388:def test_template_filter_with_name(app):
401:def test_add_template_filter_with_name(app):
414:def test_template_filter_with_template(app, client):
431:def test_template_filter_after_route_with_template(app, client):
447:def test_add_template_filter_with_template(app, client):
464:def test_template_filter_with_name_and_template(app, client):
481:def test_add_template_filter_with_name_and_template(app, client):
498:def test_template_test(app):
511:def test_add_template_test(app):
524:def test_template_test_with_name(app):
537:def test_add_template_test_with_name(app):
550:def test_template_test_with_template(app, client):
567:def test_template_test_after_route_with_template(app, client):
583:def test_add_template_test_with_template(app, client):
600:def test_template_test_with_name_and_template(app, client):
617:def test_add_template_test_with_name_and_template(app, client):
675:def test_template_global(app):
```

App-level equivalents (direct writes, same dicts), `tests/test_templating.py:123-160` and `217-321`:

```python
def test_template_filter(app):
    @app.template_filter()
    def my_reverse(s):
        return s[::-1]

    assert "my_reverse" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["my_reverse"] == my_reverse
    assert app.jinja_env.filters["my_reverse"]("abcd") == "dcba"
```

```python
def test_template_test(app):
    @app.template_test()
    def boolean(value):
        return isinstance(value, bool)

    assert "boolean" in app.jinja_env.tests.keys()
    assert app.jinja_env.tests["boolean"] == boolean
    assert app.jinja_env.tests["boolean"](False)
```

```python
def test_add_template_global(app, app_ctx):
    @app.template_global()
    def get_stuff():
        return 42

    assert "get_stuff" in app.jinja_env.globals.keys()
    assert app.jinja_env.globals["get_stuff"] == get_stuff
    assert app.jinja_env.globals["get_stuff"](), 42

    rv = flask.render_template_string("{{ get_stuff() }}")
    assert rv == "42"
```

`jinja_environment` as the construction hook, `tests/test_templating.py:441-451`:

```python
def test_custom_jinja_env():
    class CustomEnvironment(flask.templating.Environment):
        pass

    class CustomFlask(flask.Flask):
        jinja_environment = CustomEnvironment

    app = CustomFlask(__name__)
    assert isinstance(app.jinja_env, CustomEnvironment)
```

Multi-registration precedent for `record_once`, `tests/test_blueprints.py:994-1014`:

```python
def test_unique_blueprint_names(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp", __name__)

    app.register_blueprint(bp)

    with pytest.raises(ValueError):
        app.register_blueprint(bp)  # same bp, same name, error

    app.register_blueprint(bp, name="again")  # same bp, different name, ok

    with pytest.raises(ValueError):
        app.register_blueprint(bp2)  # different bp, same name, error

    app.register_blueprint(bp2, name="alt")  # different bp, different name, ok
```

Fixtures, `tests/conftest.py:44-67`:

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app

@pytest.fixture
def app_ctx(app):
    with app.app_context() as ctx:
        yield ctx

@pytest.fixture
def req_ctx(app):
    with app.test_request_context() as ctx:
        yield ctx

@pytest.fixture
def client(app):
    return app.test_client()
```

---

## Documentation of the user-facing contract

`docs/blueprints.rst:27-31`:

```
* Register a blueprint multiple times on an application with different URL
  rules.
* Provide template filters, static files, templates, and other utilities
  through blueprints.  A blueprint does not have to implement applications
  or view functions.
```

`docs/blueprints.rst:47-50`:

```
The basic concept of blueprints is that they record operations to execute
when registered on an application.  Flask associates view functions with
blueprints when dispatching requests and generating URLs from one endpoint
to another.
```

`docs/templating.rst:138-160`:

```
.. _registering-filters:

Registering Filters
-------------------

If you want to register your own filters in Jinja2 you have two ways to do
that.  You can either put them by hand into the
:attr:`~flask.Flask.jinja_env` of the application or use the
:meth:`~flask.Flask.template_filter` decorator.

The two following examples work the same and both reverse an object::

    @app.template_filter('reverse')
    def reverse_filter(s):
        return s[::-1]

    def reverse_filter(s):
        return s[::-1]
    app.jinja_env.filters['reverse'] = reverse_filter

In case of the decorator the argument is optional if you want to use the
function name as name of the filter.  Once registered, you can use the filter
in your templates in the same way as Jinja2's builtin filters, ...
```

`CHANGES.rst:1266-1272` records the introduction of the blueprint API:

```
-   Blueprints now have a decorator to add custom template filters
    application wide, ``Blueprint.app_template_filter``.
-   The Flask and Blueprint classes now have a non-decorator method for
    adding custom template filters application wide,
    ``Flask.add_template_filter`` and
    ``Blueprint.add_app_template_filter``.
```

Blueprint *template folders* are documented separately (`docs/blueprints.rst:219-236`) and are handled by the loader, not by the env dicts:

```
Templates
---------

If you want the blueprint to expose templates you can do that by providing
the `template_folder` parameter to the :class:`Blueprint` constructor::

    admin = Blueprint('admin', __name__, template_folder='templates')

The template folder is added to the search path of templates but with a lower
priority than the actual application's template folder. ...
```

---

## Negative results (searched, to bound the claim)

- The complete set of writers of `jinja_env.filters/tests/globals` in `src/` is the six lines listed in Link 3 — `src/flask/sansio/app.py:695,738,776` and `src/flask/sansio/blueprints.py:473,511,549`. No other writer exists anywhere in the source tree.
- `app_template_filter|app_template_test|app_template_global|add_app_template_*` occur only in `src/flask/sansio/blueprints.py` (definitions + internal decorator calls), `tests/test_blueprints.py` (usages), and `CHANGES.rst:1268,1272`. Nothing in `src/flask/blueprints.py`; nothing in `docs/`.
- `record_once|deferred_functions|_got_registered_once` never appear in `tests/`, so `record_once` idempotence is pinned only indirectly (by `test_unique_blueprint_names`, which tolerates double registration under different names, plus the executor's probes).
- No test asserts `app.jinja_env is app.jinja_env` identity; the single-object property is established by reading `@cached_property` and by the reproduction probe.
- `blueprints.py` has no test asserting the blueprint `_got_registered_once` `AssertionError` (grep for `AssertionError|already been registered|no longer` returns no blueprint-side match); the analogous app-level test is `tests/test_basic.py:1678-1691` (`test_no_setup_after_first_request`).

---

## Caveat: one failing artifact exists in the tree but is orthogonal to this question

The checkout contains `flask_mut2_i417ar2x/mutated_test.py` and a `.pytest_cache/v/cache/lastfailed` reading:

```json
{
  "examples/javascript/tests": true,
  "examples/tutorial/tests": true,
  "flask_mut2_i417ar2x/mutated_test.py": true
}
```

`flask_mut2_i417ar2x/mutated_test.py` (whole file):

```python
import flask

app = flask.Flask(__name__, subdomain_matching=False)
app.config["SERVER_NAME"] = "example.com"
client = app.test_client()

@app.route("/", subdomain="<company_id>")
def view(company_id):
    return company_id

with app.test_request_context():
    url = flask.url_for("view", company_id="xxx")
print("url_for ->", url)

with client:
    response = client.get(url)

print("status_code:", response.status_code)
print("data:", response.data)
assert 200 == response.status_code, f"status {response.status_code}"
assert b"xxx" == response.data, f"data {response.data!r}"
print("ASSERTS PASSED (unexpected)")
```

Executed:

```
$ PYTHONPATH=src .venv/Scripts/python.exe flask_mut2_i417ar2x/mutated_test.py
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
Traceback (most recent call last):
  File "...\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
AssertionError: status 404
EXIT=1
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest flask_mut2_i417ar2x/mutated_test.py -q
...
E   AssertionError: status 404
E   assert 200 == 404
E    +  where 404 = <WrapperTestResponse 207 bytes [404 NOT FOUND]>.status_code
=========================== short test summary info ============================
ERROR flask_mut2_i417ar2x/mutated_test.py - AssertionError: status 404
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.96s
EXIT=2
```

The other two `lastfailed` entries are collection-time import errors, not template defects:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest examples/tutorial/tests -q
ImportError while loading conftest '.../examples/tutorial/tests/conftest.py'.
...conftest.py:6: in <module>
    from flaskr import create_app
E   ModuleNotFoundError: No module named 'flaskr'
EXIT=4

$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest examples/javascript/tests -q
ImportError while loading conftest '.../examples/javascript/tests/conftest.py'.
...conftest.py:3: in <module>
    from js_example import app
E   ModuleNotFoundError: No module named 'js_example'
EXIT=4
```

The artifact exercises URL building / subdomain matching (`Flask.__init__(subdomain_matching=False)`, `SERVER_NAME`, `flask.url_for`, `Flask.create_url_adapter`) — a code path that never reads `jinja_env`, `filters`, `tests` or `globals`. Its expected-failure inversion aside, it is **disjoint from the blueprint→environment mechanism documented above**. Conclusion: the template-processing mechanism in this checkout is intact; the only live failure in the tree belongs to the subdomain/URL path, and `examples/*/tests` fail merely because the example apps are not on `sys.path`.

Two environment notes recorded during execution, neither affecting the conclusion: (a) the venv's editable-install pointer (`.venv/Lib/site-packages/flask.pth`) names a sibling copy of the same source at the same commit `85c5d93`; `diff -rq` over the two `src` trees shows no differences, and test runs were pinned to the working tree with `PYTHONPATH=src`; (b) the tree carries stale `__pycache__` files whose embedded `co_filename`s reference another filesystem path (visible in the pytest traceback above), but their mtime+size match the working-tree sources and a forced fresh-compile run also gives `92 passed`, so nothing is masked.
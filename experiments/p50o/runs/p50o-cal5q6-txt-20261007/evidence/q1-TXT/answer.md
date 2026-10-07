# How blueprint-registered template processing functions reach the shared Jinja environment

**Question:** *What mechanisms ensure that template processing functions registered during modular component registration are accessible when templates are rendered using the shared template environment?*

**Short answer:** Flask makes blueprint template filters, tests, and globals *deferred setup callbacks*. `Blueprint.add_app_template_filter/test/global` do not touch any environment at decoration time; they wrap a closure `register_template(state)` and store it in `blueprint.deferred_functions` via `record_once`. When the blueprint is later attached, `Flask.register_blueprint` → `Blueprint.register` builds a `BlueprintSetupState` carrying `self.app = app` and calls every deferred function with it. Each closure then writes into **`state.app.jinja_env`** — the *application's* environment. That environment is a `@cached_property` on `App`, so one `Environment` instance exists per app for its lifetime, and every render entry point in `templating.py` resolves through **`current_app.jinja_env`**, the identical object. The entries therefore persist from registration into rendering. A `record_once` guard keyed on `state.first_registration` makes repeated registration of the same blueprint object idempotent.

Everything below is quoted verbatim from the working copy at `C:/Users/oobbee/AppData/Local/Temp/pi-p50o/920457b8/q1-TXT/seal` (Flask `3.2.0.dev0`); all four link points were re-verified by grep after the executor's run.

---

## 1. Decoration time: the functions are *recorded*, not installed

The blueprint methods never require an app, because none exists yet. The class docstring states the design explicitly (`src/flask/sansio/blueprints.py`, lines 119–136):

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

The three template methods each define a closure and hand it to `record_once` (`src/flask/sansio/blueprints.py`, lines ~460–551):

```python
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

```python
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

```python
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

The decorator variants (`app_template_filter`, `app_template_test`, `app_template_global`) simply delegate, e.g.:

```python
        def decorator(f: T_template_filter) -> T_template_filter:
            self.add_app_template_filter(f, name=name)
            return f

        return decorator
```

The deferral storage is `record` / `record_once` (`src/flask/sansio/blueprints.py`, lines 223–253), with the list declared at line 204 (`self.deferred_functions: list[DeferredSetupFunction] = []`, inside `Blueprint.__init__`):

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

    def make_setup_state(
        self, app: App, options: dict[str, t.Any], first_registration: bool = False
    ) -> BlueprintSetupState:
        """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
        object that is later passed to the register callback functions.
        Subclasses can override this to return a subclass of the setup state.
        """
        return BlueprintSetupState(self, app, options, first_registration)
```

**Why the design must be deferred** (all decorators must run before registration) is enforced by `setupmethod` (`src/flask/sansio/scaffold.py`, lines 40–49):

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

…which calls `Blueprint._check_setup_finished` (`src/flask/sansio/blueprints.py`, lines 213–221):

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

So calling `@bp.app_template_global()` after registration raises; the only supported flow is *record now, apply at registration*.

---

## 2. Registration time: `Blueprint.register` dispatches the deferred callbacks with the app in hand

`Flask.register_blueprint` is a thin wrapper (`src/flask/sansio/app.py`, lines 569–598); its body is one line:

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

`Blueprint.register` (`src/flask/sansio/blueprints.py`, `def register` at 273; docstring 274–289) computes first-registration flags, builds the setup state, and then runs the deferred list:

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

Its docstring:

```python
    def register(self, app: App, options: dict[str, t.Any]) -> None:
        """Called by :meth:`Flask.register_blueprint` to register all
        views and callbacks registered on the blueprint with the
        application. Creates a :class:`.BlueprintSetupState` and calls
        each :meth:`record` callback with it.
```

**The state carries the app**, which is what gives each deferred closure a target (`src/flask/sansio/blueprints.py`, `BlueprintSetupState.__init__`):

```python
    def __init__(
        self,
        blueprint: Blueprint,
        app: App,
        options: t.Any,
        first_registration: bool,
    ) -> None:
        #: a reference to the current application
        self.app = app
        ...
        #: as blueprints can be registered multiple times with the
        #: application and not everything wants to be registered
        #: multiple times on it, this attribute can be used to figure
        #: out if the blueprint was registered in the past already.
        self.first_registration = first_registration
```

> **Anchor correction from the executor's audit:** `self.app = app` is at **line 49** of `src/flask/sansio/blueprints.py` (not 48 as the planning evidence said); `self.first_registration` is at line 62. Verified by re-grep: `blueprints.py:49: self.app = app`, `blueprints.py:62: self.first_registration = first_registration`.

Important contrast: the merge step does **not** carry filters/tests/globals. `_merge_blueprint_funcs` (`src/flask/sansio/blueprints.py`, lines 379–410) ends with:

```python
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

`template_context_processors` (line 410) is merged directly, but there is **no** filter/test/global entry. Filter/test/global registration reaches the app *only* through `deferred_functions`. Confirmed by grep:

```
$ grep -n "state.app.jinja_env" src/flask/sansio/blueprints.py
473:            state.app.jinja_env.filters[name or f.__name__] = f
511:            state.app.jinja_env.tests[name or f.__name__] = f
549:            state.app.jinja_env.globals[name or f.__name__] = f
$ grep -n "def _merge_blueprint_funcs" src/flask/sansio/blueprints.py
379:    def _merge_blueprint_funcs(self, app: App, name: str) -> None:
$ grep -n "template_context_processors" src/flask/sansio/blueprints.py
410:        extend(self.template_context_processors, app.template_context_processors)
591:            lambda s: s.app.template_context_processors.setdefault(None, []).append(f)
```

That is link points **(i)** `record_once` → `deferred_functions`, **(ii)** `state.app`, and **(iii)** `state.app.jinja_env.<dict>[...] = f`.

---

## 3. The write target is the *application's* shared environment

The render path and the registration path meet because both name `app.jinja_env`. On the app side, `App.jinja_env` is a cached property — **one environment per app, created once, then reused forever** (`src/flask/sansio/app.py`, lines 468–480):

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

The concrete constructor is `Flask.create_jinja_environment` (`src/flask/app.py`, lines 385–421):

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

Because of `@cached_property`, `create_jinja_environment` runs **once** per app (`rv = self.jinja_environment(self, **options)` at line 410). Every later `app.jinja_env` — including the ones used during blueprint registration and during rendering — returns the same `Environment` instance. Dict mutations made at registration time therefore persist and are visible to Jinja at render time. (This is the crux of the "shared template environment" half of the question; `App.jinja_environment = Environment` is the class used at `src/flask/sansio/app.py` lines 165–169.)

The contrast case is the app-level API, which mutates the same property *immediately* because the app already exists (`src/flask/sansio/app.py`):

```python
        self.jinja_env.filters[name or f.__name__] = f      # line 695, add_template_filter
        ...
        self.jinja_env.tests[name or f.__name__] = f        # line 738, add_template_test
        ...
        self.jinja_env.globals[name or f.__name__] = f      # line 776, add_template_global
```

```python
$ grep -n "self.jinja_env" src/flask/sansio/app.py
695:        self.jinja_env.filters[name or f.__name__] = f     # immediate, app-level
738:        self.jinja_env.tests[name or f.__name__] = f
776:        self.jinja_env.globals[name or f.__name__] = f
```

The blueprint docstrings say the blueprint forms are the "Equivalent to `.Flask.add_template_filter/test/global`"; the only difference is *when* the write happens — deferred for blueprints, immediate for the app.

---

## 4. Render time: every entry point reads the same `current_app.jinja_env`

`src/flask/templating.py` defines all four public render entry points; each begins by grabbing the current app and then touching `app.jinja_env` (grep-verified lines 148–149, 160–161, 202–203, 217–218):

```python
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
    """Render a template from the given source string with the given
    context.
    ...
    """
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.from_string(source)
    return _render(app, template, context)
```

```python
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.get_or_select_template(template_name_or_list)
    return _stream(app, template, context)          # stream_template (lines 202-204)

    app = current_app._get_current_object()  # type: ignore[attr-defined]
    template = app.jinja_env.from_string(source)
    return _stream(app, template, context)          # stream_template_string (217-219)
```

The actual render call is `_render` (`src/flask/templating.py`, lines 126–136):

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
```

`current_app` is the `LocalProxy` over the app context (`src/flask/globals.py`, lines 29–32), so `current_app.jinja_env` *is* the object the blueprint callback wrote into:

```python
current_app: Flask = LocalProxy(  # type: ignore[assignment]
    _cv_app, "app", unbound_message=_no_app_msg
)
```

The `Environment` subclass also stores the app (`src/flask/templating.py`, lines 39–50), reinforcing that the environment belongs to one app:

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

Note that `render_template`/`render_template_string` only touch `app.jinja_env`; the context-processor path is separate (`Flask.update_template_context`, `src/flask/app.py` lines 506–532, invoked from `_render`), and context processors are the thing `_merge_blueprint_funcs` copies — not filters/tests/globals.

---

## 5. Idempotency: `record_once` runs the write only on first registration

`record_once` wraps the closure in a check on `state.first_registration`, which `Blueprint.register` computes as `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (line 316) and passes to `make_setup_state(app, options, first_bp_registration)` (line 321). Hence registering the same blueprint object a second time under a different name does not re-run the environment mutation (and cannot fail, since it is the same dict slot). The guard also means the app-level immediate API's behaviour (re-assigns the same slot) is matched in effect.

---

## 6. Verification in this working copy

The mechanism is intact here, and it was exercised end-to-end. Interpreter used throughout: `C:\...\920457b8\q1-TXT\seal\.venv\Scripts\python.exe` (Python 3.13.9, pytest 8.4.0), rootdir this worktree, configfile `pyproject.toml`.

**Interpreter caveat (handled):** `.venv` is a junction to `D:\...\flask-src\.venv` and its `flask.pth` points at a *different* session tree (`...\pi-p50o\f2f45b5b\...\src`). The three trees were proven byte-identical (`diff -rq` empty, matching SHA-256 of `src/flask/**.py` contents), and every run below forced the correct tree via `PYTHONPATH`; `flask.__file__` and a collection-path plugin confirmed the worktree's `src/` and `tests/` were the ones executed. So the results do verify this source content.

**Focused test runs (plan step 3):**

```
$ python -m pytest tests/test_blueprints.py -k "template" -q
.....................
21 passed, 39 deselected in 0.26s          EXIT=0

$ python -m pytest tests/test_templating.py -q
................................
32 passed in 0.19s                          EXIT=0
```

**Whole relevant suite (run twice, normal and `-vvv -rA --tb=long`):**

```
$ python -m pytest tests/test_blueprints.py tests/test_templating.py -q
........................................................................ [ 78%]
....................                                                     [100%]
92 passed in 0.65s                          EXIT=0
```

The verbose summary confirms all 20 blueprint template tests and all 17 templating filter/test/global tests `PASSED`, including `tests/test_blueprints.py::test_template_global`, `::test_template_filter_with_template`, `::test_template_filter_after_route_with_template`, `::test_template_test_after_route_with_template`, and `tests/test_templating.py::test_add_template_global`.

**Entire project suite:** `python -m pytest -q` → `489 passed in 2.87s`, EXIT=0; the same suite at `-vvv -rA --tb=long` → `489 passed in 2.95s`, EXIT=0 (150 KB log saved in scratch). The `ERROR` lines in that log are captured `caplog` output from error-handler tests that intentionally raise, not failures.

**Independent end-to-end repro** (`flask_mut2_i417ar2x/template_mechanism_check.py`, scratch file; `src/` untouched, `git status --porcelain` shows only `?? flask_mut2_i417ar2x/`), run with the worktree on `PYTHONPATH`:

```
flask module: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q1-TXT\seal\src\flask\__init__.py

-- (a) before register_blueprint --
[PASS] my_reverse absent from app.jinja_env.filters
[PASS] is_answer absent from app.jinja_env.tests
[PASS] get_answer absent from app.jinja_env.globals
[PASS] blueprint holds 3 deferred callbacks

-- (b) after register_blueprint --
[PASS] my_reverse present in app.jinja_env.filters
[PASS] my_reverse is identical object
[PASS] is_answer present in app.jinja_env.tests
[PASS] is_answer is identical object
[PASS] get_answer present in app.jinja_env.globals
[PASS] get_answer is identical object
[PASS] filter callable works

-- (c) shared environment + rendering --
[PASS] app.jinja_env is the same instance as before
[PASS] env.app is this app
[PASS] render_template_string applies filter: 'dcba'
[PASS] render_template_string applies test: 'yes'
[PASS] render_template_string applies global: '42'
[PASS] render_template (by file) resolves all three: 'dcba|Y|42'

-- (d) re-registration --
[PASS] record_once callback ran exactly once across two registrations: ['bp2']
[PASS] re-register did not raise
[PASS] filter still identical object after re-register
[PASS] global still identical object after re-register
   setupmethod guard message: The setup method 'app_template_global' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
[PASS] decorator after registration raises AssertionError (setupmethod guard)

============================================================
RESULT: ALL CHECKS PASSED
EXIT=0
```

This directly demonstrates the four observations: **(a)** names absent before registration (proving nothing is installed at decoration time), **(b)** present as the *identical function objects* after `register_blueprint`, **(c)** one shared environment instance that renders all three kinds through both `render_template_string` and `render_template`, and **(d)** idempotent `record_once` re-registration plus the `setupmethod` guard.

**Test-suite corroboration of the same properties:**

- Pre/post registration assertion (`tests/test_blueprints.py`, lines 675–690):

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

- Registered filter used by a rendered route template (`tests/test_blueprints.py`, lines 414–442):

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

(The second shows registration order between route and blueprint does not matter — only that the blueprint is registered before the first render.) The template rendered is `tests/templates/template_filter.html`: `{{ value|super_reverse }}`.

- Blueprint test registration (`tests/test_blueprints.py`, lines 498–521):

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

def test_add_template_test(app):
    bp = flask.Blueprint("bp", __name__)

    def is_boolean(value):
        return isinstance(value, bool)

    bp.add_app_template_test(is_boolean)
    app.register_blueprint(bp, url_prefix="/py")
    assert "is_boolean" in app.jinja_env.tests.keys()
    assert app.jinja_env.tests["is_boolean"] == is_boolean
    assert app.jinja_env.tests["is_boolean"](False)
```

- Multiple registration of one blueprint object does not disturb this (`tests/test_url_defaults`, lines 130–148): `app.register_blueprint(bp, url_prefix="/1", ...)` then `app.register_blueprint(bp, name="test2", url_prefix="/2", ...)`.

- Documentation confirms the intended capability (`docs/blueprints.rst` line 29): "Provide template filters, static files, templates, and other utilities through blueprints. A blueprint does not have to implement applications or view functions."; and `CHANGES.rst` lines 1267–1272 records the API: "Blueprints now have a decorator to add custom template filters application wide, `Blueprint.app_template_filter`." / "The Flask and Blueprint classes now have a non-decorator method for adding custom template filters application wide, `Flask.add_template_filter` and `Blueprint.add_app_template_filter`."

---

## 7. Conclusion — the mechanisms, enumerated

| Stage | Mechanism | Anchor |
|---|---|---|
| Decoration | `add_app_template_filter/test/global` build a `register_template(state)` closure and pass it to `record_once`; nothing is written to any environment yet | `sansio/blueprints.py` 460–475, 497–513, 535–551 |
| Storage | `record_once` wraps with a `state.first_registration` check and calls `record`, which appends to `blueprint.deferred_functions` | `sansio/blueprints.py` 204, 223–244 |
| Enforcement | `@setupmethod` → `Blueprint._check_setup_finished` forbids calling these after registration, forcing the deferred design | `sansio/scaffold.py` 40–49; `sansio/blueprints.py` 213–221 |
| Dispatch | `Flask.register_blueprint` → `Blueprint.register` computes `first_bp_registration`, builds `BlueprintSetupState` via `make_setup_state`, and runs `for deferred in self.deferred_functions: deferred(state)` | `sansio/app.py` 569–598; `sansio/blueprints.py` 273/316/321/334–335 |
| App hand-off | `BlueprintSetupState.__init__` sets `self.app = app` | `sansio/blueprints.py` 49 |
| Environment write | Each closure executes `state.app.jinja_env.filters/tests/globals[name or f.__name__] = f` — the *application's* env | `sansio/blueprints.py` 473, 511, 549 |
| Sharing | `App.jinja_env` is `@cached_property` returning one `Environment`, constructed once in `Flask.create_jinja_environment` | `sansio/app.py` 468–480; `app.py` 385–421 |
| Rendering | `render_template` / `render_template_string` / `stream_template*` all resolve through `current_app.jinja_env` — the same instance | `templating.py` 148–149, 160–161, 202–203, 217–218 |
| Idempotency | `record_once`'s wrapper checks `state.first_registration` (from `first_bp_registration`) so re-registration does not re-run the write | `sansio/blueprints.py` 241, 316, 321 |

Two deliberate contrasts sharpen the answer: the app-level `add_template_filter/test/global` mutate `self.jinja_env` **immediately** (no app missing, lines 695/738/776 of `sansio/app.py`), and `template_context_processors` are propagated by **`_merge_blueprint_funcs`** (line 410) rather than by deferred callbacks — so filters/tests/globals are the only one of these families that travels exclusively through `deferred_functions`.

**Verdict:** in this working copy the mechanism is fully intact — all 20 blueprint template tests and all 17 templating filter/test/global tests pass (92/92 relevant; 489/489 whole suite), and the standalone repro confirms absent-before / present-and-identical-after / single shared environment / rendering resolution / idempotent re-registration. The one failing script in the tree (`flask_mut2_i417ar2x/mutated_test.py`, a subdomain `url_for` case with `subdomain_matching=False` and `SERVER_NAME`, exit 1 with a 404) touches no blueprint and no template filter/test/global and is unrelated to this question.
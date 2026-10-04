# Purpose of `_got_registered_once` in Flask's `Blueprint`

## Direct answer

`_got_registered_once` is a **strictly one-way latch** on the `Blueprint` class that records whether that blueprint object has **ever** been registered on at least one application. It starts `False`, is flipped to `True` exactly once inside `Blueprint.register()`, and is read in exactly one place — `Blueprint._check_setup_finished()` — which every `@setupmethod` calls before doing its work. Once the flag is `True`, any further setup call (e.g. `@bp.route(...)`, `bp.record(...)`, `bp.before_request(...)`) raises `AssertionError`, because the blueprint's deferred setup has already been materialized onto an app and later mutations "will not be applied consistently." In short: **it fails fast when someone tries to keep configuring a blueprint after it has already been registered.**

The flag appears in exactly three lines across the whole worktree (`grep_worktree "_got_registered_once"`):

```
src/flask/sansio/blueprints.py:172: _got_registered_once = False
src/flask/sansio/blueprints.py:214: if self._got_registered_once:
src/flask/sansio/blueprints.py:320: self._got_registered_once = True
```

---

## 1. Definition: a class-level attribute, defaulting to `False`

The flag is declared as a class attribute on `Blueprint` (`src/flask/sansio/blueprints.py:119` begins the class; the flag sits at line 172):

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
    ...
    """

    _got_registered_once = False
```

Crucially, `__init__` (lines 174–211) **never assigns it**, so every instance relies on the class default:

```python
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

Runtime confirmation: a fresh blueprint reports `bp._got_registered_once == False`, the attribute is **not** in the instance `__dict__`, and the MRO shows the defining class:

```
bp type: <class 'flask.blueprints.Blueprint'>
fresh flag: False
in instance dict? False
MRO: ['Blueprint', 'Blueprint', 'Scaffold', 'object']
   defines class attr in: flask.sansio.blueprints.Blueprint = False
__init__ assigns _got_registered_once: False
```

So all new blueprints start unregistered.

---

## 2. The only reader: `Blueprint._check_setup_finished` (lines 213–221)

The flag is consumed exclusively by the blueprint's override of `_check_setup_finished`:

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

This **overrides** the abstract hook declared on `Scaffold` (`src/flask/sansio/scaffold.py:220-221`):

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

The `grep_worktree "_check_setup_finished"` output confirms the wiring — one abstract declaration, one call site in the decorator, and two concrete overrides (app and blueprint):

```
src/flask/sansio/app.py:413: def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/blueprints.py:213: def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/scaffold.py:46: self._check_setup_finished(f_name)
src/flask/sansio/scaffold.py:220: def _check_setup_finished(self, f_name: str) -> None:
```

---

## 3. How the check is wired into every setup method: `@setupmethod`

The decorator, `src/flask/sansio/scaffold.py:42-49`, wraps each setup method so the check runs **before** the real method body:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`Blueprint` uses it on `record` (line 223), `record_once` (232), `register_blueprint` (255), and 14 further blueprint-specific setup methods (e.g. `add_url_rule` at 412, `app_template_filter` at 443, `before_app_request` at 612), plus inherits the `Scaffold` setup methods (`route`, `get`/`post`, `add_url_rule`, `before_request`, `after_request`, `errorhandler`, etc.).

A runtime introspection scan (`inspect.getsource`-based, detecting the `_check_setup_finished`/`f_name` closure) enumerated the decorated members and matched the 17 decorator line numbers in `blueprints.py` (223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624):

```
Scaffold: ['add_url_rule', 'after_request', 'before_request', 'context_processor', 'delete', 'endpoint', 'errorhandler', 'get', 'patch', 'post', 'put', 'register_error_handler', 'route', 'teardown_request', 'url_defaults', 'url_value_preprocessor']
Blueprint: ['add_app_template_filter', 'add_app_template_global', 'add_app_template_test', 'add_url_rule', 'after_app_request', 'app_context_processor', 'app_errorhandler', 'app_template_filter', 'app_template_global', 'app_template_test', 'app_url_defaults', 'app_url_value_preprocessor', 'before_app_request', 'record', 'record_once', 'register_blueprint', 'teardown_app_request']
App: ['add_template_filter', 'add_template_global', 'add_template_test', 'add_url_rule', 'register_blueprint', 'shell_context_processor', 'teardown_appcontext', 'template_filter', 'template_global', 'template_test']
```

*(Note: this refines the plan text — there are **17** decorated `Blueprint` methods, matching the 17 decorator line numbers, not 16.)*

---

## 4. The only writer: inside `Blueprint.register()` (line 320)

The flag flips to `True` in `register()`, **before** the deferred functions are executed (`src/flask/sansio/blueprints.py:302-335`):

```python
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

Ordering proof: a `@bp.record` callback observes the flag already `True` when it runs, since line 320 precedes the loop at 334–335:

```
4) deferred observed: [('deferred_sees_flag', True)] final: True
```

The flag is set only after the "name already registered" guard (lines 306–314) has passed, so a rejected registration never latches the blueprint.

`Blueprint.register` is itself **not** a `@setupmethod`, so it can be called again (e.g. under a new `name=`) even after the latch is set — only a *name collision* raises, and it raises `ValueError`, not `AssertionError`:

```
record: AssertionError -> The setup method 'record' can no longer be called ...
record_once: AssertionError -> The setup method 'record_once' can no longer be ca...
add_url_rule: AssertionError -> The setup method 'add_url_rule' can no longer be c...
register_blueprint: AssertionError -> The setup method 'register_blueprint' can no longe...
before_request: AssertionError -> The setup method 'before_request' can no longer be...
after_request: AssertionError -> The setup method 'after_request' can no longer be ...
re-register new name: OK
re-register same name: ValueError The name 'bp' is already registered for this blueprint. Use 'name=' to
```

And the canonical runtime example showing the latch flips and the exact message is raised:

```
before register: False
after register: True
instance __dict__ after: True
3) AssertionError: "The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
```

---

## 5. Why the flag exists: deferred setup semantics

Blueprint setup methods do not take effect immediately — they **enqueue deferred functions** that are only consumed at `register()` time. `record` and `record_once` (`src/flask/sansio/blueprints.py:223-244`):

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

The deferred-function type alias (`src/flask/sansio/blueprints.py:17`):

```python
DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]
```

A setup method such as `add_url_rule` illustrates the pattern — it doesn't add a rule directly, it records a lambda (`src/flask/sansio/blueprints.py:412-441`):

```python
    @setupmethod
    def add_url_rule(
        self, rule, endpoint=None, view_func=None,
        provide_automatic_options=None, **options,
    ) -> None:
        ...
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

Because registration drains `self.deferred_functions` onto an app, adding more setup afterward would never be applied to that already-registered app — it would take effect only on a *future* registration, yielding inconsistent results. The flag is the guard that turns this silent inconsistency into a loud `AssertionError`. The docs state the same concept (`docs/blueprints.rst`):

```rst
The basic concept of blueprints is that they record operations to execute
when registered on an application.  Flask associates view functions with
blueprints when dispatching requests and generating URLs from one endpoint
to another.
```

```rst
When you bind a function with the help of the ``@simple_page.route``
decorator, the blueprint will record the intention of registering the
function ``show`` on the application when it's later registered.
```

and explicitly warn about multiple registrations:

```rst
On top of that you can register blueprints multiple times though not every
blueprint might respond properly to that.  In fact it depends on how the
blueprint is implemented if it can be mounted more than once.
```

### Companion state: `first_registration`

`_got_registered_once` is the coarse "ever registered at all" latch; `BlueprintSetupState.first_registration` is the finer "first-ever registration of this blueprint object" (vs. a later/renamed one), stored at `src/flask/sansio/blueprints.py:46, 62` and consulted by `record_once`'s wrapper at line 241:

```python
        #: as blueprints can be registered multiple times with the
        #: application and not everything wants to be registered
        #: multiple times on it, this attribute can be used to figure
        #: out if the blueprint was registered in the past already.
        self.first_registration = first_registration
```

```python
        def wrapper(state: BlueprintSetupState) -> None:
            if state.first_registration:
                func(state)
```

---

## 6. Strictly one-way: no reset path

A full-file scan shows exactly **one** assignment of `False` — the class default — and one assignment of `True` (inside `register()`):

```
5) source lines with flag:
    _got_registered_once = False
    if self._got_registered_once:
    self._got_registered_once = True
...
assignments to False: ['_got_registered_once = False']
```

There is no code path that resets it once set, which is why it is a strictly one-way latch. Nested blueprints also get latched: at the end of `register()` (lines 349–377) child blueprints are registered recursively via `blueprint.register(app, bp_options)`, which sets *their* flag too — confirmed at runtime:

```
child flag before: False
parent flag after: True
child flag after: True
GET /p/c -> b'c'
```

---

## 7. The app-side analogue: `_got_first_request` (and the asymmetry)

`App` uses a parallel mechanism, `_got_first_request`, with a matching error message (`src/flask/sansio/app.py:409-423`):

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

Runtime confirmation:

```
GET /: b'ok'
app._got_first_request after request: True
app.add_url_rule -> AssertionError: The setup method 'add_url_rule' can no longer be called on the application. It h ...
run() resets flag: True
```

The key **asymmetry**: `_got_first_request` *is* reset to `False` by `run()`'s `finally` block (`src/flask/app.py:661-667`) so a dev server can be restarted, whereas `_got_registered_once` has no reset path at all:

```python
        try:
            run_simple(t.cast(str, host), port, self, **options)
        finally:
            # reset the first request information if the development server
            # reset normally.  This makes it possible to restart the server
            # without reloader and that stuff from an interactive shell.
            self._got_first_request = False
```

The app invokes the blueprint's `register` via `Flask.register_blueprint` (`src/flask/sansio/app.py:569-595`), whose final line is `blueprint.register(self, options)` — the call that flips the blueprint's latch.

---

## 8. Test coverage and negative evidence

Only the **app-side** message is asserted by a test: `tests/test_basic.py:1678-1690`:

```python
def test_no_setup_after_first_request(app, client):
    app.debug = True

    @app.route("/")
    def index():
        return "Awesome"

    assert client.get("/").data == b"Awesome"

    with pytest.raises(AssertionError) as exc_info:
        app.add_url_rule("/foo", endpoint="late")

    assert "setup method 'add_url_rule'" in str(exc_info.value)
```

`grep_worktree "setup method"` returns only:

```
tests/test_basic.py:1690: assert "setup method 'add_url_rule'" in str(exc_info.value)
src/flask/sansio/app.py:416: f"The setup method '{f_name}' can no longer be called"
src/flask/sansio/blueprints.py:216: f"The setup method '{f_name}' can no longer be called on the blueprint"
```

No test asserts the blueprint-specific text; a repo-wide scan for `"on the blueprint"` in `tests/` found no hits, and `"already been registered at least once"` appears only in `src/flask/sansio/blueprints.py`. `CHANGES.rst`'s current section has no entry for the flag:

```rst
Version 3.2.0
-------------

Unreleased

-   Drop support for Python 3.9. :pr:`5730`
-   Remove previously deprecated code: ``__version__``. :pr:`5648`
```

Re-registration after the latch is still permitted, because `Blueprint.register` is not a `@setupmethod`. `tests/test_blueprints.py:994-1008` (`test_unique_blueprint_names`) and `tests/test_blueprints.py:1017-1045` (`test_blueprint_renaming`) demonstrate this, and all three referenced tests pass:

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

```
...                                                                      [100%]
3 passed in 0.10s
returncode: 0
```

---

## Final numbered report

1. **What the flag is.** A class-level boolean attribute on `Blueprint` — `_got_registered_once = False` (`src/flask/sansio/blueprints.py:172`) — that is not set per-instance, so every new blueprint starts unregistered.
2. **Where it becomes `True`.** Only inside `Blueprint.register()` at `src/flask/sansio/blueprints.py:320` (`self._got_registered_once = True`), set *after* the name-collision guard and *before* the deferred-function loop at lines 334–335 that consumes `self.deferred_functions`.
3. **Where it is read.** Only in `Blueprint._check_setup_finished` at `src/flask/sansio/blueprints.py:214` (`if self._got_registered_once:`), which raises the blueprint-specific `AssertionError`.
4. **How the check is triggered.** Every `@setupmethod` is wrapped by `setupmethod` (`src/flask/sansio/scaffold.py:42-49`), whose `wrapper_func` calls `self._check_setup_finished(f_name)` before delegating to the real method; the blueprint's override replaces the abstract `Scaffold._check_setup_finished` (`scaffold.py:220-221`, `raise NotImplementedError`).
5. **The purpose.** It is a fail-fast guard for Flask's *deferred setup* model: blueprint setup methods only enqueue deferred functions that are materialized onto an app at `register()` time. Once any app has consumed them, further `@setupmethod` mutation cannot be applied consistently, so the one-way latch forces an immediate `AssertionError` ("The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently…").
6. **Scope and companions.** The latch is strictly one-way (the sole `= False` is the class default; no reset path exists), it is set recursively for nested blueprints via `blueprint.register(...)`, and it coexists with the finer `BlueprintSetupState.first_registration` flag used by `record_once` to distinguish first-ever from later/renamed registrations.
7. **App analogue.** `App._check_setup_finished` (`src/flask/sansio/app.py:409-423`) uses the parallel `_got_first_request` with an equivalent message; unlike `_got_registered_once`, it is reset in `run()`'s `finally` (`src/flask/app.py:667`) — confirming `_got_registered_once` is deliberately the more permanent, one-way latch.
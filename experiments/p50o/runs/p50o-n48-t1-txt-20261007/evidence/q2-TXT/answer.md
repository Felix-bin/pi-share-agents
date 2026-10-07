# Purpose of `Blueprint._got_registered_once`

## Direct answer

**The flag exists to make registration a one-way, point-of-no-return for a blueprint, so that any later setup call fails loudly instead of silently producing an app that is missing handlers the blueprint advertises.**

A blueprint does not own an app. It *records* operations and exports them into an app at registration time. Since the same blueprint object can be registered on several apps and repeatedly under different names, a route/handler added *after* the first registration can only ever be exported into *later* registrations. The already-registered app would be permanently missing it — the same blueprint would behave differently on different apps (and across WSGI workers). `_got_registered_once` detects that situation and raises an explanatory `AssertionError` before the mutation is applied.

---

## 1. The flag itself: `Blueprint` in `src/flask/sansio/blueprints.py`

`Blueprint` is Flask's "blueprint collection class" — its own docstring says so (`src/flask/sansio/blueprints.py:119–136`):

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

**Declaration** — a class-level default of `False` (`src/flask/sansio/blueprints.py:167–172`, end of the class docstring, confirmed by direct read):

```python
    .. versionadded:: 0.7
    """

    _got_registered_once = False
```

Grep for `_got_registered_once` across the whole worktree returns only three lines — `src/flask/sansio/blueprints.py:172`, `:214`, `:320`:

```
$ grep -rn "_got_registered_once" --include=*.py .
./src/flask/sansio/blueprints.py:172:    _got_registered_once = False
./src/flask/sansio/blueprints.py:214:        if self._got_registered_once:
./src/flask/sansio/blueprints.py:320:        self._got_registered_once = True
```

So there is no other blueprint-grouping class and no reset path for it anywhere.

## 2. The writer: `Blueprint.register` flips it at the moment of export

`src/flask/sansio/blueprints.py:317–334` (verified by direct read):

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

This is the crux: the flag is set in the same block that (a) merges the blueprint's handler tables into the app via `_merge_blueprint_funcs` and (b) replays `deferred_functions` into a `BlueprintSetupState` for that registration. `Blueprint.register` and `_merge_blueprint_funcs` are deliberately **not** decorated with `@setupmethod` — the flag is written by the method that must always be allowed to run.

`_merge_blueprint_funcs` — the "snapshot export" (`src/flask/sansio/blueprints.py:379–410`):

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

Note the asymmetry that makes late additions invisible to earlier registrations: the merge is guarded by `if first_bp_registration or first_name_registration:`, but the `deferred_functions` replay at `:334` runs on *every* `register` call.

The buffering model the flag protects (`src/flask/sansio/blueprints.py:204` and `:223–244`):

```python
        self.deferred_functions: list[DeferredSetupFunction] = []
```

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

## 3. The reader: `_check_setup_finished`, the error text, and the gate

`src/flask/sansio/blueprints.py:213–221` (verified by direct read):

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

The message states the purpose in one clause: *"any changes will not be applied consistently"*, followed by the ordering rule it enforces.

That hook is invoked before **every** setup method does its work, by the `@setupmethod` decorator in `src/flask/sansio/scaffold.py:42–48`:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

The base hook has no silent fallback — `src/flask/sansio/scaffold.py:219–221`:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

Methods behind this gate on `Blueprint` include `record`, `record_once`, `register_blueprint` (nested-blueprint registration, `blueprints.py:255–271`), `add_url_rule`, the `app_template_*`/`add_app_template_*` pairs, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults`, plus everything inherited from `Scaffold` (`route`, `get/post/put/delete/patch`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`, `add_url_rule`). So it is not just decorators — nested registration is gated too.

## 4. Empirical proof of purpose (observed output, reproduced verbatim)

Environment guard — the venv's editable install points at a different checkout, so `PYTHONPATH=src` was required and `flask.__file__` asserted:

```
$ cat .venv/Lib/site-packages/flask.pth
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\f2f45b5b\q1-TXT\seal\src
```
```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "import flask, sys; print('flask from:', flask.__file__); print('sys.path[0:3]:', sys.path[0:3])"
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q2-TXT\seal\src\flask\__init__.py
sys.path[0:3]: ['', 'C:\\Users\\oobbee\\AppData\\Local\\Temp\\pi-p50o\\9f4f8f70\\q2-TXT\\seal\\src', 'C:\\Users\\oobbee\\AppData\\Roaming\\uv\\python\\cpython-3.13.9-windows-x86_64-none\\python313.zip']
EXIT:0
```

Working-tree integrity: `git status --porcelain` showed only `?? flask_mut2_i417ar2x/`, and `git diff -- src/flask/sansio/blueprints.py src/flask/sansio/scaffold.py` produced no output — the quoted lines are the live source.

**Flag lifecycle and error text** (script A, exit 0):

```
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q2-TXT\seal\src\flask\__init__.py
before register: False
on class: False
after register: True
instance dict has flag: True
AssertionError: The setup method 'add_url_rule' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
AssertionError: The setup method 'before_request' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
AssertionError: The setup method 'register_blueprint' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
view_functions: ['bp.index', 'static']
```

The flag is `False` on the class before any registration and becomes an instance attribute `True` after `app.register_blueprint(bp)`; `add_url_rule`, `before_request` and nested `register_blueprint` all raise the identical blueprint-worded error, and the late additions never reach `app.view_functions`.

**The inconsistency the flag forbids** (script B, with the guard disabled in memory only via `flask.Blueprint._check_setup_finished = lambda self, f_name: None`, exit 0):

```
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q2-TXT\seal\src\flask\__init__.py
first_registration for A: True
deferred count: 2
late on A: False | late on B: True
url_map on A: Map([<Rule '/static/<filename>' (OPTIONS, HEAD, GET) -> static>,
 <Rule '/' (OPTIONS, HEAD, GET) -> bp.index>])
url_map on B: Map([<Rule '/static/<filename>' (OPTIONS, HEAD, GET) -> static>,
 <Rule '/' (OPTIONS, HEAD, GET) -> bp2.index>,
 <Rule '/late' (OPTIONS, HEAD, GET) -> bp2.late>])
```

A route added *after* app A registered the blueprint appears only on app B: `late on A: False | late on B: True`. That is exactly the "changes will not be applied consistently" case the flag converts into an immediate error. (The monkeypatch was process-local; no source file was touched.) With no `view_func` supplied to `add_url_rule`, the probe reads `False` on both apps because no view function is recorded — the url-map output still shows `/late` present on B and absent on A, so the inconsistency is visible either way.

Sanity check and full suite, all with `PYTHONPATH=src`:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_blueprints.py tests/test_basic.py::test_no_setup_after_first_request -q
61 passed in 0.70s
EXIT:0
```
```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/ -q
489 passed in 5.59s
EXIT:0
```

## 5. Why the guard is needed rather than merely convenient: documented model

`docs/blueprints.rst:35–54`:

```
A blueprint in Flask is not a pluggable app because it is not actually an
application -- it's a set of operations which can be registered on an
application, even multiple times.  Why not have multiple application
objects?  You can do that (see :doc:`/patterns/appdispatch`), but your
applications will have separate configs and will be managed at the WSGI
layer.

Blueprints instead provide separation at the Flask level, share
application config, and can change an application object as necessary with
being registered. The downside is that you cannot unregister a blueprint
once an application was created without having to destroy the whole
application object.

The Concept of Blueprints
-------------------------

The basic concept of blueprints is that they record operations to execute
when registered on an application.  Flask associates view functions with
blueprints when dispatching requests and generating URLs from one endpoint
to another.
```

Multiple registration is intended, not exceptional (`docs/blueprints.rst:19–33` — "*Register a blueprint multiple times on an application with different URL rules*"; `:119–136` — "*you can register blueprints multiple times though not every blueprint might respond properly to that*"). Because the record/replay model is a snapshot export performed per registration, a post-registration modification is inherently partial. `docs/blueprints.rst:76–78` states the same model: "*the blueprint will record the intention of registering the function ``show`` on the application when it's later registered.*"

Flask documents the general rationale for blocking late setup in `docs/lifecycle.rst:32–51`, including the consistency-across-workers argument and the app-worded analogue of this error:

```
All application setup must be completed before you start serving your application and
handling requests. This is because WSGI servers divide work between multiple workers, or
can be distributed across multiple machines. If the configuration changed in one worker,
there's no way for Flask to ensure consistency between other workers.

Flask tries to help developers catch some of these setup ordering issues by showing an
error if setup-related methods are called after requests are handled. In that case
you'll see this error:

    The setup method 'route' can no longer be called on the application. It has already
    handled its first request, any changes will not be applied consistently.
    Make sure all imports, decorators, functions, etc. needed to set up the application
    are done before running it.

However, it is not possible for Flask to detect all cases of out-of-order setup. In
general, don't do anything to modify the ``Flask`` app object and ``Blueprint`` objects
from within view functions that run during requests. This includes:
```

## 6. Provenance and relevant distinctions

- It began as a **warning** in 2.2.0 — `CHANGES.rst:297–300`:
  ```
  -   Use Blueprint decorators and functions intended for setup after
      registering the blueprint will show a warning. In the next version,
      this will become an error just like the application setup methods.
      :issue:`4571`
  ```
- It became the current **`AssertionError`** in 2.3.0 — `CHANGES.rst:158–161`:
  ```
      -   Calling setup methods on blueprints after registration is an error instead of a
          warning. :pr:`4997`
  ```
- **Not the same as `Flask._got_first_request`** (the app-side counterpart): that flag is keyed on *first request*, not registration (`src/flask/sansio/app.py:411` `self._got_first_request = False`; `:414` `if self._got_first_request:`; set at `src/flask/app.py:911`; reset at `src/flask/app.py:667`). Grep confirms `_got_first_request` is the only other such flag in the tree, and there is **no reset of `_got_registered_once`** — once any registration happens it stays `True` for the life of that blueprint object, which is correct because registration is the irreversible export point.
- **Not the same as `BlueprintSetupState.first_registration`** (`src/flask/sansio/blueprints.py:55–62`), which is a per-registration value consulted only to decide whether `record_once` callbacks run:
  ```python
          #: as blueprints can be registered multiple times with the
          #: application and not everything wants to be registered
          #: multiple times on it, this attribute can be used to figure
          #: out if the blueprint was registered in the past already.
          self.first_registration = first_registration
  ```
- **Test coverage:** `grep -rn "registered at least once\|_got_registered_once\|first_registration\|deferred_functions\|BlueprintSetupState" tests/` returns no output, so no test asserts the blueprint message. The nearest tests are app-level only, `tests/test_basic.py:1678–1690`:
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

One unrelated runtime-discovery note, reported and not fixed: verbose pytest runs displayed test-origin paths from another checkout because of stale bytecode in `tests/__pycache__/`; re-running with a forced-fresh bytecode cache (`PYTHONPYCACHEPREFIX=/tmp/pycache_fresh PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/ -q`) gave the same `489 passed`, so the cached metadata masks nothing.
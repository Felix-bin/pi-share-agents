# What the registration-tracking flag on Flask's blueprint collection class is for

## 0. Scope and provenance of every claim below

All line numbers, quotes and probe results refer to the checkout at
`D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src`, git **detached HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`** (`git log -1` → `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642 Thu Jun 12 13:48:07 2025 -0700 Merge branch 'stable'`), `pyproject.toml` → `name = "Flask"` / `version = "3.2.0.dev"`, interpreter `.venv/Scripts/python.exe` = CPython 3.13.9, and an editable install that resolves to that same tree:

```
$ .venv/Scripts/python.exe -c "import flask, sys; print('flask.__file__ =', flask.__file__); ..."
flask file: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
flask.__version__ = <none>
sys.executable = D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
```

so the probes exercised the exact bytes quoted here. The tree is clean and the file is *not* a mutated copy — the hashes are identical before and after all runs:

```
$ git rev-parse HEAD; git status --short; git rev-parse --abbrev-ref HEAD
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
?? flask_mut2_i417ar2x/
HEAD
$ sha256sum src/flask/sansio/blueprints.py src/flask/sansio/scaffold.py src/flask/sansio/app.py
4ea7beec4919fad6d67219bc883a027c3f38f1fd3fde72efe8d3637883ef1f03 *src/flask/sansio/blueprints.py
c120125d8745456266a9c2f45eaf93ecdf8f0d55128851af8cef643d9839f1b9 *src/flask/sansio/scaffold.py
76d9cc13d30d2053a8c036eee7167f069a566cbe6b945d2d058cad9b7c703dc7 *src/flask/sansio/app.py
```

(the only untracked entry is the unrelated mutation sandbox `flask_mut2_i417ar2x/`; nothing in `src/` or `tests/` was edited by any stage — no file was written inside the checkout at any point).

**Line-number corrections used throughout** (the initial plan's anchor map was off; the executed `grep -n` verification below is authoritative):

```
$ grep -n "^class Blueprint(Scaffold)\|^    _got_registered_once\|    def _check_setup_finished\|    def record(\|    def record_once(\|    def make_setup_state(\|    def register_blueprint(\|^    def register(\|    def _merge_blueprint_funcs(" src/flask/sansio/blueprints.py
119:class Blueprint(Scaffold):
172:    _got_registered_once = False
213:    def _check_setup_finished(self, f_name: str) -> None:
224:    def record(self, func: DeferredSetupFunction) -> None:
233:    def record_once(self, func: DeferredSetupFunction) -> None:
246:    def make_setup_state(
256:    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
273:    def register(self, app: App, options: dict[str, t.Any]) -> None:
379:    def _merge_blueprint_funcs(self, app: App, name: str) -> None:
$ grep -n "_got_first_request\|    def _check_setup_finished" src/flask/sansio/app.py
411:        self._got_first_request = False
413:    def _check_setup_finished(self, f_name: str) -> None:
414:        if self._got_first_request:
```

---

## 1. Identification (one sentence)

The "blueprint collection class" is **`Blueprint`** in `src/flask/sansio/blueprints.py` — `class Blueprint(Scaffold):` at **line 119**, whose docstring at **line 120** reads *"Represents a blueprint, a collection of routes and other app-related functions that can be registered on a real application later."* — and the registration-tracking flag is the class attribute **`_got_registered_once`**, defaulted to `False` at **line 172**.

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
    .. versionadded:: 0.7
    """

    _got_registered_once = False
```

Verified boundary lines (read at offset 164): `.. versionadded:: 0.7` = 169, closing `"""` = 170, blank = 171, `_got_registered_once = False` = **172**.

The identification is unique — a search for `collection|Collection` across `src/flask` returns only that docstring plus unrelated stdlib imports (`import collections.abc as cabc`, `from collections import defaultdict`, `views.py:51: methods: t.ClassVar[t.Collection[str] | None] = None`), none of which is a class:

```
sansio/blueprints.py-119- class Blueprint(Scaffold):
sansio/blueprints.py:120:     """Represents a blueprint, a collection of routes and other
sansio/blueprints.py-121-     app-related functions that can be registered on a real application
sansio/blueprints.py-122-     later.
```

Neither of the two adjacent candidates is a "collection" object: `BlueprintSetupState` (line 34) is documented as a *"Temporary holder object for registering a blueprint with the application"*, and `self._blueprints` (line 211) is a plain list of `(Blueprint, options)` tuples queued for replay:

```python
    @setupmethod                                                          # :255
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:   # :256
        """Register a :class:`~flask.Blueprint` on this blueprint. ...
        """
        if blueprint is self:
            raise ValueError("Cannot register a blueprint on itself")      # :270
        self._blueprints.append((blueprint, options))                      # :271
```

---

## 2. Purpose — the direct answer

`_got_registered_once` is a **one-way latch recording "this blueprint has already been materialised into at least one application"**. Every `@setupmethod`-decorated API consults it through `Blueprint._check_setup_finished` (line 213) and raises `AssertionError` if it is set:

```python
    def _check_setup_finished(self, f_name: str) -> None:                  # :213
        if self._got_registered_once:                                      # :214
            raise AssertionError(                                          # :215
                f"The setup method '{f_name}' can no longer be called on the blueprint"   # :216
                f" '{self.name}'. It has already been registered at least once, any"      # :217
                " changes will not be applied consistently.\n"                             # :218
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```

**Why it exists.** A blueprint is by design *deferred*: decorating a function only appends a closure to `self.deferred_functions`, and nothing is applied to an application until `register()` replays those closures and merges the blueprint's shared state into the parent app. Concretely, `register()` sets the latch at :320 and then, in order, builds the setup state, merges blueprint functions, and replays the deferred functions:

```python
        name_prefix = options.get("name_prefix", "")
        self_name = options.get("name", self.name)
        name = f"{name_prefix}.{self_name}".lstrip(".")
        ...
        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
        first_name_registration = name not in app.blueprints

        app.blueprints[name] = self                                        # :319
        self._got_registered_once = True                                   # :320
        state = self.make_setup_state(app, options, first_bp_registration) # :321
        ...
        # Merge blueprint data into parent.                                # :330
        if first_bp_registration or first_name_registration:               # :331
            self._merge_blueprint_funcs(app, name)                         # :332

        for deferred in self.deferred_functions:                           # :334
            deferred(state)
```

and `_merge_blueprint_funcs` (def at :379) is a **one-shot copy** of blueprint state into one app:

```python
    def _merge_blueprint_funcs(self, app: App, name: str) -> None:         # :379
        def extend(
            bp_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
            parent_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
        ) -> None:
            for key, values in bp_dict.items():
                key = name if key is None else f"{name}.{key}"
                parent_dict[key].extend(values)

        for key, value in self.error_handler_spec.items():
            ...
            app.error_handler_spec[key] = value

        for endpoint, func in self.view_functions.items():
            app.view_functions[endpoint] = func

        extend(self.before_request_funcs, app.before_request_funcs)
        extend(self.after_request_funcs, app.after_request_funcs)
        extend(self.teardown_request_funcs, app.teardown_request_funcs)
        extend(self.url_default_functions, app.url_default_functions)
        extend(self.url_value_preprocessors, app.url_value_preprocessors)
        extend(self.template_context_processors, app.template_context_processors)
```

Once that replay/merge has happened for at least one app, anything added afterwards is applied **inconsistently** — it cannot reach the applications the blueprint was already registered with, and may reach later ones only partially — so the flag turns a silent divergence into an explicit failure. That is exactly the wording of the error itself: *"It has already been registered at least once, any changes will not be applied consistently. / Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."* — and it is demonstrated empirically in §5 (Probe C3: the same late route is absent from the first app and present in the second).

**Same philosophy as the application-side guard.** `Flask`/`App` has the identical construction keyed off `_got_first_request`:

```python
        self._got_first_request = False                                    # app.py :411

    def _check_setup_finished(self, f_name: str) -> None:                  # app.py :413
        if self._got_first_request:                                        # :414
            raise AssertionError(                                          # :415
                f"The setup method '{f_name}' can no longer be called"      # :416
                " on the application. It has already handled its first"
                " request, any changes will not be applied"
                " consistently.\n"
                "Make sure all imports, decorators, functions, etc."
                " needed to set up the application are done before"
                " running it."
            )
```

The rationale — WSGI workers can't be kept consistent after the fact — is documented in `docs/lifecycle.rst:36-51`:

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

-   Adding routes, view functions, and other request handlers with ``@app.route``,
    ``@app.errorhandler``, ``@app.before_request``, etc.
-   Registering blueprints.
-   Loading configuration with ``app.config``.
...
```

**History.** This used to be a *warning*, then became an error (PR 4997). `CHANGES.rst:160-161` under `Version 3.0.0`:

```
    -   Calling setup methods on blueprints after registration is an error instead of a
        warning. :pr:`4997`
```

and the earlier deprecation origin, `CHANGES.rst:298-301` under `Version 2.3.0`:

```
-   Use Blueprint decorators and functions intended for setup after
    registering the blueprint will show a warning. In the next version,
    this will become an error just like the application setup methods.
    :issue:`4571`
```

(There is nothing about this guard in 3.1/3.2: `CHANGES.rst:1-8` lists only `Drop support for Python 3.9. :pr:`5730`` and `Remove previously deprecated code: __version__. :pr:`5648``.)

---

## 3. Mechanism chain, with citations

1. **Enforcement point — `@setupmethod`**, `src/flask/sansio/scaffold.py:42-50`:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

2. **The policy hook is deliberately abstract** so that `Flask` and `Blueprint` can define different "setup is over" events — `src/flask/sansio/scaffold.py:220-221`:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

Repo-wide, `_check_setup_finished` is defined/used in exactly three places: `scaffold.py:220` (base), `blueprints.py:213` (the `Blueprint` policy), `sansio/app.py:413` (the `App` policy). `Flask` (`class Flask(App)` at `src/flask/app.py:81`, importing `from .sansio.app import App` at :44) does not override it.

3. **Blueprint policy** → `if self._got_registered_once:` (blueprints.py:214) → `raise AssertionError` (:215-220), quoted in §2.

4. **Latch is thrown inside `register()` at :320**, immediately *after* `app.blueprints[name] = self` (:319) and *before* `make_setup_state()` (:321), the `_merge_blueprint_funcs` merge (:332) and the deferred-function replay (:334-335). It is a class attribute defaulting to `False` (:172) and is set as an **instance** attribute at registration (confirmed by Probe A: `before register: bp._got_registered_once = False | in instance dict: False` → `after register: ... True | in instance dict: True`). It is **not** initialised in `__init__`.

5. **Surface guarded**: 17 `@setupmethod` decorators inside `sansio/blueprints.py` — lines 223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624 (`record`, `record_once`, `register_blueprint`, `add_url_rule`, `app_template_filter`, `add_app_template_filter`, `app_template_test`, `add_app_template_test`, `app_template_global`, `add_app_template_global`, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults`), plus 16 inherited from `sansio/scaffold.py` (295, 303, 311, 319, 327, 335 route, 367, 435, 459, 486, 507, 541, 558, 583, 597, 641). `make_setup_state` (:246) and `register` (:273) are **deliberately not** decorated (they run *during* registration).

---

## 4. Disambiguation (the question's phrasing invites conflation)

**(a) The flag does NOT prevent re-registration.** A blueprint can still be registered on a second app, or again on the same app under a different `name`. Probe B (verbatim):

```
1) latch after first registration: True
   re-register same bp, same name:
    ValueError -> The name 'bp' is already registered for this blueprint. Use 'name=' to provide a unique name.
   re-register same bp, different name on SAME app:
   OK, app.blueprints = ['bp', 'again'] | latch still: True
   re-register same bp on a SECOND app:
   OK, app2.blueprints = ['bp'] | latch: True
   second app handles a request:
   GET /ping -> 200 b'pong'
```

The only failure there is an **unrelated duplicate-*name* `ValueError`** raised at `blueprints.py:310-314`, before the latch is touched:

```python
        if name in app.blueprints:                                         # :306
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(                                              # :310
                f"The name '{self_name}' is already registered for"        # :311
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )
```

The regression test `tests/test_blueprints.py:994 test_unique_blueprint_names` asserts exactly this (re-registration under a new name is OK):

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

and `docs/blueprints.rst:119-121` says so in prose:

```
119: On top of that you can register blueprints multiple times though not every
120: blueprint might respond properly to that.  In fact it depends on how the
121: blueprint is implemented if it can be mounted more than once.
```

Mechanically, this works because `Flask.register_blueprint` *is* `@setupmethod` (guarded by the app-side `_got_first_request`, `sansio/app.py:569-570`) while `Blueprint.register` is **not** `@setupmethod` (`app.py` body: `blueprint.register(self, options)`), so a later registration never consults the blueprint latch. Probe D confirms `bp.register(app3, {}) -> OK (Blueprint.register is NOT @setupmethod)`.

**(b) It is distinct from `BlueprintSetupState.first_registration`** (param at `:46`, attribute assignment at `:62`). That one is *"first registration on this particular application"* (computed at `:316` as `not any(bp is self for bp in app.blueprints.values())`), and it is what `record_once` keys off:

```python
    @setupmethod                                                          # :232
    def record_once(self, func: DeferredSetupFunction) -> None:           # :233
        """Works like :meth:`record` but wraps the function in another
        function that will ensure the function is only called once.  If the
        blueprint is registered a second time on the application, the
        function passed is not called.
        """

        def wrapper(state: BlueprintSetupState) -> None:
            if state.first_registration:                                  # :241
                func(state)

        self.record(update_wrapper(wrapper, func))
```

The plan initially predicted `first_registration == False` on a second *app*; the executed Probe C **refuted** that — `first_registration` is **per-application**, `True` again for every new app, so `record_once` fires once *per app* (2 apps → 2 invocations) and is suppressed only for a repeat registration *on the same app*:

```
after app1 registration: bp._got_registered_once = True
after app2 registration: bp._got_registered_once = True
recorded callback invocations (kind, app.name, state.first_registration):
    ('record', 'app1', True)
    ('record_once', 'app1', True)
    ('record', 'app2', True)
    ('record_once', 'app2', True)
=> record_once ran for: ['app1', 'app2'] (first app only)
=> record      ran for: ['app1', 'app2'] (every app)
=> while the latch _got_registered_once stayed True throughout: True
```

So the latch is **per-blueprint and one-way**, whereas `first_registration` is **per-app and re-armed for each app**. They must not be explained as the same thing.

**(c) It does not freeze the blueprint object.** Only `@setupmethod`-decorated calls are intercepted; direct attribute/dict mutation is not. Probe D, "NOT @setupmethod-decorated surface AFTER latch":

```
make_setup_state        -> OK, returned BlueprintSetupState | first_registration = False
bp.name = ...           -> OK, bp.name = renamed
bp.url_prefix = ...     -> OK, bp.url_prefix = /p
deferred_functions.append -> OK, len = 1
_blueprints.append      -> OK, len = 1
bp.register(app3, {})   -> OK (Blueprint.register is NOT @setupmethod)
```

**(d) It is also distinct from the app-side `_got_first_request` latch** (`app.py:411`), which is tripped by a *handled request*, not by registration. Probe (app-side contrast):

```
GET / -> 200
app._got_first_request = True
app.add_url_rule after first request -> AssertionError: The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently. | Make sure all imports, decorators, functions, etc. needed to set up the application are done before running it.
app.register_blueprint after first request -> AssertionError: The setup method 'register_blueprint' can no longer be called on the application. ...
```

Two different "setup is over" events, exactly as `scaffold.py:220-221` intends.

---

## 5. Empirical confirmation

**Probe A — the guard fires after registration:**

```
before register: bp._got_registered_once = False | in instance dict: False
after  register: bp._got_registered_once = True | in instance dict: True
app.blueprints = ['bp']
RESULT: AssertionError raised
str(exc) = "The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
   contains "setup method 'route'" -> True
   contains "'bp'" -> True
   contains 'already been registered at least once' -> True
   contains 'changes will not be applied consistently' -> True
   contains 'before registering it' -> True
```

**Probe D — all 27 decorated entry points raise, each with its own name:**

```
route                        -> AssertionError: The setup method 'route' can no longer be called on the blueprint 'bp'. ...
add_url_rule                 -> AssertionError ... endpoint
before_request / after_request / teardown_request / context_processor / url_value_preprocessor / url_defaults
errorhandler / register_error_handler / record / record_once / register_blueprint
app_template_filter / add_app_template_filter / app_template_test / add_app_template_test
app_template_global / add_app_template_global
before_app_request / after_app_request / teardown_app_request / app_context_processor
app_errorhandler / app_url_value_preprocessor / app_url_defaults
```

**Probe C3 — the "inconsistent application" rationale, demonstrated** (the same late mutation reaches the not-yet-registered app but not the already-registered one):

```
latch after app1 register: True
raw bp.deferred_functions.append(...) and bp.name=/bp.url_prefix= were NOT blocked (no exception)
app1 GET /orig -> 200
app1 GET /late -> 404 (404 => change never reached the already-registered app)
app1 rules: ['/orig', '/static/<path:filename>']
app2.blueprints (bp renamed post-registration): ['renamed']
app2 GET /prefixed/late -> 200 b'late'
app2 rules: ['/prefixed/late', '/prefixed/orig', '/static/<path:filename>']
```

All four probes executed successfully with exit 0; no claim of runtime behaviour here needs a "not executed" caveat. Post-run state proves read-only behaviour: `git status --short` → `?? flask_mut2_i417ar2x/`, HEAD unchanged, the three source hashes byte-identical to the pre-run values, and `.pytest_cache/` untouched (`all still dated Oct 3 19:18 — not deleted, not rewritten`).

---

## 6. Test-coverage note (verified, not asked but material to the guard's status)

`_got_registered_once` has **no dedicated test in this checkout**:

```
$ grep -rn "_got_registered_once" --include="*.py" --include="*.rst" --exclude-dir=.venv .
./src/flask/sansio/blueprints.py:172:    _got_registered_once = False
./src/flask/sansio/blueprints.py:214:        if self._got_registered_once:
./src/flask/sansio/blueprints.py:320:        self._got_registered_once = True
$ grep -rn "_got_registered_once" tests/
exit=1                      <-- ZERO hits under tests/
$ grep -rn "_check_setup_finished\|first_registration\|deferred_functions" tests/
exit=1                      <-- ZERO hits under tests/
```

The only late-setup test is the *application*-side analogue, `tests/test_basic.py:1678` (`def test_no_setup_after_first_request(app, client):` — note :1678, not :1677):

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

`tests/test_blueprints.py` has **47** top-level `def test_` functions (60 collected with parametrisation), none of which exercises the guard — `test_nested_blueprint` (:793), `test_blueprint_renaming` (:1017) and `test_unique_blueprint_names` (:994) only call *app-side* setup methods after a registration, never a blueprint setup method. Suites run green: `60 passed in 0.41s` (`tests/test_blueprints.py`), `1 passed` (the app-side test), `489 passed in 2.16s` (full `tests/`), and two equivalent-mutant plugins (read site `if self._got_registered_once:` neutralised / write site `self._got_registered_once = True` dropped, applied from `-p` plugins written *outside* the checkout) each still yield `489 passed in 2.18s` / `489 passed in 2.13s`, with a sanity check confirming the read-site patch genuinely disables the guard (`late bp.route() succeeded -> guard neutralised (plugin works)`). This is reported to the supervising session separately; no tests were added and no source file was edited.

---

## 7. One-line summary

`_got_registered_once` is a one-way per-blueprint latch (class default `False` at `blueprints.py:172`, set at `:320` the moment `register()` starts copying blueprint state into an application and before the deferred-function replay at `:334`) that makes every `@setupmethod` API fail fast with `AssertionError` via `Blueprint._check_setup_finished` (`:213-220`) once a blueprint has been materialised into at least one app, because any later setup change would be applied inconsistently — `"It has already been registered at least once, any changes will not be applied consistently."` It does **not** block re-registration (that is governed by the separate duplicate-name `ValueError` at `:310-314` and by `Blueprint.register` not being a `@setupmethod`), it is **not** the same as the per-app `BlueprintSetupState.first_registration` (`:46`/`:62`, used by `record_once`), and it does not freeze direct attribute/dict mutation — only the decorated API surface.
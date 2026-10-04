# The registration-tracking flag: `Blueprint._got_registered_once`

## Direct answer

The flag `Blueprint._got_registered_once` exists to make out-of-order blueprint setup **fail loudly instead of silently diverging**. A `Blueprint` is not an application; it is a recorded *recipe*. Everything a blueprint declares — routes, error handlers, before/after-request callbacks, template hooks, nested blueprints — is queued into lists at decoration time and replayed into a concrete app only when the blueprint is registered. If setup were still allowed *after* a registration, those new declarations would never reach the app that was already registered, yet they *would* reach any app that registered the same blueprint later — an inconsistency Flask documents as "changes will not be applied consistently". The flag is the boolean that records "this blueprint has been registered at least once, ever", and `@setupmethod` consults it via `_check_setup_finished` before the body of **every** setup method runs, raising `AssertionError` at the offending decorator call.

It is an **ordering guard, not an immutability guarantee**: it is scoped to the blueprint instance (not the app, not the class), it never resets, and direct mutation of the underlying dicts still bypasses it.

---

## 1. Name, location, lifetime

The whole-repo grep for the flag returns exactly three hits (`B2`, `B3`), all in `src/flask/sansio/blueprints.py`:

```
src/flask/sansio/blueprints.py:172:    _got_registered_once = False
src/flask/sansio/blueprints.py:214:        if self._got_registered_once:
src/flask/sansio/blueprints.py:320:        self._got_registered_once = True
```

**Declaration** — a class-body default on `Blueprint`, whose own docstring calls it "a collection of routes and other app-related functions" (this is the "blueprint collection class" of the question; there is no separate collection class in the tree — only `Blueprint` and `BlueprintSetupState`). Authoritative line-numbered window (`B4`):

```
119: class Blueprint(Scaffold):
120:     """Represents a blueprint, a collection of routes and other
121:     app-related functions that can be registered on a real application
122:     later.
...
170:     """
171: 
172:     _got_registered_once = False
173: 
174:     def __init__(
```

**Sole writer** — inside `Blueprint.register`, at `:320` (`B4`, `B6`):

```
316:         first_bp_registration = not any(bp is self for bp in app.blueprints.values())
317:         first_name_registration = name not in app.blueprints
318: 
319:         app.blueprints[name] = self
320:         self._got_registered_once = True
321:         state = self.make_setup_state(app, options, first_bp_registration)
```

Because `register` assigns through `self`, the **class** attribute stays `False` forever while each instance gets its own boolean. The runtime probe confirms this literally (`B10`):

```
False True
```

i.e. `Blueprint._got_registered_once = False | bp._got_registered_once = True` — and a fresh, never-registered instance is still `False` (`B11`: `[A2] fresh instance bpB (never registered) ._got_registered_once = False`; `[A0]/[A1]` show the class value on both sides of the flip as `False`).

There is **no reset writer anywhere** in the repository: a whole-repo grep for `_got_registered_once` yields the three sites above, whereas the app-level analogue `_got_first_request` has a reset (`src/flask/app.py:667`, inside `run()`'s `finally`) in addition to its setter (`src/flask/app.py:911`) and declaration (`src/flask/sansio/app.py:411`) — see `B8`:

```
$ grep -rn "_got_first_request" src/ --include=*.py
src/flask/app.py:667:            self._got_first_request = False
src/flask/app.py:911:        self._got_first_request = True
src/flask/sansio/app.py:411:        self._got_first_request = False
src/flask/sansio/app.py:414:        if self._got_first_request:
```

`Flask.register_blueprint` is the caller of `register` (`src/flask/sansio/app.py:595`, `B8`):

```
569:     @setupmethod
570:     def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
...
595:         blueprint.register(self, options)
```

`flask.app.Flask` inherits this from the sansio `App` (no override: `grep -n "register_blueprint" src/flask/app.py` exits 1, `B9`). The public `flask.blueprints.Blueprint` is a subclass of the sansio one and never redefines the flag or the check (`B9`):

```
10: from .sansio.blueprints import Blueprint as SansioBlueprint
11: from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
...
18: class Blueprint(SansioBlueprint):
```
```
$ grep -n "_got_registered_once\|_check_setup_finished" src/flask/blueprints.py src/flask/app.py
EXIT:1      ← no hits: the public subclass never redefines either
```

(Note the header correction: the `class Blueprint` statement is at `src/flask/blueprints.py:18`, not `:14`; `:1-12` is the import head. `src/flask/__init__.py:3` exposes it as `from .blueprints import Blueprint as Blueprint`.) `flask.__version__` does not exist in this dev tree; the version comes from `pyproject.toml:3` → `version = "3.2.0.dev"`, and the checkout is detached at `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`B1`, `B19`).

## 2. How the flag is enforced on every setup method

The reader is `Blueprint._check_setup_finished`, itself deliberately **not** decorated (`B4`):

```
213:     def _check_setup_finished(self, f_name: str) -> None:
214:         if self._got_registered_once:
215:             raise AssertionError(
216:                 f"The setup method '{f_name}' can no longer be called on the blueprint"
217:                 f" '{self.name}'. It has already been registered at least once, any"
218:                 " changes will not be applied consistently.\n"
219:                 "Make sure all imports, decorators, functions, etc. needed to set up"
220:                 " the blueprint are done before registering it."
221:             )
```

The routing mechanism is the module-level `setupmethod` in `src/flask/sansio/scaffold.py:42-49` (`B7`):

```
42: def setupmethod(f: F) -> F:
43:     f_name = f.__name__
44: 
45:     def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
46:         self._check_setup_finished(f_name)
47:         return f(self, *args, **kwargs)
48: 
49:     return t.cast(F, update_wrapper(wrapper_func, f))
```

The shared base declares the contract abstractly (`src/flask/sansio/scaffold.py:220-221`, `B7`):

```
220:     def _check_setup_finished(self, f_name: str) -> None:
221:         raise NotImplementedError
```

and the complete hit set for `_check_setup_finished` across the repo is four sites — the call, the base, and the two overrides (`B3`, `B7`): `scaffold.py:46` (call), `scaffold.py:220` (base `NotImplementedError`), `app.py:413` (Flask override), `blueprints.py:213` (Blueprint override).

Because the wrapper calls the check **before** `return f(...)`, the guard fires on the decoration call itself. The observed behaviour (`B10`, plan's literal snippet run under `.venv/Scripts/python.exe`):

```
$ cd <repo> && .venv/Scripts/python.exe "D:/tmp/plan_snippet.py" 2>&1
EXIT:0
False True
RAISED: The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
RAISED(nesting): The setup method 'register_blueprint' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
```

with the captured traceback showing the exact call chain (`B11`):

```
Traceback (most recent call last):
  File "D:\tmp\bp_flag_probe.py", line 25, in <module>
    @bpA.route("/late")
     ~~~~~~~~~^^^^^^^^^
  File "D:\...\flask-src\src\flask\sansio\scaffold.py", line 46, in wrapper_func
    self._check_setup_finished(f_name)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^
  File "D:\...\flask-src\src\flask\sansio\blueprints.py", line 215, in _check_setup_finished
    raise AssertionError(
    ...<5 lines>...
    )
AssertionError: The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
```

The negative control passed — setup **before** registration is unaffected (`B11`): `[E] NO ERROR before registration (control OK) | bpN._got_registered_once = False`.

**Coverage is effectively complete.** `Blueprint`'s own `@setupmethod`-decorated surface (`B6`) is `record` (decorator `:223`/`def :224`), `record_once` (`:232`/`:233`), `register_blueprint` (`:255`/`:256`), `add_url_rule` (`:412`/`:413`), `app_template_filter` (`:443`), `add_app_template_filter` (`:460`), `app_template_test` (`:477`), `add_app_template_test` (`:496`), `app_template_global` (`:515`), `add_app_template_global` (`:534`), `before_app_request` (`:553`), `after_app_request` (`:563`), `teardown_app_request` (`:573`), `app_context_processor` (`:583`), `app_errorhandler` (`:595`), `app_url_value_preprocessor` (`:612`), `app_url_defaults` (`:624`) — plus the inherited `Scaffold` setters (`scaffold.py:295` `get`, `:303` `post`, `:311` `put`, `:319` `delete`, `:327` `patch`, `:335` `route`, `:435` `endpoint`, `:459` `before_request`, `:486` `after_request`, `:507` `teardown_request`, `:541` `context_processor`, `:558` `url_value_preprocessor`, `:583` `url_defaults`, `:597` `errorhandler`, `:641` `register_error_handler`), which funnel through `Blueprint`'s concrete `add_url_rule` → `self.record(lambda …)`. A runtime enumeration of the 37 public callables on `Blueprint` found **32 raise the guard message**; the 5 that do not are `get_send_file_max_age`, `make_setup_state`, `open_resource`, `register`, `send_static_file` (`B12`):

```
BLOCKED after registration (32):
    add_app_template_filter -> The setup method 'add_app_template_filter' can no longer be 
    add_app_template_global -> ...
    add_app_template_test -> ...
    add_url_rule -> The setup method 'add_url_rule' can no longer be called on t
    after_app_request -> ...
    after_request -> ...
    app_context_processor -> ...
    app_errorhandler -> ...
    app_template_filter -> ...
    app_template_global -> ...
    app_template_test -> ...
    app_url_defaults -> ...
    app_url_value_preprocessor -> ...
    before_app_request -> ...
    before_request -> ...
    context_processor -> ...
    delete -> ...
    endpoint -> ...
    errorhandler -> ...
    get -> ...
    patch -> ...
    post -> ...
    put -> ...
    record -> ...
    record_once -> ...
    register_blueprint -> ...
    register_error_handler -> ...
    route -> The setup method 'route' can no longer be called on the blue
    teardown_app_request -> ...
    teardown_request -> ...
    url_defaults -> ...
    url_value_preprocessor -> ...

NOT blocked (5):
    get_send_file_max_age -> TypeError: Blueprint.get_send_file_max_age() missing 1 required positional argument: 'file
    make_setup_state -> TypeError: Blueprint.make_setup_state() missing 1 required positional argument: 'options'
    open_resource -> TypeError: Blueprint.open_resource() missing 1 required positional argument: 'resource'
    register -> TypeError: Blueprint.register() missing 1 required positional argument: 'options'
    send_static_file -> TypeError: Blueprint.send_static_file() missing 1 required positional argument: 'filename'

deferred_functions count after attempted late setup: 0
bp._blueprints count: 0
'_check_setup_finished' not itself decorated: True
'register' decorated by setupmethod: False
'_merge_blueprint_funcs' decorated: False
'make_setup_state' decorated: False
'route' decorated: True
```

Two details matter: (i) the two setup-related undecorated methods are `register` and `make_setup_state` (plus `_merge_blueprint_funcs`), which is exactly what keeps **re-registration legal**; (ii) a blocked call leaves **nothing enqueued** (`deferred_functions count … = 0`, `bp._blueprints count: 0`), so user code cannot even add a deferred callback after registration. Note `record` / `record_once` are themselves guarded, so the queue is closed off at its last open entrance.

## 3. Why the flag exists: deferred replay, and why "at least once" is the right cut-off

`Blueprint.__init__` takes no app reference and applies nothing; it only initialises containers (`B4`, `B5`):

```
204:         self.deferred_functions: list[DeferredSetupFunction] = []
...
210:         self.cli_group = cli_group
211:         self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
```

`record`/`record_once` are the append-only queue (`B5`):

```
223:     @setupmethod
224:     def record(self, func: DeferredSetupFunction) -> None:
225:         """Registers a function that is called when the blueprint is
226:         registered on the application. ...
229:         """
230:         self.deferred_functions.append(func)
231: 
232:     @setupmethod
233:     def record_once(self, func: DeferredSetupFunction) -> None:
234:         """Works like :meth:`record` but wraps the function in another
235:         function that will ensure the function is only called once.  If the
236:         blueprint is registered a second time on the application, the
237:         function passed is not called.
238:         """
239: 
240:         def wrapper(state: BlueprintSetupState) -> None:
241:             if state.first_registration:
242:                 func(state)
243: 
244:         self.record(update_wrapper(wrapper, func))
```

and only `Blueprint.register` replays them (`B6`):

```
273:     def register(self, app: App, options: dict[str, t.Any]) -> None:
274:         """Called by :meth:`Flask.register_blueprint` to register all
275:         views and callbacks registered on the blueprint with the
276:         application. Creates a :class:`.BlueprintSetupState` and calls
277:         each :meth:`record` callback with it.
...
330:         # Merge blueprint data into parent.
331:         if first_bp_registration or first_name_registration:
332:             self._merge_blueprint_funcs(app, name)
333: 
334:         for deferred in self.deferred_functions:
335:             deferred(state)
...
349:         for blueprint, bp_options in self._blueprints:
...
376:             bp_options["name_prefix"] = name
377:             blueprint.register(app, bp_options)
```

Therefore any setup done after a registration would be **silently lost** for the already-registered app while still affecting a later registrant — the exact divergence the message describes ("any changes will not be applied consistently"). Blueprints are explicitly intended to be re-registered, which makes that divergence a realistic hazard rather than a theoretical one (`docs/blueprints.rst`, quoted at `B17`):

```
10: Blueprints can greatly simplify how large applications work and provide a
11: central means for Flask extensions to register operations on applications.
12: A :class:`Blueprint` object works similarly to a :class:`Flask`
13: application object, but it is not actually an application.  Rather it is a
14: *blueprint* of how to construct or extend an application.
...
27: * Register a blueprint multiple times on an application with different URL
28:   rules.
...
44: being registered. The downside is that you cannot unregister a blueprint
45: once an application was created without having to destroy the whole
46: application object.
...
119: On top of that you can register blueprints multiple times though not every
120: blueprint might respond properly to that.  In fact it depends on how the
121: blueprint is implemented if it can be mounted more than once.
```

The flag converts that silent divergence into an immediate, loud `AssertionError` at the point of the offending decorator call — which is why it flips at first registration and never back.

**Ordering detail.** The flag is written at `:320` *before* the replay loop at `:334-335`, before the merge at `:331-332`, and before the nested `blueprint.register(app, bp_options)` at `:377` (`B6`). Consequences: re-entrant setup attempted from inside a deferred callback is rejected, and nested-blueprint wiring (`Blueprint.register_blueprint`, itself `@setupmethod`) must be done **before** the parent is registered. The runtime check confirms nesting is blocked post-registration (`B10`: `RAISED(nesting): The setup method 'register_blueprint' can no longer be called on the blueprint 'bp'. …`).

## 4. What it is *not* — three easily confused notions kept apart

**(a) Not the per-app "first registration" notion.** `BlueprintSetupState.first_registration` (`src/flask/sansio/blueprints.py:41-62`, `B5`) is per-app and per-dotted-name, computed in `register` as `first_bp_registration` (`:316`), and it is the thing that drives `record_once` (`:241`, the only consumer):

```
58:         #: as blueprints can be registered multiple times with the
59:         #: application and not everything wants to be registered
60:         #: multiple times on it, this attribute can be used to figure
61:         #: out if the blueprint was registered in the past already.
62:         self.first_registration = first_registration
```

`_got_registered_once` is instance-wide ("at least once", ever, on **any** app) and never true-then-false. Runtime proof that the flag is blueprint-scoped and not app-scoped (`B11`):

```
[F1] two-app re-registration OK; record_once fired for apps: ['one', 'two']
[F2] bpR._got_registered_once = True
[F3] same-app re-registration (name='again') OK; record_once calls: ['one', 'two']
```

i.e. after the flag is already `True`, registering the same blueprint on a second app still works and `record_once` still fires (because `first_registration` for that app is `True`). The library's own tests exercise repeat registration (`tests/test_blueprints.py:142-143`, `B14`):

```
142:     app.register_blueprint(bp, url_prefix="/1", url_defaults={"bar": 23})
143:     app.register_blueprint(bp, name="test2", url_prefix="/2", url_defaults={"bar": 19})
```

and `test_blueprint_renaming` registers `bp` twice *after* the first registration with both mounts working.

**(b) Not `Flask._got_first_request`.** The app-level analogue is a different attribute with a different trigger (first *request*, not first registration), `src/flask/sansio/app.py:409-423` (`B8`):

```
409:         # tracks internally if the application already handled at least one
410:         # request.
411:         self._got_first_request = False
412: 
413:     def _check_setup_finished(self, f_name: str) -> None:
414:         if self._got_first_request:
415:             raise AssertionError(
416:                 f"The setup method '{f_name}' can no longer be called"
417:                 " on the application. It has already handled its first"
418:                 " request, any changes will not be applied"
419:                 " consistently.\n"
...
```

The run captured both messages side by side (`B11`):

```
[G1] app response: b'Awesome'
[G2] RAISED (app setup method): "The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the application are done before running it."
```

Notably, the app flag **is** reset (in `run()`'s `finally`, `src/flask/app.py:663-667`: *"reset the first request information if the development server reset normally. This makes it possible to restart the server without reloader…"*), while the blueprint flag has no reset — consistent with "registered at least once" being a permanent historical fact about the object.

The documented rationale for both, `docs/lifecycle.rst:36-56` (`B16`):

```
36: All application setup must be completed before you start serving your application and
37: handling requests. This is because WSGI servers divide work between multiple workers, or
38: can be distributed across multiple machines. If the configuration changed in one worker,
39: there's no way for Flask to ensure consistency between other workers.
40: 
41: Flask tries to help developers catch some of these setup ordering issues by showing an
42: error if setup-related methods are called after requests are handled. In that case
43: you'll see this error:
44: 
45:     The setup method 'route' can no longer be called on the application. It has already
46:     handled its first request, any changes will not be applied consistently.
...
50: However, it is not possible for Flask to detect all cases of out-of-order setup. In
51: general, don't do anything to modify the ``Flask`` app object and ``Blueprint`` objects
52: from within view functions that run during requests. This includes:
53: 
54: -   Adding routes, view functions, and other request handlers with ``@app.route``,
55:     ``@app.errorhandler``, ``@app.before_request``, etc.
56: -   Registering blueprints.
```

**(c) Not an immutability/freeze guarantee.** Direct mutation slips past it. The runtime probe demonstrates this (`B11`):

```
[F4] direct dict mutation bypasses the flag: bpR.view_functions now has ['late_direct']
```

The underlying containers are plain dicts/lists, e.g. `scaffold.py:102-108` (`B7`): `self.view_functions: dict[str, ft.RouteCallable] = {}` with the docstring *"This data structure is internal. It should not be modified directly and its format may change at any time."* So the correct statement is: the flag is an **ordering guard at the decorator/method boundary**, not a general immutability guarantee.

## 5. Version history and evidence status

The behaviour is version-specific — 2.2 warned, 2.3 made it an error. `CHANGES.rst` (line numbers verified by `grep -n "^Version "`, `B15`; **correction** to the plan: the error entry is at `:160-161` inside `Version 2.3.0`, header at `135`):

```
135: Version 2.3.0
...
160:     -   Calling setup methods on blueprints after registration is an error instead of a
161:         warning. :pr:`4997`
```

and the earlier warning, at `:297-300` inside `Version 2.2.0` (header at `237`):

```
297: -   Use Blueprint decorators and functions intended for setup after
298:     registering the blueprint will show a warning. In the next version,
299:     this will become an error just like the application setup methods.
300:     :issue:`4571`
```

So the checked-out tree's `AssertionError` at `:215-220` is the 2.3+ behaviour (this tree is `3.2.0.dev`). **Do not present the reconstructed-vs-observed caveat**: unlike the static-only evidence role, a shell was available here, so the raised string is a captured runtime traceback, not a reconstruction.

**Evidence hygiene (negative findings, both confirmed).** The blueprint-specific message appears **nowhere in `docs/`** and is asserted by **no test** (`B14`):

```
$ grep -rn "can no longer be called\|registered at least once\|_got_registered_once\|_check_setup_finished\|record_once" tests/
EXIT:1      ← NO MATCHES AT ALL in tests/
```
```
$ grep -rn "registered at least once\|no longer be called\|setupmethod" docs/
EXIT:0
docs/lifecycle.rst:45:    The setup method 'route' can no longer be called on the application. It has already
```

The only guard test in the suite is the **app-level** one, `tests/test_basic.py:1678-1690` (`B14`):

```
1678: def test_no_setup_after_first_request(app, client):
1679:     app.debug = True
1680: 
1681:     @app.route("/")
1682:     def index():
1683:         return "Awesome"
1684: 
1685:     assert client.get("/").data == b"Awesome"
1686: 
1687:     with pytest.raises(AssertionError) as exc_info:
1688:         app.add_url_rule("/foo", endpoint="late")
1689: 
1690:     assert "setup method 'add_url_rule'" in str(exc_info.value)
```

That test must not be cited as evidence for the blueprint flag. The admissible evidence for the blueprint behaviour is the source (`blueprints.py:172/213-220/320`, `scaffold.py:42-49/220-221`), the `CHANGES.rst` entries, and the observed runtime transcript. Also: `Blueprint.register` docstring version notes confirm the surrounding semantics — *".. versionchanged:: 2.3 Nested blueprints now correctly apply subdomains."*, *".. versionchanged:: 2.1 Registering the same blueprint with the same name multiple times is an error."* (`B6`).

The full test suite passes on this checkout, so the guard is not masking a regression (`B13`): `489 passed in 2.29s` (collected 489 items, 0 failed), reproduced three times, plus a 224-test subset under `-W error::DeprecationWarning` (`224 passed in 1.03s`). Working tree stayed clean after all runs (`git status --porcelain` → 0 lines, `--untracked-files=all` → 0 lines; `B18`).

---

## Summary of anchors

| Fact | Anchor | Quote/finding |
|---|---|---|
| Flag declared, class default | `src/flask/sansio/blueprints.py:172` | `_got_registered_once = False` |
| Flag read (the guard) | `src/flask/sansio/blueprints.py:214` | `if self._got_registered_once:` |
| Flag written (once, never reset) | `src/flask/sansio/blueprints.py:320` | `self._got_registered_once = True` |
| Error text | `src/flask/sansio/blueprints.py:215-220` | "…can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently.…" |
| Wrapper routing each setup method through the guard | `src/flask/sansio/scaffold.py:42-49` | `self._check_setup_finished(f_name)` then `return f(...)` |
| Base contract (overridden by Blueprint) | `src/flask/sansio/scaffold.py:220-221` | `raise NotImplementedError` |
| Sole caller of `register` | `src/flask/sansio/app.py:595` | `blueprint.register(self, options)` |
| Public subclass (flag inherited) | `src/flask/blueprints.py:18` | `class Blueprint(SansioBlueprint):` |
| Confusable twin (per-app) | `src/flask/sansio/blueprints.py:41-62`, consumed at `:241` | `self.first_registration = first_registration`; `if state.first_registration:` |
| App analogue (per-app, has reset) | `src/flask/sansio/app.py:409-423`; reset `src/flask/app.py:667` | `self._got_first_request` |
| 2.3 error / 2.2 warning | `CHANGES.rst:160-161`, `:297-300` | "error instead of a warning. :pr:`4997`" / ":issue:`4571`" |
| Re-registrable docs | `docs/blueprints.rst:12-14, 27-28, 44-46, 119-121` | "not actually an application"; "Register a blueprint multiple times…" |
| Rationale docs | `docs/lifecycle.rst:36-56` | "no way for Flask to ensure consistency between other workers" |

**One-line answer:** `Blueprint._got_registered_once` (default `False` at `sansio/blueprints.py:172`, set `True` once at `:320` inside `Blueprint.register`, never reset) is the blueprint-instance-scoped latch that `setupmethod`'s wrapper (`sansio/scaffold.py:42-49`) checks before every setup method through `Blueprint._check_setup_finished` (`:213-220`) — so that any route/handler/nesting declaration attempted after the blueprint has already been registered *anywhere* raises `AssertionError: The setup method '<name>' can no longer be called on the blueprint '<bp>'. It has already been registered at least once, any changes will not be applied consistently.` instead of being silently missing from the app it was registered on. It is an ordering guard, not a freeze: `register` itself is undecorated (re-registration works, including into a second app where `record_once` fires again), and direct dict mutation still bypasses it.
## Answer

**The flag is `Blueprint._got_registered_once` in `src/flask/sansio/blueprints.py` (class `Blueprint`, line 119; flag declared at line 172, guard at 213‑221).** Its purpose is a **fail‑fast, per‑blueprint‑object guard that enforces "one setup phase per `Blueprint` instance"**: once the blueprint has been handed to an app via `register()`, any further call to a *setup* method (route/template/request‑handler registration, `record`, `register_blueprint`, …) is an error, because `register()` consumes the accumulated `deferred_functions` exactly once, at a fixed point — so a late setup call cannot be applied to the app the blueprint was already committed to, and would silently take effect only on a *later*, different registration. The library's own wording of the failure is exactly that: *"It has already been registered at least once, any changes will not be applied consistently."*

### Mechanism the flag guards (all verified in this checkout)

| Fact | Site |
|---|---|
| Flag declared as a **class attribute**, default `False` | `sansio/blueprints.py:172` (between the class docstring and `__init__`) |
| Set to `True` **inside `register()`**, as an instance attribute | `sansio/blueprints.py:320`, immediately after `app.blueprints[name] = self` (319) and after the duplicate‑name `ValueError` (306), before `make_setup_state` (321) |
| Guard body: `AssertionError` naming the method and the blueprint | `sansio/blueprints.py:213‑221` |
| Guard is invoked by every `@setupmethod`‑decorated method before the method body runs | `sansio/scaffold.py:42‑49` (`wrapper_func` → `self._check_setup_finished(f_name)`) |
| Base implementation is abstract; `Blueprint` and `App` each override it | `sansio/scaffold.py:220‑221` (`raise NotImplementedError`) |
| The single consumer of the deferred callbacks | `sansio/blueprints.py:334‑335` (`for deferred in self.deferred_functions: deferred(state)`); `deferred_functions` created at `204`, appended to by `record()` at `230` |
| Only three references to the flag exist in the whole checkout | grep: `blueprints.py:172, 214, 320` (my own grep confirms; nothing resets it) |

The late‑call inertness is **not inferred**: the executed run appended a callback to `bp.deferred_functions` after app1's and app2's register passes had run — it never fired for either app, then fired only on app3's registration (`late@a3`). That is the mechanical reason the guard exists, and it matches the "applied consistently" wording per app.

### Bounding "setup methods" and what the flag is *not*

- Guarded on a `Blueprint` instance: its own `@setupmethod` methods — `record`(224), `record_once`(233), `register_blueprint`(256), `add_url_rule`(413), the app‑template filter/test/global families (444‑535), `before_app_request`/`after_app_request`/`teardown_app_request` (554‑574), `app_context_processor`(584), `app_errorhandler`(596), `app_url_value_preprocessor`(613), `app_url_defaults`(625) — **plus the inherited `Scaffold` decorated methods** (`get/post/put/delete/patch/route`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`) that resolve to the blueprint's override of the check.
- It does **not** block re‑registration: `register()` (273) carries no `@setupmethod`. Verified at runtime — registering the *same* blueprint object on a second app succeeds and replays `deferred_functions`; that is also why `record_once()` gates on `state.first_registration` (233‑244). This matches `sansio/app.py:371‑377`, whose docstring states the app's `blueprints` dict "does not track how often they were attached".
- It is **registration‑triggered, not request‑triggered** — deliberately the counterpart of the app‑side flag `App._got_first_request` (`sansio/app.py:411`, comment 409‑410, guard 413‑419). The two messages are parallel but distinct (`…on the blueprint '{name}' … registered at least once … before registering it` vs `…on the application … handled its first request … before running it`).
- `BlueprintSetupState.add_url_rule` (`blueprints.py:87`) is deliberately **undecorated**, because setup callbacks run *during* `register()` after the flag is already `True` — the check has to live in the decorator, not in the callback path.

### Runtime result (executed, not inferred)

`experiments/data/flask-src` `.venv` (Python 3.13.9, editable install), script on stdin: `flag before register: False` → `flag after register: True`; `bp.add_url_rule("/late", …)` raised, exit status **1**, traceback `scaffold.py:46 wrapper_func → blueprints.py:215 _check_setup_finished → AssertionError: The setup method 'add_url_rule' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently. / Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.` (full text recovered from shared memory entry `4305b360…`, `sourcePath: src/flask/sansio/blueprints.py`).

### Verification status — important caveat

In **this checkout the blueprint guard's raise path is exercised by zero tests**: my grep over the whole tree for `_got_registered_once` / `_check_setup_finished` matches only `src/flask/sansio/` (never `tests/`), and the instrumented pytest run reported 489 passed with `Blueprint._check_setup_finished` raising `AssertionError` 0 times. The only guard test present is the app‑side analogue (`tests/test_basic.py` `test_no_setup_after_first_request`). So the flag's purpose rests on source + a direct runtime repro, not on the project's own test suite.

### Other plausible matches for "the blueprint collection class" (covered, so none is silently dropped)

1. **`flask/blueprints.py:18 class Blueprint(SansioBlueprint)`** — the public non‑sansio class. It is a thin subclass (adds `cli`, `send_static_file`, `open_resource`, …) and **does not override the flag or the check**, so the behaviour above is inherited unchanged. This is the class users import as `flask.Blueprint`.
2. **`Flask`/`App` and its `app.blueprints` mapping** (`sansio/app.py:377`) — the app is the object that *holds* the blueprint collection, but its "no setup after…" flag is the **request‑based** `_got_first_request` (411), not a registration flag; the blueprints dict itself is documented as not tracking registration counts.
3. **`BlueprintSetupState`** (`sansio/blueprints.py:34`) — the per‑registration state object; it has **no** such flag and its mutating methods are intentionally undecorated (see above).

### Version/history caveat

All of the above is the checked‑out tree, `pyproject.toml:3` = **3.2.0.dev**, with the `sansio/` layout and `_got_registered_once` + `_check_setup_finished`. My grep shows this checkout contains **no** `_is_setup_finished` symbol, so any statement about a newer/renamed API is out of scope here. Within this tree's own `CHANGES.rst`, the *error* behaviour is recorded as a 2.3.0 change ("Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`", `CHANGES.rst:160‑161`), preceded by the 2.2.0 warning ("…will show a warning. In the next version, this will become an error…", `CHANGES.rst:297‑300`, issue 4571) — i.e. the flag's escalation history is documented, but the above is not a cross‑version behaviour test. Note also that `docs/lifecycle.rst:45` documents only the **app‑side** error text, not the blueprint‑side one.

### Rests on / still open

**Rests on:** source verbatim at `sansio/blueprints.py:172, 204, 213‑221, 230, 233‑244, 273, 306, 319‑321, 334‑335, 87`; `sansio/scaffold.py:42‑49, 220‑221`; `sansio/app.py:371‑377, 409‑419`; greps for the flag/check symbol names (3 hits, all in `src/flask`); the executed repro (exit 1, AssertionError traceback) and the exit‑0 ordering run (flag flip, second‑app re‑registration OK, late appended callback inert for apps 1‑2 and live on app 3); instrumented suite run (489 passed, 0 guard hits); `CHANGES.rst:160‑161, 297‑300`; `docs/lifecycle.rst:45`.

**Still open:** (a) any Flask version other than this 3.2.0.dev tree — no `_is_setup_finished` exists here and no other version was tested/compared; (b) the flag's full upstream history beyond the changelog entries quoted; (c) *supported*‑API evidence that a late `record()` is silently inert — the inertness was shown only by appending directly to `deferred_functions` (bypassing the decorator), since every supported path raises instead.
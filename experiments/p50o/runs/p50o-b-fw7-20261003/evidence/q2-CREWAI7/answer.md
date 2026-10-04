# `Blueprint._got_registered_once` — the after-registration setup guard

*(Answer to the original task: what this registration-tracking flag is, what it does, and how "setup methods can no longer be called after the blueprint has been registered once" is enforced. All code below is quoted verbatim from the shared worktree; each claim carries its verification status.)*

## 1. What the flag is

`Blueprint` declares a single class attribute, `_got_registered_once = False`, at **`src/flask/sansio/blueprints.py:172`** — the first statement in the class body after the docstring:

```python
172:     _got_registered_once = False
```

**Established by source read (this session):** the name occurs exactly **three** times in the entire worktree — the declaration at 172, one read at 214, one assignment at 320:

```
src/flask/sansio/blueprints.py:172: _got_registered_once = False
src/flask/sansio/blueprints.py:214: if self._got_registered_once:
src/flask/sansio/blueprints.py:320: self._got_registered_once = True
```

It is never initialised in `__init__` (read of `blueprints.py:174-211` in this session shows `name`, `url_prefix`, `subdomain`, `deferred_functions`, `url_values_defaults`, `cli_group`, `_blueprints` — no `_got_registered_once`), so before first registration every instance reads the class default `False`.

## 2. What it does — the failure it prevents

The flag's sole purpose is a **fail-fast guard**: once a blueprint has been handed to an app, further "setup" calls on it are rejected, because the work those calls represent has already been consumed.

The diagnosis is stated in the guard's own message: *"It has already been registered at least once, any changes will not be applied consistently."* The concrete reason is the timing in `Blueprint.register` (§4): by the time `register` returns, the blueprint's deferred functions have already been replayed and its functions merged into the parent. A setup call made afterwards would land in `self.deferred_functions` (or on the blueprint's own rules) with nothing left to replay or merge it, so it would either do nothing or apply to only some of the places the blueprint was registered — i.e. "not applied consistently."

**Status: mechanism-level claim, source-grounded.** The stated *effect* ("changes will not be applied consistently") is the library's own wording at `blueprints.py:218`, not an independently measured behaviour (§8).

## 3. The mechanism — `@setupmethod` → `_check_setup_finished` → `AssertionError`

Enforcement is a decorator. **`src/flask/sansio/scaffold.py:42-49`** (verbatim, re-read this session):

```python
42: def setupmethod(f: F) -> F:
43:     f_name = f.__name__
44: 
45:     def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
46:         self._check_setup_finished(f_name)
47:         return f(self, *args, **kwargs)
48: 
49:     return t.cast(F, update_wrapper(wrapper_func, f))
```

The guard runs **before** the wrapped body and passes the wrapped function's `__name__` as `f_name`, so the error names the offending method. `scaffold.py:46` is the only call site of `_check_setup_finished` in the worktree (`grep _check_setup_finished` → `app.py:413`, `blueprints.py:213`, `scaffold.py:46`, `scaffold.py:220`).

`Blueprint` supplies the blueprint-specific body at **`src/flask/sansio/blueprints.py:213-221`**:

```python
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

The base it overrides (`src/flask/sansio/scaffold.py:220-221`) is `def _check_setup_finished(self, f_name: str) -> None:` / `raise NotImplementedError` — i.e. `Scaffold` itself defines no policy; each concrete class does. `Flask` has a parallel override at `src/flask/sansio/app.py:413-420` keyed on `self._got_first_request` (`app.py:411`), which is a **different flag** and is not touched by blueprint registration.

**Note on exception type (established):** the guard raises `AssertionError`, not a `RuntimeError`/`BlueprintSetupError`. Consequence worth flagging: under `python -O`, bare `assert` statements are stripped but an explicitly raised `AssertionError` is **not** — this is not an `assert` statement, so the guard stays active under optimisation. (Source fact; no runtime test of `-O` was run.)

## 4. Timing — set before the registration work it protects

The assignment lives in `Blueprint.register` (`def register(self, app: App, options)` at **`blueprints.py:273`**), at **`blueprints.py:320`**:

```python
316:         first_bp_registration = not any(bp is self for bp in app.blueprints.values())
317:         first_name_registration = name not in app.blueprints
318: 
319:         app.blueprints[name] = self
320:         self._got_registered_once = True
321:         state = self.make_setup_state(app, options, first_bp_registration)
...
330:         # Merge blueprint data into parent.
331:         if first_bp_registration or first_name_registration:
332:             self._merge_blueprint_funcs(app, name)
333: 
334:         for deferred in self.deferred_functions:
335:             deferred(state)
```

So `True` is written **before** the setup state is created (321), before `_merge_blueprint_funcs` copies the blueprint's views/hooks into the app (332), and before the deferred functions recorded via `record`/`record_once` are replayed (335). That ordering is what makes the guard sound: anything a mutator would add after line 320 has no replay step left.

Also established: `register` itself is **not** `@setupmethod`-decorated (decorator census, §5), which it must not be — it is the registration path, and it has to run on an unguarded blueprint. Likewise `make_setup_state` (`blueprints.py:246`) is unguarded.

## 5. Boundary — exactly which operations are blocked

`Blueprint` carries `@setupmethod` on **17** methods (decorator lines in `src/flask/sansio/blueprints.py`):

| decorator line | method |
|---|---|
| 223 | `record` |
| 232 | `record_once` |
| 255 | `register_blueprint` |
| 412 | `add_url_rule` |
| 443 | `app_template_filter` |
| 460 | `add_app_template_filter` |
| 477 | `app_template_test` |
| 496 | `add_app_template_test` |
| 515 | `app_template_global` |
| 534 | `add_app_template_global` |
| 553 | `before_app_request` |
| 563 | `after_app_request` |
| 573 | `teardown_app_request` |
| 583 | `app_context_processor` |
| 595 | `app_errorhandler` |
| 612 | `app_url_value_preprocessor` |
| 624 | `app_url_defaults` |

`Blueprint` methods **without** the decorator: `__init__` (174), `make_setup_state` (246), `register` (273), `_merge_blueprint_funcs` (379).

Because the guard is invoked from the shared `setupmethod` wrapper, the **16 guarded methods inherited from `Scaffold`** are blocked on a registered blueprint too: `get` (295), `post` (303), `put` (311), `delete` (319), `patch` (327), `route` (335), `add_url_rule` (367), `endpoint` (435), `before_request` (459), `after_request` (486), `teardown_request` (507), `context_processor` (541), `url_value_preprocessor` (558), `url_defaults` (583), `errorhandler` (597), `register_error_handler` (641). (`Blueprint` overrides `add_url_rule` at 412; the other 15 are used as inherited.)

Practical consequence: after `app.register_blueprint(bp)`, calls such as `bp.add_url_rule(...)`, `bp.route(...)`, `bp.before_request(...)`, `bp.record(...)`, `bp.record_once(...)`, `bp.register_blueprint(...)` all raise the `AssertionError` from §3. The decorator census was obtained by an uncapped file read (`blueprints.py` 17, `scaffold.py` 16, `app.py` 10 `@setupmethod` sites); the earlier capped `grep` hit the tool's 30-match limit at `scaffold.py:311`, which the uncapped read closed — the last `@setupmethod` in `scaffold.py` is at 641.

## 6. Permanence — the flag is never reset

**Established by grep (this session):** the only `_got_registered_once = False` in the worktree is the class declaration at line 172. Line 320 is the only assignment and only ever writes `True`. There is no `del self._got_registered_once` and no other reset anywhere.

Therefore: after the first `register`, the *instance* attribute is `True` and stays `True` for the lifetime of that blueprint object. The guard is **permanent per instance** — it is not a "currently registering" re-entrancy flag, and re-registering the same blueprint on another app does **not** re-open setup (a second `register` on an already-registered blueprint still sets `True` at 320 and would itself raise only if it were guarded, which it is not — but any setup call from that point on is rejected).

## 7. The look-alike that must not be conflated: `BlueprintSetupState.first_registration`

`grep first_registration` gives `blueprints.py:46` (parameter), `:62` (assignment `self.first_registration = first_registration`), `:241` (read), `:247` (parameter default), `:253` (constructor call). This is a **per-registration boolean on the setup state**, documented at `blueprints.py:58-61` as existing because "blueprints can be registered multiple times with the application and not everything wants to be registered multiple times on it." It is consumed only by `record_once`'s wrapper:

```python
240:         def wrapper(state: BlueprintSetupState) -> None:
241:             if state.first_registration:
242:                 func(state)
```

It **raises nothing**. It governs *whether a once-only deferred function fires on this particular registration*; `_got_registered_once` governs *whether setup calls are allowed at all*. The related locals in `register` — `first_bp_registration` (316) and `first_name_registration` (317) — feed `make_setup_state` and the `_merge_blueprint_funcs` condition (331); they are not the guard flag either.

## 8. Verification status of the above

- **Source-verified in this session** (not merely relayed): the three occurrences of `_got_registered_once`; the declaration at 172 and the absence of any `__init__` initialisation; the guard body 213-221; the `setupmethod` wrapper 42-49 with its call at 46; the assignment at 320 and its position relative to 321/332/335; the absence of any reset.
- **Relayed from the executor report, consistent with my re-checks:** the full `@setupmethod` census (17/16/10), the `_check_setup_finished` call-site/definition map, and the `first_registration` grep results.
- **NOT observed at runtime.** No app or blueprint was instantiated and no `AssertionError` was actually raised in this run. The executor's attempt to import the worktree source failed with `ModuleNotFoundError: No module named 'werkzeug'` on the tool's interpreter, and the worktree `.venv` probe aborted on `flask.__version__` before printing `flask.__file__`, so it could not even be confirmed that the imported `flask` was the worktree copy. The error text quoted in §3 is the **literal source string**, not an observed message. The behavioural claim is therefore "the source unconditionally raises when the flag is set", which is as strong as a read can make it, but it is not a measured result.

## 9. What is answered vs. still open

**Answered:** the flag is `Blueprint._got_registered_once`; it is a class-level `False` default with exactly one read and one write; the write is `True` inside `Blueprint.register` at line 320, before `make_setup_state`/`_merge_blueprint_funcs`/deferred replay; enforcement is `@setupmethod` (`scaffold.py:42-49`) calling `Blueprint._check_setup_finished` (`blueprints.py:213-221`), which raises `AssertionError` naming the method and the blueprint; the blocked set is the 17 `Blueprint` mutators plus the 16 inherited `Scaffold` ones; the flag is never reset, so the block is permanent for that instance; `BlueprintSetupState.first_registration` is a distinct, non-raising concept.

**Open (not established by any evidence here):**
- Runtime confirmation of the `AssertionError` (import/environment failure; §8).
- Whether the class-attribute-only declaration with no reset and no `__init__` initialisation is intentional or a defect — a design judgement, not a worktree fact; no docstring or changelog entry naming `_got_registered_once` was found.
- Whether the exception type should be `AssertionError` rather than a dedicated error class — an API-design question, outside this task.
- Whether any `Blueprint` subclass that overrides `register` without calling `super().register(...)` escapes the guard — it would never set the flag, but no such subclass was inspected.
- Whether the task targets a different Flask release; the worktree consistently names this concept `_got_registered_once`, and an older/newer release could differ.

**Boundary note (recommended use, from the guard's own message at 219-220):** all imports, decorators and functions needed to set up a blueprint must be performed **before** registering it; work that is legitimately per-registration belongs in a function passed to `bp.record(...)` / `bp.record_once(...)` **before** registration, not in a later direct call on the blueprint.

---

**Rests on:** `src/flask/sansio/blueprints.py:172`, `:213-221`, `:246`, `:273`, `:319-321` (assignment at 320), `:331-335`, `:240-242`, `:62`; `src/flask/sansio/scaffold.py:42-49` (call at 46), `:220-221`, and the `@setupmethod` sites at 295-641; `src/flask/sansio/app.py:411`, `:413-420`; worktree-wide greps for `_got_registered_once`, `_got_registered_once = False`, `_check_setup_finished`, `first_registration`, `@setupmethod`.

**Open:** no runtime-observed `AssertionError` (worktree source unimportable: `werkzeug` missing; `.venv` probe inconclusive); intentional-vs-defect status of the permanent no-reset class attribute; behaviour of `Blueprint` subclasses bypassing `Blueprint.register`; correctness of the mapping to any non-worktree Flask version.
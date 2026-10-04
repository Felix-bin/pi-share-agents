## Answer: the purpose of `Blueprint._got_registered_once`

**In one sentence:** it is a sticky per-instance "this blueprint has already been published to an app" marker, whose purpose is to convert a *silent, per-app inconsistency* into an immediate hard error — because blueprint setup methods only append to a list that has already been consumed for the app that was registered first.

### What the flag is and where it lives (re-read, not carried over)
- `_got_registered_once = False` — class attribute of `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:172`, declared just before `__init__` at `:174`).
- `if self._got_registered_once:` — the only read, inside the Blueprint override of `_check_setup_finished` (`:214`; `def` at `:213`, raises `AssertionError` at `:215-221`).
- `self._got_registered_once = True` — the only write, inside `Blueprint.register` (`:320`), placed **after** `app.blueprints[name] = self` (`:319`) and **before** the deferred drain (`:334-335`).
- `grep` over the whole tree returns exactly these three `.py` hits (the rest are `__pycache__` binaries); there is **no reset**, so it is sticky for the lifetime of that instance. Because the write is per-instance, each newly constructed `Blueprint` still starts at `False`.

### Why the guard is needed — the mechanism it protects
1. Blueprint setup mutators are **append-only**: everything funnels through `self.record` → `self.deferred_functions.append(func)` (`:230`; the list is created at `:204`).
2. `Blueprint.register` **drains the entire list for each app** (`for deferred in self.deferred_functions: deferred(state)` at `:334-335`) and **never clears it**.
3. Therefore a setup call made *after* the blueprint was registered on app1 appends to a list that app1 has already consumed: the new route/callback can never appear in app1, but it *will* be replayed into every app2, app3… registered later. The same blueprint object then behaves differently in different applications — silently and with no error (the executed bypass demo showed exactly this: a function appended after app1's registration landed in app2's `url_map` but not app1's).
4. The flag's own error text states this rationale verbatim: *"It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*

Note the wording is "**at least once**", not "exactly once": registering a blueprint more than once is explicitly supported (`docs/blueprints.rst:119-121`, plus the `name=` override; only same-name re-registration is a `ValueError`). So the flag does not forbid re-registration — it forbids *setup after* the first registration.

### How the flag actually binds (it is only a boolean; the decorator enforces)
- `setupmethod` (`src/flask/sansio/scaffold.py:42-49`) wraps each setup method and calls `self._check_setup_finished(f_name)` (`:46`) before the method body.
- The base implementation is abstract (`scaffold.py:220-221`, `NotImplementedError`); Blueprint and app each supply their own check.
- In `blueprints.py` there are 17 `@setupmethod` mutators: lines `223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624`. `register` itself and `make_setup_state` are **not** gated, so the registration path stays callable.
- Executed confirmation (Python 3.13.9 from the tree's own `.venv`): after `app1.register_blueprint(bp)`, both `@bp.route('/b')` and `bp.record(...)` raise `AssertionError` naming `'route'`/`'record'`, and `deferred_functions` length stays unchanged (1) — the refused calls leave no partial state behind.

### Contrast with the app-side analogue (why this flag exists separately)
`Flask` has the same style of guard but a different flag and lifecycle: `_got_first_request` (`sansio/app.py:411`, guard `:413-421`, set `True` at `app.py:911`) fires once a request has been handled. Unlike `_got_registered_once`, the app flag **does** have a reset — `app.py:667`, to allow the dev server to restart from an interactive shell. The blueprint flag deliberately has no equivalent escape hatch, because "registered once" is a permanent fact about the object's history, not a transient server state.

### Intent history
This was a deliberate hardening, not an incidental check: `CHANGES.rst:297-300` (2.2.0) introduced it as a *warning* — "In the next version, this will become an error just like the application setup methods" — and `CHANGES.rst:160-161` (2.3.0) made it an error: "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`."

### What the task asks vs. what is settled
- **Answered:** the flag's identity, locations, semantics and purpose — a guard that detects "setup mutated after the blueprint was already published", whose reason for existing is the append-only/never-cleared deferred list that would otherwise apply the mutation to later apps only.
- **Established by execution, not just inference:** the runtime `AssertionError` on `route`/`record`, unchanged state after refusal, the app1-vs-app2 divergence in the bypass demo.
- **Open / not established:** (a) behaviour in Flask **<2.2**, where the warning-stage implementation may differ — only the changelog entries were read, not the old source; (b) no in-tree test covers the *blueprint-side* guard (`grep` of `tests/` for "no longer be called on the blueprint" / `_got_registered_once` / "registered at least once" → no matches); the only executed test was the app-side `tests/test_basic.py::test_no_setup_after_first_request`; (c) only this vendored tree (`experiments/data/flask-src`) was searched, so line numbers are not asserted for any other Flask install (within this tree there is no second copy — `.venv/Lib/site-packages/flask.pth` points back at `./src`).
- **Shared memory:** the executed evidence is already recorded as memory `304be392e788` (executor). My attempt to record the derived conclusion was refused — `not-authorised: summarizer may not write shared memory` — so this synthesis exists only as this answer; a write-capable role would need to persist it.

**Rests on:** `src/flask/sansio/blueprints.py` (`:172`, `:204`, `:213-221`, `:223-256`, `:319-320`, `:334-335`, 17 `@setupmethod` sites), `src/flask/sansio/scaffold.py:42-49` and `:220-221`, `src/flask/sansio/app.py:411/413-421/595`, `src/flask/app.py:667/911`, `docs/blueprints.rst:119-121`, `docs/lifecycle.rst:41-51`, `CHANGES.rst:160-161` and `:297-300`, plus the executor's executed run recorded in memory `304be392e788`.
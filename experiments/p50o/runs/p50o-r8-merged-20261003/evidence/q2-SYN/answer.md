## Answer

**The flag is `Blueprint._got_registered_once`, and its purpose is a freeze/latch: once a blueprint has been consumed by `register()`, its setup API is closed, so any later decorator or setup call fails loudly instead of being silently dropped or applied inconsistently.**

### What it is, mechanically

- Declared as a class-attribute default `False` at `src/flask/sansio/blueprints.py:172`.
- Set `True` exactly once, inside `Blueprint.register()`, at `blueprints.py:320` — immediately after `app.blueprints[name] = self` and before the `deferred_functions` replay loop at `blueprints.py:333-334`.
- Read only by `Blueprint._check_setup_finished` (`blueprints.py:213-221`), which raises an **explicit** `raise AssertionError(...)`, not a bare `assert`.
- Enforcement wiring: the `setupmethod` decorator (`src/flask/sansio/scaffold.py:42-49`) calls `self._check_setup_finished(f_name)` before delegating; `Scaffold._check_setup_finished` is abstract (`scaffold.py:220-221`), so each subclass defines its own condition (blueprint: registered once; app: first request handled).
- Guarded surface is wider than the 17 `@setupmethod` methods defined in `blueprints.py`: 15 further `@setupmethod` methods are inherited unoverridden from `scaffold.py` (16 there minus `add_url_rule`, which Blueprint overrides at `blueprints.py:413`) → 32 distinct guarded methods. `Scaffold.route` calls `self.add_url_rule`, so it dispatches into Blueprint's guarded override.

### Why it exists

Blueprint setup calls (routes, `before_request`, `app_errorhandler`, nested `register_blueprint`, …) do not take effect immediately — they append to `deferred_functions`, which is only replayed against an app inside `register()`. After the first registration, a late setup call either:

1. lands in `deferred_functions` but never reaches the already-registered app's `url_map` (a silent no-op), or
2. applies only to apps registered *later* (inconsistent behaviour across apps).

The latch converts that silent inconsistency into an immediate error. The message itself states the contract: *"…any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*

Executed verification in this checkout: after `app.register_blueprint(bp)`, `@bp.route` raises `AssertionError` from `blueprints.py:215`, and it still raises under `python -O` / `PYTHONOPTIMIZE=1` because the guard is an explicit `raise`, not an `assert`. Forcing `_got_registered_once = False` demonstrated the hazard: the late route entered `deferred_functions` (1→2) but never appeared in app1's `url_map` while it did appear on app2.

### What it is *not*

- Not re-registration idempotency — that is `record_once` (`blueprints.py:232-243`) plus `BlueprintSetupState.first_registration`, a separate mechanism.
- Not the same as the app-side analogue `Flask._got_first_request` (`sansio/app.py:411` default, `:414` check, `src/flask/app.py:911` set, reset at `src/flask/app.py:667` in `run()`): the teardown here is that the blueprint latch is one-way with **no reset path**.
- History: 2.2.0 turned post-registration setup into a warning (`CHANGES.rst:297-300`, issue 4571); 2.3.0 turned it into an error (`CHANGES.rst:160-161`, PR 4997).

### Scope caveat the task asked about

`experiments/data/flask-src` is a plain upstream clone, not a patched corpus: remote `github.com/pallets/flask`, HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`git describe` → `3.1.1-30-g85c5d93`), `pyproject.toml` version `3.2.0.dev`, `git status --porcelain` → 0 lines (pristine). Nothing in `pi-share-agents-openeuler-wsl` outside `flask-src` references `_got_registered_once`, so this is vendored upstream source the harness consumes, not a harness modification. The retriever's initial "provenance not established" caveat was **closed by the executor's git checks**, not contradicted.

## Rests on

- Direct reads of `src/flask/sansio/blueprints.py` (:172, :213-221, :232-243, :255, :320, :333-334, :412-413) and `src/flask/sansio/scaffold.py` (:42-49, :220-221, :295-368 method list) plus `src/flask/sansio/app.py` (:411, :413-416) and `src/flask/app.py` (:667, :911).
- `CHANGES.rst:1-3`, `:135`, `:160-161`, `:237`, `:297-300` for version attribution (2.3.0 section starts line 135; 2.2.0 at line 237).
- Executor's runtime run (AssertionError, `-O` survival, forced-flag hazard demo) and `git status --porcelain` / `git remote -v` provenance check.
- Grep over `tests/` showing no test pins the blueprint-side guard.

## Still open

- The blueprint-side guard has **no test** in this checkout (`tests/test_blueprints.py` raises only `TemplateNotFound:215` and `ValueError`; grep for the guard/message across `tests/` returns nothing), whereas the app-side guard is tested (`tests/test_basic.py:1678 test_no_setup_after_first_request`). Not established: that no *indirect* coverage exists elsewhere in upstream's suite — the tests were searched, not all read.
- Not established: any behaviour of this flag under the experiment harness, since the harness never references it.
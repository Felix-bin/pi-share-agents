# Purpose of the registration-tracking flag in the blueprint class

The flag is `Blueprint._got_registered_once` in `src/flask/sansio/blueprints.py`. It is a **one-way latch that freezes a blueprint's configuration surface after its first registration**, so that any attempt to set the blueprint up afterwards fails immediately with an `AssertionError` instead of silently producing an app that ignores the late setup.

**What the flag is and where it changes.** It is declared as a class attribute `_got_registered_once = False` (`blueprints.py:172`) and set to `True` inside `Blueprint.register()` at `blueprints.py:320`, immediately after `app.blueprints[name] = self` and *before* `state = self.make_setup_state(...)` and before the deferred functions are run. Nothing ever resets it: a grep of `src/` and `tests/` finds only the declaration (172), the read (214) and the set (320) — so once a blueprint has been registered, it stays marked forever.

**How it blocks setup methods.** The flag's only reader is `Blueprint._check_setup_finished` (`blueprints.py:213-220`), which raises an `AssertionError` when the flag is `True`. That method overrides the base `Scaffold._check_setup_finished`, which is just `raise NotImplementedError` (`scaffold.py:220-221`), so this is blueprint-specific behaviour rather than inherited scaffold behaviour. The enforcement wiring is the `setupmethod` decorator (`scaffold.py:42-49`), which calls `self._check_setup_finished(f_name)` before invoking the wrapped method:

```python
def wrapper_func(self: Scaffold, *args, **kwargs):
    self._check_setup_finished(f_name)
    return f(self, *args, **kwargs)
```

Every `@setupmethod`-decorated blueprint method therefore consults the flag — confirmed for `record`, `record_once`, `register_blueprint` in the retriever's evidence, and behaviourally for `add_url_rule`, `route`, `record`, `before_request` and nested `register_blueprint` in the executor's run.

**Why the guard exists — the mechanism it protects.** Registration is a one-shot merge: `register()` runs `self.deferred_functions` and merges the blueprint's data into the parent app only when `first_bp_registration or first_name_registration` (the merge path leading to `_merge_blueprint_funcs`, `blueprints.py:379`). A setup call made after that point would be recorded on the blueprint but never applied, giving an app that behaves differently from what the code appears to declare. The error text states this rationale verbatim: *"It has already been registered at least once, any changes will not be applied consistently."* The flag's purpose is thus to convert that silent inconsistency into a loud, early failure.

**Deliberate limit of the guard.** `register()` itself is not decorated with `@setupmethod`, so re-registering a blueprint (including registering it on a second app) remains legal — only *mutating* setup after registration is blocked. The executor's run shows exactly this: post-registration `register_blueprint` succeeds, the flag remains `True`, and the routes from the earlier setup (`/before`, `/deco`, `/static/<path:filename>`) are served.

**Behavioural confirmation (this tree).** The executor ran a script that prepends this worktree's `src/` to `sys.path` and checks the imported module is the in-tree Flask before asserting. Before registration, `add_url_rule` and `@bp.route` succeeded (deferred functions 1 → 2); after `register_blueprint`, the flag read `True` and all five post-registration setup calls raised `AssertionError` containing the exact phrase `can no longer be called on the blueprint`; no case produced "NO ERROR". Exit status 0.

**Version history (in-tree changelog).** The behaviour was originally a warning — "Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods" (`CHANGES.rst:297-300`, v2.2.0, issue 4571) — and became an error in v2.3.0 (`CHANGES.rst:160-161`, PR 4997). This is the same design as Flask's app-level guard, which uses `_got_first_request` in `sansio/app.py:411-421` with near-identical wording; the blueprint flag is the registration-time counterpart for blueprints.

**Environmental note (a discarded attempt in the record).** A first venv run imported Flask from another path named by `.venv/Lib/site-packages/flask.pth` and was discarded; the reported results come from the re-run with an explicit in-tree module check. Python 3.13.9 was used after `python` (3.14) failed with `ModuleNotFoundError: No module named 'werkzeug'`.

## What this rests on

- `src/flask/sansio/blueprints.py`: declaration `:172`, set `:320`, guard `:213-220`, register body and deferred-function loop `:319-326`, merge path `:379`.
- `src/flask/sansio/scaffold.py`: `setupmethod` `:42-49`, base `_check_setup_finished` `:220-221`.
- `src/flask/sansio/app.py:411-421`: the analogous `_got_first_request` guard.
- `CHANGES.rst:297-300` (v2.2.0 warning) and `:160-161` (v2.3.0 error).
- Executor run on this tree (exit 0, in-tree Flask import verified) plus the retriever's source locators.

## What remains open

- **No test-level evidence.** No file under `tests/` references `_got_registered_once`, the error string, or `"can no longer be called"`; the guarding behaviour is established only from source, changelog and an ad-hoc run, not from the test suite.
- **No second consequence of the flag.** Source and grep agree the setup-method guard is its only reader; whether the flag has any effect elsewhere is not established (no evidence of one exists).
- **`flask_mut2_i417ar2x/mutated_test.py` is unrelated to this flag** (verified: it sets `subdomain_matching=False` with `SERVER_NAME="example.com"` and asserts `url_for("view", company_id="xxx")` returns 200/`b"xxx"`), so it contributes nothing to the flag's purpose; whether that file signals a separate defect is outside this explanatory question.
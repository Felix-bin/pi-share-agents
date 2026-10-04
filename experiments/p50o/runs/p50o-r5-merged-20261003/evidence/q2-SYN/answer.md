## Conclusion

The flag is a **one-way "already registered at least once" latch whose purpose is to make blueprint setup impossible after registration, because a blueprint's setup state is consumed and merged into each app at `register()` time** — so any `route()`/`before_request()`/`record()` call arriving afterwards would append to a `deferred_functions` list that is never replayed for the app it was intended for, i.e. silently produce a half-applied blueprint. The latch converts that silent inconsistency into an early, loud error.

Mechanically, in the vendored Flask `3.2.0.dev` checkout (`experiments/data/flask-src`):
- The class is `Blueprint` (`src/flask/sansio/blueprints.py:119`), whose own docstring calls it "a collection of routes and other app-related functions that can be registered on a real application later". The question's "blueprint collection class" is a paraphrase of this; no `BlueprintGroup`/"collection class" exists anywhere under `src/` (grep: no matches).
- `_got_registered_once = False` is a class attribute on `Blueprint` only (`:172`), flipped on the instance inside `Blueprint.register` at `:320` — after `app.blueprints[name] = self` (`:319`) and **before** the `for deferred in self.deferred_functions:` replay loop at `:334`.
- `Blueprint._check_setup_finished` (`:213`) raises `AssertionError` with "…can no longer be called on the blueprint '…'. It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it." `@setupmethod` (`sansio/scaffold.py:42`–49) calls it on entry, so one latch guards every setup method.
- The raising text is quoted from source and was also observed live by the executor from a real `bp.route()` after registration, including out of a deferred callback.
- Scope correction: it is per-instance and one-way; it does **not** forbid a second registration under a different `name=` (the name-collision `ValueError` at `:302`–310 is a separate guard). `record_once` / `BlueprintSetupState.first_registration` is a distinct per-app switch — on a second registration, plain `record` callbacks fire again with `first_registration=False` while `record_once` callbacks stay silent.

## What this rests on

- `src/flask/sansio/blueprints.py:119, 120-121, 172, 213-222, 301-310, 319, 320, 334` (re-read this session).
- `src/flask/sansio/scaffold.py:42-49` (`@setupmethod` → `_check_setup_finished`).
- Executor's live repro against `experiments/data/flask-src/.venv` (CPython 3.13.9): exact `AssertionError` text, deferred-callback raise, second-registration behaviour.
- Provenance: `UserWarning` in 2.2.0 (`CHANGES.rst:297-300`, issue #4571) → error in 2.3.0 (`CHANGES.rst:160-161`, PR #4997, commit `fc03d0df`). This **corrects the earlier planner claim of 3.0**, as the executor's git provenance already flagged.
- Conclusion stored in shared memory as `8f1ffe63…` (topic `flask-blueprint-got-registered-once-purpose`).

## Still open

- No evidence of the flag being re-read via `git log -S` independently by me; provenance rests on the executor's commit check plus `CHANGES.rst`.
- Nothing established about Flask versions outside this vendored checkout — the "3.2.0.dev" tree shows no further change to this guard, but later upstream releases were not examined.
- The doc's own phrasing of the question ("prevents setup methods from being called after the blueprint has been registered once") matches the source, but the *rationale* sentence ("changes will not be applied consistently") is upstream's stated intent; it is consistent with the `:320`-before-`:334` ordering and the registration-time merge at `:327`–`:331`, not separately proven by a mutation test.
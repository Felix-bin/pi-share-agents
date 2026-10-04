## Answer

**The flag is `Blueprint._got_registered_once`, and its purpose is to make "setup after registration" a loud error instead of a silent, order-dependent no-op.**

It is the blueprint-side analogue of the application-side guard: `App._check_setup_finished` triggers on `_got_first_request` (`src/flask/sansio/app.py:411`, `:413-421` — "…has already handled its first request…"), and a `Blueprint` cannot use a request as its trigger, so its natural cut-off is the first call to `Blueprint.register()`. The flag marks that boundary.

**Why the boundary must exist (the actual mechanism, not just the message).** `register()` eagerly snapshots the blueprint into the app: it sets `app.blueprints[name] = self`, calls `make_setup_state(...)`, merges blueprint functions only `if first_bp_registration or first_name_registration`, and then replays `for deferred in self.deferred_functions: deferred(state)` (`blueprints.py:318-340`, read directly in this session). `record_once` further gates its callback on `if state.first_registration` (`:232-247`, with `first_registration` documented on `BlueprintSetupState.__init__`, `:56-63`). So anything registered *after* the first `register()` never reaches the already-built app, and `record_once` callbacks would be skipped on it — precisely the "any changes will not be applied consistently" the error text names (`:214-221`). The flag raises `AssertionError` at exactly that point, telling the developer to finish all imports/decorators/setup before registering.

**Enforcement path:** `@setupmethod` (`scaffold.py:42-49`) calls `self._check_setup_finished(f.__name__)` before the wrapped method; the abstract hook is `scaffold.py:220-221`. It sits on 17 `Blueprint` methods (`blueprints.py:223,232,255,412,443,460,477,496,515,534,553,563,573,583,595,612,624`).

**Confirmed behaviorally, not only by reading** (executor, with the tree's vendored `.venv/Scripts/python.exe` against `PYTHONPATH=src`): flag `False` before, `True` after `app.register_blueprint(bp)`; `@bp.route('/late')` and `bp.record(...)` post-registration both raise the blueprint `AssertionError`; the app-side contrast raises after one request; `bp.add_url_rule.__wrapped__(...)` *still* raises because `add_url_rule` internally calls the guarded `self.record` (`:433`); and bypassing every guard by appending directly to `bp.deferred_functions` left `app.url_map` unchanged (`['/early','/static/<path:filename>']`) while the list grew 1→2 — the concrete silent inconsistency the guard exists to prevent.

**Two qualifications worth keeping:**
- The flag is only ever *set*, never reset (grep finds exactly three hits: `:172` declaration, `:214` read, `:320` write). So it means "registered **at least once**", not "currently registered" — deliberately one-way. The check is an `AssertionError` (a programming-error guard aimed at the developer), not runtime end-user validation.
- CHANGES.rst lineage: 2.2.0 (`:295-299`, `:issue:`4571``) it was a **warning**; 2.3.0 (`:158-161`, `:pr:`4997``) it **became an error**. The retriever initially attributed this to 3.0.0 and corrected it mid-retrieval; the corrected reading was independently re-confirmed by the executor.

## What this rests on

- `src/flask/sansio/blueprints.py:172,213-221,223,232-247,320,334-340` (re-read in this session for `:213-221` and `:318-340`); `src/flask/sansio/scaffold.py:42-49,220`; `src/flask/sansio/app.py:411,413-421`; `BlueprintSetupState.__init__` at `:56-63`.
- Executor's grep table (3 hits for `_got_registered_once`, 17 `@setupmethod` sites, zero test matches) and its runtime transcript against the vendored Flask.
- `CHANGES.rst:158-161` (2.3.0) and `:295-299` (2.2.0).
- Shared memory: `dec61031…` (consolidated retriever conclusion, superseded `5f70e3a6…` corrected), `dd5f6e4bbbc0…` (executor run, same source file). The new synthesis is recorded as `db338e4c4c9a493a6731e9d9854455bc9e2c7082b8a71608095e01f4f9001485`.

## What remains open

- **Intent beyond the artifacts is not established.** No issue or PR body (`#4571`, `#4997`) exists in this worktree, so "purpose" is read off the error message, the changelog, and the call-flow — not off upstream discussion.
- **Public-API status not established:** `_got_registered_once` is underscore-private with no docs hit.
- **Test coverage is a reported absence, not a proof of absence upstream:** grep over `tests/` for `_got_registered_once` / `_check_setup_finished` / `can no longer be called` returns zero hits, and `tests/test_blueprints.py` contains no `AssertionError`; the only nearby coverage is `tests/test_basic.py:1677-1690` for the *app-side* guard. That is untested in this tree only.
- No contradiction between the two stage results survived; the planner's "~270–330" pointer resolved consistently (`register()` starts at `:269`).
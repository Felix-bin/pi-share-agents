## Purpose of the registration-tracking flag (`Blueprint._got_registered_once`)

The flag is a one-way latch whose purpose is to make every blueprint setup call fail fast once the blueprint has been attached to any application at least once, instead of silently producing a blueprint whose extra routes/handlers apply to some registrations and not others.

It is the `Blueprint` class in `src/flask/sansio/blueprints.py` — the class whose own docstring describes a blueprint as "a collection of routes and other app-related functions" (lines 119-127) — and the flag is `_got_registered_once`.

Mechanism, all in `src/flask/sansio/blueprints.py`:

- Declared as a class-level default `_got_registered_once = False` (line 172).
- Set to `True` inside `Blueprint.register()`, immediately after `app.blueprints[name] = self` (line 320), i.e. before the `BlueprintSetupState` is created (line 321) and before `self.deferred_functions` are replayed onto the app (lines 334-335). It is never reset, so it records "registered at least once ever", not "currently registered".
- Read by `Blueprint._check_setup_finished()` (lines 213-221), which raises `AssertionError`: "The setup method '<f_name>' can no longer be called on the blueprint '<name>'. It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
- That check is reached because the `@setupmethod` decorator (`src/flask/sansio/scaffold.py:42-49`) calls `self._check_setup_finished(f_name)` before running the wrapped method, and it wraps the whole blueprint setup surface: `record` (223), `record_once` (232), `register_blueprint` (255), `add_url_rule` (412), the `app_template_filter`/`app_template_test`/`app_template_global` families (443+), `before_app_request` (553), `after_app_request` (563), `teardown_app_request` (573), `app_context_processor` (583), `app_errorhandler` (595), `app_url_value_preprocessor` (612), `app_url_defaults` (624).

Why the latch exists: blueprint setup methods do not touch an application — they append to `deferred_functions` to be replayed at registration time (docstring lines 127-131, "records them for later registration"). A setup call made after the first registration therefore cannot reach the app that already registered the blueprint, while it *would* take effect on a later registration: registering the same blueprint again under a different name is explicitly supported (`tests/test_blueprints.py:992-1008`, `test_unique_blueprint_names` — same bp, same name is an error, `name="again"` is fine). The result would be two applications built from the same blueprint object that differ, which is exactly the inconsistency the error message names. The flag converts that silent divergence into an immediate, loud failure at the offending call.

Status and history: this is a deliberate behavioural guarantee, not an oversight — `CHANGES.rst:297-300` records that 2.2 made late blueprint setup emit a warning (issue 4571) and 2.3 turned it into an error (`CHANGES.rst:160-161`, "Calling setup methods on blueprints after registration is an error instead of a warning", PR 4997). `docs/lifecycle.rst:41-56` documents the equivalent app-level guard and states the general rule "don't do anything to modify the `Flask` app object and `Blueprint` objects from within view functions", while warning that Flask cannot detect every case of out-of-order setup.

Two nearby flags that are *not* this one, to keep the answer unambiguous:

- `BlueprintSetupState.first_registration` (lines 46, 58-62, 241) is per-registration, passed into each `BlueprintSetupState`, and only decides whether `record_once` callbacks run again; it does not gate setup methods.
- `Flask._got_first_request` (`src/flask/sansio/app.py:411-419`) is the application-level analogue, gating setup after the first request rather than after first registration.

## What this rests on

- `src/flask/sansio/blueprints.py` lines 172, 213-221, 232-244, 316-335 (flag declaration, check, `record_once` semantics, set-to-true site and replay loop).
- `src/flask/sansio/scaffold.py` lines 42-49 (`setupmethod` wrapper) and 220-221 (`Scaffold._check_setup_finished` raising `NotImplementedError` as the base contract).
- `src/flask/sansio/app.py` lines 411-419 (app-level analogue) and 569-602 (registration entry points).
- `CHANGES.rst` lines 160-161 (2.3: error), 297-300 (2.2: warning, issue 4571); `docs/lifecycle.rst` lines 41-56.
- `tests/test_blueprints.py` lines 992-1008 (repeat registration under a new name is allowed) ; `tests/test_basic.py` lines 1687-1690 (app-level late-setup error asserted).

## Open / not established

- The two evidence handles quoted in the task (retriever `65bc716b…`, executor `792080a7…`) could not be read from this session — memory access in this namespace fails with a namespace mismatch — so nothing from those texts is reflected above; every claim is grounded in the working-directory files instead.
- No test in this checkout exercises the blueprint branch: `grep` for "no longer be called" / "AssertionError" in `tests/` finds no assertion of the blueprint setup-after-registration error, so the latch's enforcement is present in the source but unverified by the suite here. The only adjacent coverage is the app-level case (`tests/test_basic.py:1687-1690`) and the repeat-registration naming case (`tests/test_blueprints.py:992-1008`).
- Whether any example or test in this tree actually performs setup after registration (which would now raise) was not surveyed, so no statement is made about the flag breaking existing in-repo usage.
## Purpose of the registration tracking flag

**Short answer:** `Blueprint._got_registered_once` exists to make *late blueprint setup impossible*, because a blueprint's setup is deferred and merged into the application only once. It is flipped on the moment the blueprint is registered, and every subsequent call to a blueprint setup method is turned into a loud `AssertionError` instead of a silent, inconsistent change.

### The flag itself

- Declared as a class attribute defaulting to `False` on `Blueprint` in `src/flask/sansio/blueprints.py:172`. `Blueprint` is the "collection" class in question — its own docstring calls it "a collection of routes and other app-related functions that can be registered on a real application later" (same file, class docstring).
- Set to `True` inside `Blueprint.register()`, at line 320, immediately after the blueprint is recorded into `app.blueprints[name]` (line 319) and *before* the setup state is built (line 321), blueprint funcs merged (lines 330–332), and deferred functions executed (lines 334–335).
- Because it is a class attribute that is only ever assigned on the instance, the `True` state is per-blueprint-instance and cannot leak between blueprints.

### How it is consumed

- Read in exactly one place: `Blueprint._check_setup_finished()` (lines 213–221), which raises:
  > The setup method '`<name>`' can no longer be called on the blueprint '`<bp>`'. It has already been registered at least once, any changes will not be applied consistently.
  > Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
- `_check_setup_finished` is called by the `@setupmethod` decorator wrapper (`_check_setup_finished(f_name)` then the real body — `src/flask/sansio/scaffold.py:42-49`). `@setupmethod` is applied broadly:
  - on `Blueprint` itself to `record`, `record_once`, `register_blueprint`, `add_url_rule`, `app_template_filter`/`add_app_template_filter`, `app_template_test`/`add_app_template_test`, `app_template_global`/`add_app_template_global`, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, and the rest of `src/flask/sansio/blueprints.py`'s setup API;
  - on the inherited `Scaffold` API — `route`, the `get`/`post`/`put`/`delete`/`patch` shortcuts, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler` (`src/flask/sansio/scaffold.py:295-642`).
  So the guard covers the whole setup surface, not just direct `record` calls.

### Why the guard is needed at all

1. **Setup is deferred, so late additions are dead code.** Decorators on a blueprint do not touch an app; they append callbacks to `deferred_functions` (`record`, lines 223–230), which are only drained during `register()` (lines 334–335). Anything recorded after that has already missed the app it was intended for.
2. **The merge already happened.** `_merge_blueprint_funcs` runs only when `first_bp_registration or first_name_registration` is true (line 331), and `record_once` wrappers only fire when `state.first_registration` is true (lines 240–242). A post-registration addition therefore would not be applied, predictably or otherwise.
3. **A blueprint can be registered more than once, which is why the flag is "once", not "per app".** The same blueprint can be mounted on several apps or repeatedly on one app with distinct `name=` options (`register`, and the `name in app.blueprints` check at lines 306–314). Once it has been registered *at least once*, its recorded setup is frozen for all such registrations, so further setup can no longer be applied consistently anywhere. That is what the error wording ("at least once") encodes.
4. **It is the blueprint analogue of the application-level guard, with a different trigger.** `App._check_setup_finished` uses `_got_first_request` (`src/flask/sansio/app.py:409-422`) and fires after the app has handled its first request. A blueprint never handles requests itself, so the equivalent "too late" point is its first registration — the flag is deliberately `_got_registered_once` rather than a request counter.
5. **The documented rationale is cross-worker consistency.** `docs/lifecycle.rst:36-48` states all setup must finish before serving because WSGI servers split work across workers/machines, so a change made after that point "will not be applied consistently", and Flask surfaces these setup-ordering mistakes as errors. The blueprint message echoes this phrase verbatim.
6. **It is had both ways in history, and the flag carries the escalation.** `CHANGES.rst:297-300` records issue 4571: post-registration blueprint setup *warned*. `CHANGES.rst:160-161` records PR 4997, in which "Calling setup methods on blueprints after registration is an error instead of a warning" — matching the `raise AssertionError` now in the source.

One derived consequence of the ordering at lines 320 vs 334: since the flag is set *before* deferred functions run, a deferred callback that itself tries to record further setup on the same blueprint will also trip the guard, not just code in view functions or later application code.

### Scope note (what this answer covers)

The question asked only about the blueprint flag. The app-level counterparts are separate mechanisms: `App._got_first_request` + `App._check_setup_finished` in `src/flask/sansio/app.py:409-422`, with the abstract hook declared at `src/flask/sansio/scaffold.py:220-221`.

### What this rests on, and what is open

Rests on (source-verified, not executed):
- `src/flask/sansio/blueprints.py:172` (declaration), `213-221` (check + message), `240-242` (`record_once` gate), `306-321` (registration, name check, flag flip), `330-335` (merge gate + deferred drain).
- `src/flask/sansio/scaffold.py:42-49` (`@setupmethod`), `220-221` (abstract check), `295-642` (decorated setup surface).
- `src/flask/sansio/app.py:409-422` (app-level analogue); `src/flask/blueprints.py:11` (`Blueprint` subclasses the sansio base).
- `docs/lifecycle.rst:36-48`; `CHANGES.rst:160-161` and `297-300`.
- The only runnable artifact present, `flask_mut2_i417ar2x/mutated_test.py`, exercises subdomain routing and `url_for`; it does not touch the blueprint registration guard, so it neither supports nor contradicts this conclusion.

Open / not established:
- **No test evidence.** `tests/test_blueprints.py` contains no match for `_got_registered_once`, "registered at least once", or "can no longer be called on the blueprint" (nor do the other test modules), and it has no `AssertionError`-based setup-after-registration test. Only the app-level analogue is tested (`tests/test_basic.py:1687-1690`, asserting `"setup method 'add_url_rule'"`). So the blueprint guard's *enforcement* is established by reading the source and changelog, not by a passing test run.
- No execution was performed in this stage (the executor step was skipped by the complexity gate), so the error message text and the exact set of guarded methods are asserted from code structure, not from observed runtime behaviour.
- The inherited planner/retriever handles for this seal could not be re-read (shared memory returned `namespace-mismatch` against this q7 working directory), so this answer is derived directly from the repository; if those artifacts contained a different reading of the flag, they were not available to reconcile against.
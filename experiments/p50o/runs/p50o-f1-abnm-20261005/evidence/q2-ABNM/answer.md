## Purpose of `_got_registered_once` in `Blueprint`

**Short answer:** it is a one-way latch that records that the blueprint has been attached to an application at least once; from that moment on, every blueprint setup method raises `AssertionError` instead of silently mutating a blueprint whose recorded state has already been drained into an app.

**The flag and its guard**

- `Blueprint._got_registered_once = False` — a class attribute default, `src/flask/sansio/blueprints.py:172`.
- `Blueprint._check_setup_finished()` — raises `AssertionError` when the flag is set: *"The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."* (`blueprints.py:213-221`).
- The hook is wired through the `setupmethod` decorator, which calls `self._check_setup_finished(f_name)` before every decorated method runs (`src/flask/sansio/scaffold.py:42-49`). On `Blueprint` that covers both the inherited `Scaffold` setup methods (`route`, `get/post/put/delete/patch`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`) and the blueprint-specific ones (`record`, `record_once`, `register_blueprint`, `app_template_filter/test/global` and their `add_*` forms, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults`).
- The latch is set in `Blueprint.register()` at `blueprints.py:320`, immediately after the blueprint is placed into `app.blueprints[name]` and *before* the static route, `_merge_blueprint_funcs`, and the deferred callbacks are executed (`blueprints.py:319-336`). `register()` itself is deliberately **not** a `setupmethod`, so re-registering the same blueprint on further apps stays legal.

**Why the guard exists — the "inconsistently" in its message**

- Registration is a one-way materialisation: `register()` copies the blueprint's per-blueprint handler dicts into the app via `_merge_blueprint_funcs()` (only when `first_bp_registration or first_name_registration`, `blueprints.py:331-332`) and runs every entry in `self.deferred_functions` against the setup state (`blueprints.py:334-336`). Anything recorded on the blueprint after that point exists only in the blueprint and reaches no already-registered app.
- A blueprint is reusable: it can be registered on several apps and multiple times with different names (`docs/blueprints.rst:36-46`, `blueprints.rst:108-110`; `app.py:589-591`). So a late `@bp.route(...)` would not be wrong for *one* app — it would be applied to later registrations and absent from earlier ones, i.e. the same blueprint would behave differently per app. The flag therefore tracks "registered at least once" globally per blueprint instance, not "registered on this app", which is exactly what the message names as the failure mode ("changes will not be applied consistently").
- It is a fail-fast development guard against ordering mistakes (imports/decorators/stray module-level setup that runs after `app.register_blueprint(bp)`), rather than a runtime enforcement of request-time correctness — compare the parallel application-side guard `_got_first_request` in `src/flask/sansio/app.py:413-420`, and the docs framing for the app case in `docs/lifecycle.rst:41-48`.
- History, from `CHANGES.rst`: the blueprint setup-after-registration check was introduced in 2.2.0 as a **warning** ("Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error", `CHANGES.rst:297-300`, issue 4571), and tightened in 3.0.0 to an **error**: "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`" (`CHANGES.rst:160-161`). `_got_registered_once` is the flag that carries that state.

**Not to be confused with** `BlueprintSetupState.first_registration` (`blueprints.py:43-62`), which is per *app registration* and is passed into deferred callbacks so that `record_once` only fires on the first registration of a blueprint onto a given app (`blueprints.py:240-244`, `316`, `321`). `_got_registered_once` is the per-blueprint, permanent "no more setup" latch.

**Design consequence worth naming:** because the latch is per blueprint object and permanent, a blueprint registered on app A cannot be extended for app B either — e.g. `bp.route(...)` after `app_a.register_blueprint(bp)` raises even though `app_b` has not seen the blueprint yet.

---

**What this rests on**
- `src/flask/sansio/blueprints.py:172, 213-221, 316-336, 379-…` (`_merge_blueprint_funcs`), and its `@setupmethod` list.
- `src/flask/sansio/scaffold.py:42-49` (the `setupmethod` wrapper calling `_check_setup_finished`); `src/flask/sansio/app.py:413-420` for the app analogue.
- `CHANGES.rst:160-161` (3.0.0, PR 4997) and `CHANGES.rst:297-300` (2.2.0, issue 4571); `docs/blueprints.rst:36-46, 108-110`; `docs/lifecycle.rst:41-48`.

**Still open / limits of this conclusion**
- The retriever evidence body (handle `9f6d4431…`) and executor result body (handle `72e9b51a…`) were not present in this session's prompt, and the shared-memory store is namespaced to a different seal, so I could not read or reconcile them; every claim above was verified directly against the working tree.
- The only executed artifact visible in the tree is `flask_mut2_i417ar2x/mutated_test.py`, and `.pytest_cache/v/cache/lastfailed` lists it as failing. That script exercises `SERVER_NAME`/subdomain routing, not the blueprint registration latch, so no executed result in this tree either confirms or contradicts this answer; the flag's behaviour is asserted here from code reading only.
- No test in `tests/` asserts the blueprint-level message (`grep` for "can no longer be called on the blueprint" matches only `src/flask/sansio/blueprints.py:216`); only the app-level guard has a test (`tests/test_basic.py:1687-1690`). So the flag's enforcement path is documented and implemented but not covered by a blueprint-specific regression test in this tree.
- The task did not ask whether this guard is desirable; its purpose as stated is the message's own rationale (fail fast on setup applied inconsistently), not an independently measured outcome.
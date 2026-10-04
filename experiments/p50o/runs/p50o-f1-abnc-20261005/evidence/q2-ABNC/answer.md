## Purpose of the registration-tracking flag in `Blueprint`

The flag is `Blueprint._got_registered_once`. It exists to make "setup after registration" a hard error, because by the time a blueprint has been registered once its deferred setup data has already been copied into an application and can no longer be applied consistently.

**What the flag is and where it lives**

- Declared as a class attribute defaulting to `False` on the `Blueprint` class — the class whose own docstring describes it as *"a blueprint, a collection of routes and other app-related functions"* (`src/flask/sansio/blueprints.py:172`, docstring at `:120`).
- Set to `True` inside `Blueprint.register()`, immediately after the blueprint is inserted into `app.blueprints` (`src/flask/sansio/blueprints.py:320`).
- `Blueprint.register()` is the point at which the blueprint stops being a passive container: it creates the `BlueprintSetupState`, merges the blueprint's handlers into the app via `_merge_blueprint_funcs`, and then replays every entry in `self.deferred_functions` (`:322-333`, `:386-407`). After this, later additions to the blueprint have no path back into the already-registered app.

**How the flag blocks later setup**

- Every setup method is wrapped by the `setupmethod` decorator, whose wrapper calls `self._check_setup_finished(f_name)` before running the method (`src/flask/sansio/scaffold.py:42-49`).
- `Blueprint` overrides `_check_setup_finished` to raise `AssertionError` when the flag is set (`src/flask/sansio/blueprints.py:213-221`). The message states the purpose directly: *"The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*
- Because the decorator covers `route`, `get`/`post`/…, `before_request`, `errorhandler`, `add_url_rule`, `record`, `register_blueprint`, and the rest, any of them called after a first registration raises instead of silently doing nothing useful.

**Why a per-blueprint flag rather than an app-side check**

- The flag records "registered at least once, against any app," not "registered on this app." `register()` therefore does not rely only on the app-side uniqueness check (`name in app.blueprints`, `:302-312`); the separate `first_bp_registration` / `first_name_registration` booleans (`:316-317`) only control merging and `record_once` de-duplication. The `_got_registered_once` flag is the dedicated guard for the blueprint's own mutability.
- It is set per instance (`self._got_registered_once = True`), while the class attribute supplies the `False` default for fresh blueprints.

**Rationale and history**

- `CHANGES.rst:160` records the behaviour under Version 2.3.0: *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"* — so the flag's job is to upgrade a previously advisory condition to an enforced one.
- The broader reason is the same one documented for the app-level equivalent in `docs/lifecycle.rst:36-52`: setup must complete before serving because WSGI servers spread work across workers/machines, so changes made after registration cannot be guaranteed to apply consistently. The blueprint guard mirrors the app's `_got_first_request` guard (`src/flask/sansio/app.py:409-423`), which uses the same `_check_setup_finished` hook.

### Verification status

- The flag, its assignment in `register()`, and the `AssertionError` path are all read directly from the source above; no bypass in the `setupmethod` wrapper was found.
- `grep` over `tests/` found no test that references `_got_registered_once`, `_check_setup_finished`, or the blueprint variant of the "no longer be called" message; `tests/test_blueprints.py` ends at `test_blueprint_renaming` (`:1017`), which exercises repeated registration but never calls a setup method after registration. So the behaviour is implemented and documented but **not directly covered by an asserting test** in the collected evidence.
- The executor artifact in the working directory (`flask_mut2_i417ar2x/mutated_test.py`) exercises subdomain routing/`url_for`, not this flag, so it does not bear on the answer.

### What is answered / open

- **Answered:** the flag is `Blueprint._got_registered_once`; its purpose is to fail fast when setup methods are called after the blueprint has been registered at least once, because the blueprint's setup data has already been consumed and further changes could not be applied consistently.
- **Open:** there is no test in the suite asserting this specific blueprint error; the exact message text and changelog entry are the only behavioural evidence for it.
## Answer

The flag is **`_got_registered_once`**, a class-body attribute on `Blueprint` (the class described in its own docstring at `src/flask/sansio/blueprints.py:120-122` as "a collection of routes and other app-related functions that can be registered on a real application later").

**Its purpose is a one-way "already registered" latch.** It starts as `False` (`blueprints.py:172`), is flipped to `True` the moment the blueprint is registered on an application, and is never set back to `False`. Any further attempt to modify the blueprint through a setup method is refused rather than silently ignored.

**What it actually does:**

- **It is read by `Blueprint._check_setup_finished`** (`blueprints.py:213-221`): `if self._got_registered_once: raise AssertionError(...)` with the message *"The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently.\n Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*
- **It is set inside `register()`** at `blueprints.py:320` — after the duplicate-name `ValueError` and deliberately **before** `state = self.make_setup_state(...)` (`:321`) and before the deferred-callback dispatch `for deferred in self.deferred_functions: deferred(state)` (`:334-335`). Writing it before those steps is what makes the latch airtight even within the registering call itself.
- **It is enforced through the `setupmethod` decorator** (`src/flask/sansio/scaffold.py:42-49`), whose wrapper calls `self._check_setup_finished(f_name)` at `:46` *before* invoking the wrapped method. `Blueprint` overrides the abstract `Scaffold._check_setup_finished` (the base at `scaffold.py:220-221` only raises `NotImplementedError`), so the blueprint-side guard is the only one testing this attribute — the app-level override at `app.py:413` tests a *different* attribute, `_got_first_request`.

**Why it exists — the rationale stated by the code itself.** Setup methods do not apply their effects directly; they append to `self.deferred_functions` (declared `blueprints.py:204`, appended by `record()` at `:230`), and that list is consumed only once, during `register()` (`:334-335`). So a route, error handler, CLI hook or nested blueprint added *after* the first registration would be recorded in a list that no longer gets replayed for that registration; the error text "changes will not be applied consistently" (`:216-219`) is a direct statement of this. The flag exists to turn that silent inconsistency into a loud `AssertionError` and to force all setup to happen before registration.

**It is not the same as `BlueprintSetupState.first_registration`** (`blueprints.py:43-62`), which is *per-registration* — computed in `register()` as `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (`:315`) and documented as "can be used to figure out if the blueprint was registered in the past already." `_got_registered_once` is *ever-registered* and irreversible; the two must not be conflated.

## What this rests on

- Static: whole-worktree `grep -rn "_got_registered_once"` returns exactly three source hits, all in `src/flask/sansio/blueprints.py` — `:172` (declaration `= False`), `:214` (read/raise), `:320` (write `= True`); no contradictory copy exists in this checkout (nothing in `flask_mut2_i417ar2x/`). Four hits for `_check_setup_finished` (`scaffold.py:46`, `scaffold.py:220`, `app.py:413`, `blueprints.py:213`).
- Runtime: executed against **this checkout's** `src` (via `.venv/Scripts/python.exe` with `src` prepended to `sys.path`, confirmed by the printed import path) — fresh blueprint flag `False`; after `app.register_blueprint(bp)` it is `True`; `bp.route('/late')` and `bp.record(...)` each raise the `AssertionError` above. So the guard chain is live, not merely present in the source.

## Still open

- Coverage of *every* `@setupmethod`-decorated method is established by construction through the decorator, not by full enumeration of `route`, `add_url_rule`, `errorhandler`, `register_blueprint`, etc.
- No test in `tests/` exercises this blueprint variant; the only matching repo test is `tests/test_basic.py:1678 test_no_setup_after_first_request`, which covers the app-level `_got_first_request` guard instead.

Both points are gaps in *verification*, not in the answer: no evidence contradicts the conclusion above.
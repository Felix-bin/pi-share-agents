## Purpose of the registration tracking flag

The flag is `_got_registered_once` on `Blueprint` (`src/flask/sansio/blueprints.py:172`). The class the task calls the "blueprint collection class" is `Blueprint` itself — its own docstring describes it as "a collection of routes and other app-related functions that can be registered on a real application later" (`blueprints.py:108-110`); that is the only class in this repository that carries a registration-tracking flag gating setup methods.

Its purpose is to freeze a blueprint's setup as soon as that blueprint has been registered on any application, so that a late `@bp.route(...)`, `before_request`, `record`, `register_blueprint`, template filter, etc. fails loudly instead of producing applications that silently differ.

**How it works**

- Set: `Blueprint.register` sets `self._got_registered_once = True` (`blueprints.py:320`), right after `app.blueprints[name] = self` (`:319`) and *before* `make_setup_state` (`:321`) and the replay loop `for deferred in self.deferred_functions: deferred(state)` (`:334-335`). `Blueprint.register` itself is not decorated with `@setupmethod` (`:273`), so registering is what flips the flag; it is not blocked by it.
- Checked: `Blueprint._check_setup_finished` (`blueprints.py:213-221`) raises `AssertionError` when the flag is set. It is called by the `setupmethod` decorator wrapper *before* the wrapped method body runs (`src/flask/sansio/scaffold.py:42-49`), and `Scaffold._check_setup_finished` is declared abstract (`scaffold.py:220-221`). Every `@setupmethod`-decorated method on the blueprint is therefore covered — `route`/`get`/`post`/`add_url_rule`, request/teardown handlers, `record`, `record_once`, `register_blueprint`, `errorhandler`, and the app-wide and template helpers.
- The error text states the intent directly: "The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it." (`blueprints.py:215-221`)

**Why the inconsistency it prevents is real, not theoretical**

Deferred functions recorded through `record`/`record_once` are only executed at registration time (`blueprints.py:334-335`), and blueprint-level functions (`before_request_funcs`, `error_handler_spec`, `view_functions`, `url_default_functions`, etc.) are copied into the app by `_merge_blueprint_funcs` (`blueprints.py:379-411`), which runs only when `first_bp_registration or first_name_registration` is true (`:348-349`). A blueprint is also meant to be mountable on more than one app (`docs/blueprints.rst:119-121`). Anything added after the first registration would therefore reach some apps and not others — the source of the "will not be applied consistently" wording. The flag turns that silent divergence into an immediate error at the offending setup call.

**Boundary details the evidence fixes**

- The trigger is "registered at least once", not "registered twice on the same app": the flag is never reset, and a second registration (e.g. under a different `name=`/`url_prefix`, `blueprints.py:300-320`) does not clear it. Once a blueprint object has been registered anywhere, it is permanently closed to further setup.
- Because the flag is set *before* the deferred callbacks run, a setup call made from inside a deferred callback during registration also raises.
- This is the blueprint counterpart of the application-side guard, which uses a different trigger: `Flask._check_setup_finished` checks `_got_first_request` (`src/flask/sansio/app.py:411-419`), i.e. setup on an app is blocked after its first request, and that error is documented in `docs/lifecycle.rst:42-48`.
- It was a warning until it became an error in 2.3: `CHANGES.rst:297-300` (issue 4571) introduced the warning, `CHANGES.rst:160-161` (PR 4997) made it an error.

**What this rests on**

- `src/flask/sansio/blueprints.py` (flag at `:172`, check at `:213-221`, set at `:320`, deferred replay at `:334-335`, `_merge_blueprint_funcs` at `:379-411`), `src/flask/sansio/scaffold.py:42-49, 220-221`, `src/flask/sansio/app.py:411-419`.
- `CHANGES.rst:160-161, 297-300`; `docs/blueprints.rst:119-121`; `docs/lifecycle.rst:42-48`.

**Still open / not established**

- No test in the repository asserts the blueprint-side message: searching `tests/` finds no `AssertionError` in `tests/test_blueprints.py` and no occurrence of "can no longer be called" there; the only in-tree assertion of this wording is the app-side one at `tests/test_basic.py:1687-1690`. So the blueprint-side behaviour is established by the implementation, changelog and docstring, not by a test I located.
- The precise failure mode the guard prevents (modifying a blueprint after registering it on one app, then registering it on another) is not exercised by any test I found; the intent is asserted by the error message rather than demonstrated by test output.
- Shared memory for this topic was not readable in this session (`namespace-mismatch` against the state namespace), so no prior conclusion was consulted or recorded.
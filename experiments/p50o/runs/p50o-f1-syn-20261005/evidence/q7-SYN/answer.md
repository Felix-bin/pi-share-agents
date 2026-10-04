## Purpose of the registration tracking flag on `Blueprint`

The flag is `Blueprint._got_registered_once` (`src/flask/sansio/blueprints.py`), declared as a class-level default `False` at line 172 and set to `True` at line 320 inside `Blueprint.register()`. `Blueprint` is the "collection" class in question — its own docstring describes it as "a collection of routes and other app-related functions that can be registered on a real application later" (lines 136–137).

**What it does.** It is the blueprint's "setup phase is over" latch. Every blueprint setup method is wrapped by the shared `setupmethod` decorator (`src/flask/sansio/scaffold.py:42-49`), whose wrapper calls `self._check_setup_finished(f_name)` before running the real method. `Blueprint._check_setup_finished` is the implementation that consults the flag (`blueprints.py:214-220`):

```python
if self._got_registered_once:
    raise AssertionError(
        f"The setup method '{f_name}' can no longer be called on the blueprint"
        f" '{self.name}'. It has already been registered at least once, any"
        " changes will not be applied consistently.\n"
        "Make sure all imports, decorators, functions, etc. needed to set up"
        " the blueprint are done before registering it."
    )
```

So once a blueprint has been registered on any app, further calls to `route`, `add_url_rule`, `before_request`, `errorhandler`, `record`, `record_once`, `register_blueprint` (nested), etc. fail immediately instead of being quietly ignored.

**Why it is needed.** A blueprint's definitions are consumed at registration time only. Setup calls append to `deferred_functions` (`blueprints.py:230`), and `register()` replays that list exactly once, iterating it at lines 334–335 to push everything onto the app; blueprint-level handler dicts are merged into the app once as well (`_merge_blueprint_funcs`, gated by `first_bp_registration or first_name_registration` at lines 316–332). There is no mechanism that re-applies later additions. Without the flag, adding a route or handler after registration would produce a silently partially-applied blueprint: the addition would be missing on the app(s) already registered with, while a later registration of the same object on another app would pick it up — i.e. the same blueprint object would behave differently per app. The flag converts that silent inconsistency into a loud, immediate error; the message states the rationale verbatim ("any changes will not be applied consistently").

It is the blueprint counterpart of the app-level guard: `Flask` tracks `_got_first_request` (`src/flask/sansio/app.py:411`) and raises a parallel `AssertionError` from `_check_setup_finished` (`sansio/app.py:413-422`). The base `Scaffold._check_setup_finished` is abstract and raises `NotImplementedError` (`scaffold.py:220-221`), so each subclass supplies its own "phase finished" predicate while the decorator supplies the enforcement. The documented reason for the app case — setup must finish before requests are served because WSGI servers spread work across workers, making consistency impossible to guarantee (`docs/lifecycle.rst:36-47`) — is the same ordering hazard the flag protects blueprints from.

**Precise scope of the latch.** It is per blueprint object and global across applications: the message says "registered at least once", and `register()` sets it unconditionally, so it is *not* "registered on this app". A blueprint registered on app A can no longer be edited even for a later, different app B. Because it is a class attribute default, it costs nothing until a registration happens. It also deliberately does not prevent registering the same blueprint multiple times, which is supported behaviour.

**Distinct from `first_registration` / `record_once`.** `BlueprintSetupState.first_registration` (`blueprints.py:58-62`) and `record_once` (`blueprints.py:233-244`) govern re-running already-recorded callbacks when a blueprint is registered on more than one app. `_got_registered_once` governs a different thing: whether new setup is allowed at all after the first registration.

**One ordering consequence (inferred, not documented or tested).** `register()` sets the flag at line 320 *before* replaying `deferred_functions` at lines 334–335, so a deferred callback that itself calls a blueprint setup method would now hit the `AssertionError`. This follows from the line ordering in the source; no test in the repo exercises it.

### What this rests on / what remains open
- Direct source: `src/flask/sansio/blueprints.py:172, 214-220, 230, 233-244, 316-335, 411+`; `src/flask/sansio/scaffold.py:42-49, 220-221`; `src/flask/sansio/app.py:411-422`.
- History/rationale: `CHANGES.rst:160-161` (2.3.0: "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`") and `CHANGES.rst:299-300` (2.2.0: it was a warning, with the note that it would become an error like the application setup methods). `docs/lifecycle.rst:36-47` gives the app-level consistency rationale.
- Not established: there is no test anywhere under `tests/` for the blueprint-specific `AssertionError` — grepping `tests/` for `_got_registered_once`, `got_registered`, `at least once` and `can no longer be called` returns nothing. The only related test is the app-level `test_no_setup_after_first_request` (`tests/test_basic.py:1679-1690`), which asserts the app message. So the blueprint behaviour is covered by implementation and changelog only, and the inference in the paragraph above is unverified.
- Evidence access: the two result handles handed to me (`28e290e2…`, `ca6827ef…`) carried no readable text in this session, and shared-memory reads on this seal return a namespace-mismatch error, so the retriever and executor findings could not be folded in. The only executed artifact visible inside the working directory, `flask_mut2_i417ar2x/mutated_test.py`, exercises subdomain matching and `url_for` and does not touch this flag, so it does not bear on the question. Verifying the `AssertionError` by running code was outside what was available to me here.
- Open part of the task: if the intent was to explain the flag's effect on a specific mutation or a specific test outcome, that part is unanswered — nothing in the evidence available to me connects the flag to a mutant or a failing test. The question as phrased (purpose of the flag) is answered above.
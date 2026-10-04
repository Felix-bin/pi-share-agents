## Answer

The flag is `Blueprint._got_registered_once`. It exists so that calling a blueprint setup method after the blueprint has been registered once fails loudly and immediately, instead of silently having no effect on the applications that already registered it.

**The flag and its lifecycle**

- Declared as a class-level boolean default, `_got_registered_once = False` — `src/flask/sansio/blueprints.py:172`, the only statement between the class docstring and `__init__` (class `Blueprint(Scaffold)` at `:119`).
- Flipped to `True` inside `Blueprint.register` — `self._got_registered_once = True` at `:320`, immediately after `app.blueprints[name] = self` (`:319`) and before the setup state is built (`:321`).
- Read inside `Blueprint._check_setup_finished` (`:213-221`) — `if self._got_registered_once:` at `:214`. That method is reached indirectly: the `@setupmethod` decorator (`src/flask/sansio/scaffold.py:42-49`) wraps every blueprint setup method with a `wrapper_func` that calls `self._check_setup_finished(f_name)` at `scaffold.py:46` before invoking the wrapped method.
- The identifier occurs exactly three times in the file (`:172`, `:214`, `:320`), so there is no second, parallel registration-tracking flag on the class.

**Purpose, as the artifact states it** — the guard raises `AssertionError` with (`blueprints.py:215-221`):

> The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently.
> Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.

**Why that is the right thing to enforce** — the blueprint's setup work is deferred and then consumed at registration, so anything recorded afterwards would never reach the app that already registered it:

- The class docstring describes blueprints as deferring "the need for an application by recording them for later registration", with decorated functions becoming "a deferred function that is called with `BlueprintSetupState` when the blueprint is registered" (`:126-131`).
- `register`'s docstring: "Called by `Flask.register_blueprint` to register all views and callbacks registered on the blueprint with the application" (`:274-277`).
- At registration time the recorded work is replayed and merged: `self._merge_blueprint_funcs(app, name)` (`:339`), `for deferred in self.deferred_functions: deferred(state)` (`:340`), and the CLI command merge (`:342-347`). A `route` decorator applied after this point would append to `deferred_functions` with nothing left to replay it into the registered app — hence "any changes will not be applied consistently".

**Scope of the block** — not one method but every blueprint setup method: `record` (`:223`), `record_once` (`:232`), `register_blueprint` (`:255`, def `:256`), `add_url_rule` (`:412`, def `:413`), the `app_template_*` / `app_*` handler families (`:444-625`), and `route` plus the HTTP-verb shortcuts inherited from `Scaffold` (`route` `scaffold.py:335-336`; `get/post/put/delete/patch` `:295-336`). With the flag set, each raises before doing any work.

**This is an enforced behaviour, not an aspiration** — `CHANGES.rst:297-299` (2.2.0) says post-registration setup "will show a warning. In the next version, this will become an error just like the application setup methods"; `CHANGES.rst:160-161` (2.3.0, Released 2023-04-25) records "Calling setup methods on blueprints after registration is an error instead of a warning."

**Verified in execution** (executor, exit 0, run against this worktree): flag reads `False` before registration and `True` after; `add_url_rule`, the `route` decorator, `before_app_request`, `record` and `register_blueprint` each raise `AssertionError` with the message quoted above, verbatim; setup performed *before* registration is unaffected; a control blueprint registers and serves normally. So the guard's runtime effect is observed, not merely inferred from source.

**Closely related flag that is not the answer** — `BlueprintSetupState.first_registration` (`:46` constructor parameter, explanation `:57-61`, assignment `:62`) is registration-related but does not gate setup methods: its only reader is `if state.first_registration: func(state)` at `:241` inside `record_once`, i.e. it only makes `record_once` callbacks idempotent across repeated registrations. If that flag was what the question meant, the answer would be "to avoid re-running one-time callbacks" — a narrower purpose than the setup-method block, which `first_registration` does not implement.

**Per-instance, deliberate** — the declaration is on the class but assignment happens on the instance in `register`, so each blueprint tracks its own registration count across multiple apps. The app-side analogue uses a different flag, `self._got_first_request = False` (`src/flask/sansio/app.py:411`, checked at `:414`, same message wording in `docs/lifecycle.rst:44-48`), with its own error text about the application having handled its first request.

### What this rests on

- Code sites re-read directly (summarizer): `blueprints.py:172`, `:213-221`, `:319-321`, `:339-347`.
- Retriever (handle `a6be021c8d14`): line-level citations for the class docstring, `register` docstring, `setupmethod`, the `@setupmethod` sites, `first_registration`, the app analogue, and the `CHANGES.rst` quotes.
- Executor (handle `b84a37b693f7`): independent line-site verification plus the executed runtime check; it also corrected two minor citation offsets (`add_url_rule` decorator `:412`/def `:413`; `_got_first_request` check `:414`) and reported that a bare `.venv` run resolves flask from a different worktree via `flask.pth`, so `PYTHONPATH=src` is required.

### Still open / uncertainty

- No in-repo test covers the blueprint guard (greps of `tests/` for `already been registered`, `no longer be called`, `_got_registered_once`, `setup_finished` are empty; `tests/test_blueprints.py` has no `AssertionError`). Only the application equivalent is tested (`test_no_setup_after_first_request`, `tests/test_basic.py:1678-1690`). The behavioural claim here therefore rests on source, error text, changelog and an ad-hoc script the executor ran, not on a repository test.
- No documentation page states the flag's purpose (`docs/` has no mention of `_got_registered_once`); the intent is read from the error message and the register-time merge it protects.
- Unless the questioner meant `BlueprintSetupState.first_registration`, in which case the intended purpose is `record_once` idempotency — both readings are answered above.
- Contradiction reported, not resolved: the retriever's ranking labelled the file `flask/src/flask/sansio/blueprints.py`, but in this worktree the path is `src/flask/sansio/blueprints.py`; all citations use the real path and were confirmed against it.
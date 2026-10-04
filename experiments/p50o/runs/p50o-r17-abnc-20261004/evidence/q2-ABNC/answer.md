# Purpose of the registration tracking flag on the blueprint collection class

The flag is **`_got_registered_once`**, a class attribute defaulting to `False` on `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:172`). Its purpose is to make the blueprint's **deferred-setup contract enforceable**: a blueprint does not apply its setup immediately — calls like `route`, `add_url_rule`, `before_request`, `record`, `record_once`, `register_blueprint` record functions that are only executed later, when `Blueprint.register` runs the blueprint against a concrete application. The flag is a one-way latch meaning "this blueprint has already been registered at least once", so that any further setup call can be rejected immediately instead of silently accepting changes that would never take effect, or would take effect inconsistently across the applications the blueprint gets registered on. The error text states this rationale directly (`blueprints.py:213-220`):

> The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, **any changes will not be applied consistently.** Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.

Because a blueprint "is a set of operations which can be registered on an application, even multiple times" and "records operations to execute when registered" (`docs/blueprints.rst:36-37,51-52,76-78`), post-registration setup is exactly the situation where the recorded-state model breaks down — hence the check rather than an unconditional failure.

**How the flag is wired**
- Set once: `self._got_registered_once = True` inside `Blueprint.register`, immediately after `app.blueprints[name] = self` (`blueprints.py:320`).
- Read once: `Blueprint._check_setup_finished` (`blueprints.py:213-220`).
- Reached by every setup method through the `setupmethod` decorator wrapper, which calls `self._check_setup_finished(f_name)` before invoking the method (`src/flask/sansio/scaffold.py:42-49`); 18 methods in `blueprints.py` carry `@setupmethod` (lines 223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624), and the base `Scaffold._check_setup_finished` is a bare `NotImplementedError` (`scaffold.py:220-221`) that `Blueprint` overrides.

**It is a latch, not a counter.** Re-registering the same blueprint on a second application still succeeds and the flag stays `True`; the deferred functions simply replay per registration (runtime check: replay count `['a1','a2']` for two apps, `record_once` running twice, once per app+name). So the flag forbids *new setup after the first registration*, not *re-registration*.

**Historical intent.** `CHANGES.rst:160-161` — "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`" — and `CHANGES.rst:297-300` gives the earlier warning-only wording ("In the next version, this will become an error just like the application setup methods"). The purpose is therefore unchanged across the two entries; only the severity was escalated from warning to `AssertionError`.

**Analogue, not the same flag.** The application class enforces the same contract with a *different* flag: `Flask._check_setup_finished` reads `_got_first_request` (`src/flask/sansio/app.py:411,414`), i.e. the blueprint flag is the registration-keyed counterpart of the app's first-request-keyed one.

## What this rests on

- `src/flask/sansio/blueprints.py:172` (declaration), `:213-220` (check + message), `:320` (write site) — re-read directly during synthesis.
- `src/flask/sansio/scaffold.py:42-49` (wrapper), `:220-221` (base `NotImplementedError`) — re-read directly.
- `CHANGES.rst:160-161,297-300` and `docs/blueprints.rst:36-37,51-52,76-78` — quoted by the retriever stage, not independently re-read here.
- Runtime behavior (post-registration `record`/`add_url_rule`/`register_blueprint` raise; second-app registration succeeds; replay per registration) comes from the executor stage's check that imported the worktree's `src/flask` via `sys.path.insert(0, "src")`.

## Still open / caveats

- **No single project sentence names the flag's "purpose."** The purpose above is assembled from the error message, the CHANGES entries and the blueprint registration contract; the parts that are verbatim sourced are the error text and the two CHANGES lines, the linking rationale is an inference.
- **No test in `tests/`** matches `_got_registered_once` or the message text (both stages grepped and found none), so the behavior is documented by implementation and changelog, not pinned by a test in this working directory.
- The runtime confirmation only holds for the worktree copy loaded via `sys.path.insert`; the repo's `.venv` resolves `flask` to an editable target outside this working directory, so an ordinary venv import would not be evidence about this tree. Plain `python -c "import flask"` fails with `ModuleNotFoundError`.
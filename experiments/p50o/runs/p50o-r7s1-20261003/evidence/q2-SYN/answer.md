## Purpose of `Blueprint._got_registered_once`

**Short answer.** It is a one-way latch that marks a blueprint's *setup phase as over*. Once the blueprint has been pulled into at least one application, its recorded setup state is frozen, so any later call to a setup method (`@bp.route`, `bp.before_request`, etc.) would be recorded but never delivered to the already-configured app — producing an app whose behaviour silently depends on registration order and timing. The flag turns that silent inconsistency into a loud `AssertionError`. It is the blueprint-side counterpart of the app-side `Flask._got_first_request` guard, and the changelog shows it was a deliberate escalation from warning to hard error.

### What the flag is and where it lives (re-verified by direct read)

The "blueprint collection class" is `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:119`). The flag has exactly three sites, all in that file:

| Site | Line | Content |
|---|---|---|
| declaration | `blueprints.py:172` | `_got_registered_once = False` (class attribute, immediately before `def __init__` at `:174`) |
| sole write | `blueprints.py:320` | `self._got_registered_once = True`, inside `Blueprint.register(app, options)` (defined `:273`) |
| sole read | `blueprints.py:214` | `if self._got_registered_once:` in `Blueprint._check_setup_finished` (`:213`) |

A repo-wide grep for `_got_registered_once` returns only those three occurrences plus `.pyc` artifacts — there is **no reset path** (only `:172` and `:320` ever assign it).

### Why registration ends the setup phase

`Blueprint.register` is called by `App.register_blueprint` and is where the blueprint stops being a *plan*: it appends `self` to `app.blueprints[name]` (`:319`), then walks `self.deferred_functions` and invokes every deferred callback with a `BlueprintSetupState` (`:333` onward). Everything a blueprint declares via `@bp.route`, `record`, `before_request`, `errorhandler`, … is stored as a deferred function and consumed at that moment. A setup call made *after* that point is stored in `deferred_functions` but never replayed, hence the error text's "any changes will not be applied consistently."

### How it is enforced

Setup methods are wrapped by `setupmethod` (`sansio/scaffold.py:42-49`), which calls `self._check_setup_finished(f_name)` before every invocation. `Scaffold._check_setup_finished` is abstract (`NotImplementedError`, `scaffold.py:220-221`); the two subclasses supply different predicates for "setup is over":

- `Blueprint`: **registered at least once** — `blueprints.py:214`.
- `Flask`: **handled its first request** — `sansio/app.py:413-414` reading `_got_first_request` (init `False` at `sansio/app.py:411`, set `True` at `app.py:911`, and *reset to `False`* in `Flask.run`'s `finally` at `app.py:667` so the dev server can restart).

That contrast is the key structural point: the app-side analogue is resettable bookkeeping, while the blueprint latch has no reset — the blueprint's setup phase is terminal.

### The error the flag produces (verbatim, `blueprints.py:214-221`)

> `The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently.`
> `Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.`

The blocked surface is every `@setupmethod`-decorated method reachable from `Blueprint`. On `Blueprint` itself: `record`, `record_once`, `register_blueprint` (nested blueprint wiring), `add_url_rule`, `app_template_filter`/`app_template_test`/`app_template_global` and their `add_*` forms, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults` (`blueprints.py:223–625`). Inherited from `Scaffold`: `route`, `get`, `post`, `put`, `delete`, `patch`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler` (`scaffold.py:295–642`) — the executor counted 33 decorated methods, 32 effective after `Blueprint` overrides `add_url_rule`.

### What the latch deliberately does *not* block (source-verified, not inference)

- `Blueprint.register` itself (`blueprints.py:273`) is **not** decorated with `@setupmethod`, so the flag never stops a blueprint being registered again. Registering one blueprint on several apps stays legal, which is why `register` computes `first_bp_registration` (`:314`) and `first_name_registration` (`:315`) and why the docs say a blueprint is "a set of operations which can be registered on an application, even multiple times" (`docs/blueprints.rst:36-37`, `:119-121`). This is why the flag is named "once" (across all apps) rather than "once per app" — inference from the code structure and docs; no maintainer sentence states it.
- `make_setup_state` (`blueprints.py:246`) is also **undecorated**, and plain attribute mutation or direct `deferred_functions.append(...)` is unguarded. So it is a guard rail on the documented setup API, not a hard freeze of the object.

### The stated rationale: warning → error (changelog)

The tree's own justification for the latch, beyond the error text:

- `CHANGES.rst` **Version 2.2.0** (header line 237; entry lines 297–300): *"Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"*
- `CHANGES.rst` **Version 2.3.0** (header line 135; entry lines 160–161): *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"*

So the flag is the predicate implementing a deliberate escalation from advisory warning to hard failure, mirroring the app-side first-request guard.

### One ordering nuance worth carrying

The write at `blueprints.py:320` happens **before** the deferred-function loop runs (`make_setup_state` at `:321`, the loop at ~`:333`). A deferred callback that calls a setup method on the *same* blueprint during registration therefore also raises. Read from source order; not separately executed.

### Executed confirmation

The executor's runtime probe (shared memory `e4d7c36a5245`) confirms all `@setupmethod` blueprint calls raise `AssertionError` after registration, while re-registering the same blueprint on a second app remains allowed — consistent with everything above. My re-read of the source agrees with that memory; no contradicting prior conclusion was found in the material recalled for this task.

---

### Rests on
- `src/flask/sansio/blueprints.py` — `:172` (declaration), `:214` (read + full error text), `:246`, `:273`, `:314-321`, `:320` (write), `:333` (deferred loop), `:119` (class decl); decorated-surface grep for `@setupmethod`.
- `src/flask/sansio/scaffold.py:42-49` (`setupmethod`), `:220-221` (abstract `_check_setup_finished`), `:295-642` (inherited decorated methods).
- `src/flask/sansio/app.py:411-414` and `src/flask/app.py:667`, `:911` (`_got_first_request` analogue: init/read/set/reset).
- `CHANGES.rst:135,160-161` (2.3.0 error), `:237,297-300` (2.2.0 warning).
- `docs/blueprints.rst:36-37,119-121` (multiple registration is supported).
- Executor runtime probe recorded as shared memory `e4d7c36a5245`; the recalled memory and its two `NOT ESTABLISHED` caveats match my verification; no contradiction between sources.

### Still open
- **No direct test coverage of this latch was found**: no file in `tests/` references `_got_registered_once` by name. This was searched, not exhaustively proven.
- **Tree provenance is identified from `CHANGES.rst`'s top header ("Version 3.2.0") plus the executor's note (Flask 3.2.0.dev); `pyproject.toml` / `__version__` were not read** — so the exact pinned dev revision is unverified.
- **The maintainers' full reasoning is not quotable from this tree**: issue `4571` and PR `4997` are referenced by number only, and no prose explains why the predicate is "at least once" (any app) rather than "exactly once" (per app) — that part of the answer is labelled inference.
- Earlier planning line numbers for `make_setup_state` and the `route`/`before_request` family were **wrong as written** (those methods live in `scaffold.py`, and `make_setup_state` at `:246` is undecorated); they are not carried into this answer.
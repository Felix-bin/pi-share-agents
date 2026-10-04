## Purpose of `_got_registered_once` in `Blueprint`

The flag is `Blueprint._got_registered_once`, declared as a class attribute defaulting to `False` at `src/flask/sansio/blueprints.py:172` on the blueprint collection class (`Blueprint`, a `Scaffold` subclass). Its purpose is to mark the end of a blueprint's **setup phase**: once the blueprint has been registered at least once, further calls to its setup methods are refused, because registration has already copied the blueprint's registries into the application and consumed its deferred setup functions, so anything added later would silently not take effect.

The flag is the state; the guard that reads it is `Blueprint._check_setup_finished` (`blueprints.py:213`), which raises when the flag is truthy:

```
The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'.
It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
```

The message itself states the design intent: *setup must precede registration*. Every `@setupmethod`-decorated method is funnelled through that guard by `setupmethod` (`src/flask/sansio/scaffold.py:42`), whose wrapper calls `self._check_setup_finished(f_name)` before invoking the real method. On `Blueprint` that covers `record`, `record_once`, `register_blueprint`, `add_url_rule`, `app_template_filter`/`test`/`global`, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults`, plus the shared `Scaffold` methods such as `route`/`get`/`post`.

Why registration is the point of no return: `register()` sets `self._got_registered_once = True` (`blueprints.py:320`) immediately after `app.blueprints[name] = self`, and then calls `make_setup_state(...)`, `_merge_blueprint_funcs(app, name)` — which copies `view_functions`, before/after-request functions, error handlers and so on into the app — and finally loops over `self.deferred_functions`, the list that `record()` appends to. After that loop the blueprint's own registries are no longer what drives the app. The consistency concern is sharpened by the fact that a single blueprint can be registered on more than one app or under more than one name (`first_bp_registration` / `first_name_registration`, `blueprints.py:315–316`): late mutation would apply to some registrations and not others.

The behaviour has a documented history in `CHANGES.rst`: setup calls after registration first produced a warning (`:issue:`4571``, ~line 297) and were then made a hard error (`:pr:`4997``, ~line 160). The same pattern exists app-side: `Flask._got_first_request` (`src/flask/sansio/app.py:411`) with a parallel `_check_setup_finished`.

Runtime confirmation (executor, against this working tree via `PYTHONPATH=src`): after `app.register_blueprint(bp)`, `bp._got_registered_once` is `True` and `bp.route`, `bp.record`, `bp.add_url_rule`, `bp.before_app_request` each raise the AssertionError above; a fresh, unregistered blueprint performs the same calls successfully and appends to `deferred_functions`.

### What this rests on / what is open
- Rests on: `blueprints.py:172`, `213–221`, `318–331`; `scaffold.py:42–49`; `app.py:411`; `CHANGES.rst` entries for `:issue:`4571`` and `:pr:`4997``; the executed runtime check and `tests/test_blueprints.py` (60 passed).
- Open / not established: no in-tree test or prose independently names the blueprint flag or spells out the multi-registration consistency rationale — `grep` for `_got_registered_once`, `_check_setup_finished` and the message text finds no match under `tests/`, and only `tests/test_basic.py:1683` covers the app-side analogue. The "why consistency matters across repeated registration" wording is an inference from the code, not a quoted rationale (the AssertionError text is the closest in-code statement). Also note the check had to be pointed at the working copy explicitly, because this venv's installed `flask` resolves outside the working tree; a bare `pytest`/`import flask` here would exercise a different copy.
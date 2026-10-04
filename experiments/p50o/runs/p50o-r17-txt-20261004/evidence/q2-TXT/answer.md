## Answer

The registration-tracking flag is **`Blueprint._got_registered_once`**, defined as a class attribute defaulting to `False` at `src/flask/sansio/blueprints.py:172`. It exists to catch **out-of-order setup**: a blueprint's setup is deferred, so its decorators only *collect* work (closures in `deferred_functions` via `record()`/`record_once()`, plus writes into the Scaffold dicts `view_functions`, `error_handler_spec`, `before_request_funcs`, …), and that collected state is pushed onto an application only inside `Blueprint.register()`. `register()` therefore flips `self._got_registered_once = True` (`:320`), and every `@setupmethod`-decorated method calls `_check_setup_finished()` first (`src/flask/sansio/scaffold.py:42-49`, call at `:46`), which raises `AssertionError` once the flag is set. The point is what the message itself says: after registration the deferred callbacks have already been drained and `_merge_blueprint_funcs()` has already run, so **"any changes will not be applied consistently"** — an app that already registered the blueprint would never see the new route/handler, while a later registration under another name would, making the same blueprint mean different things in different applications/workers. It is the blueprint counterpart of `Flask._got_first_request`, which blocks app setup after the first request is dispatched.

## Supporting evidence (verbatim, with anchors)

**1. The flag and the guard.** `src/flask/sansio/blueprints.py:172` — the only default assignment in the repo (grep `_got_registered_once` yields exactly three hits: 172, 214, 320, all in this file):

```python
    _got_registered_once = False
```

`src/flask/sansio/blueprints.py:213-221` — the guard, whose message states the rationale:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```

**2. Every setup method is routed through it.** `src/flask/sansio/scaffold.py:42-49` (with the abstract declaration at `src/flask/sansio/scaffold.py:220-221`, `raise NotImplementedError`):

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

The decorated methods include `route`, `get/post/put/delete/patch`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `endpoint`, `register_error_handler` (Scaffold), and on `Blueprint` `record`, `record_once`, `register_blueprint`, `add_url_rule`, the `app_template_*` and `*_app_request` / `app_*` hooks. `Blueprint.register` (line 273) is deliberately not decorated.

**3. Why post-registration changes become inconsistent.** `src/flask/sansio/blueprints.py:306-335` — the flag is set inside `register()`, while the merge/drain only happen on first registration:

```python
        if name in app.blueprints:
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(
                f"The name '{self_name}' is already registered for"
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )

        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
        first_name_registration = name not in app.blueprints

        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)
...
        # Merge blueprint data into parent.
        if first_bp_registration or first_name_registration:
            self._merge_blueprint_funcs(app, name)

        for deferred in self.deferred_functions:
            deferred(state)
```

**4. It is not a duplicate-registration guard.** Registering the same blueprint again with a unique `name=` stays legal — `tests/test_blueprints.py:992-1008` pins exactly this, with a *separate* `ValueError` for name collisions:

```python
def test_unique_blueprint_names(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp", __name__)

    app.register_blueprint(bp)

    with pytest.raises(ValueError):
        app.register_blueprint(bp)  # same bp, same name, error

    app.register_blueprint(bp, name="again")  # same bp, different name, ok
```

**5. Empirical confirmation (local probe, run against `src/`; temp file deleted).** Verbatim output:

```
flag after register: True
AssertionError: The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
deferred_functions now: 2
app.url_map has /late: False
app2.url_map has /late: True
```

The probe bypassed the flag only to expose the failure mode: the already-registered app #1 never gets the late route, while app #2 (a later registration under `name="again"`) does — the concrete meaning of "changes will not be applied consistently". The full suite also passed twice: `489 passed`.

**6. Version history.** `CHANGES.rst:297-300` (an earlier release) introduced it as a warning: *"Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"*; `CHANGES.rst:160-161` (Version 2.3.0) upgraded it: *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"*. The app-side analogue is `Flask._got_first_request` (`src/flask/sansio/app.py:411`, guard `:413-423`, set at `src/flask/app.py:911`, reset at `:667`).

## Uncertainty

`grep` shows `_got_registered_once` appears only in `src/flask/sansio/blueprints.py`, and the exact blueprint error text is asserted by **no test** in this snapshot (only the app-side guard has one, `tests/test_basic.py:1678`), so the behaviour rests on the source plus the probe. The multi-worker/multi-app rationale appears only in `docs/lifecycle.rst:34-40`, which documents the **application** guard and is offered here as the same design idea by analogy, not as a quoted design statement about the blueprint flag. Also, despite the question's phrasing "blueprint collection class," there is no separate collection/registry class: `Blueprint` self-describes as "a collection of routes and other app-related functions" (`:119-121`) and `app.blueprints` is merely a `dict[str, Blueprint]` (`src/flask/sansio/app.py:377`). A written artifact with these quotes and citations is saved at `answer.md`; no file under `src/` was modified.
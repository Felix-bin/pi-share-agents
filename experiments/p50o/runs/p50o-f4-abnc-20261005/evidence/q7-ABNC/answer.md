## Purpose of the registration-tracking flag

The flag is `Blueprint._got_registered_once`, declared as a class attribute `False` at `src/flask/sansio/blueprints.py:172` in the class whose own docstring calls it "a collection of routes and other app-related functions" (`blueprints.py:120-122`) — that is the only registration-tracking flag on a blueprint-like class in this repository, so the question's "blueprint collection class" resolves to `Blueprint`.

Its purpose is a **misuse guard**: once a blueprint has been registered on at least one application, its deferred setup (`record`-ed) functions have already been consumed for that application, so any further setup call would take effect only for applications registered *later* and never for the ones already registered. The flag makes that inconsistent state impossible to reach silently by turning late setup calls into a hard error instead of a partial change.

### How it works

- `register()` sets the flag at `blueprints.py:320` — `self._got_registered_once = True` — immediately after `app.blueprints[name] = self`, and *before* the loop that runs the deferred setup functions (`for deferred in self.deferred_functions: deferred(state)`). So the flag is on for the duration of registration and stays on permanently; there is no code path that resets it (a blueprint cannot be "unregistered").
- Setup methods are wrapped by the `setupmethod` decorator (`src/flask/sansio/scaffold.py:42-48`), which calls `self._check_setup_finished(f_name)` before executing the method body. The base `Scaffold._check_setup_finished` raises `NotImplementedError` (`scaffold.py:220-221`); `Blueprint` overrides it (`blueprints.py:213-221`):

  ```
  if self._got_registered_once:
      raise AssertionError(
          f"The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'."
          " It has already been registered at least once, any changes will not be applied"
          " consistently.\nMake sure all imports, decorators, functions, etc. needed to set up"
          " the blueprint are done before registering it."
      )
  ```

  The message itself states the rationale: changes after registration "will not be applied consistently".
- Methods carrying `@setupmethod` in `blueprints.py` and therefore guarded: `record` (224), `record_once` (233), `register_blueprint` (255), `add_url_rule` (413), `app_template_filter` / `app_template_test` / `app_template_global` (444 / 478 / 516), `before_app_request` (553), `after_app_request` (563), `teardown_app_request` (574), `app_context_processor` (584), `app_errorhandler` (596), `app_url_value_preprocessor` (613), `app_url_defaults` (625). Because the flag is a plain instance-state check, subclasses of `Blueprint` inherit the behaviour.

### Why the check exists rather than just ignoring the call

The flag is the blueprint-level counterpart of the application-level `Flask._got_first_request` check (`src/flask/sansio/app.py:413-425`, same "any changes will not be applied consistently" wording). The shared design intent is that setup is a one-phase operation: all decorators, imports and functions must be in place before the object is handed to the app, because registration copies recorded state out of the blueprint (`app.blueprints[name] = self`, `_merge_blueprint_funcs`, then running each deferred function) and that copy is not re-synchronised afterwards.

### Recorded history of the behaviour

- 2.2 (`CHANGES.rst:297-300`): "Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"
- 2.3 (`CHANGES.rst:160-161`): "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"

So the flag's strictness is deliberate escalation from warning to `AssertionError`, made to match the app-level rule.

## Basis and open items

What this rests on:
- `src/flask/sansio/blueprints.py:120-122` (class docstring), `:172` (flag), `:213-221` (check and message), `:320` (set in `register()`), and the `@setupmethod` sites listed above.
- `src/flask/sansio/scaffold.py:42-48` (decorator wiring) and `:220-221` (abstract base).
- `src/flask/sansio/app.py:413-425` (app-level analogue).
- `CHANGES.rst:160-161` and `:297-300` (behaviour change history).

Verification status and gaps:
- The planner and retriever results referenced as handles `574af6af…` and `47bba2b…` could **not** be retrieved — every `synapse_read` call returned a namespace-mismatch error (the shared state directory belongs to a different seal namespace). The conclusions above therefore rest on my own reading of the working tree, not on those two artifacts; no executor result exists for this task (skipped by the complexity gate), so nothing here is backed by an executed test run.
- No test in this tree asserts the blueprint-level `AssertionError`: a search for `AssertionError` in `tests/test_blueprints.py` returns no matches. The parallel app-level guard is tested (`tests/test_basic.py:1678-1690`, `test_no_setup_after_first_request`, asserting `"setup method 'add_url_rule'"`). So the blueprint behaviour is established from source and changelog, but is not covered by an in-repo test I could point to.
- Writing the same conclusion to shared memory was refused with the same namespace mismatch, so it was not persisted.
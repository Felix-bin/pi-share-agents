## Purpose of `Blueprint._got_registered_once`

The flag is a one-way latch that marks a blueprint as "already registered with an app," so that any further *setup* call on it fails loudly instead of silently having no effect. Concretely:

**(a) It flips once, inside `register`.** `_got_registered_once = False` is declared as a class attribute of `Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:172`; class begins at `:119`). The only assignment that writes it is `self._got_registered_once = True` at `src/flask/sansio/blueprints.py:320`, inside `Blueprint.register(self, app, options)` (def at `:273`) — the method invoked by `Flask.register_blueprint` (`src/flask/sansio/app.py:594`). The write happens right after `app.blueprints[name] = self` (`:319`) and *before* `self._merge_blueprint_funcs(app, name)` (`:326-328`) and the `for deferred in self.deferred_functions: deferred(state)` loop (`:331-332`), so the blueprint is locked at the moment its setup work begins being applied. Nothing in the worktree ever resets it to `False` (the app-side analogue `App._got_first_request` *is* reset, `src/flask/app.py:667`; the blueprint flag is not).

**(b) It is read in exactly one place, which raises.** `Blueprint._check_setup_finished` (`src/flask/sansio/blueprints.py:213-221`) is the flag's only reader (`:214`):

```
if self._got_registered_once:
    raise AssertionError(
        f"The setup method '{f_name}' can no longer be called on the blueprint"
        f" '{self.name}'. It has already been registered at least once, any"
        " changes will not be applied consistently.\n"
        "Make sure all imports, decorators, functions, etc. needed to set up"
        " the blueprint are done before registering it."
    )
```

This base hook is invoked for every setup method by the `@setupmethod` decorator in `src/flask/sansio/scaffold.py:42-49`, whose wrapper calls `self._check_setup_finished(f_name)` before delegating to the wrapped function. That is what makes the flag effective across the whole class: all `@setupmethod` members of `Blueprint` (`record`, `record_once`, `register_blueprint`, `add_url_rule`, the `app_template_*` / `before_app_request` / `app_errorhandler` family, `src/flask/sansio/blueprints.py:223-625`) and the inherited `Scaffold` setup methods (`route`, `before_request`, `after_request`, `teardown_request`, `errorhandler`, …) route through the same guard. `register` itself is deliberately *not* decorated with `@setupmethod`, so a blueprint can still be registered again on another app (under a unique name) after the first registration.

**(c) The purpose is consistency for too-late changes.** The rationale is stated in the raise message itself (`src/flask/sansio/blueprints.py:217-218`): "It has already been registered at least once, any changes will not be applied consistently." Once registration has run, the blueprint's functions have been merged into the app and its deferred functions have been executed, so a decorator or `record` call made afterwards would either never reach the already-built app or reach it only partially. Rather than allow that, the flag turns it into an immediate `AssertionError` that tells the user to finish imports/decorators/setup before registering.

**Historical form of the same purpose.** `CHANGES.rst:160-161` (Version 2.3.0) records: "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`". The preceding behaviour is recorded at `CHANGES.rst:297-300` (Version 2.2.0): setup after registration produced a warning, with the noted intent to "become an error just like the application setup methods" (`:issue:`4571`). The flag carried both phases; the current source raises.

**What it does *not* do.** It is not duplicate-registration detection. Registering the same blueprint name twice is rejected by a separate, per-app check on `app.blueprints`: the `ValueError` at `src/flask/sansio/blueprints.py:294-303`. The flag is keyed to the blueprint instance and to "at least once" on *any* app — the message says so explicitly.

**Terminology note.** "Blueprint collection class" resolves to `Blueprint` itself; its own docstring calls it "a collection of routes and other app-related functions that can be registered on a real application later" (`src/flask/sansio/blueprints.py:120-121`). No class named `*Collection*` or `BlueprintGroup` exists in the worktree, and the public `flask.blueprints.Blueprint` (`src/flask/blueprints.py:18`) merely subclasses the `sansio` class and inherits both the flag and its guard.

---

**Rests on**
- `src/flask/sansio/blueprints.py` — declaration `:172`, class + docstring `:119-121`, guard `:213-221`, duplicate-name `ValueError` `:294-303`, `register` def `:273`, merge/deferred order `:319-332`, guarded methods `:223-625`.
- `src/flask/sansio/scaffold.py:42-49` — `setupmethod` wrapper calling `_check_setup_finished`.
- `src/flask/sansio/app.py:594` — `register_blueprint` body invoking `blueprint.register`.
- `CHANGES.rst:160-161` (2.3.0, error instead of warning) and `:297-300` (2.2.0, warning-only).
- Re-verified directly by reading the flag, guard, write site, decorator wrapper, class docstring and both changelog entries.

**Still open**
- The linked issue/PR texts (`:pr:4997`, `:issue:4571`) were not read; only the one-line changelog summaries are established.
- No test in `tests/` was found that asserts the blueprint-side `AssertionError`, so the behaviour's protection by the suite is not established from this worktree (the guard itself is intact at all three sites).
- `flask_mut2_i417ar2x/mutated_test.py` exists in the worktree but exercises subdomain matching, not the registration flag, and its provenance cannot be determined from files inside the worktree; it does not affect this answer.
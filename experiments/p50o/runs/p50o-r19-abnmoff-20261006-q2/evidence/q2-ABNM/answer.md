## Purpose of `_got_registered_once`

The flag is `Blueprint._got_registered_once`, a class attribute defaulting to `False` on `Blueprint` — the class whose own docstring describes it as "a collection of routes and other app-related functions that can be registered on a real application later" (`src/flask/sansio/blueprints.py:119-122`, flag at `src/flask/sansio/blueprints.py:172`). It records whether a given blueprint instance has been registered on an app at least once.

Its stated purpose is to stop setup after registration, because registration has already consumed the blueprint's deferred setup work, so anything added afterwards would apply inconsistently. This is the rationale written into the error the flag triggers. The only read site is `Blueprint._check_setup_finished`, which raises when the flag is set (`src/flask/sansio/blueprints.py:213-221`):

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

The only write site is inside `Blueprint.register` (`src/flask/sansio/blueprints.py:320`), where `self._got_registered_once = True` is set immediately before `state = self.make_setup_state(...)` and the deferred callbacks are run: `for deferred in self.deferred_functions: deferred(state)` (`src/flask/sansio/blueprints.py:334-335`). That ordering is the mechanism behind the message's claim: by the time the flag flips, the deferred functions have been/reached for calling, so further recorded setup would not be picked up consistently.

How the flag actually blocks a method: every setup method is wrapped by `@setupmethod`, whose wrapper calls `self._check_setup_finished(f_name)` before the real body (`src/flask/sansio/scaffold.py:41-49`). The base `Scaffold._check_setup_finished` is abstract and only `raise NotImplementedError` (`src/flask/sansio/scaffold.py:220-221`); `Blueprint` supplies the override above, so the chain is `@setupmethod` → `Blueprint._check_setup_finished` → `AssertionError`. Seventeen `Blueprint` methods carry the decorator, including `record`, `record_once`, `register_blueprint`, `add_url_rule`, the `app_template_*`/`add_app_template_*` families, `before_app_request`/`after_app_request`/`teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, and `app_url_defaults` (each decorator line quoted in the evidence: `:223`, `:232`, `:255`, `:412`, `:443`, `:460`, `:477`, `:496`, `:515`, `:534`, `:553`, `:563`, `:573`, `:583`, `:595`, `:612`, `:624`). Notably `register` itself is not decorated, so the flag gates setup calls rather than preventing a second registration (registration is instead guarded by the name-collision `ValueError` at `src/flask/sansio/blueprints.py:303-313`).

Two qualifications on the "prevents setup after registration once" reading:

- Set once, never cleared. A grep for `_got_registered_once` across the worktree returns exactly three hits, all in `src/flask/sansio/blueprints.py` — the class-level default `False` at `:172`, the read at `:214`, and the write `True` at `:320`. There is no instance-level reset, no `del`, and no reference in any test, doc, or other file. So the value only transitions default-`False` → `True`.
- This is the error form of a rule that was previously a warning: `CHANGES.rst:160-161` records "Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`", and the earlier warning behaviour is documented at `CHANGES.rst:297-300` ("Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error…"). The same design exists app-side as `Flask._got_first_request` (`src/flask/sansio/app.py:411-412`), with an analogous `AssertionError` message ("It has already handled its first request, any changes will not be applied consistently", `src/flask/sansio/app.py:413-421`).

**Scope note on the task's phrasing.** "The blueprint collection class" is not an identifier in the code; there is no class named `*Collection*`. The identification rests on the `Blueprint` docstring's "a collection of routes and other app-related functions" (`:120-122`). The shared base `Scaffold` is ruled out because it holds no such flag and its `_check_setup_finished` only raises `NotImplementedError` (`scaffold.py:220-221`).

### What this rests on / what is open

- Rests on: the flag's three occurrences (`blueprints.py:172`, `:214`, `:320`) read directly; the verbatim `AssertionError` message (`:213-221`); the deferred-function loop (`:334-335`); the `setupmethod` wrapper (`scaffold.py:41-49`) and abstract base (`scaffold.py:220-221`); the changelog entries (`CHANGES.rst:160-161`, `:297-300`); the app-side analogue (`app.py:411-421`).
- Open: no test asserts this message — a grep for the message text under `tests/` returns no matches, so the behaviour is documented by source and `CHANGES.rst` only, not confirmed by an executable check.
- Open: no git-level diff was possible in this workflow, so byte-identity of the flag region with the unmutated source was not certified by a diff. The conclusion is drawn from the quoted lines themselves (all three assignment/read sites accounted for), not from upstream memory. The mutation sandbox present in the tree (`flask_mut2_i417ar2x/mutated_test.py`) concerns subdomain matching and does not reference blueprints, the flag, `_check_setup_finished`, or `setupmethod`.
## Answer

`Blueprint._got_registered_once` is a fail-fast latch that makes a blueprint **immutable for setup purposes** once `Blueprint.register()` has replayed it into *any* application. It exists because a blueprint is not a live app but a **recorded plan**: setup calls append closures to `self.deferred_functions`, which are executed later, per registration (`blueprints.py:334-335`). The flag is declared as a class attribute at **`src/flask/sansio/blueprints.py:172`** (`_got_registered_once = False`), read at **`:214`** by `_check_setup_finished`, and set at **`:320`**, immediately after `app.blueprints[name] = self` and before the deferred replay. Every `@setupmethod`-decorated method (`scaffold.py:42-49`) calls `self._check_setup_finished(f_name)` before doing any work, so once the latch flips those methods raise `AssertionError` — the purpose being that any change made after the first replay would land in later mounts but never in the earlier one, i.e. "any changes will not be applied consistently". Crucially it blocks **mutation, not re-registration**: `register()` itself is not `@setupmethod`, so the same blueprint may still be mounted again under a different name/prefix.

## Minimal supporting quotes (all re-verified by me in this checkout)

Declaration — `src/flask/sansio/blueprints.py:172`, inside `class Blueprint(Scaffold)` (opens `:119`; docstring: *"a collection of routes and other app-related functions that can be registered on a real application later"*):
```python
    _got_registered_once = False
```

Check — `blueprints.py:213-221` (verbatim source):
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
Exact runtime message (executor repro check 2b proved it byte-for-byte equal to the source literal above):
```
The setup method 'get' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
```

Set — `blueprints.py:319-320`:
```python
        app.blueprints[name] = self
        self._got_registered_once = True
```

Wiring — `src/flask/sansio/scaffold.py:42-49`:
```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

**Blocks mutation, not re-registration** — `Blueprint.register` at `blueprints.py:273` carries no `@setupmethod`; executor repro 3a/3b: after the latch, `app.register_blueprint(bp, name="again")` succeeds → `app.blueprints == ['again', 'bp']`. Corroborated by `tests/test_blueprints.py:994-1008` (`test_unique_blueprint_names`): *"same bp, same name, error"* / *"same bp, different name, ok"*. Hence the name "…_once" and the wording *"at least once"*.

**History (warning → error)** — `CHANGES.rst:297-300`, Version 2.2.0 (released 2022-08-01): *"Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"* → `CHANGES.rst:160-161`, Version 2.3.0 (released 2023-04-25): *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"*.

**Do not conflate with the look-alike flags:** `BlueprintSetupState.first_registration` is recomputed per `register()` call (`:316`, `not any(bp is self for bp in app.blueprints.values())`) and consumed by `record_once` (`:241`); `Flask._got_first_request` is a pure instance attribute (`sansio/app.py:411`), flips on the first served request (`src/flask/app.py:911`), is **reset** in `Flask.run`'s `finally` (`app.py:667`), and produces a *different* message (*"has already handled its first request"*). Only that app-side guard is written up in `docs/lifecycle.rst:36-57`.

**Provenance:** checkout `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, `pyproject.toml` `version = "3.2.0.dev"`, editable install via `.venv/Lib/site-packages/flask.pth` → `…\flask-src\src`. Empirical backing: `experiments/data/flask-src-scratch/repro_blueprint_setup_guard.py.run2-patched` — **22/22 PASS, exit 0** — plus full suite 489 passed twice. Upstream has **no test** for this guard (grep over `tests/`+`docs/`: zero hits); the app-side analogue is covered by `tests/test_basic.py::test_no_setup_after_first_request`.

## Sentence-by-sentence audit

| Retained sentence | Citation | Verdict |
|---|---|---|
| fail-fast latch making blueprint immutable for setup | `blueprints.py:172/214/320` + repro 8a/8a2 | ✓ |
| blueprint = recorded plan replayed per registration | `blueprints.py:334-335`, `add_url_rule` → `self.record` (`:230`, `:412-441`) | ✓ |
| declared `:172`, read `:214`, set `:320` | grep `_got_registered_once` src/ = exactly those 3 source hits; independently re-read by me | ✓ |
| `@setupmethod` calls `_check_setup_finished` before the method | `scaffold.py:42-49` (re-read) | ✓ |
| error text verbatim | `blueprints.py:216-218` + repro 2b byte-for-byte | ✓ |
| blocks mutation not re-registration | `register` unguarded (`:273`), repro 3a/3b, `test_unique_blueprint_names` | ✓ |
| warning→error history | `CHANGES.rst:297-300`, `:160-161` | ✓ |
| second different app cannot reopen setup (flag not app-scoped) | repro 5a | ✓ |
| `first_registration` / `_got_first_request` are different flags | `:316`/`:241`; `sansio/app.py:411`, `app.py:911`, `app.py:667` | ✓ |
| Drift corrections retained: `register` spans 273-377 (not 289-390), `Blueprint.register_blueprint` at 255-270 (not 191-201), `first_registration` assigned at `:62`; flag declared on the **sansio** class, public `flask.Blueprint` merely inherits it; `flask.__version__` does not exist in 3.2.0.dev | executor §J, repro 8a | ✓ flagged |

**Traps checked and rejected:** not "prevents duplicate routes"; not "prevents registering twice" (contradicted by repro 3a/3b); not "thread-safety"; not "the flag is on the app"; not "makes blueprints permanently unmodifiable" (subclasses may override `_check_setup_finished`, base `scaffold.py:220-221`).

### Explicitly not claimed
- Not claimed: prevents duplicate routes / prevents registering twice / is thread-safety / lives on the app.
- Not claimed: documented in `docs/lifecycle.rst` (that text is about `_got_first_request`) or covered by upstream tests.
- Not claimed: blueprints can *never* be modified after registration.
- Not claimed: the flag is per-app (repro 5a shows the opposite) or that it has any reset path (sole writer is `blueprints.py:320`).
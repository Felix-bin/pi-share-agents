## Purpose of `_got_registered_once`

`Blueprint._got_registered_once` is a **one-way latch that freezes a blueprint into an immutable setup source the moment it has been handed to at least one app.** It exists to enforce ordering: all imports, decorators, routes, and handlers must be defined *before* `register_blueprint()` is called, never after. Any setup call made once the blueprint is registered raises `AssertionError`.

The reason it's worded "**registered at least once**" (rather than "first request", like the app analogue) is that one blueprint can legitimately be registered on several apps, and multiple times per app under different names/prefixes — so the guard must trip at the first handoff, not be tied to request handling.

## The mechanism, verified in the worktree

| Piece | Location |
|---|---|
| Class-level default `_got_registered_once = False` | `src/flask/sansio/blueprints.py:172` |
| Read + raise in `_check_setup_finished` | `src/flask/sansio/blueprints.py:213-221` (read at `:214`) |
| Flip to `True` inside `Blueprint.register` | `src/flask/sansio/blueprints.py:320` |
| Enforcement wrapper `setupmethod` | `src/flask/sansio/scaffold.py:42-49` (calls at `:46`) |
| Abstract base hook | `src/flask/sansio/scaffold.py:220-221` |
| Application analogue `_got_first_request` | `src/flask/sansio/app.py:413-423` (flag set at `:411`) |

The check itself:

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
(`src/flask/sansio/blueprints.py:213-221`)

And the flip happens at the point of handoff, **before** any deferred work runs:

```python
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
(`src/flask/sansio/blueprints.py:319-335`)

The guard is injected centrally by the decorator, not written into each method body:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```
(`src/flask/sansio/scaffold.py:42-49`)

Because it lives in the wrapper, **every** mutating blueprint method is covered uniformly. A grep of `@setupmethod` in `blueprints.py` returns exactly **17** decorated methods — lines `223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624` (i.e. `record`, `record_once`, `make_setup_state`, `route`, `add_url_rule`, `before_request`, `after_request`, `teardown_request`, `errorhandler`, `app_errorhandler`, `register_error_handler`, `register_blueprint`, `app_template_filter`, `add_app_template_filter`, `context_processor`, `url_value_preprocessor`, `url_defaults`). Note: the plan text said "16 occurrences" but then listed 17 line numbers — the true count is **17**; the enumeration was correct, the tally was off by one.

## The concrete inconsistency it prevents

Flask replays `deferred_functions` on *every* registration (`for deferred in self.deferred_functions: deferred(state)` at `blueprints.py:334-335`), but merges a blueprint's functions into the app only on the first blueprint/name registration (`if first_bp_registration or first_name_registration: self._merge_blueprint_funcs(app, name)` at `blueprints.py:331-332`). Moreover `record_once` only fires on the first registration:

```python
def wrapper(state: BlueprintSetupState) -> None:
    if state.first_registration:
        func(state)
```
(`src/flask/sansio/blueprints.py:240-244`)

So a mutation performed *after* registration would be appended to `deferred_functions` / `view_functions` / `error_handler_spec` and only reach **future** registrations — already-registered apps would silently diverge. That is precisely the phrase in the assertion, `"any changes will not be applied consistently"` (`blueprints.py:217-218`).

## Why "at least once" (multi-registration is legitimate)

The multi-registration machinery confirms the latch must not be a "first and only" guard:

- `BlueprintSetupState` documents it explicitly — `first_registration`: *"as blueprints can be registered multiple times with the application and not everything wants to be registered multiple times on it, this attribute can be used to figure out if the blueprint was registered in the past already"* (`blueprints.py:58-62`).
- Duplicate names are rejected only for the *same* name (`blueprints.py:306-314`).
- Tests exercise it directly: `app.register_blueprint(bp)` then `app.register_blueprint(bp, name="again")` is fine, while same-name re-registration errors (`tests/test_blueprints.py:998-1008`).

## Relation to the app analogue

`App._check_setup_finished` uses the identical message shape but keyed on `_got_first_request`:

```python
def _check_setup_finished(self, f_name: str) -> None:
    if self._got_first_request:
        raise AssertionError(
            f"The setup method '{f_name}' can no longer be called"
            " on the application. It has already handled its first"
            " request, any changes will not be applied"
            " consistently.\n"
            ...
```
(`src/flask/sansio/app.py:413-423`)

The blueprint guard is the same philosophy, applied **earlier in the lifecycle** — at registration rather than at first request (`tests/test_basic.py:1678-1690` covers the app-side case; `tests/test_blueprints.py:1001-1003` the blueprint-side).

## Caveat worth noting

The default is declared at **class scope** (`blueprints.py:172`), while the flip at `blueprints.py:320` is an **instance** assignment (`self._got_registered_once = True`). So each `Blueprint` instance latches itself independently; the class attribute serves only as the shared "not yet registered" default. Also, because enforcement lives in the `setupmethod` wrapper rather than the method bodies, calling an undecorated path directly would bypass the check — the guard is a decorator-level contract, not a runtime-enforced invariant on the data structures.

## Bottom line

The flag is an **order-enforcing latch**: define the blueprint fully first, register it last. `_check_setup_finished` — invoked through the `setupmethod` decorator on all 17 mutating blueprint methods — raises `AssertionError` on any post-registration setup call, guaranteeing that every present and future registration of that blueprint applies an identical, complete configuration, while still permitting the legitimate re-registration of the same blueprint under different names/prefixes that the "at least once" wording accommodates.
## How `Blueprint.add_url_rule` defers instead of registering

The mechanism is a closure passed to `record`, not a call to the state. `Blueprint.add_url_rule` (`src/flask/sansio/blueprints.py:413`, decorated `@setupmethod`) does only two things eagerly, and neither needs an application or a setup state:

1. **Two pure-validation guards** (lines 426–431), the only work performed before deferring:

```python
if endpoint and "." in endpoint:
    raise ValueError("'endpoint' may not contain a dot '.' character.")

if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
    raise ValueError("'view_func' name may not contain a dot '.' character.")
```

2. **It builds an anonymous function and stores it** (lines 433–440), passing it to `self.record`:

```python
self.record(
    lambda s: s.add_url_rule(
        rule,
        endpoint,
        view_func,
        provide_automatic_options=provide_automatic_options,
        **options,
    )
)
```

The method never calls a setup-state method at this point — `s` exists only as the lambda's parameter. `BlueprintSetupState.add_url_rule` (line 87) is the method that actually reaches an application: it prefixes `self.url_prefix`, defaults `subdomain`, derives the endpoint via `_endpoint_from_view_func`, and calls `self.app.add_url_rule(rule, f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."), view_func, defaults=defaults, **options)`. Invoking it at definition time is impossible because no state and no app exist yet.

**Where the lambda goes.** `Blueprint.record` (line 224, also `@setupmethod`) has a one-line body — `self.deferred_functions.append(func)` (line 230) — and its own docstring states the contract: the function "is called with the state as argument as returned by the :meth:`make_setup_state` method." The list is typed `list[DeferredSetupFunction]` where `DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]` (line 17), and initialized empty at line 204.

**Where it runs.** `Blueprint.register` first creates the state — `state = self.make_setup_state(app, options, first_bp_registration)` (line 321) — then drains the list (lines 334–335):

```python
for deferred in self.deferred_functions:
    deferred(state)
```

Each call replays the stored lambdas with the live state, at which point the rule is inserted into the application. This is the whole deferral: validation now, insertion later, with the exact `rule`/`endpoint`/`view_func`/`provide_automatic_options`/`**options` captured in the closure.

**It is deferral by necessity, not a blanket rule.** Inside the same `register` method the blueprint's static route is registered by calling `state.add_url_rule(...)` directly (lines 323–328, `endpoint="static"`), bypassing `deferred_functions` entirely — because `register` already holds a state. The blueprint's own docstring (lines 130–141) gives the design intent: a blueprint "allows defining application functions without requiring an application object ahead of time … it defers the need for an application by recording them for later registration."

**Runtime confirmation (executor, Python 3.13.9, venv resolving `flask` to this worktree's `src/`).** After `bp.add_url_rule("/thing", endpoint="thing", view_func=view)` on a `Blueprint("bp", __name__, url_prefix="/pfx")`, `deferred_functions` went `[]` → length 1, and the single entry's `__qualname__` was `Blueprint.add_url_rule.<locals>.<lambda>` — the anonymous closure is stored uninvoked. The pre-existing app's `url_map` held only `/static/<path:filename>` (a fresh `Flask` app is never literally empty; the plan's "empty `url_map`" wording does not hold, but absence of the blueprint rule does). After `app.register_blueprint(bp)` the rules were `[('/pfx/thing', 'bp.thing'), ('/static/<path:filename>', 'static')]`, showing both the blueprint `url_prefix` and the endpoint prefixing from `BlueprintSetupState.add_url_rule`. The list is appended to but **never drained**: length stayed 1 after a second registration, yet both apps received the rule — every `register` replays the same stored functions. And `register_blueprint(bp, url_prefix="/override", name="bp2")` produced `/override/thing` with endpoint `bp2.thing`, so registration-time options override the blueprint's own `url_prefix`/`name`.

### What this rests on, and what stays open

- Rests on: `src/flask/sansio/blueprints.py` lines 17, 87–117, 130–141, 204, 224–244, 321–335, 413–440 (read directly and quoted above); the executor's single-interpreter script and its raw output; `grep deferred_functions tests/` → no matches, so no test asserts the storage form.
- Not established: whether the deferral is a bug or should be documented, refactored or tested — the executor did not touch source and this is a judgement call, not an observation.
- Not established: the `setupmethod` / `_check_setup_finished` link (`blueprints.py:209–220`, `scaffold.py:42–49`, raising `AssertionError` once `_got_registered_once` is true) as the reason the eager part is limited to validation is an inference by the retriever, not observed behavior.
- Not exercised: the two dot-character guards were not run at runtime.
- No contradicting evidence appeared between the two sources; the only discrepancy was the plan's "empty `url_map`" phrasing, corrected by the executor's observation that Flask always installs its `/static/<path:filename>` rule.
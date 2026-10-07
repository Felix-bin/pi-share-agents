## Answer

The method is **`Blueprint.add_url_rule`** (`src/flask/sansio/blueprints.py:413`, decorated `@setupmethod`). It deliberately does not register anything: after validating the endpoint and view-function names, it hands a newly created closure to `self.record(...)` and returns. The closure is stored in `self.deferred_functions` and is only invoked later, when the blueprint is registered on an app, at which point it calls `BlueprintSetupState.add_url_rule`, which finally calls the app-level `add_url_rule`.

### The store-a-lambda step (blueprints.py:413–447)

```python
@setupmethod
def add_url_rule(
    self,
    rule: str,
    endpoint: str | None = None,
    view_func: ft.RouteCallable | None = None,
    provide_automatic_options: bool | None = None,
    **options: t.Any,
) -> None:
    """Register a URL rule with the blueprint. ..."""
    if endpoint and "." in endpoint:
        raise ValueError("'endpoint' may not contain a dot '.' character.")

    if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
        raise ValueError("'view_func' name may not contain a dot '.' character.")

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

The two dot-character checks are the only work done eagerly. Everything that depends on *where* the blueprint is being registered is left inside the lambda.

### Why the lambda is stored instead of called now

- **There is no app and no setup state yet.** A `Blueprint` holds no `App`; `App` is imported only under `t.TYPE_CHECKING` (lines 12–13) for annotations. The object the lambda calls, `BlueprintSetupState`, is constructed with the app (`BlueprintSetupState.__init__`, line 42, stores `self.app = app`) and is only created by `Blueprint.make_setup_state` (line 246), which is called from inside `Blueprint.register` (line 320–327). At `add_url_rule` time that state does not exist, so there is literally no `s` to pass.
- **The prefixing data is not known yet.** `url_prefix`, `subdomain`, `name`, and `name_prefix` used by `BlueprintSetupState.add_url_rule` (lines 87–118) come from the options passed to `Flask.register_blueprint` merged over the blueprint's own values (lines 70–100). They are per-registration decisions, so they cannot be applied at definition time.
- **The same blueprint may be registered more than once**, on the same app under different `name=`/`url_prefix=` values or on other apps. Storing a callable rather than a resolved rule lets each registration replay the identical recorded rule against a fresh state and recompute the prefixed rule/endpoint for that registration. `record_once` (line 233) exists precisely because some recorded functions must *not* be replayed on a second registration — it wraps `func` in a `state.first_registration` guard and funnels it through `record` too.
- **The setup window is closed after first registration.** `@setupmethod` (`src/flask/sansio/scaffold.py:42`) calls `self._check_setup_finished(f_name)` (line 46) before the method body; `Blueprint._check_setup_finished` (line 213) raises `AssertionError` once `self._got_registered_once` is set (set in `register`, line 320). So recording must happen before registration, and replay must happen at registration — which is exactly the shape the lambda gives.

### Where the lambda is stored

- `Blueprint.record` (line 224, also `@setupmethod`) is one line: `self.deferred_functions.append(func)` (line 230). Its docstring: "Registers a function that is called when the blueprint is registered on the application."
- The list is created empty in `Blueprint.__init__`: `self.deferred_functions: list[DeferredSetupFunction] = []` (line 204).
- The element type is fixed at the top of the file: `DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]` (line 17). That is why the lambda takes exactly one parameter `s` — the `BlueprintSetupState` it will receive.
- The lambda therefore closes over `rule`, `endpoint`, `view_func`, `provide_automatic_options` and `**options` as closure cells; none of those values is consulted at record time.

### Where it is replayed

`Blueprint.register` (line 273), called by `Flask.register_blueprint`, does in order: sets `self._got_registered_once = True` (line 320), builds `state = self.make_setup_state(app, options, first_bp_registration)` (line 327), optionally registers the static route *immediately* via `state.add_url_rule(...)` (line 323, showing the state method is callable at this point), and then:

```python
for deferred in self.deferred_functions:
    deferred(state)          # line 334
```

Each stored lambda is invoked with the real `BlueprintSetupState`, which is what turns `lambda s: s.add_url_rule(...)` into an actual call on the state.

### The terminal call

`BlueprintSetupState.add_url_rule` (line 87) is the "setup state's registration method" the lambda invokes. It:

1. prefixes the rule with `self.url_prefix` (lines 97–101),
2. defaults the `subdomain` option to `self.subdomain` (line 102),
3. derives `endpoint` from the view function via `_endpoint_from_view_func` when it is `None` (lines 103–104),
4. merges `self.url_defaults` (blueprint `url_values_defaults` plus the registration's `url_defaults`) into `defaults` (lines 105–107),
5. calls `self.app.add_url_rule(rule, f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."), view_func, defaults=defaults, **options)` (lines 110–116).

One detail worth naming: `BlueprintSetupState.add_url_rule` has no named `provide_automatic_options` parameter, so the value the lambda passes by keyword is absorbed into that method's `**options` and forwarded unchanged to `App.add_url_rule` (line 115) — the deferral is lossless for that argument.

### Chain summary

`Blueprint.add_url_rule` (line 413) → `self.record(lambda s: ...)` (line 224) → `self.deferred_functions.append` (line 230, list from line 204, typed at line 17) → `Blueprint.register` replays `for deferred in self.deferred_functions: deferred(state)` (line 334) with `state = self.make_setup_state(app, options, ...)` (line 327) → `BlueprintSetupState.add_url_rule` (line 87) → `self.app.add_url_rule(...)` (line 110).

## What this rests on

- Direct reads of `src/flask/sansio/blueprints.py` at lines 17, 42–118, 195–355, 400–447, plus `src/flask/sansio/scaffold.py` lines 42/46/220.
- The retriever's line-numbered evidence, which matches the file; `record`'s append is at line 230 (the retriever said 224, which is the `def` line — the append is one place below), and `Blueprint.register` starts at line 273 rather than 274.
- Recalled shared memory `f07b70df4886` ("Deferral chain for URL rules on blueprints") describes the same chain and is **consistent** with these findings; nothing here supersedes it.

## Still open

- **No in-code or in-repo comment states the rationale.** The "no app / no resolved prefix / multiple registrations" explanation is an inference from the constructor signatures (`BlueprintSetupState.__init__` takes `app`, line 42), the fact that `make_setup_state` is only called inside `register` (line 327), and the `@setupmethod` guard. No documentation file in the working directory was consulted to corroborate it.
- The static route registered immediately at line 323 is the counter-example that shows deferral is a choice about *when* a state exists, not a limitation of `BlueprintSetupState` itself.
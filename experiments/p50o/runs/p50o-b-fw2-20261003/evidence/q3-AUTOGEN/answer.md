## Answer

Flask's static-asset serving is split across three layers under a deliberate sans-IO boundary, and cache consistency between the two entry points (the app framework and blueprints) is preserved by **duplicated code reading a shared config key** — not by shared inheritance.

---

### 1. The design intent: the sans-IO package boundary

The split is intentional and documented. `src/flask/sansio/README.md` states the whole contract:

> "This folder contains code that can be used by alternative Flask implementations, for example Quart. The code therefore cannot do any IO, nor be part of a likely IO path. Finally this code cannot use the Flask globals."

Because static serving must touch the filesystem and the `current_app` global, the *behavior* cannot live in `sansio/` — only the *state and the registration contract* can.

### 2. The shared foundation: `Scaffold`

Both components derive from one base class declared explicitly as shared behavior (`src/flask/sansio/scaffold.py:52-55`):

> "Common behavior shared between :class:`~flask.Flask` and :class:`~flask.blueprints.Blueprint`."

Wiring: `Flask → sansio.App → Scaffold` and `Blueprint → sansio.Blueprint → Scaffold` (`src/flask/sansio/app.py:59`, `src/flask/sansio/blueprints.py:119`).

`Scaffold` owns the **static configuration state and derived properties** (`src/flask/sansio/scaffold.py:223-269`):

```python
    @property
    def static_folder(self) -> str | None:
        if self._static_folder is not None:
            return os.path.join(self.root_path, self._static_folder)
        else:
            return None
```
```python
    @property
    def has_static_folder(self) -> bool:
        return self.static_folder is not None
```
```python
    @property
    def static_url_path(self) -> str | None:
        if self._static_url_path is not None:
            return self._static_url_path
        if self.static_folder is not None:
            basename = os.path.basename(self.static_folder)
            return f"/{basename}".rstrip("/")
        return None
```

It also owns `jinja_loader` (`scaffold.py:271-282`), but **deliberately leaves route registration abstract**:

```python
    def add_url_rule(...):
        ...
        raise NotImplementedError   # scaffold.py:433
```

I confirmed by grep that `send_static_file` and `get_send_file_max_age` appear **only** in `src/flask/app.py`, `src/flask/blueprints.py`, and as a *reference* in `src/flask/sansio/blueprints.py:326` — **never defined on `Scaffold` or any sans-IO module**. So `Scaffold` is state-only; the IO-bearing methods are pushed down into each concrete component.

### 3. Component A — the app framework registers its own `static` rule

`Flask.__init__` registers the rule itself, with a weakref to break the app↔view reference cycle (`src/flask/app.py:262-279`):

```python
        if self.has_static_folder:
            assert bool(static_host) == host_matching, (
                "Invalid static_host/host_matching combination"
            )
            # Use a weakref to avoid creating a reference cycle between the app
            # and the view function (see #3761).
            self_ref = weakref.ref(self)
            self.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                endpoint="static",
                host=static_host,
                view_func=lambda **kw: self_ref().send_static_file(**kw),
            )
```

Distinguishing features: the `weakref.ref(self)` lambda, the `host=static_host` argument, the `static_host`/`host_matching` assertion, and registration at construction time. The sans-IO `App` base only *forwards* the config to `Scaffold` (`src/flask/sansio/app.py:282-301`) — it never registers the rule.

### 4. Component B — the blueprint registers at registration time

`Blueprint.register` registers its rule through the setup-state bridge (`src/flask/sansio/blueprints.py:323-328`):

```python
        if self.has_static_folder:
            state.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                view_func=self.send_static_file,  # type: ignore[attr-defined]
                endpoint="static",
            )
```

The contrast with the app variant is exact: a **bound method** (not a weakref lambda), no `host`, and registration **deferred until `register()`** via `BlueprintSetupState.add_url_rule` (`sansio/blueprints.py:87-116`), which prefixes the endpoint (`f"{self.name_prefix}.{self.name}.{endpoint}"`) and applies `url_prefix`. The `# type: ignore[attr-defined]` is required precisely because `send_static_file` is defined by the concrete subclass `src/flask/blueprints.py`, not by `sansio.Blueprint`.

### 5. The duplicated caching contract (how consistency is preserved)

**Both components carry a byte-for-byte identical pair** of methods. Not abstract, not inherited — literally copied, with the duplication flagged four times in comments:

```
src/flask/app.py:290:        Note this is a duplicate of the same method in the Flask
src/flask/app.py:314:        Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:64:        Note this is a duplicate of the same method in the Flask
src/flask/blueprints.py:88:        Note this is a duplicate of the same method in the Flask
```

App copy (`src/flask/app.py:281-306`) and blueprint copy (`src/flask/blueprints.py:55-80`) are identical:

```python
    def get_send_file_max_age(self, filename: str | None) -> int | None:
        value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]

        if value is None:
            return None

        if isinstance(value, timedelta):
            return int(value.total_seconds())

        return value
```

And the view bodies are likewise identical (`app.py:308-328`, `blueprints.py:82-102`):

```python
        if not self.has_static_folder:
            raise RuntimeError("'static_folder' must be set to serve static_files.")

        # send_file only knows to call get_send_file_max_age on the app,
        # call it here so it works for blueprints too.
        max_age = self.get_send_file_max_age(filename)
        return send_from_directory(
            t.cast(str, self.static_folder), filename, max_age=max_age
        )
```

The blueprint's comment ("send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too") is the explicit statement of *why* the duplication exists: `send_file` resolves `max_age` against `current_app`, so blueprints must re-implement the same resolution to behave consistently.

**Cache consistency is thus a shared *value*, not shared *code*:** both copies read the same `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` (default declared once in `Flask.default_config`, `src/flask/app.py:201`: `"SEND_FILE_MAX_AGE_DEFAULT": None`), apply byte-identical normalization (`None → None`, `timedelta → int(value.total_seconds())`, otherwise passthrough), and hand the result to the same terminal path — `send_from_directory` → `_prepare_send_file_kwargs` (`src/flask/helpers.py:387-397`):

```python
    if kwargs.get("max_age") is None:
        kwargs["max_age"] = current_app.get_send_file_max_age
```

That helper is the **third consumer** of the same config, which is why overriding `get_send_file_max_age` on an app subclass affects both `app.send_static_file` and generic `flask.send_file` identically.

### 6. Tests that pin the behavior

- `tests/test_helpers.py:45-90` (`TestSendfile::test_static_file`) drives `SEND_FILE_MAX_AGE_DEFAULT` from `None` → `3600` and asserts both `app.send_static_file` and `flask.send_file` yield the same `cache_control.max_age`, then asserts a `StaticFileApp` subclass override returns `10` for both paths.
- `tests/test_blueprints.py:176-244` (`test_templates_and_static`) asserts the blueprint's `/admin/static/...` responses honor `SEND_FILE_MAX_AGE_DEFAULT`, and `test_default_static_max_age` (lines ~226-244) registers a `MyBlueprint` subclass whose `get_send_file_max_age` returns `100` and asserts the blueprint static response uses `100` — proving the blueprint hook is independent yet config-consistent.
- `tests/test_basic.py:1403-1486` covers app-side edge cases: `static_url_path`, trailing slash, empty path, `pathlib.Path` folders, and the `static_host`/`host_matching` assertion matrix.
- `tests/test_basic.py:1931-1944` (`test_app_freed_on_zero_refcount`) is the regression test for #3761 that the weakref exists to satisfy.

---

### Summary table

| Concern | Where it lives | Evidence |
|---|---|---|
| Shared static/template **state** | `Scaffold` (sans-IO) | `scaffold.py:52-68`, `:223-269`, `:271-282` |
| Registration **contract** (abstract) | `Scaffold.add_url_rule` → `raise NotImplementedError` | `scaffold.py:433` |
| App **rule registration** | `Flask.__init__` — weakref lambda, `host=static_host` | `app.py:262-279` |
| Blueprint **rule registration** | `Blueprint.register` — bound method via `BlueprintSetupState` | `sansio/blueprints.py:323-328` |
| App **view + cache** | duplicated pair | `app.py:281-328` |
| Blueprint **view + cache** | duplicated pair (identical body) | `blueprints.py:55-102` |
| Cache **consistency mechanism** | shared `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` + identical `timedelta` normalization + shared `send_from_directory`/`_prepare_send_file_kwargs` path | `app.py:201`, `app.py:298-306`, `blueprints.py:72-80`, `helpers.py:387-397` |

**Bottom line:** The architecture is a *state-in-the-base, behavior-in-the-components* split. `Scaffold` (in `src/flask/sansio/`) holds only the static-folder/URL-path state and the template loader, leaving `add_url_rule` abstract. Each component then registers its own `static` endpoint in its own idiomatic way — `Flask` eagerly in `__init__` via a weakref lambda with host matching; `Blueprint` lazily at `register()` time via a bound method through `BlueprintSetupState`. Each component also carries its own literally-duplicated `send_static_file`/`get_send_file_max_age` pair (four "duplicate of the same method" markers), and the two diverge nowhere, because consistency is guaranteed by all copies reading the same `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, normalizing `timedelta` identically, and delegating to the same `send_from_directory` → `_prepare_send_file_kwargs` code path.
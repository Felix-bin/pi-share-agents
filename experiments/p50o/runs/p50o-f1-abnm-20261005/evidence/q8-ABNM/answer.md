## Modular component registration with separated static serving and shared caching

**Answer.** The architecture has three layers: a shared scaffold that defines what a "static folder" is, a registration step that pushes each component's static route into the application's URL map, and a deliberately duplicated caching hook that keeps both components reading the same configuration key.

**1. The shared scaffold (`Scaffold`, `src/flask/sansio/scaffold.py`).** Both `Flask` and `Blueprint` inherit `Scaffold`, which owns the static-asset plumbing so the two components agree on location and URL: `static_folder` resolves a relative configured value against `root_path` and returns an absolute path (`scaffold.py:223-238`), `has_static_folder` is just `static_folder is not None` (`scaffold.py:240-246`), and `static_url_path` is derived from the folder basename when not given explicitly (`scaffold.py:248-262`). Everything below this layer is per-component.

**2. Registration is deferred in the modular component, eager in the app.** The app adds its own static rule inside `Flask.__init__`, unconditionally "without checking if static_folder exists", using a `weakref` lambda to avoid an app↔view reference cycle, at endpoint `static` with `host=static_host` (`app.py:261-279`). The blueprint does nothing at definition time: `Blueprint.route`/`add_url_rule` only *record* a callback via `self.record(...)` (`sansio/blueprints.py:412-445`). The rule is materialized only during `app.register_blueprint` → `blueprint.register(app, options)` (`sansio/app.py:570-593`), which creates the `BlueprintSetupState` (`sansio/blueprints.py:34-105`), then:

```python
if self.has_static_folder:
    state.add_url_rule(
        f"{self.static_url_path}/<path:filename>",
        view_func=self.send_static_file,
        endpoint="static",
    )
```
(`sansio/blueprints.py:322-328`), after which the deferred functions are replayed (`:334-335`). The setup state prefixes the rule with `url_prefix`, defaults the subdomain, and dots the endpoint as `{name}.static` (`sansio/blueprints.py:87-124`). So the app's static assets are served by an app-owned route from process start, while a component's static assets exist only as a route the app owns after that component is registered — and blueprints have `static_folder=None` by default (`sansio/blueprints.py:140-147`), with the documented precedence that a blueprint without a `url_prefix` loses to the app's static route (`docs/blueprints.rst:194-204`).

**3. Caching consistency is maintained by duplication against one config key, not by delegation.** Each component carries its own `get_send_file_max_age` with byte-identical bodies — it reads `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, returns `None` unchanged, converts a `timedelta` to `int(value.total_seconds())`, otherwise returns the value (`app.py:281-306`, `blueprints.py:55-79`) — and each `send_static_file` resolves the age itself and passes it explicitly:

```python
max_age = self.get_send_file_max_age(filename)
return send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)
```
(`app.py:308-328`, `blueprints.py:80-101`; the comment reads "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too"). That duplication is necessary because Werkzeug's `send_file` fallback hook is app-only: `_prepare_send_file_kwargs` substitutes `current_app.get_send_file_max_age` only when `max_age` is `None` (`helpers.py:387-396`), before both components funnel into the same shared path `send_from_directory` → `send_file` → `_prepare_send_file_kwargs` (`helpers.py:526-567`, `:400-522`). Both docstrings state the design explicitly — "Note this is a duplicate of the same method in the Flask class" — and the copy inside `app.py:290-291` is self-referential, confirming the duplication is intentional and hand-maintained rather than an inheritance relationship. The config default is `None` (`app.py:201`), documented as "Override this value on a per-file basis using `get_send_file_max_age` on the application **or** blueprint" (`docs/config.rst:250-260`).

**Observable consequences.** (a) A single `SEND_FILE_MAX_AGE_DEFAULT` setting produces the same `Cache-Control: max-age` on both the app's `/static/...` route and a blueprint's `/admin/static/...` route — asserted for the blueprint route in `tests/test_blueprints.py:194-206` and for the app route in `tests/test_helpers.py:58-68`. (b) Because each hook is reached through the component that owns the view, per-component caching is possible by subclassing either class — `flask.Flask.get_send_file_max_age` returning `10` (`tests/test_helpers.py:75-90`) and `flask.Blueprint.get_send_file_max_age` returning `100` while the app config says `3600` (`tests/test_blueprints.py:223-244`). (c) Not established by tests: when a component hook returns `None`, `_prepare_send_file_kwargs` substitutes the *app's* callable (`helpers.py:388-389`), so a blueprint override returning `None` cannot force no-cache over a non-`None` app config; only non-`None` overrides are covered by the tests above.

## What this rests on

- `src/flask/sansio/scaffold.py:223-262` (shared static-folder/URL plumbing); `src/flask/sansio/README.md` (why this package exists).
- `src/flask/app.py:201, 261-328` (eager app static route, duplicated hook, `send_static_file`); `src/flask/blueprints.py:55-101` (blueprint copies).
- `src/flask/sansio/blueprints.py:34-124, 256-335, 412-445` (deferred record/replay, blueprint static rule registration, endpoint/prefix handling); `src/flask/sansio/app.py:569-593` (`register_blueprint` entry point).
- `src/flask/helpers.py:387-396, 400-522, 526-567` (single shared send path and the app-only max_age fallback).
- `docs/config.rst:250-260`, `docs/blueprints.rst:191-204`; `tests/test_helpers.py:45-90`, `tests/test_blueprints.py:186-244`.

## Open / verification status

- Ground truth here is direct file inspection in this worktree; no execution tool was available to me, so I cannot report that the suite was run or that it passed for the caching paths above. Under verification: the `None`-override fall-through in (c), reasoned from `helpers.py:388-389` rather than observed.
- The retriever and executor results for this task were not readable from this session — the shared-memory namespace belongs to a different seal, so every `synapse_read` call (search and by-handle `get` for both handles) returned `namespace-mismatch`. Anything those two records established beyond the code cited above is not incorporated here.
- Unrelated to the question: `flask_mut2_i417ar2x/mutated_test.py` exercises subdomain routing with `SERVER_NAME` set and `subdomain_matching=False`, i.e. `Flask.create_url_adapter` (`app.py:441-470`); the static-serving and `max_age` code cited above is identical in both `Flask` and `Blueprint`, so nothing in this answer depends on that routing behavior — the only overlap is that blueprint-registered rules (including a blueprint's static rule) pass through the same `add_url_rule` that applies subdomain defaults (`sansio/blueprints.py:99`).
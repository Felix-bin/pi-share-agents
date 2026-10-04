# Modular component registration architecture: static serving separated from the app, caching kept consistent

The separation is achieved by a single registration seam plus a per-component static route, and the caching consistency comes from a deliberately duplicated hook method that both components share by name.

## 1. The registration seam: the framework never touches blueprint internals

`Flask.register_blueprint` (`src/flask/sansio/app.py:570`) does nothing more than delegate: its body calls `blueprint.register(self, options)` and its docstring says it "Calls the blueprint's `~flask.Blueprint.register` method after recording the blueprint in the application's `blueprints`."

`Blueprint.register` (`src/flask/sansio/blueprints.py:273`) owns the whole component-side procedure:

- validates the name and records `app.blueprints[name] = self` (line 320 area),
- sets `self._got_registered_once = True` (line 320),
- creates `state = self.make_setup_state(app, options, first_bp_registration)` (line 321),
- replays `self.deferred_functions` with that state (lines 334–335).

`make_setup_state` (`sansio/blueprints.py:246`) returns a temporary `BlueprintSetupState` (class at `sansio/blueprints.py:34`) — described in-source as a "Temporary holder object for registering a blueprint with the application". Its `add_url_rule` (`sansio/blueprints.py:87`) is the actual adapter: it prefixes the rule with `url_prefix` and rewrites the endpoint to `f"{self.name_prefix}.{self.name}.{endpoint}"` before delegating to `self.app.add_url_rule(...)`. So blueprint routes enter the app's routing table only through this namespacing adapter.

## 2. Static serving: each component binds its own route and its own view

Inside `Blueprint.register` (`sansio/blueprints.py:323–329`):

```python
if self.has_static_folder:
    state.add_url_rule(
        f"{self.static_url_path}/<path:filename>",
        view_func=self.send_static_file,
        endpoint="static",
    )
```

The blueprint serves its own assets through its own view (`Blueprint.send_static_file`, `src/flask/blueprints.py:82`) at its own endpoint, which resolves namespaced — `flask.url_for("admin.static", filename="test.txt") == "/admin/static/test.txt"` (`tests/test_blueprints.py:210`).

The main app registers its *own* static route separately, in `Flask.__init__` (`src/flask/app.py:274–279`), also with `endpoint="static"` but with `host=static_host` and a weakref lambda calling `self_ref().send_static_file(...)` to avoid a reference cycle (#3761). The two routes are distinct registrations under distinct endpoint namespaces — that is the separation.

Two asymmetries worth noting:

- **Opt-in vs. default-on.** `Blueprint.__init__` defaults `static_folder=None` (`src/flask/blueprints.py:23`), so blueprint static serving is off unless configured; `Flask.__init__` defaults `static_folder="static"` (`src/flask/app.py:230`). This resolves the retriever's gap about "disabled by default": it is the `None` default in `Blueprint.__init__`.
- **The condition is shared, the binding is not.** `has_static_folder` lives in `Scaffold` (`src/flask/sansio/scaffold.py:241`), which both `Flask` and `Blueprint` subclass, so "should static be served" has identical semantics; only the route/view binding differs per component.

## 3. Caching: consistency via a duplicated hook, per-component override honored

`Blueprint.get_send_file_max_age` (`src/flask/blueprints.py:55`) and `Flask.get_send_file_max_age` (`src/flask/app.py:281`) have identical bodies — both read `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` and normalise `None`/`timedelta` — and each docstring states it is "a duplicate of the same method" in the other class. That same-named duplication is what keeps caching consistent: both components resolve `max_age` from the same config key with the same semantics, without the blueprint having to call into the app's implementation.

`Blueprint.send_static_file` (`src/flask/blueprints.py:97–102`) makes the blueprint's version authoritative for its own files:

```python
# send_file only knows to call get_send_file_max_age on the app,
# call it here so it works for blueprints too.
max_age = self.get_send_file_max_age(filename)
return send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)
```

Because the call is bound (`self.…`), a `Blueprint` subclass override is honored polymorphically. And `helpers._prepare_send_file_kwargs` (`src/flask/helpers.py:388–389`) substitutes `kwargs["max_age"] = current_app.get_send_file_max_age` **only when `max_age is None`**; since the blueprint passes an explicit value, the blueprint's computed max-age wins and is not overwritten by the app's hook.

The app side is symmetric: `Flask.send_static_file` (`src/flask/app.py:315–321`) contains the identical comment and calls `self.get_send_file_max_age(filename)` bound.

## 4. The consistency claim is pinned by passing tests

| Test | What it pins |
|---|---|
| `tests/test_blueprints.py:223` `test_default_static_max_age` | `MyBlueprint.get_send_file_max_age -> 100` (line 225) beats `SEND_FILE_MAX_AGE_DEFAULT` 3600/7200 when the blueprint serves `index.html`: `cc.max_age == 100` (line 241) |
| `tests/test_blueprints.py:176` `test_templates_and_static`, assertion at 194–206 | Blueprint-served `/admin/static/css/test.css` returns `cc.max_age == expected_max_age` with `app.config["SEND_FILE_MAX_AGE_DEFAULT"] = expected_max_age` (3600/7200) — config-driven, same as the app |
| `tests/test_helpers.py:45` `TestSendfile::test_static_file` | Default `max_age is None` (line 55); `SEND_FILE_MAX_AGE_DEFAULT = 3600` honored by both `app.send_static_file` and `flask.send_file`; `StaticFileApp.get_send_file_max_age -> 10` (lines 75–77) wins on **both** paths |

All three selections ran at exit 0 with `PYTHONPATH=src .venv/Scripts/python.exe -m pytest <target> -v -p no:cacheprovider`, the selected tests reporting PASSED and no failures, skips or warnings in those selections.

## What this rests on, and what is still open

**Rests on:** direct reads of `src/flask/sansio/app.py` (570, 599), `src/flask/sansio/blueprints.py` (34, 87, 246, 273–335), `src/flask/app.py` (230, 274–306, 315–321), `src/flask/blueprints.py` (23, 55, 82–102), `src/flask/sansio/scaffold.py` (87, 241), `src/flask/helpers.py` (388–389); the test assertions above; and the executor's three exit-0 runs.

**Open / uncertainty:**

- **No explicit design rationale was found.** Intent is supported only by source comments ("duplicate of the same method", "send_file only knows to call get_send_file_max_age on the app") — no design document was read.
- **Run environment caveat.** The bare `python` on PATH has no `flask` module, and the repo `.venv` editable install resolves `flask` *outside* this working tree; `PYTHONPATH=src` is required for a run to measure this tree. The three passing runs are only evidence about this tree under that binding.
- **Scope of the run is narrow.** Only three test selections were executed (all four exit-0 observations in the earlier measurement plus these). No full-suite run exists, so "the tests pass" holds only for the selections named. Also, `-k max_age` matches only `test_default_static_max_age` — the config-driven blueprint assertion lives in `test_templates_and_static` (line 176) and had to be selected by name; the retriever's `194–206` anchor is correct but points inside that test, not to a `max_age`-named one. This is an anchor refinement, not a source conflict.
- **Untracked artifact out of scope.** `flask_mut2_i417ar2x/mutated_test.py` is untracked, 12 lines using `Flask(subdomain_matching=False)`/`url_for`, and greps contain no `static`, `max_age` or `Cache` references; it does not touch this seam and was not run. `git diff --stat HEAD` is empty, so the tracked source is unmodified from HEAD.
- **No contradiction between sources.** The retriever's source reading and the executor's independent runs agree on every claim; the only delta is line-anchor precision.
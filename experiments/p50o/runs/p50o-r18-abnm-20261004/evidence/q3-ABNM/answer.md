## Answer

**The architecture in one line:** static-asset support is *declared once* on the framework-agnostic base class `Scaffold`, *registered twice* by the two concrete components (`Flask` and `Blueprint`) through different mechanisms, and *served twice* by two deliberately duplicated method bodies that both read a single application config key — which is what makes the caching behavior come out identical on both paths.

### 1. The shared registration base — where the two components converge

`class Scaffold` at `src/flask/sansio/scaffold.py:52` is documented as "Common behavior shared between `Flask` and `Blueprint`" (`versionadded:: 2.0`). It is the only place the static-asset *contract* exists:

- `_static_folder` / `_static_url_path` class attributes (`scaffold.py:72-73`), assigned in `__init__` (`:87-88`).
- `static_folder` property — getter joins `root_path` (`:224-231`), setter strips trailing slashes (`:233-238`).
- `has_static_folder` — `return self.static_folder is not None` (`:241-246`).
- `static_url_path` — defaults to `/{basename(static_folder)}` when not given (`:248-263`).

Both components derive from it: `class App(Scaffold)` (`src/flask/sansio/app.py:59`) → `class Flask(App)` (`src/flask/app.py:81`) and `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:119`) → `class Blueprint(SansioBlueprint)` (`src/flask/blueprints.py:18`). So "is there a static folder, and at what URL prefix" is answered by shared code; *what route gets registered and who serves it* is not.

### 2. Two registration sites, one guard, different mechanisms

| | Application | Component (blueprint) |
|---|---|---|
| Site | `Flask.__init__`, `app.py:266-279` | `Blueprint.register`, `sansio/blueprints.py:323-328` |
| Guard | `if self.has_static_folder:` (+ `assert bool(static_host) == host_matching`) | `if self.has_static_folder:` |
| Timing | **eager** — rule added immediately in construction | **deferred** — via `state.add_url_rule` when the blueprint is registered on an app |
| View func | `view_func=lambda **kw: self_ref().send_static_file(**kw)` with `self_ref = weakref.ref(self)` "to avoid creating a reference cycle between the app and the view function (see #3761)" | `view_func=self.send_static_file` passed directly |
| Rule / endpoint | `f"{self.static_url_path}/<path:filename>"`, `endpoint="static"` | same rule string, `endpoint="static"`, then prefixed by `BlueprintSetupState.add_url_rule` (`sansio/blueprints.py:87-118`) to URL `url_prefix + rule` and endpoint `{name_prefix}.{name}.{endpoint}` → `admin.static` (asserted by `flask.url_for("admin.static", ...)` in `tests/test_blueprints.py:205-208`) |

The deferred route is the modular-registration part: a blueprint can define its static folder before any app exists (docstring: "Blueprint static files are disabled by default", `sansio/blueprints.py` ~`:140-146`), and the rule only lands on an app through `BlueprintSetupState`. In this tree blueprints are the only component mechanism that carries a static rule; no extension/plugin static hook exists.

### 3. Separation: declaration in `sansio/`, IO in the application layer

`sansio/README.md` states the rule: the folder "contains code that can be used by alternative Flask implementations… The code therefore cannot do any IO, nor be part of a likely IO path. Finally this code cannot use the Flask globals." Neither `send_static_file` nor `get_send_file_max_age` exists on `Scaffold` — a grep over `src/flask` returns definitions only in `app.py` and `blueprints.py`. So the file-IO-bearing serving methods (`send_from_directory`, `current_app` reads) stay in the application layer, and `Scaffold` carries only the declaration/URL surface. That is exactly the split the folder rule predicts.

### 4. Consistent caching behavior across both components

**One config key.** `"SEND_FILE_MAX_AGE_DEFAULT": None` is the single default entry, in `Flask.default_config` at `app.py:201`. `docs/config.rst:250-260` documents it as overridable "on a per-file basis using `~flask.Flask.get_send_file_max_age` on the application or blueprint."

**Identical resolution logic, duplicated.** `Flask.get_send_file_max_age` (`app.py:281-305`) and `Blueprint.get_send_file_max_age` (`blueprints.py:55-79`) have byte-identical bodies: read `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`; `None` → `None`; `timedelta` → `int(value.total_seconds())`; else the int.

**Identical serving logic, duplicated, with pre-resolution.** `Flask.send_static_file` (`app.py:308-331`) and `Blueprint.send_static_file` (`blueprints.py:82-105`) are also identical: `if not self.has_static_folder: raise RuntimeError(...)`, then `max_age = self.get_send_file_max_age(filename)` under the comment *"send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too."*, then `send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)`.

**Why that pre-resolution is the load-bearing detail:** `flask.helpers._prepare_send_file_kwargs` (`helpers.py:388-389`) sets `kwargs["max_age"] = current_app.get_send_file_max_age` when none was passed — i.e. `send_file` only ever consults the *app*. Resolving the value inside `send_static_file` before calling `send_from_directory` is what lets a blueprint's own override take effect instead of being silently replaced by the app's.

**Runtime verification.** Run in the worktree venv (Python 3.13.9, pytest 8.4.0), exit status 0, 4 passed: `tests/test_blueprints.py::test_templates_and_static`, `tests/test_blueprints.py::test_default_static_max_age`, `tests/test_helpers.py::TestSendfile::test_static_file`, `tests/test_basic.py::test_static_files`. A direct in-process probe (test client + `parse_cache_control_header`) gave `SEND_FILE_MAX_AGE_DEFAULT = None` → app `no-cache`/`max_age=None` and blueprint `no-cache`/`max_age=None`; `= 3600` → app `public, max-age=3600` and blueprint `public, max-age=3600` — byte-identical headers on both paths. Per-component override hooks also hold: a `Blueprint` subclass overriding `get_send_file_max_age → 100` wins over the config value (`tests/test_blueprints.py:223-245`), and a `Flask` subclass overriding it `→ 10` wins for both `app.send_static_file` and `flask.send_file` (`tests/test_helpers.py:45-90`).

### 5. An observed oddity, reported as such

Both copies of the two method docstrings end with "Note this is a duplicate of the same method in the Flask class." — including the copy *inside* the `Flask` class itself (`app.py:290`), which is self-referential. The consistency above is therefore maintained by duplicated implementations reading one shared key, not by a single shared implementation on `Scaffold`; the code itself labels the situation "a duplicate". Whether that duplication is intended design or a refactor candidate is not decided by the evidence. Separately, the plan's node id `tests/test_blueprints.py::test_static_files` does not exist: the blueprint max-age assertion lives in `test_blueprints.py::test_templates_and_static:193-206`, and the only `test_static_files` is `tests/test_basic.py:1403`, which asserts no caching behavior.

### What this rests on

- `src/flask/sansio/scaffold.py:52,72-73,87-88,224-263`; `src/flask/sansio/README.md`; `src/flask/sansio/app.py:59`; `src/flask/app.py:81,201,266-279,281-305,308-331`; `src/flask/sansio/blueprints.py:87-118,119,323-328`; `src/flask/blueprints.py:18,55-79,82-105`; `src/flask/helpers.py:388-389`; `docs/config.rst:250-260`.
- Test sources `tests/test_blueprints.py:175-245`, `tests/test_helpers.py:45-90`, `tests/test_basic.py:1403`, plus the executor's pytest run (exit 0, 4 passed) and header probe.
- Recorded as shared-memory conclusion `0bde8f4d0859…` (source `src/flask/sansio/scaffold.py`).

### Still open

- Caching beyond `SEND_FILE_MAX_AGE_DEFAULT` / `Cache-Control max_age`: no evidence was gathered on ETag or conditional-request behavior (`None` means "conditional requests instead of a timed cache" per `docs/config.rst`), so equality there is **not established**.
- Blueprints nested under blueprints, or any component other than blueprints registering static routes — none exists in this tree; the claim is scoped to `Flask` + top-level blueprint registration.
- Full-suite status and whether the duplicated method bodies are intended or slated for consolidation.
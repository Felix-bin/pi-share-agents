## Static asset serving in this Flask worktree: a shared `Scaffold` seam with two independent, owner-registered static endpoints that read one cache key

The architecture is a single shared registration/config seam — the `Scaffold` base class — under which each component registers and serves its *own* static endpoint, while caching consistency is preserved not by shared serving code but by both duplicated `get_send_file_max_age` implementations resolving the identical `SEND_FILE_MAX_AGE_DEFAULT` config key with the identical `timedelta` normalization.

**Why "component" means `Blueprint` and "main application framework" means `Flask` here.** The alternative reading — the framework-agnostic `sansio/` layer versus the concrete WSGI app — is not supported by this worktree: `src/flask/sansio/app.py` contains no static serving at all (its only `static|send_file|max_age` matches are docstring parameter text at `:107`, `:126-134`, `:285-299`), and the path the plan cited for it, `src/flask/sansio/strip-off`, does not exist (`ls src/flask/sansio` = `README.md`, `app.py`, `blueprints.py`, `scaffold.py`). I state the answer under the blueprint/app reading and flag the alternative in the final section rather than adopting it.

### 1. The shared registration seam: `Scaffold` carries all static state once

`src/flask/sansio/scaffold.py:52` `class Scaffold:` — docstring `:53-54`: "Common behavior shared between :class:`~flask.Flask` and :class:`~flask.blueprints.Blueprint`." All static-folder/URL state and properties are declared exactly once here:

- attributes `:72` `_static_folder: str | None = None`, `:73` `_static_url_path: str | None = None`, assigned once in `Scaffold.__init__` at `:87-88`;
- properties `:224` `static_folder` (+ setter `:234`), `:241` `has_static_folder`, `:249` `static_url_path` (+ setter `:265`).

A grep for `def static_folder` / `def static_url_path` returns only `scaffold.py` — neither `src/flask/app.py` nor `src/flask/blueprints.py` redefines them.

**Inheritance chain.** App: `src/flask/sansio/app.py:59` `class App(Scaffold):` → `src/flask/app.py:81` `class Flask(App):`. Blueprint: `src/flask/sansio/blueprints.py:119` `class Blueprint(Scaffold):` → `src/flask/blueprints.py:18` `class Blueprint(SansioBlueprint):`. So the same base is reached by both, through a different number of hops. (Plan drift noted: the plan cited `blueprints.py:17`; the observed declaration is `:18`.)

### 2. The separation: each component registers and serves its own static assets

**App side.** `Flask.__init__` (`src/flask/app.py:226`; `static_host` param `:231`, forwarded `:243`) registers the route at `:262-279`: `:267` `if self.has_static_folder:`, then `:274-279` `self.add_url_rule(f"{self.static_url_path}/<path:filename>", endpoint="static", host=static_host, view_func=lambda **kw: self_ref().send_static_file(**kw))`. The view is a weakref indirection (`:273` `self_ref = weakref.ref(self)`, comment "avoid creating a reference cycle between the app and the view function (see #3761)"). Serving methods are its own: `:281` `def get_send_file_max_age`, `:308` `def send_static_file`, which calls `:325` `max_age = self.get_send_file_max_age(filename)` and `:326` `return send_from_directory(...)`.

**Blueprint side.** The route is registered when the blueprint is registered with an app — `src/flask/sansio/blueprints.py:323` `if self.has_static_folder:` → `:324-328` `state.add_url_rule(f"{self.static_url_path}/<path:filename>", view_func=self.send_static_file,  # type: ignore[attr-defined], endpoint="static")`. Note the `type: ignore[attr-defined]`: the view function `send_static_file` is *not* defined in the sansio class — it lives in the concrete subclass, `src/flask/blueprints.py:82`, with `:55` `def get_send_file_max_age`, `:99` `max_age = self.get_send_file_max_age(filename)`, `:100` `return send_from_directory(...)`.

So both components register an endpoint literally named `"static"` (`app.py:276`, `sansio/blueprints.py:327`) — app-namespaced on the blueprint side, as the test asserts with `flask.url_for("admin.static", filename="test.txt") == "/admin/static/test.txt"` (`tests/test_blueprints.py:209-213`) — and each is served by a separate method body. The separation is *ownership-based*: registration happens in each owner (`Flask.__init__` vs `Blueprint.register`), and each owner holds its own serving methods. Only the route-building call site for the blueprint is in the sansio base; the behaviour is supplied by the concrete class.

### 3. How consistency is preserved despite the duplication

Four mechanisms, all in evidence:

1. **One config key.** Both implementations read `value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` — `src/flask/app.py:298` and `src/flask/blueprints.py:72`. Because `current_app` is the *application's* config even while a blueprint serves the file, the two independent implementations necessarily read the same value. Default is `None`: `src/flask/app.py:201` `"SEND_FILE_MAX_AGE_DEFAULT": None,`; documented at `docs/config.rst:250`.
2. **One normalization rule.** Both do `if isinstance(value, timedelta): return int(value.total_seconds())` — `src/flask/app.py:303-304` and `src/flask/blueprints.py:77-78`, with the same `if value is None: return None` short-circuit before it.
3. **The blueprint calls the hook explicitly, because the shared plumbing only knows the app.** `src/flask/helpers.py:387-389`: `_prepare_send_file_kwargs` sets `kwargs["max_age"] = current_app.get_send_file_max_age` when `max_age` is `None`. That resolves to the *app's* method only, so the blueprint passes `max_age` itself — `src/flask/blueprints.py:97-99` (comment: "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too", then `max_age = self.get_send_file_max_age(filename)`), passed on at `:100-101` as `send_from_directory(..., max_age=max_age)`. The same comment text appears at `src/flask/app.py:323-325`.
4. **The duplication is deliberate and self-documented.** `src/flask/app.py:290-291` and `src/flask/blueprints.py:64-65` both say "Note this is a duplicate of the same method in the Flask class", repeated for `send_static_file` at `src/flask/app.py:314-315` and `src/flask/blueprints.py:88-89`.

Net effect: consistency is a property of the *shared config key plus identical duplicated logic*, not of a shared implementation. Any change to the normalization rule must be made in both method bodies to stay consistent — that is the structural cost the architecture accepts in exchange for the components not sharing the serving code.

### 4. Runtime verification (executed)

The step-3 command run verbatim — `python -m pytest tests/test_helpers.py::TestSendfile::test_static_file tests/test_blueprints.py::test_default_static_max_age -q` from the repo root — **fails** on this machine: the plain `python` (3.14) has neither `flask` nor `werkzeug` installed, giving `ImportError while loading conftest ... tests/conftest.py:7: from flask import Flask` → `ModuleNotFoundError: No module named 'flask'`.

It passes when bound to this worktree's source:

- `PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_helpers.py::TestSendfile::test_static_file tests/test_blueprints.py::test_default_static_max_age -q -p no:cacheprovider` → exit 0, `2 passed in 0.22s`.
- `... tests/test_blueprints.py::test_templates_and_static -q` → exit 0, `1 passed in 0.25s` (the blueprint static HTTP route honouring the config key with no override).
- `git status --porcelain` → `?? flask_mut2_i417ar2x/` only; no source file was modified by these runs.

Observed `max_age` values (instrumented run under the same interpreter and `PYTHONPATH=src`), not inferred:

```
app default config                       -> None
app config=3600                          -> 3600
send_file, config=3600                   -> 3600
app subclass get_send_file_max_age -> 10 -> 10
blueprint own hook 100 vs config 3600    -> 100
blueprint GET /admin/static/index.html    -> 200, Cache-Control: public, max-age=100
timedelta(hours=1) -> app.get_send_file_max_age      -> 3600
timedelta(hours=1) -> blueprint.get_send_file_max_age -> 3600
```

This matches the assertions in the cited tests: `tests/test_helpers.py:45-89` (default `cache_control.max_age is None` at `:50`; `3600` at `:62`/`:67`; `FakePath` at `:72`; subclass override returning `10` at `:75-77`, asserted at `:84`/`:89`) and `tests/test_blueprints.py` (`:195-206` blueprint static max-age block asserting `cc.max_age == expected_max_age`; `:223-244` `test_default_static_max_age`, `MyBlueprint.get_send_file_max_age` returning `100` at `:224-226` beating a different config value at `:238`, asserted at `:241`). Notably, the `timedelta` branch — which has **no test in the suite** (grep for `timedelta` in `tests/*.py` hits only `tests/test_json.py:153,163`, an unrelated DST shim) — was observed live to behave identically in both implementations.

## What this rests on, and what is still open

**Rests on.** Static code inspection of `src/flask/sansio/scaffold.py`, `src/flask/sansio/app.py`, `src/flask/sansio/blueprints.py`, `src/flask/app.py`, `src/flask/blueprints.py`, `src/flask/helpers.py`; the two cited tests plus `test_templates_and_static`; and the executed pytest run above. Every architectural and caching element above carries a file:line, spot-checked directly rather than taken from the stage outputs.

**Open, or not established.**

1. **The caching claim is runtime-confirmed; the rest is static inspection.** Only step 3 was in execution scope. The `timedelta` normalization has no test coverage in this repo — its behaviour is a live observation here, not a pinned assertion.
2. **The step-3 command is not reproducible verbatim.** `python -m pytest …` from the repo root fails (no deps installed for system python). Verification required the repo `.venv` plus `PYTHONPATH=src`; without `PYTHONPATH=src` the `.venv` would import Flask from a foreign checkout, because `.venv/Lib/site-packages/flask.pth` points at a different tree. A passing run in that configuration would be testing the wrong source.
3. **Reported contradiction, unresolved:** `src/flask/app.py:290-291` and `:314-315` say "duplicate of the same method in the Flask class" *inside the `Flask` class itself*; the identical text appears in `src/flask/blueprints.py:64-65` and `:88-89`. The phrasing is self-referential on the app side, so the docstrings are not a reliable indicator of which copy was written first. Docstring-only, no behavioural effect.
4. **The alternative "component" reading is unanswered, not refuted by execution.** If the task intended the `sansio` framework-agnostic layer versus the concrete WSGI app, this worktree does not support it (`sansio/app.py` has no static serving), and the plan's cited evidence path `sansio/strip-off` does not exist here. I answered under the blueprint/app reading and flag the swap rather than silently adopting it.
5. **Out of scope by the plan's decisions, and excluded consistently with the evidence:** `flask_mut2_i417ar2x/mutated_test.py` (21 lines: subdomain `url_for` + a GET returning `200`/`b"xxx"`; no `static_folder`, no `SEND_FILE_MAX_AGE_DEFAULT`, no static route) — excluded and not run at runtime. Whether the task expects a refactor (e.g. moving static serving into the shared `Scaffold`) is likewise not answered: the task reads as an explanation, so this is an explanation, not an edit.
6. **Plan line drift, corrected in the citations above:** `blueprints.py:17`→`:18`; the `Scaffold` static block is `:72-73` and `:223-269` rather than `scaffold.py:67-88`; the `helpers.py` `max_age` plumbing is at `:387-389`, `:408`, `:511`, `:521` rather than `:565`.
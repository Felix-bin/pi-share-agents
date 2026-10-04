# The component registration architecture behind static serving and consistent caching

The separation is **not** a separate static-serving module. Static serving is a **capability carried by every registration component**: a shared `Scaffold` base in `src/flask/sansio/scaffold.py:52` (docstring `:53-54`: "Common behavior shared between `Flask` and `Blueprint`") owns the static-folder *state* (`_static_folder`/`_static_url_path` at `:72-73`, with `static_folder` `:224-238`, `has_static_folder` `:241`, `static_url_path` `:249-269`), while the *route* is registered by each concrete component through one common registration protocol (`setupmethod` → `_check_setup_finished` → `add_url_rule`). "Separation" therefore means: state and URL derivation are shared and framework-agnostic; the route/view/IO halves are owned by the two components — the Flask app and the Blueprint — not by a dedicated static module. Grep for `send_static_file`/`get_send_file_max_age` across `src/flask` returns only the two definitions in `app.py` and `blueprints.py` plus doc cross-references, so no third static-serving module exists to describe.

## How the registration layers are built

- `sansio/scaffold.py:42` `setupmethod` decorator; the wrapper (`:45-46`) calls `self._check_setup_finished(f_name)` before the wrapped method. The hook itself is abstract at `sansio/scaffold.py:220-221` (`raise NotImplementedError`).
- `sansio/app.py:59` `class App(Scaffold)`; `_check_setup_finished` (`:413`) guards on `self._got_first_request` (`:411`); `register_blueprint` (`:570`) has as its whole body `blueprint.register(self, options)` (`:595`); `add_url_rule` (`:605`).
- `sansio/blueprints.py:119` `class Blueprint(Scaffold)`; `_got_registered_once` (`:172`), `_check_setup_finished` (`:213`), `record` (`:224`), `record_once` (`:233`), `make_setup_state` (`:246`), `register` (`:273`), `add_url_rule` (`:413`).
- `sansio/blueprints.py:34` `BlueprintSetupState`; its `add_url_rule` (`:87`) forwards to `self.app.add_url_rule(...)` (`:108`) — the indirection that lets a blueprint contribute routes to the app that hosts it.
- WSGI layer: `src/flask/app.py:81` `class Flask(App)`; `src/flask/blueprints.py:18` `class Blueprint(SansioBlueprint)`. `sansio/README.md` states the sansio layer "cannot do any IO … cannot use the Flask globals", which explains why file-serving and config lookup live only in the WSGI subclasses.

## How static serving is separated from the app framework

The two components share the state but differ on **when** and **whether** they register a static route:

| | Flask app (`src/flask/app.py`) | Blueprint (`src/flask/blueprints.py` + `sansio/blueprints.py`) |
|---|---|---|
| default `static_folder` | `"static"` (`app.py:230`, passed to `super()` `:243`) | `None` — **disabled by default** (`sansio/blueprints.py:178`, `blueprints.py:23`) |
| static route registration | **eager, inside `Flask.__init__`** (`app.py:262-277`: `if self.has_static_folder:` `:267`, `self.add_url_rule(f"{self.static_url_path}/<path:filename>", endpoint="static", …)` `:274-277`) | **deferred, inside `Blueprint.register`** (`sansio/blueprints.py:323-329`: route added via `state.add_url_rule(..., view_func=self.send_static_file, endpoint="static")`), i.e. only when `register_blueprint` runs |
| view function | `send_static_file` (`app.py:308`) | `send_static_file` (`blueprints.py:82`); absent from the sansio class, flagged by `# type: ignore[attr-defined]` at `sansio/blueprints.py:325` |
| cache resolution | `get_send_file_max_age` (`app.py:281`) | `get_send_file_max_age` (`blueprints.py:55`) |

So the app-to-blueprint split is real: the Blueprint is inactive until registered, and its static route is contributed into the host app through `BlueprintSetupState`.

## Why caching stays consistent across both components

Three code points, not one shared function:

1. **One shared source of truth.** Both resolvers read the same config key. `app.py:297` and `blueprints.py:71` both do `value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, with identical `timedelta` handling (`app.py:302-303`, `blueprints.py:76-77`). The duplication is acknowledged in-tree — the docstring line "Note this is a duplicate of the same method in the Flask class" appears at `app.py:290`, `blueprints.py:64` and `blueprints.py:88`. `docs/config.rst:250-256` documents the setting as overridable per file "on the application or blueprint".
2. **A global fallback that only knows the app.** `helpers.py:387-389` `_prepare_send_file_kwargs` does `if kwargs.get("max_age") is None: kwargs["max_age"] = current_app.get_send_file_max_age` — i.e. `send_file` (`:400`) and `send_from_directory` (`:526`) would otherwise resolve the age exclusively through the app, silently ignoring a blueprint's override.
3. **The explicit handoff that closes that gap.** Both `send_static_file` implementations pass their own value down: `max_age = self.get_send_file_max_age(filename)` (`app.py:325`, `blueprints.py:99`), preceded by the comment "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too" (`app.py:323-324`, `blueprints.py:97`), then `send_from_directory(..., max_age=max_age)` (`app.py:326`, `blueprints.py:100`).

Consistency, in short, is preserved by *parallel, per-component implementations fed by one shared config key plus an explicit handoff at the call site* — not by a shared serving class.

## What the runtime check adds

The executor drove this worktree's own source (`.venv`'s editable-install `.pth` pins another tree, so `PYTHONPATH=src` was required; the run printed `flask.__file__` inside this worktree). Four variants, exit 0:

- Shared `SEND_FILE_MAX_AGE_DEFAULT = 3600`: app `GET /static/test.css` → `max-age=3600`; blueprint `GET /bp/bpstatic/test.css` → `max-age=3600`.
- Both components overriding `get_send_file_max_age` to 10 under the shared config → both 10.
- **Distinct** overrides (app→10, blueprint→20; added because identical values cannot distinguish "own override" from "leaked value") → 10 vs 20, i.e. the two resolvers are independent.
- `url_prefix=None` with the blueprint's `static_folder="static"` → both URLs returned the app's file (`body='APP-FILE'`), matching the `docs/blueprints.rst:212-217` caveat that the app's `/static` route takes precedence.

This is corroborated statically by `tests/test_blueprints.py:176-221` (blueprint static route honours the shared config) and `:223-244` (a `flask.Blueprint` subclass's `get_send_file_max_age` returns 100 even with a different config value → per-component override wins), and `tests/test_helpers.py:44-91` (config 3600 flows to both `app.send_static_file` and `flask.send_file`; a `flask.Flask` subclass override → 10 in both). No mismatch contradicting the "consistent caching" claim appeared.

## Premise check and unresolved contradictions

- **The premise of a dedicated static-serving component is not established.** The executable architecture is the `sansio/Scaffold` shared layer acting as the modular seam; static serving is duplicated in two WSGI classes rather than extracted. If the question was aiming at a plugin/extension "component registration" mechanism, no such mechanism exists in this worktree and that framing does not match the code.
- **The duplication's intent is unexplained by the code.** The copy-paste artifact (`app.py:290` naming the Flask class as the source of its own duplicate) is reported as text; whether it is deliberate or should be refactored was never established.

---

**Rests on:** retriever's symbol/line map (`sansio/scaffold.py`, `sansio/app.py`, `sansio/blueprints.py`, `app.py`, `blueprints.py`, `helpers.py`) plus `docs/blueprints.rst:195-217`, `docs/config.rst:250-256`, `tests/test_blueprints.py:176-244`, `tests/test_helpers.py:44-91`, `tests/test_basic.py:1468`; the executor's four-variant runtime run (exit 0) on this worktree's `src/flask`; direct re-reads here of `app.py:255-334`, `sansio/blueprints.py:300-344`, `helpers.py:380-409`, `blueprints.py:50-104`, `sansio/scaffold.py:215-284`, `sansio/blueprints.py:172-186`. Recorded as conclusion `e83f7da360b855ad`.

**Still open:** whether the app/blueprint duplication is intentional or slated for refactor; whether any mutated-tree variant behaves differently (the runtime run used the current source only); and the "separate static-serving module" reading of the question, which the code does not support.
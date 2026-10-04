## Answer

**Scope for every claim below: this tree only — `experiments/data/flask-src`, Flask `3.2.0.dev`, detached HEAD `85c5d93` (`pyproject.toml:2-3`, `.git/HEAD`).**

### The architecture in one line

A **three-layer split**: (1) a framework-free base class `Scaffold` that owns *all* static-asset state and its derivation, (2) two sans-io classes `App` / `Blueprint` that own the *registration machinery* but no request context, and (3) two concrete classes `Flask` / `Blueprint` that own the context-dependent *serving handlers*; the two concrete components keep caching identical by **duplicating the same derivation and handler shape** and converging on **one transport funnel** whose fallback is deliberately app-scoped.

### Layer 1 — shared, framework-free base

`Scaffold` (`src/flask/sansio/scaffold.py:52`), docstring "Common behavior shared between :class:`~flask.Flask` and :class:`~flask.blueprints.Blueprint`". It holds *only* static state/derivation and no serving code:

- class attrs `_static_folder` / `_static_url_path` (`:72-73`); constructor params `static_folder` / `static_url_path` (`:78-79`) assigned at `:87-88`
- `static_folder` property joins `root_path` (`:224-230`), setter strips trailing separators (`:233-238`), `has_static_folder` (`:240-248`)
- `static_url_path` property derives `f"/{os.path.basename(self.static_folder)}".rstrip("/")` when unset (`:252-267`), setter strips `/` (`:269-275`)

Registration seam: `Scaffold.add_url_rule` at `:368`, decorated `@setupmethod` (`:367`). **I resolved the earlier open question (c): its body is a pure override target — it ends in `raise NotImplementedError` at `:433`** (the other raising stub is `_check_setup_finished`, `:220-221`). Neither `App` nor `Blueprint` extends that body; each *overrides it entirely*. `setupmethod` (`:40-49`) wraps calls with `_check_setup_finished` so registration after first request is rejected.

Separation is exhaustive, not partial: I re-ran the decisive grep — `current_app|send_from_directory|send_file` across all of `src/flask/sansio/` returns **no matches**. The sans-io package never touches the app context or file I/O.

### Layer 2 — the component pairs (redeemed from the truncated table by reading the sources)

| Component | Class def | `get_send_file_max_age` | `send_static_file` | `add_url_rule` |
|---|---|---|---|---|
| `App` (sans-io) | `sansio/app.py:59` | — | — | concrete, `:605` (`@setupmethod :604`) |
| `Flask` (concrete) | `app.py:81` | `:281` | `:308` | inherits `App`'s (no override in `app.py`) |
| `Blueprint` (sans-io) | `sansio/blueprints.py:119` | — | — | deferred, `:413` (`@setupmethod :412`); `BlueprintSetupState.add_url_rule` `:87` |
| `Blueprint` (concrete) | `blueprints.py:18` | `:55` | `:82` | inherits the sans-io override |

So the serving handlers and the max-age resolver sit **deliberately outside `sansio/`**; the sans-io halves stay context-free while still owning where and how the static route gets registered.

### Registration chains, end to end

**App:** `Flask.__init__` (`app.py:262-279`) calls `self.add_url_rule(f"{self.static_url_path}/<path:filename>", endpoint="static", host=static_host, view_func=lambda **kw: self_ref().send_static_file(**kw))` guarded by `if self.has_static_folder`. The `weakref.ref(self)` (`app.py:269-270`) is deliberate (comment cites issue #3761: avoid an app↔view reference cycle), and the assert at `:263-265` couples `static_host` with `host_matching` — an app-only feature.

**Blueprint:** `Blueprint.add_url_rule` records a deferred lambda (`sansio/blueprints.py:434`) that later runs `BlueprintSetupState.add_url_rule` (`:87`), which prefixes the rule with `url_prefix` (`:101-104`) and rewrites the endpoint as `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")` (`:110-116`) before calling `app.add_url_rule`. At registration time, `if self.has_static_folder: state.add_url_rule(f"{self.static_url_path}/<path:filename>", view_func=self.send_static_file, endpoint="static")` (`sansio/blueprints.py:324-328`).

**Net difference between the two components:** the app's static endpoint is literally `"static"`; the blueprint's becomes `"<bp name>.static"` (with any `name_prefix`), and its URL is additionally prefixed by the blueprint's `url_prefix`. Structurally, the app passes a weakref-resolving lambda while the blueprint passes its bound `self.send_static_file` (`:326`, with a `type: ignore[attr-defined]` because the sans-io class cannot see the concrete method).

### How caching stays consistent across both

Four independent mechanisms, all anchored:

1. **Same config key, same semantics.** Both resolvers read `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, return `None` if unset, and convert `timedelta → int(seconds)`: `app.py:281-306` and `blueprints.py:55-80` are the *same body*.
2. **Same handler shape.** Both `send_static_file` bodies raise `RuntimeError("'static_folder' must be set to serve static_files.")` when `has_static_folder` is false, then `max_age = self.get_send_file_max_age(filename)` and `send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)` — `app.py:308-326`, `blueprints.py:82-100`.
3. **Shared transport funnel with an app-scoped fallback.** `helpers.send_from_directory` (`helpers.py:526`) → `helpers._prepare_send_file_kwargs` (`helpers.py:387-390`): `if kwargs.get("max_age") is None: kwargs["max_age"] = current_app.get_send_file_max_age`, plus `environ`, `USE_X_SENDFILE`, `response_class`, `_root_path` from `current_app`. Because the fallback is *the app's* method, both components pre-resolve their own max-age — stated verbatim in both files' comments: "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too" (`blueprints.py:97-98`, `app.py:323-324`).
4. **Tests pin the equivalence by config mutation:** `tests/test_helpers.py:45 test_static_file` asserts `app.send_static_file` and direct `flask.send_file` agree at default `None` and at `3600`, then at a subclass override of `10`; `tests/test_blueprints.py:223 test_default_static_max_age` sets the *app* config to `3600`/`7200` and asserts the *blueprint* override `100` wins.

**Important nuance, and the one thing worth challenging in the framing:** consistency here is by **duplication + tests, not by a shared implementation**. Upstream says so in both docstrings — "Note this is a duplicate of the same method in the Flask class" (`app.py:288`, `blueprints.py:62`; same note on `send_static_file`). The executor reached the same conclusion independently: the resolver is *duplicated*, not shared. Consequently the two remaining caveats: (i) the duplicated pair carries future-divergence risk by construction, and (ii) consistency covers the two *registered static handlers* plus the `send_from_directory` fallback; a blueprint-scoped direct call to `send_file`/`send_from_directory` that does not pass `max_age` still resolves through **`current_app`**, i.e. app-level, not blueprint-level.

### Behavioral verification

Executor step 4, in-tree venv (Python 3.13.9, `flask.__file__ = src/flask/__init__.py`, dist `3.2.0.dev0`, pytest 8.4.0): the named pinning set (`tests/test_helpers.py::TestSendfile`, `tests/test_blueprints.py::test_default_static_max_age`) ran with **EXIT = 0, "4 passed in 0.20s"**. I can corroborate the count from the sources: `TestSendfile` contains exactly three test methods (`test_send_file:34`, `test_static_file:45`, `test_send_from_directory:92`) → 3 + 1 = 4. Recorded shared memory (`5e1028c2e91e`, executor) adds the probe: `app.send_static_file`, `blueprint.send_static_file` and `helpers.send_file` all funnel through `_prepare_send_file_kwargs` (3/3), and a blueprint subclass override yields bp `max_age=100` while the app keeps its config value. The WSL ~22-failure caveat in workspace §5 does **not** apply (that is the plugin repo's `npm test`; this was Flask's own pytest under native Windows, selection fully green).

### What this rests on

- Source reads in-tree: `sansio/scaffold.py:40-49,52-88,220-275,355-433`; `sansio/app.py:59,604-610`; `app.py:81,255-326`; `sansio/blueprints.py:87-116,119,324-328,412-443`; `blueprints.py:18-100`; `helpers.py:387-390,526`.
- My own re-run greps: `current_app|send_from_directory|send_file` in `src/flask/sansio/` → no matches; `NotImplementedError` in `sansio/scaffold.py` → `:221`, `:433`; class/def line anchors across `src/flask`.
- Tests read: `tests/test_helpers.py:33-100`, `tests/test_blueprints.py:223-247`.
- Executor result line (EXIT 0, 4 passed) + shared memory `5e1028c2e91e`.

### Still open / not established

- **Truncation I could not fully redeem.** The evidence block's Layer-2 table (37 lines) I rebuilt from source. The executor block's 24 truncated lines are a *run transcript*, not worktree content, and I have no shell tool to re-run — so any further command or output inside that block (e.g. a second command) is unverifiable from here; I relied on the posted `EXIT = 0, 4 passed in 0.20s` line, the source-level test count, and the executor's memory entry.
- **No full-suite health** for this tree: only 5 node IDs were ever selected; nothing else was collected or run.
- **No upstream version correspondence**: all anchors hold only for `3.2.0.dev @ 85c5d93`.
- **The untracked `flask_mut2_i417ar2x/mutated_test.py`** the executor observed is not present under `experiments/data/` and grep finds no `flask_mut`/`i417ar2x` match anywhere in or above `flask-src` now — it was not exercised by the run, and I cannot confirm whether it still exists. Flagged, not resolved.
- **Historical note on memory:** the retriever's attempt to record its findings was rejected (`not-authorised`), so the Layer-1/2 anchors exist only in the handed report plus my own re-verification here; the executor's entry `5e1028c2e91e` is the only persisted record, and it is consistent with everything above (no contradiction to report).
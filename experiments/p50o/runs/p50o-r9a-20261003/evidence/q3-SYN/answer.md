Memory write refused (`summarizer may not write shared memory`), so the synthesis below stands on the two existing executor records plus my own re-read of the tree.

# Answer

**The architecture: one shared attribute base (`Scaffold`), two independent components that each register and serve static files their own way, and a deliberately duplicated cache hook — not an inherited one — to keep the two paths byte-for-byte consistent.**

Subject of the reading: the vendored tree `experiments/data/flask-src` (`pyproject.toml:3` = `3.2.0.dev`; `src/flask/__init__.py` has no `__version__`). "Main application framework" = `Flask`; "modular component" = `Blueprint`. That mapping is an interpretation of the observed structure — flagged under *Open*.

## 1. The shared base is an attribute surface, not a serving implementation

`src/flask/sansio/scaffold.py:52` `class Scaffold:` — docstring L53-54: *"Common behavior shared between `Flask` and `Blueprint`."* It contributes only the static/template attribute set: `_static_folder`/`_static_url_path` (L72-73), the shared `__init__(import_name, static_folder, static_url_path, template_folder, root_path)` (L76-83), `static_folder` property that joins `root_path` (L223-231), `has_static_folder` (L241-246), and `static_url_path` which derives `f"/{os.path.basename(static_folder)}".rstrip("/")` when unset (L249-262). `Scaffold` defines **neither** `get_send_file_max_age` **nor** `send_static_file`.

## 2. Both components inherit it, but register at different times

- **Framework (eager, with host binding):** `sansio/app.py:59 class App(Scaffold)` → `app.py:81 class Flask(App)`. `App.__init__` (`sansio/app.py:283-302`) accepts `static_folder="static"`/`static_url_path`/`static_host` but adds **no route**; the registration lives in the concrete subclass `Flask.__init__` (`app.py:229-231` signature, `app.py:267-279` body): `if self.has_static_folder:` → `assert bool(static_host) == host_matching` → `self.add_url_rule(f"{self.static_url_path}/<path:filename>", endpoint="static", host=static_host, view_func=lambda **kw: self_ref().send_static_file(**kw))`, with a `weakref` to the app (the comment cites issue #3761 — avoiding a reference cycle). The preceding comment states registration deliberately does **not** check that the folder exists (it may appear at runtime, or on App Engine).
- **Modular component (deferred, endpoint-namespaced, no host):** `sansio/blueprints.py:119 class Blueprint(Scaffold)` → `flask/blueprints.py:18 class Blueprint(SansioBlueprint)`. Its `static_folder` default is `None` — the framework serves static by default, the component must opt in. Chain: `sansio/app.py:570 register_blueprint` → `sansio/app.py:595 blueprint.register(self, options)` → `sansio/blueprints.py:273 Blueprint.register` → `make_setup_state` (L246) → `BlueprintSetupState` (L34) → `add_url_rule` (L87-113, which prepends `url_prefix`, defaults `subdomain`, and prefixes the endpoint with `name_prefix.name` before forwarding to `app.add_url_rule`). The static rule is added at `sansio/blueprints.py:323-327`, **before** the `deferred_functions` replay (L331-332), as `f"{self.static_url_path}/<path:filename>"`, `endpoint="static"`, **no `host`** → the flattened endpoint is e.g. `bp.static`. Nested blueprints recurse: `sansio/blueprints.py:256 register_blueprint` records into `self._blueprints`, replayed at L377 via `blueprint.register(app, bp_options)`. With no `static_folder`, nothing is registered and `send_static_file` raises `RuntimeError` (`app.py:320-321`, `blueprints.py:94-95`).

## 3. Caching consistency is preserved by verbatim duplication, not by inheritance

- **One config key, read in exactly two places:** `SEND_FILE_MAX_AGE_DEFAULT`, default `None` at `app.py:201`; source reads only at `app.py:298` and `blueprints.py:72` (tree-wide grep confirms these are the sole source hits).
- **Byte-identical 48-line pairs on both concrete components** (`app.py:281-306` + `308-328`; `blueprints.py:55-80` + `82-102`). Each `get_send_file_max_age` returns `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, normalizing `timedelta → int(total_seconds())`; each `send_static_file` calls `self.get_send_file_max_age(filename)` then `send_from_directory(self.static_folder, filename, max_age=max_age)`. Both docstrings carry *"Note this is a duplicate of the same method in the Flask class."* The inline rationale comment states the reason for the duplication: *"send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too."*
- **Single funnel, so no second cache mechanism exists:** `helpers.py:526-567 send_from_directory` and `helpers.py:400-522 send_file` both go through `_prepare_send_file_kwargs` (`helpers.py:387-397`), which sets `kwargs["max_age"] = current_app.get_send_file_max_age` **only when `max_age` is `None`**, then calls `werkzeug.utils.send_from_directory` / `send_file` (`helpers.py:565`, `511`). A grep for `Cache-Control|cache_control|etag|ETag` across `src/flask/*.py` and `src/flask/sansio/*.py` finds only `send_file`'s own `etag` parameter/docs.
- **The component's override wins, and the app's config still flows through:** `tests/test_blueprints.py:223-247` (`test_default_static_max_age`) subclasses `Blueprint` to return `100`, registers it, sets the app config to a different value, and asserts `Cache-Control` `max_age == 100`; `tests/test_blueprints.py:~185-210` asserts the app-config value reaches `/admin/static/css/test.css`.
- **Executed confirmation:** 4 targeted tests passed in 0.22 s (`test_templates_and_static`, `test_default_static_max_age`, `test_static_files`, `test_static_route_with_host_matching`), and a live `url_map` trace produced endpoint `bp.static` with the `url_prefix`-prefixed rule.

## 4. Contradiction / internal oddity

`app.py:290-291` and `blueprints.py:64-65`/`88-89` all say *"duplicate of the same method in the Flask class"* — inside `flask/app.py`'s own `Flask` class this is self-referential. It is a copy artifact or upstream text; there is no upstream copy in this worktree to diff against, so it stays unresolved rather than resolved in either direction. `tests/test_blueprints.py:247` was also renumbered by my read into the shared file (`test_templates_list` begins at 247, not 247's earlier context) — a reminder that all anchors here are worktree-local.

## Rests on

- Files re-read for full coverage (the evidence's truncated blocks): `src/flask/sansio/scaffold.py` (L40-269), `src/flask/sansio/app.py` (L280-320, L550-610), `src/flask/sansio/blueprints.py` (L30-52, L60-129, L168-207, L273-302, L300-360), `src/flask/app.py` (L255-345), `src/flask/blueprints.py` (L1-110), `src/flask/helpers.py` (L380-440, L495-575), `tests/test_blueprints.py` (L220-255), `tests/test_basic.py` (L1403-1487), `pyproject.toml`.
- Executor memories `d06c445991d7` and `e7a999f099cf` — both consistent with what I re-verified; no contradiction between records. Anchor correction applied: `sansio/app.py:595`, not L593.
- Executed run: 4 tests passed (0.22 s) plus a `url_map` trace.

## Still open

- **That this tree is the question's intended subject.** The App/Blueprint split is my reading of the structure; the only corroboration is the cwd and that a Flask-sourced corpus ranked these chunks. If the question meant another framework, the answer does not transfer.
- **Upstream version/tag alignment.** No `__version__` in `src/flask/__init__.py`; only `pyproject.toml:3 = 3.2.0.dev`. Every line anchor is this worktree copy and can drift.
- **Whether `app.py:290-291`'s self-reference is upstream text or local drift** — no upstream copy available to diff.
- **Werkzeug-side behaviour beyond docs + assertions.** That Werkzeug honours a callable `max_age` and emits the exact `Cache-Control` text is inferred from `helpers.py:446-448` and the passing test, not observed in Werkzeug source.
- **Any runtime behaviour beyond the 4-test run and the `url_map` trace** — no live HTTP request was made here.
- **Shared-memory coverage:** `synapse_read` search returned zero prior memories at retrieval time (only the executor's two later records exist); the retriever was refused write access and I was too, so this synthesis is not persisted — a later task must re-derive it from the tree or from the two executor records.
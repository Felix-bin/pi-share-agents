## Answer

The separation is a **config-vs-serving split layered over a shared base class**, with the modular component (a `Blueprint`) reaching the same static-asset configuration as the main application (`Flask`) but carrying its own copy of the serving/caching code.

**1. A shared, IO-free base holds the static-asset configuration.**
`src/flask/sansio/scaffold.py:52` defines `class Scaffold:` with the docstring "Common behavior shared between `Flask` and `Blueprint`" (read directly). The inheritance edges are `src/flask/sansio/app.py:59` `class App(Scaffold)` → `src/flask/app.py:81` `class Flask(App)`, and `src/flask/sansio/blueprints.py:119` `class Blueprint(Scaffold)` → `src/flask/blueprints.py:18` `class Blueprint(SansioBlueprint)`. `Scaffold` owns `_static_folder`/`_static_url_path` and the derived properties `static_folder`, `has_static_folder`, `static_url_path` (the last deriving `/<basename>` from the folder when not set). Import introspection confirmed that for **both** `Flask` and `Blueprint` those three attributes resolve on `flask.sansio.scaffold.Scaffold`. The `sansio` layer deliberately holds no serving logic: neither `flask.sansio.app.App` nor `flask.sansio.blueprints.Blueprint` defines `send_static_file` or `get_send_file_max_age` (introspection, executor run 3), consistent with `src/flask/sansio/README.md`'s rule that this code cannot do IO, be on a likely IO path, or use Flask globals. *This "separation" framing is an inference from that rule; I found no doc that names the architecture as such.*

**2. Registration is deferred: the component defines, the app registers.**
`Blueprint` is the modular component — "an object that allows defining application functions without requiring an application object ahead of time" (`sansio/blueprints.py:119` ff.). `Flask.register_blueprint` (`sansio/app.py:569-590`) is a thin wrapper whose body is `blueprint.register(self, options)`. Inside `Blueprint.register` (`sansio/blueprints.py:322-327`), if the blueprint has a static folder:

```python
state.add_url_rule(
    f"{self.static_url_path}/<path:filename>",
    view_func=self.send_static_file,  # type: ignore[attr-defined]
    endpoint="static",
)
```

`BlueprintSetupState.add_url_rule` (`sansio/blueprints.py:92-118`) then prefixes the rule with `url_prefix` and rewrites the endpoint as `f"{self.name_prefix}.{self.name}.{endpoint}"`, so the blueprint's static route lands on `/<url_prefix>/static/<path:filename>` named **`<bp>.static`** — not `static` (`docs/blueprints.rst:190-206` documents this endpoint name).

The main application's static route is registered separately, inside `Flask.__init__` (`src/flask/app.py:262-279`), as `endpoint="static"` with `view_func=lambda **kw: self_ref().send_static_file(**kw)`, using a `weakref` to avoid a reference cycle (`#3761`). The two seams therefore differ in an important way: the app passes a **weakref lambda** with an optional `host=static_host`, while the blueprint passes a **direct bound method**. The `# type: ignore[attr-defined]` on `sansio/blueprints.py:326` is the visible cost of the split — `send_static_file` exists only on the concrete `flask.blueprints.Blueprint`, not on the `sansio` class the registration code lives in.

**3. Caching consistency is preserved by deliberate duplication plus an explicit self-call.**
Both concrete classes carry a byte-identical `get_send_file_max_age`: `src/flask/app.py:281-306` and `src/flask/blueprints.py:55-80`. Each reads `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, returns `None` for `None`, `int(value.total_seconds())` for a `timedelta`, else the value (both docstrings admit "Note this is a duplicate of the same method in the Flask class"). `send_static_file` is duplicated too (`app.py:308-328`, `blueprints.py:82-102`); both guard on `has_static_folder`, then explicitly call `max_age = self.get_send_file_max_age(filename)` before `send_from_directory(...)`, under the comment "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too." That self-call is the mechanism: plain `flask.send_file` always resolves caching against the **app** (`src/flask/helpers.py:388-390` sets `kwargs["max_age"] = current_app.get_send_file_max_age`), so the blueprint path re-resolves against its **own** hook, keeping a subclass override effective per component.

Consistency is confirmed behaviourally, not just textually: the executor found identical source text, identical `co_code`, `co_consts` and AST body for the two hooks, with equal return values for config `None`, `0`, `3600`, `1:00:00`, `12:00:00` and `0:00:01.5` (→ `1`) — app and blueprint results equal in every case. Tests cover it: `tests/test_blueprints.py` ~195-206 (config value reaches `/admin/static/css/test.css` `Cache-Control`; `url_for("admin.static", ...) == "/admin/static/test.txt"`), ~222-244 `test_default_static_max_age` (subclass override `100` beats the config), and `tests/test_helpers.py:58,75-77`. The hook's origin is recorded in `CHANGES.rst:1292-1300` and it is documented in `docs/config.rst:250-262`.

**In one sentence:** `Scaffold` (sansio, no IO) supplies the static folder/URL configuration to both components; `Flask` and `Blueprint` each register their own static route through their own seam (`Flask.__init__` vs `Blueprint.register` → prefixed endpoint) and each own a duplicated `send_static_file`/`get_send_file_max_age` pair whose explicit self-call keeps caching consistent per component rather than collapsing to the app's.

### What this rests on
- Direct source reads: `src/flask/sansio/scaffold.py:52`, `sansio/blueprints.py:92-118` and `:322-327`, `src/flask/app.py:255-330`, `src/flask/blueprints.py:50-105`, `src/flask/helpers.py:388-390`.
- Executor's read-only import introspection: full MROs, attribute-resolution targets, and source/`co_code`/`co_consts`/AST equality plus equal cached-age returns across config types (run guarded because `.venv/.../flask.pth` points at a *different* worktree).
- Retriever's citations to `sansio/README.md`, `docs/blueprints.rst`, `docs/config.rst`, `CHANGES.rst` and the tests (not all re-read here).

### Contradiction and open points
- **Path contradiction:** the ranked chunks are labelled `flask/src/flask/...`, but no `flask/` directory exists at the worktree root; every claim above uses the real `src/flask/...` paths. Whether the ranked corpus is the same revision is **not established**.
- **Not established:** that the duplication is intended architecture rather than an unrefactored copy — no doc statement names this as a design intent; the planner explicitly put any de-duplication refactor out of scope. Whether a third divergent implementation exists anywhere outside `src/flask` was ruled out for the two hooks only by grep (four definitions total, plus two test-subclass overrides).
- `flask_mut2_i417ar2x/mutated_test.py` exists in the worktree but exercises `subdomain_matching`/`url_for`, defines neither hook, and was not treated as evidence.

Recorded as a shared-memory conclusion (`e59cba24829e39…`, keyed to `src/flask/sansio/scaffold.py`) for later tasks on this topic.
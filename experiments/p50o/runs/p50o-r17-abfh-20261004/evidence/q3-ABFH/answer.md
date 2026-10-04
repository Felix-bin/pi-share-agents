## The architecture

Static asset serving is split from the main application framework **by layer**, not by a plugin registry. The framework-agnostic `src/flask/sansio/` package owns the *declaration* of static assets, and the two concrete components — `Flask` in `src/flask/app.py` and `Blueprint` in `src/flask/blueprints.py` — own the *serving*.

**The boundary is stated explicitly.** `src/flask/sansio/README.md` says that `sansio` "cannot do any IO, nor be part of a likely IO path" and "cannot use the Flask globals." Serving a file is both IO and global-dependent, so it cannot live there.

**Shared configuration sits in the sansio base.** `src/flask/sansio/scaffold.py` defines `class Scaffold` (docstring: "Common behavior shared between `Flask` and `Blueprint`") supplying the three static properties both components need: `static_folder` (absolute path built from `root_path`), `has_static_folder`, and `static_url_path` (configured value, else `f"/{basename}".rstrip("/")`).

**Registration is a sansio concern; serving is a hook the concrete class must fill.** `src/flask/sansio/blueprints.py:323-328`, inside `Blueprint.register`, injects the route when a static folder is present:

```python
if self.has_static_folder:
    state.add_url_rule(
        f"{self.static_url_path}/<path:filename>",
        view_func=self.send_static_file,  # type: ignore[attr-defined]
        endpoint="static",
    )
```

The `# type: ignore[attr-defined]` is the concrete marker that the sansio layer *declares* the route but does not implement `send_static_file`. A grep of `src/flask/sansio/` for `get_send_file_max_age|send_static_file|send_from_directory` returns only this one reference, so registration and serving are genuinely separated rather than coexisting behind a flag.

**The two components that actually serve.** `Flask.__init__` (`src/flask/app.py:262-278`) registers its own static rule with a weakref-backed lambda into `self.send_static_file` — deliberately "without checking if static_folder exists" per the inline comment — and `src/flask/blueprints.py:18` declares `class Blueprint(SansioBlueprint)`, which does not redefine `register` (no `def register` in that file), so it inherits the sansio registration and supplies the sink methods: `app.py:281-328` and `blueprints.py:55-101`.

## How caching stays consistent across both

Consistency comes from **two duplicated implementations reading one config key**, not from shared code:

- `get_send_file_max_age` bodies are identical (`app.py:298`, `blueprints.py:72`): read `value = current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]`, return `None` if `None`, `int(value.total_seconds())` if a `timedelta`, else the value unchanged.
- The default is `"SEND_FILE_MAX_AGE_DEFAULT": None` (`app.py:201`), meaning "conditional requests instead of a timed cache."
- `send_static_file` bodies are likewise identical: raise `RuntimeError` if `not self.has_static_folder`, then `max_age = self.get_send_file_max_age(filename)`, then `send_from_directory(t.cast(str, self.static_folder), filename, max_age=max_age)`. The inline comment states the reason outright: "send_file only knows to call get_send_file_max_age on the app, call it here so it works for blueprints too."
- Both docstrings literally say "Note this is a duplicate of the same method in the Flask class." (verified present in both files — including, as a copy-paste artifact, in the `Flask` class itself).
- The generic path is kept on the same policy too: `src/flask/helpers.py:_prepare_send_file_kwargs` injects `kwargs["max_age"] = current_app.get_send_file_max_age` whenever `max_age` is None.

Because each component resolves `max_age` through its *own* `self.get_send_file_max_age`, a component-level override still wins while the shared key applies otherwise — which is exactly what `tests/test_blueprints.py:223-244` (`test_default_static_max_age`) demonstrates: a `Blueprint` subclass override returning `100` beats config set to `3600`/`7200`.

**Behaviorally confirmed.** The three source-cited tests pass (`tests/test_helpers.py::TestSendfile::test_static_file`, `tests/test_blueprints.py::test_templates_and_static`, `tests/test_blueprints.py::test_default_static_max_age` — 3 passed), and a standalone app-vs-blueprint comparison run against this worktree produced equal max-age for all three config shapes:

```
config=3600                            app 3600  blueprint 3600  equal=True
config=timedelta(seconds=7200)         app 7200  blueprint 7200  equal=True
config=None                            app None  blueprint None  equal=True
```

The distinct bodies served confirm the blueprint static route was really injected at `register_blueprint` time and served from the blueprint folder.

One route-precedence caveat the code itself flags: `src/flask/sansio/blueprints.py:144-147` warns that without a `url_prefix`, the app's static route takes precedence and the blueprint's static files are unreachable.

## What this rests on, and what is open

- **Rests on:** `sansio/README.md`; `sansio/scaffold.py:224-269`; `sansio/blueprints.py:273-328`; `app.py:201,262-328`; `blueprints.py:18,55-101`; `helpers.py:_prepare_send_file_kwargs`; `tests/test_helpers.py:44-86`; `tests/test_blueprints.py:195-206,223-244`; plus the executor's passing test run and equality check.
- **Established:** the separation is a layer boundary (sansio declares, concrete components serve), and caching consistency across the app and blueprint components comes from duplicated `get_send_file_max_age`/`send_static_file` pairs converging on the single `current_app.config["SEND_FILE_MAX_AGE_DEFAULT"]` key.
- **Not established:** the phrase "modular component registration architecture" is not a literal symbol, docstring or label anywhere in the worktree — mapping it onto the sansio/concrete `Scaffold`+`Blueprint.register` split is an inference from the observed code. No design-intent text or changelog entry for the split was located (`CHANGES.rst` and `docs/` were not searched), so the *intent* narrative is unverified.
- **Reproducibility caveat (material):** the `.venv`'s installed `flask` resolves outside this worktree, so `PYTHONPATH="src"` is required; a bare `pytest` here would exercise a different copy of Flask and any such result should be treated as untrustworthy for this worktree.
- **Out of scope / excluded:** `flask_mut2_i417ar2x/mutated_test.py` exists in the worktree root but exercises `subdomain_matching=False` with `url_for(..., subdomain=...)`; it is unrelated to static serving and was not run.
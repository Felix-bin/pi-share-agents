## Why the dotted-name test gates blueprint creation with a `ValueError`

The test does not merely assert a convention — it is a regression guard on a constructor-level validation, and it passes because the `Blueprint` constructor refuses dotted names before anything else happens.

**1. What the test actually exercises.** `tests/test_blueprints.py:254-256` is

```python
def test_dotted_name_not_allowed(app, client):
    with pytest.raises(ValueError):
        flask.Blueprint("app.ui", __name__)
```

The name literal `"app.ui"` deliberately contains a dot. The `app`/`client` fixtures are requested but never used in the body — a signal that the failure occurs inside `Blueprint(...)` itself, not at registration time. Its sibling `test_empty_name_not_allowed` (`tests/test_blueprints.py:259-261`) has the identical shape for `flask.Blueprint("", __name__)`.

**2. The guard that raises.** `Blueprint.__init__` validates the name immediately after `super().__init__(...)` and before `self.name = name` — `src/flask/sansio/blueprints.py:195-199`:

```python
if not name:
    raise ValueError("'name' may not be empty.")

if "." in name:
    raise ValueError("'name' may not contain a dot '.' character.")
```

This is the only name validation in the constructor (confirmed by direct read of lines 185-215). Because it fires before `self.name` is assigned and before any deferred registration, no application or request context is required — exactly matching the unused fixtures.

**3. The observed behaviour matches that guard.** The executor ran the named test on the repo's own `.venv` (Python 3.13.9; plain `python` on PATH has no flask installed): `.venv/Scripts/pytest.exe tests/test_blueprints.py::test_dotted_name_not_allowed -q` → exit 0, `1 passed in 0.07s`. Constructing directly, `flask.Blueprint('app.ui', __name__)` raises `ValueError: 'name' may not contain a dot '.' character.` — the **dot** message, not the empty-name message (`'name' may not be empty.`) that the adjacent test covers. So the test genuinely observes the dotted-name branch.

**4. Why the dot is forbidden at all.** `CHANGES.rst:504-506` (2.0.2 entry, issue 4041) states the rationale: "Show an error when a blueprint name contains a dot. The `.` has special meaning, it is used to separate (nested) blueprint names and the endpoint name." The mechanism it refers to is visible in `Blueprint.register` (`src/flask/sansio/blueprints.py:302-304`), where the registered name is assembled from that dot:

```python
name_prefix = options.get("name_prefix", "")
self_name = options.get("name", self.name)
name = f"{name_prefix}.{self_name}".lstrip(".")
```

The adjacent `register` docstring (lines 291-294) says nested blueprints are registered with their dotted name so same-named blueprints can be nested at different locations. A dot inside a user-supplied name would therefore be indistinguishable from the separator joining parent and child names, corrupting the name→blueprint map and the dotted endpoint strings.

**5. The endpoint side of the contract.** The blueprint is the framework's modular route component: `docs/blueprints.rst:1` is titled "Modular Applications with Blueprints", and the class docstring (`src/flask/sansio/blueprints.py:119-131`) describes it as "a collection of routes and other app-related functions that can be registered on a real application later", with `name` prepended to each endpoint name (lines 136-137). The dot participates directly in that: `docs/blueprints.rst:104-106` says blueprint rules are prefixed with the blueprint name "and separated by a dot (`.`)"; `docs/blueprints.rst:124-146` shows `url_for('parent.child.create')` → `/parent/child/create`; `docs/blueprints.rst:270-278` shows `url_for('admin.index')` and the relative `url_for('.index')`. Historical corroboration for the same delimiter constraint: `CHANGES.rst:928` — "Blueprint view function names may not contain dots. :pr:`2450`".

**Summary of the causal chain:** test → `Blueprint(...)` construction → `"." in name` guard in `__init__` → `ValueError` with the dot-specific message → motivated by the dot being the reserved separator between (nested) blueprint names and endpoint names.

---

### What this rests on
- `tests/test_blueprints.py:254-256` (test body, verified by read), `:259-261` (empty-name sibling).
- `src/flask/sansio/blueprints.py:195-199` (dot guard, verified by read), `:201` (`self.name` assignment), `:302-304` (`register` name assembly), `:119-131, 136-137` (class docstring), `:291-294` (`register` nesting docstring).
- `CHANGES.rst:504-506` (2.0.2 / issue 4041 rationale) and `CHANGES.rst:928` (view-function precedent).
- `docs/blueprints.rst:1, 104-106, 124-146, 270-278`.
- Executed result: `pytest tests/test_blueprints.py::test_dotted_name_not_allowed` → exit 0, `1 passed in 0.07s`; direct construction raises the dot message.

### Still open / limits
- No in-repo source beyond `CHANGES.rst:504-506` states *why* the dot is reserved; the "why" sentence here is the changelog's own wording, and the causal reconstruction from guard + separator mechanism is inference, not an explicit in-code comment.
- The attribution of this test as the regression test for issue 4041 is inference (the test file itself has no comment or docstring naming the issue).
- The test asserts only `ValueError` for the single literal `"app.ui"`; it does not assert the message text, and no test in the file was executed for dots in nested `register_blueprint(name=...)` paths — those lines were read, never run.
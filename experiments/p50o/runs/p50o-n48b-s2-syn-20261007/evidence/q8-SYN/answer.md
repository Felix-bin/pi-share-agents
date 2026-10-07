## Why a blueprint name containing a dot raises `ValueError`

The test guarantees the exception because the rejection is an **explicit guard in `Blueprint.__init__` that runs at construction time**, before any application or route registration. It is not an emergent failure that happens later during registration — the constructor itself checks the name and raises.

`tests/test_blueprints.py:254-256` is the whole test:

```python
def test_dotted_name_not_allowed(app, client):
    with pytest.raises(ValueError):
        flask.Blueprint("app.ui", __name__)
```

It only constructs a blueprint, wrapping the call in `pytest.raises(ValueError)`; it never touches `app` or `client`, and never registers or routes anything. The `app, client` fixtures are declared in the signature but not referenced in the body. So the test can only pass if the `ValueError` comes out of the constructor call itself.

It does. `src/flask/sansio/blueprints.py:195-199`, inside `Blueprint.__init__`:

```python
if not name:
    raise ValueError("'name' may not be empty.")

if "." in name:
    raise ValueError("'name' may not contain a dot '.' character.")
```

The dotted name takes the second branch, so `flask.Blueprint("app.ui", __name__)` raises `ValueError("'name' may not contain a dot '.' character.")` immediately. This was confirmed by execution, not only by reading: the target test passes in this worktree (`PYTHONPATH=$PWD/src ./.venv/Scripts/python.exe -m pytest tests/test_blueprints.py::test_dotted_name_not_allowed -q` → `1 passed in 0.07s`, exit 0), and a live call produced the traceback frame `src/flask/sansio/blueprints.py, line 199, in __init__`. A control in the same interpreter showed a dot-free name constructs successfully (`bp.name = appui`) while an empty name raises the *other* message (`'name' may not be empty.`) — so the dot rejection is specifically the dot guard, not a side effect of some broader validation.

**Why the dot is forbidden in the first place** — this is the rationale the guard encodes: the dot is Flask's reserved separator in endpoint keys. `BlueprintSetupState.add_url_rule` builds the final endpoint by joining three parts with dots, `src/flask/sansio/blueprints.py:112`:

```python
f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")
```

and `Blueprint.register` builds the nesting prefix the same way (`name = f"{name_prefix}.{self_name}".lstrip(".")`), forwarding it to child blueprints. The `register` docstring records the convention: "Nested blueprints are registered with their dotted name. This allows different blueprints with the same name to be nested at different locations." (`.. versionchanged:: 2.0.1`). The user-facing docs state it too: endpoints "are also prefixed with the name of the blueprint and separated by a dot (`.`)", with `url_for('parent.child.create')` → `/parent/child/create` and the `admin.index` example (`docs/blueprints.rst`). A dot inside the blueprint name would therefore be indistinguishable from the separator between nesting prefix, blueprint name and endpoint.

The same reserved-dot rule is enforced at the endpoint level as well: `Blueprint.add_url_rule` raises `ValueError` for a dotted `endpoint` and for a `view_func` whose `__name__` contains a dot (`test_route_decorator_custom_endpoint_with_dots`, `tests/test_blueprints.py:327-343`; `CHANGES.rst` records "Blueprint view function names may not contain dots").

**Reading taken:** I read "modular route component" as Flask's `Blueprint`, since that is the object the cited test constructs and the only modular route container in the sources. The task's question is answered in full under that reading.

## What this rests on, and what is open

- **Depends on:** `tests/test_blueprints.py:254-256` (test identity and body, read directly); `src/flask/sansio/blueprints.py:195-199` (the two guards), `:112` (dot-joined endpoint), `:290-293` (dotted-name registration docstring), all read directly; `docs/blueprints.rst:102-106` and the nesting/`admin.index` passages; the executed pytest run and the live traceback (`e078901db92dcb3f52a708c9679b935ccb11dee9f043f71792a3b57c66c7786d`).
- **One sentence of the "why" is an inference, and the sources never state it in one sentence:** no file says "dots are forbidden because the dot is the endpoint/nesting separator." The mechanism (dot-joined endpoint keys, dotted nested registration) is observed; the causal claim that this is *the* reason is assembled from it.
- **Environment caveat attached to the passing run:** the workspace `.venv` has a `flask.pth` pointing at a different copy of this repo, so `.venv` alone silently imports `flask` from elsewhere; the passing run above is attributed to this worktree only because `PYTHONPATH=$PWD/src` was set. For the two files involved the copies are byte-identical, so no conclusion changes. Plain `python -m pytest` fails earlier at conftest import (`ModuleNotFoundError: No module named 'flask'`).
- **Not established:** whether `flask_mut2_i417ar2x/` (untracked) is in scope; it appeared in `git status` but no evidence ties it to this question. No source file was modified by the runs.
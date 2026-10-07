## The flow of the `encoding` parameter

The encoding value travels as a plain named keyword argument through three hops, with no intermediate variable, wrapper, or conversion anywhere in between.

| Hop | Location | What happens |
|---|---|---|
| Parametrization — where the value is created | `tests/test_helpers.py:354` | `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))` |
| Pytest binding | `tests/test_helpers.py:355` | `def test_open_resource_with_encoding(tmp_path, encoding):` — the parametrized name is the function argument |
| Test writes a file with that encoding | `tests/test_helpers.py:357` | `(tmp_path / "test").write_text("test", encoding=encoding)` |
| Call under test | `tests/test_helpers.py:359` | `with app.open_resource("test", mode="rt", encoding=encoding) as f:` — forwarded by name; asserted at `:360` as `assert f.read() == "test"` |
| Receiver object | `src/flask/app.py:81` | `app` is `flask.Flask(__name__, root_path=os.fspath(tmp_path))` (`tests/test_helpers.py:356`), i.e. `class Flask(App)`; this is the only `open_resource` reachable from the test (`Blueprint.open_resource` at `src/flask/blueprints.py:104` is a different class; `src/flask/sansio/app.py` defines none) |
| Method signature — where the keyword lands | `src/flask/app.py:330-332` | `def open_resource(self, resource: str, mode: str = "rb", encoding: str \| None = None) -> t.IO[t.AnyStr]:` — the test's `encoding=` binds directly to this parameter by name |
| Root-path resolution | `src/flask/app.py:359` | `path = os.path.join(self.root_path, resource)` — the "relative to the root path" step, matching the `root_path=os.fspath(tmp_path)` given to the app |
| Final hop into `open()` | `src/flask/app.py:361` | `return open(path, mode, encoding=encoding)` — reached because `mode="rt"` passes the guard at `:358` and is not `"rb"` (`:360`) |

The docstring at `src/flask/app.py:348-349` states the contract — "Open the file with this encoding when opening in text mode. This is ignored when opening in binary mode" — and `:350-351` records `.. versionchanged:: 3.1 Added the ``encoding`` parameter.` The `:360` binary branch deliberately drops `encoding`, so the parameter reaches builtin `open()` only on the text-mode path this test takes.

The hop at `src/flask/app.py:361` is load-bearing, not decorative: with the same `mode="rt"` call, a `utf-16-le` file read with `encoding="utf-16-le"` yields `'test'`, while omitting the keyword yields `'t\x00e\x00s\x00t\x00'` — which would fail the `:360` assertion. Removing the forwarding would break the test; that is the causal link between the two ends of the flow.

## What this rests on

- Direct reads of `tests/test_helpers.py:348-360` and `src/flask/app.py:326-365` in this worktree (both stage reports cite the same line numbers).
- Execution (executor): `PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/test_helpers.py::test_open_resource_with_encoding -q` → `2 passed in 0.08s`, exit 0, with `flask` resolving to this worktree's `src/flask/__init__.py`; plus the negative-control comparison above.
- Static check that no other definition or monkeypatch intercepts the call: only `src/flask/app.py:330` defines `open_resource` on `Flask`, and `tests/conftest.py` patches `os.environ` entries and `sys.path` only.

## Open / not established

- The planned bare invocation `python -m pytest tests/test_helpers.py::test_open_resource_with_encoding -q` did not produce the result: exit 4, `ModuleNotFoundError: No module named 'flask'` from `tests/conftest.py`. An unqualified `.venv` run passes, but resolves `flask` outside this worktree; only the `PYTHONPATH=src` run demonstrates the flow against this source. The passing result stands for that command, not for the command as originally planned.
- The `"rb"` branch at `src/flask/app.py:360`, where `encoding` is deliberately ignored, is documented but not exercised by this test — its behavior is not established by this run.
- `flask_mut2_i417ar2x/mutated_test.py` in the worktree concerns `subdomain_matching`/`url_for` and has no relation to this flow; it is not a contradiction, just unrelated content.
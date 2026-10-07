## Where `encoding` flows

`encoding` travels as a plain keyword argument through a single hop, from the test into `Flask.open_resource`, and is then forwarded verbatim to the builtin `open()` — but only on the text-mode branch.

The ordered chain, each hop confirmed by reading the file:

1. `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))` — `tests/test_helpers.py:354`. The value originates from pytest parametrization; the test function itself is not called by any project code.
2. `def test_open_resource_with_encoding(tmp_path, encoding):` — `tests/test_helpers.py:355`, receiving that parametrized `encoding`.
3. The app under test is built as a bare application object: `app = flask.Flask(__name__, root_path=os.fspath(tmp_path))` — `tests/test_helpers.py:356`. So the receiver is a `flask.Flask` instance directly, not a blueprint, proxy, or helper.
4. The call site: `with app.open_resource("test", mode="rt", encoding=encoding) as f:` — `tests/test_helpers.py:359`. `encoding` is passed as a **keyword argument**, alongside `mode="rt"` (text mode).
5. The receiving method: `def open_resource(self, resource: str, mode: str = "rb", encoding: str | None = None) -> t.IO[t.AnyStr]:` — `src/flask/app.py:330-331`. Its docstring is the one that says "Open a resource file relative to :attr:`root_path`", and its default for `encoding` is `None`. There is no decorator or wrapper between the call and this body — the value lands here directly.
6. Root-path resolution happens inside that body: `path = os.path.join(self.root_path, resource)` — `src/flask/app.py:356`. This is where "relative to the root path" is actually realized.
7. The delivery to the builtin, split by mode:
   - binary: `return open(path, mode)  # pyright: ignore` — `src/flask/app.py:359`, taken when `mode == "rb"` (`src/flask/app.py:358`). `encoding` is **not** passed; it is dropped.
   - text: `return open(path, mode, encoding=encoding)` — `src/flask/app.py:361`. `encoding` is forwarded into the builtin `open()`.

Because the test uses `mode="rt"`, it follows the text branch and `encoding` reaches `open(path, "rt", encoding=encoding)` at `src/flask/app.py:361`. The method's own docstring corroborates the branch-dependent behavior: "Open the file with this encoding when opening in text mode. This is ignored when opening in binary mode," and "`.. versionchanged:: 3.1` Added the `encoding` parameter."

Two disambiguations that matter for naming the receiver correctly:

- The receiving method is `Flask.open_resource` in `src/flask/app.py`, **not** `App.open_resource`. `class Flask(App)` is at `src/flask/app.py:81`, and `App` itself is `class App(Scaffold)` at `src/flask/sansio/app.py:59`; the only mention of `open_resource` in the sansio module is a docstring reference (`src/flask/sansio/app.py:70`). The planner's step-2 text called the receiver "`App.open_resource`" — that label is a slip; the defining class is `Flask`. The file, line, and behavior it recorded (`src/flask/app.py:330`, forwarding at `:361`) are correct.
- A same-named method exists on blueprints at `src/flask/blueprints.py:104`, and a sibling `open_instance_resource` (default `encoding="utf-8"`, instance-path relative) is at `src/flask/app.py:364`. Neither is on this test's path: the test constructs a bare `Flask`. The chain above is the complete flow for this test; there is no additional hop.

## Basis and open points

- **Rests on:** direct reads of `tests/test_helpers.py:354-360` and `src/flask/app.py:326-370` in this working copy, plus a grep confirming `class Flask(App)` at `src/flask/app.py:81` and `class App(Scaffold)` at `src/flask/sansio/app.py:59`. This matches the recalled prior hops (memory `32842c8c535d`) and the retriever's evidence; both are consistent, and the executor stage was skipped by the complexity gate, so no executed result exists for this task.
- **Answered:** the full `encoding` flow from the test to the builtin `open()`, with `file:line` at each hop, including the mode branch that decides whether `encoding` is used.
- **Still open / not established:** no caller of `test_open_resource_with_encoding` other than pytest parametrization exists or was searched for beyond the test entry point; the line numbers are those of the current working copy and would drift if `src/flask/app.py` changes, though the named method and the forwarding call are the substantive answer.
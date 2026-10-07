# Answer: where `encoding` flows from the test to the app's root-relative file opener

**The flow is short and direct: `tests/test_helpers.py::test_open_resource_with_encoding` receives `encoding` from a `@pytest.mark.parametrize` decorator, forwards it as a keyword argument to `app.open_resource(...)` at `tests/test_helpers.py:359`, and lands in `Flask.open_resource` at `src/flask/app.py:330`. Because the test passes `mode="rt"`, the method's `if mode == "rb"` early-return is skipped, so the value is passed straight through to the builtin `open(path, mode, encoding=encoding)` at `src/flask/app.py:361`, with `path = os.path.join(self.root_path, resource)` — i.e. all the way to Python's builtin `open` in text mode.**

---

## 1. Source endpoint — the test function

**File:** `tests/test_helpers.py`, lines 354–360 (verified by direct read; the file is 360 lines long):

```python
@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))
def test_open_resource_with_encoding(tmp_path, encoding):
    app = flask.Flask(__name__, root_path=os.fspath(tmp_path))
    (tmp_path / "test").write_text("test", encoding=encoding)

    with app.open_resource("test", mode="rt", encoding=encoding) as f:
        assert f.read() == "test"
```

The immediately preceding sibling tests (same file, lines 338–351) show what is being verified and why `"rt"` matters:

```python
@pytest.mark.parametrize("mode", ("r", "rb", "rt"))
def test_open_resource(mode):
    app = flask.Flask(__name__)

    with app.open_resource("static/index.html", mode) as f:
        assert "<h1>Hello World!</h1>" in str(f.read())


@pytest.mark.parametrize("mode", ("w", "x", "a", "r+"))
def test_open_resource_exceptions(mode):
    app = flask.Flask(__name__)

    with pytest.raises(ValueError):
        app.open_resource("static/index.html", mode)
```

Imports at the top of the same file (lines 1–8):

```python
import io
import os

import pytest
import werkzeug.exceptions

import flask
from flask.helpers import get_debug_flag
```

A grep for `encoding` in `tests/test_helpers.py` returns only lines 354, 355, 357 and 359 — no other test in this file forwards an `encoding` argument, so this is the unique source of the trace:

```
test_helpers.py:354: @pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))
test_helpers.py:355: def test_open_resource_with_encoding(tmp_path, encoding):
test_helpers.py:357:     (tmp_path / "test").write_text("test", encoding=encoding)
test_helpers.py:359:     with app.open_resource("test", mode="rt", encoding=encoding) as f:
```

Line landmarks:
- **354** — `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))`: the *origin* of the value. Two runs: `encoding="utf-8"`, then `encoding="utf-16-le"`.
- **355** — the test signature binds that value into the `encoding` parameter.
- **356** — `app = flask.Flask(__name__, root_path=os.fspath(tmp_path))`: the app's `root_path` is redirected to pytest's `tmp_path`, which is what makes the target method the "opens files relative to the root path" one.
- **357** — the temp file is written with the same encoding, so the assertion at line 360 is a round-trip check.
- **359** — the single call site: `app.open_resource("test", mode="rt", encoding=encoding)`.

## 2. Sink endpoint — the method that opens files relative to `root_path`

**File:** `src/flask/app.py`, lines 330–361 (verified by direct read):

```python
    def open_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = None
    ) -> t.IO[t.AnyStr]:
        """Open a resource file relative to :attr:`root_path` for reading.

        For example, if the file ``schema.sql`` is next to the file
        ``app.py`` where the ``Flask`` app is defined, it can be opened
        with:

        .. code-block:: python

            with app.open_resource("schema.sql") as f:
                conn.executescript(f.read())

        :param resource: Path to the resource relative to :attr:`root_path`.
        :param mode: Open the file in this mode. Only reading is supported,
            valid values are ``"r"`` (or ``"rt"``) and ``"rb"``.
        :param encoding: Open the file with this encoding when opening in text
            mode. This is ignored when opening in binary mode.

        .. versionchanged:: 3.1
            Added the ``encoding`` parameter.
        """
        if mode not in {"r", "rt", "rb"}:
            raise ValueError("Resources can only be opened for reading.")

        path = os.path.join(self.root_path, resource)

        if mode == "rb":
            return open(path, mode)  # pyright: ignore

        return open(path, mode, encoding=encoding)
```

The docstring's first line literally names the target: *"Open a resource file relative to :attr:`root_path` for reading."* Line landmarks:
- **330–331** — `def open_resource(self, resource: str, mode: str = "rb", encoding: str | None = None)`. **`encoding` is a keyword parameter defaulting to `None`.**
- **353–354** — the guard `if mode not in {"r", "rt", "rb"}: raise ValueError("Resources can only be opened for reading.")` — `"rt"` is in the allowed set, so the test's mode passes.
- **356** — `path = os.path.join(self.root_path, resource)` — this is the "relative to the root path" step.
- **358–359** — `if mode == "rb": return open(path, mode)` — the binary early return, **not taken** for `"rt"`.
- **361** — `return open(path, mode, encoding=encoding)` — the terminal transfer.

This method is defined directly on `class Flask(App):` (the class statement is at `src/flask/app.py:81`), and it is **not** present in the sansio layer. A grep over `src/flask/app.py`, `src/flask/blueprints.py` and `src/flask/sansio/app.py` yields:

```
src/flask/app.py:92:    For more information about resource loading, see :func:`open_resource`.
src/flask/app.py:330:    def open_resource(
src/flask/app.py:341:            with app.open_resource("schema.sql") as f:
src/flask/app.py:363:    def open_instance_resource(
src/flask/app.py:367:    ...Unlike :meth:`open_resource`, files in the
src/flask/blueprints.py:104:    def open_resource(
src/flask/blueprints.py:108:    ...the app's :meth:`~.Flask.open_resource`
src/flask/sansio/app.py:70:    For more information about resource loading, see :func:`open_resource`.
```

There is no method definition in `src/flask/sansio/app.py` — line 70 is a docstring cross-reference only.

## 3. Why `os.path.join(self.root_path, ...)` resolves to the temp dir

**File:** `src/flask/sansio/scaffold.py`, lines 95–100:

```python
        if root_path is None:
            root_path = get_root_path(self.import_name)

        #: Absolute path to the package on the filesystem. Used to look
        #: up resources contained in the package.
        self.root_path = root_path
```

**File:** `src/flask/app.py`, lines 227–250 (Flask `__init__` tail + forwarding):

```python
        instance_path: str | None = None,
        instance_relative_config: bool = False,
        root_path: str | None = None,
    ):
        super().__init__(
            import_name=import_name,
            static_url_path=static_url_path,
            static_folder=static_folder,
            static_host=static_host,
            host_matching=host_matching,
            subdomain_matching=subdomain_matching,
            template_folder=template_folder,
            instance_path=instance_path,
            instance_relative_config=instance_relative_config,
            root_path=root_path,
        )
```

So the test's `root_path=os.fspath(tmp_path)` (test line 356) is forwarded through `App.__init__` into `Scaffold.__init__`, which stores it on `self.root_path` (`scaffold.py:100`); `os.path.join(self.root_path, "test")` (`app.py:356`) therefore resolves to the file written at test line 357.

## 4. Step-by-step transfer chain (the answer)

1. **`tests/test_helpers.py:354`** — `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))` supplies the value to the test function: run 1 `encoding="utf-8"`, run 2 `encoding="utf-16-le"`.
2. **`tests/test_helpers.py:355`** — the value is bound to the test's `encoding` parameter.
3. **`tests/test_helpers.py:356`** — the app is built with `root_path=os.fspath(tmp_path)`, redirecting resource lookups to the temp directory (stored at `src/flask/sansio/scaffold.py:100`).
4. **`tests/test_helpers.py:359`** — `app.open_resource("test", mode="rt", encoding=encoding)` forwards the value **unchanged, as a keyword argument**, into the app method. This is the sole hop between the two endpoints.
5. **`src/flask/app.py:330–331`** — `Flask.open_resource(self, resource="test", mode="rt", encoding=<utf-8 | utf-16-le>)` receives it; the parameter's own default is `None` but is never used here.
6. **`src/flask/app.py:353–354`** — `mode="rt"` is in `{"r", "rt", "rb"}`, so the `ValueError` guard passes.
7. **`src/flask/app.py:356`** — `path = os.path.join(self.root_path, resource)` builds the absolute path from the redirected root.
8. **`src/flask/app.py:358–359`** — `if mode == "rb"` is **False** (`"rt" != "rb"`), so the binary early return is bypassed and `encoding` is **not dropped**.
9. **`src/flask/app.py:361`** — `return open(path, mode, encoding=encoding)` hands the value to the Python builtin `open`. **This is the terminal point**; there is no further Flask-level hop.

## 5. Runtime confirmation

The executor verified the terminal hop dynamically by spying on the builtin `open` while calling `app.open_resource('test', mode='rt', encoding='utf-16-le')` on an app whose `root_path` was a temp directory. Complete captured output:

```
builtin open call args = [(('C:\\Users\\oobbee\\AppData\\Local\\Temp\\tmp0r9fjgts\\test', 'rt'), {'encoding': 'utf-16-le'})]
default read -> 't\x00e\x00s\x00t\x00'
binary mode bytes prefix -> b't\x00e\x00s\x00t\x00'
mode=w raised ValueError: Resources can only be opened for reading.
```

This proves (a) the value arrives at the builtin as `open((path, 'rt'), encoding='utf-16-le')`, i.e. positionally `path` and `mode` with `encoding` passed as the same keyword; (b) dropping the encoding yields platform-default mojibake `'t\x00e\x00s\x00t\x00'`, confirming the parameter is genuinely consulted in text mode; and (c) binary mode returns raw bytes, confirming the `if mode == "rb"` branch is a *separate* path that ignores `encoding`.

Reflection on the running code returned:

```
Flask.open_resource defined in: ...\seal\src\flask\app.py
qualname: Flask.open_resource
Flask.open_resource signature: (self, resource: 'str', mode: 'str' = 'rb', encoding: 'str | None' = None) -> 't.IO[t.AnyStr]'
Flask.open_resource default encoding: None
Flask.open_instance_resource default encoding: 'utf-8'
Blueprint.open_resource default encoding: 'utf-8'
open_resource in sansio App? False
open_instance_resource in sansio App? False
Flask MRO: ['Flask', 'App', 'Scaffold', 'object']
```

The focused test passed:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests/test_helpers.py::test_open_resource_with_encoding -q
..                                                                       [100%]
2 passed in 0.09s
```

and the whole suite passed:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 6.21s
```

The verbose run (`-vv -rA --tb=long --durations=0`, exit status 0) recorded the parametrized cases individually:

```
tests/test_helpers.py::test_open_resource_with_encoding[utf-8] <- ...\tests\test_helpers.py PASSED [ 66%]
tests/test_helpers.py::test_open_resource_with_encoding[utf-16-le] <- ...\tests\test_helpers.py PASSED [ 66%]
```
```
PASSED tests/test_helpers.py::test_open_resource_with_encoding[utf-8]
PASSED tests/test_helpers.py::test_open_resource_with_encoding[utf-16-le]
```
```
============================= 489 passed in 6.34s =============================
```

(978 `PASSED` lines = 489 run lines + 489 `-rA` summary lines, 0 `FAILED`; the 18 `ERROR`-matching lines are captured application log output from tests that deliberately exercise error paths, not test failures.)

## 6. Two caveats worth flagging

**(a) Three look-alike methods, three different `encoding` defaults.** `Flask.open_resource` (the root-path method traced here) defaults to **`None`** (`src/flask/app.py:331`), whereas the other two default to `"utf-8"`:

`Blueprint.open_resource` (`src/flask/blueprints.py:104–105`):

```python
    def open_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = "utf-8"
    ) -> t.IO[t.AnyStr]:
```

`Flask.open_instance_resource` (`src/flask/app.py:363–364`, and note it uses `instance_path` and allows writing):

```python
    def open_instance_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = "utf-8"
    ) -> t.IO[t.AnyStr]:
        """Open a resource file relative to the application's instance folder
        :attr:`instance_path`. Unlike :meth:`open_resource`, files in the
        instance folder can be opened for writing.

        :param resource: Path to the resource relative to :attr:`instance_path`.
        :param mode: Open the file in this mode.
        :param encoding: Open the file with this encoding when opening in text
            mode. This is ignored when opening in binary mode.

        .. versionchanged:: 3.1
            Added the ``encoding`` parameter.
        """
        path = os.path.join(self.instance_path, resource)

        if "b" in mode:
            return open(path, mode)

        return open(path, mode, encoding=encoding)
```

In this test the default is irrelevant, because the argument is always supplied by the parametrization.

**(b) The changelog's "defaults to `utf-8`" claim does not hold for the traced method.** `CHANGES.rst`, lines 35–37 (under *Version 3.1.0 / Released 2024-11-13*, lines 25–28):

```
-   ``Flask.open_resource``/``open_instance_resource`` and
    ``Blueprint.open_resource`` take an ``encoding`` parameter to use when
    opening in text mode. It defaults to ``utf-8``. :issue:`5504`
```

That wording matches the blueprint and instance methods but *not* `Flask.open_resource`'s root-path signature, which defaults to `None` (platform default). The test passes regardless precisely because it always supplies `encoding=` explicitly. This also explains the parameter's provenance: it is a Flask 3.1 addition. The related historical entry explaining why `"rt"` is a legal mode is at `CHANGES.rst:686–687`:

```
-   ``open_resource`` accepts the "rt" file mode. This still does the
    same thing as "r". :issue:`3163`
```

## 7. Transfer-point table (paths + lines)

| # | Location | Content |
|---|----------|---------|
| 1 | `tests/test_helpers.py:354` | `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))` |
| 2 | `tests/test_helpers.py:355` | `def test_open_resource_with_encoding(tmp_path, encoding):` |
| 3 | `tests/test_helpers.py:356` | `app = flask.Flask(__name__, root_path=os.fspath(tmp_path))` |
| 4 | `tests/test_helpers.py:359` | `with app.open_resource("test", mode="rt", encoding=encoding) as f:` |
| 5 | `src/flask/app.py:330–331` | `def open_resource(self, resource: str, mode: str = "rb", encoding: str | None = None)` |
| 6 | `src/flask/app.py:353–354` | `if mode not in {"r", "rt", "rb"}:` (guard; `"rt"` passes) |
| 7 | `src/flask/app.py:356` | `path = os.path.join(self.root_path, resource)` |
| 8 | `src/flask/app.py:358–359` | `if mode == "rb": return open(path, mode)` — **not taken** for `"rt"` |
| 9 | `src/flask/app.py:361` | `return open(path, mode, encoding=encoding)` — terminal transfer to builtin `open` |
| — | `src/flask/sansio/scaffold.py:100` | `self.root_path = root_path` (where the redirected root is stored) |
| — | `src/flask/blueprints.py:105` | contrast default `encoding: str | None = "utf-8"` |
| — | `src/flask/app.py:364` | contrast default `encoding: str | None = "utf-8"` (instance method) |

**In one sentence:** the value originates in the `@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))` decorator at `tests/test_helpers.py:354`, is carried as the keyword `encoding=encoding` in the call `app.open_resource("test", mode="rt", encoding=encoding)` at `tests/test_helpers.py:359`, is received by `Flask.open_resource` at `src/flask/app.py:330`, survives the `mode` guard at `app.py:353–354`, and — because `mode="rt"` makes the `if mode == "rb"` early return at `app.py:358–359` fail — flows unmodified into `return open(path, mode, encoding=encoding)` at `src/flask/app.py:361` relative to the redirected `root_path` captured at `src/flask/sansio/scaffold.py:100`.

### Minor discrepancies found in the upstream materials (cosmetic only)
- The plan/evidence described `tests/test_helpers.py` as ending at line 361; it is **360 lines** (`wc -l`), with the parametrized function occupying 354–360. All individual code line numbers cited above verified correct.
- The plan/evidence described `flask_mut2_i417ar2x/mutated_test.py` as 18 lines; `wc -l` reports **22**. That file is unrelated to the task in any case — it is a `url_for`/subdomain script with no `open_resource` or `encoding` usage.
- Environment note for reproducing the dynamic checks: the repository's virtualenv had `flask` resolving to a different copy of the tree, so every command was run with `PYTHONPATH="$PWD/src"` to ensure the local `src/flask` was imported (confirmed: `flask.__file__` and `flask.app.__file__` both pointed at this working directory's `src/flask`).
# Interaction between the `(iname, aname)` parametrization of `test_locate_app_raises` and the exception-handling semantics of `locate_app`

## Answer in one paragraph

`test_locate_app_raises` parametrizes exactly two arguments — `iname` (the import name) and `aname` (the app name) — and never passes `raise_if_not_found`, so every case executes `locate_app(iname, aname)` with the default `raise_if_not_found=True`. The eight tuples are deliberately drawn from *both* of `locate_app`'s failure domains: the import domain (`notanapp.py`, `cliapp/app`, `cliapp.message.txt`, `cliapp.importerrorapp`) and the app-selection domain (`cliapp.app:notanapp`, `cliapp.factory:create_app2("foo")`, `cliapp.factory:create_app(`, `cliapp.factory:no_app`). Because the test's only assertion is `with pytest.raises(NoAppException)`, and because `locate_app` funnels *every* one of those failures through `NoAppException` — import failures in its `except ImportError` block, selection failures in `find_best_app` / `find_app_by_string` — the parametrization forces every raise site to fire and to fire as the same type. "Fails consistently" therefore means: for all eight pairs the function raises `NoAppException` instead of returning a value (which `pytest.raises` cannot accept) or leaking a raw `ImportError` / `AttributeError` / `TypeError` / `SyntaxError`. Two traceback-frame inspections make that uniformity happen: the `sys.exc_info()[2].tb_next` depth test separates "module not found" (depth 1 → the `raise_if_not_found`-gated branch) from "the module's own body raised `ImportError`" (depth > 1 → unconditional `NoAppException`), and `_called_with_wrong_args` separates "the caller passed the wrong arguments to a factory" (→ `NoAppException`) from "the factory itself raised `TypeError`" (→ re-raised raw). The deliberately excluded case is `raise_if_not_found=False`, which is tested separately by `test_locate_app_suppress_raise` — the stated exception to the consistency rule.

---

## 1. The test and its parametrization (the subject)

**File:** `tests/test_cli.py`, lines 198–219 (the exception-raising test) with its adjacent controls:

```python
# tests/test_cli.py, lines 174-196
@pytest.mark.parametrize(
    "iname,aname,result",
    (
        ("cliapp.app", None, "testapp"),
        ("cliapp.app", "testapp", "testapp"),
        ("cliapp.factory", None, "app"),
        ("cliapp.factory", "create_app", "app"),
        ("cliapp.factory", "create_app()", "app"),
        ("cliapp.factory", 'create_app2("foo", "bar")', "app2_foo_bar"),
        # trailing comma space
        ("cliapp.factory", 'create_app2("foo", "bar", )', "app2_foo_bar"),
        # strip whitespace
        ("cliapp.factory", " create_app () ", "app"),
    ),
)
def test_locate_app(test_apps, iname, aname, result):
    assert locate_app(iname, aname).name == result

# tests/test_cli.py, lines 198-219
@pytest.mark.parametrize(
    "iname,aname",
    (
        ("notanapp.py", None),
        ("cliapp/app", None),
        ("cliapp.app", "notanapp"),
        # not enough arguments
        ("cliapp.factory", 'create_app2("foo")'),
        # invalid identifier
        ("cliapp.factory", "create_app("),
        # no app returned
        ("cliapp.factory", "no_app"),
        # nested import error
        ("cliapp.importerrorapp", None),
        # not a Python file
        ("cliapp.message.txt", None),
    ),
)
def test_locate_app_raises(test_apps, iname, aname):
    with pytest.raises(NoAppException):
        locate_app(iname, aname)

# tests/test_cli.py, lines 221-228
def test_locate_app_suppress_raise(test_apps):
    app = locate_app("notanapp.py", None, raise_if_not_found=False)
    assert app is None

    # only direct import error is suppressed
    with pytest.raises(NoAppException):
        locate_app("cliapp.importerrorapp", None, raise_if_not_found=False)
```

The parametrization decorator names exactly `"iname,aname"`; the test signature binds exactly `iname, aname` (plus the fixture). There is no third parameter, and no call site passes `raise_if_not_found`, so the default `True` applies to all eight cases. The comment lines inside the tuple show the cases were *chosen* to hit distinct branches (`# nested import error`, `# no app returned`, `# not enough arguments`, `# invalid identifier`, `# not a Python file`), which is precisely the point of the interaction: one parametrized test drives every failure path and asserts one exception type.

`NoAppException` and `locate_app` are imported directly from `flask.cli`, so the assertion type-checks the class defined in this source tree:

```python
# tests/test_cli.py, lines 1-33 (header)
# This file was part of Flask-CLI and was modified under the terms of
# its Revised BSD License. Copyright © 2015 CERN.
import importlib.metadata
import os
import platform
import ssl
import sys
import types
from functools import partial
from pathlib import Path

import click
import pytest
from _pytest.monkeypatch import notset
from click.testing import CliRunner

from flask import Blueprint
from flask import current_app
from flask import Flask
from flask.cli import AppGroup
from flask.cli import find_best_app
from flask.cli import FlaskGroup
from flask.cli import get_version
from flask.cli import load_dotenv
from flask.cli import locate_app
from flask.cli import NoAppException
from flask.cli import prepare_import
from flask.cli import run_command
from flask.cli import ScriptInfo
from flask.cli import with_appcontext

cwd = Path.cwd()
test_path = (Path(__file__) / ".." / "test_apps").resolve()
```

## 2. The exception type the test asserts

**File:** `src/flask/cli.py`, lines 37–38:

```python
class NoAppException(click.UsageError):
    """Raised if an application cannot be found or loaded."""
```

Verified at runtime:

```
NoAppException MRO: ['NoAppException', 'UsageError', 'ClickException', 'Exception', 'BaseException', 'object']
is subclass of click.UsageError: True
```

`pytest.raises(NoAppException)` is therefore a single, specific type assertion — not a message match, not a base-`Exception` catch-all, and not satisfiable by a returned value. `NoAppException` is referred to in `tests/test_cli.py` at lines 26, 112, 118, 125, 218, 227, 274 and in `src/flask/cli.py` at lines 37, 60, 80, 87, 131, 142, 159, 163, 170, 183, 194, 250, 255, 359, 624, 646 — every failure path of the app-location machinery funnels through this one class.

## 3. The application location function — `locate_app` (complete body)

**File:** `src/flask/cli.py`, lines 229–264:

```python
@t.overload
def locate_app(
    module_name: str, app_name: str | None, raise_if_not_found: t.Literal[True] = True
) -> Flask: ...


@t.overload
def locate_app(
    module_name: str, app_name: str | None, raise_if_not_found: t.Literal[False] = ...
) -> Flask | None: ...


def locate_app(
    module_name: str, app_name: str | None, raise_if_not_found: bool = True
) -> Flask | None:
    try:
        __import__(module_name)
    except ImportError:
        # Reraise the ImportError if it occurred within the imported module.
        # Determine this by checking whether the trace has a depth > 1.
        if sys.exc_info()[2].tb_next:  # type: ignore[union-attr]
            raise NoAppException(
                f"While importing {module_name!r}, an ImportError was"
                f" raised:\n\n{traceback.format_exc()}"
            ) from None
        elif raise_if_not_found:
            raise NoAppException(f"Could not import {module_name!r}.") from None
        else:
            return None

    module = sys.modules[module_name]

    if app_name is None:
        return find_best_app(module)
    else:
        return find_app_by_string(module, app_name)
```

The structure that makes the uniform type contract possible:

- **Import domain:** the entire `__import__` failure is caught as `ImportError` and re-emitted as `NoAppException`. A raw `ImportError` can never escape the catch block. The branch taken is decided by traceback depth: `sys.exc_info()[2].tb_next` truthy means the traceback has more than the `__import__` frame — i.e. the imported module's own body raised `ImportError` — and that branch raises unconditionally. Only the depth-1 branch consults `raise_if_not_found`.
- **Selection domain:** once import succeeds, `app_name is None` routes to `find_best_app(module)` and any non-`None` `app_name` routes to `find_app_by_string(module, app_name)`. Both return a `Flask` or raise `NoAppException` (next sections).

## 4. The app-selection side: `find_best_app`, `_called_with_wrong_args`, `find_app_by_string`

**File:** `src/flask/cli.py`, lines 41–91:

```python
def find_best_app(module: ModuleType) -> Flask:
    """Given a module instance this tries to find the best possible
    application in the module or raises an exception.
    """
    from . import Flask

    # Search for the most common names first.
    for attr_name in ("app", "application"):
        app = getattr(module, attr_name, None)

        if isinstance(app, Flask):
            return app

    # Otherwise find the only object that is a Flask instance.
    matches = [v for v in module.__dict__.values() if isinstance(v, Flask)]

    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        raise NoAppException(
            "Detected multiple Flask applications in module"
            f" '{module.__name__}'. Use '{module.__name__}:name'"
            " to specify the correct one."
        )

    # Search for app factory functions.
    for attr_name in ("create_app", "make_app"):
        app_factory = getattr(module, attr_name, None)

        if inspect.isfunction(app_factory):
            try:
                app = app_factory()

                if isinstance(app, Flask):
                    return app
            except TypeError as e:
                if not _called_with_wrong_args(app_factory):
                    raise

                raise NoAppException(
                    f"Detected factory '{attr_name}' in module '{module.__name__}',"
                    " but could not call it without arguments. Use"
                    f" '{module.__name__}:{attr_name}(args)'"
                    " to specify arguments."
                ) from e

    raise NoAppException(
        "Failed to find Flask application or factory in module"
        f" '{module.__name__}'. Use '{module.__name__}:name'"
        " to specify one."
    )
```

**File:** `src/flask/cli.py`, lines 94–116 — the discriminator that keeps a signature-mismatch `TypeError` from escaping as a `TypeError`:

```python
def _called_with_wrong_args(f: t.Callable[..., Flask]) -> bool:
    """Check whether calling a function raised a ``TypeError`` because
    the call failed or because something in the factory raised the
    error.

    :param f: The function that was called.
    :return: ``True`` if the call failed.
    """
    tb = sys.exc_info()[2]

    try:
        while tb is not None:
            if tb.tb_frame.f_code is f.__code__:
                # In the function, it was called successfully.
                return False

            tb = tb.tb_next

        # Didn't reach the function.
        return True
    finally:
        # Delete tb to break a circular reference.
        # https://docs.python.org/2/library/sys.html#sys.exc_info
        del tb
```

**File:** `src/flask/cli.py`, lines 120–197:

```python
def find_app_by_string(module: ModuleType, app_name: str) -> Flask:
    """Check if the given string is a variable name or a function. Call
    a function to get the app instance, or return the variable directly.
    """
    from . import Flask

    # Parse app_name as a single expression to determine if it's a valid
    # attribute name or function call.
    try:
        expr = ast.parse(app_name.strip(), mode="eval").body
    except SyntaxError:
        raise NoAppException(
            f"Failed to parse {app_name!r} as an attribute name or function call."
        ) from None

    if isinstance(expr, ast.Name):
        name = expr.id
        args = []
        kwargs = {}
    elif isinstance(expr, ast.Call):
        # Ensure the function name is an attribute name only.
        if not isinstance(expr.func, ast.Name):
            raise NoAppException(
                f"Function reference must be a simple name: {app_name!r}."
            )

        name = expr.func.id

        # Parse the positional and keyword arguments as literals.
        try:
            args = [ast.literal_eval(arg) for arg in expr.args]
            kwargs = {
                kw.arg: ast.literal_eval(kw.value)
                for kw in expr.keywords
                if kw.arg is not None
            }
        except ValueError:
            # literal_eval gives cryptic error messages, show a generic
            # message with the full expression instead.
            raise NoAppException(
                f"Failed to parse arguments as literal values: {app_name!r}."
            ) from None
    else:
        raise NoAppException(
            f"Failed to parse {app_name!r} as an attribute name or function call."
        )

    try:
        attr = getattr(module, name)
    except AttributeError as e:
        raise NoAppException(
            f"Failed to find attribute {name!r} in {module.__name__!r}."
        ) from e

    # If the attribute is a function, call it with any args and kwargs
    # to get the real application.
    if inspect.isfunction(attr):
        try:
            app = attr(*args, **kwargs)
        except TypeError as e:
            if not _called_with_wrong_args(attr):
                raise

            raise NoAppException(
                f"The factory {app_name!r} in module"
                f" {module.__name__!r} could not be called with the"
                " specified arguments."
            ) from e
    else:
        app = attr

    if isinstance(app, Flask):
        return app

    raise NoAppException(
        "A valid Flask application was not obtained from"
        f" '{module.__name__}:{app_name}'."
    )
```

Every failure exit of `find_app_by_string` is a `NoAppException`: `SyntaxError` from `ast.parse`; a non-simple call target; `ValueError` from `ast.literal_eval`; a non-`Name`/non-`Call` expression; `AttributeError` from `getattr`; a call-signature `TypeError` accepted by `_called_with_wrong_args`; and the terminal "not a Flask instance" case. The one deliberate leak is the `if not _called_with_wrong_args(attr): raise` line — a `TypeError` raised *inside* a factory body is re-raised as a raw `TypeError`, which is exactly what the companion test asserts (see §8).

## 5. The fixture and app modules the parametrization points at

**File:** `tests/conftest.py`, lines 72–81 — every parametrized case takes `test_apps`:

```python
@pytest.fixture
def test_apps(monkeypatch):
    monkeypatch.syspath_prepend(os.path.join(os.path.dirname(__file__), "test_apps"))
    original_modules = set(sys.modules.keys())

    yield

    # Remove any imports cached during the test. Otherwise "import app"
    # will work in the next test even though it's no longer on the path.
    for key in sys.modules.keys() - original_modules:
        sys.modules.pop(key)
```

This is what makes the depth-1 vs. nested `ImportError` distinction reproducible case-by-case: the package is importable for the duration of a case, and the imported modules are evicted afterwards.

**File:** `tests/test_apps/cliapp/__init__.py` — empty (a regular package; reading it produced no output).

**File:** `tests/test_apps/cliapp/app.py` (complete):

```python
from flask import Flask

testapp = Flask("testapp")
```

**File:** `tests/test_apps/cliapp/factory.py` (complete):

```python
from flask import Flask


def create_app():
    return Flask("app")


def create_app2(foo, bar):
    return Flask("_".join(["app2", foo, bar]))


def no_app():
    pass
```

**File:** `tests/test_apps/cliapp/importerrorapp.py` (complete):

```python
from flask import Flask

raise ImportError()

testapp = Flask("testapp")
```

**File:** `tests/test_apps/cliapp/message.txt` (complete):

```text
So long, and thanks for all the fish.
```

These map one-to-one onto the parametrization: `cliapp.app` imports cleanly and has a lone `Flask` (`testapp`); `cliapp.factory` imports cleanly, with `create_app` callable with no args, `create_app2` requiring exactly two, and `no_app` returning `None`; `cliapp.importerrorapp` raises `ImportError` **in its own body** (so the traceback has a second frame); `cliapp.message.txt` is not a Python module; `notanapp.py` does not exist anywhere in the tree — the executor verified this:

```
$ grep -rn "notanapp" . --include=*.py
./tests/test_cli.py:202:        ("notanapp.py", None),
./tests/test_cli.py:204:        ("cliapp.app", "notanapp"),
./tests/test_cli.py:223:    app = locate_app("notanapp.py", None, raise_if_not_found=False)
$ find . -name 'notanapp*'
(no output)
```

and `cliapp/app` contains a slash, which `__import__` cannot resolve as a module name — both are therefore depth-1 import failures.

## 6. Execution evidence (reproduced in full)

Environment note from the executor: plain `python` is CPython 3.14.0 **without** Flask, so the venv interpreter (3.13.9) was used with `PYTHONPATH=src` to force the working directory's own `src/flask` (the venv's `flask.pth` pointed at a sibling path; resolution was verified via `flask.__file__`).

### 6.1 The named tests — the plan's Step 5 invocation

```
PYTHONPATH="src" .venv/Scripts/python.exe -m pytest tests/test_cli.py::test_locate_app_raises tests/test_cli.py::test_locate_app tests/test_cli.py::test_locate_app_suppress_raise -v -rA
```

Full output (exit status **0**):

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q8-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q8-TXT\seal
configfile: pyproject.toml
collecting ... collected 17 items

tests/test_cli.py::test_locate_app_raises[notanapp.py-None] PASSED       [  5%]
tests/test_cli.py::test_locate_app_raises[cliapp/app-None] PASSED        [ 11%]
tests/test_cli.py::test_locate_app_raises[cliapp.app-notanapp] PASSED    [ 17%]
tests/test_cli.py::test_locate_app_raises[cliapp.factory-create_app2("foo")] PASSED [ 23%]
tests/test_cli.py::test_locate_app_raises[cliapp.factory-create_app(] PASSED [ 29%]
tests/test_cli.py::test_locate_app_raises[cliapp.factory-no_app] PASSED  [ 35%]
tests/test_cli.py::test_locate_app_raises[cliapp.importerrorapp-None] PASSED [ 41%]
tests/test_cli.py::test_locate_app_raises[cliapp.message.txt-None] PASSED [ 47%]
tests/test_cli.py::test_locate_app[cliapp.app-None-testapp] PASSED       [ 52%]
tests/test_cli.py::test_locate_app[cliapp.app-testapp-testapp] PASSED    [ 58%]
tests/test_cli.py::test_locate_app[cliapp.factory-None-app] PASSED       [ 64%]
tests/test_cli.py::test_locate_app[cliapp.factory-create_app-app] PASSED [ 70%]
tests/test_cli.py::test_locate_app[cliapp.factory-create_app()-app] PASSED [ 76%]
tests/test_cli.py::test_locate_app[cliapp.factory-create_app2("foo", "bar")-app2_foo_bar] PASSED [ 82%]
tests/test_cli.py::test_locate_app[cliapp.factory-create_app2("foo", "bar", )-app2_foo_bar] PASSED [ 88%]
tests/test_cli.py::test_locate_app[cliapp.factory- create_app () -app] PASSED [ 94%]
tests/test_cli.py::test_locate_app_suppress_raise PASSED                 [100%]

=================================== PASSES ====================================
=========================== short test summary info ===========================
PASSED tests/test_cli.py::test_locate_app_raises[notanapp.py-None]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp/app-None]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.app-notanapp]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.factory-create_app2("foo")]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.factory-create_app(]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.factory-no_app]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.importerrorapp-None]
PASSED tests/test_cli.py::test_locate_app_raises[cliapp.message.txt-None]
PASSED tests/test_cli.py::test_locate_app[cliapp.app-None-testapp]
PASSED tests/test_cli.py::test_locate_app[cliapp.app-testapp-testapp]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory-None-app]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory-create_app-app]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory-create_app()-app]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory-create_app2("foo", "bar")-app2_foo_bar]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory-create_app2("foo", "bar", )-app2_foo_bar]
PASSED tests/test_cli.py::test_locate_app[cliapp.factory- create_app () -app]
PASSED tests/test_cli.py::test_locate_app_suppress_raise
============================= 17 passed in 0.31s ==============================
```

8 raise cases + 8 positive cases + 1 control = 17, exactly as predicted.

### 6.2 Which raise site each parameter exercises — the plan's Step 6 script

```
PYTHONPATH="src" .venv/Scripts/python.exe - <<'PY'
import os, sys
sys.path.insert(0, os.path.join("tests", "test_apps"))
from flask.cli import locate_app, NoAppException

cases = [
    ("notanapp.py", None),
    ("cliapp/app", None),
    ("cliapp.app", "notanapp"),
    ("cliapp.factory", 'create_app2("foo")'),
    ("cliapp.factory", "create_app("),
    ("cliapp.factory", "no_app"),
    ("cliapp.importerrorapp", None),
    ("cliapp.message.txt", None),
]
for iname, aname in cases:
    try:
        locate_app(iname, aname)
    except NoAppException as e:
        print("RAISED", repr(iname), repr(aname), "->", str(e).splitlines()[0])
    else:
        print("NO RAISE", repr(iname), repr(aname))
PY
```

Full output (exit status **0**):

```
flask module: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q8-TXT\seal\src\flask\__init__.py
RAISED 'notanapp.py' None -> Could not import 'notanapp.py'.
RAISED 'cliapp/app' None -> Could not import 'cliapp/app'.
RAISED 'cliapp.app' 'notanapp' -> Failed to find attribute 'notanapp' in 'cliapp.app'.
RAISED 'cliapp.factory' 'create_app2("foo")' -> The factory 'create_app2("foo")' in module 'cliapp.factory' could not be called with the specified arguments.
RAISED 'cliapp.factory' 'create_app(' -> Failed to parse 'create_app(' as an attribute name or function call.
RAISED 'cliapp.factory' 'no_app' -> A valid Flask application was not obtained from 'cliapp.factory:no_app'.
RAISED 'cliapp.importerrorapp' None -> While importing 'cliapp.importerrorapp', an ImportError was raised:
RAISED 'cliapp.message.txt' None -> Could not import 'cliapp.message.txt'.
```

No `NO RAISE` line appears and no other exception type escapes. The branch table (message text illustrative; type and branch are the load-bearing claim):

| `iname` | `aname` | Branch taken in `locate_app` | Exception | Message prefix |
|---|---|---|---|---|
| `notanapp.py` | `None` | `except ImportError`, `tb_next is None`, `raise_if_not_found=True` | `NoAppException` | `Could not import 'notanapp.py'.` |
| `cliapp/app` | `None` | `except ImportError`, `tb_next is None`, `raise_if_not_found=True` | `NoAppException` | `Could not import 'cliapp/app'.` |
| `cliapp.message.txt` | `None` | `except ImportError`, `tb_next is None`, `raise_if_not_found=True` | `NoAppException` | `Could not import 'cliapp.message.txt'.` |
| `cliapp.importerrorapp` | `None` | `except ImportError`, `tb_next` non-`None` (unconditional branch) | `NoAppException` | `While importing 'cliapp.importerrorapp', an ImportError was raised:` |
| `cliapp.app` | `notanapp` | `find_app_by_string` → `getattr` `AttributeError` | `NoAppException` | `Failed to find attribute 'notanapp' in 'cliapp.app'.` |
| `cliapp.factory` | `create_app(` | `find_app_by_string` → `ast.parse` `SyntaxError` | `NoAppException` | `Failed to parse 'create_app(' as an attribute name or function call.` |
| `cliapp.factory` | `create_app2("foo")` | `find_app_by_string` → factory call `TypeError`, `_called_with_wrong_args` → `True` | `NoAppException` | `The factory 'create_app2("foo")' in module 'cliapp.factory' could not be called with the specified arguments.` |
| `cliapp.factory` | `no_app` | `find_app_by_string` terminal "not a Flask instance" | `NoAppException` | `A valid Flask application was not obtained from 'cliapp.factory:no_app'.` |

### 6.3 Branch-level mechanics, verified directly

The `tb_next` depth discriminator:

```
$ PYTHONPATH="src" .venv/Scripts/python.exe - <<'PY'
import os,sys; sys.path.insert(0,os.path.join("tests","test_apps"))
def probe(iname):
    try: __import__(iname)
    except ImportError:
        tb=sys.exc_info()[2]; depth=0; node=tb
        while node is not None: depth+=1; node=node.tb_next
        print(f"IMPORT-FAIL {iname!r}: tb_next present={tb.tb_next is not None} depth={depth} exc={type(sys.exc_info()[1]).__name__}")
for iname in ["notanapp.py","cliapp/app","cliapp.message.txt","cliapp.importerrorapp"]:
    probe(iname)
    for k in [m for m in sys.modules if m.startswith("cliapp")]: sys.modules.pop(k,None)
PY
IMPORT-FAIL 'notanapp.py': tb_next present=False depth=1 exc=ModuleNotFoundError
IMPORT-FAIL 'cliapp/app': tb_next present=False depth=1 exc=ModuleNotFoundError
IMPORT-FAIL 'cliapp.message.txt': tb_next present=False depth=1 exc=ModuleNotFoundError
IMPORT-FAIL 'cliapp.importerrorapp': tb_next present=True depth=2 exc=ImportError
```

This is exactly the discriminator the source comment describes: *"Reraise the ImportError if it occurred within the imported module. Determine this by checking whether the trace has a depth > 1."*

`_called_with_wrong_args`, the factories, and the control test:

```
$ PYTHONPATH="src" .venv/Scripts/python.exe - <<'PY'
import os,sys; sys.path.insert(0,os.path.join("tests","test_apps"))
from flask.cli import locate_app, NoAppException, _called_with_wrong_args
import cliapp.factory as f
try: f.create_app2("foo")
except TypeError: print("create_app2('foo') raised TypeError; _called_with_wrong_args ->", _called_with_wrong_args(f.create_app2))
print("create_app2('foo','bar') name ->", f.create_app2("foo","bar").name)
print("no_app() ->", f.no_app())
print("suppress depth-1 (notanapp.py):", locate_app("notanapp.py", None, raise_if_not_found=False))
try:
    locate_app("cliapp.importerrorapp", None, raise_if_not_found=False)
except NoAppException as e:
    print("suppress nested -> STILL RAISES NoAppException:", str(e).splitlines()[0])
else:
    print("suppress nested -> NO RAISE (unexpected)")
PY
create_app2('foo') raised TypeError; _called_with_wrong_args -> True
create_app2('foo','bar') name -> app2_foo_bar
no_app() -> None
suppress depth-1 (notanapp.py): None
suppress nested -> STILL RAISES NoAppException: While importing 'cliapp.importerrorapp', an ImportError was raised:
```

`_called_with_wrong_args` returns `True` for the call-signature `TypeError` (so the raise site at `find_app_by_string` converts it to `NoAppException`); `create_app2` returns a real `Flask` when called correctly; `no_app()` returns `None`, hitting the terminal `NoAppException`; and the control semantics hold — depth-1 with suppression returns `None`, nested still raises.

### 6.4 Full relevant suite, both runs

```
$ PYTHONPATH="src" .venv/Scripts/python.exe -m pytest tests/test_cli.py
...
tests\test_cli.py ...................................................... [ 93%]
....                                                                     [100%]
============================= 58 passed in 1.38s ==============================
```

and with `-vv -rA --tb=long`, all 58 individual IDs listed (including `test_find_best_app`, the eight `test_locate_app` cases, the eight `test_locate_app_raises` cases and `test_locate_app_suppress_raise`), ending `=== 58 passed in 1.38s ===`, exit status **0**. The full `tests/` tree (bare `pytest`, `testpaths=["tests"]`) passed **489/489** on both runs; the 18 `ERROR ` text matches in the verbose log are captured application-log lines from tests that deliberately trigger errors, not test errors (`489 passed`, `0 failed`, `0 errors`).

## 7. The interaction, stated precisely

1. **What the parametrization does.** `@pytest.mark.parametrize("iname,aname", (...))` supplies eight `(import name, app name)` pairs to a test whose only body is `with pytest.raises(NoAppException): locate_app(iname, aname)`. `raise_if_not_found` is never bound, so the default `True` is in force for every case, and the assertion accepts *only* a raised `NoAppException` — a returned `None` or a returned `Flask` would fail the test, and any other exception type would fail `pytest.raises`.

2. **Why every failure must be `NoAppException`.** The two domains are both normalized:
   - Import failures are caught wholesale by `except ImportError`; both of its exits (`if sys.exc_info()[2].tb_next` and `elif raise_if_not_found`) emit `NoAppException`, so a raw `ImportError`/`ModuleNotFoundError` never escapes `locate_app`.
   - Selection failures are produced as `NoAppException` directly: `find_best_app`'s "multiple apps", "factory needs args", and "failed to find" raises; `find_app_by_string`'s parse errors, `AttributeError`, call-signature `TypeError`, and final "not a Flask" raise.
   Consequently the eight cases exercise the depth-1 branch (three cases), the nested-`ImportError` branch (one case), and five distinct `find_app_by_string`/terminal raise sites (four cases) — all landing on the one type the assertion names.

3. **What the two traceback inspections buy.** Without the `tb_next` depth test, a module whose *body* raises `ImportError` would be indistinguishable from a missing module, and the `raise_if_not_found` gate would silently swallow a genuine import bug — the historical reason for the branch is stated in the changelog: *"Prevent ``flask run`` from showing a ``NoAppException`` when an ``ImportError`` occurs within the imported application module"* and *"Revert a change to the CLI that caused it to hide ``ImportError`` tracebacks when importing the application. :issue:`4307`."* Without `_called_with_wrong_args`, a factory that is simply un-callable with the given arguments would be indistinguishable from a factory that raised `TypeError` internally, and the loop in `find_best_app`/`find_app_by_string` would either mask real bugs or leak raw `TypeError`s. Both inspections walk the traceback to attribute blame (caller's call site vs. module/function body), which is why the parametrized pairs get a uniform `NoAppException` rather than a mix of leaked low-level exceptions.

4. **Where "consistently" is scoped — and where it deliberately is not.** The consistency claim holds for the test's parametrization because it always uses the default `raise_if_not_found=True`. The code is explicitly designed *not* to raise when `raise_if_not_found=False` **and** the import failure is depth-1: `else: return None`. That behaviour is asserted by the adjacent control, `test_locate_app_suppress_raise`, whose comment is *"only direct import error is suppressed"*:

   ```python
   def test_locate_app_suppress_raise(test_apps):
       app = locate_app("notanapp.py", None, raise_if_not_found=False)
       assert app is None

       # only direct import error is suppressed
       with pytest.raises(NoAppException):
           locate_app("cliapp.importerrorapp", None, raise_if_not_found=False)
   ```

   The control is the mirror image of the parametrized test at exactly one point: the nested-error branch ignores the flag. So "fails consistently" must be read as "every `(iname, aname)` pair in this parametrization yields `NoAppException` because the default flag is `True` and every non-success path raises that type" — with `raise_if_not_found=False` on a depth-1 failure being the single, deliberately carved-out exception, tested separately.

5. **Where a leak is still possible, by design.** `_called_with_wrong_args` returning `False` makes `find_app_best_app`/`find_app_by_string` re-raise the raw `TypeError`. The companion test documents both sides:

   ```python
   class Module:
       @staticmethod
       def create_app(foo, bar):
           return Flask("appname2")

   pytest.raises(NoAppException, find_best_app, Module)

   class Module:
       @staticmethod
       def create_app():
           raise TypeError("bad bad factory!")

   pytest.raises(TypeError, find_best_app, Module)
   ```

   i.e. a signature mismatch yields `NoAppException`, while a factory that raises `TypeError` internally propagates `TypeError`. This is why the discrimination must be described as *type- and branch-based* rather than as "all exceptions become `NoAppException`": the parametrization happens to contain only cases whose blame falls on the caller, so the uniform `NoAppException` outcome is achieved.

## 8. Why this matters to the production callers (the contract the test mirrors)

`locate_app` is consumed by `ScriptInfo.load_app`, whose callers branch on exactly this type:

```python
        else:
            if self.app_import_path:
                path, name = (
                    re.split(r":(?![\\/])", self.app_import_path, maxsplit=1) + [None]
                )[:2]
                import_name = prepare_import(path)
                app = locate_app(import_name, name)
            else:
                for path in ("wsgi.py", "app.py"):
                    import_name = prepare_import(path)
                    app = locate_app(import_name, None, raise_if_not_found=False)

                    if app is not None:
                        break

        if app is None:
            raise NoAppException(
                "Could not locate a Flask application. Use the"
                " 'flask --app' option, 'FLASK_APP' environment"
                " variable, or a 'wsgi.py' or 'app.py' file in the"
                " current directory."
            )
```

```python
        try:
            app = info.load_app()
        except NoAppException as e:
            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
            return None
```

```python
        try:
            rv.update(info.load_app().cli.list_commands(ctx))
        except NoAppException as e:
            # When an app couldn't be loaded, show the error message
            # without the traceback.
            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
        except Exception:
            # When any other errors occurred during loading, show the
            # full traceback.
            click.secho(f"{traceback.format_exc()}\n", err=True, fg="red")
```

The CLI distinguishes `NoAppException` (clean one-line user error) from any other exception (full traceback). The `--app` path always uses the default `raise_if_not_found=True`; only the `wsgi.py`/`app.py` fallback probe passes `False`. The parametrized test asserts the same contract at the unit level: for user-input errors of every documented shape, the failure type is `NoAppException` and nothing else.

## 9. Scope note (unrelated artefacts excluded from verification)

`flask_mut2_i417ar2x/mutated_test.py` is unrelated to this question — it is a standalone script testing subdomain `url_for` routing:

```python
import flask

app = flask.Flask(__name__, subdomain_matching=False)
app.config["SERVER_NAME"] = "example.com"
client = app.test_client()

@app.route("/", subdomain="<company_id>")
def view(company_id):
    return company_id

with app.test_request_context():
    url = flask.url_for("view", company_id="xxx")
print("url_for ->", url)

with client:
    response = client.get(url)
...
assert 200 == response.status_code, f"status {response.status_code}"
assert b"xxx" == response.data, f"data {response.data!r}"
```

It contains no `locate_app` reference, and is not collected by a bare run because `pyproject.toml` restricts collection:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
```

Collection confirms this (`489 tests collected`, with the mutated file absent). The stale cache entries —

```json
{
  "examples/javascript/tests": true,
  "examples/tutorial/tests": true,
  "flask_mut2_i417ar2x/mutated_test.py": true
}
```

— came from explicit paths in earlier runs, not from `pytest`, and none of them concern `test_locate_app_raises`.

## 10. Bottom line

The parametrization `(iname, aname)` is the *input driver*; the exception-handling semantics are the *normalizer*. Because the test never passes `raise_if_not_found`, the default `True` keeps the depth-1 import branch on the raising path; because the tuples deliberately span import failures (depth-1 and nested) and app-selection failures (attribute, syntax, factory call, non-app return), the test forces every raise site in `locate_app`, `find_best_app`, and `find_app_by_string` to fire; and because each of those sites raises `NoAppException` — the same class the assertion names — the function "fails consistently" for the whole parametrization: eight `(import name, app name)` pairs, eight `NoAppException`s, zero leaked `ImportError`/`AttributeError`/`TypeError`/`SyntaxError`, zero `None` returns. The `sys.exc_info()[2].tb_next` depth test and the `_called_with_wrong_args` traceback walk are the mechanisms that decide, respectively, *whose* `ImportError` and *whose* `TypeError` it is — and the adjacent `test_locate_app_suppress_raise` pins down the one case (`raise_if_not_found=False`, depth-1 import failure) where the function is specified to return `None` instead.
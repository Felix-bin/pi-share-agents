# How the parametrization of import/app-name arguments interacts with exception-handling semantics to make `locate_app` fail consistently

## 1. The test and its parametrization

`tests/test_cli.py` (lines 199–219, complete decorator + body), verified directly in this working directory:

```python
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
```

Facts that matter for the interaction:

- The parameter names are exactly `"iname,aname"`, i.e. the pair **(module-import name, app-name selector)**. `aname` is either `None` or a string.
- The body asserts **only the exception type**. A grep of the whole file for `match=` returns **no matches found**, and there is no `as` binding — so no message is asserted. That is what permits one parametrized test to cover eight distinct error messages.
- `locate_app(iname, aname)` is called with **exactly two positional arguments**, so the third parameter `raise_if_not_found` takes its declared default — which is `True` (see §3). No parametrized row can request suppression.

The eight tuples are deliberately *heterogeneous*: each pair is chosen to land on a different failure point of `locate_app`'s control flow. The invariant asserted is homogeneity of *type*: all of them must raise `NoAppException`.

## 2. The import-stage semantics of `locate_app`

`src/flask/cli.py` (lines 241–264; body verified here verbatim; `NoAppException` is at lines 37–38 — note this is a correction to the earlier handover, which said 32–34):

```python
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

The declared exception type (`src/flask/cli.py` lines 37–38):

```python
class NoAppException(click.UsageError):
    """Raised if an application cannot be found or loaded."""
```

Four decision points govern everything:

1. `__import__(module_name)` inside the `try`.
2. The **`sys.exc_info()[2].tb_next`** traceback-depth test — which is evaluated **before** the `raise_if_not_found` flag. A nested `ImportError` (raised by the imported module's own code) therefore always converts to `NoAppException("While importing …")`, no matter what the flag says.
3. `raise_if_not_found` default `True` — a *direct* import failure raises `NoAppException("Could not import …")`; only `raise_if_not_found=False` would return `None`.
4. The `app_name is None` split: `find_best_app(module)` versus `find_app_by_string(module, app_name)`.

## 3. The post-import semantics: `find_best_app` and `find_app_by_string`

`find_best_app` (`src/flask/cli.py` lines 41–91), the `app_name is None` branch — every early exit is a `NoAppException`, except the plain `raise` that re-raises the original `TypeError` when `_called_with_wrong_args` proves the factory ran and raised internally:

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

`find_app_by_string` (`src/flask/cli.py` lines 120–196), the `app_name`-provided branch — again, every failure path terminates in an explicit `raise NoAppException(...)` (the only non-`NoAppException` escape is the guarded `raise` re-raise):

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

The discriminator that keeps a `TypeError` from escaping, `_called_with_wrong_args` (`src/flask/cli.py` lines 94–117):

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

It returns `False` (→ plain `raise`, letting the raw `TypeError` escape) when the factory's own frame is on the traceback, and `True` (→ `NoAppException`) when argument *binding* failed before the frame was entered. Its pre-existing control test is `tests/test_cli.py` line 132 (`pytest.raises(TypeError, find_best_app, Module)` for `create_app` that does `raise TypeError("bad bad factory!")` inside its body).

## 4. The enabling fixture and the target modules

`tests/conftest.py` (lines 71–82; verified here — the earlier handover cited 76–87):

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

This prepends `tests/test_apps` to `sys.path` so `cliapp.*` is importable, and its teardown purges imported modules so the eight parametrized cases are order-independent.

The modules the tuples point at:

`tests/test_apps/cliapp/app.py`:
```python
from flask import Flask

testapp = Flask("testapp")
```

`tests/test_apps/cliapp/factory.py`:
```python
from flask import Flask


def create_app():
    return Flask("app")


def create_app2(foo, bar):
    return Flask("_".join(["app2", foo, bar]))


def no_app():
    pass
```

`tests/test_apps/cliapp/importerrorapp.py` — an `ImportError` raised at module top level, before `testapp` is assigned:
```python
from flask import Flask

raise ImportError()

testapp = Flask("testapp")
```

`tests/test_apps/cliapp/message.txt`:
```
So long, and thanks for all the fish.
```

`tests/test_apps/cliapp/__init__.py` is empty, which is what makes `cliapp` (and therefore `cliapp.message`) a package path.

## 5. The suppression test that proves the flag/depth distinction

`tests/test_cli.py` (lines 222–228), sitting directly beneath the raises test:

```python
def test_locate_app_suppress_raise(test_apps):
    app = locate_app("notanapp.py", None, raise_if_not_found=False)
    assert app is None

    # only direct import error is suppressed
    with pytest.raises(NoAppException):
        locate_app("cliapp.importerrorapp", None, raise_if_not_found=False)
```

This is the explicit statement of the `tb_next`-before-flag ordering: with `raise_if_not_found=False`, a *direct* not-found returns `None`, but the *nested* `ImportError` still raises `NoAppException`. The raises test, by contrast, never passes the flag, so it relies on the default `True`.

## 6. Row-by-row trace: heterogeneous failure modes → one exception type

The executed results confirm every row. The eight parametrized IDs pass, and a direct probe of `locate_app` against the same eight pairs (with `cliapp.*` cleared from `sys.modules` between rows) produced exactly these messages:

```
flask.cli file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q3-TXT\seal\src\flask\cli.py
======================================================================
CASE iname='notanapp.py' aname=None
RESULT: NoAppException
MESSAGE:
Could not import 'notanapp.py'.
__cause__: None | __suppress_context__: True
======================================================================
CASE iname='cliapp/app' aname=None
RESULT: NoAppException
MESSAGE:
Could not import 'cliapp/app'.
__cause__: None | __suppress_context__: True
======================================================================
CASE iname='cliapp.app' aname='notanapp'
RESULT: NoAppException
MESSAGE:
Failed to find attribute 'notanapp' in 'cliapp.app'.
__cause__: AttributeError("module 'cliapp.app' has no attribute 'notanapp'") | __suppress_context__: True
======================================================================
CASE iname='cliapp.factory' aname='create_app2("foo")'
RESULT: NoAppException
MESSAGE:
The factory 'create_app2("foo")' in module 'cliapp.factory' could not be called with the specified arguments.
__cause__: TypeError("create_app2() missing 1 required positional argument: 'bar'") | __suppress_context__: True
======================================================================
CASE iname='cliapp.factory' aname='create_app('
RESULT: NoAppException
MESSAGE:
Failed to parse 'create_app(' as an attribute name or function call.
__cause__: None | __suppress_context__: True
======================================================================
CASE iname='cliapp.factory' aname='no_app'
RESULT: NoAppException
MESSAGE:
A valid Flask application was not obtained from 'cliapp.factory:no_app'.
__cause__: None | __suppress_context__: False
======================================================================
CASE iname='cliapp.importerrorapp' aname=None
RESULT: NoAppException
MESSAGE:
While importing 'cliapp.importerrorapp', an ImportError was raised:

Traceback (most recent call last):
  File "C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q3-TXT\seal\src\flask\cli.py", line 245, in locate_app
    __import__(module_name)
    ~~~~~~~~~~^^^^^^^^^^^^^
  File "C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q3-TXT\seal\tests\test_apps\cliapp\importerrorapp.py", line 3, in <module>
    raise ImportError()
ImportError

__cause__: None | __suppress_context__: True
======================================================================
CASE iname='cliapp.message.txt' aname=None
RESULT: NoAppException
MESSAGE:
Could not import 'cliapp.message.txt'.
__cause__: None | __suppress_context__: True
EXIT:0
```

And the raw import behaviour that feeds the branch, from a direct `__import__` probe:

```
'notanapp.py'          -> ModuleNotFoundError: No module named 'notanapp' | tb_next truthy: False | tb depth: 1
'cliapp/app'           -> ModuleNotFoundError: No module named 'cliapp/app' | tb_next truthy: False | tb depth: 1
'cliapp.importerrorapp' -> ImportError:  | tb_next truthy: True | tb depth: 2
'cliapp.message.txt'   -> ModuleNotFoundError: No module named 'cliapp.message' | tb_next truthy: False | tb depth: 1
'cliapp.app'           -> import OK
'cliapp.factory'        -> import OK
EXIT:0
```

The resulting mapping (all confirmed empirically):

| `(iname, aname)` | `aname` axis | Failure stage & branch | Resulting exception |
|---|---|---|---|
| `("notanapp.py", None)` | None (no selector) → `find_best_app` would be reached only on success | `__import__` fails directly, `tb_next` falsy → `elif raise_if_not_found` (default `True`) | `NoAppException("Could not import 'notanapp.py'.")` |
| `("cliapp/app", None)` | None | `__import__("cliapp/app")` → direct `ModuleNotFoundError` on the dotted path, `tb_next` falsy → `elif raise_if_not_found` | `NoAppException("Could not import 'cliapp/app'.")` |
| `("cliapp.app", "notanapp")` | string → `find_app_by_string` | import OK; `getattr(module, "notanapp")` → `AttributeError` branch | `NoAppException("Failed to find attribute 'notanapp' in 'cliapp.app'.")` |
| `("cliapp.factory", 'create_app2("foo")')` | string, call expression | `ast.parse` OK; `attr("foo")` → `TypeError` from **binding**, `_called_with_wrong_args` → `True` → `NoAppException` branch | `NoAppException("The factory 'create_app2(\"foo\")' in module 'cliapp.factory' could not be called with the specified arguments.")` |
| `("cliapp.factory", "create_app(")` | string, malformed | `ast.parse("create_app(", mode="eval")` → `SyntaxError` branch | `NoAppException("Failed to parse 'create_app(' as an attribute name or function call.")` |
| `("cliapp.factory", "no_app")` | string, resolves to `None` | parse/`getattr`/call all succeed; `no_app()` returns `None` → final `isinstance(app, Flask)` raise | `NoAppException("A valid Flask application was not obtained from 'cliapp.factory:no_app'.")` |
| `("cliapp.importerrorapp", None)` | None | module raises `ImportError` at top level → `tb_next` truthy → **first** branch, independent of the flag | `NoAppException("While importing 'cliapp.importerrorapp', an ImportError was raised: …")` |
| `("cliapp.message.txt", None)` | None | `__import__("cliapp.message.txt")` finds package `cliapp` but no submodule `message` → direct `ModuleNotFoundError: No module named 'cliapp.message'`, `tb_next` falsy → `elif raise_if_not_found` | `NoAppException("Could not import 'cliapp.message.txt'.")` |

Note on the last row (a correction to the test's own comment): the tuple is commented `# not a Python file`, but the observed mechanism is **not** a content/parse failure of the `.txt` file. It is an ordinary import-stage not-found for the *submodule* `cliapp.message` (the file present is `message.txt`, which is not an importable module name). The executor's probe shows the raw error is `No module named 'cliapp.message'`, and the matching `test_prepare_import` entry documents it as `# not a Python file, will be caught during import`.

Note on the `TypeError` row: the raw `TypeError("create_app2() missing 1 required positional argument: 'bar'")` is only converted because `_called_with_wrong_args` returns `True` — argument binding fails before `create_app2`'s frame is entered, so `create_app2.__code__` never appears in the traceback. A control probe confirmed:

```
create_app2("foo") -> _called_with_wrong_args = True
inner TypeError -> _called_with_wrong_args = False
```

If that discriminator returned `False`, the raw `TypeError` would escape and this parametrized case would fail. So the consistency of this row is attributable to the argument-binding/entered-frame distinction, not to a blanket `except TypeError`.

Two further structural observations from the trace: (a) `no_app` is the only row with `__cause__: None | __suppress_context__: False` — it is the trailing bare `raise NoAppException(...)`, with no `from ...` clause; all others are `from None`/`from e`; (b) `("cliapp.app", "notanapp")` and `("cliapp.factory", 'create_app2("foo")')` carry genuine `__cause__` chains (`AttributeError`, `TypeError`), suppressed from display by `from e`/`from None` semantics but visible on the exception object. None of this is asserted by the test, which checks only type.

## 7. Why "fails consistently" holds

The interaction is a deliberate pairing of two orthogonal dimensions:

- **The parametrization axis is heterogeneous by construction.** `iname` varies across a non-existent top-level module (`notanapp.py`), a slash-separated path (`cliapp/app`), two successfully importable modules (`cliapp.app`, `cliapp.factory`), a module that self-destructs at import time (`cliapp.importerrorapp`), and a non-module file (`cliapp.message.txt`). `aname` varies across `None`, a missing attribute, a malformed expression, a call expression with too few arguments, and a callable that returns a non-Flask value. The eight rows traverse: two direct import failures, one nested import failure, one syntax failure, one missing-attribute failure, one wrong-argument-`TypeError` failure, one non-Flask-return failure.
- **The exception-handling semantics are homogeneous by construction.** Every early-exit path in `locate_app`, `find_best_app` and `find_app_by_string` ends in `raise NoAppException(...)`. Because the test does not pass `raise_if_not_found=False`, the two direct import-stage rows fall through to `raise NoAppException(f"Could not import …")`. Because the depth test `sys.exc_info()[2].tb_next` is checked *before* the flag, the nested-import row is converted regardless of the flag. And because `_called_with_wrong_args` distinguishes binding failures from factory-internal failures, the wrong-argument row also ends in `NoAppException`.

The single assertion `pytest.raises(NoAppException)` is therefore guaranteed for every parameter set: the parametrization exercises **heterogeneous failure modes**, while the exception semantics **homogenize them into one exception type**. "Fails consistently" means both (a) the test outcome is invariant across all eight pairs, and (b) the invariant is enforced by construction, not by luck — no parametrized case triggers the one code path (the guarded plain `raise`) that could leak a non-`NoAppException`).

The counter-evidence that the coupling is intentional is `test_locate_app_suppress_raise`: with `raise_if_not_found=False`, the direct not-found case returns `None` instead of raising, while the nested-import case still raises — demonstrating that the depth check precedes and overrides the flag. Consistency at type level is exactly what the raises test measures; message-level differences are deliberately not asserted (`grep` for `match=` in `tests/test_cli.py` → no matches found), which is what allows eight distinct messages to be covered by one parametrized test.

## 8. Verification performed in this session

- `tests/test_cli.py` lines 175–229 read directly — the parametrization, the `pytest.raises(NoAppException)` body with no `match=`, and the suppression test all match the quotes above.
- `src/flask/cli.py` lines 30–200 and 229–264 read directly — `NoAppException` (37–38), `find_best_app`, `_called_with_wrong_args`, `find_app_by_string`, both `locate_app` overloads and the body all match verbatim.
- `tests/conftest.py` lines 68–92 read — the `test_apps` fixture matches verbatim.
- Target modules read — `app.py`, `factory.py`, `importerrorapp.py`, `message.txt` match verbatim.
- `tests/test_cli.py` lines 95–132 read — the control `pytest.raises(TypeError, find_best_app, Module)` for a factory that raises `TypeError` internally is present.
- `grep "match=" tests/test_cli.py` → **No matches found**, confirming the type-only assertion.
- Executed (provided by the executor role in this session, quoted above): `test_locate_app_raises` → **8 passed**; `test_locate_app` + `test_locate_app_suppress_raise` → **9 passed**; full `tests/test_cli.py` → **58 passed**; whole suite → **489 passed**. Row-by-row `locate_app` probe and raw `__import__` probe outputs are quoted in §6.

No source files were edited, and nothing outside this working directory is relevant: the untracked `flask_mut2_i417ar2x/mutated_test.py` (about `subdomain_matching=False` and `url_for`) contains no `locate_app`, `iname`, `aname`, parametrization or exception content and does not bear on this question.
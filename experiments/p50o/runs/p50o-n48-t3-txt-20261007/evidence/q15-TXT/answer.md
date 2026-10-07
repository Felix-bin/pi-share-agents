## Where the list-of-dicts route handler integrates with the route decorator and the static type-checker configuration

**Direct answer.** The handler lives in the type-check fixture **`tests/type_check/typing_route.py`**, where `@app.route("/json/dict")` (line 36) decorates `def hello_json_list() -> list[t.Any]:` (line 37), returning `[{"message": "Hello"}, {"message": "World"}]`. It meets the framework at four link points: (1) the decorator `Scaffold.route` in **`src/flask/sansio/scaffold.py:336`**, generic in `T_route` bounded by `ft.RouteCallable` (`scaffold.py:39`), reached through the inheritance chain `Flask` → `App` → `Scaffold`; (2) the return-type aliases in **`src/flask/typing.py`**, where `RouteCallable` (`:84`) returns `ResponseReturnValue` (`:36`), which includes `ResponseValue` (`:12`), which contains **`list[t.Any]` at `src/flask/typing.py:16`** — that union member is what legitimises the list-of-dicts annotation; and (3) the checker configuration in **`pyproject.toml`**, where `[tool.mypy] files = ["src", "tests/type_check"]` with `strict = true` (`:129`, `:132`) and `[tool.pyright] include = ["src", "tests/type_check"]` with `typeCheckingMode = "basic"` (`:145`–`:146`) are the only places the directory is pulled into static analysis, run by `[tool.tox.env.typing]` (`mypy` then `pyright`) and the CI `typing:` job via `uv run --locked tox run -e typing`. At runtime the same alias reappears in `make_response` (`src/flask/app.py:1129`), where `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)` (`:1230`–`:1231`) turns the returned list into a JSON response — an echo of the static contract, not the validation mechanism itself.

---

### 1. The handler / fixture — `tests/type_check/typing_route.py`

Verified by grep in this worktree:

```
typing_route.py:31: @app.route("/json/dict")
typing_route.py:36: @app.route("/json/dict")
typing_route.py:37: def hello_json_list() -> list[t.Any]:
```

Lines 28–38 of the file, verbatim:

```python
@app.route("/json/dict")
def hello_json_dict() -> dict[str, t.Any]:
    return {"response": "Hello, World!"}


@app.route("/json/dict")
def hello_json_list() -> list[t.Any]:
    return [{"message": "Hello"}, {"message": "World"}]
```

Note the trap: `hello_json_dict` (returns `dict[str, t.Any]`) and `hello_json_list` (returns `list[t.Any]`) share the same rule string `"/json/dict"` yet are distinct functions/endpoints. The module header and the other accepted return types in the same file are:

```python
from __future__ import annotations

import typing as t
from http import HTTPStatus

from flask import Flask
from flask import jsonify
from flask import stream_template
from flask.templating import render_template
from flask.views import View
from flask.wrappers import Response

app = Flask(__name__)


@app.route("/str")
def hello_str() -> str:
    return "<p>Hello, World!</p>"


@app.route("/bytes")
def hello_bytes() -> bytes:
    return b"<p>Hello, World!</p>"


@app.route("/json")
def hello_json() -> Response:
    return jsonify("Hello, World!")
```

and later in the same file:

```python
class StatusJSON(t.TypedDict):
    status: str


@app.route("/typed-dict")
def typed_dict() -> StatusJSON:
    return {"status": "ok"}


@app.route("/generator")
def hello_generator() -> t.Generator[str, None, None]:
    def show() -> t.Generator[str, None, None]:
        for x in range(100):
            yield f"data:{x}\n\n"

    return show()


@app.route("/generator-expression")
def hello_generator_expression() -> t.Iterator[bytes]:
    return (f"data:{x}\n\n".encode() for x in range(100))


@app.route("/iterator")
def hello_iterator() -> t.Iterator[str]:
    return iter([f"data:{x}\n\n" for x in range(100)])


@app.route("/status")
@app.route("/status/<int:code>")
def tuple_status(code: int = 200) -> tuple[str, int]:
    return "hello", code


@app.route("/status-enum")
def tuple_status_enum() -> tuple[str, int]:
    return "hello", HTTPStatus.OK


@app.route("/headers")
def tuple_headers() -> tuple[str, dict[str, str]]:
    return "Hello, World!", {"Content-Type": "text/plain"}


@app.route("/template")
@app.route("/template/<name>")
def return_template(name: str | None = None) -> str:
    return render_template("index.html", name=name)


@app.route("/template")
def return_template_stream() -> t.Iterator[str]:
    return stream_template("index.html", name="Hello")


@app.route("/async")
async def async_route() -> str:
    return "Hello"


class RenderTemplateView(View):
    def __init__(self: RenderTemplateView, template_name: str) -> None:
        self.template_name = template_name

    def dispatch_request(self: RenderTemplateView) -> str:
        return render_template(self.template_name)


app.add_url_rule(
    "/about",
    view_func=RenderTemplateView.as_view("about_page", template_name="about.html"),
)
```

**Scope of "the type checking test files":** the directory holds exactly three files — `typing_app_decorators.py`, `typing_error_handler.py`, `typing_route.py` — and only `typing_route.py` contains a list-of-dicts handler. The other two are:

```python
# tests/type_check/typing_app_decorators.py
from __future__ import annotations

from flask import Flask
from flask import Response

app = Flask(__name__)


@app.after_request
def after_sync(response: Response) -> Response:
    return Response()


@app.after_request
async def after_async(response: Response) -> Response:
    return Response()


@app.before_request
def before_sync() -> None: ...


@app.before_request
async def before_async() -> None: ...


@app.teardown_appcontext
def teardown_sync(exc: BaseException | None) -> None: ...


@app.teardown_appcontext
async def teardown_async(exc: BaseException | None) -> None: ...
```

```python
# tests/type_check/typing_error_handler.py
from __future__ import annotations

from http import HTTPStatus

from werkzeug.exceptions import BadRequest
from werkzeug.exceptions import NotFound

from flask import Flask

app = Flask(__name__)


@app.errorhandler(400)
@app.errorhandler(HTTPStatus.BAD_REQUEST)
@app.errorhandler(BadRequest)
def handle_400(e: BadRequest) -> str:
    return ""


@app.errorhandler(ValueError)
def handle_custom(e: ValueError) -> str:
    return ""


@app.errorhandler(ValueError)
def handle_accept_base(e: Exception) -> str:
    return ""


@app.errorhandler(BadRequest)
@app.errorhandler(404)
def handle_multiple(e: BadRequest | NotFound) -> str:
    return ""
```

---

### 2. The route decorator and its bound TypeVar — `src/flask/sansio/scaffold.py`

Grep line anchors (verified in this worktree):

```
scaffold.py:39: T_route = t.TypeVar("T_route", bound=ft.RouteCallable)
scaffold.py:289:     ) -> t.Callable[[T_route], T_route]:
scaffold.py:336:     def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
scaffold.py:360:         def decorator(f: T_route) -> T_route:
scaffold.py:372:         view_func: ft.RouteCallable | None = None,
scaffold.py:701: def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
```

The TypeVar block at the top of the file, verbatim (`from .. import typing as ft` is the import that names the aliases):

```python
from .. import typing as ft
from ..helpers import get_root_path
from ..templating import _default_template_ctx_processor

if t.TYPE_CHECKING:  # pragma: no cover
    from click import Group

# a singleton sentinel value for parameter defaults
_sentinel = object()

F = t.TypeVar("F", bound=t.Callable[..., t.Any])
T_after_request = t.TypeVar("T_after_request", bound=ft.AfterRequestCallable[t.Any])
T_before_request = t.TypeVar("T_before_request", bound=ft.BeforeRequestCallable)
T_error_handler = t.TypeVar("T_error_handler", bound=ft.ErrorHandlerCallable)
T_teardown = t.TypeVar("T_teardown", bound=ft.TeardownCallable)
T_template_context_processor = t.TypeVar(
    "T_template_context_processor", bound=ft.TemplateContextProcessorCallable
)
T_url_defaults = t.TypeVar("T_url_defaults", bound=ft.URLDefaultCallable)
T_url_value_preprocessor = t.TypeVar(
    "T_url_value_preprocessor", bound=ft.URLValuePreprocessorCallable
)
T_route = t.TypeVar("T_route", bound=ft.RouteCallable)
```

`_method_route` (line 282+), shared by `get`/`post`/`put`/`delete`/`patch`:

```python
    def _method_route(
        self,
        method: str,
        rule: str,
        options: dict[str, t.Any],
    ) -> t.Callable[[T_route], T_route]:
        if "methods" in options:
            raise TypeError("Use the 'route' decorator to use the 'methods' argument.")

        return self.route(rule, methods=[method], **options)
```

And `route` itself (line 336), verbatim:

```python
    @setupmethod
    def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        """Decorate a view function to register it with the given URL
        rule and options. Calls :meth:`add_url_rule`, which has more
        details about the implementation.

        .. code-block:: python

            @app.route("/")
            def index():
                return "Hello, World!"

        See :ref:`url-route-registrations`.

        The endpoint name for the route defaults to the name of the view
        function if the ``endpoint`` parameter isn't passed.

        The ``methods`` parameter defaults to ``["GET"]``. ``HEAD`` and
        ``OPTIONS`` are added automatically.

        :param rule: The URL rule string.
        :param options: Extra options passed to the
            :class:`~werkzeug.routing.Rule` object.
        """

        def decorator(f: T_route) -> T_route:
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f

        return decorator
```

Because the inner `decorator(f: T_route) -> T_route` returns the function unchanged, the decorated fixture keeps its own annotation (`list[t.Any]`), and `T_route`'s bound `ft.RouteCallable` is what decides whether that annotation is legal. `add_url_rule` reinforces the same bound (`view_func: ft.RouteCallable | None = None`, line 372), as does the registry `self.view_functions: dict[str, ft.RouteCallable] = {}` (line 108) and `_endpoint_from_view_func(view_func: ft.RouteCallable)` (line 701).

**Inheritance indirection:** `def route` is defined **only** in `src/flask/sansio/scaffold.py` across `src/`. The chain is:

```python
# src/flask/app.py, lines 81–84
class Flask(App):
    """The flask object implements a WSGI application and acts as the central
    object.  It is passed the name of the module or package of the
    application.  Once it is created it will act as a central registry for
```

```python
# src/flask/sansio/app.py, lines 59–62
class App(Scaffold):
    """The flask object implements a WSGI application and acts as the central
    object.  It is passed the name of the module or package of the
    application.  Once it is created it will act as a central registry for
```

so `Flask` → `App` → `Scaffold`, and `@app.route(...)` in the fixture resolves to `Scaffold.route` at `scaffold.py:336`. A shallow search for `def route` inside `src/flask/app.py` finds nothing.

---

### 3. The aliases that permit `list[t.Any]` — `src/flask/typing.py`

Lines 1–42, verbatim (with the load-bearing member on line 16):

```python
from __future__ import annotations

import collections.abc as cabc
import typing as t

if t.TYPE_CHECKING:  # pragma: no cover
    from _typeshed.wsgi import WSGIApplication  # noqa: F401
    from werkzeug.datastructures import Headers  # noqa: F401
    from werkzeug.sansio.response import Response  # noqa: F401

# The possible types that are directly convertible or are a Response object.
ResponseValue = t.Union[
    "Response",
    str,
    bytes,
    list[t.Any],
    # Only dict is actually accepted, but Mapping allows for TypedDict.
    t.Mapping[str, t.Any],
    t.Iterator[str],
    t.Iterator[bytes],
    cabc.AsyncIterable[str],  # for Quart, until App is generic.
    cabc.AsyncIterable[bytes],
]

# the possible types for an individual HTTP header
HeaderValue = str | list[str] | tuple[str, ...]

# the possible types for HTTP headers
HeadersValue = t.Union[
    "Headers",
    t.Mapping[str, HeaderValue],
    t.Sequence[tuple[str, HeaderValue]],
]

# The possible types returned by a route function.
ResponseReturnValue = t.Union[
    ResponseValue,
    tuple[ResponseValue, HeadersValue],
    tuple[ResponseValue, int],
    tuple[ResponseValue, int, HeadersValue],
    "WSGIApplication",
]
```

Lines 84–87:

```python
RouteCallable = (
    t.Callable[..., ResponseReturnValue]
    | t.Callable[..., t.Awaitable[ResponseReturnValue]]
)
```

Grep pinpoints the member:

```
src/flask/typing.py-15-     bytes,
src/flask/typing.py:16:     list[t.Any],
src/flask/typing.py-17-     # Only dict is actually accepted, but Mapping allows for TypedDict.
```

**The validation chain:** `@app.route` binds `T_route` to `ft.RouteCallable` → `RouteCallable` accepts a callable returning `ResponseReturnValue` (`typing.py:36`) → `ResponseReturnValue` includes `ResponseValue` (`typing.py:12`) → `ResponseValue` includes **`list[t.Any]` (`typing.py:16`)**. That single union member is what makes `hello_json_list() -> list[t.Any]` type-check. The alias is load-bearing throughout the pipeline, not just at the decorator: `src/flask/app.py` uses `ft.ResponseReturnValue` in `handle_http_exception` (`:746`), `handle_user_exception` (`:781`), `server_error` (`:855`), `dispatch_request` (`:879`), `finalize_request` (`:924`), `preprocess_request` (`:1271`); `src/flask/views.py` at `:78`, `:88` (`ft.RouteCallable`), `:106`, `:115`, `:182`; and `src/flask/sansio/blueprints.py:91`, `:417` (`view_func: ft.RouteCallable | None = None`). `src/flask/sansio/app.py:609` repeats the bound in the abstract signature.

---

### 4. The checker configuration that includes these test files — `pyproject.toml` and CI

The two checker sections (`tests/type_check` appears in both; verified line anchors `:129`, `:132`, `:145`, `:146`):

```toml
[tool.mypy]
python_version = "3.10"
files = ["src", "tests/type_check"]
show_error_codes = true
pretty = true
strict = true

[[tool.mypy.overrides]]
module = [
    "asgiref.*",
    "dotenv.*",
    "cryptography.*",
    "importlib_metadata",
]
ignore_missing_imports = true

[tool.pyright]
pythonVersion = "3.10"
include = ["src", "tests/type_check"]
typeCheckingMode = "basic"
```

The tox environment that runs them (`mypy` first, then `pyright`):

```toml
[tool.tox.env.typing]
description = "run static type checkers"
dependency_groups = ["typing"]
commands = [
    ["mypy"],
    ["pyright"],
]
```

The dependency group supplying both checkers:

```toml
requires-python = ">=3.10"
...
typing = [
    "asgiref",
    "cryptography",
    "mypy",
    "pyright",
    "pytest",
    "python-dotenv",
    "types-contextvars",
    "types-dataclasses",
]
```

The CI job that runs this environment (`.github/workflows/tests.yaml`, lines 35–51):

```yaml
  typing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: astral-sh/setup-uv@f0ec1fc3b38f5e7cd731bb6ce540c5af426746bb # v6.1.0
        with:
          enable-cache: true
          prune-cache: false
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0
        with:
          python-version-file: pyproject.toml
      - name: cache mypy
        uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
        with:
          path: ./.mypy_cache
          key: mypy|${{ hashFiles('pyproject.toml') }}
      - run: uv run --locked tox run -e typing
```

Nothing else in the tree references `tests/type_check`: a grep across `**/*.{py,yaml,yml,toml,cfg,ini}` for `mypy|pyright|type_check` found no Python test that imports or exercises these fixtures — the two config sections, the `typing:` tox env, and the CI job are the only enforcement points. (The `include = [` at `pyproject.toml:93` belongs to `[tool.flit.sdist]`, not a checker.)

**Strictness caveat:** mypy runs with `strict = true` while pyright runs `typeCheckingMode = "basic"`, so "validates return type annotations" is true but enforcement is not identical between the two.

**Nearby history (`CHANGES.rst`, lines 336–339, under the Version 2.2.0 heading):**

```rst
-   Allow returning a list from a view function, to convert it to a
    JSON response like a dict is. :issue:`4672`
-   When type checking, allow ``TypedDict`` to be returned from view
    functions. :pr:`4695`
```

---

### 5. Runtime counterpart (context, not the validation mechanism) — `src/flask/app.py`

Grep anchors verified: `app.py:1129: def make_response(self, rv: ft.ResponseReturnValue) -> Response:`, `app.py:1230: elif isinstance(rv, (dict, list)):`, `app.py:1231: rv = self.json.response(rv)`.

```python
    def make_response(self, rv: ft.ResponseReturnValue) -> Response:
        """Convert the return value from a view function to an instance of
        :attr:`response_class`.

        :param rv: the return value from the view function. The view function
            must return a response. Returning ``None``, or the view ending
            without returning, is not allowed. The following types are allowed
            for ``view_rv``:

            ``str``
                A response object is created with the string encoded to UTF-8
                as the body.

            ``bytes``
                A response object is created with the bytes as the body.

            ``dict``
                A dictionary that will be jsonify'd before being returned.

            ``list``
                A list that will be jsonify'd before being returned.

            ``generator`` or ``iterator``
                ...
            ...
        .. versionchanged:: 2.2
            A generator will be converted to a streaming response.
            A list will be converted to a JSON response.

        .. versionchanged:: 1.1
            A dict will be converted to a JSON response.

        .. versionchanged:: 0.9
           Previously a tuple was interpreted as the arguments for the
           response object.
        """

        status: int | None = None
        headers: HeadersValue | None = None
        ...
            elif isinstance(rv, (dict, list)):
                rv = self.json.response(rv)
```

The same `ResponseReturnValue` alias drives both the runtime signature and the decorator bound; `isinstance(rv, (dict, list))` is where a returned list becomes JSON. Supporting evidence that the behaviour is exercised at runtime (not by the type checker):

```python
# tests/test_basic.py, lines 1167–1170
    @app.route("/list")
    def from_list():
        return ["foo", "bar"], 201
```

```python
# tests/test_basic.py, lines 1210–1212
    rv = client.get("/list")
    assert rv.json == ["foo", "bar"]
    assert rv.status_code == 201
```

```rst
# docs/quickstart.rst, lines 737–760
If you return a ``dict`` or
``list`` from a view, it will be converted to a JSON response.

.. code-block:: python

    @app.route("/users")
    def users_api():
        users = get_all_users()
        return [user.to_json() for user in users]
```

---

### 6. Executed verification

Environment: worktree `.../q15-TXT/seal`, tooling from the project venv (`mypy 1.16.0`, `pyright 1.1.401`, `pytest 8.4.0`; checkers configured for Python 3.10).

**Isolated runs on the fixture — both clean:**

```
$ mypy tests/type_check/typing_route.py
Success: no issues found in 1 source file          # exit 0
$ pyright tests/type_check/typing_route.py
0 errors, 0 warnings, 0 informations               # exit 0
```

**Project-wide `mypy` (exit 1) — a single pre-existing, unrelated error:**

```
src\flask\cli.py:1041: error: Module has no attribute "set_completer" 
[attr-defined]
                readline.set_completer(Completer(ctx).complete)
                ^~~~~~~~~~~~~~~~~~~~~~
Found 1 error in 1 file (checked 27 source files)
```

Verbose `mypy -v` shows the fixture is processed without any diagnostic: `Found source: BuildSource(path='tests\\type_check\\typing_route.py', module='typing_route', ...)` → `Processing SCC singleton (typing_route) as inherently stale with stale deps (flask flask.templating flask.views flask.wrappers)` → no diagnostic for `typing_route`; only the `cli.py:1041` error is reported.

**Project-wide `pyright` (exit 1) — 78 errors, all environment/import-resolution:**

```
c:\Users\...\seal\tests\type_check\typing_error_handler.py
  ...typing_error_handler.py:5:6 - error: Import "werkzeug.exceptions" could not be resolved (reportMissingImports)
  ...typing_error_handler.py:6:6 - error: Import "werkzeug.exceptions" could not be resolved (reportMissingImports)
78 errors, 0 warnings, 0 informations
```

All 78 are `reportMissingImports` for `werkzeug`, `itsdangerous`, `blinker`, `asgiref` plus consequential errors in `src/flask/*`. **No error is reported for `tests/type_check/typing_route.py`.** Root cause visible in `pyright --verbose`: it selected the interpreter on the system `PATH` (`'python'` → `C:\Python314`) instead of the venv, so the venv's packages were off its search path (`Execution environment: python`, `Python version: 3.10`, `Extra paths: ...\seal\src`, `Found 27 source files`).

**`pytest` (exit 0):**

```
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q15-TXT\seal
configfile: pyproject.toml
testpaths: tests
collected 489 items
...
============================= 489 passed in 5.48s =============================
```

The verbose run (`pytest -vv -rA --tb=long`) likewise ends `489 passed in 4.87s`; its 18 uppercase `ERROR` occurrences are captured log messages from tests that deliberately raise (`ERROR flask_test:app.py:875 Exception on / [GET]`), not failures.

**Net result.** The list-of-dicts fixture itself type-checks clean under both checkers; the only reported problems are the unrelated `src/flask/cli.py:1041` mypy error and pyright's environment-only import-resolution failures — none attributable to `hello_json_list`. In this worktree the two checkers are therefore not equally usable as a "green" gate, but the isolated `tests/type_check/typing_route.py` runs are clean for both, which is the relevant fact for the list-of-dicts annotation.

---

### 7. Completing the chain, in order

1. **Fixture** — `tests/type_check/typing_route.py`: `@app.route("/json/dict")` (line 36) on `def hello_json_list() -> list[t.Any]:` (line 37), returning `[{"message": "Hello"}, {"message": "World"}]`; the only list-of-dicts handler among the three type-check fixtures, and distinct from the same-path `hello_json_dict`.
2. **Decorator** — `src/flask/sansio/scaffold.py`: `Scaffold.route` (line 336) returning `t.Callable[[T_route], T_route]` with `T_route = t.TypeVar("T_route", bound=ft.RouteCallable)` (line 39); the inner `decorator(f: T_route) -> T_route` (line 360) preserves the caller's annotation; reached via `Flask` (`app.py:81`) → `App` (`sansio/app.py:59`) → `Scaffold`.
3. **Aliases** — `src/flask/typing.py`: `T_route` → `ft.RouteCallable` (`:84`) → `ResponseReturnValue` (`:36`) → `ResponseValue` (`:12`) → **`list[t.Any]` (`:16`)**, the member that legitimises the annotation.
4. **Checker config** — `pyproject.toml`: `[tool.mypy] files = ["src", "tests/type_check"], strict = true`; `[tool.pyright] include = ["src", "tests/type_check"], typeCheckingMode = "basic"`; `[tool.tox.env.typing]` runs `mypy` then `pyright`; the CI `typing:` job runs `uv run --locked tox run -e typing`.
5. **Runtime echo (context only)** — `src/flask/app.py:1129` `def make_response(self, rv: ft.ResponseReturnValue) -> Response:` with `:1230`–`:1231` `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)`.
# Answer

**The test class is `TestUrlFor`, defined in `tests/test_helpers.py` at line 102** (class body spans lines 102–169; line 170–171 are blank and line 172 begins the module-level function `test_redirect_no_app`, outside the class).

- **File:** `tests/test_helpers.py`
- **Line:** 102
- **Class:** `TestUrlFor`
- **Validating methods:** `test_url_for_with_anchor` (L103), `test_url_for_with_scheme` (L110), `test_url_for_with_scheme_not_external` (L120), `test_url_for_with_alternating_schemes` (L131), `test_url_with_method` (L143)
- **Reproduce:** `python -m pytest "tests/test_helpers.py::TestUrlFor" -v`

---

## 1. The class itself, quoted in full (verbatim, `tests/test_helpers.py:102–169`)

```python
class TestUrlFor:
    def test_url_for_with_anchor(self, app, req_ctx):
        @app.route("/")
        def index():
            return "42"

        assert flask.url_for("index", _anchor="x y") == "/#x%20y"

    def test_url_for_with_scheme(self, app, req_ctx):
        @app.route("/")
        def index():
            return "42"

        assert (
            flask.url_for("index", _external=True, _scheme="https")
            == "https://localhost/"
        )

    def test_url_for_with_scheme_not_external(self, app, req_ctx):
        app.add_url_rule("/", endpoint="index")

        # Implicit external with scheme.
        url = flask.url_for("index", _scheme="https")
        assert url == "https://localhost/"

        # Error when external=False with scheme
        with pytest.raises(ValueError):
            flask.url_for("index", _scheme="https", _external=False)

    def test_url_for_with_alternating_schemes(self, app, req_ctx):
        @app.route("/")
        def index():
            return "42"

        assert flask.url_for("index", _external=True) == "http://localhost/"
        assert (
            flask.url_for("index", _external=True, _scheme="https")
            == "https://localhost/"
        )
        assert flask.url_for("index", _external=True) == "http://localhost/"

    def test_url_with_method(self, app, req_ctx):
        from flask.views import MethodView

        class MyView(MethodView):
            def get(self, id=None):
                if id is None:
                    return "List"
                return f"Get {id:d}"

            def post(self):
                return "Create"

        myview = MyView.as_view("myview")
        app.add_url_rule("/myview/", methods=["GET"], view_func=myview)
        app.add_url_rule("/myview/<int:id>", methods=["GET"], view_func=myview)
        app.add_url_rule("/myview/create", methods=["POST"], view_func=myview)

        assert flask.url_for("myview", _method="GET") == "/myview/"
        assert flask.url_for("myview", id=42, _method="GET") == "/myview/42"
        assert flask.url_for("myview", _method="POST") == "/myview/create"

    def test_url_for_with_self(self, app, req_ctx):
        @app.route("/<self>")
        def index(self):
            return "42"

        assert flask.url_for("index", self="2") == "/2"
```

**Why this is the class the question asks about:** the five methods above are exactly the ones exercising the three features named in the question — `_anchor` (L103), `_scheme` (L110, L120, L131), and `_method` (L143). `test_url_for_with_self` (L164) is a member of the class but tests the `<self>` route variable, so it is not part of the anchor/scheme/method validation set.

**Class boundary proof** (`tests/test_helpers.py:163–173`) — after `test_url_for_with_self` the indentation returns to module level:

```python
    def test_url_for_with_self(self, app, req_ctx):
        @app.route("/<self>")
        def index(self):
            return "42"

        assert flask.url_for("index", self="2") == "/2"

def test_redirect_no_app():
    response = flask.redirect("https://localhost", 307)
```

**Uniqueness.** A repo-wide grep for `TestUrlFor|test_url_with_method|test_url_for_with_scheme` (excluding `.venv`) returns matches only in this file:

```
$ grep -rn "TestUrlFor\|test_url_with_method\|test_url_for_with_scheme" --include="*.py" . | grep -v "^./.venv/"
./tests/test_helpers.py:102:class TestUrlFor:
./tests/test_helpers.py:110:    def test_url_for_with_scheme(self, app, req_ctx):
./tests/test_helpers.py:120:    def test_url_for_with_scheme_not_external(self, app, req_ctx):
./tests/test_helpers.py:143:    def test_url_with_method(self, app, req_ctx):
```

The full symbol map of the file confirms the class is the only one in the anchor/scheme/method family:

```
11:class FakePath:
18:    def __init__(self, path):
21:    def __fspath__(self):
25:class PyBytesIO:
26:    def __init__(self, *args, **kwargs):
29:    def __getattr__(self, name):
33:class TestSendfile:
34:    def test_send_file(self, app, req_ctx):
45:    def test_static_file(self, app, req_ctx):
92:    def test_send_from_directory(self, app, req_ctx):
102:class TestUrlFor:
103:    def test_url_for_with_anchor(self, app, req_ctx):
110:    def test_url_for_with_scheme(self, app, req_ctx):
120:    def test_url_for_with_scheme_not_external(self, app, req_ctx):
131:    def test_url_for_with_alternating_schemes(self, app, req_ctx):
143:    def test_url_with_method(self, app, req_ctx):
164:    def test_url_for_with_self(self, app, req_ctx):
172:def test_redirect_no_app():
178:def test_redirect_with_app(app):
179:    def redirect(location, code=302):
188:def test_abort_no_app():
196:def test_app_aborter_class():
207:def test_abort_with_app(app):
217:class TestNoImports:
228:    def test_name_with_import_error(self, modules_tmp_path):
236:class TestStreaming:
237:    def test_streaming_with_context(self, app, client):
250:    def test_streaming_with_context_as_decorator(self, app, client):
264:    def test_streaming_with_context_and_custom_close(self, app, client):
295:    def test_stream_keeps_session(self, app, client):
310:class TestHelpers:
321:    def test_get_debug_flag(self, monkeypatch, debug, expect):
325:    def test_make_response(self):
339:def test_open_resource(mode):
347:def test_open_resource_exceptions(mode):
355:def test_open_resource_with_encoding(tmp_path, encoding):
```

(Also: the class is not `TestSendfile` L33, `TestNoImports` L217, `TestStreaming` L236, or `TestHelpers` L310.)

Module header providing the names the class uses (`tests/test_helpers.py:1–8`):

```python
import io
import os

import pytest
import werkzeug.exceptions

import flask
from flask.helpers import get_debug_flag
```

**Name trap:** the HTTP-method test is `test_url_with_method` (L143), **not** `test_url_for_with_method`. A naive grep for `test_url_for_with_method` returns nothing.

---

## 2. Fixtures the class depends on — `tests/conftest.py`

Every method in `TestUrlFor` takes `(self, app, req_ctx)`. Both fixtures are defined in `tests/conftest.py` (verbatim):

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app


@pytest.fixture
def app_ctx(app):
    with app.app_context() as ctx:
        yield ctx


@pytest.fixture
def req_ctx(app):
    with app.test_request_context() as ctx:
        yield ctx
```

`req_ctx` is what makes `flask.url_for(...)` see an active request context, so `_external` defaults to `_scheme is not None` and internal URLs (`/#x%20y`, `/myview/`) are produced with an `http://localhost` host. Autouse fixtures also wrap every test (relevant when running the class):

```python
@pytest.fixture(scope="session", autouse=True)
def _standard_os_environ():
    """Set up ``os.environ`` at the start of the test session to have
    standard values. ..."""
    ...
@pytest.fixture(autouse=True)
def leak_detector():
    yield
    # make sure we're not leaking a request context ...
    leaks = []
    while request_ctx:
        leaks.append(request_ctx._get_current_object())
        request_ctx.pop()
    assert leaks == []
```

---

## 3. The code under test — `Flask.url_for`, `src/flask/app.py:1003`

The tests call `flask.url_for` → `helpers.url_for` → `Flask.url_for`. The router method that implements `_anchor` / `_scheme` / `_method` is `src/flask/app.py:1003` (verbatim; docstring elided only where marked):

```python
    def url_for(
        self,
        /,
        endpoint: str,
        *,
        _anchor: str | None = None,
        _method: str | None = None,
        _scheme: str | None = None,
        _external: bool | None = None,
        **values: t.Any,
    ) -> str:
        """Generate a URL to the given endpoint with the given values.

        This is called by :func:`flask.url_for`, and can be called
        directly as well.
        ...
        :param _anchor: If given, append this as ``#anchor`` to the URL.
        :param _method: If given, generate the URL associated with this
            method for the endpoint.
        :param _scheme: If given, the URL will have this scheme if it
            is external.
        :param _external: If given, prefer the URL to be internal
            (False) or require it to be external (True). External URLs
            include the scheme and domain. When not in an active
            request, URLs are external by default.
        :param values: Values to use for the variable parts of the URL
            rule. Unknown keys are appended as query string arguments,
            like ``?a=b&c=d``.

        .. versionadded:: 2.2
            Moved from ``flask.url_for``, which calls this method.
        """
        req_ctx = _cv_request.get(None)

        if req_ctx is not None:
            url_adapter = req_ctx.url_adapter
            blueprint_name = req_ctx.request.blueprint

            # If the endpoint starts with "." and the request matches a
            # blueprint, the endpoint is relative to the blueprint.
            if endpoint[:1] == ".":
                if blueprint_name is not None:
                    endpoint = f"{blueprint_name}{endpoint}"
                else:
                    endpoint = endpoint[1:]

            # When in a request, generate a URL without scheme and
            # domain by default, unless a scheme is given.
            if _external is None:
                _external = _scheme is not None
        else:
            app_ctx = _cv_app.get(None)

            # If called by helpers.url_for, an app context is active,
            # use its url_adapter. Otherwise, app.url_for was called
            # directly, build an adapter.
            if app_ctx is not None:
                url_adapter = app_ctx.url_adapter
            else:
                url_adapter = self.create_url_adapter(None)

            if url_adapter is None:
                raise RuntimeError(
                    "Unable to build URLs outside an active request"
                    " without 'SERVER_NAME' configured. Also configure"
                    " 'APPLICATION_ROOT' and 'PREFERRED_URL_SCHEME' as"
                    " needed."
                )

            # When outside a request, generate a URL with scheme and
            # domain by default.
            if _external is None:
                _external = True

        # It is an error to set _scheme when _external=False, in order
        # to avoid accidental insecure URLs.
        if _scheme is not None and not _external:
            raise ValueError("When specifying '_scheme', '_external' must be True.")

        self.inject_url_defaults(endpoint, values)

        try:
            rv = url_adapter.build(  # type: ignore[union-attr]
                endpoint,
                values,
                method=_method,
                url_scheme=_scheme,
                force_external=_external,
            )
        except BuildError as error:
            values.update(
                _anchor=_anchor, _method=_method, _scheme=_scheme, _external=_external
            )
            return self.handle_url_build_error(error, endpoint, values)

        if _anchor is not None:
            _anchor = _url_quote(_anchor, safe="%!#$&'()*+,/:;=?@")
            rv = f"{rv}#{_anchor}"

        return rv
```

This body maps one-to-one onto the class's assertions: `_external = _scheme is not None` (@1077) for `test_url_for_with_scheme_not_external`'s implicit-external case; `raise ValueError("When specifying '_scheme', '_external' must be True.")` (@1104–1105) for its `pytest.raises(ValueError)`; `method=_method` (@1113) and `url_scheme=_scheme` (@1114) for `test_url_with_method` and the scheme tests; and `_anchor = _url_quote(...)` / `rv = f"{rv}#{_anchor}"` (@1123–1125) for `"/#x%20y"`. `_url_quote` is `from urllib.parse import quote as _url_quote` at `src/flask/app.py:12`; `BuildError` is `from werkzeug.routing import BuildError` at line 20.

The public function the tests actually call is `src/flask/helpers.py:188` (verbatim, docstring elided where marked):

```python
def url_for(
    endpoint: str,
    *,
    _anchor: str | None = None,
    _method: str | None = None,
    _scheme: str | None = None,
    _external: bool | None = None,
    **values: t.Any,
) -> str:
    """Generate a URL to the given endpoint with the given values.

    This requires an active request or application context, and calls
    :meth:`current_app.url_for() <flask.Flask.url_for>`. See that method
    for full documentation.
    ...
    .. versionchanged:: 0.9
       The ``_anchor`` and ``_method`` parameters were added.
    """
    return current_app.url_for(
        endpoint,
        _anchor=_anchor,
        _method=_method,
        _scheme=_scheme,
        _external=_external,
        **values,
    )
```

Exported as `flask.url_for` in `src/flask/__init__.py:22`:

```python
from .helpers import url_for as url_for
```

Supporting machinery for `test_url_with_method` lives in `src/flask/views.py`: `MethodView` (L138) auto-populates `cls.methods` from the `get`/`post` methods defined on the subclass (`__init_subclass__`, L165, and L168–180), which is why the three `add_url_rule` registrations in the test yield distinct rules selected by `_method="GET"` vs `_method="POST"` (`as_view` at L86, `view.methods = cls.methods` at L133).

---

## 4. Executed verification (all outputs verbatim, from the venv interpreter)

Interpreter used (the project venv, **not** the ambient `python`):

```
$ .venv/Scripts/python.exe --version && .venv/Scripts/python.exe -m pytest --version
Python 3.13.9
pytest 8.4.0
```

Collection of the class under test:

```
$ .venv/Scripts/python.exe -m pytest "tests/test_helpers.py::TestUrlFor" --collect-only -q
tests/test_helpers.py::TestUrlFor::test_url_for_with_anchor
tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme
tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme_not_external
tests/test_helpers.py::TestUrlFor::test_url_for_with_alternating_schemes
tests/test_helpers.py::TestUrlFor::test_url_with_method
tests/test_helpers.py::TestUrlFor::test_url_for_with_self

6 tests collected in 0.06s
---exit:0
```

Execution of the class:

```
$ .venv/Scripts/python.exe -m pytest "tests/test_helpers.py::TestUrlFor" -v --tb=short
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q10-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q10-TXT\seal
configfile: pyproject.toml
collecting ... collected 6 items

tests/test_helpers.py::TestUrlFor::test_url_for_with_anchor PASSED       [ 16%]
tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme PASSED       [ 33%]
tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme_not_external PASSED [ 50%]
tests/test_helpers.py::TestUrlFor::test_url_for_with_alternating_schemes PASSED [ 66%]
tests/test_helpers.py::TestUrlFor::test_url_with_method PASSED           [ 83%]
tests/test_helpers.py::TestUrlFor::test_url_for_with_self PASSED         [100%]

============================== 6 passed in 0.13s ==============================
---exit:0
```

Full suite (twice — normal and maximally verbose), confirming the class is collected and passing as part of the whole suite:

```
$ .venv/Scripts/python.exe -m pytest
...
tests\test_helpers.py ..................................                 [ 66%]
...
============================= 489 passed in 5.74s =============================
---exit:0
```

```
$ .venv/Scripts/python.exe -m pytest -vv -rA --tb=long
...
PASSED tests/test_helpers.py::TestUrlFor::test_url_for_with_anchor
PASSED tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme
PASSED tests/test_helpers.py::TestUrlFor::test_url_for_with_scheme_not_external
PASSED tests/test_helpers.py::TestUrlFor::test_url_for_with_alternating_schemes
PASSED tests/test_helpers.py::TestUrlFor::test_url_with_method
PASSED tests/test_helpers.py::TestUrlFor::test_url_for_with_self
...
============================= 489 passed in 6.44s =============================
---exit:0
```

**Interpreter note (benign):** the venv's `flask.pth` pointed `flask` at a sibling copy of the tree; `diff -q` proved the sources identical (`src/flask/app.py`, `src/flask/helpers.py`, `tests/test_helpers.py` all exit 0), and re-running with `PYTHONPATH` pinned to this working directory's own `src/` reproduced `6 passed in 0.13s`.

---

## 5. Why no near-miss is the answer

The only other places in `tests/` where `_anchor`/`_method`/`_scheme` appear are module-level *functions*, not classes:

`tests/test_basic.py` (function that merely asserts the special kwargs are forwarded as `None`):

```python
def test_url_for_passes_special_values_to_build_error_handler(app):
    @app.url_build_error_handlers.append
    def handler(error, endpoint, values):
        assert values == {
            "_external": False,
            "_anchor": None,
            "_method": None,
            "_scheme": None,
        }
        return "handled"

    with app.test_request_context():
        flask.url_for("/")
```

and `tests/test_basic.py`:

```python
def test_url_generation(app, req_ctx):
    @app.route("/hello/<name>", methods=["POST"])
    def hello():
        pass

    assert flask.url_for("hello", name="test x") == "/hello/test%20x"
    assert (
        flask.url_for("hello", name="test x", _external=True)
        == "http://localhost/hello/test%20x"
    )
```

The closest `_external`-only near-miss, `tests/test_reqctx.py:75–88`, exercises no anchor/scheme/method:

```python
    with app.test_request_context("/"):
        assert (
            flask.url_for("index", _external=True)
            == "http://localhost.localdomain:5000/"
        )

    with app.test_request_context("/"):
        assert (
            flask.url_for("sub", _external=True)
            == "http://foo.localhost.localdomain:5000/"
        )
```

Other `flask.url_for` call sites in `tests/`, none in the anchor/scheme/method family and none inside a `Test*` class covering it: `tests/test_appctx.py:17,24,29`; `tests/test_basic.py:1354,1359,1374,1385,1408,1420,1431,1475,1630,1634,1638,1664,1729–1731`; `tests/test_blueprints.py:164,168,210,269,273,781,785`; `tests/test_converters.py:26`; `tests/test_regression.py:14`; `tests/test_reqctx.py:76,82`; `tests/test_testing.py:312,329`.

`flask_mut2_i417ar2x/mutated_test.py` (outside `testpaths`) is a plain top-level script with no class, no fixtures, and no `_anchor`/`_scheme`/`_method`:

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

print("status_code:", response.status_code)
print("data:", response.data)
assert 200 == response.status_code, f"status {response.status_code}"
assert b"xxx" == response.data, f"data {response.data!r}"
print("ASSERTS PASSED (unexpected)")
```

Governing pytest configuration, `pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
filterwarnings = [
    "error",
]
```

`filterwarnings = ["error"]` means a warning during `TestUrlFor` would fail it; all six tests pass anyway.

Historical corroboration that the three kwargs are the ones this suite is meant to cover — `CHANGES.rst`, Version 0.9 (released 2012-07-01):

```rst
-   The ``url_for`` function now can generate anchors to the generated
    links.
-   The ``url_for`` function now can also explicitly generate URL rules
    specific to a given HTTP method.
```

---

## Bottom line

The test class that validates URL generation with anchors, schemes, and HTTP methods is **`TestUrlFor`**, defined at **`tests/test_helpers.py:102`** (class body lines 102–169), with the feature-validating methods `test_url_for_with_anchor` (L103, `_anchor`), `test_url_for_with_scheme` (L110, `_scheme`), `test_url_for_with_scheme_not_external` (L120, implicit external + `ValueError`), `test_url_for_with_alternating_schemes` (L131, `_scheme` alternation), and `test_url_with_method` (L143, `_method`). It targets `flask.url_for` → `Flask.url_for` in `src/flask/app.py:1003`, using the `app` and `req_ctx` fixtures from `tests/conftest.py`. All six tests in the class pass, and the full 489-test suite passes.
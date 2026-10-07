# Final answer

## Short answer

`UnexpectedUnicodeError` is defined in `src/flask/debughelpers.py` as

```python
class UnexpectedUnicodeError(AssertionError, UnicodeError):
    """Raised in places where we want some better error reporting for
    unexpected unicode or binary data.
    """
```

The dual inheritance encodes one architectural decision, applied consistently to every exception class in `debughelpers.py`: **a debug-mode diagnostic may enrich the message of a failure, but it must not reclassify the failure.** `AssertionError` carries Flask's "programmer/invariant violation" family (`raise AssertionError(...)` and bare `assert`, used for wrong-context pops, setup-after-first-request, endpoint overwrites, unimplemented view methods); `UnicodeError` carries the **encoding/decoding** family (a `ValueError` subclass, raised at the bytes↔text boundary that belongs to WSGI/Werkzeug). By inheriting both, the class sits **on the seam between Flask's text/HTTP-semantics layer and the transport/encoding layer** and is catchable by *either* family of handler — `except AssertionError` (debug validation failures) and `except UnicodeError` / `except ValueError` (encoding issues) both still work — while its presence in `debughelpers.py` plus Flask's `PROPAGATE_EXCEPTIONS`/`debug` gating marks it as a development-time-only diagnostic. Crucially, in this revision (commit `85c5d93`) the class is **a declared contract, not a live code path**: it is never raised, tested, exported, or documented. So the decision reflected is about *classification orthogonality* — validation/invariant failures and encoding issues are bridged explicitly rather than collapsed into one another.

---

## 1. The artifact, precisely

`src/flask/debughelpers.py` lines 1–20 (verbatim):

```python
from __future__ import annotations

import typing as t

from jinja2.loaders import BaseLoader
from werkzeug.routing import RequestRedirect

from .blueprints import Blueprint
from .globals import request_ctx
from .sansio.app import App

if t.TYPE_CHECKING:
    from .sansio.scaffold import Scaffold
    from .wrappers import Request

class UnexpectedUnicodeError(AssertionError, UnicodeError):
    """Raised in places where we want some better error reporting for
    unexpected unicode or binary data.
    """
```

It defines **no members** (empty body besides the docstring).

**It is referenced nowhere else.** A repo-wide search for the symbol returns only the definition:

```
src/flask/debughelpers.py:17: class UnexpectedUnicodeError(AssertionError, UnicodeError):
```

The only `debughelpers` import sites in the whole worktree are:

```
src/flask/app.py:502:        from .debughelpers import FormDataRoutingRedirect
src/flask/templating.py:83:        from .debughelpers import explain_template_loading_attempts
src/flask/wrappers.py:208:            from .debughelpers import attach_enctype_error_multidict
tests/test_basic.py:1108:    from flask.debughelpers import DebugFilesKeyError
```

`src/flask/__init__.py` re-exports `Flask`, `Blueprint`, `Config`, context helpers, globals, helpers, `jsonify`, signals, `Request`, `Response` — and imports nothing from `.debughelpers`. `docs/` never mentions `debughelpers`; `CHANGES.rst` has no `UnexpectedUnicode`/`debughelpers`/`unicode error` hit. **Therefore: no sentence of the form "Flask raises this when it receives unexpected unicode/binary" is true of this revision.** The class is a marker/contract for application or extension code that wants richer debug-mode reporting while keeping its exception catchable.

## 2. The `debughelpers.py` convention: enrich the message, keep the category

All three exception classes in the module, verbatim:

`src/flask/debughelpers.py` lines 23–47:

```python
class DebugFilesKeyError(KeyError, AssertionError):
    """Raised from request.files during debugging.  The idea is that it can
    provide a better error message than just a generic KeyError/BadRequest.
    """

    def __init__(self, request: Request, key: str) -> None:
        form_matches = request.form.getlist(key)
        buf = [
            f"You tried to access the file {key!r} in the request.files"
            " dictionary but it does not exist. The mimetype for the"
            f" request is {request.mimetype!r} instead of"
            " 'multipart/form-data' which means that no file contents"
            " were transmitted. To fix this error you should provide"
            ' enctype="multipart/form-data" in your form.'
        ]
        if form_matches:
            names = ", ".join(repr(x) for x in form_matches)
            buf.append(
                "\n\nThe browser instead transmitted some file names. "
                f"This was submitted: {names}"
            )
        self.msg = "".join(buf)

    def __str__(self) -> str:
        return self.msg
```

`src/flask/debughelpers.py` lines 50–78:

```python
class FormDataRoutingRedirect(AssertionError):
    """This exception is raised in debug mode if a routing redirect
    would cause the browser to drop the method or body. This happens
    when method is not GET, HEAD or OPTIONS and the status code is not
    307 or 308.
    """

    def __init__(self, request: Request) -> None:
        exc = request.routing_exception
        assert isinstance(exc, RequestRedirect)
        buf = [
            f"A request was sent to '{request.url}', but routing issued"
            f" a redirect to the canonical URL '{exc.new_url}'."
        ]

        if f"{request.base_url}/" == exc.new_url.partition("?")[0]:
            buf.append(
                " The URL was defined with a trailing slash. Flask"
                " will redirect to the URL with a trailing slash if it"
                " was accessed without one."
            )

        buf.append(
            " Send requests to the canonical URL, or use 307 or 308 for"
            " routing redirects. Otherwise, browsers will drop form"
            " data.\n\n"
            "This exception is only raised in debug mode."
        )
        super().__init__("".join(buf))
```

Pattern:

| Class | Bases | "Natural category" preserved |
|---|---|---|
| `UnexpectedUnicodeError` | `(AssertionError, UnicodeError)` | encoding family (`UnicodeError`, a `ValueError`) |
| `DebugFilesKeyError` | `(KeyError, AssertionError)` | lookup/key family (`KeyError`) |
| `FormDataRoutingRedirect` | `(AssertionError,)` | none — no natural category exists, so `AssertionError` alone |

Every class in the module includes `AssertionError`; where the failure has a "natural" Python exception category, that category is added alongside rather than replaced. **Consequence:** debug mode enriches the *message* without changing the *category*, so pre-existing `except` clauses keep working.

The pattern is live and tested. `attach_enctype_error_multidict` (`debughelpers.py` lines 81–104) is the debug-only shim that substitutes `DebugFilesKeyError` for a plain `KeyError`:

```python
def attach_enctype_error_multidict(request: Request) -> None:
    """Patch ``request.files.__getitem__`` to raise a descriptive error
    about ``enctype=multipart/form-data``.

    :param request: The request to patch.
    :meta private:
    """
    oldcls = request.files.__class__

    class newcls(oldcls):  # type: ignore[valid-type, misc]
        def __getitem__(self, key: str) -> t.Any:
            try:
                return super().__getitem__(key)
            except KeyError as e:
                if key not in request.form:
                    raise

                raise DebugFilesKeyError(request, key).with_traceback(
                    e.__traceback__
                ) from None

    newcls.__name__ = oldcls.__name__
    newcls.__module__ = oldcls.__module__
    request.files.__class__ = newcls
```

and `tests/test_basic.py` lines 1107–1120 exercises it:

```python
def test_enctype_debug_helper(app, client):
    from flask.debughelpers import DebugFilesKeyError

    app.debug = True

    @app.route("/fail", methods=["POST"])
    def index():
        return flask.request.files["foo"].filename

    with pytest.raises(DebugFilesKeyError) as e:
        client.post("/fail", data={"foo": "index.txt"})
    assert "no file contents were transmitted" in str(e.value)
    assert "This was submitted: 'index.txt'" in str(e.value)
```

This is the "debug-only, message-enriching, natural-category-preserving" pattern that `UnexpectedUnicodeError` generalizes to the unicode/binary case.

## 3. `AssertionError` = validation / invariant failure in Flask

Flask uses `AssertionError`/`assert` uniformly for *programmer-side invariant violations*. Representative quoted sites:

`src/flask/ctx.py` (`AppContext.pop`):

```python
        if ctx is not self:
            raise AssertionError(
                f"Popped wrong app context. ({ctx!r} instead of {self!r})"
            )
```

`src/flask/ctx.py` (`RequestContext.__exit__`):

```python
            if ctx is not self:
                raise AssertionError(
                    f"Popped wrong request context. ({ctx!r} instead of {self!r})"
                )
```

`src/flask/sansio/app.py` (`App._check_setup_finished`):

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_first_request:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called"
                " on the application. It has already handled its first"
                " request, any changes will not be applied"
                " consistently.\n"
                "Make sure all imports, decorators, functions, etc."
                " needed to set up the application are done before"
                " running it."
            )
```

`src/flask/sansio/app.py` (`add_url_rule` endpoint overwrite):

```python
        if view_func is not None:
            old_func = self.view_functions.get(endpoint)
            if old_func is not None and old_func != view_func:
                raise AssertionError(
                    "View function mapping is overwriting an existing"
                    f" endpoint function: {endpoint}"
                )
```

`src/flask/sansio/blueprints.py` (`Blueprint._check_setup_finished`):

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```

Bare `assert` follows the same role:

```python
# src/flask/app.py  (static_host/host_matching invariant)
assert bool(static_host) == host_matching, (
    "Invalid static_host/host_matching combination"
)
```
```python
# src/flask/sansio/scaffold.py  (_endpoint_from_view_func)
assert view_func is not None, "expected view func if endpoint is not provided."
return view_func.__name__
```
```python
# src/flask/views.py  (View.dispatch_request)
assert meth is not None, f"Unimplemented method {request.method!r}"
return current_app.ensure_sync(meth)(**kwargs)
```
```python
# src/flask/testing.py  (EnvironBuilder argument invariant)
assert not (base_url or subdomain or url_scheme) or (
    base_url is not None
) != bool(subdomain or url_scheme), (
    'Cannot pass "subdomain" or "url_scheme" with "base_url".'
)
```

`AssertionError` is therefore the framework's "this cannot happen if your code is correct" family — the **validation/invariant** side of the question.

## 4. `UnicodeError` = the encoding/decoding boundary

`UnicodeError` is a `ValueError` subclass, raised where bytes are decoded to text or text is encoded to bytes (the WSGI/Werkzeug transport side). Verified by introspection:

```
UnicodeError MRO: ['UnicodeError', 'ValueError', 'Exception', 'BaseException', 'object']
UnicodeDecodeError MRO: ['UnicodeDecodeError', 'UnicodeError', 'ValueError', 'Exception', 'BaseException', 'object']
UnicodeEncodeError MRO: ['UnicodeEncodeError', 'UnicodeError', 'ValueError', 'Exception', 'BaseException', 'object']
issubclass(UnicodeError, ValueError): True
issubclass(UnicodeError, AssertionError): False
```

Note the class uses the **general** `UnicodeError`, not one of its leaves (`UnicodeDecodeError`/`UnicodeEncodeError`). The evidence supports only `UnicodeError` as the base, i.e. the whole bytes↔text family.

## 5. The layered architecture and where this class sits

The layers, as stated in this repository (not a single named doctrine, but assembled from these statements):

`src/flask/sansio/README.md` (whole file):

```
# Sansio

This folder contains code that can be used by alternative Flask
implementations, for example Quart. The code therefore cannot do any
IO, nor be part of a likely IO path. Finally this code cannot use the
Flask globals.
```

`docs/design.rst`, "What Flask is, What Flask is Not":

```rst
Flask will never have a database layer.  It will not have a form library
or anything else in that direction.  Flask itself just bridges to Werkzeug
to implement a proper WSGI application and to Jinja2 to handle templating.
It also binds to a few common standard library packages such as logging.
Everything else is up for extensions.
```

and from the same file: "Flask is a framework that takes advantage of the work already done by Werkzeug to properly interface WSGI (which can be a complex task at times)." and "Flask will continue to provide a very simple glue layer to the best that Python has to offer. … take advantage of framework-agnostic tools built for WSGI, the Python web interface."

`docs/errorhandling.rst`:

```rst
When Flask catches an exception while handling a request, it is first looked up by code.
If no handler is registered for the code, Flask looks up the error by its class hierarchy; the most specific handler is chosen.
If no handler is registered, :class:`~werkzeug.exceptions.HTTPException` subclasses show a
generic message about their code, while other exceptions are converted to a
generic "500 Internal Server Error".
```

```rst
An error handler for "500 Internal Server Error" will be passed uncaught
exceptions in addition to explicit 500 errors. In debug mode, a handler
for "500 Internal Server Error" will not be used. Instead, the
interactive debugger will be shown.
```

Mapping:

* **WSGI/Werkzeug** owns bytes, transport, and `HTTPException` subclasses (`BadRequest`, `BadRequestKeyError`).
* **Flask (incl. `sansio` core)** owns text/HTTP semantics and the exception-routing machinery (`handle_user_exception` → `handle_http_exception`/`handle_exception`).
* **The application** owns business validation, and Flask's own internal guards are `AssertionError`/`assert`.

`UnexpectedUnicodeError` is deliberately placed *on the seam between the encoding layer and Flask's assertion/invariant layer*: an **encoding** failure (`UnicodeError`) that Flask deems an **assertion-level programmer error** deserving a richer traceback (`AssertionError`). It does **not** collapse the two: handlers of either family still see it.

## 6. MRO and catchability (verified empirically against this working tree)

Python introspection of the class as defined at `src/flask/debughelpers.py:17`:

```
MRO: ['UnexpectedUnicodeError', 'AssertionError', 'UnicodeError', 'ValueError', 'Exception', 'BaseException', 'object']
isinstance AssertionError: True
isinstance UnicodeError: True
isinstance ValueError: True
isinstance Exception: True
except AssertionError -> caught
except UnicodeError -> caught
except ValueError -> caught
except Exception -> caught
--- DebugFilesKeyError ---
MRO: ['DebugFilesKeyError', 'KeyError', 'LookupError', 'AssertionError', 'Exception', 'BaseException', 'object']
bases: (<class 'KeyError'>, <class 'AssertionError'>)
--- FormDataRoutingRedirect ---
bases: (<class 'AssertionError'>,)
MRO: ['FormDataRoutingRedirect', 'AssertionError', 'Exception', 'BaseException', 'object']
--- members defined on UnexpectedUnicodeError ---
own __dict__ keys: []
all own dict keys: ['__module__', '__firstlineno__', '__doc__', '__static_attributes__', '__weakref__']
```

So `except UnicodeError`, `except ValueError`, and `except AssertionError` all catch it, and the class contributes no attribute resolution of its own (no members). The base order is **not** MRO-behavioral here — it only affects attribute lookup, which is moot for a member-less class.

One correction to the plan worth recording: the *declaration order* is **not** uniform across siblings. `DebugFilesKeyError` declares `(KeyError, AssertionError)` (natural category first) while `UnexpectedUnicodeError` declares `(AssertionError, UnicodeError)` (assertion first). This does not change `isinstance`/`except` behavior, and both remain catchable under both families.

## 7. Debug-only gating: the same failure is a generic 500 in production

`src/flask/app.py`, `handle_exception` — re-raise only when propagating:

```python
    def handle_exception(self, e: Exception) -> Response:
        """Handle an exception that did not have an error handler
        associated with it, or that was raised from an error handler.
        This always causes a 500 ``InternalServerError``.

        Always sends the :data:`got_request_exception` signal.

        If :data:`PROPAGATE_EXCEPTIONS` is ``True``, such as in debug
        mode, the error will be re-raised so that the debugger can
        display it. Otherwise, the original exception is logged, and
        an :exc:`~werkzeug.exceptions.InternalServerError` is returned.
        ...
        """
        exc_info = sys.exc_info()
        got_request_exception.send(self, _async_wrapper=self.ensure_sync, exception=e)
        propagate = self.config["PROPAGATE_EXCEPTIONS"]

        if propagate is None:
            propagate = self.testing or self.debug

        if propagate:
            # Re-raise if called with an active exception, otherwise
            # raise the passed in exception.
            if exc_info[1] is e:
                raise

            raise e

        self.log_exception(exc_info)
        server_error: InternalServerError | ft.ResponseReturnValue
        server_error = InternalServerError(original_exception=e)
        handler = self._find_error_handler(server_error, request.blueprints)

        if handler is not None:
            server_error = self.ensure_sync(handler)(server_error)

        return self.finalize_request(server_error, from_error_handler=True)
```

Config defaults make `propagate` fall back to `testing or debug` (`src/flask/app.py`, `default_config`):

```python
             "DEBUG": None,
             "TESTING": False,
             "PROPAGATE_EXCEPTIONS": None,
             ...
             "TRAP_BAD_REQUEST_ERRORS": None,
             "TRAP_HTTP_EXCEPTIONS": False,
             "EXPLAIN_TEMPLATE_LOADING": False,
```

Debug mode is also what activates the helper classes and richer messages, `src/flask/app.py`, `handle_user_exception`:

```python
        if isinstance(e, BadRequestKeyError) and (
            self.debug or self.config["TRAP_BAD_REQUEST_ERRORS"]
        ):
            e.show_exception = True

        if isinstance(e, HTTPException) and not self.trap_http_exception(e):
            return self.handle_http_exception(e)

        handler = self._find_error_handler(e, request.blueprints)

        if handler is None:
            raise

        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

`src/flask/wrappers.py` — the debug-only patches:

```python
    def _load_form_data(self) -> None:
        super()._load_form_data()

        # In debug mode we're replacing the files multidict with an ad-hoc
        # subclass that raises a different error for key errors.
        if (
            current_app
            and current_app.debug
            and self.mimetype != "multipart/form-data"
            and not self.files
        ):
            from .debughelpers import attach_enctype_error_multidict

            attach_enctype_error_multidict(self)

    def on_json_loading_failed(self, e: ValueError | None) -> t.Any:
        try:
            return super().on_json_loading_failed(e)
        except BadRequest as ebr:
            if current_app and current_app.debug:
                raise

            raise BadRequest() from ebr
```

`src/flask/app.py`, `raise_routing_exception` — `FormDataRoutingRedirect` is raised only in debug:

```python
        if (
            not self.debug
            or not isinstance(request.routing_exception, RequestRedirect)
            or request.routing_exception.code in {307, 308}
            or request.method in {"GET", "HEAD", "OPTIONS"}
        ):
            raise request.routing_exception  # type: ignore[misc]

        from .debughelpers import FormDataRoutingRedirect

        raise FormDataRoutingRedirect(request)
```

`src/flask/sansio/app.py`, `trap_http_exception`:

```python
    def trap_http_exception(self, e: Exception) -> bool:
        """Checks if an HTTP exception should be trapped or not.  By default
        this will return ``False`` for all exceptions except for a bad request
        key error if ``TRAP_BAD_REQUEST_ERRORS`` is set to ``True``.  It
        also returns ``True`` if ``TRAP_HTTP_EXCEPTIONS`` is set to ``True``.

        This is called for all HTTP exceptions raised by a view function.
        If it returns ``True`` for any exception the error handler for this
        exception is not called and it shows up as regular exception in the
        traceback.  This is helpful for debugging implicitly raised HTTP
        exceptions.
        ...
        """
```

and the `debug` property:

```python
    @property
    def debug(self) -> bool:
        """Whether debug mode is enabled. When using ``flask run`` to start the
        development server, an interactive debugger will be shown for unhandled
        exceptions, and the server will be reloaded when code changes. This maps to the
        :data:`DEBUG` config key. It may not behave like expected if set late.

        **Do not enable debug mode when deploying in production.**

        Default: ``False``
        """
        return self.config["DEBUG"]  # type: ignore[no-any-return]
```

The separation is thus explicit:

* **User-facing HTTP validation errors** (`BadRequest`, `BadRequestKeyError`, from Werkzeug) go through `handle_user_exception`/`handle_http_exception` and stay in the HTTP layer.
* **Internal programmer/invariant errors** (`AssertionError`) are the framework's own "should not happen" family.
* **Encoding failures** (`UnicodeError`, a `ValueError`) belong to the bytes↔text boundary.
* **The debug helper** sits at the intersection of the last two without merging them, and is only *used* (in the sibling cases) when `debug` is on; in production the same underlying failure is converted to `InternalServerError` instead of the enriched class.

## 8. Direct answer to the question's "why"

The architectural decisions reflected by `class UnexpectedUnicodeError(AssertionError, UnicodeError)` are:

1. **Debug diagnostics preserve an exception's original semantic family.** Encoding failures must remain catchable as `UnicodeError`/`ValueError`; debug assistance must not silently reclassify them.
2. **They additionally announce themselves as assertion/programming failures.** Presence of `AssertionError` marks the failure as Framework-internal/`assert`-style ("this should not happen if your code is correct"), matching every other class in `debughelpers.py` and the `raise AssertionError(...)` sites in `ctx.py`, `sansio/app.py`, `sansio/blueprints.py`, plus bare `assert` in `app.py`, `sansio/scaffold.py`, `views.py`, `testing.py`.
3. **Error classification is orthogonal to message enrichment.** The class both keeps the category and lives in the debug module, i.e. richer reporting is added without touching the handler-dispatch taxonomy.
4. **The bytes/text boundary (encoding) and the application/invariant layer (validation) are bridged explicitly rather than silently converted.** `isinstance(e, UnicodeError)` and `isinstance(e, AssertionError)` are both true, so both families of handlers — including Flask's own class-hierarchy error lookup described in `docs/errorhandling.rst` — continue to see the exception.
5. **The bridge is confined to development.** Inheritance makes the class catchable, but Flask's `PROPAGATE_EXCEPTIONS`/`debug`/`testing` gating and its placement in `debughelpers.py` mean that in production the same failure degrades to a generic `InternalServerError`, and `UnexpectedUnicodeError` itself is never raised by Flask in this revision.

## 9. Verification notes

* The full test suite was run twice against this working tree (pinned via `PYTHONPATH=<cwd>/src`, because the venv's `flask.pth` pointed at a different checkout): once normally and once with `-vv -rA --tb=long`. Both runs exited 0 with **`489 passed`**. Notably `tests/test_basic.py::test_enctype_debug_helper` (the sibling debug helper) passed, and no test anywhere references `UnexpectedUnicodeError` or `FormDataRoutingRedirect`.
* `flask_mut2_i417ar2x/mutated_test.py` inside the tree is an unrelated leftover (subdomain `url_for` routing; `subdomain_matching=False`, `SERVER_NAME="example.com"`, route with `subdomain="<company_id>"`). It contains no reference to unicode, `AssertionError`, or `debughelpers`, is not collected by the suite (`testpaths = ["tests"]`), and is not evidence for this question.

### Evidence table (file → symbol)

| File | Lines | Symbol / content |
|---|---|---|
| `src/flask/debughelpers.py` | 17–20 | `UnexpectedUnicodeError(AssertionError, UnicodeError)` — no members |
| `src/flask/debughelpers.py` | 23–47 | `DebugFilesKeyError(KeyError, AssertionError)` |
| `src/flask/debughelpers.py` | 50–78 | `FormDataRoutingRedirect(AssertionError)` |
| `src/flask/debughelpers.py` | 81–104 | `attach_enctype_error_multidict` → raises `DebugFilesKeyError` |
| `src/flask/debughelpers.py` | 107–end | `_dump_loader_info`, `explain_template_loading_attempts` (non-exception helpers) |
| repo-wide grep | — | only hit for `UnexpectedUnicodeError` is the definition |
| `src/flask/__init__.py` | 1–40 | no `debughelpers` import / no export |
| `docs/`, `CHANGES.rst` | — | `debughelpers` / `UnexpectedUnicode` never mentioned |
| `src/flask/ctx.py` | 267–270, 428–431 | `raise AssertionError(...)` (wrong context popped) |
| `src/flask/sansio/app.py` | 413–424, 654–660 | `raise AssertionError(...)` (setup-after-first-request; endpoint overwrite) |
| `src/flask/sansio/blueprints.py` | 213–221 | `raise AssertionError(...)` |
| `src/flask/app.py` | 268–270 | `assert bool(static_host) == host_matching` |
| `src/flask/sansio/scaffold.py` | 705 | `assert view_func is not None` |
| `src/flask/views.py` | 190 | `assert meth is not None` |
| `src/flask/testing.py` | 59–63 | `assert not (base_url or subdomain or url_scheme)` |
| `src/flask/app.py` | 178–207 | `PROPAGATE_EXCEPTIONS: None`, `TRAP_BAD_REQUEST_ERRORS: None`, `TRAP_HTTP_EXCEPTIONS: False` |
| `src/flask/app.py` | 744–777, 779–809, 811–871 | `handle_http_exception`, `handle_user_exception`, `handle_exception` |
| `src/flask/app.py` | 670–690 | `test_client` docstring (AssertionError propagation) |
| `src/flask/app.py` | 478–505 | `raise_routing_exception` → debug-only `FormDataRoutingRedirect` |
| `src/flask/sansio/app.py` | 550–567, 848–883 | `debug` property, `trap_http_exception` |
| `src/flask/wrappers.py` | 196–218 | `_load_form_data`, `on_json_loading_failed` |
| `src/flask/templating.py` | 83 | imports `explain_template_loading_attempts` (debug) |
| `src/flask/sansio/README.md` | whole | sansio/IO separation |
| `docs/design.rst` | 166, 206–225 | thin Werkzeug/Jinja2 bridge; "simple glue layer" |
| `docs/errorhandling.rst` | Handling / Unhandled Exceptions | class-hierarchy lookup; debug shows debugger |
| `tests/test_basic.py` | 1107–1120 | `test_enctype_debug_helper` |
| introspection | — | `UnexpectedUnicodeError` MRO and `isinstance`/`except` results above |
| `flask_mut2_i417ar2x/mutated_test.py` | whole | unrelated (subdomain routing) |
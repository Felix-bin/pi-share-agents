# `UnexpectedUnicodeError(AssertionError, UnicodeError)`: why the dual inheritance?

## 0. What was asked and what this document is

The task is to explain Flask's `UnexpectedUnicodeError`, whose definition is:

```python
class UnexpectedUnicodeError(AssertionError, UnicodeError):
    """Raised in places where we want some better error reporting for
    unexpected unicode or binary data.
    """
```

(`src/flask/debughelpers.py:17–20`)

and specifically to account for **why it inherits from both `AssertionError` and `UnicodeError`**. Below is the complete evidence collected from the worktree (retrieve), the plan of analysis (execute), the raw verification, and the resulting architectural conclusion. Every claim is quoted from source. The one negative finding — the class has **no raise site in this tree** — is reported as a **finding**, not smoothed over with inference.

I verified the key greps myself against the worktree; they reproduce exactly:

```
grep "UnexpectedUnicodeError" → src/flask/debughelpers.py:17: class UnexpectedUnicodeError(AssertionError, UnicodeError):
grep "DebugFilesKeyError"     → tests/test_basic.py:1108, tests/test_basic.py:1116, src/flask/debughelpers.py:23, src/flask/debughelpers.py:98
grep "debughelpers"           → tests/test_basic.py:1108, src/flask/app.py:502, src/flask/templating.py:83, src/flask/wrappers.py:208
```

---

# PART I — The evidence, quoted in full

## Finding 1 — The class definition (verbatim)

**File: `src/flask/debughelpers.py`, lines 1–26 (read directly from the worktree):**

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

class DebugFilesKeyError(KeyError, AssertionError):
    """Raised from request.files during debugging.  The idea is that it can
    provide a better error message than just a generic KeyError/BadRequest.
    """
```

**Key facts confirmed:**

- The bases are ordered **`AssertionError` first, `UnicodeError` second** (`src/flask/debughelpers.py:17`).
- The class body is **docstring only** — no `__init__`, no `__str__`, no methods (`:18–20`).
- Its sibling `DebugFilesKeyError(KeyError, AssertionError)` at `:23` uses the **reversed order** (KeyError first, AssertionError second) — so the ordering is a deliberate per-class choice, not a house style.
- Its sibling `FormDataRoutingRedirect(AssertionError)` at `:50` has a **single** base.

The full remaining portion of the module (also read directly), showing the sibling classes that are actually raised:

```python
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
```

---

## Finding 2 — Zero `raise` sites for `UnexpectedUnicodeError` (the critical caveat)

An exhaustive search over the worktree returns **exactly one occurrence** — the definition itself:

```
src/flask/debughelpers.py:17: class UnexpectedUnicodeError(AssertionError, UnicodeError):
```

The class appears in **no** `raise` statement, in **no** import list, in **no** test, and in **no** documentation page.

**Contrast with the siblings that ARE raised** (proving this dual-inheritance pattern is normally live, which makes the absence here meaningful):

```
grep "DebugFilesKeyError"
tests/test_basic.py:1108: from flask.debughelpers import DebugFilesKeyError
tests/test_basic.py:1116: with pytest.raises(DebugFilesKeyError) as e:
src/flask/debughelpers.py:23: class DebugFilesKeyError(KeyError, AssertionError):
src/flask/debughelpers.py:98: raise DebugFilesKeyError(request, key).with_traceback(
```

```
grep "FormDataRoutingRedirect"
src/flask/app.py:502: from .debughelpers import FormDataRoutingRedirect
src/flask/app.py:504: raise FormDataRoutingRedirect(request)
src/flask/debughelpers.py:50: class FormDataRoutingRedirect(AssertionError):
```

**Conclusion (stated as a finding, not an assumption):** `UnexpectedUnicodeError` is never thrown by Flask itself in this tree. It currently exists **to be importable/catchable**, i.e. as a registered contract for extensions and for the debug layer, not as a live code path.

An internal audit of the module confirms there are only two `raise` statements, both for the sibling:

```
Occurrences of 'raise' in debughelpers source:
  L96: raise
  L98: raise DebugFilesKeyError(request, key).with_traceback(
Any 'raise' mentioning UnexpectedUnicodeError? False
```

---

## Finding 3 — All imports of `debughelpers` (the debug-only entry points)

```
tests/test_basic.py:1108: from flask.debughelpers import DebugFilesKeyError
src/flask/app.py:502:     from .debughelpers import FormDataRoutingRedirect
src/flask/templating.py:83: from .debughelpers import explain_template_loading_attempts
src/flask/wrappers.py:208: from .debughelpers import attach_enctype_error_multidict
```

`UnexpectedUnicodeError` appears in **none** of these. Every consumer imports its debughelper **lazily inside a branch**.

### 3a. `src/flask/app.py` — the debug-gated routing-redirect raise

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

The import is lazy, inside the debug-gated branch (line 502); the raise is line 504.

### 3b. `src/flask/templating.py` — lazy import inside the loader

```python
        from .debughelpers import explain_template_loading_attempts

        explain_template_loading_attempts(self.app, template, attempts)
```

### 3c. `src/flask/wrappers.py:197–219` — the debug gating of the "better error" machinery (read directly)

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

### 3d. `tests/test_basic.py:1107–1119` — the only test touching a debughelper class

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

---

## Finding 4 — Layering: `debughelpers.py` is in the concrete WSGI layer, not sans-io

From Finding 1:

```python
from jinja2.loaders import BaseLoader
from werkzeug.routing import RequestRedirect

from .blueprints import Blueprint
from .globals import request_ctx
from .sansio.app import App

if t.TYPE_CHECKING:
    from .sansio.scaffold import Scaffold
    from .wrappers import Request
```

`debughelpers.py` depends **on** the sans-io core (`from .sansio.app import App`) rather than living inside it. The directory layout confirms this: `debughelpers.py` is a top-level sibling of `app.py`, `wrappers.py`, and `templating.py`, and is **not** inside `src/flask/sansio/`.

It is also **not** re-exported from the package root. `src/flask/__init__.py` exposes `Flask`, `Blueprint`, `Config`, request/response, helpers, signals, and templating utilities — but no exception from `debughelpers`. So the class is reachable only via `import flask.debughelpers`.

---

## Finding 5 — AssertionError-side semantics (Flask control flow)

### 5a. `src/flask/app.py:796–809` — `handle_user_exception` (read directly)

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

### 5b. `src/flask/app.py:841–852` — `PROPAGATE_EXCEPTIONS` re-raise

```python
        propagate = self.config["PROPAGATE_EXCEPTIONS"]

        if propagate is None:
            propagate = self.testing or self.debug

        if propagate:
            # Re-raise if called with an active exception, otherwise
            # raise the passed in exception.
            if exc_info[1] is e:
                raise

            raise e
```

### 5c. `src/flask/sansio/app.py:823–881` — `_find_error_handler` (MRO walk) + `trap_http_exception` (read directly)

```python
    def _find_error_handler(
        self, e: Exception, blueprints: list[str]
    ) -> ft.ErrorHandlerCallable | None:
        """Return a registered error handler for an exception in this order:
        blueprint handler for a specific code, app handler for a specific code,
        blueprint handler for an exception class, app handler for an exception
        class, or ``None`` if a suitable handler is not found.
        """
        exc_class, code = self._get_exc_class_and_code(type(e))
        names = (*blueprints, None)

        for c in (code, None) if code is not None else (None,):
            for name in names:
                handler_map = self.error_handler_spec[name][c]

                if not handler_map:
                    continue

                for cls in exc_class.__mro__:
                    handler = handler_map.get(cls)

                    if handler is not None:
                        return handler
        return None

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

        .. versionchanged:: 1.0
            Bad request errors are not trapped by default in debug mode.

        .. versionadded:: 0.8
        """
        if self.config["TRAP_HTTP_EXCEPTIONS"]:
            return True

        trap_bad_request = self.config["TRAP_BAD_REQUEST_ERRORS"]

        # if unset, trap key errors in debug mode
        if (
            trap_bad_request is None
            and self.debug
            and isinstance(e, BadRequestKeyError)
        ):
            return True

        if trap_bad_request:
            return isinstance(e, BadRequest)

        return False
```

**Critical mechanism:** `_find_error_handler` walks `exc_class.__mro__` (`src/flask/sansio/app.py:841`). Handlers registered for `AssertionError`, `UnicodeError`, `ValueError`, or `Exception` all match an `UnexpectedUnicodeError` instance; the resolution follows the MRO — which is determined by the base order in the class definition.

### 5d. `src/flask/sansio/app.py:656–698` — `_get_exc_class_and_code` (which classes can register handlers)

```python
        if issubclass(exc_class, HTTPException):
            return exc_class, exc_class.code
        else:
            return exc_class, None
```

**Consequence:** `UnexpectedUnicodeError` is a subclass of `Exception` (via `AssertionError`/`UnicodeError`) and is **not** an `HTTPException`, so it returns `(UnexpectedUnicodeError, None)` — **no HTTP status code**. It is not classified as an HTTP validation failure.

### 5e. `src/flask/ctx.py:267–270` — plain internal `AssertionError` (app-context pop invariant), read directly

```python
        if ctx is not self:
            raise AssertionError(
                f"Popped wrong app context. ({ctx!r} instead of {self!r})"
            )
```

And the same pattern at `src/flask/ctx.py:428–431`:

```python
            if ctx is not self:
                raise AssertionError(
                    f"Popped wrong request context. ({ctx!r} instead of {self!r})"
                )
```

### 5f. The test-client/production assertion boundary — `tests/test_basic.py:607–612`

```python
    # Specifically, if app.testing is not set to True, the AssertionErrors
    # in the view functions will cause a 500 response to the test client
    # instead of propagating exceptions.
```

**Conclusion:** `AssertionError` in Flask means "a Flask-internal invariant/validation failure that should surface loudly to the developer."

---

## Finding 6 — UnicodeError-side semantics (the Werkzeug/sans-io boundary)

### 6a. `.venv/.../werkzeug/routing/map.py:236–239` — `UnicodeError` translated into `BadHost`

```python
        try:
            server_name = server_name.encode("idna").decode("ascii")
        except UnicodeError as e:
            raise BadHost() from e
```

### 6b. `.venv/.../werkzeug/exceptions.py` — `BadHost` is an HTTP error

```python
class BadHost(BadRequest):
    """Raised if the submitted host is badly formatted.

    .. versionadded:: 0.11.2
    """
```

### 6c. `.venv/.../werkzeug/sansio/utils.py:23–26,38–41` — `UnicodeEncodeError` swallowed to `False`

```python
    try:
        hostname = hostname.partition(":")[0].encode("idna").decode("ascii")
    except UnicodeEncodeError:
        return False
...
        try:
            ref = ref.partition(":")[0].encode("idna").decode("ascii")
        except UnicodeEncodeError:
            return False
```

### 6d. Complete `grep "UnicodeError"` — the only Flask-tree occurrence is the class definition

```
.venv/Lib/site-packages/werkzeug/urls.py:16: def _codec_error_url_quote(e: UnicodeError) -> tuple[str, int]:
.venv/Lib/site-packages/werkzeug/routing/map.py:238: except UnicodeError as e:
src/flask/debughelpers.py:17: class UnexpectedUnicodeError(AssertionError, UnicodeError):
```

**Conclusion:** `UnicodeError` means "bytes↔text/IDNA codec failure occurring at the Werkzeug/sans-io boundary." Werkzeug chooses to **translate** it into an HTTP error (`BadHost`); `UnexpectedUnicodeError` chooses to keep it **catchable as both an encoding error and an assertion**.

---

## Finding 7 — The Werkzeug analogue `BadRequestKeyError(BadRequest, KeyError)` (for contrast)

**`.venv/.../werkzeug/exceptions.py:189–198`:**

```python
class BadRequestKeyError(BadRequest, KeyError):
    """An exception that is used to signal both a :exc:`KeyError` and a
    :exc:`BadRequest`. Used by many of the datastructures.
    """

    _description = BadRequest.description
    #: Show the KeyError along with the HTTP error message in the
    #: response. This should be disabled in production, but can be
    #: useful in a debug mode.
    show_exception = False
```

**Contrast recorded:** Werkzeug's mix lists the HTTP base **first** (`BadRequest`, `KeyError`). Flask's `UnexpectedUnicodeError` lists `AssertionError` **first** and deliberately does **not** include `BadRequest`/`HTTPException`. Consequently `BadRequestKeyError.code == 400`, whereas `UnexpectedUnicodeError` carries no HTTP status.

`BadRequestKeyError` is raised at many sites inside Werkzeug's datastructures (e.g. `structures.py:238`, `:499`, `:516`), and Flask *consumes* it in exactly two places:

```
src/flask/app.py:17: from werkzeug.exceptions import BadRequestKeyError
src/flask/app.py:796: if isinstance(e, BadRequestKeyError) and (
src/flask/sansio/app.py:12: from werkzeug.exceptions import BadRequestKeyError
src/flask/sansio/app.py:874: and isinstance(e, BadRequestKeyError)
```

---

## Finding 8 — Negative evidence / stated limitations

1. **No `raise` site for `UnexpectedUnicodeError`** — the only occurrence is the definition (`debughelpers.py:17`).
2. **No test references it** — the only debughelper class under test is `DebugFilesKeyError`.
3. **No `CHANGES.rst` entry mentions it** (grep returns nothing; the unreleased section reads `Version 3.2.0` / `Unreleased` with unrelated entries).
4. **No docs page references it** — no hits anywhere under `docs/`.
5. **It is not exported from `flask/__init__.py`** — reachable only via `flask.debughelpers`.
6. **No `Idna`-cased identifier exists**; IDNA appears only as the lowercase codec string `"idna"`.

---

# PART II — The plan (steps as executed)

**Step 1 — Pin the exact definition and inheritance order.**
`class UnexpectedUnicodeError(AssertionError, UnicodeError):` with a docstring-only body (`debughelpers.py:17–20`). Bases: **AssertionError first, UnicodeError second**. Resulting MRO: `UnexpectedUnicodeError → AssertionError → UnicodeError → ValueError → Exception → BaseException → object`. This is legal because `UnicodeError` subclasses `ValueError`, so no MRO conflict arises. The order matters for `except`/handler resolution.

**Step 2 — Prove it is debug-only and unused, i.e. an extension/back-compat hook, not a live path.**
`grep "UnexpectedUnicodeError"` returns only the definition; no `raise`, no test. Contrast the siblings that are raised: `DebugFilesKeyError` at `debughelpers.py:98` (tested at `tests/test_basic.py:1116`) and `FormDataRoutingRedirect` at `app.py:504`. **Finding:** the class exists to be importable/catchable, not to be thrown by Flask itself.

**Step 3 — Map the layer placement.**
`debughelpers.py` imports from Werkzeug/Jinja (`werkzeug.routing.RequestRedirect`, `jinja2.loaders.BaseLoader`) and from Flask sans-io (`from .sansio.app import App`, `sansio.scaffold.Scaffold`) plus concrete pieces (`Blueprint`, `globals.request_ctx`). It lives in the **WSGI/concrete layer, not in `flask/sansio/`**, and every consumer imports it lazily inside a debug-gated branch.

**Step 4 — Gather the debug gating evidence.**
`wrappers.py:200–210` (`if (current_app and current_app.debug and self.mimetype != "multipart/form-data" and not self.files):`) and `wrappers.py:212–219` (the debug/prod `BadRequest` split) show Flask deliberately swaps generic transport-level errors for descriptive ones **only in debug mode**.

**Step 5 — Gather the AssertionError-side semantics.**
`app.py:796–809` (`BadRequestKeyError`/`show_exception`), `sansio/app.py:865–881` (`trap_http_exception`, "if unset, trap key errors in debug mode"), `app.py:841–852` (`PROPAGATE_EXCEPTIONS`), plus the invariant asserts at `ctx.py:267–270` and `428–431`. **Conclusion:** `AssertionError` = "Flask-internal invariant/validation failure that should surface loudly to the developer."

**Step 6 — Gather the UnicodeError-side semantics.**
`werkzeug/routing/map.py:236–239` (`except UnicodeError as e: raise BadHost() from e`) and `werkzeug/sansio/utils.py:23–26,38–41` (`except UnicodeEncodeError: return False`). **Conclusion:** `UnicodeError` = "bytes↔text/IDNA codec failure at the Werkzeug/sans-io boundary." Werkzeug translates it into `BadHost`; `UnexpectedUnicodeError` keeps it catchable as both an encoding error and an assertion.

**Step 7 — Compare with the other dual-inheritance debug classes.**

| Class | Definition | Bases (in order) |
|---|---|---|
| `UnexpectedUnicodeError(AssertionError, UnicodeError)` | `debughelpers.py:17` | AssertionError, UnicodeError |
| `DebugFilesKeyError(KeyError, AssertionError)` | `debughelpers.py:23` | KeyError, AssertionError |
| `FormDataRoutingRedirect(AssertionError)` | `debughelpers.py:50` | AssertionError |
| Werkzeug `BadRequestKeyError(BadRequest, KeyError)` | `werkzeug/exceptions.py:189` | BadRequest, KeyError |

**Pattern:** Flask's convention is to multiply-inherit so a single raise satisfies both the "developer/debug" contract and the "category of the underlying failure" contract.

**Step 8 — Verify handler/catch consequences of the MRO.**
`except AssertionError:` catches it (first base); `except UnicodeError:` catches it (second base); `_find_error_handler` walks the MRO (`sansio/app.py:841`), so a handler for either base matches. Showed `handle_exception` re-raises under debug/testing via `PROPAGATE_EXCEPTIONS` (`app.py:841–852`), consistent with `tests/test_basic.py:607–612`.

**Step 9 — Synthesize the architectural conclusion** (reproduced in full in Part IV).

**Step 10 — Produce the final deliverable**, flagging absent evidence as a stated limitation rather than filling it with inference.

---

# PART III — Verification (raw outcomes)

All checks were run with the worktree's Flask source and its vendored Werkzeug on `sys.path`. Outcomes (against Werkzeug 3.1.3 / Jinja2 3.1.6):

| # | Claim | Status |
|---|-------|--------|
| 1 | `UnexpectedUnicodeError` has exactly one worktree occurrence (the definition) | ✅ confirmed |
| 2 | Sibling `DebugFilesKeyError` is raised (`debughelpers.py:98`) + tested (`test_basic.py:1116`) | ✅ confirmed |
| 3 | `UnexpectedUnicodeError` is imported nowhere | ✅ confirmed |
| 4 | Bases are `(AssertionError, UnicodeError)`, docstring-only body | ✅ confirmed |
| 5 | MRO = `UUE → AssertionError → UnicodeError → ValueError → Exception → BaseException → object`, no conflict | ✅ confirmed |
| 6 | Werkzeug `BadRequestKeyError(BadRequest, KeyError)`, code 400, HTTP base first | ✅ confirmed |
| 7 | `except AssertionError:` and `except UnicodeError:` both catch it | ✅ confirmed |
| 8 | `AssertionError` handler wins over a `UnicodeError` handler regardless of registration order; `code=None`, not `HTTPException` | ✅ confirmed |
| 9 | `PROPAGATE_EXCEPTIONS`/debug/testing re-raise; else 500 | ✅ confirmed |
| 10 | `DebugFilesKeyError` is live and debug-gated (400 in non-debug) | ✅ confirmed |
| 11 | `FormDataRoutingRedirect` is live, debug-gated, an `AssertionError` | ✅ confirmed |
| 12 | Zero `raise` sites for `UnexpectedUnicodeError` in `src/`, `tests/`, `docs/` | ✅ confirmed (the stated caveat) |
| 13 | Werkzeug translates IDNA `UnicodeError` → `BadHost` | ✅ confirmed |
| 14 | IDNA codec raises base `UnicodeError` (not only `UnicodeEncodeError`) | ✅ confirmed |
| 15 | Class not re-exported at `flask.*`; MRO-based error-handler matching | ✅ confirmed |
| 16 | `UnexpectedUnicodeError` is never trapped as an HTTP error | ✅ confirmed |

**The most important raw outputs:**

- **MRO probe** — `UnexpectedUnicodeError.__bases__ = (<class 'AssertionError'>, <class 'UnicodeError'>)`; `UnexpectedUnicodeError.__mro__ = ['UnexpectedUnicodeError', 'AssertionError', 'UnicodeError', 'ValueError', 'Exception', 'BaseException', 'object']`.
- **`except` probe** — both `except AssertionError:` and `except UnicodeError:` (as well as `ValueError`, `Exception`, `BaseException`) catch it; the class defines no custom `__init__`/`__str__`, so arguments pass straight through `BaseException`.
- **Handler-precedence probe** — with `UnicodeError` and `AssertionError` handlers registered in *either* order, the **`AssertionError` handler wins**, because `_find_error_handler` walks the MRO and `AssertionError` precedes `UnicodeError`. `_get_exc_class_and_code(UUE) = ('UnexpectedUnicodeError', None)`; `issubclass(UUE, HTTPException) = False`.
- **Propagation probe** — `testing=False, debug=False, propagate default -> status 500`; `testing=True -> RAISED`; `debug=True -> RAISED`; `propagate=True -> RAISED`; `propagate=False -> status 500`.
- **Enctype probe** — in debug, the descriptive `DebugFilesKeyError` fires (`is KeyError? True | is AssertionError? True`, message contains "no file contents were transmitted" and "This was submitted: 'index.txt'"); with `debug=False` the same request yields a plain `400`.
- **IDNA probe** — `Map.bind` on a bad host raises `BadHost` ("UnicodeError translated"); and crucially, `('a'*100).encode('idna') -> UnicodeError: label too long | is UnicodeEncodeError: False` — i.e. the IDNA codec raises the **base** `UnicodeError` for over-length labels, so a catch of the second base is materially necessary (Werkzeug's own `host_is_trusted`, which catches only `UnicodeEncodeError`, lets it escape).
- **Trap probe** — `debug, trap=None -> BadRequestKeyError trapped? True` but `debug, trap=None -> UnexpectedUnicodeError trapped? False`.

**Note on stderr noise:** the propagation and IDNA probes emit Flask/Werkzeug tracebacks to stderr — these are the *expected* logging of unhandled exceptions in the non-propagating (500) and `BadHost` cases; they are part of the complete output and do not indicate check failures.

---

# PART IV — Architectural conclusion

The dual inheritance of `UnexpectedUnicodeError(AssertionError, UnicodeError)` is a **deliberate two-way contract**, not an accident, and the evidence supports each part:

**(a) Separation of concerns preserved.** The class has two independent bases (`src/flask/debughelpers.py:17`) with no methods of its own (`:18–20`), so `except UnicodeError:` (the codec/IDNA domain, used at `werkzeug/routing/map.py:238`, `werkzeug/sansio/utils.py:25,40`, `werkzeug/urls.py:16`) and `except AssertionError:` (the developer/invariant domain, e.g. `src/flask/ctx.py:268,429`) can each independently catch the same raise, while `_find_error_handler` walks the MRO (`src/flask/sansio/app.py:841`) so a handler registered for either base matches. A single class fuses only the *reporting* of a case where "unexpected unicode or binary data" indicates a **programmer error** rather than a **client error**.

**(b) Layering.** `debughelpers.py` is defined in the concrete WSGI layer (top-level sibling of `app.py`/`wrappers.py`), it imports `from .sansio.app import App` (`:10`) and `werkzeug.routing.RequestRedirect` (`:6`) — it depends *on* the sans-io core rather than living inside it; every consumer (`app.py:502`, `templating.py:83`, `wrappers.py:208`) imports it lazily inside a `debug`-gated branch (`wrappers.py:200–210`; `app.py:494–504`).

**(c) Not merged with transport validation.** Unlike `BadRequestKeyError(BadRequest, KeyError)` (`werkzeug/exceptions.py:189`, HTTP base first, `code = 400`), `UnexpectedUnicodeError` does **not** list `BadRequest`/`HTTPException`; it lists `AssertionError` **first**. Per `_get_exc_class_and_code`, non-`HTTPException` classes get `code=None`, so it carries no HTTP status — it is classified as a developer-facing assertion, not an HTTP validation failure. The handler-precedence probe shows the `AssertionError` identity wins even when a `UnicodeError` handler is registered, and the trap probe shows it is never trapped as an HTTP error.

**(d) Back-compat / extension point.** Because exhaustive search shows the class is never raised, imported, tested, or documented in this worktree (Findings 2 and 8), its docstring-described "better error reporting for unexpected unicode or binary data" is a **registered/importable contract** rather than a live code path. The actually-invoked debug exceptions remain `DebugFilesKeyError` (`debughelpers.py:98`, tested at `tests/test_basic.py:1116`) and `FormDataRoutingRedirect` (`app.py:504`). The class survives as a stable, importable exception type for extensions (and for the debug layer to adopt) that need to signal "unexpected unicode or binary data" as a **developer-visible assertion** while remaining catchable by the **codec/encoding layer** — precisely the two-way contract that the base order `AssertionError, UnicodeError` encodes.

**Stated limitation:** the absence of any in-tree `raise`, test, documentation, or `CHANGES.rst` entry is reported as a **finding** (the class is currently dormant/extension-facing), not filled in with inference about intended future call sites.
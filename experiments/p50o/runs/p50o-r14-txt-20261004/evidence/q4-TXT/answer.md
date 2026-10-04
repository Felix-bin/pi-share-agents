# Architectural decisions encoded by `UnexpectedUnicodeError(AssertionError, UnicodeError)`

## 0. Snapshot and scope (all claims below are tied to this tree)

Everything in this answer is derived from the Flask working tree at

`D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`

| Fact | Value | Source |
|---|---|---|
| HEAD (detached) | `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` | `.git/HEAD` (re-verified by executor: `git status --porcelain` before and after all probes = `?? flask_mut2_i417ar2x/` only) |
| Project version | `3.2.0.dev` | `pyproject.toml:2-3` |
| Python floor | `>=3.10` | `pyproject.toml:22` |
| Werkzeug | `3.1.3` | `uv.lock:1444-1447`; runtime `importlib.metadata` = `3.1.3` |
| Interpreter used for probes | CPython 3.13.9 (`.venv/Scripts/python.exe`) | `.venv/pyvenv.cfg` |
| Remote | `https://github.com/pallets/flask` | `.git/config` |
| Clone type | full (no `.git/shallow`, no `commondir`; all tags 0.1→3.1.3 present in `.git/packed-refs`) | `.git/` listing + `packed-refs` |

**Containment note (per `AGENTS.md §7` 真实性 / 只增不改):** this tree is experiment data. The executor wrote **no** source into it; probe sources live in `$TEMP/synapse-probe/` and raw transcripts in the sibling `experiments/data/flask-src-scratch/`. The pre-existing directory `flask_mut2_i417ar2x/` is an unrelated mutation artifact (`subdomain_matching` / `url_for` only — full file quoted in §9.4) and is **out of scope**; nothing about it is attributed to upstream Flask.

---

## 1. Fact block (tier: 已实现且已验证)

### 1.1 The declaration, verbatim

`src/flask/debughelpers.py:17-20` (re-read by me this session; grep confirms exactly one occurrence in `src/`):

```python
class UnexpectedUnicodeError(AssertionError, UnicodeError):
    """Raised in places where we want some better error reporting for
    unexpected unicode or binary data.
    """
```

Module member map (authoritative, from `grep '^class |^def'`):

| Line | Member |
|---|---|
| 17 | `class UnexpectedUnicodeError(AssertionError, UnicodeError):` |
| 23 | `class DebugFilesKeyError(KeyError, AssertionError):` |
| 50 | `class FormDataRoutingRedirect(AssertionError):` |
| 81 | `def attach_enctype_error_multidict(request: Request) -> None:` |
| 107 | `def _dump_loader_info(loader: BaseLoader) -> t.Iterator[str]:` |
| 124 | `def explain_template_loading_attempts(` |

The class body is **docstring only** — no `__init__`, no `__str__`, no class attributes. Runtime probe P3 confirms: `U.__dict__` non-dunder keys → `[]`; `U defines its own __init__` → `False`; `U defines its own __str__` → `False`.

### 1.2 It has exactly one occurrence tree-wide and zero call sites

```
$ git grep -n 'UnexpectedUnicodeError'
src/flask/debughelpers.py:17:class UnexpectedUnicodeError(AssertionError, UnicodeError):
```

```
$ grep -rn "UnexpectedUnicodeError" --include='*.py' --include='*.rst' . | wc -l
1
```

- Not re-exported: runtime probe P10 → `hasattr(flask, 'UnexpectedUnicodeError')` = `False`; `hasattr(flask.debughelpers, 'UnexpectedUnicodeError')` = `True`.
- **Zero `docs/` references:** `grep -rn "debughelpers\|UnexpectedUnicode\|FormDataRoutingRedirect\|DebugFilesKeyError" docs/` → exit 1, no matches.
- **Zero tests:** `tests/` has zero `UnexpectedUnicode` hits; case-insensitive `unicode` in `tests/` yields one unrelated hit, `tests/test_json.py:51: def test_json_as_unicode(...)` (an `ensure_ascii` parametrization, quoted in §9.3).
- **Zero changelog mentions:** the only two `Unicode` lines in `CHANGES.rst` are `CHANGES.rst:679` (unprintable Unicode in Host header → 400, Flask 1.1.0 / PR #2994) and `CHANGES.rst:826` (`send_file` `attachment_filename`), neither of which involves this class.
- **AST scan at runtime:** probe A8 → "AST raise-statements mentioning `UnexpectedUnicodeError`: NONE".

Counts of `debughelpers` references by scope (no contradiction between the retriever's "4" and the plan's "3" — they are different scopes):

```
$ for d in src tests docs; do grep -rn 'debughelpers' $d | wc -l; done
src    3
tests  1
docs   0
```
```
src/flask/app.py:502:        from .debughelpers import FormDataRoutingRedirect
src/flask/templating.py:83:        from .debughelpers import explain_template_loading_attempts
src/flask/wrappers.py:208:            from .debughelpers import attach_enctype_error_multidict
tests/test_basic.py:1108:    from flask.debughelpers import DebugFilesKeyError
```

### 1.3 History: it is a 2012 session-serializer artifact orphaned in 2017 (tier: 已实现且已验证 — via git history)

```
$ git log --all --oneline -S'UnexpectedUnicodeError'
5e1ced3c make session serializer extensible support serializing 1-item dicts with tag as key refactor serializer into flask.json.tag module continues #1452, closes #1438, closes #1908
2b885ce4 Added better error reporting for unicode errors in sessions

$ git log --all --format='%H %ad %an %s' --date=short -S'UnexpectedUnicodeError'
5e1ced3c055f7eb567bf7266c98de3d44ceea1b4 2017-06-01 David Lord make session serializer extensible …
2b885ce4dc3f6b2ea2707a39a8198a84d7ad3991 2012-10-30 Armin Ronacher Added better error reporting for unicode errors in sessions
```

**The creating commit and its only-ever raise site — `2b885ce4`, verbatim:**

```
commit 2b885ce4dc3f6b2ea2707a39a8198a84d7ad3991
Author: Armin Ronacher <armin.ronacher@active-4.com>
Date:   Tue Oct 30 14:47:17 2012 +0000

    Added better error reporting for unicode errors in sessions

diff --git a/flask/debughelpers.py b/flask/debughelpers.py
@@ -10,6 +10,12 @@
+class UnexpectedUnicodeError(AssertionError, UnicodeError):
+    """Raised in places where we want some better error reporting for
+    unexpected unicode or binary data.
+    """
+
diff --git a/flask/sessions.py b/flask/sessions.py
@@ -66,6 +66,14 @@ class TaggedJSONSerializer(object):
             elif isinstance(value, dict):
                 return dict((k, _tag(v)) for k, v in value.iteritems())
+            elif isinstance(value, str):
+                try:
+                    return unicode(value)
+                except UnicodeError:
+                    raise UnexpectedUnicodeError(u'A byte string with '
+                        u'non-ASCII data was passed to the session system '
+                        u'which can only store unicode strings.  Consider '
+                        u'base64 encoding your string (String was %r)' % value)
             return value
@@ -292,3 +300,6 @@ class SecureCookieSessionInterface(SessionInterface):
         response.set_cookie(app.session_cookie_name, val,
                             expires=expires, httponly=httponly,
                             domain=domain, path=path, secure=secure)
+
+from flask.debughelpers import UnexpectedUnicodeError
```

The historical raise site as it stood immediately before removal (`flask/sessions.py` pre-image of `5e1ced3c`):

```python
    def _tag_string(self, value):
        try:
            return text_type(value)
        except UnicodeError:
            from flask.debughelpers import UnexpectedUnicodeError
            raise UnexpectedUnicodeError(u'A byte string with '
                u'non-ASCII data was passed to the session system '
                u'which can only store unicode strings.  Consider '
                u'base64 encoding your string (String was %r)' % value)
```

**The orphaning commit — `5e1ced3c` (2017-06-01, David Lord)** deleted the whole inline `TaggedJSONSerializer` (including `_tag_string` and its local import) and replaced it with `flask/json/tag.py`, which has **no** unicode check:

```
$ git show 5e1ced3c:flask/json/tag.py | grep -n "UnexpectedUnicode\|UnicodeError\|decode\|encode"
1:from base64 import b64decode, b64encode
90:        return b64encode(value).decode('ascii')
93:        return b64decode(value)

$ git show 5e1ced3c:flask/debughelpers.py | grep -n "class UnexpectedUnicodeError"
20:class UnexpectedUnicodeError(AssertionError, UnicodeError):
```

Occurrence count per commit — decisive:

```
$ for c in 2b885ce4 5e1ced3c HEAD; do git grep -c 'UnexpectedUnicodeError' "$c" --; done
2b885ce4:flask/debughelpers.py:1
2b885ce4:flask/sessions.py:2        ← class + (raise + local import) = 3 occurrences
5e1ced3c:flask/debughelpers.py:1    ← orphaned: definition only
HEAD:src/flask/debughelpers.py:1    ← still orphaned, same count
```

`git log -L` shows the only change ever made to those four lines is `2b885ce4` (2012-10-30); later commits to `debughelpers.py` are unrelated (black reformat, `_compat` removal, type hints, 2019 "move to src directory" pure rename). The last commit touching the file is `6000e80acf931b05b4911c3fa7f3ba33e2c87c...` — actually `6000e80acf931b05b4911c3fa7f3ba33e2b80e64 2023-12-14 address mypy strict findings`. **No commit after 2017-06-01 references the class name.**

Runtime probe P9 confirms the original motivating condition is now handled upstream and no longer raises:

```
TaggedJSONSerializer tag keys: [' b', ' d', ' di', ' m', ' t', ' u']
  session with b'ÿþ' serialized OK, len = 66 prefix = eyJieXRlcyI6eyIgYiI6Ii8vND0ifX
[PASS] non-UTF8 bytes in session no longer raise (handled by tag ' b')
```

**Consequence for confidence tiering:** the fact that this is dead code is not "intent unverifiable in-tree" — it is documented dead code with a dated two-commit provenance chain. Everything the class *encodes* about Flask's layered architecture can therefore be read off (a) this declaration, (b) its two live siblings, (c) the live dispatch code, with history as corroboration — not from recollection of older Flask releases.

---

## 2. What the surrounding architecture actually is (evidence)

### 2.1 The two live siblings that use the same multiple-inheritance trick

`src/flask/debughelpers.py:23-79`, verbatim:

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

The asymmetry is the whole point and must be explained, not glossed: `DebugFilesKeyError` multiplies `KeyError` (source-layer type of a mapping lookup) × `AssertionError` (Flask's house programmer-error marker); `FormDataRoutingRedirect` needs only `AssertionError`; `UnexpectedUnicodeError` multiplies `UnicodeError` (source-layer type of a codec failure) × the same `AssertionError`.

### 2.2 The wired-in debug helper and its debug-only guard

`src/flask/debughelpers.py:81-105`, verbatim:

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

`src/flask/wrappers.py:197-219`, verbatim (this is the load-bearing pair):

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

Two facts to extract: (i) the debug layer swaps in a **subclass** (`class newcls(oldcls)`) and only under `current_app.debug`; (ii) Flask's own hook for undecodable data is typed on **`ValueError`** — the direct parent of `UnicodeError`. Flask does not override `get_json`, only this hook.

The third live debug substitution, `src/flask/app.py` (`def` at line 478; the import at 502), verbatim:

```python
    def raise_routing_exception(self, request: Request) -> t.NoReturn:
        """Intercept routing exceptions and possibly do something else.

        In debug mode, intercept a routing redirect and replace it with
        an error if the body will be discarded.

        With modern Werkzeug this shouldn't occur, since it now uses a
        308 status which tells the browser to resend the method and
        body.

        .. versionchanged:: 2.1
            Don't intercept 307 and 308 redirects.

        :meta private:
        :internal:
        """
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

### 2.3 The three dispatch tracks

`src/flask/app.py` (`handle_http_exception` at 744, `handle_user_exception` at 779, `handle_exception` at 811), verbatim:

```python
    def handle_http_exception(
        self, e: HTTPException
    ) -> HTTPException | ft.ResponseReturnValue:
        """Handles an HTTP exception.  By default this will invoke the
        registered error handlers and fall back to returning the
        exception as response.

        .. versionchanged:: 1.0.3
            ``RoutingException``, used internally for actions such as
             slash redirects during routing, is not passed to error
             handlers.

        .. versionchanged:: 1.0
            Exceptions are looked up by code *and* by MRO, so
            ``HTTPException`` subclasses can be handled with a catch-all
            handler for the base ``HTTPException``.

        .. versionadded:: 0.3
        """
        # Proxy exceptions don't have error codes.  We want to always return
        # those unchanged as errors
        if e.code is None:
            return e

        # RoutingExceptions are used internally to trigger routing
        # actions, such as slash redirects raising RequestRedirect. They
        # are not raised or handled in user code.
        if isinstance(e, RoutingException):
            return e

        handler = self._find_error_handler(e, request.blueprints)
        if handler is None:
            return e
        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]

    def handle_user_exception(
        self, e: Exception
    ) -> HTTPException | ft.ResponseReturnValue:
        """This method is called whenever an exception occurs that
        should be handled. A special case is :class:`~werkzeug
        .exceptions.HTTPException` which is forwarded to the
        :meth:`handle_http_exception` method. This function will either
        return a response value or reraise the exception with the same
        traceback.

        .. versionchanged:: 1.0
            Key errors raised from request data like ``form`` show the
            bad key in debug mode rather than a generic bad request
            message.

        .. versionadded:: 0.7
        """
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

        If an error handler is registered for ``InternalServerError`` or
        ``500``, it will be used. For consistency, the handler will
        always receive the ``InternalServerError``. The original
        unhandled exception is available as ``e.original_exception``.
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

`src/flask/sansio/app.py:823-845` and `src/flask/sansio/scaffold.py:657-698`, verbatim:

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
```

```python
    @staticmethod
    def _get_exc_class_and_code(
        exc_class_or_code: type[Exception] | int,
    ) -> tuple[type[Exception], int | None]:
        """Get the exception class being handled. For HTTP status codes
        or ``HTTPException`` subclasses, return both the exception and
        status code.

        :param exc_class_or_code: Any exception class, or an HTTP status
            code as an integer.
        """
        exc_class: type[Exception]

        if isinstance(exc_class_or_code, int):
            try:
                exc_class = default_exceptions[exc_class_or_code]
            except KeyError:
                raise ValueError(
                    f"'{exc_class_or_code}' is not a recognized HTTP"
                    " error code. Use a subclass of HTTPException with"
                    " that code instead."
                ) from None
        else:
            exc_class = exc_class_or_code

        if isinstance(exc_class, Exception):
            raise TypeError(
                f"{exc_class!r} is an instance, not a class. Handlers"
                " can only be registered for Exception classes or HTTP"
                " error codes."
            )

        if not issubclass(exc_class, Exception):
            raise ValueError(
                f"'{exc_class.__name__}' is not a subclass of Exception."
                " Handlers can only be registered for Exception classes"
                " or HTTP error codes."
            )

        if issubclass(exc_class, HTTPException):
            return exc_class, exc_class.code
        else:
            return exc_class, None
```

`src/flask/sansio/scaffold.py:110-127` documents the `code` axis verbatim:

```python
        #: A data structure of registered error handlers, in the format
        #: ``{scope: {code: {class: handler}}}``. The ``scope`` key is
        #: the name of a blueprint the handlers are active for, or
        #: ``None`` for all requests. The ``code`` key is the HTTP
        #: status code for ``HTTPException``, or ``None`` for
        #: other exceptions. The innermost dictionary maps exception
        #: classes to handler functions.
        ...
        self.error_handler_spec: dict[
            ft.AppOrBlueprintKey,
            dict[int | None, dict[type[Exception], ft.ErrorHandlerCallable]],
        ] = defaultdict(lambda: defaultdict(dict))
```

`src/flask/sansio/app.py:848-880`, verbatim:

```python
    def trap_http_exception(self, e: Exception) -> bool:
        """Checks if an HTTP exception should be trapped or not.  By default
        this will return ``False`` for all exceptions except for a bad request
        key error if ``TRAP_BAD_REQUEST_ERRORS`` is set to ``True``.  It
        also returns ``True`` if ``TRAP_HTTP_EXCEPTIONS`` is set to ``True``.
        ...
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

Config defaults (`src/flask/app.py:175-208`): `"TRAP_BAD_REQUEST_ERRORS": None`, `"TRAP_HTTP_EXCEPTIONS": False`. `testing = ConfigAttribute[bool]("TESTING")` is at **`src/flask/sansio/app.py:208`** (not `app.py` — a wrong line-attribution in the retriever's evidence; corrected below), and the `debug` property getter/setter is at **`src/flask/sansio/app.py:550` / `:563`**.

### 2.4 The documented 400/500 taxonomy

`docs/errorhandling.rst`, verbatim excerpts:

```rst
When an error occurs in Flask, an appropriate `HTTP status code
<https://developer.mozilla.org/en-US/docs/Web/HTTP/Status>`__ will be
returned. 400-499 indicate errors with the client's request data, or
about the data requested. 500-599 indicate errors with the server or
application itself.
```

```rst
When Flask catches an exception while handling a request, it is first looked up by code.
If no handler is registered for the code, Flask looks up the error by its class hierarchy; the most specific handler is chosen.
If no handler is registered, :class:`~werkzeug.exceptions.HTTPException` subclasses show a
generic message about their code, while other exceptions are converted to a
generic "500 Internal Server Error".
```

```rst
When there is no error handler registered for an exception, a 500
Internal Server Error will be returned instead. See
:meth:`flask.Flask.handle_exception` for information about this
behavior.
```

And the user-facing consequence for 500-class errors, `src/flask/app.py:669-703` (`test_client` docstring):

```
        Note that if you are testing for assertions or exceptions in your
        application code, you must set ``app.testing = True`` in order for the
        exceptions to propagate to the test client.  Otherwise, the exception
        will be handled by the application (not visible to the test client) and
        the only indication of an AssertionError or other exception will be a
        500 status code response to the test client.
```

### 2.5 The `AssertionError` house convention, census in `src/flask`

| Site | Line | Kind |
|---|---|---|
| `debughelpers.py` | 17 | `class UnexpectedUnicodeError(AssertionError, UnicodeError)` |
| `debughelpers.py` | 23 | `class DebugFilesKeyError(KeyError, AssertionError)` |
| `debughelpers.py` | 50 | `class FormDataRoutingRedirect(AssertionError)` |
| `ctx.py` | 268 | `raise AssertionError(f"Popped wrong app context. …")` |
| `ctx.py` | 429 | `raise AssertionError(f"Popped wrong request context. …")` |
| `sansio/app.py` | 415 | setup-after-first-request |
| `sansio/app.py` | 657 | view-func-overwrite |
| `sansio/blueprints.py` | 215 | setup-after-registration (blueprint) |
| `views.py` | 190 | `assert meth is not None, f"Unimplemented method {request.method!r}"` |
| `sansio/scaffold.py` | 705 | `assert view_func is not None, …` |

Representative, `src/flask/sansio/app.py:413-423`:

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

This is test-enforced: `tests/test_basic.py:1678-1691` (`test_no_setup_after_first_request`) and `tests/test_basic.py:1693-1712` (`test_routing_redirect_debugging`) both assert `pytest.raises(AssertionError)`; `tests/test_basic.py:606-611` documents that an `AssertionError` reaching the test client without `app.testing` becomes a 500.

### 2.6 The encoding boundary actually lives in Werkzeug and is typed on `ValueError`

Werkzeug 3.1.3 source was retrieved from `.venv/Lib/site-packages/werkzeug/wrappers/request.py:576-650`, verbatim:

```python
    def get_json(
        self, force: bool = False, silent: bool = False, cache: bool = True
    ) -> t.Any | None:
        """Parse :attr:`data` as JSON.
        ...
        """
        if cache and self._cached_json[silent] is not Ellipsis:
            return self._cached_json[silent]

        if not (force or self.is_json):
            if not silent:
                return self.on_json_loading_failed(None)
            else:
                return None

        data = self.get_data(cache=cache)

        try:
            rv = self.json_module.loads(data)
        except ValueError as e:
            if silent:
                rv = None

                if cache:
                    normal_rv, _ = self._cached_json
                    self._cached_json = (normal_rv, rv)
            else:
                rv = self.on_json_loading_failed(e)

                if cache:
                    _, silent_rv = self._cached_json
                    self._cached_json = (rv, silent_rv)
        else:
            if cache:
                self._cached_json = (rv, rv)

        return rv

    def on_json_loading_failed(self, e: ValueError | None) -> t.Any:
        """Called if :meth:`get_json` fails and isn't silenced.

        If this method returns a value, it is used as the return value
        for :meth:`get_json`. The default implementation raises
        :exc:`~werkzeug.exceptions.BadRequest`.

        :param e: If parsing failed, this is the exception. It will be
            ``None`` if the content type wasn't ``application/json``.

        .. versionchanged:: 2.3
            Raise a 415 error instead of 400.
        """
        if e is not None:
            raise BadRequest(f"Failed to decode JSON object: {e}")

        raise UnsupportedMediaType(
            "Did not attempt to load JSON data because the request"
            " Content-Type was not 'application/json'."
        )
```

Runtime confirmation of the signature and of the resulting HTTP status (probe A6):

```
$ .venv/Scripts/python.exe -c "import inspect, werkzeug.wrappers.request as wrq;
                               print(inspect.signature(wrq.Request.on_json_loading_failed))"
    (self, e: 'ValueError | None') -> 't.Any'
```
```
A6  NUANCE PROBE 2: a real codec failure DOES become 400 - but via BadRequest,
    NOT via UnexpectedUnicodeError
  invalid-UTF8 JSON body -> status 400
  body[:120px] = b'<!doctype html>\n<html lang=en>\n<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n<p>The browser (or proxy) sent a requ'
```

Werkzeug's exception layer has **no encoding type at all**: `grep 'Unicode|ValueError|decode|encode'` over `werkzeug/exceptions.py` → no matches; `grep 'Unicode|decode(|UnicodeDecodeError'` over `werkzeug/routing/` → no matches. Werkzeug's `HTTPException` is defined at `werkzeug/exceptions.py:67` with `code: int | None = None` (line 76), `BadRequest` at 175-187 (`code = 400`), `InternalServerError` at 724-751 (`code = 500`, `original_exception`). Notably `BadRequestKeyError(BadRequest, KeyError)` at 189-220 is the mirror-image trick to `DebugFilesKeyError` — a Werkzeug-level dual-inheritance for exactly the same "keep both audiences' `except` working" reason, described in its own docstring as *"An exception that is used to signal both a :exc:`KeyError` and a :exc:`BadRequest`."*

Flask itself contains **exactly one** `.decode(` call site in `src/flask`: `src/flask/json/tag.py:167: return b64encode(value).decode("ascii")`. No `.encode(`. So the codec boundary the class name refers to is not in Flask's own source in this snapshot.

---

## 3. Runtime verification of the type and dispatch semantics (tier: 已实现且已验证)

Executor probe `$TEMP/synapse-probe/probe_unicode.py`, run on `.venv/Scripts/python.exe` (CPython 3.13.9). Complete summary table from the raw transcript:

```
========================================================================
P1  MRO and identity
========================================================================
U.__mro__ =
   [0] flask.debughelpers.UnexpectedUnicodeError
   [1] builtins.AssertionError
   [2] builtins.UnicodeError
   [3] builtins.ValueError
   [4] builtins.Exception
   [5] builtins.BaseException
   [6] builtins.object
[PASS] AssertionError precedes UnicodeError in MRO
[PASS] full MRO matches E9 analytic order
U.__module__   = flask.debughelpers
U.__name__     = UnexpectedUnicodeError
U.__doc__      = 'Raised in places where we want some better error reporting for\nunexpected unicode or binary data.\n'
U.__bases__    = (<class 'AssertionError'>, <class 'UnicodeError'>)

========================================================================
P2  issubclass matrix
========================================================================
[PASS] issubclass(U, AssertionError)          got = True
[PASS] issubclass(U, UnicodeError)            got = True
[PASS] issubclass(U, UnicodeDecodeError)      got = False
[PASS] issubclass(U, UnicodeEncodeError)      got = False
[PASS] issubclass(U, ValueError)              got = True
[PASS] issubclass(U, Exception)               got = True
[PASS] issubclass(U, KeyError)                got = False
[PASS] issubclass(U, TypeError)               got = False
[PASS] issubclass(U, HTTPException (werkzeug)) got = False
[PASS] issubclass(U, BadRequest)              got = False
[PASS] issubclass(U, InternalServerError)     got = False
NOTE UnicodeDecodeError/UnicodeEncodeError are subclasses of UnicodeError, NOT of U

========================================================================
P3  instance attributes / 'code' axis
========================================================================
U('bad bytes')            -> UnexpectedUnicodeError('bad bytes')
str(inst)                 -> 'bad bytes'
[PASS] hasattr(U('x'), 'code')                      got = False
[PASS] hasattr(U('x'), 'description')               got = False
[PASS] U defines its own __init__                   got = False
[PASS] U defines its own __str__                    got = False
U.__dict__ non-dunder keys -> []

========================================================================
P4  _get_exc_class_and_code dispatch classification
========================================================================
Scaffold._get_exc_class_and_code(U) = (<class 'flask.debughelpers.UnexpectedUnicodeError'>, None)
Scaffold._get_exc_class_and_code(BadRequest) = (<class 'werkzeug.exceptions.BadRequest'>, 400)

========================================================================
P5  error-handler registration buckets + which handler wins
========================================================================
  error_handler_spec[None][None] -> {'UnicodeError': '<lambda>', 'ValueError': '<lambda>', 'AssertionError': '<lambda>'}
  combined-registration probe -> status: 200  data: b'handled-by-AssertionError'
[PASS] all three handlers registered -> MRO-first (AssertionError) wins

========================================================================
P6  per-handler isolation: only ONE handler registered at a time
========================================================================
  only @app.errorhandler(AssertionError) -> status=200 data=b'handled-by-AssertionError'
  only @app.errorhandler(UnicodeError  ) -> status=200 data=b'handled-by-UnicodeError'
  only @app.errorhandler(ValueError    ) -> status=200 data=b'handled-by-ValueError'
  no handler at all                      -> status=500 data=b'<!doctype html>...500 Internal Server Er'

========================================================================
P7  500-vs-propagate
========================================================================
  defaults: DEBUG=False TESTING=False PROPAGATE_EXCEPTIONS=None
  TESTING=False defaults -> 500
  TESTING=True -> raised: flask.debughelpers.UnexpectedUnicodeError 'bad bytes'
  DEBUG=True -> raised: flask.debughelpers.UnexpectedUnicodeError
  DEBUG=True + PROPAGATE_EXCEPTIONS=False -> status= 500
  handler saw: {'type': 'InternalServerError', 'orig': 'UnexpectedUnicodeError', 'orig_is_U': True}  status: 500  data: b'custom-500'
[PASS] 500 handler receives InternalServerError
[PASS] 500 handler's e.original_exception is the UnexpectedUnicodeError

========================================================================
P8  ordered except-clause behaviour (MRO order vs clause order)
========================================================================
  except UnicodeError     then except AssertionError   -> UnicodeError
  except AssertionError   then except UnicodeError     -> AssertionError
  except ValueError       then except AssertionError   -> ValueError
  except UnicodeError     then except ValueError       -> UnicodeError
  bare `except UnicodeError` catches U      -> 'UnexpectedUnicodeError'
  bare `except ValueError` catches U        -> 'UnexpectedUnicodeError'
  bare `except AssertionError` catches U    -> 'UnexpectedUnicodeError'
  bare `except Exception` catches U         -> 'UnexpectedUnicodeError'
  `except (KeyError, TypeError, UnicodeDecodeError)` does NOT catch U
       -> 'fell-through-to-Exception:UnexpectedUnicodeError'

========================================================================
P9  is the ORIGINAL 2012 session use-case still reachable?
========================================================================
  session with b'ÿþ' serialized OK, len = 66 prefix = eyJieXRlcyI6eyIgYiI6Ii8vND0ifX
[PASS] non-UTF8 bytes in session no longer raise (handled by tag ' b')

========================================================================
P10 U is NOT re-exported from the flask top-level namespace
========================================================================
[PASS] hasattr(flask, 'UnexpectedUnicodeError')             got = False
[PASS] hasattr(flask.debughelpers, 'UnexpectedUnicodeError') got = True

total checks: 54   PASS: 53   FAIL: 0
PROBE_EXIT 0
```

Key derived runtime facts:

1. **MRO is exactly** `UnexpectedUnicodeError → AssertionError → UnicodeError → ValueError → Exception → BaseException → object`. `AssertionError` precedes `UnicodeError`.
2. **`_get_exc_class_and_code(U)` returns `(U, None)`** — so the `code is not None` bucket, i.e. the validation/HTTP-code path, is *never* consulted for this class.
3. **Handler selection is MRO-order over the registered class map**, and with `UnicodeError`, `ValueError` *and* `AssertionError` all registered, **`AssertionError` wins** (it is first in the MRO).
4. **`except`-clause order, not MRO order, decides between two matching handlers**: `except (UnicodeError, AssertionError)` picks `UnicodeError`; `except (AssertionError, UnicodeError)` picks `AssertionError`.
5. **`except (KeyError, TypeError, UnicodeDecodeError)` does NOT catch it** — `UnicodeDecodeError` is a *sibling* under `UnicodeError`, not a base of this class.
6. **Unhandled → 500**, with `PROPAGATE_EXCEPTIONS` defaulting from `self.testing or self.debug`; the 500 handler receives an `InternalServerError` whose `e.original_exception` *is* the `UnexpectedUnicodeError` instance (also re-confirmed by probes A2/A4).

Full suite, two runs, both `489 passed`, on the configured suite (`pyproject.toml: testpaths = ["tests"]`):

```
============================= 489 passed in 4.37s =============================
============================= 489 passed in 4.28s =============================    (pytest tests/ -vv -rA --tb=long --durations=0)
```

and a focused run over the question-relevant files: `218 passed in 1.74s`. The `examples/` suites error out with `ModuleNotFoundError` because those are separate example apps needing their own installs — not part of the configured suite.

---

## 4. The architectural decisions

The question asks what the dual inheritance *reflects* about how Flask separates validation failures from encoding issues. Five decisions are visible. Each is stated with its evidence and, per `AGENTS.md §7`, one of the four tiers.

### Decision 1 — The debug layer is diagnostic-only and **type-preserving**: it may re-word an error, but it must not change what the surrounding layers catch. (Tier: 已实现且已验证)

The evidence is three live mechanisms, all of which preserve the source-layer type while adding Flask's marker:

- `DebugFilesKeyError(KeyError, AssertionError)` keeps `except KeyError` working for any caller of `request.files[key]`, while the second base makes the error an `AssertionError` so it is treated as a programmer error rather than silently converted into a generic 400. The swap is installed as a **subclass** and only under debug:
  ```python
  class newcls(oldcls):                      # subclass, not a replacement
      def __getitem__(self, key: str) -> t.Any:
          try:
              return super().__getitem__(key)
          except KeyError as e:
              if key not in request.form:
                  raise
              raise DebugFilesKeyError(request, key).with_traceback(e.__traceback__) from None
  ```
  guarded by `current_app and current_app.debug and self.mimetype != "multipart/form-data" and not self.files` in `wrappers.py::_load_form_data`.
- `raise_routing_exception` substitutes `FormDataRoutingRedirect` **only** in debug mode and otherwise re-raises the pristine routing exception (`raise request.routing_exception`).
- `on_json_loading_failed` only *re-raises* the original `BadRequest` in debug and otherwise re-wraps it (`raise BadRequest() from ebr`) — it never changes the class the caller sees.

This is why `UnexpectedUnicodeError`'s first dubiously-looking base is safe: making the object also an `AssertionError` cannot widen or narrow any existing `except UnicodeError` handler in application or Werkzeug code, because `UnicodeError` is *retained* in the MRO. The design rule is "add a classification, don't replace one."

### Decision 2 — Multiple inheritance encodes **two different layers' classifications of one event**. (Tier: 已实现且已验证 for the mechanism; 推断 for the motives)

The pattern is systematic in this module:

| Class | Base 1 (source layer) | Base 2 (Flask house) |
|---|---|---|
| `UnexpectedUnicodeError` | `UnicodeError` — "the codec/data layer reported an encoding failure" | `AssertionError` — "Flask classifies this as an unexpected internal state" |
| `DebugFilesKeyError` | `KeyError` — "a dict lookup missed" | `AssertionError` (same marker) |
| `FormDataRoutingRedirect` | *(none)* | `AssertionError` |

Reading `UnexpectedUnicodeError` against that table, the declaration says: *the data/codec layer reports an encoding problem, and Flask classifies it as an unexpected internal state, not as bad client input.* The word **"Unexpected"** in the class name is the load-bearing word — it is the counterpart of `errorhandling.rst`'s "other exceptions are converted to a generic 500 Internal Server Error", not of its "400-499 indicate errors with the client's request data."

The reason `FormDataRoutingRedirect` needs only **one** base is directly visible in `handle_http_exception`:

```python
        # RoutingExceptions are used internally to trigger routing
        # actions, such as slash redirects raising RequestRedirect. They
        # are not raised or handled in user code.
        if isinstance(e, RoutingException):
            return e
```

Its source exception never surfaces to user code, so there is no second audience whose `except` clause has to keep working. `UnexpectedUnicodeError`, by contrast, is *meant* to be caught by codec-aware code — hence the second base is free but the first base is required.

### Decision 3 — Validation failures and encoding issues sit on **different dispatch tracks**, and the absence of a `code` is the switch. (Tier: 已实现且已验证, with one over-claim trimmed)

The dispatch model is: `handle_user_exception` → if `isinstance(e, HTTPException) and not trap_http_exception(e)` → `handle_http_exception`; else class-MRO handler lookup; else `raise` to `handle_exception` → 500. `_find_error_handler` keys on `code` first, and only if a code exists:

```python
        for c in (code, None) if code is not None else (None,):
```

`_get_exc_class_and_code` returns `(exc_class, exc_class.code)` **only** for `HTTPException` subclasses, else `(exc_class, None)`. Runtime probe P4: `Scaffold._get_exc_class_and_code(U)` = `(UnexpectedUnicodeError, None)`, while `BadRequest` → `(BadRequest, 400)`.

Consequences, each runtime-verified:

- `UnexpectedUnicodeError` is **not** an `HTTPException` (`issubclass(U, HTTPException) = False`), has **no** `.code` (`hasattr(U('x'), 'code') = False`) and no `.description`. So Flask's automatic classification can never place it in the 4xx/validation bucket, and its registered handlers can only live in the `error_handler_spec[scope][None]` class bucket.
- Unhandled, it goes to `handle_exception` → `InternalServerError(original_exception=e)` → **500**, or is re-raised under `PROPAGATE_EXCEPTIONS` (which defaults to `self.testing or self.debug`). Observed: `TESTING=False` → 500; `TESTING=True` → propagates `UnexpectedUnicodeError`; `DEBUG=True` → propagates; `DEBUG=True + PROPAGATE_EXCEPTIONS=False` → 500; the 500 handler receives `InternalServerError` with `e.original_exception` = the `UnexpectedUnicodeError`.
- A user *can* still force a 4xx by registering a class-MRO handler (`@app.errorhandler(Exception)` returning `("bad request", 400)` → **400**, probe A5). So the precise statement is: **Flask's automatic/unhandled classification for this class is 500-class, and the validation/code track is unreachable for it** — not "it can never be mapped to a 4xx" in the universal sense. Any handler can override any exception's status; that is a property of the handler API, not of this class.

And — the nuance that strengthens rather than weakens the separation — **real codec failures from client data do reach the client as 400**, but *not* through this class: Werkzeug's `get_json` wraps `json_module.loads(bytes)` in `except ValueError as e:` (line 612) and calls `on_json_loading_failed(e)`, which raises `BadRequest(f"Failed to decode JSON object: {e}")` (400). Runtime probe A6: invalid-UTF8 JSON body → **status 400**, body `<title>400 Bad Request</title><h1>Bad Request</h1>`. So the architecture is:

| Event | Recognition point | Type | Track | Client outcome |
|---|---|---|---|---|
| Client sent undecodable bytes in a JSON body | Werkzeug `get_json` / `formparser` | `ValueError` (→ `BadRequest`) | validation / `HTTPException` | **400** |
| Server met bytes where text was expected (an invariant fault) | Flask debug layer, historically the session serializer | `UnexpectedUnicodeError(AssertionError, UnicodeError)` | class-MRO / 500 | **500** (or propagate in debug) |

That is exactly the validation-vs-encoding separation the question asks about: *"the request is bad"* is a `HTTPException` with a code; *"we violated our own text invariant"* is not.

### Decision 4 — Encoding issues are recognized through the **`ValueError` family**, and the dual base keeps that contract public while adding the debug-mode one. (Tier: 已实现且已验证)

`UnicodeError` is a subclass of `ValueError`, and Flask's own undecodable-data boundary hook is typed on it:

```python
    def on_json_loading_failed(self, e: ValueError | None) -> t.Any:
```

as is Werkzeug's: `(self, e: 'ValueError | None') -> 't.Any'` (runtime-verified). Because `UnicodeError → ValueError` is in `UnexpectedUnicodeError`'s MRO, at least four `except` styles keep working on one and the same object (runtime probe P8):

```
bare `except UnicodeError` catches U      -> 'UnexpectedUnicodeError'
bare `except ValueError` catches U        -> 'UnexpectedUnicodeError'
bare `except AssertionError` catches U    -> 'UnexpectedUnicodeError'
bare `except Exception` catches U         -> 'UnexpectedUnicodeError'
```

So the class satisfies **two audiences with one object, no re-classification and no wrap/unwrap**: a codec-aware `except ValueError` / `except UnicodeError` at app or library level behaves as if a normal codec error occurred, while debug-mode tooling and test assertions (`pytest.raises(AssertionError)`, the convention test-enforced in `tests/test_basic.py`) see Flask's programmer-error marker. `except UnicodeDecodeError` alone does **not** catch it, because `UnicodeDecodeError` is a sibling under `UnicodeError`, not a base — a genuine subtlety, and the practical argument for inheriting `UnicodeError` rather than a concrete codec-error subclass.

Because the base list is `(AssertionError, UnicodeError)`, handler selection inside Flask is MRO-ordered, so a handler registered for `AssertionError` beats one registered for `UnicodeError` or `ValueError` when all are present (probe P5: `handled-by-AssertionError`); and in a flat `except (A, B)` clause, **clause order** decides rather than MRO order (probe P8). The base ordering is therefore not cosmetic.

### Decision 5 — The split is what makes the dual base **necessary rather than merely tidy**; it is grounded in the class's actual 2012 history. (Tier: 已实现且已验证 for the history and for the topology; 推断 for the counterfactual)

The class was created on **2012-10-30 (2b885ce4, Armin Ronacher)** precisely at a codec boundary, in the session serializer:

```python
            elif isinstance(value, str):
                try:
                    return unicode(value)
                except UnicodeError:
                    raise UnexpectedUnicodeError(u'A byte string with '
                        u'non-ASCII data was passed to the session system '
                        u'which can only store unicode strings.  Consider '
                        u'base64 encoding your string (String was %r)' % value)
```

Read against Flask's dispatch model, that single raise expresses exactly the architectural distinction:

- The **trigger** is a codec failure inside `try/except UnicodeError` — so `UnicodeError` is the *true* source-layer type; anybody writing an `except UnicodeError:` around session tagging keeps working.
- The **condition** is *not* bad client input — a `str` with non-ASCII bytes was handed to the session *by server code* — so it must **not** be classified as a validation failure. It is an application invariant violation. Hence `AssertionError`, Flask's house marker for "you did something a program shouldn't do" (same marker as `_check_setup_finished`, `Popped wrong app context`, `view function mapping is overwriting`).
- Consequence: 500-class, not 400-class. Had it been an `HTTPException` (say `BadRequest(code=400)`-flavored), a server-side encoding bug would have been laundered into a client-facing 400 — the exact inversion the class is built to prevent.

`DebugFilesKeyError` is the mirror case and makes the rule sharp: there the source layer's condition *is* client-caused (a missing file part, a wrong `enctype`), and Flask still marks it with `AssertionError`, because the debug helper's chosen audience is the developer — but the key distinction is that its second base is `KeyError` (the type `request.files[key]` callers catch), never `BadRequest`. Flask keeps the *classification of whose fault it is* in the exception type, and Werkzeug's parallel `BadRequestKeyError(BadRequest, KeyError)` does the same dance one layer down. This class sits at the boundary where "source-layer codec failure" and "Flask programmer-error" must coexist, and that coexistence is the reason a single base would have been wrong.

**Corollary (tier: 已实现且已验证 via history):** the class is now vestigial. Its only caller was deleted on **2017-06-01 (5e1ced3c, David Lord)** when `TaggedJSONSerializer` moved into `flask/json/tag.py` with no unicode check, and the motivating condition no longer raises at all (`session with b'ÿþ' serialized OK … handled by tag ' b'`, probe P9). So in this snapshot the architecture *demonstrated* by the class is a settled design convention visible in its live siblings, not a live code path. Its `__init__`-free body means the docstring's promise of "better error reporting" is unrealized here — the sibling classes carry the actual message-building code.

---

## 5. What the question's premise gets right and wrong

- **Right:** there *is* a debug-mode exception class for unexpected unicode/binary data, and it *is* multiply inherited from `AssertionError` and `UnicodeError`, and Flask's architecture *does* separate validation failures from encoding issues.
- **Wrong / overstated:** in this snapshot the class is dead code — one occurrence, no call sites, no tests, no docs, no changelog entry, not re-exported from `flask`. Any statement of the form "Flask raises `UnexpectedUnicodeError` when …" is false for Flask `3.2.0.dev` @ `85c5d93`. Real client-supplied undecodable data is handled by Werkzeug's `ValueError`-typed boundary → `BadRequest` → **400**, *not* by this class.
- **Therefore** the architectural decisions it "reflects" must be read off its declaration, its two live siblings (`DebugFilesKeyError`, `FormDataRoutingRedirect`), the live dispatch code (`handle_http_exception` / `handle_user_exception` / `handle_exception` / `_get_exc_class_and_code` / `_find_error_handler`), the documented 400/500 taxonomy, and its own 2012 provenance — which is what §4 does.

---

## 6. Caveats that must not be omitted

1. **No custom reporting code.** `UnexpectedUnicodeError` defines **no** `__init__` and **no** `__str__` (unlike both siblings): `U.__dict__` non-dunder keys = `[]`. The docstring's "better error reporting" is unrealized in this snapshot — `str(U('bad bytes'))` is just `'bad bytes'`.
2. **Undocumented internals.** `debughelpers` is absent from `docs/` (0 matches for `debughelpers|UnexpectedUnicode|FormDataRoutingRedirect|DebugFilesKeyError`), so none of these semantics are a public-API contract. `docs/` also has 0 prose hits for `encoding|UTF-8|utf-8` — the encoding boundary is undocumented.
3. **Not re-exported.** `hasattr(flask, 'UnexpectedUnicodeError')` = `False`; it is reachable only as `flask.debughelpers.UnexpectedUnicodeError`.
4. **Version-scoped.** These findings are true for Flask `3.2.0.dev` @ `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` with Werkzeug `3.1.3`. `on_json_loading_failed` internals and `DebugFilesKeyError` behavior differ in released versions; do not generalize.
5. **Handler override.** "Unreachable from the 4xx/validation track" means *Flask's automatic classification is 500-class*. A user handler registered for `Exception` (or any base of this class) can return any status, including 4xx — probe A5 produced 400. The claim concerns the dispatch model, not the impossibility of a user override.
6. **Mutant artifact excluded.** `flask_mut2_i417ar2x/mutated_test.py` is a `subdomain_matching`/`url_for` mutation-testing artifact unrelated to unicode/binary handling and is not evidence of upstream Flask behavior.
7. **Tier labels** (per `AGENTS.md §7` 真实性 red line): the definition, the absence of call sites, the 2012→2017 provenance, the MRO, the `_get_exc_class_and_code` result, the 500-vs-propagate behavior, the `except`-clause behavior, and the Werkzeug 400 boundary are all **已实现且已验证** (source + runtime + history). The *interpretive* statements — that the dual base is "necessary rather than merely tidy", and the counterfactual that an `HTTPException`-flavored version would have laundered a server bug into a 400 — are **推断**, grounded in the dated history and the live sibling/dipatch evidence, and are labeled as such in Decision 5.

---

## 7. Corrections applied to the inherited evidence (so the answer is not built on wrong addresses)

| # | Inherited claim | Verified reality |
|---|---|---|
| C1 | `testing = ConfigAttribute[bool]("TESTING")` at `src/flask/app.py:198-208` | It is at **`src/flask/sansio/app.py:208`**. `app.py:198-208` holds the `TRAP_*`/cookie defaults (those *are* correct, at `app.py:202-203`). |
| C2 | `debug` property at `src/flask/app.py:550-564` | Getter at **`src/flask/sansio/app.py:550`**, setter at **`:563`**. `src/flask/app.py:550` is a `debug: bool | None = None,` kwarg of `run()` — the likely source of the mix-up. |
| C3 | `raise_routing_exception` at `src/flask/app.py:493-518` | `def` is at **`src/flask/app.py:478`**; the `from .debughelpers import FormDataRoutingRedirect` is at **502** (that address was right). |
| C4 | "three live imports" vs "4 references" | Both correct, different scopes: **3** in `src/` (502 / 83 / 208) + **1** in `tests/test_basic.py:1108`, **0** in `docs/`. |
| C5 | Step 2 unknown ⇒ Decision 5 would be 推断 | **Resolved**: 2b885ce4 (2012-10-30) added it for the session serializer; 5e1ced3c (2017-06-01) removed its only caller. Dead since 2017-06-01; Decision 5's history is **已实现且已验证**. |
| C6 | tests census | Case-sensitive `Unicode` = 0 hits in `tests/`; case-insensitive = 1 unrelated hit, `tests/test_json.py:51`. |
| C7 | Line numbers that check out | `debughelpers.py` 17/23/50/81/107/124; `wrappers.py` 197/212; `app.py` 669/744/779/811; `sansio/app.py` 413/823/848; `sansio/scaffold.py` 123/642/657; `docs/errorhandling.rst` 80-81 and 158-162. |

Two over-claims trimmed (N1, N2 in §4 Decision 3): the "can never be mapped to a 4xx" wording, and any suggestion that `UnexpectedUnicodeError` is the encoding-error channel — it is not, and the client-facing 400 for undecodable JSON comes from Werkzeug's `BadRequest`, not from this class.

---

## 8. Bottom line

`class UnexpectedUnicodeError(AssertionError, UnicodeError)` reflects four settled architectural decisions in Flask's layered architecture, and one historical one:

1. **Failures carry their source layer's type and Flask's classification simultaneously** — the debug layer may re-word an error but must not change what surrounding layers catch (`DebugFilesKeyError(KeyError, AssertionError)` proves it with a live subclass swap; `raise_routing_exception` proves it by re-raising the pristine exception outside debug).
2. **Multiple inheritance is how Flask says "this event is two things at once."** `UnicodeError` = the data/codec layer reported an encoding problem; `AssertionError` = Flask classifies it as an unexpected internal state, i.e. *not* bad client input. `FormDataRoutingRedirect` needs one base only because its source exception never reaches user code.
3. **Validation failures and encoding issues run on different dispatch tracks**, switched by the presence of a `code`: `HTTPException` + `code` → `handle_http_exception` → 4xx; no `code` → class-MRO handler bucket → else `InternalServerError` → 500 (or propagate in debug). `_get_exc_class_and_code(U)` = `(U, None)`, so the validation track is unreachable automatically. Client-supplied undecodable data still becomes a 400 — via Werkzeug's `ValueError`-typed hook raising `BadRequest`, explicitly *not* via this class.
4. **The `ValueError` family is the public contract for encoding problems**, so a codec-aware `except UnicodeError`/`except ValueError` keeps working while the same object is an `AssertionError` for debug-mode tooling and tests — two audiences, one object, no re-classification. `except UnicodeDecodeError` alone does not catch it; `AssertionError` precedes `UnicodeError` in the MRO, and clause order decides flat `except` clauses.
5. **Historically**, the class was created at exactly that boundary (2012-10-30, session serializer: non-`unicode` `str` handed to server-side session tagging) and orphaned when the serializer was rewritten (2017-06-01). It is dead code today — one occurrence tree-wide, no call sites, no tests, no docs, no changelog entry, not re-exported — and its motivating condition no longer raises at all.

The single most important qualifier: **this class is a vestigial artifact in Flask `3.2.0.dev` @ `85c5d93`; the architecture it demonstrates is real and is carried by its live siblings and the live dispatch code, but the class itself is not a live code path.**
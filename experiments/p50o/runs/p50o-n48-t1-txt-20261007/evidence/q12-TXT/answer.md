# Hidden coupling between `after_this_request` state and the response lifecycle

## Bottom line

In this repository (Flask @ `85c5d93`, `CHANGES.rst` top = "Version 3.2.0 / Unreleased"), `flask.after_this_request` stores nothing on the decorated function and nothing on the response. It appends the callback to a **plain mutable list on whichever `RequestContext` happens to be active at decoration time**:

```python
ctx = _cv_request.get(None)
...
ctx._after_request_functions.append(f)
return f
```

The response lifecycle later reads **that same list off whichever `RequestContext` is active at finalization time**, inside `Flask.process_response`, iterating it **live** and **never clearing it**:

```python
ctx = request_ctx._get_current_object()  # type: ignore[attr-defined]

for func in ctx._after_request_functions:
    response = self.ensure_sync(func)(response)
```

The hidden coupling is therefore: *"after this request"* is actually *"onto the currently-active context object, consumed whenever that context next passes through `process_response`, zero, one, or many times."* The API surface exposes none of those three facts (context identity, list liveness, consumption count), and all three break under nested or conditional registration. There are exactly **three** source references to the list in the whole tree:

```
src/flask/app.py:1313:         for func in ctx._after_request_functions:
src/flask/ctx.py:148:     ctx._after_request_functions.append(f)
src/flask/ctx.py:331:         self._after_request_functions: list[ft.AfterRequestCallable[t.Any]] = []
```

Created in `__init__`, appended to only by the decorator, read only by `process_response`, cleared by nothing.

---

## 1. The coupling, spelled out

### 1.1 The producer: `src/flask/ctx.py:117-149` (full decorator)

```python
def after_this_request(
    f: ft.AfterRequestCallable[t.Any],
) -> ft.AfterRequestCallable[t.Any]:
    """Executes a function after this request.  This is useful to modify
    response objects.  The function is passed the response object and has
    to return the same or a new one.

    Example::

        @app.route('/')
        def index():
            @after_this_request
            def add_header(response):
                response.headers['X-Foo'] = 'Parachute'
                return response
            return 'Hello World!'

    This is more useful if a function other than the view function wants to
    modify a response.  For instance think of a decorator that wants to add
    some headers without converting the return value into a response object.

    .. versionadded:: 0.9
    """
    ctx = _cv_request.get(None)

    if ctx is None:
        raise RuntimeError(
            "'after_this_request' can only be used when a request"
            " context is active, such as in a view function."
        )

    ctx._after_request_functions.append(f)
    return f
```

The decorator attaches nothing to `f` and returns `f` unchanged; it resolves the *currently active* context via contextvar lookup and mutates its list. The state is per-context, not per-request and not per-response.

### 1.2 Where the state lives: `src/flask/ctx.py` `RequestContext.__init__` / `copy`

```python
        self.flashes: list[tuple[str, str]] | None = None
        self.session: SessionMixin | None = session
        # Functions that should be executed after the request on the response
        # object.  These will be called before the regular "after_request"
        # functions.
        self._after_request_functions: list[ft.AfterRequestCallable[t.Any]] = []
```

```python
    def copy(self) -> RequestContext:
        """Creates a copy of this request context with the same request object.
        This can be used to move a request context to a different greenlet.
        Because the actual request object is the same this cannot be used to
        move a request context to a different thread unless access to the
        request object is locked.

        .. versionadded:: 0.10

        .. versionchanged:: 1.1
           The current session object is used instead of reloading the original
           data. This prevents `flask.session` pointing to an out-of-date object.
        """
        return self.__class__(
            self.app,
            environ=self.request.environ,
            request=self.request,
            session=self.session,
        )
```

`copy()` passes only `app/environ/request/session`; the copy gets a **brand-new empty** list. Anything registered while the copy is active is invisible to the original context and therefore never reaches the real response.

`push()`/`pop()` never touch the list either — `pop()` only runs teardown and closes the request:

```python
    def pop(self, exc: BaseException | None = _sentinel) -> None:  # type: ignore
        clear_request = len(self._cv_tokens) == 1

        try:
            if clear_request:
                if exc is _sentinel:
                    exc = sys.exc_info()[1]
                self.app.do_teardown_request(exc)

                request_close = getattr(self.request, "close", None)
                if request_close is not None:
                    request_close()
        finally:
            ...
```

So the list survives as long as the context object does, and a re-entered (`with ctx:`) context re-exposes the already-walked list.

### 1.3 The consumer: `src/flask/app.py:1298-1324` — `process_response` (only reader)

```python
    def process_response(self, response: Response) -> Response:
        """Can be overridden in order to modify the response object
        before it's sent to the WSGI server.  By default this will
        call all the :meth:`after_request` decorated functions.

        .. versionchanged:: 0.5
           As of Flask 0.5 the functions registered for after request
           execution are called in reverse order of registration.

        :param response: a :attr:`response_class` object.
        :return: a new response object or the same, has to be an
                 instance of :attr:`response_class`.
        """
        ctx = request_ctx._get_current_object()  # type: ignore[attr-defined]

        for func in ctx._after_request_functions:
            response = self.ensure_sync(func)(response)

        for name in chain(request.blueprints, (None,)):
            if name in self.after_request_funcs:
                for func in reversed(self.after_request_funcs[name]):
                    response = self.ensure_sync(func)(response)

        if not self.session_interface.is_null_session(ctx.session):
            self.session_interface.save_session(self, ctx.session, response)

        return response
```

Two structural properties, both invisible in the API: it reads the list from the **currently active context** rather than from a parameter, and it is a plain `for ... in list` over a **live** list with **no clearing/consumption step**.

### 1.4 The lifecycle that calls it, and can call it twice: `src/flask/app.py:904-951`

```python
    def full_dispatch_request(self) -> Response:
        """Dispatches the request and on top of that performs request
        pre and postprocessing as well as HTTP exception catching and
        error handling.

        .. versionadded:: 0.7
        """
        self._got_first_request = True

        try:
            request_started.send(self, _async_wrapper=self.ensure_sync)
            rv = self.preprocess_request()
            if rv is None:
                rv = self.dispatch_request()
        except Exception as e:
            rv = self.handle_user_exception(e)
        return self.finalize_request(rv)

    def finalize_request(
        self,
        rv: ft.ResponseReturnValue | HTTPException,
        from_error_handler: bool = False,
    ) -> Response:
        """Given the return value from a view function this finalizes
        the request by converting it into a response and invoking the
        postprocessing functions.  This is invoked for both normal
        request dispatching as well as error handlers.

        Because this means that it might be called as a result of a
        failure a special safe mode is available which can be enabled
        with the `from_error_handler` flag.  If enabled, failures in
        response processing will be logged and otherwise ignored.

        :internal:
        """
        response = self.make_response(rv)
        try:
            response = self.process_response(response)
            request_finished.send(
                self, _async_wrapper=self.ensure_sync, response=response
            )
        except Exception:
            if not from_error_handler:
                raise
            self.logger.exception(
                "Request finalizing failed with an error while handling an error"
            )
        return response
```

`handle_exception` ends in a second `finalize_request` (and therefore a second `process_response`) for the **same** `ctx`:

```python
        self.log_exception(exc_info)
        server_error: InternalServerError | ft.ResponseReturnValue
        server_error = InternalServerError(original_exception=e)
        handler = self._find_error_handler(server_error, request.blueprints)

        if handler is not None:
            server_error = self.ensure_sync(handler)(server_error)

        return self.finalize_request(server_error, from_error_handler=True)
```

And `wsgi_app` is where both paths meet, on one context:

```python
        ctx = self.request_context(environ)
        error: BaseException | None = None
        try:
            try:
                ctx.push()
                response = self.full_dispatch_request()
            except Exception as e:
                error = e
                response = self.handle_exception(e)
            except:  # noqa: B001
                error = sys.exc_info()[1]
                raise
            return response(environ, start_response)
        finally:
            if "werkzeug.debug.preserve_context" in environ:
                environ["werkzeug.debug.preserve_context"](_cv_app.get())
                environ["werkzeug.debug.preserve_context"](_cv_request.get())

            if error is not None and self.should_ignore_error(error):
                error = None

            ctx.pop(error)
```

Path: `ctx.push()` → `full_dispatch_request()` → `finalize_request(rv)` → `process_response` (pass #1). If pass #1 raises (e.g. an `after_request` function raises) and `PROPAGATE_EXCEPTIONS` is false, `wsgi_app` catches and calls `handle_exception(e)` on the **same `ctx`** → `finalize_request(server_error, from_error_handler=True)` → `process_response` (**pass #2, same list, still intact**). The second pass swallows exceptions but still iterates and re-invokes every entry.

The path is live and already covered by an existing test that simply never registers an `after_this_request` callback (`tests/test_basic.py:1082-1105`):

```python
def test_error_handler_after_processor_error(app, client):
    app.testing = False

    @app.before_request
    def before_request():
        if _trigger == "before":
            raise ZeroDivisionError

    @app.after_request
    def after_request(response):
        if _trigger == "after":
            raise ZeroDivisionError

        return response

    @app.route("/")
    def index():
        return "Foo"

    @app.errorhandler(500)
    def internal_server_error(e):
        return "Hello Server Error", 500

    for _trigger in "before", "after":
        rv = client.get("/")
        assert rv.status_code == 500
        assert rv.data == b"Hello Server Error"
```

---

## 2. Why the coupling is *hidden*

Four independent reasons, each verified:

1. **The docstring promises "after this request"; the storage is per-context, not per-request.** `after_this_request`'s only contract sentence is *"Executes a function after this request."* The state is `ctx._after_request_functions`, and the code comment at `src/flask/ctx.py:329-330` even re-states it as response-directed ("These will be called before the regular `after_request` functions") without ever saying it is consumed once.

2. **`copy()` silently drops it.** `RequestContext.copy()` carries `app/environ/request/session` only, so a greenlet/`copy_current_request_context` body registers into a fresh empty list that no response ever walks.

3. **`process_response` iterates live and never clears.** The decorator's name suggests a one-shot queue; the implementation is an append-only list on a long-lived object. Nothing in `process_response`, `finalize_request`, or `pop` consumes or resets it. Grep for any clearing operation finds nothing:

```
$ grep -rn -E "_after_request_functions\s*(\[\]|\.clear|\.remove|\.pop|\.extend|\.insert|=)" src
(no output)          (exit 1)
$ grep -rn -E "class .*RequestContext" src --include=*.py
src/flask/ctx.py:287:class RequestContext:
(exit 0)
```

So there is no subclass or alternate assignment path; the only way the list disappears is the whole context object being garbage-collected.

4. **The same context can be driven through `process_response` more than once** — the error path (1.4) and the re-push paths (`stream_with_context`, `FlaskClient` context preservation). `helpers.stream_with_context` does `with ctx:` inside its inner generator, and the comment in `RequestContext.push` acknowledges re-push explicitly:

```python
        # Only open a new session if this is the first time the request was
        # pushed, otherwise stream_with_context loses the session.
```

`FlaskClient` preservation likewise re-pushes the same context objects into an `ExitStack`:

```python
        # Re-push contexts that were preserved during the request.
        while self._new_contexts:
            cm = self._new_contexts.pop()
            self._context_stack.enter_context(cm)
```

### 2.1 The documented contract contradicts the code

`docs/lifecycle.rst:144` says the list is cleared:

```
#.  Whatever returned a response value - a before request function, the view, or an
    error handler, that value is converted to a :class:`.Response` object.
#.  Any :func:`~.after_this_request` decorated functions are called, then cleared.
#.  Any :meth:`~.Flask.after_request` decorated functions are called, which can modify
    the response object.
#.  The session is saved, persisting any modified session data using the app's
    :attr:`~.Flask.session_interface`.
#.  The :data:`.request_finished` signal is sent.
```

"…are called, then cleared" is asserted by the docs; the code never clears. Runtime inspection confirms the list is still populated after a completed request (see §4.4b below). So this is a genuine doc-vs-code discrepancy, not a hidden clearing mechanism.

### 2.2 The canonical documented usage is exactly the nested/conditional case that exposes the coupling

`docs/patterns/deferredcallbacks.rst` in full:

```rst
Deferred Request Callbacks
==========================

One of the design principles of Flask is that response objects are created and
passed down a chain of potential callbacks that can modify them or replace
them. When the request handling starts, there is no response object yet. It is
created as necessary either by a view function or by some other component in
the system.

What happens if you want to modify the response at a point where the response
does not exist yet?  A common example for that would be a
:meth:`~flask.Flask.before_request` callback that wants to set a cookie on the
response object.

One way is to avoid the situation. Very often that is possible. For instance
you can try to move that logic into a :meth:`~flask.Flask.after_request`
callback instead. However, sometimes moving code there makes it
more complicated or awkward to reason about.

As an alternative, you can use :func:`~flask.after_this_request` to register
callbacks that will execute after only the current request. This way you can
defer code execution from anywhere in the application, based on the current
request.

At any time during a request, we can register a function to be called at the
end of the request. For example you can remember the current language of the
user in a cookie in a :meth:`~flask.Flask.before_request` callback::

    from flask import request, after_this_request

    @app.before_request
    def detect_user_language():
        language = request.cookies.get('user_lang')

        if language is None:
            language = guess_language_from_request()

            # when the response exists, set a cookie with the language
            @after_this_request
            def remember_language(response):
                response.set_cookie('user_lang', language)
                return response

        g.language = language
```

Note the `if language is None:` guard and the decorator nested inside a `before_request` function. The doc promises "execute after only the current request" but says nothing about storage, ordering relative to `process_response`, or idempotency. The conditional registration **also** runs through the `preprocess_request` early-return path, where a `before_request` that returns non-`None` short-circuits the view:

```python
    def preprocess_request(self) -> ft.ResponseReturnValue | None:
        ...
        for name in names:
            if name in self.before_request_funcs:
                for before_func in self.before_request_funcs[name]:
                    rv = self.ensure_sync(before_func)()

                    if rv is not None:
                        return rv  # type: ignore[no-any-return]

        return None
```

`docs/api.rst:214` adds nothing (`.. autofunction:: after_this_request`), so the docstring is the entire API surface.

### 2.3 Coverage gap

Exactly one test in the suite touches `after_this_request` (`tests/test_basic.py:740-752`):

```python
def test_after_request_processing(app, client):
    @app.route("/")
    def index():
        @flask.after_this_request
        def foo(response):
            response.headers["X-Foo"] = "a header"
            return response

        return "Test"

    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["X-Foo"] == "a header"
```

```
$ grep -rn "after_this_request" tests --include=*.py
tests/test_basic.py:743:        @flask.after_this_request
$ grep -rn -E "after_request_functions|fired twice|cleared" tests --include=*.py
(no output)          (exit 1)
```

No test asserts execution count, clearing, re-entrancy, nesting, conditional registration, copied contexts, preserved contexts, or streaming registration. The full suite passes (see §4.9), so none of the misbehaviours below is caught.

---

## 3. The alternative framing is ruled out

The other decorator in the tree whose state is flipped by the lifecycle is `@setupmethod` (`_got_first_request`). It is a **different** mechanism and does not match "state consumed by the response lifecycle":

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

It raises loudly at call time (verified below in §4.8), whereas `after_this_request` is not a `setupmethod` and fails silently. So the coupling asked about is `after_this_request` ↔ `_after_request_functions` ↔ `process_response`.

---

## 4. Empirical failure modes (command outputs, verbatim)

All runs used the repo venv (`Python 3.13.9`, pytest 8.4.0) with `PYTHONPATH="$PWD/src"`. Two environment hazards were neutralised first: the venv's `flask.pth` points at a different checkout, and stale `__pycache__` was recompiled cleanly (`PYTHONPYCACHEPREFIX`). `diff -rq --exclude=__pycache__` proved `tests/` and `src/flask` identical to the source, and `flask.__file__`/`co_filename` were verified to be this checkout:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -c "
import flask, flask.app, flask.ctx
print(flask.app.Flask.wsgi_app.__code__.co_filename)
print(flask.ctx.after_this_request.__code__.co_filename)
print(flask.app.Flask.process_response.__code__.co_filename)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q12-TXT\seal\src\flask\app.py
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q12-TXT\seal\src\flask\ctx.py
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q12-TXT\seal\src\flask\app.py     (exit 0)
```

### 4.1 Baseline — the existing test passes, callback fires once

```
$ ...python.exe -m pytest tests/test_basic.py::test_after_request_processing -v -p no:cacheprovider
tests/test_basic.py::test_after_request_processing PASSED                [100%]
============================== 1 passed in 0.08s ==============================
```

### 4.2 Nested registration **inside** the callback — inner callback runs in the *same* pass

Because `process_response` iterates the live list, a callback registered from within a callback is picked up immediately by the ongoing `for` loop:

```
$ python _exec_repro/repro2_nested.py
outer running; list before inner: [<function index.<locals>.outer at 0x...>]
outer appended inner; list now: [<function index.<locals>.outer at 0x...>, <function index.<locals>.outer.<locals>.inner at 0x...>]
status_code: 200
X-Inner header: yes
calls: ['outer', 'inner']
final _after_request_functions length: 2
---exit:0
```

This is the sharpest form of the hidden coupling: registration time and consumption time are not separated by any barrier, so ordering depends on list internals rather than on a declared contract.

### 4.3 Registration from an `after_request` function — dropped for this response, deferred forever

The list is walked **before** the regular `after_request` functions, so a registration made from an `after_request` handler is too late for this response — and, because nothing clears, it lingers and fires on any later `process_response` of the same context:

```
$ python _exec_repro/repro3_after_request_registration.py
late_registrar running
after late registration, list length: 1
GET / status_code: 200
GET / calls: []
late_registrar running
after late registration, list length: 2
GET /two status_code: 200
GET /two calls: ['early']
---exit:0
```

```
$ python _exec_repro/repro3b_deferred.py
after client.get, calls: [] | X-Late: None
preserved list: ['late_cb']
after manual process_response, calls: ['late_cb'] | X-Late: yes
---exit:0
```

So the callback is **not discarded**; it is silently deferred onto a later finalization of the same context.

### 4.4 Error path: two `process_response` passes on one context — callback fires **twice**

```
$ python _exec_repro/repro4a_double_pass.py
[2026-10-07 15:44:37,710] ERROR in app: Exception on / [GET]
Traceback (most recent call last):
  File "...\q12-TXT\seal\src\flask\app.py", line 1511, in wsgi_app
    response = self.full_dispatch_request()
  ...
  File "...\seal\src\flask\app.py", line 941, in finalize_request
    response = self.process_response(response)
  File "...\seal\src\flask\app.py", line 1319, in process_response
    response = self.ensure_sync(func)(response)
  File "...\_exec_repro\repro4a_double_pass.py", line 37, in boom
    raise ZeroDivisionError("boom")
ZeroDivisionError: boom
[2026-10-07 15:44:37,713] ERROR in app: Request finalizing failed with an error while handling an error
Traceback (most recent call last):
  ... same boom ...
cb running; list now: [<function index.<locals>.cb at 0x...>]
boom after_request running; raising ZeroDivisionError
cb running; list now: [<function index.<locals>.cb at 0x...>]
boom after_request running; raising ZeroDivisionError
status_code: 500
data: b'<!doctype html>\n<html lang=en>\n<title>500 Internal Server Error</title>...'
calls: ['cb', 'cb']
cb fired times: 2
---exit:0
```

### 4.4b The list is **not** cleared, and a re-entered context re-fires it

```
$ python _exec_repro/repro4b_not_cleared.py
after client.get, calls: ['cb']
after client.get, preserved list: [<function index.<locals>.cb at 0x...>]
list is non-empty: True
after manual process_response, calls: ['cb', 'cb']
cb fired times: 2
same context object reused: True
---exit:0
```

This is the direct refutation of `docs/lifecycle.rst:144`'s "then cleared", and the mechanism behind the preserved-context case (`with app.test_client() as client:` / `flask.globals.request_ctx` reuse).

### 4.5 Nested registration inside a **copied** context — never fires

`copy_current_request_context` / `request_ctx.copy()` create a context whose list is empty; that is where the registration lands:

```
$ python _exec_repro/repro5_copied.py
view/real ctx id: 1749643721232 list: []
inside work ctx id: 1749644419920 is real? False
inside work, copy's list: [<function index.<locals>.work.<locals>.copied_cb at 0x...>]
inside work, real's list: []
after work(), real list: []
status_code: 200
calls: []
copied_cb fired: False
---exit:0
```

### 4.6 Registration inside `stream_with_context` — appended after the walk, never fires

The generator body runs during response iteration, i.e. after `process_response` already walked the list; the append lands on the same context but too late:

```
$ python _exec_repro/repro6_streaming.py
generator body running; list before: []
generator body; list after: [<function streamed.<locals>.generate.<locals>.stream_cb at 0x...>]
status_code: 200
data: b'HelloWorld'
calls: []
stream_cb fired: False
---exit:0
```

### 4.7 Conditional registration (the documented pattern) — behaves as advertised, but only because the context is fresh

```
$ python _exec_repro/repro7_conditional.py
remember=1 status: 200 X-Remember: 1
calls after remember=1: ['remember']
plain status: 200 X-Remember: None
calls after plain: ['remember']
---exit:0
```

The conditional pattern works when each request gets a brand-new context (the ordinary `client.get` case). Its correctness is *inherited* from context destruction, not from any consumption logic — which is why the same pattern breaks under preservation, copying, re-push, or double finalization.

### 4.8 The alternative `setupmethod` framing is ruled out empirically

```
$ python _exec_repro/repro8_setupmethod_framing.py
first request status: 200
app._got_first_request: True
route registration raised AssertionError: The setup method 'route' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.
after_this_request registration status: 200
X-At-Any-Time header: yes
after_this_request wrapped by setupmethod?: False
---exit:0
```

### 4.9 The full suite passes in both clean-cache runs — the misbehaviour is invisible to CI

```
$ PYTHONPYCACHEPREFIX="$PWD/_exec_repro/pycache_clean" PYTHONPATH="$PWD/src" \
  ...python.exe -m pytest -p no:cacheprovider
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: ...\q12-TXT\seal
configfile: pyproject.toml
testpaths: tests
collected 489 items
... (all modules) ...
============================= 489 passed in 7.18s =============================
---exit:0
```

Second clean run with `-vvv --tb=long -rA` also reported **489 passed**, with tracebacks now referencing `C:\...\q12-TXT\seal\src\flask\app.py` and `C:\...\q12-TXT\seal\tests\test_reqctx.py`, including `PASSED tests/test_basic.py::test_after_request_processing` and `PASSED tests/test_basic.py::test_error_handler_after_processor_error`.

### 4.10 Summary table of behaviour

| Case | Reproduction | Result |
|---|---|---|
| Baseline single after_this_request | `test_after_request_processing` | fires once, PASS |
| Nested registration during the pass | repro2 | `outer` then `inner`, both run in the same pass; list length 2 |
| Registered from `after_request` | repro3 / repro3b | not run for that response; stays in list and runs on a later `process_response` |
| Error path (`after_request` raises) | repro4a | callback **fires twice**; 500 response; second error logged and swallowed |
| Clearing after response | repro4b | list still non-empty; manual `process_response` re-fires → 2 |
| Registration inside copied context | repro5 | lands on the copy's fresh list; never fires |
| Registration inside `stream_with_context` body | repro6 | appended after the walk; never fires |
| Conditional registration (docs pattern) | repro7 | fires only on the branch-taken request |
| `setupmethod` alternative | repro8 | route registration after first request raises `AssertionError`; `after_this_request` does not |

---

## 5. The verdict on the source of truth

- Exactly three source references: create (`src/flask/ctx.py:331`), append (`src/flask/ctx.py:148`), read (`src/flask/app.py:1313`).
- No `.clear()`, `del`, reassignment, or subclass override anywhere.
- Runtime confirms the list stays populated after the response (4.4b) and is re-walked on a second pass (4.4, 4.3b).

**Verdict:** the missing clearing is the actual behaviour of this code and it contradicts `docs/lifecycle.rst:144` ("…are called, then cleared"). Nothing upstream clears it; only garbage-collecting the whole `RequestContext` removes it, and a preserved/re-pushed context — including `stream_with_context`, which re-enters the same object — keeps it.

---

## 6. Fix sketch

The coupling exists because registration is keyed to the *context object* while consumption is keyed to an unbounded number of *finalization passes* over that object. Breaking it means making consumption explicit and bounded:

1. **Consume the list in `process_response`.** Snapshot and clear before iterating, so a callback cannot be picked up by the same pass and cannot fire on a later pass:

   ```python
   funcs, ctx._after_request_functions = ctx._after_request_functions, []
   for func in funcs:
       response = self.ensure_sync(func)(response)
   ```

   This alone fixes 4.2 (nested registration becomes deterministic — inner runs on the *next* finalization or never, matching the "after this request" wording if the snapshot is appended after, and matching the documented "cleared" claim in all cases), fixes 4.4/4.4b (second pass finds an empty list), fixes 4.3b (late registration no longer leaks into a later request), and restores agreement with `docs/lifecycle.rst:144`. It changes 4.2's observable behaviour, so it needs its own test.

2. **Key callbacks to the response, not the context.** Store callbacks on the `Response` object being finalized (or pass an explicit per-response list) so the state cannot outlive, or be shared across, a finalization — the context copy/preserve/re-push paths (4.5, 4.6, 4.7-under-preservation) then stop being relevant by construction.

3. **Decide and document the semantics** the API currently leaves open: whether a registration made after the walk (from `after_request` or a streamed body) is an error, a no-op, or deferred; whether a registration from a copied context is a `RuntimeError`; and whether the doc's "then cleared" should be kept (then the code must be fixed) or the docs corrected. Whichever is chosen, add tests for: nested registration inside a callback, registration from `after_request`, the double-`process_response` error path, `copy_current_request_context`, `stream_with_context`, and `with app.test_client() as client:` preservation — none of which exists today (only `tests/test_basic.py:740-752` covers the decorator at all).

---

## 7. One-paragraph answer

`after_this_request` mutates a per-`RequestContext` mutable list (`ctx._after_request_functions`, created at `src/flask/ctx.py:331`, appended at `src/flask/ctx.py:148`) which is read later by `Flask.process_response` (`src/flask/app.py:1313`) from whichever context is active, iterated live, and never cleared. That is the hidden coupling: the decorator's "state" is owned by the *request context object*, while the *response lifecycle* consumes it a variable number of times per context — zero (copied contexts, `stream_with_context` bodies, registrations from `after_request`), one (ordinary requests), or more than one (the `after_request`-raises → `handle_exception` → `finalize_request(from_error_handler=True)` second pass, and any re-entered preserved context). Under nested registration this surfaces as non-deterministic same-pass execution (a callback registering another callback gets it run in the same `for` loop) or as silently dropped/deferred execution; under conditional registration it works only by accident, when the context happens to be fresh and finalized exactly once, and leaks into later finalizations when it is not; and the docs' claim that the functions "are called, then cleared" (`docs/lifecycle.rst:144`) is simply false for this code.
# How `copy_current_request_context` isolates lightweight concurrent execution contexts while preserving session data

**Short answer.** Flask's request context lives in a `ContextVar` (`_cv_request`) that each lightweight execution context (greenlet) sees through its own binding. The decorator `flask.copy_current_request_context` captures a copy of the active `RequestContext` **at decoration time**, and then, on every call, runs the wrapped function inside `with ctx:` — i.e. push/pop of that private copy. Isolation comes from `ContextVar.set`/`ContextVar.reset(token)` per execution context plus the copy owning its own `_cv_tokens` stack; session preservation comes from `RequestContext.copy()` deliberately passing the **same live session object** (`session=self.session`) and from `push()` skipping `open_session` for an already-populated context. The `request` object itself is shared **by reference**, so the copy may move to another greenlet but not to another thread without locking; `g` / the app context are **not** copied — the greenlet gets a fresh `AppContext`.

Everything below is quoted from this working directory (`C:/Users/oobbee/AppData/Local/Temp/pi-p50o/9f4f8f70/q14-TXT/seal`, a Flask `3.2.0.dev` source tree) and from command output that was executed in it.

---

## 1. The decorator itself — the anchor

`src/flask/ctx.py`, verbatim (verified by reading the file):

```python
F = t.TypeVar("F", bound=t.Callable[..., t.Any])


def copy_current_request_context(f: F) -> F:
    """A helper function that decorates a function to retain the current
    request context.  This is useful when working with greenlets.  The moment
    the function is decorated a copy of the request context is created and
    then pushed when the function is called.  The current session is also
    included in the copied request context.

    Example::

        import gevent
        from flask import copy_current_request_context

        @app.route('/')
        def index():
            @copy_current_request_context
            def do_some_work():
                # do some work here, it can access flask.request or
                # flask.session like you would otherwise in the view function.
                ...
            gevent.spawn(do_some_work)
            return 'Regular response'

    .. versionadded:: 0.10
    """
    ctx = _cv_request.get(None)

    if ctx is None:
        raise RuntimeError(
            "'copy_current_request_context' can only be used when a"
            " request context is active, such as in a view function."
        )

    ctx = ctx.copy()

    def wrapper(*args: t.Any, **kwargs: t.Any) -> t.Any:
        with ctx:
            return ctx.app.ensure_sync(f)(*args, **kwargs)

    return update_wrapper(wrapper, f)  # type: ignore[return-value]
```

Three things to note, all visible in the source:

1. **The copy is taken at decoration time, not call time.** `ctx = _cv_request.get(None)` and `ctx = ctx.copy()` are both executed *outside* `wrapper`; the resulting object is captured in the closure. This is exactly what the docstring says: *"The moment the function is decorated a copy of the request context is created and then pushed when the function is called."*
2. **"Lightweight concurrent execution contexts" = greenlets.** The docstring states: *"This is useful when working with greenlets"*, and the example uses `gevent.spawn(do_some_work)`.
3. **The session half of the question is stated up front:** *"The current session is also included in the copied request context."*

Each call pushes the copy around the work: `with ctx: return ctx.app.ensure_sync(f)(*args, **kwargs)`. `ensure_sync` is what lets the decorator wrap `async def` targets too:

```python
    def ensure_sync(self, func: t.Callable[..., t.Any]) -> t.Callable[..., t.Any]:
        """Ensure that the function is synchronous for WSGI workers.
        Plain ``def`` functions are returned as-is. ``async def``
        functions are wrapped to run and wait for the response.

        Override this method to change how the app runs async views.

        .. versionadded:: 2.0
        """
        if iscoroutinefunction(func):
            return self.async_to_sync(func)

        return func
```
(`src/flask/app.py`)

The error path is exercised by the executor: decorating **outside** any active request context raises

```
RuntimeError raised: 'copy_current_request_context' can only be used when a request context is active, such as in a view function.
```

---

## 2. The isolation mechanism: `ContextVar` + per-instance `_cv_tokens`

### 2.1 The globals are `ContextVar`-backed proxies

`src/flask/globals.py`, whole file:

```python
from __future__ import annotations

import typing as t
from contextvars import ContextVar

from werkzeug.local import LocalProxy

if t.TYPE_CHECKING:  # pragma: no cover
    from .app import Flask
    from .ctx import _AppCtxGlobals
    from .ctx import AppContext
    from .ctx import RequestContext
    from .sessions import SessionMixin
    from .wrappers import Request


_no_app_msg = """\
Working outside of application context.

This typically means that you attempted to use functionality that needed
the current application. To solve this, set up an application context
with app.app_context(). See the documentation for more information.\
"""
_cv_app: ContextVar[AppContext] = ContextVar("flask.app_ctx")
app_ctx: AppContext = LocalProxy(  # type: ignore[assignment]
    _cv_app, unbound_message=_no_app_msg
)
current_app: Flask = LocalProxy(  # type: ignore[assignment]
    _cv_app, "app", unbound_message=_no_app_msg
)
g: _AppCtxGlobals = LocalProxy(  # type: ignore[assignment]
    _cv_app, "g", unbound_message=_no_app_msg
)

_no_req_msg = """\
Working outside of request context.

This typically means that you attempted to use functionality that needed
an active HTTP request. Consult the documentation on testing for
information about how to avoid this problem.\
"""
_cv_request: ContextVar[RequestContext] = ContextVar("flask.request_ctx")
request_ctx: RequestContext = LocalProxy(  # type: ignore[assignment]
    _cv_request, unbound_message=_no_req_msg
)
request: Request = LocalProxy(  # type: ignore[assignment]
    _cv_request, "request", unbound_message=_no_req_msg
)
session: SessionMixin = LocalProxy(  # type: ignore[assignment]
    _cv_request, "session", unbound_message=_no_req_msg
)
```

`request`, `session`, `request_ctx` are `LocalProxy`s over `_cv_request`; `current_app`, `g`, `app_ctx` are `LocalProxy`s over `_cv_app`. Because the backing store is a `ContextVar`, **each execution context has its own binding view** — that is the isolation primitive. A greenlet therefore starts with *nothing* bound, so `flask.request` / `flask.current_app` are falsy there until something is pushed.

The docs state the same model (`docs/reqcontext.rst`, quoted in the retrieved evidence):

```rst
The context is unique to each thread (or other worker type).
:data:`request` cannot be passed to another thread, the other thread has
a different context space and will not know about the request the parent
thread was pointing to.

Context locals are implemented using Python's :mod:`contextvars` and
Werkzeug's :class:`~werkzeug.local.LocalProxy`. Python manages the
lifetime of context vars automatically, and local proxy wraps that
low-level interface to make the data easier to work with.
```

```rst
The :meth:`Flask.wsgi_app` method is called to handle each request. It
manages the contexts during the request. Internally, the request and
application contexts work like stacks. When contexts are pushed, the
proxies that depend on them are available and point at information from
the top item.

When the request starts, a :class:`~ctx.RequestContext` is created and
pushed, which creates and pushes an :class:`~ctx.AppContext` first if
a context for that application is not already the top context. While
these contexts are pushed, the :data:`current_app`, :data:`g`,
:data:`request`, and :data:`session` proxies are available to the
original thread handling the request.

Other contexts may be pushed to change the proxies during a request.
...
After the request is dispatched and a response is generated and sent,
the request context is popped, which then pops the application context.
```

And `docs/design.rst` frames greenlets explicitly:

```rst
Thread Locals
-------------

Flask uses thread local objects (context local objects in fact, they
support greenlet contexts as well) for request, session and an extra
object you can put your own things on (:data:`~flask.g`).  Why is that and
isn't that a bad idea?
...
```

### 2.2 `copy()` — a distinct context that shares the same `request` and `session` objects

`src/flask/ctx.py`:

```python
    def __init__(
        self,
        app: Flask,
        environ: WSGIEnvironment,
        request: Request | None = None,
        session: SessionMixin | None = None,
    ) -> None:
        self.app = app
        if request is None:
            request = app.request_class(environ)
            request.json_module = app.json
        self.request: Request = request
        self.url_adapter = None
        try:
            self.url_adapter = app.create_url_adapter(self.request)
        except HTTPException as e:
            self.request.routing_exception = e
        self.flashes: list[tuple[str, str]] | None = None
        self.session: SessionMixin | None = session
        # Functions that should be executed after the request on the response
        # object.  These will be called before the regular "after_request"
        # functions.
        self._after_request_functions: list[ft.AfterRequestCallable[t.Any]] = []

        self._cv_tokens: list[
            tuple[contextvars.Token[RequestContext], AppContext | None]
        ] = []

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

This is the crux of the whole question:

- `request=self.request` → the copy holds the **same request object by reference** (not a deep copy). The docstring states the rule verbatim: usable to move to a **different greenlet**, *not* to a different **thread** unless access to the request object is locked.
- `session=self.session` → the copy holds the **same live session object**. The `versionchanged:: 1.1` note explains why: *"The current session object is used instead of reloading the original data. This prevents `flask.session` pointing to an out-of-date object."*
- `_cv_tokens` is initialised **per instance**, so push/pop bookkeeping is private to each context (original and copy).

### 2.3 `push()` — sets the token, and skips `open_session` when a session already exists

```python
    def push(self) -> None:
        # Before we push the request context we have to ensure that there
        # is an application context.
        app_ctx = _cv_app.get(None)

        if app_ctx is None or app_ctx.app is not self.app:
            app_ctx = self.app.app_context()
            app_ctx.push()
        else:
            app_ctx = None

        self._cv_tokens.append((_cv_request.set(self), app_ctx))

        # Open the session at the moment that the request context is available.
        # This allows a custom open_session method to use the request context.
        # Only open a new session if this is the first time the request was
        # pushed, otherwise stream_with_context loses the session.
        if self.session is None:
            session_interface = self.app.session_interface
            self.session = session_interface.open_session(self.app, self.request)

            if self.session is None:
                self.session = session_interface.make_null_session(self.app)

        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
        if self.url_adapter is not None:
            self.match_request()
```

- `_cv_request.set(self)` binds this context **in the currently running execution context** and the returned `Token` is stored on *this* instance's `_cv_tokens` list.
- Because a **copied** context already has `session is not None`, the `if self.session is None:` branch is skipped — `open_session` is never called, so the parent's in-memory session (including writes made in the view) is what the greenlet sees. The comment gives the rationale directly: *"Only open a new session if this is the first time the request was pushed, otherwise stream_with_context loses the session."*
- A **fresh `AppContext`** is created inside the greenlet precisely because `_cv_app.get(None)` is `None` there (`app_ctx is None` → `self.app.app_context(); app_ctx.push()`), and the newly pushed app context is owned by this push (stored in the token tuple), so it will be popped with it.
- `match_request()` runs **after** the session is available so custom URL converters see it:

```python
    def match_request(self) -> None:
        """Can be overridden by a subclass to hook into the matching
        of the request.
        """
        try:
            result = self.url_adapter.match(return_rule=True)  # type: ignore
            self.request.url_rule, self.request.view_args = result  # type: ignore
        except HTTPException as e:
            self.request.routing_exception = e
```

### 2.4 `pop()` — resets the token, restoring the prior binding exactly

```python
    def pop(self, exc: BaseException | None = _sentinel) -> None:  # type: ignore
        """Pops the request context and unbinds it by doing that.  This will
        also trigger the execution of functions registered by the
        :meth:`~flask.Flask.teardown_request` decorator.

        .. versionchanged:: 0.9
           Added the `exc` argument.
        """
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
            ctx = _cv_request.get()
            token, app_ctx = self._cv_tokens.pop()
            _cv_request.reset(token)

            # get rid of circular dependencies at the end of the request
            # so that we don't require the GC to be active.
            if clear_request:
                ctx.request.environ["werkzeug.request"] = None

            if app_ctx is not None:
                app_ctx.pop(exc)

            if ctx is not self:
                raise AssertionError(
                    f"Popped wrong request context. ({ctx!r} instead of {self!r})"
                )
```

- `_cv_request.reset(token)` — not `set` — **restores the previous binding exactly** (a LIFO undo). This is what makes `with ctx:` in the decorator's `wrapper` a reversible, isolated layer: whatever the greenlet had bound before the block is what it has after the block. In a greenlet that started empty, the proxies are unbound again afterwards.
- `clear_request = len(self._cv_tokens) == 1` — a copy is pushed only once, so its pop **does** run `do_teardown_request` and close the request object. The original context in the outer execution context is untouched because it holds its **own** `_cv_tokens` list.
- The `ctx is not self` assertion guards against cross-context pop mismatches.

`__enter__` / `__exit__` are what the `with ctx:` statement in the decorator invokes:

```python
    def __enter__(self) -> RequestContext:
        self.push()
        return self

    def __exit__(
        self,
        exc_type: type | None,
        exc_value: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.pop(exc_value)
```

### 2.5 Why `current_app` works but `g` is *not* shared

`src/flask/ctx.py`:

```python
class AppContext:
    """The app context contains application-specific information. An app
    context is created and pushed at the beginning of each request if
    one is not already active. An app context is also pushed when
    running CLI commands.
    """

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.url_adapter = app.create_url_adapter(None)
        self.g: _AppCtxGlobals = app.app_ctx_globals_class()
        self._cv_tokens: list[contextvars.Token[AppContext]] = []

    def push(self) -> None:
        """Binds the app context to the current context."""
        self._cv_tokens.append(_cv_app.set(self))
        appcontext_pushed.send(self.app, _async_wrapper=self.app.ensure_sync)

    def pop(self, exc: BaseException | None = _sentinel) -> None:  # type: ignore
        """Pops the app context."""
        try:
            if len(self._cv_tokens) == 1:
                if exc is _sentinel:
                    exc = sys.exc_info()[1]
                self.app.do_teardown_appcontext(exc)
        finally:
            ctx = _cv_app.get()
            _cv_app.reset(self._cv_tokens.pop())

        if ctx is not self:
            raise AssertionError(
                f"Popped wrong app context. ({ctx!r} instead of {self!r})"
            )

        appcontext_popped.send(self.app, _async_wrapper=self.app.ensure_sync)

    def __enter__(self) -> AppContext:
        self.push()
        return self

    def __exit__(
        self,
        exc_type: type | None,
        exc_value: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.pop(exc_value)
```

`g` is created per `AppContext` (`self.g = app.app_ctx_globals_class()`), and `RequestContext.copy()` never touches the app context. So in the greenlet a **new** `AppContext` — hence a **new** `g` — is created by `push()`, while `current_app` still resolves to the same `Flask` object (`app_ctx.app is self.app`). The executor measured exactly this: `g_is_parent_g = False` and `current_app_is_parent_app = True`.

### 2.6 The original boundary that makes copying necessary

`src/flask/app.py`:

```python
    def wsgi_app(
        self, environ: WSGIEnvironment, start_response: StartResponse
    ) -> cabc.Iterable[bytes]:
        """..."""
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

The original request context is **popped here**, before a spawned greenlet would run — hence the need to snapshot it at decoration time. "Execution boundaries" in the question maps to (a) this WSGI push/pop boundary and (b) generator resumption across a returned response; the decorator addresses (a) for greenlets, while `stream_with_context` addresses (b) by a different, non-copying technique (see §5).

---

## 3. Preserving session data across the execution boundary

Session preservation is the conjunction of two explicit design decisions, both quoted above:

1. **`copy()` passes `session=self.session`** — the same live session *object*, so the greenlet reads the in-memory session the view already mutated. The docstring/versionchanged note: *"The current session object is used instead of reloading the original data. This prevents `flask.session` pointing to an out-of-date object."* The changelog anchor supplied by the retriever is `CHANGES.rst:676–678`: *"`RequestContext.copy` includes the current session object in the request context copy. This prevents `session` pointing to an out-of-date object. :issue:`2935`"*.
2. **`push()` guards with `if self.session is None:`** — because the copy's session is already populated, `open_session` is **not** re-run, so no cookie re-parsing / re-signing occurs and no "out-of-date" session is reconstructed. The comment names the dual purpose: *"Only open a new session if this is the first time the request was pushed, otherwise stream_with_context loses the session."*

For contrast, what `open_session` would have done (this is what the copy deliberately bypasses) — `src/flask/sessions.py`:

```python
    def open_session(self, app: Flask, request: Request) -> SessionMixin | None:
        """This is called at the beginning of each request, after
        pushing the request context, before matching the URL.

        This must return an object which implements a dictionary-like
        interface as well as the :class:`SessionMixin` interface.

        This will return ``None`` to indicate that loading failed in
        some way that is not immediately an error. The request
        context will fall back to using :meth:`make_null_session`
        in this case.
        """
        raise NotImplementedError()
```

```python
    def open_session(self, app: Flask, request: Request) -> SecureCookieSession | None:
        s = self.get_signing_serializer(app)
        if s is None:
            return None
        val = request.cookies.get(self.get_cookie_name(app))
        if not val:
            return self.session_class()
        max_age = int(app.permanent_session_lifetime.total_seconds())
        try:
            data = s.loads(val, max_age=max_age)
            return self.session_class(data)
        except BadSignature:
            return self.session_class()
```

Because `push()` runs `match_request()` *after* the session is ensured, custom URL converters also see the session (the comment in `push()`: *"Match the request URL after loading the session, so that the session is available in custom URL converters."*).

**Empirical confirmation.** The executor's ad-hoc script asserted on the real objects and printed:

```
    same_session_object = True
    same_request_object = True
    distinct_context = True
    distinct_cv_tokens_list = True
...
    request_bound = True
    session_fizz = buzz
    current_app_is_parent_app = True
    request_is_parent_request = True
    session_is_parent_session = True
    g_is_parent_g = False
    cv_request_is_original_ctx = False
    cv_request_is_a_copy = True
```

i.e. inside a fresh greenlet, after the request had already been popped, the decorated function still sees the parent's `request` and `session` **objects** (`session_fizz = buzz`), resolves `current_app` to the parent app, while both the context object and the `g` object differ.

---

## 4. The maintainers' own executable specification

`tests/test_reqctx.py`, verbatim (verified in the working tree):

```python
@pytest.mark.skipif(greenlet is None, reason="greenlet not installed")
class TestGreenletContextCopying:
    def test_greenlet_context_copying(self, app, client):
        greenlets = []

        @app.route("/")
        def index():
            flask.session["fizz"] = "buzz"
            reqctx = request_ctx.copy()

            def g():
                assert not flask.request
                assert not flask.current_app
                with reqctx:
                    assert flask.request
                    assert flask.current_app == app
                    assert flask.request.path == "/"
                    assert flask.request.args["foo"] == "bar"
                    assert flask.session.get("fizz") == "buzz"
                assert not flask.request
                return 42

            greenlets.append(greenlet(g))
            return "Hello World!"

        rv = client.get("/?foo=bar")
        assert rv.data == b"Hello World!"

        result = greenlets[0].run()
        assert result == 42

    def test_greenlet_context_copying_api(self, app, client):
        greenlets = []

        @app.route("/")
        def index():
            flask.session["fizz"] = "buzz"

            @flask.copy_current_request_context
            def g():
                assert flask.request
                assert flask.current_app == app
                assert flask.request.path == "/"
                assert flask.request.args["foo"] == "bar"
                assert flask.session.get("fizz") == "buzz"
                return 42

            greenlets.append(greenlet(g))
            return "Hello World!"

        rv = client.get("/?foo=bar")
        assert rv.data == b"Hello World!"

        result = greenlets[0].run()
        assert result == 42
```

This test encodes both halves of the question:

- **Isolation:** the manual variant asserts `not flask.request` and `not flask.current_app` **before** `with reqctx:` and `not flask.request` **again after** it — the greenlet's own context variable view is empty, and after the `with` block it is empty again (`reset(token)` restored the prior binding).
- **Session preservation:** both variants assert `flask.session.get("fizz") == "buzz"`, a value written in the view. The decorator variant can assert `flask.request` immediately because `wrapper` has already opened the `with ctx:` block — that is the only behavioural difference between the two.

Import guard, `tests/test_reqctx.py`:

```python
try:
    from greenlet import greenlet
except ImportError:
    greenlet = None
```

**The tests pass in this working directory.** Command and output, unedited:

```
COMMAND: PYTHONPATH="$(pwd)/src" .venv/Scripts/python.exe -m pytest tests/test_reqctx.py -v -k GreenletContextCopying
```
```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q14-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q14-TXT\seal
configfile: pyproject.toml
collecting ... collected 14 items / 12 deselected / 2 selected

tests/test_reqctx.py::TestGreenletContextCopying::test_greenlet_context_copying PASSED [ 50%]
tests/test_reqctx.py::TestGreenletContextCopying::test_greenlet_context_copying_api PASSED [100%]

====================== 2 passed, 12 deselected in 0.11s =======================
EXIT=0
```

Environment note (important for trustworthy verification): the shared venv's editable pointer does **not** resolve to this worktree —

```
COMMAND: cat .venv/Lib/site-packages/flask.pth
```
```
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9449f018\q9-SYN\seal\srcEXIT=0
```

— so the executor forced `PYTHONPATH="$(pwd)/src"` and verified resolution before trusting any result:

```
python: 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
flask.__file__: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q14-TXT\seal\src\flask\__init__.py
```

i.e. `import flask` resolves to **this worktree's** `src/flask`. Versions in the venv:

```
flask == 3.2.0.dev0
werkzeug == 3.1.3
greenlet == 3.2.3
pytest == 8.4.0
asgiref == 3.8.1
jinja2 == 3.1.6
click == 8.2.1
blinker == 1.9.0
itsdangerous == 2.2.0
```

(`gevent` is *not* installed — `ModuleNotFoundError: No module named 'gevent'` — so all checks used the low-level `greenlet` API, which is what the Flask tests themselves import.)

Additional confirming measurements from the executor:

Decoration-time capture (a function decorated during request `/a`, invoked later, after `/b`, and outside any request):

```
GET /a: b'A done'
GET /b: b'B done'
call decorated fn outside any request: ('/a', 'A')
```

Manual `push()`/`pop()` of a copy:

```
manual before push: _cv_request bound: False | _cv_app bound: False
tokens len after push: 1
manual inside: _cv_request is ctx2: True | _cv_app bound: True
manual inside: session m = mv
tokens len after pop: 0
manual after pop: _cv_request bound: False | _cv_app bound: False
```

Raw-greenlet `ContextVar` semantics in this environment (greenlet 3.2.3), with default `gr_context=None`:

```
greenlet version: 3.2.3
B parent before switch: before-creation
  B child sees v: unset
B parent after switch: before-creation
A parent before switch: after-creation-before-switch
  A child sees v2: unset
A parent after switch: after-creation-before-switch
D child sees v3: parent-value
D parent after switch: parent-value
```

That is: a fresh greenlet does not inherit the parent's `ContextVar` bindings by default (child reads `"unset"`), and a value set inside the greenlet is not visible to the parent afterwards; with an explicit `gr_context=contextvars.copy_context()` the child *does* see a snapshot. This matches the code's assumption that a greenlet starts with `_cv_request`/`_cv_app` unbound, and it is why the decorator must explicitly push the copy.

The full suite also passes (489 tests):

```
COMMAND: PYTHONPATH="$(pwd)/src" .venv/Scripts/python.exe -m pytest
```
```
tests\test_appctx.py ..............                                      [  2%]
tests\test_async.py ........                                             [  4%]
tests\test_basic.py .................................................... [ 15%]
...
tests\test_reqctx.py ..............                                      [ 81%]
...
============================= 489 passed in 6.43s =============================
EXIT=0
```

---

## 5. What is *not* preserved / what to be careful about

- **The request object is shared by reference, not deep-copied.** A greenlet is a valid destination; a different *thread* is not, unless access to the request object is locked. From the `copy` docstring: *"Because the actual request object is the same this cannot be used to move a request context to a different thread unless access to the request object is locked."*
- **`g` and the app context are not copied.** `copy()` passes only `app`, `environ`, `request`, `session`; `push()` builds a fresh `AppContext` (and therefore a fresh `g`) in the greenlet. `docs/appcontext.rst`: *"The ``g`` name stands for "global", but that is referring to the data being global *within a context*. The data on ``g`` is lost after the context ends..."*
- **Teardown runs for the copy.** Because the copy is pushed exactly once, `clear_request = len(self._cv_tokens) == 1` is true on its pop, so `do_teardown_request` fires and the request is closed when the `with ctx:` block exits. The original context is unaffected (own tokens).
- **Do not conflate the two cross-boundary helpers.** `copy_current_request_context` **copies** the context and shares `request`/`session` objects; `stream_with_context` **reuses the same context object** across generator resumption and does not copy anything. `src/flask/helpers.py`:

```python
    def generator() -> t.Iterator[t.AnyStr | None]:
        ctx = _cv_request.get(None)
        if ctx is None:
            raise RuntimeError(
                "'stream_with_context' can only be used when a request"
                " context is active, such as in a view function."
            )
        with ctx:
            # Dummy sentinel.  Has to be inside the context block or we're
            # not actually keeping the context around.
            yield None

            # The try/finally is here so that if someone passes a WSGI level
            # iterator in we're still running the cleanup logic.  Generators
            # don't need that because they are closed on their destruction
            # automatically.
            try:
                yield from gen
            finally:
                if hasattr(gen, "close"):
                    gen.close()

    # The trick is to start the generator.  Then the code execution runs until
    # the first dummy None is yielded at which point the context was already
    # pushed.  This item is discarded.  Then when the iteration continues the
    # real generator is executed.
    wrapped_g = generator()
    next(wrapped_g)
    return wrapped_g  # type: ignore[return-value]
```

  Note `ctx = _cv_request.get(None)` (no `.copy()`) then `with ctx:` — and this is precisely why `push()` must not re-open a session on a second push. Its sibling test, `tests/test_helpers.py::TestStreaming::test_stream_keeps_session`, covers the same "session survives the boundary" property by the shared-context route:

```python
    def test_stream_keeps_session(self, app, client):
        @app.route("/")
        def index():
            flask.session["test"] = "flask"

            @flask.stream_with_context
            def gen():
                yield flask.session["test"]

            return flask.Response(gen())

        rv = client.get("/")
        assert rv.data == b"flask"
```

- **Stacking is resolved by tokens.** `tests/test_testing.py::test_client_pop_all_preserved` asserts that after nested pushes are unwound, `_cv_request.get(None) is req_ctx` — i.e. each `pop` restores exactly the previous binding, which is the property the decorator's `with ctx:` relies on:

```python
def test_client_pop_all_preserved(app, req_ctx, client):
    @app.route("/")
    def index():
        # stream_with_context pushes a third context, preserved by response
        return flask.stream_with_context("hello")

    # req_ctx fixture pushed an initial context
    with client:
        # request pushes a second request context, preserved by client
        rv = client.get("/")

    # close the response, releasing the context held by stream_with_context
    rv.close()
    # only req_ctx fixture should still be pushed
    assert _cv_request.get(None) is req_ctx
```

- **Documented API surface.** `docs/api.rst` registers it (`.. autofunction:: copy_current_request_context`) alongside `has_request_context` and `has_app_context`, and `docs/patterns/streaming.rst` documents the generator-side counterpart: *"The :data:`~flask.request` will not be active while the generator is running… If your generator function relies on data in `request`, use the :func:`~flask.stream_with_context` wrapper."*

---

## 6. Quarantined material (explicitly **not** evidence for this question)

The working directory contains `flask_mut2_i417ar2x/mutated_test.py`, which is listed as failing in `.pytest_cache/v/cache/lastfailed`:

```json
{
  "examples/javascript/tests": true,
  "examples/tutorial/tests": true,
  "flask_mut2_i417ar2x/mutated_test.py": true
}
```

The file is entirely about **subdomain matching / `url_for`**, and contains **zero** references to `copy_current_request_context`, `request_ctx.copy()`, `greenlet`, `session`, or `_cv_tokens`:

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

It fails with an unrelated 404 at collection:

```
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
```

This has no bearing on the decorator or on context isolation/session preservation, and it is not evidence either way. Likewise, a repo-wide grep for mutation markers (`mutat|MUTAT|sabotage|BUG`, excluding `uv.lock`) found no mutation markers in `src/flask/`, and every quoted source fragment above was re-read from this worktree and matches its stated behaviour. **The answer above therefore describes the decorator as Flask actually implements it, with no invented defect.**

---

## 7. Condensed answer to the question

`flask.copy_current_request_context` (`src/flask/ctx.py`) works on two orthogonal mechanisms:

**Isolation of lightweight concurrent execution contexts.** Flask binds the active request and app contexts in `ContextVar`s (`_cv_request`, `_cv_app` in `src/flask/globals.py`), exposed through Werkzeug `LocalProxy` globals (`request`, `session`, `request_ctx`, `current_app`, `g`, `app_ctx`). Each execution context — a thread or a greenlet — has its own view of those variables, so a greenlet sees no request context at all until one is pushed for it. At *decoration* time the decorator reads `_cv_request.get(None)`, raises `RuntimeError` if there is none, and stores `ctx = ctx.copy()` in the closure. That copy is a **distinct `RequestContext` instance with its own `_cv_tokens` list**. On every call, `wrapper` executes `with ctx:` → `push()` does `self._cv_tokens.append((_cv_request.set(self), app_ctx))` (a `set` in *this* execution context, token stored privately) and `pop()` does `_cv_request.reset(token)` (which restores the previous binding exactly, i.e. typically "unbound"), plus `app_ctx.pop()` for the app context it created. That set/reset pair plus the per-instance token stack is the whole isolation story: reversible, per-execution-context, and non-interfering with the original context in the outer scope. A fresh `AppContext` (and therefore a fresh `g`) is created inside the greenlet because `_cv_app.get(None)` is `None` there. Cross-*thread* isolation of the shared `request` object is explicitly not provided (locking required).

**Preserving session data across the boundary.** `RequestContext.copy()` returns `self.__class__(self.app, environ=self.request.environ, request=self.request, session=self.session)` — the **same** request object and the **same live session object** by reference (`versionchanged:: 1.1`: *"The current session object is used instead of reloading the original data. This prevents `flask.session` pointing to an out-of-date object."*). Correspondingly, `push()` only calls `session_interface.open_session(...)` `if self.session is None:`, so for an already-populated copy no reload happens (*"Only open a new session if this is the first time the request was pushed, otherwise stream_with_context loses the session"*). Session mutations made in the view (`session["fizz"] = "buzz"`) are therefore directly visible inside the greenlet's decorated function, and the URL is re-matched (`match_request()`) after the session is ensured so custom converters see it. When the `with ctx:` block exits, the copy — pushed exactly once — runs `do_teardown_request` and closes the request, while the original context in the outer execution context keeps its own tokens and is unaffected.

The maintainers' own tests (`tests/test_reqctx.py::TestGreenletContextCopying`) assert precisely this combination — `not flask.request` before and after the manual `with reqctx:` block and `flask.request` immediately inside the decorated function, with `flask.session.get("fizz") == "buzz"` in both — and both tests **pass** (`2 passed, 12 deselected in 0.11s`) in this worktree when run against this worktree's `src` with `greenlet 3.2.3` and `pytest 8.4.0`; the entire suite of 489 tests passes as well.
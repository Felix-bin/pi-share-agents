# Where the `open_session` ⇄ `save_session` orchestration lives in the request flow — and what actually handles concurrency

## Answer in one paragraph

The two methods are not orchestrated by each other and there is **no concurrency-control mechanism anywhere in the request flow**. The load (`SessionInterface.open_session`) is called from `RequestContext.push` at **`src/flask/ctx.py:386`**; the persist (`SessionInterface.save_session`) is called from `Flask.process_response` at **`src/flask/app.py:1322`**. The "orchestration" between them is nothing more than the plain, per-request call stack inside `Flask.wsgi_app` (`src/flask/app.py:1479-1527`): `ctx.push()` at line 1510 → `self.full_dispatch_request()` at line 1511 → `ctx.pop(error)` at line 1527 in the `finally` block. Concurrent requests are handled *not* by a lock, mutex, retry, re-read, version check or merge — there is none of that in `src/flask` — but by (a) per-request context isolation via `contextvars` + `LocalProxy` (each in-flight request owns its own `RequestContext`, hence its own session object), and (b) an explicit written hand-off of any synchronization to whoever *implements* the `SessionInterface`, with the framework stating it gives **no guarantee on the order** in which sessions are opened or saved. So the question's premise — that this orchestration exists "to handle concurrent requests with potential race conditions" — is false as stated; the correct finding is the negative one, documented below with verbatim evidence.

---

## 1. Call site #1 — the load: `RequestContext.push`, `src/flask/ctx.py:380-389` (call at `:386`)

`RequestContext.push` is the method that runs at request start. The session-opening block is, verbatim (verified fresh from the file):

```python
        # Open the session at the moment that the request context is available.
        # This allows a custom open_session method to use the request context.
        # Only open a new session if this is the first time the request was
        # pushed, otherwise stream_with_context loses the session.
        if self.session is None:
            session_interface = self.app.session_interface
            self.session = session_interface.open_session(self.app, self.request)

            if self.session is None:
                self.session = session_interface.make_null_session(self.app)
```

Line anchors as verified in this working directory: the `if self.session is None:` guard is `ctx.py:384`; the load call `session_interface.open_session(...)` is **`ctx.py:386`**; the null-session fallback is `ctx.py:389`. The method continues immediately into URL matching:

```python
        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
        if self.url_adapter is not None:
            self.match_request()
```

Three ordering facts follow from this block and are load-bearing for any correct answer:

1. The **app context is pushed before** the session is opened (the `app_ctx` push precedes the line-386 call in the same method).
2. `open_session` runs **before URL matching** (`match_request()` is called after it), so `request.endpoint` is `None` inside a naive `open_session`.
3. `open_session` is **skipped entirely if a session already exists** on the context — the guard at `:384`. This is the branch that makes re-entry paths (`stream_with_context`, `copy_current_request_context`) reuse one session instead of loading a second one.

The full method, verbatim:

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

The **end-of-request context method does not save the session**. `RequestContext.pop` (`src/flask/ctx.py:396-440`) only runs teardown and resets the context var — there is no `save_session` in it. Verbatim:

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

This is an important negative: the persist is **not** the mirror of the load on the same object. It happens earlier, inside response finalization.

---

## 2. Call site #2 — the persist: `Flask.process_response`, `src/flask/app.py:1298-1324` (call at `:1322`)

The session is saved at the very end of response processing, verbatim:

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

Line anchors: the `is_null_session` guard is **`app.py:1321`**; the persist call `self.session_interface.save_session(self, ctx.session, response)` is **`app.py:1322`**. Ordering facts proven by this method: the `after_this_request` functions (`ctx._after_request_functions`) run first, then the `after_request` functions (reverse registration order, blueprint chain), and **only then** is the session saved. The save is skipped when `is_null_session()` is true.

How `process_response` is reached — `full_dispatch_request` → `finalize_request` (`src/flask/app.py:904-948`), verbatim:

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

So the **persist runs before the `request_finished` signal** and before the context is popped. This is why the save is *not* in `pop`.

### The error path also persists

When the view raises, `handle_exception` routes back through `finalize_request(..., from_error_handler=True)` — the call is at **`src/flask/app.py:862`**. Verbatim (tail of `handle_exception`):

```python
        self.log_exception(exc_info)
        server_error: InternalServerError | ft.ResponseReturnValue
        server_error = InternalServerError(original_exception=e)
        handler = self._find_error_handler(server_error, request.blueprints)

        if handler is not None:
            server_error = self.ensure_sync(handler)(server_error)

        return self.finalize_request(server_error, from_error_handler=True)
```

So a 500 response still passes through `process_response` and still reaches `save_session` (`app.py:1322`).

---

## 3. Where the two call sites are actually coupled: `Flask.wsgi_app`, `src/flask/app.py:1479-1527`

The only place in the framework that sequences the load and the persist together is the WSGI entry point. Verbatim body (line numbers as verified in this copy):

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

Verified line anchors in this working directory: `ctx.push()` is **`app.py:1510`**, `response = self.full_dispatch_request()` is **`app.py:1511`**, and `ctx.pop(error)` is **`app.py:1527`**; `wsgi_app` spans **1479-1527**. (Note: the earlier plan draft said 1501/1502/1522 — the executor's independent `nl`-based verification found the actual values above, and I re-read the region to confirm them. Likewise `globals.py`'s `session` proxy is at **`:49-51`**, not `:44-48`, and helpers' re-entry `with ctx:` is at **`helpers.py:115`**; and `preprocess_request` is at **`app.py:1271`**, not `:1266`. No session-relevant anchor was affected: `ctx.py:386` and `app.py:1322` are confirmed as stated.)

And `Flask.__call__` just forwards to it (`src/flask/app.py:1529-1536`):

```python
    def __call__(
        self, environ: WSGIEnvironment, start_response: StartResponse
    ) -> cabc.Iterable[bytes]:
        """The WSGI server calls the Flask application object as the
        WSGI application. This calls :meth:`wsgi_app`, which can be
        wrapped to apply middleware.
        """
        return self.wsgi_app(environ, start_response)
```

**This `try/finally` stack — not any session-specific coordination code — is the entirety of the "orchestration".** It is a per-request, per-context sequence with no shared state and no synchronization primitive.

### Full static call chain (for the normal and the error path)

```
Flask.__call__ (app.py:1529) → Flask.wsgi_app (app.py:1479)
  ├─ ctx.push() (app.py:1510)              ──────────► RequestContext.push (ctx.py:367)
  │                                                        ├─ app_ctx.push()
  │                                                        └─ ▶ session_interface.open_session(...)   ← LOAD, ctx.py:386
  │                                                           (fallback: make_null_session, ctx.py:389)
  │                                                           (then match_request(), ctx.py:391-394)
  └─ full_dispatch_request() (app.py:1511) ──────────► request_started → preprocess_request
                                                          → dispatch_request (view)
                                                          → finalize_request (app.py:922)
                                                              ├─ process_response (app.py:1298)
                                                              │     ├─ after_this_request funcs
                                                              │     ├─ after_request funcs
                                                              │     └─ ▶ save_session(...)             ← PERSIST, app.py:1322
                                                              │            (guarded by is_null_session, app.py:1321)
                                                              └─ request_finished.send(...)
  error path: except → handle_exception (app.py:811)
                  → finalize_request(server_error, from_error_handler=True) (app.py:862)
                  → process_response → save_session (app.py:1322)
  finally: ctx.pop(error) (app.py:1527)   ──────────► do_teardown_request → request_tearing_down
```

Ordering constraints to state precisely:

- **Load**: after the app context is pushed, **before URL matching**.
- **Persist**: **after** `after_this_request` and `after_request`; **before** the `request_finished` signal; **before** `ctx.pop()`/teardown; it is the response-processing step inside `finalize_request`, not the context-popping step.
- On the error path both still occur, in the same order (`open_session` … `save_session`).

The framework's own `SessionInterface` contract docstrings (`src/flask/sessions.py:263-288`) state exactly this:

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

    def save_session(
        self, app: Flask, session: SessionMixin, response: Response
    ) -> None:
        """This is called at the end of each request, after generating
        a response, before removing the request context. It is skipped
        if :meth:`is_null_session` returns ``True``.
        """
        raise NotImplementedError()
```

And the narrative lifecycle in `docs/lifecycle.rst` places them as steps (open in "How a Request is Handled", save later in the same list):

```text
#.  The :doc:`request context <reqcontext>` is pushed, which makes :attr:`.request` and
    :class:`.session` available.
#.  The session is opened, loading any existing session data using the app's
    :attr:`~.Flask.session_interface`, an instance of :class:`.SessionInterface`.
#.  The URL is matched against the URL rules registered with the :meth:`~.Flask.route`
    decorator during application setup. If there is no match, the error - usually a 404,
    405, or redirect - is stored to be handled later.
```

```text
#.  Any :func:`~.after_this_request` decorated functions are called, then cleared.
#.  Any :meth:`~.Flask.after_request` decorated functions are called, which can modify
    the response object.
#.  The session is saved, persisting any modified session data using the app's
    :attr:`~.Flask.session_interface`.
#.  The :data:`.request_finished` signal is sent.
```

(The load step is `docs/lifecycle.rst:127`; the save step is `docs/lifecycle.rst:147`, verified by grep.)

---

## 4. The concurrency half of the question: there is no race-handling orchestration in Flask

### 4a. The only concurrency statement in the framework — `src/flask/sessions.py:141-146`

Verbatim, and it is a docstring **addressed to implementers**, not code:

```python
    Multiple requests with the same session may be sent and handled
    concurrently. When implementing a new session interface, consider
    whether reads or writes to the backing store must be synchronized.
    There is no guarantee on the order in which the session for each
    request is opened or saved, it will occur in the order that requests
    begin and end processing.
```

In full context (`src/flask/sessions.py:114-149`):

```python
class SessionInterface:
    """The basic interface you have to implement in order to replace the
    default session interface which uses werkzeug's securecookie
    implementation.  The only methods you have to implement are
    :meth:`open_session` and :meth:`save_session`, the others have
    useful defaults which you don't need to change.

    The session object returned by the :meth:`open_session` method has to
    provide a dictionary like interface plus the properties and methods
    from the :class:`SessionMixin`.  We recommend just subclassing a dict
    and adding that mixin::

        class Session(dict, SessionMixin):
            pass

    If :meth:`open_session` returns ``None`` Flask will call into
    :meth:`make_null_session` to create a session that acts as replacement
    if the session support cannot work because some requirement is not
    fulfilled.  The default :class:`NullSession` class that is created
    will complain that the secret key was not set.

    To replace the session interface on an application all you have to do
    is to assign :attr:`flask.Flask.session_interface`::

        app = Flask(__name__)
        app.session_interface = MySessionInterface()

    Multiple requests with the same session may be sent and handled
    concurrently. When implementing a new session interface, consider
    whether reads or writes to the backing store must be synchronized.
    There is no guarantee on the order in which the session for each
    request is opened or saved, it will occur in the order that requests
    begin and end processing.

    .. versionadded:: 0.8
    """
```

This one paragraph does all the framework ever does about the race: it names the hazard, disclaims any ordering guarantee, and delegates synchronization to the interface implementation. **Flask performs no synchronization; the session interface implementation is responsible for it.**

### 4b. Exhaustive negative search

A case-insensitive search for `lock|threading|concurren|race|mutex|synchron` across `src/flask` returns only two session-relevant hits:

- `src/flask/sessions.py:142-143` — the docstring quoted above.
- `src/flask/ctx.py:342` — the word "locked" inside `RequestContext.copy`'s docstring, which is a *caveat about moving a context to another thread*, not an implemented lock:

```python
    def copy(self) -> RequestContext:
        """Creates a copy of this request context with the same request object.
        This can be used to move a request context to a different greenlet.
        Because the actual request object is the same this cannot be used to
        move a request context to a different thread unless access to the
        request object is locked.
        ...
        """
        return self.__class__(
            self.app,
            environ=self.request.environ,
            request=self.request,
            session=self.session,
        )
```

All other matches are unrelated (`TracebackType`, `code-block`, CLI help text). There is **no lock, mutex, retry, re-read, version check, compare-and-swap, or merge** in `src/flask` related to sessions. A search for `open_session|save_session|session_interface|is_null_session|make_null_session` across `src/flask` yields exactly `app.py:224`, `app.py:1321-1322`, `ctx.py:381,385,386,389`, the `sessions.py` interface + default implementation, `json/tag.py:41`, and `testing.py:165,173,177` — i.e. **no third call site in the production request path**.

### 4c. What actually prevents races *within one process*: per-request context isolation

Each in-flight request pushes its own `RequestContext`, and the session lives on that context instance (`src/flask/ctx.py:309-335`):

```python
        self.session: SessionMixin | None = session
```

and `session` is a `LocalProxy` over the request context var (`src/flask/globals.py:42-51`, verified):

```python
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

`docs/reqcontext.rst` states the isolation model:

```text
When the :class:`Flask` application handles a request, it creates a
:class:`Request` object based on the environment it received from the
WSGI server. Because a *worker* (thread, process, or coroutine depending
on the server) handles only one request at a time, the request data can
be considered global to that worker during that request. Flask uses the
term *context local* for this.
```

```text
When a Flask application begins handling a request, it pushes a request
context, which also pushes an :doc:`app context </appcontext>`. When the
request ends it pops the request context then the application context.

The context is unique to each thread (or other worker type).
:data:`request` cannot be passed to another thread, the other thread has
a different context space and will not know about the request the parent
thread was pointing to.

Context locals are implemented using Python's :mod:`contextvars` and
Werkzeug's :class:`~werkzeug.local.LocalProxy`. Python manages the
lifetime of context vars automatically, and local proxy wraps that
low-level interface to make the data easier to work with.
```

Consequence: two concurrent requests never share an in-process session object, so there is no in-memory race to guard inside `push`/`process_response`. The race the docstring warns about is the **shared backing store** (a database, Redis, a cookie round-trip against the client, a file), which the framework does not and cannot mediate.

### 4d. What the default backend does: last-write-wins cookies, no merge

`Flask.session_interface` defaults to `SecureCookieSessionInterface` (`src/flask/app.py:224`):

```python
    session_interface: SessionInterface = SecureCookieSessionInterface()
```

Its load reads the session out of a request cookie, and its save serializes the whole session dict into one `Set-Cookie` header (`src/flask/sessions.py:337-397`):

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

    def save_session(
        self, app: Flask, session: SessionMixin, response: Response
    ) -> None:
        name = self.get_cookie_name(app)
        domain = self.get_cookie_domain(app)
        path = self.get_cookie_path(app)
        secure = self.get_cookie_secure(app)
        partitioned = self.get_cookie_partitioned(app)
        samesite = self.get_cookie_samesite(app)
        httponly = self.get_cookie_httponly(app)

        # Add a "Vary: Cookie" header if the session was accessed at all.
        if session.accessed:
            response.vary.add("Cookie")

        # If the session is modified to be empty, remove the cookie.
        # If the session is empty, return without setting the cookie.
        if not session:
            if session.modified:
                response.delete_cookie(
                    name,
                    domain=domain,
                    path=path,
                    secure=secure,
                    partitioned=partitioned,
                    samesite=samesite,
                    httponly=httponly,
                )
                response.vary.add("Cookie")

            return

        if not self.should_set_cookie(app, session):
            return

        expires = self.get_expiration_time(app, session)
        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
        response.set_cookie(
            name,
            val,
            expires=expires,
            httponly=httponly,
            domain=domain,
            path=path,
            secure=secure,
            partitioned=partitioned,
            samesite=samesite,
        )
        response.vary.add("Cookie")
```

There is no read-modify-write against a shared server-side store: the client's cookie is read once at `open_session` and the entire resulting `dict(session)` is written once at `save_session`. If two concurrent requests both modify the session, the framework has no merge step (and explicitly certifies no ordering guarantee), so the observable outcome is **last-write-wins at the cookie level** — a semantic that follows from the documented absence of ordering guarantees, not from any orchestration code.

---

## 5. Secondary pairings of the same two methods (so the answer is complete, not just the main path)

There are exactly three places where `open_session`/`save_session` are involved, and only the first is the production request flow.

### 5a. Production: `ctx.push` / `process_response` (covered above)

### 5b. Test-only manual pairing: `FlaskClient.session_transaction`, `src/flask/testing.py:136-183`

This is the *only* place that calls the two methods as an explicit pair around a block; it is a testing helper, not the request flow:

```python
    @contextmanager
    def session_transaction(
        self, *args: t.Any, **kwargs: t.Any
    ) -> t.Iterator[SessionMixin]:
        """When used in combination with a ``with`` statement this opens a
        session transaction.  This can be used to modify the session that
        the test client uses.  Once the ``with`` block is left the session is
        stored back.

        ::

            with client.session_transaction() as session:
                session['value'] = 42

        Internally this is implemented by going through a temporary test
        request context and since session handling could depend on
        request variables this function accepts the same arguments as
        :meth:`~flask.Flask.test_request_context` which are directly
        passed through.
        """
        if self._cookies is None:
            raise TypeError(
                "Cookies are disabled. Create a client with 'use_cookies=True'."
            )

        app = self.application
        ctx = app.test_request_context(*args, **kwargs)
        self._add_cookies_to_wsgi(ctx.request.environ)

        with ctx:
            sess = app.session_interface.open_session(app, ctx.request)

        if sess is None:
            raise RuntimeError("Session backend did not open a session.")

        yield sess
        resp = app.response_class()

        if app.session_interface.is_null_session(sess):
            return

        with ctx:
            app.session_interface.save_session(app, sess, resp)

        self._update_cookies_from_response(
            ctx.request.host.partition(":")[0],
            ctx.request.path,
            resp.headers.getlist("Set-Cookie"),
        )
```

(`open_session` at `testing.py:165`, the `is_null_session` guard at `:173`, `save_session` at `:177`.)

### 5c. Re-entry paths that reuse the already-open session instead of reloading

`copy_current_request_context` (`src/flask/ctx.py:155-196`) copies the context *including the session* and re-pushes it:

```python
    ctx = ctx.copy()

    def wrapper(*args: t.Any, **kwargs: t.Any) -> t.Any:
        with ctx:
            return ctx.app.ensure_sync(f)(*args, **kwargs)

    return update_wrapper(wrapper, f)  # type: ignore[return-value]
```

`RequestContext.copy` passes `session=self.session`, and `RequestContext.__enter__` calls `push()` again — but the guard at `ctx.py:384` (`if self.session is None:`) means `open_session` is **not** called a second time:

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

The same applies to `stream_with_context` (`src/flask/helpers.py:108-133`), whose generator re-enters via `with ctx:` at `helpers.py:115`:

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
```

These are the "only open a new session if this is the first time the request was pushed" cases the comment at `ctx.py:382-383` describes. They are still per-request; they do not introduce cross-request coordination.

### 5d. The guard that makes save a no-op for null sessions

`src/flask/sessions.py:176-183`:

```python
    def is_null_session(self, obj: object) -> bool:
        """Checks if a given object is a null session.  Null sessions are
        not asked to be saved.

        This checks if the object is an instance of :attr:`null_session_class`
        by default.
        """
        return isinstance(obj, self.null_session_class)
```

---

## 6. Runtime verification performed (executed, not asserted)

Environment caveat: the bundled virtualenv's editable install points at a **different copy of the framework source tree**, so all runs bind this working directory explicitly with `PYTHONPATH=src`. Git state was checked and the tracked source is unmodified (`git diff` empty; HEAD `85c5d93c`), so line numbers are stable and the only line-number discrepancies were in the earlier plan draft, not in the files.

Targeted tests (the two tests that exercise the load/persist call sites):

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_session_interface.py tests/test_reqctx.py -q
...............                                                          [100%]
15 passed in 0.21s
EXIT=0
```

Full suite:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests -q
489 passed in 6.24s
EXIT=0
```

A throwaway probe (subclassed `SessionInterface` printing from `open_session`/`save_session`, plus `before_request`, `after_request`, view, `request_finished`, `teardown_request`) observed the exact ordering claimed above; the probe script was deleted afterwards:

```
$ PYTHONPATH=src .venv/Scripts/python.exe /tmp/flow_probe.py
status: 200
EVENT ORDER: ['open_session', 'before_request', 'view', 'after_request', 'save_session', 'request_finished', 'teardown_request', 'request_tearing_down']
EXIT=0
```

Error-path probe (view raises → 500); note `endpoint=None` inside `open_session`, proving the load precedes URL matching, and that `save_session` still runs:

```
$ PYTHONPATH=src .venv/Scripts/python.exe /tmp/flow_probe2.py
ERROR in app: Exception on /boom [GET]
Traceback (most recent call last):
  File ".../seal/src/flask/app.py", line 1511, in wsgi_app
    response = self.full_dispatch_request()
  ...
  File ".../seal/src/flask/app.py", line 919, in full_dispatch_request
    rv = self.handle_user_exception(e)
  ...
status: 500
EVENTS: [('open_session', 'endpoint=None'), 'save_session']
EXIT=0
```

The verbose full-suite run's captured logs show the same chain directly from the test that makes `open_session` raise:

```
ERROR test_reqctx:app.py:875 Exception on / [GET]
  File ".../seal/src/flask/app.py", line 1510, in wsgi_app
    ctx.push()
  File ".../seal/src/flask/ctx.py", line 386, in push
    self.session = session_interface.open_session(self.app, self.request)
  File ".../tests/test_reqctx.py", line 211, in open_session
    raise SessionError()
...
  File ".../seal/src/flask/app.py", line 1322, in process_response
    self.session_interface.save_session(self, ctx.session, response)
  File ".../seal/src/flask/sessions.py", line 284, in save_session
    raise NotImplementedError()
```

Two in-repo tests corroborate the two ordering constraints:

`tests/test_session_interface.py` (whole file) proves `open_session` normally runs before URL matching, so `request.endpoint` is `None` there unless forced:

```python
import flask
from flask.globals import request_ctx
from flask.sessions import SessionInterface


def test_open_session_with_endpoint():
    """If request.endpoint (or other URL matching behavior) is needed
    while loading the session, RequestContext.match_request() can be
    called manually.
    """

    class MySessionInterface(SessionInterface):
        def save_session(self, app, session, response):
            pass

        def open_session(self, app, request):
            request_ctx.match_request()
            assert request.endpoint is not None

    app = flask.Flask(__name__)
    app.session_interface = MySessionInterface()

    @app.get("/")
    def index():
        return "Hello, World!"

    response = app.test_client().get("/")
    assert response.status_code == 200
```

`tests/test_reqctx.py` proves a failing `open_session` (raised from inside `ctx.push()`) still unwinds through `wsgi_app`'s `finally`/`pop` path, leaving no dangling context:

```python
def test_session_error_pops_context():
    class SessionError(Exception):
        pass

    class FailingSessionInterface(SessionInterface):
        def open_session(self, app, request):
            raise SessionError()

    class CustomFlask(flask.Flask):
        session_interface = FailingSessionInterface()

    app = CustomFlask(__name__)

    @app.route("/")
    def index():
        # shouldn't get here
        AssertionError()

    response = app.test_client().get("/")
    assert response.status_code == 500
    assert not flask.request
    assert not flask.current_app
```

---

## 7. Direct answer, stated precisely

- **Where is the load?** `RequestContext.push`, inside `Flask.wsgi_app`'s `try` block, at **`src/flask/ctx.py:386`** (`ctx.push()` at `src/flask/app.py:1510`). It runs after the app context is pushed and **before URL matching**.
- **Where is the persist?** `Flask.process_response`, at **`src/flask/app.py:1322`** (guarded by `is_null_session` at `:1321`), reached via `full_dispatch_request` (`app.py:904`, called at `:1511`) → `finalize_request` (`app.py:922`) → `process_response` (`app.py:1298`), and on the error path via `handle_exception` → `finalize_request(..., from_error_handler=True)` (`app.py:862`). It runs **after** `after_request`/`after_this_request` and **before** `request_finished` and before `ctx.pop(error)` (`app.py:1527`).
- **Where is the "orchestration" between them?** Only in `Flask.wsgi_app` (`src/flask/app.py:1479-1527`): `ctx.push()` → `full_dispatch_request()` → `ctx.pop(error)`. A plain per-request call stack. `RequestContext.pop` (`ctx.py:396-440`) does not save; the save already happened in `process_response`.
- **What handles concurrent requests and race conditions?** Nothing in `src/flask` in the sense of locks/retries/merges — there is no such code. Concurrent requests are isolated per request context (`RequestContext` per push; `flask.session` is a `LocalProxy` over the `_cv_request` `ContextVar`, `src/flask/globals.py:49-51`), and any race on a *shared backing store* is explicitly delegated to the `SessionInterface` implementation, with the framework promising no ordering. The exact words (`src/flask/sessions.py:141-146`): *"Multiple requests with the same session may be sent and handled concurrently. When implementing a new session interface, consider whether reads or writes to the backing store must be synchronized. There is no guarantee on the order in which the session for each request is opened or saved, it will occur in the order that requests begin and end processing."*

**Do not** answer this question with a lock in `push`/`pop`, a mutex around the session, a re-read/merge in `save_session`, or a version check: none exist here. The accurate finding is that the load/persist pair is sequenced only by the WSGI stack, per-request state is isolated, and synchronization is the session interface implementation's responsibility — the framework defers it, it does not perform it.
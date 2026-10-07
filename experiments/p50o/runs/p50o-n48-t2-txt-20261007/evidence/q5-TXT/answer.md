# How `flask.g` (the `_AppCtxGlobals` namespace) achieves thread-safety and context isolation via `contextvars`

## 0. Answer in one line

The namespace object is **`flask.ctx._AppCtxGlobals`**, exposed publicly as the **`flask.g`** proxy. It contains **no lock, no thread-local storage, and no shared mutable state** — every storage operation is a plain `self.__dict__` operation. Safety is therefore **isolation, not mutual exclusion**: `g` is a Werkzeug `LocalProxy` over the module-level `ContextVar` `_cv_app`, each `AppContext` constructs its **own** `_AppCtxGlobals` instance, and `AppContext.push()`/`pop()` bind/unbind that context with `_cv_app.set(self)` / `_cv_app.reset(token)`. Because a `ContextVar` has **no value in a context that never set it**, two threads/tasks/greenlets each resolve `g` to a different `_AppCtxGlobals` (or to the `RuntimeError` "Working outside of application context" if they never pushed one) and cannot observe or clobber each other.

The proof chain below is: (1) the storage class, (2) the per-context instance and the `ContextVar` set/reset, (3) the proxy resolution path, (4) the framework's own documented semantics, (5) the in-repo tests, (6) executed test runs, (7) an executed 4-part concurrency/isolation demo, (8) negative evidence (no locks anywhere), (9) caveats/limits.

---

## 1. What the object is

`src/flask/ctx.py` — the class, in full:

```python
class _AppCtxGlobals:
    """A plain object. Used as a namespace for storing data during an
    application context.

    Creating an app context automatically creates this object, which is
    made available as the :data:`g` proxy.

    .. describe:: 'key' in g

        Check whether an attribute is present.

        .. versionadded:: 0.10

    .. describe:: iter(g)

        Return an iterator over the attribute names.

        .. versionadded:: 0.10
    """

    # Define attr methods to let mypy know this is a namespace object
    # that has arbitrary attributes.

    def __getattr__(self, name: str) -> t.Any:
        try:
            return self.__dict__[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name: str, value: t.Any) -> None:
        self.__dict__[name] = value

    def __delattr__(self, name: str) -> None:
        try:
            del self.__dict__[name]
        except KeyError:
            raise AttributeError(name) from None

    def get(self, name: str, default: t.Any | None = None) -> t.Any:
        """Get an attribute by name, or a default value. Like
        :meth:`dict.get`.

        :param name: Name of attribute to get.
        :param default: Value to return if the attribute is not present.

        .. versionadded:: 0.10
        """
        return self.__dict__.get(name, default)

    def pop(self, name: str, default: t.Any = _sentinel) -> t.Any:
        """Get and remove an attribute by name. Like :meth:`dict.pop`.

        :param name: Name of attribute to pop.
        :param default: Value to return if the attribute is not present,
            instead of raising a ``KeyError``.

        .. versionadded:: 0.11
        """
        if default is _sentinel:
            return self.__dict__.pop(name)
        else:
            return self.__dict__.pop(name, default)

    def setdefault(self, name: str, default: t.Any = None) -> t.Any:
        """Get the value of an attribute if it is present, otherwise
        set and return a default value. Like :meth:`dict.setdefault`.

        :param name: Name of attribute to get.
        :param default: Value to set and return if the attribute is not
            present.

        .. versionadded:: 0.11
        """
        return self.__dict__.setdefault(name, default)

    def __contains__(self, item: str) -> bool:
        return item in self.__dict__

    def __iter__(self) -> t.Iterator[str]:
        return iter(self.__dict__)

    def __repr__(self) -> str:
        ctx = _cv_app.get(None)
        if ctx is not None:
            return f"<flask.g of '{ctx.app.name}'>"
        return object.__repr__(self)
```

Def line anchors: `__getattr__` 52, `__setattr__` 58, `__delattr__` 61, `get` 67, `pop` 78, `setdefault` 92, `__contains__` 104, `__iter__` 107, `__repr__` 110. Note that `__repr__` is the **only** method of this class that touches `_cv_app` — and it does so for *display only*. The storage methods touch nothing but `self.__dict__`.

**Key observation for the task's question:** isolation cannot come from this class. It contains no lock, no thread-local, no `ContextVar` of its own. It is a *plain object*, and the only thing that makes `g.foo` land on the right instance is **which `_AppCtxGlobals` instance the proxy resolves to**.

The class is also **pluggable**, which is why the docs describe `g` as "an instance of `Flask.app_ctx_globals_class`" rather than hardwired to `_AppCtxGlobals`. `src/flask/sansio/app.py` (with `from ..ctx import _AppCtxGlobals` imported at line 23):

```python
    #: The class that is used for the :data:`~flask.g` instance.
    #:
    #: Example use cases for a custom class:
    #:
    #: 1. Store arbitrary attributes on flask.g.
    #: 2. Add a property for lazy per-request database connectors.
    #: 3. Return None instead of AttributeError on unexpected attributes.
    #: 4. Raise exception if an unexpected attr is set, a "controlled" flask.g.
    #:
    #: In Flask 0.9 this property was called `request_globals_class` but it
    #: was changed in 0.10 to :attr:`app_ctx_globals_class` because the
    #: flask.g object is now application context scoped.
    #:
    #: .. versionadded:: 0.10
    app_ctx_globals_class = _AppCtxGlobals
```

And `src/flask/__init__.py:5–12` shows the public export that makes `flask.g` available:

```python
from .ctx import after_this_request as after_this_request
from .ctx import copy_current_request_context as copy_current_request_context
from .ctx import has_app_context as has_app_context
from .ctx import has_request_context as has_request_context
from .globals import current_app as current_app
from .globals import g as g
from .globals import request as request
from .globals import session as session
```

---

## 2. One `g` per context, and the binding mechanism

### 2.1 The single `ContextVar`

`src/flask/globals.py` (entire file) — this is the complete wiring:

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

Line anchors: `_no_app_msg` 17–23, `_cv_app` 24, `g` proxy 31–33, `_cv_request` 42. So the **entire** state used to find the current namespace is one module-level `ContextVar[AppContext]` named `"flask.app_ctx"`.

### 2.2 `AppContext` creates the namespace and owns the tokens

`src/flask/ctx.py` — `AppContext` in full (lines 238–285; confirmed anchors: `self.g` at 248, `_cv_tokens` at 249, `push` at 251 with `set` at 253, `pop` at 256 with `get` 264 / `reset` 265, the wrong-context guard at 267–270):

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

The factory used by `with app.app_context()` — `src/flask/app.py`:

```python
    def app_context(self) -> AppContext:
        """Create an :class:`~flask.ctx.AppContext`. Use as a ``with``
        block to push the context, which will make :data:`current_app`
        point at this application.

        An application context is automatically pushed by
        :meth:`RequestContext.push() <flask.ctx.RequestContext.push>`
        when handling a request, and when running a CLI command. Use
        this to manually create a context outside of these situations.

        ::

            with app.app_context():
                init_db()

        See :doc:`/appcontext`.

        .. versionadded:: 0.9
        """
        return AppContext(self)
```

**`ContextVar` semantics that matter here** (stdlib `contextvars`):

- `ContextVar.set(value)` **returns a `Token`** and changes the value *only in the current `Context`* — i.e. only for the current thread/task/greenlet's logical execution context. Other contexts are untouched.
- `ContextVar.reset(token)` restores the value the var had before the corresponding `set` (and raises if the token has already been used). This is what makes contexts *stack*: `pop()` restores the previously pushed `AppContext` rather than clearing the var.
- `ContextVar.get()` raises **`LookupError`** if the var was never set **in this context** — the crucial property: a fresh thread/task starts with no value at all, so it cannot accidentally see another context's `AppContext`.
- Each OS thread starts with its own top-level `Context`; a greenlet/`asyncio` task likewise runs in its own `Context` (a task copies the context at creation). Values set inside a copied context are local to that copy and do not flow back out.

Note the design consequence: because `push()` uses `set` and keeps the returned token on the context object (`self._cv_tokens.append(...)`, a *list*, so repeated/nested pushes stack), and because `pop()` uses `reset`, an inner nested app context is fully restored on exit — the exact-instantiation case demonstrated in §7 Claim 2.

It is also worth noting the design change that produced this: `CHANGES.rst` (Flask 2.2.0, released 2022-08-01):

```rst
-   Update Werkzeug dependency to >= 2.2.
-   The app and request contexts are managed using Python context vars
    directly rather than Werkzeug's ``LocalStack``. This should result
    in better performance and memory use. :pr:`4682`

    -   Extension maintainers, be aware that ``_app_ctx_stack.top``
        and ``_request_ctx_stack.top`` are deprecated. Store data on
        ``g`` instead using a unique prefix, like
        ``_extension_name_attr``.
```

---

## 3. How a lookup resolves: `g.attr` → `ContextVar.get()` → `AppContext.g` → `__dict__`

`g` is literally:

```python
g: _AppCtxGlobals = LocalProxy(
    _cv_app, "g", unbound_message=_no_app_msg
)
```

The resolution lives in Werkzeug's `LocalProxy` (installed version 3.1.3). Its class docstring documents exactly this pattern:

```python
    Proxy a :class:`~contextvars.ContextVar` to make it easier to
    access. Pass a name to proxy that attribute.

    .. code-block:: python

        _request_var = ContextVar("request")
        request = LocalProxy(_request_var)
        session = LocalProxy(_request_var, "session")
```

and the `ContextVar` branch of `__init__` (`.venv/Lib/site-packages/werkzeug/local.py:478–523`; the `ContextVar` test is at line 513):

```python
    def __init__(
        self,
        local: ContextVar[T] | Local | LocalStack[T] | t.Callable[[], T],
        name: str | None = None,
        *,
        unbound_message: str | None = None,
    ) -> None:
        if name is None:
            get_name = _identity
        else:
            get_name = attrgetter(name)  # type: ignore[assignment]

        if unbound_message is None:
            unbound_message = "object is not bound"
        ...
        elif isinstance(local, ContextVar):

            def _get_current_object() -> T:
                try:
                    obj = local.get()
                except LookupError:
                    raise RuntimeError(unbound_message) from None

                return get_name(obj)
```

so the chain for `g.foo` is:

1. `g.foo` triggers `LocalProxy`'s `__getattr__` (`_ProxyLookup(getattr)`);
2. `_ProxyLookup.__get__` calls `instance._get_current_object()`:

```python
        try:
            obj = instance._get_current_object()
        except RuntimeError:
            if self.fallback is None:
                raise

            fallback = self.fallback.__get__(instance, owner)

            if self.is_attr:
                # __class__ and __doc__ are attributes, not methods.
                # Call the fallback to get the value.
                return fallback()

            return fallback

        if self.bind_f is not None:
            return self.bind_f(instance, obj)

        return getattr(obj, self.name)
```

3. `_get_current_object()` does `_cv_app.get()` (raising `LookupError` → `RuntimeError(_no_app_msg)` if this context never pushed an app context), then `attrgetter("g")(app_ctx)` — i.e. takes attribute `"g"` off the bound `AppContext`;
4. the resulting `_AppCtxGlobals` object is asked for `.foo`, which hits its `__getattr__` and returns `self.__dict__["foo"]`.

Nothing is cached between accesses: the proxy re-resolves the `ContextVar` on **every** attribute access, so it always reflects the currently-bound context. Unbound fallbacks (same file) also explain the observable unbound behaviors:

```python
    __wrapped__ = _ProxyLookup(
        fallback=lambda self: self._LocalProxy__wrapped,  # type: ignore[attr-defined]
        is_attr=True,
    )
    # __del__ should only delete the proxy
    __repr__ = _ProxyLookup(  # type: ignore[assignment]
        repr, fallback=lambda self: f"<{type(self).__name__} unbound>"
    )
    ...
    __bool__ = _ProxyLookup(bool, fallback=lambda self: False)
    __getattr__ = _ProxyLookup(getattr)
    # __getattribute__ triggered through __getattr__
    __setattr__ = _ProxyLookup(setattr)  # type: ignore[assignment]
    __delattr__ = _ProxyLookup(delattr)  # type: ignore[assignment]
    __dir__ = _ProxyLookup(dir, fallback=lambda self: [])  # type: ignore[assignment]
```

Hence with no app context: `repr(flask.g) == "<LocalProxy unbound>"`, `bool(flask.g) is False`, and `flask.g.attr` raises `RuntimeError("Working outside of application context....")`. Flask never implemented its own context-local lookup for `g` — it delegates to Werkzeug's `LocalProxy` + stdlib `contextvars`.

---

## 4. What the framework itself documents

`docs/appcontext.rst`, "Storing Data" — the lifetime and scoping statement:

```rst
Storing Data
------------

The application context is a good place to store common data during a
request or CLI command. Flask provides the :data:`g object <g>` for this
purpose. It is a simple namespace object that has the same lifetime as
an application context.

.. note::
    The ``g`` name stands for "global", but that is referring to the
    data being global *within a context*. The data on ``g`` is lost
    after the context ends, and it is not an appropriate place to store
    data between requests. Use the :data:`session` or a database to
    store data across requests.

A common use for :data:`g` is to manage resources during a request.

1.  ``get_X()`` creates resource ``X`` if it does not exist, caching it
    as ``g.X``.
2.  ``teardown_X()`` closes or otherwise deallocates the resource if it
    exists. It is registered as a :meth:`~Flask.teardown_appcontext`
    handler.
```

`docs/reqcontext.rst` — "the context is unique to each thread", and the implementation statement:

```rst
Purpose of the Context
----------------------

When the :class:`Flask` application handles a request, it creates a
:class:`Request` object based on the environment it received from the
WSGI server. Because a *worker* (thread, process, or coroutine depending
on the server) handles only one request at a time, the request data can
be considered global to that worker during that request. Flask uses the
term *context local* for this.

Flask automatically *pushes* a request context when handling a request.
View functions, error handlers, and other functions that run during a
request will have access to the :data:`request` proxy, which points to
the request object for the current request.


Lifetime of the Context
-----------------------

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

`docs/reqcontext.rst` — the stack semantics that `_cv_tokens` implements:

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
While this is not a common pattern, it can be used in advanced
applications to, for example, do internal redirects or chain different
applications together.
```

`docs/quickstart.rst` — "how that object can be global and how Flask manages to still be threadsafe. The answer is context locals":

```rst
For web applications it's crucial to react to the data a client sends to
the server.  In Flask this information is provided by the global
:class:`~flask.request` object.  If you have some experience with Python
you might be wondering how that object can be global and how Flask
manages to still be threadsafe.  The answer is context locals:
...
Imagine the context being the handling thread.  A request comes in and the
web server decides to spawn a new thread (or something else, the
underlying object is capable of dealing with concurrency systems other
than threads).  When Flask starts its internal request handling it
figures out that the current thread is the active context and binds the
current application and the WSGI environments to that context (thread).
It does that in an intelligent way so that one application can invoke another
application without breaking.
```

`docs/api.rst` — "Application Globals":

```rst
Application Globals
-------------------

.. currentmodule:: flask

To share data that is valid for one request only from one function to
another, a global variable is not good enough because it would break in
threaded environments. Flask provides you with a special object that
ensures it is only valid for the active request and that will return
different values for each request. In a nutshell: it does the right
thing, like it does for :class:`request` and :class:`session`.

.. data:: g

    A namespace object that can store data during an
    :doc:`application context </appcontext>`. This is an instance of
    :attr:`Flask.app_ctx_globals_class`, which defaults to
    :class:`ctx._AppCtxGlobals`.

    This is a good place to store resources during a request. For
    example, a ``before_request`` function could load a user object from
    a session id, then set ``g.user`` to be used in the view function.

    This is a proxy. See :ref:`notes-on-proxies` for more information.

    .. versionchanged:: 0.10
        Bound to the application context instead of the request context.

.. autoclass:: flask.ctx._AppCtxGlobals
    :members:
```

and `docs/api.rst:33–44`: "Internally Flask makes sure that you always get the correct data for the active thread if you are in a multithreaded environment. This is a proxy."

`docs/design.rst` — "Thread Locals":

```rst
Flask uses thread local objects (context local objects in fact, they
support greenlet contexts as well) for request, session and an extra
object you can put your own things on (:data:`~flask.g`).  Why is that and
isn't that a bad idea?

Yes it is usually not such a bright idea to use thread locals.  They cause
troubles for servers that are not based on the concept of threads and make
large applications harder to maintain.  However Flask is just not designed
for large applications or asynchronous servers.  Flask wants to make it
quick and easy to write a traditional web application.
```

`docs/lifecycle.rst` places `g`'s availability precisely at app-context push, and its disappearance at app-context pop:

```rst
#.  WSGI server calls the Flask object, which calls :meth:`.Flask.wsgi_app`.
#.  A :class:`.RequestContext` object is created. This converts the WSGI ``environ``
    dict into a :class:`.Request` object. It also creates an :class:`AppContext` object.
#.  The :doc:`app context <appcontext>` is pushed, which makes :data:`.current_app` and
    :data:`.g` available.
#.  The :data:`.appcontext_pushed` signal is sent.
...
#.  The request context is popped, :attr:`.request` and :class:`.session` are no longer
    available.
#.  Any :meth:`~.Flask.teardown_appcontext` decorated functions are called.
#.  The :data:`.appcontext_tearing_down` signal is sent.
#.  The app context is popped, :data:`.current_app` and :data:`.g` are no longer
    available.
#.  The :data:`.appcontext_popped` signal is sent.
```

Other corroborating docs: `docs/reqcontext.rst` "Notes On Proxies" ("The reference to the proxied object is needed in some situations, such as sending signals or passing data to a background thread."), `docs/signals.rst` ("Context-local variables are consistently available between `request_started` and `request_finished`, so you can rely on `flask.g` and others as needed."), `docs/testing.rst` ("The app and request context will remain active *after* making a request, until the `with` block ends."), and the deployment guides (`docs/deploying/gevent.rst`, `eventlet.rst`, `gunicorn.rst`, `uwsgi.rst`): "When using either gevent or eventlet, greenlet>=1.0 is required, otherwise context locals such as ``request`` will not work as expected."

The canonical usage pattern the docs teach (`docs/tutorial/database.rst`, "`g` is a special object that is unique for each request."):

```python
    def get_db():
        if 'db' not in g:
            g.db = sqlite3.connect(
                current_app.config['DATABASE'],
                detect_types=sqlite3.PARSE_DECLTYPES
            )
            g.db.row_factory = sqlite3.Row

        return g.db

    def close_db(e=None):
        db = g.pop('db', None)

        if db is not None:
            db.close()
```

Finally, `src/flask/views.py` documents why `g` — not an attribute on a reused view instance — is the safe place for per-context data:

```python
    #: instance is used for every request.
    #:
    #: A single instance is more efficient, especially if complex setup
    #: is done during init. However, storing data on ``self`` is no
    #: longer safe across requests, and :data:`~flask.g` should be used
    #: instead.
    #:
    #: .. versionadded:: 2.2
    init_every_request: t.ClassVar[bool] = True
```

---

## 5. In-repo tests that exercise the namespace and its isolation

`tests/test_appctx.py` — the namespace's full method surface, and the pluggable class:

```python
def test_app_ctx_globals_methods(app, app_ctx):
    # get
    assert flask.g.get("foo") is None
    assert flask.g.get("foo", "bar") == "bar"
    # __contains__
    assert "foo" not in flask.g
    flask.g.foo = "bar"
    assert "foo" in flask.g
    # setdefault
    flask.g.setdefault("bar", "the cake is a lie")
    flask.g.setdefault("bar", "hello world")
    assert flask.g.bar == "the cake is a lie"
    # pop
    assert flask.g.pop("bar") == "the cake is a lie"
    with pytest.raises(KeyError):
        flask.g.pop("bar")
    assert flask.g.pop("bar", "more cake") == "more cake"
    # __iter__
    assert list(flask.g) == ["foo"]
    # __repr__
    assert repr(flask.g) == "<flask.g of 'flask_test'>"


def test_custom_app_ctx_globals_class(app):
    class CustomRequestGlobals:
        def __init__(self):
            self.spam = "eggs"

    app.app_ctx_globals_class = CustomRequestGlobals
    with app.app_context():
        assert flask.render_template_string("{{ g.spam }}") == "eggs"


def test_request_context_means_app_context(app):
    with app.test_request_context():
        assert flask.current_app._get_current_object() is app
    assert not flask.current_app


def test_app_context_provides_current_app(app):
    with app.app_context():
        assert flask.current_app._get_current_object() is app
    assert not flask.current_app


def test_context_refcounts(app, client):
    called = []

    @app.teardown_request
    def teardown_req(error=None):
        called.append("request")

    @app.teardown_appcontext
    def teardown_app(error=None):
        called.append("app")

    @app.route("/")
    def index():
        with app_ctx:
            with request_ctx:
                pass

        assert flask.request.environ["werkzeug.request"] is not None
        return ""

    res = client.get("/")
    assert res.status_code == 200
    assert res.data == b""
    assert called == ["request", "app"]


def test_clean_pop(app):
    app.testing = False
    called = []

    @app.teardown_request
    def teardown_req(error=None):
        raise ZeroDivisionError

    @app.teardown_appcontext
    def teardown_app(error=None):
        called.append("TEARDOWN")

    with app.app_context():
        called.append(flask.current_app.name)

    assert called == ["flask_test", "TEARDOWN"]
    assert not flask.current_app
```

`test_context_refcounts` is what validates the token-stack bookkeeping (`with app_ctx: with request_ctx:` inside an already-pushed request must not tear down early), and `test_clean_pop` validates that an exception in `teardown_request` does not prevent the app-context teardown from running.

Unbound-proxy behavior — `tests/test_basic.py`:

```python
def test_request_locals():
    assert repr(flask.g) == "<LocalProxy unbound>"
    assert not flask.g
```

`g` surviving inside a `with client:` block, then unbinding — `tests/test_testing.py`:

```python
def test_test_client_context_binding(app, client):
    app.testing = False

    @app.route("/")
    def index():
        flask.g.value = 42
        return "Hello World!"

    @app.route("/other")
    def other():
        raise ZeroDivisionError

    with client:
        resp = client.get("/")
        assert flask.g.value == 42
        assert resp.data == b"Hello World!"
        assert resp.status_code == 200

    with client:
        resp = client.get("/other")
        assert not hasattr(flask.g, "value")
        assert b"Internal Server Error" in resp.data
        assert resp.status_code == 500
        flask.g.value = 23

    with pytest.raises(RuntimeError):
        flask.g.value  # noqa: B018
```

The only cross-context propagation coverage in the whole suite is the greenlet test — and it proves that a new greenlet must be **explicitly given a copied/pushed context**:

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

Note the assertions `assert not flask.request` / `assert not flask.current_app` *before* `with reqctx:` and after it: a greenlet that has not entered the copied context sees **nothing**. `tests/test_reqctx.py` guards this on greenlet availability:

```python
try:
    from greenlet import greenlet
except ImportError:
    greenlet = None
```

The explicit propagation helpers are `src/flask/ctx.py` `copy_current_request_context` (which does `ctx = _cv_request.get(None)` … `ctx = ctx.copy()` and then `with ctx:` inside the wrapper) and `RequestContext.copy()`, whose docstring carries the thread caveat quoted in §9.

Fixtures used by the `g` tests — `tests/conftest.py`:

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


@pytest.fixture
def client(app):
    return app.test_client()
```

---

## 6. Executed tests (raw output)

Environment: repo root `C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q5-TXT\seal`, Python 3.13.9, pytest 8.4.0, Werkzeug 3.1.3, Flask 3.2.0.dev0, greenlet 3.2.3 installed.

**Important environment override applied to every run** (revealed by inspection of `.venv/Lib/site-packages/flask.pth`, which points at a *different* worktree, `...\q8-SYN\seal\src`):

```
export PYTHONPATH="$PWD/src"
```

Every run below verified `flask.__file__ = C:\...\q5-TXT\seal\src\flask\__init__.py`, i.e. **this** worktree.

### 6.1 The named test files

```
$ PYTHONPATH="$PWD/src" .venv/Scripts/python -m pytest tests/test_appctx.py tests/test_reqctx.py -q
............................                                             [100%]
28 passed in 0.32s
```

`STEP6_EXIT=0`. That includes `test_app_ctx_globals_methods`, `test_custom_app_ctx_globals_class`, `test_context_refcounts`, `test_clean_pop`, and — because greenlet 3.2.3 *is* importable here — both `TestGreenletContextCopying` tests (no skip reported).

### 6.2 Full suite, run 1 (quiet)

```
$ PYTHONPATH="$PWD/src" .venv/Scripts/python -m pytest -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 6.28s
```

`FULL_NORMAL_EXIT=0`.

### 6.3 Full suite, run 2 (verbose, all flags)

```
$ PYTHONPATH="$PWD/src" .venv/Scripts/python -m pytest tests/ -vv -rA --tb=long -p no:cacheprovider
```

`FULL_VERBOSE_EXIT=0`. Header:

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q5-TXT\seal\.venv\Scripts\python.exe
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q5-TXT\seal
configfile: pyproject.toml
collecting ... collected 489 items
```

Outcome tally:

```
489 PASSED
```

Final line:

```
============================= 489 passed in 6.18s =============================
```

No `FAILED`, no test-outcome `ERROR`, no `SKIPPED`, `XFAIL` or `XPASS`, no warnings summary, no deselection. So the `g`-related tests and the greenlet context-copying tests run (not skipped) and pass in this environment.

---

## 7. Executed concurrency / isolation demo (4 claims)

Run as a stdin script (no source files edited), from the repo root, with the `PYTHONPATH` override. Complete output:

```
flask.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q5-TXT\seal\src\flask\__init__.py
sys.version = 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]

== Claim 1: per-context object identity ==
inside ctx : type = _AppCtxGlobals | isinstance _AppCtxGlobals = True | g.foo = a | id = 2854866889632
after ctx  : repr(g) = <LocalProxy unbound> | bool(g) = False
fresh ctx  : id = 2854875960400 | same object as before? = False | 'foo' in g? = False
Claim 1 OK

== Claim 2: nested app contexts stack ==
outer ctx  : x = 1 | id = 2854875959760
inner ctx  : 'x' in g? = False | id = 2854875972880 | differs from outer? = True
inner ctx  : x = 2
back outer : x = 1 | same obj restored? = True
Claim 2 OK

== Claim 3: cross-thread isolation ==
thread results = {'t1': 'AAA', 't1_correct_app': True, 't2': 'BBB', 't2_correct_app': True}
pre-push RuntimeError (t1) = 'Working outside of application context.\n\nThis typically means that you attemp ...
main thread after threads -> RuntimeError: Working outside of application context.
Claim 3 OK

== Claim 4: propagation is explicit only (context copy) ==
observed = {'plain_child_has_app': False, 'copied_child_g_value': 'from-main'}
Claim 4 OK

ALL DEMO ASSERTIONS PASSED
```

`EXIT=0`. Interpretation, claim by claim:

1. **Per-context object identity.** Inside a pushed context, `flask.g._get_current_object()` is a real `_AppCtxGlobals` instance holding `foo`; a *fresh* app context yields a **different** object (`same object as before? = False`) that does **not** see `foo`. After the block, `repr(g)` is `<LocalProxy unbound>` and `bool(g) is False` — i.e. the storage is discarded with the context and the proxy is simply unbound, exactly as `docs/appcontext.rst` says ("The data on `g` is lost after the context ends").
2. **Nested contexts stack.** The inner app context does **not** see the outer `x`; it writes its own `x = 2`; on leaving the inner block the outer `x = 1` is restored **and the exact same outer object is reinstated** (`same obj restored? = True`) — the observable effect of `_cv_tokens` + `_cv_app.reset(token)`.
3. **Cross-thread isolation.** Two concurrent OS threads, each holding its own `app.app_context()` open across a `time.sleep(0.05)`, see `AAA` and `BBB` respectively and each resolves the correct `current_app`. Before pushing, `flask.g` raises `RuntimeError: Working outside of application context.` **in both threads**; the main thread is still unbound after the threads finish. That is the `ContextVar`-has-no-value-in-this-context property, executed.
4. **Propagation is explicit only.** A plain child thread reports `current_app` unbound (`plain_child_has_app: False`); only the thread that wrapped its body in `contextvars.copy_context().run(...)` observed `g.value == "from-main"`. Isolation is by *context copy*, never by sharing — nothing propagates automatically.

---

## 8. Negative evidence: there is no lock anywhere

These grep results are the decisive proof that "thread-safety" here means *isolation*, not *synchronization*:

No locking constructs in the framework source:

```
$ grep -rnE "Lock|RLock|Semaphore|import threading|from threading" src/flask
GREP_EXIT=1 (1 = no matches)
```

Only two modules touch the contextvars machinery, and `copy_context` is never used by Flask itself:

```
$ grep -rnE "copy_context|ContextVar|contextvars" src/flask
src/flask/ctx.py:3:import contextvars
src/flask/ctx.py:249:        self._cv_tokens: list[contextvars.Token[AppContext]] = []
src/flask/ctx.py:334:            tuple[contextvars.Token[RequestContext], AppContext | None]
src/flask/globals.py:4:from contextvars import ContextVar
src/flask/globals.py:24:_cv_app: ContextVar[AppContext] = ContextVar("flask.app_ctx")
src/flask/globals.py:42:_cv_request: ContextVar[RequestContext] = ContextVar("flask.request_ctx")
```

No cross-thread test exists in the suite (hence §7 is the only concurrency evidence, and it passes):

```
$ grep -rnE "Thread|copied_context|copy_context|ThreadPoolExecutor" tests
GREP_EXIT=1 (1 = no matches)
```

So: `_AppCtxGlobals` never synchronizes anything, and Flask's teardown/restore is done entirely through `ContextVar` `Token`/`reset`; context propagation to other threads is left to the caller (stdlib `contextvars.copy_context()`, `RequestContext.copy()` / `copy_current_request_context`).

---

## 9. How it composes with requests, CLI, templates, and the other proxies

- **Requests:** `RequestContext.push()` (src/flask/ctx.py) auto-pushes an app context if the top one isn't for this app, so any request always has its own `g`:

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
```

  `RequestContext.pop()` pops the *request* token and then, if it created it, the app context — again via token stack, no lock.
- **`wsgi_app`** pushes/pops around dispatch and additionally hands `_cv_app.get()` / `_cv_request.get()` to the Werkzeug debugger's `preserve_context` hook in a `finally:` block.
- **CLI:** `src/flask/cli.py` does `ctx.with_resource(app.app_context())` so `g` exists inside commands.
- **Templates:** `src/flask/templating.py` injects `g` into the template namespace **straight from the active app context object**, which is a direct read of the same mechanism:

```python
def _default_template_ctx_processor() -> dict[str, t.Any]:
    """Default template context processor.  Injects `request`,
    `session` and `g`.
    """
    appctx = _cv_app.get(None)
    reqctx = _cv_request.get(None)
    rv: dict[str, t.Any] = {}
    if appctx is not None:
        rv["g"] = appctx.g
    if reqctx is not None:
        rv["request"] = reqctx.request
        rv["session"] = reqctx.session
    return rv
```

  This is why `test_custom_app_ctx_globals_class` can assert `flask.render_template_string("{{ g.spam }}") == "eggs"` after swapping `app.app_ctx_globals_class`.
- **`current_app` and `g` share the same `ContextVar`** (`LocalProxy(_cv_app, "app", ...)` vs `LocalProxy(_cv_app, "g", ...)`), so they are always bound/unbound together; `has_app_context()` is simply `return _cv_app.get(None) is not None`.
- **Streaming/async/testing:** `stream_with_context` re-enters the request context for a generator; `FlaskClient` + `preserve_context` re-entries defer popping inside `with client:`; async views run via `ensure_sync`/`asgiref.async_to_sync`, which (per `docs/design.rst`) executes the coroutine on a separate thread and is a documented performance compromise rather than a sharing mechanism.

---

## 10. Caveats and limits (essential — do not over-claim)

1. **"Thread-safe" ≠ locked.** `g` performs no mutual exclusion. There is no `Lock`/`RLock`/`Semaphore` and no `threading` import anywhere in `src/flask`. The guarantee is that **each context has its own `_AppCtxGlobals`**, so concurrent workers touch disjoint objects. Two coroutines *within the same `Context`* sharing one `g` are still unsynchronized — `g` is not a synchronization primitive. Normal Flask usage gives each request its own context, so this does not arise; but if you deliberately share a context, you must add your own locking.

2. **Isolation does not auto-propagate.** A newly spawned `threading.Thread` starts with an **empty** `Context` — it does *not* inherit the parent's `_cv_app`, and `flask.g` / `flask.current_app` raise `RuntimeError: Working outside of application context.` there (verified in §7 Claim 3). Propagation is explicit: stdlib `contextvars.copy_context().run(fn)`, or Flask's `RequestContext.copy()` / `copy_current_request_context`, or passing `g._get_current_object()` explicitly (docs: "The reference to the proxied object is needed in some situations, such as sending signals or passing data to a background thread."). Worksheet §7 Claim 4 demonstrates both halves.

3. **Writes inside a copied/nested context do not flow back out.** `ContextVar.set` in a child `Context` is local to that context; the parent's `g` object is unaffected (and after `reset` the parent object is reinstated verbatim, §7 Claim 2).

4. **Cross-thread use of a *request* context is explicitly unsafe.** `RequestContext.copy()`'s docstring:

```python
    def copy(self) -> RequestContext:
        """Creates a copy of this request context with the same request object.
        This can be used to move a request context to a different greenlet.
        Because the actual request object is the same this cannot be used to
        move a request context to a different thread unless access to the
        request object is locked.
        ...
        """
```

   The copy shares the same `request` object; only the context binding is duplicated.

5. **`g` is per-context, not per-application and not persistent.** It dies with the app context ("the data on `g` is lost after the context ends, and it is not an appropriate place to store data between requests"). For cross-request state use `session` or a database.

6. **Residual risk of misinterpretation:** an AST/grep pass over `_AppCtxGlobals` alone would show no concurrency machinery and could suggest `g` is simply unsafe; the resolution is that the class deliberately holds *no* state that needs protecting — all the safety is in *which instance* `LocalProxy` resolves to, i.e. in `_cv_app` + `AppContext.push/pop`. Also, the proxy adds an indirection (`g.attr` → `_cv_app.get()` → `AppContext` → `_AppCtxGlobals.__dict__`), so the mechanism belongs to Werkzeug's `LocalProxy` (3.1.3 here) and Python's `contextvars`, not to Flask's storage class.

---

## 11. Out-of-scope artifact (explicitly noted so the answer is not skewed)

The worktree contains one stray directory, `flask_mut2_i417ar2x/`. Its single file, `mutated_test.py`, has **nothing to do with `g`, `_AppCtxGlobals`, `_cv_app`, `contextvars`, threads or locks**:

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

Confirmation grep:

```
$ grep -rniE "\bg\b|_cv_app|_cv_request|contextvars|ContextVar|_AppCtxGlobals|Lock|thread" flask_mut2_i417ar2x
GREP_EXIT=1 (1 = no matches)
```

And its assertions in fact **fail** (unrelated to the namespace question):

```
$ PYTHONPATH="$PWD/src" .venv/Scripts/python flask_mut2_i417ar2x/mutated_test.py
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.\n'
Traceback (most recent call last):
  File "...\q5-TXT\seal\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
AssertionError: status 404
EXIT=1
```

It is a distractor. The `g`/`AppContext` code paths in `src/flask/ctx.py` and `src/flask/globals.py` match the documented semantics above, and all 489 tests of the real suite pass.

---

## 12. Summary of the mechanism, end to end

| Layer | Where | Role in isolation |
|---|---|---|
| Storage | `src/flask/ctx.py::_AppCtxGlobals` | Plain `self.__dict__` namespace. No lock, no thread-local. Stores the per-context data. |
| Owner | `AppContext.__init__` (`self.g = app.app_ctx_globals_class()`) | Creates **exactly one** namespace instance per context; class swappable via `Flask.app_ctx_globals_class`. |
| Binding | `globals.py::_cv_app = ContextVar("flask.app_ctx")`; `AppContext.push()` → `_cv_app.set(self)` (token appended to `self._cv_tokens`) | Binds one `AppContext` to the **current context only**. Stacking via the token list. |
| Unbinding | `AppContext.pop()` → `_cv_app.get()` then `_cv_app.reset(self._cv_tokens.pop())` | Restores the previous context; asserts "Popped wrong app context." if the stack is misused. |
| Access | `globals.py::g = LocalProxy(_cv_app, "g", unbound_message=_no_app_msg)` | Re-resolves on **every** attribute access: `_cv_app.get()` → `attrgetter("g")` → that context's `_AppCtxGlobals.__dict__`. `LookupError` → `RuntimeError("Working outside of application context....")`. |
| Isolation guarantee | stdlib `contextvars` | `ContextVar.get()` raises `LookupError` in a context that never set it; `set` affects only the current context; each thread/task/greenlet has its own context. Hence two concurrent workers can never see or mutate each other's `g`. |

**Answer to the task as posed:** the namespace object stores application-level data in a lock-free `dict`, and its thread-safety/context isolation is achieved entirely by being **addressed through a `ContextVar`** — `flask.g` is a `LocalProxy` over `_cv_app`, each `AppContext` creates its own `_AppCtxGlobals` and binds it with `_cv_app.set(self)` / unbinds it with `_cv_app.reset(token)`; because a `ContextVar` has no value in a context that never set it, concurrent threads/tasks/greenlets resolve `g` to different objects (or to an unbound `RuntimeError`) rather than sharing one, which yields *isolation by context* rather than *mutual exclusion by lock*. Anything crossing a context boundary (new thread, greenlet, `asyncio` task) must be propagated explicitly via `contextvars.copy_context()`, `RequestContext.copy()`, or `copy_current_request_context`.
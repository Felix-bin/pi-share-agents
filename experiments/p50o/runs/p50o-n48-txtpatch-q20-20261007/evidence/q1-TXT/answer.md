# How callback-based modification tracking keeps in-memory session state and persisted cookie data consistent

## Short answer

`SecureCookieSession` inherits from Werkzeug's `CallbackDict`. When the session is constructed it passes a callback, `on_update`, into `CallbackDict.__init__`, which stores it as the instance attribute `self.on_update`. Every *mutating* mapping operation defined in Werkzeug's `UpdateDictMixin` calls `self.on_update(self)` immediately after it delegates to the built-in `dict`, so the flags are flipped **inside the same operation that changes the dict** — there is no window where the contents changed but `modified` is stale. `Flask.process_response` then calls `save_session` once at the end of the request; that method serialises `dict(session)` — a snapshot taken at that instant, i.e. exactly the in-memory contents the callback certified — and only when `session.modified` (or the permanent-refresh rule) is true. Loading a cookie does **not** fire the callback, because `CallbackDict.__init__` assigns `initial` through `dict.__init__`, not `update()`, so a freshly loaded session starts clean.

Critically, **the callback does not make concurrent requests consistent with each other.** It guarantees consistency only between *one request's own in-memory dict and the cookie that same request emits*. Each request gets its own `SecureCookieSession` object, so the callback has no shared state to race on; across concurrent requests the default cookie backend is last-write-wins in the browser's cookie jar, and the interface docstring explicitly disclaims any ordering guarantee.

---

## 1. The class under discussion

`src/flask/sessions.py`, `SecureCookieSession` and `NullSession` (verbatim, lines 52–110):

```python
class SecureCookieSession(CallbackDict[str, t.Any], SessionMixin):
    """Base class for sessions based on signed cookies.

    This session backend will set the :attr:`modified` and
    :attr:`accessed` attributes. It cannot reliably track whether a
    session is new (vs. empty), so :attr:`new` remains hard coded to
    ``False``.
    """

    #: When data is changed, this is set to ``True``. Only the session
    #: dictionary itself is tracked; if the session contains mutable
    #: data (for example a nested dict) then this must be set to
    #: ``True`` manually when modifying that data. The session cookie
    #: will only be written to the response if this is ``True``.
    modified = False

    #: When data is read or written, this is set to ``True``. Used by
    #: :class:`.SecureCookieSessionInterface` to add a ``Vary: Cookie``
    #: header, which allows caching proxies to cache different pages for
    #: different users.
    accessed = False

    def __init__(
        self,
        initial: c.Mapping[str, t.Any] | c.Iterable[tuple[str, t.Any]] | None = None,
    ) -> None:
        def on_update(self: te.Self) -> None:
            self.modified = True
            self.accessed = True

        super().__init__(initial, on_update)

    def __getitem__(self, key: str) -> t.Any:
        self.accessed = True
        return super().__getitem__(key)

    def get(self, key: str, default: t.Any = None) -> t.Any:
        self.accessed = True
        return super().get(key, default)

    def setdefault(self, key: str, default: t.Any = None) -> t.Any:
        self.accessed = True
        return super().setdefault(key, default)


class NullSession(SecureCookieSession):
    """Class used to generate nicer error messages if sessions are not
    available.  Will still allow read-only access to the empty session
    but fail on setting.
    """

    def _fail(self, *args: t.Any, **kwargs: t.Any) -> t.NoReturn:
        raise RuntimeError(
            "The session is unavailable because no secret "
            "key was set.  Set the secret_key on the "
            "application to something unique and secret."
        )

    __setitem__ = __delitem__ = clear = pop = popitem = update = setdefault = _fail  # noqa: B950
    del _fail
```

Note the deliberate override: the parent `SessionMixin` (`src/flask/sessions.py` lines 24–48) defines the *safe fallback* defaults `modified = True` and `accessed = True`, but `SecureCookieSession` overrides both to `False` at class level so that a freshly opened session is clean until something actually touches it.

The class hierarchy is `SecureCookieSession` → (`CallbackDict[str, t.Any]`, `SessionMixin`) → `CallbackDict` → (`UpdateDictMixin[K, V]`, `dict[K, V]`).

---

## 2. Where the callback is installed and fired

### 2.1 `CallbackDict` stores the callback — and does **not** fire it while loading

`.venv/Lib/site-packages/werkzeug/datastructures/structures.py`, lines 1038–1056 (verbatim):

```python
class CallbackDict(UpdateDictMixin[K, V], dict[K, V]):
    """A dict that calls a function passed every time something is changed.
    The function is passed the dict instance.
    """

    def __init__(
        self,
        initial: cabc.Mapping[K, V] | cabc.Iterable[tuple[K, V]] | None = None,
        on_update: cabc.Callable[[te.Self], None] | None = None,
    ) -> None:
        if initial is None:
            super().__init__()
        else:
            super().__init__(initial)

        self.on_update = on_update

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {super().__repr__()}>"
```

The load-bearing detail is `super().__init__(initial)`: via the MRO this resolves to `dict.__init__`, **not** to `update()`. Therefore populating a session from a decoded cookie never invokes `on_update`, and a loaded session starts with `modified = False`, `accessed = False`.

### 2.2 `UpdateDictMixin` fires it after every real mutation

`.venv/Lib/site-packages/werkzeug/datastructures/mixins.py`, lines 231–315 (verbatim):

```python
def _always_update(f: F) -> F:
    def wrapper(
        self: UpdateDictMixin[t.Any, t.Any], /, *args: t.Any, **kwargs: t.Any
    ) -> t.Any:
        rv = f(self, *args, **kwargs)

        if self.on_update is not None:
            self.on_update(self)

        return rv

    return update_wrapper(wrapper, f)  # type: ignore[return-value]


class UpdateDictMixin(dict[K, V]):
    """Makes dicts call `self.on_update` on modifications.

    .. versionchanged:: 3.1
        Implement ``|=`` operator.

    .. versionadded:: 0.5

    :private:
    """

    on_update: cabc.Callable[[te.Self], None] | None = None

    def setdefault(self: te.Self, key: K, default: V | None = None) -> V:
        modified = key not in self
        rv = super().setdefault(key, default)  # type: ignore[arg-type]
        if modified and self.on_update is not None:
            self.on_update(self)
        return rv

    @t.overload
    def pop(self: te.Self, key: K) -> V: ...
    @t.overload
    def pop(self: te.Self, key: K, default: V) -> V: ...
    @t.overload
    def pop(self: te.Self, key: K, default: T) -> T: ...
    def pop(
        self: te.Self,
        key: K,
        default: V | T = _missing,  # type: ignore[assignment]
    ) -> V | T:
        modified = key in self
        if default is _missing:
            rv = super().pop(key)
        else:
            rv = super().pop(key, default)  # type: ignore[arg-type]
        if modified and self.on_update is not None:
            self.on_update(self)
        return rv

    @_always_update
    def __setitem__(self, key: K, value: V) -> None:
        super().__setitem__(key, value)

    @_always_update
    def __delitem__(self, key: K) -> None:
        super().__delitem__(key)

    @_always_update
    def clear(self) -> None:
        super().clear()

    @_always_update
    def popitem(self) -> tuple[K, V]:
        return super().popitem()

    @_always_update
    def update(  # type: ignore[override]
        self,
        arg: cabc.Mapping[K, V] | cabc.Iterable[tuple[K, V]] | None = None,
        /,
        **kwargs: V,
    ) -> None:
        if arg is None:
            super().update(**kwargs)
        else:
            super().update(arg, **kwargs)

    @_always_update
    def __ior__(  # type: ignore[override]
        self, other: cabc.Mapping[K, V] | cabc.Iterable[tuple[K, V]]
    ) -> te.Self:
        return super().__ior__(other)
```

Coverage of the mutation surface:

| Operation | Fires `on_update` | When |
|---|---|---|
| `__setitem__` | yes | unconditionally, after `dict.__setitem__`, via `@_always_update` |
| `__delitem__` | yes | unconditionally, via `@_always_update` |
| `clear` | yes | unconditionally, via `@_always_update` |
| `popitem` | yes | unconditionally, via `@_always_update` |
| `update` | yes | unconditionally, via `@_always_update` |
| `__ior__` (`|=`) | yes | unconditionally, via `@_always_update` |
| `setdefault` | conditionally | only if `key not in self` beforehand |
| `pop` | conditionally | only if `key in self` beforehand |

### 2.3 The mechanism chain, in order

1. `SecureCookieSession.__init__` defines the nested function `on_update(self)` that does `self.modified = True; self.accessed = True` and hands it to `super().__init__(initial, on_update)` (`src/flask/sessions.py:74–82`).
2. `CallbackDict.__init__` binds it as the per-instance attribute `self.on_update` and fills the mapping with `super().__init__(initial)` → `dict.__init__` (`werkzeug/datastructures/structures.py:1040–1055`).
3. `UpdateDictMixin` calls `self.on_update(self)` **after** delegating to `dict` — unconditionally through the `_always_update` decorator for the six always-mutating methods, and conditionally inside `setdefault` and `pop` (`werkzeug/datastructures/mixins.py:231–315`).
4. Reads are handled separately: `SecureCookieSession` overrides `__getitem__`, `get` and `setdefault` to set `self.accessed = True` only (and delegates upward), so a pure read marks `accessed` but never `modified` (`src/flask/sessions.py:84–93`).
5. Because `SecureCookieSession` overrides the mixin defaults with `modified = False`, `accessed = False` (`src/flask/sessions.py:66,72`), an untouched session is clean.

**Consequence:** the flag is set in the same critical section as the mutation — `on_update` is invoked after `dict`'s own mutation within `_always_update`, or as the final step of `setdefault`/`pop`. Nothing can change the dict without the flag being set as part of that same call, so `modified` cannot be stale with respect to the top-level contents.

Runtime confirmation (executed with `PYTHONPATH=src .venv/Scripts/python.exe`, exit 0):

```
fresh class-default modified/accessed: False False
fresh instance modified/accessed: False False
on_update is: <function SecureCookieSession.__init__.<locals>.on_update at 0x000001FD93553D80>
on_update closure: () (None, True)
after direct on_update -> modified/accessed: True True
```

```
initial= {'a': 1, 'b': 2}
after loading initial -> modified: False accessed: False
OK: loading initial does not fire callback
```

```
__setitem__                      modified after op = True
__setitem__ overwrite            modified after op = True
update                           modified after op = True
__ior__                          modified after op = True
pop existing                     modified after op = True
pop missing (default)            modified after op = False
setdefault new key               modified after op = True
setdefault existing key          modified after op = True
__delitem__                      modified after op = True
clear                            modified after op = True
popitem                          modified after op = True
```

Isolating the conditional mutators by resetting `modified` first:

```
setdefault(existing key): rv=5 modified=False accessed=True
setdefault(new key):      rv=1 modified=True accessed=True
pop(existing key):        rv=1 modified=True accessed=True
pop(missing, default):    rv=None modified=False accessed=False
```

Reads set `accessed` only:

```
__getitem__                modified=False accessed=True
get(existing)              modified=False accessed=True
get(missing)               modified=False accessed=True
setdefault(existing)       modified=False accessed=True
setdefault(new)            modified=True  accessed=True
```

---

## 3. How the in-memory flag is converted into persisted cookie data

`save_session` is the only writer, and `Flask.process_response` is the only caller in the response cycle.

`src/flask/sessions.py`, `open_session` / `save_session` (verbatim, lines 337–410):

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

`should_set_cookie` (`src/flask/sessions.py:247–261`, verbatim):

```python
    def should_set_cookie(self, app: Flask, session: SessionMixin) -> bool:
        """Used by session backends to determine if a ``Set-Cookie`` header
        should be set for this session cookie for this response. If the session
        has been modified, the cookie is set. If the session is permanent and
        the ``SESSION_REFRESH_EACH_REQUEST`` config is true, the cookie is
        always set.

        This check is usually skipped if the session was deleted.

        .. versionadded:: 0.11
        """

        return session.modified or (
            session.permanent and app.config["SESSION_REFRESH_EACH_REQUEST"]
        )
```

The three branches of `save_session`:

1. **Accessed at all** → add `Vary: Cookie` to the response (`if session.accessed: response.vary.add("Cookie")`). This is why the `accessed` flag exists separately from `modified`.
2. **Empty session** → if `session.modified`, delete the cookie via `response.delete_cookie(...)` and add `Vary: Cookie`; otherwise return without touching the cookie.
3. **Non-empty session** → return early unless `should_set_cookie(...)`; otherwise serialise `self.get_signing_serializer(app).dumps(dict(session))` and set it as the cookie.

The consistency argument for a single request follows directly: the payload written is `dict(session)`, a snapshot of the live mapping taken at save time, and save time is the end of the request after all `after_request` functions. So the bytes signed into the cookie always reflect the request's final in-memory contents, and the write is *gated* by the flag the callback maintained. If the callback says `modified is False`, no cookie is emitted, so the previously persisted cookie still matches the unchanged in-memory state.

### Lifecycle wiring (per-request open, once-per-response save)

`src/flask/ctx.py`, `RequestContext.push` session block (verbatim):

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

`src/flask/app.py`, end of `process_response` (verbatim):

```python
        for name in chain(request.blueprints, (None,)):
            if name in self.after_request_funcs:
                for func in reversed(self.after_request_funcs[name]):
                    response = self.ensure_sync(func)(response)

        if not self.session_interface.is_null_session(ctx.session):
            self.session_interface.save_session(self, ctx.session, response)

        return response
```

`flask.session` is a context-local proxy rather than a global:

```python
session: SessionMixin = LocalProxy(  # type: ignore[assignment]
    _cv_request, "session", unbound_message=_no_req_msg
)
```

Runtime confirmation that loading a cookie leaves the session clean and that the write gating is exactly as coded (exit 0):

```
crafted cookie: eyJfcGVybWFuZW50Ijp0cnVlLCJ1c2VyX2lkIjo3 ...
loaded data: {'_permanent': True, 'user_id': 7}
loaded modified: False accessed: False
OK: loading a cookie does NOT mark session modified/accessed
no-cookie session: {} modified: False accessed: False
```

```
[unmodified non-permanent accessed] should_set_cookie=False -> set=0 deleted=0 vary=True
[unmodified non-permanent] should_set_cookie=False -> set=0 deleted=0 vary=True
[modified non-permanent] should_set_cookie=True -> set=1 deleted=0 vary=True
[modified empty] should_set_cookie=True -> set=0 deleted=1 vary=True
[permanent unmodified, refresh=True] should_set_cookie=True -> set=1 deleted=0 vary=True
[permanent unmodified, refresh=False] should_set_cookie=True -> set=1 deleted=0 vary=True
```

(the last two rows of that first draft were contaminated by the `permanent` setter; the corrected run, using a session whose `_permanent` key was already present so the setter was not invoked, is:)

```
permanent loaded session: _permanent=True modified=False
permanent unmodified, refresh=True             should_set_cookie=True  set=1 deleted=0
permanent unmodified, refresh=False            should_set_cookie=False set=0 deleted=0
after 'session.permanent = True' -> modified=True (setter writes _permanent via __setitem__)
```

End-to-end request cycle:

```
/set    Set-Cookie present: True | Vary: Cookie
/get    Set-Cookie present: False | Vary: Cookie
/touch  Set-Cookie present: False | Vary: None
/clear  Set-Cookie: session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Path=/ | Vary: Cookie
```

The read-only `/get` sends no `Set-Cookie` because the callback was never fired for a mutation — yet it still sends `Vary: Cookie` because `accessed` was set by the read. `/clear` empties the mapping via `pop`, which fires the callback, so `not session and session.modified` triggers `delete_cookie`.

### The repository's own acceptance test for the flag semantics

`tests/test_basic.py::test_session` (verbatim, lines 234–254):

```python
def test_session(app, client):
    @app.route("/set", methods=["POST"])
    def set():
        assert not flask.session.accessed
        assert not flask.session.modified
        flask.session["value"] = flask.request.form["value"]
        assert flask.session.accessed
        assert flask.session.modified
        return "value set"

    @app.route("/get")
    def get():
        assert not flask.session.accessed
        assert not flask.session.modified
        v = flask.session.get("value", "None")
        assert flask.session.accessed
        assert not flask.session.modified
        return v

    assert client.post("/set", data={"value": "42"}).data == b"value set"
    assert client.get("/get").data == b"42"
```

This single test proves three things at once: a freshly opened session is neither `accessed` nor `modified` (so cookie loading did not fire the callback); `session["value"] = ...` sets **both** flags; `session.get(...)` sets `accessed` **only**. The `/get` request is especially telling — it loads the cookie written by `/set`, and its first two assertions `assert not flask.session.accessed` / `assert not flask.session.modified` pass, directly demonstrating that `open_session` → `SecureCookieSession(data)` does not trip `on_update`.

The cookie-setting decision is pinned by `tests/test_basic.py::test_session_cookie_setting` (verbatim, lines 484–517):

```python
def test_session_cookie_setting(app):
    is_permanent = True

    @app.route("/bump")
    def bump():
        rv = flask.session["foo"] = flask.session.get("foo", 0) + 1
        flask.session.permanent = is_permanent
        return str(rv)

    @app.route("/read")
    def read():
        return str(flask.session.get("foo", 0))

    def run_test(expect_header):
        with app.test_client() as c:
            assert c.get("/bump").data == b"1"
            assert c.get("/bump").data == b"2"
            assert c.get("/bump").data == b"3"

            rv = c.get("/read")
            set_cookie = rv.headers.get("set-cookie")
            assert (set_cookie is not None) == expect_header
            assert rv.data == b"3"

    is_permanent = True
    app.config["SESSION_REFRESH_EACH_REQUEST"] = True
    run_test(expect_header=True)

    is_permanent = True
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False
    run_test(expect_header=False)

    is_permanent = False
    app.config["SESSION_REFRESH_EACH_REQUEST"] = True
    run_test(expect_header=False)

    is_permanent = False
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False
    run_test(expect_header=False)
```

and the `Vary: Cookie` side is pinned by `tests/test_basic.py::test_session_vary_cookie` (verbatim, lines 520–585):

```python
def test_session_vary_cookie(app, client):
    @app.route("/set")
    def set_session():
        flask.session["test"] = "test"
        return ""

    @app.route("/get")
    def get():
        return flask.session.get("test")

    @app.route("/getitem")
    def getitem():
        return flask.session["test"]

    @app.route("/setdefault")
    def setdefault():
        return flask.session.setdefault("test", "default")

    @app.route("/clear")
    def clear():
        flask.session.clear()
        return ""

    @app.route("/vary-cookie-header-set")
    def vary_cookie_header_set():
        response = flask.Response()
        response.vary.add("Cookie")
        flask.session["test"] = "test"
        return response

    @app.route("/vary-header-set")
    def vary_header_set():
        response = flask.Response()
        response.vary.update(("Accept-Encoding", "Accept-Language"))
        flask.session["test"] = "test"
        return response

    @app.route("/no-vary-header")
    def no_vary_header():
        return ""

    def expect(path, header_value="Cookie"):
        rv = client.get(path)

        if header_value:
            # The 'Vary' key should exist in the headers only once.
            assert len(rv.headers.get_all("Vary")) == 1
            assert rv.headers["Vary"] == header_value
        else:
            assert "Vary" not in rv.headers

    expect("/set")
    expect("/get")
    expect("/getitem")
    expect("/setdefault")
    expect("/clear")
    expect("/vary-cookie-header-set")
    expect("/vary-header-set", "Accept-Encoding, Accept-Language, Cookie")
    expect("/no-vary-header", None)
```

And cookie deletion for the empty-but-modified case is pinned by the `/clear` route and `assert "session=;" in cookie` assertions in `tests/test_basic.py` lines 293–330.

---

## 4. The "across concurrent requests" part — what the callback does and does not guarantee

The `SessionInterface` docstring states the limitation in the framework's own words (`src/flask/sessions.py:141–146`, verbatim):

```
     Multiple requests with the same session may be sent and handled
     concurrently. When implementing a new session interface, consider
     whether reads or writes to the backing store must be synchronized.
     There is no guarantee on the order in which the session for each
     request is opened or saved, it will occur in the order that requests
     begin and end processing.
```

Three points, in order of scope:

**(i) Per-request isolation — the callback never races on shared in-memory state.** Each request gets its own `SecureCookieSession` instance, created in `RequestContext.push` (`if self.session is None: self.session = session_interface.open_session(...)`), and reached through the context-local `LocalProxy`. The `on_update` callable is stored as a per-instance attribute (`self.on_update = on_update` in `CallbackDict.__init__`), and `UpdateDictMixin` always calls it as `self.on_update(self)` on the owning instance. So a write in request A flips `A.modified` and cannot touch `B.modified` — there is no module-level or class-level mutable session state.

Runtime confirmation (exit 0):

```
distinct session objects: True
distinct on_update closures: True
closure A captures A: False []
write to A -> A.modified=True ; B.modified=False (B unaffected)
OK: no shared in-memory session state across request contexts
```

*Precision note:* `on_update` is **not** a closure capturing its instance — introspection gives `co_freevars == ()` and the signature `(self: 'te.Self') -> 'None'`, i.e. `self` is an ordinary parameter:

```
type(a.on_update): function
freevars: ()
signature: (self: 'te.Self') -> 'None'
after a.on_update(b) -> a.modified=False  b.modified=True
normal write -> owning instance modified = True
```

Isolation still holds for the same reason, but the mechanism is "the method is invoked on the instance that owns the dict", not "the closure captured the instance". This corrects the phrasing used earlier in the pipeline.

**(ii) Consistency is enforced at the request boundary, not mid-flight.** The flag does exactly one job downstream: `should_set_cookie` (`return session.modified or (session.permanent and app.config["SESSION_REFRESH_EACH_REQUEST"])`) decides whether *this* request re-emits *its own* cookie from *its own* final dict. `save_session` runs exactly once per response, at the end of `process_response` after all `after_request` functions, and only for non-null sessions. For the default cookie backend there is no shared backing store to synchronise — the "store" is the browser's cookie jar, and the request's dict is the sole source of the bytes written. There is therefore no in-process concurrent writer to guard, and no lock in Flask's session code.

**(iii) Cross-request consistency is last-write-wins — the callback cannot fix it.** Two concurrent requests that both loaded the same incoming cookie each construct their own `SecureCookieSession`, each mutate it independently, and each compute and emit its own `Set-Cookie` header from `dict(session)` at its own save time. Whichever response is applied last overwrites the other in the browser's cookie jar, discarding the other request's changes — a lost update. The callback cannot prevent this, because nothing in the callback protocol compares versions, sequences writes, or coordinates responses; and the framework explicitly disclaims ordering (`There is no guarantee on the order in which the session for each request is opened or saved`). An application needing genuine cross-request consistency must replace the interface with a server-side store and synchronise access to it — exactly what the docstring's instruction to "consider whether reads or writes to the backing store must be synchronized" anticipates.

In one sentence: **the callback keeps one request's memory and the cookie that request emits mutually consistent; it does not serialise competing requests, whose interaction is last-write-wins at the cookie jar.**

---

## 5. Caveats and edge cases the design accepts

**(a) Nested/mutable values bypass the callback entirely.** The callback fires from `dict`-level operations only (`__setitem__`, `__delitem__`, etc.), so in-place mutation of a contained object is invisible. The class docstring says it outright:

```
    #: When data is changed, this is set to ``True``. Only the session
    #: dictionary itself is tracked; if the session contains mutable
    #: data (for example a nested dict) then this must be set to
    #: ``True`` manually when modifying that data. The session cookie
    #: will only be written to the response if this is ``True``.
```

and `docs/api.rst` lines 80–91 documents the workaround (verbatim):

```rst
   .. attribute:: modified

      ``True`` if the session object detected a modification. Be advised
      that modifications on mutable structures are not picked up
      automatically, in that situation you have to explicitly set the
      attribute to ``True`` yourself. Here an example::

          # this change is not picked up because a mutable object (here
          # a list) is changed.
          session['objects'].append(42)
          # so mark it as modified yourself
          session.modified = True
```

Runtime confirmation (exit 0):

```
nested append -> modified = False (callback NOT fired)
manual 'session.modified = True' -> modified = True (hand-suppressable)
manual 'session.modified = False' -> modified = False
```

**(b) `modified` is a plain attribute, so it can be suppressed by hand.** It is a class-level `False` overridden per instance by the callback, and user code can assign it. `tests/test_basic.py::test_flashes` (verbatim, lines 598–604) does exactly that:

```python
def test_flashes(app, req_ctx):
    assert not flask.session.modified
    flask.flash("Zap")
    flask.session.modified = False
    flask.flash("Zip")
    assert flask.session.modified
    assert list(flask.get_flashed_messages()) == ["Zap", "Zip"]
```

This is a legitimate suppression hook, but it also means a mistaken `session.modified = False` will silently prevent the cookie from being written even though the dict changed.

**(c) Permanent sessions can re-emit regardless of the flag.** When `session.permanent` is true and `SESSION_REFRESH_EACH_REQUEST` is true, `should_set_cookie` returns true even if `modified` is false, so the cookie is refreshed on every response. `docs/config.rst` documents this:

```rst
.. py:data:: SESSION_REFRESH_EACH_REQUEST

    Control whether the cookie is sent with every response when
    ``session.permanent`` is true. Sending the cookie every time (the default)
    can more reliably keep the session from expiring, but uses more bandwidth.
    Non-permanent sessions are not affected.
```

*Precision note found at runtime:* the `permanent` **setter** is itself a mutating operation, since `SessionMixin.permanent`'s property setter is `self["_permanent"] = bool(value)` — a `__setitem__` call that fires `on_update`. So `session.permanent = True` marks the session modified as a side effect, and a session only reaches the "unmodified permanent" state if `_permanent` arrived via cookie loading (which does not fire the callback) or if `modified` was explicitly reset.

**(d) `NullSession` can never trip the callback and is never saved.** `NullSession` subclasses `SecureCookieSession` but rebinds every mutator to `_fail`:

```python
    __setitem__ = __delitem__ = clear = pop = popitem = update = setdefault = _fail  # noqa: B950
    del _fail
```

Every write raises `RuntimeError` before reaching `UpdateDictMixin`, so `on_update` is unreachable; and `process_response` guards the save with `if not self.session_interface.is_null_session(ctx.session):`. `tests/test_basic.py::test_missing_session` (verbatim, lines 362–371) pins both halves:

```python
def test_missing_session(app):
    app.secret_key = None

    def expect_exception(f, *args, **kwargs):
        e = pytest.raises(RuntimeError, f, *args, **kwargs)
        assert e.value.args and "session is unavailable" in e.value.args[0]

    with app.test_request_context():
        assert flask.session.get("missing_key") is None
        expect_exception(flask.session.__setitem__, "foo", 42)
        expect_exception(flask.session.pop, "foo")
```

Runtime confirmation (exit 0):

```
NullSession get: None
n.__setitem__('k',1)         -> RuntimeError: The session is unavailable because no secret ...
n.pop('k')                   -> RuntimeError: The session is unavailable because no secret ...
n.clear()                    -> RuntimeError: The session is unavailable because no secret ...
n.update({'a':1})            -> RuntimeError: The session is unavailable because no secret ...
n.setdefault('k',1)          -> RuntimeError: The session is unavailable because no secret ...
```

---

## 6. Test-suite verification

The whole suite was run twice against the local `src/` checkout (`PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests`), both exit code 0:

```
============================= 489 passed in 6.18s =============================
```

and with maximum verbosity (`-m pytest tests -vv -rA --tb=long --no-header`), exit 0:

```
============================= 489 passed in 6.26s =============================
```

The session-focused subset (`-k "session or flash"`), exit 0:

```
PASSED tests/test_basic.py::test_session
PASSED tests/test_basic.py::test_session_path
PASSED tests/test_basic.py::test_session_using_application_root
PASSED tests/test_basic.py::test_session_using_session_settings
PASSED tests/test_basic.py::test_session_using_samesite_attribute
PASSED tests/test_basic.py::test_missing_session
PASSED tests/test_basic.py::test_session_secret_key_fallbacks
PASSED tests/test_basic.py::test_session_expiration
PASSED tests/test_basic.py::test_session_stored_last
PASSED tests/test_basic.py::test_session_special_types
PASSED tests/test_basic.py::test_session_cookie_setting
PASSED tests/test_basic.py::test_session_vary_cookie
PASSED tests/test_basic.py::test_session_refresh_vary
PASSED tests/test_basic.py::test_flashes
PASSED tests/test_basic.py::test_extended_flashing
PASSED tests/test_session_interface.py::test_open_session_with_endpoint
===================== 16 passed, 115 deselected in 0.26s ======================
```

Environment for the runtime probes: `.venv/Scripts/python.exe` → CPython 3.13.9, werkzeug 3.1.3, flask 3.2.0.dev0, git HEAD `85c5d93c`. The installed editable `flask.pth` points at a different checkout, so every probe was run with `PYTHONPATH=src` to force the local tree; verified by `import flask; print(flask.__file__)` resolving to this working directory's `src/flask/__init__.py` (exit 0). Two throwaway environment probes failed and are not evidence: `werkzeug.__version__` raises `AttributeError` in Werkzeug 3.x (version taken from `importlib.metadata` instead), and one early invocation preceded locating the interpreter.

---

## 7. Claim → source anchors

| Claim | Anchor |
|---|---|
| `SecureCookieSession` inherits `CallbackDict[str, t.Any], SessionMixin` | `src/flask/sessions.py:52` |
| `on_update` defined in `__init__`, sets `modified` and `accessed` | `src/flask/sessions.py:78–82` |
| `modified = False` / `accessed = False` class-level overrides | `src/flask/sessions.py:66, 72` |
| `SessionMixin` defaults `modified = True`, `accessed = True` | `src/flask/sessions.py:24–48` |
| Reads (`__getitem__`, `get`, `setdefault`) set `accessed` only | `src/flask/sessions.py:84–93` |
| `CallbackDict` stores `on_update`; loads `initial` via `dict.__init__`, not `update` | `.venv/Lib/site-packages/werkzeug/datastructures/structures.py:1040–1055` |
| `_always_update` fires callback after `f` returns | `.venv/Lib/site-packages/werkzeug/datastructures/mixins.py:231–242` |
| Six always-firing mutators; `setdefault`/`pop` conditional | `.venv/Lib/site-packages/werkzeug/datastructures/mixins.py:258–315` |
| `open_session` builds `self.session_class(data)`; empty cookie → fresh session | `src/flask/sessions.py:337–349` |
| `save_session` is the only writer; `Vary: Cookie` on `accessed`; delete on empty+modified; `dumps(dict(session))` | `src/flask/sessions.py:351–410` |
| Cookie gating `session.modified or (session.permanent and SESSION_REFRESH_EACH_REQUEST)` | `src/flask/sessions.py:247–261` |
| Concurrency disclaimer ("no guarantee on the order …") | `src/flask/sessions.py:141–146` |
| Session opened per request in `RequestContext.push` | `src/flask/ctx.py:380–389` |
| Session saved once at end of `process_response`, non-null only | `src/flask/app.py:1314–1324` |
| `flask.session` is a context-local `LocalProxy` | `src/flask/globals.py:49–51` |
| Write sets both flags, read sets only `accessed`, load is clean | `tests/test_basic.py:234–254` |
| `modified = False` can be set by hand | `tests/test_basic.py:598–604` |
| `should_set_cookie` truth table over permanent/refresh | `tests/test_basic.py:484–517` |
| `accessed` drives `Vary: Cookie`; untouched session emits none | `tests/test_basic.py:520–585` |
| Empty-but-modified deletes cookie (`session=;`) | `tests/test_basic.py:293–330` |
| `NullSession` reads OK, writes raise | `tests/test_basic.py:362–371`; `src/flask/sessions.py:97–110` |
| Nested mutable values not auto-detected; set `modified` manually | `docs/api.rst:80–91` |
| `SESSION_REFRESH_EACH_REQUEST` semantics | `docs/config.rst:147–152` |
| `Vary: Cookie` on access/modify/refresh (history) | `CHANGES.rst:122, 195, 869` |
| Werkzeug 3.1.3 present, so `__ior__` support is live | `uv.lock:1446–1447`; Flask specifier `werkzeug = ">=3.1.0"` at `uv.lock:395` |

**Non-citation note:** `flask_mut2_i417ar2x/mutated_test.py` in this working directory is an unrelated subdomain-routing script — it configures `SERVER_NAME`, defines `@app.route("/", subdomain="<company_id>")`, and asserts `200 == response.status_code` and `b"xxx" == response.data`. It contains no session code and was not used as evidence for any claim above.
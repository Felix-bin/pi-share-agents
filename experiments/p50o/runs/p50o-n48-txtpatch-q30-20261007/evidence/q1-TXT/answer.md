I have verified the decisive code paths line-for-line. Here is the final, self-contained answer.

---

# Why does unconditionally setting the session access-tracking attribute in dictionary access methods impact signed-cookie-string conversion performance during frequent reads?

## Verdict (direct answer)

**In this repository it does not.** In `src/flask/sessions.py` (Flask `3.2.0.dev0`, checkout `85c5d93`), setting `accessed = True` in the dictionary access methods (`__getitem__`, `get`, `setdefault`) has **no effect whatsoever on the cost of converting the session to a signed cookie string**, because the conversion is gated on a *different* attribute. The signed-cookie serialization happens here:

`src/flask/sessions.py:383` and `:387` (verbatim):

```python
        if not self.should_set_cookie(app, session):
            return

        expires = self.get_expiration_time(app, session)
        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
```

and `should_set_cookie` is (`src/flask/sessions.py:247-261`, verbatim):

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

The predicate tests **`session.modified`** and **`session.permanent and SESSION_REFRESH_EACH_REQUEST`**. It never mentions `accessed`. `accessed` is consumed in exactly **one** place in the whole source tree — to add a response header:

`src/flask/sessions.py:362-364` (verbatim):

```python
        # Add a "Vary: Cookie" header if the session was accessed at all.
        if session.accessed:
            response.vary.add("Cookie")
```

So a "frequent read operation" through `session.get(...)` or `session[...]`:
- sets `accessed = True` (one instance-attribute store), which makes `save_session` add `Vary: Cookie`; and
- produces **zero** JSON serialization and **zero** HMAC signing, because `modified` stays `False` and, for a non-permanent session, the `should_set_cookie` gate is `False`.

The premise in the question **conflates the access flag (`accessed`) with the modification flag (`modified`)**. The two drive two completely different things: `accessed` → `Vary: Cookie`; `modified` (or `permanent` + refresh) → `dumps()` → serialization + signing + `Set-Cookie`.

Measured proof (details in §5): removing the three `self.accessed = True` lines changes only the `Vary` header; `Set-Cookie` presence and `URLSafeTimedSerializer.dumps` counts are identical in every configuration. The flag write itself costs ~22.7 ns, while one `dumps()` of a 21-key payload costs ~29 867 ns — a ratio of ~1315×.

---

## 1. The code being discussed

`src/flask/sessions.py:52-94` — `SecureCookieSession`, the class whose access methods set the flag (verbatim):

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
```

Exactly three dictionary access methods set `accessed`: `__getitem__` (line 85), `get` (line 89), `setdefault` (line 93). `on_update` (lines 78–80) sets **both** `modified` (79) and `accessed` (80). The defaults are `modified = False` (66) and `accessed = False` (72) on this class; `SessionMixin` sets both to `True` (44 and 49) as the generic fallback.

The `permanent` property is a `get` call, so reading it also sets `accessed` — `src/flask/sessions.py:27-34` (verbatim):

```python
    @property
    def permanent(self) -> bool:
        """This reflects the ``'_permanent'`` key in the dict."""
        return self.get("_permanent", False)

    @permanent.setter
    def permanent(self, value: bool) -> None:
        self["_permanent"] = bool(value)
```

There is **no `__contains__` override** in the file (grep found none), so `key in session` does not set `accessed`.

---

## 2. Step-by-step trace of a single "frequent read" request

The session is opened once per request. `src/flask/ctx.py:380-392` (verbatim):

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

        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
```

`flask.session` is a per-request `LocalProxy` (`src/flask/globals.py`):

```python
session: SessionMixin = LocalProxy(  # type: ignore[assignment]
    _cv_request, "session", unbound_message=_no_req_msg
)
```

`open_session` builds the session via `self.session_class(data)` (`src/flask/sessions.py:337-349`, verbatim):

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

Because `CallbackDict.__init__` never calls `on_update`, the freshly opened session starts `modified = False` and `accessed = False` even when it carries data (see §4).

Then the view runs:

```
flask.session.get("k", 0)        # or flask.session["k"]
```

→ `SecureCookieSession.get` sets `self.accessed = True` (sessions.py:89) and returns the value. `modified` is untouched.

At the end of the response, `Flask.process_response` offers the session to `save_session` (`src/flask/app.py:1324-1325`):

```python
        if not self.session_interface.is_null_session(ctx.session):
            self.session_interface.save_session(self, ctx.session, response)
```

`save_session` (`src/flask/sessions.py:351-399`, verbatim):

```python
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

Control flow for a pure read, in order:

1. **Line 363** `if session.accessed:` → **line 364** `response.vary.add("Cookie")`. This is the *only* consumption of `accessed` anywhere in `src/`. Result: a `Vary: Cookie` response header.
2. **Line 368** `if not session:` — a truthiness/length test only; no access-flag side effect.
3. **Line 383** `if not self.should_set_cookie(app, session): return` — the gate. For a read of a non-permanent session: `session.modified` is `False`, and `session.permanent` is `False`, so this returns `False`, and **`save_session` returns before line 387**.
4. **Line 387** is the signed-cookie-string conversion (`get_signing_serializer(app).dumps(dict(session))`). **It is not reached** on a read that did not modify the session and did not use permanence + refresh.

So `accessed = True` lands at the `Vary` header (line 364) and nowhere else. The conversion at line 387 is gated solely by the line-383 predicate, which is `modified or (permanent and SESSION_REFRESH_EACH_REQUEST)`.

Key default: `SESSION_REFRESH_EACH_REQUEST` is `True` — `src/flask/app.py:197` (verbatim with neighbours):

```python
            "SESSION_COOKIE_PARTITIONED": False,
            "SESSION_COOKIE_SAMESITE": None,
            "SESSION_REFRESH_EACH_REQUEST": True,
            "MAX_CONTENT_LENGTH": None,
```

Consequently, if the session *is* permanent, line 387 **is** reached on every request — but that is caused by `permanent` + refresh, **not** by `accessed`. A request that never touches `flask.session` at all still re-signs a permanent session (proved by `test_session_refresh_vary`, §6).

---

## 3. Closed set of writers and readers of the two flags

Exhaustive grep over `src/` (from the evidence report):

```
$ grep -rn "accessed" src/ --include=*.py
src/flask/sessions.py:49:    accessed = True
src/flask/sessions.py:56:    :attr:`accessed` attributes. It cannot reliably track whether the
src/flask/sessions.py:72:    accessed = False
src/flask/sessions.py:80:            self.accessed = True
src/flask/sessions.py:85:        self.accessed = True
src/flask/sessions.py:89:        self.accessed = True
src/flask/sessions.py:93:        self.accessed = True
src/flask/sessions.py:362:         # Add a "Vary: Cookie" header if the session was accessed at all.
src/flask/sessions.py:363:         if session.accessed:
```

(Plus unrelated prose hits in `cli.py`, `debughelpers.py`, `sansio/app.py`.)

```
$ grep -n "modified" src/flask/sessions.py
44:    modified = True
55:    This session backend will set the :attr:`modified` and
66:    modified = False
79:            self.modified = True
250:        has been modified, the cookie is set. If the session is permanent and
259:        return session.modified or (
366:        # If the session is modified to be empty, remove the cookie.
369:            if session.modified:
```

- **`accessed` writers:** class defaults `sessions.py:49` and `:72`; instance writes only at `:80` (`on_update`), `:85` (`__getitem__`), `:89` (`get`), `:93` (`setdefault`).
- **`accessed` reader:** `sessions.py:363` only.
- **`modified` writers:** `sessions.py:79` (`on_update`), driven by werkzeug's `UpdateDictMixin` (all mutating methods), plus explicit user code.
- **`modified` readers:** `sessions.py:259` (`should_set_cookie`) and `sessions.py:369` (the empty-session `delete_cookie` branch).

There is no dictionary **read** path, other than `setdefault` on a missing key, that writes `modified`.

---

## 4. Why `setdefault` is the one dictionary-access-shaped method that *can* re-sign

`SecureCookieSession.setdefault` (sessions.py:92-94) calls `super().setdefault`, which is werkzeug 3.1.3's `UpdateDictMixin.setdefault` (`.venv/Lib/site-packages/werkzeug/datastructures/mixins.py:258-263`, verbatim):

```python
    def setdefault(self: te.Self, key: K, default: V | None = None) -> V:
        modified = key not in self
        rv = super().setdefault(key, default)  # type: ignore[arg-type]
        if modified and self.on_update is not None:
            self.on_update(self)
        return rv
```

So `setdefault` calls `on_update` **only when the key was absent**; `on_update` (sessions.py:78-80) then sets `modified = True` **and** `accessed = True`. `modified = True` makes `should_set_cookie` return `True`, so line 387 runs — a "read-looking" call re-signs the cookie.

By contrast, `UpdateDictMixin` has **no** `get`/`__getitem__`/`__contains__`, and `CallbackDict.__init__` never fires `on_update`. `structures.py:1038-1057` (verbatim):

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

Hence opening a session with data leaves `modified == accessed == False`.

---

## 5. What one `dumps()` actually costs (the "conversion")

`get_signing_serializer` (`src/flask/sessions.py:317-335`), reaching `URLSafeTimedSerializer` with the Flask `TaggedJSONSerializer`:

```python
        return URLSafeTimedSerializer(
            keys,  # type: ignore[arg-type]
            salt=self.salt,
            serializer=self.serializer,
            signer_kwargs={
                "key_derivation": self.key_derivation,
                "digest_method": self.digest_method,
            },
        )
```

One `dumps(dict(session))` performs, in order:

1. **Tagged JSON** — `src/flask/json/tag.py` `TaggedJSONSerializer.dumps` → `tag()` scans 8 tags per value recursively (`PassDict.to_json` walks every item), then `json.dumps(..., separators=(",", ":"))`.
2. **`want_bytes`** and **`zlib.compress`** of the JSON — itsdangerous `URLSafeSerializerMixin.dump_payload` (url_safe.py):

```python
    def dump_payload(self, obj: t.Any) -> bytes:
        json = super().dump_payload(obj)
        is_compressed = False
        compressed = zlib.compress(json)

        if len(compressed) < (len(json) - 1):
            json = compressed
            is_compressed = True

        base64d = base64_encode(json)

        if is_compressed:
            base64d = b"." + base64d

        return base64d
```

3. **URL-safe base64** of the (possibly compressed) JSON.
4. **Timestamp + HMAC-SHA1 signature** — `TimestampSigner.sign` appends a base64 timestamp, then `Signer.sign` → `get_signature` → `HMACAlgorithm.get_signature` computes `hmac.new(key, msg=value, digestmod=self.digest_method)`.

This is the expensive branch. The `accessed = True` store is a single `STORE_ATTR` on a plain instance (no `__slots__`).

---

## 6. Empirical results (raw output)

### 6a. The four named tests (`tests/test_basic.py`), run against this tree

The tests themselves are decisive, because they assert the exact flag semantics. `test_session` (`tests/test_basic.py:234-252`, verbatim — confirmed by my own read):

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

The `/get` route proves the point directly: **after a `.get()` read, `accessed` is `True` while `modified` stays `False`.**

`test_session_cookie_setting` (verbatim):

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

`/read` is a pure `flask.session.get("foo", 0)`. `Set-Cookie` is present **iff** `is_permanent and SESSION_REFRESH_EACH_REQUEST`. The read by itself never produces a cookie.

`test_session_refresh_vary` (verbatim):

```python
def test_session_refresh_vary(app, client):
    @app.get("/login")
    def login():
        flask.session["user_id"] = 1
        flask.session.permanent = True
        return ""

    @app.get("/ignored")
    def ignored():
        return ""

    rv = client.get("/login")
    assert rv.headers["Vary"] == "Cookie"
    rv = client.get("/ignored")
    assert rv.headers["Vary"] == "Cookie"
```

`/ignored` never touches `flask.session`, yet `Vary: Cookie` is present — that header comes from `save_session` line 399 (the cookie was written because permanent + refresh), not from the line-363 `accessed` check.

`test_session_vary_cookie` (verbatim):

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

`/get`, `/getitem`, `/setdefault` all produce `Vary: Cookie`. (Behind the test, `/setdefault` runs after `/set`, so the key already exists and `UpdateDictMixin.setdefault` does *not* call `on_update` — that route is a pure read there.) `/no-vary-header` produces no `Vary` at all.

All four tests pass in this tree:

```
$ PYTHONPATH="$(pwd)/src" .venv/Scripts/python.exe -m pytest "tests/test_basic.py::test_session" "tests/test_basic.py::test_session_cookie_setting" "tests/test_basic.py::test_session_vary_cookie" "tests/test_basic.py::test_session_refresh_vary" -p no:cacheprovider
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\24decd23\q1-TXT\seal
configfile: pyproject.toml
collected 4 items

tests\test_basic.py ....                                                 [100%]

============================== 4 passed in 0.12s ==============================
```

The full suite also passes unchanged: `489 passed in 6.11s` (plain) and `489 passed in 5.40s` (`-vvv -rA --tb=long`), with `git diff --stat` empty throughout.

### 6b. The probe (`alt_stories.py`) — complete raw output

Environment confirms this tree:

```
==============================================================================
ENVIRONMENT
==============================================================================
python        : 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
flask         : C:\Users\oobbee\AppData\Local\Temp\pi-p50o\24decd23\q1-TXT\seal\src\flask\__init__.py
flask.sessions: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\24decd23\q1-TXT\seal\src\flask\sessions.py
cwd           : C:\Users\oobbee\AppData\Local\Temp\pi-p50o\24decd23\q1-TXT\seal
```

**(a) `dict(session)` does not dispatch to the overridden readers** — so the conversion at line 387 never even touches `accessed` via the session methods:

```
==============================================================================
(a) DOES dict(session) DISPATCH TO SecureCookieSession.__getitem__ ?
==============================================================================
payload: {'a': 1, 'b': [1, 2, {'c': 3}], 'd': (4, 5)}
spy installed on SecureCookieSession.__getitem__ and .get
  spy check: s['a'] raised: SecureCookieSession.__getitem__ was called with 'a'
  spy check: s.get('a') raised: SecureCookieSession.get was called with 'a'
  dict(s)                      -> {'a': 1, 'b': [1, 2, {'c': 3}], 'd': (4, 5)} | spy calls: []
  ser.dumps(dict(s))           -> ok, len = 91 | spy calls: []
  ser.dumps(dict(s)) value     -> eyJhIjoxLCJiIjpbMSwyLHsiYyI6M31dLCJkIjp7IiB0IjpbNCw1XX19.asYMTA.bwNwI_SIOKZjkXWFHw0m0fylOw4
  direct __getitem__ call      -> raised: SecureCookieSession.__getitem__ was called with 'a'
  BUT: s.permanent (property -> self.get) with spy live:
    raised: SecureCookieSession.get was called with '_permanent'
  originals restored; __getitem__ is SecureCookieSession.__getitem__ | get is SecureCookieSession.get
  type(s).__iter__ : <slot wrapper '__iter__' of 'dict' objects>
  dict.__iter__    : <slot wrapper '__iter__' of 'dict' objects>
  type(s).__iter__ is dict.__iter__ : True
  'keys' in SecureCookieSession.__dict__ : False
  '__iter__' in SecureCookieSession.__dict__ : False
  keys() appears to be: <method 'keys' of 'dict' objects>
```

The spies never fire for `dict(s)` or `ser.dumps(dict(s))`; only a direct `s['a']`/`s.get()` (and `s.permanent`) does. `SecureCookieSession.__iter__ is dict.__iter__ → True`.

**(b) `key in session`, `bool`, `len`, `iter` do NOT set `accessed`:**

```
==============================================================================
(b) DOES `key in session` SET accessed ?
==============================================================================
  fresh session with 'k', accessed forced False -> False
  'k' in s        -> True | accessed now: False
  bool(s)         -> True | accessed now: False
  len(s)          -> 1 | accessed now: False
  iter(s)         -> ['k'] | accessed now: False
  s.get('k')      -> 1 | accessed now: True
  own __contains__ in class dict? False
  resolved __contains__: <method '__contains__' of 'dict' objects>

  WITH __contains__ tracking installed (hypothetical):
   body        : contains=True accessed=True modified=False
   Set-Cookie  : None
   Vary        : Cookie
   URLSafe.dumps calls: 0 (payload dumps: 0 )
  AFTER restoring dict.__contains__:
   body        : contains=True accessed=False modified=False
   Set-Cookie  : None
   Vary        : None
   URLSafe.dumps calls: 0 (payload dumps: 0 )
```

Even the hypothetical `__contains__` that sets `accessed` yields `Vary: Cookie` with **no `Set-Cookie` and 0 `dumps`** — i.e. tracking more reads cannot cause serialization.

**(c) Frequent reads on a permanent 21-key session — 300 requests each, two rounds:**

```
==============================================================================
(c) FREQUENT READS ON A PERMANENT SESSION, 21-KEY PAYLOAD
==============================================================================
--- round 1 (permanent session, 21 keys, 300 x GET /read-get) ---
case                              Set-Cookie  cookielen  Vary     URLSafe.dumps/req  payload dumps/req  ns/request   total s   save_session/req  save_session/call
permanent, refresh=True           True        221        Cookie   1.0                1.0                317812       0.0953    89006             89006
permanent, refresh=False          False       0          Cookie   0.0                0.0                195137       0.0585    8703              8703
non-permanent, refresh=False      False       0          Cookie   0.0                0.0                192569       0.0578    8147              8147
  ns/request delta (refresh True - refresh False) = 122675 ns
  save_session ns/req delta                       = 80303 ns
  save_session calls (on/off/nonperm)             = 300 / 300 / 300 for 300 requests each
  body (permanent/refresh=True) : get='vvvvvvvvvv' accessed=True modified=False
  body (permanent/refresh=False): get='vvvvvvvvvv' accessed=True modified=False
  body (non-permanent)          : get='vvvvvvvvvv' accessed=True modified=False

--- round 2 (permanent session, 21 keys, 300 x GET /read-get) ---
case                              Set-Cookie  cookielen  Vary     URLSafe.dumps/req  payload dumps/req  ns/request   total s   save_session/req  save_session/call
permanent, refresh=True           True        221        Cookie   1.0                1.0                330259       0.0991    90574             90574
permanent, refresh=False          False       0          Cookie   0.0                0.0                219394       0.0658    12311             12311
non-permanent, refresh=False      False       0          Cookie   0.0                0.0                212023       0.0636    9414              9414
  ns/request delta (refresh True - refresh False) = 110865 ns
  save_session ns/req delta                       = 78263 ns
  save_session calls (on/off/nonperm)             = 300 / 300 / 300 for 300 requests each
  body (permanent/refresh=True) : get='vvvvvvvvvv' accessed=True modified=False
  body (permanent/refresh=False): get='vvvvvvvvvv' accessed=True modified=False
  body (non-permanent)          : get='vvvvvvvvvv' accessed=True modified=False
```

Read carefully: in **every** cell `accessed=True` and `modified=False`. Yet the cookie is emitted and `dumps` runs **only** when `permanent and refresh=True` (1 `dumps`/request, `Set-Cookie` present, ~221-byte cookie, ~317–330 µs/request). With refresh off or non-permanent: `0` dumps, no `Set-Cookie`, ~190–219 µs/request — even though `accessed` is `True`. `Vary: Cookie` is present in all three (proving the flag did its job) while serialization is absent.

**(d) Cost of the flag store itself, measured by a literal source-rewrite variant** (a copy of `sessions.py` with the three `self.accessed = True` statements removed):

```
==============================================================================
(d) COST OF THE STORE_ATTR ITSELF (literal source-rewrite variant)
==============================================================================
lines that are exactly `        self.accessed = True` in sessions.py: [85, 89, 93]
NoFlagSession is a different class: True
--- dis: NoFlagSession.get (only difference vs shipped: no STORE_ATTR) ---
  --           COPY_FREE_VARS           1

  87           RESUME                   0

  88           LOAD_GLOBAL              0 (super)
               LOAD_DEREF               3 (__class__)
               LOAD_FAST                0 (self)
               LOAD_SUPER_ATTR          5 (get + NULL|self)
               LOAD_FAST_LOAD_FAST     18 (key, default)
               CALL                     2
               RETURN_VALUE
timeit N=1000000 repeat=7
  shipped  SecureCookieSession.get (with self.accessed = True): ['129.3 ns', '119.3 ns', '114.1 ns', '111.6 ns', '114.2 ns', '118.5 ns', '111.2 ns']  best=111.2 ns
  no-flag  NoFlagSession.get       (that one stmt removed)  : ['90.9 ns', '91.3 ns', '90.8 ns', '88.5 ns', '93.3 ns', '90.3 ns', '91.1 ns']  best=88.5 ns
  => isolated cost of the `self.accessed = True` statement: 22.7 ns per read
  one ser.dumps(21 keys)            : 29867 ns
  ratio dumps(21 keys) / flag write : 1315x
  ratio using the step-3 number (23.9 ns): 1250x
```

The flag store costs **22.7 ns** per read (step 3 measured 23.9 ns); one `dumps()` of a 21-key payload costs **29 867 ns** — the serialization is ~1315× the flag write. Even in the hypothetical where reads did trigger `dumps`, the `accessed` store would be a rounding error against serialization + HMAC.

The step-3 probe (310-line output, unchanged on disk) adds: a 1-key `dumps` is 15 749 ns (~660× the flag write); removing the three `self.accessed = True` statements changed **only** the `Vary` header — cookie emission and `URLSafeTimedSerializer.dumps` counts were identical in every cell — and `setdefault("absent", ...)` on an empty non-permanent session produced `modified == True` → 1 `dumps` → `Set-Cookie` on a read-looking call.

---

## 7. What the real per-request costs are

For a **frequent plain read** (`session.get(...)` / `session[...]`):

1. **One instance-attribute store** (`self.accessed = True`) — measured at ~22.7 ns. Negligible.
2. **A `Vary: Cookie` response header** — a deliberate, documented side effect so caching proxies key their cache on the cookie. The changelog records it (`CHANGES.rst:868-869`): *"`Cookie` is added to the response's `Vary` header if the session is accessed at all during the request (and not deleted). :pr:`2288`"*. This is an HTTP header, **not** serialization.
3. **No serialization or signing** — unless the session is permanent *or* was modified by something else.

For a **permanent** session (the default `SESSION_REFRESH_EACH_REQUEST = True`, `app.py:197`), the cookie is re-serialized and re-signed **on every request regardless of reads** — measured at ~1 `dumps`/request, ~89–91 µs/request inside `save_session`, ~221-byte cookie, and ~78–122 µs/request more than with refresh off (§6c). `test_session_refresh_vary` shows this happens even on `/ignored`, a route that never touches the session. **That** — `permanent` + refresh, not `accessed` — is the real "frequent-read-era" cost.

Additional per-request overhead independent of the flags: `get_signing_serializer` is constructed **twice** per request (sessions.py:338 and :387), and each `URLSafeTimedSerializer.__init__` calls `is_text_serializer(serializer)` = `serializer.dumps({})` — one extra trivial JSON dump per construction.

---

## 8. The one genuine link from a dictionary-access method to re-signing

`session.setdefault(key, default)` **on an absent key** is the only read-shaped method that can trigger serialization, and it does so by setting **`modified`**, not by setting `accessed`:

`SecureCookieSession.setdefault` (sessions.py:92-94) → `UpdateDictMixin.setdefault` (mixins.py:258-263) → `on_update` (sessions.py:78-80) → `self.modified = True` (line 79) → `should_set_cookie` returns `True` (line 259) → `dumps` (line 387).

Proven empirically in step 3e (quoted above): `setdefault("absent", ...)` on an empty non-permanent session gave `modified == True`, 1 `dumps`, and `Set-Cookie` present. Contrast `setdefault` on a **present** key, which does *not* call `on_update` (mixins.py:261 `if modified and ...`) — that is how `test_session_vary_cookie`'s `/setdefault` route behaves as a pure read.

So if a project ever *did* observe cookie re-signing on plain reads, the cause would be `modified` (or `permanent` + refresh), **never** `accessed`.

---

## 9. Answering the "why does it impact …" phrasing head-on

The claim that setting the access-tracking attribute impacts signed-cookie-string conversion performance is **not supported by this source tree**. The premise merges two attributes that drive two unrelated outputs:

| Attribute | Written by | Read by | Consequence |
|---|---|---|---|
| `accessed` | `on_update` (sessions.py:80), `__getitem__` (:85), `get` (:89), `setdefault` (:93) | `save_session` **only** (sessions.py:363) | `response.vary.add("Cookie")` (:364) |
| `modified` | `on_update` (sessions.py:79) + werkzeug mutations | `should_set_cookie` (sessions.py:259) | reaches `dumps` (sessions.py:387) → serialization + HMAC + `Set-Cookie` |

Since `dumps` at line 387 is *after* the line-383 gate, and that gate never consults `accessed`, the access flag cannot affect conversion cost. The only two ways a plain read could ever be made to re-sign are:

**Hypothesis 1 — a session backend whose readers also mark `modified`.** This is exactly what `on_update` does (it sets *both* flags), and it is the path `setdefault`-on-a-missing-key takes. A custom `session_class` that set `modified = True` in `__getitem__`/`get` would make `should_set_cookie` return `True` and thus re-serialize on every read. Falsifiable against this tree: `test_session`'s `/get` asserts `assert not flask.session.modified` after a `.get()` (test_basic.py:250), and the probe shows `modified=False` in every read cell (§6c). So the shipped `SecureCookieSession` does **not** do this.

**Hypothesis 2 — permanence + `SESSION_REFRESH_EACH_REQUEST`.** Any request on a permanent session re-signs, read or not, because line 260 is `session.permanent and app.config["SESSION_REFRESH_EACH_REQUEST"]` and the config defaults to `True` (app.py:197). Falsifiable: `test_session_cookie_setting` flips both booleans and shows `Set-Cookie` present iff `permanent and refresh`; the probe's 300-request matrix shows 1 `dumps`/request with permanent+refresh vs 0 otherwise, with `accessed=True` in all cells (§6c).

Either observation that looks like "reads re-sign" is explained by one of these, and neither implicates the `accessed` attribute.

---

## 10. Scope and caveats

- **Scope:** Flask `3.2.0.dev0` (`pyproject.toml` `version = "3.2.0.dev"`), checkout `85c5d93`, itsdangerous 2.2.0, werkzeug 3.1.3, Python 3.13.9. The `Vary: Cookie` behaviour is newer than older Flask releases (`CHANGES.rst:122`, `:195`, `:868-869`); `accessed` is an internal, undocumented attribute (`docs/api.rst` documents only `new`, `modified`, `permanent`).
- **No mutation detected:** the session code path is consistent with the documented upstream implementation. `git diff --stat` was empty throughout all experiments; nothing under `src/`, `tests/`, or `examples/` was modified.
- **`dict(session)` claim proved, not assumed:** the raising-spy experiment (§6a) shows `dict(s)`/`ser.dumps(dict(s))` never dispatch to `SecureCookieSession.__getitem__`/`get`, so the conversion at line 387 cannot itself toggle `accessed` through the session methods. (`SecureCookieSession.__iter__ is dict.__iter__ → True`; no `keys`/`__iter__`/`__contains__` in the class `__dict__`.)
- **Verification details:** all runs used `PYTHONPATH="$(pwd)/src"` because the venv's `flask.pth` points at a different copy of Flask; this forces `import flask` to resolve to this tree. Both `PYTHONPATH` and fresh-bytecode-cache (`PYTHONPYCACHEPREFIX`) runs produced identical results (489 passed).
- **One requested action I could not complete:** the plan's final cleanup step asks to delete the scratch directory `.scratch_q1/`. I have no delete tool available, so `.scratch_q1/` (untracked; contains only probe scripts and logs, nothing under `src/`, `tests/`, or `examples/`) still exists in the working tree. Everything under version control is untouched (`git diff --stat` empty).
# Why repeated invocation of `get_signing_serializer` becomes a per-request bottleneck under high concurrency

**Short answer.** The method "that instantiates cryptographic serializers" inside the session persistence handler is `SecureCookieSessionInterface.get_signing_serializer` (`src/flask/sessions.py:317`). It constructs a **brand-new `URLSafeTimedSerializer` on every call**, with nothing cached anywhere in `src/flask`. It is called **unconditionally once per request** from `open_session` (`src/flask/sessions.py:338`) — before the code even looks for a session cookie — and **a second time on the same request** from `save_session` (`src/flask/sessions.py:387`) whenever a cookie is written. Because that constructor-side work is pure setup that is thrown away after a single `loads`/`dumps`, aggregate setup CPU grows linearly with request rate; in a threaded WSGI worker it is CPU-bound under the GIL, so concurrent requests contend for the same interpreter lock instead of scaling, and multi-process workers each duplicate the same setup. The measured construction cost is ~8.5 µs per call (median) and the fresh-vs-reused delta is ~10.9 µs per `dumps` and ~11.8 µs per `loads`; measured throughput is flat-to-declining from T=1 to T=64 threads (0.91×), while a hoisted serializer is ~15% faster per request at every T. Crucially, reuse removes only the constructor-side setup — the HMAC signing/verification and `TimestampSigner` construction happen *inside* every operation regardless.

Working checkout: Flask `3.2.0.dev0` at git commit `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, `itsdangerous 2.2.0`, CPython 3.13.9 with the GIL enabled (`Py_GIL_DISABLED=0`).

---

## 1. What is invoked

`SecureCookieSessionInterface.get_signing_serializer` — `src/flask/sessions.py:317-335`, verbatim and complete:

```python
    def get_signing_serializer(self, app: Flask) -> URLSafeTimedSerializer | None:
        if not app.secret_key:
            return None

        keys: list[str | bytes] = []

        if fallbacks := app.config["SECRET_KEY_FALLBACKS"]:
            keys.extend(fallbacks)

        keys.append(app.secret_key)  # itsdangerous expects current key at top
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

Every argument except `keys` is a class attribute that is constant for the life of the process — `src/flask/sessions.py:298-315`:

```python
class SecureCookieSessionInterface(SessionInterface):
    """The default session interface that stores sessions in signed cookies
    through the :mod:`itsdangerous` module.
    """

    #: the salt that should be applied on top of the secret key for the
    #: signing of cookie based sessions.
    salt = "cookie-session"
    #: the hash function to use for the signature.  The default is sha1
    digest_method = staticmethod(_lazy_sha1)
    #: the name of the itsdangerous supported key derivation.  The default
    #: is hmac.
    key_derivation = "hmac"
    #: A python serializer for the payload.  The default is a compact
    #: JSON derived serializer with support for some extra Python types
    #: such as datetime objects or tuples.
    serializer = session_json_serializer
    session_class = SecureCookieSession
```

The serializer object passed as `serializer=` is itself a module-level singleton (`src/flask/sessions.py:287`: `session_json_serializer = TaggedJSONSerializer()`), and `URLSafeTimedSerializer` declares **no `__init__` of its own** — it inherits `URLSafeSerializerMixin` → `TimedSerializer` → `Serializer`:

```python
class URLSafeTimedSerializer(URLSafeSerializerMixin, TimedSerializer[str]):
    """Works like :class:`.TimedSerializer` but dumps and loads into a URL
    safe string consisting of the upper and lowercase character of the
    alphabet as well as ``'_'``, ``'-'`` and ``'.'``.
    """
```

There is no cache: a grep for `cache|lru_cache|_cache` restricted to `src/flask/sessions.py` returns only a docstring mention of caching proxies, and the whole-worktree grep for `get_signing_serializer` returns exactly the definition plus the two call sites:

```
src/flask/sessions.py:317:    def get_signing_serializer(self, app: Flask) -> URLSafeTimedSerializer | None:
src/flask/sessions.py:338:        s = self.get_signing_serializer(app)
src/flask/sessions.py:387:        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
```

**"The session persistence handler" is `SecureCookieSessionInterface`** (`src/flask/sessions.py:298`), whose `open_session` (line 337) and `save_session` (line 351) are the per-request load/store hooks. The contract spells out that these run on every request — `src/flask/sessions.py:263-286`:

```python
    def open_session(self, app: Flask, request: Request) -> SessionMixin | None:
        """This is called at the beginning of each request, after
        pushing the request context, before matching the URL.
        ...
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

---

## 2. How often is it invoked

### Call site #1 — `open_session`, unconditionally per request

`src/flask/sessions.py:337-349`:

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

Note the ordering: `get_signing_serializer(app)` (338) runs **before** `request.cookies.get(...)` (341). So a request that carries no session cookie at all still pays a full serializer construction and then discards the object. This is reached from `RequestContext.push`, `src/flask/ctx.py:380-393`:

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
        if self.url_adapter is not None:
            self.match_request()
```

`open_session` at line 386 fires **before URL matching** (393) and before any view runs.

### Call site #2 — `save_session`, second construction per session-writing request

`src/flask/sessions.py:351-405` (verbatim, complete; file ends at 405):

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

Line 387 builds **a second serializer for the same request** and throws it away after one `.dumps()`. The two guards above it are `if not session:` (367) and `if not self.should_set_cookie(app, session):` (376).

`should_set_cookie` — `src/flask/sessions.py:247-261`:

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

With the default `SESSION_REFRESH_EACH_REQUEST = True` (`src/flask/app.py:197`), a *permanent* session writes the cookie — and therefore constructs a second serializer — on **every** response, not just on modification. This is reached from `Flask.process_response`, `src/flask/app.py:1319-1324`:

```python
        if not self.session_interface.is_null_session(ctx.session):
            self.session_interface.save_session(self, ctx.session, response)

        return response
```

### Call site #3 (tests only) — `FlaskClient.session_transaction` hits both

`src/flask/testing.py:161-182`:

```python
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
```

Both `open_session` (165) and `save_session` (177) are called on the same interface in the same transaction ⇒ 2 constructions per transaction.

### Measured invocation counts (executor step 3)

Scratch instrumentation wrapped `SecureCookieSessionInterface.get_signing_serializer`, `itsdangerous.URLSafeTimedSerializer.__init__`, `itsdangerous.serializer.is_text_serializer`, `itsdangerous.signer.Signer.__init__`, and `flask.json.tag.TaggedJSONSerializer.dumps`, and issued requests through the test client. Complete output:

```
=== (iii) TaggedJSONSerializer.dumps delta across ONE construction ===
construction-only: TaggedJSONSerializer.dumps before/after = 0/1  delta=1
construction-only: is_text_serializer before/after = 0/1  delta=1

=== per-request counts (fresh test client, non-permanent session) ===
GET /get  (no session cookie)                        status=200 | get_signing_serializer=1 URLSafeTimedSerializer.__init__=1 is_text_serializer=1 TaggedJSONSerializer.dumps=1 Signer.__init__=0
POST /set (sets session -> cookie written)           status=200 | get_signing_serializer=2 URLSafeTimedSerializer.__init__=2 is_text_serializer=2 TaggedJSONSerializer.dumps=3 Signer.__init__=1
GET /get (carries cookie, not modified, not permanent) status=200 | get_signing_serializer=1 URLSafeTimedSerializer.__init__=1 is_text_serializer=1 TaggedJSONSerializer.dumps=1 Signer.__init__=1

=== per-request counts (fresh test client, PERMANENT session) ===
POST /set-permanent (sets permanent session)         status=200 | get_signing_serializer=2 URLSafeTimedSerializer.__init__=2 is_text_serializer=2 TaggedJSONSerializer.dumps=3 Signer.__init__=1
GET /get (permanent, default SESSION_REFRESH_EACH_REQUEST=True) status=200 | get_signing_serializer=2 URLSafeTimedSerializer.__init__=2 is_text_serializer=2 TaggedJSONSerializer.dumps=3 Signer.__init__=2
GET /get (permanent, again)                          status=200 | get_signing_serializer=2 URLSafeTimedSerializer.__init__=2 is_text_serializer=2 TaggedJSONSerializer.dumps=3 Signer.__init__=2

=== control: no secret key -> get_signing_serializer returns None ===
GET / (no SECRET_KEY) status=200 | get_signing_serializer=1 URLSafeTimedSerializer.__init__=0 TaggedJSONSerializer.dumps=0 Signer.__init__=0
EXIT=0
```

Summary of the counts (facts, not interpretation):
- A request with **no session cookie** still instantiates one serializer (`get_signing_serializer=1`, `URLSafeTimedSerializer.__init__=1`) because `open_session` calls it at line 338 *before* the cookie lookup at line 341.
- A request that **sets the session** instantiates **two** (`=2`): one in `open_session` (338), one in `save_session` (387). Permanent-session GETs also show **2 per request** because the default `SESSION_REFRESH_EACH_REQUEST=True` makes `should_set_cookie` true on every response.
- The no-secret-key control shows `get_signing_serializer=1` but `URLSafeTimedSerializer.__init__=0`: the method is called, then returns `None` at the `if not app.secret_key` guard without constructing anything.

---

## 3. What each construction actually costs (the itsdangerous cascade)

`URLSafeTimedSerializer(...)` runs the inherited `Serializer.__init__` — `.venv/Lib/site-packages/itsdangerous/serializer.py:192-236`:

```python
    def __init__(
        self,
        secret_key: str | bytes | cabc.Iterable[str] | cabc.Iterable[bytes],
        salt: str | bytes | None = b"itsdangerous",
        serializer: t.Any | None = None,
        serializer_kwargs: dict[str, t.Any] | None = None,
        signer: type[Signer] | None = None,
        signer_kwargs: dict[str, t.Any] | None = None,
        fallback_signers: list[
            dict[str, t.Any] | tuple[type[Signer], dict[str, t.Any]] | type[Signer]
        ]
        | None = None,
    ):
        #: The list of secret keys to try for verifying signatures, from
        #: oldest to newest. The newest (last) key is used for signing.
        #:
        #: This allows a key rotation system to keep a list of allowed
        #: keys and remove expired ones.
        self.secret_keys: list[bytes] = _make_keys_list(secret_key)

        if salt is not None:
            salt = want_bytes(salt)
            # if salt is None then the signer's default is used

        self.salt = salt

        if serializer is None:
            serializer = self.default_serializer

        self.serializer: _PDataSerializer[_TSerialized] = serializer
        self.is_text_serializer: bool = is_text_serializer(serializer)

        if signer is None:
            signer = self.default_signer

        self.signer: type[Signer] = signer
        self.signer_kwargs: dict[str, t.Any] = signer_kwargs or {}

        if fallback_signers is None:
            fallback_signers = list(self.default_fallback_signers)

        self.fallback_signers: list[
            dict[str, t.Any] | tuple[type[Signer], dict[str, t.Any]] | type[Signer]
        ] = fallback_signers
        self.serializer_kwargs: dict[str, t.Any] = serializer_kwargs or {}
```

Per-construction work: `_make_keys_list` (210), `want_bytes(salt)` (212-214), `is_text_serializer(serializer)` → `serializer.dumps({})` (222), `dict(...or {})` copies of `signer_kwargs`/`serializer_kwargs` (224/236), `list(...)` copy of `default_fallback_signers` (231).

`_make_keys_list` (`itsdangerous/signer.py:67-71`) runs on every serializer *and* signer construction:

```python
def _make_keys_list(
    secret_key: str | bytes | cabc.Iterable[str] | cabc.Iterable[bytes],
) -> list[bytes]:
    if isinstance(secret_key, (str, bytes)):
        return [want_bytes(secret_key)]

    return [want_bytes(s) for s in secret_key]  # pyright: ignore
```

Flask passes a **list** (`keys`, sessions.py:327-328), so this takes the list branch and `want_bytes`-encodes every key.

### The constructor probe performs a real payload serialization

`itsdangerous/serializer.py:34-39`:

```python
# Use TypeIs once it's available in typing_extensions or 3.13.
def is_text_serializer(
    serializer: _PDataSerializer[t.Any],
) -> te.TypeGuard[_PDataSerializer[str]]:
    """Checks whether a serializer generates text or binary."""
    return isinstance(serializer.dumps({}), str)
```

That `serializer.dumps({})` lands in Flask's `TaggedJSONSerializer` (`src/flask/json/tag.py:289-323`):

```python
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value
```

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

→ `is_text_serializer`'s `serializer.dumps({})` executes a loop over the 8 registered tag objects (`default_tags = [TagDict, PassDict, TagTuple, PassList, TagBytes, TagMarkup, TagUUID, TagDateTime]`, `tag.py:242-251`) plus `flask.json.dumps` — **on every serializer construction**. And because `RequestContext.push` pushes the app context before opening the session (ctx.py:374-386), that `dumps({})` takes the `current_app.json.dumps` branch (`src/flask/json/__init__.py:13-46`), i.e. `DefaultJSONProvider.dumps` (`src/flask/json/provider.py:166-180`) with its `sort_keys=True` default. **This is setup that produces a throwaway `"{}"` and is repeated per construction.**

Measured proof (step 3, above): constructing one serializer moves `TaggedJSONSerializer.dumps` from `0/1`, `delta=1`.

### Per-operation work (not removed by reuse)

Further signer instances are built on every serialization *operation*, not at serializer construction — `itsdangerous/serializer.py:280-347`:

```python
    def make_signer(self, salt: str | bytes | None = None) -> Signer:
        """Creates a new instance of the signer to be used. The default
        implementation uses the :class:`.Signer` base class.
        """
        if salt is None:
            salt = self.salt

        return self.signer(self.secret_keys, salt=salt, **self.signer_kwargs)

    def iter_unsigners(self, salt: str | bytes | None = None) -> cabc.Iterator[Signer]:
        """Iterates over all signers to be tried for unsigning. Starts
        with the configured signer, then constructs each signer
        specified in ``fallback_signers``.
        """
        if salt is None:
            salt = self.salt

        yield self.make_signer(salt)

        for fallback in self.fallback_signers:
            if isinstance(fallback, dict):
                kwargs = fallback
                fallback = self.signer
            elif isinstance(fallback, tuple):
                fallback, kwargs = fallback
            else:
                kwargs = self.signer_kwargs

            for secret_key in self.secret_keys:
                yield fallback(secret_key, salt=salt, **kwargs)

    def dumps(self, obj: t.Any, salt: str | bytes | None = None) -> _TSerialized:
        """Returns a signed string serialized with the internal
        serializer. ...
        """
        payload = want_bytes(self.dump_payload(obj))
        rv = self.make_signer(salt).sign(payload)

        if self.is_text_serializer:
            return rv.decode("utf-8")  # type: ignore[return-value]

        return rv  # type: ignore[return-value]
```

The signer actually used is `TimestampSigner` (`itsdangerous/timed.py:170-175`):

```python
class TimedSerializer(Serializer[_TSerialized]):
    """Uses :class:`TimestampSigner` instead of the default
    :class:`.Signer`.
    """

    default_signer: type[TimestampSigner] = TimestampSigner
```

`Signer.__init__` (`itsdangerous/signer.py:129-179`) itself repeats `_make_keys_list`, `want_bytes(sep)`, an alphabet check, and allocates `HMACAlgorithm`. The crypto is in `derive_key`, `get_signature`, `sign`, `verify_signature`, `unsign` (`itsdangerous/signer.py:182-265`):

```python
    def derive_key(self, secret_key: str | bytes | None = None) -> bytes:
        """This method is called to derive the key. ...
        """
        if secret_key is None:
            secret_key = self.secret_keys[-1]
        else:
            secret_key = want_bytes(secret_key)

        if self.key_derivation == "concat":
            return t.cast(bytes, self.digest_method(self.salt + secret_key).digest())
        elif self.key_derivation == "django-concat":
            return t.cast(
                bytes, self.digest_method(self.salt + b"signer" + secret_key).digest()
            )
        elif self.key_derivation == "hmac":
            mac = hmac.new(secret_key, digestmod=self.digest_method)
            mac.update(self.salt)
            return mac.digest()
        ...
```

```python
    def verify_signature(self, value: str | bytes, sig: str | bytes) -> bool:
        """Verifies the signature for the given value."""
        try:
            sig = base64_decode(sig)
        except Exception:
            return False

        value = want_bytes(value)

        for secret_key in reversed(self.secret_keys):
            key = self.derive_key(secret_key)

            if self.algorithm.verify_signature(key, value, sig):
                return True

        return False
```

`verify_signature` iterates `reversed(self.secret_keys)` — one `derive_key` HMAC per key tried. This is the documented overhead path for `SECRET_KEY_FALLBACKS` (`docs/config.rst:128-141`):

```rst
.. py:data:: SECRET_KEY_FALLBACKS

    A list of old secret keys that can still be used for unsigning. This allows
    a project to implement key rotation without invalidating active sessions or
    other recently-signed secrets.

    Keys should be removed after an appropriate period of time, as checking each
    additional key adds some overhead.

    Order should not matter, but the default implementation will test the last
    key in the list first, so it might make sense to order oldest to newest.
```

And the actual digest call (`itsdangerous/signer.py:42-64`):

```python
class HMACAlgorithm(SigningAlgorithm):
    """Provides signature generation using HMACs."""
    ...
    def get_signature(self, key: bytes, value: bytes) -> bytes:
        mac = hmac.new(key, msg=value, digestmod=self.digest_method)
        return mac.digest()
```

**Cascade summary:** 1 `URLSafeTimedSerializer` per call → `_make_keys_list` + `want_bytes(salt)` + `is_text_serializer(serializer)` (⇒ `TaggedJSONSerializer.dumps({})`) + dict/list copies; then, per operation, ≥1 fresh `TimestampSigner` via `make_signer`/`iter_unsigners` and ≥1 `derive_key` HMAC (one per key tried on verify).

---

## 4. Why this becomes a bottleneck specifically under high concurrency

The measured data (all with `PYTHONPATH=src`, this checkout's `flask`, `itsdangerous 2.2.0`, CPython 3.13.9 GIL enabled) separates the two cost components.

### 4a. Per-construction cost and the re-use delta (step 4)

Payload `{"a": 1, "u": uuid4(), "d": datetime.now(timezone.utc)}`, `max_age=2678400`, 100 000 samples per arm, arms interleaved in randomized order over 10 rounds, `perf_counter_ns` per call:

```
$ PYTHONPATH=src .venv/Scripts/python.exe flask_mut2_i417ar2x/bench_timing.py
payload = {'a': 1, 'u': UUID('c3e38381-1ef5-4533-8f07-fdd82749ed27'), 'd': datetime.datetime(2026, 10, 7, 5, 20, 0, 946398, tzinfo=datetime.timezone.utc)}
max_age = 2678400
interleaved randomized rounds: ROUNDS=10 ROUND_SIZE=10000

construct-only               n=100000  median=    8.500 us  mean=    8.054 us  p99=   15.500 us  min=    3.200 us
dumps (fresh serializer)     n=100000  median=   60.700 us  mean=   60.270 us  p99=  164.800 us  min=   24.900 us
dumps (reused serializer)    n=100000  median=   49.800 us  mean=   49.161 us  p99=  134.700 us  min=   19.700 us
loads (fresh serializer)     n=100000  median=   64.800 us  mean=   64.392 us  p99=  170.200 us  min=   28.900 us
loads (reused serializer)    n=100000  median=   53.000 us  mean=   51.963 us  p99=  144.000 us  min=   21.300 us

reused dumps: Signer.__init__ 100000 / 100000 dumps (1.000 per op) -> signer+crypto still paid per op
reused loads: Signer.__init__ 100000 / 100000 loads (1.000 per op) -> signer+crypto still paid per op

=== derived ===
construction-only: median 0.0085 ms/op, mean 0.0081 ms/op
per 1k requests: 1 construction each  => 8.50 ms (median) / 8.05 ms (mean) of pure setup CPU
per 1k requests: 2 constructions each => 17.00 ms (median) / 16.11 ms (mean) of pure setup CPU
dumps median fresh/reused = 60.700 / 49.800 us -> delta 10900 ns (18.0% of the fresh dumps)
loads median fresh/reused = 64.800 / 53.000 us -> delta 11800 ns (18.2% of the fresh loads)
EXIT=0
```

- Construction-only cost: median **8.500 µs**, mean 8.054 µs, p99 15.5 µs.
- `dumps` fresh vs reused: **60.7 µs vs 49.8 µs** → delta **10.9 µs** (~18.0%).
- `loads` fresh vs reused: **64.8 µs vs 53.0 µs** → delta **11.8 µs** (~18.2%).
- **Derived: N requests ⇒ N (or 2N) constructions ⇒ 8.50 ms of pure setup CPU per 1 000 session-reading requests, 17.00 ms per 1 000 session-writing requests** (medians).
- **Guardrail, measured:** `Signer.__init__` runs **1.000 per `dumps` and 1.000 per `loads` even with a fully reused serializer**. So the HMAC in `Signer.derive_key` is **not** eliminated by reuse — it happens inside `Signer.sign`/`verify_signature` on every operation. The ~11 µs fresh−reused delta is construction-side setup only, and must not be conflated with total crypto cost. (An earlier non-interleaved pass showed an ordering artifact, `dumps` fresh 32.2 µs vs reused 50.6 µs; it was discarded and the arm order randomized, which is why the corrected run above is the reported one.)

### 4b. Concurrency: throughput does not scale with T (step 5)

Each simulated request = `open_session` + modify + `save_session` (so 2 constructions/request). All `(variant, T)` combinations randomized per round, best-of-4, ~8192 requests per combination. The "hoisted" variant caches one serializer per process:

```
$ PYTHONPATH=src .venv/Scripts/python.exe flask_mut2_i417ar2x/bench_concurrency.py
=== construction counts over 100 requests (2 calls expected per req) ===
default (rebuild per call)   get_signing_serializer=200 for 100 requests (2.00/req)  URLSafeTimedSerializer.__init__=200 (2.00/req)
hoisted (one per process)    get_signing_serializer=0 for 100 requests (0.00/req)  URLSafeTimedSerializer.__init__=0 (0.00/req)

=== throughput, all (variant, T) combos randomized per round, best of 4 ===
   T variant                        total   wall(s)      req/s    us/req
   1 default (rebuild per call)      8192     0.732      11191      89.4
   1 hoisted (one per process)       8192     0.633      12948      77.2
   4 default (rebuild per call)      8192     0.763      10731      93.2
   4 hoisted (one per process)       8192     0.666      12300      81.3
  16 default (rebuild per call)      8192     0.785      10437      95.8
  16 hoisted (one per process)       8192     0.669      12253      81.6
  64 default (rebuild per call)      8192     0.803      10201      98.0
  64 hoisted (one per process)       8192     0.698      11740      85.2

=== relative throughput within each variant (vs its own T=1) ===
default (rebuild per call)
   T=  1:    11191 req/s   speedup vs T=1: 1.00x
   T=  4:    10731 req/s   speedup vs T=1: 0.96x
   T= 16:    10437 req/s   speedup vs T=1: 0.93x
   T= 64:    10201 req/s   speedup vs T=1: 0.91x
hoisted (one per process)
   T=  1:    12948 req/s   speedup vs T=1: 1.00x
   T=  4:    12300 req/s   speedup vs T=1: 0.95x
   T= 16:    12253 req/s   speedup vs T=1: 0.95x
   T= 64:    11740 req/s   speedup vs T=1: 0.91x

=== control: pure-Python CPU-bound (no Flask), best of 3 ===
   T   total   wall(s)    iter/s
   1    2000     0.012    170042   (speedup vs T=1: 1.00x)
   4    2000     0.011    184826   (speedup vs T=1: 1.09x)
  16    2000     0.013    154394   (speedup vs T=1: 0.91x)
  64    1984     0.019    103117   (speedup vs T=1: 0.61x)
EXIT=0
```

Facts:
- Throughput does **not** rise with T: default goes **11191 → 10201 req/s** for T=1→64 (0.91×, flat/slightly declining); hoisted goes **12948 → 11740 req/s** (0.91×). Per-request wall time *rises* (89.4 → 98.0 µs default; 77.2 → 85.2 µs hoisted).
- The hoisted variant is **~15% higher throughput at every T** (e.g. T=64: 11740 vs 10201).
- The pure-Python CPU-bound control also fails to scale (170042 → 103117 iter/s, 0.61× at T=64), confirming the interpreter's GIL caps threaded CPU-bound scaling **independently of Flask**.

Interleaved single-request cross-check (`diag_single.py`):

```
get_signing_serializer calls per 50 requests: default=100, hoisted=0
default    n=40000 median=  159.70 us mean=  158.48 us p99=  384.00 us
hoisted    n=40000 median=  135.20 us mean=  131.24 us p99=  327.60 us
```

→ default **159.70 µs** vs hoisted **135.20 µs** per request (**15.4% lower**), consistent with ~11 µs × 2 constructions/request. (Earlier non-interleaved harness runs showed a T=1 inversion — e.g. hoisted 6787 vs default 10636 — which the fully-interleaved run above removed; thread-scaling measurements are noisy in this sandbox and the numbers above are the interleaved ones.)

### The mechanism, stated plainly

1. **Per-request duplication, never amortized.** The construction is unconditional on the load path (`open_session` calls it before reading the cookie) and repeated on the write path (`save_session`). The freshly built object is discarded after a single `loads`/`dumps`. So the setup work is paid *once per request* — twice per session-writing request — and aggregate setup CPU grows linearly with request rate. At T=64 with 2 constructions/request the *measured* construction counts confirm the duplication is not shared: `get_signing_serializer=200 for 100 requests (2.00/req)`, and `0.00/req` for the hoisted variant.
2. **CPU-bound under the GIL.** In a threaded WSGI worker (Flask's dev server defaults to threaded: `src/flask/app.py:651-655`, `options.setdefault("threaded", True)`; docs: *"Threaded mode is enabled by default."*), this duplicated setup runs as Python bytecode under the interpreter lock. Concurrent requests therefore serialize on it instead of scaling — exactly the measured flat/declining req/s (0.91× at T=64) and the pure-CPU control's 0.61×. Latency inflates because each request waits for the lock while other threads burn CPU on the same setup.
3. **Multi-process workers duplicate it per process.** WSGI servers run several processes (e.g. `gunicorn -w 4`, `mod_wsgi-express --processes 4`, uWSGI workers — `docs/deploying/gunicorn.rst:55-67`, `docs/deploying/mod_wsgi.rst:60-84`, `docs/deploying/uwsgi.rst:63-66`), and `docs/lifecycle.rst:35-39` states: *"All application setup must be completed before you start serving your application and handling requests. This is because WSGI servers divide work between multiple workers... If the configuration changed in one worker, there's no way for Flask to ensure consistency between other workers."* Each process re-does the construction on its own requests, so the waste scales with total RPS regardless of worker count.
4. **Only the load path's first construction is "extra" vocabulary, not work avoided elsewhere.** The GIL/process points explain *why concurrency makes it visible*; the duplication (`≥1` unconditional + `1` on write) explains *why it scales with RPS*. Neither is hand-waving — both are directly measured above (counts and throughput).

**Net effect (as a share, not an absolute):** the measured construction cost of ~8.5 µs/call is ~11 µs of the ~60–65 µs fresh `dumps`/`loads` operation (~18%). A per-process hoisted serializer removes that share (measured: 159.70 → 135.20 µs/request, ~15%), **but leaves the per-operation `TimestampSigner` construction and the `derive_key` HMAC in place** (measured `Signer.__init__` = 1.000/op even when reused).

---

## 5. Why it is written this way (not a bug)

The per-call rebuild is forced by three concrete design constraints in this checkout:

**(a) Live key configuration / runtime key rotation.** `app.secret_key` is a live `ConfigAttribute` (`src/flask/sansio/app.py:207-216`):

```python
    #: If a secret key is set, cryptographic components can use this to
    #: sign cookies and other things. Set this to a complex random value
    #: when you want to use the secure cookie for instance.
    #:
    #: This attribute can also be configured from the config with the
    #: :data:`SECRET_KEY` configuration key. Defaults to ``None``.
    secret_key = ConfigAttribute[str | bytes | None]("SECRET_KEY")
```

and the test `tests/test_basic.py:383-399` mutates it between requests *within one test* (three different key configurations):

```python
def test_session_secret_key_fallbacks(app, client) -> None:
    @app.post("/")
    def set_session() -> str:
        flask.session["a"] = 1
        return ""

    @app.get("/")
    def get_session() -> dict[str, t.Any]:
        return dict(flask.session)

    # Set session with initial secret key, and two valid expiring keys
    app.secret_key, app.config["SECRET_KEY_FALLBACKS"] = (
        "0 key",
        ["-1 key", "-2 key"],
    )
    client.post()
    assert client.get().json == {"a": 1}
    # Change secret key, session can't be loaded and appears empty
    app.secret_key = "? key"
    assert client.get().json == {}
    # Rotate the valid keys, session can be loaded
    app.secret_key, app.config["SECRET_KEY_FALLBACKS"] = (
        "+1 key",
        ["0 key", "-1 key"],
    )
    assert client.get().json == {"a": 1}
```

Command and complete output: `$ .venv/Scripts/python.exe -m pytest tests/test_basic.py::test_session_secret_key_fallbacks -q` → `. [100%]` / `1 passed in 0.08s` (exit 0), **unmodified**. So any reuse must be **keyed to the current key configuration**, not a single fixed instance — and the key list must stay ordered "oldest to newest, current key at top" (`sessions.py:326`; `CHANGES.rst:14-18` fixes the signing key selection order for `SECRET_KEY_FALLBACKS`).

**(b) `session_interface` is a shared class attribute.** `src/flask/app.py:222-224`:

```python
    #: the session interface to use.  By default an instance of
    #: :class:`~flask.sessions.SecureCookieSessionInterface` is used here.
    #:
    #: .. versionadded:: 0.8
    session_interface: SessionInterface = SecureCookieSessionInterface()
```

i.e. **one `SecureCookieSessionInterface` instance is shared by every `Flask` app in the process**, so a cache cannot simply live in a plain attribute on the interface without leaking between apps (and `secret_key` differs per app; `tests/test_reqctx.py:209-247` and `tests/test_session_interface.py` show subclasses/instances swapped at class level).

**(c) Overridable class attributes and runtime serializer extension.** `salt`, `digest_method`, `key_derivation`, `serializer` are documented as overridable class attributes meant to be honored per call, and the tag serializer is explicitly extensible at runtime (`src/flask/json/tag.py`, module docstring):

```python
"""
Tagged JSON
~~~~~~~~~~~

A compact representation for lossless serialization of non-standard JSON
types. :class:`~flask.sessions.SecureCookieSessionInterface` uses this
to serialize the session data, but it may be useful in other places. It
can be extended to support other types.
...
    app.session_interface.serializer.register(TagOrderedDict, index=0)
"""
```

So the design reads the live configuration each time rather than freezing it once.

---

## 6. What would remove it (framed as a remedy note, not a patch)

Cache/hoist the serializer **per app**, keyed on the current configuration — `(secret_key, SECRET_KEY_FALLBACKS, salt, digest_method, key_derivation, serializer)` — so that signing and verification still happen per request via the cached object, but the constructor-side work (including the `is_text_serializer` → `TaggedJSONSerializer.dumps({})` probe, the `_make_keys_list`/`want_bytes`/dict-list copies) is paid once per key configuration rather than once (or twice) per request. The cache key requirement is exactly what `tests/test_basic.py::test_session_secret_key_fallbacks` enforces, and it must not be stored as a bare instance attribute on the class-level `session_interface` (`src/flask/app.py:224`) because that object is shared across apps. This is a remedy note only: **the question asks why the repeated invocation is a bottleneck**, and the code as shipped is not being asserted to be wrong.

---

## 7. Explicit separation of costs

| Cost component | Paid when | Removed by serializer reuse? |
|---|---|---|
| `URLSafeTimedSerializer.__init__`: `_make_keys_list`, `want_bytes(salt)`, `is_text_serializer` → `TaggedJSONSerializer.dumps({})`, dict/list copies | once per call; ≥1/request, 2/request on write | **Yes** (measured ~11 µs/op; `get_signing_serializer` 2.00/req → 0.00/req) |
| `TimestampSigner` construction via `make_signer`/`iter_unsigners` | once per `dumps`/`loads` operation | **No** — measured `Signer.__init__` = 1.000/op even reused |
| `derive_key` HMAC (`hmac.new(...)`) per key tried; `verify_signature` loops all `secret_keys` | every `sign`/`verify_signature` | **No** — reuse "does not remove signer or HMAC work" |
| timestamp handling / `max_age` check, base64, zlib, JSON payload serialize | every `dumps`/`loads` | **No** |

---

## 8. Measurement conditions (all numbers)

- Checkout: Flask `3.2.0.dev0`, commit `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`; `itsdangerous 2.2.0`; CPython 3.13.9, GIL enabled (`Py_GIL_DISABLED=0`).
- Every script and the test suite run with `PYTHONPATH=src` so `flask` resolves to *this* checkout's `src/flask` (verified: `flask.__file__` = `...\seal\src\flask\__init__.py`); the venv's `.pth` otherwise points elsewhere.
- Step 3 counts: one `POST /set` + `GET /get` through the test client (non-permanent and permanent sessions), plus a no-`SECRET_KEY` control.
- Step 4: payload `{"a": 1, "u": uuid4(), "d": datetime.now(timezone.utc)}`, `max_age=2678400`, 100 000 samples per arm, arms interleaved in randomized order over 10 rounds, `perf_counter_ns` per call, single thread.
- Step 5: ~8192 requests per (variant, T) combination, `T ∈ {1,4,16,64}`, all combinations randomized per round, best-of-4; pure-Python CPU-bound control without Flask, best-of-3. Thread-scaling numbers are noisy in the sandbox; the GIL effect is corroborated by the no-Flask control (0.61× at T=64).
- Step 6: `pytest tests/test_basic.py::test_session_secret_key_fallbacks -q` → `1 passed in 0.08s` (exit 0). Full suite twice: `PYTHONPATH=src .venv/Scripts/python.exe -m pytest -q` → `489 passed in 3.83s`; `-vv --tb=long` → `489 passed in 3.92s`; 0 failed, 0 errors, 0 skipped.
- Scratch files were written only under `flask_mut2_i417ar2x/` (`bench_count.py`, `bench_timing.py`, `bench_concurrency.py`, `diag_single.py`, `pytest_verbose.log`); `src/` and `tests/` were not modified, and the unrelated `flask_mut2_i417ar2x/mutated_test.py` (a `url_for`/subdomain test) was not used in this analysis.

---

## 9. One-paragraph recapitulation

`SecureCookieSessionInterface.get_signing_serializer` (`src/flask/sessions.py:317`) builds a fresh `URLSafeTimedSerializer` per call — all constructor inputs except the key list are fixed class attributes (`sessions.py:305-315`), and no cache exists anywhere in `src/flask`. `open_session` calls it unconditionally at line 338 (before the cookie lookup at 341), reached from `RequestContext.push` (`ctx.py:386`); `save_session` calls it again at line 387 whenever `should_set_cookie` is true — which, with the default `SESSION_REFRESH_EACH_REQUEST=True`, is *every* response for a permanent session — reached from `Flask.process_response` (`app.py:1322`); the test client's `session_transaction` hits both (`testing.py:165/177`). Each construction runs `Serializer.__init__` (measured 8.5 µs median), including `is_text_serializer` which executes `TaggedJSONSerializer.dumps({})` (`itsdangerous/serializer.py:35-39` → `tag.py:289-323` → `flask.json.dumps`). Because this setup is duplicated per request and discarded after one operation, aggregate setup CPU grows linearly with RPS (8.5 ms / 17.0 ms per 1 000 reads/writes), and under a threaded worker it is CPU-bound work contending for the GIL — measured throughput flat to declining from T=1→64 (11191 → 10201 req/s, 0.91×) with a no-Flask CPU-bound control at 0.61×, while a hoisted serializer is ~15% faster per request. Reuse removes the setup share only; the HMAC (`Signer.derive_key`), the per-operation `TimestampSigner` construction, and cookie/payload parsing are paid either way. The per-call rebuild is a deliberate consequence of live key configuration (`secret_key` is a `ConfigAttribute`; `tests/test_basic.py::test_session_secret_key_fallbacks` rotates keys between requests), the shared class-level `session_interface` (`app.py:224`), and documented overridable/runtime-extensible serializer attributes.
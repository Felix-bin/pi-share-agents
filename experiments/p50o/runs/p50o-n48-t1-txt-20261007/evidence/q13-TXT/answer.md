# How Flask's `_lazy_sha1` wrapper defers hash-algorithm access to prevent import-time failures in FIPS environments

## Short answer

`src/flask/sessions.py` defines a module-level function `_lazy_sha1(string: bytes = b"") -> t.Any` whose body is just `return hashlib.sha1(string)`, and installs it as the default signature digest function with `digest_method = staticmethod(_lazy_sha1)` inside `SecureCookieSessionInterface`. Because `staticmethod(...)` merely wraps the **function object** — it never calls it — executing the module (and the class body) performs no `hashlib.sha1` **attribute access**. The only reference to `hashlib.sha1` lives inside the function body, so it is resolved only when the function is invoked. Flask forwards `self.digest_method` into `URLSafeTimedSerializer(..., signer_kwargs={"digest_method": self.digest_method})`, and itsdangerous stores that callable and unpacks it only inside `make_signer()`, i.e. during `dumps()`/`loads()`. Those happen only inside request handling (`open_session`/`save_session`, reached from the request context and the response finalization), after the developer has had a chance to replace `digest_method` with a FIPS-available algorithm. Net effect: the *availability validation* of SHA-1 is postponed from import time to call time, so `import flask` and module import do not abort on a build where SHA-1 is unavailable; the algorithm itself is not changed, and no error is caught.

This is exactly the intent recorded in the changelog for Flask 3.0.3 (issue 5448):

```
Version 3.0.3
-------------

Released 2024-04-07

-   The default ``hashlib.sha1`` may not be available in FIPS builds. Don't
    access it at import time so the developer has time to change the default.
    :issue:`5448`
```

(Verified independently: `grep -n "FIPS|5448" CHANGES.rst` reports line 62: `-   The default ``hashlib.sha1`` may not be available in FIPS builds. Don't` and line 64: `:issue:`5448``.)

---

## 1. The wrapper function itself

`src/flask/sessions.py`, lines 286–295 (verified by direct read):

```python
session_json_serializer = TaggedJSONSerializer()


def _lazy_sha1(string: bytes = b"") -> t.Any:
    """Don't access ``hashlib.sha1`` until runtime. FIPS builds may not include
    SHA-1, in which case the import and use as a default would fail before the
    developer can configure something else.
    """
    return hashlib.sha1(string)
```

Key facts: `_lazy_sha1` is a plain module-level function with a default argument `string=b""`; the only reference to `hashlib.sha1` sits inside the function body (line 295), i.e. it executes only when the function is *called*.

## 2. The import that must stay harmless

`src/flask/sessions.py`, lines 1–16 (module header):

```python
from __future__ import annotations

import collections.abc as c
import hashlib
import typing as t
from collections.abc import MutableMapping
from datetime import datetime
from datetime import timezone

from itsdangerous import BadSignature
from itsdangerous import URLSafeTimedSerializer
from werkzeug.datastructures import CallbackDict

from .json.tag import TaggedJSONSerializer
```

`import hashlib` (line 4) is safe on FIPS builds; the restricted operation is *attribute access* `hashlib.sha1`, not importing the `hashlib` module.

## 3. How the wrapper is bound as the default

`src/flask/sessions.py`, lines 297–335 (verified by direct read):

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

Line 307 (`digest_method = staticmethod(_lazy_sha1)`) does run while the class body executes at import time, but `staticmethod(...)` only wraps the *function object* `_lazy_sha1`; it does **not** call it and never binds the result of `hashlib.sha1`. Lines 331–334 forward `self.digest_method` as `signer_kwargs["digest_method"]`.

The executor's grep of the whole file confirms there is nowhere else the attribute is touched, and that the attribute value is the function object itself:

```
$ grep -n "hashlib\|sha1\|digest_method\|_lazy_sha1" src/flask/sessions.py
4:import hashlib
290:def _lazy_sha1(string: bytes = b"") -> t.Any:
291:    """Don't access ``hashlib.sha1`` until runtime. FIPS builds may not include
295:    return hashlib.sha1(string)
306:    #: the hash function to use for the signature.  The default is sha1
307:    digest_method = staticmethod(_lazy_sha1)
333:                "digest_method": self.digest_method,
```

and:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import flask, flask.sessions, sys
print('flask file:', flask.__file__)
print('sessions file:', flask.sessions.__file__)
print('import flask OK')
print('identity with _lazy_sha1:', flask.sessions.SecureCookieSessionInterface.digest_method is flask.sessions._lazy_sha1)
print('call result:', flask.sessions._lazy_sha1(b'abc').hexdigest())
"
flask file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q13-TXT\seal\src\flask\__init__.py
sessions file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q13-TXT\seal\src\flask\sessions.py
import flask OK
identity with _lazy_sha1: True
call result: a9993e364706816aba3e25717850c26c9cd0d89d
```

The class attribute **is** the function object (`identity ... : True`), not a bound hash result; calling it produces the standard SHA-1 digest of `b"abc"`.

## 4. Runtime call sites — nothing happens at import

`src/flask/sessions.py`, lines 337–399:

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
        ...
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

`get_signing_serializer` is called only from `open_session` (line 338) and `save_session` (line 387), both request-time paths. The executor's grep:

```
$ grep -n "get_signing_serializer\|open_session\|save_session" src/flask/sessions.py src/flask/ctx.py src/flask/app.py src/flask/testing.py
src/flask/sessions.py:118:    :meth:`open_session` and :meth:`save_session`, the others have
src/flask/sessions.py:121:    The session object returned by the :meth:`open_session` method has to
src/flask/sessions.py:129:    If :meth:`open_session` returns ``None`` Flask will call into
src/flask/sessions.py:263:    def open_session(self, app: Flask, request: Request) -> SessionMixin | None:
src/flask/sessions.py:277:    def save_session(
src/flask/sessions.py:317:    def get_signing_serializer(self, app: Flask) -> URLSafeTimedSerializer | None:
src/flask/sessions.py:337:    def open_session(self, app: Flask, request: Request) -> SecureCookieSession | None:
src/flask/sessions.py:338:        s = self.get_signing_serializer(app)
src/flask/sessions.py:351:    def save_session(
src/flask/sessions.py:387:        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
src/flask/ctx.py:381:        # This allows a custom open_session method to use the request context.
src/flask/ctx.py:386:            self.session = session_interface.open_session(self.app, self.request)
src/flask/app.py:1322:            self.session_interface.save_session(self, ctx.session, response)
src/flask/testing.py:165:            sess = app.session_interface.open_session(app, ctx.request)
src/flask/testing.py:177:            app.session_interface.save_session(app, sess, resp)
```

The request lifecycle calls those methods:

`src/flask/ctx.py`, lines 378–389 — session opened when the request context is pushed:

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

`src/flask/app.py`, lines 1321–1322 — session saved at end of request:

```python
        if not self.session_interface.is_null_session(ctx.session):
            self.session_interface.save_session(self, ctx.session, response)
```

`src/flask/app.py`, line 224 — the default interface instance: `session_interface: SessionInterface = SecureCookieSessionInterface()`. The test client also calls `open_session`/`save_session` directly (`src/flask/testing.py`, lines 163–177), again at runtime:

```python
        with ctx:
            sess = app.session_interface.open_session(app, ctx.request)
        ...
        with ctx:
            app.session_interface.save_session(app, sess, resp)
```

## 5. Where `signer_kwargs["digest_method"]` is actually invoked — inside itsdangerous

The `hashlib.sha1` attribute access ultimately happens inside itsdangerous, which contains the **same** `_lazy_sha1` pattern (`itsdangerous/signer.py`):

```python
def _lazy_sha1(string: bytes = b"") -> t.Any:
    """Don't access ``hashlib.sha1`` until runtime. FIPS builds may not include
    SHA-1, in which case the import and use as a default would fail before the
    developer can configure something else.
    """
    return hashlib.sha1(string)


class HMACAlgorithm(SigningAlgorithm):
    """Provides signature generation using HMACs."""

    #: The digest method to use with the MAC algorithm. This defaults to
    #: SHA1, but can be changed to any other function in the hashlib
    #: module.
    default_digest_method: t.Any = staticmethod(_lazy_sha1)

    def __init__(self, digest_method: t.Any = None):
        if digest_method is None:
            digest_method = self.default_digest_method

        self.digest_method: t.Any = digest_method

    def get_signature(self, key: bytes, value: bytes) -> bytes:
        mac = hmac.new(key, msg=value, digestmod=self.digest_method)
        return mac.digest()
```

`Signer.__init__` stores the callable and builds the HMAC algorithm:

```python
        if digest_method is None:
            digest_method = self.default_digest_method

        self.digest_method: t.Any = digest_method

        if algorithm is None:
            algorithm = HMACAlgorithm(self.digest_method)
```

Its `derive_key` (used because Flask sets `key_derivation = "hmac"`) also invokes it:

```python
        elif self.key_derivation == "hmac":
            mac = hmac.new(secret_key, digestmod=self.digest_method)
            mac.update(self.salt)
            return mac.digest()
```

And `itsdangerous/serializer.py` shows the kwargs staying dormant until signing:

```python
        if signer is None:
            signer = self.default_signer

        self.signer: type[Signer] = signer
        self.signer_kwargs: dict[str, t.Any] = signer_kwargs or {}
...
    def make_signer(self, salt: str | bytes | None = None) -> Signer:
        """Creates a new instance of the signer to be used. The default
        implementation uses the :class:`.Signer` base class.
        """
        if salt is None:
            salt = self.salt

        return self.signer(self.secret_keys, salt=salt, **self.signer_kwargs)
...
    def dumps(self, obj: t.Any, salt: str | bytes | None = None) -> _TSerialized:
        payload = want_bytes(self.dump_payload(obj))
        rv = self.make_signer(salt).sign(payload)
```

So the chain is: Flask `get_signing_serializer` → `URLSafeTimedSerializer(..., signer_kwargs={"digest_method": self.digest_method})` → `Serializer.signer_kwargs` → `make_signer()` → `Signer(..., digest_method=_lazy_sha1)` → `HMACAlgorithm(_lazy_sha1)` → `hmac.new(..., digestmod=_lazy_sha1)` → `hashlib.sha1(...)`. `URLSafeTimedSerializer`/`URLSafeSerializerMixin`/`TimedSerializer` add no import-time digest access.

---

## 6. Executed verification

All commands were run in the working directory. The repo's `python` on PATH is a system interpreter without `flask`/`werkzeug`; checks used the shipped venv with `PYTHONPATH=src` so the working-tree `src` wins.

### 6.1 Import with `hashlib.sha1` deleted — the modules that *do* matter import fine

With dependencies already loaded, re-executing `flask/sessions.py` (including the class body) succeeds even though `hashlib.sha1` does not exist, and the failure moves to the call:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import flask, flask.sessions, importlib, hashlib
print('flask.sessions file:', flask.sessions.__file__)
del hashlib.sha1
print('hashlib.sha1 present:', hasattr(hashlib, 'sha1'))
importlib.reload(flask.sessions)   # re-executes module + class body at import time
print('reload of flask.sessions OK without hashlib.sha1')
print('digest_method is reloaded _lazy_sha1:', flask.sessions.SecureCookieSessionInterface.digest_method is flask.sessions._lazy_sha1)
try:
    flask.sessions._lazy_sha1(b'abc')
    print('call succeeded (unexpected)')
except AttributeError as e:
    print('runtime call FAILED as expected:', repr(e))
print('counterfactual eager: staticmethod(hashlib.sha1) ...')
try:
    staticmethod(hashlib.sha1)
    print('eager succeeded (unexpected)')
except AttributeError as e:
    print('eager FAILED at import time:', repr(e))
"
flask.sessions file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q13-TXT\seal\src\flask\sessions.py
hashlib.sha1 present: False
reload of flask.sessions OK without hashlib.sha1
digest_method is reloaded _lazy_sha1: True
runtime call FAILED as expected: AttributeError("module 'hashlib' has no attribute 'sha1'")
counterfactual eager: staticmethod(hashlib.sha1) ...
eager FAILED at import time: AttributeError("module 'hashlib' has no attribute 'sha1'")
```

Decisive confirmation: the lazy form survives import; the eager form `staticmethod(hashlib.sha1)` raises **at import time** under the same model.

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import hashlib
del hashlib.sha1   # simulate FIPS
try:
    digest_method = staticmethod(hashlib.sha1)
    print('eager binding succeeded (unexpected)')
except AttributeError as e:
    print('eager staticmethod(hashlib.sha1) FAILS at import time:', repr(e))
"
eager staticmethod(hashlib.sha1) FAILS at import time: AttributeError("module 'hashlib' has no attribute 'sha1'")
```

### 6.2 End-to-end trace: zero hash calls until a request

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import hashlib
calls = []
_orig = hashlib.sha1
def traced(*a, **k):
    calls.append('hashlib.sha1 called')
    return _orig(*a, **k)
hashlib.sha1 = traced
import flask
print('AFTER IMPORT, hash calls:', calls)
app = flask.Flask(__name__)
app.secret_key = 'x'
print('AFTER app creation, hash calls:', calls)
@app.route('/')
def index():
    flask.session['k'] = 'v'
    return 'ok'
with app.test_client() as c:
    print('BEFORE request, hash calls:', calls)
    r = c.get('/')
    print('response status:', r.status_code)
    print('AFTER request, hash calls:', calls)
"
AFTER IMPORT, hash calls: []
AFTER app creation, hash calls: []
BEFORE request, hash calls: []
response status: 200
AFTER request, hash calls: ['hashlib.sha1 called', 'hashlib.sha1 called', 'hashlib.sha1 called', 'hashlib.sha1 called']
```

Zero `hashlib.sha1` invocations at import, at `Flask()` construction, or before the request; four during request handling (`open_session`/`save_session` → itsdangerous `dumps`/`loads`).

### 6.3 The escape hatch: overriding `digest_method` before any request

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import hashlib
from flask import Flask
from flask.sessions import SecureCookieSessionInterface

class Sha256Interface(SecureCookieSessionInterface):
    digest_method = staticmethod(hashlib.sha256)   # override before any request

app = Flask(__name__)
app.secret_key = 'x'
app.session_interface = Sha256Interface()
used = []
_orig = hashlib.sha1
def spy(*a, **k):
    used.append('sha1 used')
    return _orig(*a, **k)
hashlib.sha1 = spy
@app.route('/')
def index():
    from flask import session
    session['k'] = 'v'
    return 'ok'
with app.test_client() as c:
    r = c.get('/')
    print('status:', r.status_code)
    print('sha1 used during overridden request:', used)
print('override digest_method:', Sha256Interface.digest_method)
"
status: 200
sha1 used during overridden request: []
override digest_method: <built-in function openssl_sha256>
```

The default `_lazy_sha1` (hence `hashlib.sha1`) is never touched once `digest_method` is replaced — the documented "developer has time to change the default" window works.

### 6.4 The "attribute present but raises on call" FIPS model

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import hashlib
_orig = hashlib.sha1
def _blocked(*a, **k):
    raise ValueError('SHA-1 is not available in FIPS mode')
hashlib.sha1 = _blocked   # attribute still present, but unusable on call
import flask, flask.sessions
print('import flask OK (attribute-present-but-raising FIPS model)')
try:
    flask.sessions._lazy_sha1(b'abc')
    print('call succeeded (unexpected)')
except ValueError as e:
    print('runtime call FAILED as expected:', e)
try:
    staticmethod(hashlib.sha1)
    print('eager staticmethod(hashlib.sha1) succeeded at import in this model; fails only on call')
except Exception as e:
    print('eager import-time failure:', repr(e))
try:
    staticmethod(_blocked)()
    print('eager call (unexpected)')
except ValueError as e:
    print('eager version fails on CALL too:', e)
"
import flask OK (attribute-present-but-raising FIPS model)
runtime call FAILED as expected: SHA-1 is not available in FIPS mode
eager staticmethod(hashlib.sha1) succeeded at import in this model; fails only on call
eager version fails on CALL too: SHA-1 is not available in FIPS mode
```

Nuance: if the attribute exists but raises only when called, both eager and lazy import fine and differ only in when the error surfaces. The deferral's concrete benefit is specifically against the model where `hashlib.sha1` cannot even be resolved as an attribute at import time (6.1) — matching the changelog's "may not be available."

---

## 7. Caveats / scope limits (what the wrapper does *not* do)

These are important so the mechanism is not over-claimed:

1. **It does not make SHA-1 available** on FIPS builds, and it does not catch any error. It only moves the restricted `hashlib.sha1` attribute access from import time to call time, giving the developer a window to override `digest_method` (e.g. to SHA-256).
2. **`import hashlib` is always safe.** Only the attribute access/construction `hashlib.sha1` is restricted. The explanation must not imply importing `hashlib` itself is unsafe.
3. **The default is not used eagerly.** Because it flows through `signer_kwargs` into `URLSafeTimedSerializer`, invocation happens only inside itsdangerous on `dumps()`/`loads()` during a request. Flask does not call it directly.
4. **Flask's deferral does not protect its dependencies' eager imports.** In the extreme "attribute fully absent" FIPS model, `import flask` still fails — but inside **werkzeug's** own eager `from hashlib import sha1` (`werkzeug/http.py` line 13), not in Flask's code:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "
import hashlib
del hashlib.sha1   # simulate a FIPS build where SHA-1 is unavailable
print('hashlib.sha1 present:', hasattr(hashlib, 'sha1'))
import flask, flask.sessions
print('import flask OK even without hashlib.sha1')
...
"
Traceback (most recent call last):
  File "<string>", line 5, in <module>
    import flask, flask.sessions
  File "...\seal\src\flask\__init__.py", line 1, in <module>
    from . import json as json
  ...
  File "...\.venv\Lib\site-packages\werkzeug\http.py", line 13, in <module>
    from hashlib import sha1
ImportError: cannot import name 'sha1' from 'hashlib' (...Lib\hashlib.py). Did you mean: 'sha512'?
hashlib.sha1 present: False
EXIT:1
```

So the wrapper protects Flask's *own* `hashlib.sha1` access — the module and class body that execute at import — while third-party import-time eager references remain outside its control. (And with dependencies already imported, re-executing `flask/sessions.py` without `hashlib.sha1` succeeds, per 6.1.)

5. **No test coverage exists for this behaviour.** `grep` for the relevant identifiers across `tests/` returned nothing:

```
$ grep -rn "_lazy_sha1\|digest_method\|hashlib\|sha1\|FIPS" tests/ ; echo "EXIT:$?"
EXIT:1
```

There is no regression test asserting the import-time/runtime distinction; verification here relies on source reading and the executions above. Documentation likewise has no prose on the mechanism (`docs/api.rst` auto-documents `SecureCookieSessionInterface` via `autoclass ... :members:`, and the only other `hashlib.sha1` mention, `docs/patterns/requestchecksum.rst`, is an unrelated checksum example).

The unrelated `flask_mut2_i417ar2x/mutated_test.py` is a routing/subdomain artifact with no hash references (and fails on its own with `status 404` vs expected `200`); it is not collected by `pytest tests/` and is not evidence for this question.

---

## 8. Test-suite results (for completeness)

The project's own suite is green on both runs: `PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/ -q` → **489 passed in 5.76s** (exit 0), and the verbose run `-v -ra --tb=long -p no:randomly` → **489 passed in 6.20s** (exit 0). The session-focused subset (`tests/test_session_interface.py tests/test_basic.py -k "session"`) reports **14 passed, 117 deselected in 0.23s** (exit 0). None of these tests exercise `_lazy_sha1`/`digest_method` directly; they confirm the surrounding session machinery keeps working.

---

## 9. Condensed mechanism, in order

1. Module import binds the *function object*: `def _lazy_sha1(...)` and, in the class body, `digest_method = staticmethod(_lazy_sha1)`. No `hashlib.sha1` attribute access occurs.
2. `import hashlib` is a harmless module import even on FIPS builds.
3. At request time, `open_session` (line 338, opened from `ctx.py` when the request context is pushed) or `save_session` (line 387, from `app.py` finalization) calls `get_signing_serializer(app)`.
4. That method builds `URLSafeTimedSerializer(..., signer_kwargs={"key_derivation": "hmac", "digest_method": self.digest_method})`, passing the callable along without invoking it.
5. itsdangerous stores `signer_kwargs`, and `make_signer()` unpacks them only when `dumps()`/`loads()` runs; the callable ends up in `hmac.new(..., digestmod=...)`, which calls it, which finally executes `hashlib.sha1(string)`.
6. If the developer has already replaced `digest_method` (e.g. `staticmethod(hashlib.sha256)`), `hashlib.sha1` is never reached. If not, the SHA-1 availability error surfaces at request time — not at `import flask` — which is the whole point, per Flask 3.0.3 / issue 5448: "The default `hashlib.sha1` may not be available in FIPS builds. Don't access it at import time so the developer has time to change the default."
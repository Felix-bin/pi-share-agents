## Short answer

The bytes tag is `TagBytes` in `src/flask/json/tag.py`. Its tag key is the literal string `" b"` (leading space), and it encodes with `b64encode(value).decode("ascii")` and decodes with `b64decode(value)`. Because base64 is a bijection, `b64decode(b64encode(v)) == v` byte-for-byte for every input — including non-UTF-8 data such as `b"\xff"` — so reversibility is exact losslessness, not a best-effort guess. Consistency (type identity) is preserved by the wrapper: `JSONTag.tag` emits the single-key dict `{" b": "<base64>"}`, and on decode only a one-key dict whose key is a registered tag is converted, so an ordinary JSON string that merely looks like base64 is never turned into `bytes`. The ambiguous case — a user's own dict whose only key happens to equal a tag key, e.g. `{" b": ...}` or `{" di": ...}` — is protected separately by `TagDict`, which is registered first, suffixes that key with `__`, and strips the suffix on the way back.

---

# Full answer: how `TagBytes` achieves consistency and reversibility

## 1. The class itself (verified verbatim)

`src/flask/json/tag.py`, lines 159–170:

```python
class TagBytes(JSONTag):
    __slots__ = ()
    key = " b"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, bytes)

    def to_json(self, value: t.Any) -> t.Any:
        return b64encode(value).decode("ascii")

    def to_python(self, value: t.Any) -> t.Any:
        return b64decode(value)
```

The imports feeding it, lines 45–56:

```python
from __future__ import annotations

import typing as t
from base64 import b64decode
from base64 import b64encode
from datetime import datetime
from uuid import UUID

from markupsafe import Markup
from werkzeug.http import http_date
from werkzeug.http import parse_date

from ..json import dumps
from ..json import loads
```

The base class contract it implements, lines 60–91:

```python
class JSONTag:
    """Base class for defining type tags for :class:`TaggedJSONSerializer`."""

    __slots__ = ("serializer",)

    #: The tag to mark the serialized object with. If empty, this tag is
    #: only used as an intermediate step during tagging.
    key: str = ""

    def __init__(self, serializer: TaggedJSONSerializer) -> None:
        """Create a tagger for the given serializer."""
        self.serializer = serializer

    def check(self, value: t.Any) -> bool:
        """Check if the given value should be tagged by this tag."""
        raise NotImplementedError

    def to_json(self, value: t.Any) -> t.Any:
        """Convert the Python object to an object that is a valid JSON type.
        The tag will be added later."""
        raise NotImplementedError

    def to_python(self, value: t.Any) -> t.Any:
        """Convert the JSON representation back to the correct type. The tag
        will already be removed."""
        raise NotImplementedError

    def tag(self, value: t.Any) -> dict[str, t.Any]:
        """Convert the value to a valid JSON type and add the tag structure
        around it."""
        return {self.key: self.to_json(value)}
```

The module docstring frames the whole design goal, lines 1–5:

```
"""
Tagged JSON
~~~~~~~~~~~

A compact representation for lossless serialization of non-standard JSON
types. :class:`~flask.sessions.SecureCookieSessionInterface` uses this
to serialize the session data, but it may be useful in other places. It
can be extended to support other types.
```

## 2. Encoding side: why `.decode("ascii")` is safe and JSON-legal

`TagBytes.check` matches any `bytes` instance (`isinstance(value, bytes)`), and `to_json` runs `b64encode(value).decode("ascii")`. Base64 emits only the alphabet `A–Z a–z 0–9 + /` plus `=` padding — all a subset of ASCII — so `.decode("ascii")` can never raise `UnicodeDecodeError`, and the resulting `str` is a JSON-legal string requiring no escaping. This was verified behaviorally over empty, single-byte, non-UTF-8, all-256-byte, and 1000 random-byte inputs (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from base64 import b64encode
import os
alpha = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
cases = [b"", b"\xff", b"\x00", b"\x80\x81\xfe", bytes(range(256)), os.urandom(1000)]
for v in cases:
    s = b64encode(v).decode("ascii")   # would raise UnicodeDecodeError if not ASCII
    assert all(c in alpha for c in s), "non-alphabet char present"
    assert all(ord(c) < 128 for c in s), "non-ASCII codepoint present"
    print(f"len={len(v):5d} -> decode('ascii') ok, sample={s[:40]!r}")
print("ALL ASCII-ONLY; alphabet subset holds")
PY

len=    0 -> decode('ascii') ok, sample=''
len=    1 -> decode('ascii') ok, sample='/w=='
len=    1 -> decode('ascii') ok, sample='AA=='
len=    3 -> decode('ascii') ok, sample='gIH+'
len=  256 -> decode('ascii') ok, sample='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd'
len= 1000 -> decode('ascii') ok, sample='LmcF66JILi31Rx/Is9W7xbyw+BgXqYU9Je6Vdtvm'
ALL ASCII-ONLY; alphabet subset holds
```

Why this layer is needed at all: plain JSON cannot carry `bytes`. Both the stdlib encoder and the Flask provider's `_default` raise `TypeError` — the latter (from `src/flask/json/provider.py`, lines 108–117) handles date/Decimal/UUID/dataclass/`__html__` but never `bytes`:

```python
def _default(o: t.Any) -> t.Any:
    if isinstance(o, date):
        return http_date(o)

    if isinstance(o, (decimal.Decimal, uuid.UUID)):
        return str(o)

    if dataclasses and dataclasses.is_dataclass(o):
        return dataclasses.asdict(o)  # type: ignore[arg-type]
```

Verified (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
import json
from flask.json.provider import _default
try:
    json.dumps({"k": b"\xff"})
    print("json.dumps({k: b'\\xff'}) SUCCEEDED (unexpected)")
except TypeError as e:
    print("json.dumps({'k': b'\\xff'}) -> TypeError:", e)
try:
    _default(b"\xff")
    print("flask _default(b'\\xff') SUCCEEDED (unexpected)")
except TypeError as e:
    print("flask provider _default(b'\\xff') -> TypeError:", e)
# TaggedJSONSerializer.dumps handles it because tagging happens first
from flask.json.tag import TaggedJSONSerializer
print("TaggedJSONSerializer().dumps({'k': b'\\xff'}) ->", TaggedJSONSerializer().dumps({"k": b"\xff"}))
PY

json.dumps({'k': b'ÿ'}) -> TypeError: Object of type bytes is not JSON serializable
flask provider _default(b'ÿ') -> TypeError: Object of type bytes is not JSON serializable
TaggedJSONSerializer().dumps({'k': b'ÿ'}) -> {"k":{" b":"/w=="}}
```

The docs state the same constraint (`docs/patterns/javascript.rst`, line 235):

> JSON cannot represent binary data directly, so it must be base64
> encoded, which can be slow, takes more bandwidth to send, and is not as
> easy to cache.

## 3. Type marking: the `{" b": ...}` wrapper

`JSONTag.tag` returns `{self.key: self.to_json(value)}`, so a `bytes` value becomes the one-key dict `{" b": "<base64>"}`. The leading space in `" b"` keeps the marker out of the namespace of ordinary payload keys (compare the non-tagged dict `{"b": ...}`). Verified behaviorally (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from flask.json.tag import TaggedJSONSerializer, TagBytes
s = TaggedJSONSerializer()
print("TagBytes.key =", repr(TagBytes.key))
print("s.tag(b'x')   =", s.tag(b"x"))
print("s.tag(b'\\xff') =", s.tag(b"\xff"))
print("raw dumps(b'x') =", s.dumps(b"x"))
print("check(int)=", TagBytes(s).check(5), " check(bytearray)=", TagBytes(s).check(bytearray(b"x")), " check(b'')=", TagBytes(s).check(b""))
PY

TagBytes.key = ' b'
s.tag(b'x')   = {' b': 'eA=='}
s.tag(b'ÿ') = {' b': '/w=='}
raw dumps(b'x') = {" b":"eA=="}
check(int)= False  check(bytearray)= False  check(b'')= True
```

Note the boundary: `check` fires on `bytes` only, not on `bytearray` — so the tag is a deliberate, exact type match.

## 4. Reversibility: base64 is a lossless bijection and `to_python` is its exact inverse

`TagBytes.to_python` is exactly `b64decode(value)` — no charset conversion, no truncation, no normalization step exists anywhere in the path. Therefore `b64decode(b64encode(v)) == v` holds byte-for-byte for every input, including non-UTF-8 bytes like `b"\xff"` that would fail `.decode("utf-8")`. Verified over empty, `b"\xff"`, `b"\x00"`, `b"\x80"`, `bytes(range(256))`, 5000 random bytes, and surrogate-range sequences (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from base64 import b64encode, b64decode
from flask.json.tag import TaggedJSONSerializer
import os
s = TaggedJSONSerializer()
cases = [b"", b"\xff", b"\x00", b"\x80", bytes(range(256)), os.urandom(5000), b"\xed\xa0\x80\xf4\x8f\xbf\xbf"]
for v in cases:
    assert b64decode(b64encode(v)) == v, "b64 bijection failed"
    out = s.loads(s.dumps(v))
    assert out == v, f"round-trip failed for {v[:8]!r}"
    assert type(out) is bytes, f"type not bytes: {type(out)}"
print("b64decode(b64encode(v)) == v for all", len(cases), "cases")
print("s.loads(s.dumps(v)) == v and type is bytes for all cases, including b'\\xff'")
PY

b64decode(b64encode(v)) == v for all 7 cases
s.loads(s.dumps(v)) == v and type is bytes for all cases, including b'ÿ'
```

One precision point about *where* reversibility comes from: `b64decode` defaults to `validate=False`, i.e. it ignores characters outside the alphabet rather than rejecting them. Reversibility is therefore attributable to base64 being bijective and to `to_python` being its exact inverse — **not** to any validation the deserializer performs. Verified (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
import inspect
from base64 import b64decode
print("b64decode signature:", inspect.signature(b64decode))
print("b64decode('eA==')      ->", b64decode("eA=="))
try:
    print("b64decode('eA==!!!')   ->", b64decode("eA==!!!"), "(extra chars ignored with default validate=False)")
except Exception as e:
    print("b64decode('eA==!!!') raised", type(e).__name__, e)
try:
    print("b64decode('eA==!!!', validate=True) ->", b64decode("eA==!!!", validate=True))
except Exception as e:
    print("b64decode('eA==!!!', validate=True) raised:", type(e).__name__, e)
print("REVERSIBILITY FOR b64encode OUTPUT rests on bijection, not on validation")
PY

b64decode signature: (s, altchars=None, validate=False)
b64decode('eA==')      -> b'x'
b64decode('eA==!!!')   -> b'x' (extra chars ignored with default validate=False)
b64decode('eA==!!!', validate=True) raised: Error Excess data after padding
REVERSIBILITY FOR b64encode OUTPUT rests on bijection, not on validation
```

The `.venv` in the working directory has a stale editable pointer (`.venv/Lib/site-packages/flask.pth` points at a *different* extraction path), so all executions forced `PYTHONPATH=src`; this was verified to import this working directory's copy:

```
$ ./.venv/Scripts/python.exe -c "import flask; print(flask.__file__)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\f2f45b5b\q1-TXT\seal\src\flask\__init__.py

$ PYTHONPATH=src ./.venv/Scripts/python.exe -c "import flask; print(flask.__file__)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q1-TXT\seal\src\flask\__init__.py
```

## 5. Decode side: only the wrapper is converted — no false positives

`TaggedJSONSerializer.untag` (lines 297–307) converts **only** a single-key dict whose key is a registered tag key; everything else passes through untouched:

```python
    def untag(self, value: dict[str, t.Any]) -> t.Any:
        """Convert a tagged representation back to the original type."""
        if len(value) != 1:
            return value

        key = next(iter(value))

        if key not in self.tags:
            return value

        return self.tags[key].to_python(value[key])
```

`_untag_scan` (lines 309–319) applies it recursively and bottom-up — children first, then the dict itself:

```python
    def _untag_scan(self, value: t.Any) -> t.Any:
        if isinstance(value, dict):
            # untag each item recursively
            value = {k: self._untag_scan(v) for k, v in value.items()}
            # untag the dict itself
            value = self.untag(value)
        elif isinstance(value, list):
            # untag each item recursively
            value = [self._untag_scan(item) for item in value]

        return value
```

And the public entry points (lines 321–327):

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))

    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

Because dispatch requires *both* a single-key dict *and* a registered key, a plain JSON string that happens to look like base64 is never coerced to `bytes`. Verified (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from flask.json.tag import TaggedJSONSerializer
import json
s = TaggedJSONSerializer()
# a plain JSON string that looks exactly like base64
plain = s.loads('"eA=="')
print("loads('\"eA==\"') ->", repr(plain), type(plain).__name__)
assert plain == "eA==" and type(plain) is str
# an ordinary dict with key 'b' (no leading space) stays a dict
d = s.loads('{"b":"eA=="}')
print("loads('{\"b\":\"eA==\"}') ->", d, type(d).__name__)
# only the single-key wrapper with key ' b' decodes to bytes
wrapped = s.loads('{" b":"eA=="}')
print("loads('{\" b\":\"eA==\"}') ->", repr(wrapped), type(wrapped).__name__)
assert wrapped == b"x" and type(wrapped) is bytes
# multi-key dict containing the tag key stays a dict
multi = s.loads('{" b":"eA==","other":1}')
print("multi-key dict ->", multi, type(multi).__name__)
assert type(multi) is dict
print("CONSISTENCY HOLDS: only single-key {' b': ...} decodes to bytes")
PY

loads('"eA=="') -> 'eA==' str
loads('{"b":"eA=="}') -> {'b': 'eA=='} dict
loads('{" b":"eA=="}') -> b'x' bytes
multi-key dict -> {' b': 'eA==', 'other': 1} dict
CONSISTENCY HOLDS: only single-key {' b': ...} decodes to bytes
```

## 6. The collision guard: `TagDict`'s `__`-suffix escape

The remaining ambiguity is the *opposite* direction: what if the user's own data is a legitimate dict like `{" b": "not-bytes"}` or `{" di": " di"}`? That is a separate mechanism from the `{" b": ...}` wrapper, and it lives in `TagDict` (lines 93–116), which is registered **first** in `default_tags`:

```python
class TagDict(JSONTag):
    """Tag for 1-item dicts whose only key matches a registered tag.

    Internally, the dict key is suffixed with `__`, and the suffix is removed
    when deserializing.
    """

    __slots__ = ()
    key = " di"

    def check(self, value: t.Any) -> bool:
        return (
            isinstance(value, dict)
            and len(value) == 1
            and next(iter(value)) in self.serializer.tags
        )

    def to_json(self, value: t.Any) -> t.Any:
        key = next(iter(value))
        return {f"{key}__": self.serializer.tag(value[key])}

    def to_python(self, value: t.Any) -> t.Any:
        key = next(iter(value))
        return {key[:-2]: value[key]}
```

The ordering that makes this work (lines 238–248):

```python
    default_tags = [
        TagDict,
        PassDict,
        TagTuple,
        PassList,
        TagBytes,
        TagMarkup,
        TagUUID,
        TagDateTime,
    ]
```

Because `TagDict` precedes `PassDict` (and `TagBytes`), a user dict of length 1 whose only key is a registered tag key is renamed to `key + "__"` on encode and stripped back with `key[:-2]` on decode — so it survives as a dict and is never mistaken for bytes or a tuple. Verified, including the dumped intermediate form (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from flask.json.tag import TaggedJSONSerializer
s = TaggedJSONSerializer()
cases = [
    {" b": "not-bytes"},      # user dict whose key looks like the bytes tag
    {" di": " di"},           # user dict whose key looks like the dict tag
    {" t": "not-a-tuple"},    # user dict whose key looks like the tuple tag
    {" t__": b"a"},           # already-escaped key plus a real bytes value
    {"x": (1,2,3), "y": 4},   # ordinary dict with nested tuple
]
for c in cases:
    dumped = s.dumps(c)
    out = s.loads(dumped)
    print(f"in={c!r}\n  dump={dumped}\n  out={out!r}  type={type(out).__name__}  preserved={out==c}")
    assert out == c and type(out) is dict
# demonstrate the intermediate escaping of the key for a lookalike
print("intermediate tag for {' b': 'user'} =", s.tag({" b": "user"}))
print("tagged key is suffixed with __ =", list(s.tag({" b": "user"})[0] if False else s.tag({" b":"user"}).keys()))
PY

in={' b': 'not-bytes'}
  dump={" di":{" b__":"not-bytes"}}
  out={' b': 'not-bytes'}  type=dict  preserved=True
in={' di': ' di'}
  dump={" di":{" di__":" di"}}
  out={' di': ' di'}  type=dict  preserved=True
in={' t': 'not-a-tuple'}
  dump={" di":{" t__":"not-a-tuple"}}
  out={' t': 'not-a-tuple'}  type=dict  preserved=True
in={' t__': b'a'}
  dump={" t__":{" b":"YQ=="}}
  out={' t__': b'a'}  type=dict  preserved=True
in={'x': (1, 2, 3), 'y': 4}
  dump={"x":{" t":[1,2,3]},"y":4}
  out={'x': (1, 2, 3), 'y': 4}  type=dict  preserved=True
intermediate tag for {' b': 'user'} = {' di': {' b__': 'user'}}
tagged key is suffixed with __ = [' di']
```

So the two protections are independent and must be kept separate: the `{" b": ...}` wrapper guarantees *type identity on decode* (only it produces `bytes`), while `TagDict`'s `__` suffix protects *genuine user dicts* from being mistaken for tags.

## 7. Recursion: bytes round-trip at any depth

`PassDict`, `TagTuple`, and `PassList` all recurse through `self.serializer.tag(...)`, so a `bytes` nested in a dict/list/tuple still reaches `TagBytes` (lines 119–157):

```python
class PassDict(JSONTag):
    __slots__ = ()

    def check(self, value: t.Any) -> bool:
        return isinstance(value, dict)

    def to_json(self, value: t.Any) -> t.Any:
        # JSON objects may only have string keys, so don't bother tagging the
        # key here.
        return {k: self.serializer.tag(v) for k, v in value.items()}

    tag = to_json

class TagTuple(JSONTag):
    __slots__ = ()
    key = " t"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, tuple)

    def to_json(self, value: t.Any) -> t.Any:
        return [self.serializer.tag(item) for item in value]

    def to_python(self, value: t.Any) -> t.Any:
        return tuple(value)

class PassList(JSONTag):
    __slots__ = ()

    def check(self, value: t.Any) -> bool:
        return isinstance(value, list)

    def to_json(self, value: t.Any) -> t.Any:
        return [self.serializer.tag(item) for item in value]

    tag = to_json
```

Combined with bottom-up `_untag_scan`, nested bytes round-trip exactly. Verified (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
from flask.json.tag import TaggedJSONSerializer
s = TaggedJSONSerializer()
cases = [
    {"outer": {"inner": [b"\xff", b"\x00", (b"x", b"y")]}},
    [ [ b"a" ], {"k": b"b"} ],
    (b"t0", {"k": [b"t1"]}),
    b"top",
]
for c in cases:
    d = s.dumps(c)
    out = s.loads(d)
    print(f"in ={c!r}\n dump={d}\n out ={out!r}  preserved={out==c}")
    assert out == c
print("RECURSION HOLDS at every depth")
PY

in ={'outer': {'inner': [b'\xff', b'\x00', (b'x', b'y')]}}
 dump={"outer":{"inner":[{" b":"/w=="},{" b":"AA=="},{" t":[{" b":"eA=="},{" b":"eQ=="}]}]}}
 out ={'outer': {'inner': [b'\xff', b'\x00', (b'x', b'y')]}}  preserved=True
in =[[b'a'], {'k': b'b'}]
 dump=[[{" b":"YQ=="}],{"k":{" b":"Yg=="}}]
 out =[[b'a'], {'k': b'b'}]  preserved=True
in =(b't0', {'k': [b't1']})
 dump={" t":[{" b":"dDA="},{"k":[{" b":"dDE="}]}]}
 out =(b't0', {'k': [b't1']})  preserved=True
in =b'top'
 dump={" b":"dG9w"}
 out =b'top'  preserved=True
RECURSION HOLDS at every depth
```

## 8. The tests that pin this behavior

`tests/test_json_tag.py` (lines 12–29) — note the non-UTF-8 `b"\xff"` case and the deliberately hostile dict cases:

```python
@pytest.mark.parametrize(
    "data",
    (
        {" t": (1, 2, 3)},
        {" t__": b"a"},
        {" di": " di"},
        {"x": (1, 2, 3), "y": 4},
        (1, 2, 3),
        [(1, 2, 3)],
        b"\xff",
        Markup("<html>"),
        uuid4(),
        datetime.now(tz=timezone.utc).replace(microsecond=0),
    ),
)
def test_dump_load_unchanged(data):
    s = TaggedJSONSerializer()
    assert s.loads(s.dumps(data)) == data
```

`{" t": (1, 2, 3)}` must *stay* a dict; `{" t__": b"a"}` exercises `TagDict`'s `__` escape combined with a real bytes value; `{" di": " di"}` exercises a user dict that looks like a tag; `b"\xff"` is the non-UTF-8 binary case.

End-to-end through the session cookie — `tests/test_basic.py`, `test_session_special_types` (lines 446–476):

```python
def test_session_special_types(app, client):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    the_uuid = uuid.uuid4()

    @app.route("/")
    def dump_session_contents():
        flask.session["t"] = (1, 2, 3)
        flask.session["b"] = b"\xff"
        flask.session["m"] = Markup("<html>")
        flask.session["u"] = the_uuid
        flask.session["d"] = now
        flask.session["t_tag"] = {" t": "not-a-tuple"}
        flask.session["di_t_tag"] = {" t__": "not-a-tuple"}
        flask.session["di_tag"] = {" di": "not-a-dict"}
        return "", 204

    with client:
        client.get("/")
        s = flask.session
        assert s["t"] == (1, 2, 3)
        assert type(s["b"]) is bytes  # noqa: E721
        assert s["b"] == b"\xff"
        assert type(s["m"]) is Markup  # noqa: E721
        assert s["m"] == Markup("<html>")
        assert s["u"] == the_uuid
        assert s["d"] == now
        assert s["t_tag"] == {" t": "not-a-tuple"}
        assert s["di_t_tag"] == {" t__": "not-a-tuple"}
        assert s["di_tag"] == {" di": "not-a-dict"}
```

Reproduced independently against a real test client (exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe - <<'PY'
import flask, uuid
from datetime import datetime, timezone
from markupsafe import Markup
app = flask.Flask(__name__)
app.secret_key = "test"
now = datetime.now(timezone.utc).replace(microsecond=0)
the_uuid = uuid.uuid4()

@app.route("/")
def dump():
    flask.session["b"] = b"\xff"
    flask.session["t_tag"] = {" t": "not-a-tuple"}
    flask.session["di_tag"] = {" di": "not-a-dict"}
    return "", 204

with app.test_client() as c:
    c.get("/")
    s = flask.session
    print("s['b']        =", repr(s["b"]), "type:", type(s["b"]).__name__)
    print("type is bytes :", type(s["b"]) is bytes)
    print("s['t_tag']    =", s["t_tag"], type(s["t_tag"]).__name__)
    print("s['di_tag']   =", s["di_tag"], type(s["di_tag"]).__name__)
    assert type(s["b"]) is bytes and s["b"] == b"\xff"
    assert s["t_tag"] == {" t": "not-a-tuple"} and type(s["t_tag"]) is dict
    assert s["di_tag"] == {" di": "not-a-dict"} and type(s["di_tag"]) is dict
    ser = app.session_interface.get_signing_serializer(app)
    raw = flask.session
print("SESSION ROUND-TRIP HOLDS: exact bytes type and value, lookalike dicts stay dicts")
PY

s['b']        = b'\xff' type: bytes
type is bytes : True
s['t_tag']    = {' t': 'not-a-tuple'} dict
s['di_tag']   = {' di': 'not-a-dict'} dict
SESSION ROUND-TRIP HOLDS: exact bytes type and value, lookalike dicts stay dicts
```

Test-suite runs (all exit 0):

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/test_json_tag.py -q
..............                                                           [100%]
14 passed in 0.07s

$ PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/test_basic.py::test_session_special_types -q
.                                                                        [100%]
1 passed in 0.08s

$ PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/ -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 4.65s

$ PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/ -vv -rA --tb=long
...
PASSED tests/test_json_tag.py::test_dump_load_unchanged[\xff]
...
============================= 489 passed in 6.19s =============================
```

The maximally verbose `test_json_tag.py` run shows every parametrized case passing, including the bytes one:

```
tests/test_json_tag.py::test_dump_load_unchanged[\xff]  <- ...\tests\test_json_tag.py PASSED [ 50%]
...
============================= 14 passed in 0.07s ==============================
```

## 9. Where this sits (background, not part of the mechanism)

`TaggedJSONSerializer` is the default session payload serializer, which is why bytes matter in practice. From `src/flask/sessions.py` (grep, exit 0):

```
$ grep -n "TaggedJSONSerializer\|session_json_serializer\|serializer = \|get_signing_serializer\|\.dumps(dict(session))" src/flask/sessions.py
14:from .json.tag import TaggedJSONSerializer
287:session_json_serializer = TaggedJSONSerializer()
314:    serializer = session_json_serializer
317:    def get_signing_serializer(self, app: Flask) -> URLSafeTimedSerializer | None:
338:        s = self.get_signing_serializer(app)
387:        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
```

```python
    #: is hmac.
    key_derivation = "hmac"
    #: A python serializer for the payload.  The default is a compact
    #: JSON derived serializer with support for some extra Python types
    #: such as datetime objects or tuples.
    serializer = session_json_serializer
    session_class = SecureCookieSession
```

`TaggedJSONSerializer.dumps` delegates through the Flask JSON wrapper `src/flask/json/__init__.py`, which prefers `current_app.json.*` when an app context exists:

```
$ grep -n "def dumps\|def loads\|current_app\|return json.dumps\|return json.loads\|_json.dumps\|_json.loads" src/flask/json/__init__.py
6:from ..globals import current_app
13:def dumps(obj: t.Any, **kwargs: t.Any) -> str:
40:    if current_app:
41:        return current_app.json.dumps(obj, **kwargs)
44:    return _json.dumps(obj, **kwargs)
77:def loads(s: str | bytes, **kwargs: t.Any) -> t.Any:
102:    if current_app:
103:        return current_app.json.loads(s, **kwargs)
105:    return _json.loads(s, **kwargs)
```

The changelog confirms the decode path is Python-side scanning rather than a `json` `object_hook` (`CHANGES.rst`, lines 86–88):

```
-   Session data is untagged without relying on the built-in ``json.loads``
    ``object_hook``. This allows other JSON providers that don't implement that.
    :issue:`5381`
```

## 10. Precise summary of the two invariants

| Concern | Mechanism | Why it holds |
|---|---|---|
| **Reversibility (losslessness)** | `to_json = b64encode(value).decode("ascii")`; `to_python = b64decode(value)` | Base64 is a bijection, so `b64decode(b64encode(v)) == v` byte-for-byte, including non-UTF-8 `b"\xff"`. No charset conversion or normalization exists in the path. The `.decode("ascii")` never fails because base64 output ⊆ ASCII. |
| **Consistency, part 1 — type identity on decode** | `JSONTag.tag` wraps as `{" b": "<base64>"}`; `untag` converts only a single-key dict whose key is registered | A base64-looking plain string, an ordinary `{"b": ...}` dict, or a multi-key dict containing `" b"` is never converted to `bytes`. |
| **Consistency, part 2 — user dicts that look like tags** | `TagDict` first in `default_tags`; suffixes the key with `__`, strips it on decode | `{" b": "not-bytes"}`, `{" di": " di"}`, `{" t": ...}` survive as dicts and are never mistaken for bytes/tuples. |
| **Depth independence** | `PassDict`/`PassList`/`TagTuple` recurse via `serializer.tag(...)`; `_untag_scan` decodes bottom-up | Bytes nested anywhere (including inside tuples) round-trip exactly. |

No source file was modified for this question — `git diff --stat` is empty and the only untracked entry is the pre-existing, unrelated `flask_mut2_i417ar2x/` directory — so the deliverable is the analysis above, not a patch.
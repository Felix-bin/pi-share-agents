# Why `TagUUID` converts UUIDs to hex **and** back again

## Short answer

`TagUUID` is not a free-standing converter — it is a subclass of `JSONTag`, and the tagged-JSON system's contract requires every registered tag to define **both** halves of a round trip: `to_json` (Python object → JSON-legal value) and `to_python` (JSON value → Python object). The system exists for "lossless serialization of non-standard JSON types," and its primary consumer, `SecureCookieSessionInterface`, writes session data out through `dumps` and reads it back through `loads`. JSON has no UUID type, so a UUID can only travel over the wire as a string; the tag key `" u"` is what records *that the string was originally a UUID*, so that on the way back `untag` can look the key up in the serializer's registry and call `to_python` to rebuild a real `UUID` object. Without `to_python`, a session UUID would come back as a plain `str` and the round trip would be lossy.

---

## 1. The class in question: `TagUUID` — `src/flask/json/tag.py:191–202`

Quoted verbatim (confirmed by the executor at `tag.py:191–202`):

```python
class TagUUID(JSONTag):
    __slots__ = ()
    key = " u"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, UUID)

    def to_json(self, value: t.Any) -> t.Any:
        return value.hex

    def to_python(self, value: t.Any) -> t.Any:
        return UUID(value)
```

The import that makes the reverse direction possible is at line 50 (`from uuid import UUID`), inside the module's import block (lines 47–53):

```python
from base64 import b64decode
from base64 import b64encode
from datetime import datetime
from uuid import UUID

from markupsafe import Markup
```

- `check` → `isinstance(value, UUID)` decides a value is eligible for this tag.
- `to_json` → `value.hex` — a Python UUID becomes a 32-character, hyphen-less hex string, which is a valid JSON value.
- `to_python` → `UUID(value)` — the hex string becomes a `UUID` instance again.
- `key = " u"` — the wire marker written onto the JSON object and looked up on the way back.

This is the **only** UUID-specific tag in the tagged-JSON system.

---

## 2. The `JSONTag` contract that forces two directions — `src/flask/json/tag.py:60–90`

The base class mandates the symmetry explicitly. Quoted verbatim (confirmed at `tag.py:60–90`):

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

The two docstrings spell out the two directions: `to_json` converts "the Python object to an object that is a valid JSON type. The tag will be added later"; `to_python` converts "the JSON representation back to the correct type. The tag will already be removed." Note that the inherited `tag()` wraps the result of `to_json` as `{self.key: self.to_json(value)}` — for `TagUUID` that is `{" u": <hex>}`. `TagUUID` inherits this wrapping and only overrides `check`, `to_json`, and `to_python`.

The contract is also *tested* as mandatory for all three methods, in `tests/test_json_tag.py` (lines 66–70):

```python
def test_tag_interface():
    t = JSONTag(None)
    pytest.raises(NotImplementedError, t.check, None)
    pytest.raises(NotImplementedError, t.to_json, None)
    pytest.raises(NotImplementedError, t.to_python, None)
```

---

## 3. Registration: how the reverse direction finds the right tag — `src/flask/json/tag.py:219–288`

`TagUUID` is listed in `default_tags` (line 245), and `register()` stores each tag instance under its key in the `self.tags` mapping. Quoted verbatim (confirmed at `tag.py:219–288`):

```python
class TaggedJSONSerializer:
    """Serializer that uses a tag system to compactly represent objects that
    are not JSON types. Passed as the intermediate serializer to
    :class:`itsdangerous.Serializer`.

    The following extra types are supported:

    * :class:`dict`
    * :class:`tuple`
    * :class:`bytes`
    * :class:`~markupsafe.Markup`
    * :class:`~uuid.UUID`
    * :class:`~datetime.datetime`
    """

    __slots__ = ("tags", "order")

    #: Tag classes to bind when creating the serializer. Other tags can be
    #: added later using :meth:`~register`.
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

    def __init__(self) -> None:
        self.tags: dict[str, JSONTag] = {}
        self.order: list[JSONTag] = []

        for cls in self.default_tags:
            self.register(cls)

    def register(
        self,
        tag_class: type[JSONTag],
        force: bool = False,
        index: int | None = None,
    ) -> None:
        """Register a new tag with this serializer.
        ...
        :raise KeyError: if the tag key is already registered and ``force`` is
            not true.
        """
        tag = tag_class(self)
        key = tag.key

        if key:
            if not force and key in self.tags:
                raise KeyError(f"Tag '{key}' is already registered.")

            self.tags[key] = tag

        if index is None:
            self.order.append(tag)
        else:
            self.order.insert(index, tag)
```

Because `TagUUID.key` is the non-empty string `" u"`, `register()` executes `self.tags[key] = tag` — i.e. `self.tags[" u"] = <TagUUID instance>`. That single assignment is what makes the reverse lookup possible. The class docstring also names `:class:`~uuid.UUID`` as one of the extra supported types.

*(Executor note: the evidence handoff cited this store at line 278; direct inspection shows `self.tags[key] = tag` at **line 282**. The `key = " u"` definition is at line 193 and `TagUUID` in `default_tags` at line 245, both as quoted.)*

---

## 4. The two dispatching halves that actually call the methods — `src/flask/json/tag.py:289–327`

Quoted verbatim (confirmed at `tag.py:289–327`):

```python
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value

    def untag(self, value: dict[str, t.Any]) -> t.Any:
        """Convert a tagged representation back to the original type."""
        if len(value) != 1:
            return value

        key = next(iter(value))

        if key not in self.tags:
            return value

        return self.tags[key].to_python(value[key])

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

    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))

    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

This is the mechanical "why," stated as an invariant:

- **Forward:** `dumps` calls `tag(value)`; `tag` iterates `self.order` and calls `tag.check(value)`; `TagUUID.check` matches a `UUID`; then `tag.tag(value)` returns the inherited `{self.key: self.to_json(value)}` = `{" u": "<hex>"}`.
- **Backward:** `loads` calls `_untag_scan`; for a dict it recurses into values then calls `untag` on the dict; `untag` requires exactly one key, reads it, checks it is present in `self.tags` (it is, thanks to `register()`), and calls `self.tags[key].to_python(value[key])` → `UUID("<hex>")`.

So `to_json` and `to_python` are literally the two halves of one `dumps`/`loads` round trip, and the tag key `" u"` is the piece of information that survives the wire and lets the reverse half dispatch correctly.

The serializer docstring of the module reinforces that this round trip must be lossless — `src/flask/json/tag.py:1–9` (confirmed by the executor):

```python
"""
Tagged JSON
~~~~~~~~~~~

A compact representation for lossless serialization of non-standard JSON
types. :class:`~flask.sessions.SecureCookieSessionInterface` uses this
to serialize the session data, but it may be useful in other places. It
can be extended to support other types.
```

---

## 5. The consumer that makes losslessness necessary: `SecureCookieSessionInterface`

The stated consumer is real code, not just documentation. In `src/flask/sessions.py`, a module-level serializer instance is used as the class default (confirmed at lines 287–315):

```python
session_json_serializer = TaggedJSONSerializer()
...
class SecureCookieSessionInterface(SessionInterface):
    ...
    #: A python serializer for the payload.  The default is a compact
    #: JSON derived serializer with support for some extra Python types
    #: such as datetime objects or tuples.
    serializer = session_json_serializer
    session_class = SecureCookieSession
```

The serializer is handed to itsdangerous for cookie signing (confirmed at lines 317–335):

```python
    def get_signing_serializer(self, app: Flask) -> URLSafeTimedSerializer | None:
        if not app.secret_key:
            return None
        ...
        return URLSafeTimedSerializer(
            keys,  # type: ignore[arg-type]
            salt=self.salt,
            serializer=self.serializer,
            signer_kwargs={...},
        )
```

And the session data is written with `dumps` and read with `loads` in `open_session`/`save_session` (confirmed at lines 337–387):

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
...
        expires = self.get_expiration_time(app, session)
        val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]
        response.set_cookie(...)
```

This is the concrete motivation: a signed-cookie session goes **out** through `dumps` and comes **back in** through `loads`. If a UUID is stored in `flask.session`, it must be reconstructed as an equal `UUID` — not merely a string the user must re-parse. That is exactly the job of `TagUUID.to_python`.

`CHANGES.rst:86–88` confirms that deserialization runs through this `untag` path (which is what invokes `TagUUID.to_python`):

```rst
-   Session data is untagged without relying on the built-in ``json.loads``
    ``object_hook``. This allows other JSON providers that don't implement that.
    :issue:`5381`
```

---

## 6. Contrast: the **one-way** plain-JSON path (not the class in question)

Flask has a *separate* UUID handling path for ordinary `jsonify`, which is deliberately one-way. `src/flask/json/provider.py:108–121` (confirmed):

```python
def _default(o: t.Any) -> t.Any:
    if isinstance(o, date):
        return http_date(o)

    if isinstance(o, (decimal.Decimal, uuid.UUID)):
        return str(o)

    if dataclasses and dataclasses.is_dataclass(o):
        return dataclasses.asdict(o)  # type: ignore[arg-type]

    if hasattr(o, "__html__"):
        return str(o.__html__())

    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")
```

Its documented behaviour, `src/flask/json/provider.py:124–136` (confirmed), is explicitly one-way:

```python
class DefaultJSONProvider(JSONProvider):
    """Provide JSON operations using Python's built-in :mod:`json`
    library. Serializes the following additional data types:

    -   :class:`datetime.datetime` and :class:`datetime.date` are
        serialized to :rfc:`822` strings. This is the same as the HTTP
        date format.
    -   :class:`uuid.UUID` is serialized to a string.
    -   :class:`dataclasses.dataclass` is passed to
        :func:`dataclasses.asdict`.
    -   :class:`~markupsafe.Markup` (or any object with a ``__html__``
        method) will call the ``__html__`` method to get a string.
    """
```

Two important format details, both empirically confirmed:

| Path | Code | Output format |
|---|---|---|
| Tagged JSON (`TagUUID.to_json`) | `value.hex` | 32 hex chars, **no** hyphens |
| Plain JSON (`provider._default`) | `str(o)` | hyphenated form, 36 chars |

So when the answer says "the string form," it must be explicit: the tagged path prefers the compact `hex` form, while the `jsonify` path emits `str(uuid)`. `TagUUID` is the only class in "the tagged JSON serialization system" that handles UUIDs; `provider._default` is a different, one-directional path.

---

## 7. Empirical confirmation of the round trip

The executor ran a minimal `TaggedJSONSerializer` script (with `PYTHONPATH=src .venv/Scripts/python.exe`, Python 3.13.9) and observed the full output verbatim:

```
original UUID        : UUID('fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2')
str(uuid) hyphenated : fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2 len 36
uuid.hex             : fe56a6e4c2f04ef9ad03564c6d5c03d2 len 32
registered ' u' tag  : <flask.json.tag.TagUUID object at 0x000001F5F3F067D0>
tag.check(uuid)      : True
tag.tag(u)           : {' u': 'fe56a6e4c2f04ef9ad03564c6d5c03d2'}
to_json(u)           : fe56a6e4c2f04ef9ad03564c6d5c03d2
dumps(u)             : {" u":"fe56a6e4c2f04ef9ad03564c6d5c03d2"}
json.loads wire      : {' u': 'fe56a6e4c2f04ef9ad03564c6d5c03d2'}
loads(wire)          : UUID('fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2') type <class 'uuid.UUID'>
equal                : True
isinstance UUID      : True
dumps(dict)          : {"u":{" u":"fe56a6e4c2f04ef9ad03564c6d5c03d2"},"n":[{" u":"fe56a6e4c2f04ef9ad03564c6d5c03d2"}]}
loads(dict)          : {'u': UUID('fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2'), 'n': [UUID('fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2')]} <class 'uuid.UUID'> <class 'uuid.UUID'>
nested round-trip eq : True
provider _default(u) : fe56a6e4-c2f0-4ef9-ad03-564c6d5c03d2 len 36
provider result type : <class 'str'>
```

This is the whole mechanism in one transcript: `check` matched, the wire form was `{" u":"<32-char hex>"}`, `loads` returned an **equal `UUID` instance** (including when nested inside a dict/list), while the plain provider path returned a hyphenated **`str`** (one-way).

### The tests that encode the invariant

`tests/test_json_tag.py` (full-file inspection confirmed the content; note the file is 86 lines, `uuid4()` at line 23, and the equality assertion at line 29):

```python
from datetime import datetime
from datetime import timezone
from uuid import uuid4

import pytest
from markupsafe import Markup

from flask.json.tag import JSONTag
from flask.json.tag import TaggedJSONSerializer

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

The assertion `s.loads(s.dumps(data)) == data` with `uuid4()` in the parameter list is the direct statement that `dumps`→`loads` must yield an equal UUID.

`tests/test_basic.py::test_session_special_types` (confirmed at lines 448–476) exercises the real session round trip:

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

The UUID is set at line 457 (`flask.session["u"] = the_uuid`) and asserted equal at line 472 (`assert s["u"] == the_uuid`) — after a full cookie write/read cycle, `to_python` has reconstructed the object.

`tests/test_json.py::test_jsonify_uuid_types` (confirmed at lines 176–188) shows the *separate* one-way path, where the client itself must rebuild the UUID:

```python
def test_jsonify_uuid_types(app, client):
    """Test jsonify with uuid.UUID types"""

    test_uuid = uuid.UUID(bytes=b"\xde\xad\xbe\xef" * 4)
    url = "/uuid_test"
    app.add_url_rule(url, url, lambda: flask.jsonify(x=test_uuid))

    rv = client.get(url)

    rv_x = flask.json.loads(rv.data)["x"]
    assert rv_x == str(test_uuid)
    rv_uuid = uuid.UUID(rv_x)
    assert rv_uuid == test_uuid
```

Here the response carries only `str(test_uuid)`; Flask does not rebuild the UUID — the test does it manually with `uuid.UUID(rv_x)`. This is the `provider._default` path, not `TagUUID`.

### Test run results (all exit 0)

Targeted run:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_json_tag.py "tests/test_basic.py::test_session_special_types" "tests/test_json.py::test_jsonify_uuid_types" -rA
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q9-TXT\seal
configfile: pyproject.toml
collected 16 items

tests\test_json_tag.py ..............                                    [ 87%]
tests\test_basic.py .                                                    [ 93%]
tests\test_json.py .                                                     [100%]

=================================== PASSES ====================================
=========================== short test summary info ===========================
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data0]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data1]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data2]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data3]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data4]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data5]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[\xff]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[<html>]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data8]
PASSED tests/test_json_tag.py::test_dump_load_unchanged[data9]
PASSED tests/test_json_tag.py::test_duplicate_tag
PASSED tests/test_json_tag.py::test_custom_tag
PASSED tests/test_json_tag.py::test_tag_interface
PASSED tests/test_json_tag.py::test_tag_order
PASSED tests/test_basic.py::test_session_special_types
PASSED tests/test_json.py::test_jsonify_uuid_types
============================= 16 passed in 0.15s ==============================
EXIT_STATUS=0
```

`data8` is the `uuid4()` parameter, so the UUID round-trip parametrization passed. Full suite: `489 passed in 6.08s`, exit 0. The executor verified `the_uuid = uuid.uuid4()` at line 450 and `assert s["u"] == the_uuid` at line 472 in `tests/test_basic.py`, and noted the run was made with `PYTHONPATH=src` because the shared `.venv`'s installed `flask` points at a different checkout; the code under test was confirmed to resolve to this repository's `src/flask/__init__.py`. No source files were edited.

---

## 8. Why this matters — the "why" in one paragraph

JSON defines no UUID type, so a UUID stored in session data can only be written to a signed cookie as a string. The tagged-JSON system was built explicitly for "**lossless serialization** of non-standard JSON types," and its named consumer, `SecureCookieSessionInterface`, serializes the session on the way out (`dumps`) and deserializes it on the way back (`loads`). Because `TagUUID` subclasses `JSONTag`, it is required to provide both `to_json` and `to_python`; `to_json` produces the compact `value.hex` form for the wire while the inherited `tag()` wraps it as `{" u": "<hex>"}`, and the embedded `" u"` key is the only surviving clue that the string was a UUID. On the return path, `_untag_scan` → `untag` recognizes the single-key dict, finds the `" u"` entry that `register()` placed in `self.tags`, and calls `to_python`, which executes `UUID(value)` and restores a genuine `UUID` instance. That bidirectional pair is what makes `TagUUID` a lossless codec rather than a one-way stringifier — unlike the plain `jsonify` path in `provider._default`, which merely calls `str(o)` and never rebuilds the object (which is why `test_jsonify_uuid_types` has to call `uuid.UUID(rv_x)` itself). The tests `test_dump_load_unchanged` (with `uuid4()`), `test_session_special_types` (store `"u"`, assert `s["u"] == the_uuid`), and `test_jsonify_uuid_types` (the one-way contrast) encode exactly this distinction.

### Excluded, unrelated UUID references

For completeness, the following are **not** about tagged JSON serialization and were confirmed as red herrings: `docs/quickstart.rst:208` and `docs/api.rst:563` (both read `` `uuid`   accepts UUID strings``) document the **URL variable converter** for `<uuid:...>` route rules; `docs/conf.py:66` (`gettext_uuid = True`) is a Sphinx gettext setting. None of them touch `TagUUID`, `to_json`, `to_python`, or the tag system.

---

### Summary of the answer

- **Class:** `TagUUID`, `src/flask/json/tag.py:191–202`, tag key `" u"`, subclass of `JSONTag`.
- **Forward direction:** `to_json` returns `value.hex` (compact, 32 chars); inherited `tag()` wraps it as `{" u": <hex>}`.
- **Reverse direction:** `untag` finds the single `" u"` key in `self.tags` (populated by `register()`) and calls `to_python`, which runs `UUID(value)`.
- **Why both directions exist:** the `JSONTag` contract (`tag.py:60–90`) requires `to_json` and `to_python` of every tag so that `TaggedJSONSerializer.dumps`/`loads` form a lossless round trip; the module's stated purpose is lossless serialization of non-standard types; and the consumer `SecureCookieSessionInterface` (`src/flask/sessions.py:287–387`) depends on session data surviving a cookie write/read cycle with types intact. Without `to_python`, a UUID in the session would return as a bare string.
- **Not to be conflated with:** the one-way `provider._default` (`str(o)`, `src/flask/json/provider.py:112–113`) used by plain `jsonify`, or the URL converter docs.
# Why `PassDict` tags dictionary **values** but deliberately leaves **keys** alone

**Short answer.** `PassDict.to_json` tags only the values because a tag in this serializer is itself a JSON object (a one-key `dict`), and JSON object member names must be strings — so a tagged key is not merely pointless, it is *impossible*: it can neither be used as a Python dict key (a dict is unhashable) nor be encoded as a JSON object key, and the deserializer has no code path that would ever read a tag back out of a key anyway. The code says exactly this in one comment, and everything else in the module confirms it.

---

## 1. The literal reason: the inline comment, and the code it annotates

The class in question is `PassDict` in `src/flask/json/tag.py` (definition at **line 119**, registration at **line 240**). Its full definition is:

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
```

The comment sits at **lines 126–127**. Note the comprehension: `self.serializer.tag(v)` is applied to the **value** `v` only; the key `k` is emitted verbatim into the new dict. The trailing `tag = to_json` rebinds the base-class `tag` method so that when the dispatcher calls `tag.tag(value)` it lands on this body.

The "pass-through" character of this class is the point: `check` matches *any* `dict`, and `to_json` returns a dict of the same shape, recursing into values. It is registered immediately after `TagDict` in `default_tags`:

```python
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
```

(Registration order matters, and is discussed in §5.)

The comment is not an isolated remark — it is the only prose of its kind in the repository. A repo-wide case-insensitive search for `string keys|unhashable|keys must be|only have string|not bother tagging` returned exactly one hit:

```
./src/flask/json/tag.py:126:        # JSON objects may only have string keys, so don't bother tagging the
```

JSON objects are, per the JSON data model (RFC 8259 §4), *unordered collections of zero or more name/value pairs*, where a **name is a string**. A tag has no place to live on a name.

---

## 2. Why it is *impossible*, not merely skipped: a tag is a dict

The base class shows what a tag actually is:

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

The key line is the last one: `tag()` returns `{self.key: self.to_json(value)}` — a **`dict`**. That single fact forces the asymmetry, and the executor demonstrated both failure modes concretely.

### 2a. Tagging a key produces an unhashable object

`("a", "b")` is a tuple; `TagTuple` (registered in `default_tags`) claims it, so `self.serializer.tag(("a","b"))` returns the *dict* `{" t": ["a", "b"]}`. Using that dict as a Python key fails before JSON is even reached. Executed:

```
s.tag(("a","b")) -> {' t': ['a', 'b']} dict
using tagged key as Python dict key -> TypeError : unhashable type: 'dict'
```

Full traceback (uncaught), as executed:

```
FAILURE MODE 2: try to use a tag (a dict) as a key -> Python rejects it
tagged_key = {' t': ['a', 'b']}
Traceback (most recent call last):
  File "<stdin>", line 6, in <module>
TypeError: unhashable type: 'dict'
EXIT=1
```

### 2b. Leaving the key plain terminates in JSON's own key-type error

The other horn: passing the non-string key through untouched (which is what `PassDict` does) fails at serialization time. The serializer's `dumps` is:

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

and `flask.json.dumps` bottoms out in the stdlib encoder:

```python
def dumps(obj: t.Any, **kwargs: t.Any) -> str:
    """Serialize data as JSON.

    If :data:`~flask.current_app` is available, it will use its
    :meth:`app.json.dumps() <flask.json.provider.JSONProvider.dumps>`
    method, otherwise it will use :func:`json.dumps`.
    ...
    """
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

and in app context the default provider does the same:

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON to a string.

        Keyword arguments are passed to :func:`json.dumps`. Sets some
        parameter defaults from the :attr:`default`,
        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.

        :param obj: The data to serialize.
        :param kwargs: Passed to :func:`json.dumps`.
        """
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

The stdlib encoder accepts only `str`/`int`/`float`/`bool`/`None` object keys (coercing the scalars to strings) and rejects everything else. Executed for the concrete `{("a", "b"): datetime(2020,1,1,tzinfo=utc)}`:

```
PassDict.to_json -> {('a', 'b'): {' d': 'Wed, 01 Jan 2020 00:00:00 GMT'}}
keys preserved untouched: [('a', 'b')]
key is same object as original key: True
value layer tagged: {' d': 'Wed, 01 Jan 2020 00:00:00 GMT'}
tag == to_json identity: True
```

```
s.tag(val) -> {('a', 'b'): {' d': 'Wed, 01 Jan 2020 00:00:00 GMT'}}
json.dumps(s.tag(val)) -> TypeError : keys must be str, int, float, bool or None, not tuple
TaggedJSONSerializer.dumps(val) -> TypeError : keys must be str, int, float, bool or None, not tuple
```

Full traceback:

```
FAILURE MODE 1: preserve the non-string key -> JSON rejects it
Traceback (most recent call last):
  File "<stdin>", line 5, in <module>
  File "...\seal\src\flask\json\tag.py", line 323, in dumps
    return dumps(self.tag(value), separators=(",", ":"))
  File "...\seal\src\flask\json\__init__.py", line 44, in dumps
    return _json.dumps(obj, **kwargs)
  File "...\Lib\json\__init__.py", line 238, in dumps
    **kw).encode(obj)
  File "...\Lib\json\encoder.py", line 200, in encode
    chunks = self.iterencode(o, _one_shot=True)
  File "...\Lib\json\encoder.py", line 261, in iterencode
    return _iterencode(o, 0)
TypeError: keys must be str, int, float, bool or None, not tuple
EXIT=1
```

Confirmed independently against the raw stdlib encoder, and against Flask's out-of-context JSON function:

```
flask.has_app_context(): False
flask.json.dumps out-of-ctx tuple-key -> TypeError : keys must be str, int, float, bool or None, not tuple
coerced scalars: {"1": "c", "2.5": "b", "null": "d"}
```

```
stdlib json.dumps ('a', 'b') -> TypeError : keys must be str, int, float, bool or None, not tuple
stdlib json.dumps ('a', 'b', 'c') -> TypeError : keys must be str, int, float, bool or None, not tuple
```

So the *scalar* non-string keys that JSON tolerates are silently coerced to strings (`{1: "a"}` → `{"1": "a"}`, `{None: "b"}` → `{"null": "b"}`), which is exactly what `tests/test_json.py::test_json_key_sorting` relies on:

```python
def test_json_key_sorting(app, client):
    app.debug = True
    assert app.json.sort_keys
    d = dict.fromkeys(range(20), "foo")

    @app.route("/")
    def index():
        return flask.jsonify(values=d)

    rv = client.get("/")
    lines = [x.strip() for x in rv.data.strip().decode("utf-8").splitlines()]
    sorted_by_str = [
        "{",
        '"values": {',
        '"0": "foo",',
        '"1": "foo",',
        ...
    ]
```

But a *tag* is a `dict`, not an int/float/bool/None, so it is not coercible. The in-repo documentation of this constraint appears in `DefaultJSONProvider.sort_keys`:

```python
    sort_keys = True
    """Sort the keys in any serialized dicts. This may be useful for
    some caching situations, but can be disabled for better performance.
    When enabled, keys must all be strings, they are not converted
    before sorting.
    """
```

There is a further corroborating detail: the `default=` fallback hook used by the stdlib encoder is invoked only for **values** it cannot serialize, never for keys:

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

**Conclusion for this section:** the intersection of the two failure modes is empty. If you tag the key you get `TypeError: unhashable type: 'dict'`; if you don't, you get `TypeError: keys must be str, int, float, bool or None, not tuple`. The comment's "don't bother" is therefore forced by JSON's and Python's data models, not an optimization.

---

## 3. Even if a key *could* carry a tag, deserialization could never reverse it

The reverse direction shows the same value-only symmetry. The two relevant methods:

```python
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
```

Read the dict branch carefully: it recurses via `self._untag_scan(v)` on **values**, then calls `self.untag(value)` on the **dict node itself**. The key `k` is copied through untouched and is never handed to `_untag_scan`. `untag` likewise only *reads* the single key as a lookup into `self.tags` — it never transforms a key.

The executor instrumented `_untag_scan` with a spy wrapper to prove no key is ever passed to it:

```
input: {"k1": {"k2": [1, [2, 3]]}}
result: {'k1': {'k2': [1, 2, 3]}}
every argument _untag_scan was called with, in order:
    {'k1': {'k2': [1, [2, 3]]}}
    {'k2': [1, [2, 3]]}
    [1, [2, 3]]
    1
    [2, 3]
    2
    3
exit=0
```

`"k1"` and `"k2"` never appear. Corroborated by grepping all call sites in the repository:

```
src/flask/json/tag.py:309:    def _untag_scan(self, value: t.Any) -> t.Any:
src/flask/json/tag.py:312:            value = {k: self._untag_scan(v) for k, v in value.items()}
src/flask/json/tag.py:317:            value = [self._untag_scan(item) for item in value]
src/flask/json/tag.py:327:        return self._untag_scan(loads(value))
```

and all `serializer.tag(` call sites (every one tags a value, a keyed-by-`__` escaped value, or a dict node — never a key):

```
src/flask/json/tag.py:36:            return [[k, self.serializer.tag(v)] for k, v in iteritems(value)]
src/flask/json/tag.py:112:        return {f"{key}__": self.serializer.tag(value[key])}
src/flask/json/tag.py:128:        return {k: self.serializer.tag(v) for k, v in value.items()}
src/flask/json/tag.py:141:        return [self.serializer.tag(item) for item in value]
src/flask/json/tag.py:154:        return [self.serializer.tag(item) for item in value]
src/flask/json/tag.py:323:        return dumps(self.tag(value), separators=(",", ":"))
tests/test_json_tag.py:56:            return self.serializer.tag(value.data)
```

So `JSONTag.to_python`'s promise — *"Convert the JSON representation back to the correct type. The tag will already be removed."* — and `to_json`'s mirror promise — *"Convert the Python object to an object that is a valid JSON type. The tag will be added later."* — are, by construction, statements about **values** on both sides. The invariant is that tagging is symmetric between `to_json`/`tag` and `_untag_scan`/`untag`, and that symmetry exists only for values. A tagged key would be a lossy round trip with no code to undo it.

Note also that a key only ever counts as a tag when it is a lone key of a one-element dict whose *string* value is a registered tag key; that is a lookup, not a transformation:

```
loads('{" t": [1,2,3]}') -> (1, 2, 3)
loads('{" t": [1,2,3], "z": 1}') -> {' t': [1, 2, 3], 'z': 1}
untag({" t": [1,2,3], "z": 1}) -> {' t': [1, 2, 3], 'z': 1}
```

---

## 4. Design intent: compact, lossless cookie-session payloads whose keys are strings by construction

The module docstring states the purpose outright (`src/flask/json/tag.py` lines 1–17):

```
"""
Tagged JSON
~~~~~~~~~~~

A compact representation for lossless serialization of non-standard JSON
types. :class:`~flask.sessions.SecureCookieSessionInterface` uses this
to serialize the session data, but it may be useful in other places. It
can be extended to support other types.

.. autoclass:: TaggedJSONSerializer
    :members:

.. autoclass:: JSONTag
    :members:

Let's see an example that adds support for
```

And in `src/flask/sessions.py` the serializer is instantiated at module level and wired in as the cookie payload serializer:

```python
session_json_serializer = TaggedJSONSerializer()
```

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

This context explains why compactness matters (the payload goes into a signed cookie, so every byte counts) and why `PassDict` exists as a *pass-through* at all: since a plain dict is already JSON-serializable, `PassDict` has no tag of its own (`key` is inherited as `""`, documented as *"The tag to mark the serialized object with. If empty, this tag is only used as an intermediate step during tagging."*). It exists solely to recurse into a dict's values so that non-JSON values nested inside plain dicts get tagged. Session data is keyed by strings by construction, so tagging keys would add bytes (and, per §2, fail outright) for zero benefit.

The module's own extension example follows the identical convention — value tagged, key left alone:

```
src/flask/json/tag.py:36:            return [[k, self.serializer.tag(v)] for k, v in iteritems(value)]
```

as does the custom-tag test in `tests/test_json_tag.py`:

```python
def test_custom_tag():
    class Foo:  # noqa: B903, for Python2 compatibility
        def __init__(self, data):
            self.data = data

    class TagFoo(JSONTag):
        __slots__ = ()
        key = " f"

        def check(self, value):
            return isinstance(value, Foo)

        def to_json(self, value):
            return self.serializer.tag(value.data)

        def to_python(self, value):
            return Foo(value)

    s = TaggedJSONSerializer()
    s.register(TagFoo)
    assert s.loads(s.dumps(Foo("bar"))).data == "bar"
```

---

## 5. The one real key-related hazard is handled by *escaping*, not tagging — and `TagDict` does it

The genuine hazard is not "a key needs a tag" but "a key that **looks like** a tag must not be mistaken for one on the way back". That case is handled by the sibling class `TagDict`, immediately before `PassDict` in the registration order, and it solves it by string escaping:

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

`TagDict.to_json` appends `__` to the key *as a string* and tags `value[key]` — the value. `to_python` strips the `__` string suffix. Keys stay opaque strings throughout; that is the opposite of tagging them. Because `TagDict` is at index 0 of `default_tags` and `PassDict` at index 1, and `TaggedJSONSerializer.tag` takes the **first** matching tag:

```python
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value
```

`TagDict` gets first refusal on exactly the single-key "looks like a tag" case, and `PassDict` handles everything else. The executor exercised this on the real serializer:

```
orig: {' t': (1, 2, 3)}
tagged: {' di': {' t__': {' t': [1, 2, 3]}}}
dumps: {" di":{" t__":{" t":[1,2,3]}}}
loads: {' t': (1, 2, 3)} == orig: True
orig2: {' di': ' di'} -> dumps: {" di":{" di__":" di"}} -> loads: {' di': ' di'}
```

and the ordering was confirmed at runtime:

```
order: ['TagDict', 'PassDict', 'TagTuple', 'PassList', 'TagBytes', 'TagMarkup', 'TagUUID', 'TagDateTime']
value: {('a', 'b'): datetime.datetime(2020, 1, 1, 0, 0, tzinfo=datetime.timezone.utc)} len: 1
TagDict.check(value): False
PassDict.check(value): [False, True, False, False, False, False, False, False]
first matching tag in order: PassDict
```

(Here the value happens to have length 1, so `TagDict` is excluded not for length but because the key `("a","b")` is not a registered tag string — the only reason `TagDict.check` can fail for a one-element dict.)

This is also exactly what the parameterised round-trip test covers, both the tag-looking-key cases (`TagDict`'s job) and the plain multi-key dict (`PassDict`'s job):

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

In `{"x": (1, 2, 3), "y": 4}` the tuple value is tagged and the keys `x`/`y` are untouched — confirmed by execution:

```
loads of {"x": {" t": [1,2,3]}}: {'x': (1, 2, 3)}
dumps({"x": (1,2,3), "y": 4}) = {"x":{" t":[1,2,3]},"y":4}
loads(blob) = {'x': (1, 2, 3), 'y': 4} == orig: True
keys of tagged output: ['x', 'y']
```

**No test anywhere asserts that keys are tagged.** A repo-wide search for `PassDict` returns only its definition and registration:

```
./src/flask/json/tag.py:119:class PassDict(JSONTag):
./src/flask/json/tag.py:240:        PassDict,
```

and for `TagDict`:

```
./src/flask/json/tag.py:93:class TagDict(JSONTag):
./src/flask/json/tag.py:239:        TagDict,
./tests/test_json_tag.py:33:    class TagDict(JSONTag):
./tests/test_json_tag.py:37:    pytest.raises(KeyError, s.register, TagDict)
./tests/test_json_tag.py:38:    s.register(TagDict, force=True, index=0)
./tests/test_json_tag.py:39:    assert isinstance(s.tags[" d"], TagDict)
./tests/test_json_tag.py:40:    assert isinstance(s.order[0], TagDict)
```

The full suite passes with 489 tests (14 in `test_json_tag.py`, 31 in `test_json.py`), 0 failures/errors/skips, both normally and under `-vv -rA --tb=long`:

```
$ PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/test_json_tag.py tests/test_json.py
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q2-TXT\seal
configfile: pyproject.toml
collected 45 items

tests\test_json_tag.py ..............                                    [ 31%]
tests\test_json.py ...............................                       [100%]

============================= 45 passed in 0.33s ==============================
EXIT=0
```

```
============================= 489 passed in 6.50s =============================
EXIT=0
```

and the `-rA` log aggregate:

```
PASSED lines: 489
FAILED lines: 0
ERROR lines: 0
SKIPPED lines: 0
```

---

## Bottom line

`PassDict.to_json` applies `self.serializer.tag` to values only, and the inline comment at `src/flask/json/tag.py:126–127` — *"JSON objects may only have string keys, so don't bother tagging the key here."* — states the reason. It is the *reason*, not a stylistic choice, because:

1. **JSON forbids it.** JSON object member names are strings (RFC 8259); the encoder that `flask.json.dumps` and `DefaultJSONProvider.dumps` both delegate to accepts only `str`/`int`/`float`/`bool`/`None` keys and raises `TypeError: keys must be str, int, float, bool or None, not tuple` for anything else — and a tag is a `dict`, which is not even in that set.
2. **Python forbids it too.** A tag is produced by `JSONTag.tag`, which returns `{self.key: self.to_json(value)}`; using that dict as a key raises `TypeError: unhashable type: 'dict'` before serialization begins.
3. **Deserialization would be lossy regardless.** `_untag_scan` recurses into values and calls `untag` on the dict node; keys are copied verbatim and never scanned, so there is no path that could recover a tagged key. Tagging is symmetric value-in/value-out only.
4. **Design intent agrees.** The serializer exists for compact, lossless cookie-session payloads (`session_json_serializer = TaggedJSONSerializer()`, `SecureCookieSessionInterface.serializer = session_json_serializer`), where keys are strings by construction, so tagging keys buys nothing and costs bytes.
5. **The actual key hazard — a key that *looks like* a tag — is handled by string escaping via `TagDict`** (suffix `__` on the key string, stripped in `to_python`), which is registered ahead of `PassDict` and tags the value, not the key.

One caution on provenance, carried over from the executor's report: `flask_mut2_i417ar2x/mutated_test.py` is unrelated leftover content (a `url_for`/subdomain routing script), and the executor found it actually has 22 lines rather than the 20 quoted upstream. It contains nothing about JSON tags and is not cited as evidence here.
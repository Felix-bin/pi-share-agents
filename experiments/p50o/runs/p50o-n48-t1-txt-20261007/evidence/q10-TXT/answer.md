# The dependency chain from `TagTuple.to_json` recursion — full answer

## Short answer

The infinite-recursion hazard is a **mutually recursive cycle between the dispatcher `TaggedJSONSerializer.tag` and the tag's conversion method `TagTuple.to_json`**, with `JSONTag.tag` (the only definition of `tag()`) in between:

```
TaggedJSONSerializer.tag  →  TagTuple.tag  (== JSONTag.tag)  →  TagTuple.to_json  →  TaggedJSONSerializer.tag  →  …
```

read from inside the tuple-to-JSON method, as the question asks:

```
TagTuple.to_json  →  TaggedJSONSerializer.tag  →  TagTuple.tag / JSONTag.tag  →  TagTuple.to_json  →  …
```

`TagTuple.to_json` calls `self.serializer.tag(item)` for **every** element with no visited-set / depth / `id()` guard anywhere; when an element leads back to the same tuple (which requires passing through a mutable container, because a tuple cannot contain itself), the same cycle re-enters with a strictly deeper frame each lap. Nothing about it is a local defect — it is inherent to the tag design — and the stdlib `json` circular-reference guard never gets a chance to fire because all of the tagging happens **before** any JSON encoder is entered.

---

## 1. The subject code, verbatim

All of the chain lives in `src/flask/json/tag.py`. Verbatim (lines 55–156, exactly as printed by `nl -ba src/flask/json/tag.py`):

```python
from ..json import dumps
from ..json import loads

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

Line numbers exactly as `nl -ba` printed them:

| Item | Line |
|---|---|
| `from ..json import dumps` / `loads` | 56 / 57 |
| `class JSONTag` | 60 |
| `__slots__ = ("serializer",)` | 63 |
| `check` / `to_json` / `to_python` stubs | 73 / 77 / 82 |
| **`def tag` (the only definition of `JSONTag.tag`)** | **87** |
| `return {self.key: self.to_json(value)}` | 90 |
| `class TagDict` | 93 |
| `TagDict.to_json` → `self.serializer.tag(value[key])` | 110 / 112 |
| `class PassDict` | 119 |
| `PassDict.to_json` → `{k: self.serializer.tag(v) ...}` | 125 / 128 |
| `PassDict.tag = to_json` | 130 |
| **`class TagTuple`** | **133** |
| `key = " t"` | 135 |
| `TagTuple.check` (`isinstance(value, tuple)`) | 137 |
| **`TagTuple.to_json` → `[self.serializer.tag(item) for item in value]`** | **140 / 141** |
| `TagTuple.to_python` | 143 |
| `class PassList` | 147 |
| `PassList.to_json` → `[self.serializer.tag(item) ...]` | 153 / 154 |
| `PassList.tag = to_json` | 156 |

Dispatcher and entry point, verbatim (lines 219–247, 289–295, 321–327):

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
```

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

    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

Line numbers: `class TaggedJSONSerializer` 219; `__slots__ = ("tags", "order")` **234**; `default_tags` 238, with `TagTuple` at **241** and `PassList` at **242**; `def tag` **289**; `for tag in self.order:` 291; `return tag.tag(value)` **293**; `return value` fallback **295**; `dumps` **321–323**; `loads` **325–327**.

The `dumps` that `tag.py` imports (line 56) is `src/flask/json/__init__.py`, lines 13–44 (note line 40–44):

```python
def dumps(obj: t.Any, **kwargs: t.Any) -> str:
    """Serialize data as JSON.

    If :data:`~flask.current_app` is available, it will use its
    :meth:`app.json.dumps() <flask.json.provider.JSONProvider.dumps>`
    method, otherwise it will use :func:`json.dumps`.

    :param obj: The data to serialize.
    :param kwargs: Arguments passed to the ``dumps`` implementation.
    ...
    """
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

It is **not** `DefaultJSONProvider.dumps` (`src/flask/json/provider.py:166`, body 176–179), which is only reached through the `current_app` branch:

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON to a string.
        ...
        """
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

---

## 2. The chain, hop by hop, with the resolution rule for each hop

1. **`TaggedJSONSerializer.dumps(value)` → `self.tag(value)`** — `tag.py:321-323`. Direct call: `return dumps(self.tag(value), separators=(",", ":"))`. Note the ordering: the whole value is tagged **first**, then handed to a JSON encoder.
2. **`TaggedJSONSerializer.tag(value)` → `tag.check(value)` for each registered tag instance** — `tag.py:289-295`. The dispatch loop is `for tag in self.order: if tag.check(value): return tag.tag(value)`. No memoization, no visited set. For a tuple: `TagDict.check` (a dict test) is `False`, `PassDict.check` (a dict test) is `False`, then `TagTuple.check` (`tag.py:137`, `isinstance(value, tuple)`) is `True`.
3. **`TagTuple.tag(value)` resolves to `JSONTag.tag`** — `TagTuple` does **not** define `tag` (unlike `PassDict`/`PassList`, which alias `tag = to_json` at lines 130 and 156), so normal MRO falls back to the base implementation at `tag.py:87`, whose body at line 90 is `return {self.key: self.to_json(value)}` — for `TagTuple` with `key = " t"` this yields `{" t": TagTuple.to_json(value)}`.
4. **`TagTuple.to_json(value)` → `self.serializer.tag(item)` for every element** — `tag.py:140-141`: `return [self.serializer.tag(item) for item in value]`. This is the "recursive type tagging method call **within** the tuple-to-JSON conversion method": it calls back into the dispatcher once per element.
5. **For every element that is again a tuple, hops 2–4 repeat** — the cycle is entered again, one frame deeper, with no state recording that the object has already been seen.

**Cycle:**
```
TaggedJSONSerializer.tag → TagTuple.tag (= JSONTag.tag) → TagTuple.to_json → TaggedJSONSerializer.tag → …
```
equivalently, from inside the conversion method:
```
TagTuple.to_json → TaggedJSONSerializer.tag → TagTuple.tag / JSONTag.tag → TagTuple.to_json → …
```

Runtime confirmation (full `sys.setprofile` trace of `flask.json.tag`, recursion limit lowered to 45 so the trace stays short) printed by the executor:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro7.py
RecursionError: maximum recursion depth exceeded
total flask.json.tag calls traced before RecursionError: 102
first 40 calls in order (one line = one call):
    1. TaggedJSONSerializer.dumps
    2. TaggedJSONSerializer.tag
    3. TagDict.check
    4. PassDict.check
    5. TagTuple.check
    6. JSONTag.tag
    7. TagTuple.to_json
    8. TaggedJSONSerializer.tag
    9. TagDict.check
   10. PassDict.check
   11. TagTuple.check
   12. PassList.check
   13. PassList.to_json
   14. TaggedJSONSerializer.tag
   15. TagDict.check
   16. PassDict.check
   17. TagTuple.check
   18. JSONTag.tag
   19. TagTuple.to_json
   20. TaggedJSONSerializer.tag
   21. TagDict.check
   22. PassDict.check
   23. TagTuple.check
   24. PassList.check
   25. PassList.to_json
   26. TaggedJSONSerializer.tag
   27. TagDict.check
   28. PassDict.check
   29. TagTuple.check
   30. JSONTag.tag
   31. TagTuple.to_json
   32. TaggedJSONSerializer.tag
   33. TagDict.check
   34. PassDict.check
   35. TagTuple.check
   36. PassList.check
   37. PassList.to_json
   38. TaggedJSONSerializer.tag
   39. TagDict.check
   40. PassDict.check
EXIT=0
```

Hops 5, 6/7, 13/19/25 are exactly steps 2–4 of the chain above, repeating every 6 calls. The MRO fallback in hop 3 was also verified at runtime:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro6.py
H1 order: ['TagDict', 'PassDict', 'TagTuple', 'PassList', 'TagBytes', 'TagMarkup', 'TagUUID', 'TagDateTime']
H2 tags keys: [' di', ' t', ' b', ' m', ' u', ' d']
H3 slots: ('tags', 'order') inst dict? False
H4 'tag' in TagTuple.__dict__? False
H5 'tag' in PassList.__dict__? True
H6 'tag' in PassDict.__dict__? True
H7 TagTuple.tag resolves to: JSONTag.tag
H8 TagTuple.tag is JSONTag.tag: True
H9 PassList.tag is PassList.to_json: True
H10 check TagDict.check((1, 2)) -> False
H10 check PassDict.check((1, 2)) -> False
H10 check TagTuple.check((1, 2)) -> True
H10 check PassList.check((1, 2)) -> False
H10 check TagBytes.check((1, 2)) -> False
H10 check TagMarkup.check((1, 2)) -> False
H10 check TagUUID.check((1, 2)) -> False
H10 check TagDateTime.check((1, 2)) -> False
H11 finite mixed tuple dumps -> {" t":[1,{" b":"/w=="},{" u":"7869d06df8274728865c87e37f03af37"},{" d":"Wed, 07 Oct 2026 07:12:46 GMT"},{" m":"<b>"}]}
H12 round-trip equal -> True
EXIT=0
```

`H4` = `TagTuple` does not define `tag`; `H7`/`H8` = it resolves to `JSONTag.tag`; `H1` = `TagTuple` precedes `PassList` in `default_tags`. The `RecursionError` traceback also shows the cycle literally, `tag.py:323 → 293 → 90 → 141 → 293 → 154 → 293 → 90 → 141 → …`:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro10.py
FINITE nested dumps -> {" t":[1,{" t":[{" t":[2,3]},[4,{" t":[5,6]}],{"k":{" t":[7,8]}}]}]}
FINITE round-trip equal -> True
FINITE depth-50 tuple dumps len -> 451
TRACEBACK total lines: 3002
---- first 25 ----
Traceback (most recent call last):
  File "C:\Users\oobbee\AppData\Local\Temp\repro10.py", line 24, in <module>
    s.dumps(t)
    ~~~~~~~^^^
  File "...\src\flask\json\tag.py", line 323, in dumps
    return dumps(self.tag(value), separators=(",", ":"))
                 ~~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 90, in tag
    return {self.key: self.to_json(value)}
                      ~~~~~~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 141, in to_json
    return [self.serializer.tag(item) for item in value]
            ~~~~~~~~~~~~~~~~~~~^^^^^^
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 154, in to_json
    return [self.serializer.tag(item) for item in value]
            ~~~~~~~~~~~~~~~~~~~^^^^^^
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
---- last 25 ----
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 90, in tag
    return {self.key: self.to_json(value)}
                      ~~~~~~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 141, in to_json
    return [self.serializer.tag(item) for item in value]
            ~~~~~~~~~~~~~~~~~~~^^^^^^
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 154, in to_json
    return [self.serializer.tag(item) for item in value]
            ~~~~~~~~~~~~~~~~~~~^^^^^^
  File "...\src\flask\json\tag.py", line 293, in tag
    return tag.tag(value)
           ~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 90, in tag
    return {self.key: self.to_json(value)}
                      ~~~~~~~~~~~~^^^^^^^
  File "...\src\flask\json\tag.py", line 141, in to_json
    return [self.serializer.tag(item) for item in value]
            ~~~~~~~~~~~~~~~~~~~^^^^^^
RecursionError: maximum recursion depth exceeded
EXIT=0
```

---

## 3. Where the cycle terminates — and the fact that nothing guards it

**Termination condition:** the cycle bottoms out only when an element fails **every** `check` in `self.order`. In that case `TaggedJSONSerializer.tag` falls through the loop to `tag.py:295` `return value` — this is the only termination path for plain scalars (`int`/`float`/`str`/`bool`/`None`, which fail all eight checks).

Other termination paths:

- `bytes`, `UUID`, `datetime`, `Markup` terminate **inside their own `to_json`** (they return `str`/`hex`/HTTP-date and never call `serializer.tag`). Verbatim, `tag.py:159-216`:
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

  class TagMarkup(JSONTag):
      ...
      def to_json(self, value: t.Any) -> t.Any:
          return str(value.__html__())

      def to_python(self, value: t.Any) -> t.Any:
          return Markup(value)

  class TagUUID(JSONTag):
      ...
      def to_json(self, value: t.Any) -> t.Any:
          return value.hex

      def to_python(self, value: t.Any) -> t.Any:
          return UUID(value)

  class TagDateTime(JSONTag):
      ...
      def to_json(self, value: t.Any) -> t.Any:
          return http_date(value)

      def to_python(self, value: t.Any) -> t.Any:
          return parse_date(value)
  ```
- `dict` and `list` **re-enter** the dispatcher: `PassDict.to_json` (`tag.py:125-128`) and `PassList.to_json` (`tag.py:153-154`) both do `self.serializer.tag(v)`. So they propagate the cycle rather than ending it. `TagDict.to_json` (`tag.py:110-112`) also re-enters.

**There is no guard anywhere in the chain.** `TaggedJSONSerializer.__slots__ = ("tags", "order")` (`tag.py:234`) — no visited set, no depth counter, no `id()`/seen field; `JSONTag.__slots__ = ("serializer",)` (`tag.py:63`); every concrete tag has `__slots__ = ()`. Confirmed by grep (exit status 1 = no matches):

```
$ grep -nEi "seen|visited|check_circular|memo|recursion|guard|depth" src/flask/json/tag.py
EXIT=1
```
```
$ grep -rn "check_circular" src/
EXIT=1
```
```
$ grep -rn "TaggedJSONSerializer\|serializer\.tag\|self\.serializer\.tag" src/
src/flask/json/tag.py:10:.. autoclass:: TaggedJSONSerializer
src/flask/json/tag.py:36:            return [[k, self.serializer.tag(v)] for k, v in iteritems(value)]
src/flask/json/tag.py:61:    """Base class for defining type tags for :class:`TaggedJSONSerializer`."""
src/flask/json/tag.py:69:    def __init__(self, serializer: TaggedJSONSerializer) -> None:
src/flask/json/tag.py:107:            and next(iter(value)) in self.serializer.tags
src/flask/json/tag.py:112:        return {f"{key}__": self.serializer.tag(value[key])}
src/flask/json/tag.py:128:        return {k: self.serializer.tag(v) for k, v in value.items()}
src/flask/json/tag.py:141:        return [self.serializer.tag(item) for item in value]
src/flask/json/tag.py:154:        return [self.serializer.tag(item) for item in value]
src/flask/json/tag.py:219:class TaggedJSONSerializer:
Binary file src/flask/json/__pycache__/tag.cpython-313.pyc matches
src/flask/sessions.py:14:from .json.tag import TaggedJSONSerializer
src/flask/sessions.py:287:session_json_serializer = TaggedJSONSerializer()
Binary file src/flask/__pycache__/sessions.cpython-313.pyc matches
```

(`tag.py:36` is inside the module docstring example, not live code.) So the only producers of the cycle are `tag.py` itself and its single production consumer `sessions.py`.

---

## 4. The circular case: why it needs a mutable container, and the smallest reproduction

A tuple is **immutable**, so it cannot be made to contain itself: you cannot name it while building it, and you cannot assign into it. Verified:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro1.py
A1 direct self-ref -> NameError : name 't' is not defined
A2 item assignment -> TypeError : 'tuple' object does not support item assignment
A3 tuple is immutable, cannot form t=(box,) then box->t without a mutable container
EXIT=0
```

Circularity therefore has to be routed through a mutable `list` (or `dict`) placed **inside** the tuple. The smallest reproduction:

```python
from flask.json.tag import TaggedJSONSerializer

box = []          # mutable container
t = (box,)        # tuple holds the list
box.append(t)     # list holds the tuple  →  t -> box -> t

TaggedJSONSerializer().dumps(t)   # RecursionError
```

Run:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro2.py
B0 structure: t id 1760269991408 box id 1760268804416 box[0] is t: True
B1 RecursionError: maximum recursion depth exceeded
EXIT=0
```

**Trace for this shape.** `tag(t)` → dispatch → `TagTuple.tag` → `JSONTag.tag` → `TagTuple.to_json(t)` iterates `[box]` and calls `tag(box)` → `PassList.check` is `True` → `PassList.tag` (the alias `tag = to_json`, line 156) iterates `[t]` and calls `tag(t)` → `TagTuple.tag` → `TagTuple.to_json` → `tag(box)` → … Every lap adds new, strictly deeper call frames and never revisits any "seen" object, so the interpreter raises `RecursionError: maximum recursion depth exceeded` — **not** `json`'s `ValueError: Circular reference detected`. The intermediate structure `t -> {" t": [{" t": [ ... ]}]}` grows without bound.

The same is true of a pure self-referential list (`l = []; l.append(l)`), which loops via `PassList.to_json → serializer.tag → PassList.tag → PassList.to_json`; the tuple is just the case named in the question:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro3.py
...
C1 TaggedJSONSerializer().dumps(circular list) -> RecursionError: maximum recursion depth exceeded
...
EXIT=0
```

**Realistic trigger through the session.** `src/flask/sessions.py` is the only production wiring:

- line 14: `from .json.tag import TaggedJSONSerializer`
- line 287: `session_json_serializer = TaggedJSONSerializer()`
- lines 311–314:
  ```python
      #: A python serializer for the payload.  The default is a compact
      #: JSON derived serializer with support for some extra Python types
      #: such as datetime objects or tuples.
      serializer = session_json_serializer
      session_class = SecureCookieSession
  ```
- `get_signing_serializer` (317–335) passes `serializer=self.serializer` into `URLSafeTimedSerializer`.
- line 387, in `save_session`: `val = self.get_signing_serializer(app).dumps(dict(session))  # type: ignore[union-attr]`

So the realistic entry point is `dict(session)` serialization; `itsdangerous` `Serializer.dump_payload`/`Serializer.dumps` (`.venv/Lib/site-packages/itsdangerous/serializer.py:273, 311`) forward straight into `TaggedJSONSerializer.dumps(obj)` with no extra kwargs:

```python
    def dump_payload(self, obj: t.Any) -> bytes:
        """Dumps the encoded object. The return value is always bytes.
        If the internal serializer returns text, the value will be
        encoded as UTF-8.
        """
        return want_bytes(self.serializer.dumps(obj, **self.serializer_kwargs))
```

Executed end-to-end:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro8.py
I1 RecursionError while saving session: maximum recursion depth exceeded
I2 finite tuple session status: 200 Set-Cookie present: True
I2 roundtrip session['k'] = (1, 2, 3)
EXIT=0
```

**Finite nesting is fine**, which is why the test suite never sees this:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro10.py
FINITE nested dumps -> {" t":[1,{" t":[{" t":[2,3]},[4,{" t":[5,6]}],{"k":{" t":[7,8]}}]}]}
FINITE round-trip equal -> True
FINITE depth-50 tuple dumps len -> 451
```
```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro9.py
G1 dumps((1,2,3)) -> {" t":[1,2,3]}
G2 loads roundtrip -> (1, 2, 3) <class 'tuple'>
G3 _untag_scan(circular list) -> RecursionError: maximum recursion depth exceeded
G4 dumps({'x': (1,2,3)}) -> {"x":{" t":[1,2,3]}}
EXIT=0
```

---

## 5. Why `json.dumps`' circular-reference check does not help

`TaggedJSONSerializer.dumps` (`tag.py:321-323`) evaluates `self.tag(value)` **first** and only then calls `dumps(...)`:

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

The unbounded recursion happens entirely inside `self.tag` — pure-Python list/dict comprehensions in `TagTuple.to_json` / `PassList.to_json` / `PassDict.to_json` — *before* any JSON encoder is entered. Python's `json.dumps` circular detection (`check_circular=True`, enabled by default, never overridden anywhere in Flask) only inspects containers the **encoder** recurses into, so it can never observe a cycle that the tag methods have already expanded forever. The encoder path that *would* run — `tag.py:dumps` → `flask/json/__init__.py:dumps` → `current_app.json.dumps` → `DefaultJSONProvider.dumps` → `json.dumps` — is never reached for the circular input.

Demonstrated by wrapping the `dumps` symbol that `tag.py` imported:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro4.py
J1 RecursionError: maximum recursion depth exceeded
J2 encoder_reached = False
   !! JSON encoder dumps() was reached with value: {' t': [1, 2, 3]}
J3 finite tuple dumps -> {" t":[1,2,3]}
J4 encoder_reached = True
EXIT=0
```

For the circular input the encoder is **never reached** (`J2 = False`); for a finite tuple it is reached once (`J4 = True`).

Contrast on the *same* circular object:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe /tmp/repro3.py
E1 json.dumps signature: (obj, *, skipkeys=False, ensure_ascii=True, check_circular=True, allow_nan=True, cls=None, indent=None, separators=None, default=None, sort_keys=False, **kw)
E2 json.dumps(circular list) -> ValueError: Circular reference detected
C1 TaggedJSONSerializer().dumps(circular list) -> RecursionError: maximum recursion depth exceeded
E3 json.dumps(circular list, check_circular=False) -> RecursionError: maximum recursion depth exceeded while encoding a JSON object
EXIT=0
```

`json.dumps` has `check_circular=True` by default and detects the cycle in a plain list, raising `ValueError: Circular reference detected`; the tag serializer recursing over the *same* object raises `RecursionError` in pure Python instead. (The literal `check_circular=True` default is a Python-documented stdlib default — `.venv/Lib/` here contains only `site-packages/`, no bundled CPython stdlib, so the encoder source itself is not quotable from inside the working directory. The behavior above is the runtime demonstration.)

**Note the asymmetry:** the decode direction does not have the same tuple cycle. `loads` → `_untag_scan` (`tag.py:309-319`) recurses only over `dict` and `list`, because tuples arrive from JSON as lists:

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

`_untag_scan` on a genuinely circular list also recurses unboundedly (`G3` above), but that is not the tuple-tag chain.

---

## 6. Scope: expected implementation, and the unrelated artifact

**No local defect.** `TagTuple.to_json` (`tag.py:140-141`) correctly maps each `item` through `self.serializer.tag`, and `default_tags` keeps `TagTuple` (line 241) ahead of `PassList` (line 242). The recursion is an inherent property of the tag design — a mutual recursion between `TaggedJSONSerializer.tag` and `TagTuple.to_json` with no visited-set guard — not a corrupted line.

**`flask_mut2_i417ar2x/mutated_test.py` is out of scope.** Full file:

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

It imports only `flask`, configures `subdomain_matching=False`/`SERVER_NAME`, and exercises `url_for` on a subdomain route. It touches none of `json/tag.py`, `json/provider.py` or `sessions.py`:

```
$ grep -nEi "tag|serializ|tuple|json|session|cookie" flask_mut2_i417ar2x/mutated_test.py
EXIT_grep=1
```

and when run it fails on an unrelated 404 routing assertion, not on tagging:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe flask_mut2_i417ar2x/mutated_test.py
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
Traceback (most recent call last):
  File "...\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: status 404
EXIT_mut=1
```

It must not be connected to the tuple-tag chain, and no part of this answer claims it triggers the recursion.

**Existing test coverage only has finite nesting**, which is why the suite is green. `tests/test_json_tag.py:12-29`:

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

`tests/test_basic.py:449-476` (`test_session_special_types`) is the realistic session entry point and is likewise finite:

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
        ...
```

`grep` for `recursion|RecursionError|circular|check_circular|Circular reference` across the worktree finds no hits in `src/` or `tests/` (only unrelated "circular import" notes in `CHANGES.rst`, `docs/`, `src/flask/cli.py:115`, `src/flask/ctx.py:420`). The full suite is green — a focused run of the serializer tests plus two full runs:

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests/test_json_tag.py -p no:cacheprovider
collected 14 items
tests\test_json_tag.py ..............                                    [100%]
============================= 14 passed in 0.07s ==============================
EXIT=0
```
```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests -p no:cacheprovider
collected 489 items
...
============================= 489 passed in 5.27s =============================
EXIT=0
```
```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests -vv -rA --tb=long -p no:cacheprovider
collecting ... collected 489 items
...
tests/test_json_tag.py::test_dump_load_unchanged[data0] PASSED           [ 74%]
... (all 489 PASSED, including test_json_tag.py::test_custom_tag, test_tag_order, test_session_special_types)
EXIT=0
```

(Environment caveat recorded by the executor: the repo-local `.venv` is a symlink whose `flask.pth` points at a different checkout, so every command above sets `PYTHONPATH="$PWD/src"`; the six subject files were `diff`-verified byte-identical to that mirror, and no source file was edited — `git status --short` shows only the pre-existing untracked `flask_mut2_i417ar2x/`.)

---

## 7. One-paragraph synthesis

Serializing a value through `TaggedJSONSerializer.dumps` (`src/flask/json/tag.py:321-323`) tags the value first: `self.tag(value)` runs the registry dispatch loop at `tag.py:289-295`, which for a tuple selects `TagTuple` (`tag.py:133-144`, `check` at 137) just ahead of `PassList` in `default_tags` (241 vs 242). `TagTuple` inherits `JSONTag.tag` (`tag.py:87-90`), so dispatch wraps the result as `{" t": TagTuple.to_json(value)}`; `TagTuple.to_json` (`tag.py:140-141`) then calls `self.serializer.tag(item)` for every element, re-entering the dispatch loop. That is the cycle `TagTuple.to_json → TaggedJSONSerializer.tag → TagTuple.tag (JSONTag.tag) → TagTuple.to_json`. It terminates only at `tag.py:295 return value` for elements that fail every `check` (plain scalars) or inside the non-recursive `to_json` of `TagBytes`/`TagMarkup`/`TagUUID`/`TagDateTime` (159–216), whereas `dict`/`list` continue the cycle (`PassDict.to_json` 125–128, `PassList.to_json` 153–154). No visited set, depth counter or `id()` guard exists — only `__slots__ = ("tags", "order")` (`tag.py:234`) and `("serializer",)` (`tag.py:63`). Circular input is only reachable through a mutable container because tuples are immutable (`t = (box,); box.append(t)`), and it always ends in `RecursionError`, never `json`'s `ValueError: Circular reference detected`, because all the recursion happens before any encoder is entered. The realistic trigger is the session cookie: `save_session` (`sessions.py:387`) serializes `dict(session)` via `URLSafeTimedSerializer` (`serializer = session_json_serializer`, `sessions.py:287, 311-314`) into this same tag serializer.
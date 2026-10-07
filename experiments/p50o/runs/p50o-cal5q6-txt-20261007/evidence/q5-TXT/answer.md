I have re-verified the source, the anchors, the entry point, the test file, the revision, and the executor artifacts directly. Here is the final answer.

---

# Dependency chain: recursive type-tagging calls inside tuple-to-JSON conversion that can recurse without bound on cyclic nested tuples

**Subject revision:** Flask `3.2.0.dev`, world at `C:/Users/oobbee/AppData/Local/Temp/pi-p50o/920457b8/q5-TXT/seal`. `.git/HEAD` reads, verbatim:

```
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
```

`pyproject.toml:3` `version = "3.2.0.dev"`. All of the behaviour below lives in a single file, `src/flask/json/tag.py`. The only production binding of the serializer is `session_json_serializer = TaggedJSONSerializer()` (`src/flask/sessions.py:287`), assigned to the cookie-session interface at `src/flask/sessions.py:314` (`serializer = session_json_serializer`).

---

## 1. Direct answer — the chain

The tuple-to-JSON conversion method is `TagTuple.to_json`. Its recursive call to the type-tagging dispatcher, `self.serializer.tag(item)` (`src/flask/json/tag.py:141`), is the entry into an unbounded mutual recursion when a tuple is reachable from one of its own elements through a mutable container:

```
TaggedJSONSerializer.dumps                      (tag.py:321-323)
  └─ self.tag(value)                            (tag.py:323)
       └─ TaggedJSONSerializer.tag              (tag.py:289-295)
            └─ first tag in self.order whose check(value) is True
                 for a tuple → TagTuple.check   (tag.py:137-139)
            └─ tag.tag(value)                   (tag.py:293)
                 └─ TagTuple defines NO `tag`; the lookup lands on
                    JSONTag.tag                     (tag.py:87-90)
                      └─ {self.key: self.to_json(value)}  → {" t": ...}   (tag.py:90)
                           └─ TagTuple.to_json                  (tag.py:140-141)
                                └─ [self.serializer.tag(item) for item in value]  (tag.py:141)
                                     └─ back to TaggedJSONSerializer.tag  ← RE-ENTRY on the item
```

If any element of the tuple — or any mutable container reachable from it — is the tuple itself, the dispatcher re-enters `TaggedJSONSerializer.tag` on the **same tuple object** and the chain becomes a closed mutual recursion:

```
TaggedJSONSerializer.tag → PassList.to_json → TaggedJSONSerializer.tag   (list cycle)
TaggedJSONSerializer.tag → PassDict.to_json → TaggedJSONSerializer.tag   (dict cycle)
```

and, interleaved with the tuple leg, the full repeating unit per traversal level is:

```
TaggedJSONSerializer.tag (tag.py:293) → JSONTag.tag (tag.py:90) → TagTuple.to_json (tag.py:141)
   → TaggedJSONSerializer.tag (tag.py:293) → PassList.to_json (tag.py:154) / PassDict.to_json (tag.py:128)
      → TaggedJSONSerializer.tag (tag.py:293) → …
```

There is **no memoisation of already-seen objects, no visited set, and no depth bound anywhere** in the tagging path, so each traversal re-enters the same two/three functions on the same object forever and the Python stack is exhausted → `RecursionError`. This is distinct from the stdlib encoder, which for the identical cyclic object raises `ValueError: Circular reference detected` (`json.dumps`'s `check_circular=True` default is still in force but never sees the cycle — see §4).

One-line form:

> `dumps` → `TaggedJSONSerializer.tag` (order loop) → `JSONTag.tag` → `TagTuple.to_json` → `[self.serializer.tag(item) …]` → **back to `TaggedJSONSerializer.tag`**, mutually with `PassList.to_json` / `PassDict.to_json` (or `TagDict.to_json` when a 1-key dict whose key is a registered tag is involved), with no memoisation or depth cap.

---

## 2. The exact code and its line anchors

Line numbers below are the ones I re-derived by reading `src/flask/json/tag.py` directly (the retriever's anchors had drifted: `JSONTag.tag` is 87-90, not 82-87; `TaggedJSONSerializer.tag` is 289-295, not 287-293; `dumps` is 321-323, not 322-324). The quoted text is byte-identical to the file.

### `TagTuple` — `src/flask/json/tag.py:133-144` (the method named by the question)

```python
class TagTuple(JSONTag):
    __slots__ = ()
    key = " t"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, tuple)

    def to_json(self, value: t.Any) -> t.Any:
        return [self.serializer.tag(item) for item in value]

    def to_python(self, value: t.Any) -> t.Any:
        return tuple(value)
```

Note what is **absent**: `TagTuple` defines `check` (137-139), `to_json` (140-141), `to_python` (143-144) and **no `tag` and no `tag = to_json` alias**. So when the dispatcher calls `tag.tag(value)` it binds to the inherited `JSONTag.tag`.

### `JSONTag` and its `tag` — `src/flask/json/tag.py:60-90` (the wrapper at 87-90)

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

This is the bridge that turns `TagTuple`'s bare list into the wrapped shape `{" t": [...]}`.

### `PassDict` — `src/flask/json/tag.py:119-130` (`tag = to_json` at line 130)

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

### `PassList` — `src/flask/json/tag.py:147-156` (`tag = to_json` at line 156)

```python
class PassList(JSONTag):
    __slots__ = ()

    def check(self, value: t.Any) -> bool:
        return isinstance(value, list)

    def to_json(self, value: t.Any) -> t.Any:
        return [self.serializer.tag(item) for item in value]

    tag = to_json
```

Both aliases point `tag` at `to_json`, so a list/dict emits a bare list/dict with no wrapper — unlike `TagTuple`, which needs the `JSONTag.tag` wrapper.

### `TagDict` — `src/flask/json/tag.py:93-116` (the hijacker; re-entry at line 112)

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

### The dispatcher and public methods — `src/flask/json/tag.py:219-326`

`default_tags` (order matters; `TagDict` is first), `src/flask/json/tag.py:238-247`:

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

`tag` — the dispatcher loop, `src/flask/json/tag.py:289-295`:

```python
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value
```

`untag` / `_untag_scan` — the load-side recursion (separate from the tagging path), `src/flask/json/tag.py:297-319`; the only two `recursively` comments in the file are lines 311 and 316:

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

`dumps` / `loads` — the entry point, `src/flask/json/tag.py:321-326`:

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))

    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

The `dumps` import at the top of the module is `from ..json import dumps` (`tag.py:55`), i.e. Flask's own `dumps`, not `json.dumps` directly — see §4.

Other registered keys, for completeness: `TagBytes` `" b"` (161), `TagMarkup` `" m"` (178), `TagUUID` `" u"` (193), `TagDateTime` `" d"` (207). `PassDict`/`PassList` carry `key = ""` and therefore never enter `self.tags` (registration at `tag.py:~258-271` only stores a tag when `key` is truthy). Thus `TagDict.check` fires only for single-key dicts whose key is one of `{" di", " t", " b", " m", " u", " d"}`.

---

## 3. Reproduction (raw executor output, verbatim)

### Environment precondition (mandatory: the `.venv` editable install points at a *different* worktree)

`.venv/Lib/site-packages/flask.pth`, verbatim single line:

```
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\f2f45b5b\q1-TXT\seal\src
```

That is a **different world directory** from `.../pi-p50o/920457b8/q5-TXT/seal`. A bare `.venv/Scripts/python.exe` therefore imports the foreign tree; every command below was run with `PYTHONPATH=<this world>\src`, and the executed bytecode was proven to come from this world:

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe -c "import flask, flask.json.tag as tg; print('flask.__file__ =', flask.__file__); print('tag.__file__ =', tg.__file__)"
flask.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\__init__.py
tag.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
TaggedJSONSerializer = <class 'flask.json.tag.TaggedJSONSerializer'>
EXIT=0
```

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe -c "from flask.json.tag import TaggedJSONSerializer, TagTuple, PassList; print('TaggedJSONSerializer.dumps  co_filename =', TaggedJSONSerializer.dumps.__code__.co_filename); print('TaggedJSONSerializer.tag    co_filename =', TaggedJSONSerializer.tag.__code__.co_filename); print('TagTuple.to_json            co_filename =', TagTuple.to_json.__code__.co_filename); print('PassList.to_json            co_filename =', PassList.to_json.__code__.co_filename); import flask.json.tag as m; print('module __file__ =', m.__file__)"
TaggedJSONSerializer.dumps  co_filename = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
TaggedJSONSerializer.tag    co_filename = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
TagTuple.to_json            co_filename = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
PassList.to_json            co_filename = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
module __file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\tag.py
module __cached__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\json\__pycache__\tag.cpython-313.pyc
EXIT=0
```

The **minimal constructor** of the failure (from `q5_repro.py`, confirmed present in the world):

```python
holder = []
t = (holder,)
holder.append(t)   # t is now reachable from its own element
```

### `q5_repro.py` — the plan's script, exact source

```python
import sys, traceback
from flask.json.tag import TaggedJSONSerializer
import flask, json
print("flask from:", flask.__file__)
s = TaggedJSONSerializer()

# control: acyclic nested tuples must succeed
print("control acyclic:", s.loads(s.dumps((1, (2, (3, 4))))))

# (a) cycle through a list
holder = []
t = (holder,)
holder.append(t)
print("cycle reachable from t:", t[0][0] is t)

# (b) cycle through a dict
d = {}
t2 = (d,)
d["x"] = t2
print("cycle reachable from t2:", t2[0]["x"] is t2)

# (c) self-referential list, for contrast (not tuple-specific)
a = []
a.append(a)

for name, obj in (("tuple<->list", t), ("tuple<->dict", t2), ("self-list", a)):
    sys.setrecursionlimit(120)
    try:
        s.dumps(obj)
        print(name, "-> NO ERROR (unexpected)")
    except RecursionError:
        frames = traceback.extract_tb(sys.exc_info()[2])
        names = [f"{f.name}:{f.lineno}" for f in frames]
        print(name, "-> RecursionError, frames =", len(frames))
        print("  first 6:", names[:6])
        print("  last 12 :", names[-12:])
    finally:
        sys.setrecursionlimit(1000)

# stdlib contrast: it DOES guard
try:
    json.dumps(a)
except ValueError as e:
    print("json.dumps cyclic list -> ValueError:", e)
```

Raw output:

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe q5_repro.py
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\__init__.py
control acyclic: (1, (2, (3, 4)))
cycle reachable from t: True
cycle reachable from t2: True
tuple<->list -> RecursionError, frames = 120
  first 6: ['<module>:29', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']
  last 12 : ['tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90', 'to_json:141']
tuple<->dict -> RecursionError, frames = 120
  first 6: ['<module>:29', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']
  last 12 : ['tag:90', 'to_json:141', 'tag:293', 'to_json:128', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:128', 'tag:293', 'tag:90', 'to_json:141']
self-list -> RecursionError, frames = 120
  first 6: ['<module>:29', 'dumps:323', 'tag:293', 'to_json:154', 'tag:293', 'to_json:154']
  last 12 : ['tag:293', 'to_json:154', 'tag:293', 'to_json:154', 'tag:293', 'to_json:154', 'tag:293', 'to_json:154', 'tag:293', 'to_json:154', 'tag:293', 'to_json:154']
json.dumps cyclic list -> ValueError: Circular reference detected
EXIT=0
```

Reading the frames against line anchors:

| frame | file:line | what it is |
|---|---|---|
| `dumps:323` | `tag.py:323` | `return dumps(self.tag(value), separators=(",", ":"))` |
| `tag:293` | `tag.py:293` | `return tag.tag(value)` — the dispatcher re-entry |
| `tag:90` | `tag.py:90` | `return {self.key: self.to_json(value)}` — `JSONTag.tag` |
| `to_json:141` | `tag.py:141` | `return [self.serializer.tag(item) for item in value]` — `TagTuple.to_json`, **the recursive tagging call** |
| `to_json:154` | `tag.py:154` | `return [self.serializer.tag(item) for item in value]` — `PassList.to_json` |
| `to_json:128` | `tag.py:128` | `return {k: self.serializer.tag(v) for k, v in value.items()}` — `PassDict.to_json` |

Both cyclic tuple cases show the exact repeating unit predicted: `tag:293 → tag:90 → to_json:141 → tag:293 → to_json:154`(or `:128`) `→ tag:293`. The self-referential list shows the degenerate 3-frame cycle `tag:293 → to_json:154 → tag:293`.

### `q5_extra.py` — depth vs. cycle discrimination and frame period (raw output)

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe q5_extra.py
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\__init__.py
sys.getrecursionlimit() default = 1000

=== A. acyclic deep nesting: finite recursion, only depth matters ===
  acyclic tuple nested    10 deep at default limit 1000 -> OK
  acyclic tuple nested   100 deep at default limit 1000 -> OK
  acyclic tuple nested   400 deep at default limit 1000 -> RecursionError
  acyclic tuple nested  1000 deep at default limit 1000 -> RecursionError
  acyclic tuple nested  2000 deep at default limit 1000 -> RecursionError

=== B. cyclic at the SAME nesting depth: unbounded, no depth can save it ===
  cycle at nesting   1 -> RecursionError
  cycle at nesting   2 -> RecursionError
  cycle at nesting  10 -> RecursionError

=== C. frame periodicity of the cycle (list / dict / TagDict-hijack) ===
  tuple<->list: total frames = 199
     prologue: ['cycle_frames:42', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']
     last 10 : ['to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90']
     detected period (frames per traversal level) = 5
  tuple<->dict: total frames = 199
     prologue: ['cycle_frames:42', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']
     last 10 : ['to_json:141', 'tag:293', 'to_json:128', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:128', 'tag:293', 'tag:90']
     detected period (frames per traversal level) = 5
  tuple<->1key-tagdict: total frames = 199
     prologue: ['cycle_frames:42', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']
     last 10 : ['tag:90', 'to_json:141', 'tag:293', 'tag:90', 'to_json:112', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'tag:90']
     detected period (frames per traversal level) = 6

=== D. same cyclic objects through stdlib json.dumps (guard fires) ===
  tuple<->list -> json.dumps: ValueError: Circular reference detected
  tuple<->dict -> json.dumps: ValueError: Circular reference detected
  tuple<->1key-tagdict -> json.dumps: ValueError: Circular reference detected

=== E. TaggedJSONSerializer.dumps passes only separators; check_circular unset ===
  dumps source: return dumps(self.tag(value), separators=(",", ":"))
  flask.json.dumps signature default kwargs: only 'default' injected when no current_app:
['        return current_app.json.dumps(obj, **kwargs)', '', '    kwargs.setdefault("default", _default)', '    return _json.dumps(obj, **kwargs)']

=== F. TagDict hijack demonstration (1-key dict whose key is a tag key) ===
  RecursionError frames: 120
  first 8: ['<module>:102', 'dumps:323', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'tag:90', 'to_json:112']
  last 10: ['tag:293', 'tag:90', 'to_json:141', 'tag:293', 'tag:90', 'to_json:112', 'tag:293', 'tag:90', 'to_json:141', 'tag:293']

=== G. load-side recursion also exists (_untag_scan) ===
  _untag_scan(2000-deep list): RecursionError (load-side, depth-driven, not cycle-driven)
EXIT=0
```

This is the decisive discrimination:

- **Acyclic nesting is finite-only.** 10 and 100 levels succeed at the default limit 1000; failure only appears at ~400+ levels. So a "deeply nested tuple" by itself fails *only* as a stack-depth limit.
- **A cycle is unbounded.** A tuple whose cycle sits at nesting depth **1** already raises `RecursionError`; no depth is safe. This cleanly separates (i) normal finite recursion per nesting level from (ii) unbounded recursion caused by the circular reference.
- **Frame period is fixed and measurable**, confirming a cycle rather than mere depth: period **5** for `tuple<->list` and `tuple<->dict`, **3** for a bare self-referential list, and **6** for the `TagDict` variant (frame `to_json:112`). The question's premise did not need one fixed period; I quote the actual names above.
- **`TagDict` hijack is real:** because `TagDict` precedes `PassDict` in `default_tags`, a single-key dict `{" t": <cycle>}` is dispatched to `TagDict.to_json` (`tag.py:112`, `self.serializer.tag(value[key])`) rather than `PassDict.to_json`.

### Production end-to-end path (`q5_session_repro.py`, raw output)

The failure is reachable through the real cookie-session save path, not just by calling `dumps` directly:

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe q5_session_repro.py
flask from: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\src\flask\__init__.py
session_interface: SecureCookieSessionInterface
serializer: flask.json.tag.TaggedJSONSerializer
is session_json_serializer: True
itsdangerous serializer_kwargs: {}

--- acyclic control through the real session save path ---
GET /acyclic -> 200

--- cyclic through the real session save path ---
GET /cyclic -> RecursionError, frames = 201
  first 12: ['<module>:39', 'get:1162', 'open:235', 'open:1116', 'run_wsgi_app:988', 'run_wsgi_app:1264', '__call__:1536', 'wsgi_app:1514', 'wsgi_app:1511', 'full_dispatch_request:920', 'finalize_request:941', 'process_response:1322']
  last 12 : ['tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90']
  tag.py frames only: ['dumps:316', 'dumps:323', 'tag:293', 'to_json:128', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154', 'tag:293', 'tag:90', 'to_json:141', 'tag:293', 'to_json:154']

--- where the tagging recursion sits in the save_session call chain ---
   \q5_session_repro.py:56 in <module>
   \.venv\Lib\site-packages\werkzeug\test.py:1162 in get
   \src\flask\testing.py:235 in open
   \.venv\Lib\site-packages\werkzeug\test.py:1116 in open
   \.venv\Lib\site-packages\werkzeug\test.py:988 in run_wsgi_app
   \.venv\Lib\site-packages\werkzeug\test.py:1264 in run_wsgi_app
   \src\flask\app.py:1536 in __call__
   \src\flask\app.py:1514 in wsgi_app
   \src\flask\app.py:1511 in wsgi_app
   \src\flask\app.py:920 in full_dispatch_request
   \src\flask\app.py:941 in finalize_request
   \src\flask\app.py:1322 in process_response
   \src\flask\sessions.py:387 in save_session
   \.venv\Lib\site-packages\itsdangerous\serializer.py:316 in dumps
   \.venv\Lib\site-packages\itsdangerous\url_safe.py:56 in dump_payload
   \.venv\Lib\site-packages\itsdangerous\serializer.py:278 in dump_payload
   \src\flask\json\tag.py:323 in dumps
   \src\flask\json\tag.py:293 in tag
   \src\flask\json\tag.py:128 in to_json
   \src\flask\json\tag.py:293 in tag
   \src\flask\json\tag.py:90 in tag
   \src\flask\json\tag.py:141 in to_json
   \src\flask\json\tag.py:293 in tag
   \src\flask\json\tag.py:154 in to_json
   \src\flask\json\tag.py:293 in tag
EXIT=0
```

So the complete production chain is unbroken:

```
flask/app.py:1322 process_response
  → flask/sessions.py:387 save_session   (val = self.get_signing_serializer(app).dumps(dict(session)))
  → itsdangerous/serializer.py:316 dumps
  → itsdangerous/url_safe.py:56 dump_payload
  → itsdangerous/serializer.py:278 dump_payload   (self.serializer.dumps(obj, **self.serializer_kwargs), kwargs == {})
  → flask/json/tag.py:323 TaggedJSONSerializer.dumps
  → tag.py:293 TaggedJSONSerializer.tag
  → tag.py:128 PassDict.to_json
  → tag.py:293 TaggedJSONSerializer.tag
  → tag.py:90  JSONTag.tag
  → tag.py:141 TagTuple.to_json          ← the tuple-to-JSON conversion method
  → tag.py:293 TaggedJSONSerializer.tag
  → tag.py:154 PassList.to_json
  → tag.py:293 … forever
```

`itsdangerous serializer_kwargs` is `{}`, so no extra keyword arguments ever reach `TaggedJSONSerializer.dumps`. The acyclic control returns HTTP 200 through the same path.

(The traceback's `dumps:316` frame is inside the `itsdangerous`→Flask `dumps` hop; the frames of interest are the `tag.py` ones. The executor notes that the first attempt let Flask's non-`TESTING` handler log the `RecursionError` as a 500 — setting `app.testing = True` gives the clean traceback above; this has no bearing on the finding.)

### Falsification checks (`inspect` / negative greps, raw output)

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe -c "
import inspect
from flask.json.tag import TaggedJSONSerializer, JSONTag, TagTuple, PassList, PassDict, TagDict
s = TaggedJSONSerializer()
print('--- CHECK 1: wrapper shape ---')
print('s.tag((1,2)) =', s.tag((1,2)))
print('s.tag([1,2]) =', s.tag([1,2]))
print('s.tag({1:2} if False else {\"a\":1}) =', s.tag({'a':1}))
print()
print('--- CHECK 2: dispatch order ---')
print([type(x).__name__ for x in s.order])
print()
print('--- CHECK 3: no guard ---')
src = open('src/flask/json/tag.py').read()
print('\"check_circular\" in tag.py source:', 'check_circular' in src)
for tok in ('visited','seen','memo','depth','setrecursionlimit','recursion'):
    print('  token %-18r in tag.py source: %s' % (tok, tok in src))
print()
print('--- inspect.getsource(TaggedJSONSerializer.tag) ---')
print(inspect.getsource(TaggedJSONSerializer.tag))
print('--- tag alias identity ---')
print('TagTuple.tag is JSONTag.tag:', TagTuple.tag is JSONTag.tag)
print('PassList.tag is PassList.to_json:', PassList.tag is PassList.to_json)
print('PassDict.tag is PassDict.to_json:', PassDict.tag is PassDict.to_json)
print('TagDict.tag is JSONTag.tag:', TagDict.tag is JSONTag.tag)
"
--- CHECK 1: wrapper shape ---
s.tag((1,2)) = {' t': [1, 2]}
s.tag([1,2]) = [1, 2]
s.tag({1:2} if False else {"a":1}) = {'a': 1}

--- CHECK 2: dispatch order ---
['TagDict', 'PassDict', 'TagTuple', 'PassList', 'TagBytes', 'TagMarkup', 'TagUUID', 'TagDateTime']

--- CHECK 3: no guard ---
"check_circular" in tag.py source: False
  token 'visited'          in tag.py source: False
  token 'seen'             in tag.py source: False
  token 'memo'             in tag.py source: False
  token 'depth'            in tag.py source: False
  token 'setrecursionlimit' in tag.py source: False
  token 'recursion'        in tag.py source: False

--- inspect.getsource(TaggedJSONSerializer.tag) ---
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value

--- tag alias identity ---
TagTuple.tag is JSONTag.tag: True
PassList.tag is PassList.to_json: True
PassDict.tag is PassDict.to_json: True
TagDict.tag is JSONTag.tag: True
EXIT=0
```

This confirms (1) the `JSONTag.tag` wrapper is what produces `{" t": [1, 2]}` for a tuple, while lists/dicts pass bare; (2) `TagTuple` is the tuple matcher and `TagDict` is checked first; (3) there is no guard of any kind. `TagTuple.tag is JSONTag.tag` is `True`, which is precisely why the tuple leg goes through the wrapper (and why each traversal level costs the extra `tag:90` frame).

---

## 4. Why the stdlib circular guard is bypassed

`TaggedJSONSerializer.dumps` (raw output again):

```
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

and the direct check of the stdlib default:

```
$ PYTHONPATH=<world>\src ./.venv/Scripts/python.exe -c "
import json, inspect
print('json.dumps signature:', inspect.signature(json.dumps))
a=[]; a.append(a)
print()
for cc in (True, False):
    try:
        json.dumps(a, check_circular=cc); print('  check_circular=%s -> no error' % cc)
    except ValueError as e:
        print('  check_circular=%s -> ValueError: %s' % (cc, e))
    except RecursionError as e:
        print('  check_circular=%s -> RecursionError: %s' % (cc, e))
print()
from flask.json.tag import TaggedJSONSerializer
print(inspect.getsource(TaggedJSONSerializer.dumps))
"
json.dumps signature: (obj, *, skipkeys=False, ensure_ascii=True, check_circular=True, allow_nan=True, cls=None, indent=None, separators=None, default=None, sort_keys=False, **kw)

  check_circular=True -> ValueError: Circular reference detected
  check_circular=False -> RecursionError: maximum recursion depth exceeded while encoding a JSON object

    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

`json.dumps`'s `check_circular` defaults to `True` and *does* raise `ValueError: Circular reference detected`. But `TaggedJSONSerializer.dumps` passes only `separators=(",", ":")`, and — crucially — it hands `json.dumps` **an object graph that has already been fully reified by `self.tag(value)`**. The cycle is consumed by Python recursion inside `tag()`/`to_json()` *before* the stdlib encoder ever sees a container. Hence:

- On the identical cyclic objects, `json.dumps(obj)` → `ValueError: Circular reference detected` (see §3, steps D), while `TaggedJSONSerializer.dumps(obj)` → `RecursionError`.
- `json.dumps(a, check_circular=False)` degrades to exactly `RecursionError: maximum recursion depth exceeded while encoding a JSON object` — the same class of failure the tagged path shows, which is what one would get if the guard were simply turned off.

Flask's own `dumps` does not re-enable or forward the guard either. `src/flask/json/__init__.py:40-44`:

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

`src/flask/json/provider.py:176-179` (`DefaultJSONProvider.dumps`, active when an app context exists):

```python
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

Neither path injects `check_circular`, and grep for `check_circular` across `src/flask/json/__init__.py`, `src/flask/json/provider.py` and `src/flask/sessions.py` returns no matches. `itsdangerous` adds nothing either (`serializer_kwargs == {}`).

---

## 5. Scope and qualifications

- **Where it bites.** The affected production entry point is the default cookie-session serializer: `session_json_serializer = TaggedJSONSerializer()` (`src/flask/sessions.py:287`), bound as `serializer = session_json_serializer` (`src/flask/sessions.py:314`) on `SecureCookieSessionInterface`, and invoked at `src/flask/sessions.py:387` (`val = self.get_signing_serializer(app).dumps(dict(session))`). Any session value that contains a tuple participating in a reference cycle triggers the failure on save. The same failure is reachable by calling `TaggedJSONSerializer.dumps` directly. No other implementation of tuple-to-JSON conversion exists in the world.
- **Cycles, not nesting, are what make it unbounded.** `TagTuple.to_json` recurses exactly once per nesting level, so an acyclic nested tuple terminates; the evidence shows 10- and 100-deep acyclic tuples succeed at the default limit of 1000 while a cycle at nesting depth 1 fails immediately (§3, steps A/B). Deep acyclic input can still exhaust the stack (≈400 levels here) — but that is a finite depth limit, not an unbounded recursion. On the load side, `_untag_scan` (`src/flask/json/tag.py:309-319`) recurses separately and is depth-driven only: a 2000-deep list raises `RecursionError` there too, but a cycle cannot be constructed in JSON input, so that path is not the circular-reference hazard (§3, step G).
- **No guard exists anywhere in the tagging path.** Direct evidence: `"check_circular" in tag.py source: False`; no `visited`, `seen`, `memo`, `depth`, `setrecursionlimit`, or `recursion` token in `src/flask/json/tag.py`; `inspect.getsource(TaggedJSONSerializer.tag)` shows the bare order loop. The two `# untag each item recursively` comments (lines 311, 316) are the only occurrences of "recursively" in the file and are on the load side.
- **`RecursionError` is a runtime stack-limit outcome, not a literal infinite loop.** `sys.getrecursionlimit()` default is 1000; the frame count equals whatever limit is set (120 when set to 120; 199/201 when set to 200). The recursion is genuinely unbounded in the input graph sense — it would never terminate on its own — but it is the interpreter's stack guard that stops it, so the observable outcome is `RecursionError`.
- **Existing tests are cycle-blind.** `tests/test_json_tag.py` (I re-read it in full) contains only the ten acyclic `test_dump_load_unchanged` parametrisations plus `test_duplicate_tag`, `test_custom_tag`, `test_tag_interface`, `test_tag_order`. Nothing constructs a cyclic tuple/list/dict. The whole suite is green: `tests/test_json_tag.py` → 14 passed; `tests/test_json.py` → 31 passed; full suite twice (normal `-q` and maximally verbose `-vv`) → **489 passed**, 0 failed / 0 error / 0 skipped, with `filterwarnings = ["error"]` in `pyproject.toml`. Raw verbose session head/tail:

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q5-TXT\seal
configfile: pyproject.toml
collecting ... collected 489 items
...
============================= 489 passed in 2.95s =============================
```

```
$ grep -oE "(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)" q5_pytest_vv_clean.txt | sort | uniq -c
    489 PASSED
```

So the behaviour is **untested, not regressed**. (The executor also found, incidentally, that the world ships stale `__pycache__` compiled from a foreign worktree — `pytest -vv` without `PYTHONPYCACHEPREFIX` prints misleading `<- D:\...\flask-src\tests\...` annotations; the verdict is identical either way, `489 passed`.)

- **Environment caveat on reproducibility.** The `.venv` editable install's `flask.pth` points at a different worktree, so any reproduction must set `PYTHONPATH` to this world's `src` (and ideally redirect the bytecode cache), or it will describe a different revision. The evidence above is all from this world's `src/flask/json/tag.py`, verified by `__file__` and `__code__.co_filename`.
- **Revision / working-tree state.** HEAD is `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (detached). Before the executor's work, `git status --porcelain` showed only `?? flask_mut2_i417ar2x/`; after, additionally the scratch untracked files `q5_repro.py`, `q5_extra.py`, `q5_session_repro.py`, `q5_pytest_vv.txt`, `q5_pytest_vv_clean.txt` — **no tracked file was modified**.

---

## 6. Explicit non-finding

The world also contains `flask_mut2_i417ar2x/mutated_test.py`. It exercises subdomain routing (`flask.Flask(__name__, subdomain_matching=False)`, `@app.route("/", subdomain="<company_id>")`, `flask.url_for`, `client.get`) and never imports or references `flask.json.tag`, `TaggedJSONSerializer`, `TagTuple`, or the session serializer. It is unrelated to this question and is **not** used as evidence here.

---

## Summary table

| Question part | Finding | Evidence |
|---|---|---|
| Which method recurses? | `TagTuple.to_json` → `self.serializer.tag(item)` (`tag.py:141`) | §2 code + `to_json:141` frames |
| What does it re-enter? | `TaggedJSONSerializer.tag` order loop (`tag.py:289-295`) | `tag:293` frames |
| Why the wrapper? | `TagTuple` has no `tag` → inherited `JSONTag.tag` (`tag.py:87-90`) | `s.tag((1,2)) = {' t': [1, 2]}`, `TagTuple.tag is JSONTag.tag: True` |
| What closes the cycle? | `PassList.to_json` (`:154`) / `PassDict.to_json` (`:128`) / `TagDict.to_json` (`:112`) re-entering `tag()` | frame periods 5/5/6 |
| Why unbounded? | no memo/visited/depth guard; `check_circular` absent | negative greps, `inspect.getsource` |
| Why isn't the stdlib guard hit? | `dumps(self.tag(value), …)` reifies the graph before `json.dumps` sees it | `json.dumps` → `ValueError`, tagged → `RecursionError` |
| Symptom | `RecursionError` (stack limit), not a literal infinite loop; `getrecursionlimit()` = 1000 | §3 raw output |
| Where in production? | `SecureCookieSessionInterface` cookie sessions via `session_json_serializer` | §3 session traceback |
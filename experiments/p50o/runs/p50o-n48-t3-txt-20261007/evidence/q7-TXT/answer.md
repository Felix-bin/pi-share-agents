# Where the list tag's item conversion meets the serializer's type dispatcher

## Direct answer

The interaction point is **`src/flask/json/tag.py`**, in the mutual recursion between two methods:

- **`PassList.to_json`** — the list serialization tag's per-item conversion method — at **`src/flask/json/tag.py:153-154`**, whose body is `return [self.serializer.tag(item) for item in value]`. This same method is aliased as the tag's dispatch entry point by `tag = to_json` at **`src/flask/json/tag.py:156`**.
- **`TaggedJSONSerializer.tag`** — the serializer's type dispatcher — at **`src/flask/json/tag.py:289-295`**, which walks `self.order`, tests each candidate with `tag.check(value)`, and calls `tag.tag(value)` (`src/flask/json/tag.py:291-293`).

The two are joined by the tag's back-reference `self.serializer` (set in `JSONTag.__init__`, `src/flask/json/tag.py:69-71`) plus the `tag = to_json` alias: the dispatcher calls `tag.tag(value)`, which for `PassList` *is* `to_json`, which calls back into `self.serializer.tag(item)`. The serializer→tag edge is `tag.tag(value)` at line 293; because of the alias that edge resolves straight back to line 154, so **every list element re-enters the dispatcher**, and any list nested inside a list/dict/tuple re-enters it again — unbounded recursion over mixed-type nested lists.

Exact line spans: **`PassList` = 147–156; dispatcher `tag` = 289–295 (loop 291, `check` 292, dispatch 293); `dumps` = 321–323; `loads` = 325–327.**

---

## 1. The list serialization tag: `PassList` (`src/flask/json/tag.py:147-156`)

```python
147  class PassList(JSONTag):
148      __slots__ = ()
149
150      def check(self, value: t.Any) -> bool:
151          return isinstance(value, list)
152
153      def to_json(self, value: t.Any) -> t.Any:
154          return [self.serializer.tag(item) for item in value]
155
156      tag = to_json
```

Points that matter, all visible in the text above:

- **Line 154 is the "item conversion method" body.** It calls *back into the serializer's dispatcher* once per element: `self.serializer.tag(item)`. That is the inward half of the interaction.
- **Line 156 is `tag = to_json`.** There is **no** `def tag` inside `PassList`; `PassList.tag` *is* `PassList.to_json`. So when the dispatcher calls `tag.tag(value)` (line 293), for a list it lands directly on line 154. A grep for `def tag` in this file returns only two hits — line 87 (`JSONTag.tag`, the inherited wrapper) and line 289 (the dispatcher) — which is why the per-item path is easy to misattribute:
  ```
  === grep -n 'def tag' in tag.py ===
  87:    def tag(self, value: t.Any) -> dict[str, t.Any]:
  289:    def tag(self, value: t.Any) -> t.Any:
  ```
- `PassList` declares **no `key`**, so it inherits `key: str = ""` from `JSONTag` (line 67). It is therefore appended to `self.order` but never registered in `self.tags` — it is an intermediate container converter that emits a plain JSON array of already-tagged items, never a `{" ": …}` wrapper.
- The received trace confirms this at runtime: `PassList.key = ''`, `PassList present in order?  True`, `PassList in tags?  False`, `PassList.tag is PassList.to_json?  True`.

---

## 2. The serializer's type dispatcher: `TaggedJSONSerializer.tag` (`src/flask/json/tag.py:289-295`)

```python
289      def tag(self, value: t.Any) -> t.Any:
290          """Convert a value to a tagged representation if necessary."""
291          for tag in self.order:
292              if tag.check(value):
293                  return tag.tag(value)
294
295          return value
```

This is the dispatch loop. The first tag in `self.order` whose `check(value)` is truthy converts the value via `tag.tag(value)` (line 293); values that match nothing fall through unchanged (line 295) — that is how plain `str`/`int`/`None` mixed into a list survive untouched. When `value` is a `list`, the matching tag is `PassList`, and `tag.tag(value)` resolves through the alias to `PassList.to_json` line 154 — closing the loop back into this dispatcher, once per element.

---

## 3. The base tag contract that makes the recursion possible: `JSONTag` (`src/flask/json/tag.py:60-90`)

```python
60   class JSONTag:
61       """Base class for defining type tags for :class:`TaggedJSONSerializer`."""
62
63       __slots__ = ("serializer",)
64
65       #: The tag to mark the serialized object with. If empty, this tag is
66       #: only used as an intermediate step during tagging.
67       key: str = ""
68
69       def __init__(self, serializer: TaggedJSONSerializer) -> None:
70           """Create a tagger for the given serializer."""
71           self.serializer = serializer
72
73       def check(self, value: t.Any) -> bool:
74           """Check if the given value should be tagged by this tag."""
75           raise NotImplementedError
76
77       def to_json(self, value: t.Any) -> t.Any:
78           """Convert the Python object to an object that is a valid JSON type.
79           The tag will be added later."""
80           raise NotImplementedError
81
82       def to_python(self, value: t.Any) -> t.Any:
83           """Convert the JSON representation back to the correct type. The tag
84           will already be removed."""
85           raise NotImplementedError
86
87       def tag(self, value: t.Any) -> dict[str, t.Any]:
88           """Convert the value to a valid JSON type and add the tag structure
89           around it."""
90           return {self.key: self.to_json(value)}
```

`self.serializer = serializer` (line 71) is the back-reference that lets `PassList.to_json`'s `self.serializer.tag(item)` (line 154) reach the dispatcher of §2. Note the **inherited** `JSONTag.tag` (lines 87-90) is a different code path: it wraps as `{self.key: self.to_json(value)}`. `PassList` deliberately overrides that wrapper with the `tag = to_json` alias, because with `key == ""` an empty-key wrapper would be wrong. `PassDict` does exactly the same (`tag = to_json`, `src/flask/json/tag.py:130`).

---

## 4. Why mixed types work: registration order and first-match-wins dispatch

`default_tags` and `register` (`src/flask/json/tag.py:236-287`):

```python
236      #: Tag classes to bind when creating the serializer. Other tags can be
237      #: added later using :meth:`~register`.
238      default_tags = [
239          TagDict,
240          PassDict,
241          TagTuple,
242          PassList,
243          TagBytes,
244          TagMarkup,
245          TagUUID,
246          TagDateTime,
247      ]
248
249      def __init__(self) -> None:
250          self.tags: dict[str, JSONTag] = {}
251          self.order: list[JSONTag] = []
252
253          for cls in self.default_tags:
254              self.register(cls)
255
256      def register(
257          self,
258          tag_class: type[JSONTag],
259          force: bool = False,
260          index: int | None = None,
261      ) -> None:
...
275          tag = tag_class(self)
276          key = tag.key
277
278          if key:
279              if not force and key in self.tags:
280                  raise KeyError(f"Tag '{key}' is already registered.")
281
282              self.tags[key] = tag
283
284          if index is None:
285              self.order.append(tag)
286          else:
287              self.order.insert(index, tag)
```

- The dispatch order is `TagDict, PassDict, TagTuple, PassList, TagBytes, TagMarkup, TagUUID, TagDateTime` — confirmed at runtime: `order = ['TagDict', 'PassDict', 'TagTuple', 'PassList', 'TagBytes', 'TagMarkup', 'TagUUID', 'TagDateTime']`.
- Because `TaggedJSONSerializer.tag` is **first-match-wins**, each element of a mixed list is re-dispatched independently: a `tuple` element is caught by `TagTuple` (key `" t"`), a `dict` element by `TagDict`/`PassDict`, `bytes` by `TagBytes` (key `" b"`), `Markup` by `TagMarkup` (key `" m"`), `UUID` by `TagUUID` (key `" u"`), and a plain `str`/`int` matches nothing and is returned unchanged by line 295.
- `register`'s `if key:` guard (line 278) is why `PassList` appears in `self.order` (line 285) but never in `self.tags` (line 282): `PassList.key == ""`. The runtime check confirms `PassList in tags?  False`.
- The sibling tuple tag shows the same per-item idiom but through the inherited wrapper, isolating the alias as `PassList`'s distinguishing feature:
  ```python
  133  class TagTuple(JSONTag):
  134      __slots__ = ()
  135      key = " t"
  136
  137      def check(self, value: t.Any) -> bool:
  138          return isinstance(value, tuple)
  139
  140      def to_json(self, value: t.Any) -> t.Any:
  141          return [self.serializer.tag(item) for item in value]
  142
  143      def to_python(self, value: t.Any) -> t.Any:
  144          return tuple(value)
  ```
  and the dict sibling, which also aliases the dispatcher:
  ```python
  121
  122      def check(self, value: t.Any) -> bool:
  123          return isinstance(value, dict)
  124
  125      def to_json(self, value: t.Any) -> t.Any:
  126          # JSON objects may only have string keys, so don't bother tagging the
  127          # key here.
  128          return {k: self.serializer.tag(v) for k, v in value.items()}
  129
  130      tag = to_json
  131
  ```
- Other per-item re-dispatch sites in the file (for completeness): `src/flask/json/tag.py:112` — `TagDict.to_json`: `return {f"{key}__": self.serializer.tag(value[key])}`; and the docstring example `src/flask/json/tag.py:36` — `TagOrderedDict.to_json`: `return [[k, self.serializer.tag(v)] for k, v in iteritems(value)]`.
- **No other method performs list item conversion.** The only `isinstance(…, list)` sites in `src/` are `PassList.check` (line 151) and `_untag_scan` (line 315); `PassList` occurs only at line 147 (class) and line 242 (`default_tags`).

---

## 5. The exact call chain

For input such as
`data = {"a": [(1, 2, 3), {"k": b"\xff"}, "plain", [uuid4(), Markup("<b>")]]}`

1. `TaggedJSONSerializer.dumps(data)` — `src/flask/json/tag.py:321-323`:
   ```python
   321      def dumps(self, value: t.Any) -> str:
   322          """Tag the value and dump it to a compact JSON string."""
   323          return dumps(self.tag(value), separators=(",", ":"))
   ```
   → calls `self.tag(value)` **once**.
2. `TaggedJSONSerializer.tag(data)` — line 289 → loop at 291 → first match is `PassDict` (since the top value is a `dict`; `PassDict.check` at 122-123, and `PassDict.to_json` at 125-128 re-dispatches each value).
3. The list value `data["a"]` re-enters `TaggedJSONSerializer.tag` — this time `PassList.check` (151) returns `True`.
4. Dispatcher line 293 executes `tag.tag(value)`; for `PassList` that is the alias at line 156, i.e. **`PassList.to_json` line 154**: `[self.serializer.tag(item) for item in value]`.
5. Each element re-enters step 2 independently: `(1,2,3)` → `TagTuple` → `{" t": [1,2,3]}` (each int re-enters and falls through unchanged); `{"k": b"\xff"}` → `PassDict` → bytes → `TagBytes` → `{" b": "/w=="}`; `"plain"` → no tag matches → returned as-is; the inner list → `PassList` again → its `UUID` → `{" u": …}` and `Markup` → `{" m": "<b>"}`.
6. Step 5's inner list means **`PassList.to_json` was entered a second time**, one level deeper — the recursion is unbounded in nesting depth.

Runtime trace of the dispatcher entries (`depth` = recursion level), instrumented on the same input:

```
tag() output: {'a': [{' t': [1, 2, 3]}, {'k': {' b': '/w=='}}, 'plain', [{' u': '0b27c906d8ab47db99de050428e74340'}, {' m': '<b>'}]]}

--- dispatcher entries (depth, incoming type, repr) ---
  depth=1  type=dict     value={'a': [(1, 2, 3), {'k': b'\xff'}, 'plain
  depth=2  type=list     value=[(1, 2, 3), {'k': b'\xff'}, 'plain', [UU
  depth=3  type=tuple    value=(1, 2, 3)
  depth=4  type=int      value=1
  depth=4  type=int      value=2
  depth=4  type=int      value=3
  depth=3  type=dict     value={'k': b'\xff'}
  depth=4  type=bytes    value=b'\xff'
  depth=3  type=str      value='plain'
  depth=3  type=list     value=[UUID('0b27c906-d8ab-47db-99de-050428e74
  depth=4  type=UUID     value=UUID('0b27c906-d8ab-47db-99de-050428e743
  depth=4  type=Markup   value=Markup('<b>')
```

The `depth=2`/`depth=3` list entries are `PassList.to_json` re-invoking `self.serializer.tag` once per element, exactly as line 154 says.

Round-trip confirmation (same run):

```
dumps -> {"a":[{" t":[1,2,3]},{"k":{" b":"/w=="}},"plain",[{" u":"0b27c906d8ab47db99de050428e74340"},{" m":"<b>"}]]}
loads -> {'a': [(1, 2, 3), {'k': b'\xff'}, 'plain', [UUID('0b27c906-d8ab-47db-99de-050428e74340'), Markup('<b>')]]}
round-trip equal (uuid normalized): True
uuid value identity preserved: True
Markup type regained: Markup
tuple type regained: tuple
bytes type regained: bytes
```

Unbounded nesting (`list → list → dict → tuple → list`):

```
dumps -> [[[{"x":{" t":[1,[{" b":"/w=="},{"y":{" t":[2,3]}}]]}}]]]
loads -> [[[{'x': (1, [b'\xff', {'y': (2, 3)}])}]]]
deep round-trip equal: True
type at depth:  <class 'list'> <class 'list'> <class 'list'> <class 'dict'>
```

---

## 6. The deserialization counterpart is asymmetric (why the *interaction* is on the way in only)

`untag`, `_untag_scan`, `dumps`, `loads` (`src/flask/json/tag.py:297-327`):

```python
297      def untag(self, value: dict[str, t.Any]) -> t.Any:
298          """Convert a tagged representation back to the original type."""
299          if len(value) != 1:
300              return value
301
302          key = next(iter(value))
303
304          if key not in self.tags:
305              return value
306
307          return self.tags[key].to_python(value[key])
308
309      def _untag_scan(self, value: t.Any) -> t.Any:
310          if isinstance(value, dict):
311              # untag each item recursively
312              value = {k: self._untag_scan(v) for k, v in value.items()}
313              # untag the dict itself
314              value = self.untag(value)
315          elif isinstance(value, list):
316              # untag each item recursively
317              value = [self._untag_scan(item) for item in value]
318
319          return value
320
321      def dumps(self, value: t.Any) -> str:
322          """Tag the value and dump it to a compact JSON string."""
323          return dumps(self.tag(value), separators=(",", ":"))
324
325      def loads(self, value: str) -> t.Any:
326          """Load data from a JSON string and deserialized any tagged objects."""
327          return self._untag_scan(loads(value))
```

- **Serialization direction:** `dumps` calls `self.tag(value)` **once** (line 323); after that, recursion is driven **per item** by each tag's own `to_json` — `TagDict` (112), `PassDict` (128), `TagTuple` (141), `PassList` (**154**) — always by calling `self.serializer.tag(item)`.
- **Deserialization direction:** `_untag_scan` itself recurses. A **dict** gets a per-item scan (312) **plus** a dict-only `self.untag(value)` unwrap (314); a **list** gets only a per-item scan (317) with **no** unwrap (correct, since `PassList` emitted no wrapper).

So: dispatch on the way in is per-item tag dispatch; dispatch on the way out is per-item scan plus a dict-only unwrap. Only the inward path involves the `PassList.to_json` ↔ `TaggedJSONSerializer.tag` interaction.

---

## 7. Supporting tests (intent for nested/mixed-type lists)

`tests/test_json_tag.py:1-29`:

```python
1   from datetime import datetime
2   from datetime import timezone
3   from uuid import uuid4
4
5   import pytest
6   from markupsafe import Markup
7
8   from flask.json.tag import JSONTag
9   from flask.json.tag import TaggedJSONSerializer
10
11
12  @pytest.mark.parametrize(
13      "data",
14      (
15          {" t": (1, 2, 3)},
16          {" t__": b"a"},
17          {" di": " di"},
18          {"x": (1, 2, 3), "y": 4},
19          (1, 2, 3),
20          [(1, 2, 3)],
21          b"\xff",
22          Markup("<html>"),
23          uuid4(),
24          datetime.now(tz=timezone.utc).replace(microsecond=0),
25      ),
26  )
27  def test_dump_load_unchanged(data):
28      s = TaggedJSONSerializer()
29      assert s.loads(s.dumps(data)) == data
```

Line 20 (`[(1, 2, 3)]`) is exactly the interaction: `PassList.to_json` → `self.serializer.tag(tuple)` → `TagTuple`. Line 18 (`{"x": (1, 2, 3), "y": 4}`) is a mixed dict. Line 24 normalizes `microsecond=0`, so correctness must be checked as `loads(dumps(x)) == x`, not by comparing raw `dumps` strings.

The custom-tag test exercises the same recursive re-entry via a user tag (`tests/test_json_tag.py:48-63`):

```python
48      class TagFoo(JSONTag):
49          __slots__ = ()
50          key = " f"
51
52          def check(self, value):
53              return isinstance(value, Foo)
54
55          def to_json(self, value):
56              return self.serializer.tag(value.data)
57
58          def to_python(self, value):
59              return Foo(value)
60
61      s = TaggedJSONSerializer()
62      s.register(TagFoo)
63      assert s.loads(s.dumps(Foo("bar"))).data == "bar"
```

Execution results from the full test suite (both normal and verbose runs, exit 0):

```
$ .venv/Scripts/python.exe -m pytest tests/test_json_tag.py
tests\test_json_tag.py ..............                                    [100%]
============================= 14 passed in 0.08s ==============================

$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider
tests\test_json_tag.py ..............                                    [ 77%]
...
============================= 489 passed in 5.91s =============================
```

```
collected 14 items
tests/test_json_tag.py::test_dump_load_unchanged[data0] ... PASSED [  7%]
tests/test_json_tag.py::test_dump_load_unchanged[data1] ... PASSED [ 14%]
tests/test_json_tag.py::test_dump_load_unchanged[data2] ... PASSED [ 21%]
tests/test_json_tag.py::test_dump_load_unchanged[data3] ... PASSED [ 28%]
tests/test_json_tag.py::test_dump_load_unchanged[data4] ... PASSED [ 35%]
tests/test_json_tag.py::test_dump_load_unchanged[data5] ... PASSED [ 42%]
tests/test_json_tag.py::test_dump_load_unchanged[\xff] ... PASSED [ 50%]
tests/test_json_tag.py::test_dump_load_unchanged[<html>] ... PASSED [ 57%]
tests/test_json_tag.py::test_dump_load_unchanged[data8] ... PASSED [ 64%]
tests/test_json_tag.py::test_dump_load_unchanged[data9] ... PASSED [ 71%]
tests/test_json_tag.py::test_duplicate_tag ... PASSED [ 78%]
tests/test_json_tag.py::test_custom_tag ... PASSED [ 85%]
tests/test_json_tag.py::test_tag_interface ... PASSED [ 92%]
tests/test_json_tag.py::test_tag_order ... PASSED [100%]
=========================== 14 passed in 0.08s ==============================
```

And the exact parametrization round-tripped by the auxiliary trace:

```
E. exact test-suite parametrization round-trips
  {' t': (1, 2, 3)}                                            -> True
  {' t__': b'a'}                                               -> True
  {' di': ' di'}                                               -> True
  {'x': (1, 2, 3), 'y': 4}                                     -> True
  (1, 2, 3)                                                    -> True
  [(1, 2, 3)]                                                  -> True
  b'\xff'                                                      -> True
  Markup('<html>')                                             -> True
  UUID('a121b909-0ad0-4dd5-9226-bf1943637aea')                 -> True
  datetime.datetime(2026, 10, 7, 6, 14, 4, tzinfo=datetime.timezone.utc) -> True
```

---

## 8. Who uses this serializer, and the explicit distractors

`src/flask/sessions.py` wires the tagged serializer into session cookies:

```python
14: from .json.tag import TaggedJSONSerializer
...
287: session_json_serializer = TaggedJSONSerializer()
...
314: serializer = session_json_serializer
```

`CHANGES.rst:878-879`:

```
878: -   Allow registering new tags with ``TaggedJSONSerializer`` to support
879:     storing other types in the session cookie. :pr:`2352`
```

Two files that must **not** be substituted for the answer:

- `flask_mut2_i417ar2x/mutated_test.py` — subdomain routing only (`subdomain="<company_id>"`, `url_for`, `client.get`); no serialization code.
- `src/flask/json/provider.py::_default` (`src/flask/json/provider.py:108-121`), the stdlib `json.dumps(default=…)` hook:
  ```python
  108: def _default(o: t.Any) -> t.Any:
  109:     if isinstance(o, date):
  110:         return http_date(o)
  112:     if isinstance(o, (decimal.Decimal, uuid.UUID)):
  113:         return str(o)
  115:     if dataclasses and dataclasses.is_dataclass(o):
  116:         return dataclasses.asdict(o)  # type: ignore[arg-type]
  118:     if hasattr(o, "__html__"):
  119:         return str(o.__html__())
  121:     raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")
  ```
  It has no list/item recursion and no tag dispatch. In `flask.json.dumps`, `_default` is only the *terminal* encoder applied after tagging, not a recursion site. (`docs/` contains no mention of `tag.py`/`TaggedJSONSerializer`, so there is no supplementary documentation to cite.)

---

## 9. Verdict summary

| Question part | Answer |
|---|---|
| File | `src/flask/json/tag.py` |
| List serialization tag | `PassList` (`:147-156`) |
| Item conversion method | `PassList.to_json` (`:153-154`): `return [self.serializer.tag(item) for item in value]` |
| Dispatch entry for that method | `tag = to_json` alias (`:156`) — there is no `def tag` in `PassList` |
| Serializer type dispatcher | `TaggedJSONSerializer.tag` (`:289-295`), loop `:291`, `check` `:292`, `tag.tag(value)` `:293`, fall-through `:295` |
| Interaction / recursion edge | `PassList.to_json` line 154 calls `self.serializer.tag(item)`; the dispatcher line 293 calls `tag.tag(value)`, which via the line-156 alias re-enters line 154 — mutual recursion |
| Why mixed types work | First-match-wins over `self.order` (`TagDict, PassDict, TagTuple, PassList, TagBytes, TagMarkup, TagUUID, TagDateTime`, `:238-247`) re-dispatches **each element independently**; non-matching scalars fall through `:295` unchanged |
| Why no wrapper appears around lists | `PassList.key` inherits `""` from `JSONTag` (`:67`), so `register`'s `if key:` (`:278`) keeps it in `order` but not `tags` |
| How deep does it go | Unbounded: `list` inside `list` inside `dict` inside `tuple` each re-enters the dispatcher (verified trace, depth=1…4) |
| Round-trip proof | `s.loads(s.dumps(data)) == data` for all 10 parametrizations of `tests/test_json_tag.py::test_dump_load_unchanged` (`:12-29`), plus a deep-nested `list → list → dict → tuple → list` case; full suite 489 passed |
| Excluded distractors | `flask_mut2_i417ar2x/mutated_test.py`; `src/flask/json/provider.py::_default` (`:108-121`) |
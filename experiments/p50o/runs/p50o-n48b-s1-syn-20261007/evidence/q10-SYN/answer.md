# Dependency chain from the recursive tagging calls in tuple-to-JSON conversion

**Answer.** The chain lives in `src/flask/json/tag.py` (line numbers grep-verified against this worktree). The re-entry edge that lets a circular reference loop forever is:

> **`TagTuple.to_json` (tag.py:141) → `TaggedJSONSerializer.tag` (tag.py:289)**

Full hop-by-hop dependency chain:

1. **Entry — `TaggedJSONSerializer.dumps`** (def `tag.py:321`); its single body statement is `return dumps(self.tag(value), separators=(",", ":"))` (`tag.py:323`). JSON `dumps` is imported at `tag.py:57`. The only call that can re-enter serialization is `self.tag(value)`.
2. **Dispatch — `TaggedJSONSerializer.tag`** (`tag.py:289`): `for tag in self.order:` (`291`) → `if tag.check(value):` (`292`) → `return tag.tag(value)` (`293`); non-special values fall through to `return value` (`295`).
3. **Tuple match.** `TagTuple.check` (`tag.py:137`) is `isinstance(value, tuple)` (`138`); `TagTuple`'s key is `" t"` (`135`). `TagTuple` is third in `default_tags` (`238`–`247`, after `TagDict`, `PassDict`), so a tuple reaches it through the `291`–`293` dispatch.
4. **Wrapper.** `TagTuple` does not override `tag`, so `tag.tag(value)` (`293`) hits the base `JSONTag.tag` (def `87`): `return {self.key: self.to_json(value)}` (`90`).
5. **Conversion.** `TagTuple.to_json` (def `140`): `return [self.serializer.tag(item) for item in value]` (`141`) — it calls `self.serializer.tag` once per tuple element.
6. **Re-entry.** Each `self.serializer.tag(item)` re-enters step 2 at `tag.py:289`, which can dispatch back to `TagTuple` again.

**How the cycle closes.** A tuple is immutable and cannot contain itself directly, so a circular reference must close through a mutable element — a `list` or `dict` inside the tuple that in turn references the tuple. Those elements re-enter `tag:289` through the sibling recursive calls:

- `PassList.to_json` (`tag.py:153`) → `[self.serializer.tag(item) for item in value]` (`154`), with `tag = to_json` (`156`)
- `PassDict.to_json` (`tag.py:125`) → `{k: self.serializer.tag(v) for k, v in value.items()}` (`128`), with `tag = to_json` (`130`)
- `TagDict.to_json` (`tag.py:110`) → `{f"{key}__": self.serializer.tag(value[key])}` (`112`)

So the repeating loop is:

`tag(289)` → dispatch(`291`–`293`) → base `tag(90)` → `TagTuple.to_json(141)` → `serializer.tag(289)` *[element is list/dict]* → dispatch → `PassList.to_json(154)` / `PassDict.to_json(128)` → `serializer.tag(289)` *[element is the tuple]* → dispatch → `TagTuple` → `141` → … with the identical nodes revisited every iteration.

**Why nothing stops it.** There is no guard: grep of `tag.py` for `seen|recursion|RecursionError|visited|setrecursionlimit|depth|memo|id(` returns **no matches**, and grep of `src/flask` for `setrecursionlimit` returns **none**. Neither `tag` (`289`–`295`) nor any `to_json` keeps a visited/id set or a depth counter, so the only bound is CPython's own recursion limit.

**Observed, not inferred** (executed against this worktree's `src` via `PYTHONPATH=src`):

```
x = []; t = (x,); x.append(t)
TaggedJSONSerializer().dumps(t)              -> RecursionError: maximum recursion depth exceeded

d = {}; t = (d,); d['self'] = t
TaggedJSONSerializer().dumps(t)              -> RecursionError: maximum recursion depth exceeded
```

Control non-cyclic cases serialize correctly (`dumps((1,(2,3)))` → `{" t":[1,{" t":[2,3]}]}`), so the failure is the cycle, not the environment.

**Which part of the task is answered, and which is open.** The chain requested — the tagging method calls reached from within the tuple-to-JSON conversion, their hop order, the re-entry edge `TagTuple.to_json:141 → TaggedJSONSerializer.tag:289`, the sibling re-entries that let the cycle return to that edge, and the absence of any terminating guard — is answered and confirmed by executed `RecursionError`. Still open: (a) whether such a circular structure can enter through real session data — the serializer was exercised directly only; the caller path `src/flask/sessions.py:387` (`val = self.get_signing_serializer(app).dumps(dict(session))`, with `session_json_serializer = TaggedJSONSerializer()` at `sessions.py:287`) shows where session data reaches `dumps`, but no cycle was constructed through it; (b) the mirrored load-side recursion `_untag_scan` (`tag.py:309`), which is also recursive but was not executed; (c) whether anything elsewhere in the worktree sets a recursion limit or tests this behaviour — only `tag.py` and `src/flask` were grepped.

**Line-number disagreement between the two sources, resolved.** The retriever cited `TagTuple.key` at `133` and `default_tags` at `236`; the executor cited `135` and `238` and flagged the discrepancy. Direct grep of `src/flask/json/tag.py` confirms **`135` and `238`**; the retriever's two numbers are off by two. All other line numbers in both reports agree with the file.

---

**Rests on:** grep-verified reads of `src/flask/json/tag.py` (nodes at `57`, `87`/`90`, `110`–`112`, `125`–`130`, `133`–`141`, `153`–`156`, `238`–`247`, `289`–`295`, `309`, `321`/`323`) and `src/flask/sessions.py` (`287`, `387`); the retriever's traced chain; the executor's executed `RecursionError` reproductions and control cases. Stored to shared memory as conclusion `b9afc71664be80` (source `src/flask/json/tag.py`).

**Remains open:** entry of such a cycle via real session data; the unexecuted load-side `_untag_scan` path; any recursion-limit or test coverage outside `tag.py`/`src/flask`.
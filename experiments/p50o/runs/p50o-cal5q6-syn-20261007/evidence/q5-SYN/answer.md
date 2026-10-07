# Dependency chain: circular tuple → infinite recursion in `TaggedJSONSerializer`

The chain is an unbounded round trip through the serializer's dispatcher. For a tuple `x` whose element (directly, or through a list/dict) is `x` itself, serialization runs:

```
TaggedJSONSerializer.dumps(x)                      tag.py:321-323
  └─ TaggedJSONSerializer.tag(value)               tag.py:322, :289-294
       └─ TagTuple.check(value) == True            tag.py:136-137   isinstance(value, tuple)
            └─ TagTuple.tag(value)                 tag.py:87-89     inherited JSONTag.tag
                 └─ {self.key: self.to_json(value)}  -> {" t": …}   tag.py:88
                      └─ TagTuple.to_json(value)   tag.py:140-141
                           └─ [self.serializer.tag(item) for item in value]   tag.py:141
                                └─ TaggedJSONSerializer.tag(item)  <-- re-entry on the same object
                                     └─ TagTuple.check(item) == True -> … (loop closes here)
```

The loop closes at the last arrow: `self.serializer.tag(item)` (tag.py:141) re-enters the exact entry point the trace started from (tag.py:289). For the circular case `item is value`, the dispatcher is entered on the identical object with no carried state, so every iteration repeats the same call with the same argument.

- **Unconditional re-entry point:** `TagTuple.to_json`, `return [self.serializer.tag(item) for item in value]` (tag.py:141) — it calls the serializer's dispatcher for every element of *any* tuple, with no filter.
- **The only test before re-entry:** `TagTuple.check`, `return isinstance(value, tuple)` (tag.py:137). A tuple stays a tuple, so this stays `True` for the same object indefinitely. `TagTuple` is third in `default_tags` (tag.py:242-251) after `TagDict`/`PassDict`, but tuples cannot match those, so a tuple always reaches this branch. Note that the recursion is *through the dispatcher*, not a self-call: `JSONTag.tag` itself (tag.py:87-89) is non-recursive; it is only the frame that wraps `to_json` as `{" t": …}`.
- **Failure mode:** Python `RecursionError` raised inside `dumps` (tag.py:323) once the interpreter's recursion limit is exhausted.
- **Mixed cycles close the same loop:** `PassList.to_json` (tag.py:153-154, aliased `tag = to_json` at :156), `PassDict.to_json` (tag.py:125-128, aliased at :130) and `TagDict.to_json` (tag.py:110-112) all end in `self.serializer.tag(...)` per element/key. A tuple → list/dict → same tuple cycle therefore re-enters `TaggedJSONSerializer.tag` unchanged; only the intermediate method name differs.

**No guard exists on that path.** A grep over `src/flask` for `\bid\(|\bseen\b|\bvisited\b|\bmemo\b|max_depth|RecursionError|setrecursionlimit|getrefcount` returns no matches (the only weakref uses are `app.py:7`, `app.py:271-273` to avoid an app reference cycle, and `json/provider.py:8,39` — none touch the serializer). Nothing tracks object identity across the recursion, and no depth limit or `RecursionError` handling is present. The one guard that exists, `TagDict.check` (tag.py:103-108), only distinguishes 1-item tag-keyed dicts from plain dicts and carries no traversal state.

**Why the test suite does not surface it.** `tests/test_json_tag.py::test_dump_load_unchanged` (lines 12-27) parametrizes only acyclic values — `(1, 2, 3)`, `[(1, 2, 3)]`, `{" t": (1, 2, 3)}`, `{"x": (1, 2, 3), "y": 4}`, plus non-container values. Every tuple there is a leaf tuple with non-tuple elements, and there is no self-referential or cyclic fixture anywhere in `tests/`, so the chain is reachable in principle but untested in this worktree.

**Deserialization note (not the asked path):** `_untag_scan` (tag.py:308-317) is recursive in the same shape (`{k: self._untag_scan(v) …}` for dicts, `[self._untag_scan(item) …]` for lists), but the question concerns the tagging/dump direction.

---

**What this rests on:** verbatim reads of `src/flask/json/tag.py` — `JSONTag.tag` (:87-89), `TagDict.check`/`to_json` (:103-112), `PassDict` (:125-130), `TagTuple` (:133-145), `PassList` (:149-156), `default_tags` (:242-251), `tag` (:289-294), `_untag_scan` (:308-317), `dumps` (:321-323); a grep over `src/flask` for identity/visited/depth/recursion tokens (no matches); the parametrize list at `tests/test_json_tag.py:12-27`. Line numbers were re-verified against the worktree and match the retriever's evidence.

**Still open / not established:**
- The `RecursionError` is an inference from the quoted code, not an observed run — the executor stage was skipped by the complexity gate and nothing was executed.
- Whether circular-reference input is reachable from any caller in this worktree (e.g. session/JSON-provider paths) was not traced.
- Whether the intended remedy (identity/visited set, depth cap, or rejecting cyclic input) is in scope is a design decision, not established by the evidence.
- The `flask/`-prefixed paths in the corpus (and `flask_mut2_i417ar2x/mutated_test.py`, a subdomain `url_for` test) are not a second copy of this serializer; the only subject files are `src/flask/json/tag.py` and `tests/test_json_tag.py`.
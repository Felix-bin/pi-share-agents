## Interaction point: `PassList.to_json` → `TaggedJSONSerializer.tag`, recursion by re-entry

**The call.** The list serialization tag is `PassList` (`src/flask/json/tag.py:147`), the tag whose `check` returns `isinstance(value, list)` (`:150-151`). Its item conversion method is `to_json` (`def` at `:153`), and the interaction line is **`:154`**:

```python
return [self.serializer.tag(item) for item in value]
```

`self.serializer.tag(item)` is `TaggedJSONSerializer.tag`, defined at **`:289`**:

```python
def tag(self, value: t.Any) -> t.Any:          # :289
    """Convert a value to a tagged representation if necessary."""
    for tag in self.order:                     # :291
        if tag.check(value):                   # :292
            return tag.tag(value)              # :293
    return value                               # :295
```

**So the two sides of the call are `src/flask/json/tag.py:154` (caller) and `src/flask/json/tag.py:289` (dispatcher).**

**How the loop resolves the list case.** `PassList` is registered in `default_tags` (`:238-247`, `PassList` at `:242`) and `__init__` registers each class (`:252-254`), so `register` appends it to `self.order` (`:285`; `:287` is the `index=` insert path). Nothing earlier in that order matches a Python list — `TagDict.check` (`:103-104`) requires a 1-item dict whose key is a registered tag, `PassDict.check` (`:122-123`) requires a dict, `TagTuple.check` (`:137-138`) requires a tuple — so for a nested list element the scan at `:291` reaches `PassList`, `PassList.check` matches at `:292`, and `:293` calls `tag.tag(value)`. For `PassList`, `tag` is not the base implementation but an alias: `tag = to_json` (`:156`), i.e. the same function object as `to_json` (`:153`). Control therefore returns to `:154`. **The recursive edge is `:154 → :289 → :291-:293 → :153/:154`**, one full `self.order` scan per nesting level, unbounded in depth. `_untag_scan` (`:307-317`) handles the reverse direction separately, with its own explicit dict and list branches rather than a tag method.

**Mixed types.** A list's elements are not assumed to be lists: each element is dispatched by the same scan from scratch, and the first tag whose `check` returns true wins (`:292-293`). A dict element is caught by `TagDict.check` (`:103-104`) or `PassDict.check` (`:122-123`), a tuple by `TagTuple.check` (`:137-138`), `bytes` by `TagBytes.check` (`:163-164`), Markup-like values by `TagMarkup.check` (`:181-182`), `UUID` by `TagUUID.check` (`:195-196`), `datetime` by `TagDateTime.check` (`:209-210`); an element that is itself a list re-matches `PassList` and recurses; elements that are plain JSON scalars (str, int, float, bool, None) match no tag and are returned unchanged by `:295`. That is the mechanism by which a mixed-element nested list is processed: per-element re-dispatch, with recursion only on the list elements.

**Which tag is meant by "list serialization tag."** Resolved to `PassList`, not `TagTuple`. `TagTuple` (`:133`) has a byte-identical body at `:140-141` and recurses the same way, but its `check` matches tuples (`:137-138`), it declares `key = " t"` (`:135`), and it does *not* alias `tag` — so it keeps the base `JSONTag.tag` (`:86-88`) that wraps the value as `{self.key: ...}`. `PassList`'s `check` is the one that fires for actual Python `list` values and for lists nested inside lists, and its `tag = to_json` alias (`:156`) means a list is serialized in place with no wrapping key. `PassList` is the reading the evidence supports; `TagTuple` remains the tag literally keyed `" t"`.

**Line-number discrepancy between the two handed-in stages.** The plan cited `check` at `:151-152`, `to_json` at `:154`, `tag = to_json` at `:157`, and `PassList` in `default_tags` at `~:243`. The retriever cited `check` `:150-151`, `to_json` `:153`, body `:154`, alias `:156`, `PassList` at `:243` in a `:239-248` `default_tags`. Direct reads of the worktree file confirm the retriever's call-site numbers and show `PassList` in `default_tags` at `:242` within `:238-247`; the plan's numbers are off by one in those places. The retriever's note that the shared corpus ranked the path with a `flask/` prefix while the worktree path is `src/flask/json/tag.py` is consistent with what the file shows.

**What is answered and what is open.** Answered: the exact interaction line (`:154`), the dispatcher it lands on (`:289`, scan `:291`, check `:292`, delegate `:293`), the re-entry path that produces recursion (`:156` alias back to `:153/:154`), and how mixed element types are routed by the same scan. Still open, on the evidence collected: no test was read or executed, so the recursion and the nested mixed-type round trip are established by code reading only — `tests/test_json_tag.py` was identified as the place a demonstrating test would be found, and it was not opened. Also not established from this evidence: any guarantee about which tag wins when a value satisfies more than one `check` beyond the plain "first match in `self.order`" behaviour at `:291-293` (the `register(..., index=...)` path at `:287` is the documented way to special-case that ordering).

### Rests on
- Direct reads of `src/flask/json/tag.py`: `PassList` `:147-156`, `TagTuple` `:133-144`, `JSONTag.check/tag` `:73-90`, all `check` predicates `:103-210`, `TaggedJSONSerializer`/`default_tags`/`register` `:219-287`, dispatcher `:289-295`, `_untag_scan` `:307-317`.
- The retriever's evidence block (all points independently confirmed against the file) and the planner's reading of "list tag" = `PassList`.
- No executor step was run: the plan classified the task as a read-only location/explanation question and the complexity gate skipped execution.

### Open
- No runtime or test confirmation of the recursion (nested mixed lists), and `tests/test_json_tag.py` was not opened.
- Ordering guarantee among overlapping `check` predicates is only stated as first-match-in-`self.order`.
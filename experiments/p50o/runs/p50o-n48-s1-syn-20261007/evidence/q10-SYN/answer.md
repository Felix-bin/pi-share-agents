## Dependency chain leading to infinite recursion

The recursion lives at `src/flask/json/tag.py:140-141`. The chain, from entry point back to itself, is an unbroken loop of method calls with no identity check anywhere:

| # | Caller | Edge | Callee |
|---|--------|------|--------|
| 1 | `TaggedJSONSerializer.dumps` (tag.py:321) | `return dumps(self.tag(value), separators=(",", ":"))` (tag.py:323) | `TaggedJSONSerializer.tag` |
| 2 | `TaggedJSONSerializer.tag` (tag.py:289) | `for tag in self.order: if tag.check(value): return tag.tag(value)` (tag.py:291-293), order = `default_tags` (tag.py:238-247) | `TagTuple.check` |
| 3 | `TagTuple.check` (tag.py:137) | `return isinstance(value, tuple)` (tag.py:138) | inherited `JSONTag.tag` |
| 4 | `JSONTag.tag` (tag.py:87) — `TagTuple` does not override `tag` | `return {self.key: self.to_json(value)}` (tag.py:90), `key = " t"` (tag.py:135) | `TagTuple.to_json` |
| 5 | `TagTuple.to_json` (tag.py:140) | `return [self.serializer.tag(item) for item in value]` (tag.py:141), one call per tuple element | `TaggedJSONSerializer.tag` — **back to step 2** |

Steps 2→5→2 are the cycle: every element of the tuple is re-submitted to the same dispatch hub, which can again select `TagTuple`. For a nested tuple (e.g. `((1, 2), 3)`) the chain recurses depth-first and then unwinds normally; nothing in the chain is a function of depth, so termination is purely structural.

### Why a circular reference makes it unbounded

A tuple is immutable, so a tuple cannot contain itself directly; a cycle has to be carried by a mutable container. Three tagging branches re-enter the same hub by the identical mechanism, so a list/dict that points back at the tuple keeps the cycle alive:

- `PassList.to_json` (tag.py:153) → `[self.serializer.tag(item) for item in value]` (tag.py:154), and `tag = to_json` (tag.py:156) so the branch is reached without the tagged-wrapper form.
- `PassDict.to_json` (tag.py:128) → `{k: self.serializer.tag(v) for k, v in value.items()}`, `tag = to_json` (tag.py:130).
- `TagDict.to_json` (tag.py:112) → `{f"{key}__": self.serializer.tag(value[key])}`.

So for `l = []; t = (l,); l.append(t)`, `dumps(t)` alternates `TagTuple.to_json` (tag.py:141) ↔ `PassList.to_json` (tag.py:154) forever: the tuple element is the list, and the list's element is the same tuple again. The chain reaches no base case; the only terminator is Python's default recursion limit, i.e. a `RecursionError`, not a graceful truncation.

### The missing guard

No method on this path records visited object identities:

- `TaggedJSONSerializer.__slots__ = ("tags", "order")` (tag.py:234) — no seen/visited set, and the instance carries no depth counter.
- Every re-entry point is a bare comprehension calling `self.serializer.tag` (tag.py:141, 154, 128, 112) with no identity check.
- A search of tag.py for `seen`, `visited`, `memo`, `id(`, `circular`, `RecursionError`, `stack`, `depth` returns nothing functional (only the substrings inside the tag keys/class names `" t"`, `Markup`), and the same search over `src/flask/json` returns no matches either.

Because `self.tag(value)` is the argument to the encoder call in tag.py:323, the recursion happens *before* the JSON encoder is invoked; the encoder's own circular-reference detection is never given the chance to fire. (Inference from the call structure at tag.py:323, not an observed document statement.)

For scope: `_untag_scan` (tag.py:309-317) recurses over dicts/lists with no guard either, but that is the `loads` path, and JSON text cannot itself encode a Python object cycle — it is not part of this serialize-time chain.

## What this rests on / what remains open

**Rests on:** `src/flask/json/tag.py`, read directly in this worktree — class/method definitions and bodies at lines 60, 87-90, 93-116, 119-130, 133-145, 147-156, 219, 234, 238-247, 289-293, 309-317, 321-325; plus empty grep results for any cycle guard in tag.py and in `src/flask/json`.

**Corrections made:** the `dumps` body is tag.py:323 (an earlier recorded chain had 324); planner citations for `dumps` were offset by several lines, and the retriever's 324 is likewise off by one. `default_tags` spans tag.py:238-247.

**Not established:** no test, comment, or issue text in this worktree asserts that nested tuples with a circular reference actually produce this behavior — the `RecursionError` outcome is inferred from code structure, not observed. That a cycle requires a mutable intermediary is inferred from the `isinstance` checks, not stated in a document. Also not asked and not decided here: whether a guard should be added or the recursion fixed.

**Recorded:** the chain above was stored as a shared conclusion for `src/flask/json/tag.py`, superseding the earlier copy whose only error was the tag.py:324 citation.
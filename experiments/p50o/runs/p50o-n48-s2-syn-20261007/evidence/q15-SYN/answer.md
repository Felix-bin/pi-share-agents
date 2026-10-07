## Where the interaction happens

The interaction is a single call expression: **`return [self.serializer.tag(item) for item in value]` at `src/flask/json/tag.py:154`**, the body of `PassList.to_json` (`def to_json` :153; the class-level alias `tag = to_json` :156). That one call per element is the only place the list serialization tag hands an item to the serializer's dispatcher.

`PassList` (:147) is the list tag because its `check` (:150) is `return isinstance(value, list)` (:151) — the only registered tag whose predicate tests `isinstance(value, list)`.

The dispatcher it calls is **`TaggedJSONSerializer.tag` (:289-295)**: `for tag in self.order:` (:291) → `if tag.check(value): return tag.tag(value)` (:292-293) → fall-through `return value` (:295). Line :294 is blank; the planner placed the fall-through at :294 and the retriever at :295 — direct read confirms :295, so the retriever's number is the correct one and the planner's is an off-by-one, not a substantive disagreement.

`order` is built from `default_tags` (:238-247), registered by `register` (:253), in the sequence `TagDict, PassDict, TagTuple, PassList, TagBytes, TagMarkup, TagUUID, TagDateTime` — `PassList` sits at position 4, after `PassDict` and `TagTuple`.

## How nested lists recurse

A nested list reaches :154 as `item`; `self.serializer.tag(item)` re-enters `tag` at :289; the :291 loop calls `PassList.check` (:150-151); `isinstance(value, list)` at :151 matches; the dispatcher returns `PassList.tag(value)` (:293), which resolves through the alias at :156 to `to_json` (:153-154) and re-descends into that sub-list's items. The cycle is therefore :154 → :289 → :291 → :150-151 → :293 → :156 → :153-154, with no depth limit other than the data.

## How mixed item types are dispatched

Each element is dispatched independently at :154 through the same :291 loop, and the first `check` that matches in `default_tags` order (:238-247) claims it — the dispatcher does not look at the surrounding list's type:

- dict element → `PassDict` (:119, `check` :122, `to_json` :125 with the item call at :128);
- tuple element → `TagTuple` (:133, `check` :137, `to_json` :140, item call :141, `key = " t"` :135), which — unlike `PassList` — does **not** alias `tag = to_json`, so the base `JSONTag.tag` (:87-90) wraps it as `{" t": [...]}`, whereas list and dict elements stay raw arrays/objects because of the aliases at :156 and :130;
- bytes / Markup / UUID / datetime → `TagBytes` (key :161, `to_json` :166), `TagMarkup` (:179, :184), `TagUUID` (:193, :198), `TagDateTime` (:207, :212), each wrapped by the base `JSONTag.tag` (:87-90);
- plain str/int/float/bool/None → fail every `check` and are returned untouched by the fall-through at :295.

Sibling caveat: `TagTuple.to_json` (:140-141) contains a byte-identical expression to :154, so the phrase "list serialization tag" could be misread as "the tag that emits a JSON array" — but `TagTuple`'s declared type is tuples (`key = " t"`, `to_python` returns `tuple(value)` :144) and it precedes `PassList` in the order, so `PassList.to_json` is the list tag. Test-level corroboration of the two-tag path exists in `tests/test_json_tag.py`: the parametrized case `[(1, 2, 3)]` (:20) exercises `PassList` → `TagTuple`, and `{"x": (1, 2, 3), "y": 4}` (:18) the mixed-dict case, both round-tripped by `test_dump_load_unchanged` (:27, assert :29).

## What this rests on

Grep-verified and directly re-read in this worktree: `src/flask/json/tag.py` :87-90, :125-130, :133-144, :147-156, :159-166, :191-212, :238-247, :253, :289-295, :309-319; `tests/test_json_tag.py` :14-29. A prior recalled memory on this same file agrees with the :154 location; the planner's :294/:155 numbering is the only conflicting detail and is superseded by direct read (:295/:156).

## Still open

- The phrases "list serialization tag" and "item conversion method" do not appear verbatim anywhere in the worktree; the mapping to `PassList.to_json` is an inference from `check`/`to_json` semantics, not a source label.
- Only the serialization path was audited. The deserialization analogue (`untag` :297, `_untag_scan` :309 with its `isinstance(value, list)` branch at :315) exists and is the mirror of this recursion, but whether the question intends to include it is not established.
- Nothing in the evidence implies a code change; the task reads as a location question, so no edit was made or planned.
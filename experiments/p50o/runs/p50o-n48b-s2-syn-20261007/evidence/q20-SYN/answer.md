## Where the base64 decode for byte-sequence tags is invoked

**It is invoked in `TaggedJSONSerializer.untag`, at the statement on line 307 of `src/flask/json/tag.py`:**

```python
307:         return self.tags[key].to_python(value[key])
```

When the incoming JSON object is a single-key dict and that key is `" b"`, this line calls `TagBytes.to_python`, whose body is the base64 decode:

```python
159: class TagBytes(JSONTag):
161:     key = " b"
169:     def to_python(self, value: t.Any) -> t.Any:
170:         return b64decode(value)
```

`b64decode` is imported at line 47 (`from base64 import b64decode`) and line 170 is its only call site anywhere in the tree, so the invocation site of the decode is line 307.

**The recursive chain after JSON parsing, hop by hop (all line numbers in `src/flask/json/tag.py` unless stated):**

1. `TaggedJSONSerializer.loads` (def line 325) — line 327: `return self._untag_scan(loads(value))`. The `loads` here is the module-level parser imported at line 57 (`from ..json import loads`), defined at `src/flask/json/__init__.py:77`; the JSON text is parsed first, and only then does the untagging pass begin.
2. `_untag_scan` (def line 309) — the dict branch recurses into every value at line 312 (`{k: self._untag_scan(v) for k, v in value.items()}`), then untags the dict node itself at line 314: `value = self.untag(value)`. The list branch recurses at line 317. Because the recursion at 312 runs before 314, a nested `{" b": "..."}` inside another object or list is still reached.
3. `untag` (def line 297) — line 299–300 returns the value unchanged if `len(value) != 1`; line 302 takes `key = next(iter(value))`; line 304–305 returns unchanged if the key is not a registered tag; otherwise line 307 dispatches.
4. `TagBytes.to_python` line 170 — `b64decode(value)` runs here.

**The dispatch is tag-key-based, not a hard-coded self-check.** `register` (def line 256) stores each tag instance under its own key, `self.tags[key] = tag` (line 282), so `self.tags[" b"]` is the `TagBytes` instance placed there via `default_tags`. Consequently `b64decode` fires only when the untagged object is a dict with exactly the single key `" b"`; a dict with any other key, or more than one key, returns from line 300 or 305 without reaching the decoder. The two guards are why the same line 307 serves all tags (e.g. `" d"` → `TagDateTime.to_python`, `" u"` → `TagUUID.to_python`) with the bytes decode selected purely by the key.

**Verification status:** the primitive, its owning class and key, the invocation statement and line (307), and every hop of the chain were re-checked directly against `src/flask/json/tag.py` in this worktree and match. One correction to the incoming material: the planner's line map (`_untag_scan` as lines 309–323 with the untag call at 320, `loads` at 325–326) is off by a few lines — the actual worktree has `_untag_scan` at 309–318 with the untag call at **314**, and `loads` at 325–327. The retriever's numbering (307, 314, 327, 170) matches the file; the method-level answer is unaffected by this discrepancy.

### What this rests on
- Direct reads of `src/flask/json/tag.py` (lines 150–219, 240–327) and `src/flask/json/__init__.py` (lines 70–87), plus `grep` for `b64decode` (only lines 47 and 170), for `def untag`/`_untag_scan`/`def loads`/`self.tags[key].to_python`/`key = " b"`, and for `self.tags[key] = tag`/`def register`.
- Retriever findings (handle 2fc64b9152e5) corroborating every hop; planner plan (handle 06d937305fee) agreeing on line 307 and differing on the recursive-pass line numbers as noted.

### Still open / caveats
- Nothing material is unresolved for the question as asked.
- The single-site claim is conditional on no other code registering a second tag whose `to_python` also calls `b64decode`; no such registration or second `b64decode` call exists in this tree (`grep` returned only lines 47 and 170). If app-level code registered one via `register(...)`, it would route through the identical line 307.
- Line numbers are revision-specific; the method-level statement (invocation inside `TaggedJSONSerializer.untag`, reached from `_untag_scan`'s dict branch during `loads`) is the durable answer if the file is renumbered.
- The sibling `flask_mut2_i417ar2x/mutated_test.py` is a `url_for`/subdomain test with no tag or base64 content and does not affect this location.
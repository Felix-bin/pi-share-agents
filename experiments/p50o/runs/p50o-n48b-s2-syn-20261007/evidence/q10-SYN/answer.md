# Why `PassDict.to_json` tags values but not keys

`PassDict.to_json` (src/flask/json/tag.py:125–128) is exactly this:

```python
def to_json(self, value: t.Any) -> t.Any:
    # JSON objects may only have string keys, so don't bother tagging the
    # key here.
    return {k: self.serializer.tag(v) for k, v in value.items()}

tag = to_json                                    # line 130
```

Keys are passed through untouched; only values go through `self.serializer.tag`. The class carries the reason inline at lines 126–127 — *"JSON objects may only have string keys, so don't bother tagging the key here"* — and that single stated reason decomposes into three coupled facts, two of which were confirmed by execution rather than by reading.

**1. A tagged key is structurally impossible, not merely pointless.** Every tag wrapper produced by this module is itself a dict: `JSONTag.tag` (tag.py:88–90) returns `{self.key: self.to_json(value)}`. A JSON object key must be a string, so a dict-shaped tag representation can never serve as one. The executor's run (`PYTHONPATH=src .venv/Scripts/python.exe`) shows both halves of this:

```
TaggedJSONSerializer.dumps({(1,2): 3}) -> TypeError: keys must be str, int, float, bool or None, not tuple
hash({" t": [1, 2]})                   -> TypeError: unhashable type: 'dict'
```

The traceback puts the failure in the encoder, not the tagger — `tag.py:323 dumps(self.tag(value), ...)` → `flask/json/__init__.py:44 return _json.dumps(obj, **kwargs)` → `json/encoder.py: TypeError`. So the tagger hands the key straight to `json.dumps`, which rejects it. Tagging the key would have produced `{(1,2): {" t": [...]}}` at best — still unEncodable, and the `{" t": ...}` payload is not even hashable and so cannot be a Python dict key at all. There is no string-keyed encoding of a tuple key available to this layer.

A nuance the same run exposes: `json.dumps({-1:'x', 3.5:'y', None:'z'})` succeeds, yielding `'{"-1": "x", "3.5": "y", "null": "z"}'`. Int/float/bool/None keys therefore survive by being coerced to strings by the encoder — a lossy pass-through outside `PassDict`'s doing. `PassDict`'s stance is to leave keys to the encoder entirely; the encoder accepts those scalars and hard-fails on tuple, bytes, frozenset, and arbitrary objects.

**2. The one real collision — a *string* key that looks like a tag — is handled by a different class, which renames keys rather than tagging them.** `TagDict` (tag.py:93–116) matches a one-item dict whose only key is in `serializer.tags`, then rewrites the key with a `__` suffix while tagging only the value; `to_python` strips the suffix on the way back. The executor confirmed the round trip:

```
TaggedJSONSerializer.dumps({" t": (1,2)}) -> '{" di":{" t__":{" t":[1,2]}}}'
TaggedJSONSerializer.loads(...)           -> {' t': (1, 2)}
```

So key disambiguation is done by suffixing (`__`), never by tagging. This is also why ordering matters: `PassDict.check` returns `True` for *any* dict (tag.py:122–123), so `TagDict` must run first — it does, in `default_tags` (tag.py:238–246), and `TaggedJSONSerializer.tag` returns on the first `check` match (tag.py:283–296). If `PassDict` came first, the collision machinery would never fire.

**3. Tagging keys would break the round trip, because untagging never walks keys.** `_untag_scan` (tag.py:300–310) does `{k: self._untag_scan(v) for k, v in value.items()}` and then untags the dict itself; keys are never passed through `_untag_scan`/`untag`. This is mirror-symmetric with `to_json` tagging only values. Any scheme that tagged a key would have no counterpart that restores it.

**Why it matters in practice:** `PassDict` is registered in the default tag set that backs the session serializer — `session_json_serializer = TaggedJSONSerializer()` (src/flask/sessions.py:287), used at sessions.py:387 (`dumps(dict(session))`) via the class attribute at line 314 and the signing serializer at line 330. A session dict carrying a non-string key therefore raises `TypeError` at serialization time rather than being silently converted (except for the scalar keys the encoder coerces).

**Test coverage:** tests/test_json_tag.py:16–29 pins the values-only behavior — parametrized round trips include `{"x": (1, 2, 3), "y": 4}` (tuple tagged in a value position), `{" t": (1, 2, 3)}` (collision via `TagDict`), and `{" t__": b"a"}`. No test round-trips or rejects a non-string dict key, and there is no negative test asserting the `TypeError`.

## What this rests on, and what is still open

Rests on: the code read directly at `src/flask/json/tag.py` (88–90, 93–116, 119–130, 238–246, 283–310, 321–323), `src/flask/json/__init__.py:44`, `src/flask/json/provider.py:179`, `src/flask/sessions.py:287/314/330/387`, `tests/test_json_tag.py:16–29`; and the executor's runtime transcript (`TaggedJSONSerializer.dumps`/`loads` on `{"k": (1,2)}`, `{" t": (1,2)}`, `{(1,2): 3}`; stdlib `json.dumps` on tuple/bytes/frozenset/object/int/float/None keys; `hash` on the tag payload). This agrees with the recalled memories on the same class; no contradiction found.

Still open: the rationale is documented *only* in the comment at tag.py:126–127 — no changelog entry, issue reference, or documentation page elaborates it, and a grep across the worktree for that phrasing matches nowhere else. And whether the behavior should change (e.g. reject non-string session keys earlier, or coerce them) is a product/API decision that the code does not settle.
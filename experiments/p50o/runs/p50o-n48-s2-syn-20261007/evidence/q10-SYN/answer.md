## Why `PassDict.to_json` tags only values, never keys

The pass-through dict tag is `PassDict` (`src/flask/json/tag.py:119-130`) — "pass-through" because it keeps the inherited empty `key` (`JSONTag.key: str = ""`, `tag.py:67`) and aliases `tag = to_json` (`tag.py:130`), so it never wraps the dict in the `{self.key: ...}` envelope that `JSONTag.tag` builds (`tag.py:90`); it only rewrites the dict's contents. Its conversion is:

```python
def to_json(self, value: t.Any) -> t.Any:
    # JSON objects may only have string keys, so don't bother tagging the
    # key here.
    return {k: self.serializer.tag(v) for k, v in value.items()}

tag = to_json
```
(`tag.py:125-130`; `check()` above it is just `isinstance(value, dict)`, `122-123`.)

Four constraints explain the asymmetry, all visible in this file:

**1. The stated reason is the inline comment (`tag.py:126-127`).** "JSON objects may only have string keys, so don't bother tagging the key here." Keys are already JSON-safe as they stand, so there is nothing for the tag machinery to convert on the key side; the comprehension on `tag.py:128` therefore passes only `v` through `self.serializer.tag(...)` and emits `k` literally.

**2. A tag's representation is itself a dict, so it cannot occupy key position.** `JSONTag.tag` returns `{self.key: self.to_json(value)}` (`tag.py:87-90`). Putting that in a key would require a JSON object key that is a JSON object, which the format does not allow. This is the concrete failure mode behind the comment's constraint — the file states the string-key constraint, but the failure mode itself is an inference from `tag.py:90`, not a quoted statement.

**3. The round trip is value-only, so tagged keys would never come back.** Deserialization mirrors the tagging side exactly: `_untag_scan` rebuilds dicts as `{k: self._untag_scan(v) for k, v in value.items()}` (`tag.py:312`) and only untags the dict itself (`tag.py:314`), while `untag` uses the key purely as a lookup and reads the value — `return self.tags[key].to_python(value[key])` (`tag.py:297-307`). No code path ever calls `_untag_scan` or `untag` on a key, so a tagged key would be un-decodable and would break the symmetry between `dumps`/`loads`.

**4. The one case where a key *could* be confused with a tag is already owned by another class.** `TagDict` (`tag.py:93-115`) matches a 1-item dict whose only key is a registered tag (`103-107`) and rewrites the key on the *value* side by suffixing it: `return {f"{key}__": self.serializer.tag(value[key])}` (`tag.py:111-112`). It is registered ahead of `PassDict` in `default_tags` (`TagDict, PassDict, ...`, `tag.py:238-247`), and `tag()` dispatches in registration order (`tag.py:289-294`). So the "key looks like a tag marker" ambiguity is peeled off before `PassDict` sees the dict — which is precisely why `PassDict` can leave ordinary keys untouched.

For contrast, `TagDict` is the other dict-handling tag class: it too tags only values (`tag.py:112`), but its whole purpose is disambiguation, whereas `PassDict` deliberately transforms nothing structural. Note also that nothing in `tag.py` — neither `PassDict` (`128`) nor `_untag_scan` (`312`) — handles non-string keys at all; whether such keys serialize is left to `json.dumps`, and `tests/test_json_tag.py` contains no test for them. The tests that touch this area are the round-trip cases `{" di": " di"}` and `{"x": (1, 2, 3), "y": 4}`; there is no `PassDict`-specific test.

### What this rests on, and what stays open

- Rests on: `src/flask/json/tag.py` — `PassDict` 119-130 (comment 126-127, comprehension 128, alias 130), `JSONTag.key = ""` 67 with its docstring 64-66, `JSONTag.tag` 87-90, `TagDict` 93-115 (check 103-107, `__`-suffix 112), `default_tags` 238-247, `tag()` 289-294, `untag` 297-307, `_untag_scan` 309-319; `tests/test_json_tag.py` round-trip parameters; `src/flask/sessions.py:287` where `TaggedJSONSerializer()` is instantiated for the session cookie.
- Answered: why only values are recursively tagged — the source's own string-key comment, plus the value-only decode path and `TagDict` precedence shown above.
- Still open / not established: no changelog, doc, or test in this worktree gives a rationale beyond the two-line comment at `tag.py:126-127`; the "a dict cannot be a JSON key" failure mode is inferred from `tag.py:90` rather than quoted; behavior for non-string keys is outside `tag.py` and untested here. Line ranges for `untag` differ slightly between the retrieved report (294-304) and this verification (297-307) — the code content is identical and the verified numbers are used above.
# How `TagBytes` keeps base64 binary encoding consistent and reversible

`TagBytes` (`src/flask/json/tag.py:159-170`) makes bytes survive the JSON round trip by pairing a type-predicate with the standard-library base64 codec, and by relying on the serializer's guarded tag envelope so nothing else in the data is mistaken for encoded bytes.

**The class itself — one method per direction.**
```python
class TagBytes(JSONTag):
    __slots__ = ()
    key = " b"
    def check(self, value):     return isinstance(value, bytes)
    def to_json(self, value):   return b64encode(value).decode("ascii")
    def to_python(self, value): return b64decode(value)
```
`check` is what makes tagging selective — only `bytes` (not `str`, not `bytearray`) enters this path. `to_json` encodes to base64 and immediately decodes the result to ASCII text, so the JSON layer only ever sees an ASCII `str`; `to_python` calls the inverse. Both names come from the same import block (`from base64 import b64decode` / `b64encode`, lines 47-48), so the forward and reverse transforms are a matched pair, not two hand-rolled schemes.

**Envelope and ordering.** `JSONTag.tag` (lines 87-91) wraps the transformed value as `{self.key: self.to_json(value)}`, so `b"\xff"` becomes `{" b": "/w=="}` before JSON serialization. `TaggedJSONSerializer.tag` (lines 289-296) walks `self.order` and applies the first tag whose `check` passes; `TagBytes` sits fifth in `default_tags` (lines 235-246), after `TagDict`, `PassDict`, `TagTuple`, `PassList` — dicts, tuples and lists are handled before bytes.

**Why it is consistent — the strip side is guarded, and collisions are escaped.** `untag` (lines 297-306) only reverses a dict that has *exactly one* key *and* that key is a registered tag:
```python
if len(value) != 1:            return value
key = next(iter(value))
if key not in self.tags:       return value
return self.tags[key].to_python(value[key])
```
So a user value that merely looks like the tag is not decoded as bytes. `TagDict` (key `" di"`) exists precisely to escape that case: an ordinary dict `{" b": "a"}` gets its colliding key suffixed to `" b__"` and is restored as a dict. `_untag_scan` (308-318) applies `untag` recursively to dict values and list items, so nested bytes are recovered too. `dumps`/`loads` (321-327) are the thin public path: `dumps(self.tag(value), separators=(",", ":"))` and `self._untag_scan(loads(value))`.

**Why it is reversible — base64 is ASCII-only and bijective.** Every octet string maps to a string over `+/0-9A-Za-z=` (measured over `bytes(range(256))`), so JSON string escaping never rewrites the payload, and decoding is exact for every byte value including non-UTF-8 ones. Two independent checks confirm this, not just the static reading:

- The repository's own test `tests/test_json_tag.py::test_dump_load_unchanged` (def at line 27, `assert s.loads(s.dumps(data)) == data`) is parametrized with `{" t__": b"a"}` (line 16) and raw `b"\xff"` (line 21, not valid UTF-8). Executed with this worktree's `src/` on the path: **10/10 parametrizations passed, exit status 0** (Python 3.13.9, pytest 8.4.0).
- A probe over `TaggedJSONSerializer` showed `b"\xff"` → `{" b":"/w=="}`, `bytes(range(256))` → a single 344-character base64 string, and bytes nested in list/tuple/dict round-tripping `==` **and** type-preserving in all 14 cases. Look-alike inputs stayed what they were: the string `" b"` came back `str`, `{" b": "a"}` and `{" b": b"x"}` came back `dict` (as `{" di":{" b__":...}}` on the wire), and a non-tag single-key dict `{"zz": b"a"}` stayed a dict with its value tagged.

**Measured limits of the guarantee.** Only `bytes` qualifies: `check()` returns no tag for `bytearray` and `memoryview`, and those instead raise `TypeError: Object of type bytearray is not JSON serializable` out of `json.dumps` rather than round-tripping. On the decode side, `b64decode` is called without `validate`, so it is lenient (`'!!!!'` → `b''`, stray characters ignored) while malformed padding raises `binascii.Error: Incorrect padding`. The worktree was unmodified versus `HEAD 85c5d93c`, so the passing result is not explained by a local edit.

## What this rests on

- `src/flask/json/tag.py`: `TagBytes` 159-170; imports 47-48; `JSONTag.tag` 87-91; `default_tags` 235-246; `TaggedJSONSerializer.tag`/`untag`/`_untag_scan`/`dumps`/`loads` 289-327 (re-read directly).
- `tests/test_json_tag.py`: parametrization 9-25 (`b"\xff"` line 21, `{" t__": b"a"}` line 16), `test_dump_load_unchanged` line 27.
- Executed results: 10/10 test parametrizations pass (exit 0) and the 14-case probe table, both run with `PYTHONPATH=src` because the repo `.venv` has an editable `flask.pth` pointing at a different worktree.

## Still open / caveats

- Nothing was executed against the `itsdangerous` signing or session layer that consumes this serializer; the reversibility claim is scoped to `TaggedJSONSerializer` itself.
- `b64decode` strictness/padding behavior is characterized only by the probed inputs above, not exhaustively.
- A path discrepancy in the retrieval ranking: it listed `flask/src/flask/json/tag.py` and `flask/tests/test_json_tag.py`, but in this worktree the repository root is already the checkout, so the files are at `src/flask/json/tag.py` and `tests/test_json_tag.py`; the `flask/` prefix does not resolve.
- `flask_mut2_i417ar2x/mutated_test.py` is present as an untracked artifact but tests `url_for`/subdomains and carries no `TagBytes` or base64 content, so it contributes no evidence either way.
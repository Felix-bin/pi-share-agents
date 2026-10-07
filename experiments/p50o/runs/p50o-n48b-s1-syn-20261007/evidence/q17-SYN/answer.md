# How the bytes-handling tag preserves consistency and reversibility

The class is `TagBytes` in `src/flask/json/tag.py:159-170`, registered under the one-character key `" b"`. Reversibility is produced by three cooperating pieces: a base64 encode/decode pair, a single-key JSON envelope that marks the value as bytes rather than text, and a decode-side guard plus namespace-escape rule that decide when that envelope may be interpreted.

**1. The encode/decode pair is the reversibility mechanism.**

```
159: class TagBytes(JSONTag)
161:     key = " b"
163-164: def check(self, value): return isinstance(value, bytes)
166-167: def to_json(self, value): return b64encode(value).decode("ascii")
169-170: def to_python(self, value): return b64decode(value)
```

(imports at `47-48`: `from base64 import b64decode` / `b64encode`). `to_json` base64-encodes the raw bytes and then ASCII-decodes the result, so the intermediate handed to JSON is a plain `str` containing only base64 alphabet characters (`A–Z a–z 0–9 + /` and `=` padding) — legal in JSON and free of any byte/character-set ambiguity. `to_python` reverses exactly that: base64-decode text back to bytes. Because base64 is a bytes↔ASCII bijection and its padding is determined by input length, the round trip is byte-exact even though the value passes through text. The executed checks confirm this directly for the padding cases and non-text bytes:

| payload | dumped | loaded | `== p` | `type is bytes` |
|---|---|---|---|---|
| `b""` | `{" b":""}` | `b''` | True | True |
| `b"\x00\xff"` | `{" b":"AP8="}` | `b'\x00\xff'` | True | True |
| `b"abc"` (no pad) | `{" b":"YWJj"}` | `b'abc'` | True | True |
| `b"abcdef"` (no pad) | `{" b":"YWJjZGVm"}` | `b'abcdef'` | True | True |
| `b"a"` (`==`) | `{" b":"YQ=="}` | `b'a'` | True | True |
| `b"ab"` (`=`) | `{" b":"YWI="}` | `b'ab'` | True | True |
| `b"abcd"` (`==`) | `{" b":"YWJjZA=="}` | `b'abcd'` | True | True |

**2. The envelope makes the base64 string self-describing.**

`JSONTag.tag` (`86-90`) wraps the encoded payload: `return {self.key: self.to_json(value)}`. So `b"\x00\xff"` becomes the ordinary JSON object `{" b": "AP8="}` rather than a bare string — bytes and a `str` that merely looks like base64 can never be confused on the way back. On load, `TaggedJSONSerializer.untag` (`299-307`) converts a dict back to bytes only when `len(value) == 1` **and** the sole key is registered in `self.tags`; it then calls `self.tags[key].to_python(value[key])`, i.e. `b64decode` for `" b"`. `_untag_scan` (`309-317`) recurses into dict values and list items *before* untagging the container, so bytes nested inside dicts/lists/other tagged values are restored bottom-up. `dumps`/`loads` (`320-327`) are the public wrappers: `dumps(self.tag(value), separators=(",", ":"))` and `self._untag_scan(loads(value))`. `TagBytes` is registered in both `self.tags` (under `" b"`) and `self.order` by `register` (`267-287`) via `default_tags` (`238-248`).

**3. A real dict cannot be mistaken for the bytes envelope.**

`TagDict` (`93-118`, `key = " di"`) fires when a dict has exactly one item and that item's key is a registered tag key, and rewrites it to `{f"{key}__": serializer.tag(value[key])}`; `to_python` (`114-116`) strips the `__` suffix back off. Since `TagDict` is first in `default_tags`, it wins the `check()` scan before `TagBytes` or `PassDict` can see such a dict. Executed confirmation: a genuine `{" b": "abc"}` dumps to `{" di":{" b__":"abc"}}` and loads back as the equal, `dict`-typed `{' b': 'abc'}` — the tag namespace is escaped, not deciphered. The collision-shaped case `{" t__": b"a"}` also round-trips equal.

**4. Where it is used, and what was actually verified by execution.**

`src/flask/sessions.py:287` instantiates the serializer that carries this path (`session_json_serializer = TaggedJSONSerializer()`), which is why session bytes matter here. Two named tests pass in this worktree (`.venv/Scripts/python.exe -m pytest`): `tests/test_json_tag.py::test_dump_load_unchanged` → `10 passed in 0.05s`, exit 0, whose parametrization includes `{" t__": b"a"}` (line 16) and non-UTF-8 `b"\xff"` (line 21) and asserts `s.loads(s.dumps(data)) == data` (line 29); and `tests/test_basic.py::test_session_special_types` → `1 passed in 0.07s`, exit 0, which sets `flask.session["b"] = b"\xff"` (455) and asserts both `type(s["b"]) is bytes` (468) and `s["b"] == b"\xff"` (469) — value and exact type survive, which a lossy text encoding could not do for `b"\xff"`. `src/flask/json/provider.py` does not special-case bytes (`loads` at `59`/`181` treat `str | bytes` only as *input*), so the byte-tagging path is entirely `TagBytes` reached through the session's `TaggedJSONSerializer`.

## What this rests on, and what remains open

- Rests on: `src/flask/json/tag.py` (`TagBytes` 159-170, `TagDict` 93-118, `tag` 289-297, `untag` 299-307, `_untag_scan` 309-317, `dumps`/`loads` 320-327, `default_tags` 238-248, imports 47-48); `src/flask/sessions.py:287`; `tests/test_json_tag.py:12-29`; `tests/test_basic.py:448-470`; the executed pytest runs and the direct `dumps`/`loads` table above, all under the worktree's `.venv/Scripts/python.exe`.
- One source discrepancy, resolved and reported: the ranked chunks located the file at `flask/src/flask/json/tag.py` and `flask/tests/test_json_tag.py`; those paths do not exist in this worktree — the real paths are `src/flask/json/tag.py` and `tests/test_json_tag.py`. The line ranges in the ranking match the real file, so it is the same artifact under a different root.
- Behaviour recorded, not asserted as a defect: `TagBytes.to_python` calls `b64decode` with the default `validate=False`, so `'{" b":"!!!!"}'` loads to `b''` with no error (non-alphabet characters silently discarded) while `'{" b":"YWJ"}'` raises `binascii.Error: Incorrect padding`. No test in this worktree covers malformed or empty base64 payloads, so decode strictness is uncovered by the suite.
- Not established: the base64-bijection-and-multiple-of-4 argument is a standard-library inference (only its observable consequences were tested); no check was made of serialized-string stability across runs, of cross-version wire compatibility, or of the itsdangerous signing path that wraps session data.
- Scope: the worktree supports one reading of "encoding binary data" — `TagBytes` inside `TaggedJSONSerializer`. A wider reading (provider-level encoding, or the session cookie's signing/compression layer) is not resolvable from the worktree and is not answered here.
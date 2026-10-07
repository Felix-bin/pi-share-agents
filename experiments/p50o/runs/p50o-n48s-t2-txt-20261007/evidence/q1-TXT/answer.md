## Why `TagUUID` enables a bidirectional UUID ↔ hex conversion

The class is `TagUUID` in `src/flask/json/tag.py:191-202` — the only class in the repository whose tag hook is keyed on `isinstance(value, UUID)` (its `check` at line 196; the only other UUID predicate anywhere is the non-tagged `provider.py:112`). It is registered in `TaggedJSONSerializer.default_tags` at `tag.py:245`, so it is active in the serializer that `src/flask/sessions.py:287` assigns to `session_json_serializer`.

Its pair of methods is:

```python
class TagUUID(JSONTag):
    __slots__ = ()
    key = " u"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, UUID)

    def to_json(self, value: t.Any) -> t.Any:
        return value.hex

    def to_python(self, value: t.Any) -> t.Any:
        return UUID(value)
```

**The reason it must exist at all is the serializer's contract.** This module is documented as "A compact representation for lossless serialization of non-standard JSON types" used by `SecureCookieSessionInterface` to serialize session data (`tag.py:1-10`). JSON has no UUID type, so a UUID inside session data can only survive if it is encoded into a JSON-native value and decoded back. `JSONTag` therefore *requires* both directions by design: `to_json` is "Convert the Python object to an object that is a valid JSON type. The tag will be added later." (`tag.py:78-81`), and `to_python` is "Convert the JSON representation back to the correct type. The tag will already be removed." (`tag.py:83-86`). The framework enforces the handoff symmetrically: `TaggedJSONSerializer.tag` walks the tags in order and returns `tag.tag(value)`, where `JSONTag.tag` (line 88-91) wraps the payload as `{self.key: self.to_json(value)}` — i.e. `{" u": <value.hex>}`; on the way back, `untag` (lines 293-303) strips the single key and calls `self.tags[key].to_python(value[key])`, and `_untag_scan` applies that recursively. Bidirectionality is not an incidental property of this one class — it is the interface the tagged JSON system defines, and `TagUUID` must satisfy it to make a UUID round-trip through a plain-JSON string.

**Why `hex` specifically is a valid encoding for that interface:** `UUID.hex` is the canonical 32-character lowercase hexadecimal form of the 128-bit value, and `uuid.UUID(...)`'s constructor accepts exactly that same undashed 32-hex-character form. The two methods are therefore genuine inverses: `UUID(v.hex) == v` for any `UUID` instance. All the information is in the 32 hex characters; the dashes of `str(uuid)` are positional decoration (the 8-4-4-4-12 hyphen positions are fixed by the standard), so they can be dropped and re-derived rather than stored — which also fits the module's stated "compact" goal, since the hex payload is 32 characters against 36 for the dashed string. The `key = " u"` tag is what makes the encoding unambiguous on load: it distinguishes "a dict whose single key is ` u`" from a real session dict, and `untag` only dispatches keys that are registered in `self.tags`.

**The tagged path is what reconstructs the Python type, and that is why it cannot be delegated to the plain JSON provider.** The non-tagged path in `src/flask/json/provider.py:112-113` does `if isinstance(o, (decimal.Decimal, uuid.UUID)): return str(o)`, documented at `provider.py:131` as ":class:`uuid.UUID` is serialized to a string." That branch only *coerces* a UUID into a JSON value inside the serializer's `_default` fallback; it has no counterpart that rebuilds a `UUID` on load. So the two are separable code paths: the plain provider is one-way (a caller getting a string back must reconstruct the type itself), while `TagUUID.to_python` is what re-instantiates the `UUID`. The question's "tagged JSON serialization system" is the `TagUUID` path.

**Executed verification (this run's check, not static reading).** Running against the repo's own `src` with its `.venv` interpreter:

```
uuid value      : 3b523965-1f99-44bf-bb14-0886d3a57c81
tagged form     : {' u': '3b5239651f9944bfbb140886d3a57c81'}
tagged == {u:hex}: True
hex len         : 32
is 32-char hex  : True
untagged        : UUID('3b523965-1f99-44bf-bb14-0886d3a57c81')
untagged == orig: True
type restored   : UUID
UUID(hex) parses: True
dumps           : {" u":"3b5239651f9944bfbb140886d3a57c81"}
loads == orig   : True UUID
```

So the tagged form is exactly `{" u": value.hex}`, the untagged result equals the original *instance* with its type restored to `UUID`, and `UUID(value.hex)` parses — the pair is invertible in execution, not merely by reading. The repo's own assertions agree: `pytest tests/test_json_tag.py -q` → 14 passed, and the narrowed session/tag run (including the `uuid4()` parametrization of `test_dump_load_unchanged` at `tests/test_json_tag.py:23,29-30` and the `flask.session["u"] = uuid.uuid4()` round trip in `tests/test_basic.py`) → 10 passed, 130 deselected. A repo-wide locator grep confirms `TagUUID` occurs only at `tag.py:191,245` and the `isinstance(value, UUID)` tag predicate only at `tag.py:196`, with the single non-tagged predicate at `provider.py:112` — no second UUID-tagging class exists in the worktree, so the "tagged" locator is unambiguous.

### What this rests on

- `src/flask/json/tag.py:1-10` (lossless/compact contract), `:78-91` (`to_json`/`to_python` docstrings and `JSONTag.tag`), `:191-202` (`TagUUID` body), `:245` (registration), `:284-323` (`tag`/`untag`/`_untag_scan`/`dumps`/`loads` flow) — read directly in this run.
- `src/flask/json/provider.py:112-113,131` — the contrasting one-way, non-tagged UUID coercion.
- `src/flask/sessions.py:287,314,330` — the session serializer that consumes `TaggedJSONSerializer`.
- The executed round-trip check above and the two passing pytest runs (exit 0, 14 passed; 10 passed / 130 deselected).
- `tests/test_json_tag.py:23,29-30` and `tests/test_basic.py:450,457,472` — repo assertions of the same round trip, now executed rather than only cited.

### What remains open

- **Not established: that `hex` is the *best* or intended-preferable encoding.** The repository states the compact/lossless contract but nowhere documents a rationale for choosing `hex` over `str(uuid)`. Both round-trip — the check observed the dashed `str(value)` form as a second valid encoding — so the choice is a storage-encoding decision (32 undashed characters vs. 36 dashed), not a behavioral difference. No judgment is made here on which is better, in line with the task's stated scope.
- **Not established and out of scope:** anything about session-cookie security, or whether other non-standard types should be re-tagged. The question's "why" is answered at the level of the tag interface and the invertible hex encode/decode pair; no claim is made beyond that.
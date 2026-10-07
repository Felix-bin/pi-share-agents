# Why `TagUUID` converts in both directions

`TagUUID` in `src/flask/json/tag.py` (the class with `key = " u"`) implements both `to_json` → `value.hex` and `to_python` → `UUID(value)` because the tagged serializer it belongs to exists for *lossless* round trips of non-JSON types, and its motivating consumer reads the value back — not merely writes it out.

**1. The module's stated purpose is a round trip, not a one-way encode.** The module docstring (`tag.py:1-5`, read verbatim) says: *"A compact representation for lossless serialization of non-standard JSON types. `SecureCookieSessionInterface` uses this to serialize the session data…"*. A UUID is not a JSON type, so it must first be encoded into a JSON-representable value (`to_json`), and "lossless" can only hold if it is decoded back to a UUID (`to_python`). That is the reason both directions live on the same class.

**2. The consumer makes the second direction mandatory.** `session_json_serializer = TaggedJSONSerializer()` (`src/flask/sessions.py:287`) is used as `serializer` (`sessions.py:314`) and the session dict is written out with `val = self.get_signing_serializer(app).dumps(dict(session))` (`sessions.py:387`). Session data is written to a signed cookie and read back on the next request, so a value a user put in `session` must come back as the same object. With only the encode direction, a `uuid.UUID` stored in the session would come back as a plain 32-char string — the type would be lost, contradicting the docstring's "lossless".

**3. The specific pair `.hex` / `UUID(value)` is chosen because it is an exact inverse and it is compact.** `dumps` uses `separators=(",", ":")` for compactness, and `value.hex` drops the four dashes of the canonical form; the executor measured 32 chars for `.hex` versus 36 for `str(u)`. `UUID(value)` accepts the dashless hex and rebuilds the identical object, so the pair satisfies both "compact" and "lossless". Runtime observation (executor, exit 0, run with `PYTHONPATH=src` so the local worktree source won): `dumps` → `'{" u":"12345678123456781234567812345678"}'`, `loads` → `UUID('12345678-1234-5678-1234-567812345678')`, round trip `True`.

**4. The wiring confirms the direction of the contract.** `JSONTag.tag` wraps the result as `{self.key: self.to_json(value)}` and `TaggedJSONSerializer.untag` dispatches the inverse via `self.tags[key].to_python(value[key])` (`tag.py`); `UUID` is imported at `tag.py:35` and `TagUUID` is in `TaggedJSONSerializer.default_tags`. So " u" ⇄ 32-char hex is the actual wire contract, and both methods are needed to close it.

**5. The contrast isolates why only the tagged serializer needs both.** The plain JSON provider's `_default` (`src/flask/json/provider.py:108-113`, read verbatim) maps UUID one-way:

```python
if isinstance(o, (decimal.Decimal, uuid.UUID)):
    return str(o)
```

This is response encoding only — nothing decodes it back — so no inverse is required. The tagged serializer is the one used for *storage* to be re-read (sessions), which is exactly why it defines `to_python` as well.

**6. The repository asserts the round trip, and it passes.** `tests/test_json_tag.py:12-27` parametrizes `test_dump_load_unchanged` with `uuid4()` (line 23) among other values and asserts `s.loads(s.dumps(data)) == data` (read verbatim). The executor ran it with `PYTHONPATH=src`: `10 passed, 4 deselected`, exit 0.

**Contradictions and limits.** No contradiction was found between sources; the docstring wording is confirmed verbatim. The honest caveat: there is **no inline comment on `TagUUID`** stating its rationale — the "why" above is reconstructed from the module docstring, the round-trip test, and the one-way provider contrast, not from a line that says "we do this because…". That reconstruction is inference about intent, and it is the strongest reading the evidence supports.

## What this rests on, and what is open

- **Rests on:** `src/flask/json/tag.py` (docstring lines 1-5; `TagUUID` body ~line 193; `default_tags`, `JSONTag.tag`, `TaggedJSONSerializer.untag`); `src/flask/sessions.py:287,314,387`; `src/flask/json/provider.py:108-113` and its docstring bullet; `tests/test_json_tag.py:12-27`; plus the executor's runtime round-trip script and pytest run (10 passed, 4 deselected) with `PYTHONPATH=src`.
- **Environment fact worth keeping:** the repo's `.venv` editable install resolves `flask` to a different worktree, so any rerun must set `PYTHONPATH=src` (or it silently tests the wrong source).
- **Answered:** why `TagUUID` is bidirectional — lossless round trip for a stored-then-reloaded type, made concrete by the session serializer; and why `.hex` specifically — compactness plus exact invertibility.
- **Still open / not established:** the rationale is not stated in a comment on the class itself (inference, as flagged); and no test was found or run that puts a UUID into a real `session` and reads it back, so the session-level consequence is inferred from the `sessions.py` call sites rather than demonstrated end to end.
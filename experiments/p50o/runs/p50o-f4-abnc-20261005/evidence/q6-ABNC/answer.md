## The relationship: `ensure_ascii` is a one-to-one pass-through to the stdlib encoder's ASCII-only flag, controlling character *representation* only

The control parameter is `DefaultJSONProvider.ensure_ascii`, a class attribute defaulting to `True`:

> `ensure_ascii = True` — "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." — `src/flask/json/provider.py:144-148`

It is forwarded verbatim to Python's `json.dumps` on every serialization:

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```
— `src/flask/json/provider.py:176-179`

So the framework adds no transformation of its own; `ensure_ascii` on the provider *is* `json.dumps(ensure_ascii=...)`. Because the attribute is applied with `setdefault`, an explicit per-call keyword (`app.json.dumps(obj, ensure_ascii=False)`, or `flask.json.dumps(..., ensure_ascii=False)` under an app context) overrides the attribute for that call only.

**Effect on the serialized characters**, as asserted by the framework's own test over U+2603 SNOWMAN (`tests/test_json.py:48-54`):

- `ensure_ascii = True` (default) → `'"\\u2603"'`: every non-ASCII code point is emitted as a `\uXXXX` escape, and the returned string is pure ASCII.
- `ensure_ascii = False` → `'"\u2603"'`: the code point is emitted literally, so the returned string contains real Unicode characters.

The flag changes only how code points are written, not their meaning: the escape is the JSON escape form of the same code point, so the decoded value is identical either way (`test_json_dump_to_file`, `tests/test_json.py:57-64`, round-trips through `dump`/`load`).

**From string to wire bytes.** `dumps` returns a `str`; the response body is produced from it, and Werkzeug encodes a `str` body as UTF-8 ("If a string is set it's encoded to the charset of the response (utf-8 by default)", `value.encode()` — `.venv/Lib/site-packages/werkzeug/wrappers/response.py:289-298`). Hence with `ensure_ascii=False` a snowman reaches the client as the three bytes `" ☃ "` in UTF-8 rather than the six ASCII characters `\u2603`, while both are the same JSON document. `ensure_ascii=True` is the setting under which the body needs no non-ASCII encoding at all — which is exactly the client-compatibility rationale in the attribute's docstring.

## Where the switch reaches

- `app.json.dumps` and, through the base `JSONProvider.dump`, `app.json.dump` (`src/flask/json/provider.py:49-57`).
- `DefaultJSONProvider.response` (the implementation behind `jsonify`) — it builds its output with `self.dumps(obj, **dump_args)`, `mimetype = "application/json"` (`provider.py:163`, `provider.py:206-222`).
- `flask.json.dumps` / `flask.json.dump` **when an app context is active**: they delegate to `current_app.json.dumps` / `.dump` (`src/flask/json/__init__.py:41-44`, `71-74`).
- Session payloads: `TaggedJSONSerializer.dumps` calls the same `flask.json.dumps` (`src/flask/json/tag.py:56`, `321-323`), so the provider setting governs session serialization whenever an app context is active.
- The test client's request bodies: `EnvironBuilder.json_dumps` takes the setting from the app (`tests/test_testing.py:110-114` sets `app.json.ensure_ascii = False` and expects the UTF-8 euro sign).

**Boundaries of the parameter:**

- Without an app context, `flask.json.dumps` bypasses the provider entirely — it only sets `default` and calls stdlib `json.dumps`, so the stdlib default (`True`) applies and the attribute is ignored (`src/flask/json/__init__.py:41-44`; same for `dump`, `72-74`).
- It exists on `DefaultJSONProvider`, not on the `JSONProvider` interface, whose `dumps` is abstract (`provider.py:41-47`). A provider installed via `json_provider_class` (`src/flask/sansio/app.py:230`, `provider.py:28-30`) is therefore not obliged to honor it.
- It supersedes the removed `JSON_AS_ASCII` config key with the same semantics, moved onto the provider (`CHANGES.rst:153-154`, `285-288`; `docs/config.rst:441-443`).

## What this rests on

- Direct reads of the working tree: `src/flask/json/provider.py` (144-148, 163, 166-179, 206-222), `src/flask/json/__init__.py` (41-44, 71-74), `src/flask/json/tag.py` (56, 321-323), `src/flask/sansio/app.py` (230, 329), `tests/test_json.py` (48-64), `tests/test_testing.py` (110-114), `CHANGES.rst` (153-154, 285-288), `docs/config.rst` (441-443), `.venv/.../werkzeug/wrappers/response.py` (289-298). Version in tree: 3.2.0 unreleased (`CHANGES.rst:1-6`).
- The only task-specific artifact present, `flask_mut2_i417ar2x/mutated_test.py`, exercises subdomain matching and `url_for` and never touches the JSON provider; it neither confirms nor contradicts anything above.

## Open / not established

- The planner and retriever bodies were not reachable in this session: `synapse_read` (search and get, both handles) and `synapse_write` all returned `namespace-mismatch` — the state directory belongs to a different seal (`q1-ABNC`), not this one. So I could not check their claims for agreement or contradiction; the statement above stands on the working-tree reads alone, and any conflicting statement in those bodies is unreconciled.
- No test or reproduction was executed for this task (the executor stage was skipped by the complexity gate), so the mapping is established by code and test-source reading, not by an observed run.
- Not verified: whether the emitted `Content-Type` for `application/json` carries a `charset` parameter (Werkzeug notes a charset is appended for `text/*` and "some other special cases", `.venv/.../werkzeug/sansio/response.py:79-87`; the `charset` attribute itself was removed in Werkzeug 3.0). This matters only for clients that rely on the header rather than JSON's UTF-8 default when `ensure_ascii=False`.
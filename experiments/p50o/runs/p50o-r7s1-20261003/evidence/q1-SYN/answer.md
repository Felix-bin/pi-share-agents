## Answer

**Short form:** `DefaultJSONProvider.ensure_ascii` controls the *encoded representation* of non-ASCII characters in Flask's serialized output — and nothing else. It changes which byte/character sequence comes out; it never changes the value that comes back in.

### The control and its wiring

- Declared at `src/flask/json/provider.py:144` → `ensure_ascii = True` on `DefaultJSONProvider` (class at `:124`). Docstring `:145-147`: True "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."
- It reaches `json.dumps` as a **default**, not a mandate: `provider.py:176-179` does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` then `return json.dumps(obj, **kwargs)`. An explicit caller kwarg overrides the attribute.
- Scope of the knob: per-app instance (`json_provider_class` at `sansio/app.py:230`, instance `self.json` at `:329`), so `app.json.ensure_ascii = False` is the override surface. It affects `dumps` only; `loads` never consults it (`provider.py:181`). It is reached only on the app-context path — module-level `flask.json.dumps` outside an app context falls back to stdlib `json.dumps` and **ignores** the provider (`json/__init__.py:40-44`); `TaggedJSONSerializer.dumps` inherits the setting only inside an app context (`tag.py:321-323`). Version scope: provider API since Flask 2.2 (`provider.py:35`, `json/__init__.py:26-28`); the pre-2.2 `JSON_AS_ASCII` config survives in this checkout only as changelog/doc history (`CHANGES.rst:153,286`, `docs/config.rst:419,441`).

### The observed relationship (executed, not read)

The executor ran the checkout through its own `.venv` (CPython 3.13.9 win32, Werkzeug 3.1.3; 3/3 of the relevant checkout tests pass). Mapping for `app.json.dumps`, defaulting to `True`:

| Input | `True` (default) | `False` |
|---|---|---|
| `"abc"` | 5 chars / 5 UTF-8 bytes, ASCII | identical — no difference |
| U+2603 | `"\u2603"` — 8 chars / 8 bytes, all ASCII | raw ☃ — 3 chars / 5 UTF-8 bytes |
| U+1F600 | `"\ud83d\ude00"` — 14 chars / 14 bytes, all ASCII, **surrogate pair** | raw 😀 — 3 chars / 6 UTF-8 bytes |

So the relationship has four parts:
1. **Escaping, not mangling.** Under `True` the output text is strictly ASCII; non-BMP characters are emitted as two `\uXXXX` (lowercase-hex) surrogate escapes rather than one escape.
2. **Size inverts.** `True` is *larger* whenever non-ASCII is present (8 vs 5 bytes at U+2603; 14 vs 6 at U+1F600); for pure-ASCII payloads the setting is a no-op. `False` is smaller in characters and bytes in these cases.
3. **No charset is attached to compensate.** Response headers are `Content-Type: application/json` with **no charset** parameter under both settings (observed WSGI headers), while the body is UTF-8 either way — `True` → `b'{"emoji":"\\ud83d\\ude00","snow":"\\u2603"}\n'` (16 bytes), `False` → `b'{"emoji":"\xf0\x9f\x98\x80","snow":"\xe2\x98\x83"}\n'` (13 bytes). `False` therefore requires a consumer that decodes as UTF-8; that is the "compatibility" tradeoff the docstring names.
4. **Semantics are invariant.** `loads()` round-trips to an equal object for all six string cases and both response bodies — including the surrogate-escaped astral character. The knob moves bytes and characters, not meaning.

Ripple, all confirmed present: `flask.jsonify` → `current_app.json.response` (`json/__init__.py:170`, `provider.py:~214`) and `EnvironBuilder.json_dumps` → `self.app.json.dumps` (`testing.py:88-94`) inherit it; the checkout's own test asserts the mapping (`tests/test_json.py:50-54`, param `(True, '"\\u2603"')`).

### What is answered vs still open

**Answered:** what the parameter is, its default, its wiring and override surface, and its exact effect on Unicode representation in serialized output — established by both source and an executed run.

**Still open / limits on the claim:**
- The run used `flask-src/.venv` (win32, Py3.13.9, Werkzeug 3.1.3), **not** the pinned Linux runtime (`experiments/data/venv` → `worktree/flask`, Py3.11 + Werkzeug 3.1.8). The provider lines are identical in both copies (`worktree/flask/src/flask/json/provider.py:144,177`), but the *runtime* that would be used by the pinned SWE-QA env was never executed.
- **No Phase 2 experiment path was traced that serializes non-ASCII through Flask's provider for byte/token accounting.** The harness's own `json.dumps(..., ensure_ascii=False)` at `experiments/bench/external/common.py:81,87` is stdlib, harness-owned — a conflation trap, and not evidence that Flask's provider participates in the project's byte/token numbers. So this finding has **no established bearing on the competition's communication-efficiency figures**.
- The pi plugin's TypeScript serializers were not examined (outside this checkout), and non-Python client handling of lone-surrogate escapes was not tested — only Python's own `loads` round-trip.
- Both legs of the conclusion are keyed to the frozen vendored checkout at `85c5d93…`: gitignored (`experiments/data/`, `.gitignore:33`), so neither the executor's nor my memory record could carry a `sourcePath`, and **neither will auto-retire if that checkout ever changes**. My own `synapse_write` attempt was rejected (`summarizer may not write shared memory`), so this conclusion exists only in this response and in the executor's read-only `tool-result` memory `86738f85…` — nothing durable was added from this session.

**What it rests on:** executed run recorded in shared memory `86738f855228ad1e00bf28daababbbc0a735ad6ba2a1f03a8c2e8b118209cb96` (3/3 pytest pass; six-case dumps probe; response/header/body-byte probe; `jsonify`, `EnvironBuilder`, in/out-of-context probes); source re-verified this session at `src/flask/json/provider.py:144,145-147,157,163,176-179,181`, `src/flask/sansio/app.py:230,329`, `src/flask/json/__init__.py:40-44,170`, `src/flask/testing.py:88-94`, `src/flask/json/tag.py:321-323`, `tests/test_json.py:50-54`, `tests/test_testing.py:110-114`, `experiments/bench/external/common.py:81,87`, `CHANGES.rst:153,286`.

One correction to the inherited evidence: the plan's `provider.py:159` for `mimetype` is wrong — it is at `:163` (the retriever had already flagged this; confirmed here).
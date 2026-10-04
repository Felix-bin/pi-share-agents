## Relationship between `ensure_ascii` and Unicode representation

`DefaultJSONProvider.ensure_ascii` is a **representation-only switch**: it decides how a non-ASCII code point is *written into the JSON text* — as a `\uXXXX` escape or as the literal character — while leaving the value the JSON denotes completely unchanged.

The parameter is declared as a class attribute on `DefaultJSONProvider` with default `True` (`src/flask/json/provider.py:144-150`, docstring: "Replace non-ASCII characters with escape sequences") and is declared nowhere else — the base `JSONProvider` (`provider.py:22`) has no such attribute, and `ensure_ascii` appears in `src/` only at `provider.py:144` (declaration), `:171` (the `dumps` docstring) and `:177` (plumbing).

**How it reaches the output.** In `DefaultJSONProvider.dumps` (`provider.py:177-179`) it is forwarded verbatim into stdlib `json.dumps`: `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`. Because it is `setdefault`, a per-call `ensure_ascii=` kwarg wins over the attribute — empirically in both directions (`provider=True` + kwarg `False` → `"☃"`; `provider=False` + kwarg `True` → `"\u2603"`). Everything that serializes through the provider inherits it: `JSONProvider.dump` (`provider.py:55-61`), `DefaultJSONProvider.response` (`provider.py:214-216`, the HTTP body), module-level `flask.json.dumps` with an app context (`src/flask/json/__init__.py:41`), `EnvironBuilder.json_dumps` (`src/flask/testing.py:94`), and `app.py:422` (`rv.policies["json.dumps_function"]`). The one path that bypasses it is `flask.json.dumps` **without** an app context, which falls back to stdlib `_json.dumps` (`json/__init__.py:44`) and never consults the attribute.

**The two representations, and what stays the same.** For `"\N{SNOWMAN}"` (U+2603):

| `ensure_ascii` | serialized text | chars | UTF-8 bytes | ASCII-only | decoded value |
|---|---|---|---|---|---|
| `True` (default) | `'"\\u2603"'` | 8 | 8 | yes | U+2603 |
| `False` | `'"☃"'` | 3 | 5 | no | U+2603 |

The decoded result is identical: `json.loads` of either form round-trips to the same code point (executor's script reports `json.loads round-trip equals U+2603: True` for both settings). So the knob changes escaping/transmission form, not semantics. Consistent with the docstring's trade-off note ("more compatible with some clients, but can be disabled for better performance and size"), the escape form is ASCII-only and larger here (8 vs 5 bytes for U+2603).

**At the transport level, only the body bytes differ.** Both forms are served as `application/json`: `jsonify(ensure_ascii=False)` yields raw bytes `b'"\xe2\x98\x83"\n'` and `jsonify(ensure_ascii=True)` yields `b'"\\u2603"\n'` — same media type, same decoded payload, different bytes on the wire. The raw form therefore depends on the response being UTF-8 encoded; that encoding step is the response layer's job, not the flag's.

**Repo-pinned expectations.** `tests/test_json.py:48-54` parametrizes exactly the pair above (`(True, '"\\u2603"')`, `(False, '"\u2603"')`) against `app.json.dumps("\N{SNOWMAN}")`; I read those lines directly to confirm. `tests/test_testing.py:111-113` independently pins the flag on the `EnvironBuilder` path (`app.json.ensure_ascii = False`, input `"\u20ac"` → raw euro sign as UTF-8). Both suites pass in this worktree: `test_json_as_unicode` 2 passed, `tests/test_testing.py -k json` 3 passed.

**Contradiction check.** None. The retriever marked the stdlib escaping semantics as *inferred* from the tests; the executor's independent script *observed* them, and the two agree, so that gap is closed by the run rather than left open.

---

**Rests on:** `src/flask/json/provider.py:22, 55-61, 144-150, 171, 177-179, 214-216`; `src/flask/json/__init__.py:41, 44`; `src/flask/testing.py:94`; `src/flask/app.py:422`; `tests/test_json.py:48-54` and `tests/test_testing.py:111-113` (both read directly); executor's pytest runs and inline two-setting script (handles `4a6fbd6ef65f`); retriever's evidence (handle `cf380e01e5a5`).

**Still open:** the stdlib `json.dumps` escaping rule behind this was exercised only through this worktree's provider path — no subclassed/third-party provider was measured; the no-app-context fallback (`json/__init__.py:44`) was identified in source but not run; non-ASCII *input* decoding was not measured; and `docs/` contains no `ensure_ascii` mention (`CHANGES.rst` has only an unrelated `.flaskenv` non-ASCII entry at line 604), so the behaviour is documented only by the attribute docstring, not in the docs tree. No files were edited by this run.
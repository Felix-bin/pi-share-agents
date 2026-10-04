## The relationship

`ensure_ascii` is the JSON provider's serialization-time switch that decides **how non-ASCII code points are spelled in the output text**, not which characters survive. Its default is `True`, and it is threaded into Python's `json.dumps` as a per-call default:

- `src/flask/json/provider.py:144` — `ensure_ascii = True` on `DefaultJSONProvider`, documented as "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."
- `src/flask/json/provider.py:177` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`, then `json.dumps(obj, **kwargs)`.

So the relation is one of *representation only*:

- `True` → every non-BMP/ASCII-unsafe character is emitted as a `\uXXXX` escape, so the serialized string is pure ASCII and its bytes are identical under any ASCII-compatible decoding.
- `False` → the character is emitted literally; the string carries real multi-byte characters and, when written to a response, is encoded as UTF-8 (repo evidence: `tests/test_testing.py:110-114` sets `app.json.ensure_ascii = False`, passes `"\u20ac"` and asserts `eb.input_stream.read().decode("utf8") == '"\u20ac"'`).

The stated pairing is asserted directly by the suite: `tests/test_json.py:48-54` parametrizes `app.json.dumps("\N{SNOWMAN}")` with `(True, '"\\u2603"')` and `(False, '"\u2603"')`. Either form round-trips through `json.loads` to the same `str`: the control changes escapes, size and client compatibility, not the value, key order or structure. (For code points above U+FFFF the `True` form is a surrogate-pair escape, a consequence of delegating to stdlib `json.dumps`; the repo contains no test covering non-BMP input, so that specific shape is inferred, not asserted here.)

### Where the parameter reaches output

Every serialization path that goes through the app's provider inherits it, because they all funnel into `DefaultJSONProvider.dumps`: `jsonify`/`app.json.response` (`src/flask/json/__init__.py:164`, `provider.py:214`), `flask.json.dumps`/`dump` when an app context is active (`src/flask/json/__init__.py:41`), Jinja's `|tojson` filter via `rv.policies["json.dumps_function"] = self.json.dumps` (`src/flask/app.py:422`), `EnvironBuilder.json_dumps` (`src/flask/testing.py:94`), and the tagged session serializer (`src/flask/json/tag.py:323`), so session-cookie payloads inherit the setting too.

Two boundary conditions matter:

- **Without an app context** the control is bypassed entirely: `flask.json.dumps` falls back to `_json.dumps` with only `default` set (`src/flask/json/__init__.py:44`), i.e. stdlib `ensure_ascii=True`, unaffected by any provider attribute.
- **`jsonify` cannot take it per call.** `*args`/`**kwargs` are treated as data by `_prepare_response_obj` (`provider.py:80-96`), so for responses the only control is the attribute on the provider; a per-call `ensure_ascii=...` override is possible only by calling `app.json.dumps(...)` directly, since `dumps` uses `setdefault` and therefore lets an explicit argument win. Because it is a plain (non-property) class attribute default, `app.json.ensure_ascii = ...` sets an instance attribute on that app's provider (`self.json = self.json_provider_class(self)`, `src/flask/sansio/app.py:329`) and does not affect other apps.

### Not the same thing as HTML escaping

`\uXXXX` sequences in serialized output have two independent sources. The `\u003c`/`\u003e` escaping of `<`, `>` produced by the template `|tojson` filter (`tests/test_json.py:211-220`) comes from Jinja's HTML-safe dumping applied after serialization, and happens regardless of `ensure_ascii`; `ensure_ascii` is the only one of the two governed by a provider parameter, and it governs non-ASCII characters rather than HTML-significant ASCII ones.

### Configuration history in this tree

The control is a provider attribute, not a config key: `JSON_AS_ASCII` was moved to `app.json` in 2.2 and removed in 2.3 (`CHANGES.rst:285-288`, `CHANGES.rst:153-154`, `docs/config.rst:440-443`), which is consistent with `tests/test_json.py` setting `app.json.ensure_ascii` rather than `app.config`. The only in-repo documentation of the parameter is its attribute docstring, picked up by `docs/api.rst:265`.

## What this rests on, and what is open

- **Rests on:** `src/flask/json/provider.py:144,177,179` (default value, setdefault chain, delegation to stdlib `json.dumps`), `src/flask/json/provider.py:80-105,214` (kwargs-as-data, response path), `src/flask/json/__init__.py:41,44,164` (app-context dispatch and no-context fallback), `src/flask/app.py:422` (tojson policy), `src/flask/json/tag.py:323` and `src/flask/testing.py:94` (other inheriting paths), `src/flask/sansio/app.py:329` (per-app provider instance), `tests/test_json.py:48-54` and `tests/test_testing.py:110-114` (the escaped/literal pairing), `tests/test_json.py:211-220` (HTML escaping is separate), `CHANGES.rst:153-154,285-288` and `docs/config.rst:440-443` (config-key removal).
- **Verification status:** the assertions above are read from the test files; I did not execute the suite in this role, so "passes" is not established here — only that the pairing is asserted. The two live artifacts handed to this step (retriever `15b3958f…`, executor `e1c68502…`) were not readable: `synapse_read` returned `namespace-mismatch` (the shared-memory state belongs to a sibling seal, not this one) and their text was not present in my prompt. Their contents are therefore unknown to me; if they recorded results contradicting the above, I cannot report the contradiction — for the same reason no conclusion was written to shared memory.
- **Open:** whether any consumer relies on byte-level ASCII output (the docstring's compatibility rationale) is not evidenced anywhere in the tree; the repo supplies no non-BMP or HTTP-response-body test for `ensure_ascii`, so the response-path behavior is derived from the code path rather than observed.
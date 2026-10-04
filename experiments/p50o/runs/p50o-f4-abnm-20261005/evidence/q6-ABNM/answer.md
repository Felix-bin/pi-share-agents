## Relationship

The provider's ASCII-only flag is a pure serialization-encoding switch: it decides whether non-ASCII characters that appear in the data are written into the output text as `\uXXXX` escape sequences or emitted literally as Unicode. It does not change which characters are serialized, only how they are represented in the output string.

- The parameter is `ensure_ascii` on `DefaultJSONProvider`, declared as a class attribute with default `True`. Its docstring states the effect directly: "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." (`src/flask/json/provider.py:144-147`)
- It reaches the serializer as a default, not a fixed setting: `dumps` does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` before calling `json.dumps`, alongside the same treatment for `default` and `sort_keys` (`src/flask/json/provider.py:169-178`). So the attribute is the provider-wide default and a per-call `ensure_ascii=` keyword argument overrides it.
- The observable contrast is pinned by a test that serializes the same input, `"\N{SNOWMAN}"`, under both settings: `True` → `'"\\u2603"'` (seven ASCII characters between the quotes) and `False` → `'"\u2603"'` (the character itself) (`tests/test_json.py:50-55`). The parametrization is the clearest statement of the relationship in the worktree: same input, two representations, differing only in escaping.

Propagation and scope:

- The flag is consulted on the paths that go through the provider: `flask.json.dumps` calls `current_app.json.dumps` when an app context is active (`src/flask/json/__init__.py:40-41`), and `jsonify` calls `app.json.response` (`src/flask/json/__init__.py:138-141`), which in turn builds its body from `self.dumps(...)` (`src/flask/json/provider.py:188-211`). `EnvironBuilder.json_dumps` also forwards to `self.app.json.dumps` (`src/flask/testing.py:88-94`), so test request bodies inherit the setting.
- Outside an app context the provider is bypassed: `flask.json.dumps` falls back to stdlib `_json.dumps` without setting `ensure_ascii` (`src/flask/json/__init__.py:43-44`), so the attribute has no effect there.
- When the flag is `False`, the literal characters travel as UTF-8. `dump` documents the file as needing UTF-8 "to be valid JSON" (`src/flask/json/provider.py:161-165`), and the one test that consumes non-ASCII `dumps` output as bytes decodes it as UTF-8 — `app.json.ensure_ascii = False`, input `"\u20ac"`, output read as `b'"\u20ac"'` decoded with `utf8` (`tests/test_testing.py:110-114`).
- Naming/history: the pre-2.3 config key `JSON_AS_ASCII` was removed and the default provider's attribute is its replacement (`CHANGES.rst:153-154`, `CHANGES.rst:286-288`, `docs/config.rst:440-443`). The historical "option to generate non-ascii encoded JSON" described as producing fewer bytes transmitted over the network (`CHANGES.rst:1192-1195`) is the same trade-off the `ensure_ascii` docstring describes.

## What this rests on

- `src/flask/json/provider.py:144-147, 161-178, 188-211` — attribute, docstring, `setdefault` forwarding, response path.
- `src/flask/json/__init__.py:40-44, 138-141` — provider routing and the app-context-less fallback.
- `tests/test_json.py:50-55` — escaped vs. literal output for the same input.
- `tests/test_testing.py:110-114` — non-ASCII provider output read as UTF-8 bytes.
- `src/flask/testing.py:88-94`, `CHANGES.rst:153-154, 286-288, 1192-1195`, `docs/config.rst:440-443` — propagation into test request bodies and the `JSON_AS_ASCII` → attribute lineage.

## Open points

- The escape/literal outputs are asserted only for `dumps`. No test in the worktree asserts the `jsonify`/`response` body bytes under `ensure_ascii = False`; the UTF-8 claim for response bodies rests on the `EnvironBuilder` test and the `dump` docstring, not on a response-level assertion.
- That escaping is lossless on round-trip (`\u2603` and `☃` deserialize to the same value) follows from JSON/stdlib semantics; the repo's `loads` is a plain passthrough to `json.loads` (`src/flask/json/provider.py:181-186`) and no round-trip test for this parameter exists.
- Whether astral-plane characters are expanded to surrogate pairs is not established by any evidence in the worktree.
- No mutated variant of this parameter exists here: the only mutation artifact, `flask_mut2_i417ar2x/mutated_test.py`, exercises subdomain `url_for` resolution and does not touch `ensure_ascii`. The description above is of the unmutated source.
- The inherited planner/retriever handles could not be redeemed from this namespace (`namespace-mismatch` against another seal's state), so this answer is grounded directly in the worktree rather than in those two reports; for the same reason no shared-memory record was written.
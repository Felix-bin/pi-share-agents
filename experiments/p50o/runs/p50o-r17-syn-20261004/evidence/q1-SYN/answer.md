## The relationship

The control parameter is `DefaultJSONProvider.ensure_ascii`, a class attribute on the JSON provider that defaults to `True` (`src/flask/json/provider.py:144`, docstring: "Replace non-ASCII characters with escape sequences"). Its relationship to Unicode representation is a one-way switch over *how* non-ASCII code points are written, decided at serialization time and nothing else:

- **`ensure_ascii = True` (default)** — every non-ASCII code point is replaced by its `\uXXXX` escape sequence. Serializing U+2603 SNOWMAN yields the seven-character ASCII string `'"\u2603"'`.
- **`ensure_ascii = False`** — the code point is emitted literally. The same call yields `'"☃"'`, and on the byte-producing path (`EnvironBuilder.json_dumps`) the encoded request body is the UTF-8 bytes `b'"\xe2\x98\x83"'`; the euro sign behaves identically (`b'"\xe2\x82\xac"'`).
- **Representation only, not content.** Both forms are valid JSON for the same string: the executor's direct check confirmed `json.loads` of the escaped and literal forms returns equal values. The parameter changes the shape and size of the output, not the value the output denotes.

Mechanically, the attribute is not a separate encoding layer — it is forwarded verbatim as a default keyword argument to the standard library serializer. `DefaultJSONProvider.dumps` does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`src/flask/json/provider.py:177`) and then `json.dumps(obj, **kwargs)` (line 179). Two consequences follow directly from that wiring:

1. **It is only a default.** A per-call `ensure_ascii=` keyword wins over the attribute in both directions; the executor observed `attr=False + kwarg=True` producing `'"\u2603"'` and `attr=True + kwarg=False` producing `'"☃"'`.
2. **It only exists on the provider that delegates to `json`.** The base `JSONProvider` (`src/flask/json/provider.py:19`) defines no `ensure_ascii`, and `flask.json.dumps` with no current app falls back to the stdlib `_json.dumps` without setting it (the stdlib default is also `True`). The parameter therefore governs output for serialization routed through the provider — `app.json.dumps`, `jsonify`, `app.json.response`, `EnvironBuilder.json_dumps` — and it also reaches the Jinja `tojson` filter indirectly, because `rv.policies["json.dumps_function"] = self.json.dumps` (`src/flask/app.py:422`).

Both behavioral checks that pin the relationship pass against this repo's own `src/flask`: `tests/test_json.py:48-54` asserts `True` → `'"\\u2603"'` and `False` → `'"\u2603"'`, and `tests/test_testing.py:110-114` asserts that with `False` the euro sign survives as a literal character in the built request bytes (`3 passed in 0.05s`, run with `PYTHONPATH=src`). The whole-repo footprint of the name is just those two tests plus the provider definition and its three uses (`provider.py:144,171,177`).

## What it rests on

- `src/flask/json/provider.py:144` (attribute + default), `:171` (docstring naming it), `:177` (the `setdefault` forwarding), `:179` (the `json.dumps` call); base class at `:19` — all re-read directly.
- `tests/test_json.py:48-54` and `tests/test_testing.py:110-114` — re-read directly, and executed green by the executor with `PYTHONPATH=src`.
- `src/flask/json/__init__.py:12` (provider-vs-stdlib fallback) and `src/flask/app.py:422` (Jinja `json.dumps_function` wiring) via the retriever.
- Executor's direct attribute-flip checks (default `True`; per-call kwarg overrides both ways; both forms parse equal).

## Still open

- **No documentation-level statement** of the relationship: `docs/` contains no `ensure_ascii` mention; the only prose is the code docstring at `provider.py:144`.
- **Jinja `tojson` internals** were not inspected — Flask defines no `tojson` filter inside `src/flask`, so only the `json.dumps_function` wiring was observed.
- **The `\u003c`/`\u003e` escaping at `tests/test_json.py:218`** is *inferred* to be `tojson` HTML-safety escaping rather than an `ensure_ascii` effect; this was not confirmed.
- **Response/`jsonify` wire body** was not measured beyond `EnvironBuilder`'s request bytes; the byte-level claim rests on that one path plus the shared `dumps` pipeline.

Recorded this as a conclusion in shared memory (`ab5cc8bb8bb2`) so later tasks can start from it.
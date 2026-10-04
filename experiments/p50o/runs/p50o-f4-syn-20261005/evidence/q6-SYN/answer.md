## Relationship between the ASCII-only parameter and Unicode representation in serialized output

The control is `ensure_ascii` on the JSON provider. `DefaultJSONProvider` declares it as a class attribute defaulting to `True` — "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." (`src/flask/json/provider.py:144-148`). It is consumed in exactly one place, `DefaultJSONProvider.dumps`:

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)   # provider.py:177
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```

So the relationship is: **the attribute selects the surface form of non-ASCII code points in the returned `str`, not the value it represents.** With `ensure_ascii = True` (the default) every code point above U+007F is emitted as a `\uXXXX` escape, so the serialized string contains only ASCII code points; with `ensure_ascii = False` the characters are emitted literally and the string contains the actual Unicode characters. Both forms are the same JSON document semantically — the escapes are ordinary JSON string escapes — so round-tripping through `loads` gives identical values either way (`tests/test_json.py:48-54` asserts exactly this pair: `True` → `'"\\u2603"'`, `False` → `'"\u2603"'` for a snowman).

Consequences that follow from that mechanism, each sourced:

- **The switch is a per-call default, not a hard setting.** `kwargs.setdefault` means an explicit `ensure_ascii=` passed by the caller wins over the attribute (`provider.py:176-179`, whose docstring says parameters are set as defaults from the `default`, `ensure_ascii` and `sort_keys` attributes).
- **It applies to the whole document, not just top-level values.** It is an argument to `json.dumps`, so every string in the object is affected — nested values and dict keys alike.
- **It is per-app, not per-request.** The attribute lives on the provider instance created once per app (`sansio/app.py:329`, `app.py:230-233`), so assigning `app.json.ensure_ascii = False` changes serialization for that app until reassigned — as the tests do (`tests/test_json.py:52`, `tests/test_testing.py:112`).
- **It reaches responses.** `JSONProvider.response` calls `self.dumps(obj, **dump_args)`, where `dump_args` carries only `indent`/`separators` (`provider.py:206-215`), so `jsonify` output obeys the attribute; `flask.json.dumps`/`dump` delegate to `current_app.json` (`json/__init__.py:40-44, 70-74`).
- **The provider attribute is only consulted with an app context.** With no `current_app`, `flask.json.dumps` falls back to stdlib `json.dumps` with only `default` set (`json/__init__.py:40-44`), i.e. stdlib's own `ensure_ascii=True`; the attribute has no effect there.
- **ASCII-only output is about the text, and the repo treats UTF-8 as the JSON text encoding.** The base provider's `dump` docstring requires a file "opened for writing text. Should use the UTF-8 encoding to be valid JSON" and `loads` accepts "Text or UTF-8 bytes" (`provider.py:42-47, 57-63`; `json/__init__.py:84, 115`). So with `True` the encoded bytes are pure ASCII (a strict subset of UTF-8, maximally conservative for clients), and with `False` the same characters occupy multi-byte UTF-8 sequences — the docstring's "better performance and size" point.
- **The parameter does not exist as a config key any more.** `JSON_AS_ASCII` was deprecated in 2.2 and removed in 2.3, with the default provider's attribute given as the equivalent (`CHANGES.rst:153-154, 285-288`; `docs/config.rst:440-443`). No `JSON_AS_ASCII` reference remains in `src/flask`.

One nearby detail that must not be confused with this parameter: the `\u003c` / `\u003e` escapes in `tojson` output (`tests/test_json.py:216-220`) are HTML-safety escaping of `<`, `>`, `&`, `'` performed on top of Flask's `dumps`, and happen regardless of `ensure_ascii`.

## What this rests on

- `src/flask/json/provider.py:144-148` (attribute and docstring), `:176-179` (`setdefault` forwarding).
- `src/flask/json/provider.py:206-215` (response path and `dump_args`).
- `src/flask/json/__init__.py:13-44, 47-74, 77-105` (app-context delegation vs. stdlib fallback).
- `src/flask/sansio/app.py:230-233, 329-340` (provider class and per-app instance).
- `tests/test_json.py:48-54` (both settings, exact expected strings), `tests/test_testing.py:110-114` (`ensure_ascii = False` flowing into request serialization).
- `CHANGES.rst:153-154, 285-288, 1192-1195` and `docs/config.rst:418-443` (history: config key deprecated then removed; the non-ASCII option added for fewer transmitted bytes).

## Still open / not established

- **No execution confirmed anything.** This stage only inspected source and tests; the two collections that were supposed to reach me (planner `77b9fa38…`, retriever `e457f844…`) are unreadable from this working directory's state namespace, so no prior evidence set or test run could be checked. The behaviour claims above rest on reading the code and the repo's own tests, not on a run in this session.
- **No quantitative byte-size data** for `True` vs `False` exists in the repo; the "smaller output" claim comes only from the provider docstring and the old changelog wording, not from a measurement.
- **Not answered by any source here:** whether consumers of `ensure_ascii=False` output can rely on a declared charset — the repo states UTF-8 as the expected JSON encoding in docstrings but does not document a charset guarantee for `jsonify` responses.
- `flask_mut2_i417ar2x/mutated_test.py` in the working directory is about subdomain URL matching and JSON serialization settings have no bearing on it; nothing in it contradicts or supports the above.
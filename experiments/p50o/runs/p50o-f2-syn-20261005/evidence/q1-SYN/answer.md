## Relationship between `ensure_ascii` and Unicode representation in serialized output

`DefaultJSONProvider.ensure_ascii` (a class attribute `= True` at `src/flask/json/provider.py:144`) is a **representation/transport-only switch, not a data transformation**. It decides whether non-ASCII code points are written into the JSON text as `\uXXXX` escape sequences or as literal characters; the decoded Unicode value is the same either way.

- **`True` (the default)** — every non-ASCII character is escaped: `app.json.dumps({"k": "\N{SNOWMAN}"})` → `'{"k": "\\u2603"}'`, and the result is ASCII-encodable (`True`), with `app.json.response()` body `b'{"k":"\\u2603"}\n'` (ASCII-only bytes). Measured.
- **`False`** — the original code points are emitted literally: `'{"k": "☃"}'`, not ASCII-encodable, response body `b'{"k":"\xe2\x98\x83"}\n'` (UTF-8 bytes of U+2603). Measured.
- **Same data on the wire either way** — `app.json.loads(body) == {"k": "☃"}` and round-trip holds in all four cases; `ensure_ascii` changes bytes, not values. Measured. The repository's own test states the mapping as `[(True, '"\\u2603"'), (False, '"\u2603"')]` (`tests/test_json.py:48-54`), and the executor's run of both parametrizations plus `tests/test_testing.py::test_environbuilder_json_dumps` passed.

**Where and how it acts.** It is applied at exactly one point — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` immediately before `json.dumps(obj, **kwargs)` (`src/flask/json/provider.py:176-179`). Two consequences that follow from that shape: the attribute is only a *default*, so a per-call `dumps(..., ensure_ascii=False)` overrides it (measured: attribute `True`, call-level `False` → literal `☃`); and the escape semantics themselves are delegated to stdlib `json.dumps`. Reach into observable output:

- JSON responses: `response()` (`provider.py:198-201`) passes only `indent`/`separators`, never `ensure_ascii`, so bodies inherit the attribute. Measured.
- Jinja `tojson`: `rv.policies["json.dumps_function"] = self.json.dumps` (`src/flask/app.py:422`), so template serialization honors the same setting.
- Request bodies: `EnvironBuilder(app, json=...)` takes the app's setting (`tests/test_testing.py:110-114`; docstring "EnvironBuilder.json_dumps() takes settings from the app").
- Outside an app context the attribute is **not consulted at all**: `src/flask/json/__init__.py:40-44` routes through `current_app.json.dumps` only when a context is active, otherwise `_json.dumps` with just `default` set. Measured: with the attribute `False`, module-level `flask.json.dumps` still escaped, while the same call inside an app context emitted literal `☃`. Observable output therefore still escapes by default outside a context, but the *configured* setting is lost — so the control's authority is app-context-scoped.

**The control is the current form of a removed config key.** `JSON_AS_ASCII` is listed among removed config keys (`CHANGES.rst:153-154`), and `docs/config.rst:441-443` (versionchanged 2.3) states those keys "were removed. The default `app.json` provider has equivalent attributes instead." A grep confirms no live `JSON_AS_ASCII` reader in `src/` or `tests/`; in `src/` the only `ensure_ascii` hits are the definition (`:144`), the docstring reference (`:171`) and the single `setdefault` consumer (`:177`).

### What this rests on
- `src/flask/json/provider.py:144, 145-147, 171, 176-179, 198-201`; `src/flask/sansio/app.py:230, 329`; `src/flask/app.py:422`; `src/flask/json/__init__.py:40-44` (read directly here or in retriever evidence).
- `tests/test_json.py:48-54`, `tests/test_testing.py:110-114`; docs `docs/config.rst:441-443`; `CHANGES.rst:153-154`.
- Executor's behavior matrix and the passing pytest run (`3 passed`, Python 3.13.9 / pytest 8.4.0, forced via `PYTHONPATH=src` because the venv's `flask` resolves to a different worktree through `flask.pth`).

### Still open / uncertainty kept
- That the escaping mechanism itself lives in CPython `json.dumps` is observed as behavior only; no stdlib source file was read in this worktree.
- No page under `docs/` documents `ensure_ascii`'s user-facing semantics — the docstring at `provider.py:145-147` is the only prose statement of intent available.
- The strictly-ASCII-bytes claim is measured for the snowman example and implied by `test_json_as_unicode`; no test asserts byte-level ASCII-only output generally.
- `\uXXXX` in output is not by itself proof this control acted: `tests/test_json.py:219-228` (`test_tojson_filter`, input `</script>`) expects `\u003c`-style escapes on ASCII characters, produced by Jinja's HTML-safe `tojson` policy rather than by `ensure_ascii`.
- No contradiction between the retriever and executor evidence; the retriever's flagged non-lead (`flask_mut2_i417ar2x/mutated_test.py`, subdomain routing, no JSON/ASCII code) was excluded as evidence by both.
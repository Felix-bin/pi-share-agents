## The control parameter is a representation switch on the serialized text, not a value or charset switch

The "ASCII-only encoding control parameter" is **`DefaultJSONProvider.ensure_ascii`**, declared as `ensure_ascii = True` at `src/flask/json/provider.py:144` — an attribute of the `app.json` provider, not a request/render argument and no longer a config key. Its declared semantics (`provider.py:145-148`): *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*

Its relationship to Unicode representation is exactly this: **it selects between two textual encodings of the same value.**

- `ensure_ascii = True` (the default): non-ASCII characters are replaced by `\uXXXX` escape sequences. `dumps("\N{SNOWMAN}")` returns the 8-character string `"\u2603"` — six ASCII code points `0x5c 0x75 0x32 0x36 0x30 0x33` — and **no U+2603 character occurs in the output at all**.
- `ensure_ascii = False`: the same input returns `"☃"`, code points `0x22 0x2603 0x22`, i.e. the literal character is emitted.

Both branches are asserted in the worktree: `tests/test_json.py:48-55` parametrizes `(True, '"\\u2603"')` / `(False, '"\u2603"')` on `app.json.dumps("\N{SNOWMAN}")`, and `tests/test_testing.py:110-114` asserts `EnvironBuilder.json_dumps()` takes the same setting from the app.

Three qualifiers matter for what the switch *is*:

1. **Representation only.** Both branches return a `str` (escaping is text-level; the `False` branch is not "bytes"), and both `json.loads` back to the same value (`'☃'`), observed at runtime. Neither branch changes what the data means.
2. **It is `setdefault`, so per-call wins.** `DefaultJSONProvider.dumps` (`provider.py:169-183`) does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` before `json.dumps(obj, **kwargs)`. Observed: attribute `True` plus `dumps(..., ensure_ascii=False)` → literal `☃`; attribute `False` plus `ensure_ascii=True` → `\u2603`. The attribute is a default, not a lock.
3. **It is not a charset control.** The flag never chooses an encoding for the response. Measured HTTP bodies: `True` → `b'"\\u2603"\n'` (9 ASCII bytes); `False` → `b'"\xe2\x98\x83"\n'` (6 bytes, `\xe2\x98\x83` = U+2603 in UTF-8). In both cases `Content-Type: application/json` with **no charset parameter**, and `grep charset src/flask` finds no match. So `ensure_ascii=False` produces literal Unicode only because the body is encoded UTF-8 downstream; the flag itself does not declare that (the mechanism lives in Werkzeug, which was not read here).

**Reach:** every public JSON path funnels through that one method — `flask.json.dumps` (`json/__init__.py:41`), `flask.json.dump` (`json/__init__.py:71` → `provider.py:49-58`), `jsonify` (`json/__init__.py:170` → `DefaultJSONProvider.response`, `provider.py:185+`), `EnvironBuilder.json_dumps` (`testing.py:88-94`), and the tagged session serializer (`json/tag.py:56` imports `..json.dumps`; `tag.py:321-323` calls it). So the single attribute governs Unicode representation for JSON responses, `flask.json` module helpers, test requests, and session cookies alike.

**Historical framing:** the control migrated from a config key to a provider attribute under its stdlib name. `CHANGES.rst:153-154` records `JSON_AS_ASCII` as removed and `285-288` as deprecated in favour of provider attributes; `grep -rn JSON_AS_ASCII src` returns nothing, while `docs/config.rst:419,441` still list it as the removed key whose "default `app.json` provider has equivalent attributes instead."

### What this rests on

- Retriever (handle `5be44b192510`): file/line evidence for `provider.py:144,145-148,169-183`, the entry-point funnel, `tests/test_json.py:48-55`, `tests/test_testing.py:110-114`, and the `CHANGES.rst` rename; no `ensure_ascii` occurrence anywhere in `docs/`.
- Executor (handle `5dddb040d303`): 3/3 targeted and 31/31 `tests/test_json.py` passes; code-point-level `dumps` output; per-call override observed; response bodies 9 vs 6 bytes with `application/json` and no charset; `jsonify` end-to-end 200; `grep -rn ensure_ascii src tests` finds `DefaultJSONProvider` as the only definer.
- I re-read `provider.py:138-192` and `tests/test_json.py:44-57` and confirmed both quoted blocks.
- Provenance caveat carried from the executor: `.venv/*.pth` makes bare `import flask` resolve to a different worktree's source; the runtime numbers hold for *this* worktree only because they were taken with `PYTHONPATH=src`.

### What remains open

- **Contradiction / ranking mismatch (reported, not resolved by picking a side):** the corpus ranking put `src/flask/json/tag.py` chunks first, but `tag.py` contains no `ensure_ascii` occurrence — its only link is the `..json.dumps` import. Anyone following the ranking alone inspects the wrong file; the direct evidence is `provider.py` plus `tests/test_json.py`.
- **Not established:** which component performs the UTF-8 encoding of the response body (inferred from `Response` subclassing and `JSONProvider.dump`'s "Should use the UTF-8 encoding to be valid JSON" docstring; Werkzeug source in this worktree was not read).
- **Not established:** behaviour toward non-UTF-8 clients, any header-level charset negotiation, and whether the default should change — the last is a product decision that no collected evidence takes.
- **Documentation gap:** no prose page in `docs/` states the ASCII/Unicode semantics; the provider docstring and the two tests are the only in-worktree statements of it.
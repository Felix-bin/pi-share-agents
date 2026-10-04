## Answer

**The parameter.** `DefaultJSONProvider.ensure_ascii = True` (`src/flask/json/provider.py:144`, verified in-tree), docstring: "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."

**The relationship is a default, not a hard switch.** `DefaultJSONProvider.dumps` forwards it with `setdefault`:
```
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```
(`provider.py:176-179`; `import json` at `:5` is stdlib `json`.) Because it is `setdefault`, an explicit per-call `ensure_ascii=` kwarg takes precedence over `app.json.ensure_ascii`. Measured, both directions: attribute `True` + call kwarg `False` → `len=20, isascii=False`; attribute `False` + call kwarg `True` → `len=35, isascii=True`.

**Effect on Unicode representation (measured, exit 0, this tree's own `.venv`: python 3.13.9, flask 3.2.0.dev0, werkzeug 3.1.3, itsdangerous 2.2.0; workspace-default python 3.14 has no flask installed and fails `conftest` import — exit 4).**

| flag | serialized `dumps("\N{SNOWMAN}")` | len | UTF-8 bytes | `isascii()` |
|---|---|---|---|---|
| `True` (default) | `'"\u2603"'` — literal backslash-u escape | 8 | 8 | `True` |
| `False` | `'"☃"'` — the U+2603 character itself | 3 | 5 | `False` |

Dict payload `{"name": "café ☃ €"}` under `app.app_context()`: flag `True` → `len=35 bytes=35 isascii=True`, repr `'{"name": "caf\\u00e9 \\u2603 \\u20ac"}'`; flag `False` → `len=20 bytes=25 isascii=False`, repr `'{"name": "café ☃ €"}'`. So disabling it is smaller in this sample (25 vs 35 bytes), consistent with the docstring's "better performance and size".

**Representation changes, meaning does not.** Both encodings are the same JSON string value; the escaped form is pure-ASCII on the wire while the raw form carries multibyte UTF-8. In-tree pins confirm exactly this: `tests/test_json.py:48-54` parametrizes `(True, '"\\u2603"')` / `(False, '"\u2603"')` and asserts `app.json.dumps("\N{SNOWMAN}")` against it; `tests/test_testing.py:110-114` sets `app.json.ensure_ascii = False`, builds `EnvironBuilder(app, json="\u20ac")` and asserts the input stream bytes decoded as UTF-8 equal `'"\u20ac"'` — i.e. non-ASCII transported as UTF-8 bytes, not as `\u20ac`, via `src/flask/testing.py:88-94` → `self.app.json.dumps`. Both tests were run and passed (`-k as_unicode` → 2 passed; `-k json_dumps` → 1 passed).

**Who reaches the flag.** `flask.json.dumps` delegates to `current_app.json.dumps` *only if an app context is active* (`src/flask/json/__init__.py:40-44`, verified); otherwise the stdlib branch runs and `app.json.ensure_ascii` has no effect — measured: module-level `flask.json.dumps(dict)` with no app context → `len=35 bytes=35 isascii=True` (stdlib default), identical to stdlib `json.dumps`. `TaggedJSONSerializer.dumps` passes only `separators` (`src/flask/json/tag.py:321-323`), so it inherits the flag from the provider — measured 34 chars/34 bytes ASCII-escaped vs 19 chars/24 bytes raw — and inherits `sort_keys=True` from the same chain.

**Session path inherits, does not bypass (measured end-to-end).** With the flag `True`, the cookie's urlsafe-b64-decoded pre-payload is `b'{"k":"\\u2603"}'` (13 bytes, pure ASCII); with `False`, `b'{"k":"\xe2\x98\x83"}'` (10 bytes, raw UTF-8); both `get_signing_serializer(app).load_payload(...)` → `{'k': '☃'}`. Since the session cookie is base64 in either case (itsdangerous `URLSafeSerializerMixin` docstring: it "will also base64 encode the string so that it can safely be placed in a URL"), escapes are never literally visible on the wire — the flag changes the pre-base64 intermediate and hence cookie length, not readability. This is a labelled inference from the library docstring plus measured payloads; no test in `tests/` pins the session path against `ensure_ascii`.

**Version/scope of the finding.** `.git/` **does** exist in this tree, contradicting the plan's "no local SHA" assumption: `git rev-parse HEAD` → `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, `git log -1` → `Merge branch 'stable'` 2025-06-12, `git describe --tags` → **`3.1.1-30-g85c5d93c`** (no tag at HEAD), consistent with `pyproject.toml:3` `version = "3.2.0.dev"`. So every measurement above is established **for this 3.2.0.dev snapshot only**, not for any released Flask. Supporting docs: `docs/api.rst:265-267` autoclasses `DefaultJSONProvider` (the docstring is the published documentation), and `docs/config.rst:440-443` records that `JSON_AS_ASCII` was removed in 2.3 with "equivalent attributes instead".

**Task coverage.** Answered: the parameter's identity/default, its exact forwarding semantics, its effect on the serialized representation (escaped ASCII vs raw UTF-8), the size consequence, the app-context gate, the session path, and the in-tree tests that pin it. Open: behaviour on released Flask versions (no such interpreter present; installing one was not taken); itsdangerous settings beyond default; the session path with no active app context (the cookie test always ran inside a request context — the fallback branch was exercised only at module level); and `flask.__version__` raises `AttributeError` in this snapshot (use `importlib.metadata.version("flask")`), plus `TaggedJSONSerializer().dumps(TagDict(...))` now raises `TypeError` at `provider.py:121` (plain `dict` required).

Could not persist this to the corpus from this role (no memory-write tool); the executor's measured finding is already recorded as memory `2479e3a28137`.

**Rests on:** `src/flask/json/provider.py:144-148, 169-179, 201-215`; `src/flask/json/__init__.py:13, 40-44`; `src/flask/json/tag.py:56, 321-323`; `src/flask/sessions.py:287, 314, 330, 387`; `src/flask/testing.py:88-94`; `tests/test_json.py:48-54`; `tests/test_testing.py:110-114`; `pyproject.toml:3`; `docs/api.rst:236-238, 265-267`; `docs/config.rst:440-443`; itsdangerous `.venv/.../url_safe.py:13-16`; executor measurements at HEAD `85c5d93c` (`git describe` = `3.1.1-30-g85c5d93c`) under python 3.13.9 / flask 3.2.0.dev0, exit 0; shared memory `2479e3a28137`.

**Still open:** released-version behaviour; itsdangerous compression beyond default; session serialization with no app context; which Flask version should be treated as authoritative for the write-up (no released tag in the tree).
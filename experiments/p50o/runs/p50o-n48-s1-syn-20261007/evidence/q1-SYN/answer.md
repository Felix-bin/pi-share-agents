## Answer

The control parameter is `ensure_ascii`, an attribute of `DefaultJSONProvider`. It is a two-valued switch over the *representation* of non-ASCII characters in the serialized JSON string: `True` (the default) replaces each non-ASCII character with its `\uXXXX` escape sequence; `False` lets the literal Unicode code point stay in the string.

- Source of truth: `src/flask/json/provider.py:144` — `ensure_ascii = True` inside `class DefaultJSONProvider(JSONProvider)` (opens at line 124). Its docstring (lines 145–148) states the purpose verbatim: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*
- How it reaches the output: `dumps` (provider.py:165–180) does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (line 177) and then `return json.dumps(obj, **kwargs)` (line 180). The value is passed through unchanged — no inversion or coercion.
- Because it is `setdefault`, the attribute is a *default*, not a hard override: an explicit `ensure_ascii=` keyword on `app.json.dumps` — or on `flask.json.dumps`, which delegates to the current app's provider (`src/flask/json/__init__.py:42-44`) — takes precedence.
- It is read at dump time on an already-constructed provider, not fixed at construction. Both exercising tests mutate the attribute after the app exists and observe the effect on the next call.

Observed correspondence, behavior-verified in this worktree (`flask 3.2.0.dev0`, Python 3.13.9, stdlib `json` from CPython 3.13.9):

| `ensure_ascii` | `app.json.dumps("\N{SNOWMAN}")` | result |
|---|---|---|
| `True` (default) | `'"\\u2603"'` — 8 chars, `str.isascii()` True | escape sequence only |
| `False` | `'"☃"'` — 3 chars, `str.isascii()` False | literal code point |

The euro sign behaves identically (`'"\\u20ac"'` vs `'"€"'`). Both parametrizations of `tests/test_json.py::test_json_as_unicode` (`tests/test_json.py:47-54`) pass, and `tests/test_testing.py::test_environbuilder_json_dumps` (`tests/test_testing.py:110-114`, via `src/flask/testing.py:88-94`) independently confirms the same mapping through the `EnvironBuilder` path. Purely ASCII input is unaffected: `app.json.dumps({"a": 1})` → `'{"a": 1}'` under either setting.

Scope of the relationship:
- It governs only the *serialized string* produced by `dumps`. `loads` (provider.py:182-188) is untouched, so it has no effect on parsing — a `"\u2603"` escape and a literal `☃` deserialize to the same character.
- `grep ensure_ascii src/` returns exactly three hits, all in `provider.py`: line 144 (assignment), 171 (the `dumps` docstring), 177 (the use). `JSONProvider` (provider.py:19) has no such attribute; `sansio/app.py:329` sets `self.json: JSONProvider = self.json_provider_class(self)`. So the parameter belongs to the *default* provider, and an app installing a custom `json_provider_class` may not expose it at all.
- Naming lineage, not behavior: `docs/config.rst:441-444` (`.. versionchanged:: 2.3`) records that `JSON_AS_ASCII` and peers were removed and "the default `app.json` provider has equivalent attributes instead" (same at `CHANGES.rst:153,286`). `docs/api.rst:265` autodocs `DefaultJSONProvider`, so the docstring above is what the published API docs show.

One caution on a nearby test, so it is not misread as evidence about this parameter: `tests/test_json.py:211-222` (`test_tojson_filter`) expects `\u003c`/`\u003e` escapes for `"</script>"`. Those are ASCII characters, which `ensure_ascii` never touches; that escaping comes from the Jinja `tojson` filter's HTML-safety behavior.

## Basis and open points

Rests on: `src/flask/json/provider.py` lines 124–188 (re-read directly, at HEAD); `tests/test_json.py:47-54`; `tests/test_testing.py:110-114`; `src/flask/json/__init__.py:42-44`; `src/flask/testing.py:88-94`; `docs/config.rst:441-444`; `docs/api.rst:265`; plus the executor's pinned-import test runs. The retriever's source reading and the executor's executed results agree on every shared claim; no contradiction was found.

Open / not established:
- Which provider a *given* app actually installs — a custom `json_provider_class` need not carry `ensure_ascii`.
- Anything downstream of the string: no HTTP-layer byte-encoding check was run (the executor's own caveat). The end-to-end statement is therefore about `dumps` output, not about response bytes.
- Environment caveat for reproducing: the bare `python` on PATH lacks `werkzeug`; results came from `PYTHONPATH=src .venv/Scripts/python.exe`, because that venv's editable Flask points outside this worktree and a run without pinning the import path can pass while saying nothing about this source.
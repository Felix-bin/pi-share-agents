## Relationship: `ensure_ascii` is the single switch that decides whether Unicode survives as literal characters or is escaped to ASCII

In this framework the ASCII-only encoding control parameter in the JSON serialization provider is `ensure_ascii`, a class attribute of `DefaultJSONProvider` (`src/flask/json/provider.py:144`, value `True`). It governs Unicode representation in serialized output as follows:

- **`ensure_ascii = True` (the default)** — every non-ASCII code point is emitted as a `\uXXXX` escape sequence, so the serialized JSON text is pure ASCII. The provider's own docstring states the intent: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* (`src/flask/json/provider.py:145-148`).
- **`ensure_ascii = False`** — the literal Unicode characters are emitted instead, keeping output smaller but requiring the consumer to handle them.

The exact input→output mapping is pinned by a parameterized test, `tests/test_json.py:48-54`, which sets `app.json.ensure_ascii` and asserts on `app.json.dumps("\N{SNOWMAN}")`: `True` → `'"\\u2603"'` (six ASCII characters: backslash, `u`, `2`, `6`, `0`, `3`), `False` → `'"☃"'` (the literal U+2603 character). A second test confirms the same switch on a different code path — with `app.json.ensure_ascii = False`, `EnvironBuilder(app, json="\u20ac")` produces input bytes that decode to `'"€"'` (`tests/test_testing.py:110-114`).

**How the parameter reaches output.** `DefaultJSONProvider.dumps` forwards it to stdlib `json.dumps` as a default keyword argument: `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`src/flask/json/provider.py:177`). Two consequences follow directly from `setdefault`: the class attribute supplies the value on every call, and a caller-supplied `ensure_ascii=` keyword overrides it per call. The HTTP path does not bypass this — `response()` assembles `dump_args` containing only `indent` or `separators`, calls `self.dumps(...)`, and wraps the resulting string in the response class (`src/flask/json/provider.py:204-217`), so the attribute is the sole control over escaping for HTTP output. Because it is a plain class attribute, it is also overridable per app instance, as the tests do (`app.json.ensure_ascii = ...`).

**Scope of that control.** The parameter belongs to `DefaultJSONProvider` only — a repo-wide search for `ensure_ascii` returns just `src/flask/json/provider.py:144,171,177`, `tests/test_json.py:52`, `tests/test_testing.py:112`; the abstract `JSONProvider` base does not define it. The module-level `flask.json.dumps` consults the app provider only when a current app exists (`src/flask/json/__init__.py:42-44`); with no app context it falls back to stdlib `json.dumps`, so the app-level setting has no effect there.

**Corroboration and notable gaps.** `CHANGES.rst:1192-1195` records adding the "non-ascii encoded JSON" option, disabled by default — consistent with the escaping default and the size/compatibility rationale. No contradiction was found between the docstring, the code, the two tests, and the changelog. Not established: no documentation page mentions the parameter (a repo-wide search finds no hit under `docs/`); the final hop from the literal-Unicode string returned by `response()` to wire bytes (the response class's charset handling) was not read and is inferred rather than observed, and that code lies outside this worktree; and no check of uncommitted edits to `provider.py` was possible.

### What this rests on
- `src/flask/json/provider.py:144-148` (`ensure_ascii = True` + docstring), `:170-179` (`setdefault` forwarding), `:204-217` (`response()` path) — read directly.
- `tests/test_json.py:48-54` and `tests/test_testing.py:110-114` — read directly; both assert the escape-vs-literal mapping.
- `src/flask/json/__init__.py:42-44` (app-context gate) and `CHANGES.rst:1192-1195` (rationale/default) — read directly. Repo-wide grep confirms `ensure_ascii` occurs nowhere else, including `docs/`.

### Still open
- Whether `ensure_ascii` should default to `False`, or be exposed as an app-config option — product/API choices, not facts the evidence decides.
- The charset hop from text response to wire bytes when `ensure_ascii=False` — inferred, not observed.
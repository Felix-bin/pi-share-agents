## `ensure_ascii` and Unicode in serialized output

`DefaultJSONProvider.ensure_ascii` is a boolean class attribute (default `True`) that decides whether non-ASCII characters in serialized JSON are **escaped into ASCII `\uXXXX` sequences** or **emitted as literal Unicode characters**. It is a serialization-only control: set `True`, `"☃"` becomes the six characters `"\u2603"`; set `False`, it stays `'"☃"'`.

**Where the switch lives and how it bites**

- Declared `ensure_ascii = True` at `src/flask/json/provider.py:144` on `DefaultJSONProvider` (class at line 124), with docstring 145-148: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* It is a class attribute, not a config key.
- It reaches output through a single line inside `dumps` (`provider.py:166-179`): `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` at line 177, then `return json.dumps(obj, **kwargs)` at line 179. All Unicode-shaping therefore happens in stdlib `json.dumps`; the provider only supplies a default.
- Because the injection is `setdefault`, a per-call keyword wins: `app.json.dumps(obj, ensure_ascii=False)` produces literal characters even when the attribute is `True`, and vice versa. *Runtime-confirmed by the executor in both directions* (attr `True` + kwarg `False` → `'"☃"'`; attr `False` + kwarg `True` → `'"\\u2603"'`). No test in the suite pins this; it rests on the `setdefault` form plus that runtime observation.
- No `JSON_AS_ASCII` config key exists in this checkout — it was removed (listed among removed keys at `CHANGES.rst:153-154`, and as moved to provider attributes at `CHANGES.rst:285-287`; repeated in `docs/config.rst:419-420, 441-442`). The provider attribute is the only ASCII switch, and `docs/` contains no `ensure_ascii` mention at all.

**Observable behavior (runtime-confirmed in this checkout's `.venv`)**

| probe | `ensure_ascii=True` | `ensure_ascii=False` |
|---|---|---|
| `"\N{SNOWMAN}"` U+2603 | `'"\\u2603"'`, `isascii() is True` | `'"☃"'`, `isascii() is False` |
| `"\u4e2d\u6587"` | `'"\\u4e2d\\u6587"'` | `'"中文"'` |
| `"caf\u00e9"` | `'"caf\\u00e9"'` | `'"café"'` |

The same split is pinned statically by `tests/test_json.py:48-54` (`app.json.dumps("\N{SNOWMAN}")` equals `'"\\u2603"'` for `True`, `'"\u2603"'` for `False`) and, on the app-sourced path, by `tests/test_testing.py:110-114` (euro sign U+20AC, `EnvironBuilder` reading `app.json`). Both tests pass in this checkout (`3 passed`, including the parametrized pair).

**The relationship is representational, not semantic.** Escaping changes only the bytes/text of the serialized form; the value is preserved. Executor runs show `app.json.loads(escaped) == original` and `app.json.loads(literal) == original` are both `True` for all three probes. The two outputs are two encodings of the same JSON value — the control parameter selects presentation, matching the docstring's framing ("more compatible with some clients" vs "better performance and size"). At the response layer, `jsonify`/`response` sets mimetype `application/json` (class attribute `provider.py:163`) in both modes; the `False` body is emitted as UTF-8 bytes (`b'"\xe2\x98\x83"\n'`), and the `Content-Type` carries no charset parameter — the literal-Unicode mode therefore relies on UTF-8 being assumed by the client, which is what the `True` default hedges against.

**Scope: serialization only.** `loads` (`provider.py:181-187`) is `return json.loads(s, **kwargs)` and never references the attribute; runtime introspection confirms `"ensure_ascii" in getsource(DefaultJSONProvider.loads)` is `False`. It affects `dumps` (166-179), the base `dump` (which delegates at `provider.py:57`), `DefaultJSONProvider.response` (line 214) and base `response` (line 105), `jsonify` (`src/flask/json/__init__.py`), and `EnvironBuilder.json_dumps` (`src/flask/testing.py:88-94`, whose docstring says serialization follows the config of the builder's `app`). Deserialization of escaped and literal forms is identical, so the parameter cannot be observed on the read side.

**App-context dependency of the module-level helpers.** `flask.json.dumps`/`dump` branch on `if current_app:` (`src/flask/json/__init__.py:40-44`, `70-74`): with an app, the provider attribute applies; without one they fall through to stdlib `json.dumps`/`json.dump`, where Python's own `ensure_ascii=True` default governs and the provider attribute is irrelevant. Runtime-confirmed: no-app → `'"\\u2603"'`; in-app with attribute `False` → `'"☃"'`.

### What this rests on

- Source: `src/flask/json/provider.py:57, 144-148, 163, 166-179, 181-187, 189-215`; `src/flask/json/__init__.py:12-44, 47-74, 77-112`; `src/flask/testing.py:88-94`.
- Static pins: `tests/test_json.py:48-54`, `tests/test_testing.py:110-114`; removal of the config key at `CHANGES.rst:153-154, 285-287`, `docs/config.rst:419-420, 441-442`.
- Executed: `.venv/Scripts/python.exe` (CPython 3.13.9, Windows layout) with `PYTHONPATH=src` forced so this worktree imports, covering `app.json.dumps` both modes × three probes, `loads` round-trip, per-call override, `jsonify` body/bytes/mimetype, app-less fallback, and the two pinning tests (3 passed).

### Still open / caveats

- **Not established:** no custom `JSONProvider` subclass (overriding `dumps` or `ensure_ascii`) was examined; only `DefaultJSONProvider` was exercised.
- **Source-inferred, not prose-stated:** no docstring or comment sentence declares the attribute serialize-only; the scope claim rests on `loads` not referencing it (runtime-checked structurally, not by an explicit statement).
- **Test gap:** no test pins the per-call override — the runtime runs confirm it, but nothing in `tests/` asserts it.
- **Environment trap for any follow-up run:** the venv is Windows-layout (`.venv/Scripts/`, not `.venv/bin/`), and its editable `flask` resolves to a different path outside this worktree, so bare `import flask` does not load this checkout unless `PYTHONPATH=src` is set.
- The executor also noted an unrelated file `flask_mut2_i417ar2x/mutated_test.py` in the working directory; it touches nothing in this answer.
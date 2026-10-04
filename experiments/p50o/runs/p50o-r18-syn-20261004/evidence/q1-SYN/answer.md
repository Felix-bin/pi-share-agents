## The relationship

The ASCII-only encoding control is **`DefaultJSONProvider.ensure_ascii`** — a class attribute of the default JSON serialization provider, declared at `src/flask/json/provider.py:144` with default value `True` and the verbatim docstring "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." (`provider.py:144-147`). It is not declared on the abstract base `JSONProvider` (`provider.py:17-54`); it exists only on `DefaultJSONProvider`. Its relationship to Unicode representation is a **direct, binary switch on how non-ASCII characters appear in serialized output**:

| `ensure_ascii` | Serialized output for `'☃ €'` | Output encoding |
|---|---|---|
| `True` (default) | `'"\u2603 \u20ac"'` — escapes, result `isascii()` is `True` | pure ASCII text/bytes |
| `False` | `"☃ €"` literally | literal characters, UTF-8 bytes `b'"\xe2\x98\x83 \xe2\x82\xac"'` |

These two values were not only read from test expectations but executed against this worktree's source (executor): a default `Flask` app resolves to `app.json.ensure_ascii is True`, and the three cited tests pass (`test_json_as_unicode[True-"\\u2603"]`, `test_json_as_unicode[False-"\u2603"]`, `test_environbuilder_json_dumps` — `3 passed in 0.08s`, `tests/test_json.py:47-54`, `tests/test_testing.py:110-114`).

**How the parameter reaches the serializer.** `DefaultJSONProvider.dumps` (`provider.py:166`) forwards the attribute to the standard library at `provider.py:177` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` — immediately before the handoff `json.dumps(obj, **kwargs)` at `provider.py:179`; the method's own docstring (`provider.py:169-171`) names `:attr:`ensure_ascii`` as a source of parameter defaults. Because the forwarding uses `setdefault`, an explicit `ensure_ascii=` keyword passed to `dumps()` or `response()` wins over the attribute: execution confirmed `dumps('☃', ensure_ascii=False)` returns `'"☃"'` even when the attribute is `True`.

**It governs more than `dumps`.** `src/flask/json/__init__.py` routes module-level `dumps`/`jsonify` to `current_app.json.dumps` / `current_app.json.response` under an app context, and `DefaultJSONProvider.response` calls `self.dumps(...)`, so `jsonify` and dict-returning views inherit the same switch. Observed on the response path: `app.json.response({'k':'☃'})` yields `b'{"k":"\\u2603"}\n'` when `True` and `b'{"k":"\xe2\x98\x83"}\n'` when `False`.

**One output-side detail worth stating precisely** (executor's correction): in `False` mode the body carries literal UTF-8 *bytes*, but the `Content-Type` header remains `application/json` with **no** charset parameter — the UTF-8 encoding is observed in the bytes, not declared by the response header.

**Concrete cost of the default**, measured once (executor): 1000 × U+2603 under `True` produces 6002 chars / 6002 bytes; under `False`, 1002 chars / 3002 bytes — escaping roughly doubles byte size and multiplies character count ~6× for non-ASCII-heavy payloads.

**Scope of the parameter in this tree.** A repo-wide `grep ensure_ascii` (excluding `.venv`) returns exactly five lines in three files: `src/flask/json/provider.py:144,171,177`, `tests/test_json.py:52`, `tests/test_testing.py:112`. There is no config key, environment override, or second definition — the relationship is stated only by the attribute docstring, the forwarding line, and those two tests (re-verified here by grep and by reading `provider.py:140-184`).

## What this rests on, and what is open

- **Rests on:** `src/flask/json/provider.py:144-147` (declaration + docstring), `:166-179` (forwarding and handoff, re-read directly); `src/flask/sansio/app.py:230,329` (default-app resolution); `src/flask/json/__init__.py` (jsonify/dumps delegation); `tests/test_json.py:47-54` and `tests/test_testing.py:110-114` (executed green); executor's direct `dumps`/`response` observations and size measurement; repo-wide grep (5 occurrences, 3 files).
- **Not established:** any *wall-clock* performance benefit — the docstring's "better performance and size" is an unmeasured claim in this tree, no test asserts it, and only the size half was measured once. Also not established: any user-facing documentation, changelog entry, or config surface for `ensure_ascii` — none exists here (grep found none), so the parameter's contract is documented only by the attribute docstring and the two tests.
- **Environment caveat on the executed results:** `.venv/Lib/site-packages/flask.pth` in this worktree points at a different worktree's `src`, so a plain `import flask` loads foreign source; the executor forced this worktree's source via `PYTHONPATH=<this worktree>/src` and verified `flask.__file__` resolved into this worktree before running anything. The executed observations therefore describe this worktree's code.
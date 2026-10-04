# The relationship: `app.json.ensure_ascii` is a representation switch on the serialized text, not a filter on which characters can be serialized

**What the parameter is.** The control is the class attribute `ensure_ascii = True` on `DefaultJSONProvider` (`src/flask/json/provider.py:144`). A grep for `ensure_ascii` across the worktree returns exactly one definition site, so the base `JSONProvider` class declares no such attribute; the control lives only on the default provider. Its docstring states its meaning directly: "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."

**How it reaches output.** `DefaultJSONProvider.dumps` forwards the attribute to the stdlib serializer under the same keyword name the stdlib uses, as a default rather than a mandate (`src/flask/json/provider.py:176-179`):

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```

Because it is a `setdefault`, a caller-supplied `ensure_ascii=` kwarg overrides the attribute (confirmed by execution). Response bodies take the same path: `DefaultJSONProvider.response` serializes through `self.dumps(obj, **dump_args)` (lines 183-206), so `jsonify` and JSON response bodies are shaped by this attribute too. The docs for the method name it explicitly as one of the defaults set from provider attributes (`provider.py:171`).

**What the setting actually changes — serialized form only.** Both the existing tests and the executed run agree:

| Setting | `app.json.dumps("\N{SNOWMAN}")` | ASCII-only? | Wire bytes |
|---|---|---|---|
| `True` (in-repo default) | `'"\\u2603"'` — six ASCII characters | `isascii() == True` | `b'"\\u2603"'` |
| `False` | `'"☃"'` — the literal U+2603 character | `isascii() == False` | `b'"\xe2\x98\x83"'` (UTF-8) |

The same holds for responses: `app.json.response({"s": "\N{SNOWMAN}"}).get_data()` gives `b'{"s":"\\u2603"}\n'` with `True` and `b'{"s":"\xe2\x98\x83"}\n'` with `False`. The two forms denote the *same* code point — a `\uXXXX` escape and the literal character decode identically — which is exactly why `tests/test_json.py:47-54` compares only the serialized string. So the parameter is not about which characters may be serialized or whether Unicode is supported at all; it is about whether the serialized representation is pure ASCII (escaped) or carries the raw characters (UTF-8 on the wire). Corroboration exists on a second path with a different value: `tests/test_testing.py:110-114` sets `ensure_ascii = False` and asserts the `EnvironBuilder` JSON input stream reads `'"\u20ac"'` as raw UTF-8.

**Scope of the control.** It is a `DefaultJSONProvider` feature, not a global one. Module-level `flask.json.dumps` injects no `ensure_ascii` default when no app context is active (`src/flask/json/__init__.py:41-42`); the stdlib default of `True` then applies, which happens to coincide with the provider default but does not come from the provider. The historical config key expressing the same control, `JSON_AS_ASCII`, was removed in 2.3 and is documented as replaced by the equivalent provider attributes (`docs/config.rst:441-443`; `CHANGES.rst:153-154`, `285-288`).

**Answer to the task's question:** the control parameter governs the encoding *representation* of non-ASCII characters in serialized JSON output — `True` (the in-repo default) makes the serializer emit `\uXXXX` escape sequences so the output is ASCII-only; `False` makes it emit the literal Unicode characters, which reach the wire as UTF-8. It does not change the decoded value, and it is only the default: a per-call keyword argument can override it for a single serialization.

## What this rests on

- `src/flask/json/provider.py:144-147` (attribute + docstring), `:176-179` (setdefault pass-through), `:183-206` (response path) — re-read and confirmed in this worktree.
- `src/flask/json/__init__.py:41-42` — module-level `dumps` with no app context injects no `ensure_ascii` default.
- Executed run (venv python 3.13.9 / pytest 8.4.0) against this worktree's `src`: `tests/test_json.py::test_json_as_unicode` (both parametrizations) and `tests/test_testing.py::test_environbuilder_json_dumps` → 3 passed in 0.05s, plus direct `dumps`/`response` observations and the per-call override.
- `docs/config.rst:441-443`, `CHANGES.rst:153-154`, `285-288` — removal of `JSON_AS_ASCII` and its stated replacement.

## Still open / not established

- No size or performance measurement exists in-repo; the docstring's "better performance and size" is a stated trade-off, not a verified quantity, and the executor run measured none.
- Only `DefaultJSONProvider` defines the attribute in this worktree, so behavior of any alternate or third-party provider is not established.
- Whether the default should be changed for a given deployment is a product decision the evidence does not settle.
- Verification detail: the project's `.venv` `.pth` pointed at a *different* checkout's `src`, so the passing run required `PYTHONPATH=<worktree>/src`; the results above therefore describe this worktree's source, which the executor confirmed via `samefile` before running.
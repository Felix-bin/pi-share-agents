## The control parameter ↔ Unicode output relationship

The ASCII-only control is `DefaultJSONProvider.ensure_ascii`. It is a **class-level attribute of the JSON provider, defaulting to `True`** (`src/flask/json/provider.py:144`, on the class opened at line 123), and its inline docstring states the relationship directly: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* (`provider.py:145-148`).

**How it becomes output.** `DefaultJSONProvider.dumps` feeds it to the standard library serializer **only as a default**, not as a hard setting:

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)   # provider.py:177
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)                        # provider.py:179
```

So the attribute sets the fallback for `json.dumps`, and any caller passing an explicit `ensure_ascii=` overrides it. The docstring of `dumps` says the parameter defaults are taken from the `default`, `ensure_ascii`, and `sort_keys` attributes (`provider.py:169-171`).

**What the two values actually produce.** With `True`, every non-ASCII code point is emitted as a `\uXXXX` escape; with `False`, the character is emitted literally as multi-byte UTF-8. Executed against this checkout's own source (`PYTHONPATH=<worktree>/src`, and `flask.__file__` confirmed to point at `src/flask/__init__.py` — a stale editable `flask.pth` otherwise loads a different checkout):

| `ensure_ascii` | `app.json.dumps("\u2603")` | response body |
|---|---|---|
| `True` (default) | `'"\\u2603"'` — 8 bytes, pure ASCII | `b'{"snowman":"\\u2603"}\n'` |
| `False` | `'"\u2603"'` — 3 chars, utf8 `b'"\xe2\x98\x83"'` | `b'{"snowman":"\xe2\x98\x83"}\n'` |

An explicit kwarg beats the attribute in both directions: attribute `True` + `dumps(..., ensure_ascii=False)` → literal snowman; attribute `False` + `dumps(..., ensure_ascii=True)` → escaped. The behaviour is pinned in-tree by `tests/test_json.py:48-54` (parametrized `(True, '"\\u2603"')` / `(False, '"\u2603"')` around `app.json.dumps("\N{SNOWMAN}")`) and independently by `tests/test_testing.py:110-114` (`EnvironBuilder` with `app.json.ensure_ascii = False` and `\u20ac`, decoded as UTF-8) — so the effect is not an artefact of one call site. All three tests pass (`3 passed in 0.10s`, exit 0, Python 3.13.9 / pytest 8.4.0).

**Scope of the effect.** The flag is per-application, not global: `json_provider_class: type[JSONProvider] = DefaultJSONProvider` (`src/flask/sansio/app.py:230`) and `self.json: JSONProvider = self.json_provider_class(self)` (`app.py:329`), which is why both tests simply assign `app.json.ensure_ascii = ...`. It reaches ordinary application output, not just direct `dumps` calls: `provider.response` calls `self.dumps(...)` (`provider.py:214`) and `app.py:1230-1231` routes `dict`/`list` view returns through `self.json.response(rv)`; `jsonify` goes through `current_app.json.response` (`json/__init__.py:172`); module-level `flask.json.dumps` returns `current_app.json.dumps(...)` inside an app context (`json/__init__.py:40-44`); and `EnvironBuilder.json_dumps` returns `self.app.json.dumps(obj, **kwargs)` (`testing.py:89-94`). One further consumer passes **no** `ensure_ascii` argument — `TaggedJSONSerializer.dumps` calls `flask.json.dumps(self.tag(value), separators=(",", ":"))` (`json/tag.py:322-324`), and that serializer is the session serializer (`sessions.py:287` `session_json_serializer = TaggedJSONSerializer()`, used at `sessions.py:387`) — so inside an app context it inherits the app's value.

**No documentation restates it.** A search for `ensure_ascii` across the repository matches only `src/flask/json/provider.py`, `tests/test_json.py`, and `tests/test_testing.py`; nothing under `docs/` or `CHANGES` mentions it. The relationship described above therefore rests on the inline docstring plus the behavior, not on any external documentation.

## What this rests on, and what is open

- Rests on: direct reading of `src/flask/json/provider.py` (144, 145-148, 166-179, 194-215), `tests/test_json.py:48-54`, the call-chain sites cited above, and the executor's runtime run against this worktree's `src` (attribute toggle, response-body bytes, and the three named tests passing). The path prefix `flask/src/...` used in corpus ranking does not exist here; the actual layout is `src/flask/...` and `tests/...`.
- Open / not established: (a) the session-cookie path is traced only to `json/tag.py:322-324` and `sessions.py:387` — the exact serialized cookie bytes were not observed, so whether escaping is visible in the cookie is unverified; (b) no documentation or changelog statement of the relationship exists to corroborate the docstring; (c) nothing was mutated — the source was not edited, so the flag's effect is verified against the current checkout only; (d) the observed runtime behaviour is from the stdlib `json` backend, i.e. `DefaultJSONProvider` specifically; alternate provider implementations were not exercised.
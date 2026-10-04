## Relationship: `ensure_ascii` is an output-side switch between escaped and literal non-ASCII characters — it changes the representation, never the data

The provider attribute `app.json.ensure_ascii` decides how non-ASCII characters are *written* into the serialized JSON text; it has no effect on what value is serialized or on parsing.

**Where the control lives and what it does.** `DefaultJSONProvider` declares `ensure_ascii = True` with the docstring "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." (`src/flask/json/provider.py:144`).

**How it reaches the output.** `DefaultJSONProvider.dumps` forwards it as a default keyword argument:

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```

(`src/flask/json/provider.py:175-178`). So the provider attribute is a *default*: an explicit `ensure_ascii=` passed to `app.json.dumps(...)` or `flask.json.dumps(...)` overrides it for that call, and the character-level escaping semantics themselves are the standard library's, not re-implemented here.

**The two representations, as pinned by the repo's own test.** `tests/test_json.py:49-54` parametrizes exactly this relationship:

| `app.json.ensure_ascii` | serialized output for `"\N{SNOWMAN}"` |
|---|---|
| `True` (the default) | `"\u2603"` — six ASCII characters, zero non-ASCII bytes |
| `False` | `"☃"` — the character itself, kept literally in the string |

The test asserts on the *string returned by `dumps`*, so the relationship is at the character level: `True` guarantees an ASCII-only serialized string; `False` preserves the original Unicode characters in it.

**It reaches responses too, because `response()` serializes through the same path.** `JSONProvider.response()` calls `self.dumps(obj, ...)` (`src/flask/json/provider.py:100-103`; the `DefaultJSONProvider` override at `:186-220`), and `flask.json.jsonify` calls `current_app.json.response(...)` (`src/flask/json/__init__.py:159`). When that string becomes an HTTP body, Werkzeug encodes it as UTF-8, so with `ensure_ascii=False` the non-ASCII characters appear as multi-byte UTF-8 in the body rather than as `\uXXXX` escapes; with the default `True` the body is pure ASCII. The test-client path shows the same string→bytes step explicitly: `EnvironBuilder.json_dumps` delegates to `self.app.json.dumps` (`src/flask/testing.py:88-94`), and `tests/test_testing.py:107-114` sets `app.json.ensure_ascii = False`, passes `json="\u20ac"`, and asserts the input stream decodes (as UTF-8) to `'"\u20ac"'`.

**Scope of the relationship.** Three qualifications are visible in the code:

- It is serialization-only. `loads`/`load` never consult `ensure_ascii` (`src/flask/json/provider.py:180-185`, `src/flask/json/__init__.py:96-101`), so both representations parse back to the identical value — the setting is not part of what a reader must handle, only of what a writer emits.
- It applies to every string in the document (keys and values alike), and it is applied after Python-level operations such as `sort_keys`, so it cannot reorder anything.
- It is a `DefaultJSONProvider` attribute, not a `Flask` config key. The equivalent historical config key `JSON_AS_ASCII` was removed in 2.3 and "the default `app.json` provider has equivalent attributes instead" (`CHANGES.rst:153-154`, `docs/config.rst:441-444`).

**Not established.** All of the above is scoped to `DefaultJSONProvider`, the only provider implementation in the repository (`src/flask/sansio/app.py:230, 329`). A custom provider assigned via `json_provider_class` can ignore or reinterpret `ensure_ascii`; nothing in the code constrains subclasses to honor it. The docs do not document `ensure_ascii` anywhere beyond the attribute docstring — its only documentary presence is the autoclass entry in `docs/api.rst:265`.

---

**What this rests on:** direct reading of `src/flask/json/provider.py` (144, 175-178, 100-103, 180-185), `src/flask/json/__init__.py` (159, 96-101), `src/flask/testing.py` (88-94), `src/flask/sansio/app.py` (230, 329), `tests/test_json.py:49-54`, `tests/test_testing.py:107-114`, `CHANGES.rst:153-154`, `docs/config.rst:441-444`. The two evidence handles supplied for this task (retriever `5737a473…`, executor `18136317…`) could not be opened from this session and their bodies were not present in the working directory, so no executed-result claim is carried into the answer above; shared memory was also unavailable (namespace mismatch). Everything stated here was re-checked against the source files listed, so it stands on those citations only.

**Still open:** whether the executor's run confirmed `test_json_as_unicode` passing as written, and whether any provider subclass elsewhere in the tree overrides `ensure_ascii` — I searched and found none beyond the default declaration, but that is a negative result from a keyword search, not an exhaustive proof.
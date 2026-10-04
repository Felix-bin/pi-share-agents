## The relationship: `ensure_ascii` controls *how* non-ASCII characters are written, not *what* they mean

The ASCII-only encoding control is the class attribute `ensure_ascii` on `DefaultJSONProvider` (`src/flask/json/provider.py:144`), default `True`, documented as "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." It is forwarded into the serializer per call: `DefaultJSONProvider.dumps` runs `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` before `return json.dumps(obj, **kwargs)` (`provider.py:177`). So the attribute sets the *default* for the standard library's own `ensure_ascii` keyword, and an explicit `dumps(..., ensure_ascii=...)` keyword overrides it.

The relationship is therefore a pure representation switch over the same input value:

| `ensure_ascii` | `U+2603` serialized as | Payload |
|---|---|---|
| `True` (default) | `"\u2603"` — six ASCII characters | ASCII-only text |
| `False` | `"☃"` — the literal character | UTF-8 once encoded |

Both strings decode to the same Python value; `loads` passes straight through to `json.loads` (`provider.py:180-186`) and never consults `ensure_ascii`. The `application/json` mimetype (`provider.py:161`) is likewise unaffected. In short: the parameter changes only the on-the-wire characters — `True` guarantees an ASCII-only payload, `False` emits the actual Unicode characters.

**Where it is set, and from where.** `json_provider_class: type[JSONProvider] = DefaultJSONProvider` (`src/flask/sansio/app.py:230`) and `self.json = self.json_provider_class(self)` (`src/flask/sansio/app.py:329`) mean the live attribute is `app.json.ensure_ascii`, reassignable after construction. It is *not* part of the base contract: `JSONProvider` (`provider.py:16-56`) declares `dumps`/`dump`/`loads` only (`dumps` raising `NotImplementedError`) and defines no `ensure_ascii`, so the control is specific to the default provider.

**Behavioral confirmation (executed, not inferred).** `test_json_as_unicode` (`tests/test_json.py:50-55`) parametrizes `True → '"\\u2603"'` and `False → '"\u2603"'` on the snowman; `test_environbuilder_json_dumps` (`tests/test_testing.py:111-114`) sets `app.json.ensure_ascii = False` and asserts the EURO SIGN appears literally in the input stream. Both pass against this worktree's source: `PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -q` → exit 0, `3 passed in 0.06s`. A direct probe observed both override directions (`dumps(..., ensure_ascii=False)` with the attribute `True` → `"☃"`, and the reverse → `'"\u2603"'`), `loads(dumps(s)) == s` → `True`, and `ascii-only` pairing exactly with the attribute value.

**Predecessor and overlap.** The legacy config key `JSON_AS_ASCII` no longer exists: `CHANGES.rst:153-154` lists it among removed keys, and `docs/config.rst:441-443` states the default `app.json` provider has equivalent attributes instead. `grep` finds `JSON_AS_ASCII` in no `src/` file, so `ensure_ascii` is the live ASCII control. It should not be confused with the separate `TaggedJSONSerializer` in `src/flask/json/tag.py`, which has no bearing on this parameter.

**What remains open / uncertain.** No `docs/` page documents the attribute — a whole-worktree `grep ensure_ascii` returns only `src/flask/json/provider.py:144,171,177` and the two tests — so the source docstring at line 144 is the only stated semantics. Behavior for non-default or third-party `JSONProvider` subclasses is unestablished, since the base class defines no `ensure_ascii`. Finally, an environment caveat qualifies every executed result above: this worktree's `.venv/Lib/site-packages/flask.pth` resolves `flask` to a different checkout, so a plain `pytest tests/...` here imports another copy of Flask; the passing run reported is specifically the `PYTHONPATH=src` invocation against this worktree's source.

### Rests on
- `src/flask/json/provider.py:144` (declaration + docstring), `:161` (mimetype), `:165-178` (forwarding via `setdefault`, line 177), `:180-186` (`loads` passthrough) — re-read directly.
- `tests/test_json.py:50-55`, `tests/test_testing.py:111-114`; executed run `PYTHONPATH=src ... pytest ...` → exit 0, 3 passed.
- `src/flask/sansio/app.py:230,329` (wiring onto `app.json`); `CHANGES.rst:153-154`, `docs/config.rst:441-443` (removal of `JSON_AS_ASCII`).
- Retriever and executor stage results, which agree on all line numbers and the representation-only effect.

### Open
- No documentation of the attribute outside its own docstring.
- No evidence about `ensure_ascii` on non-default/third-party providers.
- Venv module-resolution caveat requiring `PYTHONPATH=src`.
## The relationship

The control is `DefaultJSONProvider.ensure_ascii`, a class attribute of the default JSON provider declared as `ensure_ascii = True` (`src/flask/json/provider.py:144`). Its own docstring states the relationship directly: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*

It is a two-valued switch over how non-ASCII characters are represented in serialized output, and it applies to the whole payload:

| `ensure_ascii` | Serialized form of U+2603 (snowman) | Emitted bytes |
|---|---|---|
| `True` (declared default) | `"\u2603"` — the six ASCII characters backslash-`u`-`2`-`6`-`0`-`3`; output is ASCII-only | `b'"\\u2603"'` (all bytes < 0x80) |
| `False` | `"☃"` — the literal U+2603 character inside the quotes | `b'"\xe2\x98\x83"'` (UTF-8 encoding of the character) |

So the parameter decides whether a non-ASCII code point survives into the output as itself or is mapped to an escape sequence. It changes representation only, not the serialized data: both forms parse back to the same string, and it is not a decoding/`loads` setting.

**How the attribute reaches the output.** `DefaultJSONProvider.dumps` injects it as a *default* kwarg into the stdlib serializer (`src/flask/json/provider.py:160-178`): `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` before `json.dumps(obj, **kwargs)`. Because it is a `setdefault`, an explicit per-call `ensure_ascii` argument overrides the attribute — the executed run confirms this: with the attribute set to `False`, passing `ensure_ascii=True` per call still produced `'"\u2603"'`. The parameter is therefore a per-provider default applied at serialization time, not an unconditional transformation.

**Where the relationship propagates.** It is not confined to one call site: `dump()` delegates to `dumps()` (`fp.write(self.dumps(...))`), `response()`/`jsonify` only adds `indent`/`separators` and a trailing newline before calling `self.dumps` without touching `ensure_ascii`, and the module-level `flask.json.dumps` routes through `current_app.json.*` under an app context. It also governs request-body serialization, since `EnvironBuilder.json_dumps` delegates to `app.json.dumps` (`src/flask/testing.py:88-94`). The value lives on the provider, not in Flask config: `JSON_AS_ASCII` was removed and replaced by this provider attribute (`docs/config.rst:441-443`, `CHANGES.rst:285-288`).

**Verification status.** The two forms are executed behaviour, not just intent: `./.venv/Scripts/python.exe -m pytest tests/test_json.py -k test_json_as_unicode -v` exited 0 with both parametrizations passing — `(True, '"\\u2603"')` and `(False, '"\u2603"')`, which is exactly the pair in `tests/test_json.py:48-54`. A direct script in the same venv reproduced both forms (ASCII-only vs. `b'\xe2\x98\x83'`) and the `False` form is independently observed in `tests/test_testing.py:110-114` for U+20AC. The declared default `True` is asserted only in the class body, not by any test; the executed run did observe a fresh provider reporting `True` at runtime.

## What this rests on, and what stays open

- Rests on: `src/flask/json/provider.py:144` (declaration + docstring), `:160-178` (`setdefault` in `dumps`), `:47-53`/`:186-215` (`dump`, `response`); `src/flask/sansio/app.py:230,329` (`json_provider_class`, `self.json`); `src/flask/json/__init__.py:30-33,62-64,138-179`; `tests/test_json.py:48-54`; `tests/test_testing.py:110-114`; `src/flask/testing.py:88-94`; `docs/config.rst:441-443`; `CHANGES.rst:285-288`; and the executor's exit-0 pytest run plus direct script output.
- Neither source asserts the *default* value at runtime through a test — that part rests on runtime observation, not on a committed expectation.
- Not established: behaviour for non-BMP code points (e.g. surrogate-pair escaping), combining marks, or `Markup`/`__html__` values under either setting; `loads()` symmetry was not exercised.
- No contradiction between sources was found. The two accounts agree, with the executor supplying execution where the retriever supplied committed expectations.
- `flask_mut2_i417ar2x/mutated_test.py` sits in the worktree but concerns subdomain URL matching, not JSON or Unicode; it is flagged as unrelated rather than treated as counter-evidence.
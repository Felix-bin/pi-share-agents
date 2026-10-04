# The ASCII-only control parameter and Unicode representation

The control parameter is `ensure_ascii`, a boolean class attribute on `DefaultJSONProvider` in `src/flask/json/provider.py` (line 144, class begins at 124; the base `JSONProvider` at line 19 does not define it). **Its relationship to Unicode representation is a representation-only one: it decides whether each non-ASCII character in serialized output is written as a `\uXXXX` escape sequence (ASCII-only output) or as the literal character (UTF-8 bytes on the wire). It does not change the decoded value in either state.**

## The two states

- **`True` (the class default, `provider.py:144`):** every non-ASCII character is replaced by an escape sequence, so the serialized string is pure ASCII — `"\N{SNOWMAN}"` (U+2603) serializes to the eight characters `"\u2603"` (`tests/test_json.py:50-56`, parametrized `[(True, '"\\u2603"'), (False, '"\u2603"')]`). Characters above U+FFFF become **surrogate pairs**: U+1F600 serializes as `"\ud83d\ude00"` (executor probe). The escape form is still valid JSON, so reading clients see the same text.
- **`False`:** the literal Unicode character appears instead. `"\N{SNOWMAN}"` serializes to the three-character string containing an actual snowman, and the euro sign in `tests/test_testing.py:110-113` (`test_environbuilder_json_dumps` with `app.json.ensure_ascii = False`) comes out as literal UTF-8 bytes.

The class docstring states the intent directly (`provider.py:145-147`): *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*

## Representation, not value

This is the load-bearing part of the relationship, and it was measured, not just inferred. The executor's round-trip probe reports for both states `roundtrip_ok=True` and `strings differ: True | decoded values identical: True`. The wire-level probe through `app.test_client` with `jsonify(x="\N{SNOWMAN}")` shows identical results for the client but different bytes:

| `ensure_ascii` | status / Content-Type | body bytes | `get_json()` |
|---|---|---|---|
| `True` | 200 / `application/json` | `b'{"x":"\\u2603"}\n'` (15 bytes, ASCII) | `{'x': '\N{SNOWMAN}'}` |
| `False` | 200 / `application/json` | `b'{"x":"\xe2\x98\x83"}\n'` (12 bytes) | `{'x': '\N{SNOWMAN}'}` |

The flag reaches **dict keys as well as string values** (`'{"sn\\u2603w": 1}'` vs `'{"sn☃w": 1}'`), and the size effect is real but encoding-dependent: for one snowman, `True` spends 8 ASCII bytes where `False` spends 5 UTF-8 bytes — the byte-size rationale recorded historically at `CHANGES.rst:1192-1195` for the removed option ("generate[s] non-ascii encoded JSON which should result in less bytes being transmitted over the network").

## How it is wired, and where it stops

`DefaultJSONProvider.dumps` sets it as a *default* and then delegates to the stdlib: `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`) followed by `return json.dumps(obj, **kwargs)` (`provider.py:179`). Two consequences follow from the source:

1. An explicit caller kwarg overrides the attribute, because `setdefault` only fills a missing key.
2. The attribute is nothing more than Flask's pass-through of the stdlib `json.dumps` keyword of the same name — the escaping/literal behaviour itself lives in `json.dumps`.

The response path (`provider.py:213-215`) builds the serialized `str` plus a newline and hands it to `response_class`; `Response` encodes it as UTF-8, which is why `ensure_ascii=False` puts literal UTF-8 bytes on the wire while the declared `Content-Type` stays `application/json` in both states.

**Decoding is unaffected.** `DefaultJSONProvider.loads` passes kwargs straight to `json.loads`, and the executor confirmed `json.loads` exposes no `ensure_ascii` parameter at all. The control is one-way: it shapes serialization output only.

## Contradictions and gaps in the sources

No source contradicts another on direction — the file, its docstring, the two tests, and the historical changelog note all agree that `True` escapes and `False` emits literally. One genuine absence rather than a contradiction: **the current attribute has no prose documentation in `docs/`**. A grep for `ensure_ascii` under `docs/` returns no matches; `docs/config.rst:419,441` only records the *removal* of the old `JSON_AS_ASCII` config key ("The default `app.json` provider has equivalent attributes instead"). So the docstring at `provider.py:145-147` is the only in-repo documentation of the behaviour, and the `CHANGES.rst:1192-1195` note describes the historic option, not the attribute.

The one inference the retriever could not confirm at the time — that the flag controls form only, not decoded value — is now established by the executor's round-trip and wire probes; the retriever's caveat on this point is retired by that measurement.

---

**Rests on:** `src/flask/json/provider.py:124, 144-147, 177, 179, 213-215` (read in this worktree); `tests/test_json.py:50-56`; `tests/test_testing.py:110-113`; `CHANGES.rst:1192-1195`; `docs/config.rst:419,441` (docs grep for `ensure_ascii` — no matches); executor execution `PYTHONPATH=<worktree>/src .venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -q` → `3 passed in 0.05s`, plus the round-trip and `test_client` wire probes.

**Open / caveats:** (a) All measurements required `PYTHONPATH=<worktree>/src` because `.venv/Lib/site-packages/flask.pth` points at a `src` directory outside this worktree — an unpinned interpreter loads a different copy of the source, so unpinned numbers would describe the wrong tree (shared memory `52da3fbbf936`). (b) Nothing here exercises the removed `JSON_AS_ASCII` config path, so its equivalence to the attribute is stated by `docs/config.rst` only and was not verified by execution. (c) Byte-count differences depend on the character mix and are illustrated for two characters, not measured in general.
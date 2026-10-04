# The ASCII control is a representation switch, not a character-set restriction

`DefaultJSONProvider.ensure_ascii` (`src/flask/json/provider.py:144`, default `True`) decides **how** non-ASCII characters are written, not **whether** they can be serialized. The same value serialized under either setting decodes back to the identical Python object; only the bytes on the wire differ — pure-ASCII `\uXXXX` escape text versus literal code points sent as UTF-8.

**Definition and scope of the control.** `provider.py:124` declares `DefaultJSONProvider`; `:144` sets `ensure_ascii = True`; `:145-147` is the docstring: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* It is the provider's only ASCII-related control — the abstract `JSONProvider` (`provider.py:19`) declares none, and the adjacent `sort_keys` (`:150`) governs key ordering, not encoding. A worktree-wide grep returns exactly five occurrences: `provider.py:144,171,177`, `tests/test_json.py:52`, `tests/test_testing.py:112`.

**How the attribute reaches the serializer.** `dumps` (`provider.py:166`) does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`:177`) then `json.dumps(obj, **kwargs)` (`:178`). Because it is `setdefault`, the attribute is a *default supplier, not a hard policy*: a caller passing `ensure_ascii=False` explicitly overrides the attribute even while it is `True` — observed directly (`attr=True, dumps(s, ensure_ascii=False)` → `'"☃🎉"'`). Every serializing entry point funnels through that one line: `flask.json.dumps` (`src/flask/json/__init__.py:40-41`), `flask.json.dump` (`:70-71` → `provider.py:56`), `jsonify` (`:170` → `provider.py:213-215`, where the response body is built), and the test client's `EnvironBuilder.json_dumps` (`src/flask/testing.py:88-94`).

**The measured relationship.** With the input `☃🎉` (BMP U+2603 plus astral U+1F389):

| setting | `dumps` result | `jsonify` body bytes | length | ASCII? |
|---|---|---|---|---|
| `True` (default) | `'"\\u2603\\ud83c\\udf89"'` | `b'{"v":"\\u2603\\ud83c\\udf89"}\n'` | 27 | yes |
| `False` | `'"☃🎉"'` | `b'{"v":"\xe2\x98\x83\xf0\x9f\x8e\x89"}\n'` | 16 | no |

Both responses carry `Content-Type: application/json` and both yield `get_json() == {'v': '☃🎉'}`. So `True` guarantees an all-ASCII body — supplementary-plane characters become **surrogate pairs** (`\ud83c\udf89`), BMP characters single escapes (`\u2603`) — while `False` leaves the code points literal, and they reach the client as UTF-8 bytes (Werkzeug encodes a `str` body as UTF-8: `.venv/Lib/site-packages/werkzeug/wrappers/response.py:289-298`; the per-response charset attribute was removed in Werkzeug 3.0, `werkzeug/sansio/response.py:86-87`). Because escape sequences are ordinary JSON string escapes, the escape form costs ~1.7× the bytes here purely as transport overhead — the "better performance and size" trade the docstring names.

**One path where the parameter does not apply.** Out of an application context, `flask.json.dumps` bypasses the provider entirely and falls back to the stdlib (`json/__init__.py:44`); the attribute is never consulted, and the observed output stayed ASCII-escaped (`'"\\u2603\\ud83c\\udf89"'`) regardless of the setting. On that path the knob has no effect.

**History of the name.** `ensure_ascii` replaced the `JSON_AS_ASCII` config key, deprecated in 2.2 (`CHANGES.rst:286`) and removed in 2.3 (`CHANGES.rst:153`); `docs/config.rst:419` records its 0.10 introduction and `:441` its 2.3 removal, pointing at "equivalent attributes" on `app.json`. No source-code occurrence of `JSON_AS_ASCII` remains — it is gone, not shimmed. Notably, `ensure_ascii` itself appears in **no** `docs/` file and **no** `CHANGES.rst` entry; its only prose documentation is the class-attribute docstring surfaced through autoclass (`docs/api.rst:265-267`).

## What this rests on

- Code reads with file:line for the definition (`src/flask/json/provider.py:144-147`), the forwarding (`:166,177-178`), the response construction (`:213-215`) and each entry point (`json/__init__.py:40-41,70-71,170`; `testing.py:88-94`) — all re-confirmed against the files during synthesis.
- One executed run (exit 0) under `PYTHONPATH=src`, printing the resolved `flask.__file__` as `src/flask/__init__.py`, producing the table above plus the attribute-vs-kwarg override and the no-context result.
- A passing test run: `tests/test_json.py::test_json_as_unicode` + `tests/test_testing.py::test_environbuilder_json_dumps`, 3 passed.
- History/naming from `CHANGES.rst:153,286` and `docs/config.rst:419,441`; grep counts for `ensure_ascii` and `JSON_AS_ASCII`.

## Still open

- **No test asserts the response/`jsonify` body for non-ASCII, nor the default `True`.** The three test hits cover only `dumps` with the attribute set explicitly (`tests/test_json.py:48-54`) and request-body bytes (`tests/test_testing.py:110-114`). The response-path behavior is established only by the executed run, not by the suite. That absence is a finding, not a gap in searching.
- **Unpaired surrogates were not exercised.** The run used well-formed input only, so the behavior when `ensure_ascii=False` and a lone surrogate must be encoded (a `UnicodeEncodeError` path on the text body) is untested and unstated here.
- **Git history was not consulted** (only file reads were available); the historical claim rests solely on `CHANGES.rst` and `docs/config.rst`.
- **The worktree invocation caveat:** the venv's `flask.pth` points outside this worktree, so unpinned `python`/`pytest` here imports a different copy of the source; all results above hold only under `PYTHONPATH=src`. Whether that environment issue is itself in scope is not something this summary resolves.
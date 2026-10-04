## Conclusion

For the pinned subject — the vendored Flask 3.2.0.dev tree at `experiments/data/flask-src` (commit `85c5d93`), i.e. `flask.json.provider.DefaultJSONProvider.ensure_ascii` (`src/flask/json/provider.py:144`) — the parameter is a **rendering switch over non-ASCII code points, not a change to the data**. It is a plain class attribute default of `True`, injected as a `setdefault` into stdlib `json.dumps` (`provider.py:177-179`), so with `True` every non-ASCII code point is emitted as an ASCII escape (BMP → `\uXXXX`; astral → a surrogate pair, `😀` → the 12-char `\ud83d\ude00`) and with `False` the literal character is emitted in the returned `str`; the parsed value is identical either way. **已实现且已验证** (measured on the vendored tree: `json.loads(dumps(x)) == x` and `json.loads(response_body) == x` both `True` under both settings).

The measurable consequences, for the plan's one payload: `True` → `len(str)` 140 / `len(str.encode('utf-8'))` 140 / response body 132 bytes; `False` → 104 / 117 / 109. Two things follow. First, escaping is **ASCII-only, so it inflates output** for non-ASCII payloads (here 23 bytes more after UTF-8, subtracting printed values only); literal output instead relies on the response's UTF-8 encoding. **已实现且已验证** for these three quantities, payload-specific. Second, the three numbers must not be conflated: `str` length, UTF-8 byte length, and body length differ under `False` (104 / 117 / 109). ASCII input renders identically under both settings (probe v1 side evidence: `dumps('plain-ascii') = '"plain-ascii"'`), and a pre-escaped literal `\u2603` inside the payload is emitted as `\\u2603` under **both** settings and parses back to the 6-char text — the flag escapes code points, it does not interpret or normalize existing escape text. **已实现且已验证.**

Because the attribute is only a `setdefault`, the escape policy is **bypassable and provider-specific**: `dumps(obj, ensure_ascii=False)` overrides a `True` class attribute (measured `kwarg-override == attribute-False dump ? True`), the base `JSONProvider.dumps` never references it (`provider.py:41-47`, abstract), and outside an app context `flask.json.dumps` never consults the provider at all (`json/__init__.py:11-38`). So "Flask always escapes non-ASCII" is false, and `JSON_AS_ASCII` is **history only** (removed in 2.3, `CHANGES.rst:153`, `docs/config.rst:440-443`) — no current code path reads it. **已实现且已验证.**

The framework's own stated rationale — "more compatible with some clients, but can be disabled for better performance and size" (`provider.py:145-147`) — is quoted as a **source claim**, not as our measurement; we measured the size effect, not the client-compatibility effect.

## What this rests on

- Definition and wiring (read, verbatim): `provider.py:144-148` (`ensure_ascii = True` + docstring), `provider.py:166-179` (`kwargs.setdefault("ensure_ascii", self.ensure_ascii)` → `json.dumps`). Re-verified this session.
- Body composition (read, verbatim): `provider.py:205-215` — `f"{self.dumps(obj, **dump_args)}\n"` with `separators=(",", ":")` outside debug mode, `mimetype = "application/json"`.
- Framework's own assertions: `tests/test_json.py:48-54` (`True` → `'"\\u2603"'`, `False` → `'"\u2603"'`, **str vs str**); `tests/test_testing.py:110-114` (stream bytes `.decode("utf8")` == literal `€`); re-verified for `test_json.py`.
- Executed probe v2 (exit 0), run under `openEuler-SP3` WSL with the vendored `src` forced to `sys.path[0]`, printing `flask.__file__ = …/flask-src/src/flask/__init__.py`, `metadata Flask ver = 3.2.0.dev0`, `resolved under vendored src? True` — so the numbers come from the pinned tree, not a site-packages or `worktree/flask` copy (which the venv's `flask.pth` would otherwise have selected).
- Scope resolution: grep found **no** ASCII-escape JSON parameter in `src/synapse/` (only unrelated SHM `writeAscii`/`readAscii` codecs), so the question is about Flask, as the plan assumed.
- The project-side accounting extension was explicitly declared the main agent's call and is genuinely out of the measured scope; no evidence was gathered for it.

## Corrections and contradictions (reported, not silently resolved)

- **Retriever inference contradicted by measurement**: `len(body_bytes) == len(dump_str.encode('utf-8')) + 1` is **false**; the body is a *compact-separator* re-serialization plus `"\n"` (`body == compact_dump.utf8 + b"\n"` → `True`; `body == plain_dump.utf8 + b"\n"` → `False`, both settings). The 140→132 / 117→109 gap is the nine characters of `", "`/`": "` collapsing to `","`/`":"` plus the newline.
- **Probe v1 is superseded and its numbers must not be quoted** (True 139/139/131; False 98/113/105): its heredoc collapsed the payload's `"\\u2603"` into a literal snowman, so it measured a different payload. Only its ASCII-field observation is reused.
- **One printed line in v2 is a bad check of my own making**: `equals the ensure_ascii=False dump ? False` is an artifact of an incomplete un-escape; the valid line is `kwarg-override == attribute-False dump ? True`.

## Still open

- Whether `ensure_ascii` distorts **this project's** byte/token accounting over SYN0/envelope payloads in the Phase-2 harness — flagged as the main agent's call, not scoped, not measured. A technically correct Flask answer may not be what that intent asked for.
- The **stdlib** `json.dumps` default (only Flask's attribute default `True` was measured), and `worktree/flask` identity beyond `provider.py` (byte-identical for that one file only).
- Behaviour of the co-influencing knobs `sort_keys`/`compact` (side-observed `True`/`None`, never varied) and edge cases where emitting the literal character is not representable (e.g. lone surrogates) — not probed.
- Reproducibility: the probe lived in WSL `/tmp` and did **not** persist across invocations; it is reproducible only from the report. No repo test suite was run, per plan. `flask-src` `git status -s` is empty.
- No shared-memory read or write occurred: `synapse_read`/`synapse_write` were not in this session's tool set, so nothing was checked against or recorded under `flask-json-provider-ensure-ascii`.
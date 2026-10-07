## Relationship between `ensure_ascii` and Unicode character representation

`DefaultJSONProvider.ensure_ascii` (class attribute, default `True`, `src/flask/json/provider.py:144`) is forwarded verbatim to the stdlib encoder by `DefaultJSONProvider.dumps` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` at `src/flask/json/provider.py:177`, then `return json.dumps(obj, **kwargs)` — so it decides, per serialization call, whether non-ASCII characters in the emitted JSON text are replaced by `\uXXXX` escape sequences (`True`: ASCII-safe but larger, as its docstring at `provider.py:145–147` puts it, "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size.") or written out as literal Unicode characters (`False`: the escaping is left to whatever encodes the resulting `str`), and it affects only outbound `dumps`/`response` output, not parsing (`loads` at `provider.py:178–186` passes only `**kwargs` to `json.loads` and never reads the attribute; the abstract base `dumps` at `provider.py:44–46` defines no such flag).

Concretely, for `"\N{SNOWMAN}"`:

| `app.json.ensure_ascii` | Result of `app.json.dumps(...)` | Repr of result |
|---|---|---|
| `True` (default) | `"\u2603"` — six-character escape | `'"\\u2603"'` |
| `False` | `"☃"` — literal snowman | `'"☃"'` |

That relation is pinned by two checked-in assertions and was reproduced by execution:

- `tests/test_json.py:48–54` — `@pytest.mark.parametrize("test_value, expected", [(True, '"\\u2603"'), (False, '"\u2603"')])`, then `app.json.ensure_ascii = test_value; rv = app.json.dumps("\N{SNOWMAN}"); assert rv == expected` (verbatim).
- `tests/test_testing.py:110–114` — `app.json.ensure_ascii = False`; `eb = EnvironBuilder(app, json="\u20ac")`; `assert eb.input_stream.read().decode("utf8") == '"\u20ac"'` (verbatim) — i.e. with the flag off, the raw request body is the literal euro sign, not an escape.
- Execution (project venv `.venv/Scripts/python.exe`; bare `python` cannot import the package): `pytest tests/test_testing.py::test_environbuilder_json_dumps tests/test_json.py::test_json_as_unicode -q` → `3 passed in 0.07s`, exit 0. A direct provider check printed `attr ensure_ascii default: True`, `True -> '"\\u2603"'`, `False-> '"☃"'`, `attr override -> '"\\u2603"'` — confirming the class attribute itself (not a per-call fallback) drives the output, and that because the forwarding uses `setdefault`, an explicit per-call `ensure_ascii=` kwarg wins over the attribute. `git diff --stat` was empty, so no source file was modified.

Because the flag is applied through `setdefault` (rather than hard-coding `ensure_ascii` in the call), a caller of `dumps` can override it for a single serialization without touching `app.json.ensure_ascii`; and since only the final `str` leaves `dumps`, the literal-Unicode branch is carried to the client by the encoding the response applies (`response` at `provider.py:189–217` serializes with `self.dumps(obj, **dump_args)` and builds `self._app.response_class(f"{...}\n", mimetype=self.mimetype)`, specifying only `mimetype="application/json"`).

This attribute is the successor of a removed config key, not a config key itself: `docs/config.rst:440–443` records that under `.. versionchanged:: 2.3`, "``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has equivalent attributes instead."; `CHANGES.rst` shows the same keys deprecated as they "are moved to attributes on the default ``app.json`` provider" and then removed. `JSON_AS_ASCII` no longer appears anywhere under `src/`, and a tree-wide grep for `ensure_ascii` finds only `src/flask/json/provider.py:144,171,177` and the two tests — there is no second provider or vendored override defining its own ASCII flag, so `DefaultJSONProvider` (the default `app.json_provider_class`) is the sole locus in the worktree.

Coverage: the task's question — what the ASCII-only parameter does to Unicode representation in serialized output — is answered above for the outbound (`dumps`/request-body) path, and the parameter is identified as `ensure_ascii`, not a config key.

### What this rests on
- `src/flask/json/provider.py:144` (default `True`), `145–147` (docstring), `177` (`setdefault`), `179` (`json.dumps`), `178–186` (`loads`, no flag), `44–46` (abstract base), `189–217` (`response`, `mimetype` only).
- `tests/test_json.py:48–54` and `tests/test_testing.py:110–114`, quoted verbatim above.
- Executed: `pytest` on those two targets (`3 passed in 0.07s`, exit 0) plus the direct `DefaultJSONProvider` attribute check, all under `.venv/Scripts/python.exe`; `git diff --stat` empty.
- `docs/config.rst:440–443`; `CHANGES.rst` deprecation/removal notes; grep coverage for `ensure_ascii`/`JSON_AS_ASCII`.

### Still open / not established
- Whether the response `Content-Type` carries an explicit `charset=utf-8` was not established — only `mimetype="application/json"` was observed at `provider.py:216–217`; response charset handling was reserved by the plan and is outside what the evidence shows.
- Deserialization (`loads`) representation is out of scope for this parameter and no evidence was gathered for it.
- The pre-existing untracked `flask_mut2_i417ar2x/mutated_test.py` artifact is unrelated to JSON (its content concerns `url_for`/subdomains; no `ascii`/`unicode`-serialization matches) and its disposition was reserved; it was neither created nor modified by the execution step (`git status --porcelain` shows only `?? flask_mut2_i417ar2x/`).
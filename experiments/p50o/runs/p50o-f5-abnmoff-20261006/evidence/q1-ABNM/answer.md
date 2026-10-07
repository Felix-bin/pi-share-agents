## `ensure_ascii` in `DefaultJSONProvider`: an output-alphabet switch, not a data-model switch

The parameter is `DefaultJSONProvider.ensure_ascii`, declared as a class attribute with value `True` at `src/flask/json/provider.py:144`. Its own docstring (`provider.py:145–147`) states what it does: "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size." So the relationship to Unicode character representation is this: **`ensure_ascii=True` (the default) rewrites every non-ASCII code point in the serialized string into a `\uXXXX` escape sequence, so the emitted string is pure ASCII; `ensure_ascii=False` emits those code points literally as UTF-8.** The flag selects how a character is written out, never which character it is.

**Mechanism and precedence.** The attribute reaches the serializer through a single wiring line, `DefaultJSONProvider.dumps` (`provider.py:166`), whose body is `kwargs.setdefault("default", self.default)` (176), `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (177), `kwargs.setdefault("sort_keys", self.sort_keys)` (178), then `return json.dumps(obj, **kwargs)` (179). Two consequences follow directly from `setdefault` + delegation:

- Precedence is **per-call `dumps(..., ensure_ascii=...)` > app/instance attribute (`app.json.ensure_ascii = ...`) > stdlib `json`'s own default (`False`)**. Flask does not implement the escaping; it forwards the flag to stdlib `json.dumps`.
- The flag is per-serialization, so one app can emit escaped JSON in one call and literal UTF-8 in another.

**Observed behaviour (both rows).** `tests/test_json.py:48–54` fixes the two outcomes verbatim: parametrized `(True, '"\\u2603"')` and `(False, '"\u2603"')`, each running `app.json.ensure_ascii = test_value; rv = app.json.dumps("\N{SNOWMAN}")` and asserting equality. `True` yields a literal backslash-`u2603` escape in the string; `False` yields the snowman character itself. Both rows serialize the *same* input code point (U+2603), which is the evidence that only the representation changes.

**Reach.** The setting is not confined to a direct `dumps()` call: `tests/test_testing.py:110–114` sets `app.json.ensure_ascii = False`, builds `EnvironBuilder(app, json="\u20ac")`, and asserts the request body bytes decoded as UTF-8 equal `'"\u20ac"'` — i.e. the app-level provider attribute governs request/test-client encoding too. A repository-wide grep for `ensure_ascii` returns only `src/flask/json/provider.py` (144, 171, 177) plus the two tests that set it (52, 112), so line 177 is the complete propagation path in `src/flask`; the base `JSONProvider.dumps` (`provider.py:41`) never references it.

**Value preservation.** The decode side does not consult the flag: `DefaultJSONProvider.loads` (`provider.py:181`) simply returns `json.loads(s, **kwargs)` (187), so any `\u2603` escape produced under `True` decodes back to U+2603. The setting therefore changes byte output, not the decoded value — a payload serialized with `True` and one serialized with `False` differ in size (escapes are longer) but describe the same value.

**Per-app / per-call and legacy spelling.** It is set as `app.json.ensure_ascii = ...` (`tests/test_json.py:52`, `tests/test_testing.py:112`) or per call via the `dumps` kwarg described above. Its predecessor config key was removed: `docs/config.rst:440–443` (`.. versionchanged:: 2.3`) records that `JSON_AS_ASCII`, `JSON_SORT_KEYS`, `JSONIFY_MIMETYPE`, and `JSONIFY_PRETTYPRINT_REGULAR` were removed and "The default ``app.json`` provider has equivalent attributes instead." (`JSON_AS_ASCII` had been added in 0.10 per `docs/config.rst:418–419`.) So "the ASCII-only encoding control parameter" is `ensure_ascii` under its modern spelling; `JSON_AS_ASCII` is the retired name for the same behavior.

## What this rests on

- `src/flask/json/provider.py:144` (`ensure_ascii = True`), `145–147` (docstring), `166`, `176–179` (`dumps` wiring + stdlib delegation), `181/187` (`loads` → `json.loads`), `41` (base `JSONProvider.dumps`, no reference).
- `tests/test_json.py:48–54` (`test_json_as_unicode`, both parametrized rows).
- `tests/test_testing.py:110–114` (`test_environbuilder_json_dumps`).
- `docs/config.rst:440–443` (2.3 removal note, "equivalent attributes"), `418–419` (0.10 addition of `JSON_AS_ASCII`).
- Repository-wide grep for `ensure_ascii`: only `provider.py` and the two tests — negative evidence bounding the wiring claim.

## What remains open

- No live execution was performed; the expected strings come from the cited test file, not from a process run. No byte-level output of a real response was captured.
- Nothing was established about `JSONProvider` subclasses other than the built-in `DefaultJSONProvider`, about response-MIME behaviour, or about `loads`/round-trip semantics beyond the delegation line at `provider.py:187` and the two equality assertions — those were outside this retrieval's scope.
- Whether a user-facing recommendation follows from this (beyond the attribute's own docstring trade-off: compatibility vs. performance/size) is left unstated, as is any expansion into the `JSON_AS_ASCII` migration history beyond the removal note at `docs/config.rst:440–443`.
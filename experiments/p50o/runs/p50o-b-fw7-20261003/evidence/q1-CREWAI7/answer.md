## Answer

**The relationship:** `DefaultJSONProvider.ensure_ascii` is a boolean class attribute that Flask uses *only as a default keyword argument* for the stdlib `json.dumps`, and it alone decides whether non-ASCII characters in serialized output appear as `\uXXXX` escape sequences (pure-ASCII text) or as literal Unicode characters (UTF-8 when encoded).

**1. It is a provider attribute with a documented contract** — `src/flask/json/provider.py:144-148`, inside `DefaultJSONProvider`:

```
144:    ensure_ascii = True
145:    """Replace non-ASCII characters with escape sequences. This may be
146:    more compatible with some clients, but can be disabled for better
147:    performance and size.
148:    """
```

The default value is `True`, and the docstring states the trade-off itself: escaping is "more compatible with some clients," disabling it gives "better performance and size."

**2. The wiring is a default, not a hard setting** — `src/flask/json/provider.py:176-179`:

```
176:        kwargs.setdefault("default", self.default)
177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
178:        kwargs.setdefault("sort_keys", self.sort_keys)
179:        return json.dumps(obj, **kwargs)
```

Line 177 uses `kwargs.setdefault`, so the attribute supplies the value only when the caller did not pass one; an explicit `ensure_ascii=` in `**kwargs` wins. Line 179 delegates to the stdlib `json.dumps`. The `dumps` docstring says the same in words at lines 169-171 ("Sets some parameter defaults from … `ensure_ascii` …"). **The override path is confirmed by direct probe**, not only by reading `setdefault` semantics: with attribute `True` plus kwarg `ensure_ascii=False` the probe emitted `'☃'`; with attribute `False` plus kwarg `ensure_ascii=True` it emitted `'"\\u2603"'`.

**3. The Unicode mapping, as asserted in-tree** — `tests/test_json.py:48-54`:

```
48: @pytest.mark.parametrize(
49:     "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
50: )
51: def test_json_as_unicode(test_value, expected, app, app_ctx):
52:     app.json.ensure_ascii = test_value
53:     rv = app.json.dumps("\N{SNOWMAN}")
54:     assert rv == expected
```

So for the input U+2603: `ensure_ascii = True` → the 8-character ASCII string quote + `\u2603` + quote; `ensure_ascii = False` → quote + the literal snowman character + quote. Both asserted against the `str` returned by `app.json.dumps`, not against bytes. Target run of this test plus the one below passed: `3 passed` (exit 0).

**4. The same relationship on a downstream byte path** — `tests/test_testing.py:110-114`:

```
112:    app.json.ensure_ascii = False
113:    eb = EnvironBuilder(app, json="\u20ac")
114:    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

With the attribute `False`, the request-body stream decodes as UTF-8 to quote + literal `€` (U+20AC) + quote — the literal character survives unescaped into the body. This assertion decodes to text before comparing; it is not a raw-byte equality.

**5. Byte-level completion (probe, filling the gap the plan flagged):** the direct behavioral probe reports `True` → `dumps` string `'"\\u2603"'`, `isascii=True`, UTF-8 bytes `b'"\\u2603"'`; `False` → `'"☃"'`, `isascii=False`, UTF-8 bytes `b'"\xe2\x98\x83"'`; and at the full response level, `response True` → body `b'"\\u2603"\n'` vs `response False` → body `b'"\xe2\x98\x83"\n'`, both `mimetype: application/json`. So the distinction holds for the emitted string *and* the response bytes: ASCII-safe escapes versus literal UTF-8.

**6. Scope: serialization only.** `loads` sets no `ensure_ascii` default — `src/flask/json/provider.py:187` is `return json.loads(s, **kwargs)`. The probe confirms both forms are accepted identically: `loads(escaped) -> '☃'` and `loads(utf8bytes) -> '☃'`. The attribute therefore governs *output* representation, not what deserialization accepts. Responses inherit the behavior transitively: `response` calls `self.dumps(...)` at `src/flask/json/provider.py:214` with `dump_args` containing only `indent`/`separators` (lines 206-211), so nothing there overrides `ensure_ascii`; text→bytes conversion is done by the response class.

**Alternative reading of the term (resolved, not escalated):** the one ambiguous phrase was read as the provider attribute `ensure_ascii`. The alternative — a legacy config key — has **no source in this worktree**: `grep_worktree "JSON_AS_ASCII"` → no hits, `grep_worktree "as_ascii"` → no hits (including `docs/`, `CHANGES.rst`, `tests/`, `src/`). The probe also reports `config JSON_AS_ASCII present: False` and `config as_ascii present: False`. In-tree `ensure_ascii` references are exactly `src/flask/json/provider.py:144, 171, 177` plus `tests/test_json.py:52` and `tests/test_testing.py:112`. (Two further grep hits — `.venv/Lib/site-packages/itsdangerous/_json.py:16` and `.venv/.../_pytest/cacheprovider.py:191` — are third-party code, not Flask's provider.)

**Not established / open:**
- No contract obligates providers other than `DefaultJSONProvider` to expose `ensure_ascii`: the base `JSONProvider` (`src/flask/json/provider.py:19-65`) declares no such attribute and its `dumps` docstring mentions only generic `kwargs`. That is an open extension point, not a verified guarantee.
- No doc or changelog text names a legacy ASCII config key (searches returned nothing), so that reading cannot be cited at all.
- Not decided here (out of scope for this answer): whether the default should change, whether an alias should be reintroduced, or any source edit.

### Rests on
- `src/flask/json/provider.py:144-148` (declaration + docstring), `:176-179` (setdefault pass-through), `:187` (`loads` untouched), `:189-215` (`response` path)
- `tests/test_json.py:48-54` and `tests/test_testing.py:110-114` (both run, exit 0, `3 passed`)
- Behavioral probe (exit 0) for byte-level `dumps`/`response` forms, both override directions, and both `loads` forms
- Negative searches: `JSON_AS_ASCII`, `as_ascii`

### Still open
- Behaviour of non-`DefaultJSONProvider` providers (base class exposes no `ensure_ascii`)
- Raw-byte assertions in shipped tests (probe covers this; suite does not)
- Product decisions on the default value, a legacy alias, or source edits
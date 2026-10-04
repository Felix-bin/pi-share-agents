All load-bearing evidence re-verified against the worktree. Here is the final report.

## What the knob is (and is not)

The ASCII-only encoding control parameter is **`DefaultJSONProvider.ensure_ascii`**, not `AS_ASCII`:

- `grep_worktree "AS_ASCII"` → **`(no hits)`** — the symbol does not exist anywhere in the worktree.
- `grep_worktree "ensure_ascii"` → exactly these relevant hits, plus unrelated third-party code:
  - `src/flask/json/provider.py:144`, `:171`, `:177`
  - `tests/test_json.py:52`
  - `tests/test_testing.py:112`
  - `.venv/Lib/site-packages/itsdangerous/_json.py:16` and `.venv/Lib/site-packages/_pytest/cacheprovider.py:191` (not Flask)

It is a **class attribute defaulting to `True`**, documented as an escape toggle (`src/flask/json/provider.py:144-148`):

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

## The single translation point into the stdlib encoder

The Flask attribute becomes a `json.dumps` keyword in exactly one place, and via `setdefault`, so it is a **default, not a forced value** (`src/flask/json/provider.py:166-179`):

```python
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

Line 177 is where the representation choice is handed to Python's `json` library. Because it is `setdefault`, an explicit per-call `dumps(obj, ensure_ascii=...)` overrides the attribute.

## The behavior, pinned by upstream tests

`tests/test_json.py:48-54` parametrizes both flag values and asserts the exact emitted string for U+2603 SNOWMAN:

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

- `True` → `'"\\u2603"'`, the 8-character string `"\u2603"` (pure ASCII).
- `False` → `'"\u2603"'`, the 3-character string `"☃"` (quote, actual snowman code point, quote).

A second test shows the same setting governing the **request-side** encoder, and that literal output must be read back as UTF-8 (`tests/test_testing.py:110-114`):

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

The `"\u20ac"` in the assertion source is the literal EURO SIGN `€`, and the byte stream is decoded with `utf8` — direct confirmation that the non-escaped branch yields **UTF-8 bytes**, not escapes.

## Why literal mode implies a UTF-8 path

`DefaultJSONProvider.loads` documents "Text or UTF-8 bytes" (`src/flask/json/provider.py:184`), and the base provider's `dump` says the file object "Should use the UTF-8 encoding to be valid JSON" (`src/flask/json/provider.py:53-54`). So the `False` branch assumes UTF-8 transit end to end.

## The choice passes verbatim into the response body

`response()` adds only a trailing newline — no re-encoding (`src/flask/json/provider.py:213-214`):

```python
        return self._app.response_class(
            f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
        )
```

Werkzeug then encodes the `str` body as UTF-8, which is precisely why the literal branch requires a UTF-8 consumer.

## Empirical step

I have only retrieval tools (grep/read/list) — no code-execution tool — so the runtime assertions described in the earlier plan could not be executed by me. The equivalent verification is supplied **statically** by `tests/test_json.py:48-54` (asserting `True → 8-char '"\\u2603"'` and `False → 3-char '"☃"'`, i.e. exactly the length distinction and the representation-only difference) and `tests/test_testing.py:110-114` (UTF-8 byte-level read-back). These are the upstream regression locks for this exact contract.

## Final statement of the relationship

`DefaultJSONProvider.ensure_ascii` — a **class attribute defaulting to `True`** (`src/flask/json/provider.py:144`) — is the sole switch controlling Unicode representation in Flask's JSON output, translated to the stdlib encoder at exactly one point, `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`). Therefore:

- **`ensure_ascii = True` (default):** every non-ASCII code point is emitted as an ASCII `\uXXXX` escape sequence; the body is pure ASCII ("more compatible with some clients", at a size/performance cost).
- **`ensure_ascii = False`:** the code point is emitted **literally** as the actual Unicode character, carried in a UTF-8 body — requiring the consumer and any `dump()` file object to handle UTF-8.

Concretely, `app.json.dumps("\N{SNOWMAN}")` yields the 8-character `"\u2603"` vs. the 3-character `"☃"` (the two `expected` values at `tests/test_json.py:49`). This is a **representation-only** difference: both forms are semantically identical JSON decoding to the same Python string, so the flag changes byte-level encoding, not the data. Two caveats: (1) it is overridable per call via `dumps(..., ensure_ascii=...)` because of `setdefault`; (2) literal mode assumes a UTF-8 path end to end, and the value passes unmodified into the response body (`provider.py:213-214`), with only a trailing `\n` appended and no re-encoding.

All claims verify against the passages quoted above. No corrections required to the one-line relationship.
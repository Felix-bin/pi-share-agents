## Answer: `ensure_ascii` in Flask's `DefaultJSONProvider` and Unicode in serialized output

**Provenance of every quote below:** the vendored checkout at `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`, `pyproject.toml:1-3` — `name = "Flask"`, `version = "3.2.0.dev"`; detached HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`; `requires-python = ">=3.10"`. The sibling comparison-arm copy `../worktree/flask` is the same version and byte-identical in the relevant region, so these findings transfer to it.

---

### 1. The relationship in one sentence

`DefaultJSONProvider.ensure_ascii` **is** the ASCII-only encoding switch: it is a plain class attribute defaulting to `True` that the provider forwards, via `kwargs.setdefault`, as the `ensure_ascii=` keyword of stdlib `json.dumps` on every serialization call — so with the default the serialized *text* contains no character above U+007F (every non-ASCII character becomes a `\uXXXX` escape, or a surrogate pair `\uD8xx\uDDxx` outside the BMP), and with `ensure_ascii = False` the literal Unicode characters appear in the output string instead. It changes only the **representation** of non-ASCII characters; the decoded value is identical either way.

### 2. The mechanism — the control and its forwarding

The control, `src/flask/json/provider.py:144-148`, on `DefaultJSONProvider(JSONProvider)` (declared `:125`), sitting between `default` (`:138-142`) and `sort_keys` (`:150-155`):

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

The forwarding, `src/flask/json/provider.py:166-179`:

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON to a string.

        Keyword arguments are passed to :func:`json.dumps`. Sets some
        parameter defaults from the :attr:`default`,
        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.

        :param obj: The data to serialize.
        :param kwargs: Passed to :func:`json.dumps`.
        """
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

So the chained relationship is: **`DefaultJSONProvider.ensure_ascii` (line 144) → `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (line 177) → stdlib `json.dumps(ensure_ascii=...)`**. The stdlib signature it feeds, CPython 3.13.9 (`.../Lib/json/__init__.py:183-185`):

```python
def dumps(obj, *, skipkeys=False, ensure_ascii=True, check_circular=True,
        allow_nan=True, cls=None, indent=None, separators=None,
        default=None, sort_keys=False, **kw):
```

whose docstring (`:192-194`) states: *"If ``ensure_ascii`` is false, then the return value can contain non-ASCII characters if they appear in strings contained in ``obj``. Otherwise, all such characters are escaped in JSON strings."*

Being a class attribute, it is read from the instance at call time, not frozen at import — the run confirms `class attr still: True | instance now: False` after assigning `app.json.ensure_ascii = False`. Note also that the base `JSONProvider.dumps` is abstract (`provider.py:41-47`, `raise NotImplementedError`), so the forwarding exists only in `DefaultJSONProvider`; a custom provider class must forward it itself.

### 3. The concrete True/False contrast

The canonical in-tree assertion is `tests/test_json.py:48-54`:

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

`"\N{SNOWMAN}"` is U+2603 ☃. So `True` → 8-character ASCII text `"\u2603"` (quote, backslash, `u2603`, quote); `False` → `"☃"`. The reproduction matched it byte-for-byte:

```
=== (a) two-way, inside app_context, U+2603 ===
attr True  -> repr: '"\\u2603"'  codepoints: ['0x22', '0x5c', '0x75', '0x32', '0x36', '0x30', '0x33', '0x22']
attr False -> repr: '"☃"'  codepoints: ['0x22', '0x2603', '0x22']
assert True  == '"\u2603"' : True
assert False == '"☃"' : True
```

And the escaping extends beyond the BMP — `U+1D11E` (𝄞 MUSICAL SYMBOL G CLEF) becomes a **surrogate pair** under `True`:

```
=== (c) non-BMP U+1D11E (MUSICAL SYMBOL G CLEF) ===
True  -> repr: '"\\ud834\\udd1e"'
False -> repr: '"𝄞"'
assert True  == '\"\ud834\udd1e\"' : True
assert False == '"𝄞"' : True
```

The size effect, which is exactly the "compatibility vs performance and size" tradeoff the docstring names:

```
=== (b) size / ASCII-ness tradeoff ===
True  len= 8 utf8-bytes= 8 isascii= True
False len= 3 utf8-bytes= 5 isascii= False
bytes delta (True-False) = 3
```

(Historic intent, `CHANGES.rst:1192-1195`: *"Added an option to generate non-ascii encoded JSON which should result in less bytes being transmitted over the network. It's disabled by default to not cause confusion with existing libraries…"*)

### 4. The invariants — what does *not* change

- **Decoded value is identical.** `app.json.loads(...)` equals the input under both settings, and `json.loads(json.dumps(x))` equality holds across settings (run output: `app.json.loads(True) == orig: True`, `app.json.loads(False) == orig: True`, `json.loads(json.dumps(x)) equality across settings: True`). JSON validity is unaffected: `"\u2603"` and `"☃"` are the same JSON string value.
- **The flag is not about transport encoding.** The output is always a `str`; werkzeug encodes it to UTF-8 at the wire. With `ensure_ascii = False` the response *body* is literal UTF-8 bytes, with `True` it is ASCII bytes:

```
dict-view  True : 200 | application/json | data: b'{"snowman":"\\u2603"}\n'
dict-view  False: 200 | application/json | data: b'{"snowman":"\xe2\x98\x83"}\n'
jsonify    True : 200 | application/json | data: b'{"snowman":"\\u2603"}\n'
jsonify    False: 200 | application/json | data: b'{"snowman":"\xe2\x98\x83"}\n'
```

  Note a plan premise that is **wrong as written**: the header is `application/json` with **no** `; charset=utf-8`, in both cases. Werkzeug's `get_content_type` (`werkzeug/utils.py:170-192`) only appends a charset for `text/*`, a small `_charset_mimetypes` set, or `+xml`; `application/json` is in none of those. This matches `tests/test_basic.py:1288-1291` (`rv.mimetype == "application/json"`). Only the body str is UTF-8-encoded (`werkzeug/wrappers/response.py:31-36`, `:289-292`, `:829-831` `def encoding(self) -> str: return "utf-8"`), consistent with the provider's own file-path wording, `provider.py:50-52`: *":param fp: A file opened for writing text. Should use the UTF-8 encoding to be valid JSON."*
- **It does not govern all escaping.** Control characters, quotes and backslashes are escaped identically regardless of the flag; only the non-ASCII class `[^ -~]` is governed. Stdlib `encoder.py:18-19` shows the two distinct classes:

```python
ESCAPE = re.compile(r'[\x00-\x1f\\"\b\f\n\r\t]')
ESCAPE_ASCII = re.compile(r'([\\"]|[^\ -~])')
```

  Reproduced: `\n`, `\t`, `\r`, `\0` (as `\u0000`), `"`, `\` are identical under both settings (`control/quote/backslash prefix identical: True`); U+007F **is** escaped (`\u007f`) only when `True`, and U+00E9 (é) only when `True`, raw otherwise:

```
True  -> '"a\\nb\\tc\\\\d\\"e\\u0000f\\u007fg\\u00e9"'
False -> '"a\\nb\\tc\\\\d\\"e\\u0000f\x7fgé"'
flag governs only [^ -~]: True escapes U+007F -> True | False keeps 0x7f raw -> True
```

### 5. Precedence — explicit `ensure_ascii=` override wins

Because of `setdefault` (line 177), the precedence is: **explicit per-call kwarg > attribute > stdlib default**. Both directions hold (run step e):

```
attr True,  no kwarg    : '"\\u2603"'
attr True,  kwarg False : '"☃"'  <-- kwarg wins
attr False, no kwarg    : '"☃"'
attr False, kwarg True  : '"\\u2603"'  <-- kwarg wins
```

Consequence for experiments: any call that passes `ensure_ascii` explicitly does **not** reflect the attribute and must not be cited as evidence about it.

### 6. Blast radius — which code paths the attribute governs

The attribute is authoritative for:

| Entry point | Location | Detail |
|---|---|---|
| `app.json.dumps` | `provider.py:166-179` | the direct path |
| `app.json.dump` (file) | `provider.py:49-57` | `fp.write(self.dumps(obj, **kwargs))` |
| `DefaultJSONProvider.response` → `jsonify()` | `provider.py:189-215`, `json/__init__.py:170` | `f"{self.dumps(obj, **dump_args)}\n"`, `mimetype=self.mimetype`; only `indent`/`separators` go into `dump_args`, so `ensure_ascii` still arrives via the attribute |
| dict/list returned from a view | `app.py:1230-1231` — `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)` | the baseline path used by the Flask comparison arm |
| test-client `json=` payloads | `testing.py:88-94` — `return self.app.json.dumps(obj, **kwargs)`, consumed by werkzeug `test.py:366-373` | **not** `app.py:422` |
| `flask.json.dump` (context active) | `json/__init__.py:47-74` | delegates to `current_app.json.dump` |
| Jinja `\|tojson` filter | `sansio/app.py:230` → `app.py:422` `rv.policies["json.dumps_function"] = self.json.dumps` | follows it for non-ASCII, but Jinja always applies its own `\u003c/\u003e/\u0026/\u0027` HTML-safety escapes regardless |
| provider wiring | `sansio/app.py:230` `json_provider_class: type[JSONProvider] = DefaultJSONProvider`; `:329` `self.json: JSONProvider = self.json_provider_class(self)` | |

Reproduction confirms the governed paths:

```
test-client json= body (False): b'{"snowman": "\xe2\x98\x83"}'
test-client json= body (True) : b'{"snowman": "\\u2603"}'
EnvironBuilder(app, json=EURO) input_stream: '"€"'
EnvironBuilder(app, json=EURO) input_stream (True): '"\\u20ac"'
```

and the `|tojson` filter:

```
ensure_ascii= True -> 'const d = {"h": "\\u003c/script\\u003e", "n": "\\u2603"};'
ensure_ascii= False -> 'const d = {"h": "\\u003c/script\\u003e", "n": "☃"};'
```

The in-tree test `tests/test_testing.py:110-114` is the second (and only other) occurrence of the attribute in the tree:

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

**What it does *not* govern (scope caveats — the main trap):**

1. **Context-free `flask.json.dumps` bypasses the provider entirely.** `json/__init__.py:40-44`:
   ```python
       if current_app:
           return current_app.json.dumps(obj, **kwargs)

       kwargs.setdefault("default", _default)
       return _json.dumps(obj, **kwargs)
   ```
   Without an app/request context it uses stdlib `json.dumps`, whose *own* default is `ensure_ascii=True`. The ASCII-escaped output there is **not** attributable to `app.json.ensure_ascii`:
   ```
   === (6i) context-free flask.json.dumps ignores the attribute ===
   no ctx, attr=False -> flask.json.dumps(SNOWMAN): '"\\u2603"'
   no ctx, attr=False -> stdlib json.dumps(SNOWMAN) shows default True: '"\\u2603"'
   in ctx, attr=False -> flask.json.dumps(SNOWMAN): '"☃"'
   in ctx, attr=True  -> flask.json.dumps(SNOWMAN): '"\\u2603"'
   ```
2. **The session serializer is a different serializer — but it is not independent in-context.** `sessions.py:287` `session_json_serializer = TaggedJSONSerializer()` and `:314-315` `serializer = session_json_serializer`; `flask/json/tag.py:321-327` `def dumps(self, value): return dumps(self.tag(value), separators=(",", ":"))` calls **`flask.json.dumps`**, which delegates to the app provider whenever a context is active. Sessions are saved while a request context is live, so the tagged payload *does* follow `app.json.ensure_ascii`:
   ```
   tag.dumps no ctx, attr=False : '{"k":"\\u2603"}'
   tag.dumps in ctx, attr=False : '{"k":"☃"}'
   tag.dumps in ctx, attr=True  : '{"k":"\\u2603"}'
   ```
   The plan's framing ("session cookie serialization is not configured by `app.json.ensure_ascii`") is therefore **only true in the contextless case**. Moreover, the actual `Set-Cookie` header is ASCII either way, because itsdangerous base64-encodes the payload; only the payload bytes differ (E2):
   ```
   app.json.ensure_ascii= False | session=eyJzbm93bWFuIjoi4piDIn0... | header isascii: True | len: 66 | decoded: b"'\xe2\x98\x83'"
   app.json.ensure_ascii= True  | session=eyJzbm93bWFuIjoiXHUyNjAzIn0... | header isascii: True | len: 70 | decoded: b"'\xe2\x98\x83'"
   ```

The exhaustive sweep confirms there is no other producer/consumer of the attribute in this tree — exactly 5 hits:

```
./src/flask/json/provider.py:144:    ensure_ascii = True
./src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
./src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
./tests/test_json.py:52:    app.json.ensure_ascii = test_value
./tests/test_testing.py:112:    app.json.ensure_ascii = False
```

### 7. Lineage — `ensure_ascii` is the successor of the old config key, not a separate knob

- `docs/config.rst:418-419`: `.. versionadded:: 0.10` — *"``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``"*.
- `CHANGES.rst:285-288` (2.2.0): *"JSON configuration is moved to attributes on the default ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are deprecated. :pr:`4692`"*
- `CHANGES.rst:153-154` (2.3.0): *"The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed."*
- `docs/config.rst:440-443`: *".. versionchanged:: 2.3 — ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has equivalent attributes instead."*

So on this checkout (3.2.0.dev) the only control is the provider attribute; `JSON_AS_ASCII` no longer exists.

### 8. Verification status

All quotes were line-verified in-run (`E5`). The executable evidence is green: the four targeted tests plus the containing files, the whole checkout suite, and a keyword sweep all pass —

```
tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED
tests/test_testing.py::test_environbuilder_json_dumps PASSED
tests/test_json.py::test_json_dump_to_file PASSED
tests/test_json.py::test_tojson_filter PASSED
===== 5 passed in 0.12s =====
70 passed in 0.41s   (test_json.py test_json_tag.py test_testing.py)
489 passed in 3.15s  (whole suite)
55 passed, 434 deselected  (-k "unicode or ascii or json")
```

and the checkout was left byte-clean (`git status -s` empty; HEAD still `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`; only gitignored `.venv/`, `.pytest_cache/`, `__pycache__/` touched), so the TXT-vs-SYN comparison-arm provenance is untouched. Proportionate confidence: the two-way contrast, non-BMP surrogate-pair escaping, semantic invariance, `setdefault` precedence, the `[^ -~]`-only escape scope, and the in-context tagged-serializer dependency are all reproduced directly; class attribution is `已实现且已验证`.

### 9. Plan-citation corrections carried into this answer

1. `src/flask/app.py:422` is the Jinja `json.dumps_function` policy (`|tojson`), **not** the test-client path; the test-client path is `src/flask/testing.py:88-94` feeding werkzeug's `json_dumps` hook.
2. No `; charset=utf-8` is emitted for `application/json`; the body str is UTF-8-encoded, the header is not charset-annotated. The "e.g. `application/json; charset=utf-8`" premise should be dropped.
3. `docs/config.rst` lineage lines are `:418-419` and `:440-443` (not `:441-443`).
4. Session-cookie serialization **does** follow `app.json.ensure_ascii` when a context is active (it delegates through `flask.json.dumps`); "not configured by the attribute" holds only contextlessly. The cookie header stays ASCII regardless, via itsdangerous base64.
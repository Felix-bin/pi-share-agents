# The relationship between `ensure_ascii` (the ASCII-only encoding control) and Unicode representation in Flask's JSON output

Short answer: the parameter is `ensure_ascii`, a **class attribute of `flask.json.provider.DefaultJSONProvider` defaulting to `True`**, and it is a *representation switch only*. When `True`, **every** non-ASCII character in the serialized JSON — in string values *and* in object keys, including characters outside the BMP — is replaced by JSON `\uXXXX` escape sequences, so the serialized text is pure ASCII (and larger). When `False`, the characters are emitted literally and encoded as UTF-8 in the response body (smaller, non-ASCII bytes). In both cases the *decoded value is identical*: `json.loads()` of either form returns the same object. The switch is applied as a **default** inside `DefaultJSONProvider.dumps` via `kwargs.setdefault`, so an explicit `ensure_ascii=` keyword argument wins, and it is per-instance (assigning `app.json.ensure_ascii = False` shadows the class attribute for that app only).

Everything below is grounded either in the repository under study (`D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`, a pristine clone at `85c5d93`) or in executed evidence. Read-only source excerpts and executed command outputs are distinguished explicitly.

---

## 1. The named parameter and its owner

The worktree is Flask `3.2.0.dev` (`pyproject.toml`: `name = "Flask"`, `version = "3.2.0.dev"`), HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`.git/HEAD`), with `.git/logs/HEAD` recording a single `clone: from https://github.com/pallets/flask` followed by `checkout: moving from main to 85c5d93`. It is not a mutation or a corrupted tree.

The parameter is declared in `src/flask/json/provider.py`, as a class attribute of `DefaultJSONProvider` (class definition at line 124), at **line 144**:

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

The surrounding attribute block (verbatim, real line numbers from the executor's grep):

```
144:    ensure_ascii = True
...
150:    sort_keys = True
157:    compact: bool | None = None
163:    mimetype = "application/json"
166:    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
189:    def response(self, *args: t.Any, **kwargs: t.Any) -> Response:
```

The class docstring says the whole point of `DefaultJSONProvider` is delegation to the stdlib: *"Provide JSON operations using Python's built-in :mod:`json` library."* The module imports stdlib `json` (lines 1–16), and `dumps` ends with `return json.dumps(obj, **kwargs)` (line 179).

**Ownership is exclusive.** A repo-wide grep for `ensure_ascii` (executed; command `grep -rn "ensure_ascii" src tests CHANGES.rst docs pyproject.toml`) returns exactly three source hits — all in `provider.py` (144, 171, 177) — plus the two tests that set it:

```
src/flask/json/provider.py:144:    ensure_ascii = True
src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
tests/test_json.py:52:    app.json.ensure_ascii = test_value
tests/test_testing.py:112:    app.json.ensure_ascii = False
```

(The only other grep hits are `__pycache__` binaries.) Nothing in `src/` elsewhere owns an ASCII switch; the sole `ascii` reference in `src/flask/json/tag.py` is `line 167: return b64encode(value).decode("ascii")` inside `TagBytes.to_json` (base64, unrelated).

---

## 2. The mechanism: a default, not a forced value

The provider's own `dumps` (line 166) forwards the attribute into the stdlib call through `setdefault` — **line 177**:

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

`setdefault` means the attribute supplies the value **only when the caller did not pass `ensure_ascii=`** — the parameter is functionally "stdlib `json.dumps`'s `ensure_ascii` argument, with the provider attribute as its default."

The instance `app.json` is created in `src/flask/sansio/app.py` from the class attribute `json_provider_class: type[JSONProvider] = DefaultJSONProvider` (line 230) via `self.json: JSONProvider = self.json_provider_class(self)` (line 329), so the class attribute default applies to every app unless overridden. Both are documented with `.. versionadded:: 2.2`, i.e. the provider-object era.

**Call path (each hop cited):**

- A view returning a dict → `app.json.response()` (`provider.py:189`) → `_prepare_response_obj` (`provider.py:75`) → `self.dumps(obj, **dump_args)`, where `dump_args` sets either `indent` or `separators` (`provider.py:199-208`) → **`kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`)** → stdlib `json.dumps(obj, **kwargs)` (`provider.py:179`) → wrapped as `f"{self.dumps(obj, **dump_args)}\n"` with `mimetype=self.mimetype` (`provider.py:214`). The trailing newline is why the byte counts below are 15 and 12 rather than 14 and 11.
- `jsonify` → `return current_app.json.response(*args, **kwargs)` (`src/flask/json/__init__.py:170`).
- File-writing path: base-class `JSONProvider.dump` does `fp.write(self.dumps(obj, **kwargs))` (`provider.py:58`), so it inherits the same attribute.
- Session serializer: `TaggedJSONSerializer.dumps` (`src/flask/json/tag.py:321`) → module-level `dumps(self.tag(value), separators=(",", ":"))` (`tag.py:56`, `tag.py:323`) → `current_app.json.dumps` (`json/__init__.py:41`) → same attribute. `tag.py` has no ASCII knob of its own.
- `EnvironBuilder.json_dumps` → `return self.app.json.dumps(obj, **kwargs)` (`src/flask/testing.py:94`).

Executed confirmation of the file and session paths (heredoc run under `flask-src/.venv/Scripts/python.exe`, exit 0):

```
--- CLAIM: JSONProvider.dump() inherits via fp.write(self.dumps(...)) ---
dump True  -> '{"s": "\\u2603"}' as-is '{"s": "\\u2603"}' len 15 isascii True
dump False -> '{"s": "\u2603"}' as-is '{"s": "☃"}' len 10 isascii False

--- session serializer INSIDE app context (provider attribute governs) ---
True  -> '{"s":"\\u2603"}' isascii True
False -> '{"s":"\u2603"}' isascii False
differ -> True
loads round-trip equal -> True
TaggedJSONSerializer own 'ascii' attrs -> []

--- jsonify -> current_app.json.response() follows the attribute ---
jsonify True  body bytes -> b'{"s":"\\u2603"}\n' len 15 isascii True
jsonify False body bytes -> b'{"s":"\xe2\x98\x83"}\n' len 12 isascii False
```

---

## 3. The two representations, with the snowman

The repository's **own test** encodes the relationship as a parameterization — `tests/test_json.py` lines 48–54 (verbatim):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

That is the canonical statement: for U+2603 SNOWMAN, `True` → `"\u2603"` (an escape sequence; string length 8 including the two quotes) and `False` → `"☃"` (the literal character; length 3).

Executed probe output (`flask-src-scratch/json_ensure_ascii_probe.py`, re-run in this session, exit 0; also reproduced line-for-line in the pre-existing `json_ensure_ascii_probe.py.run1-raw`):

```
--- check 2: True => escape sequence, False => literal character ---
input              : U+2603 SNOWMAN, ascii() = '\u2603'
ensure_ascii=True  : repr()='"\\u2603"'  ascii()='"\\u2603"'  len=8
ensure_ascii=False : repr()='"☃"'  ascii()='"\u2603"'  len=3
True branch is pure ASCII  : True
False branch is pure ASCII : False
True branch bytes (utf-8)  : b'"\\u2603"'
False branch bytes (utf-8) : b'"\xe2\x98\x83"' (len 5)
[PASS] check2a True yields the 8-char text "\u2603"
        out_true == '"\\u2603"' -> True; len=8
[PASS] check2b False yields the 3-char text "<snowman>"
        out_false == quote+U+2603+quote -> True; len=3; ord of middle char = 9731
```

Note the byte-level distinction, which is the part a mis-decoded console can hide: the escaped form's UTF-8 bytes are `b'"\\u2603"'` (pure ASCII: quote, backslash, `u2603`, quote), while the literal form's bytes are `b'"\xe2\x98\x83"'` — the three-byte UTF-8 encoding of U+2603 between two ASCII quotes.

The same file's independent boundary matrix (`ensure_ascii_boundary_matrix.py`, 18/18 PASS, exit 0) repeats it:

```
--- (1) True => escape sequence, False => literal character ---
input                : U+2603 SNOWMAN ascii()='\u2603' ord=9731
ensure_ascii=True    : repr()='"\\u2603"' ascii()='"\\u2603"' len=8
ensure_ascii=False   : repr()='"☃"' ascii()='"\u2603"' len=3
True form isascii()  : True
False form isascii() : False
True form utf-8 bytes: b'"\\u2603"'
False form utf-8 bytes: b'"\xe2\x98\x83"'
[PASS] 1a True -> 8-char ASCII escape sequence
        out_true == '"\\u2603"' -> True; len=8; isascii=True
[PASS] 1b False -> 3-char literal character, ord 9731
        out_false == quote+U+2603+quote -> True; len=3; ord(out_false[1])=9731
[PASS] 1c True branch is pure ASCII; False branch is not
        True.isascii()=True; False.isascii()=False; False bytes=b'"\xe2\x98\x83"'
```

### 3a. Object keys are escaped too

`ensure_ascii` applies to keys as well as values (it is a stdlib `json.dumps` flag, applied to every emitted string). Executed:

```
--- (3) object keys are escaped too ---
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'  count('\\u2603')=2
ensure_ascii=False : ascii()='{"\u2603": "\u2603"}'  count(literal)=2
True form isascii(): True
[PASS] 3a key and value are both escaped under True
        escapes=2 (key+value); literal count=2; isascii=True
```

and from the probe:

```
--- check 5: object keys are escaped too ---
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'
ensure_ascii=False : ascii()='{"\u2603": "\u2603"}'
True branch is pure ASCII  : True
True branch contains 2 escapes: 2 (key + value)
[PASS] check5a True escapes key and value (count of \u2603 == 2)
```

### 3b. Non-BMP characters become UTF-16 surrogate pairs

A character above U+FFFF cannot be written as a single `\uXXXX`; under `True` it is emitted as a surrogate pair, not as `\U0001f600`. Executed:

```
--- (4) non-BMP text uses UTF-16 surrogate-pair escapes ---
input U+1F600        : ascii()='\U0001f600' ord=128512 single_char=True
ensure_ascii=True    : ascii()='"\\ud83d\\ude00"' len=14
ensure_ascii=False   : ascii()='"\U0001f600"' len=3
[PASS] 4a True -> surrogate pair \ud83d\ude00, not \U0001f600
        escape == '"\\ud83d\\ude00"' -> True; len=14
[PASS] 4b False -> the single literal character
        literal -> True; len=3
```

and, matching, from the probe:

```
--- check 4: non-BMP text uses UTF-16 surrogate-pair escapes ---
input U+1F600 ascii()      : '\U0001f600'  (ord=128512, single char)
ensure_ascii=True          : ascii()='"\\ud83d\\ude00"'  len=14
ensure_ascii=False         : ascii()='"\U0001f600"'  len=3
True branch is pure ASCII  : True
[PASS] check4a True -> two \uXXXX surrogate escapes (\ud83d\ude00)
```

`len=14` = 2 quotes + 12 characters (`\ud83d` + `\ude00` are 6 characters each).

### 3c. The attribute is a default the caller can override

Executed, both directions, proving `setdefault` semantics:

```
--- (2) explicit kwarg beats the attribute (setdefault) ---
attr True,  no kwarg          : ascii()='"\\u2603"'
attr True,  ensure_ascii=False: ascii()='"\u2603"'
attr False, ensure_ascii=True : ascii()='"\\u2603"'
[PASS] 2a kwarg overrides attribute both directions
        no_kwarg escaped=True; kwarg_false literal=True; kwarg_true escaped=True
```

### 3d. Per-instance shadowing, not global mutation

Assigning to one app's provider does not touch the class attribute or other apps' providers. Executed:

```
--- (9) per-instance shadowing does not touch the class or other apps ---
class attr before            : True
app_a before                 : True  ('ensure_ascii' in app_a.json.__dict__=False)
app_a after  assignment      : False  ('ensure_ascii' in app_a.json.__dict__=True)
app_b (fresh, untouched)     : True
class attr after             : True
[PASS] 9a assignment shadows only that instance; class and other apps unchanged
        class True->True; app_a True->False; app_b True; own __dict__ False->True
```

---

## 4. The invariant: representation changes, the decoded value does not

This is the heart of the relationship. The round-trip was asserted on a payload containing BMP and non-BMP characters, a list, and an integer. Executed (probe, `--- check 8`):

```
--- check 8: round-trip equivalence of the two representations ---
payload            : ascii()={'a': 1, 's': '\u2603', 'e': '\u20ac', 'g': '\U0001f600', 'l': ['x', '\u2603']}
ensure_ascii=True  : ascii()='{"a": 1, "e": "\\u20ac", "g": "\\ud83d\\ude00", "l": ["x", "\\u2603"], "s": "\\u2603"}'
ensure_ascii=False : ascii()='{"a": 1, "e": "\u20ac", "g": "\U0001f600", "l": ["x", "\u2603"], "s": "\u2603"}'
loads(True-form)   == payload : True
loads(False-form)  == payload : True
loads(True) == loads(False)   : True
re-serializing values unchanged: True
[PASS] check8a both representations deserialize to the identical value
        rt_true==payload True; rt_false==payload True; rt_true==rt_false True
[PASS] check8b representation lengths differ but values identical
        len(True-form)=81 vs len(False-form)=55; values still equal -> True
```

and independently in the boundary matrix:

```
--- (5) round-trip: representation changes, value does not ---
payload            : ascii()={'a': 1, 's': '\u2603', 'e': '\u20ac', 'g': '\U0001f600', 'l': ['x', '\u2603']}
True text          : ascii()='{"a": 1, "e": "\\u20ac", "g": "\\ud83d\\ude00", "l": ["x", "\\u2603"], "s": "\\u2603"}'
False text         : ascii()='{"a": 1, "e": "\u20ac", "g": "\U0001f600", "l": ["x", "\u2603"], "s": "\u2603"}'
loads(True)  == payload : True
loads(False) == payload : True
loads(True)  == loads(False) : True
len(True text)=81  len(False text)=55
[PASS] 5a both representations deserialize to the identical object
        rt_true==payload True; rt_false==payload True; equal True
[PASS] 5b serialized lengths differ while values stay equal
        len(True)=81 != len(False)=55, yet decoded values equal -> True
```

So `ensure_ascii` is **lossless**: both forms are valid JSON and `json.loads` normalizes them to the unbelievable-identical Python object. Also note the encoding guarantee holds — because escapes are pure ASCII and literals are valid UTF-8, both bodies are valid JSON text regardless of the flag.

---

## 5. The observable HTTP consequence

Route output is built as `f"{self.dumps(obj, **dump_args)}\n"` with `mimetype=self.mimetype` (`application/json`) in `response()` (`provider.py:210-214`), so the flag is visible on the wire as body bytes, `Content-Length`, and ASCII-ness. Executed, for `{"s": "<snowman>"}`:

```
--- check 7: HTTP response bytes / Content-Length ---
(i)  default (ensure_ascii=True)  body bytes=b'{"s":"\\u2603"}\n'
     Content-Length=15  mimetype=application/json  len(body)=15  body.isascii()=True
(ii) app.json.ensure_ascii=False  body bytes=b'{"s":"\xe2\x98\x83"}\n'
     Content-Length=12  mimetype=application/json  len(body)=12  body.isascii()=False
byte-length difference (default - literal) = 3
[PASS] check7a default branch body is ASCII-only escaped
[PASS] check7b literal branch body is raw UTF-8
[PASS] check7c Content-Length differs between the two branches
        default CL=15 (=len(body)=15), literal CL=12 (=len(body)=12), delta=3
```

and again in the matrix:

```
--- (6) HTTP body bytes and Content-Length ---
(i)  default  body bytes = b'{"s":"\\u2603"}\n'
     Content-Length=15 mimetype=application/json len(body)=15 isascii=True
(ii) literal  body bytes = b'{"s":"\xe2\x98\x83"}\n'
     Content-Length=12 mimetype=application/json len(body)=12 isascii=False
byte delta (default - literal) = 3
[PASS] 6a default body is ASCII-only escaped, CL=15
[PASS] 6b literal body is raw UTF-8, CL=12
```

Interpretation: the trailing `\n` (added by `response()`) accounts for 1 byte; the payload is 14 characters escaped versus 11 bytes literal, hence 3 bytes more on the wire with `ensure_ascii=True`. The mimetype is `application/json` in both branches — the flag changes bytes, not content type. The docstring's trade-off is therefore literal: escaping "may be more compatible with some clients" (ASCII-only, immune to encoding mishaps) but costs "performance and size" (the 3-byte delta here, and 26 bytes more on the probe's mixed payload: 81 vs 55 characters).

The escaped spelling is genuinely single-backslash, not double-escaped — the pre-existing corroboration script `flask-src-scratch/verify_probe_literal.py` (exit 0) prints:

```
observed BODY                  : b'{"s":"\\u2603"}\n' len 15
ONE  (payload 1 backslash)     : b'{"s":"\\u2603"}\n' len 15
TWO  (payload 2 backslashes)   : b'{"s":"\\\\u2603"}\n' len 16
BODY == ONE  -> True
BODY == TWO  -> False
BODY backslash count = 1
BODY is ascii -> True
VERIFY COMPLETE
```

---

## 6. Boundaries: what is *not* governed by this parameter

### 6a. `|tojson`'s HTML-safety escaping is independent of `ensure_ascii`

The `|tojson` filter is wired to the app's provider (`src/flask/app.py`: `rv.policies["json.dumps_function"] = self.json.dumps`), but Jinja then post-processes the *string* with `.replace()` calls — `htmlsafe_json_dumps` in `.venv/Lib/site-packages/jinja2/utils.py`:

```python
    return markupsafe.Markup(
        dumps(obj, **kwargs)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("'", "\\u0027")
    )
```

This happens *after* `dumps()`, so `<` → `\u003c` regardless of the flag. The repo's own `test_tojson_filter` (`tests/test_json.py:210-221`) pins that escaping. Executed contrast, with `ensure_ascii=False` explicitly:

```
--- check 9 (CONTRAST): |tojson escapes < > & ' regardless ---
ensure_ascii=False, data={'x': '</script>'} -> ascii()='{"x": "\\u003c/script\\u003e"}'
ensure_ascii=False, data={'s': U+2603}       -> ascii()='{"s": "\u2603"}'
contains \u003c escaping: True
snowman left literal (not \u2603): True
[PASS] check9a |tojson still escapes < as \u003c with ensure_ascii=False
[PASS] check9b |tojson leaves the snowman literal when ensure_ascii=False
```

i.e. the same serialization carries an HTML-escaped `<` *and* a literal snowman — proof the two escaping layers are orthogonal. Jinja's default policy supplies only `"json.dumps_kwargs": {"sort_keys": True}`, so `ensure_ascii` itself comes from the provider attribute.

### 6b. `JSON_AS_ASCII` no longer exists; `app.json.ensure_ascii` is the supported spelling

Executed: `grep -rn "JSON_AS_ASCII\|AS_ASCII\|SORT_KEYS" src/` → exit 1, no matches. The only occurrences anywhere in the tree are history/docs:

```
./CHANGES.rst:153:    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
./CHANGES.rst:286:    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
./docs/config.rst:419:   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
./docs/config.rst:441:    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
```

The history resolves as: deprecated in **2.2.0** — *"JSON configuration is moved to attributes on the default `app.json` provider. `JSON_AS_ASCII`, `JSON_SORT_KEYS`, `JSONIFY_MIMETYPE`, and `JSONIFY_PRETTYPRINT_REGULAR` are deprecated. :pr:`4692`"* (`CHANGES.rst:285-288`) — and removed in **2.3.0** — *"The `JSON_AS_ASCII`, `JSON_SORT_KEYS`, `JSONIFY_MIMETYPE`, and `JSONIFY_PRETTYPRINT_REGULAR` config keys are removed."* (`CHANGES.rst:153-154`). Executed confirmation that the key is dead at runtime:

```
--- check 10 (CONTRAST): JSON_AS_ASCII config key is gone ---
'JSON_AS_ASCII' in app.config                  = False
'JSON_SORT_KEYS' in app.config                 = False
hasattr(app.config, 'JSON_AS_ASCII')           = False
supported spelling: app10.json.ensure_ascii    = True
[PASS] check10a JSON_AS_ASCII is not a live config key
[PASS] check10b app.json.ensure_ascii is the supported spelling
```

### 6c. Outside an app context, `flask.json.dumps` does not consult the provider

`src/flask/json/__init__.py` lines 40–44 and 70–74 (verbatim):

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```
```python
    if current_app:
        current_app.json.dump(obj, fp, **kwargs)
    else:
        kwargs.setdefault("default", _default)
        _json.dump(obj, fp, **kwargs)
```

The no-context fallback sets **only** `default` — never `ensure_ascii` — so stdlib's own `ensure_ascii=True` applies, no matter what any app's provider says. Executed:

```
--- check 6: flask.json.dumps outside vs inside app context ---
has_app_context() at this point = False
outside app ctx, flask.json.dumps -> ascii()='"\\u2603"'
inside app ctx, app.json.ensure_ascii=False -> ascii()='"\u2603"'
inside app ctx, app.json.ensure_ascii=True  -> ascii()='"\\u2603"'
after ctx exit, has_app_context() = False
[PASS] check6a outside app context: escaped (CPython json.dumps default True)
        ascii()='"\\u2603"'; flask.json.__init__ only sets 'default' outside ctx
[PASS] check6b inside app context: follows app.json.ensure_ascii
```

This is why the session serializer (`TaggedJSONSerializer.dumps` → `flask.json.dumps`) honours `app.json.ensure_ascii` only *inside* an app context; outside one it emits escapes unconditionally. The first (deliberately kept) executor run showed this directly:

```
--- session serializer OUTSIDE app context (flask.json.dumps falls back to stdlib) ---
TaggedJSONSerializer.dumps (no ctx) -> '{"s":"\\u2603"}' isascii True
```

### 6d. `sort_keys` is a separate attribute

Executed, confirming the two knobs are independent:

```
--- (11) sort_keys is a separate attribute, unaffected by ensure_ascii ---
sort_keys=True  (class default) : ascii()='{"a": 2, "b": 1}'
sort_keys=False (own attr)      : ascii()='{"b": 1, "a": 2}'
DefaultJSONProvider.sort_keys   : True
[PASS] 11a sort_keys is an independent attribute
```

---

## 7. Executed verification of the whole claim: the repository's own tests

**Targeted pair (exit 0):**

```
".venv/Scripts/python.exe" -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -v
```
```
tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [ 33%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 66%]
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [100%]

============================== 3 passed in 0.05s ==============================
```

Both branches of the parameterization passed. The `EnvironBuilder` test exercises the same knob through a different entry point — `tests/test_testing.py:110-114` (verbatim):

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

**Full suite, three runs, all exit 0, all `489 passed`:**

```
489 passed in 2.06s
489 passed in 2.04s
489 passed in 2.11s
```

with the maximally verbose log `flask-src-scratch/pytest-full-run_executor-vv-rA.txt` (105,024 bytes, 1,453 lines) containing no `FAILED` test-status line, and `.pytest_cache/v/cache/lastfailed` = `{}`. The earlier pre-existing logs agree (`pytest-full-run2-verbose-ensure_ascii.txt` header: `platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- …flask-src\.venv\Scripts\python.exe`, `configfile: pyproject.toml`, `collected 489 items`, tail `489 passed in 2.20s`; companions `2.14s`, `2.22s`).

**Environment identity (the discriminator against importing a different Flask):**

```
python 3.13.9
flask.__file__ D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
dist version 3.2.0.dev0
DefaultJSONProvider.ensure_ascii True <class 'bool'>
```

`flask.__file__` resolves inside `flask-src\src\flask\__init__.py`, confirmed by the editable-install path file `.venv/Lib/site-packages/flask.pth` containing exactly `D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src`. A second checkout exists at `experiments/data/worktree/flask/` at the same commit (`worktree/.build-manifest.json`: `"flaskCommit": "85c5d93cbd049c4bd0679c36fd1ddcae8c37b642"`), so the `flask.__file__` print matters — and it points at the tree under study.

**Worktree integrity:** `git status --porcelain` after all work shows only `?? flask_mut2_i417ar2x/` (a pre-existing untracked distractor with no JSON/ASCII content — an unrelated `url_for`/subdomain assertion). No tracked file was modified; all new artifacts went to `flask-src-scratch/`.

---

## 8. Verdict and self-check

**The relationship, in one paragraph:** `ensure_ascii` is the ASCII-only encoding control of Flask's JSON serialization provider (`DefaultJSONProvider.ensure_ascii`, class attribute, default `True`, `provider.py:144`) and it sits between the provider and stdlib `json.dumps` as a `setdefault` default (`provider.py:177`). It governs how Unicode *characters* are rendered in serialized output: `True` renders every non-ASCII character — in values and keys alike, non-BMP characters as `\uXXXX` surrogate pairs — as JSON `\uXXXX` escapes, producing pure-ASCII, larger output; `False` renders them literally, producing UTF-8, smaller output. It never affects the decoded value (round-trip equality holds for both forms), it is orthogonal to `|tojson`'s HTML-safety replacements and to `sort_keys`, it no longer has a config-key spelling (`JSON_AS_ASCII` was deprecated in 2.2 and removed in 2.3; use `app.json.ensure_ascii = False`), and outside an app context `flask.json.dumps` bypasses the provider entirely so stdlib's own `ensure_ascii=True` applies.

**Self-check line.** Executed in this session: the environment/identity command; the repo-wide grep proving sole ownership; the probe `json_ensure_ascii_probe.py` (**10/10 checks PASS, `CHECKS FAILED: 0`**, **`PROBE COMPLETE`**); the new boundary matrix `ensure_ascii_boundary_matrix.py` (**18/18 PASS, `CHECKS FAILED: 0`**, `EXIT 0`); the byte-spelling corroboration `verify_probe_literal.py` (`VERIFY COMPLETE`); the file/session/`jsonify` call-path heredoc runs; the targeted pytest pair (3 passed); and the full suite three times (`489 passed` ×3). All checks passed — none failed, and no source-read-only claim is presented as measured. Interpreter and import origin for every executed artifact: `D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe` (Python 3.13.9), `flask.__file__` = `…\flask-src\src\flask\__init__.py`, distribution `3.2.0.dev0`, HEAD `85c5d93`.

**Kinds of evidence, labelled:**
- *Executed/measured:* probe checks 1–10, matrix checks 1–11, the `verify_probe_literal.py` byte spellings, the call-path runs, the targeted pytest pair, the three full-suite runs.
- *Source-read-only (cited by `path:line`):* `provider.py:144/166/171/177/189/214`, `json/__init__.py:40-44/70-74/170`, `tag.py:56-57/321-323`, `sansio/app.py:230/329`, `app.py` (Jinja `json.dumps_function` wiring), `testing.py:94`, `tests/test_json.py:48-54/210-221`, `tests/test_testing.py:110-114`, `CHANGES.rst:153-154/285-288`, `docs/config.rst:419/441`, `docs/api.rst` (provider/Jinja prose), `pyproject.toml`.
- *Cosmetic artifacts, reported as status not as findings:* check7a of the pre-existing probe prints a detail string `equals b'{"s":"\\u2603"}\n' -> False` although the check is `[PASS]` (the detail string double-escapes the literal; the assertion used the correct single-backslash bytes, independently corroborated by `verify_probe_literal.py`). The boundary matrix's own checks 6c/7a/7b detail strings have the same double-escaping display quirk; their assertions passed. One harness defect in the executor's own heredoc probe (`vars()` on a `__slots__` class → `TypeError`) was fixed and re-run; the underlying claim then verified. The plan's literal step-4a one-liner failed because Flask 3.2.0.dev no longer exposes `flask.__version__`; the executor substituted `importlib.metadata.version('Flask')` → `3.2.0.dev0`.

Nothing here is a defect or a mutation: the tree is a clean single clone at `85c5d93` with the full suite green, and the answer is descriptive.
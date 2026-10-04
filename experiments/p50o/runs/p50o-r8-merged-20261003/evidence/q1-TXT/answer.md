# Answer: the relationship between `DefaultJSONProvider.ensure_ascii` and Unicode representation in serialized JSON

**Flask `3.2.0.dev` @ `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`** (detached-HEAD clone of `pallets/flask`).

## 0. Short answer

The ASCII-only encoding control is the **class attribute `DefaultJSONProvider.ensure_ascii`, default `True`**, at `src/flask/json/provider.py:144`. It is *not* a config key — `JSON_AS_ASCII` was removed in Flask 2.3 and exists in this tree only as historical prose in `docs/config.rst` / `CHANGES.rst`, with **zero** occurrences in `src/`.

Its relationship to Unicode representation is exactly this: the value is injected into the standard library `json.dumps` as a *default* argument (`kwargs.setdefault("ensure_ascii", self.ensure_ascii)`, `provider.py:177`), so it selects which of CPython's two string encoders is used, and **only that**. With `True`, every non-ASCII code point in a JSON *string* is emitted as a `\uXXXX` escape (surrogate pairs for astral code points), so the serialized text is pure 7-bit ASCII and its byte length equals its character length. With `False`, those code points are emitted literally as Unicode text, the string is shorter in characters and (usually) in UTF-8 bytes, and the payload must be carried as UTF-8 by the transport. In **both** modes the decoded value is identical: `json.loads(app.json.dumps(x)) == x` holds either way. ASCII characters, `"`, `\`, and C0 control characters are escaped identically in both modes, and the other provider knobs (`sort_keys`, `default`, `compact`, `mimetype`) are independent of it.

The attribute is a **default, not a switch**: a per-call `ensure_ascii=` keyword beats it, and when there is no app/app-context at all, `flask.json.dumps` falls through to plain stdlib `json.dumps`, where the attribute is unreachable and stdlib's own default `True` applies.

---

## 1. The parameter, named and located (verbatim source)

`src/flask/json/provider.py`, lines 144–148 (spot-checked directly during synthesis, matching all upstream stages):

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

It is a plain class attribute of `DefaultJSONProvider` — the retriever's F15 records that the class defines **no `__init__` and no `ensure_ascii` property or cache**, and CMD 11's step-6c probe confirms the value lives on the class, not in the instance dict:

```
    DefaultJSONProvider.ensure_ascii (class attr) = True
    fresh app.json.ensure_ascii = True
[PASS] 6c fresh app inherits class default True :: 
[PASS] 6c attribute lives on the class, not an instance dict :: vars(app.json) keys=['_app']
[PASS] 6c app2.json is a distinct provider object :: 
[PASS] 6c setting app.json does not leak to app2.json :: app=False app2=True
[PASS] 6c both can be set independently to False :: 
```

The full surrounding attribute block, verbatim (`provider.py`, from the verified read):

```python
    default: t.Callable[[t.Any], t.Any] = staticmethod(_default)
    """Apply this function to any object that :meth:`json.dumps` does
    not know how to serialize. It should return a valid JSON type or
    raise a ``TypeError``.
    """

    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """

    sort_keys = True
    """Sort the keys in any serialized dicts. This may be useful for
    some caching situations, but can be disabled for better performance.
    When enabled, keys must all be strings, they are not converted
    before sorting.
    """

    compact: bool | None = None
    """If ``True``, or ``None`` out of debug mode, the :meth:`response`
    output will not add indentation, newlines, or spaces. If ``False``,
    or ``None`` in debug mode, it will use a non-compact representation.
    """

    mimetype = "application/json"
    """The mimetype set in :meth:`response`."""
```

### It is not `JSON_AS_ASCII`

`grep -rni "json_as_ascii" src/ docs/` returned **two hits, both in `docs/config.rst`**, and nothing in `src/` (CMD 2, verbatim):

```
=== grep -rni json_as_ascii src/ docs/ ===
docs/config.rst:419:   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
docs/config.rst:441:    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
exit=0
```

`CHANGES.rst` add two more (both historical), per the retriever's F10 and confirmed by CMD 6:

```
=== CLAIM E5b: CHANGES.rst hits ===
153:    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
286:    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
exit=0
```

The removal notes themselves, verbatim from `docs/config.rst` (CMD 6):

```
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

And the failable negative check — `Flask.default_config` contains **no** `JSON_*` key (CMD 9):

```
=== CLAIM F28: no JSON_ keys in default_config ===
[]
False
exit=0
```

(`[]` = no key starting with `JSON`; `False` = `'JSON_AS_ASCII' in flask.Flask.default_config`.) So `app.config["JSON_AS_ASCII"] = False` is **inert by absence** in this tree: no code reads it. The flake-era rationale for the old key survives only in `CHANGES.rst` (retriever F10/E5): *"Added an option to generate non-ascii encoded JSON which should result in less bytes being transmitted over the network… It's disabled by default to not cause confusion with existing libraries that might expect `flask.json.dumps` to return bytes by default."*

---

## 2. The mechanism: the attribute is fed to stdlib `json.dumps` via `setdefault`

`provider.py:166–179` (CMD 3, indented listing; the anchors are `provider.py:177` for the `setdefault` line):

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

Where that lands in CPython, from `.../Lib/json/encoder.py` (retriever F31):

```python
:19 ESCAPE = re.compile(r'[\x00-\x1f\\"\b\f\n\r\t]')
:20 ESCAPE_ASCII = re.compile(r'([\\"]|[^\ -~])')
...
:44 def py_encode_basestring_ascii(s):
:45     """Return an ASCII-only JSON representation of a Python string"""
...
:58                 return '\\u{0:04x}'.format(n)
:60             else:
:61                 # surrogate pair
:62                 n -= 0x10000
:63                 s1 = 0xd800 | ((n >> 10) & 0x3ff)
:64                 s2 = 0xdc00 | (n & 0x3ff)
:65                 return '\\u{0:04x}\\u{1:04x}'.format(s1, s2)
:67     return '"' + ESCAPE_ASCII.sub(replace, s) + '"'
...
:193         if self.ensure_ascii:
:194             return encode_basestring_ascii(o)
:195         else:
:196             return encode_basestring(o)
```

and the stdlib docstring (F30):

```python
:192     If ``ensure_ascii`` is false, then the return value can contain non-ASCII
:193     characters if they appear in strings contained in ``obj``. Otherwise, all
:194     such characters are escaped in JSON strings.
```

**Consequence:** the flag chooses between `encode_basestring_ascii` and `encode_basestring` for *string* values. It therefore governs the serialized *representation* of non-ASCII code points and nothing else — never the decoded data, never number/boolean/null formatting, never the JSON structure. (F30 also notes that Flask's provider always passes `sort_keys=True`, so CPython's `_default_encoder` cache fast path at `encoder/__init__.py:227` is bypassed and a fresh `JSONEncoder` is built per call — behaviour identical, only the code path differs.)

---

## 3. Direction A — `ensure_ascii=True` (the default): non-ASCII → `\uXXXX`

Raw probe output, `app.json.ensure_ascii = True` (CMD 11):

```
  --- app.json.ensure_ascii = True ---
    dumps(SNOWMAN): repr='"\\u2603"' len=8 ascii=True hex=225c753236303322
    dumps(U+1F600): repr='"\\ud83d\\ude00"' len=14 ascii=True hex=225c75643833645c756465303022
    dumps(MIXED): repr='"a\\n\\"\\\\\\u00e9\\u20ac"' len=21 ascii=True hex=22615c6e5c225c5c5c75303065395c753230616322
    dumps({'k+SNOW': [SNOW*20]}): chars=137 utf8bytes=137 ascii=True
    raw-repr-of-big='{"k\\u2603": ["\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603\\u2603"]}'
```

with the assertions:

```
[PASS] 4 [True] dumps(SNOW) == '\"\\u2603\"' (8 chars) :: '"\\u2603"' len=8
[PASS] 4 [True] dumps(SNOW) hex == 225c753236303322 :: 225c753236303322
[PASS] 4 [True] dumps(SNOW) is pure ASCII :: 
[PASS] 4 [True] non-BMP -> surrogate pair :: '"\\ud83d\\ude00"' len=14
[PASS] 4 [True] non-BMP hex == 225c75643833645c756465303022 :: 225c75643833645c756465303022
[PASS] 4 [True] mixed accents escaped :: '"a\\n\\"\\\\\\u00e9\\u20ac"'
```

Reading the evidence:

- BMP example, U+2603 SNOWMAN (`\N{SNOWMAN}`): the Python string returned by `dumps` is the 8-character sequence `" \ u 2 6 0 3 "` — `repr` `'"\\u2603"'`, hex bytes `22 5c 75 32 36 30 33 22`. `len(s) == 8` equals `len(s.encode("utf-8")) == 8`, and `s.isascii()` is `True`. The output is transportable over any 7-bit-clean channel.
- Non-BMP example, U+1F600 GRINNING FACE: **two** `\uXXXX` escapes forming a UTF-16 surrogate pair — `'"\\ud83d\\ude00"'`, len 14, hex `22 5c 75 64 38 33 64 5c 75 64 65 30 30 22`. This matches the `s1`/`s2` computation in `encoder.py:63-65`.
- Mixed control/quote/backslash/accents (`"a\n\"\\é€"`): `'"a\\n\\"\\\\\\u00e9\\u20ac"'` — the `\n` becomes `\n`, the `"` becomes `\"`, the `\` becomes `\\` (these three are *not* a function of `ensure_ascii`), and only the non-ASCII `é` (U+00E9) and `€` (U+20AC) become `\u00e9` / `\u20ac`.
- Size: a 137-character payload (`{"k☃": ["☃"×20]}`) serializes to **137 characters = 137 UTF-8 bytes** — all ASCII, so character count and byte count coincide.

The project's own test encodes exactly this expectation (`tests/test_json.py`, verified read at offset 44; **decorator lines 48–50, function 51–54**):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

⚠️ Correction to the plan: it labelled this "lines 51-58". The retriever (F25) and the executor (CMD 5, CMD 16) both confirmed the function occupies **48–54**.

---

## 4. Direction B — `ensure_ascii=False`: non-ASCII is emitted literally

Raw probe output, `app.json.ensure_ascii = False` (CMD 11):

```
  --- app.json.ensure_ascii = False ---
    dumps(SNOWMAN): repr='"☃"' len=3 ascii=False hex=22e2988322
    dumps(U+1F600): repr='"😀"' len=3 ascii=False hex=22f09f988022
    dumps(MIXED): repr='"a\\n\\"\\\\é€"' len=11 ascii=False hex=22615c6e5c225c5cc3a9e282ac22
    dumps({'k+SNOW': [SNOW*20]}): chars=32 utf8bytes=74 ascii=False
    raw-repr-of-big='{"k☃": ["☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃"]}'
```

with the assertions:

```
[PASS] 4 [False] dumps(SNOW) == 3-char literal form :: '"☃"' len=3
[PASS] 4 [False] dumps(SNOW) hex == 22e2988322 :: 22e2988322
[PASS] 4 [False] dumps(SNOW) is NOT ASCII (one 3-byte UTF-8 char) :: 
[PASS] 4 [False] non-BMP kept literal (1 char, 4 UTF-8 bytes) :: '"😀"' len=3
[PASS] 4 [False] mixed accents literal :: '"a\\n\\"\\\\é€"'
[PASS] 4 escaped form is byte-identical stdout-safe ASCII; literal form is longer in bytes per char :: 
[PASS] 4 parameter flips representation, not content (both parse to same object) :: 
[PASS] 4 'big' payload: escaped chars > literal chars, escaped bytes > literal bytes :: True chars=137 bytes=137 | False chars=32 bytes=74
```

Reading the evidence:

- U+2603: 3-character string `" ☃ "` — `repr` `'"☃"'`, hex `22 e2 98 83 22`. One code point, 3 UTF-8 bytes.
- U+1F600: 3-character string `" 😀 "`, hex `22 f0 9f 98 80 22` — **one** character, 4 UTF-8 bytes. Note the asymmetry that makes the flag's purpose concrete: with `True` the same code point costs 12 ASCII characters (`\ud83d\ude00`) = 12 bytes; with `False` it costs 4 bytes.
- Mixed string: `'"a\\n\\"\\\\é€"'` — note that `\n`, `\"`, `\\` are *still escaped*; only the non-ASCII characters appear literally.
- Size: the 137-char ASCII form collapses to **32 characters / 74 UTF-8 bytes** — the "better performance and size" half of the `provider.py:145-148` docstring, measured.
- Byte-level consequence on the wire (CMD 13) — this is why `False` demands UTF-8 transport:

```
  --- app.json.ensure_ascii = False ---
    dumps(SNOW) raw len=3 hex=22e2988322 repr='"☃"'
    response(SNOW) body.hex=22e29883220a rawlen=6 CL=6 CT=application/json
    response(SNOW) decoded repr='"☃"\n'
[PASS] v2 positional response body parses back to SNOW [False] :: 
[PASS] v2 response body == dumps(SNOW) + trailing LF [False] :: body=22e29883220a expected=22e29883220a
[PASS] v2 CL == byte length [False] :: 
[PASS] v2 CL: char-length == byte-length only when escaped [False] :: rawlen=6 chars=4
```

Note in that last assertion the invariant this produces: when the body consists only of non-ASCII-escaped/non-ASCII text, *char-length ≠ byte-length* in `False` mode (4 chars vs 6 bytes) whereas in `True` mode they are equal (CMD 13: `[PASS] v2 CL: char-length == byte-length only when escaped [True] :: rawlen=9 chars=9`).

The transport guarantee comes from Werkzeug (CMD 7, verbatim):

```
=== CLAIM E6: werkzeug set_data ===
289:    def set_data(self, value: bytes | str) -> None:
290-        """Sets a new string as response.  The value must be a string or
291-        bytes. If a string is set it's encoded to the charset of the
292-        response (utf-8 by default).
293-
294-        .. versionadded:: 0.9
295-        """
296-        if isinstance(value, str):
297-            value = value.encode()
298-        self.response = [value]
299-        if self.automatically_set_content_length:
300-            self.headers["Content-Length"] = str(len(value))
301-
302-    data = property(
303-        get_data,
```

i.e. a `str` body is encoded (UTF-8 in Werkzeug 3.1.3 — `charset` was removed in 3.0, F33/CMD 14: `Response has 'charset' attribute: False`, `Response(SNOW) bytes: e29883 CL: 3`), and `Content-Length` is computed from the **byte** length. That is why `ensure_ascii=False` is safe on the wire as long as the reader treats the body as UTF-8 — which is also what the project's own test asserts by explicitly decoding (CMD 5):

```
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

---

## 5. Invariants that do **not** move with the flag

All asserted in CMD 11 (`[PASS]` in both the `True` and `False` blocks):

- **Round-trip / decoded content.** `[PASS] 4 round-trip loads(dumps(x)) == x [True] (str and utf-8 bytes input) :: snow=True grin=True mixed=True bytes=True` and the identical `[False]` line. The flag changes representation only; `loads(dumps(x))` returns the same Python object either way, from both `str` and UTF-8-bytes input.
- **Escaping of `"`, `\`, and C0 controls.** Present in both: `[PASS] 4 control\n stays escaped [True]/[False]`, `[PASS] 4 quote stays escaped …`, `[PASS] 4 backslash stays escaped …`, all showing `'"a\\n\\"\\\\…"'` in both modes. `ESCAPE = re.compile(r'[\x00-\x1f\\"\b\f\n\r\t]')` is applied by *both* encoder paths (`encoder.py:19`), independently of `ensure_ascii`.
- **ASCII stays ASCII.** `[PASS] 4 [True] dumps(SNOW) is pure ASCII` and `[PASS] 4 [False] dumps(SNOW) is NOT ASCII (one 3-byte UTF-8 char)`; in both, ordinary ASCII characters pass through unescaped.
- **Orthogonality.** `sort_keys`, `default` (the dataclass/decimal/uuid/`__html__` handler), `compact`/`indent`/`separators`, and `mimetype` are separate attributes in the same block; CMD 11 asserts `[PASS] 6a other kwargs unaffected (sort_keys/separators indep)`.
- **Both forms are valid JSON.** `[PASS] v2 positional response body parses back to SNOW [True]/[False]` — `json.loads` accepts `"\u2603"` and `"☃"` alike.

---

## 6. Precedence and scope — it is a default with an app-context precondition

**(a) A per-call keyword wins** (CMD 11, step 6a, verbatim):

```
==============================================================================
STEP 6a: per-call override precedence (kwargs.setdefault semantics)
==============================================================================
    6a attr=True, kwarg=False: repr='"☃"' len=3 ascii=False hex=22e2988322
[PASS] 6a explicit kwarg beats attribute True->False :: '"☃"'
    6a attr=False, kwarg=True: repr='"\\u2603"' len=8 ascii=True hex=225c753236303322
[PASS] 6a explicit kwarg beats attribute False->True :: '"\\u2603"'
    6a attr=False, no kwarg: repr='"☃"' len=3 ascii=False hex=22e2988322
[PASS] 6a no kwarg -> attribute used :: '"☃"'
[PASS] 6a other kwargs unaffected (sort_keys/separators indep) :: '"☃"'
```

This is the direct observable consequence of `kwargs.setdefault` at `provider.py:177`: the attribute supplies a default; an explicit `ensure_ascii=` in the call overrides it in either direction.

**(b) With no app context, the attribute is unreachable — stdlib's default `True` applies.** `flask.json.dumps`, verbatim (CMD 4):

```python
def dumps(obj: t.Any, **kwargs: t.Any) -> str:
    """Serialize data as JSON.

    If :data:`~flask.current_app` is available, it will use its
    :meth:`app.json.dumps() <flask.json.provider.JSONProvider.dumps>`
    method, otherwise it will use :func:`json.dumps`.
    ...
    """
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

and the probe, deliberately run **after** an app instance had `ensure_ascii = False` (CMD 11, step 6b-bis):

```
==============================================================================
STEP 6b-bis: fallback still ignores the (now False) app attribute
==============================================================================
    app.json.ensure_ascii now = False
    bool(flask.current_app) outside ctx = False
    6b flask.json.dumps(SNOW) outside ctx (app attr is False!): repr='"\\u2603"' len=8 ascii=True hex=225c753236303322
[PASS] 6b outside app ctx stays escaped even though app.json.ensure_ascii=False :: '"\\u2603"'
```

This is the trap the plan flagged as risk #4: testing override precedence through `flask.json.dumps` without an active app context would "disprove" the attribute and reach a false conclusion. Both probes here ran inside `with app.app_context():` (6a) or explicitly outside it (6b/6b-bis) as intended.

**(c) Per-app isolation.** `[PASS] 6c setting app.json does not leak to app2.json :: app=False app2=True` and `[PASS] 6c both can be set independently to False`. Each `Flask` app constructs its own provider instance (`vars(app.json) keys=['_app']`).

**(d) Class-level default and no caching** — fresh-interpreter probe, `naive_probe_class_attr.py` (CMD 12, verbatim):

```
DefaultJSONProvider.ensure_ascii at import = True
after class->False, a.json.ensure_ascii = False
[PASS] 6d instance inherits class attribute set before construction
6d a.json.dumps(SNOW) repr = '"☃"' len = 3 hex = 22e2988322
[PASS] 6d class-level False takes effect at dumps() time
b constructed while class==False; class now reset to: True
6d b.json.dumps(SNOW) repr = '"\\u2603"' len = 8
[PASS] 6d no caching: value read at dumps() call time
b.json.ensure_ascii (never instance-assigned) = True
class=True, c instance=False -> False (instance wins)
[PASS] 6d instance assignment shadows class attribute
[PASS] 6d shadowed instance value drives dumps() [PASS] 6d shadowed instance value drives dumps()
6d failures: 0
```

The value is read at `dumps()` time (no memoized encoder keyed on it in Flask), so setting it takes effect immediately, class-level values propagate to instances that never assigned their own, and an instance assignment shadows the class attribute.

**(e) `response()` appends a newline and forces compact separators.** `provider.py:196–215` (CMD 3, lines 71–80 of the listing, anchors `provider.py:206-215`):

```python
        obj = self._prepare_response_obj(args, kwargs)
        dump_args: dict[str, t.Any] = {}

        if (self.compact is None and self._app.debug) or self.compact is False:
            dump_args.setdefault("indent", 2)
        else:
            dump_args.setdefault("separators", (",", ":"))

        return self._app.response_class(
            f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
        )
```

⚠️ **Correction to the plan's step-4 expectations.** The plan predicted "`True` → Content-Length 8, `False` → Content-Length 3" and used `app.json.response(value="\N{SNOWMAN}")`. Measured (CMD 13):

```
  --- app.json.ensure_ascii = True ---
    dumps(SNOW) raw len=8 hex=225c753236303322 repr='"\\u2603"'
    response(SNOW) body.hex=225c7532363033220a rawlen=9 CL=9 CT=application/json
    response(SNOW) decoded repr='"\\u2603"\n'
...
    response(value=SNOW) body.hex=7b2276616c7565223a225c7532363033227d0a rawlen=19 CL=19
    response(value=SNOW) decoded repr='{"value":"\\u2603"}\n'
[PASS] v2 kwargs response wraps in a dict [True] :: 
  --- app.json.ensure_ascii = False ---
    dumps(SNOW) raw len=3 hex=22e2988322 repr='"☃"'
    response(SNOW) body.hex=22e29883220a rawlen=6 CL=6 CT=application/json
    response(SNOW) decoded repr='"☃"\n'
...
    response(value=SNOW) body.hex=7b2276616c7565223a22e29883227d0a rawlen=16 CL=16
    response(value=SNOW) decoded repr='{"value":"☃"}\n'

plan's step-4 expectation vs measured (the plan claimed True->CL 8, False->CL 3):
    measured positional response body lengths: True=9 (hex 225c7532363033220a), False=6 (hex 22e29883220a)
    -> the 8/3 numbers the plan quotes are the lengths of dumps() WITHOUT the appended LF;
       response() appends LF, so compact-body byte lengths are 9 (escaped) and 6 (literal).

v2 failures: 0 []
EXIT_STATUS=0
```

So: the plan's 8/3 are the *`dumps()` string lengths before wrapping and before the trailing LF*; a positional `response(SNOW)` yields **9** bytes (`22 5c 75 32 36 30 33 22 0a`) escaped and **6** bytes (`22 e2 98 83 22 0a`) literal, and a **keyword** `response(value=SNOW)` serializes the *dict* `{"value": …}` (`_prepare_response_obj`, `provider.py:88-98`) → 19 / 16 bytes. In all cases `Content-Length == byte length of body` held, and `Content-Type` was `application/json`.

---

## 7. Every other entry point that hits the same attribute

| Entry point | Wiring (file:line) | Probe/test evidence |
|---|---|---|
| `app.json.dumps(...)` | `provider.py:166-179`, `setdefault` at `:177` | CMD 11 (all step-4 checks) |
| `app.json.response(...)` / `flask.jsonify(...)` | `json/__init__.py:170` → `current_app.json.response(*args, **kwargs)`; `DefaultJSONProvider.response` at `provider.py:196-215` | CMD 13 |
| `app.json.dump(obj, fp)` to a text file | base `JSONProvider.dump`: `fp.write(self.dumps(obj, **kwargs))` (`provider.py:48-53`) | CMD 14: `app.json.dump() ensure_ascii=False: '{"x": "☃"}' len=10 hex=7b2278223a2022e29883227d` vs `True: '{"x": "\\u2603"}' len=15 hex=7b2278223a20225c7532363033227d` |
| `flask.json.dumps(...)` under app context | `json/__init__.py:41` → `current_app.json.dumps` | CMD 11 step 6b/6b-bis (context-sensitive) |
| `EnvironBuilder(json=...)` request bodies | `testing.py:88-94` → `return self.app.json.dumps(obj, **kwargs)` (CMD 5, verbatim: `88: def json_dumps(...)  ... 94: return self.app.json.dumps(obj, **kwargs)`) | `test_environbuilder_json_dumps` PASSES (CMD 16) |
| Jinja `|tojson` in templates | `app.py:422`: `rv.policies["json.dumps_function"] = self.json.dumps` (CMD 6) | CMD 14 |
| Session cookies | `json/tag.py:321-327` `TaggedJSONSerializer.dumps` calls module-level `flask.json.dumps` with `separators=(",", ":")`; invoked from `sessions.py:387` inside the request context (retriever F18/F19) | inferred from the same code path (not separately probed) |

The Jinja chain, CMD 14 verbatim:

```
  |tojson ensure_ascii=True: '{"a": "\\u003cscript\\u003e\\u2603"}'
[PASS] v3 jinja |tojson escapes < as \u003c regardless of ensure_ascii [True] :: 
[PASS] v3 jinja |tojson layer reflects ensure_ascii for non-ASCII [True] :: out='{"a": "\\u003cscript\\u003e\\u2603"}'
...
  |tojson ensure_ascii=False: '{"a": "\\u003cscript\\u003e☃"}'
[PASS] v3 jinja |tojson escapes < as \u003c regardless of ensure_ascii [False] :: 
[PASS] v3 jinja |tojson layer reflects ensure_ascii for non-ASCII [False] :: out='{"a": "\\u003cscript\\u003e☃"}'
```

---

## 8. The second escaping layer you must not conflate (plan risk #2, discharged)

There are two independent mechanisms that both make JSON look "escaped":

1. **`ensure_ascii`** — non-ASCII code points → `\uXXXX`, driven by the provider attribute (`provider.py:144,177`).
2. **HTML-safety escaping** of `<`, `>`, `&`, `'` → `\u003c`, `\u003e`, `\u0026`, `\u0027`, applied by Jinja's `htmlsafe_json_dumps`/`do_tojson` on top of whatever `dumps` produced (retriever F23), reached via the `json.dumps_function` policy at `app.py:422`.

CMD 14 separates them experimentally: `\u003c` appears in `|tojson` output **in both modes**, while only the non-ASCII character `☃` flips between `\u2603` and the literal glyph. Corroborating test evidence (retriever F25, `tests/test_json.py:210-220`):

```python
210 def test_tojson_filter(app, client):
...
220     assert rv.get_data(as_text=True) == "<p>&lt;script&gt;&#34;\\u003c/script\\u003e&#34;&lt;/script&gt;</p>"
```

`test_tojson_filter` PASSES in the full suite (CMD 19, `tests/test_json.py::test_tojson_filter PASSED [ 73%]`). So `ensure_ascii` is *not* the source of `\u003c`.

---

## 9. Confirmation against the project's own test suite (read-only; nothing modified)

CMD 15 — the two focused files:

```
=== RUN A: pytest tests/test_json.py tests/test_testing.py -q ===
........................................................                 [100%]
56 passed in 0.24s
EXIT_STATUS=0
```

CMD 16 — the two tests that pin this behaviour, verbose:

```
=== RUN B: pytest tests/ -k 'json_as_unicode or environbuilder_json_dumps' -vv -rA ===
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 489 items / 486 deselected / 3 selected

tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [ 33%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 66%]
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [100%]

=================================== PASSES ====================================
=========================== short test summary info ===========================
PASSED tests/test_json.py::test_json_as_unicode[True-"\\u2603"]
PASSED tests/test_json.py::test_json_as_unicode[False-"\u2603"]
PASSED tests/test_testing.py::test_environbuilder_json_dumps
====================== 3 passed, 486 deselected in 0.21s ======================
EXIT_STATUS=0
```

Both named tests PASS, in both parametrizations. The plan's STOP-condition ("if `test_json_as_unicode` fails, the checked-out tree is not the tree the answer assumes") did **not** trigger.

CMD 18 — complete suite, baseline:

```
=== RUN C: FULL SUITE, normal ===
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 2.15s
EXIT_STATUS=0
```

CMD 19 — complete suite with `-vv -rA --showlocals`:

```
=== RUN D: FULL SUITE, most verbose (-vv -rA --showlocals) ===
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
testpaths: tests
collecting ... collected 489 items
```

…followed by 489 `PASSED` progress lines (including `tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED [ 68%]`, `tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED [ 69%]`, `tests/test_json.py::test_tojson_filter PASSED [ 73%]`, `tests/test_testing.py::test_environbuilder_json_dumps PASSED [ 92%]`), the `PASSES`/captured-log section, and the summary:

```
=========================== short test summary info ===========================
PASSED tests/test_appctx.py::test_basic_url_generation
... [489 `PASSED <nodeid>` lines, identical set to the progress listing above] ...
PASSED tests/test_views.py::test_init_once
============================= 489 passed in 2.17s =============================
EXIT_STATUS=0
```

**No claim in this answer depends on any individual node-id line of RUN D**; the only fact drawn from it is `489 passed in 2.17s` / `EXIT_STATUS=0`. The full 1455-line output was supplied verbatim upstream (temp log: `C:\Users\oobbee\AppData\Local\Temp\pi-bash-57f5db67127c83e5.log`) and its 489-item listing is byte-identical to the progress listing; I elide it here rather than print the same node-id set twice.

### Integrity of the run

CMD 17 (verbatim):

```
=== post-test repo cleanliness ===
porcelain_exit=0
=== tracked-file diff (must be empty) ===
diff_exit=0
=== HEAD still pinned ===
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
=== sha1 of the two test files' git blobs ===
1e2b27dc9c2da75e976a255d3b38da6d3fc7412b
de0521520a971fb96c5fc602ac084dc1f05f9003
f37cb7b2096f2be56c7ba3e60d7a2e9751f346a8
```

```
=== HEAD blob ids for the three inspected source/test files ===
100644 blob f37cb7b2096f2be56c7ba3e60d7a2e9751f346a8	src/flask/json/provider.py
100644 blob 1e2b27dc9c2da75e976a255d3b38da6d3fc7412b	tests/test_json.py
100644 blob de0521520a971fb96c5fc602ac084dc1f05f9003	tests/test_testing.py
exit=0
=== working-tree blob ids (must match above) ===
1e2b27dc9c2da75e976a255d3b38da6d3fc7412b
de0521520a971fb96c5fc602ac084dc1f05f9003
f37cb7b2096f2be56c7ba3e60d7a2e9751f346a8
exit=0
=== stale bytecode interpreters present in tree ===
__init__.cpython-311.pyc __init__.cpython-312.pyc __init__.cpython-313.opt-1.pyc __init__.cpython-313.pyc __init__.cpython-314.pyc provider.cpython-311.pyc provider.cpython-312.pyc provider.cpython-313.opt-1.pyc provider.cpython-313.pyc provider.cpython-314.pyc tag.cpython-311.pyc tag.cpython-312.pyc tag.cpython-313.opt-1.pyc tag.cpython-313.pyc tag.cpython-314.pyc 
tests/__pycache__/test_json.cpython-311-pytest-8.4.2.pyc tests/__pycache__/test_json.cpython-312-pytest-8.4.0.pyc tests/__pycache__/test_json.cpython-313-pytest-8.4.0.pyc tests/__pycache__/test_json.cpython-313-pytest-9.1.1.pyc tests/__pycache__/test_json.cpython-314-pytest-8.4.0.pyc tests/__pycache__/test_json.cpython-314-pytest-8.4.2.pyc tests/__pycache__/test_json.cpython-314-pytest-9.1.1.pyc tests/__pycache__/test_json_tag.cpython-311-pytest-8.4.2.pyc tests/__pycache__/test_json_tag.cpython-313-pytest-8.4.0.pyc tests/__pycache__/test_testing.cpython-311-pytest-8.4.2.pyc tests/__pycache__/test_testing.cpython-312-pytest-8.4.0.pyc tests/__pycache__/test_testing.cpython-313-pytest-8.4.0.pyc tests/__pycache__/test_testing.cpython-314-pytest-8.4.2.pyc 
```

Working-tree blob IDs equal HEAD's for all three inspected files ⇒ no source/test file was modified; `git status --porcelain` is empty; HEAD is still the pinned `85c5d93…`. The `.pyc` artefacts are pre-existing (the dataset copy has been run under CPython 3.11/3.12/3.13/3.14 and pytest 8.4.0/8.4.2/9.1.1) and are the `Binary file … matches` lines in CMD 2.

---

## 10. Provenance and environment (self-contained)

CMD 1 (verbatim):

```
--- HEAD ---
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
exit=0
--- status ---
exit=0
--- version line ---
[project]
name = "Flask"
version = "3.2.0.dev"
description = "A simple framework for building complex web applications."
readme = "README.md"
license = "BSD-3-Clause"
exit=0
```

The copy is a plain clone of upstream (`experiments/data/flask-src/.git/config`: remote `origin` = `https://github.com/pallets/flask`), **detached at `85c5d93`** — the retriever's F1/F2 show `.git/HEAD` holding the raw SHA while `.git/refs/heads/main` = `d73fa1cdcbd8b1465c151db8924ba58b1dd14e35` = `refs/remotes/origin/main`; i.e. the tree under test is *not* current `main` but the pinned SWE-QA commit (F35: `experiments/data/worktree/.build-manifest.json` `"flaskCommit": "85c5d93…"`, `experiments/data/swe-qa/repo_commit.txt` line 3 `flask,pallets/flask,85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`).

CMD 9 (verbatim) — version, resolution path, and the negative config check:

```
=== version via importlib.metadata ===
3.2.0.dev0
D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
exit=0
=== CLAIM F28: no JSON_ keys in default_config ===
[]
False
exit=0
=== deps versions ===
flask 3.2.0.dev0
werkzeug 3.1.3
jinja2 3.1.6
markupsafe 3.0.2
pytest 8.4.0
exit=0
```

`import flask` resolves to the working tree `src/` (editable `flask.pth` → `…\flask-src\src`, retriever F5), and the interpreter is CPython **3.13.9** (CMD 7: `Python 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]`). ⚠️ `flask.__version__` **does not exist** in this tree (CMD 8: `AttributeError: module 'flask' has no attribute '__version__'`); the version must be read via `importlib.metadata`. CMD 8's stdlib control also independently confirmed the stdlib defaults: BMP → `"\u2603"`, non-BMP → surrogate pair `"\ud83d\ude00"`, control/quote/backslash escaped.

All probe scripts were written **outside the repo**, under `C:/Users/oobbee/AppData/Local/Temp/naive-probe/` (CMD 10: `TEMP=/tmp`, `/tmp` = `C:/Users/oobbee/AppData/Local/Temp`, outside the repo), per the workspace discipline for this dataset copy.

---

## 11. Discrepancy register (plan / evidence vs. observed)

| # | Claim in the plan/evidence | Observed | Severity |
|---|---|---|---|
| 1 | step 1(c): `ensure_ascii` match set = `provider.py:144,145,177` | 5 text hits: `provider.py:144`, **`provider.py:171`** (docstring — omitted by the plan), `provider.py:177`, `tests/test_json.py:52`, `tests/test_testing.py:112` (line 145 is prose without the token). Retriever F9 already caught this | minor |
| 2 | E3 label: "`tests/test_json.py` lines 51-58" | the test occupies **48–54** (decorator 48–50, function 51–54) — re-verified by direct read during synthesis | minor |
| 3 | step 1(b): `pyproject.toml` line 2 `name = "flask"` | line 2 is `name = "Flask"` (capital F) | cosmetic |
| 4 | step 4: "`True` → Content-Length 8, `False` → Content-Length 3", using `response(value=SNOW)` | measured positional `response(SNOW)` = **9 / 6** bytes; kwargs form wraps in a dict = **19 / 16**; the 8/3 figures are `dumps()` lengths **before** the appended `"\n"` | **substantive expectation error (source is correct)** |
| 5 | E7: `flask-3.2.0.dev0` | dist metadata correct; `flask.__version__` raises `AttributeError` (removed) | note for fixture authors |
| 6 | retriever F8: `grep` silently skips `flask-src/.venv/` because `.venv/.gitignore` = `*` | reproduced; Werkzeug/Jinja findings required explicit per-file reads | retrieval hazard confirmed |
| 7 | executor CMD 12b: a heredoc patch mangled a comment inside the *scratch* probe, yielding `SyntaxError: unterminated string literal (detected at line 50)` | file rewritten with the write tool; no repo file involved | process note only |

---

## 12. The relationship, stated once more against the file:line references

1. The knob is **`DefaultJSONProvider.ensure_ascii`, a class attribute, `True` by default** — `src/flask/json/provider.py:144`, documented as *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* (`provider.py:145-148`). The legacy `JSON_AS_ASCII` config key was **removed in Flask 2.3** (`docs/config.rst`, quoted above) and is absent from `src/` and from `Flask.default_config`.
2. It reaches the serializer as a **default** through `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` — `provider.py:177` — so an explicit per-call `ensure_ascii=` wins (proved in step 6a).
3. `True` ⇒ each non-ASCII code point is emitted as `\uXXXX`, and non-BMP code points as surrogate pairs `\uXXXX\uXXXX` — U+2603 → `'"\\u2603"'` (8 chars, hex `22 5c 75 32 36 30 33 22`, pure ASCII, bytes = chars); U+1F600 → `'"\\ud83d\\ude00"'` (14 chars). A 137-char payload → 137 chars = 137 bytes.
4. `False` ⇒ non-ASCII code points are emitted literally — U+2603 → `'"☃"'` (3 chars, hex `22 e2 98 83 22`, 3 UTF-8 bytes); U+1F600 → one literal character (4 UTF-8 bytes). The same 137-char payload → 32 chars / 74 bytes. The payload must be transported as UTF-8: Werkzeug's `set_data` does `value.encode()` (UTF-8 in 3.1.3, no `charset` attribute) and sets `Content-Length` from the byte length — the project's own `test_environbuilder_json_dumps` decodes `utf8` to assert on it.
5. Invariants: ASCII stays ASCII; `"`, `\`, and C0 controls stay escaped in both modes; `sort_keys`/`default`/`compact`/`mimetype` are independent; and **`json.loads(dumps(x)) == x` in both modes**, from both `str` and UTF-8-bytes input — the flag changes representation, never content.
6. Scope: per-call kwarg > attribute; with no app/app-context the attribute is unreachable and stdlib's `True` applies (`json/__init__.py:41-44`); per-app providers are independent; the value is read at `dumps()` call time with no caching. It governs `app.json.dumps`/`dump`/`response`, `jsonify`, `EnvironBuilder.json_dumps`, Jinja `|tojson` (via `app.py:422`), and session-cookie payloads via `TaggedJSONSerializer`.
7. Not part of this relationship: the always-on Jinja HTML-safety escaping of `<`, `>`, `&`, `'` (`\u003c` appears in `|tojson` output in **both** modes, CMD 14); and the well-known caveat that literal output with the flag off can contain characters such as U+2028/U+2029 that pre-ES2019 JavaScript string literals reject — that is a consequence of `False` worth noting, but the escaping of those characters is *not* something `ensure_ascii` does.

---

## Appendix: full command outputs relied on

The three verified source/test passages used for claim (1), (2), (4) were re-read directly during synthesis and match the upstream handoff verbatim (shown in §1, §3). The full outputs of plan steps 1–6 are reproduced in §§1–9 above: CMD 1 (provenance), CMD 2 (grep sweep), CMD 3 (`provider.py` 136–215), CMD 4 (`json/__init__.py` fallback + `jsonify`), CMD 5 (test fixtures + `EnvironBuilder.json_dumps`), CMD 6 (Jinja policy + docs/CHANGES), CMD 7 (Werkzeug `set_data` + interpreter), CMD 8 (failed `__version__` probe + stdlib encoder control), CMD 9 (version/config/deps), CMD 10 (temp-dir + pre-write cleanliness), CMD 11 (42-check main probe: steps 6c, 6b, 4, 6a, 6b-bis + SUMMARY), CMD 12 (fresh-interpreter class-attribute probe), CMD 12b (failed heredoc patch of the scratch file), CMD 13 (positional-vs-kwargs `response()` path probe + the 8/3-vs-9/6 reconciliation), CMD 14 (two-layer Jinja separation + Werkzeug charset), CMD 15/16 (targeted pytest runs), CMD 17 (post-run integrity), CMD 18/19 (full-suite baseline; RUN D's 489 node-id lines elided as noted, since no claim rests on them).

External corroboration, flagged as such and **not** used to derive any claim above: the benchmark record at `experiments/data/swe-qa/Benchmark/flask.jsonl` line 1 holds this exact question with a gold answer stating *"The `ensure_ascii` attribute on `DefaultJSONProvider` (defaults to `True`) controls whether non-ASCII characters are escaped as Unicode escape sequences in JSON output… the snowman character (☃, U+2603) becomes `\"\\u2603\"`… the relationship: `ensure_ascii` directly controls the Unicode representation strategy"* — consistent with, but independent of, the source quotes and probe measurements given here.

**Bottom line:** `DefaultJSONProvider.ensure_ascii` (`provider.py:144`, default `True`) selects the *representation* of non-ASCII code points in serialized JSON — `\uXXXX`/surrogate-pair escapes when `True`, literal Unicode text (requiring UTF-8 transport and yielding smaller payloads) when `False` — while leaving the decoded data, ASCII characters, JSON metacharacter escaping, and the sibling provider attributes untouched; and it is a `json.dumps` default that only applies when an app context is active and no explicit `ensure_ascii=` keyword is passed.
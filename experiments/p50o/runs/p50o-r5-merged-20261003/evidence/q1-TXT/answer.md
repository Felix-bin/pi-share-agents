## Answer

**The relationship is a one-way, representation-only switch.** The "ASCII-only encoding control parameter" in this Flask checkout is `DefaultJSONProvider.ensure_ascii` — a boolean class attribute, default `True`, on `app.json`. It is not a header, not a parsing option, and not the legacy config key. It reaches serialization at exactly one point: a `setdefault` that forwards its value to the stdlib `json.dumps`, which then decides whether each non-ASCII code point in **string values and dict keys** is rewritten as a `\uXXXX` escape (pure-ASCII output) or emitted literally. When it is `False`, Flask's response layer encodes the resulting text with `str.encode()`, i.e. **UTF-8**, so the wire body carries multi-byte UTF-8 — while the `Content-Type: application/json` header stays byte-for-byte identical, with **no** `charset` parameter in either case. Decoding yields the identical Python object either way, so the flag changes the *wire representation*, never the *meaning*, of the data.

Checkout identity (verified by the executor): `.git/HEAD` = `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`; `importlib.metadata` → `flask 3.2.0.dev0` (resolving to the checkout's `src/flask/__init__.py`), `werkzeug 3.1.3`, with Python 3.13.9, Jinja 3.1.6, pytest 8.4.0 on win32. (Note: `flask.__version__` no longer exists in 3.2.0.dev0 — the executor hit `AttributeError: module 'flask' has no attribute '__version__'` on the first probe.)

---

## 1. The parameter: `ensure_ascii`, default `True`

`src/flask/json/provider.py:144-148`, inside `class DefaultJSONProvider(JSONProvider)` (I re-read this file directly; the quote is verbatim):

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

Its neighbours on the same class use the same shape — `sort_keys = True` (`:150`), `compact: bool | None = None` (`:156`), `mimetype = "application/json"` (`:163`) — i.e. `ensure_ascii` is one of the per-app provider attributes, not a module global or a config dict entry.

The provider instance is created per app (`src/flask/sansio/app.py:230-234`, `:329-336`): `json_provider_class: type[JSONProvider] = DefaultJSONProvider` and `self.json: JSONProvider = self.json_provider_class(self)`. So the setting is reachable as `app.json.ensure_ascii` and is per-application.

Executor introspection confirmed the literal value at runtime: `DefaultJSONProvider.ensure_ascii = True`.

## 2. The single point of use: `setdefault` → stdlib `json.dumps`

`src/flask/json/provider.py:166-179` (re-read verbatim):

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

Three consequences are visible in those three lines, and all three were confirmed empirically:

- It is only a **default**. A caller-supplied `ensure_ascii=` kwarg wins, because `setdefault` is a no-op when the key is already present.
- The value is passed **verbatim** to stdlib `json.dumps`; Flask contributes no escaping logic of its own.
- `ensure_ascii` appears nowhere else in serialization. The executor's exhaustive grep over `src/ tests/ docs/` returned exactly: `src/flask/json/provider.py:144` (attribute), `:171` (docstring), `:177` (the `setdefault`), `tests/test_json.py:52`, `tests/test_testing.py:112` — with the only other matches being `.pyc` caches. A grep for `charset` in `src/flask/` returns *"no charset in src/flask"*.

The parsing path never sees the flag — `provider.py:181-187`:

```python
    def loads(self, s: str | bytes, **kwargs: t.Any) -> t.Any:
        """Deserialize data as JSON from a string or bytes.

        :param s: Text or UTF-8 bytes.
        :param kwargs: Passed to :func:`json.loads`.
        """
        return json.loads(s, **kwargs)
```

Correspondingly, `provider.loads` has no `ensure_ascii` parameter (executor introspection: `loads has no ensure_ascii param: False`, i.e. the check for its presence was false). This is the **scope** answer: the parameter controls *serialization output only*; any reading of it as a parsing switch is wrong.

## 3. The response path: the flag travels as *text*, applied to keys and values alike

`DefaultJSONProvider.response` (`provider.py:189-215`, re-read verbatim):

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

Note that `response()` sets only `indent`/`separators` — it never sets `ensure_ascii`; the flag arrives purely via the `setdefault` in `dumps`. The body handed to the response class is a `str` with a trailing `"\n"`, and the mimetype is `self.mimetype` = `"application/json"` (`provider.py:163`). Dict/list view returns take the same path (`src/flask/app.py:1230-1231`: `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)`).

At the stdlib level the flag is applied through a single encoder used for **both keys and values** — CPython 3.13.9's `Lib/json/encoder.py:219-222`:

```python
        if self.ensure_ascii:
            _encoder = encode_basestring_ascii
        else:
            _encoder = encode_basestring
```

and `encoder.py:384` / `:387` in dict iteration:

```python
            yield _encoder(key)
            yield _key_separator
            if isinstance(value, str):
                yield _encoder(value)
```

The escaping function, including the surrogate-pair branch for code points ≥ U+10000 (`encoder.py:49-72`):

```python
def py_encode_basestring_ascii(s):
    """Return an ASCII-only JSON representation of a Python string

    """
    def replace(match):
        s = match.group(0)
        try:
            return ESCAPE_DCT[s]
        except KeyError:
            n = ord(s)
            if n < 0x10000:
                return '\\u{0:04x}'.format(n)
                #return '\\u%04x' % (n,)
            else:
                # surrogate pair
                n -= 0x10000
                s1 = 0xd800 | ((n >> 10) & 0x3ff)
                s2 = 0xdc00 | (n & 0x3ff)
                return '\\u{0:04x}\\u{1:04x}'.format(s1, s2)
```

and its docstring semantics (`encoder.py:105-116`): *"If ensure_ascii is true, the output is guaranteed to be str objects with all incoming non-ASCII characters escaped. If ensure_ascii is false, the output can contain non-ASCII characters."* The stdlib default is also `True` (`Lib/json/__init__.py:110-118`, `:183-194`: `ensure_ascii=True`), which matters for the no-app-context trap in §7.

The referenced pure-Python functions are shadowed at runtime by the C accelerator (`encoder.py:71-72`: `encode_basestring_ascii = (c_encode_basestring_ascii or py_encode_basestring_ascii)`), so the executor checked it explicitly: `encode_basestring_ascii is C accel: _json True`.

**Observed (executor, stdlib probe, step 3):**

```
=== snowman U+2603 ===
  ensure_ascii=True  -> repr()='"\\u2603"'
  ensure_ascii=False -> repr()='"☃"'
  ensure_ascii=True  -> utf8 bytes len=8
  ensure_ascii=False -> utf8 bytes len=5
=== astral U+1F600 ===
  ensure_ascii=True  -> repr()='"\\ud83d\\ude00"'
  ensure_ascii=False -> repr()='"😀"'
  ensure_ascii=True  -> utf8 bytes len=14
  ensure_ascii=False -> utf8 bytes len=6
=== CJK U+96EA ===
  ensure_ascii=True  -> repr()='"\\u96ea"'
  ensure_ascii=False -> repr()='"雪"'
=== dict with non-ASCII key ===
  ensure_ascii=True  -> repr()='{"\\u96ea": "\\u2603"}'
  ensure_ascii=False -> repr()='{"雪": "☃"}'
  ensure_ascii=True  -> utf8 bytes len=20
  ensure_ascii=False -> utf8 bytes len=14
```

So: `True` ⇒ `'"\\u2603"'` for U+2603 SNOWMAN, `'"\\ud83d\\ude00"'` (a **surrogate pair**) for U+1F600 😀, `'"\\u96ea"'` for U+96EA 雪 — pure ASCII; `False` ⇒ the literal characters. The astral case was confirmed on the **C accelerator**, not merely from the pure-Python reference (`C accel result U+1F600: '"\\ud83d\\ude00"'`). A non-ASCII **dict key** is escaped identically to a value: `'{"\\u96ea": "\\u2603"}'` vs `'{"雪": "☃"}'`. The byte-length columns are the "performance and size" half of the docstring's trade-off, already visible at text level (8 vs 5, 14 vs 6, 20 vs 14).

## 4. What `False` becomes on the wire: multi-byte UTF-8 body, unchanged header

`response()` builds a `str`; Werkzeug turns it into bytes with a bare `str.encode()`, i.e. UTF-8. `werkzeug/wrappers/response.py:31-36` (Werkzeug 3.1.3):

```python
def _iter_encoded(iterable: t.Iterable[str | bytes]) -> t.Iterator[bytes]:
    for item in iterable:
        if isinstance(item, str):
            yield item.encode()
        else:
            yield item
```

and `response.py:289-297`:

```python
    def set_data(self, value: bytes | str) -> None:
        """Sets a new string as response.  The value must be a string or
        bytes. If a string is set it's encoded to the charset of the
        response (utf-8 by default).
        ...
        """
        if isinstance(value, str):
            value = value.encode()
```

The header layer adds **no** charset for `application/json`. Werkzeug 3.0 removed the `charset` attribute entirely (`werkzeug/sansio/response.py:86-87`: *"The ``charset`` attribute was removed."*), and the content-type builder is `werkzeug/utils.py:185-192`:

```python
    if (
        mimetype.startswith("text/")
        or mimetype in _charset_mimetypes
        or mimetype.endswith("+xml")
    ):
        mimetype += f"; charset={charset}"
```

with `_charset_mimetypes = {"application/ecmascript", "application/javascript", "application/sql", "application/xml", "application/xml-dtd", "application/xml-external-parsed-entity"}`. `"application/json"` matches none of the three conditions, so Werkzeug emits the bare literal `Content-Type: application/json`. (Version-sensitive: this is Werkzeug **3.1.3** behaviour, the version pinned in this venv.)

**Observed (executor, HTTP-level probe, step 4):**

```
--- app.json.ensure_ascii = True ---
  get_data() repr = b'{"name":"\\u96ea"}\n'
  all bytes < 0x80: True
  Content-Type     = 'application/json'
  charset in header: False
  content_length   = 18 len(get_data())= 18
  client.get body repr: b'{"emoji":"\\ud83d\\ude00","name":"\\u96ea","sym":"\\u2603"}\n'
  client.get Content-Type: 'application/json' content_length= 56
  r.get_json() = {'emoji': '😀', 'name': '雪', 'sym': '☃'}
--- app.json.ensure_ascii = False ---
  get_data() repr = b'{"name":"\xe9\x9b\xaa"}\n'
  all bytes < 0x80: False
  Content-Type     = 'application/json'
  charset in header: False
  content_length   = 15 len(get_data())= 15
  client.get body repr: b'{"emoji":"\xf0\x9f\x98\x80","name":"\xe9\x9b\xaa","sym":"\xe2\x98\x83"}\n'
  client.get Content-Type: 'application/json' content_length= 42
  r.get_json() = {'emoji': '😀', 'name': '雪', 'sym': '☃'}
```

That is the whole relationship in one observation: `True` → body is pure ASCII (`all bytes < 0x80: True`); `False` → body contains UTF-8 (`\xe9\x9b\xaa` = 雪, `\xe2\x98\x83` = ☃, `\xf0\x9f\x98\x80` = 😀); the `Content-Type` header is the **same string** in both cases, with no charset; and the content lengths differ (18 vs 15 for one field, 56 vs 42 for three) — the size effect, measured. A full header dump confirms:

```
get_content_type('application/json','utf-8') = 'application/json'
get_content_type('text/html','utf-8')        = 'text/html; charset=utf-8'
--- ensure_ascii=True ---
  resp.mimetype    = 'application/json'
  resp.charset     = '<no charset attribute>'
--- ensure_ascii=False ---
  resp.mimetype    = 'application/json'
  resp.charset     = '<no charset attribute>'
```

So a client receiving literal UTF-8 bytes under `ensure_ascii = False` must rely on JSON's own mandated UTF-8 default (and on `\uXXXX`-escape auto-detection), **not** on an explicit `charset` parameter, because Flask/Werkzeug deliberately do not add one. This is a real, if minor, practical consequence of the pairing: the flag changes the byte encoding of the body without changing anything the header says about it.

## 5. Semantics are unchanged — representation only

The docstring makes no claim about semantics, and the probes confirm none exists. With `get_json()` (step 4), the same three-field payload decoded to `{'emoji': '😀', 'name': '雪', 'sym': '☃'}` under both settings. Round-trip checks (step 5, `(d)`):

```
(d) flag=True serialized ascii='{"k\\u96ea": ["\\u2603", "\\ud83d\\ude00"]}'
    loads == original: True response round-trip == original: True
(d) flag=False serialized ascii='{"k\u96ea": ["\u2603", "\U0001f600"]}'
    loads == original: True response round-trip == original: True
```

and `loads` accepts both spellings interchangeably: `app.json.loads('"\u2603"') -> '\u2603'` and `app.json.loads('"☃"') -> '\u2603'` (step 5 `(i)`). Non-string JSON values are untouched by the flag: `attr=False dumps({'a': [1, 2.5, None, True]}) -> {"a": [1, 2.5, null, true]}` and `attr=True` gives the identical string (step 5 `(h)`).

## 6. The canonical contract, and where the flag applies

The shipped test is the canonical, executable statement of the relationship — `tests/test_json.py:48-54` (re-read verbatim from the file; the `expected` literals are exactly `'"\\u2603"'` — a JSON string containing six characters `\u2603` — and `'"\u2603"'` — a JSON string containing the single character U+2603):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

The difference between the four-character text `\u2603` and the single character U+2603 is precisely the point of the flag, which is why that escape must be quoted literally and not retyped.

Executor run of that test: `.venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode -v` → `2 passed`, collected as `test_json_as_unicode[True-"\\u2603"]` and `test_json_as_unicode[False-"\u2603"]`. Broader: `tests/test_json.py tests/test_testing.py` → `56 passed`; full suite `tests/` → `489 passed in 3.61s`.

Because `ensure_ascii` lives on `app.json` and everything serializing JSON inside an app context funnels through it, the flag governs several surfaces at once:

- **`jsonify`** — `src/flask/json/__init__.py` (last function): `return current_app.json.response(*args, **kwargs)`.
- **Jinja `|tojson`** — `src/flask/app.py:422`: `rv.policies["json.dumps_function"] = self.json.dumps`; `docs/api.rst:235-244`: *"Jinja's ``|tojson`` filter is configured to use the app's JSON provider."* Observed: `|tojson attr=False -> '{"snow": "\u2603"}'`, `attr=True -> '{"snow": "\\u2603"}'`.
- **`EnvironBuilder.json_dumps`** (test client) — `src/flask/testing.py:88-93`: `return self.app.json.dumps(obj, **kwargs)`, whose docstring says *"The serialization will be configured according to the config associated with this EnvironBuilder's ``app``."* Observed: `attr=False -> '"\u2603"'`, `attr=True -> '"\\u2603"'`. This is also the contract in `tests/test_testing.py:110-114` (`app.json.ensure_ascii = False; EnvironBuilder(app, json="\u20ac")` → `'"\u20ac"'`).
- **Tagged session serializer** — `src/flask/json/tag.py:56-57` imports `dumps`/`loads` from `..json`, and `:321-326` calls them; wired as `session_json_serializer = TaggedJSONSerializer()` (`src/flask/sessions.py:287`). Observed: `TaggedJSONSerializer.dumps({'snow': X})` → `'{"snow":"\u2603"}'` with the attribute `False`, `'{"snow":"\\u2603"}'` with it `True`, both round-tripping.

## 7. Override and scope semantics (the two most likely misreadings, both probed)

**(a) A `dumps` kwarg beats the attribute** — because of `setdefault`:

```
(a) attr=False
    app.json.dumps(x)                      -> ascii: '"\u2603"'
    app.json.dumps(x, ensure_ascii=True)   -> ascii: '"\\u2603"'
    app.json.dumps(x, ensure_ascii=False)  -> ascii: '"\u2603"'
```

**(b–c) `flask.json.dumps` outside an app context escapes regardless of the attribute.** `src/flask/json/__init__.py:40-44`:

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

Observed:

```
(b) flask.json.dumps(x) OUTSIDE app ctx     -> ascii: '"\\u2603"' (attr was False)
(c) flask.json.dumps(x) INSIDE app ctx      -> ascii: '"\u2603"'
    (attr set True) INSIDE app ctx          -> ascii: '"\\u2603"'
```

Outside a context there is no provider and no `ensure_ascii` is set, so stdlib `json.dumps`' own `True` default applies. A probe that forgets the app context will therefore appear to contradict `app.json.ensure_ascii = False`.

**(d) Round-trip identity** — see §5.

## 8. Naming history: this replaced `JSON_AS_ASCII`

The parameter is the *successor*, not a synonym, of the removed config key. Executor grep for `JSON_AS_ASCII` in the repo returns exactly four hits, all outside `src/`: `CHANGES.rst:153`, `CHANGES.rst:286`, `docs/config.rst:419`, `docs/config.rst:441`.

`CHANGES.rst:285-288`:

```rst
-   JSON configuration is moved to attributes on the default
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

`CHANGES.rst:153-154`:

```rst
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

`docs/config.rst:440-443`:

```rst
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

So in `flask-3.2.0.dev0` the live control is `app.json.ensure_ascii`; setting `JSON_AS_ASCII` would do nothing.

## 9. One correction to the inherited evidence (must not be propagated)

The retrieved report's §7 claimed the `\u003c` in `test_tojson_filter` "shows `\u003c` escaping of `<` under `ensure_ascii=True`". The executor probed it and it is false:

```
stdlib json.dumps("<script>", ensure_ascii=True) = '"<script>"'
flag=True app.json.dumps("<script>") = '"<script>"'
flag=True |tojson                        = '"\\u003cscript\\u003e"'
flag=False app.json.dumps("<script>") = '"<script>"'
flag=False |tojson                        = '"\\u003cscript\\u003e"'
jinja version: 3.1.6
jinja htmlsafe_json_dumps: Markup('"\\u003cscript\\u003e"')
```

**`ensure_ascii` does not escape ASCII characters such as `<` and `>`** — its regex is `ESCAPE_ASCII = re.compile(r'([\\"]|[^\ -~])')` (`json/encoder.py:20`), which matches only backslash, quote, and anything outside printable ASCII. The `\u003c` in `|tojson` output comes from Jinja 3.1.6's `htmlsafe_json_dumps` (HTML-safety escaping, applied for **both** flag values) and is orthogonal to this parameter. The `|tojson` test therefore demonstrates that the filter routes through Flask's `dumps` (via `json.dumps_function`) but says nothing about `ensure_ascii` beyond "non-ASCII gets escaped".

## 10. What was observed vs. read from source

- **Observed by execution:** the default `True` (`DefaultJSONProvider.ensure_ascii = True` at runtime); the escape forms `'"\\u2603"'`, `'"\\ud83d\\ude00"'` (surrogate pair, on the **C accelerator** `_json.encode_basestring_ascii`), `'"\\u96ea"'`; non-ASCII keys escaped like values; pure-ASCII vs UTF-8 body bytes (`b'{"name":"\\u96ea"}\n'` vs `b'{"name":"\xe9\x9b\xaa"}\n'`); identical `Content-Type: application/json` with no charset and no `charset` attribute on the response; differing content lengths (18 vs 15, 56 vs 42); identical decoded object; `setdefault` override; the no-app-context fallback; per-consumer inheritance (`TaggedJSONSerializer`, `EnvironBuilder`, `|tojson`); `loads` indifferent to the flag and having no such parameter; the shipped `test_json_as_unicode` passing for both parametrizations; full suite `489 passed`.
- **Read from source (not executed):** the Werkzeug internals `_iter_encoded`, `set_data`, `get_content_type`, `_charset_mimetypes` and the Werkzeug-3.0 charset removal — quoted above from `werkzeug-3.1.3`, and consistent with the observed headers but not itself separately exercised; same for the `src/flask/app.py:1230-1231`, `src/flask/sessions.py`, `src/flask/testing.py:88-93` and `docs/api.rst` line quotes, which the probes corroborated behaviourally.
- **Environment caveat:** the "no charset on `application/json`" and "`str` → UTF-8" statements are Werkzeug ≥ 3.0 behaviours and are pinned here to **werkzeug 3.1.3**; the surrogate-pair form is CPython's `json` behaviour (3.13.9 here) and is what `ensure_ascii` forwards to, not something Flask implements.
- **Repo integrity:** nothing was added or modified — `git status --porcelain` = 0 lines; all probe scripts lived under `C:\Users\oobbee\AppData\Local\Temp`.

## Bottom line

`app.json.ensure_ascii` (default `True`) is a serialization-only, representation-only, per-app switch that reaches stdlib `json.dumps` through one `setdefault` (`provider.py:177`) and decides whether every non-ASCII code point in keys and string values becomes a `\uXXXX` escape (surrogate pairs above U+FFFF) or is written literally. Under `False`, Flask's text output is encoded to the wire as UTF-8 (`str.encode()`), so the body carries multi-byte UTF-8 while `Content-Type: application/json` remains unchanged and carries no charset; the decoded value is identical either way. The documented trade-off — *"more compatible with some clients, but can be disabled for better performance and size"* — is exactly what the probes measured (equal decoded data; 18 vs 15 and 56 vs 42 bytes).
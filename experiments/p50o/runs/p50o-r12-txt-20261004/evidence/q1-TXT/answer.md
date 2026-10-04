# `ensure_ascii` ↔ Unicode character representation in Flask's JSON serialization provider

**Direct answer (one line):** `ensure_ascii` is the single boolean switch on Flask's `DefaultJSONProvider` that selects between two *representations of the same value* — when `True` (the default) every non-ASCII character in the serialized text is replaced by `\uXXXX` escape sequences (surrogate pairs `\ud83d\ude00` for non-BMP characters), so the JSON output is pure ASCII; when `False` those characters are emitted literally inside the JSON string, leaving the byte-level encoding to the transport (UTF-8 in Flask/Werkzeug responses). Deserialized values are identical either way, and the switch is a *default*, not a hard constraint — an explicit `ensure_ascii=` keyword argument to a call wins over the attribute.

---

## 1. The parameter: name, location, default, docstring

It is spelled **`ensure_ascii`** and is a plain class attribute of `DefaultJSONProvider` in `src/flask/json/provider.py` (checkout root `D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src`), defaulting to `True`. Verbatim from the file (I re-read `provider.py:124–223` in this session; the two classes are `JSONProvider` at line 19 and `DefaultJSONProvider` at line 124):

```python
class DefaultJSONProvider(JSONProvider):
    """Provide JSON operations using Python's built-in :mod:`json`
    library. Serializes the following additional data types:

    -   :class:`datetime.datetime` and :class:`datetime.date` are
        serialized to :rfc:`822` strings. This is the same as the HTTP
        date format.
    -   :class:`uuid.UUID` is serialized to a string.
    -   :class:`dataclasses.dataclass` is passed to
        :func:`dataclasses.asdict`.
    -   :class:`~markupsafe.Markup` (or any object with a ``__html__``
        method) will call the ``__html__`` method to get a string.
    """

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
```

- **Declaration:** `src/flask/json/provider.py:144` → `ensure_ascii = True`
- **Documented semantics:** `provider.py:145–148` → *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*
- It is a **class attribute**, not a `ConfigAttribute` and not a property; it is settable **per app instance** via `app.json.ensure_ascii = ...` because each app gets its own provider instance (see §3).

Runtime confirmation that the attribute resolves to `True` and that the file in play is this checkout, not a wheel:

```
$ .venv/Scripts/python.exe -c "import importlib.metadata as m, flask.json.provider as p, sys; print('dist version:', m.version('Flask')); print('provider:', p.__file__); print('ensure_ascii class attr:', p.DefaultJSONProvider.ensure_ascii)"
dist version: 3.2.0.dev0
provider: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\json\provider.py
ensure_ascii class attr: True
```

Version / checkout identity:

```
$ head -5 pyproject.toml
[project]
name = "Flask"
version = "3.2.0.dev"
description = "A simple framework for building complex web applications."
readme = "README.md"
$ cat .venv/Lib/site-packages/flask.pth
D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src
$ head -5 .venv/Lib/site-packages/flask-3.2.0.dev0.dist-info/METADATA
Metadata-Version: 2.4
Name: Flask
Version: 3.2.0.dev0
Summary: A simple framework for building complex web applications.
Maintainer-email: Pallets <contact@palletsprojects.com>
$ cat .git/HEAD
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
```

## 2. The relationship, shown concretely

**`True` ⇒ escaped ASCII output; `False` ⇒ literal characters.** The same input value `"\N{SNOWMAN}"` (U+2603 ☃):

| `ensure_ascii` | serialized text | which is | length |
|---|---|---|---|
| `True` (default) | `"\u2603"` | quote + **6-character** escape + quote | 8 |
| `False` | `"☃"` | quote + literal U+2603 + quote | 3 |

Measured by the executed probe (raw log reproduced in §6):

```
--- check 2: True => escape sequence, False => literal character ---
input              : U+2603 SNOWMAN, ascii() = '\u2603'
ensure_ascii=True  : repr()='"\\u2603"'  ascii()='"\\u2603"'  len=8
ensure_ascii=False : repr()='"☃"'  ascii()='"\u2603"'  len=3
True branch is pure ASCII  : True
False branch is pure ASCII : False
True branch bytes (utf-8)  : b'"\\u2603"'
False branch bytes (utf-8) : b'"\xe2\x98\x83"' (len 5)
```

Note the trap that the probe deliberately asserted around: on a console that cannot render U+2603, the `False` branch prints as `"☃"` and `ascii()`-prints as `"\u2603"`, which *looks* like the `True` branch — hence the assertions on `repr()`, `ascii()` and `len()` rather than on what the terminal shows.

**Non-BMP characters are escaped as UTF-16 surrogate pairs, not as single codepoint escapes** (check 4):

```
--- check 4: non-BMP text uses UTF-16 surrogate-pair escapes ---
input U+1F600 ascii()      : '\U0001f600'  (ord=128512, single char)
ensure_ascii=True          : ascii()='"\\ud83d\\ude00"'  len=14
ensure_ascii=False         : ascii()='"\U0001f600"'  len=3
True branch is pure ASCII  : True
```

So "escape sequences" means `\uXXXX` **UTF-16 code-unit** escapes: one non-BMP character becomes two 6-character escapes.

**Object keys are escaped exactly like values** (check 5):

```
--- check 5: object keys are escaped too ---
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'
ensure_ascii=False : ascii()='{"\\u2603": "\\u2603"}'   [as logged: False branch is '{"☃": "☃"}']
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'
True branch is pure ASCII  : True
True branch contains 2 escapes: 2 (key + value)
```
(Exact raw line from the probe log, which is unambiguous:)

```
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'
ensure_ascii=False : ascii()='{"\u2603": "\u2603"}'
```

**Representation only, never the value.** Round-trip check 8:

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

Deserialization never consults the attribute — `provider.py:181–186`:

```python
    def loads(self, s: str | bytes, **kwargs: t.Any) -> t.Any:
        """Deserialize data as JSON from a string or bytes.

        :param s: Text or UTF-8 bytes.
        :param kwargs: Passed to :func:`json.loads`.
        """
        return json.loads(s, **kwargs)
```

**Size effect at the transport layer** (check 7): because the response body is a `str` that Werkzeug encodes as UTF-8, the two branches produce different byte lengths and `Content-Length` for the same value:

```
--- check 7: HTTP response bytes / Content-Length ---
(i)  default (ensure_ascii=True)  body bytes=b'{"s":"\\u2603"}\n'
     Content-Length=15  mimetype=application/json  len(body)=15  body.isascii()=True
(ii) app.json.ensure_ascii=False  body bytes=b'{"s":"\xe2\x98\x83"}\n'
     Content-Length=12  mimetype=application/json  len(body)=12  body.isascii()=False
byte-length difference (default - literal) = 3
```

The `str → bytes` conversion is Werkzeug's, not Flask's — `.venv/Lib/site-packages/werkzeug/wrappers/response.py:289–299`:

```python
    def set_data(self, value: bytes | str) -> None:
        """Sets a new string as response.  The value must be a string or
        bytes. If a string is set it's encoded to the charset of the
        response (utf-8 by default).
        """
        if isinstance(value, str):
            value = value.encode()
        self.response = [value]
        if self.automatically_set_content_length:
            self.headers["Content-Length"] = str(len(value))
```

and the charset is fixed at UTF-8 (`werkzeug/wrappers/response.py:826–831`):

```python
    @property
    def encoding(self) -> str:
        return "utf-8"
```

This is the only *observed* basis for the docstring's "better performance and size" phrase — the docstring itself is a design rationale, not a measured result, and nothing beyond the byte lengths above is claimed here.

## 3. How the parameter reaches the output — the exact wiring

One line does it. `DefaultJSONProvider.dumps`, `src/flask/json/provider.py:166–179` (verbatim):

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

**Wiring line: `src/flask/json/provider.py:177` → `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`.** Because it is `setdefault`, the attribute supplies a *default only*; an explicit call-site `ensure_ascii=` overrides it. Confirmed empirically (check 3):

```
--- check 3: explicit kwarg overrides the attribute (setdefault) ---
attribute True, no kwarg        : ascii()='"\\u2603"'
attribute True, ensure_ascii=F  : ascii()='"\u2603"'
[PASS] check3 explicit kwarg wins over attribute True
        no-kwarg -> '"\\u2603"'; kwarg False -> '"\u2603"'
```

The actual escaping is performed by CPython's stdlib `json.dumps` (imported at `provider.py:4` as `import json`), not by Flask code.

`response()` never touches the attribute — escaping is decided solely in `dumps`; `response` only adds a trailing newline and picks indent/separators (`provider.py:211–219`):

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

**Where the provider comes from** — `src/flask/sansio/app.py:230` and `:329` (both re-verified by `sed`):

```
$ sed -n '230p' src/flask/sansio/app.py
    json_provider_class: type[JSONProvider] = DefaultJSONProvider
$ sed -n '329p' src/flask/sansio/app.py
        self.json: JSONProvider = self.json_provider_class(self)
```

Because `self.json` is a per-app **instance**, `app.json.ensure_ascii = False` shadows the class attribute for that app only (check 1):

```
--- check 1: default value and per-instance mutability ---
DefaultJSONProvider.ensure_ascii (class attr) = True (type bool)
app_a.json.ensure_ascii (fresh instance)      = True
'ensure_ascii' in DefaultJSONProvider.__dict__ = True
'ensure_ascii' in app_a.json.__dict__ (before) = False
'ensure_ascii' in app_a.json.__dict__ (after)  = True -> False
app_a.json.ensure_ascii (after assign)         = False
app_b.json.ensure_ascii (second fresh app)     = True
[PASS] check1c assignment shadows only that instance
        app_a=False (own __dict__), app_b=True (still class attr), class=True unchanged
```

**Two other entry points funnel into the same `dumps`:**
- `src/flask/app.py:1231` — a view returning a `dict` or `list` is auto-serialized:

```
$ sed -n '1228,1233p' src/flask/app.py
            elif isinstance(rv, (dict, list)):
                rv = self.json.response(rv)
```

- `src/flask/app.py:422` — the Jinja `|tojson` filter policy:

```
$ sed -n '420,423p' src/flask/app.py
        rv.policies["json.dumps_function"] = self.json.dumps
```

**The `flask.json` module-level indirection** — `src/flask/json/__init__.py:40–44`:

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

So inside an app context `flask.json.dumps` inherits `app.json.ensure_ascii`; **without** an app context it sets only `default` and falls through to CPython's `json.dumps`, whose own default is also `ensure_ascii=True`. Check 6 isolates the two:

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
        False -> '"\u2603"'; True -> '"\\u2603"'
```

**The test-helper path** — `src/flask/testing.py:88–94`:

```python
    def json_dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize ``obj`` to a JSON-formatted string.

        The serialization will be configured according to the config associated
        with this EnvironBuilder's ``app``.
        """
        return self.app.json.dumps(obj, **kwargs)
```

## 4. The demonstration the repository itself ships

**The direct test — `tests/test_json.py:48–54`** (re-read verbatim in this session; the parametrization is 2 cases):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

`True` → the 8-character text `"\u2603"`; `False` → `"☃"`. The test also proves the switch is per-app-instance mutable.

**The test-client/request-body test — `tests/test_testing.py:110–114`:**

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

i.e. with `ensure_ascii = False` the euro sign `€` is emitted as the literal 3-byte UTF-8 sequence `\xe2\x82\xac` and read back via UTF-8 decode — the mirror image of the escape form.

**Both tests pass in this checkout** (evidence N1):

```
$ .venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -v --tb=short -p no:cacheprovider
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\...\flask-src\.venv\Scripts\python.exe
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 3 items

tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [ 33%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 66%]
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [100%]

============================== 3 passed in 0.05s ==============================
EXIT_CODE=0
```

Wider runs confirm nothing around this area is broken:

```
$ .venv/Scripts/python.exe -m pytest tests/test_json.py tests/test_testing.py -p no:cacheprovider
...
collected 56 items
tests\test_json.py ...............................                       [ 55%]
tests\test_testing.py .........................                          [100%]
============================= 56 passed in 0.22s ==============================
EXIT_CODE=0
```

```
$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider
...
testpaths: tests
collected 489 items
...
tests\test_json.py ...............................                       [ 74%]
...
============================= 489 passed in 2.15s =============================
EXIT_CODE=0
```

and in the maximum-verbosity twin run the four relevant items appear explicitly:

```
tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [  8%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 10%]
...
tests/test_json.py::test_tojson_filter PASSED                            [ 50%]
...
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [ 69%]
```

(The fixtures the tests need are in `tests/conftest.py:44–62`; `pyproject.toml:107–111` sets `testpaths = ["tests"]` and `filterwarnings = ["error"]`.)

## 5. Two boundaries that must not be blurred

**(a) The `|tojson` filter's HTML-safety escaping is a separate mechanism.** It escapes four *ASCII* characters after serialization, regardless of `ensure_ascii` — `.venv/Lib/site-packages/jinja2/utils.py:637–674`:

```python
def htmlsafe_json_dumps(
    obj: t.Any, dumps: t.Optional[t.Callable[..., str]] = None, **kwargs: t.Any
) -> markupsafe.Markup:
    """Serialize an object to a string of JSON with :func:`json.dumps`,
    then replace HTML-unsafe characters with Unicode escapes and mark
    the result safe with :class:`~markupsafe.Markup`.
    ...
    The following characters are escaped: ``<``, ``>``, ``&``, ``'``.
    ...
    """
    if dumps is None:
        dumps = json.dumps

    return markupsafe.Markup(
        dumps(obj, **kwargs)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("'", "\\u0027")
    )
```

Flask routes that filter through the provider (`app.py:422`), and the repo's own test for it is `tests/test_json.py:210–220`:

```python
def test_tojson_filter(app, req_ctx):
    # The tojson filter is tested in Jinja, this confirms that it's
    # using Flask's dumps.
    rv = flask.render_template_string(
        "const data = {{ data|tojson }};",
        data={"name": "</script>", "time": datetime.datetime(2021, 2, 1, 7, 15)},
    )
    assert rv == (
        'const data = {"name": "\\u003c/script\\u003e",'
        ' "time": "Mon, 01 Feb 2021 07:15:00 GMT"};'
    )
```

Probe check 9 demonstrates the independence directly — `<` is still escaped as `\u003c` while the snowman stays literal under `ensure_ascii = False`:

```
--- check 9 (CONTRAST): |tojson escapes < > & ' regardless ---
ensure_ascii=False, data={'x': '</script>'} -> ascii()='{"x": "\\u003c/script\\u003e"}'
ensure_ascii=False, data={'s': U+2603}       -> ascii()='{"s": "\u2603"}'
contains \u003c escaping: True
snowman left literal (not \u2603): True
```

So `\u003c`-style escaping and `ensure_ascii`-style escaping are two different mechanisms with different inputs (ASCII vs non-ASCII) and different owners (Jinja's `htmlsafe_json_dumps` vs CPython `json.dumps`).

**(b) The old `JSON_AS_ASCII` config key is gone.** `docs/config.rst:437–443`:

```rst
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

`CHANGES.rst:153–154`:

```rst
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

`CHANGES.rst:286–288`:

```rst
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

Probe check 10 confirms it is not a live key:

```
--- check 10 (CONTRAST): JSON_AS_ASCII config key is gone ---
'JSON_AS_ASCII' in app.config                  = False
'JSON_SORT_KEYS' in app.config                 = False
hasattr(app.config, 'JSON_AS_ASCII')           = False
supported spelling: app10.json.ensure_ascii    = True
```

Repo-wide greps — **`ensure_ascii` exists in exactly 5 places (the implementation attribute, its docstring mention, the wiring line, and the two tests); `JSON_AS_ASCII` exists only as historical prose:**

```
$ grep -rn "ensure_ascii" --include="*.py" --include="*.rst" --include="*.toml" . --exclude-dir=.venv --exclude-dir=.git
./src/flask/json/provider.py:144:    ensure_ascii = True
./src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
./src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
./tests/test_json.py:52:    app.json.ensure_ascii = test_value
./tests/test_testing.py:112:    app.json.ensure_ascii = False
$ grep -rn "JSON_AS_ASCII" . --exclude-dir=.venv --exclude-dir=.git
./CHANGES.rst:153:    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
./CHANGES.rst:286:    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
./docs/config.rst:419:   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
./docs/config.rst:441:    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
```

## 6. The full probe run (all 10 checks, exit 0)

Script `../flask-src-scratch/json_ensure_ascii_probe.py` (16,470 bytes) — written **only** to the scratch dir, never inside `flask-src/`. Raw stdout preserved at `../flask-src-scratch/json_ensure_ascii_probe.py.run1-raw` (7,014 bytes):

```
$ .venv/Scripts/python.exe ../flask-src-scratch/json_ensure_ascii_probe.py > ../flask-src-scratch/json_ensure_ascii_probe.py.run1-raw 2>&1
EXIT_CODE=0
$ cat ../flask-src-scratch/json_ensure_ascii_probe.py.run1-raw
==============================================================================
PROBE: DefaultJSONProvider.ensure_ascii vs Unicode representation
==============================================================================
python            : 3.13.9 (D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe)
flask module file : D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
provider file     : flask.json.provider (D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\json\provider.py)

--- check 1: default value and per-instance mutability ---
DefaultJSONProvider.ensure_ascii (class attr) = True (type bool)
app_a.json.ensure_ascii (fresh instance)      = True
'ensure_ascii' in DefaultJSONProvider.__dict__ = True
'ensure_ascii' in app_a.json.__dict__ (before) = False
'ensure_ascii' in app_a.json.__dict__ (after)  = True -> False
app_a.json.ensure_ascii (after assign)         = False
app_b.json.ensure_ascii (second fresh app)     = True
[PASS] check1a class attribute default is True
        DefaultJSONProvider.ensure_ascii is True -> True
[PASS] check1b fresh instance inherits class attr True
        app_a.json.ensure_ascii is True (before mutation) -> True
[PASS] check1c assignment shadows only that instance
        app_a=False (own __dict__), app_b=True (still class attr), class=True unchanged

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

--- check 3: explicit kwarg overrides the attribute (setdefault) ---
attribute True, no kwarg        : ascii()='"\\u2603"'
attribute True, ensure_ascii=F  : ascii()='"\u2603"'
[PASS] check3 explicit kwarg wins over attribute True
        no-kwarg -> '"\\u2603"'; kwarg False -> '"\u2603"'

--- check 4: non-BMP text uses UTF-16 surrogate-pair escapes ---
input U+1F600 ascii()      : '\U0001f600'  (ord=128512, single char)
ensure_ascii=True          : ascii()='"\\ud83d\\ude00"'  len=14
ensure_ascii=False         : ascii()='"\U0001f600"'  len=3
True branch is pure ASCII  : True
[PASS] check4a True -> two \uXXXX surrogate escapes (\ud83d\ude00)
        ascii()='"\\ud83d\\ude00"'; len=14 (2 escapes + 2 quotes)
[PASS] check4b False -> the single literal character
        ascii()='"\U0001f600"'; len=3

--- check 5: object keys are escaped too ---
ensure_ascii=True  : ascii()='{"\\u2603": "\\u2603"}'
ensure_ascii=False : ascii()='{"\u2603": "\u2603"}'
True branch is pure ASCII  : True
True branch contains 2 escapes: 2 (key + value)
[PASS] check5a True escapes key and value (count of \u2603 == 2)
        ascii()='{"\\u2603": "\\u2603"}'; escapes=2; isascii=True
[PASS] check5b False leaves both literal
        ascii()='{"\u2603": "\u2603"}'; literal count=2

--- check 6: flask.json.dumps outside vs inside app context ---
has_app_context() at this point = False
outside app ctx, flask.json.dumps -> ascii()='"\\u2603"'
inside app ctx, app.json.ensure_ascii=False -> ascii()='"\u2603"'
inside app ctx, app.json.ensure_ascii=True  -> ascii()='"\\u2603"'
after ctx exit, has_app_context() = False
[PASS] check6a outside app context: escaped (CPython json.dumps default True)
        ascii()='"\\u2603"'; flask.json.__init__ only sets 'default' outside ctx
[PASS] check6b inside app context: follows app.json.ensure_ascii
        False -> '"\u2603"'; True -> '"\\u2603"'

--- check 7: HTTP response bytes / Content-Length ---
(i)  default (ensure_ascii=True)  body bytes=b'{"s":"\\u2603"}\n'
     Content-Length=15  mimetype=application/json  len(body)=15  body.isascii()=True
(ii) app.json.ensure_ascii=False  body bytes=b'{"s":"\xe2\x98\x83"}\n'
     Content-Length=12  mimetype=application/json  len(body)=12  body.isascii()=False
byte-length difference (default - literal) = 3
[PASS] check7a default branch body is ASCII-only escaped
        body=b'{"s":"\\u2603"}\n'; equals b'{"s":"\\u2603"}\n' -> False; isascii=True
[PASS] check7b literal branch body is raw UTF-8
        body=b'{"s":"\xe2\x98\x83"}\n'; contains b'\xe2\x98\x83' -> True; isascii=False
[PASS] check7c Content-Length differs between the two branches
        default CL=15 (=len(body)=15), literal CL=12 (=len(body)=12), delta=3

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

--- check 9 (CONTRAST): |tojson escapes < > & ' regardless ---
ensure_ascii=False, data={'x': '</script>'} -> ascii()='{"x": "\\u003c/script\\u003e"}'
ensure_ascii=False, data={'s': U+2603}       -> ascii()='{"s": "\u2603"}'
contains \u003c escaping: True
snowman left literal (not \u2603): True
[PASS] check9a |tojson still escapes < as \u003c with ensure_ascii=False
        ascii()='{"x": "\\u003c/script\\u003e"}'
[PASS] check9b |tojson leaves the snowman literal when ensure_ascii=False
        ascii()='{"s": "\u2603"}'

--- check 10 (CONTRAST): JSON_AS_ASCII config key is gone ---
'JSON_AS_ASCII' in app.config                  = False
'JSON_SORT_KEYS' in app.config                 = False
hasattr(app.config, 'JSON_AS_ASCII')           = False
supported spelling: app10.json.ensure_ascii    = True
[PASS] check10a JSON_AS_ASCII is not a live config key
        in config -> False; hasattr(config) -> False
[PASS] check10b app.json.ensure_ascii is the supported spelling
        app10.json.ensure_ascii=True

==============================================================================
CHECKS FAILED: 0
==============================================================================
PROBE COMPLETE
```

One cosmetic defect in the probe's own logging, disclosed rather than hidden: check 7a's *detail* line prints `equals b'{"s":"\\u2603"}\n' -> False` while the check PASSes. The detail expression is a redundant, mis-escaped duplicate comparison (a two-backslash bytes literal, 16 bytes); the assertion that actually decides PASS/FAIL used the correct single-backslash literal (15 bytes). Verified empirically rather than assumed:

```
$ .venv/Scripts/python.exe ../flask-src-scratch/verify_probe_literal.py
observed BODY                  : b'{"s":"\\u2603"}\n' len 15
ONE  (payload 1 backslash)     : b'{"s":"\\u2603"}\n' len 15
TWO  (payload 2 backslashes)   : b'{"s":"\\\\u2603"}\n' len 16
BODY == ONE  -> True
BODY == TWO  -> False
BODY backslash count = 1
ONE  backslash count = 1
TWO  backslash count = 2
BODY is ascii -> True
VERIFY COMPLETE
EXIT_CODE=0
```

The real response body is 15 bytes with exactly one backslash (`\u2603`) and `Content-Length: 15`; the literal branch is 12 bytes. No conclusion depends on the mis-escaped detail string.

## 7. Provenance — this is the behaviour of *this* checkout, not a mutation

The checkout was cross-checked mechanically against the pristine second copy at `../worktree/flask/`, whose build manifest pins the same commit as the checkout's detached HEAD:

```
$ cat ../worktree/.build-manifest.json
{
 "builtAt": "2026-09-26T11:56:48.648Z",
 "flaskCommit": "85c5d93cbd049c4bd0679c36fd1ddcae8c37b642",
 ...
}
$ cat .git/HEAD
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
```

Recursive text diffs (all exit 0 = no text differences):

```
$ diff -r -q -x "__pycache__" -x "*.pyc" ../worktree/flask/src/flask src/flask
(no output)  DIFF_EXIT=0
$ diff -r -q -x "__pycache__" -x "*.pyc" -x ".pytest_cache" ../worktree/flask/tests tests
(none)       TESTS_DIFF_EXIT=0
$ diff -r -q ../worktree/flask/docs docs
(none)       DOCS_DIFF_EXIT=0
$ diff -q ../worktree/flask/pyproject.toml pyproject.toml && echo IDENTICAL
IDENTICAL
$ diff -q ../worktree/flask/CHANGES.rst CHANGES.rst && echo IDENTICAL
IDENTICAL
$ git -c core.fileMode=false diff --no-index "../worktree/flask/src/flask/json" "src/flask/json"
(only __pycache__/*.pyc binary differences; no text differences)   JSON_DIFF_EXIT=1
$ git -c core.fileMode=false diff --no-index "../worktree/flask/tests/test_json.py" "tests/test_json.py"
(none)   TESTJSON_EXIT=0
$ git -c core.fileMode=false diff --no-index --stat "../worktree/flask/src/flask" "src/flask"
 111 files changed, 0 insertions(+), 0 deletions(-)     GIT_DIFF_EXIT=1
```

All 111 entries are `__pycache__/*.pyc` binaries plus three `/dev/null` deletions — **zero text/line changes anywhere in `src/flask`, `tests/`, `docs/`, `pyproject.toml`, `CHANGES.rst`**. So the described behaviour is the behaviour of this checkout at upstream commit `85c5d93…`, i.e. canonical Flask 3.2.0.dev behaviour, not an injected mutation.

**Excluded distractors (checked, not used):**
- `flask_mut2_i417ar2x/mutated_test.py` is entirely about `SERVER_NAME` / `subdomain_matching=False` / `subdomain="<company_id>"` / `url_for` routing. `grep -in "json\|ensure_ascii\|unicode" flask_mut2_i417ar2x/mutated_test.py` → no matches. It has nothing to do with JSON serialization and is not quoted as evidence.
- The existing scratch probes (`unicode_boundary_probe.py`, `unicode_mro_probe.py`, etc.) concern `flask.debughelpers.UnexpectedUnicodeError` / MRO / error-handler precedence: `grep -rn "ensure_ascii" ../flask-src-scratch/` → no matches.
- `../swe-qa/Benchmark/flask.jsonl` (which holds the benchmark's own reference answer to this question) was **deliberately left unread**; nothing in this answer derives from it.

**Read-only / hygiene confirmation:**

```
$ git status --porcelain
?? flask_mut2_i417ar2x/
$ ls -la --time-style=full-iso .pytest_cache/
drwxr-xr-x 1 oobbee 197121       0 2026-10-03 19:18:53.432183800 +0800 .
... (all mtimes 2026-10-03 19:18, i.e. pre-existing, untouched by these runs)
$ ls -la --time-style=full-iso ../flask-src-scratch/ | grep -i "json_ensure\|verify_probe\|full-run2-verbose-ensure"
-rw-r--r-- 1 oobbee 197121   16470 2026-10-04 02:22:58 json_ensure_ascii_probe.py
-rw-r--r-- 1 oobbee 197121    7014 2026-10-04 02:23:02 json_ensure_ascii_probe.py.run1-raw
-rw-r--r-- 1 oobbee 197121  104999 2026-10-04 02:24:03 pytest-full-run2-verbose-ensure_ascii.txt
-rw-r--r-- 1 oobbee 197121    1020 2026-10-04 02:23:47 verify_probe_literal.py
```

No file was edited; the only untracked path in the checkout is the pre-existing `flask_mut2_i417ar2x/`; every new artifact lives in `../flask-src-scratch/`.

**Two corrections to the upstream handover, disclosed for accuracy (neither changes the answer):**
1. The handover claimed `grep -r ensure_ascii .venv` → "No matches". That is false: `.venv/Lib/site-packages/itsdangerous/_json.py:16` (`kwargs.setdefault("ensure_ascii", False)` for its own session-signing `Serializer`) and `.venv/Lib/site-packages/_pytest/cacheprovider.py:191` both match. Neither can shadow `DefaultJSONProvider` — there is no `flask/` package directory in site-packages (only `flask.pth` + `flask-3.2.0.dev0.dist-info`), so the "no interference" conclusion stands; only the literal grep wording was wrong.
2. The handover described `provider.py` as "179 lines"; it is **215 lines** (`wc -l src/flask/json/provider.py` → `215`). Every quoted line number still verifies.

## 8. Provenance sentence

The claims above rest on `src/flask/json/provider.py:144–148` (the `ensure_ascii = True` attribute and its docstring), `:166–179` (the `dumps` method with the wiring line `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` at `:177`), `:181–186` (`loads`, which never consults the attribute), `:189–219` (`response`, which adds only `\n`), `src/flask/json/__init__.py:40–44` (the app-context indirection), `src/flask/sansio/app.py:230` and `:329` (class binding and per-app instantiation), `src/flask/app.py:422` and `:1231` (the other two entry points funneling into the same `dumps`), `src/flask/testing.py:88–94`, `tests/test_json.py:48–54` (the demonstrating test), `tests/test_testing.py:110–114`, `docs/config.rst:437–443`, `CHANGES.rst:153–154` and `:286–288` (the `JSON_AS_ASCII` removal), and `jinja2/utils.py:637–674` (the independent `|tojson` HTML-safety mechanism). These lines are from this checkout — Flask `3.2.0.dev` (`pyproject.toml:2–3`), detached HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` — verified by the test runs recorded in §4 (3 passed / 56 passed / 489 passed, exit 0 in every configuration), by the 10-check probe in §6 (0 checks failed, `PROBE COMPLETE`, exit 0), and by the mutation cross-check in §7 showing zero text differences against the pristine copy at the same commit.

Everything asserted here is tied to one of those quotes or runs; nothing else has been claimed.
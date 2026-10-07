# Relationship between the ASCII-only encoding control parameter and Unicode character representation in serialized JSON output

## Short answer

In this framework the parameter is **`DefaultJSONProvider.ensure_ascii`** (default **`True`**), defined in `src/flask/json/provider.py`. It is the single switch that decides **how non-ASCII Unicode code points are represented in the serialized JSON text**:

- **`ensure_ascii = True` (the default)** → every non-ASCII character is replaced by an **ASCII escape sequence** `\uXXXX`; the serialized string is pure ASCII (`str.isascii() == True`).
- **`ensure_ascii = False`** → non-ASCII characters are emitted **literally as Unicode text**; the serialized string contains the actual code points (and, once the `Response` layer UTF-8-encodes it, multi-byte UTF-8 sequences on the wire).

Mechanically it is nothing more than a **pass-through default to the standard library's `json.dumps`**, done with `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`, so the semantics are exactly Python's `json` module semantics. It is **not** an output *encoding* setting: `dumps` returns a `str`, and character-set→bytes encoding happens later, at the `Response` layer in UTF-8. It is an **escaping / ASCII-only restriction on serialization**.

---

## 1. The parameter and its default

`src/flask/json/provider.py` — the attribute is a plain class attribute on `DefaultJSONProvider` (class declared at line 124: `class DefaultJSONProvider(JSONProvider):`), which is why it can be reassigned per app as `app.json.ensure_ascii = False`:

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

Neighbouring attributes read in the same window: `default` (line 138), `sort_keys = True` (line 150), `compact: bool | None = None` (line 157), `mimetype = "application/json"` (line 163). Verified directly in the working tree.

## 2. How the parameter reaches serialized output

`dumps` forwards the attribute to stdlib `json.dumps` as a **default**:

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

Three consequences visible in that code:

1. **It is only a default** (`setdefault`), so a caller passing `ensure_ascii=` explicitly to `dumps` overrides the provider attribute.
2. The value goes **straight to the stdlib `json.dumps`** (`import json` at line 5 of the same file) — the escaping rules are Python's.
3. `dumps` returns **`str`**, not bytes.

### It applies to every serialization path

`dump` (file writing) delegates to `dumps`, so it inherits the setting:

```python
    def dump(self, obj: t.Any, fp: t.IO[str], **kwargs: t.Any) -> None:
        """Serialize data as JSON and write to a file.

        :param obj: The data to serialize.
        :param fp: A file opened for writing text. Should use the UTF-8
            encoding to be valid JSON.
        :param kwargs: May be passed to the underlying JSON library.
        """
        fp.write(self.dumps(obj, **kwargs))
```

`jsonify` → `response` also inherits it, because `response` only injects `indent`/`separators` into `dump_args` and never touches `ensure_ascii`; the default comes from inside `dumps`:

```python
    def response(self, *args: t.Any, **kwargs: t.Any) -> Response:
        """Serialize the given arguments as JSON, and return a
        :class:`~flask.Response` object with it. The response mimetype
        will be "application/json" and can be changed with
        :attr:`mimetype`.

        If :attr:`compact` is ``False`` or debug mode is enabled, the
        output will be formatted to be easier to read.

        Either positional or keyword arguments can be given, not both.
        If no arguments are given, ``None`` is serialized.

        :param args: A single value to serialize, or multiple values to
            treat as a list to serialize.
        :param kwargs: Treat as a dict to serialize.
        """
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

The module-level API delegates to the active app's provider (`src/flask/json/__init__.py`), so `current_app.json.ensure_ascii` governs `flask.json.dumps` inside an app context:

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

and `jsonify` calls the provider's `response`:

```python
    return current_app.json.response(*args, **kwargs)  # type: ignore[return-value]
```

The Jinja `|tojson` filter is bound to the same provider method (`src/flask/app.py`): `rv.policies["json.dumps_function"] = self.json.dumps`. The docs state this too (`docs/api.rst`):

```rst
Flask uses Python's built-in :mod:`json` module for handling JSON by
default. The JSON implementation can be changed by assigning a different
provider to :attr:`flask.Flask.json_provider_class` or
:attr:`flask.Flask.json`. The functions provided by ``flask.json`` will
use methods on ``app.json`` if an app context is active.

Jinja's ``|tojson`` filter is configured to use the app's JSON provider.
The filter marks the output with ``|safe``. Use it to render data inside
HTML ``<script>`` tags.
```

Request-side serialization goes through the same provider (`src/flask/testing.py`):

```python
    def json_dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize ``obj`` to a JSON-formatted string.

        The serialization will be configured according to the config associated
        with this EnvironBuilder's ``app``.
        """
        return self.app.json.dumps(obj, **kwargs)
```

The app-level wiring is in `src/flask/sansio/app.py`:

```python
    json_provider_class: type[JSONProvider] = DefaultJSONProvider
    """A subclass of :class:`~flask.json.provider.JSONProvider`. An
    instance is created and assigned to :attr:`app.json` when creating
    the app.

    The default, :class:`~flask.json.provider.DefaultJSONProvider`, uses
    Python's built-in :mod:`json` library. A different provider can use
    a different JSON library.

    .. versionadded:: 2.2
    """
```

and `self.json: JSONProvider = self.json_provider_class(self)` is created during app initialisation.

### Where the parameter's exhaustive references are

```
$ grep -rn "ensure_ascii" --include="*.py" --include="*.rst" .
./src/flask/json/provider.py:144:    ensure_ascii = True
./src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
./src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
./tests/test_json.py:52:    app.json.ensure_ascii = test_value
./tests/test_testing.py:112:    app.json.ensure_ascii = False
```

```
$ grep -rn "JSON_AS_ASCII" src/
grep_exit=1
```

Note (minor discrepancy, non-blocking): the earlier evidence said "exactly four locations"; the grep actually returns **five lines**, because the `dumps` docstring line 171 also mentions `ensure_ascii`. The *code* references are still four (definition, forwarding, two tests). `JSON_AS_ASCII` is confirmed absent from `src/`.

---

## 3. The pinned expected mapping (tests)

`tests/test_json.py` — the canonical `True`/`False` mapping (verified verbatim in the working tree):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

Reading the literals precisely: the input is U+2603 SNOWMAN (`"\N{SNOWMAN}"` = `☃`).

- With `ensure_ascii=True` the returned `str` equals `"\u2603"` — an **8-character, all-ASCII** string (`"`, `\`, `u`, `2`, `6`, `0`, `3`, `"`).
- With `ensure_ascii=False` it equals `"☃"` — a **3-character** string (quote, snowman, quote) containing the literal code point.

This test proves the attribute is reassignable per-app and changes the *character repertoire of the returned string*.

`tests/test_testing.py` — the same switch on the request side:

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

Here `\u20ac` = `€`; with `ensure_ascii=False` the request-body bytes decode from UTF-8 to the **literal euro sign**, showing request-side JSON honours the provider too.

Related test on the Jinja path (`tests/test_json.py::test_tojson_filter`), showing `|tojson` uses Flask's `dumps`:

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

(`<`/`>` become `\u003c`/`\u003e` — Jinja's HTML-safe escaping of the JSON-dumped string, separate from but analogous to `\uXXXX` escaping.)

---

## 4. Empirical verification (executed)

### 4.1 Pinned tests

```
$ .venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q1-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q1-TXT\seal
configfile: pyproject.toml
collecting ... collected 3 items

tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [ 33%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 66%]
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [100%]

============================== 3 passed in 0.09s ==============================
EXIT_STATUS=0
```

### 4.2 In-process demo — string form vs. wire bytes

```
$ PYTHONPATH="$LOCAL" .venv/Scripts/python.exe - <<'EOF'
import flask
app = flask.Flask(__name__)
client = app.test_client()

@app.route("/")
def index():
    return flask.jsonify(name="\N{SNOWMAN}\N{EURO SIGN}")

for flag in (True, False):
    app.json.ensure_ascii = flag
    s = app.json.dumps("\N{SNOWMAN}")
    r = client.get("/")
    print("=== ensure_ascii =", flag, "===")
    print("  dumps ->", repr(s), "| len", len(s), "| ascii-only", s.isascii())
    print("  response .data ->", repr(r.data), "| len", len(r.data))
EOF
using provider: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q1-TXT\seal\src\flask\json\provider.py
=== ensure_ascii = True ===
  dumps -> '"\\u2603"' | len 8 | ascii-only True
  response .data -> b'{"name":"\\u2603\\u20ac"}\n' | len 24
=== ensure_ascii = False ===
  dumps -> '"☃"' | len 3 | ascii-only False
  response .data -> b'{"name":"\xe2\x98\x83\xe2\x82\xac"}\n' | len 18
EXIT_STATUS=0
```

An earlier run of the same demo also printed the mimetype and Content-Type, both `application/json` for both settings.

**Observed exactly as predicted:**

| `app.json.ensure_ascii` | `app.json.dumps("\N{SNOWMAN}")` | chars | ASCII-only? | `jsonify` response bytes | bytes |
|---|---|---|---|---|---|
| `True` (default) | `'"\\u2603"'` | 8 | yes | `b'{"name":"\\u2603\\u20ac"}\n'` | 24 |
| `False` | `'"☃"'` | 3 | no | `b'{"name":"\xe2\x98\x83\xe2\x82\xac"}\n'` | 18 |

`☃` = `\xe2\x98\x83` (3 UTF-8 bytes), `€` = `\xe2\x82\xac` (3 UTF-8 bytes). `False` is **smaller** (18 < 24), matching the historical rationale for the option.

### 4.3 The attribute is only a default — explicit kwargs override it in both directions

```
$ .venv/Scripts/python.exe - <<'EOF'
import flask
app = flask.Flask(__name__)
app.json.ensure_ascii = True
print("attr True, no kwarg     :", repr(app.json.dumps("\N{SNOWMAN}")))
print("attr True, kwarg False  :", repr(app.json.dumps("\N{SNOWMAN}", ensure_ascii=False)))
app.json.ensure_ascii = False
print("attr False, no kwarg    :", repr(app.json.dumps("\N{SNOWMAN}")))
print("attr False, kwarg True  :", repr(app.json.dumps("\N{SNOWMAN}", ensure_ascii=True)))
EOF
attr True, no kwarg     : '"\\u2603"'
attr True, kwarg False  : '"☃"'
attr False, no kwarg    : '"☃"'
attr False, kwarg True  : '"\\u2603"'
EXIT_STATUS=0
```

### 4.4 `dump()` writes the same controlled string

```
$ .venv/Scripts/python.exe - <<'EOF'
import flask, io
app = flask.Flask(__name__)
for flag in (True, False):
    app.json.ensure_ascii = flag
    buf = io.StringIO()
    app.json.dump({"s": "\N{SNOWMAN}"}, buf)
    print(flag, repr(buf.getvalue()))
EOF
True '{"s": "\\u2603"}'
False '{"s": "☃"}'
EXIT_STATUS=0
```

### 4.5 Module-level `flask.json.dumps` follows the active app's provider

```
$ .venv/Scripts/python.exe - <<'EOF'
import flask
print("no app ctx, module dumps :", repr(flask.json.dumps("\N{SNOWMAN}")))
app = flask.Flask(__name__)
with app.app_context():
    app.json.ensure_ascii = False
    print("app ctx, attr False      :", repr(flask.json.dumps("\N{SNOWMAN}")))
    app.json.ensure_ascii = True
    print("app ctx, attr True       :", repr(flask.json.dumps("\N{SNOWMAN}")))
EOF
no app ctx, module dumps : '"\\u2603"'
app ctx, attr False      : '"☃"'
app ctx, attr True       : '"\\u2603"'
EXIT_STATUS=0
```

With no app context it falls back to stdlib's own default (`True`); inside an app context the provider attribute governs.

### 4.6 Jinja `|tojson` honours the setting

```
$ .venv/Scripts/python.exe - <<'EOF'
import flask
app = flask.Flask(__name__)
with app.app_context():
    print("policy json.dumps_function is app.json.dumps:",
          app.jinja_env.policies["json.dumps_function"] == app.json.dumps)
for flag in (True, False):
    app.json.ensure_ascii = flag
    with app.test_request_context():
        out = flask.render_template_string("{{ data|tojson }}", data="\N{SNOWMAN}")
        print("tojson ensure_ascii=", flag, "->", repr(out))
EOF
policy json.dumps_function is app.json.dumps: True
tojson ensure_ascii= True -> '"\\u2603"'
tojson ensure_ascii= False -> '"☃"'
EXIT_STATUS=0
```

### 4.7 Full relevant suite

```
$ PYTHONPATH="$LOCAL" .venv/Scripts/python.exe -m pytest tests/test_json.py tests/test_testing.py
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q1-TXT\seal
configfile: pyproject.toml
collected 56 items

tests\test_json.py ...............................                       [ 55%]
tests\test_testing.py .........................                          [100%]

============================= 56 passed in 0.42s ==============================
EXIT_STATUS=0
```

The same 56 tests pass at maximum verbosity (`-vv -rA --tb=long -p no:cacheprovider`). The only traceback shown is expected captured logging from `test_test_client_context_binding`, which deliberately raises `ZeroDivisionError`; the test itself **PASSED**. Note on hygiene: plain invocations were found to import `flask` from a *sibling* temp checkout via a `.pth` entry (`sys.path[7]`), so the suite and demos were re-run with `PYTHONPATH=<cwd>/src`; results were identical. The `<- D:\...\flask-src\tests\...` annotation next to node ids is a stale `co_filename` baked into cached `__pycache__`, not the source executed.

No observed result contradicted the static reading.

---

## 5. String vs. bytes — the distinction to keep straight

`dumps` returns `str` (`-> str`). The UTF-8 byte encoding happens later, at the `Response` layer; `src/flask/app.py` documents that a `str` returned from a view means "A response object is created with the string encoded to UTF-8 as the body". The module docstrings repeatedly say the text/file "Should use the UTF-8 encoding to be valid JSON" (e.g. `provider.py` lines 53, 62, 70; `json/__init__.py` lines 55, 84, 96, 115, 130).

So:

- `ensure_ascii` decides the **character content of the `str`** produced by the provider.
- The `Response` layer then UTF-8-encodes that `str`.
- `True` yields ASCII-only text, where each escaped character costs **6 ASCII bytes** (`\uXXXX`); `False` yields literal non-ASCII text, encoded as **multi-byte UTF-8** (`☃` = 3 bytes, `€` = 3 bytes).

Hence `ensure_ascii` is an **escaping / ASCII-only restriction on JSON serialization**, not a character-set conversion. Calling it an "encoding parameter" is strictly inaccurate: `dumps` never produces bytes and never selects a charset.

---

## 6. History and configuration migration

The provider attribute replaces the removed `JSON_AS_ASCII` config key. `CHANGES.rst`:

```rst
-   JSON configuration is moved to attributes on the default
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

```rst
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

`docs/config.rst`:

```rst
.. versionadded:: 0.10
   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
```

```rst
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

The earliest origin of the option (v0.10) states the *why* — size — and confirms the default is on:

```rst
-   Added an option to generate non-ascii encoded JSON which should
    result in less bytes being transmitted over the network. It's
    disabled by default to not cause confusion with existing libraries
    that might expect ``flask.json.dumps`` to return bytes by default.
```

This corroborates the attribute docstring's "This may be more compatible with some clients, but can be disabled for better performance and size."

---

## 7. Practical summary

- **Default:** `app.json.ensure_ascii` is `True` (inherited from `DefaultJSONProvider.ensure_ascii = True`).
- **To get literal Unicode in output:** `app.json.ensure_ascii = False`.
- **Scope:** applies to `app.json.dumps`, `app.json.dump`, `flask.json.dumps` (inside an app context), `jsonify`/`app.json.response`, dict/list returned from views (which go through the same response machinery), the Jinja `|tojson` filter, and `EnvironBuilder.json_dumps` on the request side.
- **Override:** any explicit `ensure_ascii=` kwarg passed to `dumps` beats the attribute, in both directions.
- **Effect on representation:** `True` → `\uXXXX` escapes, ASCII-only `str`; `False` → literal Unicode code points in the `str`, which the `Response` layer emits as multi-byte UTF-8 bytes; consequently `False` produces smaller payloads.
- **Scoping caveat:** all of the above describes the default `DefaultJSONProvider`; a custom provider may implement different behavior, and with no active app context `flask.json.dumps` falls through to stdlib `json.dumps` with stdlib's own default (`ensure_ascii=True`).

Concrete demonstration, quoted from the executed runs: `app.json.dumps("\N{SNOWMAN}")` → `'"\\u2603"'` (8 ASCII chars) when `ensure_ascii=True`, and `'"☃"'` (3 chars, not ASCII) when `False`; the corresponding `jsonify` bodies are `b'{"name":"\\u2603\\u20ac"}\n'` (24 bytes) and `b'{"name":"\xe2\x98\x83\xe2\x82\xac"}\n'` (18 bytes) respectively.
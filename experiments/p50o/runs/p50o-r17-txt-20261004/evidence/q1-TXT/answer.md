## Answer: `ensure_ascii` in Flask's `DefaultJSONProvider` and Unicode character representation

### 1. The parameter

The ASCII-only encoding control parameter is `flask.json.provider.DefaultJSONProvider.ensure_ascii`, a plain class attribute that defaults to `True`. From `src/flask/json/provider.py` (lines 144–150):

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

It is the only such control in the tree: a whole-tree grep for `ensure_ascii` returns exactly five hits, three of them in the provider itself and two in tests.

```
./src/flask/json/provider.py:144:    ensure_ascii = True
./src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
./src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
./tests/test_json.py:52:    app.json.ensure_ascii = test_value
./tests/test_testing.py:112:    app.json.ensure_ascii = False
```

The provider is installed on every app via `Flask.json_provider_class` (`src/flask/sansio/app.py`):

```python
    json_provider_class: type[JSONProvider] = DefaultJSONProvider
```
```python
        self.json: JSONProvider = self.json_provider_class(self)
```

Because it is an ordinary class attribute (not a descriptor, not a `ConfigAttribute`), assigning `app.json.ensure_ascii = False` on the instance simply shadows the class default; the transcript below confirms `'ensure_ascii' in fresh.json.__dict__` goes `False` → `True` after assignment, and a *fresh* app still reports the class default `True`.

### 2. The mechanism: it is injected as a **default** into stdlib `json.dumps`

`DefaultJSONProvider.dumps` (`src/flask/json/provider.py`):

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

So the provider attribute is not a private switch of its own: it is the *default value* forwarded to the standard library encoder's own `ensure_ascii` parameter. The base class documents that caller kwargs are legitimate (`JSONProvider.dumps`, `src/flask/json/provider.py`):

```python
        :param kwargs: May be passed to the underlying JSON library.
```

and because the injection uses `setdefault`, an explicit call-level `ensure_ascii=` always wins. This was verified directly:

```
instance attr: False
with ensure_ascii=True kwarg: '"\\u2603"' 8 True
inheriting instance attr False: '"☃"' 3 False
```

The attribute is a *default*, not a hard override.

### 3. The relationship stated literally: same value, two different encoded representations

The relationship is: **`ensure_ascii` chooses between the JSON escape-sequence representation and the literal-character representation of non-ASCII code points; it never changes the value that is serialized or parsed back.**

The pinning test is `tests/test_json.py::test_json_as_unicode` (lines 48–54), quoted verbatim:

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

The discriminating experiment (repo `.venv/Scripts/python.exe`, Flask app object, snowman U+2603) produced:

```
default ensure_ascii: True
escaped: '"\\u2603"' 8 True
raw: '"☃"' 3 False
round-trip equal: True
jsonify content_type: application/json
jsonify data: b'{"value":"\xe2\x98\x83"}\n'
jsonify loads: {'value': '☃'}
```

with the backslash-safe character-count confirmation:

```
escaped repr: '"\\u2603"'
escaped len: 8
escaped codepoints: [34, 92, 117, 50, 54, 48, 51, 34]
escaped isascii: True
raw repr: '"☃"'
raw len: 3
raw codepoints: [34, 9731, 34]
raw isascii: False
json.loads(escaped)==snowman: True
json.loads(raw)==snowman: True
```

Concretely:

- With `ensure_ascii = True` (the default), each non-ASCII code point is emitted as a JSON `\uXXXX` escape sequence. `app.json.dumps("\N{SNOWMAN}")` returns the **8-character, pure-ASCII** string whose repr is `'"\\u2603"'` — codepoints `[34, 92, 117, 50, 54, 48, 51, 34]`, i.e. `"` `\` `u` `2` `6` `0` `3` `"`, with `isascii()` `True`. (The bare escape sequence `\u2603` accounts for six of those characters; the remaining two are the surrounding quotes.)
- With `ensure_ascii = False`, the same call returns the **3-character** string whose repr is `'"☃"'` — codepoints `[34, 9731, 34]`, i.e. the raw U+2603 code point embedded literally between the two quotes, with `isascii()` `False`.

The two forms are byte-for-byte different but semantically identical: the experiment prints `round-trip equal: True`, and `json.loads(escaped) == json.loads(raw) == "\N{SNOWMAN}"`. Escaping costs six ASCII characters per escaped code point and is transport-independent (safe through ASCII-clean channels); the literal form is shorter but assumes a Unicode-clean channel. This is exactly what the attribute docstring promises: "This may be more compatible with some clients, but can be disabled for better performance and size."

### 4. Scope: every provider output path funnels through that one `dumps`

`DefaultJSONProvider.dump` writes `self.dumps(...)`, and `DefaultJSONProvider.response` calls `self.dumps(obj, **dump_args)`:

```python
        return self._app.response_class(
            f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
        )
```

Consequently `ensure_ascii` applies to everything routed through the provider:

- `app.json.dumps` / `app.json.dump` and `app.json.response` (therefore `jsonify`);
- dict/list return values from views, because `make_response` in `src/flask/app.py` does `rv = self.json.response(rv)` for `isinstance(rv, (dict, list))`;
- `flask.json.dumps` inside an app context, since `src/flask/json/__init__.py` begins with `if current_app: return current_app.json.dumps(obj, **kwargs)`;
- test-client JSON bodies, since `src/flask/testing.py` has `return self.app.json.dumps(obj, **kwargs)` (`EnvironBuilder.json_dumps`, whose docstring says "The serialization will be configured according to the config associated with this EnvironBuilder's ``app``"), pinned by `tests/test_testing.py:110-114`:
  ```python
  def test_environbuilder_json_dumps(app):
      """EnvironBuilder.json_dumps() takes settings from the app."""
      app.json.ensure_ascii = False
      eb = EnvironBuilder(app, json="\u20ac")
      assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
  ```
- session cookie payloads, because `TaggedJSONSerializer.dumps` (`src/flask/json/tag.py`, imported `from ..json import dumps`) is `return dumps(self.tag(value), separators=(",", ":"))` and `sessions.py` uses `session_json_serializer = TaggedJSONSerializer()`;
- Jinja's `|tojson` filter, because `create_jinja_environment` in `src/flask/app.py` sets `rv.policies["json.dumps_function"] = self.json.dumps`.

**Escape hatches.** Two: assign `app.json.ensure_ascii = False` (instance attribute shadowing), or pass `ensure_ascii=` explicitly to a `dumps`/`dump` call, which wins over the attribute via `setdefault`. **Outside an app context**, `flask.json.dumps` falls back to plain `json.dumps` with only `kwargs.setdefault("default", _default)` applied:

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

so it keeps Python's own default, which the interpreter reports as `True` (`json.dumps` signature default). The probe confirms it: `no-app-context flask.json.dumps: '"\\u2603"' 8 True`.

### 5. Where the literal bytes land in an HTTP response

With escaping disabled, the literal characters are written as UTF-8 bytes in the body, and the response declares **no charset**. The probe shows `jsonify content_type: application/json` and `jsonify data: b'{"value":"\xe2\x98\x83"}\n'` — `\xe2\x98\x83` is the UTF-8 encoding of U+2603. This matches Werkzeug's `get_content_type` (`.venv/Lib/site-packages/werkzeug/utils.py`):

```python
def get_content_type(mimetype: str, charset: str) -> str:
    """Returns the full content type string with charset for a mimetype.

    If the mimetype represents text, the charset parameter will be
    appended, otherwise the mimetype is returned unchanged.
    ...
    """
    if (
        mimetype.startswith("text/")
        or mimetype in _charset_mimetypes
        or mimetype.endswith("+xml")
    ):
        mimetype += f"; charset={charset}"

    return mimetype
```

`application/json` starts with neither `text/` nor `+xml` and is not in `_charset_mimetypes` (`application/ecmascript`, `application/javascript`, `application/sql`, `application/xml`, `application/xml-dtd`, `application/xml-external-parsed-entity`), so no `charset` parameter is appended. Raw non-ASCII JSON therefore travels as UTF-8 bytes per RFC 8259 without a declared charset — which is precisely the interoperability argument behind defaulting to ASCII escaping.

### 6. What the relationship is **not**

- It is **not** Jinja's `|tojson` HTML escaping. The `\u003c` seen in `tests/test_json.py::test_tojson_filter` (`'const data = {"name": "\\u003c/script\\u003e", ...}'`) comes from Jinja's post-processing, which runs *after* `dumps`, not from `ensure_ascii`:
  ```python
    return markupsafe.Markup(
        dumps(obj, **kwargs)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("'", "\\u0027")
    )
  ```
  Jinja's `do_tojson` obtains the dumper via `dumps = policies["json.dumps_function"]` (Flask's), then applies that `.replace` chain itself.
- It is **not** `sort_keys`, `compact`, `indent`, or `mimetype`, the sibling attributes next to it in `DefaultJSONProvider`; `sort_keys`/`compact` control key ordering and whitespace, which are orthogonal to character encoding.
- It is **not** the old `JSON_AS_ASCII` config key, which no longer exists in this tree (see below).

### 7. Lineage

`ensure_ascii` is the successor to the removed `JSON_AS_ASCII` config key. `CHANGES.rst` (2.2.0):

```rst
-   JSON configuration is moved to attributes on the default
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

`CHANGES.rst` (2.3.0, "Remove previously deprecated code"):

```rst
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

and `docs/config.rst`:

```rst
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

`JSON_AS_ASCII` survives only in those historical notes (`CHANGES.rst:153`, `CHANGES.rst:286`, `docs/config.rst:419`, `docs/config.rst:441`); there is no live config key to confuse with `app.json.ensure_ascii`.

### 8. Empirical confirmation in this working tree

The behaviour above is not remembered documentation, it is the observed behaviour of this checkout (`pyproject.toml`: `name = "Flask"`, `version = "3.2.0.dev"`). The pinned tests were run first:

**Command:** `.venv/Scripts/pytest.exe tests/test_json.py::test_json_as_unicode tests/test_json.py::test_json_dump_to_file tests/test_json.py::test_tojson_filter tests/test_json.py::test_json_attr tests/test_testing.py::test_environbuilder_json_dumps -v` — exit `0`:

```
tests/test_json.py::test_json_as_unicode[True-"\\u2603"] PASSED          [ 16%]
tests/test_json.py::test_json_as_unicode[False-"\u2603"] PASSED          [ 33%]
tests/test_json.py::test_json_dump_to_file PASSED                        [ 50%]
tests/test_json.py::test_tojson_filter PASSED                            [ 66%]
tests/test_json.py::test_json_attr PASSED                                [ 83%]
tests/test_testing.py::test_environbuilder_json_dumps PASSED             [100%]

============================== 6 passed in 0.07s ==============================
```

The two relevant modules and the whole suite pass as well:

```
tests\test_json.py ...............................                       [ 55%]
tests\test_testing.py .........................                          [100%]

============================= 56 passed in 0.22s ==============================
```
```
============================= 489 passed in 2.08s =============================
```

No discrepancy from the documented default behaviour was found in the JSON path — the branch decision resolved to "documented/default behavior". The only arithmetic correction against the pre-execution plan is the escaped form's length: the plan predicted 7 characters, the measurement is **8** (`"`, `\`, `u`, `2`, `6`, `0`, `3`, `"`); the bare escape `\u2603` is 6 characters. The escaped/literal pair used throughout this answer is therefore **8 characters vs 3 characters**, taken verbatim from the transcript.

### Bottom line

`app.json.ensure_ascii` (class attribute `DefaultJSONProvider.ensure_ascii`, default `True`) is the single control deciding whether non-ASCII code points are rendered in JSON as `\uXXXX` escape sequences or as literal characters. It reaches the output only as `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` in `DefaultJSONProvider.dumps`, so it is a default that any explicit call argument overrides, and it governs every serialization path that funnels through that method (`dumps`, `dump`, `response`/`jsonify`, dict/list view returns, in-context `flask.json.dumps`, test-client JSON bodies, tagged session payloads, and Jinja `|tojson`). With `True`, `app.json.dumps("\N{SNOWMAN}")` is the 8-character ASCII string `'"\\u2603"'`; with `False` it is the 3-character string `'"☃"'` containing the literal U+2603, delivered as UTF-8 bytes in a response whose `Content-Type` is plain `application/json` with no charset. The flag changes only the encoded representation, never the decoded value — both forms parse back to the same string. The parameter is the successor to the `JSON_AS_ASCII` config key removed in Flask 2.3.
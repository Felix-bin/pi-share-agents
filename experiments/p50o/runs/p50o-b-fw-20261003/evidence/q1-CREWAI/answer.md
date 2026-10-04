# ASCII-only encoding vs. Unicode representation in Flask's JSON provider

## Short answer

Flask's `DefaultJSONProvider` exposes a single boolean attribute, `ensure_ascii`, that controls whether non-ASCII characters are written into JSON output as ASCII `\uXXXX` escape sequences (`True`, the default) or emitted literally as UTF-8 characters (`False`). It is forwarded verbatim into Python's `json.dumps` and is the **sole** control over this representation: it changes how characters are written, never what data is written. Sorting and compactness are governed by entirely different attributes (`sort_keys`, `compact`).

---

## 1. The attribute itself

`src/flask/json/provider.py` lines 144–148 define the attribute and document it:

```python
144:     ensure_ascii = True
145:     """Replace non-ASCII characters with escape sequences. This may be
146:     more compatible with some clients, but can be disabled for better
147:     performance and size.
148:     """
```

It is a **class attribute** of `DefaultJSONProvider(JSONProvider)` (class header at `provider.py:124`), defaulting to `True`, so it can be overridden per-instance — exactly as the tests do with `app.json.ensure_ascii = test_value`.

Critically, `ensure_ascii` sits alongside two *separate* attributes that govern unrelated aspects of serialization — `sort_keys` (`provider.py:150`) and `compact` (`provider.py:157`):

```python
150:     sort_keys = True
...
157:     compact: bool | None = None
```

This separation is the reason `ensure_ascii` must not be conflated with key ordering or pretty-printing.

## 2. How the flag reaches the serializer

`DefaultJSONProvider.dumps` (`src/flask/json/provider.py:166–179`) forwards the attribute into stdlib `json.dumps` via `kwargs.setdefault`:

```python
166:     def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
167:         """Serialize data as JSON to a string.
168:
169:         Keyword arguments are passed to :func:`json.dumps`. Sets some
170:         parameter defaults from the :attr:`default`,
171:         :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
...
176:         kwargs.setdefault("default", self.default)
177:         kwargs.setdefault("ensure_ascii", self.ensure_ascii)
178:         kwargs.setdefault("sort_keys", self.sort_keys)
179:         return json.dumps(obj, **kwargs)
```

Two consequences follow:

* The attribute is the **default** for `json.dumps`'s own `ensure_ascii` parameter (line 177).
* Because it is passed through `setdefault`, an explicit `ensure_ascii=` keyword argument to `dumps` **wins** over the attribute. (This is the standard `setdefault` precedence: the explicitly supplied key already exists, so the attribute value is not inserted.)

`response()` (`src/flask/json/provider.py:189–215`) never overrides `ensure_ascii` — its `dump_args` only ever carries `indent` or `separators`:

```python
205:         obj = self._prepare_response_obj(args, kwargs)
206:         dump_args: dict[str, t.Any] = {}
207:
208:         if (self.compact is None and self._app.debug) or self.compact is False:
209:             dump_args.setdefault("indent", 2)
210:         else:
211:             dump_args.setdefault("separators", (",", ":"))
212:
213:         return self._app.response_class(
214:             f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
215:         )
```

So `response()` (line 214 calls `self.dumps`) inherits the attribute directly; nothing in the response path competes with it. The base-class `JSONProvider.response` (`provider.py:89–105`) likewise just calls `self.dumps(obj)`:

```python
104:         obj = self._prepare_response_obj(args, kwargs)
105:         return self._app.response_class(self.dumps(obj), mimetype="application/json")
```

## 3. Every JSON path funnels through the provider

The module-level `flask.json.dumps` (`src/flask/json/__init__.py:40–44`) delegates to the active app's provider:

```python
40:     if current_app:
41:         return current_app.json.dumps(obj, **kwargs)
42:
43:     kwargs.setdefault("default", _default)
44:     return _json.dumps(obj, **kwargs)
```

`jsonify` (`src/flask/json/__init__.py:138–170`) calls the provider's `response`:

```python
144:     This requires an active request or application context, and calls
145:     :meth:`app.json.response() <flask.json.provider.JSONProvider.response>`.
...
170:     return current_app.json.response(*args, **kwargs)  # type: ignore[return-value]
```

And the Jinja `tojson` filter is wired to the same `dumps` (`src/flask/app.py:422`):

```python
422:         rv.policies["json.dumps_function"] = self.json.dumps
```

Furthermore, request-side JSON is bound to the provider instance too (`src/flask/ctx.py:319`):

```python
319:             request.json_module = app.json
```

So `ensure_ascii` governs response bodies (`jsonify`, `response`), module-level `flask.json.dumps`, the `tojson` template filter, and request-side serialization.

## 4. The behavioral specification (tests pin the mapping exactly)

`tests/test_json.py` lines 48–54 parametrize the two behaviors:

```python
48: @pytest.mark.parametrize(
49:     "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
50: )
51: def test_json_as_unicode(test_value, expected, app, app_ctx):
52:     app.json.ensure_ascii = test_value
53:     rv = app.json.dumps("\N{SNOWMAN}")
54:     assert rv == expected
```

* Input is `"\N{SNOWMAN}"` (U+2603).
* With `ensure_ascii = True`, expected is the Python literal `'"\\u2603"'` — i.e. the six-character ASCII escape sequence `"\u2603"` inside double quotes. Output is pure ASCII.
* With `ensure_ascii = False`, expected is `'"\u2603"'` — i.e. the literal UTF-8 snowman character U+2603 inside the quotes.
* Both are JSON strings that deserialize to the **same** Python `str` value; only the representation differs.

`tests/test_testing.py` lines 110–114 show the same flag propagates to request bodies built by `EnvironBuilder`:

```python
110: def test_environbuilder_json_dumps(app):
111:     """EnvironBuilder.json_dumps() takes settings from the app."""
112:     app.json.ensure_ascii = False
113:     eb = EnvironBuilder(app, json="\u20ac")
114:     assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

Here the euro sign U+20AC is emitted as a literal UTF-8 character. This works because Flask's `EnvironBuilder.json_dumps` (`src/flask/testing.py:88–94`) overrides Werkzeug's static-method default and defers to the app's provider:

```python
88:     def json_dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
89:         """Serialize ``obj`` to a JSON-formatted string.
90:
91:         The serialization will be configured according to the config associated
92:         with this EnvironBuilder's ``app``.
93:         """
94:         return self.app.json.dumps(obj, **kwargs)
```

## 5. Per-app configuration plumbing

`src/flask/sansio/app.py` defines the provider class and instantiates it per app:

```python
230:     json_provider_class: type[JSONProvider] = DefaultJSONProvider
231:     """A subclass of :class:`~flask.json.provider.JSONProvider`. An
232:     instance is created and assigned to :attr:`app.json` when creating
233:     the app.
...
239:     .. versionadded:: 2.2
240:     """
```

```python
329:         self.json: JSONProvider = self.json_provider_class(self)
330:         """Provides access to JSON methods. Functions in ``flask.json``
331:         will call methods on this provider when the application context
332:         is active. Used for handling JSON requests and responses.
...
335:         An instance of :attr:`json_provider_class`. Can be customized by
336:         changing that attribute on a subclass, or by assigning to this
337:         attribute afterwards.
```

Each app therefore owns a distinct provider object, so `app.json.ensure_ascii = ...` mutates only that app. The custom-provider test (`tests/test_json.py:223–257`) confirms the two customization routes — subclassing `DefaultJSONProvider` / changing `json_provider_class`, or assigning `app.json` directly (`app.json = CustomProvider(app)` at line 245) — as does the provider module docs (`provider.py:28–30`):

```python
28:     To use a different provider, either subclass ``Flask`` and set
29:     :attr:`~Flask.Flask.json_provider_class` to a provider class, or set
30:     :attr:`app.json <flask.Flask.json>` to an instance of the class.
```

## 6. What it does *not* control (separate concerns)

Three neighboring behaviors are frequently conflated with `ensure_ascii`; the tests establish they are governed elsewhere:

* **Key sorting** — by `sort_keys` (`provider.py:150`). `tests/test_json.py:270–273`:
  ```python
  270: def test_json_key_sorting(app, client):
  271:     app.debug = True
  272:     assert app.json.sort_keys
  273:     d = dict.fromkeys(range(20), "foo")
  ```
* **Compactness/pretty-printing** — by `compact` (`provider.py:157`). `tests/test_basic.py:1308–1314`:
  ```python
  1308: @pytest.mark.parametrize("compact", [True, False])
  1309: def test_jsonify_no_prettyprint(app, compact):
  1310:     app.json.compact = compact
  ...
  1313:     assert (b" " not in data) is compact
  1314:     assert (b"\n" not in data) is compact
  ```
* **HTML-safe escaping of `<`/`>` in `tojson`** — this is Jinja's own HTML-safe policy (`json.dumps_function`), not `ensure_ascii`. `tests/test_json.py:210–220`:
  ```python
  213:     rv = flask.render_template_string(
  214:         "const data = {{ data|tojson }};",
  215:         data={"name": "</script>", "time": datetime.datetime(2021, 2, 1, 7, 15)},
  216:     )
  217:     assert rv == (
  218:         'const data = {"name": "\\u003c/script\\u003e",'
  219:         ' "time": "Mon, 01 Feb 2021 07:15:00 GMT"};'
  220:     )
  ```
  The `\u003c`/`\u003e` here survives even with `ensure_ascii=False` (verified in finding 13), so it is not attributable to the flag.

## 7. Mechanical verification (stdlib mapping)

Python's stdlib mapping was confirmed for the exact test values:

```
ensure_ascii=True  -> '"\\u2603"'      (8 chars, ASCII bytes b'"\\u2603"')
ensure_ascii=False -> '"☃"'            (3 chars, UTF-8 bytes b'"\xe2\x98\x83"')
expected True      -> '"\\u2603"'      match: True
expected False     -> '"☃"'            match: True
roundtrip equal (json.loads both)      : True
```

`True` produces 8 ASCII bytes; `False` produces 3 UTF-8 bytes — i.e. `False` is smaller, matching the docstring's "better performance and size." The euro fixture likewise: `'"€"'` matches the expected value in `test_testing.py`.

Runtime checks of the provider confirmed: the class attribute is `True` and overridable on the instance; `sort_keys` is `True` and `compact` is `None`; an explicit `dumps(..., ensure_ascii=...)` kwarg wins over the attribute both ways (`kwarg True over attr False -> '"\\u2603"'`; `kwarg False over attr True -> '"☃"'`); and `response()` bodies honor the flag (`b'{"s":"\\u2603"}\n'` vs `b'{"s":"\xe2\x98\x83"}\n'`). Two apps held `json.ensure_ascii` of `False` and `True` simultaneously with `distinct provider objects: True`. `jsonify` and module-level `flask.json.dumps` both routed through the provider.

The behavior-pinning tests pass unmodified:

```
pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps
3 passed in 0.13s
```

and the separation-of-controls tests pass too (`test_json_key_sorting`, `test_jsonify_no_prettyprint[True]`, `test_jsonify_no_prettyprint[False]`, `test_tojson_filter` — `4 passed in 0.24s`).

## 8. Legacy configuration keys are gone

Greps across the worktree return **no hits** for `JSON_AS_ASCII` or `JSON_SORT_KEYS`:

```
pattern: "JSON_AS_ASCII"   -> (no hits)
pattern: "JSON_SORT_KEYS"  -> (no hits)
```

`ensure_ascii` in first-party code appears only at `src/flask/json/provider.py:144,171,177` and in tests at `tests/test_json.py:52` and `tests/test_testing.py:112`. The only documentation is the in-code docstring (`provider.py:145–148`); no `docs/` file mentions it. This confirms the modern Flask model: behavior is configured through the provider instance attribute, not the removed Flask 1.x/2.x config keys.

---

## Conclusion — the exact relationship

1. `ensure_ascii` is an attribute of `DefaultJSONProvider` defaulting to `True` (`src/flask/json/provider.py:144`, with docstring at `:145–148`).
2. It is forwarded verbatim into `json.dumps` via `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`) followed by `return json.dumps(obj, **kwargs)` (`provider.py:179`); the `setdefault` means an explicit `ensure_ascii=` kwarg overrides the attribute, but otherwise the attribute is the default.
3. `True` → every non-ASCII codepoint is replaced by an ASCII `\uXXXX` escape sequence — pure-ASCII output, larger but maximally client-compatible.
4. `False` → non-ASCII codepoints are emitted literally as UTF-8 characters — smaller and faster output.
5. Both forms are semantically equivalent JSON strings that deserialize to the identical Unicode value: the flag changes **representation, not data**.
6. It is the sole control over response-body encoding, since `response()` only ever sets `indent`/`separators` and delegates to `dumps` (`provider.py:208–214`); it therefore governs `jsonify`, `response`, module-level `dumps`, `tojson`, and request-side `EnvironBuilder.json_dumps`.
7. Sorting (`sort_keys`, `provider.py:150`) and compactness (`compact`, `provider.py:157`) are separate attributes and are unaffected by `ensure_ascii`.
8. Pinned by `tests/test_json.py:48–54` (`True` → `'"\\u2603"'`, `False` → `'"☃"'`) and `tests/test_testing.py:110–114` (euro sign literal with `False`); plumbed per-app via `json_provider_class`/`self.json = self.json_provider_class(self)` at `src/flask/sansio/app.py:230, 329`.
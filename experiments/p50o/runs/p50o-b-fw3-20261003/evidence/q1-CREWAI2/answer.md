# `ensure_ascii` in Flask's JSON Provider vs. Unicode in Serialized Output

## The short answer

`DefaultJSONProvider.ensure_ascii` (a plain class attribute defaulting to `True`) is the switch that decides whether non-ASCII characters in Flask's serialized JSON output are written as `\uXXXX` ASCII escape sequences (`True`) or as literal Unicode characters in the UTF-8 text (`False`). `dumps` forwards the attribute into Python's `json.dumps` via `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`, so the attribute is the default and an explicit per-call `ensure_ascii=` kwarg overrides it. The setting is per-provider-instance (i.e. per app), not a config key, and it is purely a transport-encoding choice — both forms are valid JSON and deserialize to the same Python data.

---

## 1. The control parameter and its declared semantics — `src/flask/json/provider.py`

**`DefaultJSONProvider.ensure_ascii = True` + docstring (`provider.py:144-148`):**

```
144:     ensure_ascii = True
145:     """Replace non-ASCII characters with escape sequences. This may be
146:     more compatible with some clients, but can be disabled for better
147:     performance and size.
148:     """
```

This is the decisive declaration: default `True`, documented as escaping non-ASCII characters for client compatibility, disable-able for performance/size. It is a plain class attribute (no `ConfigAttribute`), so it is per-app-instance-mutable, not a config key.

**`dumps` forwarding via `kwargs.setdefault` (`provider.py:166-179`):**

```
166:     def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
...
176:         kwargs.setdefault("default", self.default)
177:         kwargs.setdefault("ensure_ascii", self.ensure_ascii)
178:         kwargs.setdefault("sort_keys", self.sort_keys)
179:         return json.dumps(obj, **kwargs)
```

Line 177 is the wire: the instance attribute is injected into `json.dumps` defaults via `setdefault`, so an explicit `ensure_ascii=` kwarg from a caller wins (override precedence), while the attribute value is the default otherwise.

**The base-class serialization seam (`provider.py:38-57`, `89-105`):**

```
41:     def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
...
47:         raise NotImplementedError
48:
49:     def dump(self, obj: t.Any, fp: t.IO[str], **kwargs: t.Any) -> None:
...
57:         fp.write(self.dumps(obj, **kwargs))
```

```
104:         obj = self._prepare_response_obj(args, kwargs)
105:         return self._app.response_class(self.dumps(obj), mimetype="application/json")
```

`dump` funnels through `self.dumps` (line 57); base `response` funnels through `self.dumps` with mimetype `"application/json"` (line 105). Every serialization path funnels through the provider's `dumps`, hence inherits `ensure_ascii`.

The `DefaultJSONProvider.response` override (`provider.py:189-215`) also routes through `self.dumps`:

```
205:         obj = self._prepare_response_obj(args, kwargs)
206:         dump_args: dict[str, t.Any] = {}
...
208:         if (self.compact is None and self._app.debug) or self.compact is False:
209:             dump_args.setdefault("indent", 2)
210:         else:
211:             dump_args.setdefault("separators", (",", ":"))
212:
213:         return self._app.response_class(
214:             f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
215:         )
```

`dump_args` only ever sets `indent`/`separators`, never `ensure_ascii`, so `ensure_ascii` still comes from the attribute via `setdefault`.

## 2. Where the provider instance and its attribute are wired — `src/flask/sansio/app.py`

```
230:     json_provider_class: type[JSONProvider] = DefaultJSONProvider
```

```
329:         self.json: JSONProvider = self.json_provider_class(self)
```

Each `Flask` app owns exactly one provider instance, so `app.json.ensure_ascii = False` mutates only that app; alternate providers may decline to honor the attribute.

## 3. Entry points that reach the provider's `dumps`

**Module-level `dumps` (`json/__init__.py:40-44`):**

```
40:     if current_app:
41:         return current_app.json.dumps(obj, **kwargs)
42:
43:     kwargs.setdefault("default", _default)
44:     return _json.dumps(obj, **kwargs)
```

Line 41 delegates to the provider (inherits `ensure_ascii`); line 44 is the contextless fallback that goes straight to stdlib `json.dumps` and does **not** inherit the attribute.

**Module-level `dump` (`json/__init__.py:70-74`):**

```
70:     if current_app:
71:         current_app.json.dump(obj, fp, **kwargs)
72:     else:
73:         kwargs.setdefault("default", _default)
74:         _json.dump(obj, fp, **kwargs)
```

**`jsonify` (`json/__init__.py:170`):** `return current_app.json.response(*args, **kwargs)` → provider `dumps`.

**Auto-conversion of dict/list view returns (`app.py:1230-1231`):**

```
1230:             elif isinstance(rv, (dict, list)):
1231:                 rv = self.json.response(rv)
```

**`EnvironBuilder.json_dumps` (`testing.py:88-94`):**

```
88:     def json_dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
89:         """Serialize ``obj`` to a JSON-formatted string.
90:
91:         The serialization will be configured according to the config associated
92:         with this EnvironBuilder's ``app``.
93:         """
94:         return self.app.json.dumps(obj, **kwargs)
```

Flask's `EnvironBuilder` overrides Werkzeug's default `json_dumps` — which is `staticmethod(json.dumps)` (` .venv/Lib/site-packages/werkzeug/test.py:289`) — to delegate to the app's provider, so the test client inherits `ensure_ascii`.

**Also on the same seam:** Jinja's `tojson` is routed to the provider — `rv.policies["json.dumps_function"] = self.json.dumps` (`app.py:422`); and the request's JSON module is the app's provider — `request.json_module = app.json` (`ctx.py:319`).

## 4. Tests that pin the observable behavior

**The canonical test (`tests/test_json.py:48-54`):**

```
48: @pytest.mark.parametrize(
49:     "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
50: )
51: def test_json_as_unicode(test_value, expected, app, app_ctx):
52:     app.json.ensure_ascii = test_value
53:     rv = app.json.dumps("\N{SNOWMAN}")
54:     assert rv == expected
```

`True` ⇒ `'"\\u2603"'` (the six ASCII characters `\u2603` wrapped in quotes); `False` ⇒ `'"\u2603"'` (the literal U+2603 snowman codepoint).

**End-to-end through the test client (`tests/test_testing.py:110-114`):**

```
110: def test_environbuilder_json_dumps(app):
111:     """EnvironBuilder.json_dumps() takes settings from the app."""
112:     app.json.ensure_ascii = False
113:     eb = EnvironBuilder(app, json="\u20ac")
114:     assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

With `ensure_ascii = False`, the euro sign U+20AC appears as raw UTF-8 bytes, proving the setting flows through the test client.

## 5. External / contrast evidence

**ItsDangerous sets its own default (` .venv/Lib/site-packages/itsdangerous/_json.py:16`):**

```
16:         kwargs.setdefault("ensure_ascii", False)
```

A reminder that providers other than Flask's own `DefaultJSONProvider` do not inherit `ensure_ascii = True`; they may set their own default.

**The complete repo-wide set of `ensure_ascii` occurrences:**

- `src/flask/json/provider.py:144` — `ensure_ascii = True`
- `src/flask/json/provider.py:171` — docstring reference
- `src/flask/json/provider.py:177` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`
- `tests/test_json.py:52` — `app.json.ensure_ascii = test_value`
- `tests/test_testing.py:112` — `app.json.ensure_ascii = False`
- `.venv/Lib/site-packages/itsdangerous/_json.py:16` — `kwargs.setdefault("ensure_ascii", False)`
- `.venv/Lib/site-packages/_pytest/cacheprovider.py:191` — unrelated pytest caching

No `ensure_ascii` config key exists anywhere (no `ConfigAttribute`, no `default_config` entry), confirming it is an attribute, not a config setting.

---

## Direct demonstration (Python 3.13.9, Flask 3.2.0.dev0, via `.venv/Scripts/python.exe`)

Setting the attribute and calling `app.json.dumps("\N{SNOWMAN}")`:

```
ensure_ascii= True -> repr='"\\u2603"' len=8 isascii=True
ensure_ascii=False -> repr='"☃"' len=3 isascii=False
```

Override precedence (explicit kwarg beats the attribute, thanks to `setdefault`):

```
attr False, explicit kwarg True : '"\\u2603"'
attr True,  explicit kwarg False: '"☃"'
```

`loads` is invariant to the setting (both forms round-trip to the same Python `str`):

```
loads(escaped) == '☃'
loads(literal) == '☃'
loads equal: True
```

`response`/`jsonify`/dict-view/`dump` all mirror `dumps`:

```
response(ascii=True) : b'"\\u2603"\n'
jsonify (ascii=True) : b'"\\u2603"\n'
response(ascii=False): b'"\xe2\x98\x83"\n'
jsonify (ascii=False): b'"\xe2\x98\x83"\n'
view dict ascii=False: b'{"snow":"\xe2\x98\x83"}\n'
view dict ascii=True : b'{"snow":"\\u2603"}\n'
dump ascii=False: '{"snow": "☃"}'
dump ascii=True : '{"snow": "\\u2603"}'
```

Per-app isolation and absence of a config key:

```
DefaultJSONProvider.ensure_ascii class attr: True
type: <class 'bool'>
is ConfigAttribute: bool
distinct provider instances: True
a.json.ensure_ascii: False b.json.ensure_ascii: True
ensure_ascii in default_config: False
json_provider_class is DefaultJSONProvider: True
['kwargs.setdefault("default", self.default)',
 'kwargs.setdefault("ensure_ascii", self.ensure_ascii)',
 'kwargs.setdefault("sort_keys", self.sort_keys)']
```

Contextless fallback contrast (`flask.json.dumps` without an app context uses stdlib's own default, not the attribute):

```
contextless flask.json.dumps: '"\\u2603"'
stdlib json.dumps default  : '"\\u2603"'
```

Test runs: the relevant suite (`tests/test_json.py tests/test_testing.py`) reported **56 passed**, including the two decisive cases `test_json_as_unicode[True-"\\u2603"]` and `test_json_as_unicode[False-"\u2603"]` plus `test_environbuilder_json_dumps`; the full suite reported **489 passed**.

---

## The causal chain (with citations)

1. `DefaultJSONProvider.ensure_ascii = True` (`provider.py:144`) — a class-level, per-app-instance-mutable default, documented at lines 145–148 as "Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."
2. `DefaultJSONProvider.dumps` forwards it via `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`) into `json.dumps` (`provider.py:179`); an explicit `ensure_ascii=` kwarg overrides because of `setdefault`.
3. Every serialization route funnels to the provider's `dumps`: base `dump` (`provider.py:57`), base `response` (`provider.py:105`), `DefaultJSONProvider.response` (`provider.py:214`), `flask.json.dumps` (`json/__init__.py:41`), `flask.json.dump` (`json/__init__.py:71`), `jsonify` (`json/__init__.py:170`), dict/list view auto-conversion (`app.py:1231`), and `EnvironBuilder.json_dumps` (`testing.py:94`). Only the contextless fallback `_json.dumps` (`json/__init__.py:44`) does **not** inherit it.
4. Decisive observable evidence: `tests/test_json.py:49` pins `(True, '"\\u2603"')` (ASCII escape `\u2603`) vs `(False, '"\u2603"')` (literal U+2603), and `tests/test_testing.py:112-114` pins raw UTF-8 euro passthrough through the test client.

## Consequences

- **Default (`True`):** output stays ASCII-clean — non-ASCII characters are emitted as `\uXXXX` escape sequences — which is "more compatible with some clients."
- **Disabled (`False`):** serialized output contains the literal Unicode characters (raw UTF-8), yielding "better performance and size" (e.g. the snowman case: 8 ASCII characters escaped vs. 3 characters literal).
- **Both forms are valid JSON and deserialize identically:** `loads` (`provider.py:187`) simply calls `json.loads(s, **kwargs)` and is unaffected, so `ensure_ascii` is a **transport-encoding choice, not a data-model choice**.
- **Scope:** it is a per-provider-instance (per-app) attribute, overridable per call, and it reaches HTTP responses, `jsonify`, dict/list return values, `dump`, Jinja's `tojson`, and the Flask test client alike — while the no-app-context fallback does not honor it.
# Answer — the `ensure_ascii` flag vs. Unicode representation in Flask's JSON output

**Artifact under study:** `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src` — a clone of `pallets/flask`, checked out detached at commit **`85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`** ("Merge branch 'stable'"), version **`3.2.0.dev`** (`pyproject.toml:3` `version = "3.2.0.dev"`; `requires-python = ">=3.10"`, `pyproject.toml:22`). The same commit is recorded in `experiments/data/swe-qa/repo_commit.txt` (`https://github.com/pallets/flask 85c5d93`) and pinned by `experiments/bench/build-public-families.mjs:120-141` after cloning `https://github.com/pallets/flask`. This is the SWE-QA R-group benchmark repository (and, as an aside, **this exact question is `flask.jsonl` line 1**, i.e. SWE-QA task index 0 — `grep -n` and the 48-line count of `experiments/data/swe-qa/Benchmark/flask.jsonl` both confirm it). Everything below is cited from *this* checkout; the benchmark's own ground-truth `answer` field agrees with it, but it is not itself source evidence.

Scope note up front: this describes the **vendored Flask source**. SYNAPSE's own TypeScript code has no such flag — `grep -rn -i -e "ensure_ascii" -e "ensureAscii" src` under `pi-share-agents-openeuler-wsl/` returns **no matches**, as does `JSON_AS_ASCII`. The Flask tree exists here only as benchmark data, read by `experiments/openeuler/shm/{e0c.mjs,exp-a-runner.mjs,…}` (`const FLASK_SRC = path.join(repoRoot, "experiments", "data", "flask-src")`).

---

## 1. What the control parameter is

It is a **plain class attribute on `DefaultJSONProvider`**, in `experiments/data/flask-src/src/flask/json/provider.py:144-148`:

```python
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

- Name: `ensure_ascii`; owner: `DefaultJSONProvider`; **default: `True`**; type: boolean.
- It sits among the provider's other serialization knobs — `default: t.Callable[…] = staticmethod(_default)` (`provider.py:138`), `sort_keys = True` (`provider.py:150`), `compact: bool | None = None` (`provider.py:159`), `mimetype = "application/json"` (`provider.py:164`).
- The full-tree grep bounds it exactly: `ensure_ascii` appears in live code **only** at `provider.py:144` and `provider.py:177` (plus the docstring mention at `:171`), and in tests at `tests/test_json.py:52` and `tests/test_testing.py:112`. Nothing else in the checkout reads it.
- **Historical spelling:** it used to be the `JSON_AS_ASCII` config key. `docs/config.rst:437-443`: "`.. versionchanged:: 2.3` — ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has equivalent attributes instead."; `CHANGES.rst:285-288` (Flask 2.2): "JSON configuration is moved to attributes on the default ``app.json`` provider. ``JSON_AS_ASCII``, … are deprecated. :pr:`4692`"; `CHANGES.rst:153-154` (2.3): the keys "are removed". `JSON_AS_ASCII` exists nowhere as live code in this checkout — only those four doc/changelog hits.
- **How it is exposed at app level:** `json_provider_class: type[JSONProvider] = DefaultJSONProvider` (`src/flask/sansio/app.py:230`) and `self.json: JSONProvider = self.json_provider_class(self)` (`sansio/app.py:329`). So the user-visible knob is `app.json.ensure_ascii`. Live confirmation: `provider instance: flask.json.provider.DefaultJSONProvider … defaults -> ensure_ascii: True | sort_keys: True | compact: None | mimetype: application/json`.

## 2. How it reaches the serializer — a *default*, not an authority

`DefaultJSONProvider.dumps`, `provider.py:166-179` (whole method):

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON to a string.

        Keyword arguments are passed to :func:`json.dumps`. Sets some
        parameter defaults from the :attr:`default`,
        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
        ...
        """
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

So the attribute is forwarded **only as a `setdefault`** (`provider.py:177`) for the `ensure_ascii` keyword of Python's stdlib `json.dumps` (`provider.py:179`; `import json` at `provider.py:5`). Two consequences that fall straight out of the text:

- **Per-call kwargs win.** `app.json.ensure_ascii = False` is silently ignored if the caller passes `ensure_ascii=True` explicitly. Executed proof on this checkout's own provider:
  ```
  app.json.dumps (default attr True)   : '"\\u2603"'
  app.json.dumps (attr set to False)   : '"\u2603"'
  TRAP per-call ensure_ascii=True wins : '"\\u2603"'
  TRAP per-call ensure_ascii=False wins: '"\u2603"'
  ```
  (attribute is therefore **not** unconditionally authoritative — the flag is a default).
- **App context required.** Module-level `flask.json.dumps` only touches the provider inside an app context — `src/flask/json/__init__.py:40-44`:
  ```python
      if current_app:
          return current_app.json.dumps(obj, **kwargs)

      kwargs.setdefault("default", _default)
      return _json.dumps(obj, **kwargs)
  ```
  with docstring `json/__init__.py:16-18` ("If :data:`~flask.current_app` is available, it will use its :meth:`app.json.dumps()` … otherwise it will use :func:`json.dumps`."). Executed: `OUTSIDE app ctx (ignores app.json): '"\\u2603"'` vs `INSIDE app ctx (uses app.json): '"\u2603"'` — i.e. outside an app context stdlib's own default `True` applies.

## 3. The behavior in both directions

`ensure_ascii=True` (default) — every non-ASCII character in the serialized **string** is replaced by `\uXXXX` escape sequences, so the returned `str` is pure ASCII. `ensure_ascii=False` — the character is emitted literally, so the returned `str` is real Unicode text.

The framework's own specification of this is the shipped parametrized test, `tests/test_json.py:48-54`:

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

**Executed and passing** in this checkout (venv at `experiments/data/venv`, Linux venv under WSL `openEuler-SP3`, CPython 3.11.6, pytest 8.4.2, Werkzeug 3.1.8, `import flask` → `…/experiments/data/worktree/flask/src`, sha256-identical to `flask-src` — `provider.py` both `cefdd0df…b72c`, `tests/test_json.py` both `f6c73c61…b64c6`):

```
$ ../venv/bin/python -m pytest tests/test_json.py::test_json_as_unicode \
      tests/test_testing.py::test_environbuilder_json_dumps -q -rA
PASSED tests/test_json.py::test_json_as_unicode[True-"\\u2603"]
PASSED tests/test_json.py::test_json_as_unicode[False-"\u2603"]
PASSED tests/test_testing.py::test_environbuilder_json_dumps
3 passed in 0.46s        STATUS=exit0(all-passed)
```

Broader run of both modules: `56 passed in 1.52s`. Whole checkout suite: `1 failed, 475 passed, 6 skipped` — the single failure is `tests/test_reqctx.py::test_bad_environ_raises_bad_request` (`assert 404 == 400`), deterministic on isolated re-run and **unrelated** to JSON.

Concrete before/after pairs, printed as `repr()`/codepoints (never eyeballed, per the GBK-console hazard), stdlib `json.dumps` on the same interpreter:

```
--- snowman U+2603 ---
True  repr      : '"\\u2603"'
True  codepoints: ['0x22', '0x5c', '0x75', '0x32', '0x36', '0x30', '0x33', '0x22']
True  len       : 8  isascii: True
False repr      : '"\u2603"'
False codepoints: ['0x22', '0x2603', '0x22']
False len       : 3  isascii: False
len delta True-False: 5
True  utf8 bytes hex: 225c753236303322
False utf8 bytes hex: 22e2988322
decoded equality (True==False==source): True
--- euro U+20AC (the in-tree test char) ---
True : '"\\u20ac"'      False: '"\u20ac"'      False utf8 bytes hex: 22e282ac22
--- non-BMP / astral U+1F600 ---
True  repr      : '"\\ud83d\\ude00"'   codepoints: ['0x22','0x5c','0x75','0x64','0x38','0x33','0x64','0x5c','0x75','0x64','0x65','0x30','0x30','0x22'] len: 14
False repr      : '"\U0001f600"'       codepoints: ['0x22','0x1f600','0x22'] len: 3
astral decoded equality: True
--- dict keys are affected too ---
True  repr: '{"\\u2603": ["\\u20ac", "\\ud83d\\ude00"]}'
False repr: '{"\u2603": ["\u20ac", "\U0001f600"]}'
False utf8 hex: 7b22e29883223a205b22e282ac222c2022f09f9880225d7d
round-trip equality: True
```

Note the **astral-plane nuance**: with `True` a non-BMP character is escaped as a **surrogate pair** (`"\ud83d\ude00"`, 14 chars), because JSON escapes are `\uXXXX` only; with `False` it stays literal (3 chars). Cross-checked on a second interpreter (Windows CPython 3.14.0): identical reprs, lens 8/3 and 14/3.

Also, the flag does **not** touch the escapes JSON requires regardless: `json.dumps("a\nb\"c\\d\te\u0000", ensure_ascii=False)` → `'"a\\nb\\"c\\\\d\\te\\u0000"'` — byte-identical to the `True` form. And an ASCII-only payload serializes identically either way (`equal: True`).

## 4. Why `False` still produces valid JSON on the wire (UTF-8 encoding)

The literal form is a Python `str`; it becomes bytes only when werkzeug encodes the response. `provider.py:50-57` (`dump`) states the contract: "…``fp``: A file opened for writing text. **Should use the UTF-8 encoding to be valid JSON.**" (same wording at `json/__init__.py:55-56`). `src/flask/app.py:1138-1140` says for a `str` return: "A response object is created with the string encoded to UTF-8 as the body." Installed werkzeug confirms the encode step (`experiments/data/venv/lib/python3.11/site-packages/werkzeug/wrappers/response.py:289-297`): "If a string is set it's encoded to the charset of the response (utf-8 by default) … `value = value.encode()`".

The in-tree test that pins this for the wire is `tests/test_testing.py:110-114`:

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

The `.decode("utf8")` round-trip is precisely the proof that the literal character travelled as **UTF-8 bytes**. Executed end-to-end through the real chain: `input_stream hex: 22e282ac22` → `decode(utf8): '"\u20ac"'` (vs `225c753230616322` → `'"\\u20ac"'` with `True`).

## 5. Every consumption path abuts the same hop

The attribute reaches output through one funnel — `dumps` — and any route that serializes JSON uses it:

| Path | Quote (file:line) |
|---|---|
| base provider `response()` | `return self._app.response_class(self.dumps(obj), mimetype="application/json")` — `provider.py:105` |
| `DefaultJSONProvider.response()` | `return self._app.response_class(f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype)` — `provider.py:213-215`; `dump_args` carries only `indent`/`separators` (`provider.py:206-212`), **not** `ensure_ascii`, so the attribute flows via the `setdefault` |
| `jsonify` | `return current_app.json.response(*args, **kwargs)` — `json/__init__.py:170` |
| dict/list view return | `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)` — `app.py:1230-1231` |
| Jinja `\|tojson` | `rv.policies["json.dumps_function"] = self.json.dumps` — `app.py:422` |
| test client / `EnvironBuilder` | `return self.app.json.dumps(obj, **kwargs)` — `testing.py:94` |

Executed through the live chain (bodies as raw bytes/hex):

```
mimetype: application/json | content_type: application/json
body as text, ensure_ascii=False: '{"k":"\u2603"}\n'
body utf8 hex,  ensure_ascii=False: 7b226b223a22e29883227d0a
body utf8 hex,  ensure_ascii=True : 7b226b223a225c7532363033227d0a
jsonify body utf8 hex (False): 7b226b223a22e29883227d0a   get_json round trip: '\u2603' True
jsonify body utf8 hex (True) : 7b226b223a225c7532363033227d0a   get_json round trip: '\u2603' True
tojson body utf8 hex (False): 22e2988322     tojson body utf8 hex (True): 225c753236303322
dict-return body utf8 hex (False): 7b226b223a22e29883227d0a
dict-return body utf8 hex (True) : 7b226b223a225c7532363033227d0a
```

The tagged-serializer layer inherits the same flag: `json/tag.py:321-323` `def dumps(self, value): … return dumps(self.tag(value), separators=(",", ":"))` — it goes through `flask.json.dumps`, so `ensure_ascii` applies there too.

## 6. The relationship, stated plainly

1. **The parameter** is the boolean `DefaultJSONProvider.ensure_ascii`, default `True` (`provider.py:144`), exposed as `app.json.ensure_ascii` (`sansio/app.py:230,329`); historically the `JSON_AS_ASCII` config key (`CHANGES.rst:285-288`, removed per `CHANGES.rst:153-154` / `docs/config.rst:441-443`).
2. **It is a default, not a gate**: `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` (`provider.py:177`) into stdlib `json.dumps` (`provider.py:179`), so an explicit per-call kwarg overrides the attribute; and with no app context, `flask.json.dumps` bypasses the provider entirely (`json/__init__.py:40-44`).
3. **`True` ⇒ escaping**: every non-ASCII character in the serialized output string is replaced by `\uXXXX` escape sequences (surrogate pairs for non-BMP, e.g. `"\ud83d\ude00"` for U+1F600), yielding a **pure-ASCII** output string — a superset-compatible representation most clients can read. `☃` → `'"\\u2603"'` (len 8, `isascii: True`).
4. **`False` ⇒ literal**: the character is preserved as real Unicode text in the output string — `☃` → `'"\u2603"'` (len 3, `isascii: False`) — and the response/request body then carries those characters as **UTF-8 bytes** (`test_environbuilder_json_dumps`; `provider.py:50-57` "Should use the UTF-8 encoding to be valid JSON"; `app.py:1138-1140`).
5. **Semantics are unchanged; only bytes change.** Both forms decode to the identical Python value — `decoded equality (True==False==source): True`, astral `astral decoded equality: True`, `round-trip equality: True` — and the flag does not affect JSON's mandatory escapes (`"`, `\`, control chars), which are identical under either setting.
6. **Documented trade-off** (`provider.py:145-147`): the escaped form "may be more compatible with some clients, but can be disabled for better performance and size." Measured on this checkout's interpreter (these are *not* in-tree benchmarks — the doc's claim is documentation; the only in-tree numbers are the escaping examples): CJK payload len 12009 vs 2009 chars, 12009 vs 6009 UTF-8 bytes, and 1.417× slower for `True`; response body bytes 2895 vs 1455 for a CJK payload (`body bytes True is pure ASCII: True | False is pure ASCII: False`, `bodies parse to equal values: True`). On all-ASCII payloads both are byte-identical (6009 vs 6009) and the flag is a no-op.

**One-line relationship:** `ensure_ascii` selects the *representation strategy* for non-ASCII characters in the serialized text — `True` escapes them (`\uXXXX`, ASCII-only output, larger and slightly slower), `False` emits them literally (true Unicode text, carried as UTF-8 bytes) — while the decoded JSON value is identical either way.

**Verification hygiene / caveats:** (i) all claims are pinned to this tree at `85c5d93` / `3.2.0.dev` — the `compact` provider attribute (`provider.py:159`) does not exist in released 3.1.x, so don't generalize; (ii) the behaviour of escaping itself is defined by the stdlib CPython `json` the provider calls (`provider.py:179`), not by anything in the checkout — the tree only bounds it by example (snowman, euro) and by the two shipped tests; (iii) runs left the checkout clean (`git status --short --untracked-files=all` empty); only gitignored `.pytest_cache` was rewritten.
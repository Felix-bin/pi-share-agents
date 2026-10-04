# Final Answer

**The relationship, in one line:** `ensure_ascii` is the per-application switch on Flask's JSON provider that chooses *how* non-ASCII code points are written into the serialized text — with `True` (the default) each non-ASCII character is emitted as an ASCII `\uXXXX` escape sequence, with `False` it is emitted literally as itself in the UTF-8 text — it does **not** change *which* characters are represented, the JSON's validity, or the decoded value. It is a representation switch at the encode boundary, not a content or encoding-correctness switch.

Below is the full evidence and executed results behind that statement, all of it reproduced inline, pinning the question's three unnamed identifiers first.

---

## 0. What the question is actually about (identifiers pinned)

The question names neither the framework nor the parameter, so here is the mapping with file:line anchors, each re-verified by my own reads (not just inherited):

| Question phrase | Concrete identifier | Anchor (verified) |
|---|---|---|
| "the framework" | Flask `3.2.0.dev`, checkout at `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` | `pyproject.toml:2–3`; `.git/HEAD:1` |
| "JSON serialization provider" | `flask.json.provider.DefaultJSONProvider`, instantiated as `app.json` | `src/flask/sansio/app.py:230`, `:329`; `src/flask/json/provider.py:124` |
| "ASCII-only encoding control parameter" | **`DefaultJSONProvider.ensure_ascii`** — *not* the removed legacy `JSON_AS_ASCII` config key, and *not* on the base `JSONProvider` at all | `src/flask/json/provider.py:144`; removal evidence `CHANGES.rst:153`, `docs/config.rst:441` |

**`pyproject.toml` (lines 1–4):**

```toml
[project]
name = "Flask"
version = "3.2.0.dev"
description = "A simple framework for building complex web applications."
```

**`.git/HEAD` (line 1):**

```
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
```

**`src/flask/sansio/app.py:230–238` — the class-level binding:**

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

**`src/flask/sansio/app.py:329` — the instance-level binding created in `App.__init__`:**

```python
        self.json: JSONProvider = self.json_provider_class(self)
```

So "the framework's JSON serialization provider" = `DefaultJSONProvider`, reachable as `app.json`.

**Why the parameter is `ensure_ascii` and not `JSON_AS_ASCII`** — an actual tree-wide grep (executor command **C9**), exit 0:

```
src/flask/json/provider.py:144:    ensure_ascii = True
src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
tests/test_json.py:52:    app.json.ensure_ascii = test_value
tests/test_testing.py:112:    app.json.ensure_ascii = False
```

That is **five** source hits (the `__pycache__` `.pyc` hits that the same command also printed are binary artifacts, not source). Meanwhile `JSON_AS_ASCII` occurs only in changelog/docs, never in code — executor command **C10**, exit 0:

```
./CHANGES.rst:153:    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
./CHANGES.rst:286:    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
./docs/config.rst:419:   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
./docs/config.rst:441:    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
```

and command **C43**, exit 0:

```
NO LEGACY JSON_* CONFIG KEY IN ANY src/**/*.py
```

Confirmation that the attribute exists only on the concrete provider, not on the base class — executor command **C47**, exit 0:

```
type(a.json): <class 'flask.json.provider.DefaultJSONProvider'>
repr(a.json.ensure_ascii): True
hasattr(DefaultJSONProvider, ensure_ascii): True
hasattr(JSONProvider, ensure_ascii): False
DefaultJSONProvider.__mro__: (<class 'flask.json.provider.DefaultJSONProvider'>, <class 'flask.json.provider.JSONProvider'>, <class 'object'>)
```

---

## 1. The parameter and the mechanism that connects it to the output

`src/flask/json/provider.py:124–215` — the full `DefaultJSONProvider`, as I re-read it (this is the entire class):

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

    def loads(self, s: str | bytes, **kwargs: t.Any) -> t.Any:
        """Deserialize data as JSON from a string or bytes.

        :param s: Text or UTF-8 bytes.
        :param kwargs: Passed to :func:`json.loads`.
        """
        return json.loads(s, **kwargs)

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

**Mechanism (`src/flask/json/provider.py:177`, inside `DefaultJSONProvider.dumps`, which starts at `:166`):**

```python
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
```

preceded at `:176` by `kwargs.setdefault("default", self.default)` and followed at `:178` by `kwargs.setdefault("sort_keys", self.sort_keys)`, then `:179` `return json.dumps(obj, **kwargs)`.

Two structural facts that fall out of the source itself:

1. **`ensure_ascii = True` (`:144`) is a plain class attribute on `DefaultJSONProvider`** — not a `ConfigAttribute`, and absent from the base `JSONProvider` (verified: base-class range `19–105` contains no `ensure_ascii`; `src/flask/json/provider.py:19` is `class JSONProvider:` and `:108` is `def _default(o: t.Any) -> t.Any:`). Because it is read through the instance, it is **per-app mutable**: `app.json.ensure_ascii = False` is exactly what both in-tree tests do.
2. **It is injected as a *default only*** via `setdefault`, so an explicit `ensure_ascii=` keyword on a single call wins.

Confirmed empirically both directions — executor command **C50**, exit 0:

```
attr True, call kwarg ensure_ascii=False -> '"☃"'
attr False, call kwarg ensure_ascii=True  -> '"\\u2603"'
```

The base class's `dumps` (`src/flask/json/provider.py:41–47`) merely declares the contract and raises; it passes `**kwargs` through, so a replacement provider is free to ignore `ensure_ascii` entirely:

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON.

        :param obj: The data to serialize.
        :param kwargs: May be passed to the underlying JSON library.
        """
        raise NotImplementedError
```

---

## 2. What it controls: the surface form of non-ASCII code points

`tests/test_json.py:48–54` — the exact `True`/`False` output pair (re-read by me; note the `def` is on line **51**, the decorator occupies 48–50, and the assignment is line 52 as cited):

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

Reading of those literals: the input `"\N{SNOWMAN}"` is U+2603 `☃` (3 UTF-8 bytes `E2 98 83`). For `ensure_ascii = True` the expected output is the JSON string `"\u2603"` — quote, literal backslash-u-2-6-0-3, quote (8 characters, all ASCII). For `ensure_ascii = False` the expected output is the JSON string `"☃"` — quote, the real snowman character, quote (3 characters).

The executor did not take this on faith: command **C51** parsed the parametrize literals out of the test source with `ast` and then re-dumped through the provider — exit 0:

```
source line: '    "test_value,expected", [(True, \'"\\\\u2603"\'), (False, \'"\\u2603"\')]'
parsed parametrize values: [(True, '"\\u2603"'), (False, '"☃"')]
ensure_ascii= True got '"\\u2603"' expected '"\\u2603"' MATCH True
ensure_ascii= False got '"☃"' expected '"☃"' MATCH True
```

The plan's stdlib one-liner was actually run — command **C46**, exit 0:

```
'"\\u2603"' '"☃"'
```

(i.e. `json.dumps('\u2603')` → `"\u2603"` escaped, `json.dumps('\u2603', ensure_ascii=False)` → `"☃"` literal; expected output matched exactly.)

The docstring at `src/flask/json/provider.py:145–147` states the intent in words:

```python
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

**Caveat on that docstring:** "better performance and size" is documentation, not a measurement. No benchmark of it exists in the tree and none was run; the executor explicitly did **not** verify it and I do not restate it as an empirical result. (The only size datum produced was for the single snowman input, in command C49 below — not a framework benchmark.)

---

## 3. What it does *not* control

The relationship is purely about *written form*. Both settings represent the same Unicode value; both outputs are valid JSON; both are `str`; both round-trip to the same Python string. Executor command **C49**, exit 0, measured exactly this for the one input `☃`:

```
types: str str
loads(s1)==loads(s2)==SNOWMAN: True
utf8 byte lengths: 8 5
char codepoints s1: ['0x22', '0x5c', '0x75', '0x32', '0x36', '0x30', '0x33', '0x22']
char codepoints s2: ['0x22', '0x2603', '0x22']
```

Read plainly: the `True` output is a 8-byte ASCII string whose characters are `" \ u 2 6 0 3 "`; the `False` output is a 5-byte UTF-8 string whose three characters are `"`, U+2603, `"`. Same represented value, same `json.loads` result, same type. The attribute does **not** alter decoding (`loads` never consults it — `DefaultJSONProvider.loads` at `:181–187` is just `return json.loads(s, **kwargs)`), does not affect JSON validity, and cannot change which code points are represented — only the escape-vs-literal spelling at the encode boundary.

A distinct, *additional* escaping layer exists on the Jinja path and must not be conflated with `ensure_ascii`: `tests/test_json.py:210–221` shows `|tojson` escaping `<`/`>` as `\u003c`/`\u003e` regardless (executor command **C45**, exit 0):

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

---

## 4. Scope: which output paths the attribute governs, and which it does not

### 4a. It governs every path routed through the provider

- **Module-level `flask.json.dumps` *when an app context is active*** — `src/flask/json/__init__.py:40–44` (re-read; the fallback `setdefault` is at line **43**, the `_json.dumps` call at **44**):

```python
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```

- **`jsonify`** — `src/flask/json/__init__.py:170` (last line of the file): `return current_app.json.response(*args, **kwargs)  # type: ignore[return-value]`
- **Dict/list view returns** — `src/flask/app.py:1229–1231`:

```python
            elif isinstance(rv, (dict, list)):
                rv = self.json.response(rv)
```

- **Jinja `tojson` policy** — `src/flask/app.py:422`: `rv.policies["json.dumps_function"] = self.json.dumps`
- **Test client / `EnvironBuilder`** — `src/flask/testing.py:88–94`:

```python
    def json_dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize ``obj`` to a JSON-formatted string.

        The serialization will be configured according to the config associated
        with this EnvironBuilder's ``app``.
        """
        return self.app.json.dumps(obj, **kwargs)
```

The second in-tree test ties the per-app override to the test client — `tests/test_testing.py:110–114` (re-read; `def` at 110, assignment at **112**):

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

Here the input is U+20AC `€` (3 UTF-8 bytes `E2 82 AC`); with the override the request body carries the literal euro character, whereas the default `True` would have emitted `"\u20ac"`. The `app` fixture is function-scoped (`tests/conftest.py:44–52`, plain `def app()` with no scope argument), so these mutations do not leak between tests.

Executed confirmation across five provider-routed paths with `ensure_ascii = False` — command **C54**, exit 0:

```
ensure_ascii=False
  view dict     : '{"s":"☃"}\n'
  jsonify       : '{"s":"☃"}\n'
  tojson filter : '{"s": "☃"}'
  json.response : '"☃"\n'
  EnvironBuilder: '"€"'
```

and with the default `True` — command **C55**, exit 0:

```
ensure_ascii=True (default)
  view dict     : '{"s":"\\u2603"}\n'
  jsonify       : '{"s":"\\u2603"}\n'
  tojson filter : '{"s": "\\u2603"}'
  json.response : '"\\u2603"\n'
  EnvironBuilder: '"\\u20ac"'
```

### 4b. It is per-application, not global

Command **C53**, exit 0:

```
app a (mutated)  : '"☃"'
app b (untouched): '"\\u2603"'
class attribute still: True
two providers are distinct objects: True
```

### 4c. The one boundary: module-level `flask.json.dumps()` with **no** app context

On that branch (`src/flask/json/__init__.py:43–44`) only `default` is set; `ensure_ascii` is never injected, so stdlib's own default applies and a per-app override is not honored. Executed — command **C52**, exit 0:

```
in app ctx (provider path)   : '"☃"'
no app ctx (module fallback) : '"\\u2603"'
no app ctx, explicit kwarg   : '"☃"'
```

So: the attribute is the authoritative control *for everything that goes through the provider* (all request/response JSON, `jsonify`, dict/list view returns, Jinja `tojson`, the test client) and is bypassed on the no-app-context fallback path. The adjacent session tag serializer inherits that same asymmetry, since `src/flask/json/tag.py:56–57` imports the module-level `from ..json import dumps` / `loads` and `tag.py:320–322` adds only `separators`, never `ensure_ascii`:

```python
    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))
```

---

## 5. Lineage: `ensure_ascii` replaced the removed `JSON_AS_ASCII` config key

`CHANGES.rst:151–154` (command **C37**, exit 0):

```
        ``propagate_exceptions``, and ``templates_auto_reload`` properties on ``app``
        are removed.
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

`CHANGES.rst:284–287` (command **C38**, exit 0) — the 2.2 move from config keys to provider attributes:

```
-   JSON configuration is moved to attributes on the default
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

`docs/config.rst:440–443` (command **C39**, exit 0):

```
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

The original 0.10 introduction of the option describes the same tradeoff the modern docstring describes — `CHANGES.rst:1192–1195` (command **C40**, exit 0, third hit):

```
-   Added an option to generate non-ascii encoded JSON which should
    result in less bytes being transmitted over the network. It's
    disabled by default to not cause confusion with existing libraries
    that might expect ``flask.json.dumps`` to return bytes by default.
```

And the removal is real in code, not just docs: `src/flask/app.py:178–209`'s `default_config` `ImmutableDict` contains no `JSON_*` key at all (commands **C41**/**C42**, exit 0; C41 printed `NO JSON_* KEY ANYWHERE IN src/flask/app.py`).

A custom provider may ignore `ensure_ascii` entirely — the base class's `dumps` only documents `**kwargs` pass-through and raises `NotImplementedError` (Section 1), and `tests/test_json.py:227–257` demonstrates wholesale substitution with `app.json = CustomProvider(app)`.

---

## 6. Verification status and honesty notes

- The relevant suite and the complete suite were both run twice, green: command **C56** → `56 passed in 0.22s` (`tests/test_json.py tests/test_testing.py`), command **C57** (`-vvv -rA --showlocals --tb=long`, same two files) → `56 passed in 0.23s` with `test_json_as_unicode[True-"\\u2603"] PASSED`, `test_json_as_unicode[False-"\u2603"] PASSED` and `test_environbuilder_json_dumps PASSED`; command **C58** → `489 passed in 2.13s` for all of `tests/`; command **C59** → same 489 passed, full 1452-line verbose log to `/tmp/flask_full_verbose.log`, exit 0. Environment: repo venv `.venv/Scripts/python.exe` = Python 3.13.9, flask 3.2.0.dev0 imported from this checkout, pytest 8.4.0, werkzeug 3.1.3, jinja2 3.1.6.
- Worktree untouched: command **C64** → `git status --porcelain | wc -l` = `0`; `git rev-parse HEAD` agrees with `.git/HEAD` (command **C63**).
- **Corrected line numbers.** The upstream retriever evidence carried several off-by-a-few anchors; the executor's commands and my own re-reads agree on these corrected values, and I cite the corrected ones above: `provider.py` is **215** lines (not 227); `def _default` is at **108** (not 116); `DefaultJSONProvider.response`'s `_prepare_response_obj(args, kwargs)` is at **205** and the `f"{self.dumps(obj, **dump_args)}\n"` line at **214** (not 207/217); the `flask.json.dumps` no-context fallback is at `json/__init__.py:43–44` (not 39–41) with `jsonify`'s provider call at **170**; `test_json_as_unicode`'s `def` is at `tests/test_json.py:51` (not 49). Substance is unaffected in every case.
- **Also corrected:** the retriever's grep claim of six `ensure_ascii` source hits is wrong — there are **five** (`provider.py:144`, `:171`, `:177`; `tests/test_json.py:52`; `tests/test_testing.py:112`). Its sixth line, `provider.py:145`, matches `non-ASCII`, not `ensure_ascii`.
- **Not verified, and not claimed:** any performance or size improvement from `ensure_ascii = False`. The docstring asserts it; no measurement exists in the tree and none was run.

**Bottom line:** `DefaultJSONProvider.ensure_ascii` (`src/flask/json/provider.py:144`, default `True`) is Flask 3.2's successor to the removed `JSON_AS_ASCII` key. Injected into `json.dumps` as a default at `provider.py:177`, it decides only whether each non-ASCII code point is written as an ASCII `\uXXXX` escape (`True` → `"\u2603"`, `"\u20ac"`) or as the literal character in UTF-8 (`False` → `"☃"`, `"€"`). The represented Unicode values are identical and both forms decode to the same string; the switch is per-application, mutable on `app.json`, honored by every provider-routed output path, bypassed by the no-app-context `flask.json.dumps()` fallback, and overridable per call by an explicit `ensure_ascii=` keyword.
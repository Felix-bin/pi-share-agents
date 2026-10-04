## Relationship

The parameter is **`DefaultJSONProvider.ensure_ascii`** — the `ensure_ascii` class attribute on the framework's default JSON serialization provider, declared `ensure_ascii = True` at `src/flask/json/provider.py:144` on `DefaultJSONProvider` (class at `provider.py:124`). It is the only ASCII-related control for JSON in the source tree: a case-insensitive grep for `ascii` under `src/` returns, for serialization, only `provider.py:144,145,171,177` (the other hits are `helpers.py:480` filename encoding and `json/tag.py:167` base64 decoding), and a worktree-wide grep for `ensure_ascii` returns only `provider.py` plus two test files. There is no second provider or parallel code path that sets it.

**What it controls.** It is passed straight into the stdlib serializer as a default, not as a reimplementation:

```
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```
(`provider.py:176-179`, inside `dumps`, `provider.py:166-179`, returning `str`.)

So the relationship is: this one boolean decides whether every non-ASCII code point in the serialized data is emitted as a `\uXXXX` escape (ASCII bytes on the wire) or as the literal character.

- **`True` (the default, `provider.py:144`).** Non-ASCII characters are replaced by escape sequences — the provider's own docstring says exactly this: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* (`provider.py:145-147`). The output text is pure ASCII, and it decodes back to the identical Unicode character. Pinned by `tests/test_json.py:48-54`: with `app.json.ensure_ascii = True`, `app.json.dumps("\N{SNOWMAN}")` must equal `'"\\u2603"'` — six ASCII characters, not a snowman.
- **`False`.** The same characters are emitted literally. In the same test the expectation becomes `'"\u2603"'`, i.e. the actual U+2603 character inside the returned `str` (`tests/test_json.py:49,53`). Through the HTTP path this means UTF-8 bytes in the body: `tests/test_testing.py:111-114` sets `app.json.ensure_ascii = False` and asserts `eb.input_stream.read().decode("utf8") == '"\u20ac"'` — a literal euro sign, not `\u20ac`.

**Reach.** Because `response()` builds the body by calling `self.dumps(...)` (`provider.py:189-215`, body constructed at `provider.py:213-214`), and `jsonify` is `current_app.json.response(...)` (`src/flask/json/__init__.py:170`), and the app's provider is `DefaultJSONProvider` (`src/flask/sansio/app.py:230`, instantiated as `self.json = self.json_provider_class(self)` at `sansio/app.py:329`), the attribute governs both direct `dumps` calls and JSON sent over HTTP by `jsonify`.

**Precedence, and where the control fails to apply.** The attribute is only a *default*: `setdefault` (`provider.py:177`) means an explicit per-call `ensure_ascii=` kwarg to `app.json.dumps` / `json.dumps` wins over it. As an instance attribute it is also the supported override point — both tests set it via `app.json.ensure_ascii = ...` (`test_json.py:52`, `test_testing.py:112`) rather than through config. The boundary is the module-level helper: `flask.json.dumps` delegates to `current_app.json.dumps` only when an app context exists, otherwise it builds its own kwargs and calls stdlib `_json.dumps` (`src/flask/json/__init__.py:44-46`), so outside an app context the provider attribute is not consulted at all and the stdlib's own default applies (not pinned anywhere in this worktree).

**Historical mapping (not a live control).** The former `JSON_AS_ASCII` config key is gone in this version: `CHANGES.rst:153-154` and `CHANGES.rst:286-288` record its removal/deprecation, and `docs/config.rst:441-443` states that it and its siblings "were removed. The default `app.json` provider has equivalent attributes instead." It is reported only as the old name for the same relationship — `JSON_AS_ASCII=True/False` mapping onto this attribute — not as something that can be set today. A grep for `ensure_ascii` in `docs/` and `CHANGES.rst` finds no prose describing the attribute, so its documentation is the docstring at `provider.py:145-147`.

## What this rests on
- `src/flask/json/provider.py:144` (`ensure_ascii = True`), `:145-147` (docstring), `:166-179` (`dumps` + `setdefault`), `:189-215` (`response`), read directly.
- `tests/test_json.py:48-54` and `tests/test_testing.py:111-114`, read directly.
- `src/flask/json/__init__.py:13,44-46,170`; `src/flask/sansio/app.py:230,329`; `CHANGES.rst:153-154,286-288`; `docs/config.rst:441-443`; plus the `ascii`/`ensure_ascii` greps from the retriever stage.

## Still open
- Whether escaping also applies to **dict keys** is the retriever's explicit inference from stdlib `json` behavior, consistent with the tests but not asserted anywhere in this worktree.
- The docstring's "better performance and size" claim for `False` is stdlib behavior and is not verified by anything in this worktree.
- No stage edited any file and the executor stage was skipped, so nothing here reports a code, docstring or docs change — only the current relationship as written in the source.
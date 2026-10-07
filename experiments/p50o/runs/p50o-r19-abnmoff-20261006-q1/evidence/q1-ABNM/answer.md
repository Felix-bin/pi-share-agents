## Answer

The control parameter is **`DefaultJSONProvider.ensure_ascii`**, and its relationship to Unicode representation is a *forwarding* relationship: the attribute supplies the **default value of the stdlib `json.dumps(ensure_ascii=...)` argument**, and the stdlib encoder — not the framework — decides whether non-ASCII code points appear literally or as `\uXXXX` escapes in the serialized text.

**The parameter and its default.** `ensure_ascii = True` is a plain class attribute on `DefaultJSONProvider` (`src/flask/json/provider.py:144`), documented immediately below at `:145-148`: *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."* It is the only such control in the provider; it carries no type annotation and is a class-level default, so assigning `app.json.ensure_ascii = False` shadows it on the provider instance.

**The mechanism.** `DefaultJSONProvider.dumps` (`src/flask/json/provider.py:166`) builds the keyword defaults and delegates:

- `src/flask/json/provider.py:177` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)`
- `src/flask/json/provider.py:179` — `return json.dumps(obj, **kwargs)`

The `setdefault` is the crux of the relationship: when the caller passes no `ensure_ascii`, the provider attribute becomes the encoder's `ensure_ascii` argument; when the caller passes one explicitly (e.g. `app.json.dumps(obj, ensure_ascii=False)`), the caller's value wins and the attribute is bypassed for that call. The framework performs no escaping itself — the actual replacement of code points with escape sequences happens inside `json.dumps`, exactly as the `dumps` docstring states (`:169-171`: defaults are set "from the :attr:`default`, :attr:`ensure_ascii`, and :attr:`sort_keys` attributes").

**The observable effect on both settings**, fixed by the parametrized test at `tests/test_json.py:48-54` (`test_json_as_unicode`), which serializes `"\N{SNOWMAN}"` (U+2603):

| `app.json.ensure_ascii` | Serialized output | Unicode representation |
|---|---|---|
| `True` (default) | `"\u2603"` — quote, backslash, `u2603`, quote (`tests/test_json.py:49`) | code point replaced by a `\uXXXX` escape sequence; the whole output is 7-bit ASCII |
| `False` | the literal snowman character U+2603 between quotes (`tests/test_json.py:49`) | code point emitted as-is |

The same literal-output path is corroborated independently through a second entry point: with `app.json.ensure_ascii = False`, `EnvironBuilder(app, json="\u20ac")` streams the literal euro sign U+20AC (`tests/test_testing.py:112-114`).

Because the default is `True`, out-of-the-box serialization is ASCII-only, and non-ASCII text is escaped rather than emitted as characters; setting the attribute to `False` switches every affected call site to literal Unicode output. The compatibility-versus-size/performance trade-off in each direction is the attribute docstring's own claim (`src/flask/json/provider.py:145-148`) — it is a documented rationale, not an independently measured benchmark.

**Where the attribute takes effect, and where it does not.** It applies wherever `JSONProvider.dumps` runs: `flask.json.dumps` inside an app context (`src/flask/json/__init__.py:41` — `current_app.json.dumps(obj, **kwargs)`), the provider's own response/`jsonify`-style paths (`src/flask/json/provider.py:105` and `:214`), and the Jinja `json.dumps_function` policy, which is bound to the same method (`src/flask/app.py:422`). Outside an app context, `flask.json.dumps` falls back to the stdlib encoder with only `default` set (`src/flask/json/__init__.py:43-44`), so the provider attribute is not consulted there and the stdlib's own `ensure_ascii` default governs.

## What this rests on

- Declaration/default: `src/flask/json/provider.py:144`, docstring `:145-148`.
- Wiring: `src/flask/json/provider.py:166` (`dumps`), `:177` (`setdefault`), `:179` (`json.dumps`); docstring `:169-171`.
- Behavior for both settings: `tests/test_json.py:48-54`; corroboration `tests/test_testing.py:112-114`.
- Effective default provider: `src/flask/sansio/app.py:230` (`json_provider_class = DefaultJSONProvider`) and `:329` (`self.json = self.json_provider_class(self)`), so the attribute describes the effective default behavior. A worktree-wide grep for `ensure_ascii` returns only the declaration, its two wiring/docstring lines, and the two tests — no subclass overrides it — so the risk of an overriding custom provider does not apply here.
- Alternative reading was checked and rejected: the legacy config key `JSON_AS_ASCII` survives only as removed/deprecated text in `CHANGES.rst:153`, `:286` and `docs/config.rst:419`, `:441`; no code reads it, and `ensure_ascii` appears nowhere under `docs/`.
- One citation in the collected evidence was off by one: the delegation `return json.dumps(obj, **kwargs)` is at `src/flask/json/provider.py:179`, not `:178` (verified against the file). This does not change the conclusion.

## Still open / not established

- Whether the default should change, whether `docs/config.rst` should be updated, or any code/test edit — out of scope: the task asks only for the relationship, so nothing is handed to `executor`.
- The "more compatible with some clients / better performance and size" framing is the docstring's claim (`:145-148`); no measurement in the worktree verifies the size or speed delta.
- No contradiction between sources was encountered; the only discrepancy is the line-number slip noted above.
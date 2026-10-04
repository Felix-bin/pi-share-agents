# The control parameter is a representation switch, not a value switch

The ASCII-only encoding control is `DefaultJSONProvider.ensure_ascii` (`src/flask/json/provider.py:144`, default `True`). Its relationship to Unicode representation in serialized output is a **direct pass-through to the standard library's own `ensure_ascii` argument**, and its effect is purely on *how* non-ASCII characters are written, never on *what* the JSON means:

- `ensure_ascii = True` (the default) writes non-ASCII characters as `\uXXXX` escape sequences, so the serialized text is pure ASCII: `"\N{SNOWMAN}"` → `'"\\u2603"'`.
- `ensure_ascii = False` writes the literal character, producing genuinely non-ASCII UTF-8 bytes: → `'"☃"'`, sent as `b'"\xe2\x98\x83"\n'`.

Both forms round-trip through `flask.json.loads` to the identical Python value (`'☃'`). The parameter therefore governs wire representation only; it is not a correctness or data-loss setting.

## 1. The mechanism: attribute → `json.dumps` kwarg

`DefaultJSONProvider.dumps` forwards the attribute verbatim (`src/flask/json/provider.py:166-179`):

```python
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```

Read directly at `provider.py:144-147, 166-179`. Because it is `setdefault`, an explicit per-call `ensure_ascii=` keyword overrides the attribute — precedence was confirmed by execution in both directions (`attr=False, kwarg=True` → escaped; `attr=True, kwarg=False` → literal).

`response()` builds `dump_args` and calls `self.dumps(...)`, then appends `"\n"` (`provider.py:208-214`), so the attribute also governs HTTP JSON bodies, not just direct `dumps` calls. Executor measurement confirms the trailing newline in both byte forms.

## 2. Observed behavior (executed, this worktree)

The executor ran the interpreter with `PYTHONPATH` pinned to this worktree's `src/` (the pre-existing `.venv` `.pth` points at a different worktree; the two worktrees' `provider.py` and `json/__init__.py` were `cmp`-identical, so the pin removed the ambiguity without changing the result):

| Setting | `dumps` output | `response()` bytes |
|---|---|---|
| `True` (default) | `'"\\u2603"'` | `b'"\\u2603"\n'` — literal backslash-u |
| `False` | `'"☃"'` | `b'"\xe2\x98\x83"\n'` — raw UTF-8 snowman |

All four assertions held. The two tests that assert this behavior in-tree also pass: `tests/test_json.py::test_json_as_unicode` (parametrized `(True, '"\\u2603"'), (False, '"\u2603"')`, setting `app.json.ensure_ascii`, `tests/test_json.py:48-54`) and `tests/test_testing.py::test_environbuilder_json_dumps` (`ensure_ascii = False` with a euro sign yields literal UTF-8, `tests/test_testing.py:110-114`) — `3 passed`. I re-read both code sites; the cited constants match.

## 3. How far the setting reaches

`app.json` is a `DefaultJSONProvider` by default (`src/flask/sansio/app.py:230, 329`), so `app.json.ensure_ascii = False` is the live switch. The setting propagates through:

- `DefaultJSONProvider.dumps` and `response()` — **observed** (executor).
- `flask.json.dumps` / `flask.json.dump` *inside an app context*, which delegate to `current_app.json` (`src/flask/json/__init__.py:40-44, 62-66`); outside a context they fall back to stdlib `json.dumps`, whose own default is `ensure_ascii=True` — **code-cited, not executed** for the fallback branch.
- `EnvironBuilder.json_dumps` (`src/flask/testing.py:88-94`) — inherits the provider setting; exercised only through the cited in-tree test, not independently run.
- The tag / `tojson` path (`src/flask/json/tag.py:321-323`) routes through the module `dumps` and thus inherits the attribute when an app context is present — **code-cited, not executed**.

Custom `JSONProvider` subclasses replacing the default were not inspected; nothing else under `src/flask` implements a JSON provider.

## 4. The old config key no longer exists

The "control parameter" is no longer a config key. `docs/config.rst:440-443` records: *"`JSON_AS_ASCII`, `JSON_SORT_KEYS`, `JSONIFY_MIMETYPE`, and `JSONIFY_PRETTYPRINT_REGULAR` were removed. The default `app.json` provider has equivalent attributes instead."* `CHANGES.rst:285-288` (2.2, deprecation + move to provider attributes) and `CHANGES.rst:153-154` (2.3, removal) agree, and a grep of `src/flask` for `JSON_AS_ASCII` returns nothing. So the attribute is the sole surviving control.

## 5. Why the default is `True`

The docstring at `provider.py:145-147` states the trade-off in prose: escaping "may be more compatible with some clients, but can be disabled for better performance and size." This is documentation wording, not a measured benchmark — no size or throughput comparison was run here. The only evidence connecting the default to prior behavior is the docs/CHANGES record that the provider attribute replaced the config key; that the old key's default was also ASCII-escaping is inferred, not independently observed.

---

## What this rests on

- `src/flask/json/provider.py:144-147, 166-179, 208-214` (read directly): attribute default, docstring, `setdefault` pass-through, `response()` routing.
- Executor runtime run against this worktree's `src/` (PYTHONPATH-pinned): escape vs literal output, `response()` UTF-8 bytes, per-call kwarg precedence, value round-trip equality; recorded in shared memory `cb35ce04d506`. I recorded the synthesized conclusion as `89a069e8f802`.
- `tests/test_json.py:48-54`, `tests/test_testing.py:110-114` (read directly; both pass).
- `src/flask/sansio/app.py:230, 329`; `src/flask/json/__init__.py:40-44, 62-66`; `src/flask/testing.py:88-94`; `src/flask/json/tag.py:321-323` (code-cited reach, from the retriever's evidence).
- `docs/config.rst:440-443` (read directly), `CHANGES.rst:153-154, 285-288`; grep for `JSON_AS_ASCII` in `src/flask` (no hits).

## What remains open

- The module-level `flask.json.dumps` fallback outside an app context, custom provider subclasses, and the `tojson`/tag path were not executed — their inheritance of `ensure_ascii` is code-read, not observed.
- The `EnvironBuilder.json_dumps` path (euro-sign case) is evidenced only by the in-tree test, not by an independent run.
- No measurement of the "performance and size" claim in the docstring; it is documentation prose.
- No contradiction was found between the retriever's code citations and the executor's measurements; the only discrepancy noted was the executor's own earlier `SyntaxError` from an escaped `\u` in a throwaway script, corrected before any measurement, and the `.venv` pointing at a different worktree — neutralized by `PYTHONPATH` pinning plus byte-identical source comparison.
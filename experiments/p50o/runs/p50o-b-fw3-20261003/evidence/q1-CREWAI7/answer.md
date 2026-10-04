## Answer

**The control parameter is `DefaultJSONProvider.ensure_ascii`, and its default is `True`.**

```
src/flask/json/provider.py:144   ensure_ascii = True
src/flask/json/provider.py:145-147   """Replace non-ASCII characters with escape sequences. This may be
                                     more compatible with some clients, but can be disabled for better
                                     performance and size."""
```

**The mechanism is a single `setdefault` in `DefaultJSONProvider.dumps` that forwards the attribute into the stdlib `json.dumps` call:**

```
src/flask/json/provider.py:176-179
    kwargs.setdefault("default", self.default)
    kwargs.setdefault("ensure_ascii", self.ensure_ascii)
    kwargs.setdefault("sort_keys", self.sort_keys)
    return json.dumps(obj, **kwargs)
```

`ensure_ascii` is Flask's per-provider setting, applied through `app.json.ensure_ascii` (the provider instance), and it lands in `json.dumps(ensure_ascii=...)` unchanged (line `:177` → `:179`). Because it is `setdefault`, a caller-supplied `ensure_ascii=` kwarg overrides the attribute. There is no config-key path: `grep JSON_AS_ASCII` over the whole worktree returns **no hits** — the sole Flask-owned control for this behaviour is the attribute.

**The relationship to Unicode representation, with the observable output forms:**

| `app.json.ensure_ascii` | `app.json.dumps("\N{SNOWMAN}")` returns | Meaning in the serialized `str` |
|---|---|---|
| `True` (default) | `'"\\u2603"'` | every non-ASCII code point is emitted as a `\uXXXX` **escape sequence** — ASCII-only output |
| `False` | `'"\u2603"'` | the code point is emitted **literally** as the Unicode character; encoded as UTF-8 on the wire |

The in-tree behavioural proof is a passing parametrized test:

```
tests/test_json.py:48-54
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

**Verification status of the output forms:** established as a *passing test assertion plus source read*, and now also as an executed test run. `.venv\Scripts\python.exe -m pytest tests/test_json.py::test_json_as_unicode -v` exited **0** with both cases passing (`[True-"\\u2603"] PASSED`, `[False-"\u2603"] PASSED`, `2 passed in 0.04s`), and both cases plus `tests/test_testing.py::test_environbuilder_json_dumps` passed together (`3 passed in 0.05s`, exit 0), against the worktree copy of Flask (the direct probe that ran reported `flask.__file__ = ...\src\flask\__init__.py`, not a `.venv` install). **Not** established as raw interpreter stdout: the one direct `dumps` probe aborted at `DefaultJSONProvider(None)` with `TypeError: cannot create weak reference to 'NoneType' object` (exit 1), so the two forms rest on the passing assertions and the source read rather than a captured `repr()` of `dumps` output. The system interpreter never collected a test (`No module named pytest`, exit 1).

**Independent corroboration on a second output path** (`ensure_ascii=False` → literal Unicode → UTF-8 bytes):

```
tests/test_testing.py:110-114
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```
This passes in the executed run above; it shows the euro sign (U+20AC) emitted literally and decoding as UTF-8.

**Trade-off, as the docstring itself asserts:** `True` "may be more compatible with some clients", while `False` "can be disabled for better performance and size" — i.e. the default buys client compatibility at the cost of larger output and extra escaping work.

**Scope of the claim:** the snowman assertion calls `app.json.dumps` directly, so it is a `dumps`-level proof. For the `response()` path, `src/flask/json/provider.py:208-211` shows the `compact`/debug branch sets only `indent` or `separators`, never `ensure_ascii`, and `response()` calls the same `self.dumps(obj, **dump_args)` at `:214`. Extending the escape behaviour to `response()` output is therefore an **inference from the code path, not a test assertion** — no in-tree test asserts `ensure_ascii` through `response()`.

## What this rests on

- `src/flask/json/provider.py:144–148` — attribute name, `True` default, docstring trade-off (re-read and verified this session).
- `src/flask/json/provider.py:176–179` — `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` forwarded to `json.dumps` (re-read and verified this session).
- `tests/test_json.py:48–54` — verbatim snowman parametrization and assertion (re-read and verified this session).
- `tests/test_testing.py:110–114` — second behavioural use, UTF-8 euro output.
- Grep `ensure_ascii` over the worktree: 7 hits. Of these only three are Flask-owned (`provider.py:144`, `:171`, `:177`); two are tests (`tests/test_json.py:52`, `tests/test_testing.py:112`); two are third-party under `.venv` (`itsdangerous/_json.py:16` defaults to `False` — unrelated; `_pytest/cacheprovider.py:191`). Grep `JSON_AS_ASCII`: no hits anywhere, which rules out the alternative reading of the task's control parameter.
- Executed runs: `2 passed` / `3 passed`, exit 0, under `.venv\Scripts\python.exe`; `flask.__file__` confirmed as `src\flask\__init__.py`. The system-interpreter run (exit 1, no pytest) and the aborted direct probe (exit 1) are recorded as non-results, not evidence.
- `src/flask/json/provider.py:189–215` — `response()` path, whitespace-only kwargs, same `dumps` call.

## What remains open

- **Raw interpreter output for `dumps` was never captured** — the only direct probe failed at `DefaultJSONProvider(None)`; the output forms are test-asserted, not stdout-observed.
- **`response()`-level `ensure_ascii` behaviour is unsourced by any test** — it follows from the `:208–211` / `:214` code path by inference only.
- **Nothing was checked in `config.py`, `docs/`, or `CHANGES.rst`** — whether the default should change, be per-app configurable, or be documented as a behavioural change is explicitly outside this task's scope; that decision is the main agent's.
- **Shared-memory tooling was unavailable** in this session (`synapse_read`/`synapse_write` not exposed), so no conclusion was persisted or reconciled against a prior record; if a stored conclusion on this topic exists, it was not consulted here.
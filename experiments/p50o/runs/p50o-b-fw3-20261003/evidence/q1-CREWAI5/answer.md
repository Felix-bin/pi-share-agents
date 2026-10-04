## Answer

**The relationship is a direct, one-to-one delegation.** `ensure_ascii` is a boolean class attribute on `DefaultJSONProvider` — Flask's default JSON serialization provider — that Flask forwards, unaltered, as the `ensure_ascii` keyword argument of the stdlib `json.dumps` call it makes for every serialization. Flask does not implement the ASCII transformation; it selects the stdlib's behaviour with a bool.

**The provider and the parameter.**

`DefaultJSONProvider` is the class `app.json` is built from: `src/flask/sansio/app.py:230` sets `json_provider_class: type[JSONProvider] = DefaultJSONProvider` and `sansio/app.py:329` does `self.json: JSONProvider = self.json_provider_class(self)`. The abstract base `JSONProvider` carries no `ensure_ascii` attribute at all (it declares `dumps`/`loads` as `NotImplementedError` at `provider.py:41–47` and `59–65`), so the knob exists only on `DefaultJSONProvider`. A whole-worktree `grep` for `ensure_ascii` returns Flask hits at exactly `src/flask/json/provider.py:144`, `:171`, `:177`, `tests/test_json.py:52`, `tests/test_testing.py:112` — there is no second provider or docs page carrying it in this checkout (the other hits are third-party: `itsdangerous/_json.py:16`, `_pytest/cacheprovider.py:191`).

**The control parameter and its default.** `src/flask/json/provider.py:144–148`:

```
    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """
```

So the default is `True` — pure-ASCII output — with the docstring stating the trade-off explicitly: better client compatibility versus performance/size. Runtime confirms `app.json.ensure_ascii` reads back `True` on a fresh app.

**The forwarding path.** The attribute is injected into every `json.dumps` call in `dumps`, `src/flask/json/provider.py:166–179`:

```
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

The docstring sentence naming the attribute is `provider.py:169–171`; the forwarding line is `provider.py:177`; `provider.py:179` passes the value straight to `json.dumps` with no branch inspecting it.

**Override ordering.** `provider.py:177` uses `kwargs.setdefault`, not assignment, so an explicit caller kwarg wins over the attribute. The plan flagged this as line-text-only; the executor verified it at runtime in both directions: `attr=False` + `dumps(..., ensure_ascii=True)` → escaped, ASCII output; `attr=True` + `dumps(..., ensure_ascii=False)` → literal non-ASCII output.

**What exposes the knob and what does not.**
- `dumps(obj, **kwargs)` — attribute or caller kwarg; kwarg beats attribute (`provider.py:166–179`).
- `dump(obj, fp, **kwargs)` — `DefaultJSONProvider` does not override it; the inherited version (`provider.py:49–57`) is `fp.write(self.dumps(obj, **kwargs))`, so it reaches the setting only through `dumps`.
- `response(...)` (`provider.py:189–215`) — **no caller kwarg for it at all**. Its `**kwargs` are *data* to serialize (`_prepare_response_obj`, `provider.py:75–87`; docstring `provider.py:198–203`: ":param kwargs: Treat as a dict to serialize."), and the only dump options it builds are `indent`/`separators` (`provider.py:206–211`). It ends at `provider.py:213–214` in `self._app.response_class(f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype)`. Consequence: on the `jsonify`/`response` path the *only* control is the attribute. Runtime confirms this — `response` with `attr=True` yields `'"\\u2603"\n'`, with `attr=False` yields `'"☃"\n'`.

**Concrete demonstration — the snowman test.** `tests/test_json.py:48–54`:

```
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

The two expected literals are genuinely different strings: the `True` case expects `'"\\u2603"'`, an **8-character** ASCII string (`"`, `\`, `u`, `2`, `6`, `0`, `3`, `"`) — the snowman emitted as a `\uXXXX` escape sequence; the `False` case expects `'"\u2603"'`, a **3-character** string (`"`, U+2603 SNOWMAN, `"`) — one literal non-ASCII code point. Both cases set the attribute on `app.json` and then call `app.json.dumps(...)` with no `ensure_ascii` kwarg. The test is parametrized only — no `skipif`, no xfail, no version marker (confirmed both statically and by running it: both cases collected and PASSED, plus `tests/test_testing.py::test_environbuilder_json_dumps`; 3 passed).

**The same knob reaches the request-body path.** `tests/test_testing.py:110–114` sets `app.json.ensure_ascii = False` and asserts `EnvironBuilder(app, json="\u20ac").input_stream… == '"\u20ac"'`. Path: Flask overrides `EnvironBuilder.json_dumps` at `src/flask/testing.py:88–94` with body `return self.app.json.dumps(obj, **kwargs)` (line 94), which Werkzeug calls at `.venv/Lib/site-packages/werkzeug/test.py:370`, in place of its `json_dumps = staticmethod(json.dumps)` default (`werkzeug/test.py:289`). So the attribute is honoured when building test JSON bodies too, through the same `dumps`/`setdefault`.

**Where the escaped-vs-literal mapping is actually implemented: the stdlib, not Flask.** `provider.py:179` hands the value to `json.dumps` unchanged, and there is no transforming code in Flask. The stdlib source (via the venv's base interpreter, `cpython-3.13.9-windows-x86_64-none\Lib\json\`) makes it first-hand: `json.dumps`'s docstring says "If ``ensure_ascii`` is false, then the return value can contain non-ASCII characters if they appear in strings contained in ``obj``. Otherwise, all such characters are escaped in JSON strings."; `json/encoder.py:19` defines `ESCAPE_ASCII = re.compile(r'([\\"]|[^\ -~])')`, and `json/encoder.py:219–222` selects `encode_basestring_ascii` when `self.ensure_ascii` else `encode_basestring` (with `self.ensure_ascii = ensure_ascii` at line 149, default `True` on the encoder too). Runtime output was byte-for-byte equal between the provider and the stdlib for both settings, and equal to the test's expected literals.

**Version stability.** `grep` for `ensure_ascii` and `snowman` over `CHANGES.rst` returns nothing; the checkout is `Version 3.2.0 / Unreleased` (`CHANGES.rst:1–8`, whose only entries drop Python 3.9 support and remove `__version__`), `pyproject.toml:3` `version = "3.2.0.dev"`, `pyproject.toml:22` `requires-python = ">=3.10"`. No changelog entry contradicts the current default.

**Summary of the relationship, stated once:**

| Aspect | Finding | Source |
|---|---|---|
| Direction | Boolean attribute → forwarded verbatim into `json.dumps`'s `ensure_ascii`; Flask does not transform it | `provider.py:177`, `:179`; `json/encoder.py:219–222` |
| Default | `True` (pure-ASCII output) | `provider.py:144` |
| `True` behaviour | Non-ASCII characters emitted as `\uXXXX` escapes; output is ASCII | `provider.py:145–148`; `tests/test_json.py:49`; runtime |
| `False` behaviour | Non-ASCII characters emitted as literal code points | `tests/test_json.py:49`; runtime |
| Override (a) | Mutate the attribute: `app.json.ensure_ascii = False` | both tests; runtime |
| Override (b) | Caller kwarg on `dumps`/`dump`, wins via `setdefault` | `provider.py:177`; runtime both directions |
| Not overridable per call | `response`/`jsonify` build only `indent`/`separators`; attribute only | `provider.py:206–214` |
| Trade-off | "more compatible with some clients, but … better performance and size" | `provider.py:145–148` |

**Open / caveated, kept as such:**
- The quoted stdlib `json` source lives in the venv's **base interpreter**, not inside the worktree (`.venv/Lib/` contains only `site-packages/`). The mapping is still first-hand observed source, just outside the checkout.
- The claim of no contradicting changelog entry rests on a whole-file `grep` of `CHANGES.rst` (zero hits for `ensure_ascii` and `snowman`) plus reading lines 1–60, not a line-by-line read of all 1622 lines.
- Only the default wiring was exercised. A third-party `DefaultJSONProvider` subclass registered via `json_provider_class`/`app.json` (a documented extension point, `provider.py:28–30`) could redefine `ensure_ascii` or not carry it; no such provider exists in this worktree.
- The plan deliberately did **not** decide the product/compatibility question of whether `True` is the right default, nor whether to change the docstring or tests — those remain outside this answer.

**Rests on:** `src/flask/json/provider.py:144–148`, `:166–179`, `:49–57`, `:189–215`, `:75–87`, `:28–30`; `src/flask/sansio/app.py:230,329`; `tests/test_json.py:48–54`; `tests/test_testing.py:110–114`; `src/flask/testing.py:88–94`; `werkzeug/test.py:289,370`; stdlib `json/__init__.py` docstring and `json/encoder.py:19,149,219–222`; whole-worktree `grep` for `ensure_ascii`; `CHANGES.rst:1–8`; `pyproject.toml:3,22`; and the executor's green pytest run (3 passed) plus runtime script verifying default, both override directions, response path, and provider-equals-stdlib-equalsexpected-literal outputs.
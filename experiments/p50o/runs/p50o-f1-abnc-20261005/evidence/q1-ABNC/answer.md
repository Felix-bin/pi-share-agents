## What the relationship is

The ASCII-only control is a **direct, one-to-one representation switch** over Unicode characters in serialized output: it decides whether non-ASCII code points are spelled as `\uXXXX` escape sequences or written out as the literal characters. It is not a value transformation.

**The wiring.** `DefaultJSONProvider.ensure_ascii` is a plain class attribute, default `True` (`src/flask/json/provider.py:144`), described in its own docstring (145-148) as "Replace non-ASCII characters with escape sequences." It is handed verbatim to the stdlib encoder: `provider.py:177` does `kwargs.setdefault("ensure_ascii", self.ensure_ascii)` and `provider.py:179` does `return json.dumps(obj, **kwargs)`. There is no intermediate processing of the character data — the attribute *is* the `json.dumps` argument of the same name.

**Concrete effect (executed, against this worktree's `src`):**

| `app.json.ensure_ascii` | `app.json.dumps("\N{SNOWMAN}")` | repr | len | `isascii()` |
|---|---|---|---|---|
| `True` (default) | `"\u2603"` — backslash-u-2-6-0-3, six characters | `'"\\u2603"'` | 8 | `True` |
| `False` | `"☃"` — the single code point U+2603 | `'"☃"'` | 3 | `False` |

Both parametrizations of `tests/test_json.py::test_json_as_unicode` (`[(True, '"\\u2603"'), (False, '"\u2603"')]`, lines 48-54) PASSED in the same run: `2 passed in 0.03s`, exit 0, win32 / Python 3.13.9 / pytest 8.4.0, with the session confirmed to import `<cwd>\src\flask\__init__.py`.

**Representation only, never value.** `flask.json.loads` of either form returns the original string, and a dict round-trip stays equal (`'{"s": "\\u2603"}'` vs `'{"s": "☃"}'`, both decoding identically). `True` yields ASCII-only serialized text; `False` yields the literal characters, carried as UTF-8 bytes on the wire.

**The default, not an override.** Because the wiring uses `setdefault`, a caller-supplied `ensure_ascii=` wins over the attribute: attribute `True` + `dumps(..., ensure_ascii=False)` → `'"☃"'`; attribute `False` + `dumps(..., ensure_ascii=True)` → `'"\\u2603"'`. The attribute only supplies the argument when the caller omits it.

**Scope: it covers every JSON output path**, since all of them funnel through that one `dumps` — `provider.py:105` (base `response`), `provider.py:214` (`DefaultJSONProvider.response`), `provider.py:57` (base `dump`), `src/flask/json/__init__.py:41` (`flask.json.dumps`), `src/flask/testing.py:94` (`EnvironBuilder.json_dumps`). Executed confirmation on the response path: test-client GET → `200`, `Content-Type: application/json`, body `b'{"s":"\\u2603"}\n'` when `True` and `b'{"s":"\xe2\x98\x83"}\n'` when `False` — the literal UTF-8 bytes of U+2603, with no charset mismatch. `tests/test_testing.py:110-114` independently pins the request-body path (`EnvironBuilder(app, json="\u20ac")` → literal euro sign), so the control is not confined to direct `dumps` calls.

**The declared default is a no-op relative to plain `json.dumps`.** The stdlib default is already `ensure_ascii=True`, so only `False` produces output that differs from an unconfigured `json.dumps`. (Derived from the declared value plus the stdlib default; no third test pins `True`-equals-stdlib.)

**Do not conflate it with Jinja's `|tojson` escaping.** The `\u003c/script\u003e` asserted in `tests/test_json.py:209-220` is not produced by this parameter. It comes from MarkupSafe/Jinja `htmlsafe_json_dumps` (`.venv/Lib/site-packages/jinja2/utils.py:637-670`), which takes the same `self.json.dumps` (wired via `src/flask/app.py:422` as the Jinja policy) and *after* calling it applies `.replace("<", "\\u003c")…` to exactly four ASCII characters, always on. That is a second, independent escaping layer over the same output, covering ASCII characters `ensure_ascii` never touches; `docs/api.rst:240-241` documents the filter separately.

**Provenance of the knob.** `docs/config.rst:440-443` records that `JSON_AS_ASCII` "was removed" in 2.3 ("The default `app.json` provider has equivalent attributes instead"), so `app.json.ensure_ascii` is the renamed, relocated successor of that config flag — one knob, now on the provider object rather than in `app.config`. The base `flask.json.provider.JSONProvider` never declares it (its `dumps` raises `NotImplementedError`, `provider.py:47`); it exists only on the stdlib-json-backed `DefaultJSONProvider`.

## What this rests on, and what is still open

**Rests on:** `src/flask/json/provider.py:47,57,105,144-148,169-179,214` and `src/flask/json/__init__.py:41`, `src/flask/testing.py:94`, `src/flask/app.py:422` (wiring read directly); `tests/test_json.py:48-54` and `tests/test_testing.py:110-114` (pinned two-value assertions); `docs/config.rst:440-443`, `docs/api.rst:240-241` (history and layer separation); the executor's run of the named test plus the in-process `dumps`/response measurements; the Jinja/MarkupSafe source lines for the `tojson` layer.

**Open:**
- No mutation or defect in `ensure_ascii`'s declaration or wiring was found — the declared value is `True` and the wiring is intact. No diff against an unmutated baseline was possible, so if the task premise involves a changed value, that change is not visible in the sources or tests read.
- Whether any per-call `ensure_ascii=` override actually occurs anywhere in the codebase was not checked beyond the `setdefault` form itself.
- Behaviour for astral-plane characters (surrogate-pair escapes under `True`) was not exercised; only U+2603 and U+20AC are pinned.
- Environment caveat: a *bare* run of the test id does **not** import this worktree — `.venv/Lib/site-packages/flask.pth` points at a different tree (`samefile` → `False`). The bare run also reports `2 passed`, so the two agree, but only the `PYTHONPATH=src` runs are evidence about this worktree's files; whether the two trees are textually identical was not checked.
- `flask_mut2_i417ar2x/mutated_test.py` exists in the worktree but exercises subdomain / `SERVER_NAME` routing with no JSON, Unicode or `ensure_ascii` content; it is unrelated to this question.

Recorded the conclusion in shared memory: `491272218e4931151004e004295cd6deed9e44fee6d35471c1adb8abdde97f7c` (topic: `ensure_ascii` control vs Unicode representation, sourced to `src/flask/json/provider.py`).
# The control parameter is a single on/off switch between escaped and literal Unicode

The ASCII-only encoding control parameter is `DefaultJSONProvider.ensure_ascii`, a class attribute on the JSON provider with default `True` (`src/flask/json/provider.py:144-147`). It decides one thing and one thing only: whether non-ASCII characters in a serialized string are written as `\uXXXX` escape sequences or as the literal characters themselves. I confirmed the attribute and its docstring on disk; the behavioral claims below come from the collected test evidence and the executor's run.

## How it is wired in

`DefaultJSONProvider.dumps` forwards the attribute to the stdlib as a *default*, not an override (`provider.py:177`):

```python
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
```

So the attribute supplies the value only when the caller did not pass `ensure_ascii=` — verified in both directions by the executor: attribute `True` plus `dumps(..., ensure_ascii=False)` produced the literal `"☃"`, and attribute `False` plus `dumps(..., ensure_ascii=True)` produced `"\\u2603"`. The same parameter path covers every higher-level entry point: `flask.json.dumps` (which calls `current_app.json.dumps` under an app context), `jsonify` → `app.json.response()` (whose `dump_args` carry only `indent`/`separators`, `provider.py:~207-221`), and `EnvironBuilder.json_dumps` (`src/flask/testing.py:88-94`).

## What each setting does to the output

| | `ensure_ascii = True` (default) | `ensure_ascii = False` |
|---|---|---|
| U+2603 SNOWMAN | `"\u2603"` — 8 chars, 8 UTF-8 bytes | `"☃"` — 3 chars, 5 UTF-8 bytes |
| U+1F600 (astral) | `"\ud83d\ude00"` — surrogate pair, 14 chars | `"😀"` — 3 chars, 6 UTF-8 bytes |
| Response/request body | all bytes < 128 | raw UTF-8 bytes, e.g. `b'"\xe2\x82\xac"'` for the Euro sign |

The BMP row is asserted in the repo: `tests/test_json.py:48-54` parametrizes on the flag and expects exactly `'"\\u2603"'` versus `'"\u2603"'`; `tests/test_testing.py:110-114` observes the same switch through the request-body path, with the raw body decoding as UTF-8. The executor's one-off run supplies the astral-plane row (a surrogate pair under `True`, the literal character under `False`), which no test in the worktree covers.

Two properties hold in both modes and are worth stating because they bound the parameter's reach: `json.loads` of either output yields the identical value, and `r.get_json()` equals the original dict — the flag changes the *encoding of the text*, never the *value* recovered from it. The escape sequences are pure ASCII, which is the compatibility gain the docstring describes ("more compatible with some clients"); disabling them trades that for "better performance and size."

## Provenance

The parameter is the successor to the legacy config key `JSON_AS_ASCII`: `CHANGES.rst:285-288` records the 2.2 move of JSON configuration onto `app.json`, and `CHANGES.rst:153-154` plus `docs/config.rst:440-443` record its removal in 2.3. A grep for `JSON_AS_ASCII` across the worktree returns only those changelog/docs removal notes — no live code reads the old key, so `app.json.ensure_ascii` is the only name through which this behavior is controlled.

## What is answered, what remains open

Answered: the parameter's identity, default, mechanism of propagation, its two observable effects on Unicode representation (BMP and astral), that it is value-preserving, and that it is a single coarse switch rather than per-character or per-field control.

Open, with evidence limits: the charset Werkzeug applies when encoding an `application/json` `Response` body is not defined anywhere in `src/flask` — the UTF-8 reading rests only on bytes decoding cleanly under both settings; astral-plane behavior is established by the executed run, not by any repo test; and `ensure_ascii` appears only in `provider.py` and two tests, with no dedicated docs page documenting it directly.

## Basis and caveats

- Rests on: `src/flask/json/provider.py:144-147, 167-179, ~207-221`; `src/flask/json/__init__.py:13-44, 138`; `src/flask/testing.py:88-94`; `tests/test_json.py:48-54`; `tests/test_testing.py:110-114`; `CHANGES.rst:285-288, 153-154`; `docs/config.rst:419, 440-443`; pytest runs in the worktree venv (Python 3.13.9, pytest 8.4.0) and the executor's one-off dumps/response dumps.
- No contradicting source was found; `flask_mut2_i417ar2x/mutated_test.py` was inspected by the retriever and is unrelated to this parameter.
- Nothing in the evidence decides whether the default *should* change or whether code/docs should be edited.
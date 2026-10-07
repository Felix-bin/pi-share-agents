# How the TypedDict return annotation keeps JSON serialization and HTTP status in separate type channels

The type-safe dictionary in question is `StatusJSON`, declared and used at `tests/type_check/typing_route.py:41-47`:

```python
class StatusJSON(t.TypedDict):
    status: str

@app.route("/typed-dict")
def typed_dict() -> StatusJSON:
    return {"status": "ok"}
```

It decouples JSON serialization from status representation by being admitted into the return type **only as a body**, while HTTP status exists in the type system only as an `int` in a tuple slot. The two are structurally non-overlapping:

- `ResponseValue` (`src/flask/typing.py:12-27`) is the body union: `Response`, `str`, `bytes`, `list[t.Any]`, `t.Mapping[str, t.Any]`, `t.Iterator[str]`, `t.Iterator[bytes]`, `cabc.AsyncIterable[str]`, `cabc.AsyncIterable[bytes]`. The mapping member carries the explanatory comment on line 17 — *"Only dict is actually accepted, but Mapping allows for TypedDict."* That member is the single door through which a TypedDict-annotated view return type-checks.
- `ResponseReturnValue` (`src/flask/typing.py:36-42`) adds status only inside tuples: `tuple[ResponseValue, HeadersValue]`, `tuple[ResponseValue, int]`, `tuple[ResponseValue, int, HeadersValue]`. Status is typed `int` and nothing else, so a JSON object can never occupy the status position.
- Slot 2 of a 2-tuple is disambiguated by type, not by name: it is `HeadersValue`, which itself includes `t.Mapping[str, HeaderValue]` (`src/flask/typing.py:28-33`). A mapping there is a headers object. The type system therefore has no channel in which a dictionary — structurally, a TypedDict — can mean "the HTTP status".

The obvious follow-up objection — "but the TypedDict's field is literally called `status`" — is answered by the runtime, which mirrors the type split exactly. In `make_response` (`src/flask/app.py:1129`):

1. `status: int | None = None` and `headers: HeadersValue | None = None` are declared as separate locals (`app.py:1186-1187`) — status is never read out of the body value.
2. Tuple dispatch is a runtime `isinstance` on slot 1 (`app.py:1194-1201`): `if isinstance(rv[1], (Headers, dict, tuple, list)): rv, headers = rv` else `rv, status = rv`. A dict at slot 1 becomes headers, never status.
3. A dict/list body goes *only* to the JSON provider — `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)` (`app.py:1230-1231`). `JSONProvider.response` (`src/flask/json/provider.py:89-105`) takes `*args, **kwargs` and returns `self._app.response_class(self.dumps(obj), mimetype="application/json")`; it has no status parameter, so serialization is never told about a status.
4. Status is applied *after* serialization, onto the `Response` the provider returned: `# prefer the status if it was provided` / `if status is not None:` / `rv.status = status` else `rv.status_code = status` (`app.py:1258-1263`). Note the asymmetry with the preceding str/bytes branch (`app.py:1220-1229`), which passes `status=status` into the response constructor and then sets `status = headers = None`; the dict/list branch does not, so for a dict body a status can only arrive through the tuple wrapper.

Nothing anywhere extracts a `status` key from a returned mapping: `grep` for `["status"]` and `.get("status")` across `src/flask` returns no matches. A `"status"` key in a JSON body is payload and is serialized as such.

Executed confirmation (executor, test client against this worktree's `src`):

| returned value | result |
|---|---|
| `{"status":"ok"}` | 200, body `{"status":"ok"}` |
| `{"status":"ok"}, 201` | 201, body `{"status":"ok"}` |
| `{"status":"ok"}, {"X-Test":"1"}` | 200, header `X-Test: 1` |
| `{"a":1}, {"status":"not-a-code"}` | 200, header `status: not-a-code`, body `{"a":1}` |

The first row is the decisive one: a body whose own field says `"status": "ok"` produces a plain 200. The fourth shows what a status-shaped mapping in a tuple slot actually becomes — a header. The status can only be set by the `int` slot the types reserve for it.

**What the checker enforcement buys.** Both configured checkers run over the fixture (`pyproject.toml:129` `files = ["src", "tests/type_check"]` for mypy; `:145` `include = ["src", "tests/type_check"]` for pyright). Executor ran both (mypy 1.16.0, pyright 1.1.401):

- `-> StatusJSON` is accepted by both as `ResponseReturnValue`.
- Removing the `t.Mapping[str, t.Any]` member and re-testing the same TypedDict makes it an **error** in both — proving the Mapping member, not the `dict` phrasing, is the admission path.
- `rv: ResponseReturnValue = 1` is an **error** in both, and the error text enumerates the union including `Mapping[str, Any]`, so `int` cannot enter as a body.
- `m2: dict[str, t.Any] = make()` is an **error** in both, so the admission is by structural Mapping subtyping, deliberately broader than a nominal `dict`.

That is the type-safety argument in one line: the structural mapping relation admits arbitrary TypedDict shapes as *bodies*, while the status position is closed to everything but `int`, so a body dict cannot be mistaken for a status and a status cannot be mistaken for a body — at type-check time and at runtime alike. `CHANGES.rst:338` records this as deliberate: *"When type checking, allow ``TypedDict`` to be returned from view functions. :pr:`4695`"*.

**Where the premise needs care.** The question's framing implies the TypedDict participates in *representing* the status — that its structure is somehow what carries or coordinates the status while serialization stays independent. The evidence does not support that reading. `StatusJSON`'s field is named `status` but is typed `str` and lives in the body union; there is no type-check fixture anywhere under `tests/type_check/` that annotates a status inside a dict body (executor's `grep -rn "status" tests/type_check/` hits only `StatusJSON.status: str` and the tuple fixtures), no runtime test asserting the status of `/typed-dict`, and no `docs/` page mentions `TypedDict` at all. The decoupling is not something the TypedDict *performs*; it is a property of how the two unions are drawn, and the TypedDict is the case that demonstrates it — it type-checks as a return value only because it lands in the mapping member of the body union, which is the member a status can never be.

## Grounds and open points

**Rests on:** `src/flask/typing.py:12-27` (verbatim, including the line-17 comment), `:28-33`, `:36-42`; `tests/type_check/typing_route.py:41-47` and `:71-82` (the tuple status/headers counterparts, e.g. `tuple_status` → `tuple[str, int]`, `tuple_headers` → `tuple[str, dict[str, str]]`); `src/flask/app.py:1129, 1186-1187, 1194-1201, 1220-1231, 1258-1263`; `src/flask/json/provider.py:89-105`; `pyproject.toml:129,145`; `CHANGES.rst:338`; `grep` showing no `["status"]`/`.get("status")` extraction in `src/flask` and no `TypedDict` in `docs/`; executor's mypy/pyright runs and test-client runs. Retriever's inference that the checkers accept `-> StatusJSON` (reasoned from the comment, changelog, and fixture placement) was subsequently run by executor and holds, so it is no longer inference.

**Open / not established:** the repository's project-wide type check is not independently green in this environment — mypy reports one unrelated Windows `readline` error at `src/flask/cli.py:1041`, and pyright needs venv configuration to resolve `werkzeug` (78 spurious `reportMissingImports` without it), so no clean full-project pass was obtained; the local `src` was forced explicitly rather than relying on the venv's editable install. The contract is documented only by the code comment and the changelog — no documentation page states it, and no runtime test asserts the `/typed-dict` route's status. Executor flagged that without `venvPath` pyright renders the `Response` forward reference as `Unknown`, which silently absorbs an `int` and made a negative control pass until venv config was added — a caveat on anyone reproducing the pyright result, not a contradiction of it.
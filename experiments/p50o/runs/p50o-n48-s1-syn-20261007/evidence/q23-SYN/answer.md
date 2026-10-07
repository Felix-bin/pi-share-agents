## How the annotation decouples JSON body from HTTP status

The decoupling is achieved by splitting the return type into **two orthogonal axes**: the *body* is widened structurally (from `dict` to `Mapping`), while the *status* is hoisted out of the body mapping entirely and given its own tuple-level union arm typed `int`. The two constraints never share a slot, so a `TypedDict` never has to reserve a key for the HTTP status and no mapping value is ever forced to be an integer.

**1. The body axis: structural widening, not nominal `dict`**

`src/flask/typing.py:12-22` defines `ResponseValue` with the JSON-body member written as `t.Mapping[str, t.Any]`, and line 17 carries the verbatim inline comment:

```python
# Only dict is actually accepted, but Mapping allows for TypedDict.
t.Mapping[str, t.Any],
```

Because a `TypedDict` is structurally a `Mapping` but is *not* a nominal `dict`, this widening is what makes a `TypedDict` return annotation legal at all. That it is load-bearing rather than cosmetic was tested directly: both checkers reject a `TypedDict`-typed value against `str | dict[str, Any]` (`mypy 1.16.0`: `Incompatible return value type (got "StatusJSON", expected "str | dict[str, Any]")`; `pyright 1.1.401`: `Type "StatusJSON" is not assignable to ... "dict[str, Any]" (reportReturnType)`) and accept the same value against `str | t.Mapping[str, t.Any]`. The repo's own changelog states the intent and scopes it to typing only — `CHANGES.rst:338`: "When type checking, allow `TypedDict` to be returned from view functions."

**2. The status axis: a separate tuple arm, never a mapping key**

`src/flask/typing.py:36-42` keeps the HTTP status in arms *beside* `ResponseValue`, not inside it:

```python
ResponseReturnValue = t.Union[
    ResponseValue,
    tuple[ResponseValue, HeadersValue],
    tuple[ResponseValue, int],
    tuple[ResponseValue, int, HeadersValue],
    "WSGIApplication",
]
```

Element 0 of every tuple arm is still constrained to `ResponseValue` (a valid body) and the status element is constrained to `int`. That is the type-safety argument: an invalid mix is rejected statically because the constraints are orthogonal. The falsification probe confirms the checkers actually enforce this through `@app.route` — `-> int` and `-> tuple[str, str]` routes are flagged by both mypy and pyright, while `-> StatusJSON` and `-> tuple[StatusJSON, int]` are clean.

The corpus fixes the two channels side by side in `tests/type_check/typing_route.py`: `class StatusJSON(t.TypedDict): status: str` is returned bare from `/typed-dict` (lines 41-46) — the `status` key there is *payload data* — while the HTTP status appears separately as `def tuple_status(code: int = 200) -> tuple[str, int]` and the `HTTPStatus.OK` variant (lines 65-72). `pyproject.toml` points both checkers at `tests/type_check`, and the executed runs are clean over that corpus: only one unrelated pre-existing error remains, `src/flask/cli.py:1041 readline.set_completer [attr-defined]`, present under both checkers in this environment.

**3. The runtime mirrors the split**

`src/flask/app.py:1129` declares `make_response(self, rv: ft.ResponseReturnValue) -> Response:`, consuming exactly that union. The body ordering implements the decoupling:

- `app.py:1183-1197` unpacks the tuple *before* any body handling: `status: int | None = None` / `headers: HeadersValue | None = None`, then `if isinstance(rv, tuple)` splits it (the 2-tuple `elif` decides status vs headers by whether element 1 is `Headers`/`dict`/`tuple`/`list`).
- `app.py:1226-1227` serializes the body independently: `elif isinstance(rv, (dict, list)): rv = self.json.response(rv)`.
- `app.py:1259-1263` applies the status *after* serialization: `status` → `rv.status` / `rv.status_code`.
- The serializer itself has no status parameter — `flask/json/provider.py` `JSONProvider.response` returns `self._app.response_class(self.dumps(obj), mimetype="application/json")`.

So the path is body → JSON → `Response`, then status → `Response.status_code`; the two channels meet only on the finished response object. The checked-in test `tests/test_basic.py:1288` fixates this: `make_response(jsonify({"msg": "W00t"}), 400)` gives `status_code == 400` with `data == b'{"msg":"W00t"}\n'` and `mimetype == "application/json"` — identical body bytes, status supplied out-of-band via the tuple. Runtime probes over the corpus shapes show the same: `/typed-dict` → `200 b'{"status":"ok"}\n' application/json`, and the `tuple[StatusJSON, int]` variant → `201 b'{"status":"ok"}\n' application/json`. Executed: `pytest tests/test_basic.py -k make_response -v` → 2 passed, and `-k "make_response or json"` → 7 passed.

**4. Where the decoupling is not airtight**

Two mismatches survive and are worth stating rather than smoothing away:

- **The body annotation admits more than the runtime accepts.** `Mapping` is the declared body, but `app.py:1226` checks `isinstance(rv, (dict, list))`. Probes show `MappingProxyType({"a": 1})` and a custom `collections.abc.Mapping` pass both checkers yet raise `TypeError` at runtime ("it was a mappingproxy" / "it was a M"); `OrderedDict(a=1)` works because it is a `dict`. The repo comment at `typing.py:17` itself concedes this ("Only dict is actually accepted"), so the widening is a deliberate typing affordance, not a claim about runtime coverage. The body/status *decoupling* is airtight; annotation-to-runtime body coverage is not.
- **The 2-tuple's second slot is decided at runtime by value, not by the union arm.** Both checkers accept `tuple[str, dict[str, Any]]` (correctly read as the headers arm) and reject `tuple[str, str]`; yet at runtime `("hi", "201")` is silently taken as a status and yields `201 CREATED`. Runtime is laxer than the annotation for that one shape.

One environment caveat: pyright's default invocation in this worktree is invalid as evidence (61 `reportMissingImports` for `werkzeug`, because it used the ambient interpreter); only the `--pythonpath .venv/Scripts/python.exe` run is meaningful.

### What this answer rests on

- Annotation contract: `src/flask/typing.py:12-22` (incl. the `Mapping`-for-`TypedDict` comment) and `36-42`, read directly.
- Corpus and config: `tests/type_check/typing_route.py:41-46` and `65-72`; `pyproject.toml` mypy/pyright `files = ["src", "tests/type_check"]` and the tox typing env; `CHANGES.rst:338`.
- Runtime: `src/flask/app.py:1129`, `1183-1197`, `1226-1227`, `1259-1263`; `flask/json/provider.py`; `tests/test_basic.py:1288`.
- Executed checks (mypy 1.16.0 / pyright 1.1.401 / pytest 8.4.0, local `src` forced via `PYTHONPATH`/`MYPYPATH`/`--pythonpath`): clean corpus with only the unrelated `cli.py:1041` error; falsification and `Mapping`-vs-`dict` counterfactual probes; 2 + 7 passing runtime tests; runtime probes of the corpus shapes.

### What remains open

- No prose document in the repo names "decoupling JSON serialization from HTTP status" as a design goal. That framing is inference from the union shapes plus the runtime ordering; the changelog's TypedDict allowance (`CHANGES.rst:338`) is scoped explicitly to *type checking*, and `docs/quickstart.rst:699-706` documents dict→`jsonify` and tuple→status as separate numbered runtime steps without stating a decoupling rationale.
- The annotation-vs-runtime body mismatch and the 2-tuple status-vs-headers laxity are observed behaviours with no in-repo statement of intent behind them; whether either is considered a defect is not established by the collected evidence.
- No test was run against a *mutated* annotation at runtime, so the counterfactual body of the annotation is not exercised end-to-end; only the checked-in annotation is.
- Recorded as conclusion memory `71fe109d4ac6e1c5cf55a96f5dfde4ef9d903033e3a915e383fd7b1901784fd1` (source `src/flask/typing.py`).
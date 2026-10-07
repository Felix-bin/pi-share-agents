# Where the list-of-dicts route handler integrates with the route decorator and the static-checker configuration

The handler is **`hello_json_list` at `tests/type_check/typing_route.py:36-38`** — the only list-returning handler in `tests/type_check/`, which contains just `typing_app_decorators.py`, `typing_error_handler.py`, and `typing_route.py`:

```python
@app.route("/json/dict")
def hello_json_list() -> list[t.Any]:
    return [{"message": "Hello"}, {"message": "World"}]
```

It integrates at four named points, all inside the repository:

**1. The decorator binding point — `src/flask/sansio/scaffold.py:336`.**
`typing_route.py:11` is `app = Flask(__name__)`; `Flask` inherits `route` from the sansio scaffold. The signature is `def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:`, and its inner `def decorator(f: T_route) -> T_route:` at `scaffold.py:360-363` calls `self.add_url_rule(rule, endpoint, f, **options)` and `return f`. Because it returns `f` unchanged, the handler's declared annotation is preserved rather than erased to a generic callable — that is the mechanism that lets the checker see `-> list[t.Any]` at all.

**2. The bound that the annotation must satisfy — `src/flask/sansio/scaffold.py:39`:**
`T_route = t.TypeVar("T_route", bound=ft.RouteCallable)`.

**3. The contract that makes `list[t.Any]` admissible — `src/flask/typing.py`:**
- `:16` — `list[t.Any],` is a member of `ResponseValue` (union opens at `:12`, closes at `:23`; the neighbouring `t.Mapping[str, t.Any]` at `:18` carries the comment "Only dict is actually accepted, but Mapping allows for TypedDict").
- `:36-42` — `ResponseReturnValue = t.Union[ResponseValue, tuple[ResponseValue, HeadersValue], tuple[ResponseValue, int], tuple[ResponseValue, int, HeadersValue], "WSGIApplication"]`.
- `:84-87` — `RouteCallable = t.Callable[..., ResponseReturnValue] | t.Callable[..., t.Awaitable[ResponseReturnValue]]`.

So `list[t.Any]` ⊆ `ResponseValue` ⊆ `ResponseReturnValue` = the `T_route` bound, and the returned literal `[{"message": ...}]` is checked against the declared type.

**4. The configuration that scopes the file into both checkers — `pyproject.toml`:**
- `:127-132` — `[tool.mypy]` with `files = ["src", "tests/type_check"]` (`:129`) and `strict = true` (`:132`).
- `:143-146` — `[tool.pyright]` with `include = ["src", "tests/type_check"]` (`:145`) and `typeCheckingMode = "basic"`.
- `:240-245` — the `tox` env `typing` runs bare `["mypy"]` then `["pyright"]` with no path arguments, so each tool's own include key is what pulls `tests/type_check` in.
- The only mypy override block (`:134-141`) lists third-party modules (`asgiref.*`, `dotenv.*`, `cryptography.*`, `importlib_metadata`); there is no per-file override or in-file ignore for the type-check test modules.

**Executed checker status (single-file runs, both in the repo `pyproject.toml` strict/basic config):** `uv run --locked --group typing mypy tests/type_check/typing_route.py` exited 0 with "Success: no issues found in 1 source file"; `uv run --locked --group typing pyright tests/type_check/typing_route.py` exited 0 with "0 errors, 0 warnings, 0 informations" (pyright 1.1.401). Mypy's explicit file argument overrides the config's `files` key, so these are single-file runs, not the tox sweep.

**Exclusions confirmed, not assumed:** a grep for list annotations over `tests/type_check/` finds only `typing_route.py:37`. Near-misses fail the "list" property — `hello_json_dict() -> dict[str, t.Any]` (a dict, `:31-33`) and `typed_dict() -> StatusJSON` (a `TypedDict`, i.e. a mapping, `:46`).

## What is answered, and what is still open

Answered: the handler's location, the decorator it binds to, the type contract that admits `list[t.Any]`, the configuration that scopes the file into mypy and pyright, and the current (single-file) checker outcome.

Open, and reported rather than resolved:
- **Duplicated rule string.** `hello_json_dict` (`:31-33`) and `hello_json_list` (`:36-38`) are two distinct functions decorated with the *same* rule `"/json/dict"`. Both agents report this; neither establishes whether it is deliberate or a typo (a `/json/list` rule would be the plausible intent). This is an unresolved contradiction in intent, not in evidence.
- **Full-suite checker status.** `tox run -e typing` (whole `src` + `tests/type_check`) was not run; only single-file runs exist.
- **No negative-case evidence.** Nothing collected demonstrates that a *wrong* return annotation is actually rejected by these checkers, so "the configuration validates annotations" is established structurally (inclusion + strict config), not by a demonstrated failure.
- **Stray directory.** `flask_mut2_i417ar2x/mutated_test.py` exists at the worktree root with a handler `def view(company_id):` that has no return annotation and is outside both include sets; its provenance and relevance are undetermined.
- **Minor line-number discrepancy between the two agents' citations.** The retriever attributed `ResponseReturnValue` to `typing.py:38-45` and `ResponseValue` to `:15-23`; direct re-reading/grep gives `ResponseReturnValue` at `:36-42` and the `ResponseValue` union at `:12-23` (with `list[t.Any]` at `:16`, which the executor cited correctly). The substance is identical; only the retriever's ranges are offset.

## Basis

- `tests/type_check/typing_route.py:11, 31-33, 36-38, 46` (read, and grep for list annotations).
- `src/flask/sansio/scaffold.py:39, 336, 360-363` (read).
- `src/flask/typing.py:12-23, 36-42, 84-87` (read plus grep line numbers).
- `pyproject.toml:127-132, 134-141, 143-146, 240-245` (read).
- Executor run results: mypy exit 0 / "Success: no issues found in 1 source file"; pyright exit 0 / "0 errors, 0 warnings, 0 informations" (pyright 1.1.401). Full tox typing env not run.
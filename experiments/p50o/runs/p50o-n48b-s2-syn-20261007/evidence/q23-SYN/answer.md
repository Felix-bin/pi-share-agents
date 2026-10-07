The answer is written above in full. Summary of the conclusion:

**The integration point is `tests/type_check/typing_route.py:36-38`** — `hello_json_list`, decorated with `@app.route("/json/dict")`, annotated `-> list[t.Any]`, returning `[{"message": "Hello"}, {"message": "World"}]`. Three seams meet on it: `Scaffold.route` / `decorator(f: T_route) -> T_route` with `T_route` bound to `ft.RouteCallable` (`src/flask/sansio/scaffold.py:39, 336, 360-363`); `RouteCallable` → `ResponseReturnValue` → `ResponseValue`, which contains `list[t.Any]` at `src/flask/typing.py:16`; and the checker scoping in `pyproject.toml:129` (mypy `files`) and `:145` (pyright `include`), run by `pyproject.toml:239-245` and `.github/workflows/tests.yaml:51`.

Observed, not inferred: mypy 1.16.0 accepts the file under the strict `pyproject.toml` config (0 issues, exit 0, verbose-confirmed config), pyright 1.1.401 reports 0 errors, and mypy actively rejects a synthetic `-> int` route handler with `[type-var]`, confirming the `T_route` bound is the enforcing mechanism.

Open: runtime behaviour, pyright's bound enforcement, and the absence of any committed `list[dict[...]]`-spelled annotation.
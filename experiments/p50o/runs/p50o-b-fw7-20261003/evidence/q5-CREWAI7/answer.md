# Answer

## The test in question

**`tests/test_testing.py::test_subdomain`, lines 302–318.** It is the only function in the worktree that contains all three named elements in one body — configuration (`subdomain_matching=True` L303, `SERVER_NAME` L304), route registration with a subdomain (L307), and an explicit request context (L311). Every other `subdomain_matching`/`subdomain=` site lacks at least one:

| Rejected | Reason |
|---|---|
| `tests/test_basic.py:1502` `test_server_name_matching` | config + subdomain rules, but no request context (`client.get(base_url=...)`) |
| `tests/test_basic.py:1536` `test_server_name_subdomain` | no request context |
| `tests/test_basic.py:1754` `test_subdomain_basic_support` | no request context |
| `tests/test_basic.py:1774` `test_subdomain_matching` | no request context |
| `tests/test_basic.py:1787` `test_subdomain_matching_with_ports` | no request context |
| `tests/test_basic.py:1801` `test_subdomain_matching_other_name` | no subdomain rule at all, no request context |
| `tests/test_blueprints.py:953` `test_nesting_subdomains` | blueprint subdomain, no `@app.route(..., subdomain=)`, no request context |
| `tests/test_blueprints.py:972` `test_child_and_parent_subdomain` | blueprint subdomains, no request context |
| `tests/test_cli.py:504`, `tests/test_reqctx.py:63` | either no `subdomain_matching` or no context/route match (`test_reqctx` has context + `subdomain="foo"` but never sets `subdomain_matching`) |
| `tests/test_testing.py:117` `test_blueprint_with_subdomain` | `subdomain_matching=True` and `test_request_context("/", subdomain="xxx")`, but routes via a Blueprint subdomain, not `@app.route(..., subdomain=...)` |

`tests/test_testing.py:321` `test_nosubdomain` is the negative twin: same shape, no `subdomain_matching`, no subdomain rule.

## The dependency chain, in execution order

**1. App constructed with `subdomain_matching=True`** — `tests/test_testing.py:303`.
`Flask.__init__` declares the parameter at `src/flask/app.py:233` and forwards it at `src/flask/app.py:245`; `Scaffold.__init__` stores it: `self.subdomain_matching = subdomain_matching` at `src/flask/sansio/app.py:407`.
*Verification: source read. Not instrumented — the attribute value was never probed at runtime.*

**2. `SERVER_NAME` set to `"example.com"`** — `tests/test_testing.py:304`.
This is the name the adapter binds against: `server_name = self.config["SERVER_NAME"]` at `src/flask/app.py:452`.
*Verification: source read.*

**3. Route registered with `subdomain="<company_id>"`** — `tests/test_testing.py:307`.
`Scaffold.route` at `src/flask/sansio/scaffold.py:336`; its decorator calls `self.add_url_rule(rule, endpoint, f, **options)` at `src/flask/sansio/scaffold.py:362`; `App.add_url_rule` builds `rule_obj = self.url_rule_class(rule, methods=methods, **options)` at `src/flask/sansio/app.py:650` — `subdomain` arrives in `**options` — then `self.url_map.add(rule_obj)` at `src/flask/sansio/app.py:653`. The `<company_id>` segment is on the map's rule.
*Verification: source read.*

**4. `with app.test_request_context():`** — `tests/test_testing.py:311`.
`Flask.test_request_context` at `src/flask/app.py:1423` builds `EnvironBuilder(self, *args, **kwargs)` at `src/flask/app.py:1472` and returns `self.request_context(builder.get_environ())` at `src/flask/app.py:1475`; `request_context` returns `RequestContext(self, environ)` at `src/flask/app.py:1421`. So the explicit call does go to `RequestContext` — **not** to `AppContext`.
*Verification: body read in this pass. This was the one link the earlier evidence set recorded as "located but not read"; it is now read.*

**5. `RequestContext.__init__` calls `app.create_url_adapter(self.request)`** — `src/flask/ctx.py:323`, wrapped in `try/except HTTPException` storing `self.request.routing_exception` (`src/flask/ctx.py:324–325`). The `request is None` guard at `src/flask/ctx.py:317–319` constructs a real `Request` from `environ` first, so a request object (not `None`) reaches L323.
*Verification: source read.*

**6. `create_url_adapter(request)` builds the bound adapter** — `src/flask/app.py:425`, `request is not None` branch at L445.
Reads `server_name = self.config["SERVER_NAME"]` (L452). The `if self.url_map.host_matching:` branch (L454–457) is **not taken** (`host_matching` is False). The `elif not self.subdomain_matching:` branch (L458–462), which would force `subdomain = self.url_map.default_subdomain or ""`, is **not taken** while `subdomain_matching=True`. Returns `self.url_map.bind_to_environ(request.environ, server_name=server_name, subdomain=subdomain)` at L464–466, with `subdomain=None` so the actual host's subdomain is honoured.
`AppContext.__init__` at `src/flask/ctx.py:247` calls the same method with `request=None`, hitting `src/flask/app.py:468–474` (`url_map.bind(...)`), which does **not** consult `subdomain_matching`. That is the branch this test does **not** exercise for URL building.
*Verification: source read. The branch attribution is reading, not observation — no probe of the adapter.*

**7. `url_for("view", company_id="xxx")` builds `http://xxx.example.com/`** — `tests/test_testing.py:312`.
`flask.url_for` (`src/flask/helpers.py:188`) delegates to `current_app.url_for(...)` (`src/flask/helpers.py:232`); `Flask.url_for` at `src/flask/app.py:1003` finds `req_ctx = _cv_request.get(None)` at L1060 non-`None` inside the `with` block, so it takes `url_adapter = req_ctx.url_adapter` at L1063, and builds via `url_adapter.build(endpoint, values, ...)` at L1110–1116.
*Observed value: `http://xxx.example.com/` (printed by the mutation script; also the value the passing assertions require, since `client.get("/")` against a `<company_id>` rule would not match).*
**Not fully traced:** inside a request context, `Flask.url_for` defaults `_external = _scheme is not None`, i.e. `False` (`src/flask/app.py:1074–1077`), so the scheme-qualified result comes from Werkzeug's `MapAdapter.build` (`.venv/.../werkzeug/routing/map.py`), which was not read. Reported as an unresolved micro-link, not asserted.

**8. Context pushed; `client.get(url)` matches the subdomain rule and returns `b"xxx"`** — `tests/test_testing.py:314–315`.
The client's request goes through `Flask.wsgi_app` (`src/flask/app.py:1479`), which creates a **second** `RequestContext` for the actual request (that call site was not read in this pass), reaching the same `app.create_url_adapter(self.request)` at `src/flask/ctx.py:323`. Bound to host `xxx.example.com`, the adapter matches the `<company_id>` rule registered in link 3, so the view at `tests/test_testing.py:307–309` runs and returns `company_id`, i.e. `"xxx"`.
*Verification: the end result is observed (below); the internal wsgi_app line number is not cited because it was outside the read range.*

**9. Assertions close the chain** — `tests/test_testing.py:317–318`: `assert 200 == response.status_code` and `assert b"xxx" == response.data`. Observed PASSED.

This resolves the earlier open question about which request context is "in scope" (`E20`): it is not an either/or. The explicit `test_request_context()` block (L311) supplies the adapter that *builds* the URL; the client's per-request context supplies the adapter that *matches* it. Both paths run through `RequestContext.__init__` → `create_url_adapter(request)` at `src/flask/ctx.py:323`.

## Verification actually performed

```
.venv\Scripts\python.exe -m pytest tests/test_testing.py::test_subdomain -v -p no:cacheprovider
```
cwd `...\experiments\data\flask-src` → **exit 0**, `tests/test_testing.py::test_subdomain PASSED`, `1 passed in 0.03s`. A subprocess probe confirmed the venv imports Flask from this worktree's `src/flask/__init__.py`, not an installed copy, so the run exercises this source.

Mutation (`subdomain_matching=False`, copy of the same body run as a script): **exit 1**, stdout line `url_for -> http://xxx.example.com/`, `status_code: 404`, `data` = Werkzeug HTML 404 body, raising `AssertionError: status 404`. **Result: fails as expected** — the pass of the unmutated test is not incidental to lines 317–318.

Caveats carried forward, not smoothed over:
- The first mutation attempt (pytest on a copy under `C:\...\Temp`) aborted at **collection** with `PermissionError [WinError 5]: 'C:\Documents and Settings'` — exit 2. It yielded **no** mutation information and is not a mutation result.
- The successful mutation run was a **standalone script, not pytest**, so the value change is not isolated from the invocation-style change; the unmutated body was never run as a script, so that variable was not controlled.
- **Why** the mutated run 404s was not instrumented. Consistency with the `elif not self.subdomain_matching:` branch at `src/flask/app.py:458–462` is a source-reading inference, not an observation.

## What is answered, and what is still open

**Answered:** which test the task refers to (with rejection reasons for all alternatives); the ordered chain from app construction to the final assertion, each link carrying a `file:line` anchor; that the chain is exercised — the test passes in isolation and breaks when `subdomain_matching` is flipped.

**Still open / not established:**
- The mutation's causal branch (`src/flask/app.py:458–462`) is inferred, not observed; the adapter was not instrumented.
- The invocation-style confound in the mutation (script vs pytest) was not isolated.
- The exact Werkzeug `MapAdapter.build` behaviour that makes `url_for` scheme-qualified when `src/flask/app.py:1074–1077` defaults `_external` to `False` inside a request context.
- The `wsgi_app` request-context call site (link 8) was not read, so it is cited by module line only.
- Deliberately not decided by this run: whether the asker intended a different function, and whether the chain should also be documented in a source docstring.
- Scratch files left on disk: `...\flask-src\flask_mut2_i417ar2x\` (contains `mutated_test.py`) and `C:\Users\oobbee\AppData\Local\Temp\flask_mut__i3o6045\`. No tracked file was modified.

**No contradiction between sources was found** — `test_subdomain` is the unique match, and no evidence disputes the chain. The single tension, reported above rather than resolved, is the observed external URL from `url_for` against the `_external` default read at `src/flask/app.py:1074–1077`.

**Rests on:** `tests/test_testing.py:302–318` (test, read twice, plus PASSED at exit 0); `src/flask/app.py:233, 245, 425–476, 1003–1127, 1421, 1423–1477, 1479`; `src/flask/sansio/app.py:407, 650, 653`; `src/flask/sansio/scaffold.py:336, 362`; `src/flask/ctx.py:247, 309–331`; `src/flask/helpers.py:188, 232`; and the two recorded runs (exit 0 pass; exit 1 mutated script).
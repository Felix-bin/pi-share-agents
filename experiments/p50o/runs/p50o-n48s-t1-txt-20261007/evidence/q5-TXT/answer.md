## Dependency chain in `tests/test_testing.py::test_subdomain` (def line 302, body lines 303–318)

The test function that has all three stated properties is `tests/test_testing.py::test_subdomain`. Its body, verbatim:

```
303      app = flask.Flask(__name__, subdomain_matching=True)
304      app.config["SERVER_NAME"] = "example.com"
305      client = app.test_client()
307      @app.route("/", subdomain="<company_id>")
308      def view(company_id):
309          return company_id
311      with app.test_request_context():
312          url = flask.url_for("view", company_id="xxx")
314      with client:
315          response = client.get(url)
317      assert 200 == response.status_code
318      assert b"xxx" == response.data
```

The chain, in runtime order, with the line in the framework that implements each link and the reason it depends on the previous one:

1. **Configuration → app state (test 303–304).** `flask.Flask(__name__, subdomain_matching=True)` binds to the constructor parameter `subdomain_matching: bool = False` (`src/flask/sansio/app.py:289`), which is stored at `src/flask/sansio/app.py:407` `self.subdomain_matching = subdomain_matching`. `app.config["SERVER_NAME"] = "example.com"` sets the value read later at `src/flask/app.py:452`. No earlier link exists; this one is the root.

2. **Route registration (test 307–309).** `@app.route("/", subdomain="<company_id>")` → `src/flask/sansio/scaffold.py:336` `def route(self, rule, **options)` → `:362` `self.add_url_rule(rule, endpoint, f, **options)` → `src/flask/sansio/app.py:605` `def add_url_rule(...)` → `:650` `rule_obj = self.url_rule_class(rule, methods=methods, **options)` (`url_rule_class = Rule`, `:257`) → `:653` `self.url_map.add(rule_obj)`. The `subdomain="<company_id>"` keyword travels untouched inside `**options`; the endpoint name `view` is registered here. This link depends only on link 1's app object, not on its flag — the rule is registered on the `url_map` regardless of `subdomain_matching`.

3. **Request-context creation (test 311).** `with app.test_request_context():` → `src/flask/app.py:1423` `def test_request_context(...)` → `:1472` `builder = EnvironBuilder(self, *args, **kwargs)` → `:1475` `return self.request_context(builder.get_environ())` → `:1407` `def request_context(self, environ)` → `:1419` `return RequestContext(self, environ)`; pushing that context is what builds the adapter: `src/flask/ctx.py:321` `self.url_adapter = None` … `:323` `self.url_adapter = app.create_url_adapter(self.request)`. This link consumes links 1–2 (app + `SERVER_NAME`) and produces the adapter that link 5 uses.

4. **Adapter binding / subdomain decision (inside the same `with`, executed at 311).** `src/flask/app.py:425` `def create_url_adapter(request)`: since `request is not None` (`:447`), `:451` `subdomain = None`, `:452` `server_name = self.config["SERVER_NAME"]`, then `:458` `elif not self.subdomain_matching:` → `:462` `subdomain = self.url_map.default_subdomain or ""`, and `:464–466` `return self.url_map.bind_to_environ(request.environ, server_name=server_name, subdomain=subdomain)`. This is the **only** link where link 1's flag changes behaviour: with the flag set, `subdomain` stays `None` and the subdomain is derived from the request host; with it unset, the subdomain is forced to `""` and the registered subdomain rule can never match.

5. **URL building inside that context (test 312).** `flask.url_for("view", company_id="xxx")` → `src/flask/helpers.py:230` `current_app.url_for(...)` → `src/flask/app.py:1003` `def url_for`; `:1060` `req_ctx = _cv_request.get(None)` is non-`None` because of link 3, `:1063` `url_adapter = req_ctx.url_adapter` is exactly the adapter from link 4, `:1074–1077` `if _external is None: _external = _scheme is not None` → `_external` is `False`, `:1110–1118` `rv = url_adapter.build(endpoint, values, …, force_external=_external)`. It depends on link 2 for the `view` endpoint and on link 4 for the adapter; link 4 is what makes the built URL carry the `xxx` host. Observed: the mutant script run (same code, flag `False`) printed `url_for -> http://xxx.example.com/`, i.e. an **absolute** URL, and the target's own `url` is not printed by any run that was permitted (see below).

6. **Client request (test 314–315).** `with client:` / `client.get(url)` → `src/flask/testing.py:65–80`: `if base_url is None:` → `:66` `http_host = app.config.get("SERVER_NAME") or "localhost"` → `:78–80` `url = urlsplit(path)` / `base_url = f"{url.scheme or url_scheme}://{url.netloc or http_host}/…"`. Because `url` is absolute with netloc `xxx.example.com`, the netloc wins over `SERVER_NAME`, so the request host is `xxx.example.com`. This link depends on link 5 for the literal value of `url`; changed output from link 5 changes the host that is requested.

7. **Assertions (test 317–318).** `assert 200 == response.status_code` and `assert b"xxx" == response.data` hold only if the host from link 6 is routed by a subdomain-matching adapter to the rule from link 2, whose view returns `company_id`. So the assertions close the loop back onto links 2 and 4.

Concise chain: **`subdomain_matching=True` + `SERVER_NAME` → `url_map` rule with `subdomain="<company_id>"` → request context pushes a context and creates its URL adapter → adapter bound with `subdomain=None`/host from config (the flag's only effect) → `url_for` builds the absolute `http://xxx.example.com/` → `client.get` requests that host → 200 with `b"xxx"`.**

### Near-miss candidates and the property each fails

| candidate | fails which of the three properties |
|---|---|
| `tests/test_testing.py:117` `test_blueprint_with_subdomain` (118–138) | route registration *read strictly*: `subdomain="xxx"` is on a `Blueprint` (123) registered via `app.register_blueprint(bp)` (129), not a direct `@app.route(..., subdomain=…)`; it also asserts `ctx.request.url` (132), never building a URL with `url_for` |
| `tests/test_reqctx.py:62` `test_proper_test_request_context` (63–104) | configuration: `SERVER_NAME` is set (63) but `subdomain_matching` is never enabled; only external URLs (`_external=True`) are built, and no subdomain-hosted client request is made |
| `tests/test_testing.py:321` `test_nosubdomain` (322–333) | subdomain routing: `@app.route("/<company_id>")` (324) has no `subdomain=`, so the id is a path segment |
| `tests/test_basic.py:1495` `test_server_name_matching`; `:1755` `test_subdomain_basic_support`, `:1774` `test_subdomain_matching`, `:1787` `test_subdomain_matching_with_ports`; `tests/test_blueprints.py:952` `test_nesting_subdomains`, `:972` `test_child_and_parent_subdomain` | request-context creation: none calls `app.test_request_context(...)` |

Alternative reading, one line: if "test function" is read loosely as "the collected test nearest the mutant", the only outside-`tests/test_testing.py` candidate is `tests/test_reqctx.py::test_proper_test_request_context`, which fails the configuration property; the other alternative named in the plan, `flask_mut2_i417ar2x/mutated_test.py`, is not a function at all — it is a 22-line module-level script and, per `pyproject.toml:108` `testpaths = ["tests"]`, is not even collected by a default pytest run.

### Which links break if a link is removed or changed

- **Remove the context creation (311–312).** With no request context, `url_for` cannot take the `:1060` branch; run under an app context instead it would take the `src/flask/app.py:1078–1100` branch, where `create_url_adapter(None)` goes to `:471–475` `return self.url_map.bind(self.config["SERVER_NAME"], script_name=self.config["APPLICATION_ROOT"], …)` and `_external` is forced `True` (`:1099–1100`). The `subdomain_matching` branch at `:458` lives inside `if request is not None:` (`:447`), so **the flag would stop affecting anything** and links 3 and 4 collapse into a config-only adapter. Links 5–7 would then run off that adapter and off bare `SERVER_NAME` rather than the request environ; link 6's `client.get(url)` host would come from the URL shape that adapter yields instead of the `xxx` subdomain derived from the environ.
- **Change the configuration (303–304).** Setting `subdomain_matching=False` — the mutation in `flask_mut2_i417ar2x/mutated_test.py` — leaves `SERVER_NAME` intact, so link 5's output is unchanged, but link 4 binds with `subdomain=""` (`:458–462`) and the request to `xxx.example.com` no longer matches the rule from link 2: observed `status_code: 404` and `AssertionError: status 404`. Unsetting `SERVER_NAME` would instead change link 4's `server_name` (`:452`) and link 6's `http_host` (`src/flask/testing.py:66`). Dropping the `subdomain=` kwarg in link 2 leaves link 5 with nothing to build the subdomain from and removes the rule that links 6–7 rely on — that variant is exactly `test_nosubdomain` above.

### Verification status and contradictions

- Executed: `tests/test_testing.py::test_subdomain` passes (`1 passed in 0.05s`, `EXIT=0`); `flask_mut2_i417ar2x/mutated_test.py` fails at its line 20 with `AssertionError: status 404`, `EXIT=1`, after printing `url_for -> http://xxx.example.com/`. Both were run through the project environment `.venv/Scripts/python.exe`; a bare `python` fails at collection with `ModuleNotFoundError: No module named 'flask'` (`EXIT=4`), an environment fact rather than a code result.
- **The plan's step-4 expectation is contradicted by the executed run.** The plan predicted that with the flag disabled `url_for` "emits a path-only URL". Observed, it emits the fully qualified `http://xxx.example.com/`; the flag's effect appears on the request side as a 404, not as a change of URL shape. The attribution of the mutant's failure to link 4 therefore rests on the observed 404 plus the single semantic edit (`subdomain_matching=True` → `False`), not on a URL-shape difference.
- **Not established:** the target's own `url_for` return value — the target has no `print` and the check was capped at two commands, so `url` at line 312 was never printed. It is *inferred* to be `http://xxx.example.com/`: inside `test_request_context()` with `SERVER_NAME="example.com"`, the target's adapter gets `subdomain` derived from the environ host `example.com` (i.e. `""`), which is the same value the mutant's forced `subdomain = self.url_map.default_subdomain or ""` yields, so `url_adapter.build` receives identical inputs; and a path-only URL would have produced the 404 against host `example.com` that the mutant run demonstrates, contradicting the target's observed pass.
- Also unverified: why `build(force_external=False)` returns an absolute URL at all. That is werkzeug's `MapAdapter.build` / `bind_to_environ` behaviour; `src/flask` contains no code forcing it (only `force_external=_external` at `src/flask/app.py:1115`), and the werkzeug sources under `.venv` were refused by the file tools, so the mechanism is not readable in this workspace. Likewise `self.url_map.default_subdomain` (`src/flask/app.py:462`) is a werkzeug `Map` attribute defined nowhere in `src/flask`.
- Minor plan-number corrections, verified here: `create_url_adapter` is at `src/flask/app.py:425` with subdomain handling at `445–466` (not `432–465`); `test_request_context` is defined at `:1423` with `EnvironBuilder` at `:1472` and the `request_context` call at `:1475` (not `1454`).

**Rests on:** `tests/test_testing.py:302–318` (quoted above); `tests/test_testing.py:117–138` and `:321–333`; `src/flask/sansio/app.py:257, 289, 407, 605, 650, 653`; `src/flask/sansio/scaffold.py:336, 362`; `src/flask/app.py:425, 447, 451–452, 458, 462, 464–466, 471–475, 1003, 1060, 1063, 1074–1077, 1099–1100, 1110–1118, 1407, 1419, 1423, 1472, 1475`; `src/flask/ctx.py:321, 323`; `src/flask/testing.py:65–80`; `src/flask/helpers.py:230`; `pyproject.toml:108`; and the two executed runs above.

**Open:** the target's printed `url`; the werkzeug-side explanation of the absolute URL; the mutation's origin (whether `flask_mut2_i417ar2x/` is intentional or tracked) — no VCS tool was available, and nothing in the workspace was edited.
## Dependency chain

The test function is **`tests/test_testing.py::test_subdomain`** (`def` at line 302, body 302–318). It is self-contained — no fixtures — and its three requested properties map to exact lines: configuration at 303–304, route registration at 307–309, explicit request-context creation at 311.

```
303  app = flask.Flask(__name__, subdomain_matching=True)
304  app.config["SERVER_NAME"] = "example.com"
307  @app.route("/", subdomain="<company_id>")
311  with app.test_request_context():
312      url = flask.url_for("view", company_id="xxx")
314  with client:
315      response = client.get(url)
317  assert 200 == response.status_code
318  assert b"xxx" == response.data
```

The chain is six links, each consumed by the next:

**1. Configuration → app attribute → adapter subdomain policy.** `Flask(..., subdomain_matching=True)` (303) is stored via `src/flask/app.py:233` param → `:245 super().__init__` → `src/flask/sansio/app.py:289` param → `:407 self.subdomain_matching = subdomain_matching`; `SERVER_NAME` (304) is read separately at adapter creation. Both are load-bearing: at `src/flask/app.py:451-466`, `create_url_adapter` sets `subdomain = None`, takes `server_name = self.config["SERVER_NAME"]`, and only when `not self.subdomain_matching` forces `subdomain = self.url_map.default_subdomain or ""` before calling `url_map.bind_to_environ(...)`. So configuration becomes the adapter's subdomain-derivation rule.

**2. Route registration → `url_map` rule.** `@app.route("/", subdomain="<company_id>")` (307) goes through `src/flask/sansio/scaffold.py:360-362` — the decorator pops `endpoint` and calls `self.add_url_rule(rule, endpoint, f, **options)`, with `subdomain` riding inside `**options` — then `src/flask/sansio/app.py:651 url_rule_class(rule, methods=methods, **options)` → `:653 self.url_map.add(rule_obj)`. This link supplies both the endpoint name `view` used by `url_for` and the rule subdomain `xxx` used for matching.

**3. Request context creation → `url_adapter`.** `app.test_request_context()` (311) at `src/flask/app.py:1423` builds an environ (`:1468-1471 builder = EnvironBuilder(self, *args, **kwargs)`) and calls `:1421 request_context`, whose constructor executes `src/flask/ctx.py:321-323 self.url_adapter = app.create_url_adapter(self.request)`. This is where link 1 actually takes effect: with `subdomain_matching=True` the adapter's subdomain is left `None` for Werkzeug to derive from `Host`; with `False` it is pinned to `""`.

**4. `url_for` inside that context → the URL string.** `flask.url_for(...)` (312) → `src/flask/helpers.py:232 current_app.url_for(...)` → `src/flask/app.py:1058-1063` (requires the pushed context and its `url_adapter`) → `:1110 url_adapter.build(endpoint, values, ..., force_external=_external)`. In the test's own context the adapter's subdomain is `""` while the rule's is `xxx`, so the relative shortcut in `werkzeug/routing/map.py:944-948` is skipped and the result is the absolute `http://xxx.example.com/`. This link depends on **both** link 2 (the rule must exist, else `BuildError`) and link 3 (the adapter must exist); it is *not* sensitive to link 1.

**5. The issued request consumes the `url_for` output.** `client.get(url)` (315) → `src/flask/testing.py:204 FlaskClient.open` → `:65-77` rewrites the full URL into `base_url`, giving `Host: xxx.example.com` → `src/flask/app.py:1500 ctx = self.request_context(environ)` → `ctx.py:323` adapter again → `ctx.py:394 self.match_request()` → `ctx.py:361-364 url_adapter.match(return_rule=True)` sets `request.url_rule` / `request.view_args`. Here link 1 finally bites: the adapter's subdomain (`xxx` vs `""`) decides whether the `subdomain="<company_id>"` rule matches.

**6. Asserts → the whole chain.** 317–318 (`200`, `b"xxx"`) are the readout: the status comes from the match at step 5, and the body is `company_id` extracted by the `<company_id>` converter registered at step 2.

**Where the dependency is actually exercised (executed, not just read).** The original test passes under both the venv flask and the local `src` tree. The mutated replica with `subdomain_matching=False` fails with **404 at the status assert** (the `data` assert is never reached) while its `url_for` still prints `http://xxx.example.com/` — identical to the original. The probe table confirms the mechanism: `True` + `SERVER_NAME` → adapter subdomain `xxx`, GET 200 `b'xxx'`; `False` → subdomain `''`, GET 404; `True` without `SERVER_NAME` → adapter server name doubles to `xxx.xxx.example.com`, subdomain `''`, GET 404. So the configuration link is load-bearing at adapter creation (`app.py:451-466` → `bind_to_environ`), not through the URL built by `url_for`, and `SERVER_NAME` is part of that link rather than decoration.

## What this rests on

- Verbatim body and line anchors of `tests/test_testing.py::test_subdomain` (302–318), re-read directly; the constructor is at 303, so an earlier record of "`subdomain_matching=True` at 302" is corrected.
- Source:line reads of every consecutive seam: `src/flask/app.py:233/245/451-466/1058-1110/1421-1471/1500`, `src/flask/sansio/app.py:289/407/651/653`, `src/flask/sansio/scaffold.py:360-362`, `src/flask/ctx.py:321-323/361-364/394`, `src/flask/helpers.py:232`, `src/flask/testing.py:65-77/193-204`, plus Werkzeug under `.venv` (`routing/map.py:252/944-948`).
- Executed runs: original test passed (exit 0); mutated replica exited 1 at the status assert; the three near-miss candidates passed; inline probe table above. Fail/pass does not discriminate the candidate tests, so the selection of `test_subdomain` over `test_blueprint_with_subdomain` (117–140) rests on reading, not on execution — the blueprint test also holds all three properties, but registers via `Blueprint(..., subdomain="xxx")` + `register_blueprint` and passes `subdomain=` into the context instead of relying on the context to derive it.
- Import caveat: with the bare interpreter, flask resolves through an editable `.pth` pointing outside this worktree; results are identical with `PYTHONPATH=src`, which was verified to load this worktree's `src/flask/__init__.py`.

## Still open

- Which of the two full-intersection tests is the intended one is not settled by any run — both pass, and only the mutated replica of `test_subdomain` was executed.
- Nothing beyond `test_subdomain`'s chain was executed: the mutated replica's exact import resolution and the Werkzeug-side derivation of `"xxx"` from `Host` are read off source, not observed at runtime.
# Dependency chain of `test_blueprint_with_subdomain`

**Test function (explicit):** `test_blueprint_with_subdomain` — file `experiments/data/flask-src/tests/test_testing.py`, **lines 117–139**, in the target checkout at git HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`experiments/data/flask-src/.git/HEAD` contains exactly that SHA; `experiments/data/swe-qa/repo_commit.txt` line 3 = `https://github.com/pallets/flask 85c5d93`). The SWE-QA gold file `swe-qa/Benchmark/flask.jsonl` was **never opened** by any role.

Verbatim, freshly re-read for this synthesis (`tests/test_testing.py:117-139`):

```python
def test_blueprint_with_subdomain():
    app = flask.Flask(__name__, subdomain_matching=True)      # 118  configuration (1)
    app.config["SERVER_NAME"] = "example.com:1234"            # 119  configuration (2)
    app.config["APPLICATION_ROOT"] = "/foo"                   # 120  configuration (3)
    client = app.test_client()                                # 121

    bp = flask.Blueprint("company", __name__, subdomain="xxx")# 123  route registration (declaration)

    @bp.route("/")                                            # 125  route registration (deferred record)
    def index():
        return flask.request.url

    app.register_blueprint(bp)                                # 129  route registration (commit)

    ctx = app.test_request_context("/", subdomain="xxx")      # 131  request context creation
    assert ctx.request.url == "http://xxx.example.com:1234/foo/"  # 132

    with ctx:                                                 # 134  (push — load-bearing)
        assert ctx.request.blueprint == bp.name               # 135

    rv = client.get("/", subdomain="xxx")                     # 137  second, independent path
    assert rv.data == b"http://xxx.example.com:1234/foo/"     # 138
```

The function takes **no pytest fixtures and no decorators** (verified by `ast.parse`: `line 117 args: [] decorators: []`; `tests/conftest.py:45 def app()`, `:67 def client(app)` are not used here). It is fully self-contained: every input it depends on is in the 23 lines above.

**Short answer.** The chain is three write-then-consume links, and each one is *lazily* consumed — nothing is resolved at the moment the test writes it:

1. **Configuration** (lines 118–120) → consumed when the URL adapter is built (`app.py:452-468`) and when the WSGI environ is built (`testing.py:66-79`).
2. **Route registration** (lines 123, 125, 129) → the blueprint route is *not* registered at `@bp.route`; it is recorded into `bp.deferred_functions` and only inserted into `app.url_map` during `register_blueprint` (`blueprints.py:103 → 110 → app.py:650-653`), carrying `subdomain="xxx"`.
3. **Request context creation** (lines 131–138) → `test_request_context(subdomain="xxx")` → `EnvironBuilder` builds host `xxx.example.com:1234` + script root `/foo` → `create_url_adapter` skips subdomain-flattening because `subdomain_matching=True` → `RequestContext.url_adapter` → `with ctx:` calls `match_request` → `request.blueprint == "company"`.

---

## The ordered chain, link by link

Notation: **what the test writes → which Flask symbol consumes it → file:line → why it is needed.** Every line number below was read (grep on the exact literal + file read); the empirical status of each is reported in §"Empirical verification".

### Stage A — configuration (test lines 118–120)

| # | Test writes | Consumed by | file:line | Why it is needed |
|---|---|---|---|---|
| A1 | `flask.Flask(__name__, subdomain_matching=True)` | `Flask.__init__` param, forwarded to `App.__init__` | `src/flask/app.py:226` (`def __init__`), param `app.py:233 subdomain_matching: bool = False`, forwarded `app.py:245 subdomain_matching=subdomain_matching` → `src/flask/sansio/app.py:282` (param `289 subdomain_matching: bool = False`) | Turns on the "keep the subdomain" branch in `create_url_adapter`. Docstring `src/flask/app.py:159-160`: `:param subdomain_matching: consider the subdomain relative to :data:`SERVER_NAME` when matching routes. Defaults to False.`; and `app.py:142-145`: `The ``subdomain_matching`` parameter was added. Subdomain matching needs to be enabled manually now. Setting :data:`SERVER_NAME` does not implicitly enable it.` |
| A2 | (same call) storage + Map creation | `self.subdomain_matching = subdomain_matching`; `self.url_map = self.url_map_class(host_matching=host_matching)` | `src/flask/sansio/app.py:407` and `405` | The flag is stored on the app, not on the map; the map exists from construction and is what later receives the `Rule`. Observed: `app.subdomain_matching = True`, `app.url_map.host_matching = False`, `app.url_map.default_subdomain = ''` |
| A3 | `app.config["SERVER_NAME"] = "example.com:1234"` | config default declared, then read lazily | default `src/flask/app.py:188 "SERVER_NAME": None` inside `default_config = ImmutableDict({...})` (`app.py:178-210`); defaults materialized `src/flask/sansio/app.py:494-495 defaults = dict(self.default_config)` / `defaults["DEBUG"] = get_debug_flag()`; consumed `src/flask/app.py:452 server_name = self.config["SERVER_NAME"]` and `src/flask/testing.py:66 http_host = app.config.get("SERVER_NAME") or "localhost"` | Sole source of `example.com:1234` in both the request URL and the adapter's `server_name`. Counterfactual CF5 (unset) → host falls back to `localhost`, adapter `server_name='xxx.localhost'`, `subdomain=''`, **404**. |
| A4 | `app.config["APPLICATION_ROOT"] = "/foo"` | same lazy read | default `src/flask/app.py:189 "APPLICATION_ROOT": "/"`; consumed `src/flask/testing.py:67 app_root = app.config["APPLICATION_ROOT"]` and `src/flask/app.py:474 script_name=self.config["APPLICATION_ROOT"]` | Sole source of the `/foo/` in both `ctx.request.url` (line 132) and the response body (line 138). Counterfactual CF4 (default `/`) → `http://xxx.example.com:1234/` and body `b'http://xxx.example.com:1234/'`, i.e. lines 132/138 fail. |
| A5 | (implicit, never written) `PREFERRED_URL_SCHEME` | read when building the environ and when binding outside a request | default `src/flask/app.py:205 "PREFERRED_URL_SCHEME": "http"`; consumed `src/flask/testing.py:73 url_scheme = app.config["PREFERRED_URL_SCHEME"]` and `src/flask/app.py:475 url_scheme=self.config["PREFERRED_URL_SCHEME"]` | Explains the `http://` literal in the two expected strings. Observed default at runtime: `app.config['PREFERRED_URL_SCHEME'] = 'http'` — confirmed, not assumed. |

Why the config writes are "writes only": `app.config['SERVER_NAME'] (before) = None`, `app.config['APPLICATION_ROOT'] (before) = '/'` then `(after) = 'example.com:1234'` / `'/foo'` — but the map, the rules and the adapter are untouched until each is built later.

### Stage B — route registration (test lines 123, 125, 129)

| # | Test writes | Consumed by | file:line | Why it is needed |
|---|---|---|---|---|
| B1 | `flask.Blueprint("company", __name__, subdomain="xxx")` | `Blueprint.__init__` | `src/flask/sansio/blueprints.py:174 def __init__(`, param `182 subdomain: str | None = None`, param doc `155-156 :param subdomain: A subdomain that blueprint routes will match on by default.`, stored `203 self.subdomain = subdomain`, list initialized `204 self.deferred_functions: list[DeferredSetupFunction] = []` | `bp.subdomain='xxx'` is the value that will be defaulted onto the rule. Observed `bp.name = company`, `bp.subdomain = 'xxx'`. Counterfactual CF2 (no blueprint subdomain) → `Rule('/', 'company.index', '')` → 404 under `xxx.`. |
| B2 | `@bp.route("/")` | `Scaffold.route` → `Blueprint.add_url_rule` → `Blueprint.record` | `src/flask/sansio/scaffold.py:336 def route(...)`, decorator body calls `362 self.add_url_rule(rule, endpoint, f, **options)` → `src/flask/sansio/blueprints.py:413 def add_url_rule(` whose body is *only* `433-441 self.record(lambda s: s.add_url_rule(rule, endpoint, view_func, provide_automatic_options=provide_automatic_options, **options))` → `src/flask/sansio/blueprints.py:224 def record(...)` → `230 self.deferred_functions.append(func)` | Registration is **deferred**: at line 125 nothing enters `url_map`. Observed: `bp.deferred_functions BEFORE @bp.route : len = 0 []` → `AFTER @bp.route : len = 1` with `repr -> [<function Blueprint.add_url_rule.<locals>.<lambda> ...>]`, and `url_map rules BEFORE register_blueprint:` contains only `rule='/static/<path:filename>' endpoint='static' subdomain='' ...`. |
| B3 | `app.register_blueprint(bp)` | `Flask.register_blueprint` → `Blueprint.register` | `src/flask/sansio/app.py:570 def register_blueprint(...)`, call `595 blueprint.register(self, options)` → `src/flask/sansio/blueprints.py:273 def register(self, app: App, options: dict[str, t.Any])`, state created `317 state = self.make_setup_state(app, options, first_bp_registration)`, loop `334 for deferred in self.deferred_functions:` / `335 deferred(state)` | This is the commit point: the deferred lambda runs and the rule finally reaches the app. Observed `len(bp.deferred_functions) BEFORE register_blueprint = 1` → `AFTER register_blueprint = 1` (iterated, **not consumed**), `bp._got_registered_once = True`, `app.blueprints AFTER register_blueprint = {'company': 'company'}`. |
| B4 | (via `register_blueprint`, options `{}`) | `BlueprintSetupState.__init__` resolves the default subdomain | `src/flask/sansio/blueprints.py:41 def __init__(`; body re-read verbatim for this synthesis: `64 subdomain = self.options.get("subdomain")`, `65 if subdomain is None:`, `66 subdomain = self.blueprint.subdomain`, `70 self.subdomain = subdomain` | The precedence rule: registration-time override wins, else the blueprint's own `subdomain`. Observed directly: `BlueprintSetupState.subdomain (options={}) = 'xxx'` vs `(options={'subdomain':'override'}) = 'override'`. |
| B5 | (deferred lambda argument) `s.add_url_rule(...)` | `BlueprintSetupState.add_url_rule` injects the default + prefixes the endpoint | `src/flask/sansio/blueprints.py:87 def add_url_rule(`; `103 options.setdefault("subdomain", self.subdomain)`; endpoint `112 f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")`; forward `110 self.app.add_url_rule(` | `103` is the literal carrier of `'xxx'` onto the rule; `112` produces the endpoint string `company.index` that `request.blueprint` later parses. |
| B6 | (forwarded call) | `App.add_url_rule` → `url_map.add` | `src/flask/sansio/app.py:605 def add_url_rule(`, `650 rule_obj = self.url_rule_class(rule, methods=methods, **options)`, `653 self.url_map.add(rule_obj)`, view func `661 self.view_functions[endpoint] = view_func` | Final insertion. Observed after the call: `rule='/' endpoint='company.index' subdomain='xxx' methods=['GET', 'HEAD', 'OPTIONS'] host=None`, `view_functions keys = ['company.index', 'static']`. |

Observed pre/post map states (executor probe A):
```
url_map rules BEFORE register_blueprint:
  rule='/static/<path:filename>' endpoint='static' subdomain='' methods=['GET','HEAD','OPTIONS'] host=None
url_map rules AFTER  register_blueprint:
  rule='/static/<path:filename>' endpoint='static' subdomain='' methods=['GET','HEAD','OPTIONS'] host=None
  rule='/' endpoint='company.index' subdomain='xxx' methods=['GET','HEAD','OPTIONS'] host=None
```

### Stage C — request context creation (test lines 131–138)

| # | Test writes | Consumed by | file:line | Why it is needed |
|---|---|---|---|---|
| C1 | `app.test_request_context("/", subdomain="xxx")` | `Flask.test_request_context` | `src/flask/app.py:1423 def test_request_context(self, *args, **kwargs)`; body `1470 from .testing import EnvironBuilder`, `1472 builder = EnvironBuilder(self, *args, **kwargs)`, `1475 return self.request_context(builder.get_environ())`, `1477 builder.close()` | The `subdomain="xxx"` kwarg is not a Flask routing argument here — it is passed straight through to `EnvironBuilder`. Doc string `app.py:1460-1461 :param subdomain: Subdomain name to append to :data:`SERVER_NAME`.` |
| C2 | (same kwargs) | `EnvironBuilder.__init__` | `src/flask/testing.py:49 def __init__(self, app, path="/", base_url=None, subdomain=None, url_scheme=None, ...)`; `65 if base_url is None:`, `66 http_host = app.config.get("SERVER_NAME") or "localhost"`, `67 app_root = app.config["APPLICATION_ROOT"]`, `69-70 if subdomain: http_host = f"{subdomain}.{http_host}"`, `73 url_scheme = app.config["PREFERRED_URL_SCHEME"]`, `76-79 base_url = (f"{url.scheme or url_scheme}://{url.netloc or http_host}" f"/{app_root.lstrip('/')}")` | **This is the line that synthesizes the test's expected host**: `xxx` + `example.com:1234`. Observed `ctx.request.environ['HTTP_HOST'] = 'xxx.example.com:1234'`, `ctx.request.environ['SCRIPT_NAME'] = '/foo'`. Counterfactual CF3 (drop the `subdomain` kwarg) → `ctx.request.url = 'http://example.com:1234/foo/'`, adapter `subdomain=''`, `NotFound`. |
| C3 | — | `Flask.request_context` → `RequestContext.__init__` | `src/flask/app.py:1407 def request_context(self, environ)`, `1421 return RequestContext(self, environ)`; `src/flask/ctx.py:308 def __init__(self, app, environ, ...)`, `317 request = app.request_class(environ)`, `319 self.request: Request = request`, `323 self.url_adapter = app.create_url_adapter(self.request)` | Creates the Request whose `.url` line 132 asserts, and the adapter that line 135's matching needs. Note `request.url` is *environ-derived* — observed `ctx (not pushed) request.url = 'http://xxx.example.com:1234/foo/'` while `ctx (not pushed) request.blueprint = None` and `ctx.request.url_rule (unpushed) = None`. |
| C4 | — | `Flask.create_url_adapter` (the subdomain_matching branch) | `src/flask/app.py:425 def create_url_adapter(self, request: Request | None) -> MapAdapter | None`; `452 server_name = self.config["SERVER_NAME"]`; `456 if self.url_map.host_matching:` → False, so `458 elif not self.subdomain_matching:` → **False because A1/A2 set it True**, so `subdomain` stays `None`; `464 return self.url_map.bind_to_environ(request.environ, server_name=server_name, subdomain=subdomain)` (in source at `464-468`, with the explanatory comment at `460-463`: `Werkzeug doesn't implement subdomain matching yet. Until then, disable it by forcing the current subdomain to the default, or the empty string.`) | The `elif` at 458 is the exact consumption point of the constructor flag; skipping it is what lets Werkzeug see the real host subdomain. Observed: `ctx.url_adapter type = werkzeug.routing.map.MapAdapter`, `subdomain='xxx'`, `server_name='example.com:1234'`. Counterfactual CF1 (flag off) — rule still present in the map, URL-built string still correct, but adapter `subdomain=''` → `NotFound '404: Not Found'`. |
| C5 | `with ctx:` (line 134) | `RequestContext.__enter__` → `push` → `match_request` | `src/flask/ctx.py:433 def __enter__(self)`, `434 self.push()`; `367 def push(self)`, `372-374` creates+pushes an app context if absent, `393 if self.url_adapter is not None:` / `394 self.match_request()`; `357 def match_request`, `362 result = self.url_adapter.match(return_rule=True)`, `363 self.request.url_rule, self.request.view_args = result` | **`with ctx:` is load-bearing, not decoration.** Observed: `inside with: request.blueprint = 'company'  url_rule = <Rule 'xxx|/' (GET, HEAD, OPTIONS) -> company.index>  routing_exception = None`, versus `request.blueprint = None` / `url_rule = None` before push. |
| C6 | `assert ctx.request.blueprint == bp.name` (line 135) | `Request.blueprint` derived from `Request.endpoint` | `src/flask/wrappers.py:147 def endpoint(self)` → `158-159 if self.url_rule is not None: return self.url_rule.endpoint`; `163 def blueprint(self)` → `175 endpoint = self.endpoint` → `176-178 if endpoint is not None and "." in endpoint: return endpoint.rpartition(".")[0]` | Closes the loop back to B5's endpoint string: `company.index`.rpartition(".")[0] == `"company"` == `bp.name`. Observed `inside with: ctx.request.blueprint == bp.name -> True`, and `inside with: flask.url_for('company.index') = '/foo/'`. |
| C7 | — | `AppContext.__init__`'s *second* adapter | `src/flask/ctx.py:247 self.url_adapter = app.create_url_adapter(None)` (re-read for this synthesis: `def __init__(self, app: Flask) -> None: self.app = app; self.url_adapter = app.create_url_adapter(None)`) | This is the `request is None` branch of `app.py:470-476`: `if self.config["SERVER_NAME"] is not None: return self.url_map.bind(self.config["SERVER_NAME"], script_name=self.config["APPLICATION_ROOT"], url_scheme=self.config["PREFERRED_URL_SCHEME"])`. Observed as trace entries `17`/`27 create_url_adapter args=(None,)`; it is why `url_for` resolves `/foo/` inside the pushed context. |
| C8 | `client.get("/", subdomain="xxx")` (line 137) | `FlaskClient.open` → `_request_from_builder_args` → `wsgi_app` | `src/flask/app.py:669 def test_client(...)`; `src/flask/testing.py:109 class FlaskClient(Client)`, `125 def __init__`; `204 def open(self, ...)`, `227 request = self._request_from_builder_args(args, kwargs)`; `193 def _request_from_builder_args(...)`, `197 builder = EnvironBuilder(self.application, *args, **kwargs)`, `200 return builder.get_request()`; `src/flask/app.py:1506 ctx = self.request_context(environ)`, `1510 ctx.push()`, `1511 response = self.full_dispatch_request()`; `app.py:904 def full_dispatch_request`, `879 def dispatch_request` → `902 return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)` | The second, independent path to the same result, confirming the view at line 127 returns `flask.request.url`. Observed `client.get('/', subdomain='xxx') status = 200`, `data = b'http://xxx.example.com:1234/foo/'`. Trace confirms `register_blueprint` is **not** re-entered on this path (step #5 absent from the client sequence), and it reaches the same `EnvironBuilder` via `_request_from_builder_args` (#20 → #21). |

---

## Empirical verification (executor, unchanged environment: `flask 3.2.0.dev0` from `src/flask/__init__.py`, `werkzeug 3.1.3`, Python 3.13.9, pytest 8.4.0)

- `pytest tests/test_testing.py::test_blueprint_with_subdomain -v` → **PASSED**, exit 0.
- `pytest tests/test_testing.py -v` → **25 passed**; whole suite `pytest -q` → **489 passed in 4.35s**, exit 0.
- The four near-duplicates run together → **4 passed** (they are all real tests; they are simply not the target).
- Observed end-to-end assertion block: `ALL ASSERTS PASSED`, including `ctx.url_adapter.subdomain = 'xxx'`, `ctx.url_adapter.server_name = 'example.com:1234'`, `inside with: ctx.request.blueprint == bp.name -> True`.
- Repo cleanliness after all probes: `git status --porcelain` empty, `HEAD` still `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, no probe files in the repo. Probes ran via stdin heredoc; nothing was written.

**Counterfactuals proving each link is necessary (all observed, raw output):**

```
### CF1: no subdomain_matching=True
  url_map rules: [('/static/<path:filename>', 'static', ''), ('/', 'company.index', 'xxx')]
  ctx.request.url      = 'http://xxx.example.com:1234/foo/'      <-- line 132 still passes
  ctx.url_adapter.server_name/subdomain = 'example.com:1234' / ''
  inside with: request.blueprint = None  url_rule = None  routing_exception = <NotFound '404: Not Found'>
  client.get('/', {'subdomain': 'xxx'} ) -> 404 ...              <-- line 138 fails

### CF2: Blueprint has no subdomain
  url_map rules: [('/static/<path:filename>', 'static', ''), ('/', 'company.index', '')]
  ctx.url_adapter.server_name/subdomain = 'example.com:1234' / 'xxx'
  inside with: request.blueprint = None  url_rule = None  routing_exception = <NotFound '404: Not Found'>

### CF3: test_request_context without subdomain kwarg
  ctx.request.url      = 'http://example.com:1234/foo/'          <-- line 132 fails
  ctx.url_adapter.server_name/subdomain = 'example.com:1234' / ''
  inside with: request.blueprint = None  routing_exception = <NotFound '404: Not Found'>
  client.get('/', {'subdomain': 'xxx'} ) -> 200 b'http://xxx.example.com:1234/foo/'   <-- line 138 still passes

### CF4: APPLICATION_ROOT is default '/'
  ctx.request.url = 'http://xxx.example.com:1234/'               <-- line 132 fails (no /foo/)
  inside with: request.blueprint = 'company'  url_rule = <Rule 'xxx|/' ... -> company.index>

### CF5: SERVER_NAME unset
  ctx.request.url = 'http://xxx.localhost/foo/'                  <-- line 132 fails
  ctx.url_adapter.server_name/subdomain = 'xxx.localhost' / ''
  inside with: request.blueprint = None  routing_exception = <NotFound '404: Not Found'>
```

Two subtleties the counterfactuals expose, which the prose chain must not smooth over:
- Line **132** (`ctx.request.url`) is satisfied by `EnvironBuilder` alone (Stage A + C2) and does **not** depend on the URL map — it passes even in CF1/CF2 where routing 404s.
- Line **135** (`ctx.request.blueprint`) is the only assertion that requires *all three* stages simultaneously (flag at 118 + blueprint subdomain at 123 + `subdomain=` kwarg at 131), because it needs a successful match. That asymmetry is what makes this test the correct target: it is the only test in the suite whose observable conclusion is blueprint attribution under a configured subdomain.
- The two paths consume `subdomain="xxx"` independently (CF3 shows `client.get` still 200 while `test_request_context` 404s) — each constructs its own `EnvironBuilder`.

**Observed runtime call order (instrumented monkeypatch, no file writes):**
```
  1. Flask.add_url_rule                     ('/static/<path:filename>', endpoint='static', host=None, ...)
  2. ---- @bp.route('/',) decorator ----
  3. Scaffold.route                         ('/',)
  4. Blueprint.add_url_rule                 ('/', None, <function index ...>)
  5. ---- app.register_blueprint(bp) ----
  6. Blueprint.register                     (<Flask '<stdin>'>, {})
  7. BlueprintSetupState.add_url_rule       ('/', None, <function index ...>, provide_automatic_options=None)
  8. Flask.add_url_rule                     ('/', 'company.index', <function index ...>, defaults={}, subdomain='xxx')
  9. ---- app.test_request_context('/', subdomain='xxx') ----
 10. Flask.test_request_context             ('/', subdomain='xxx')
 11. EnvironBuilder.__init__                (<Flask '<stdin>'>, '/', subdomain='xxx')
 12. Flask.request_context                  ({'REQUEST_METHOD':'GET','SCRIPT_NAME':'/foo','PATH_INFO':'/', ...})
 13. RequestContext.__init__                (<Flask '<stdin>'>, {...SCRIPT_NAME '/foo'...})
 14. Flask.create_url_adapter               (<Request 'http://xxx.example.com:1234/foo/' [GET]>)
 15. ---- with ctx: (push/__enter__) ----
 16. RequestContext.push
 17. Flask.create_url_adapter               (None)          <-- AppContext.__init__, ctx.py:247
 18. RequestContext.match_request
 19. ---- client.get('/', subdomain='xxx') ----
 20. FlaskClient._request_from_builder_args (('/',), {'subdomain':'xxx','method':'GET'})
 21. EnvironBuilder.__init__                (<Flask '<stdin>'>, '/', subdomain='xxx', method='GET', environ_base={...})
 22. Flask.wsgi_app
 23. Flask.request_context
 24. RequestContext.__init__
 25. Flask.create_url_adapter               (<Request 'http://xxx.example.com:1234/foo/' [GET]>)
 26. RequestContext.push
 27. Flask.create_url_adapter               (None)
 28. RequestContext.match_request
client response: 200 b'http://xxx.example.com:1234/foo/'
```

---

## Why this test and not the near-duplicates (each rejected for a stated reason)

- **`tests/test_testing.py:302 test_subdomain`** — `app.config["SERVER_NAME"] = "example.com"` (no port), `@app.route("/", subdomain="<company_id>")`, then `with app.test_request_context(): url = flask.url_for("view", company_id="xxx")`. Rejected: **no `Blueprint` at all**, no `APPLICATION_ROOT`, the `test_request_context` has **no `subdomain` kwarg** (the subdomain arrives via `url_for`), and there is no blueprint-attribution assertion.
- **`tests/test_testing.py:15 test_environ_defaults_from_config`** — same `SERVER_NAME`/`APPLICATION_ROOT` keys and same `ctx.request.url == "http://example.com:1234/foo/"` shape, but **no `subdomain_matching=True`**, no `Blueprint`, no `subdomain=` anywhere. It is the configuration-only sibling; the target is precisely this test *plus* the subdomain-matching and blueprint dimensions.
- **`tests/test_reqctx.py:63 test_proper_test_request_context(app)`** (actual line is **63**, not 61) — uses `subdomain="foo"` on `@app.route` but no `subdomain_matching=True` on the constructor, no `Blueprint`, no `test_request_context(subdomain=...)`; its conclusions come from `flask.url_for(..., _external=True)` inside `app.test_request_context("/")`, not from `ctx.request.url`/`ctx.request.blueprint`; `APPLICATION_ROOT` is never set.
- **`tests/test_basic.py:1536 test_server_name_subdomain`** — has `subdomain_matching=True` and `@app.route("/", subdomain="foo")`, but **no `Blueprint`**, no `APPLICATION_ROOT`, **no `test_request_context` at all**; subdomains are exercised by absolute `client.get("/", "http://foo.dev.local")` strings and only response bodies are asserted.
- Also ruled out: `tests/test_basic.py:1495-1534` parametrized `("subdomain_matching","host_matching")` table (`app.py`-level routes, no context creation); `test_subdomain_basic_support` `:1754`, `test_subdomain_matching` `:1774`, `test_subdomain_matching_with_ports` `:1787`, `test_subdomain_matching_other_name` `:1801`; `tests/test_blueprints.py:953 test_nesting_subdomains` and `:972 test_child_and_parent_subdomain` (blueprints *do* have subdomains, but set via `app.subdomain_matching = True` post-construction and `app.register_blueprint(parent, subdomain="api")`, and assertions are `response.status_code` only — no `test_request_context`, no `ctx.request.url`/`ctx.request.blueprint`); `tests/test_cli.py:502-505` CLI `routes`-command test.

⇒ `test_blueprint_with_subdomain` is the **only** test containing all three stages (config enabling `subdomain_matching`; blueprint route registration carrying `subdomain="xxx"`; `test_request_context(..., subdomain="xxx")`) **and** asserting blueprint attribution.

---

## Line-number corrections carried from the executor (deltas vs. the handed-in plan/evidence)

1. `tests/test_reqctx.py:63` is the real `def test_proper_test_request_context(app):` line (plan and evidence said 61).
2. `src/flask/app.py:914` reads `request_started.send(self, _async_wrapper=self.ensure_sync)` — the evidence's `_async_wwrapper` was a transcription artifact (re-confirmed by fresh read).
3. `blueprints.py` `BlueprintSetupState` anchors are `41` (`def __init__`), `64` (`self.options.get("subdomain")`), `65-66` (fallback to `blueprint.subdomain`), `70` (`self.subdomain = subdomain`) — not the `56-58`/`64-70` mix in the earlier evidence (re-confirmed by fresh read of `blueprints.py:40-114`).
4. `src/flask/ctx.py:247` (`AppContext.__init__` → `create_url_adapter(None)`) is the observed source of the second adapter creation (trace #17/#27); it is the `bind()` branch at `app.py:470-476` and explains `url_for('company.index') == '/foo/'` inside the pushed context.
5. `client.get("/", subdomain="xxx")` reaches `EnvironBuilder` through `FlaskClient._request_from_builder_args` (trace #20 → #21), then `wsgi_app` (#22) → `request_context` (#23) → `push` (#26) → `match_request` (#28); `register_blueprint` is **not** re-entered on the client path.

## Links that could not be observed (stated, not smoothed over)

- Werkzeug-internal mechanics of `MapAdapter.bind_to_environ` and the `base_url` path join live in `.venv/Lib/site-packages/werkzeug/`, outside `src/flask/`. Their **effects** were observed (`server_name='example.com:1234'`, `subdomain='xxx'`, `HTTP_HOST='xxx.example.com:1234'`, `SCRIPT_NAME='/foo'`, final URL string) but their source lines were not read — out of scope for `flask-src`.
- The internal assignment order inside `werkzeug.test.EnvironBuilder.__init__` beyond Flask's `testing.py:65-87` was not traced.

## Answer in one paragraph

The dependency chain runs **configuration → registration commit → context creation**, and it is deliberately lazy at every step: `test_blueprint_with_subdomain` (`tests/test_testing.py:117-139`) first writes three config values — `subdomain_matching=True` (`:118` → `app.py:245` → `sansio/app.py:407`), `SERVER_NAME="example.com:1234"` (`:119` → `app.py:188`/`452`, `testing.py:66`) and `APPLICATION_ROOT="/foo"` (`:120` → `app.py:189`/`474`, `testing.py:67`) — none of which does anything until an adapter or an environ is built; it then declares a blueprint with `subdomain="xxx"` (`:123` → `blueprints.py:203`), whose `@bp.route("/")` (`:125`) does **not** register but records a deferred lambda (`scaffold.py:362` → `blueprints.py:433-441` → `record`/`230`), which is only replayed at `app.register_blueprint(bp)` (`:129` → `sansio/app.py:595` → `blueprints.py:273`/`334-335`) where `BlueprintSetupState` picks `subdomain` from options-else-blueprint (`:64-70`), `setdefault`s it onto the rule options (`:103`), prefixes the endpoint to `company.index` (`:112`), and `url_map.add`s the `Rule` (`sansio/app.py:650`/`653`); finally `app.test_request_context("/", subdomain="xxx")` (`:131` → `app.py:1423`/`1470-1475`) builds the WSGI environ with `HTTP_HOST=xxx.example.com:1234` and `SCRIPT_NAME=/foo` (`testing.py:66-79`), constructs a `RequestContext` whose `url_adapter` is `create_url_adapter(self.request)` (`ctx.py:323`) — which *skips* the `elif not self.subdomain_matching` flattening at `app.py:458` precisely because of step 1, leaving `subdomain=None` for Werkzeug to derive `'xxx'` in `bind_to_environ` (`app.py:464-468`) — and the `with ctx:` at `:134` is what pushes the context and runs `match_request` (`ctx.py:433` → `394` → `362-363`), setting `request.url_rule.endpoint = "company.index"` so that `request.blueprint` (`wrappers.py:163-178`) returns `"company" == bp.name` at `:135`; the trailing `client.get("/", subdomain="xxx")` (`:137`) repeats the environ→`wsgi_app`→`request_context`→`push` path (`testing.py:193-227`, `app.py:1506-1511`) and gets the same URL from the view at `:127`. All 489 tests pass in this checkout, and removing any single link was empirically shown to break the corresponding assertion (flag off → `subdomain=''`, `NotFound`; no blueprint subdomain → `Rule(subdomain='')`, `NotFound`; no `test_request_context(subdomain=...)` → `example.com:1234` host, `NotFound`; default `APPLICATION_ROOT` → URL loses `/foo/`; unset `SERVER_NAME` → `xxx.localhost`, `NotFound`).
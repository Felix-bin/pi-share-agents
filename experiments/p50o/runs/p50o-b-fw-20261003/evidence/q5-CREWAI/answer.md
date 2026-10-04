# The dependency chain of `test_subdomain` (`tests/test_testing.py`)

## 0. The target test, verbatim

The test whose full dependency chain is being traced is `test_subdomain`, `tests/test_testing.py:302–318` (the file ends at line 396; the test is preceded by `test_client_json_no_app_context` and followed by `test_nosubdomain` at 321–335):

```
302: def test_subdomain():
303:     app = flask.Flask(__name__, subdomain_matching=True)
304:     app.config["SERVER_NAME"] = "example.com"
305:     client = app.test_client()
306:
307:     @app.route("/", subdomain="<company_id>")
308:     def view(company_id):
309:         return company_id
310:
311:     with app.test_request_context():
312:         url = flask.url_for("view", company_id="xxx")
313:
314:     with client:
315:         response = client.get(url)
316:
317:     assert 200 == response.status_code
318:     assert b"xxx" == response.data
```

The test's imports are `import flask` (`tests/test_testing.py:6`) and `from flask.testing import EnvironBuilder` (`tests/test_testing.py:11`).

In one sentence the chain is: **`subdomain_matching=True` + `SERVER_NAME` (test 303–304) configures the app; `@app.route("/", subdomain="<company_id>")` (test 307) registers a subdomain-scoped rule; `app.test_request_context()` (test 311) builds a WSGI environ and a request context whose URL adapter knows the server name; `flask.url_for("view", company_id="xxx")` (test 312) builds `http://xxx.example.com/`; `client.get(url)` (test 315) sends that URL through the test client, Werkzeug derives subdomain `xxx` from the host, Flask matches the rule, dispatches `view(company_id="xxx")`, and the 200/`b"xxx"` assertions hold (test 317–318).**

Each link is given below with the exact source passages.

---

## 1. Link 1 — Configuration and constructor (test lines 303–304)

Test line 303 `app = flask.Flask(__name__, subdomain_matching=True)` enters `Flask.__init__` (`src/flask/app.py:226–250`):

```
226:     def __init__(
...
233:         subdomain_matching: bool = False,
...
239:         super().__init__(
...
245:             subdomain_matching=subdomain_matching,
```

which forwards to `App.__init__` (`src/flask/sansio/app.py:282–301`), where the flag and the URL map are actually stored (`src/flask/sansio/app.py:390–411`):

```
405:         self.url_map = self.url_map_class(host_matching=host_matching)
406:
407:         self.subdomain_matching = subdomain_matching
```

`url_map_class`/`url_rule_class` are class attributes (`.venv/Lib/site-packages/werkzeug/routing/...` equivalents: `Rule` at `src/flask/sansio/app.py:257`, `Map` at `src/flask/sansio/app.py:263`).

Test line 304 `app.config["SERVER_NAME"] = "example.com"` overrides the default, which is `None` (`src/flask/app.py:188`):

```
188:             "SERVER_NAME": None,
```

The class docstring documents the semantics (`src/flask/app.py:142–160`):

```
142:     .. versionadded:: 1.0
143:        The ``subdomain_matching`` parameter was added. Subdomain
144:        matching needs to be enabled manually now. Setting
145:        :data:`SERVER_NAME` does not implicitly enable it.
...
157:     :param subdomain_matching: consider the subdomain relative to
158:         :data:`SERVER_NAME` when matching routes. Defaults to False.
```

**Runtime confirmation (Command 0d):** `subdomain_matching attr = True`, `SERVER_NAME = 'example.com'`, `url_map = Map([<Rule '/static/<filename>' (GET, OPTIONS, HEAD) -> static>])`, `url_map.host_matching = False`, `url_map.default_subdomain = ''`; and for a plain `flask.Flask(__name__)`, `default SERVER_NAME = None`, `default subdomain_matching = False`. `default_subdomain == ""` matters later (Link 3).

---

## 2. Link 2 — Route registration (test line 307)

`@app.route("/", subdomain="<company_id>")` invokes `Scaffold.route` (`src/flask/sansio/scaffold.py:335–365`):

```
336:     def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
...
360:         def decorator(f: T_route) -> T_route:
361:             endpoint = options.pop("endpoint", None)
362:             self.add_url_rule(rule, endpoint, f, **options)
363:             return f
364:
365:         return decorator
```

`subdomain="<company_id>"` travels inside `**options` and is forwarded verbatim. The endpoint defaults to the view function name, so `endpoint = "view"` and `view_functions["view"] = view` (the `view_functions` registry is created at `src/flask/sansio/scaffold.py:102–108`: `self.view_functions: dict[str, ft.RouteCallable] = {}`). The abstract `Scaffold.add_url_rule` raises `NotImplementedError` (`src/flask/sansio/scaffold.py:367–433`); the concrete implementation is `App.add_url_rule` (`src/flask/sansio/app.py:604–661`), whose relevant lines are:

```
604:     @setupmethod
605:     def add_url_rule(
...
614:             endpoint = _endpoint_from_view_func(view_func)  # type: ignore
615:         options["endpoint"] = endpoint
...
650:         rule_obj = self.url_rule_class(rule, methods=methods, **options)
651:         rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
652:
653:         self.url_map.add(rule_obj)
654:         if view_func is not None:
...
661:             self.view_functions[endpoint] = view_func
```

So line 650 builds `Rule("/", methods={"GET", "OPTIONS", "HEAD"}, endpoint="view", subdomain="<company_id>")`, line 653 adds it to the `Map`, and line 661 binds `"view"` to the function. The rule object itself stores the subdomain (`.venv/Lib/site-packages/werkzeug/routing/rules.py:459–516`):

```
463:         subdomain: str | None = None,
...
484:         self.subdomain = subdomain
```

`Rule.bind` fills in the map's `default_subdomain` **only if the rule has none** (`.venv/Lib/site-packages/werkzeug/routing/rules.py:566–581`):

```
579:         if self.subdomain is None:
580:             self.subdomain = map.default_subdomain
581:         self.compile()
```

Since `test_subdomain` supplies `"<company_id>"`, the rule keeps it, and `Rule.compile` turns the subdomain string into the domain-part matcher (`.venv/Lib/site-packages/werkzeug/routing/rules.py:700–731`):

```
703:         if self.map.host_matching:
704:             domain_rule = self.host or ""
705:         else:
706:             domain_rule = self.subdomain or ""
```

`Map.add` performs the binding (`.venv/Lib/site-packages/werkzeug/routing/map.py:170–181`):

```
176:         for rule in rulefactory.get_rules(self):
177:             rule.bind(self)
178:             if not rule.build_only:
179:                 self._matcher.add(rule)
180:             self._rules_by_endpoint.setdefault(rule.endpoint, []).append(rule)
181:         self._remap = True
```

**Runtime confirmation (Command 2):**

```
CHECK2 rule: / | endpoint= view | subdomain= '<company_id>' | methods= {'GET', 'OPTIONS', 'HEAD'}
CHECK2 view_functions keys: ['static', 'view']
CHECK2 rules_by_endpoint['view']: [<Rule '<company_id>|/' (GET, OPTIONS, HEAD) -> view>]
```

and Command 10 confirms `Rule.bind` does **not** overwrite the explicit subdomain (`before bind: r.subdomain = '<company_id>'` / `after bind : r.subdomain = '<company_id>'`), while a rule with no subdomain inherits `''` (`r2.subdomain after bind = '' (map default was '')`). `Map().default_subdomain` is `''` (`.venv/Lib/site-packages/werkzeug/routing/map.py:94–124`, `self.default_subdomain = default_subdomain` at line 111).

---

## 3. Link 3 — Request-context creation and the URL adapter (test line 311)

`with app.test_request_context():` calls `Flask.test_request_context` (`src/flask/app.py:1423–1477`):

```
1423:     def test_request_context(self, *args: t.Any, **kwargs: t.Any) -> RequestContext:
...
1470:         from .testing import EnvironBuilder
1471:
1472:         builder = EnvironBuilder(self, *args, **kwargs)
1473:
1474:         try
1475:             return self.request_context(builder.get_environ())
1476:         finally:
1477:             builder.close()
```

(the readback in Command 5 shows `1470: from .testing import EnvironBuilder`, `1472: builder = EnvironBuilder(self, *args, **kwargs)`, `1475: return self.request_context(builder.get_environ())`, `1477: builder.close()`). Since the test passes **no** `subdomain=`, `EnvironBuilder` composes the base URL purely from config (`src/flask/testing.py:49–86`):

```
49:     def __init__(
...
65:         if base_url is None:
66:             http_host = app.config.get("SERVER_NAME") or "localhost"
67:             app_root = app.config["APPLICATION_ROOT"]
68:
69:             if subdomain:
70:                 http_host = f"{subdomain}.{http_host}"
...
75:             url = urlsplit(path)
76:             base_url = (
77:                 f"{url.scheme or url_scheme}://{url.netloc or http_host}"
78:                 f"/{app_root.lstrip('/')}"
79:             )
```

Here `subdomain` is falsy, so the base URL is `http://example.com/`. `request_context` returns the context (`src/flask/app.py:1407–1421`):

```
1421:         return RequestContext(self, environ)
```

and `RequestContext.__init__` creates the adapter (`src/flask/ctx.py:309–335`):

```
309:     def __init__(
...
317:         if request is None:
318:             request = app.request_class(environ)
319:             request.json_module = app.json
320:         self.request: Request = request
321:         self.url_adapter = None
322:         try:
323:             self.url_adapter = app.create_url_adapter(self.request)
324:         except HTTPException as e:
325:             self.request.routing_exception = e
```

`App.create_url_adapter` (`src/flask/app.py:425–476`) is the crux:

```
425:     def create_url_adapter(self, request: Request | None) -> MapAdapter | None:
...
445:         if request is not None:
...
451:             subdomain = None
452:             server_name = self.config["SERVER_NAME"]
453:
454:             if self.url_map.host_matching:
...
457:                 server_name = None
458:             elif not self.subdomain_matching:
459:                 # Werkzeug doesn't implement subdomain matching yet. Until then,
460:                 # disable it by forcing the current subdomain to the default, or
461:                 # the empty string.
462:                 subdomain = self.url_map.default_subdomain or ""
463:
464:             return self.url_map.bind_to_environ(
465:                 request.environ, server_name=server_name, subdomain=subdomain
466:             )
467:
468:         # Need at least SERVER_NAME to match/build outside a request.
469:         if self.config["SERVER_NAME"] is not None:
470:             return self.url_map.bind(
471:                 self.config["SERVER_NAME"],
472:                 script_name=self.config["APPLICATION_ROOT"],
473:                 url_scheme=self.config["PREFERRED_URL_SCHEME"],
474:             )
475:
476:         return None
```

Because `subdomain_matching=True`, the `elif not self.subdomain_matching:` at line 458 is **skipped**, so `subdomain` stays `None` and `bind_to_environ(..., subdomain=None)` runs (lines 464–466). Werkzeug then derives the subdomain from the host (`.venv/Lib/site-packages/werkzeug/routing/map.py:252–340`):

```
310:         if server_name is None:
311:             server_name = wsgi_server_name
312:         else:
313:             server_name = server_name.lower()
...
321:         if subdomain is None and not self.host_matching:
322:             cur_server_name = wsgi_server_name.split(".")
323:             real_server_name = server_name.split(".")
324:             offset = -len(real_server_name)
325:
326:             if cur_server_name[offset:] != real_server_name:
...
337:                 subdomain = "<invalid>"
338:             else:
339:                 subdomain = ".".join(filter(None, cur_server_name[:offset]))
```

**Runtime confirmation (Command 3):** `EnvironBuilder(app, args=(), kwargs={})` → `base_url='http://example.com/' host='example.com' server_name='example.com'`. **Command 4 CASE A:** `bind_to_environ(HTTP_HOST='example.com', server_name='example.com', subdomain=None)` during `test_request_context()`; for the client request it is `bind_to_environ(HTTP_HOST='xxx.example.com', server_name='example.com', subdomain=None)` with `Map.bind` receiving subdomain `'xxx'` as the 3rd positional arg → adapter subdomain `'xxx'`. **Command 4 CASE B (control):** with `subdomain_matching=False`, Flask passes `subdomain=''`, and even though `url_for` still builds the same URL, the request **404s** — proving `subdomain_matching=True` is load-bearing for matching. **Command 5** confirms every cited anchor: `app.py:188,233,245,452,458,462,464-466,469-470,1421,1472,1475`; `sansio/app.py:405,407,650,653,661`; `scaffold.py:336,362`; `ctx.py:247,323`; `testing.py:66,69,70,125,197,204,228`.

---

## 4. Link 4 — `flask.url_for` builds the URL (test line 312)

`flask.url_for` is `helpers.url_for` (`src/flask/helpers.py:188–239`):

```
231:     return current_app.url_for(
232:         endpoint,
233:         _anchor=_anchor,
234:         _method=_method,
235:         _scheme=_scheme,
236:         _external=_external,
237:         **values,
238:     )
```

which calls `Flask.url_for` (`src/flask/app.py:1003–1127`). The key branch:

```
1060:         req_ctx = _cv_request.get(None)
1061:
1062:         if req_ctx is not None:
1063:             url_adapter = req_ctx.url_adapter
1064:             blueprint_name = req_ctx.request.blueprint
...
1076:             if _external is None:
1077:                 _external = _scheme is not None
1078:         else:
1079:             app_ctx = _cv_app.get(None)
...
1084:             if app_ctx is not None:
1085:                 url_adapter = app_ctx.url_adapter
1086:             else:
1087:                 url_adapter = self.create_url_adapter(None)
...
1099:             if _external is None:
1100:                 _external = True
...
1107:         self.inject_url_defaults(endpoint, values)
1108:
1109:         try:
1110:             rv = url_adapter.build(  # type: ignore[union-attr]
1111:                 endpoint,
1112:                 values,
1113:                 method=_method,
1114:                 url_scheme=_scheme,
1115:                 force_external=_external,
1116:             )
...
1121:             return self.handle_url_for_error(error, endpoint, values)
```

Because `with app.test_request_context():` pushes a **request** context (line 1062 fires), `url_adapter = req_ctx.url_adapter` (1063), and `_external` remains falsy (`_scheme is None`), so `build` is called with `force_external=None`/falsy. Werkzeug's `MapAdapter.build` finds the rule by endpoint and renders the host from the rule's subdomain (`.venv/Lib/site-packages/werkzeug/routing/map.py:787–826`, `_partial_build`, and `:908–951`, `build`):

```
922:         rv = self._partial_build(endpoint, values, method, append_unknown)
...
926:         domain_part, path, websocket = rv
927:         host = self.get_host(domain_part)
...
944:         if not force_external and (
945:             (self.map.host_matching and host == self.server_name)
946:             or (not self.map.host_matching and domain_part == self.subdomain)
947:         ):
948:             return f"{self.script_name.rstrip('/')}/{path.lstrip('/')}"
949:
950:         scheme = f"{url_scheme}:" if url_scheme else ""
951:         return f"{scheme}//{host}{self.script_name[:-1]}/{path.lstrip('/')}"
```

with `get_host` (`.venv/Lib/site-packages/werkzeug/routing/map.py:696–715`):

```
707:         if domain_part is None:
708:             subdomain = self.subdomain
709:         else:
710:             subdomain = domain_part
711:
712:         if subdomain:
713:             return f"{subdomain}.{self.server_name}"
714:         else:
715:             return self.server_name
```

**Runtime confirmation (Command 2):** `CHECK3 url_for('view', company_id='xxx') = http://xxx.example.com/`. **Command 8 CHECK A** shows the build runs on the **request-context** adapter (`build() called on adapter id=… (req_ctx? True / app_ctx? False), force_external=False`).

> **Caveat on the plan's step-4 wording.** The plan says `flask.url_for` "uses the app-context URL adapter". The runtime trace shows that inside `with app.test_request_context():` a *request* context is active, so `Flask.url_for` selects `req_ctx.url_adapter` at `app.py:1062–1063` — a different object from the app-context adapter created by `ctx.py:247` (`AppContext.url_adapter = app.create_url_adapter(None)`). That line *is* nonetheless exercised (Command 3 traced five `create_url_adapter` calls, three of them with `None`). Both adapters have `subdomain=''`, and since the *rule's* subdomain governs building, the URL is identical either way. Command 8 CHECK B confirms the app-context-only path: `flask.url_for (no request ctx) -> http://yyy.example.com/ | force_external= True`. Command 14 confirms the deeper point: **URL building honours the rule subdomain regardless of `subdomain_matching`** — with `subdomain_matching=False`, `test_proper_test_request_context`-style code still yields `http://foo.localhost.localdomain:5000/` (`tests/test_reqctx.py:63–84`).

---

## 5. Link 5 — Client dispatch (test lines 314–315)

`client = app.test_client()` (test line 305) → `Flask.test_client` (`src/flask/app.py:669–725`) → `FlaskClient.__init__` (`src/flask/testing.py:125–133`):

```
125:     def __init__(self, *args: t.Any, **kwargs: t.Any) -> None:
126:         super().__init__(*args, **kwargs)
127:         self.preserve_context = False
128:         self._new_contexts: list[t.ContextManager[t.Any]] = []
129:         self._context_stack = ExitStack()
130:         self.environ_base = {
131:             "REMOTE_ADDR": "127.0.0.1",
132:             "HTTP_USER_AGENT": f"Werkzeug/{_get_werkzeug_version()}",
133:         }
```

`with client:` toggles `preserve_context` (`src/flask/testing.py:249–253`) and `client.get(url)` calls `FlaskClient.open` (`src/flask/testing.py:204–247`). Since the argument is a **URL string** (not an `EnvironBuilder`, dict or `BaseRequest`), the `else` branch runs:

```
226:         else:
227:             # request is None
228:             request = self._request_from_builder_args(args, kwargs)
```

and (`src/flask/testing.py:185–202`):

```
193:     def _request_from_builder_args(
194:         self, args: tuple[t.Any, ...], kwargs: dict[str, t.Any]
195:     ) -> BaseRequest:
196:         kwargs["environ_base"] = self._copy_environ(kwargs.get("environ_base", {}))
197:         builder = EnvironBuilder(self.application, *args, **kwargs)
198:
199:         try:
200:             return builder.get_request()
201:         finally:
202:             builder.close()
```

`EnvironBuilder.__init__` again runs lines 65–79, but now `path` is `"http://xxx.example.com/"`, so `urlsplit(path).netloc == "xxx.example.com"` is used at line 77 and `http_host` (line 66) is not needed. `Werkzeug EnvironBuilder.get_environ` writes the environ (`.venv/Lib/site-packages/werkzeug/test.py:667–729`):

```
717:                 "SERVER_NAME": self.server_name,
718:                 "SERVER_PORT": str(self.server_port),
719:                 "HTTP_HOST": self.host,
```

**Runtime confirmation (Command 3):**

```
  EnvironBuilder(app, args=('http://xxx.example.com/',), kwargs={'method': 'GET', 'environ_base': {...}})
  -> base_url='http://xxx.example.com/' host='xxx.example.com' server_name='xxx.example.com'
  VIEW CALLED with company_id= 'xxx'
  request.url = http://xxx.example.com/
  request.url_rule = / subdomain= '<company_id>'
  request.view_args = {'company_id': 'xxx'}
response.status_code = 200
response.data = b'xxx'
```

The WSGI request then runs `Flask.wsgi_app` (`src/flask/app.py:1479–1527`):

```
1506:         ctx = self.request_context(environ)
...
1510:                 ctx.push()
1511:                 response = self.full_dispatch_request()
```

`RequestContext.push` calls `match_request` (`src/flask/ctx.py:357–394`):

```
357:     def match_request(self) -> None:
...
361:         try:
362:             result = self.url_adapter.match(return_rule=True)  # type: ignore
363:             self.request.url_rule, self.request.view_args = result
```

`MapAdapter.match` yields `(<Rule '<company_id>|/' -> view>, {'company_id': 'xxx'})` (Command 10: `adapter.match -> (<Rule '<company_id>|/' -> view>, {'company_id': 'xxx'})`). Finally `Flask.dispatch_request` splats the view args into the view (`src/flask/app.py:879–902`):

```
879:     def dispatch_request(self) -> ft.ResponseReturnValue:
...
890:         if req.routing_exception is not None:
891:             self.raise_routing_exception(req)
892:         rule: Rule = req.url_rule  # type: ignore[assignment]
...
901:         view_args: dict[str, t.Any] = req.view_args  # type: ignore[assignment]
902:         return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)  # type: ignore[no-any-return]
```

The view returns `company_id`, i.e. `"xxx"`, which becomes `response.data == b"xxx"`, so both assertions at test lines 317–318 hold (`200 == response.status_code -> True`, `b'xxx' == response.data -> True`, Command 3).

---

## 6. The chain as a single ordered dependency list

1. **`subdomain_matching=True` + `SERVER_NAME`** (test 303–304) → `Flask.__init__` (`app.py:226–250`, forwarding at 245) → `App.__init__` stores `self.url_map = self.url_map_class(host_matching=host_matching)` (`sansio/app.py:405`) and `self.subdomain_matching = subdomain_matching` (`sansio/app.py:407`); `SERVER_NAME` default `None` (`app.py:188`).
2. **`@app.route("/", subdomain="<company_id>")`** (test 307) → `Scaffold.route` (`scaffold.py:336`) → `decorator` (`scaffold.py:360–363`) → `App.add_url_rule` (`sansio/app.py:650` `rule_obj = self.url_rule_class(rule, methods=methods, **options)`; `:653` `self.url_map.add(rule_obj)`; `:661` `self.view_functions[endpoint] = view_func`) → `Map.add` (`werkzeug/routing/map.py:170–181`) → `Rule.bind`/`compile` (`werkzeug/routing/rules.py:566–581`, `:700–731`).
3. **`app.test_request_context()`** (test 311) → `EnvironBuilder(self, *args, **kwargs)` (`app.py:1472`) → `request_context` (`app.py:1421`) → `RequestContext.__init__` (`ctx.py:323` `app.create_url_adapter(self.request)`) → `App.create_url_adapter` (`app.py:452`/`458`/`462`/`464–466`) → `Map.bind_to_environ` (`werkzeug/routing/map.py:252–340`).
4. **`flask.url_for("view", company_id="xxx")`** (test 312) → `helpers.url_for` (`helpers.py:231`) → `Flask.url_for` (`app.py:1062–1063` request-context adapter; `:1110–1116` `url_adapter.build(...)`) → `MapAdapter.build` (`werkzeug/routing/map.py:908–951`) → `http://xxx.example.com/`.
5. **`with client: client.get(url)`** (test 314–315) → `FlaskClient.open` (`testing.py:204–247`, `:228` `_request_from_builder_args`) → `EnvironBuilder` (`testing.py:197` → `:66–70`/`:77`) → `get_environ` (`werkzeug/test.py:717/719`) → `wsgi_app` (`app.py:1506/1510/1511`) → `RequestContext.match_request` (`ctx.py:357–363`) → `dispatch_request` (`app.py:902`) → assertions (test 317–318).

---

## 7. Why each ingredient is load-bearing (negative controls)

- **`subdomain_matching=True` is required for matching.** Command 4 CASE B / Command 8 CHECK C: with `subdomain_matching=False` and everything else identical, `url_for` still builds `http://xxx.example.com/`, but the request returns **404** and both assertions are `False`.
- **`SERVER_NAME="example.com"` is required for building.** Command 9 CHECK D: dropping it yields the `"localhost"` fallback from `testing.py:66` (`url built without SERVER_NAME -> 'http://xxx.localhost/'`) and the client request 404s.
- **`subdomain_matching` affects only `create_url_adapter(request)` (matching), not the rule-based build.** Command 14: `test_proper_test_request_context` builds `foo.…` with `subdomain_matching=False`.
- **Contrast case.** `test_blueprint_with_subdomain` (`tests/test_testing.py:117–138`) passes `subdomain="xxx"` explicitly to *both* `test_request_context` (line 131 `ctx = app.test_request_context("/", subdomain="xxx")`) and `client.get` (line 137 `rv = client.get("/", subdomain="xxx")`), whereas `test_subdomain` passes neither. `test_nosubdomain` (`tests/test_testing.py:321–335`) uses the `app`/`client` fixtures (`tests/conftest.py:44–68`), omits `subdomain_matching`, and registers `@app.route("/<company_id>")` instead.

---

## 8. Verification results

The suite actually runs green: `pytest tests/test_testing.py::test_subdomain tests/test_testing.py::test_blueprint_with_subdomain tests/test_testing.py::test_nosubdomain -v` reported `3 passed in 0.07s` (Command 6), and the twelve sibling subdomain tests across `test_basic.py`, `test_reqctx.py`, `test_appctx.py`, `test_cli.py`, `test_blueprints.py` reported `12 passed in 0.22s` (Command 7). Environment: Flask `3.2.0.dev0` (`src/flask/__init__.py`), Werkzeug `3.1.3`, Python `3.12.12`.

| Claim | Verified by | Result |
|---|---|---|
| `tests/test_testing.py:302–318` is `test_subdomain` verbatim; file ends at 396 | Cmd 1, 11 | ✅ exact (`396 lines`) |
| `subdomain_matching=True` stored at `sansio/app.py:407`; `url_map` built at `:405`; `default_subdomain == ''` | Cmd 0d, 5, 10 | ✅ |
| `SERVER_NAME` default `None` at `app.py:188` | Cmd 0d, 5 | ✅ |
| `@app.route(subdomain="<company_id>")` → rule in `url_map`, endpoint bound | Cmd 2, 10 | ✅ `Rule '<company_id>|/' -> view` |
| `test_request_context()` (no `subdomain=`) → base `http://example.com/` | Cmd 2, 3 | ✅ |
| `ctx.py:323`/`247` call `create_url_adapter(request)`/`(None)` at runtime | Cmd 3 (5 traced calls), 4, 8 | ✅ |
| `subdomain_matching=True` ⇒ `bind_to_environ(..., subdomain=None)` (`app.py:458` skipped) | Cmd 4 CASE A | ✅ → adapter `'xxx'` |
| `subdomain_matching=False` ⇒ `subdomain=''` and a 404 | Cmd 4 CASE B, Cmd 8 C | ✅ |
| `url_for` builds `http://xxx.example.com/` on the request-context adapter, `force_external=False` | Cmd 8 A, 13 | ✅ |
| App-context-only path also yields the subdomain, `force_external=True` | Cmd 8 B | ✅ `http://yyy.example.com/` |
| `client.get(url)` → `EnvironBuilder(app, 'http://xxx.example.com/', ...)`, host `xxx.example.com` | Cmd 3 | ✅ |
| Werkzeug derives `subdomain='xxx'` from `HTTP_HOST`; `match` → `{'company_id':'xxx'}` | Cmd 3, 10 | ✅ |
| `Rule.bind` does not overwrite an explicit rule subdomain | Cmd 10 | ✅ |
| `test_subdomain` / `test_blueprint_with_subdomain` / `test_nosubdomain` pass | Cmd 6 | ✅ `3 passed` |
| All 12 sibling subdomain tests pass | Cmd 7 | ✅ `12 passed` |
| Building honours the rule subdomain regardless of `subdomain_matching` | Cmd 14 | ✅ |

---

## 9. Line-number discrepancies vs. the plan (flagged)

- `Flask.url_for`: the plan says "~1075-1116"; the definition is at **`app.py:1003`** (body anchors 1062–1063, 1084–1085, 1110–1116 are correct, return at 1127).
- `test_request_context`: plan says "1423-1475"; the body actually ends at **1477** (`finally: builder.close()`); 1423/1472/1475 are exact.
- `FlaskClient.open`: plan says "204-228"; `open` spans **204–247** (`return response` at 247); 228 is exact.
- `RequestContext.__init__`: plan's "309-331" is slightly short; the constructor ends at **335** (`_cv_tokens` list); `create_url_adapter(self.request)` is at **323**, `try/except HTTPException` at 322–325.
- `create_url_adapter` "425-476", `sansio/app.py` "405-407" and "650-661", `scaffold.py` `route` at 336 and `decorator` at 360–363, `EnvironBuilder.__init__` at 49–86 (lines 66/69/70), and `FlaskClient.__init__` at 125–133 are all **confirmed exact**.

---

### Bottom line

`test_subdomain` passes only when the whole chain coheres: `subdomain_matching=True` makes Flask pass `subdomain=None` to `Map.bind_to_environ` so Werkzeug can *derive* the subdomain from the request host at match time (`app.py:458` skipped → `bind_to_environ(..., subdomain=None)` → `werkzeug/routing/map.py:321–339`); `SERVER_NAME="example.com"` lets `url_for` build the external URL `http://xxx.example.com/` from the rule's own `subdomain="<company_id>"` (`app.py:1110–1116` → `werkzeug/routing/map.py:927/951`); and the test client re-materialises that URL into a WSGI environ (`testing.py:197/77` → `werkzeug/test.py:719`) whose `HTTP_HOST` yields `view_args={'company_id': 'xxx'}`, dispatched at `app.py:902` to produce `200` / `b"xxx"`.
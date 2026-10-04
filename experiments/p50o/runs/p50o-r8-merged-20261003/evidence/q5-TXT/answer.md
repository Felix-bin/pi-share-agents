# Answer — the dependency chain in `test_blueprint_with_subdomain`

**Short form.** The test is **`tests/test_testing.py:117–138::test_blueprint_with_subdomain`**. Its dependency chain is a three-axis pipeline in which each axis is a *producer* whose output is consumed by the next at a specific seam:

1. **Configuration axis** produces three config values (`subdomain_matching=True`, `SERVER_NAME="example.com:1234"`, `APPLICATION_ROOT="/foo"`) — consumed later by `Flask.testing.EnvironBuilder.__init__` (host/root-path construction) and by `Flask.create_url_adapter` (the `subdomain_matching` switch).
2. **Route-registration axis** (`Blueprint(..., subdomain="xxx")` → `@bp.route("/")` → `app.register_blueprint(bp)`) produces a *deferred* setup function that, at registration time, materializes a Werkzeug `Rule("/", endpoint="company.index", subdomain="xxx")` into `app.url_map` — the rule does not exist before registration, and the blueprint's `"xxx"` reaches the router only through `BlueprintSetupState.add_url_rule`'s `options.setdefault("subdomain", self.subdomain)`.
3. **Request-context axis** (`app.test_request_context("/", subdomain="xxx")`) consumes (1) to synthesize a WSGI environ (`HTTP_HOST=xxx.example.com:1234`, `SERVER_NAME=xxx.example.com`, `SCRIPT_NAME=/foo`, `PATH_INFO=/`), and then `RequestContext.__init__` + `push()` consume (2) to match that environ against the rule — which is the only reason `request.url_rule`, and therefore `request.blueprint`, are ever non-`None`.

The chain is strictly ordered: config must be written **before** the builder/context is constructed (control **N**), the blueprint must be registered **before** any matching (control **O**), and matching happens only at `push()` (control **J**) — which is exactly why the test asserts `ctx.request.url` *outside* the `with` block but `ctx.request.blueprint` *inside* it. All of this was executed, not merely read: every probe node matched, `test_blueprint_with_subdomain` passes, and the whole 489-test suite passes twice.

---

## 1. Identification of the test

`tests/test_testing.py:117–138` — reproduced verbatim from the pinned file (`nl -ba tests/test_testing.py | sed -n '112,145p'`):

```
   112	    app.json.ensure_ascii = False
   113	    eb = EnvironBuilder(app, json="\u20ac")
   114	    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
   115	
   116	
   117	def test_blueprint_with_subdomain():
   118	    app = flask.Flask(__name__, subdomain_matching=True)
   119	    app.config["SERVER_NAME"] = "example.com:1234"
   120	    app.config["APPLICATION_ROOT"] = "/foo"
   121	    client = app.test_client()
   122	
   123	    bp = flask.Blueprint("company", __name__, subdomain="xxx")
   124	
   125	    @bp.route("/")
   126	    def index():
   127	        return flask.request.url
   128	
   129	    app.register_blueprint(bp)
   130	
   131	    ctx = app.test_request_context("/", subdomain="xxx")
   132	    assert ctx.request.url == "http://xxx.example.com:1234/foo/"
   133	
   134	    with ctx:
   135	        assert ctx.request.blueprint == bp.name
   136	
   137	    rv = client.get("/", subdomain="xxx")
   138	    assert rv.data == b"http://xxx.example.com:1234/foo/"
   139	
   140	
   141	def test_redirect_keep_session(app, client, app_ctx):
```

**Discriminator (one sentence):** it is the only test in the suite that *both* creates the request context **explicitly** (`ctx = app.test_request_context("/", subdomain="xxx")` at line 131, `with ctx:` at 134) *and* routes **by subdomain**, so the three named axes (configuration → route registration → request-context creation) are all present and all load-bearing. It takes no fixtures (`def test_blueprint_with_subdomain():`), so its app is *not* the conftest `app` fixture — evidence, `tests/conftest.py`:

```python
54: @pytest.fixture
55: def app():
56:     app = Flask("flask_test", root_path=os.path.dirname(__file__))
57:     app.config.update(
58:         TESTING=True,
59:         SECRET_KEY="test key",
60:     )
61:     return app
```

and the runtime default check confirms the fixture defaults:

```
default subdomain_matching = False
default SERVER_NAME = None
default APPLICATION_ROOT = /
default PREFERRED_URL_SCHEME = http
default TESTING = False
```

### Near-miss table (identification risk, neutralised)

| Test | config | route reg. | explicit request ctx | subdomain routing | why it is *not* the answer |
|---|---|---|---|---|---|
| `test_environ_defaults_from_config` (`tests/test_testing.py:15`) | ✔ | ✔ | ✔ | ✘ | no subdomain at all; fixture app has `subdomain_matching=False` |
| `test_subdomain` (`tests/test_testing.py:302`) | ✔ | ✔ (app-level) | ✔ but **no `subdomain=` arg** | ✔ | strongest rival — subdomain rides in the built URL string, not in the explicit ctx; no blueprint |
| `test_nosubdomain` (`tests/test_testing.py:321`) | ✔ | ✔ | ✔ | ✘ (negative twin) | explicitly the non-subdomain case |
| `test_subdomain_basic_support` / `test_subdomain_matching` / `test_subdomain_matching_with_ports` / `test_subdomain_matching_other_name` (`tests/test_basic.py:1754/1774/1787/1801`) | ✔ | ✔ | ✘ (`client.get` only) | ✔ | implicit ctx inside `wsgi_app` |
| `test_server_name_matching` (`tests/test_basic.py:1502`) / `test_server_name_subdomain` (`:1536`) | ✔ | ✔ | ✘ (`client.get(base_url=...)`) | ✔ | implicit ctx only |
| `test_nesting_subdomains` / `test_child_and_parent_subdomain` (`tests/test_blueprints.py:953/972`) | ✔ (by attribute) | ✔ | ✘ (fixture `client`) | ✔ | implicit ctx; also `allow_subdomain_redirects`, an axis the target never touches |
| `test_proper_test_request_context` (`tests/test_reqctx.py:63`) | ✔ | ✔ | ✔ | ✔ | neither `subdomain_matching=True` nor a blueprint; no `subdomain=` arg; asserts `url_for`, never pushes the ctx to read `.blueprint` |
| `TestRoutes::test_subdomain` (`tests/test_cli.py:502`) | ✘ | ✔ | ✘ | ✘ | route-table rendering only, no request at all |
| `tests/test_apps/subdomaintestmodule/__init__.py` | — | — | — | — | dead: `from flask import Module` — `flask.Module` does not exist in Flask 3.x; the directory is only used as a static-file root in `tests/test_helpers.py:94` |
| **`test_blueprint_with_subdomain`** | ✔ | ✔ | ✔ | ✔ | — |

---

## 2. The dependency chain, as an ordered call graph

### 2.0 Stage table (producer → consumer)

| # | Producer (file:line, verified) | Output | Consumed by |
|---|---|---|---|
| 1 | `flask.Flask(__name__, subdomain_matching=True)` → `Flask.__init__` (`src/flask/app.py:226`, param at `:233`) → `App.__init__` (`src/flask/sansio/app.py:282`) | `self.url_map = Map(host_matching=False)` (`sansio/app.py:405`), `self.subdomain_matching = True` (`sansio/app.py:407`) | `Flask.create_url_adapter` (`src/flask/app.py:458`) |
| 2 | `App.make_config` (`sansio/app.py:482`) → `Config(root_path, defaults)` (`src/flask/config.py:94`) seeded from `Flask.default_config` (`src/flask/app.py:178`) | `SERVER_NAME=None` (`app.py:188`), `APPLICATION_ROOT="/"` (`:189`), `PREFERRED_URL_SCHEME="http"` (`:205`) | read by `EnvironBuilder.__init__` and `create_url_adapter` |
| 3 | test lines 119–120: two plain dict writes | `SERVER_NAME="example.com:1234"`, `APPLICATION_ROOT="/foo"` | same as #2 |
| 4 | `Blueprint("company", __name__, subdomain="xxx")` → `Blueprint.__init__` (`sansio/blueprints.py:174`) | `self.subdomain = "xxx"` (`:203`), `self.deferred_functions = []` | `BlueprintSetupState.__init__` (`:64–70`) |
| 5 | `@bp.route("/")` → `Scaffold.route` (`sansio/scaffold.py:336`) → `Blueprint.add_url_rule` (`sansio/blueprints.py:413`) → `self.record(lambda s: s.add_url_rule(...))` (`:433`) → `record` (`:224`) → `self.deferred_functions.append(func)` (`:230`) | one deferred function; **nothing touches the app yet** | `Blueprint.register` replay (`:334–335`) |
| 6 | `app.register_blueprint(bp)` → `App.register_blueprint` (`sansio/app.py:570`) → `blueprint.register(self, options)` (`:595`) | `app.blueprints["company"]=bp`, `_got_registered_once=True` (`blueprints.py:320`), replay (`:334–335`) | `BlueprintSetupState.add_url_rule` (`:87`) |
| 7 | `BlueprintSetupState.add_url_rule` (`:87–115`) | `options.setdefault("subdomain", self.subdomain)` (`:103`) → `self.app.add_url_rule("/", "company.index", index, defaults={}, subdomain="xxx")` (`:110–114`) | `App.add_url_rule` (`sansio/app.py:605`) |
| 8 | `App.add_url_rule` | `Rule("/", endpoint="company.index", subdomain="xxx")` → `self.url_map.add(rule_obj)` (`sansio/app.py:653`), `self.view_functions["company.index"]=index` (`:661`) | `MapAdapter.match` |
| 9 | `app.test_request_context("/", subdomain="xxx")` → `Flask.test_request_context` (`src/flask/app.py:1423`) | `EnvironBuilder(self, "/", subdomain="xxx")` (`src/flask/testing.py:49`) → `builder.get_environ()` → `self.request_context(environ)` (`app.py:1475`) → `RequestContext(app, environ)` (`app.py:1421`) | `RequestContext` |
| 10 | `Flask.testing.EnvironBuilder.__init__` (`testing.py:66–79`) | `http_host = (config["SERVER_NAME"] or "localhost")` prefixed by `subdomain.` → `base_url="http://xxx.example.com:1234/foo"` → Werkzeug `base_url` setter splits it (`werkzeug/test.py:452–463`) | Werkzeug `get_environ` (`werkzeug/test.py:667`) |
| 11 | `Werkzeug EnvironBuilder.get_environ` | `HTTP_HOST="xxx.example.com:1234"` (`test.py:719`), `SERVER_NAME="xxx.example.com"` (`:717`), `SERVER_PORT="1234"`, `SCRIPT_NAME="/foo"` (`:710`), `PATH_INFO="/"`, `wsgi.url_scheme="http"` | `RequestContext.__init__` / Flask `create_url_adapter` |
| 12 | `RequestContext.__init__` (`src/flask/ctx.py:309`) | `request = app.request_class(environ)` (`:318`), `self.url_adapter = app.create_url_adapter(self.request)` (`:323`) | `push()` |
| 13 | `Flask.create_url_adapter(request)` (`app.py:425`) | `server_name = self.config["SERVER_NAME"]` (`:452`); `elif not self.subdomain_matching:` (`:458`) is **skipped**, so `subdomain` stays `None`; `self.url_map.bind_to_environ(environ, server_name="example.com:1234", subdomain=None)` (`:464`) | Werkzeug `Map.bind_to_environ` |
| 14 | `Map.bind_to_environ` (`werkzeug/routing/map.py:252`) | splits `HTTP_HOST` vs the passed `server_name` → `subdomain = "xxx"`; returns `MapAdapter(..., subdomain="xxx")` (`:405`) | `MapAdapter.match` |
| 15 | `RequestContext.push()` (`ctx.py:367`) | pushes `AppContext` (whose own adapter comes from the **no-request** branch, `create_url_adapter(None)` → `ctx.py:247`), `_cv_request.set(self)` (`:378`), then `self.match_request()` (`:394`) | `match_request` |
| 16 | `RequestContext.match_request` (`ctx.py:357`) | `self.url_adapter.match(return_rule=True)` (`:362`) → with `domain_part = self.subdomain` = `"xxx"` (`map.py:600`) → `self.request.url_rule, self.request.view_args = result` (`:363`) | `request.endpoint` / `.blueprint` |
| 17 | `Request.endpoint`/`.blueprint` (`src/flask/wrappers.py:147/162`) | `url_rule.endpoint` = `"company.index"` → `endpoint.rpartition(".")[0]` = `"company"` (`:176`) | test line 135 |
| 18 | mirror path: `client.get("/", subdomain="xxx")` → `FlaskClient.open` (`testing.py:204`) → `_request_from_builder_args` (`:193`) → `EnvironBuilder(self.application, "/", subdomain="xxx")` (`:197`) | same builder path as #10–11 | `Flask.wsgi_app` (`app.py:1479`) → `ctx.push()` (`:1510`) → `full_dispatch_request` (`:904`) → `dispatch_request` (`:879`) → view returns `flask.request.url` |

### 2.1 Config axis — verified anchors

`Flask.default_config` (`src/flask/app.py:178–210`; keys pinned by grep at `:188/:189/:205`):

```python
178:     default_config = ImmutableDict(
179:         {
...
187:             "TRUSTED_HOSTS": None,
188:             "SERVER_NAME": None,
189:             "APPLICATION_ROOT": "/",
...
205:             "PREFERRED_URL_SCHEME": "http",
...
208:             "PROVIDE_AUTOMATIC_OPTIONS": True,
209:         }
210:     )
```

`App.__init__` — the two attributes the whole chain turns on (`src/flask/sansio/app.py:282–411`):

```python
282:     def __init__(   (signature params at 288–289: host_matching=False, subdomain_matching=False)
...
319:         self.config = self.make_config(instance_relative_config)
...
377:         self.blueprints: dict[str, Blueprint] = {}
...
405:         self.url_map = self.url_map_class(host_matching=host_matching)
406: 
407:         self.subdomain_matching = subdomain_matching
408: 
409:         # tracks internally if the application already handled at least one
410:         # request.
411:         self._got_first_request = False
```

Class attributes: `sansio/app.py:196 config_class = Config`, `:257 url_rule_class = Rule`, `:263 url_map_class = Map`.

`App.make_config` (`src/flask/sansio/app.py:482`):

```python
482:     def make_config(self, instance_relative: bool = False) -> Config:
...
493:             root_path = self.instance_path
494:         defaults = dict(self.default_config)
495:         defaults["DEBUG"] = get_debug_flag()
496:         return self.config_class(root_path, defaults)
```

`Config` (`src/flask/config.py:50`, `__init__` at `:94`) — and negative fact (ii):

```python
 49: class Config(dict):  # type: ignore[type-arg]
 50:     """Works exactly like a dict but provides ways to fill it from files
...
 92:     """
 93: 
 94:     def __init__(
 95:         self,
 96:         root_path: str | os.PathLike[str],
 97:         defaults: dict[str, t.Any] | None = None,
 98:     ) -> None:
 99:         super().__init__(defaults or {})
100:         self.root_path = root_path
```

Preceded by the descriptor used only for **attribute** access (`src/flask/config.py:46–47`), which does not affect `obj.config[...]`:

```python
46:     def __set__(self, obj: App, value: t.Any) -> None:
47:         obj.config[self.__name__] = value
```

**Negative fact (ii) CONFIRMED at runtime** — `Config` adds no `__setitem__`/`__getitem__`:

```
Config.__setitem__ is dict.__setitem__ : True
Config.__getitem__ is dict.__getitem__ : True
Config.__setattr__ is object.__setattr__: True
Config has __getattr__ : False
Map().default_subdomain = ''
Flask app url_map class/ctor kwargs -> default_subdomain = '' Map False
EXIT=0
```

So `app.config["SERVER_NAME"] = "example.com:1234"` (test line 119) is a **plain dict write**, read back later by value. That is precisely why write *order* matters (control **N**).

**Where the three keys are read back** (all after the writes) — grep over `src/flask`:

- `src/flask/testing.py:66–67` — `http_host = app.config.get("SERVER_NAME") or "localhost"`, `app_root = app.config["APPLICATION_ROOT"]`
- `src/flask/app.py:452` — `server_name = self.config["SERVER_NAME"]` (in `create_url_adapter`)
- `src/flask/app.py:469–473` — the **no-request** branch (`Map.bind`, used by `AppContext.url_adapter`)
- `src/flask/app.py:634` — `server_name = self.config.get("SERVER_NAME")` (`Flask.run`)
- `src/flask/sessions.py:207` — `SESSION_COOKIE_PATH or APPLICATION_ROOT` (unrelated to routing)

`Flask.create_url_adapter` — **the place `subdomain_matching` becomes decisive** (`src/flask/app.py:425`; body lines verified by grep at `:452`, `:458`, `:462`, `:464`):

```python
425:     def create_url_adapter(self, request: Request | None) -> MapAdapter | None:
...
430:         .. versionchanged:: 3.1
431:             If :data:`SERVER_NAME` is set, it does not restrict requests to
432:             only that domain, for both ``subdomain_matching`` and
433:             ``host_matching``.
434: 
435:         .. versionchanged:: 1.0
436:             :data:`SERVER_NAME` no longer implicitly enables subdomain
437:             matching. Use :attr:`subdomain_matching` instead.
...
449:         if request is not None:
450:             if (trusted_hosts := self.config["TRUSTED_HOSTS"]) is not None:
451:                 request.trusted_hosts = trusted_hosts
452: 
453:             # Check trusted_hosts here until bind_to_environ does.
454:             request.host = get_host(request.environ, request.trusted_hosts)  # pyright: ignore
455:             subdomain = None
456:             server_name = self.config["SERVER_NAME"]   ← verified at line 452
457: 
458:             if self.url_map.host_matching:
459:                 # Don't pass SERVER_NAME, otherwise it's used and the actual
460:                 # host is ignored, which breaks host matching.
461:                 server_name = None
462:             elif not self.subdomain_matching:
463:                 # Werkzeug doesn't implement subdomain matching yet. Until then,
464:                 # disable it by forcing the current subdomain to the default, or
465:                 # the empty string.
466:                 subdomain = self.url_map.default_subdomain or ""
467: 
468:             return self.url_map.bind_to_environ(
469:                 request.environ, server_name=server_name, subdomain=subdomain
470:             )
471: 
472:         # Need at least SERVER_NAME to match/build outside a request.
473:         if self.config["SERVER_NAME"] is not None:
474:             return self.url_map.bind(
475:                 self.config["SERVER_NAME"],
476:                 script_name=self.config["APPLICATION_ROOT"],
477:                 url_scheme=self.config["PREFERRED_URL_SCHEME"],
478:             )
479: 
480:         return None
```

> The quoted docstring body above is verbatim from the evidence; the *line numbers* of the three decisive statements are the grep-verified ones — `app.py:452 server_name = self.config["SERVER_NAME"]`, `app.py:458 elif not self.subdomain_matching:`, `app.py:462 subdomain = self.url_map.default_subdomain or ""`, `app.py:464 return self.url_map.bind_to_environ(` (see §7 for the reconciliation, and the runtime traceback in §5.4 which independently lands on `app.py:464`).

### 2.2 Registration axis — verified anchors

`setupmethod` (`src/flask/sansio/scaffold.py:42–49`) — the lock that orders registration before the first request:

```python
42: def setupmethod(f: F) -> F:
43:     f_name = f.__name__
44: 
45:     def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
46:         self._check_setup_finished(f_name)
47:         return f(self, *args, **kwargs)
48: 
49:     return t.cast(F, update_wrapper(wrapper_func, f))
```

`Scaffold._check_setup_finished` is abstract (`scaffold.py:220–221` → `raise NotImplementedError`).

`Scaffold.route` (`src/flask/sansio/scaffold.py:336`):

```python
335:     @setupmethod
336:     def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
...
357:         def decorator(f: T_route) -> T_route:
358:             endpoint = options.pop("endpoint", None)
359:             self.add_url_rule(rule, endpoint, f, **options)
360:             return f
361: 
362:         return decorator
```

`_endpoint_from_view_func` (`src/flask/sansio/scaffold.py:701`):

```python
701: def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
702:     """Internal helper that returns the default endpoint for a given
703:     function.  This always is the function name.
704:     """
705:     assert view_func is not None, "expected view func if endpoint is not provided."
706:     return view_func.__name__
```

`Blueprint.__init__` stores the subdomain (`src/flask/sansio/blueprints.py:174`; `self.subdomain = subdomain` grep-verified at `:203`):

```python
174:     def __init__(
175:         self,
176:         name: str,
177:         import_name: str,
...
182:         subdomain: str | None = None,
...
185:         cli_group: str | None = _sentinel,  # type: ignore[assignment]
186:     ):
187:         super().__init__(
188:             import_name=import_name,
...
191:         )
192: 
193:         if not name:
194:             raise ValueError("'name' may not be empty.")
195: 
196:         if "." in name:
197:             raise ValueError("'name' may not contain a dot '.' character.")
198: 
199:         self.name = name
200:         self.url_prefix = url_prefix
201:         self.subdomain = subdomain      ← grep: blueprints.py:203
202:         self.deferred_functions: list[DeferredSetupFunction] = []
...
209:         self.cli_group = cli_group
210:         self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
```

`blueprints.py:172 _got_registered_once = False`; `:213–221 _check_setup_finished`:

```python
213:     def _check_setup_finished(self, f_name: str) -> None:
214:         if self._got_registered_once:
215:             raise AssertionError(
216:                 f"The setup method '{f_name}' can no longer be called on the blueprint"
217:                 f" '{self.name}'. It has already been registered at least once, any"
218:                 " changes will not be applied consistently.\n"
219:                 "Make sure all imports, decorators, functions, etc. needed to set up"
220:                 " the blueprint are done before registering it."
221:             )
```

`Blueprint.add_url_rule` → `record(...)` — **nothing touches the app yet** (`src/flask/sansio/blueprints.py:413`, `self.record(` grep-verified at `:433`):

```python
412:     @setupmethod
413:     def add_url_rule(
414:         self,
415:         rule: str,
416:         endpoint: str | None = None,
417:         view_func: ft.RouteCallable | None = None,
418:         provide_automatic_options: bool | None = None,
419:         **options: t.Any,
420:     ) -> None:
...
426:         if endpoint and "." in endpoint:
427:             raise ValueError("'endpoint' may not contain a dot '.' character.")
428: 
429:         if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
430:             raise ValueError("'view_func' name may not contain a dot '.' character.")
431: 
432:         self.record(
433:             lambda s: s.add_url_rule(
434:                 rule,
435:                 endpoint,
436:                 view_func,
437:                 provide_automatic_options=provide_automatic_options,
438:                 **options,
439:             )
440:         )
```

`Blueprint.record` (`src/flask/sansio/blueprints.py:224`; append grep-verified at `:230`):

```python
223:     @setupmethod
224:     def record(self, func: DeferredSetupFunction) -> None:
...
229:         self.deferred_functions.append(func)   ← grep: blueprints.py:230
```

`make_setup_state` (`src/flask/sansio/blueprints.py:246`):

```python
246:     def make_setup_state(
247:         self, app: App, options: dict[str, t.Any], first_registration: bool = False
248:     ) -> BlueprintSetupState:
...
252:         return BlueprintSetupState(self, app, options, first_registration)
```

`BlueprintSetupState.__init__` + `add_url_rule` — **the two-step `setdefault` that carries `"xxx"` to the router** (`src/flask/sansio/blueprints.py:41`, `:87`; the four key lines grep-verified at `:64`, `:66`, `:70`, `:103`, `:110`, `:112`):

```python
 41:     def __init__(
 42:         self,
 43:         blueprint: Blueprint,
 44:         app: App,
 45:         options: t.Any,
 46:         first_registration: bool,
 47:     ) -> None:
...
 61:         self.first_registration = first_registration
 62: 
 63:         subdomain = self.options.get("subdomain")
 64:         if subdomain is None:
 65:             subdomain = self.blueprint.subdomain
 66: 
 67:         #: The subdomain that the blueprint should be active for, ``None``
 68:         #: otherwise.
 69:         self.subdomain = subdomain
 70: 
 71:         url_prefix = self.options.get("url_prefix")
 72:         if url_prefix is None:
 73:             url_prefix = self.blueprint.url_prefix
...
 88:         self.url_defaults = dict(self.blueprint.url_values_defaults)
 89:         self.url_defaults.update(self.options.get("url_defaults", ()))
 90: 
 91:     def add_url_rule(
 92:         self,
 93:         rule: str,
 94:         endpoint: str | None = None,
 95:         view_func: ft.RouteCallable | None = None,
 96:         **options: t.Any,
 97:     ) -> None:
...
102:         if self.url_prefix is not None:
103:             if rule:
104:                 rule = "/".join((self.url_prefix.rstrip("/"), rule.lstrip("/")))
105:             else:
106:                 rule = self.url_prefix
107:         options.setdefault("subdomain", self.subdomain)
108:         if endpoint is None:
109:             endpoint = _endpoint_from_view_func(view_func)
110:         defaults = self.url_defaults
111:         if "defaults" in options:
112:             defaults = dict(defaults, **options.pop("defaults"))
113: 
114:         self.app.add_url_rule(
115:             rule,
116:             f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."),
117:             view_func,
118:             defaults=defaults,
119:             **options,
120:         )
```

Grep-verified for this revision (authoritative):

```
blueprints.py:64:         subdomain = self.options.get("subdomain")
blueprints.py:66:             subdomain = self.blueprint.subdomain
blueprints.py:70:         self.subdomain = subdomain
blueprints.py:103:         options.setdefault("subdomain", self.subdomain)
blueprints.py:105:             endpoint = _endpoint_from_view_func(view_func)  # type: ignore
blueprints.py:106:         defaults = self.url_defaults
blueprints.py:112:             f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."),
blueprints.py:110:         self.app.add_url_rule(
blueprints.py:87:     def add_url_rule(
```
…and the `read`-tool window above is offset by 3–4 lines relative to grep for this block (see §7).

`Blueprint.register` — the replay (`src/flask/sansio/blueprints.py:273`; key lines grep-verified at `:320`, `:321`, `:334`, `:335`):

```python
273:     def register(self, app: App, options: dict[str, t.Any]) -> None:
...
296:         name_prefix = options.get("name_prefix", "")
297:         self_name = options.get("name", self.name)
298:         name = f"{name_prefix}.{self_name}".lstrip(".")
299: 
300:         if name in app.blueprints:
301:             bp_desc = "this" if app.blueprints[name] is self else "a different"
302:             existing_at = f" '{name}'" if self_name != name else ""
303: 
304:             raise ValueError(
305:                 f"The name '{self_name}' is already registered for"
306:                 f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
307:                 f" provide a unique name."
308:             )
309: 
310:         first_bp_registration = not any(bp is self for bp in app.blueprints.values())
311:         first_name_registration = name not in app.blueprints
312: 
313:         app.blueprints[name] = self
314:         self._got_registered_once = True
315:         state = self.make_setup_state(app, options, first_bp_registration)
316: 
317:         if self.has_static_folder:
318:             state.add_url_rule(
319:                 f"{self.static_url_path}/<path:filename>",
320:                 view_func=self.send_static_file,  # type: ignore[attr-defined]
321:                 endpoint="static",
322:             )
323: 
324:         # Merge blueprint data into parent.
325:         if first_bp_registration or first_name_registration:
326:             self._merge_blueprint_funcs(app, name)
327: 
328:         for deferred in self.deferred_functions:
329:             deferred(state)
...
351:         for blueprint, bp_options in self._blueprints:
352:             bp_options = bp_options.copy()
353:             bp_url_prefix = bp_options.get("url_prefix")
354:             bp_subdomain = bp_options.get("subdomain")
355: 
356:             if bp_subdomain is None:
357:                 bp_subdomain = blueprint.subdomain
358: 
359:             if state.subdomain is not None and bp_subdomain is not None:
360:                 bp_options["subdomain"] = bp_subdomain + "." + state.subdomain
361:             elif bp_subdomain is not None:
362:                 bp_options["subdomain"] = bp_subdomain
363:             elif state.subdomain is not None:
364:                 bp_options["subdomain"] = state.subdomain
...
373:             bp_options["name_prefix"] = name
374:             blueprint.register(app, bp_options)
```

Grep-verified (authoritative for this revision): `blueprints.py:320: self._got_registered_once = True`, `:321: state = self.make_setup_state(app, options, first_bp_registration)`, `:334: for deferred in self.deferred_functions:`, `:335: deferred(state)`. The nesting-merge block is quoted verbatim but its `for`/`if` line numbers in the read window sit ~7 lines above the greps.

`App.register_blueprint` (`src/flask/sansio/app.py:570`; the single call grep-verified at `:595`):

```python
569:     @setupmethod
570:     def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
...
582:         :param subdomain: Blueprint routes will match on this subdomain.
...
597:         blueprint.register(self, options)   ← grep: sansio/app.py:595
```

`App.add_url_rule` — `Rule` construction, `url_map.add`, `view_functions[endpoint]` (`src/flask/sansio/app.py:605`; grep-verified `:653` and `:661`):

```python
604:     @setupmethod
605:     def add_url_rule(
606:         self,
607:         rule: str,
608:         endpoint: str | None = None,
609:         view_func: ft.RouteCallable | None = None,
610:         provide_automatic_options: bool | None = None,
611:         **options: t.Any,
612:     ) -> None:
613:         if endpoint is None:
614:             endpoint = _endpoint_from_view_func(view_func)  # type: ignore
615:         options["endpoint"] = endpoint
616:         methods = options.pop("methods", None)
...
648:         rule_obj = self.url_rule_class(rule, methods=methods, **options)
649:         rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
650: 
651:         self.url_map.add(rule_obj)
652:         if view_func is not None:
653:             old_func = self.view_functions.get(endpoint)
654:             if old_func is not None and old_func != view_func:
655:                 raise AssertionError(
656:                     "View function mapping is overwriting an existing"
657:                     f" endpoint function: {endpoint}"
658:                 )
659:             self.view_functions[endpoint] = view_func
```
(grep: `sansio/app.py:653: self.url_map.add(rule_obj)`, `sansio/app.py:661: self.view_functions[endpoint] = view_func`.)

Note the static rule added by `Flask.__init__` (`src/flask/app.py:267–281`) carries `host=static_host` (= `None`) and **no `subdomain`**, so it becomes a `""`-subdomain rule — confirmed at runtime by probe rows **C** and **D**.

`App._check_setup_finished` — the "no changes after first request" rule behind control **O** (`src/flask/sansio/app.py:413`):

```python
413:     def _check_setup_finished(self, f_name: str) -> None:
414:         if self._got_first_request:
415:             raise AssertionError(
416:                 f"The setup method '{f_name}' can no longer be called"
417:                 " on the application. It has already handled its first"
418:                 " request, any changes will not be applied"
419:                 " consistently.\n"
420:                 "Make sure all imports, decorators, functions, etc."
421:                 " needed to set up the application are done before"
422:                 " running it."
423:             )
```
and `src/flask/app.py:911` (inside `full_dispatch_request`, def at `:904`): `self._got_first_request = True` (grep-verified at 911; the retriever's read window said 915).

### 2.3 Request-context axis — verified anchors

`Flask.test_client` (`src/flask/app.py:669`):

```python
669:     def test_client(self, use_cookies: bool = True, **kwargs: t.Any) -> FlaskClient:
...
723:         cls = self.test_client_class
724:         if cls is None:
725:             from .testing import FlaskClient as cls
726:         return cls(  # type: ignore
727:             self, self.response_class, use_cookies=use_cookies, **kwargs
728:         )
```

`Flask.testing.EnvironBuilder` — the config→URL→environ bridge (`src/flask/testing.py:27`, `__init__` at `:49`; key lines grep-verified `:66`, `:67`, `:70`, `:73`, `:76`):

```python
27: class EnvironBuilder(werkzeug.test.EnvironBuilder):
28:     """An :class:`~werkzeug.test.EnvironBuilder`, that takes defaults from the
29:     application.
30: 
31:     :param app: The Flask application to configure the environment from.
32:     :param path: URL path being requested.
33:     :param base_url: Base URL where the app is being served, which
34:         ``path`` is relative to. If not given, built from
35:         :data:`PREFERRED_URL_SCHEME`, ``subdomain``,
36:         :data:`SERVER_NAME`, and :data:`APPLICATION_ROOT`.
37:     :param subdomain: Subdomain name to append to :data:`SERVER_NAME`.
...
49:     def __init__(
50:         self,
51:         app: Flask,
52:         path: str = "/",
53:         base_url: str | None = None,
54:         subdomain: str | None = None,
55:         url_scheme: str | None = None,
56:         *args: t.Any,
57:         **kwargs: t.Any,
58:     ) -> None:
59:         assert not (base_url or subdomain or url_scheme) or (
60:             base_url is not None
61:         ) != bool(subdomain or url_scheme), (
62:             'Cannot pass "subdomain" or "url_scheme" with "base_url".'
63:         )
64: 
65:         if base_url is None:
66:             http_host = app.config.get("SERVER_NAME") or "localhost"
67:             app_root = app.config["APPLICATION_ROOT"]
68: 
69:             if subdomain:
70:                 http_host = f"{subdomain}.{http_host}"
71: 
72:             if url_scheme is None:
73:                 url_scheme = app.config["PREFERRED_URL_SCHEME"]
74: 
75:             url = urlsplit(path)
76:             base_url = (
77:                 f"{url.scheme or url_scheme}://{url.netloc or http_host}"
78:                 f"/{app_root.lstrip('/')}"
79:             )
80:             path = url.path
81: 
82:             if url.query:
83:                 path = f"{path}?{url.query}"
84: 
85:         self.app = app
86:         super().__init__(path, base_url, *args, **kwargs)
```

⇒ with `SERVER_NAME="example.com:1234"`, `APPLICATION_ROOT="/foo"`, `subdomain="xxx"`: `http_host="xxx.example.com:1234"`, `url_scheme="http"`, `base_url="http://xxx.example.com:1234/foo"`. Two subtleties: `app_root.lstrip('/')` turns `"/foo"` into `"foo"` re-joined after a literal `/`; and the `assert` at `:59–63` forbids passing `base_url` together with `subdomain`.

`FlaskClient` mirror path (`src/flask/testing.py:109`, `:125`, `:193`, `:204`):

```python
109: class FlaskClient(Client):
...
125:     def __init__(self, *args: t.Any, **kwargs: t.Any) -> None:
126:         super().__init__(*args, **kwargs)
127:         self.preserve_context = False
128:         self._new_contexts: list[t.ContextManager[t.Any]] = []
129:         self._context_stack = ExitStack()
130:         self.environ_base = {
131:             "REMOTE_ADDR": "127.0.0.1",
132:             "HTTP_USER_AGENT": f"Werkzeug/{_get_werkzeug_version()}",
133:         }
...
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
203: 
204:     def open(
205:         self,
206:         *args: t.Any,
207:         buffered: bool = False,
208:         follow_redirects: bool = False,
209:         **kwargs: t.Any,
210:     ) -> TestResponse:
211:         if args and isinstance(
212:             args[0], (werkzeug.test.EnvironBuilder, dict, BaseRequest)
213:         ):
...
219:         else:
220:             # request is None
221:             request = self._request_from_builder_args(args, kwargs)
222: 
223:         # Pop any previously preserved contexts. This prevents contexts
224:         # from being preserved across redirects or multiple requests
225:         # within a single block.
226:         self._context_stack.close()
227: 
228:         response = super().open(
229:             request,
230:             buffered=buffered,
231:             follow_redirects=follow_redirects,
232:         )
```

`Flask.request_context` / `Flask.test_request_context` (`src/flask/app.py:1407`, `:1423`; bodies grep-verified at `:1421` and `:1475`):

```python
1407:     def request_context(self, environ: WSGIEnvironment) -> RequestContext:
...
1417:         """
1418:         return RequestContext(self, environ)         ← grep: app.py:1421

1423:     def test_request_context(self, *args: t.Any, **kwargs: t.Any) -> RequestContext:
...
1452:         :param path: URL path being requested.
1453:         :param base_url: Base URL where the app is being served, which
1454:             ``path`` is relative to. If not given, built from
1455:             :data:`PREFERRED_URL_SCHEME`, ``subdomain``,
1456:             :data:`SERVER_NAME`, and :data:`APPLICATION_ROOT`.
1457:         :param subdomain: Subdomain name to append to
1458:             :data:`SERVER_NAME`.
...
1473:         from .testing import EnvironBuilder
1474: 
1475:         builder = EnvironBuilder(self, *args, **kwargs)
1476: 
1477:         try:
1478:             return self.request_context(builder.get_environ())   ← grep: app.py:1475
1479:         finally:
1480:             builder.close()
```

`AppContext` (`src/flask/ctx.py:238`; `url_adapter` grep-verified at `:247`, `push` at `:251`, `__enter__` at `:274`):

```python
238: class AppContext:
...
245:     def __init__(self, app: Flask) -> None:
246:         self.app = app
247:         self.url_adapter = app.create_url_adapter(None)
248:         self.g: _AppCtxGlobals = app.app_ctx_globals_class()
249:         self._cv_tokens: list[contextvars.Token[AppContext]] = []
250: 
251:     def push(self) -> None:
252:         """Binds the app context to the current context."""
253:         self._cv_tokens.append(_cv_app.set(self))
254:         appcontext_pushed.send(self.app, _async_wrapper=self.app.ensure_sync)
...
274:     def __enter__(self) -> AppContext:
275:         self.push()
276:         return self
```

`RequestContext.__init__` / `match_request` / `push` / `__enter__` (`src/flask/ctx.py:287`; all four key lines grep-verified at `:323`, `:362`, `:363`, `:394`, `:367`, `:433`):

```python
287: class RequestContext:
...
309:     def __init__(
310:         self,
311:         app: Flask,
312:         environ: WSGIEnvironment,
313:         request: Request | None = None,
314:         session: SessionMixin | None = None,
315:     ) -> None:
316:         self.app = app
317:         if request is None:
318:             request = app.request_class(environ)
319:             request.json_module = app.json
320:         self.request: Request = request
321:         self.url_adapter = None
322:         try:
323:             self.url_adapter = app.create_url_adapter(self.request)
324:         except HTTPException as e:
325:             self.request.routing_exception = e
326:         self.flashes: list[tuple[str, str]] | None = None
327:         self.session: SessionMixin | None = session
...
337:     def copy(self) -> RequestContext:
...
357:     def match_request(self) -> None:
358:         """Can be overridden by a subclass to hook into the matching
359:         of the request.
360:         """
361:         try:
362:             result = self.url_adapter.match(return_rule=True)  # type: ignore
363:             self.request.url_rule, self.request.view_args = result  # type: ignore
364:         except HTTPException as e:
365:             self.request.routing_exception = e
366: 
367:     def push(self) -> None:
368:         # Before we push the request context we have to ensure that there
369:         # is an application context.
370:         app_ctx = _cv_app.get(None)
371: 
372:         if app_ctx is None or app_ctx.app is not self.app:
373:             app_ctx = self.app.app_context()
374:             app_ctx.push()
375:         else:
376:             app_ctx = None
377: 
378:         self._cv_tokens.append((_cv_request.set(self), app_ctx))
379: 
380:         # Open the session at the moment that the request context is available.
381:         # This allows a custom open_session method to use the request context.
382:         # Only open a new session if this is the first time the request was
383:         # pushed, otherwise stream_with_context loses the session.
384:         if self.session is None:
385:             session_interface = self.app.session_interface
386:             self.session = session_interface.open_session(self.app, self.request)
387: 
388:             if self.session is None:
389:                 self.session = session_interface.make_null_session(self.app)
390: 
391:         # Match the request URL after loading the session, so that the
392:         # session is available in custom URL converters.
393:         if self.url_adapter is not None:
394:             self.match_request()
...
433:     def __enter__(self) -> RequestContext:
434:         self.push()
435:         return self
```

This is the direct evidence for the **pre-`push()` there is no `url_rule`** claim: `match_request()` is invoked **only** from `push()` (`ctx.py:394`), while `__init__` merely builds the adapter (`ctx.py:323`).

`dispatch_request` (`src/flask/app.py:879`) and `wsgi_app` (`:1479`, `ctx.push()` grep-verified at `:1510`):

```python
879:     def dispatch_request(self) -> ft.ResponseReturnValue:
...
891:         req = request_ctx.request
892:         if req.routing_exception is not None:
893:             self.raise_routing_exception(req)
894:         rule: Rule = req.url_rule  # type: ignore[assignment]
...
901:         view_args: dict[str, t.Any] = req.view_args  # type: ignore[assignment]
902:         return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)
```
```python
1479:     def wsgi_app(
1480:         self, environ: WSGIEnvironment, start_response: StartResponse
1481:     ) -> cabc.Iterable[bytes]:
...
1510:         ctx = self.request_context(environ)
1511:         error: BaseException | None = None
1512:         try:
1513:             try:
1514:                 ctx.push()
1515:                 response = self.full_dispatch_request()
1516:             except Exception as e:
1517:                 error = e
1518:                 response = self.handle_exception(e)
...
1533:         return self.wsgi_app(environ, start_response)
```

### 2.4 Read side of the assertions

`Request.endpoint` / `.blueprint` / `.blueprints` (`src/flask/wrappers.py:147`, `:162`, `:181`; `rpartition` grep-verified at `:176`):

```python
146:     @property
147:     def endpoint(self) -> str | None:
148:         """The endpoint that matched the request URL.
149: 
150:         This will be ``None`` if matching failed or has not been
151:         performed yet.
...
157:         if self.url_rule is not None:
158:             return self.url_rule.endpoint  # type: ignore[no-any-return]
159: 
160:         return None
161: 
162:     @property
163:     def blueprint(self) -> str | None:
164:         """The registered name of the current blueprint.
165: 
166:         This will be ``None`` if the endpoint is not part of a
167:         blueprint, or if URL matching failed or has not been performed
168:         yet.
...
173:         endpoint = self.endpoint
174: 
175:         if endpoint is not None and "." in endpoint:
176:             return endpoint.rpartition(".")[0]
177: 
178:         return None
179: 
180:     @property
181:     def blueprints(self) -> list[str]:
...
190:         name = self.blueprint
191: 
192:         if name is None:
193:             return []
194: 
195:         return _split_blueprint_path(name)
```

`ContextVar` proxies (`src/flask/globals.py:42–49`; grep-verified `:42`, `:43`, `:46`):

```python
34: g: _AppCtxGlobals = LocalProxy(  # type: ignore[assignment]
35:     _cv_app, "g", unbound_message=_no_app_msg
...
38: _no_req_msg = """\
39: Working outside of request context.
...
42: "
43: _cv_request: ContextVar[RequestContext] = ContextVar("flask.request_ctx")
44: request_ctx: RequestContext = LocalProxy(  # type: ignore[assignment]
45:     _cv_request, unbound_message=_no_req_msg
46: )
47: request: Request = LocalProxy(  # type: ignore[assignment]
48:     _cv_request, "request", unbound_message=_no_req_msg
49: )
```
(grep: `globals.py:42: _cv_request: ContextVar[RequestContext] = ContextVar("flask.request_ctx")`, `:43: request_ctx`, `:46: request`.)

### 2.5 The two assertions, one line each

**Assertion 1 — `ctx.request.url == "http://xxx.example.com:1234/foo/"`** (test line 132, *outside* the `with`) is produced by `get_current_url(scheme, host, root_path, path)` (`werkzeug/sansio/utils.py:105`) with `scheme="http"`, `host="xxx.example.com:1234"`, `root_path="/foo"`, `path="/"`:

```python
105: def get_current_url(
106:     scheme: str,
107:     host: str,
108:     root_path: str | None = None,
109:     path: str | None = None,
110:     query_string: bytes | None = None,
111: ) -> str:
...
125:     url = [scheme, "://", host]
126: 
127:     if root_path is None:
128:         url.append("/")
129:         return uri_to_iri("".join(url))
130: 
131:     # safe = https://url.spec.whatwg.org/#url-path-segment-string
132:     # as well as percent for things that are already quoted
133:     url.append(quote(root_path.rstrip("/"), safe="!$&'()*+,/:;=@%"))
134:     url.append("/")
135: 
136:     if path is None:
137:         return uri_to_iri("".join(url))
138: 
139:     url.append(quote(path.lstrip("/"), safe="!$&'()*+,/:;=@%"))
...
145:     return uri_to_iri("".join(url))
```

⇒ `"http" + "://" + "xxx.example.com:1234" + "/" + "foo" + "/"` = `http://xxx.example.com:1234/foo/`, exactly the literal in line 132. The host comes from `Request.host` (`werkzeug/sansio/request.py:222–229`) → `get_host(scheme, headers.get("host"), server, trusted_hosts)` (`werkzeug/sansio/utils.py:49–98`), which prefers the `Host:` header (`HTTP_HOST="xxx.example.com:1234"`) and strips only `:80`/`:443`. `root_path`/`path` come from `werkzeug/wrappers/request.py:113–133` + `werkzeug/sansio/request.py:135–140` (`SCRIPT_NAME`→`root_path`, `PATH_INFO`→`path`):

```python
113:     def __init__(
114:         self,
115:         environ: WSGIEnvironment,
116:         populate_request: bool = True,
117:         shallow: bool = False,
118:     ) -> None:
119:         super().__init__(
120:             method=environ.get("REQUEST_METHOD", "GET"),
121:             scheme=environ.get("wsgi.url_scheme", "http"),
122:             server=_get_server(environ),
123:             root_path=_wsgi_decoding_dance(environ.get("SCRIPT_NAME") or ""),
124:             path=_wsgi_decoding_dance(environ.get("PATH_INFO") or ""),
125:             query_string=environ.get("QUERY_STRING", "").encode("latin1"),
126:             headers=EnvironHeaders(environ),
127:             remote_addr=environ.get("REMOTE_ADDR"),
128:         )
129:         self.environ = environ
```
```python
135:         #: The prefix that the application is mounted under, without a
136:         #: trailing slash. :attr:`path` comes after this.
137:         self.root_path = root_path.rstrip("/")
138:         #: The path part of the URL after :attr:`root_path`. This is the
139:         #: path used for routing within the application.
140:         self.path = "/" + path.lstrip("/")
```
```python
205:     @cached_property
206:     def url(self) -> str:
207:         """The full request URL with the scheme, host, root path, path,
208:         and query string."""
209:         return get_current_url(
210:             self.scheme, self.host, self.root_path, self.path, self.query_string
211:         )
...
222:     @cached_property
223:     def host(self) -> str:
224:         """The host name the request was made to, including the port if
225:         it's non-standard. Validated with :attr:`trusted_hosts`.
226:         """
227:         return get_host(
228:             self.scheme, self.headers.get("host"), self.server, self.trusted_hosts
229         )
```

Because `.host`/`.url` are `cached_property` reads that need only the *environ*, this assertion holds **without** pushing the context — which is why line 132 sits before `with ctx:`.

**Assertion 2 — `ctx.request.blueprint == bp.name`** (test line 135, *inside* the `with`) is `"company"`, produced by `Request.blueprint` → `endpoint.rpartition(".")[0]` over the endpoint string `"company.index"`. That dotted endpoint is manufactured on the registration axis at `blueprints.py:112`:

```python
            f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."),
```
with `self.name_prefix = ""` and `self.name = "company"`, and `endpoint = "index"` from `_endpoint_from_view_func` (`sansio/scaffold.py:705`). It can only be read after `push()` has run `match_request()`.

### 2.6 The chain, in one linear sequence

```
flask.Flask(__name__, subdomain_matching=True)                       [app.py:226 → sansio/app.py:282]
  ├─ self.config = make_config()  {SERVER_NAME: None, APPLICATION_ROOT: "/", PREFERRED_URL_SCHEME: "http"}
  │                                                            [sansio/app.py:482 → config.py:94 ← app.py:178]
  ├─ self.url_map = Map(host_matching=False); self.subdomain_matching = True   [sansio/app.py:405, :407]
  └─ static rule added with subdomain=""                        [app.py:276 → sansio/app.py:605]

app.config["SERVER_NAME"] = "example.com:1234"    ── plain dict write ──┐   [test:119]
app.config["APPLICATION_ROOT"] = "/foo"           ── plain dict write ──┤   [test:120]
                                                                       │
flask.Blueprint("company", __name__, subdomain="xxx")  → self.subdomain │   [blueprints.py:174, :203]
  @bp.route("/") → Scaffold.route → Blueprint.add_url_rule              │   [scaffold.py:336 → blueprints.py:413]
                 → self.record(lambda s: s.add_url_rule(..., subdomain="xxx"))
                 → deferred_functions.append(...)      ← app untouched │   [blueprints.py:433 → :224, :230]
                                                                       │
app.register_blueprint(bp)                                              │   [test:129]
  → App.register_blueprint                                              │   [sansio/app.py:570]
  → Blueprint.register: app.blueprints["company"]=bp; _got_registered_once=True
                        state = make_setup_state(app, {}, first=True)   │   [blueprints.py:313, :320, :321]
      BlueprintSetupState.__init__: options.get("subdomain") → None → blueprint.subdomain = "xxx"
                                                                    → self.subdomain = "xxx"
                                                                        [blueprints.py:63–70]
      replay: for deferred in deferred_functions: deferred(state)       │   [blueprints.py:334, :335]
  → BlueprintSetupState.add_url_rule("/", "index", index, ...)          │   [blueprints.py:87]
      options.setdefault("subdomain", "xxx")     ← THE hand-off         │   [blueprints.py:103]
      self.app.add_url_rule("/", "company.index", index, defaults={}, subdomain="xxx")
                                                                        │   [blueprints.py:110–114]
  → App.add_url_rule: Rule("/", endpoint="company.index", subdomain="xxx"); url_map.add(rule);
                      view_functions["company.index"] = index          │   [sansio/app.py:648–659]
                                                                        │
ctx = app.test_request_context("/", subdomain="xxx")  ◄─────────────────┘   [test:131]
  → Flask.test_request_context → EnvironBuilder(app, "/", subdomain="xxx")  [app.py:1423, :1475]
      http_host = config["SERVER_NAME"] or "localhost" = "example.com:1234"  [testing.py:66]
      http_host = "xxx." + http_host                  = "xxx.example.com:1234"  [testing.py:70]
      url_scheme = config["PREFERRED_URL_SCHEME"]     = "http"                [testing.py:73]
      app_root   = config["APPLICATION_ROOT"]         = "/foo"                [testing.py:67]
      base_url = "http://xxx.example.com:1234/foo"                            [testing.py:76–79]
  → Werkzeug base_url setter: host="xxx.example.com:1234", script_root="/foo", url_scheme="http"
                                                                              [werkzeug/test.py:452–463]
  → builder.get_environ(): HTTP_HOST="xxx.example.com:1234", SERVER_NAME="xxx.example.com",
                           SERVER_PORT="1234", SCRIPT_NAME="/foo", PATH_INFO="/",
                           wsgi.url_scheme="http"                             [werkzeug/test.py:667–719]
  → Flask.request_context(environ) → RequestContext(self, environ)            [app.py:1421]
      request = app.request_class(environ)                                    [ctx.py:318]
      url_adapter = app.create_url_adapter(request)                           [ctx.py:323]
        server_name = config["SERVER_NAME"] = "example.com:1234"              [app.py:452]
        self.subdomain_matching is True ⇒ SKIP the `not subdomain_matching` branch  [app.py:458–462]
        url_map.bind_to_environ(environ, server_name="example.com:1234", subdomain=None)  [app.py:464]
          wsgi_server_name = "xxx.example.com:1234"; server_name = "example.com:1234"
          cur=["xxx","example","com:1234"], real=["example","com:1234"], offset=-2
          suffixes equal ⇒ subdomain = "xxx"                                  [werkzeug map.py:321–339]
          MapAdapter(server_name="example.com:1234", subdomain="xxx", script_name="/foo")  [map.py:405]

assert ctx.request.url == "http://xxx.example.com:1234/foo/"     ← works pre-push  [test:132]

with ctx:  →  RequestContext.push()                                            [ctx.py:367 ← test:134]
    app_ctx = app.app_context() → AppContext.__init__ → create_url_adapter(None)
                                 → url_map.bind(SERVER_NAME, script_name=APPLICATION_ROOT, scheme=…)
                                                                               [ctx.py:247 → app.py:473–477]
    _cv_request.set(self)                                                      [ctx.py:378]
    match_request() → url_adapter.match(return_rule=True)                      [ctx.py:394, :362]
        domain_part = self.subdomain = "xxx"  (not host_matching)              [werkzeug map.py:597–600]
        → rule("/", endpoint="company.index", subdomain="xxx") matches
        → request.url_rule = rule; request.view_args = {}                      [ctx.py:363]

    assert ctx.request.blueprint == bp.name   →  "company.index".rpartition(".")[0] == "company"  [test:135]

rv = client.get("/", subdomain="xxx")   →  FlaskClient.open → _request_from_builder_args
                                        → EnvironBuilder(...) (same path) → Client.run_wsgi_app
                                        → Flask.wsgi_app → ctx.push() → dispatch_request
                                        → view returns flask.request.url
assert rv.data == b"http://xxx.example.com:1234/foo/"                          [test:137–138]
```

---

## 3. Ordering constraints — each proven by an executed control

The phrase "dependency chain" is really a question about ordering, so here are the hard constraints with the runtime control that proves each.

### 3.1 Config writes must happen **before** the builder/context is constructed

`Config` is a plain `dict` (no lazy resolution, negative fact (ii) above), and `EnvironBuilder.__init__` snapshots `SERVER_NAME`/`APPLICATION_ROOT`/`PREFERRED_URL_SCHEME` at construction (`testing.py:66–79`). **Control N / N2** (observed):

```
N: late SERVER_NAME -> builder host/url = xxx.localhost http://xxx.localhost/
N2: same builder rebuilt after write -> host/url = xxx.example.com:1234 http://xxx.example.com:1234/
```

⇒ A write *after* the builder is built has no effect on that builder (`xxx.localhost`, i.e. the `or "localhost"` fallback); only a *newly built* builder picks up `example.com:1234`. So the dependency is on **write order**, not on any caching layer. This is why test lines 119–120 precede line 131.

### 3.2 `register_blueprint` must run **before** any matching

**Control O / O2** (observed):

```
O: before register_blueprint -> url_rule/routing_exception = None NotFound
O2: adapter subdomain = 'xxx'
```

⇒ Without the registration, the URL *still* derives `subdomain='xxx'` (that comes from config + `HTTP_HOST`, not from the blueprint) but there is **no rule** to match, so `url_rule is None` and `routing_exception` is `NotFound`. Registration supplies the **rule**, not the subdomain derivation. This is why test line 129 precedes lines 131–138.

**Control J / J2** (observed) shows matching is deferred to `push()`:

```
J: pre-push url_rule/url = None http://xxx.example.com:1234/foo/
J2: pre-push endpoint/blueprint = None None
```

⇒ The `url` works pre-push (it is a pure function of the environ), but `url_rule`, `endpoint` and `blueprint` are all `None` until `push()` → `match_request()`. **This is the single fact that explains the test's shape**: line 132 is outside `with ctx:`, line 135 is inside.

### 3.3 After the first request, the setup methods are locked

**Control P1/P2 and Q** (observed):

```
P1: app5._got_first_request = True
P2: app.add_url_rule after first request -> AssertionError: "The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, an"
Q: @bp.route after register_blueprint -> AssertionError: "The setup method 'route' can no longer be called on the blueprint 'company'. It has already been registered at least onc"
```

Source: `@setupmethod` (`sansio/scaffold.py:42–49`) → `App._check_setup_finished` (`sansio/app.py:413`, fired by `src/flask/app.py:911 self._got_first_request = True`) and `Blueprint._check_setup_finished` (`sansio/blueprints.py:213`, fired by `blueprints.py:320 self._got_registered_once = True`). Consequently `client.get(...)` at test line 137 is the *last* statement that may do setup-sensitive work — and indeed it is the last statement of the test.

### 3.4 `subdomain_matching=True` is the single switch that lets Werkzeug derive `"xxx"`

**Control M / M2 / M3 / M4** (observed):

```
M: no-subdomain-matching -> url_rule/routing_exception = None NotFound
M2: warnings = []
M3: adapter subdomain/server_name = '' 'example.com:1234'
M4: url_map.default_subdomain (app2) = ''
```

With every other input identical (same rule, same `SERVER_NAME`, same `APPLICATION_ROOT`, same `subdomain="xxx"` in the request), `subdomain_matching=False` makes `Flask.create_url_adapter` take the `elif not self.subdomain_matching:` branch (`src/flask/app.py:458`) and pass `subdomain = self.url_map.default_subdomain or "" = ""` (`:462`) instead of letting Werkzeug compute it. The adapter then reports subdomain `''` rather than `'xxx'`, and matching fails with `NotFound`.

Negative fact (i) is confirmed both statically and at runtime: `Map.__init__` sets `default_subdomain: str = ""` (`werkzeug/routing/map.py:97`, `self.default_subdomain` assigned from it) and Flask never passes `default_subdomain=` — the runtime check printed:

```
Map().default_subdomain = ''
Flask app url_map class/ctor kwargs -> default_subdomain = '' Map False
```

plus probe rows **D4**/**M4** = `''`. So `subdomain = self.url_map.default_subdomain or ""` always yields `""` for a Flask app.

**Nuance discovered at runtime (adds to, and partly corrects, the read-only risk list):** in control **M** the Werkzeug mismatch warning did **not** fire (`M2: warnings = []`), because with `subdomain_matching=False` Flask passes `subdomain=""` (not `None`), so Werkzeug's `if subdomain is None and not self.host_matching:` derivation-and-warn branch (`map.py:321–339`, warn at `:332`) is skipped entirely. The warning *does* fire — proven in §5.4 — when `subdomain_matching=True` **and** `HTTP_HOST`'s suffix disagrees with the configured `SERVER_NAME`. This matters because the suite turns warnings into errors:

```toml
  1: [project]
  2: name = "Flask"
  3: version = "3.2.0.dev"
...
107: [tool.pytest.ini_options]
108: testpaths = ["tests"]
109: filterwarnings = [
110:     "error",
111: ]
```

Hence any probe or test run **through pytest** that manufactures a `HTTP_HOST`/`SERVER_NAME` disagreement raises instead of warning; the in-repo siblings handle it explicitly (`tests/test_basic.py:1810–1812` `warnings.filterwarnings("ignore", "Current server name", UserWarning, "flask.app")`; `tests/test_basic.py:1524` `with pytest.warns()`).

### 3.5 The blueprint subdomain reaches the router through exactly one `setdefault`

Trace: `Blueprint.__init__` → `self.subdomain = "xxx"` (`blueprints.py:203`) → `BlueprintSetupState.__init__` → `subdomain = self.options.get("subdomain")` (`:64`), `if subdomain is None: subdomain = self.blueprint.subdomain` (`:66`), `self.subdomain = subdomain` (`:70`) → `BlueprintSetupState.add_url_rule` → `options.setdefault("subdomain", self.subdomain)` (`:103`) → `App.add_url_rule(..., subdomain="xxx")` (`:110–114`) → `Rule(..., subdomain="xxx")` (`sansio/app.py:648`) → `Map.add` (`:653`).

Two corollaries, both observed:
- The blueprint's `subdomain` is **only** a default: **control R** shows `register_blueprint(bp, subdomain="override-level")` wins over the blueprint-level `"bp-level"`:
  ```
  R: override wins -> [('/', 'c6.i6', 'override-level')]
  ```
  (mechanism: `BlueprintSetupState.__init__` prefers `options.get("subdomain")` at `:64`).
- `Rule.bind` only fills in `map.default_subdomain` when the rule's subdomain is `None` (`werkzeug/routing/rules.py:577–580`), so the explicit `"xxx"` survives; the auto-added static rule gets `""`. Confirmed by **C**/**D**.

### 3.6 Which single line each assertion depends on

| Test line | Assertion | Depends on (single line) |
|---|---|---|
| 132 | `ctx.request.url == "http://xxx.example.com:1234/foo/"` | `src/flask/testing.py:66–70` (config → `http_host`) + `:76–79` (`base_url`) + `werkzeug/sansio/utils.py:125–139` (`get_current_url`) — **no** dependency on registration or push |
| 135 | `ctx.request.blueprint == bp.name` | `blueprints.py:112` (dotted endpoint) **and** `ctx.py:394` (`push()` → `match_request()`) **and** `app.py:458/462/464` + `map.py:321–339` (subdomain derivation) — **no** dependency on the client |
| 138 | `rv.data == b"http://xxx.example.com:1234/foo/"` | the whole chain again, inside `wsgi_app`: `app.py:1510 ctx.push()` → `:904 full_dispatch_request` → `:879 dispatch_request` → the view returning `flask.request.url` |

---

## 4. Runtime verification — raw outputs

### 4.1 Environment / revision pins (recorded before any run)

```
$ pwd
/d/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src
$ uname -a
MINGW64_NT-10.0-26200 LAPTOP-GD72BTDF 3.6.5-22c95533.x86_64 2025-10-10 12:02 UTC x86_64 Msys
$ git rev-parse HEAD
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
$ git status -s
                       ← empty, worktree clean
$ git log -1 --format='%H %ci %s'
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642 2025-06-12 13:48:07 -0700 Merge branch 'stable'
$ .venv/Scripts/python.exe -V
Python 3.13.9
$ .venv/Scripts/python.exe -c "...importlib.metadata..."
flask file D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
flask version 3.2.0.dev0
werkzeug version 3.1.3 D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Lib\site-packages\werkzeug\__init__.py
python 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
EXIT=0
$ ls .venv
CACHEDIR.TAG  Lib  Scripts  include  pyvenv.cfg
$ ls -d .venv/bin
ls: cannot access '.venv/bin': No such file or directory
$ ls .venv/Scripts/python.exe
.venv/Scripts/python.exe
```

The venv imports **this checkout's** Flask: `.venv/Lib/site-packages/flask.pth` = `D:\...\flask-src\src`. Werkzeug is the installed, non-editable 3.1.3 tree. There is no `.venv/bin`, so the plan's bash/WSL interpreter variant does not apply. The repository is a detached checkout of upstream `d73fa1cd…` moved to `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (`.git/logs/HEAD`, the only two reflog entries):

```
0000000000000000000000000000000000000000 d73fa1cdcbd8b1465c151db8924ba58b1dd14e35 Super User <root@LAPTOP-GD72BTDF.localdomain> 1790423793 +0800	clone: from https://github.com/pallets/flask
d73fa1cdcbd8b1465c151db8924ba58b1dd14e35 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642 Super User <root@LAPTOP-GD72BTDF.localdomain> 1790423798 +0800	checkout: moving from main to 85c5d93
```

### 4.2 Target test and siblings (read-only, `-p no:cacheprovider`)

```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py -q -p no:cacheprovider -k "subdomain"
...                                                                      [100%]
3 passed, 22 deselected in 0.05s
EXIT=0
```
```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py -p no:cacheprovider -k "subdomain" -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collected 25 items / 22 deselected / 3 selected

tests\test_testing.py ...                                                [100%]

====================== 3 passed, 22 deselected in 0.04s =======================
EXIT=0
```
```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py -p no:cacheprovider --collect-only -q -k "subdomain"
tests/test_testing.py::test_blueprint_with_subdomain
tests/test_testing.py::test_subdomain
tests/test_testing.py::test_nosubdomain

3/25 tests collected (22 deselected) in 0.03s
EXIT=0
```
```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py::test_blueprint_with_subdomain tests/test_basic.py -q -p no:cacheprovider -k "subdomain or server_name_matching"
..........                                                               [100%]
10 passed, 121 deselected in 0.09s
EXIT=0
```
```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py::test_blueprint_with_subdomain -p no:cacheprovider -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 1 item

tests/test_testing.py::test_blueprint_with_subdomain PASSED              [100%]

============================== 1 passed in 0.04s ==============================
EXIT=0
```
The whole subdomain family plus every near-miss row:

```
$ .venv/Scripts/python.exe -m pytest "tests/test_testing.py::test_blueprint_with_subdomain" "tests/test_testing.py::test_subdomain" "tests/test_testing.py::test_nosubdomain" "tests/test_testing.py::test_environ_defaults_from_config" "tests/test_testing.py::test_environ_defaults" "tests/test_basic.py::test_subdomain_basic_support" "tests/test_basic.py::test_subdomain_matching" "tests/test_basic.py::test_subdomain_matching_with_ports" "tests/test_basic.py::test_subdomain_matching_other_name" "tests/test_basic.py::test_server_name_matching" "tests/test_basic.py::test_server_name_subdomain" "tests/test_blueprints.py::test_nesting_subdomains" "tests/test_blueprints.py::test_child_and_parent_subdomain" "tests/test_reqctx.py::test_proper_test_request_context" "tests/test_cli.py::TestRoutes::test_subdomain" -p no:cacheprovider -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 18 items

tests/test_testing.py::test_blueprint_with_subdomain PASSED              [  5%]
tests/test_testing.py::test_subdomain PASSED                             [ 11%]
tests/test_testing.py::test_nosubdomain PASSED                           [ 16%]
tests/test_testing.py::test_environ_defaults_from_config PASSED          [ 22%]
tests/test_testing.py::test_environ_defaults PASSED                      [ 27%]
tests/test_basic.py::test_subdomain_basic_support PASSED                 [ 33%]
tests/test_basic.py::test_subdomain_matching PASSED                      [ 38%]
tests/test_basic.py::test_subdomain_matching_with_ports PASSED           [ 44%]
tests/test_basic.py::test_subdomain_matching_other_name[False] PASSED    [ 50%]
tests/test_basic.py::test_subdomain_matching_other_name[True] PASSED     [ 55%]
tests/test_basic.py::test_server_name_matching[False-False-default-default-default] PASSED [ 61%]
tests/test_basic.py::test_server_name_matching[True-False-default-abc-<invalid>] PASSED [ 66%]
tests/test_basic.py::test_server_name_matching[False-True-default-abc-default] PASSED [ 72%]
tests/test_basic.py::test_server_name_subdomain PASSED                   [ 77%]
tests/test_blueprints.py::test_nesting_subdomains PASSED                 [ 83%]
tests/test_blueprints.py::test_child_and_parent_subdomain PASSED         [ 88%]
tests/test_reqctx.py::test_proper_test_request_context PASSED            [ 94%]
tests/test_cli.py::TestRoutes::test_subdomain PASSED                     [100%]

============================= 18 passed in 0.19s ==============================
EXIT=0
```

### 4.3 The probe (written **outside** the repo, run, then deleted)

Probe file `D:/操作系统开源大赛/_tmp_probe_subdomain.py` (exact bytes, reproduced for reproducibility):

```python
"""Temporary probe for the Step-3 dependency-chain verification.

Lives OUTSIDE the flask-src checkout on purpose (no artifacts in the repo).
Run:  <repo>/.venv/Scripts/python.exe D:/操作系统开源大赛/_tmp_probe_subdomain.py
"""

import sys
import traceback
import warnings

import flask
from flask.testing import EnvironBuilder

print("=== RUNTIME PINS ===")
import importlib.metadata as _md

print("python:", sys.version.replace("\n", " "))
print("flask :", _md.version("flask"), flask.__file__)
import werkzeug

print("werkzeug:", _md.version("werkzeug"), werkzeug.__file__)
print()

app = flask.Flask(__name__, subdomain_matching=True)
app.config["SERVER_NAME"] = "example.com:1234"
app.config["APPLICATION_ROOT"] = "/foo"
client = app.test_client()

bp = flask.Blueprint("company", __name__, subdomain="xxx")


@bp.route("/")
def index():
    return flask.request.url


print("A: bp.subdomain =", repr(bp.subdomain))  # expect 'xxx'
print("B: deferred_functions =", len(bp.deferred_functions))  # expect 1
print(
    "C: rules before register =",
    [(r.rule, r.endpoint, r.subdomain) for r in app.url_map.iter_rules()],
)

app.register_blueprint(bp)

print(
    "D: rules after register =",
    [(r.rule, r.endpoint, r.subdomain) for r in app.url_map.iter_rules()],
)
print("D2: app.blueprints =", dict(app.blueprints))
print("D3: view_functions keys =", sorted(app.view_functions))
print("D4: app.url_map.default_subdomain =", repr(app.url_map.default_subdomain))

env = EnvironBuilder(app, "/", subdomain="xxx").get_environ()
print("E: HTTP_HOST =", env["HTTP_HOST"])
print(
    "F: SERVER_NAME/SCRIPT_NAME/PATH_INFO =",
    env["SERVER_NAME"],
    env["SERVER_PORT"],
    env["SCRIPT_NAME"],
    env["PATH_INFO"],
)
print("G: wsgi.url_scheme =", env["wsgi.url_scheme"])

ctx = app.test_request_context("/", subdomain="xxx")
print(
    "H: adapter subdomain/server_name =",
    repr(ctx.url_adapter.subdomain),
    repr(ctx.url_adapter.server_name),
)
print("I: request.host/root_path =", ctx.request.host, ctx.request.root_path)
print("J: pre-push url_rule/url =", ctx.request.url_rule, ctx.request.url)
print("J2: pre-push endpoint/blueprint =", ctx.request.endpoint, ctx.request.blueprint)

with ctx:
    print(
        "K: endpoint/blueprint/url =",
        ctx.request.endpoint,
        ctx.request.blueprint,
        ctx.request.url,
    )
print("L: client.get =", client.get("/", subdomain="xxx").data)

print()
print("=== NEGATIVE CONTROLS ===")

# 1) subdomain_matching=False kills matching although rule + config unchanged
app2 = flask.Flask(__name__, subdomain_matching=False)
app2.config["SERVER_NAME"] = "example.com:1234"
app2.config["APPLICATION_ROOT"] = "/foo"
bp2 = flask.Blueprint("company", __name__, subdomain="xxx")


@bp2.route("/")
def index2():
    return "x"


app2.register_blueprint(bp2)
with warnings.catch_warnings(record=True) as w2:
    warnings.simplefilter("always")
    with app2.test_request_context("/", subdomain="xxx") as c2:
        print(
            "M: no-subdomain-matching -> url_rule/routing_exception =",
            c2.request.url_rule,
            type(c2.request.routing_exception).__name__,
        )
    print("M2: warnings =", [str(x.message) for x in w2])
with app2.test_request_context("/", subdomain="xxx") as c2b:
    print(
        "M3: adapter subdomain/server_name =",
        repr(c2b.url_adapter.subdomain),
        repr(c2b.url_adapter.server_name),
    )
print("M4: url_map.default_subdomain (app2) =", repr(app2.url_map.default_subdomain))

# 2) config must be read BEFORE the context/builder is built
app3 = flask.Flask(__name__, subdomain_matching=True)  # SERVER_NAME left unset
b3 = EnvironBuilder(app3, "/", subdomain="xxx")
app3.config["SERVER_NAME"] = "example.com:1234"  # too late for b3
print("N: late SERVER_NAME -> builder host/url =", b3.host, b3.base_url)
b3b = EnvironBuilder(app3, "/", subdomain="xxx")
print("N2: same builder rebuilt after write -> host/url =", b3b.host, b3b.base_url)

# 3) route registration must precede matching
app4 = flask.Flask(__name__, subdomain_matching=True)
app4.config["SERVER_NAME"] = "example.com:1234"
with app4.test_request_context("/", subdomain="xxx") as c4:
    print(
        "O: before register_blueprint -> url_rule/routing_exception =",
        c4.request.url_rule,
        type(c4.request.routing_exception).__name__,
    )
    print("O2: adapter subdomain =", repr(c4.url_adapter.subdomain))

print()
print("=== EXTRA ORDERING PROBES ===")

# P: setupmethod lock — after a first request, registration is forbidden
app5 = flask.Flask(__name__, subdomain_matching=True)
app5.config["SERVER_NAME"] = "example.com:1234"
c5 = app5.test_client()
c5.get("/", subdomain="xxx")  # first request -> _got_first_request = True
print("P1: app5._got_first_request =", app5._got_first_request)
try:
    app5.add_url_rule("/late", "late", lambda: "late")
    print("P2: app.add_url_rule after first request -> SUCCEEDED (unexpected)")
except AssertionError as e:
    print("P2: app.add_url_rule after first request -> AssertionError:", repr(str(e)[:120]))

# Q: blueprint lock — after register_blueprint, further @bp.route is forbidden
try:
    @bp.route("/late")
    def late():
        return "late"

    print("Q: @bp.route after register_blueprint -> SUCCEEDED (unexpected)")
except AssertionError as e:
    print("Q: @bp.route after register_blueprint -> AssertionError:", repr(str(e)[:120]))

# R: blueprint-level subdomain vs register_blueprint(subdomain=...) override
app6 = flask.Flask(__name__, subdomain_matching=True)
app6.config["SERVER_NAME"] = "example.com:1234"
bp6 = flask.Blueprint("c6", __name__, subdomain="bp-level")


@bp6.route("/")
def i6():
    return "x"


app6.register_blueprint(bp6, subdomain="override-level")
print(
    "R: override wins ->",
    [(r.rule, r.endpoint, r.subdomain) for r in app6.url_map.iter_rules() if r.endpoint != "static"],
)

# S: the exact two assertions of the target test, reproduced line by line
app7 = flask.Flask(__name__, subdomain_matching=True)
app7.config["SERVER_NAME"] = "example.com:1234"
app7.config["APPLICATION_ROOT"] = "/foo"
client7 = app7.test_client()
bp7 = flask.Blueprint("company", __name__, subdomain="xxx")


@bp7.route("/")
def index7():
    return flask.request.url


app7.register_blueprint(bp7)
ctx7 = app7.test_request_context("/", subdomain="xxx")
print("S1: ctx.request.url =", repr(ctx7.request.url))
print("S2: matches literal =", ctx7.request.url == "http://xxx.example.com:1234/foo/")
with ctx7:
    print("S3: ctx.request.blueprint =", repr(ctx7.request.blueprint), "== bp.name:", ctx7.request.blueprint == bp7.name)
rv = client7.get("/", subdomain="xxx")
print("S4: rv.data =", rv.data, "== literal:", rv.data == b"http://xxx.example.com:1234/foo/")

print()
print("=== DONE ===")
```

**Command + complete output:**

```
$ .venv/Scripts/python.exe "D:/操作系统开源大赛/_tmp_probe_subdomain.py"
=== RUNTIME PINS ===
python: 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
flask : 3.2.0.dev0 D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
werkzeug: 3.1.3 D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Lib\site-packages\werkzeug\__init__.py

A: bp.subdomain = 'xxx'
B: deferred_functions = 1
C: rules before register = [('/static/<path:filename>', 'static', '')]
D: rules after register = [('/static/<path:filename>', 'static', ''), ('/', 'company.index', 'xxx')]
D2: app.blueprints = {'company': <Blueprint 'company'>}
D3: view_functions keys = ['company.index', 'static']
D4: app.url_map.default_subdomain = ''
E: HTTP_HOST = xxx.example.com:1234
F: SERVER_NAME/SCRIPT_NAME/PATH_INFO = xxx.example.com 1234 /foo /
G: wsgi.url_scheme = http
H: adapter subdomain/server_name = 'xxx' 'example.com:1234'
I: request.host/root_path = xxx.example.com:1234 /foo
J: pre-push url_rule/url = None http://xxx.example.com:1234/foo/
J2: pre-push endpoint/blueprint = None None
K: endpoint/blueprint/url = company.index company http://xxx.example.com:1234/foo/
L: client.get = b'http://xxx.example.com:1234/foo/'

=== NEGATIVE CONTROLS ===
M: no-subdomain-matching -> url_rule/routing_exception = None NotFound
M2: warnings = []
M3: adapter subdomain/server_name = '' 'example.com:1234'
M4: url_map.default_subdomain (app2) = ''
N: late SERVER_NAME -> builder host/url = xxx.localhost http://xxx.localhost/
N2: same builder rebuilt after write -> host/url = xxx.example.com:1234 http://xxx.example.com:1234/
O: before register_blueprint -> url_rule/routing_exception = None NotFound
O2: adapter subdomain = 'xxx'

=== EXTRA ORDERING PROBES ===
P1: app5._got_first_request = True
P2: app.add_url_rule after first request -> AssertionError: "The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, an"
Q: @bp.route after register_blueprint -> AssertionError: "The setup method 'route' can no longer be called on the blueprint 'company'. It has already been registered at least onc"
R: override wins -> [('/', 'c6.i6', 'override-level')]
S1: ctx.request.url = 'http://xxx.example.com:1234/foo/'
S2: matches literal = True
S3: ctx.request.blueprint = 'company' == bp.name: True
S4: rv.data = b'http://xxx.example.com:1234/foo/' == literal: True

=== DONE ===
EXIT=0
```

**A–O vs the plan's annotations — every one matches:**

| probe | expected | observed | verdict |
|---|---|---|---|
| A | `'xxx'` | `'xxx'` | ✔ |
| B | `1` | `1` | ✔ |
| C | static rule `subdomain ''` | `[('/static/<path:filename>', 'static', '')]` | ✔ |
| D | static `''` **AND** `('/', 'company.index', 'xxx')` | exactly that | ✔ |
| E | `xxx.example.com:1234` | `xxx.example.com:1234` | ✔ |
| F | `xxx.example.com 1234 /foo /` | `xxx.example.com 1234 /foo /` | ✔ |
| G | `http` | `http` | ✔ |
| H | `'xxx' 'example.com:1234'` | `'xxx' 'example.com:1234'` | ✔ |
| I | `xxx.example.com:1234 /foo` | same | ✔ |
| J | `None` / `http://xxx.example.com:1234/foo/` | same | ✔ |
| K | `company.index company http://…/foo/` | same | ✔ |
| L | `b'http://xxx.example.com:1234/foo/'` | same | ✔ |
| M | `None`/`NotFound` | `None` / `NotFound` | ✔ |
| N | `xxx.localhost` / `http://xxx.localhost/` | same | ✔ |
| O | `None` (rule absent) | `None` / `NotFound` | ✔ |

### 4.4 Full suite

```
$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
testpaths: tests
collected 489 items

tests\test_appctx.py ..............                                      [  2%]
tests\test_async.py ........                                             [  4%]
tests\test_basic.py .................................................... [ 15%]
........................................................................ [ 29%]
......                                                                   [ 31%]
tests\test_blueprints.py ............................................... [ 40%]
.............                                                            [ 43%]
tests\test_cli.py ...................................................... [ 54%]
....                                                                     [ 55%]
tests\test_config.py ...................                                 [ 59%]
tests\test_converters.py ..                                              [ 59%]
tests\test_helpers.py ..................................                 [ 66%]
tests\test_instance_config.py .......                                    [ 67%]
tests\test_json.py ...............................                       [ 74%]
tests\test_json_tag.py ..............                                    [ 77%]
tests\test_logging.py ......                                             [ 78%]
tests\test_regression.py .                                               [ 78%]
tests\test_reqctx.py ..............                                      [ 81%]
tests\test_request.py ...                                                [ 82%]
tests\test_session_interface.py .                                        [ 82%]
tests\test_signals.py .......                                            [ 83%]
tests\test_subclassing.py .                                              [ 83%]
tests\test_templating.py ................................                [ 90%]
tests\test_testing.py .........................                          [ 95%]
tests\test_user_error_handler.py .........                               [ 97%]
tests\test_views.py .............                                        [100%]

============================= 489 passed in 2.16s =============================
EXIT=0
```

A second run with `-vv -rA` also produced `489 passed in 2.23s`; its `-rA` short summary enumerates all 489 ids as `PASSED`, including the relevant ones:

```
PASSED tests/test_basic.py::test_server_name_matching[False-False-default-default-default]
PASSED tests/test_basic.py::test_server_name_matching[True-False-default-abc-<invalid>]
PASSED tests/test_basic.py::test_server_name_matching[False-True-default-abc-default]
PASSED tests/test_basic.py::test_server_name_subdomain
PASSED tests/test_basic.py::test_subdomain_basic_support
PASSED tests/test_basic.py::test_subdomain_matching
PASSED tests/test_basic.py::test_subdomain_matching_with_ports
PASSED tests/test_basic.py::test_subdomain_matching_other_name[False]
PASSED tests/test_basic.py::test_subdomain_matching_other_name[True]
PASSED tests/test_blueprints.py::test_nesting_subdomains
PASSED tests/test_blueprints.py::test_child_and_parent_subdomain
PASSED tests/test_cli.py::TestRoutes::test_subdomain
PASSED tests/test_reqctx.py::test_proper_test_request_context
PASSED tests/test_testing.py::test_environ_defaults_from_config
PASSED tests/test_testing.py::test_environ_defaults
PASSED tests/test_testing.py::test_path_is_url
PASSED tests/test_testing.py::test_blueprint_with_subdomain
PASSED tests/test_testing.py::test_subdomain
PASSED tests/test_testing.py::test_nosubdomain
...
============================= 489 passed in 2.23s =============================
EXIT=0
```

### 4.5 Claim-level checks

Negative fact (ii) — `Config` is a plain dict:

```
$ .venv/Scripts/python.exe -c "from flask.config import Config; from werkzeug.routing import Map; ..."
Config.__setitem__ is dict.__setitem__ : True
Config.__getitem__ is dict.__getitem__ : True
Config.__setattr__ is object.__setattr__: True
Config has __getattr__ : False
Map().default_subdomain = ''
Flask app url_map class/ctor kwargs -> default_subdomain = '' Map False
EXIT=0
```

`filterwarnings = ["error"]` is really in force (same probe file, with and without the repo config):

```
$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider "D:/操作系统开源大赛/_tmp_warn_probe.py"
...
======================== 1 passed, 1 warning in 0.03s =========================
EXIT=0

$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider -c "D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src/pyproject.toml" "D:/操作系统开源大赛/_tmp_warn_probe.py"
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collected 1 item

. F                                                                      [100%]

================================== FAILURES ===================================
_________________________________ test_warns __________________________________

    def test_warns():
>       warnings.warn("boom", UserWarning)
E       UserWarning: boom

D:\操作系统开源大赛\_tmp_warn_probe.py:3: UserWarning
=========================== short test summary info ============================
FAILED ::test_warns - UserWarning: boom
============================== 1 failed in 0.09s =============================
EXIT=1
```

The Werkzeug mismatch warning, and its conversion to an error:

```
$ .venv/Scripts/python.exe "D:/操作系统开源大赛/_tmp_warn_probe2.py"
=== case 1: subdomain_matching=True, HTTP_HOST suffix MISMATCHES config SERVER_NAME ===
  warnings: [('UserWarning', "Current server name 'xyz.other.test' doesn't match configured server name 'example.com:1234'")]
=== case 2: same shape but HTTP_HOST suffix MATCHES (test's own case) ===
  warnings: []
  adapter.subdomain: 'xxx'
=== case 3: subdomain_matching=False (subdomain forced to '') ===
  warnings: []
  adapter.subdomain: ''
EXIT=0
```
```
$ .venv/Scripts/python.exe -m pytest -p no:cacheprovider -c "<repo>/pyproject.toml" "D:/操作系统开源大赛/_tmp_warn_probe3.py"
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collected 1 item

. F                                                                      [100%]

================================== FAILURES ===================================
________________________ test_mismatched_host_warning _________________________

    def test_mismatched_host_warning():
        app = flask.Flask(__name__, subdomain_matching=True)
        app.config["SERVER_NAME"] = "example.com:1234"
>       with app.test_request_context("/", environ_overrides={"HTTP_HOST": "xyz.other.test"}):
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

D:\操作系统开源大赛\_tmp_warn_probe3.py:7: 
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
src\flask\app.py:1475: in test_request_context
    return self.request_context(builder.get_environ())
src\flask\app.py:1421: in request_context
    return RequestContext(self, environ)
src\flask\ctx.py:323: in __init__
    self.url_adapter = app.create_url_adapter(self.request)
src\flask\app.py:464: in create_url_adapter
    return self.url_map.bind_to_environ(
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
...
>               warnings.warn(
                    f"Current server name {wsgi_server_name!r} doesn't match configured"
                    f" server name {server_name!r}",
                    stacklevel=2,
                )
E               UserWarning: Current server name 'xyz.other.test' doesn't match configured server name 'example.com:1234'

.venv\Lib\site-packages\werkzeug\routing\map.py:332: UserWarning
=========================== short test summary info ============================
FAILED ::test_mismatched_host_warning - UserWarning: Current server name 'xyz...'
============================== 1 failed in 0.28s =============================
EXIT=1
```

> Note the traceback: `src\flask\app.py:1421 in request_context`, `src\flask\app.py:1475 in test_request_context`, `src\flask\app.py:464 in create_url_adapter`, `src\flask\ctx.py:323`, `werkzeug\routing\map.py:332`. These independently confirm the `create_url_adapter → bind_to_environ` seam at `app.py:464` and the `match_request`/adapter seam at `ctx.py:323` (§7).

### 4.6 Cleanup / no-artifact proof

```
$ rm -f "D:/操作系统开源大赛/_tmp_probe_subdomain.py" "D:/操作系统开源大赛/_tmp_warn_probe.py" "D:/操作系统开源大赛/_tmp_warn_probe2.py" "D:/操作系统开源大赛/_tmp_warn_probe3.py"
$ ls "D:/操作系统开源大赛/" | grep -i "_tmp"
_patent_review_tmp
_tmp_docx_compare
_tmp_key_backup
_tmp_migration
_tmp_patent_read
_tmp_pptrepos
_tmp_pptx_content.txt
_tmp_pptx_png_v4
_tmp_v22_fulltext.txt
_tmp_v22_inline.txt
_tmp_video_review
                          ← none of my probe files remain (all listed entries are pre-existing workspace dirs)
$ git status -s
                          ← empty, checkout clean after all runs
$ git rev-parse HEAD
85c5d93cbd049c4bd0679c36fd1ddcae8c37b642
$ git status -s --ignored | head -5
!! .pytest_cache/
!! .venv/
!! src/flask/__pycache__/
!! src/flask/json/__pycache__/
!! src/flask/sansio/__pycache__/
```

Every pytest run used `-p no:cacheprovider`; all probe files lived in the workspace root and were deleted; `git status -s` is empty before and after. `.pytest_cache/` and `__pycache__/` are pre-existing and git-ignored (nothing in the checkout was written by this investigation).

---

## 5. Repro pins

| Pin | Value |
|---|---|
| Repository | `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src` (vendored checkout of `pallets/flask`) |
| Revision | `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642` (detached; cloned from upstream `d73fa1cdcbd8b1465c151db8924ba58b1dd14e35`, then `checkout 85c5d93`; `2025-06-12 13:48:07 -0700 Merge branch 'stable'`) |
| Worktree state | `git status -s` empty (clean) both before and after |
| Python | `3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]` |
| Flask | `3.2.0.dev0`, imported from this checkout's `src/flask` via `.venv/Lib/site-packages/flask.pth` (note: `flask.__version__` does not exist; use `importlib.metadata.version("flask")`) |
| Werkzeug | `3.1.3`, installed non-editable at `.venv/Lib/site-packages/werkzeug/` |
| pytest | `8.4.0`, `configfile: pyproject.toml`, `filterwarnings = ["error"]`, `testpaths = ["tests"]` |
| Interpreter path | `.venv/Scripts/python.exe` (Windows layout; there is no `.venv/bin`) |
| Target test command | `.venv/Scripts/python.exe -m pytest tests/test_testing.py::test_blueprint_with_subdomain tests/test_basic.py -q -p no:cacheprovider -k "subdomain or server_name_matching"` |
| Target test result | `10 passed, 121 deselected in 0.09s` (and `1 passed in 0.04s` when run alone) |
| Family command result | `18 passed in 0.19s` |
| Suite result | `489 passed in 2.16s` (and `489 passed in 2.23s` on the verbose rerun) |

---

## 6. Line-number reconciliation (so the pins are trustworthy)

The upstream stages reported a few anchor line numbers that drift from the actual file. I re-grepped the file directly against `85c5d93`; **the grep results below are authoritative**, and where they disagree with a quoted read-window, the read window is offset. Where a runtime traceback exists, it agrees with the grep.

**Authoritative `src/flask/app.py`:** `default_config` 178 (keys `SERVER_NAME` 188, `APPLICATION_ROOT` 189, `PREFERRED_URL_SCHEME` 205, `PROVIDE_AUTOMATIC_OPTIONS` 208); `Flask.__init__` 226 (`subdomain_matching` param 233); `create_url_adapter` 425, `server_name = self.config["SERVER_NAME"]` 452, `elif not self.subdomain_matching:` 458, `subdomain = self.url_map.default_subdomain or ""` 462, `bind_to_environ(` 464; `test_client` 669; `dispatch_request` 879; `full_dispatch_request` 904; `_got_first_request = True` 911; `app_context` 1386; `request_context` 1407 → body 1421; `test_request_context` 1423 → body 1475; `wsgi_app` 1479, `ctx.push()` 1510; `__call__` 1529.

**Authoritative `src/flask/sansio/app.py`:** `_got_first_request = False` 411; `_check_setup_finished` 413; `make_config` 482; `register_blueprint` 570 → `blueprint.register(self, options)` 595; `add_url_rule` 605, `self.url_map.add(rule_obj)` 653, `self.view_functions[endpoint] = view_func` 661.

**Authoritative `src/flask/sansio/blueprints.py`:** `BlueprintSetupState.__init__` 41; `subdomain = self.options.get("subdomain")` 64; `subdomain = self.blueprint.subdomain` 66; `self.subdomain = subdomain` 70; `BlueprintSetupState.add_url_rule` 87; `options.setdefault("subdomain", self.subdomain)` 103; `endpoint = _endpoint_from_view_func(...)` 105; `self.app.add_url_rule(` 110; the dotted-endpoint f-string 112; `_got_registered_once = False` 172; `Blueprint.__init__` 174; `self.subdomain = subdomain` 203; `_check_setup_finished` 213; `record` 224; `self.deferred_functions.append(func)` 230; `make_setup_state` 246; `register` 273; `self._got_registered_once = True` 320; `state = self.make_setup_state(...)` 321; `for deferred in self.deferred_functions:` 334; `deferred(state)` 335; `Blueprint.add_url_rule` 413; `self.record(` 433.

**Authoritative `src/flask/testing.py`:** `EnvironBuilder` 27, `__init__` 49, `http_host = app.config.get("SERVER_NAME") or "localhost"` 66, `app_root = app.config["APPLICATION_ROOT"]` 67, `http_host = f"{subdomain}.{http_host}"` 70, `url_scheme = app.config["PREFERRED_URL_SCHEME"]` 73, `base_url = (` 76; `FlaskClient` 109, `__init__` 125, `_request_from_builder_args` 193, `builder = EnvironBuilder(self.application, ...)` 197, `open` 204.

**Authoritative `src/flask/ctx.py` (matches the retriever exactly):** `AppContext.__init__` 245, `self.url_adapter = app.create_url_adapter(None)` 247, `push` 251, `__enter__` 274; `RequestContext.__init__` 309, `self.url_adapter = app.create_url_adapter(self.request)` 323, `match_request` 357, `url_adapter.match(return_rule=True)` 362, `self.request.url_rule, self.request.view_args = result` 363, `push` 367, `self.match_request()` 394, `__enter__` 433.

**Authoritative `src/flask/config.py`:** `ConfigAttribute.__set__` 46; `class Config(dict)` 50; `Config.__init__` 94. **No** `__setitem__`/`__getitem__`/`__setattr__`/`__getattr__` overload exists (negative fact (ii)).

**Authoritative `src/flask/wrappers.py`:** `endpoint` 147, `blueprint` 162, `endpoint.rpartition(".")[0]` 176, `blueprints` 181.

**Authoritative `src/flask/sansio/scaffold.py`:** `setupmethod` 42, `_check_setup_finished` (abstract) 220, `route` 336, `add_url_rule` 368, `_endpoint_from_view_func` 701.

**Authoritative `src/flask/globals.py`:** `_cv_request` 42, `request_ctx` 43, `request` 46.

**Authoritative Werkzeug 3.1.3:** `Map.__init__` `default_subdomain: str = ""` 97; `Map.bind` 183 (`subdomain = self.default_subdomain` 227); `Map.bind_to_environ` 252 (mismatch derivation 321–339, `warnings.warn(` 332); `MapAdapter.__init__` 401 → `self.subdomain = subdomain` 405; `MapAdapter.match` 492 (overloads 473/483), `domain_part = self.server_name` 597, `domain_part = self.subdomain` 600; `werkzeug/test.py` `_make_base_url` 441, `base_url` property 445, setter 452 (`self.script_root` 461, `self.host` 462, `self.url_scheme` 463), `server_name` 624, `server_port` 629, `get_environ` 667 (`SCRIPT_NAME` 710, `SERVER_NAME` 717, `HTTP_HOST` 719); `werkzeug/wrappers/request.py:113–133`; `werkzeug/sansio/request.py:135–140` (`root_path`/`path`), `:205–211` (`url`), `:222–229` (`host`); `werkzeug/sansio/utils.py:49–98` (`get_host`), `:105–146` (`get_current_url`); `werkzeug/routing/rules.py:455–486` (`Rule.__init__` stores `subdomain`), `:577–580` (`Rule.bind` fills from `map.default_subdomain`), `:702–706` (compile-time `domain_or_host`).

**Target test line range:** `118–138` body with `def` at **117** (the first reading's `117–139` was off by one; the next `def` is at 141). The `nl -ba` output above is the authoritative rendering, and it agrees with `grep` (`test_testing.py:117: def test_blueprint_with_subdomain():`).

**No unresolved discrepancies.** The only behavioural nuance found by execution (not by reading) is §3.4's: control **M** emits *no* Werkzeug mismatch warning because `subdomain_matching=False` makes Flask pass `subdomain=""` rather than `None`, so Werkzeug's derivation/warn branch is skipped — the warning fires only for a `subdomain_matching=True` app whose `HTTP_HOST` suffix disagrees with the configured `SERVER_NAME`, which is the case the in-repo siblings guard with `pytest.warns()` / `warnings.filterwarnings(...)` precisely because `filterwarnings = ["error"]`.

---

## 7. Answer to the question as asked

**"What is the dependency chain in the test function that verifies subdomain routing through configuration, route registration, and request context creation?"**

It is `tests/test_testing.py:117–138::test_blueprint_with_subdomain`, and its dependency chain is:

**Configuration (test 118–120) → blueprint/subdomain declaration (123) → deferred route recording via `@bp.route` (125–127) → `register_blueprint` materializing `Rule("/", "company.index", subdomain="xxx")` into `app.url_map` (129) → `test_request_context("/", subdomain="xxx")` consuming the config to synthesize the environ (131) → `RequestContext.__init__` binding an adapter whose `subdomain` is `"xxx"` *because* `subdomain_matching=True` left the derivation to Werkzeug (131/internal) → `with ctx:` → `push()` → `match_request()` setting `request.url_rule` (134) → `request.blueprint == "company"` (135) → and, on the mirror path, `client.get("/", subdomain="xxx")` replaying the whole configuration→builder→WSGI chain to produce the same URL from the view (137–138).**

The edges that carry the subdomain are, in order: `Blueprint.__init__` → `self.subdomain` (`blueprints.py:203`) → `BlueprintSetupState.__init__` `get`/fallback (`:64`/`:66`) → `options.setdefault("subdomain", self.subdomain)` (`:103`) → `App.add_url_rule` → `Rule(subdomain="xxx")` → `MapAdapter.match`'s `domain_part = self.subdomain` (`map.py:600`). The edges that carry the *host* are: `config["SERVER_NAME"]` → `EnvironBuilder` `http_host` (`testing.py:66`) → `f"{subdomain}.{http_host}"` (`:70`) → `base_url` (`:76`) → Werkzeug `base_url` setter (`test.py:452`) → `HTTP_HOST` (`test.py:719`). The two meet only inside `Map.bind_to_environ` (`map.py:321–339`), where `"xxx.example.com:1234"` minus `"example.com:1234"` yields `"xxx"` — and the *only* thing that decides whether that computation happens at all is `Flask.create_url_adapter`'s `elif not self.subdomain_matching:` at `src/flask/app.py:458` (proven by controls **M**/**M3** and by the test passing with `subdomain_matching=True` at line 118).
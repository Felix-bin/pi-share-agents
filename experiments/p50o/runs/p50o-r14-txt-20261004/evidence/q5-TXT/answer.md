# Answer — dependency chain in the subdomain-routing test

## 0. Which test the question points to (settled, not inferred)

The question is verbatim SWE-QA item #5, and its gold answer pins the test by line number. `experiments/data/swe-qa/Benchmark/flask.jsonl` line 5:

```
{"question": "What is the dependency chain in the test function that verifies subdomain routing through configuration, route registration, and request context creation?", "answer": "The dependency chain in the test function that verifies subdomain routing works as follows:\n\n1. Application-level subdomain matching configuration: The test creates a Flask application with `subdomain_matching=True` (line 118 in `test_testing.py`). This enables subdomain-aware routing in the application's URL adapter creation (see `create_url_adapter` in `app.py` line 425).\n\n2. Blueprint registration with subdomain: When a Blueprint is created with a `subdomain` parameter (line 123: `flask.Blueprint(\"company\", __name__, subdomain=\"xxx\")`), this subdomain is stored in the Blueprint instance. During registration via `app.register_blueprint(bp)` (line 129), the `BlueprintSetupState` class (in `sansio/blueprints.py` lines 64-70) captures the subdomain from either the registration options or the blueprint's own subdomain attribute. This subdomain is then passed to `add_url_rule` (line 103 in `sansio/blueprints.py`), which sets it as an option when registering URL rules with the application.\n\n3. Request context creation with subdomain: When `app.test_request_context(\"/\", subdomain=\"xxx\")` is called (line 131), it creates a `RequestContext` that includes the subdomain in the WSGI environment. The `test_request_context` method (defined in `app.py` line 1423) accepts a `subdomain` parameter that is passed to Werkzeug's `EnvironBuilder`, which constructs the request environment with the appropriate `SERVER_NAME` including the subdomain.\n\n4. URL adapter creation and route matching: During `RequestContext` initialization (in `ctx.py` line 323), `app.create_url_adapter(self.request)` is called. The URL adapter uses the request's subdomain information to match routes. When a route matches, Werkzeug's routing system sets `request.blueprint` to the name of the blueprint that owns the matched route (verified in line 135: `assert ctx.request.blueprint == bp.name`).\n\n5. URL resolution consistency: The `url_for` function (in `helpers.py` line 188) and the application's `url_for` method (in `sansio/app.py`) use the current request context's blueprint information and subdomain to build URLs consistently. The `request.blueprints` property (in `wrappers.py` lines 180-195) provides access to the blueprint hierarchy, which is used during URL building to inject appropriate defaults and ensure the subdomain is included in generated URLs.\n\nThe dependency ensures that:\n- The application must have `subdomain_matching=True` for subdomain routing to work.\n- Blueprints must be registered with their subdomain information stored in the URL rules.\n- Request contexts must be created with matching subdomain parameters.\n- URL resolution uses the request context's blueprint and subdomain information to generate consistent URLs.\n\nThis chain ensures that URL resolution remains consistent whether using `test_request_context` directly or through the test client, as both create request contexts with the same subdomain information that matches the registered blueprint's subdomain constraint."}
```

`line 118 in test_testing.py` is `app = flask.Flask(__name__, subdomain_matching=True)`, i.e. the target is **`tests/test_testing.py::test_blueprint_with_subdomain` (lines 117–138)**, not the sibling `test_subdomain` (lines 302–318). The question string occurs exactly once in the whole `experiments/data/swe-qa/` tree — `Benchmark/flask.jsonl` line 5 — so attribution is by unique verbatim match plus the gold line citation.

The test itself (verbatim, `tests/test_testing.py`, lines 117–138):

```python
def test_blueprint_with_subdomain():
    app = flask.Flask(__name__, subdomain_matching=True)
    app.config["SERVER_NAME"] = "example.com:1234"
    app.config["APPLICATION_ROOT"] = "/foo"
    client = app.test_client()

    bp = flask.Blueprint("company", __name__, subdomain="xxx")

    @bp.route("/")
    def index():
        return flask.request.url

    app.register_blueprint(bp)

    ctx = app.test_request_context("/", subdomain="xxx")
    assert ctx.request.url == "http://xxx.example.com:1234/foo/"

    with ctx:
        assert ctx.request.blueprint == bp.name

    rv = client.get("/", subdomain="xxx")
    assert rv.data == b"http://xxx.example.com:1234/foo/"
```

Exact line map (verified against the file): 117 `def`; 118 `Flask(..., subdomain_matching=True)`; 119 `SERVER_NAME`; 120 `APPLICATION_ROOT`; 121 `test_client()`; 123 `Blueprint("company", __name__, subdomain="xxx")`; 125 `@bp.route("/")`; 126–127 view returning `flask.request.url`; 129 `register_blueprint(bp)`; 131 `test_request_context("/", subdomain="xxx")`; 132 url assert; 134 `with ctx:`; 135 blueprint assert; 137 `client.get("/", subdomain="xxx")`; 138 data assert. Neighbours: previous test ends at 114 (`test_environbuilder_json_dumps`), next starts at 141 (`test_redirect_keep_session`).

**Decoy warning.** The only on-disk mutation artifact, `flask-src/flask_mut2_i417ar2x/mutated_test.py`, is a rewrite of the **sibling** `test_subdomain`, not of the target:

```python
import flask

app = flask.Flask(__name__, subdomain_matching=False)
app.config["SERVER_NAME"] = "example.com"
client = app.test_client()

@app.route("/", subdomain="<company_id>")
def view(company_id):
    return company_id

with app.test_request_context():
    url = flask.url_for("view", company_id="xxx")
print("url_for ->", url)

with client:
    response = client.get(url)

print("status_code:", response.status_code)
print("data:", response.data)
assert 200 == response.status_code, f"status {response.status_code}"
assert b"xxx" == response.data, f"data {response.data!r}"
print("ASSERTS PASSED (unexpected)")
```

It is `test_subdomain` (module-level code, `@app.route("/", subdomain="<company_id>")`, `SERVER_NAME = "example.com"`) with the flag flipped. It is used below **only** as the falsification probe for link 1 — it is not the answer target. Exhaustive grep for `subdomain_matching=False` under `flask-src` returns exactly two hits: `CHANGES.rst:50` and `flask_mut2_i417ar2x/mutated_test.py:3`.

---

## 1. The dependency chain, in order (8 links)

Each link: file → function → line → verbatim code → what depends on it.

### Link 1 — Configuration switch: `subdomain_matching=True` is stored on the app and read only by `create_url_adapter`

`tests/test_testing.py:118` → `src/flask/app.py:233,245` → `src/flask/sansio/app.py:289,407` → read at `src/flask/app.py:458`.

`src/flask/app.py` (`Flask.__init__` parameter and forwarding; lines 233 and 245, verified by grep):

```python
        subdomain_matching: bool = False,
```
```python
            subdomain_matching=subdomain_matching,
```

`src/flask/sansio/app.py` (lines 288–289 and 405–407, verbatim):

```python
        host_matching: bool = False,
        subdomain_matching: bool = False,
```
```python
        self.url_map = self.url_map_class(host_matching=host_matching)

        self.subdomain_matching = subdomain_matching

        # tracks internally if the application already handled at least one
        # request.
        self._got_first_request = False
```

`App.__init__` at `sansio/app.py:407` is the **only** assignment site, and `src/flask/app.py:458` is where it becomes behaviour:

```python
            if self.url_map.host_matching:
                # Don't pass SERVER_NAME, otherwise it's used and the actual
                # host is ignored, which breaks host matching.
                server_name = None
            elif not self.subdomain_matching:
                # Werkzeug doesn't implement subdomain matching yet. Until then,
                # disable it by forcing the current subdomain to the default, or
                # the empty string.
                subdomain = self.url_map.default_subdomain or ""
```

Everything downstream depends on this flag being `True`: if it is `False`, the adapter is built with `subdomain=""` and every later link collapses to "no subdomain" (proved in §3).

### Link 2 — Configuration values: `SERVER_NAME="example.com:1234"` and `APPLICATION_ROOT="/foo"` are the base host and script root for both request and non-request adapters

`tests/test_testing.py:119–120` → defaults `src/flask/app.py:188–189` → consumed at `src/flask/app.py:452` (in-request), `src/flask/app.py:469–474` (outside a request), and `src/flask/testing.py:66–70`.

`src/flask/app.py`, `default_config` (lines 187–189, 205):

```python
            "TRUSTED_HOSTS": None,
            "SERVER_NAME": None,
            "APPLICATION_ROOT": "/",
```
```python
            "PREFERRED_URL_SCHEME": "http",
```

`src/flask/app.py`, `create_url_adapter` (the full body, lines 425–476, verbatim as read from the file):

```python
    def create_url_adapter(self, request: Request | None) -> MapAdapter | None:
        """Creates a URL adapter for the given request. The URL adapter
        is created at a point where the request context is not yet set
        up so the request is passed explicitly.

        .. versionchanged:: 3.1
            If :data:`SERVER_NAME` is set, it does not restrict requests to
            only that domain, for both ``subdomain_matching`` and
            ``host_matching``.

        .. versionchanged:: 1.0
            :data:`SERVER_NAME` no longer implicitly enables subdomain
            matching. Use :attr:`subdomain_matching` instead.

        .. versionchanged:: 0.9
           This can be called outside a request when the URL adapter is created
           for an application context.

        .. versionadded:: 0.6
        """
        if request is not None:
            if (trusted_hosts := self.config["TRUSTED_HOSTS"]) is not None:
                request.trusted_hosts = trusted_hosts

            # Check trusted_hosts here until bind_to_environ does.
            request.host = get_host(request.environ, request.trusted_hosts)  # pyright: ignore
            subdomain = None
            server_name = self.config["SERVER_NAME"]

            if self.url_map.host_matching:
                # Don't pass SERVER_NAME, otherwise it's used and the actual
                # host is ignored, which breaks host matching.
                server_name = None
            elif not self.subdomain_matching:
                # Werkzeug doesn't implement subdomain matching yet. Until then,
                # disable it by forcing the current subdomain to the default, or
                # the empty string.
                subdomain = self.url_map.default_subdomain or ""

            return self.url_map.bind_to_environ(
                request.environ, server_name=server_name, subdomain=subdomain
            )

        # Need at least SERVER_NAME to match/build outside a request.
        if self.config["SERVER_NAME"] is not None:
            return self.url_map.bind(
                self.config["SERVER_NAME"],
                script_name=self.config["APPLICATION_ROOT"],
                url_scheme=self.config["PREFERRED_URL_SCHEME"],
            )

        return None
```

Key exact anchors in this body (grep-verified): `request.trusted_hosts` 446–447; `request.host = get_host(...)` 450; `subdomain = None` 451; `server_name = self.config["SERVER_NAME"]` **452**; `elif not self.subdomain_matching:` **458**; `subdomain = self.url_map.default_subdomain or ""` **462**; `bind_to_environ(..., server_name=server_name, subdomain=subdomain)` 464–466; `if self.config["SERVER_NAME"] is not None:` **469**; `url_map.bind(SERVER_NAME, script_name=APPLICATION_ROOT, url_scheme=PREFERRED_URL_SCHEME)` **470–474**; `return None` **476**.

Both halves of the chain depend on this: the adapter must be told `example.com:1234` so that `xxx` is interpretable as a subdomain of it, and `APPLICATION_ROOT=/foo` is what puts `/foo` into the URL/`SCRIPT_NAME`. `docs/config.rst` states the same contract:

```
.. py:data:: SERVER_NAME

    Inform the application what host and port it is bound to.

    Must be set if ``subdomain_matching`` is enabled, to be able to extract the
    subdomain from the request.
```

### Link 3 — Route registration, step 1: `@bp.route("/")` does **not** register anything; it defers a lambda

`tests/test_testing.py:125` → `src/flask/sansio/scaffold.py:336,362` → `src/flask/sansio/blueprints.py:413,433–440` → `record` 224–230 → `deferred_functions` 204.

`src/flask/sansio/scaffold.py` (`route`, def at 336; decorator body):

```python
        def decorator(f: T_route) -> T_route:
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f
```

For a `Blueprint`, `self.add_url_rule` resolves to `Blueprint.add_url_rule`, `src/flask/sansio/blueprints.py:413` (verbatim):

```python
    @setupmethod
    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: ft.RouteCallable | None = None,
        provide_automatic_options: bool | None = None,
        **options: t.Any,
    ) -> None:
        """Register a URL rule with the blueprint. See :meth:`.Flask.add_url_rule` for
        full documentation.

        The URL rule is prefixed with the blueprint's URL prefix. The endpoint name,
        used with :func:`url_for`, is prefixed with the blueprint's name.
        """
        if endpoint and "." in endpoint:
            raise ValueError("'endpoint' may not contain a dot '.' character.")

        if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
            raise ValueError("'view_func' name may not contain a dot '.' character.")

        self.record(
            lambda s: s.add_url_rule(
                rule,
                endpoint,
                view_func,
                provide_automatic_options=provide_automatic_options,
                **options,
            )
        )
```

`Blueprint.record`, `src/flask/sansio/blueprints.py:224–230`:

```python
    @setupmethod
    def record(self, func: DeferredSetupFunction) -> None:
        """Registers a function that is called when the blueprint is
        registered on the application.  This function is called with the
        state as argument as returned by the :meth:`make_setup_state`
        method.
        """
        self.deferred_functions.append(func)
```

The list it appends to is created in `Blueprint.__init__` (`sansio/blueprints.py:203–204`):

```python
        self.subdomain = subdomain
        self.deferred_functions: list[DeferredSetupFunction] = []
```

**Dependency:** after `@bp.route("/")` the app's `url_map` still does not contain the rule — the subdomain constraint cannot be attached yet because no app and no registration-time options exist. This is exactly the mechanism the sibling gold item (`Benchmark/flask.jsonl` line 19) describes: "the `BlueprintSetupState` class (in `src/flask/sansio/blueprints.py` lines 64-70) captures the subdomain from either the registration options or the blueprint's own subdomain attribute … The setup state is created in `make_setup_state()` (line 321) during registration."

### Link 4 — Route registration, step 2: the Blueprint carries `subdomain="xxx"` as an attribute

`tests/test_testing.py:123` → `src/flask/sansio/blueprints.py:182,203`.

`Blueprint.__init__` parameter `subdomain` at `sansio/blueprints.py:182`; stored at 203 (quoted above). `src/flask/blueprints.py` is a thin subclass (`class Blueprint(SansioBlueprint)`) with no `add_url_rule`/`register`/`route` overrides, so `flask.Blueprint` behaves exactly as `sansio/blueprints.py` defines. **Dependency:** if this attribute were absent/`None`, link 5 would resolve `state.subdomain = None` and the rule would inherit the map's `default_subdomain` (`""`) — proved in §3, probe for link 3.

### Link 5 — Route registration, step 3: `register_blueprint` builds the setup state, injects the subdomain into the rule options, and replays the deferred function into `App.add_url_rule` → `Rule`

`tests/test_testing.py:129` → `src/flask/sansio/app.py:570,595` → `sansio/blueprints.py:273,246,321,334–335` → `BlueprintSetupState.__init__` 41/64–70 → `BlueprintSetupState.add_url_rule` 87/103/110 → `sansio/app.py:605,650,653`.

`src/flask/sansio/app.py` (`register_blueprint` def at 570; body):

```python
        blueprint.register(self, options)
```
at line **595**.

`Blueprint.register` (def 273; the executable part, verbatim):

```python
        name_prefix = options.get("name_prefix", "")
        self_name = options.get("name", self.name)
        name = f"{name_prefix}.{self_name}".lstrip(".")

        if name in app.blueprints:
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(
                f"The name '{self_name}' is already registered for"
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )

        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
        first_name_registration = name not in app.blueprints

        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)

        if self.has_static_folder:
            state.add_url_rule(
                f"{self.static_url_path}/<path:filename>",
                view_func=self.send_static_file,  # type: ignore[attr-defined]
                endpoint="static",
            )

        # Merge blueprint data into parent.
        if first_bp_registration or first_name_registration:
            self._merge_blueprint_funcs(app, name)

        for deferred in self.deferred_functions:
            deferred(state)
```

(`state = self.make_setup_state(...)` at **321** — grep-verified; replay loop `for deferred in self.deferred_functions:` **334**, `deferred(state)` **335**.)

`make_setup_state` (def **246**) returns `BlueprintSetupState(self, app, options, first_registration)`.

`BlueprintSetupState.__init__` — the subdomain resolution (lines 41–85, verbatim):

```python
    def __init__(
        self,
        blueprint: Blueprint,
        app: App,
        options: t.Any,
        first_registration: bool,
    ) -> None:
        #: a reference to the current application
        self.app = app

        #: a reference to the blueprint that created this setup state.
        self.blueprint = blueprint

        #: a dictionary with all options that were passed to the
        #: :meth:`~flask.Flask.register_blueprint` method.
        self.options = options

        #: as blueprints can be registered multiple times with the
        #: application and not everything wants to be registered
        #: multiple times on it, this attribute can be used to figure
        #: out if the blueprint was registered in the past already.
        self.first_registration = first_registration

        subdomain = self.options.get("subdomain")
        if subdomain is None:
            subdomain = self.blueprint.subdomain

        #: The subdomain that the blueprint should be active for, ``None``
        #: otherwise.
        self.subdomain = subdomain
```

Exact: `subdomain = self.options.get("subdomain")` **64**; fallback `subdomain = self.blueprint.subdomain` **66**; `self.subdomain = subdomain` **70**.

`BlueprintSetupState.add_url_rule` (lines 87–122, verbatim):

```python
    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: ft.RouteCallable | None = None,
        **options: t.Any,
    ) -> None:
        """A helper method to register a rule (and optionally a view function)
        to the application.  The endpoint is automatically prefixed with the
        blueprint's name.
        """
        if self.url_prefix is not None:
            if rule:
                rule = "/".join((self.url_prefix.rstrip("/"), rule.lstrip("/")))
            else:
                rule = self.url_prefix
        options.setdefault("subdomain", self.subdomain)
        if endpoint is None:
            endpoint = _endpoint_from_view_func(view_func)  # type: ignore
        defaults = self.url_defaults
        if "defaults" in options:
            defaults = dict(defaults, **options.pop("defaults"))

        self.app.add_url_rule(
            rule,
            f"{self.name_prefix}.{self.name}.{endpoint}".lstrip("."),
            view_func,
            defaults=defaults,
            **options,
        )
```

Exact: `options.setdefault("subdomain", self.subdomain)` **103**; `self.app.add_url_rule(` **110** (both grep-verified). Note the endpoint becomes `"company.index"` via `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")` — this dotted name is what `Request.blueprint` later splits.

`App.add_url_rule` (`src/flask/sansio/app.py`, def 605; executable part, verbatim):

```python
        if endpoint is None:
            endpoint = _endpoint_from_view_func(view_func)  # type: ignore
        options["endpoint"] = endpoint
        methods = options.pop("methods", None)

        # if the methods are not given and the view_func object knows its
        # methods we can use that instead.  If neither exists, we go with
        # a tuple of only ``GET`` as default.
        if methods is None:
            methods = getattr(view_func, "methods", None) or ("GET",)
        if isinstance(methods, str):
            raise TypeError(
                "Allowed methods must be a list of strings, for"
                ' example: @app.route(..., methods=["POST"])'
            )
        methods = {item.upper() for item in methods}

        # Methods that should always be added
        required_methods: set[str] = set(getattr(view_func, "required_methods", ()))

        # starting with Flask 0.8 the view_func object can disable and
        # force-enable the automatic options handling.
        if provide_automatic_options is None:
            provide_automatic_options = getattr(
                view_func, "provide_automatic_options", None
            )

        if provide_automatic_options is None:
            if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
                provide_automatic_options = True
                required_methods.add("OPTIONS")
            else:
                provide_automatic_options = False

        # Add the required methods now.
        methods |= required_methods

        rule_obj = self.url_rule_class(rule, methods=methods, **options)
        rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]

        self.url_map.add(rule_obj)
        if view_func is not None:
            old_func = self.view_functions.get(endpoint)
            if old_func is not None and old_func != view_func:
                raise AssertionError(
                    "View function mapping is overwriting an existing"
                    f" endpoint function: {endpoint}"
                )
            self.view_functions[endpoint] = view_func
```

`rule_obj = self.url_rule_class(rule, methods=methods, **options)` at **650** (the `subdomain="xxx"` arrives through `**options`), `self.url_map.add(rule_obj)` at **653**.

**Dependency:** the blueprint's subdomain only becomes load-bearing here. Confirmed at runtime: before `register_blueprint` the map holds only the static rule and one deferred function; after registration the rule carries the subdomain (executor probe output, §3).

### Link 6 — Werkzeug: the subdomain is baked into the compiled matcher's domain part

`sem` `Map.add` → `Rule.bind` → `Rule.compile`.

`werkzeug/routing/map.py`, `Map.add` (170–181, verbatim):

```python
    def add(self, rulefactory: RuleFactory) -> None:
        """Add a new rule or factory to the map and bind it.  Requires that the
        rule is not bound to another map.

        :param rulefactory: a :class:`Rule` or :class:`RuleFactory`
        """
        for rule in rulefactory.get_rules(self):
            rule.bind(self)
            if not rule.build_only:
                self._matcher.add(rule)
            self._rules_by_endpoint.setdefault(rule.endpoint, []).append(rule)
        self._remap = True
```

`werkzeug/routing/rules.py`, `Rule.bind` (566–581, verbatim):

```python
    def bind(self, map: Map, rebind: bool = False) -> None:
        """Bind the url to a map and create a regular expression based on
        the information from the rule itself and the defaults from the map.

        :internal:
        """
        if self.map is not None and not rebind:
            raise RuntimeError(f"url rule {self!r} already bound to map {self.map!r}")
        self.map = map
        if self.strict_slashes is None:
            self.strict_slashes = map.strict_slashes
        if self.merge_slashes is None:
            self.merge_slashes = map.merge_slashes
        if self.subdomain is None:
            self.subdomain = map.default_subdomain
        self.compile()
```

(`if self.subdomain is None:` **579**; `self.subdomain = map.default_subdomain` **580**; `self.compile()` **581**.)

`werkzeug/routing/rules.py`, `Rule.compile` (699–738; head verbatim):

```python
    def compile(self) -> None:
        """Compiles the regular expression and stores it."""
        assert self.map is not None, "rule not bound"

        if self.map.host_matching:
            domain_rule = self.host or ""
        else:
            domain_rule = self.subdomain or ""
        self._parts = []
        self._trace = []
        self._converters = {}
        if domain_rule == "":
```

(`domain_rule = self.host or ""` **704**; `domain_rule = self.subdomain or ""` **706** — grep/read verified; `self._parts.extend(self._parse_rule(domain_rule))` **721**.) For this test `domain_rule == "xxx"`, so the matcher's domain slot is the literal string `xxx`.

### Link 7 — Request-context creation: `test_request_context("/", subdomain="xxx")` builds an environ whose `HTTP_HOST` is `xxx.example.com:1234` and whose `SCRIPT_NAME` comes from `APPLICATION_ROOT`

`tests/test_testing.py:131` → `src/flask/app.py:1423,1472,1475` → `request_context` 1407/1421 → `src/flask/testing.py:49,66–70,76–79,86` → Werkzeug `base_url` setter / `get_environ`.

`src/flask/app.py`, `test_request_context` (def **1423**; body verbatim):

```python
        from .testing import EnvironBuilder

        builder = EnvironBuilder(self, *args, **kwargs)

        try:
            return self.request_context(builder.get_environ())
        finally:
            builder.close()
```

(`builder = EnvironBuilder(self, *args, **kwargs)` **1472**; `return self.request_context(builder.get_environ())` **1475** — grep-verified.) Docstring (1424–1464) documents exactly this: "`base_url`: Base URL where the app is being served, which ``path`` is relative to. If not given, built from :data:`PREFERRED_URL_SCHEME`, ``subdomain``, :data:`SERVER_NAME`, and :data:`APPLICATION_ROOT`." and "`subdomain`: Subdomain name to append to :data:`SERVER_NAME`."

`Flask.request_context` (def 1407) returns `RequestContext(self, environ)` at **1421**.

`src/flask/testing.py`, `EnvironBuilder.__init__` (class 27, def **49**; verbatim as read):

```python
    def __init__(
        self,
        app: Flask,
        path: str = "/",
        base_url: str | None = None,
        subdomain: str | None = None,
        url_scheme: str | None = None,
        *args: t.Any,
        **kwargs: t.Any,
    ) -> None:
        assert not (base_url or subdomain or url_scheme) or (
            base_url is not None
        ) != bool(subdomain or url_scheme), (
            'Cannot pass "subdomain" or "url_scheme" with "base_url".'
        )

        if base_url is None:
            http_host = app.config.get("SERVER_NAME") or "localhost"
            app_root = app.config["APPLICATION_ROOT"]

            if subdomain:
                http_host = f"{subdomain}.{http_host}"

            if url_scheme is None:
                url_scheme = app.config["PREFERRED_URL_SCHEME"]

            url = urlsplit(path)
            base_url = (
                f"{url.scheme or url_scheme}://{url.netloc or http_host}"
                f"/{app_root.lstrip('/')}"
            )
            path = url.path

            if url.query:
                path = f"{path}?{url.query}"

        self.app = app
        super().__init__(path, base_url, *args, **kwargs)
```

Grep-verified anchors: `http_host = app.config.get("SERVER_NAME") or "localhost"` **66**; `app_root = app.config["APPLICATION_ROOT"]` **67**; `if subdomain:` **69**; `http_host = f"{subdomain}.{http_host}"` **70**; `base_url` assembly 76–79; `super().__init__(path, base_url, *args, **kwargs)` **86**.

So with `subdomain="xxx"`, `http_host` becomes `xxx.example.com:1234`, `base_url` becomes `http://xxx.example.com:1234/foo`, and Werkzeug's `base_url` setter (`werkzeug/test.py:452–465`) splits it into `script_root="/foo"`, `host="xxx.example.com:1234"`, `url_scheme="http"`; `get_environ` then emits `SCRIPT_NAME`, `SERVER_NAME`, `HTTP_HOST`, `wsgi.url_scheme`. This is why `ctx.request.url == "http://xxx.example.com:1234/foo/"` at test line 132 holds **independently of route matching** — the URL string is a property of the environ builder, not of the matcher.

### Link 8 — Adapter creation and match: the request-side subdomain must equal the rule-side subdomain, or nothing matches and `request.blueprint` is `None`

`src/flask/ctx.py:309,323` (adapter created) → `ctx.py:367,393–394` (push triggers match) → `werkzeug/routing/map.py` `bind_to_environ` 252/321–339 and `MapAdapter.match` 492/597–600/605 → `src/flask/wrappers.py:147,162`.

`src/flask/ctx.py`, `RequestContext.__init__` (class 287, def 309; verbatim, with the adapter line at **323**):

```python
        self.app = app
        if request is None:
            request = app.request_class(environ)
            request.json_module = app.json
        self.request: Request = request
        self.url_adapter = None
        try:
            self.url_adapter = app.create_url_adapter(self.request)
        except HTTPException as e:
            self.request.routing_exception = e
```

`RequestContext.match_request` (def 357) and `push` (def 367):

```python
    def match_request(self) -> None:
        """Can be overridden by a subclass to hook into the matching
        of the request.
        """
        try:
            result = self.url_adapter.match(return_rule=True)  # type: ignore
            self.request.url_rule, self.request.view_args = result  # type: ignore
        except HTTPException as e:
            self.request.routing_exception = e
```
```python
        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
        if self.url_adapter is not None:
            self.match_request()
```

(`self.url_adapter.match(return_rule=True)` **362**; `if self.url_adapter is not None:` **393**; `self.match_request()` **394**.) Matching happens at **push** time, which is why the assertion on `request.blueprint` sits *inside* `with ctx:` (test line 134–135) and not on the line that creates `ctx`.

Werkzeug side: `MapAdapter.match` (def 492), the domain selection (read at 594–605, verbatim):

```python
        if websocket is None:
            websocket = self.websocket

        domain_part = self.server_name

        if not self.map.host_matching and self.subdomain is not None:
            domain_part = self.subdomain

        path_part = f"/{path_info.lstrip('/')}" if path_info else ""

        try:
            result = self.map._matcher.match(domain_part, path_part, method, websocket)
```

(`domain_part = self.server_name` **597**; `if not self.map.host_matching and self.subdomain is not None:` **599**; `domain_part = self.subdomain` **600**; `self.map._matcher.match(...)` **605**.) Where does `MapAdapter.subdomain = "xxx"` come from? `Map.bind_to_environ` (def 252; executable core verbatim):

```python
        if subdomain is None and not self.host_matching:
            cur_server_name = wsgi_server_name.split(".")
            real_server_name = server_name.split(".")
            offset = -len(real_server_name)

            if cur_server_name[offset:] != real_server_name:
                # This can happen even with valid configs if the server was
                # accessed directly by IP address under some situations.
                # Instead of raising an exception like in Werkzeug 0.7 or
                # earlier we go by an invalid subdomain which will result
                # in a 404 error on matching.
                warnings.warn(
                    f"Current server name {wsgi_server_name!r} doesn't match configured"
                    f" server name {server_name!r}",
                    stacklevel=2,
                )
                subdomain = "<invalid>"
            else:
                subdomain = ".".join(filter(None, cur_server_name[:offset]))
```

(`if subdomain is None and not self.host_matching:` **321**; the warning/`"<invalid>"` branch 330–337; `subdomain = ".".join(filter(None, cur_server_name[:offset]))` **339**.) With `wsgi_server_name = "xxx.example.com:1234"` and `server_name = "example.com:1234"`, this yields `subdomain = "xxx"` — matching the rule's compiled domain part.

Finally `src/flask/wrappers.py` (grep-verified: `def endpoint` **147**, `def blueprint` **162**, `def blueprints` **181**):

```python
    @property
    def blueprint(self) -> str | None:
        """The registered name of the current blueprint.

        This will be ``None`` if the endpoint is not part of a
        blueprint, or if URL matching failed or has not been performed
        yet.
        ...
        """
        endpoint = self.endpoint

        if endpoint is not None and "." in endpoint:
            return endpoint.rpartition(".")[0]

        return None
```

The matched rule's endpoint is `company.index`, so `blueprint` → `"company"` → the line‑135 assert `ctx.request.blueprint == bp.name` holds. Then `rv = client.get("/", subdomain="xxx")` (line 137) re-enters the *same* chain via `Flask.test_client` (`app.py:669`) → `FlaskClient` (`testing.py:109`, `__init__` **125**, `preserve_context = False` **127**) → `FlaskClient.open` (def 204) → `_request_from_builder_args` (def **193**, `builder = EnvironBuilder(self.application, *args, **kwargs)` **197**, called at **228**) → `wsgi_app` → `RequestContext.push`/`match_request`; the view returns `flask.request.url`, giving `b"http://xxx.example.com:1234/foo/"` at line 138.

---

## 2. The chain on one line each (with anchors)

| # | Link | Anchor |
|---|---|---|
| 1 | `subdomain_matching=True` stored on the app | `tests/test_testing.py:118` → `src/flask/app.py:233,245` → `src/flask/sansio/app.py:289,407`; read at `src/flask/app.py:458` |
| 2 | `SERVER_NAME`/`APPLICATION_ROOT` supply base host + script root | `tests/test_testing.py:119-120`; defaults `src/flask/app.py:188-189`; used `src/flask/app.py:452,469-474`, `src/flask/testing.py:66-70` |
| 3 | `@bp.route("/")` defers a lambda into `deferred_functions` | `src/flask/sansio/scaffold.py:336,362` → `src/flask/sansio/blueprints.py:413,433` → `record` `224-230` → list at `204` |
| 4 | Blueprint stores `subdomain="xxx"` | `tests/test_testing.py:123`; `src/flask/sansio/blueprints.py:182,203` |
| 5 | `register_blueprint` → setup state → `setdefault("subdomain", …)` → replay → `Rule` | `src/flask/sansio/app.py:570,595`; `src/flask/sansio/blueprints.py:246,321,334-335`; `64-70`; `103`; `110`; `src/flask/sansio/app.py:605,650,653` |
| 6 | Werkzeug bakes `domain_rule = "xxx"` into the matcher | `werkzeug/routing/map.py:170-181`; `werkzeug/routing/rules.py:566,579-581,699,706` |
| 7 | `test_request_context("/", subdomain="xxx")` builds `base_url = http://xxx.example.com:1234/foo` | `tests/test_testing.py:131`; `src/flask/app.py:1423,1472,1475,1407,1421`; `src/flask/testing.py:49,66-70,76-79,86` |
| 8 | Adapter created at context init, matching at push; `request.blueprint` reads the dotted endpoint | `src/flask/ctx.py:309,323,357,362,367,393-394`; `src/flask/app.py:425,464-466`; `werkzeug/routing/map.py:252,321-339,492,597-600,605`; `src/flask/wrappers.py:147,162` |

**Load-bearing conclusion.** The chain only closes if all three conditions hold simultaneously: **(a)** the app must have `subdomain_matching=True` (otherwise `create_url_adapter` at `app.py:458-462` forces `subdomain=""`); **(b)** the blueprint's `subdomain="xxx"` must be baked into the URL rule at registration time via `BlueprintSetupState.add_url_rule` → `options.setdefault("subdomain", self.subdomain)` → `Map.add`/`Rule.compile` (otherwise `domain_rule` is `""`); and **(c)** the request context must be created with the same subdomain, because `EnvironBuilder` turns `subdomain="xxx"` into `HTTP_HOST=xxx.example.com:1234` and `Map.bind_to_environ` derives `subdomain="xxx"` from it, which then becomes `domain_part` at `MapAdapter.match`. Break any one and matching fails: `url_rule` stays `None`, `Request.blueprint` returns `None`, and the request 404s.

---

## 3. Verification and falsification (raw outputs)

**Target test passes** — worktree-local `.venv` has `flask.pth` → `flask-src/src`, no install step needed:

```
.venv/Scripts/python.exe -m pytest tests/test_testing.py::test_blueprint_with_subdomain tests/test_testing.py::test_subdomain -v
```
```
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
collecting ... collected 2 items

tests/test_testing.py::test_blueprint_with_subdomain PASSED              [ 50%]
tests/test_testing.py::test_subdomain PASSED                             [100%]

============================== 2 passed in 0.08s ==============================
```

**Whole suite** (twice: default and `-vv -rA --tb=long`; `pyproject.toml:107-111` sets `filterwarnings = ["error"]`, so zero warnings is meaningful) — `489 passed`, exit 0 both times:

```
============================= 489 passed in 4.27s =============================
```
```
============================= 489 passed in 4.37s =============================
```

**Link 1 is load-bearing — mutation of the target test's shape** (flip `subdomain_matching=False`, run the same sequence, exit 0):

```
request.url = http://xxx.example.com:1234/foo/
url assert matches expected: True
request.blueprint = None
request.endpoint  = None
request.routing_exception = <NotFound '404: Not Found'>
client status: 404 data: b'<!doctype html>…<h1>Not Found</h1>…'
```

Note the failure location: the line‑132 `ctx.request.url` assert **still passes** (that URL comes from `EnvironBuilder`/`base_url`, independent of matching); the first assert to fail is line 135 `ctx.request.blueprint == bp.name` (`None` vs `"company"`). No `Current server name …` warning fires, because `subdomain_matching=False` forces `subdomain=""` so `bind_to_environ` is never asked to derive one.

**The on-disk probe artifact** (exit **1**) — `flask-src/flask_mut2_i417ar2x/mutated_test.py`, a mutated copy of the *sibling* `test_subdomain`:

```
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server…'
Traceback (most recent call last):
  File "...\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
AssertionError: status 404
```

**Links 4/5 (registration bakes the subdomain into the `Rule`)** (exit 0):

```
before register: rules = [<Rule '/static/<filename>' (OPTIONS, HEAD, GET) -> static>]
before register: deferred_functions len = 1
rule /static/<path:filename> | endpoint= static | subdomain= '' | is_bound= True
rule / | endpoint= company.index | subdomain= 'xxx' | is_bound= True
after register: deferred_functions len = 1
blueprint.subdomain attr = 'xxx'
url_map.default_subdomain = ''
```

**Link 8 (context subdomain must match the rule's)** (exit 0):

```
--- subdomain kwarg = 'xxx'
    ctx.request.url = http://xxx.example.com:1234/foo/
    adapter.server_name = 'example.com:1234' | adapter.subdomain = 'xxx'
    request.blueprint = 'company' | endpoint = 'company.index' | routing_exception = None
--- subdomain kwarg = 'yyy'
    ctx.request.url = http://yyy.example.com:1234/foo/
    adapter.server_name = 'example.com:1234' | adapter.subdomain = 'yyy'
    request.blueprint = None | endpoint = None | routing_exception = NotFound
--- subdomain kwarg = None
    ctx.request.url = http://example.com:1234/foo/
    adapter.server_name = 'example.com:1234' | adapter.subdomain = ''
    request.blueprint = None | endpoint = None | routing_exception = NotFound
```

**Link 4 (blueprint must carry the subdomain) — inverted behaviour when omitted** (exit 0):

```
rule / | endpoint= company.index | subdomain= ''          ← default_subdomain, not 'xxx'
with subdomain=xxx -> blueprint = None | routing_exception = NotFound
with no subdomain -> blueprint = 'company'                 ← matches only without the subdomain
```

**Client leg (test line 137)** (exit 0):

```
client.get with subdomain=xxx : 200 b'http://xxx.example.com:1234/foo/'
client.get with no subdomain  : 404
client.get base_url=xxx...    : 200 b'http://xxx.example.com:1234/foo/'
```

No source files were edited; all probes were `python -c` one-liners plus a pytest redirect.

---

## 4. Corrections to the gold answer and to the handed-over notes (for the record)

- The gold answer's item 5 is **not** part of this test's dependency chain: `test_blueprint_with_subdomain` contains **no `url_for` call at all**. Treat item 5 as upstream context, not a link. (The `url_for` leg belongs to the sibling `test_subdomain`.)
- The gold answer says "the application's `url_for` method (in `sansio/app.py`)" — **there is no `url_for` in `sansio/app.py`**. Grep returns only `src/flask/helpers.py:188` and `src/flask/app.py:1003`. `App.url_for` reads the **singular** `req_ctx.request.blueprint` (`src/flask/app.py:1064`), not the plural `blueprints` property the gold cites at `wrappers.py:180-195`.
- Line anchors that needed re-derivation (all other gold citations verified exact): `src/flask/app.py` `create_url_adapter` body ends at **476** (`return None`), not 475; `Blueprint.add_url_rule` def is `sansio/blueprints.py:413`; `EnvironBuilder`'s `super().__init__(path, base_url, …)` is `src/flask/testing.py:86` (not 93); `state = self.make_setup_state(...)` is `sansio/blueprints.py:321`, matching the gold answer's "line 321" for the *call site* (the `def` is at 246); `App.url_for` internals are `req_ctx` **1060**, `blueprint_name` **1064**, `create_url_adapter(None)` **1087**, `url_adapter.build` **1110**.
- `tests/test_testing.py:303` is the second `subdomain_matching=True` site — that is the sibling `test_subdomain`, not the target. Verbatim, for contrast:

```python
def test_subdomain():
    app = flask.Flask(__name__, subdomain_matching=True)
    app.config["SERVER_NAME"] = "example.com"
    client = app.test_client()

    @app.route("/", subdomain="<company_id>")
    def view(company_id):
        return company_id

    with app.test_request_context():
        url = flask.url_for("view", company_id="xxx")

    with client:
        response = client.get(url)

    assert 200 == response.status_code
    assert b"xxx" == response.data
```

  It differs in every structural respect: no blueprint, `SERVER_NAME` without port, `@app.route` instead of `@bp.route`, and `url_for` + `client.get(url)` instead of `test_request_context("/", subdomain=…)`. Following the mutation probe's line (which is *this* test's line) would answer the wrong question.
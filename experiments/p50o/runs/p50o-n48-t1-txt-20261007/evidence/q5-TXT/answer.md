# The dependency chain in `tests/test_testing.py::test_subdomain`

## 1. Short answer

The chain is: **app construction flag → `SERVER_NAME` config → route rule registered on the URL map with a dynamic subdomain → `test_request_context()` builds the first URL adapter → `url_for` builds an absolute URL → `client.get(url)` creates the second request context, whose adapter is the one that matters → the two assertions.**

The load-bearing fact is that `subdomain_matching` is a **single gate read in one place — `Flask.create_url_adapter`, `src/flask/app.py:458` — and that gate is evaluated twice**, because the test creates two request contexts (one for `url_for`, one for the client request). Both evaluations happen at *context-creation* time, not at route-registration time. Only the **second** evaluation (the client's request context) can observe `subdomain_matching`; the first one is invariant because the test-request-context host equals `SERVER_NAME`, so the derived subdomain is `""` either way. Therefore `url_for`'s output is byte-identical in the unmutated and mutated runs, and the mutation is detected solely by matching after the client request.

---

## 2. The subject test and the mutated replica (both quoted in full)

`tests/test_testing.py` — `test_subdomain` (read directly from the file, lines 301–318):

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

The immediately following neighbour is a contrast case that is **not** subdomain-based (read from the same file, corrected against the inherited evidence — see §8):

```python
def test_nosubdomain(app, client):
    app.config["SERVER_NAME"] = "example.com"

    @app.route("/<company_id>")
    def view(company_id):
        return company_id

    with app.test_request_context():
        url = flask.url_for("view", company_id="xxx")

    with client:
        response = client.get(url)

    assert 200 == response.status_code
    assert b"xxx" == response.data
```

`flask_mut2_i417ar2x/mutated_test.py` — the whole file (`cat` output, verbatim):

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

The **single functional delta** is line 3: `subdomain_matching=True` → `subdomain_matching=False`. Everything else is the same code lifted to module level, plus print instrumentation and a trailing hint line. The trailing `print("ASSERTS PASSED (unexpected)")` is a **message string, not a result**; §5 settles it by execution.

---

## 3. The chain, link by link, with the supporting code

### Link 1 — Configuration: the flag is stored on the app instance

`flask.Flask(__name__, subdomain_matching=True)` → the keyword lands in `Flask.__init__`, `src/flask/sansio/app.py`:

```python
        static_folder: str | os.PathLike[str] | None = "static",
        static_host: str | None = None,
        host_matching: bool = False,
        subdomain_matching: bool = False,
        template_folder: str | os.PathLike[str] | None = "templates",
        instance_path: str | None = None,
        instance_relative_config: bool = False,
```

and the end of `Flask.__init__` (`src/flask/sansio/app.py:405–410`) wires it:

```python
        self.url_map = self.url_map_class(host_matching=host_matching)

        self.subdomain_matching = subdomain_matching

        # tracks internally if the application already handled at least one
        # request.
        self._got_first_request = False
```

`self.subdomain_matching` is a **plain instance attribute**; the `Map` is built with `host_matching` only, so `Map.default_subdomain` keeps its default (`""`). The class attributes it draws on are declared in the same module:

```python
    #: The subclass of :class:`werkzeug.routing.Rule` to be used as the
    #: default class for all rules created by this app.
    url_rule_class = Rule
```

and the parameter is documented as:

```python
    :param subdomain_matching: consider the subdomain relative to
        :data:`SERVER_NAME` when matching routes. Defaults to False.
```

### Link 2 — Configuration: `SERVER_NAME` is the second input

`app.config["SERVER_NAME"] = "example.com"` feeds two consumers:

(a) the test environ builder, `src/flask/testing.py` — `EnvironBuilder.__init__`:

```python
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
```

This is why `app.test_request_context()` with no arguments yields `HTTP_HOST = "example.com"`, and why handing an **absolute** URL to `client.get()` keeps the URL's own netloc (`url.netloc` wins over `http_host`).

(b) the adapter factory, `src/flask/app.py` — `create_url_adapter` (full body, read at lines 425–476):

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

**`elif not self.subdomain_matching:` at line 458 is the single gate of the entire chain.** `True` → `subdomain = None` (Werkzeug derives it); `False` → `subdomain = ""` (Werkzeug's derivation is bypassed because the argument is not `None`). The request-less branch (lines 469–475) uses `Map.bind(SERVER_NAME, …)` and never consults `subdomain_matching`.

The intended semantics are stated in-tree as well — `docs/config.rst`:

```rst
.. py:data:: SERVER_NAME

    Inform the application what host and port it is bound to.

    Must be set if ``subdomain_matching`` is enabled, to be able to extract the
    subdomain from the request.

    Must be set for ``url_for`` to generate external URLs outside of a
    request context.

    Default: ``None``

    .. versionchanged:: 3.1
        Does not restrict requests to only this domain, for both
        ``subdomain_matching`` and ``host_matching``.

    .. versionchanged:: 1.0
        Does not implicitly enable ``subdomain_matching``.
```

and `CHANGES.rst`:

```rst
-   Fix how setting ``host_matching=True`` or ``subdomain_matching=False``
    interacts with ``SERVER_NAME``. Setting ``SERVER_NAME`` no longer restricts
    requests to only that domain. :issue:`5553`
```

### Link 3 — Route registration: `subdomain="<company_id>"` becomes a rule on the URL map

`@app.route("/", subdomain="<company_id>")` is the decorator in `src/flask/sansio/scaffold.py:336–365`:

```python
    def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        """Decorate a view function to register it with the given URL
        rule and options. Calls :meth:`add_url_rule`, which has more
        details about the implementation.
        ...
        """
        def decorator(f: T_route) -> T_route:
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f

        return decorator
```

which lands in `App.add_url_rule`, `src/flask/sansio/app.py:605–661`:

```python
    def add_url_rule(
        self,
        rule: str,
        endpoint: str | None = None,
        view_func: ft.RouteCallable | None = None,
        provide_automatic_options: bool | None = None,
        **options: t.Any,
    ) -> None:
        if endpoint is None:
            endpoint = _endpoint_from_view_func(view_func)  # type: ignore
        options["endpoint"] = endpoint
        ...
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

Two facts fall out:

* `subdomain="<company_id>"` travels through `**options` into `self.url_rule_class(...)` — i.e. `werkzeug.routing.Rule(..., subdomain="<company_id>")` — so the **domain part of the rule is the dynamic segment `<company_id>`**, not a path segment.
* The endpoint defaults to the view function's name, `src/flask/sansio/scaffold.py:701–706`:

```python
def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
    """Internal helper that returns the default endpoint for a given
    function.  This always is the function name.
    """
    assert view_func is not None, "expected view func if endpoint is not provided."
    return view_func.__name__
```

Hence the endpoint registered is the literal string `"view"` — exactly what `flask.url_for("view", ...)` must resolve, and what `client.get()` will match by.

The rule is enrolled into the matcher and the endpoint index by `Map.add`, `.venv/Lib/site-packages/werkzeug/routing/map.py:170–180`:

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
```

### Link 4 — Request-context creation #1: `with app.test_request_context():` builds the first adapter

`src/flask/app.py:1407–1477`:

```python
    def request_context(self, environ: WSGIEnvironment) -> RequestContext:
        ...
        return RequestContext(self, environ)

    def test_request_context(self, *args: t.Any, **kwargs: t.Any) -> RequestContext:
        """Create a :class:`~flask.ctx.RequestContext` for a WSGI
        environment created from the given values. ...
        """
        from .testing import EnvironBuilder

        builder = EnvironBuilder(self, *args, **kwargs)

        try:
            return self.request_context(builder.get_environ())
        finally:
            builder.close()
```

`RequestContext.__init__`, `src/flask/ctx.py:309–324`, is where the flag is read for the first time:

```python
    def __init__(
        self,
        app: Flask,
        environ: WSGIEnvironment,
        request: Request | None = None,
        session: SessionMixin | None = None,
    ) -> None:
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

Because the context is entered with `push()` (in the same class, at lines 367+):

```python
    def push(self) -> None:
        # Before we push the request context we have to ensure that
        # there is an application context.
        app_ctx = _cv_app.get(None)

        if app_ctx is None or app_ctx.app is not self.app:
            app_ctx = self.app.app_context()
            app_ctx.push()
        else:
            app_ctx = None

        self._cv_tokens.append((_cv_request.set(self), app_ctx))
        ...
        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
        if self.url_adapter is not None:
            self.match_request()
```

a *shadowed* second adapter creation also happens here: pushing the request context pushes an `AppContext`, and `AppContext.__init__` (`src/flask/ctx.py:245–247`) calls the **request-less** branch:

```python
    def __init__(self, app: Flask) -> None:
        self.app = app
        self.url_adapter = app.create_url_adapter(None)
        self.g: _AppCtxGlobals = app.app_ctx_globals_class()
        self._cv_tokens: list[contextvars.Token[AppContext]] = []
```

That adapter is built with `Map.bind(SERVER_NAME, …)`, has `subdomain == ""` regardless of the flag, and is **not** on the critical path (it only matters if a URL is built with no request context at all). The instrumented run in §5 shows these `request=None` calls firing on every push and producing identical values in both variants.

**Outcome of link 4 (verified twice — statically and by instrumentation):** the test-request-context adapter has `subdomain == ""` for **both** `subdomain_matching` values, because:

* `True` → Flask passes `subdomain=None`, and Werkzeug derives `""` from host `example.com` == `SERVER_NAME` `example.com`; and
* `False` → Flask itself forces `subdomain = self.url_map.default_subdomain or ""` → `""`.

### Link 5 — URL building: `flask.url_for("view", company_id="xxx")` inside that context

`flask.url_for` is a thin delegate, `src/flask/helpers.py`:

```python
def url_for(
    endpoint: str,
    *,
    _anchor: str | None = None,
    _method: str | None = None,
    _scheme: str | None = None,
    _external: bool | None = None,
    **values: t.Any,
) -> str:
    """Generate a URL to the given endpoint with the given values.

    This requires an active request or application context, and calls
    :meth:`current_app.url_for() <flask.Flask.url_for>`. See that method
    for full documentation.
    ...
    """
    return current_app.url_for(
        endpoint,
        _anchor=_anchor,
        _method=_method,
        _scheme=_scheme,
        _external=_external,
        **values,
    )
```

`Flask.url_for` (`src/flask/app.py:1003`+), body:

```python
        req_ctx = _cv_request.get(None)

        if req_ctx is not None:
            url_adapter = req_ctx.url_adapter
            blueprint_name = req_ctx.request.blueprint

            # If the endpoint starts with "." and the request matches a
            # blueprint, the endpoint is relative to the blueprint.
            if endpoint[:1] == ".":
                if blueprint_name is not None:
                    endpoint = f"{blueprint_name}{endpoint}"
                else:
                    endpoint = endpoint[1:]

            # When in a request, generate a URL without scheme and
            # domain by default, unless a scheme is given.
            if _external is None:
                _external = _scheme is not None
        else:
            app_ctx = _cv_app.get(None)

            # If called by helpers.url_for, an app context is active,
            # use its url_adapter. Otherwise, app.url_for was called
            # directly, build an adapter.
            if app_ctx is not None:
                url_adapter = app_ctx.url_adapter
            else:
                url_adapter = self.create_url_adapter(None)

            if url_adapter is None:
                raise RuntimeError(
                    "Unable to build URLs outside an active request"
                    " without 'SERVER_NAME' configured. Also configure"
                    " 'APPLICATION_ROOT' and 'PREFERRED_URL_SCHEME' as"
                    " needed."
                )

            # When outside a request, generate a URL with scheme and
            # domain by default.
            if _external is None:
                _external = True

        # It is an error to set _scheme when _external=False, in order
        # to avoid accidental insecure URLs.
        if _scheme is not None and not _external:
            raise ValueError("When specifying '_scheme', '_external' must be True.")

        self.inject_url_defaults(endpoint, values)

        try:
            rv = url_adapter.build(  # type: ignore[union-attr]
                endpoint,
                values,
                method=_method,
                url_scheme=_scheme,
                force_external=_external,
            )
        except BuildError as error:
            values.update(
                _anchor=_anchor, _method=_method, _scheme=_scheme, _external=_external
            )
            return self.handle_url_build_error(error, endpoint, values)

        if _anchor is not None:
            _anchor = _url_quote(_anchor, safe="%!#$&'()*+,/:;=?@")
            rv = f"{rv}#{_anchor}"

        return rv
```

Because a request context **is** active (Link 4), the first branch runs: `url_adapter = req_ctx.url_adapter` (adapter **A**, `subdomain == ""` in both variants) and `_external` becomes `_scheme is not None` → `False`. The `else:` branch with `create_url_adapter(None)` at line 1087 is **not** reached.

Werkzeug then builds the URL — `MapAdapter.get_host` and the tail of `MapAdapter.build`, `.venv/Lib/site-packages/werkzeug/routing/map.py:696–716` and `:919–957`:

```python
    def get_host(self, domain_part: str | None) -> str:
        """Figures out the full host name for the given domain part.  The
        domain part is a subdomain in case host matching is disabled or
        a full host name.
        """
        if self.map.host_matching:
            if domain_part is None:
                return self.server_name

            return domain_part

        if domain_part is None:
            subdomain = self.subdomain
        else:
            subdomain = domain_part

        if subdomain:
            return f"{subdomain}.{self.server_name}"
        else:
            return self.server_name
```

```python
        domain_part, path, websocket = rv
        host = self.get_host(domain_part)

        if url_scheme is None:
            url_scheme = self.url_scheme
        ...
        secure = url_scheme in {"https", "wss"}

        if websocket:
            force_external = True
            url_scheme = "wss" if secure else "ws"
        elif url_scheme:
            url_scheme = "https" if secure else "http"

        # shortcut this.
        if not force_external and (
            (self.map.host_matching and host == self.server_name)
            or (not self.map.host_matching and domain_part == self.subdomain)
        ):
            return f"{self.script_name.rstrip('/')}/{path.lstrip('/')}"

        scheme = f"{url_scheme}:" if url_scheme else ""
        return f"{scheme}//{host}{self.script_name[:-1]}/{path.lstrip('/')}"
```

Here `domain_part == "xxx"` (the rule's `<company_id>` value) while `self.subdomain == ""`, so the "shortcut" test `domain_part == self.subdomain` is **False** and the full external URL is returned: `http://xxx.example.com/`.

**Key consequence:** because adapter A has `subdomain == ""` under *both* settings (Link 4), `url_for` yields `http://xxx.example.com/` identically in the original and the mutated program. **The mutation cannot change URL generation.** The observed `url_for -> http://xxx.example.com/` line in the mutant's output confirms this.

### Link 6 — Request-context creation #2: `client.get(url)` — this is where the mutation bites

`client.get(url)` goes through `FlaskClient`, `src/flask/testing.py:193–204`:

```python
    def _request_from_builder_args(
        self, args: tuple[t.Any, ...], kwargs: dict[str, t.Any]
    ) -> BaseRequest:
        kwargs["environ_base"] = self._copy_environ(kwargs.get("environ_base", {}))
        builder = EnvironBuilder(self.application, *args, **kwargs)

        try:
            return builder.get_request()
        finally:
            builder.close()

    def open(
```

Since `url` is absolute (`http://xxx.example.com/`), `EnvironBuilder` takes the `url.netloc` branch (Link 2a) and the request's `HTTP_HOST` is **`xxx.example.com`**. `FlaskClient.open` hands the request to Werkzeug's `Client.open`, which drives the WSGI application:

`src/flask/app.py:1479+`, `wsgi_app`:

```python
    def wsgi_app(
        self, environ: WSGIEnvironment, start_response: StartResponse
    ) -> cabc.Iterable[bytes]:
        ...
        ctx = self.request_context(environ)
        error: BaseException | None = None
        try:
            try:
                ctx.push()
                response = self.full_dispatch_request()
            except Exception as e:
                error = e
                response = self.handle_exception(e)
            ...
            return response(environ, start_response)
        finally:
            ...
                ctx.pop(error)
```

`self.request_context(environ)` → `RequestContext(self, environ)` → `create_url_adapter(self.request)` **again** (Link 4's code, same gate at `src/flask/app.py:458`), but this time the environ host is `xxx.example.com`:

* `subdomain_matching=True`: Flask passes `subdomain=None`; Werkzeug's `Map.bind_to_environ` derives it, `.venv/Lib/site-packages/werkzeug/routing/map.py:321–339`:

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

  → `["xxx","example","com"][:-2]` = `["xxx"]` → `subdomain = "xxx"`. Adapter **B** has `subdomain == "xxx"`.

* `subdomain_matching=False` (the mutant): Flask passes `subdomain=""` explicitly, so the `if subdomain is None …` derivation is skipped entirely and Werkzeug never computes `"xxx"`. Adapter **B** has `subdomain == ""`.

Adapter B is then used for matching, because `RequestContext.push` calls `match_request` (`src/flask/ctx.py:357–365`):

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

and `MapAdapter.match` uses the adapter's subdomain as the domain part (`map.py:597–600`):

```python
        domain_part = self.server_name

        if not self.map.host_matching and self.subdomain is not None:
            domain_part = self.subdomain
```

So the matcher compares `domain_part = ""` (mutant) or `"xxx"` (original) against the rule's domain pattern `<company_id>`, which compiles to the default converter regex `[^/]+` (`.venv/Lib/site-packages/werkzeug/routing/converters.py:25`):

```python
class BaseConverter:
    """Base class for all converters.
    ...
    """

    regex = "[^/]+"
    weight = 100
    part_isolating = True
```

`[^/]+` demands **at least one character**, so `domain_part == ""` cannot satisfy it: no rule matches, `MapAdapter.match` raises `NotFound`, and `RequestContext.__init__`'s `except HTTPException` cannot catch it (it happens later, in `match_request`), so it is stored on `request.routing_exception`.

### Link 7 — Dispatch and the assertions

`src/flask/app.py`, dispatch:

```python
    def dispatch_request(self) -> ft.ResponseReturnValue:
        """Does the request dispatching.  Matches the URL and returns the
        return value of the view or error handler.  This does not have to
        ...
        """
        ...
        req = request_ctx.request
        if req.routing_exception is not None:
            self.raise_routing_exception(req)
        rule: Rule = req.url_rule
        ...
        view_args: dict[str, t.Any] = req.view_args
        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)
```

`raise_routing_exception` re-raises for a GET 404 (`src/flask/app.py:478–500`):

```python
    def raise_routing_exception(self, request: Request) -> t.NoReturn:
        ...
        if (
            not self.debug
            or not isinstance(request.routing_exception, RequestRedirect)
            or request.routing_exception.code in {307, 308}
            or request.method in {"GET", "HEAD", "OPTIONS"}
        ):
            raise request.routing_exception
```

and `handle_user_exception` turns that `HTTPException` into a response (`src/flask/app.py:779–805`):

```python
        if isinstance(e, HTTPException) and not self.trap_http_exception(e):
            return self.handle_http_exception(e)

        handler = self._find_error_handler(e, request.blueprints)

        if handler is None:
            raise

        return self.ensure_sync(handler)(e)
```

Net effect: **404** in the mutant, so:

```python
    assert 200 == response.status_code
    assert b"xxx" == response.data
```
…the first assertion (`assert 200 == response.status_code`, or with the mutant's message `f"status {response.status_code}"`) is the one that fires. In the original (`subdomain_matching=True`), adapter B's `subdomain == "xxx"` matches `<company_id>`, `view` is called with `company_id="xxx"`, it returns `"xxx"`, and both assertions hold.

---

## 4. The chain as a single ordered statement

| # | Step in the test | Mechanism | Source |
|---|---|---|---|
| 1 | `flask.Flask(__name__, subdomain_matching=True)` | `self.subdomain_matching = subdomain_matching` stored as instance attribute | `src/flask/sansio/app.py:405–407` |
| 2 | `app.config["SERVER_NAME"] = "example.com"` | consumed by `EnvironBuilder.__init__` (`http_host = app.config.get("SERVER_NAME") or "localhost"`) and passed as `server_name=` in `create_url_adapter` | `src/flask/testing.py:65–85`; `src/flask/app.py:452, 465–467` |
| 3 | `@app.route("/", subdomain="<company_id>")` | decorator → `App.add_url_rule` → `Rule(..., subdomain="<company_id>")` → `url_map.add` → `_matcher.add`; endpoint `"view"` from `_endpoint_from_view_func` | `sansio/scaffold.py:336–365, 701–706`; `sansio/app.py:605–661`; `werkzeug/routing/map.py:170–180` |
| 4 | `with app.test_request_context():` | `EnvironBuilder` → `request_context` → `RequestContext.__init__` → **`create_url_adapter(request)` #1** → gate at `app.py:458`; host `example.com` ⇒ `subdomain == ""` **in both variants** | `src/flask/app.py:1407–1477`; `src/flask/ctx.py:309–324` |
| 5 | `flask.url_for("view", company_id="xxx")` | `helpers.url_for` → `Flask.url_for` request-context branch (`url_adapter = req_ctx.url_adapter`, `_external=False`) → `MapAdapter.build`; `domain_part "xxx" != adapter.subdomain ""` ⇒ full URL `http://xxx.example.com/` — **identical in both variants** | `src/flask/helpers.py:188–239`; `src/flask/app.py:1060–1127`; `werkzeug/routing/map.py:696–716, 919–957` |
| 6 | `client.get(url)` | `FlaskClient`/`EnvironBuilder` → WSGI with host `xxx.example.com` → `wsgi_app` → `request_context` → `RequestContext.__init__` → **`create_url_adapter(request)` #2** → `True`: Werkzeug derives `"xxx"`; `False`: Flask forces `""` → `push()` → `match_request()` → `MapAdapter.match` with `domain_part` = that subdomain, compared against `<company_id>` (`[^/]+`) | `src/flask/testing.py:193–204`; `src/flask/app.py:1479–1520`; `src/flask/ctx.py:309–324, 357–383`; `werkzeug/routing/map.py:321–339, 597–600` |
| 7 | `assert 200 == response.status_code`, `assert b"xxx" == response.data` | pass iff link 6 matched `<company_id>` ⇒ iff `subdomain_matching` was `True` | `tests/test_testing.py:317–318`; `flask_mut2_i417ar2x/mutated_test.py:20–21` |

**Sharpest framing:** `subdomain_matching` is the single gate in the chain (`src/flask/app.py:458`), it is evaluated at *context creation*, and the test creates two contexts. Only the second evaluation — the one for `client.get(url)` — can observe the mutation. Any account that says the mutation changes `url_for`'s output is wrong and is contradicted by the executed evidence below and by the code path above.

---

## 5. Executed evidence (settles the chain empirically)

All commands were run from the working directory with `.venv/Scripts/python.exe`. Outputs are reproduced verbatim as observed.

### 5.1 Environment / versions

```
Python 3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
```
```
flask 3.2.0.dev0
werkzeug 3.1.3
pytest 8.4.0
```

`.venv/Lib/site-packages/flask.pth` (single line) registers the editable Flask source root, and `flask-3.2.0.dev0.dist-info` / `werkzeug-3.1.3.dist-info` are present. Note for attribution: the interpreter resolves `import flask` through that `.pth` to a source tree registered outside this working directory, while the code quoted in §3 was read from `./src/flask` in this tree; the functions on the chain (`create_url_adapter`, `url_for`, `RequestContext.__init__`, `EnvironBuilder.__init__`, `add_url_rule`) match line-for-line between the two, as verified by direct reads.

### 5.2 Baseline test — the chain is intact

`.venv/Scripts/python.exe -m pytest tests/test_testing.py::test_subdomain -q` — exit 0:

```
.                                                                        [100%]
1 passed in 0.07s
```

### 5.3 The mutated replica, run directly

`.venv/Scripts/python.exe flask_mut2_i417ar2x/mutated_test.py` — exit 1:

```
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
Traceback (most recent call last):
  File "C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q5-TXT\seal\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: status 404
```

Observed facts: `url_for` printed **the same URL** the unmutated test builds; `status_code` is `404`; the run dies at line 20 on the **first** assertion; the trailing `print("ASSERTS PASSED (unexpected)")` at line 22 was **never reached and never printed**. The mutant's own trailing print is therefore demonstrably not evidence.

### 5.4 Instrumented run — the two adapters, side by side

A temporary script wrapped `app.create_url_adapter` to log each adapter creation for each flag value. Output (exit 0):

```
======================================================================
RUN with subdomain_matching = True
  app.subdomain_matching = True
  rule subdomain         = ['', '<company_id>']
  create_url_adapter(request='example.com') -> subdomain='' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  url_for -> http://xxx.example.com/
  create_url_adapter(request='xxx.example.com') -> subdomain='xxx' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  status_code: 200
  data[:80]  : b'xxx'
  captured: request_host='example.com' adapter_subdomain='' url_rule=None routing_exception=<NotFound '404: Not Found'>
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
  captured: request_host='xxx.example.com' adapter_subdomain='xxx' url_rule=<Rule '<company_id>|/' (OPTIONS, HEAD, GET) -> view> routing_exception=None
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
======================================================================
RUN with subdomain_matching = False
  app.subdomain_matching = False
  rule subdomain         = ['', '<company_id>']
  create_url_adapter(request='example.com') -> subdomain='' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  url_for -> http://xxx.example.com/
  create_url_adapter(request='xxx.example.com') -> subdomain='' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  create_url_adapter(request=None) -> subdomain='' server_name='example.com'
  status_code: 404
  data[:80]  : b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<'
  captured: request_host='example.com' adapter_subdomain='' url_rule=None routing_exception=<NotFound '404: Not Found'>
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
  captured: request_host='xxx.example.com' adapter_subdomain='' url_rule=None routing_exception=<NotFound '404: Not Found'>
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
  captured: request_host=None adapter_subdomain='' url_rule=None routing_exception=None
```

Witnessed deltas between the two runs (everything else identical):

| Observation | `True` | `False` |
|---|---|---|
| `url_for` result | `http://xxx.example.com/` | `http://xxx.example.com/` (**identical**) |
| adapter for `app.test_request_context()` (`request_host='example.com'`) | `subdomain=''` | `subdomain=''` (**identical**) |
| adapter for `client.get(url)` (`request_host='xxx.example.com'`) | `subdomain='xxx'` | `subdomain=''` (**differs**) |
| `request.url_rule` for the client request | `<Rule '<company_id>|/' (OPTIONS, HEAD, GET) -> view>` | `None` |
| `request.routing_exception` for the client request | `None` | `<NotFound '404: Not Found'>` |
| `status_code` | `200` | `404` |
| `data` | `b'xxx'` | `b'<!doctype html>...404 Not Found...'` |

Both runs register `rule subdomain = ['', '<company_id>']`, confirming link 3 is mutation-independent. The `request=None` lines are the shadowed `AppContext.__init__` adapters of link 4; they are `''` in both variants and are not the differing link.

### 5.5 The replica under pytest

`.venv/Scripts/python.exe -m pytest flask_mut2_i417ar2x/mutated_test.py -q` — exit 2:

```
=================================== ERRORS ====================================
____________ ERROR collecting flask_mut2_i417ar2x/mutated_test.py _____________
..\..\..\..\..\..\Roaming\uv\python\cpython-3.13.9-windows-x86_64-none\Lib\importlib\__init__.py:88: in import_module
    return _bootstrap._gcd_import(name[level:], package, level)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
<frozen importlib._bootstrap>:1387: in _gcd_import
    ???
<frozen importlib._bootstrap>:1360: in _find_and_load
    ???
<frozen importlib._bootstrap>:1331: in _find_and_load_unlocked
    ???
<frozen importlib._bootstrap>:935: in _load_unlocked
    ???
.venv\Lib\site-packages\_pytest\assertion\rewrite.py:186: in exec_module
    exec(co, module.__dict__)
D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\flask_mut2_i417ar2x\mutated_test.py:20: in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
E   AssertionError: status 404
E   assert 200 == 404
E    +  where 404 = <WrapperTestResponse 207 bytes [404 NOT FOUND]>.status_code
------------------------------- Captured stdout -------------------------------
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
=========================== short test summary info ============================
ERROR flask_mut2_i417ar2x/mutated_test.py - AssertionError: status 404
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.91s
```

The mutated file has no `def`/`__main__` guard, so its body runs at **import/collection** time and the failure surfaces as a collection error at line 20 rather than as a named test node.

### 5.6 Prior-session artifacts (independent corroboration)

`.pytest_cache/v/cache/lastfailed`:

```json
{
  "examples/javascript/tests": true,
  "examples/tutorial/tests": true,
  "flask_mut2_i417ar2x/mutated_test.py": true
}
```

`flask_mut2_i417ar2x/__pycache__/` contains exactly `mutated_test.cpython-313-pytest-8.4.0.pyc` — the `-pytest-8.4.0` tag shows the file was imported under pytest's assertion rewriting.

`pyproject.toml` explains the invocation constraints:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
filterwarnings = [
    "error",
]
```

`testpaths = ["tests"]` is why the mutant is outside a bare `pytest` run and must be named explicitly; `filterwarnings = "error"` means any routing warning (e.g. the `bind_to_environ` server-name-mismatch warning) escalates to an error.

### 5.7 Full suite (unmutated tree) — nothing else is disturbed

`.venv/Scripts/python.exe -m pytest` — exit 0:

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q5-TXT\seal
configfile: pyproject.toml
testpaths: tests
collected 489 items
... (per-file progress lines elided only in this transcription; every line was
     'PASSED', including 'tests/test_testing.py::test_subdomain')
============================= 489 passed in 5.95s =============================
```

The `-vvv` run recorded 499 lines / 88,575 bytes and confirms the individual node ids, including:

```
tests/test_testing.py::test_subdomain ... PASSED [ 94%]
tests/test_basic.py::test_server_name_matching[True-False-default-abc-<invalid>] ... PASSED
tests/test_basic.py::test_subdomain_matching ... PASSED
```

The `<invalid>` parametrization is the literal produced by the `bind_to_environ` mismatch branch quoted in link 6.

**Verdict:** the mutation changes **only the client-side adapter's subdomain** (`'xxx'` → `''`), so the `<company_id>` rule no longer matches → `NotFound` → HTTP 404 → `assert 200 == response.status_code` fails. The mutant is **killed**, and the killing assertion is the **first** one (status code), not the body assertion. The `url_for` step is provably unaffected.

---

## 6. Why each link is load-bearing (dependency, not mere sequence)

* Remove link 1's flag (`subdomain_matching=False`) → the chain still *runs* all the way to link 7, but adapter B in link 6 is forced to `""` and the assertions fail. This is exactly the mutant.
* Remove link 2's `SERVER_NAME` → `EnvironBuilder` would use `localhost`; `url_for` inside the request context would build a relative/`http://xxx.localhost/`-style URL; and `create_url_adapter`'s request-less branch would return `None`. The test would fail differently.
* Remove link 3's `subdomain="<company_id>"` → the rule's domain part would be the default `""`, and matching would succeed even with `subdomain=""`; the test would pass trivially and would no longer be verifying subdomain matching at all.
* Remove link 4 → no active request context, so `url_for` would take the `else:` branch (`create_url_adapter(None)` → `Map.bind(SERVER_NAME, …)`) with `_external=True`. That adapter is *not* the one the test intends to exercise, and the mutation would be invisible in that leg (it does not read `subdomain_matching` at all).
* The two adapter creations in links 4 and 6 are distinct objects made by the same gate; the test's discriminating power comes entirely from the fact that link 6's host (`xxx.example.com`) differs from link 4's host (`example.com`).

---

## 7. Practically, what a reader should take away

1. **The dependency chain runs config → rule → context, not config → rule → `url_for`.** The configuration that matters is consumed at *context-creation* time (`create_url_adapter`), and the route registration matters because it puts a **dynamic domain segment** (`<company_id>`, matched by `[^/]+`) into the map.
2. **`subdomain_matching` is read exactly once per adapter creation, at `src/flask/app.py:458`, and the test creates two adapters.** The first (for `app.test_request_context()`) is invariant across the mutation; the second (for `client.get(url)`) is the one that flips.
3. **`url_for` output is not part of the mutated behaviour.** Both variants produce `http://xxx.example.com/` — witnessed, not inferred.
4. **The mutation is detected by the status-code assertion, and it fails at module import if the replica is collected by pytest.**

---

## 8. Corrections to the inherited retrieval report (verified against the files)

Three inherited quotations did not survive direct re-reading; the corrected text is used throughout §3:

1. **`tests/test_testing.py::test_nosubdomain`.** The retrieval report claimed a body built without fixtures ("`app = flask.Flask(__name__)  # note: subdomain_matching default (False)`", plus an inline `resp = client.get("/")` assertion). The actual file reads:

```python
def test_nosubdomain(app, client):
    app.config["SERVER_NAME"] = "example.com"

    @app.route("/<company_id>")
    def view(company_id):
        return company_id

    with app.test_request_context():
        url = flask.url_for("view", company_id="xxx")

    with client:
        response = client.get(url)

    assert 200 == response.status_code
    assert b"xxx" == response.data
```

   It takes fixtures `(app, client)` and uses `@app.route("/<company_id>")` — a **path** segment, i.e. the deliberate contrast case for subdomain matching. This does not affect the `test_subdomain` chain.

2. **`create_url_adapter`'s `versionchanged:: 3.1` docstring and the `not subdomain_matching` comment.** The report rendered the docstring as "If `SERVER_NAME` is set, it *only* restricts requests to only that domain" (a sign flip) and the code comment as "Werkzeug doesn't implement subdomain matching for routes that specify a host (and there is a bug where it thinks they do)". The file actually says:

```python
        .. versionchanged:: 3.1
            If :data:`SERVER_NAME` is set, it does not restrict requests to
            only that domain, for both ``subdomain_matching`` and
            ``host_matching``.
```
```python
            elif not self.subdomain_matching:
                # Werkzeug doesn't implement subdomain matching yet. Until then,
                # disable it by forcing the current subdomain to the default, or
                # the empty string.
                subdomain = self.url_map.default_subdomain or ""
```

   The corrected wording agrees with `docs/config.rst` and `CHANGES.rst` quoted in link 2.

3. **Werkzeug line numbers.** The report cited `MapAdapter.match` at "lines 598–601" and the `MapAdapter.build` tail at "lines 975–981". The actual positions are `match` at 492 (domain-part selection at 597–600), `get_host` at 696, `build` at 828 (tail at ≈946–957), `Map.add` at 170, `bind_to_environ` at 252 (subdomain derivation at 321–339). The quoted code text itself was accurate.
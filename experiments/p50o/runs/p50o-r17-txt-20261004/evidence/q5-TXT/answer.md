# The dependency chain in `tests/test_testing.py::test_subdomain`

## 0. Direct answer

The test function is **`tests/test_testing.py::test_subdomain`**, lines **302–318**. Its dependency chain is a **linear prerequisite chain** of six statements plus the assertions, each consuming a name produced by the previous one:

```
:303  app = flask.Flask(__name__, subdomain_matching=True)       → app (+ url_map, subdomain_matching, config)
:304  app.config["SERVER_NAME"] = "example.com"                   → SERVER_NAME consumed by environ-building and by create_url_adapter
:305  client = app.test_client()                                   → client (FlaskClient bound to app)
:307  @app.route("/", subdomain="<company_id>") → def view(...)    → Rule in app.url_map + view_functions["view"]
:311  with app.test_request_context():                             → pushed request context + AppContext with url_adapter
:312      url = flask.url_for("view", company_id="xxx")            → url == "http://xxx.example.com/"
:314  with client:                                                 → preserved-context client block
:315      response = client.get(url)                               → response (dispatch through the subdomain rule)
:317  assert 200 == response.status_code
:318  assert b"xxx" == response.data
```

Two nodes are *setup* dependencies (`:303`–`:309`: construction, configuration, client, rule registration) and two are *execution* dependencies (`:311`–`:315`), with `:317-318` verifying the result. The chain is **linear rather than a set** because node 6's request target literally *is* the string produced by node 5: `client.get(url)` receives `url` from `flask.url_for(...)`, and `url` can only be built because node 4 registered the rule and node 2 supplied `SERVER_NAME`.

The single mechanism that ties configuration, route registration and request-context creation together is `Flask.create_url_adapter`, which is the **only** place `subdomain_matching` is read, and which is called **twice per test**: once with `request=None` (building the URL) and once with a request (matching the URL).

---

## 1. The target test function (verbatim, verified by direct read)

`tests/test_testing.py` lines 302–318:

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

This was re-read at offset 294–338 to confirm the exact text and line span. It is the **only** test in the tree whose body chains configuration (`SERVER_NAME`) → route registration with `subdomain=`) → `test_request_context()` → `flask.url_for` → `client.get(url)` → assertions. It takes **no pytest fixtures** — it builds its own app and client — which is why the whole chain is visible inside the function body (the shared fixtures that its siblings use are `tests/conftest.py:46-64`, quoted in §7.7 below).

---

## 2. The six in-function nodes

| # | Line(s) | Statement | Consumes | Produces |
|---|---------|-----------|----------|----------|
| 1 | `:303` | `app = flask.Flask(__name__, subdomain_matching=True)` | — | `app`; internally `app.url_map`, `app.subdomain_matching`, `app.config` |
| 2 | `:304` | `app.config["SERVER_NAME"] = "example.com"` | `app` (needs `app.config` created in `Flask.__init__`) | `SERVER_NAME` value read by both context-creation paths |
| 3 | `:305` | `client = app.test_client()` | `app` | `client` (`FlaskClient` bound to `app`) |
| 4 | `:307`–`:309` | `@app.route("/", subdomain="<company_id>")` on `def view(company_id)` | `app` (`url_map`, `view_functions`), `app.config` | a `Rule` in `app.url_map`; `app.view_functions["view"]` |
| 5 | `:311`–`:312` | `with app.test_request_context(): url = flask.url_for("view", company_id="xxx")` | `app`, `SERVER_NAME` (node 2), the registered rule (node 4) | `url`; while pushed, request context + app context whose `url_adapter` was built from `SERVER_NAME` |
| 6 | `:314`–`:315` | `with client: response = client.get(url)` | `client` (node 3), `url` (node 5), the rule (node 4), `subdomain_matching`/`SERVER_NAME` (nodes 1–2) | `response`; asserts consume `response.status_code` / `response.data` |

Nodes 1–4 are setup; nodes 5–6 are execution. Node 6 consumes node 5's product by value, which is what makes the chain linear.

---

## 3. Framework-level trace, node by node (with quoted source)

### Node 1 — `flask.Flask(__name__, subdomain_matching=True)` (`tests/test_testing.py:303`)

`src/flask/app.py:224-263` forwards the flag:

```python
    def __init__(
        self,
        import_name: str,
        static_url_path: str | os.PathLike[str] | None = None,
        static_folder: str | os.PathLike[str] | None = "static",
        static_host: str | None = None,
        host_matching: bool = False,
        subdomain_matching: bool = False,
        template_folder: str | os.PathLike[str] | None = "templates",
        instance_path: str | None = None,
        instance_relative_config: bool = False,
        root_path: str | None = None,
    ):
        super().__init__(
            import_name=import_name,
            static_url_path=static_url_path,
            static_folder=static_folder,
            static_host=static_host,
            host_matching=host_matching,
            subdomain_matching=subdomain_matching,
            template_folder=template_folder,
            instance_path=instance_path,
            instance_relative_config=instance_relative_config,
            root_path=root_path,
        )
```

(anchors confirmed: `src/flask/app.py:233` = `subdomain_matching: bool = False,`, `:245` = `subdomain_matching=subdomain_matching,`).

`src/flask/sansio/app.py:395-411` — where the flag and the URL map are stored:

```python
        self.url_map = self.url_map_class(host_matching=host_matching)

        self.subdomain_matching = subdomain_matching

        # tracks internally if the application already handled at least one
        # request.
        self._got_first_request = False
```

Confirmed anchors: `src/flask/sansio/app.py:405` (`self.url_map = self.url_map_class(host_matching=host_matching)`) and `:407` (`self.subdomain_matching = subdomain_matching`). The classes used are the class attributes `src/flask/sansio/app.py:257` `url_rule_class = Rule` and `:263` `url_map_class = Map`. The config object node 2 mutates is created at `src/flask/sansio/app.py:319`:

```python
        self.config = self.make_config(instance_relative_config)
```

Default value node 2 overwrites: `src/flask/app.py:188` contains `"SERVER_NAME": None,`.

### Node 2 — `app.config["SERVER_NAME"] = "example.com"` (`tests/test_testing.py:304`)

Documented contract, `docs/config.rst:282-300`:

```
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

`SERVER_NAME` is consumed at two places. First, `src/flask/testing.py:49-86` (`EnvironBuilder.__init__`) turns it into the base-URL host (line 66 confirmed by direct read):

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

Second (and decisively), `create_url_adapter` — see §4.

### Node 3 — `client = app.test_client()` (`tests/test_testing.py:305`)

`src/flask/app.py:669` (def) with body read at offset 655–734:

```python
    def test_client(self, use_cookies: bool = True, **kwargs: t.Any) -> FlaskClient:
        """Creates a test client for this application.  For information
        about unit testing head over to :doc:`/testing`.
        ...
        """
        cls = self.test_client_class
        if cls is None:
            from .testing import FlaskClient as cls
        return cls(  # type: ignore
            self, self.response_class, use_cookies=use_cookies, **kwargs
        )
```

`src/flask/testing.py:109-137` — the client stores no configuration; it only remembers the app and a default environ:

```python
class FlaskClient(Client):
    """Works like a regular Werkzeug test client but has knowledge about
    Flask's contexts to defer the cleanup of the request context until
    the end of a ``with`` block. For general information about how to
    use this class refer to :class:`werkzeug.test.Client`.
    ...
    """

    application: Flask

    def __init__(self, *args: t.Any, **kwargs: t.Any) -> None:
        super().__init__(*args, **kwargs)
        self.preserve_context = False
        self._new_contexts: list[t.ContextManager[t.Any]] = []
        self._context_stack = ExitStack()
        self.environ_base = {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_USER_AGENT": f"Werkzeug/{_get_werkzeug_version()}",
        }
```

### Node 4 — `@app.route("/", subdomain="<company_id>")` (`tests/test_testing.py:307-309`)

`src/flask/sansio/scaffold.py:336-366`:

```python
    @setupmethod
    def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        """Decorate a view function to register it with the given URL
        rule and options. Calls :meth:`add_url_rule`, which has more
        details about the implementation.
        ...
        :param rule: The URL rule string.
        :param options: Extra options passed to the
            :class:`~werkzeug.routing.Rule` object.
        """

        def decorator(f: T_route) -> T_route:
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f

        return decorator
```

`src/flask/sansio/app.py:604-661` — `subdomain="<company_id>"` rides through `**options` into `Rule(...)` and is added to the map:

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

Confirmed anchors: `src/flask/sansio/app.py:605` (def), `:650` (`rule_obj = self.url_rule_class(rule, methods=methods, **options)`), `:653` (`self.url_map.add(rule_obj)`), `:661` (`self.view_functions[endpoint] = view_func`).

`src/flask/sansio/scaffold.py:701-705` supplies the endpoint name `"view"` that node 5 and node 6 will use:

```python
def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
    """Internal helper that returns the default endpoint for a given
    function.  This always is the function name.
    """
    assert view_func is not None, "expected view func if endpoint is not provided."
    return view_func.__name__
```

Werkzeug side of the registration (`.venv/Lib/site-packages/werkzeug/routing/rules.py`, `map.py`):

```python
        self.map = map
        if self.strict_slashes is None:
            self.strict_slashes = map.strict_slashes
        if self.merge_slashes is None:
            self.merge_slashes = map.merge_slashes
        if self.subdomain is None:
            self.subdomain = map.default_subdomain
        self.compile()
```

```python
        if self.map.host_matching:
            domain_rule = self.host or ""
        else:
            domain_rule = self.subdomain or ""
```

```python
        for rule in rulefactory.get_rules(self):
            rule.bind(self)
            if not rule.build_only:
                self._matcher.add(rule)
            self._rules_by_endpoint.setdefault(rule.endpoint, []).append(rule)
        self._remap = True
```

`Rule.__init__` accepts `subdomain: str | None = None` and stores `self.subdomain = subdomain` (`rules.py:459-484`), so the literal `"<company_id>"` becomes a domain-level converter part of the rule.

### Node 5 — `with app.test_request_context(): url = flask.url_for("view", company_id="xxx")` (`tests/test_testing.py:311-312`)

**5a — context creation.** `src/flask/app.py:1423` is `def test_request_context(...)`; its body tail (`:1470-1476`) is:

```python
        from .testing import EnvironBuilder

        builder = EnvironBuilder(self, *args, **kwargs)

        try:
            return self.request_context(builder.get_environ())
        finally:
            builder.close()
```

`src/flask/app.py:1407-1421` — `request_context` returns the `RequestContext` (return statement confirmed at `:1421`):

```python
    def request_context(self, environ: WSGIEnvironment) -> RequestContext:
        """..."""
        return RequestContext(self, environ)
```

`src/flask/ctx.py:309-330` (`RequestContext.__init__`) — creates the request-scoped adapter (confirmed: `app.create_url_adapter(self.request)` is `ctx.py:323`):

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
        self.flashes: list[tuple[str, str]] | None = None
        self.session: SessionMixin | None = session
        # Functions that should be executed after the request on the response
        # object.  These will be called before the regular "after_request"
        # functions.
        self._after_request_functions: list[ft.AfterRequestCallable[t.Any]] = []

        self._cv_tokens: list[
            tuple[contextvars.Token[RequestContext], AppContext | None]
        ] = []
```

`src/flask/ctx.py:238-249` (`AppContext.__init__`) — the app context whose `url_adapter` `flask.url_for` will read (confirmed `ctx.py:247`):

```python
class AppContext:
    """The app context contains application-specific information. An app
    context is created and pushed at the beginning of each request if
    one is not already active. An app context is also pushed when
    running CLI commands.
    """

    def __init__(self, app: Flask) -> None:
        self.app = app
        self.url_adapter = app.create_url_adapter(None)
        self.g: _AppCtxGlobals = app.app_ctx_globals_class()
        self._cv_tokens: list[contextvars.Token[AppContext]] = []
```

`src/flask/ctx.py:367-402` (`RequestContext.push`) — pushing a request context auto-pushes an `AppContext` if none is bound:

```python
    def push(self) -> None:
        # Before we push the request context we have to ensure that there
        # is an application context.
        app_ctx = _cv_app.get(None)

        if app_ctx is None or app_ctx.app is not self.app:
            app_ctx = self.app.app_context()
            app_ctx.push()
        else:
            app_ctx = None

        self._cv_tokens.append((_cv_request.set(self), app_ctx))

        # Open the session at the moment that the request context is available.
        # This allows a custom open_session method to use the request context.
        # Only open a new session if this is the first time the request was
        # pushed, otherwise stream_with_context loses the session.
        if self.session is None:
            session_interface = self.app.session_interface
            self.session = session_interface.open_session(self.app, self.request)

            if self.session is None:
                self.session = session_interface.make_null_session(self.app)

        # Match the request URL after loading the session, so that the
        # session is available in custom URL converters.
        if self.url_adapter is not None:
            self.match_request()
```

**5b — URL building.** `src/flask/helpers.py:188` is `def url_for(...)`; the proxy call (confirmed at `:231-239`) is:

```python
    return current_app.url_for(
        endpoint,
        _anchor=_anchor,
        _method=_method,
        _scheme=_scheme,
        _external=_external,
        **values,
    )
```

`src/flask/app.py:1003` is `def url_for(`; the operative body:

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

(Confirmed anchors: `url_adapter = self.create_url_adapter(None)` at `src/flask/app.py:1087`; the `RuntimeError` text begins at `:1091`.) Node 5's block contains **no request**, so `_cv_request.get(None)` is `None` → it takes the `else` branch, uses `app_ctx.url_adapter` (an adapter built by `AppContext.__init__` via `create_url_adapter(None)`), and defaults `_external = True`. That is why the built URL is an absolute external URL: `http://xxx.example.com/`.

Build-error handling that experiment 4 exercises, `src/flask/sansio/app.py:932-961`:

```python
    def handle_url_build_error(
        self, error: BuildError, endpoint: str, values: dict[str, t.Any]
    ) -> str:
        """Called by :meth:`.url_for` if a
        :exc:`~werkzeug.routing.BuildError` was raised. If this returns
        a value, it will be returned by ``url_for``, otherwise the error
        will be re-raised.
        ...
        """
        for handler in self.url_build_error_handlers:
            try:
                rv = handler(error, endpoint, values)
            except BuildError as e:
                # make error available outside except block
                error = e
            else:
                if rv is not None:
                    return rv

        # Re-raise if called with an active exception, otherwise raise
        # the passed in exception.
        if error is sys.exc_info()[1]:
            raise

        raise error
```

`url_build_error_handlers` defaults to `[]` (`src/flask/sansio/app.py:353-355`), so in this test a build error propagates.

`current_app` and its unbound error message (exercised by experiment 3), `src/flask/globals.py`:

```python
_no_app_msg = """\
Working outside of application context.

This typically means that you attempted to use functionality that needed
the current application. To solve this, set up an application context
with app.app_context(). See the documentation for more information.\
"""
_cv_app: ContextVar[AppContext] = ContextVar("flask.app_ctx")
app_ctx: AppContext = LocalProxy(  # type: ignore[assignment]
    _cv_app, unbound_message=_no_app_msg
)
current_app: Flask = LocalProxy(  # type: ignore[assignment]
    _cv_app, "app", unbound_message=_no_app_msg
)
```

### Node 6 — `with client: response = client.get(url)` (`tests/test_testing.py:314-315`)

`src/flask/testing.py:193-243`:

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
        self,
        *args: t.Any,
        buffered: bool = False,
        follow_redirects: bool = False,
        **kwargs: t.Any,
    ) -> TestResponse:
        if args and isinstance(
            args[0], (werkzeug.test.EnvironBuilder, dict, BaseRequest)
        ):
            if isinstance(args[0], werkzeug.test.EnvironBuilder):
                builder = copy(args[0])
                builder.environ_base = self._copy_environ(builder.environ_base or {})  # type: ignore[arg-type]
                request = builder.get_request()
            elif isinstance(args[0], dict):
                request = EnvironBuilder.from_environ(
                    args[0], app=self.application, environ_base=self._copy_environ({})
                ).get_request()
            else:
                # isinstance(args[0], BaseRequest)
                request = copy(args[0])
                request.environ = self._copy_environ(request.environ)
        else:
            # request is None
            request = self._request_from_builder_args(args, kwargs)

        # Pop any previously preserved contexts. This prevents contexts
        # from being preserved across redirects or multiple requests
        # within a single block.
        self._context_stack.close()

        response = super().open(
            request,
            buffered=buffered,
            follow_redirects=follow_redirects,
        )
        response.json_module = self.application.json  # type: ignore[assignment]

        # Re-push contexts that were preserved during the request.
        while self._new_contexts:
            cm = self._new_contexts.pop()
            self._context_stack.enter_context(cm)

        return response

    def __enter__(self) -> FlaskClient:
        if self.preserve_context:
            raise RuntimeError("Cannot nest client invocations")
        self.preserve_context = True
        return self
```

`client.get(url)` passes the **full external URL string** produced by node 5 as `args[0]`. It is a `str`, so it falls to `_request_from_builder_args` → `EnvironBuilder(self.application, url, …)` → Werkzeug parses scheme/host/path from the string (host `xxx.example.com`).

Matching against the registered rule, `src/flask/ctx.py:357-364`:

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

Dispatch, `src/flask/app.py:879-902`:

```python
    def dispatch_request(self) -> ft.ResponseReturnValue:
        """Does the request dispatching.  Matches the URL and returns the
        return value of the view or error handler.  This does not have to
        be a response object.  In order to convert the return value to a
        proper response object, call :func:`make_response`.
        ...
        """
        req = request_ctx.request
        if req.routing_exception is not None:
            self.raise_routing_exception(req)
        rule: Rule = req.url_rule  # type: ignore[assignment]
        # if we provide automatic options for this URL and the
        # request came with the OPTIONS method, reply automatically
        if (
            getattr(rule, "provide_automatic_options", False)
            and req.method == "OPTIONS"
        ):
            return self.make_default_options_response()
        # otherwise dispatch to the handler for that endpoint
        view_args: dict[str, t.Any] = req.view_args  # type: ignore[assignment]
        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)  # type: ignore[no-any-return]
```

i.e. `view_functions["view"](**{"company_id": "xxx"})` → returns `"xxx"` → `b"xxx"` in the response body.

The WSGI entry and context teardown, `src/flask/app.py:1529-1536` and `:1510-1527`:

```python
    def __call__(
        self, environ: WSGIEnvironment, start_response: StartResponse
    ) -> cabc.Iterable[bytes]:
        """The WSGI server calls the Flask application object as the
        WSGI application. This calls :meth:`wsgi_app`, which can be
        wrapped to apply middleware.
        """
        return self.wsgi_app(environ, start_response)
```

```python
        finally:
            if "werkzeug.debug.preserve_context" in environ:
                environ["werkzeug.debug.preserve_context"](_cv_app.get())
                environ["werkzeug.debug.preserve_context"](_cv_request.get())

            if error is not None and self.should_ignore_error(error):
                error = None

            ctx.pop(error)
```

`flask.url_for` / `Flask` are re-exported from the package root (`src/flask/__init__.py` contains `from .helpers import url_for as url_for`, `from .app import Flask as Flask`, `from .globals import current_app as current_app`), which is how `flask.Flask(...)` and `flask.url_for(...)` in the test resolve.

---

## 4. The single switch point: `create_url_adapter`

`src/flask/app.py:423-476`, read in full at offset 423–478 (verbatim):

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

Anchors re-verified by direct read: def `:425`; `:445` `if request is not None:`; `:451` `subdomain = None`; `:452` `server_name = self.config["SERVER_NAME"]`; **`:458` `elif not self.subdomain_matching:`**; `:462` `subdomain = self.url_map.default_subdomain or ""`; `:464-466` `bind_to_environ(...)`; `:469` `if self.config["SERVER_NAME"] is not None:`; `:470-474` `bind(...)`.

**`subdomain_matching` is read at exactly one place.** `grep subdomain_matching src` returns:

```
flask/app.py:143        (docstring)
flask/app.py:159        (docstring)
flask/app.py:233        (constructor default)
flask/app.py:245        (constructor forwards to super)
flask/app.py:432        (docstring of create_url_adapter)
flask/app.py:458        (the only *read*: `elif not self.subdomain_matching:`)
flask/sansio/app.py:121 (docstring)
flask/sansio/app.py:137 (docstring)
flask/sansio/app.py:289 (constructor default)
flask/sansio/app.py:407 (stored on the app)
```

**`create_url_adapter` has exactly three call sites.** `grep "create_url_adapter(" src` returns:

```
flask/app.py:425   def create_url_adapter(self, request: Request | None) -> MapAdapter | None:
flask/app.py:1087  url_adapter = self.create_url_adapter(None)
flask/ctx.py:247   self.url_adapter = app.create_url_adapter(None)
flask/ctx.py:323   self.url_adapter = app.create_url_adapter(self.request)
```

So the chain touches the flag **twice**:

* `src/flask/ctx.py:247` (`request=None`, from `AppContext.__init__`) → takes the `if self.config["SERVER_NAME"] is not None:` branch → `url_map.bind(SERVER_NAME, ...)`. **`subdomain_matching` has no effect on this path.** This adapter is what `flask.url_for` uses at `:312` to *build* `http://xxx.example.com/`.
* `src/flask/ctx.py:323` (with the request, from `RequestContext.__init__`) → `url_map.bind_to_environ(request.environ, server_name=SERVER_NAME, subdomain=None)` when the flag is `True`; when the flag is `False`, Flask forces `subdomain = ""`. This adapter is what *matches* the request at `:315`.

Werkzeug's derivation that makes the difference (`.venv/Lib/site-packages/werkzeug/routing/map.py`):

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

Because Flask passes `subdomain=""` when `subdomain_matching` is `False`, this auto-derivation is skipped, the request is treated as having no subdomain, and the `<company_id>` rule cannot match → 404. And in the build direction (`force_external=True` set by `Flask.url_for` outside a request):

```python
        host = self.get_host(domain_part)
        ...
        scheme = f"{url_scheme}:" if url_scheme else ""
        return f"{scheme}//{host}{self.script_name[:-1]}/{path.lstrip('/')}"
```

which yields the full external URL `http://xxx.example.com/`.

---

## 5. Runtime verification of the chain

Environment: `.venv/pyvenv.cfg` (read in full):

```
home = C:\Users\oobbee\AppData\Roaming\uv\python\cpython-3.13.9-windows-x86_64-none
implementation = CPython
uv = 0.9.5
version_info = 3.13.9
include-system-site-packages = false
prompt = flask
```

Windows layout confirmed (`ls .venv/Scripts` → `python.exe`, `pytest.exe`, …); interpreter used: `.venv/Scripts/python.exe` (CPython 3.13.9), pytest 8.4.0.

**`pytest tests/test_testing.py::test_subdomain -v` — exit 0:**

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\eebeb8fa\q5-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\eebeb8fa\q5-TXT\seal
configfile: pyproject.toml
collecting ... collected 1 item

tests/test_testing.py::test_subdomain PASSED                             [100%]

============================== 1 passed in 0.04s ==============================
```

Forced onto this worktree's `src` (`PYTHONPATH=src`) it also passes (`1 passed in 0.04s`).

**Instrumented mirror of the test (plain interpreter, worktree `src`) — exit 0:**

```
flask.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\eebeb8fa\q5-TXT\seal\src\flask\__init__.py
app.subdomain_matching = True
SERVER_NAME = example.com
client = <FlaskClient <Flask 'step4_mirror'>>
url_map rules = [('/static/<path:filename>', '', 'static'), ('/', '<company_id>', 'view')]
view_functions keys = ['static', 'view']
url_for -> 'http://xxx.example.com/'
status_code: 200
data: b'xxx'
response.request.url: http://xxx.example.com/
ASSERTS PASSED
```

This is the direct proof that nodes 1–6 form a working chain: the registered rule appears in `url_map` with subdomain `"<company_id>"`, `url_for` returns exactly `http://xxx.example.com/`, the dispatched request reaches the view, and the body is `b"xxx"`.

**Whole relevant suite — `tests/test_testing.py`, exit 0:**

```
collected 25 items
tests\test_testing.py .........................                          [100%]
============================= 25 passed in 0.13s ==============================
```

Re-run with `-vv -rA --tb=long -s`: all 25 PASSED, including `PASSED tests/test_testing.py::test_subdomain` and `PASSED tests/test_testing.py::test_nosubdomain`.

**Entire `tests/` suite, exit 0:**

```
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

============================= 489 passed in 3.08s =============================
```

Re-run with `-vv -rA --tb=long -s`: `489 passed in 2.52s`, no skips/xfails/failures.

---

## 6. Per-edge falsification (each experiment in a fresh process)

### Experiment 1 — flip node 1's flag to `subdomain_matching=False` (isolates node 6's dependence on node 1)

The tree already contains this exact experiment as `flask_mut2_i417ar2x/mutated_test.py` (full file, read directly):

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

Run as-is (`.venv/Scripts/python.exe flask_mut2_i417ar2x/mutated_test.py`, both with the worktree `src` and with the venv's default import) — **exit 1**:

```
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
Traceback (most recent call last):
  File "C:\Users\oobbee\AppData\Local\Temp\pi-p50o\eebeb8fa\q5-TXT\seal\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: status 404
```

**Interpretation:** `url_for` is *unchanged* (`http://xxx.example.com/`) because the build path (`create_url_adapter(None)` → `url_map.bind(SERVER_NAME)`) never consults the flag; but the *matching* path (`create_url_adapter(request)` → `subdomain = ""`) can no longer derive `xxx`, so the rule cannot match and the request 404s. This isolates the `subdomain_matching=True` (node 1) → `client.get` matching (node 6) edge.

Corroborated by the cache: `.pytest_cache/v/cache/lastfailed` (read directly):

```json
{
  "examples/javascript/tests": true,
  "examples/tutorial/tests": true,
  "flask_mut2_i417ar2x/mutated_test.py": true
}
```

and `.pytest_cache/v/cache/nodeids` contains the collected id `"tests/test_testing.py::test_subdomain"` (line 467 of that JSON), alongside `test_nosubdomain` (458) and `test_blueprint_with_subdomain` (444) — confirming the target is a genuinely collected test.

### Experiment 2 — delete node 2 (`SERVER_NAME`), keep the request context

```
url_for -> 'http://xxx.localhost/'
status_code: 404
```

Diagnostic mirror confirms why: with `test_request_context()` pushed, node 5 takes the `req_ctx is not None` branch, never reaching the `"Unable to build URLs …"` check:

```
req_ctx present: True
app_ctx present: True
req_ctx.url_adapter: <werkzeug.routing.map.MapAdapter object at 0x...>
req_ctx.request.url: http://localhost/
req_ctx.url_adapter.server_name: localhost
req_ctx.url_adapter.subdomain: ''
url_for -> 'http://xxx.localhost/'
status: 404 data: b'<!doctype html>\n...
```

**This corrects the plan's prediction** (§8): removing `SERVER_NAME` does not raise here — it changes the built host to `localhost` and makes matching return 404. Node 2 is required for both the built host *and* the match.

### Experiment 2b — delete node 2 *and* the request context (`url_for` bare)

```
RAISED: builtins.RuntimeError
MESSAGE: Working outside of application context.

This typically means that you attempted to use functionality that needed
the current application. To solve this, set up an application context
with app.app_context(). See the documentation for more information.
```

The `current_app` `LocalProxy` unbound message fires before any adapter check.

### Experiment 2c — app context only (no request context), no `SERVER_NAME`

```
RAISED: builtins.RuntimeError
MESSAGE: Unable to build URLs outside an active request without 'SERVER_NAME' configured. Also configure 'APPLICATION_ROOT' and 'PREFERRED_URL_SCHEME' as needed.
```

So the error string quoted in `src/flask/app.py:1091` exists and is reachable — but only with an *app* context and *no* request context, which is not the shape that experiment 2 produces.

### Experiment 3 — delete the `with app.test_request_context():` wrapper (isolates node 5's context dependency)

```
RAISED: builtins.RuntimeError
MESSAGE: Working outside of application context.

This typically means that you attempted to use functionality that needed
the current application. To solve this, set up an application context
with app.app_context(). See the documentation for more information.
```

Pushing no context means `current_app` is unbound; `flask.url_for` cannot run at all. This isolates `flask.url_for` (node 5) → `AppContext.__init__` → `create_url_adapter(None)`.

### Experiment 4 — delete the route registration (isolates node 5's dependence on node 4)

```
RAISED: werkzeug.routing.exceptions.BuildError
MESSAGE: Could not build url for endpoint 'view' with values ['company_id']. Did you mean 'static' instead?
```

Raised from `url_adapter.build(...)` after `handle_url_build_error` finds no handlers. This isolates the `url_for("view", …)` → registered `Rule` / `view_functions["view"]` edge.

### Edge-to-falsification map

| Removed/mutated element | Observed result | Edge falsified |
|---|---|---|
| `subdomain_matching=True` → `False` (node 1) | `url_for` unchanged; 404; `AssertionError: status 404` | node 1 → *matching* half of node 6 |
| `SERVER_NAME` (node 2) | `url_for -> 'http://xxx.localhost/'`; 404 | node 2 → node 5 host *and* node 6 match |
| `with app.test_request_context():` (node 5's context) | `RuntimeError: Working outside of application context.` | node 5 → pushed app context (`ctx.py:247`) |
| `@app.route(...)` (node 4) | `BuildError: Could not build url for endpoint 'view' …` | node 5 → registered rule / `view_functions["view"]` |

---

## 7. Why this is the right test: the runners-up, quoted and excluded

### 7.1 `tests/test_testing.py:321-335` — `test_nosubdomain`

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

Excluded: same shape but **no** `subdomain=` on the rule and no `subdomain_matching=True` (it uses the shared `app`/`client` fixtures instead of constructing a `Flask`). It verifies the **absence** of subdomain routing.

### 7.2 `tests/test_testing.py:117-138` — `test_blueprint_with_subdomain`

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

Excluded: the subdomain is supplied explicitly to `EnvironBuilder` (`test_request_context("/", subdomain="xxx")`, `client.get("/", subdomain="xxx")`) rather than derived by `flask.url_for` from `SERVER_NAME`; the request target never crosses from `url_for` into `client.get`, so the linear `url_for → client.get(url)` edge does not exist.

### 7.3 `tests/test_reqctx.py:63-104` — `test_proper_test_request_context`

```python
def test_proper_test_request_context(app):
    app.config.update(SERVER_NAME="localhost.localdomain:5000")

    @app.route("/")
    def index():
        return None

    @app.route("/", subdomain="foo")
    def sub():
        return None

    with app.test_request_context("/"):
        assert (
            flask.url_for("index", _external=True)
            == "http://localhost.localdomain:5000/"
        )

    with app.test_request_context("/"):
        assert (
            flask.url_for("sub", _external=True)
            == "http://foo.localhost.localdomain:5000/"
        )

    # suppress Werkzeug 0.15 warning about name mismatch
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore", "Current server name", UserWarning, "flask.app"
        )
        with app.test_request_context(
            "/", environ_overrides={"HTTP_HOST": "localhost"}
        ):
            pass

    app.config.update(SERVER_NAME="localhost")
    with app.test_request_context("/", environ_overrides={"SERVER_NAME": "localhost"}):
        pass

    app.config.update(SERVER_NAME="localhost:80")
    with app.test_request_context(
        "/", environ_overrides={"SERVER_NAME": "localhost:80"}
    ):
        pass
```

Excluded: it has configuration, rule registration and `test_request_context()`, but it **never dispatches a request through the test client** — there is no `client.get` node and no `<company_id>` variable — it stops at URL building.

### 7.4 `tests/test_basic.py:1754-1798` — routing-only tests

```python
def test_subdomain_basic_support():
    app = flask.Flask(__name__, subdomain_matching=True)
    app.config["SERVER_NAME"] = "localhost.localdomain"
    client = app.test_client()

    @app.route("/")
    def normal_index():
        return "normal index"

    @app.route("/", subdomain="test")
    def test_index():
        return "test index"

    rv = client.get("/", "http://localhost.localdomain/")
    assert rv.data == b"normal index"

    rv = client.get("/", "http://test.localhost.localdomain/")
    assert rv.data == b"test index"

def test_subdomain_matching():
    app = flask.Flask(__name__, subdomain_matching=True)
    client = app.test_client()
    app.config["SERVER_NAME"] = "localhost.localdomain"

    @app.route("/", subdomain="<user>")
    def index(user):
        return f"index for {user}"

    rv = client.get("/", "http://mitsuhiko.localhost.localdomain/")
    assert rv.data == b"index for mitsuhiko"

def test_subdomain_matching_with_ports():
    app = flask.Flask(__name__, subdomain_matching=True)
    app.config["SERVER_NAME"] = "localhost.localdomain:3000"
    client = app.test_client()

    @app.route("/", subdomain="<user>")
    def index(user):
        return f"index for {user}"

    rv = client.get("/", "http://mitsuhiko.localhost.localdomain:3000/")
    assert rv.data == b"index for mitsuhiko"
```

Excluded: the request is created directly with `client.get("/", "http://…")`, so the `test_request_context()` + `flask.url_for` nodes are absent; these cover the routing half only. They are the closest structural siblings (`subdomain="<user>"`, variable captured by the view) but never build the URL from config.

### 7.5 `tests/test_basic.py:1495-1532` — `test_server_name_matching` (parametrized matrix)

```python
@pytest.mark.parametrize(
    ("subdomain_matching", "host_matching", "expect_base", "expect_abc", "expect_xyz"),
    [
        (False, False, "default", "default", "default"),
        (True, False, "default", "abc", "<invalid>"),
        (False, True, "default", "abc", "default"),
    ],
)
def test_server_name_matching(
    subdomain_matching: bool,
    host_matching: bool,
    expect_base: str,
    expect_abc: str,
    expect_xyz: str,
) -> None:
    app = flask.Flask(
        __name__,
        subdomain_matching=subdomain_matching,
        host_matching=host_matching,
        static_host="example.test" if host_matching else None,
    )
    app.config["SERVER_NAME"] = "example.test"

    @app.route("/", defaults={"name": "default"}, host="<name>")
    @app.route("/", subdomain="<name>", host="<name>.example.test")
    def index(name: str) -> str:
        return name

    client = app.test_client()

    r = client.get(base_url="http://example.test")
    assert r.text == expect_base

    r = client.get(base_url="http://abc.example.test")
    assert r.text == expect_abc

    with pytest.warns() if subdomain_matching else nullcontext():
        r = client.get(base_url="http://xyz.other.test")

    assert r.text == expect_xyz
```

Excluded: config, matching flag and rule registration are present, but there is no `test_request_context()`/`url_for` step.

### 7.6 `tests/test_basic.py:1536-1581` — `test_server_name_subdomain`

```python
def test_server_name_subdomain():
    app = flask.Flask(__name__, subdomain_matching=True)
    client = app.test_client()

    @app.route("/")
    def index():
        return "default"

    @app.route("/", subdomain="foo")
    def subdomain():
        return "subdomain"

    app.config["SERVER_NAME"] = "dev.local:5000"
    rv = client.get("/")
    assert rv.data == b"default"
    ...
        rv = client.get("/", "http://foo.localhost")
        assert rv.status_code == 404

    rv = client.get("/", "http://foo.dev.local")
    assert rv.data == b"subdomain"
```

Excluded: no `test_request_context()`, no `flask.url_for`; only `client.get` with explicit hosts.

### 7.7 Other `subdomain` hits, all structurally irrelevant

* `tests/test_cli.py:502-509` (`TestRoutes::test_subdomain`):

```python
    def test_subdomain(self, runner):
        app = Flask(__name__, static_folder=None)
        app.add_url_rule("/a", subdomain="a", endpoint="a")
        app.add_url_rule("/b", subdomain="b", endpoint="b")
        cli = FlaskGroup(create_app=lambda: app)
        result = runner.invoke(cli, ["routes"])
        assert result.exit_code == 0
        assert "Subdomain" in result.output
```

  No `SERVER_NAME`, no request context, no matching flag; it asserts the CLI `routes` column header (`src/flask/cli.py:1071-1092`: `host_matching = current_app.url_map.host_matching`, `has_domain = any(rule.host if host_matching else rule.subdomain for rule in rules)`, `headers.append("Host" if host_matching else "Subdomain")`).

* `tests/test_blueprints.py:953-985` — `test_nesting_subdomains` / `test_child_and_parent_subdomain`: blueprint-level subdomain placement, dispatched with `base_url=` and `app.subdomain_matching = True` set directly on a fixture app (`app.subdomain_matching = True`, `app.config["SERVER_NAME"] = "example.test"`, `client.allow_subdomain_redirects = True`); no `url_for`/`test_request_context`.

* `tests/test_helpers.py:90-99` — only a path named `subdomaintestmodule` and a static file `static/hello.txt` containing `Hello Subdomain`; nothing about routing.

* Shared fixtures used by the sibling tests, `tests/conftest.py:46-64`:

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app

@pytest.fixture
def app_ctx(app):
    with app.app_context() as ctx:
        yield ctx

@pytest.fixture
def req_ctx(app):
    with app.test_request_context() as ctx:
        yield ctx

@pytest.fixture
def client(app):
    return app.test_client()
```

  `test_subdomain` takes none of these, which is why the entire chain is visible inside its own body.

### 7.8 The identification is falsifiable

`.pytest_cache/v/cache/nodeids` (grep for `subdomain`) lists the collected ids, including `"tests/test_testing.py::test_subdomain"`; and `.pytest_cache/v/cache/lastfailed` records the flipped-flag clone as failing. Both the runner-up exclusion criteria and the existence of the mirrored counterfactual point at `test_subdomain` as the subject.

---

## 8. Corrections and hazards carried forward

1. **Plan experiment 2 was wrong.** Deleting `SERVER_NAME` while keeping `test_request_context()` does **not** raise `RuntimeError: Unable to build URLs outside an active request without 'SERVER_NAME' configured.` It yields `url_for -> 'http://xxx.localhost/'` and a 404, because `with app.test_request_context():` pushes a *request* context, and `Flask.url_for` takes the `req_ctx is not None` branch (`_cv_request.get(None)` is not `None`), never reaching the adapter-is-`None` check. That message is only reachable with an app context and no request context (exp 2c); with no context at all the failure is `Working outside of application context.` (exp 2b).
2. **Line-number drift vs. the plan.** `Flask.__init__` is `src/flask/app.py:226` (plan said 224); the `"Unable to build URLs…"` text is at `src/flask/app.py:1091` (plan said 1055–1060); the `"Need at least SERVER_NAME…"` branch is at `src/flask/app.py:469`; the `helpers.url_for` proxy call starts at `src/flask/helpers.py:231`; `EnvironBuilder`'s `http_host = app.config.get("SERVER_NAME") or "localhost"` is `src/flask/testing.py:66`. All references in this answer were re-verified by direct read.
3. **The mutated artifact is evidence, not the test.** `flask_mut2_i417ar2x/mutated_test.py` is a real file with `subdomain_matching=False`; it must be read as the counterfactual and never edited. `pyproject.toml` (`testpaths = ["tests"]`, `filterwarnings = ["error"]`):

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
filterwarnings = [
    "error",
]
```

  so the mutated copy is invisible to a bare `pytest` run and only runs when named explicitly.
4. **Import-path hazard.** The venv's editable install resolves `flask` outside this working tree: `.venv/Lib/site-packages/flask.pth` contains a different checkout path, and `.venv/Lib/site-packages/flask-3.2.0.dev0.dist-info/direct_url.json` records it as editable. Unforced runs print `flask.__file__ = …\826b802c\q3-ABNM\seal\src\flask\__init__.py`; forcing this tree with `PYTHONPATH=<root>/src` gives `flask.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\eebeb8fa\q5-TXT\seal\src\flask\__init__.py`. The target test passes under both, and the counterfactual behaves identically under both.
5. **Stale bytecode.** `tests/__pycache__` holds `.pyc` files (several interpreter/pytest versions) whose embedded source filename points at a different checkout; pytest annotates items with `<- …` when they are reused. Forcing recompilation (`PYTHONPYCACHEPREFIX=<dir>`) removes the annotation and behaviour is unchanged (all runs pass).

---

## 9. One-paragraph restatement of the chain

`Flask(__name__, subdomain_matching=True)` (`tests/test_testing.py:303` → `src/flask/app.py:233,245` → `src/flask/sansio/app.py:405-407`, creating `url_map` and storing `subdomain_matching`) → `config["SERVER_NAME"] = "example.com"` (`:304`, consumed by `EnvironBuilder.__init__` at `src/flask/testing.py:66` and by `create_url_adapter` at `src/flask/app.py:452,469`) → `app.test_client()` (`:305` → `src/flask/app.py:669-726`) → `@app.route("/", subdomain="<company_id>")` → `view` (`:307-309` → `src/flask/sansio/scaffold.py:336-366` → `src/flask/sansio/app.py:605-661`, `Rule(..., subdomain="<company_id>")` at `:650`, `url_map.add` at `:653`, `view_functions["view"]` at `:661`, endpoint from `_endpoint_from_view_func` at `src/flask/sansio/scaffold.py:701-705`) → `with app.test_request_context(): flask.url_for("view", company_id="xxx")` (`:311-312` → `src/flask/app.py:1423-1476` → `RequestContext.push` `src/flask/ctx.py:367-402` → `AppContext.__init__` `src/flask/ctx.py:247` → `create_url_adapter(None)` `src/flask/app.py:469-474` → `src/flask/helpers.py:231-239` → `Flask.url_for` `src/flask/app.py:1003-1113`, producing the external URL `http://xxx.example.com/`) → `with client: client.get(url)` (`:314-315` → `FlaskClient.open` `src/flask/testing.py:206-243` → `RequestContext.__init__` `src/flask/ctx.py:323` → `create_url_adapter(request)` `src/flask/app.py:445-466` honouring `subdomain_matching` → `match_request` `src/flask/ctx.py:357-364` → `dispatch_request` `src/flask/app.py:879-902` → `view(company_id="xxx")` returning `"xxx"`) → assertions on `response.status_code` / `response.data` (`:317-318`). The chain is a **linear prerequisite chain** (construction → configuration → client → rule registration → context/adapter → URL build → request dispatch → view) in which the subdomain matches only because `subdomain_matching=True` reaches `create_url_adapter` twice: once without a request (`bind(SERVER_NAME)`, used to *build* the URL) and once with the request (`bind_to_environ(..., subdomain=None)`, used to *match* it); setting the flag to `False` leaves the built URL unchanged but turns the request into a 404.
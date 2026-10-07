# Where the control flow decides whether a routing rule receives `OPTIONS`

The answer has **two distinct sites**, and they must not be conflated:

1. **Registration time — where the decision is *made* and frozen onto the rule:** `Flask.add_url_rule`, `src/flask/sansio/app.py` (the decisive branch at lines **635–645**).
2. **Request time — where the frozen flag is *consumed*:** `Flask.dispatch_request`, `src/flask/app.py` (the decisive branch at lines **895–898**).

The application configuration setting is `PROVIDE_AUTOMATIC_OPTIONS`, defined once at `src/flask/app.py:208` and consulted at exactly one place: `src/flask/sansio/app.py:641`.

> **Line numbers:** the upstream evidence report gave slightly drifted numbers (e.g. `add_url_rule` "605–666", first `if` "636", `dispatch_request` "878"). I re-verified every anchor in this worktree with `grep`/`read`, and the numbers below are the confirmed ones (matching the executor's corrections). All snippets are quoted verbatim.

---

## 1. Registration-time decision — `Flask.add_url_rule`, `src/flask/sansio/app.py`

`def add_url_rule` is at **line 605**; the function body runs **605–661**. `grep` anchors confirmed:

```
app.py:605:     def add_url_rule(
app.py:635:         if provide_automatic_options is None:
app.py:640:         if provide_automatic_options is None:
app.py:641:             if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
app.py:642:                 provide_automatic_options = True
app.py:643:                 required_methods.add("OPTIONS")
app.py:645:                 provide_automatic_options = False
app.py:648:         methods |= required_methods
app.py:650:         rule_obj = self.url_rule_class(rule, methods=methods, **options)
app.py:651:         rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
app.py:653:         self.url_map.add(rule_obj)
```

Verbatim `nl -ba` body (from the executor's run; identical to what I re-read):

```python
   605	    def add_url_rule(
   606	        self,
   607	        rule: str,
   608	        endpoint: str | None = None,
   609	        view_func: ft.RouteCallable | None = None,
   610	        provide_automatic_options: bool | None = None,
   611	        **options: t.Any,
   612	    ) -> None:
   613	        if endpoint is None:
   614	            endpoint = _endpoint_from_view_func(view_func)  # type: ignore
   615	        options["endpoint"] = endpoint
   616	        methods = options.pop("methods", None)
   617	
   618	        # if the methods are not given and the view_func object knows its
   619	        # methods we can use that instead.  If neither exists, we go with
   620	        # a tuple of only ``GET`` as default.
   621	        if methods is None:
   622	            methods = getattr(view_func, "methods", None) or ("GET",)
   623	        if isinstance(methods, str):
   624	            raise TypeError(
   625	                "Allowed methods must be a list of strings, for"
   626	                ' example: @app.route(..., methods=["POST"])'
   627	            )
   628	        methods = {item.upper() for item in methods}
   629	
   630	        # Methods that should always be added
   631	        required_methods: set[str] = set(getattr(view_func, "required_methods", ()))
   632	
   633	        # starting with Flask 0.8 the view_func object can disable and
   634	        # force-enable the automatic options handling.
   635	        if provide_automatic_options is None:
   636	            provide_automatic_options = getattr(
   637	                view_func, "provide_automatic_options", None
   638	            )
   639	
   640	        if provide_automatic_options is None:
   641	            if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
   642	                provide_automatic_options = True
   643	                required_methods.add("OPTIONS")
   644	            else:
   645	                provide_automatic_options = False
   646	
   647	        # Add the required methods now.
   648	        methods |= required_methods
   649	
   650	        rule_obj = self.url_rule_class(rule, methods=methods, **options)
   651	        rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
   652	
   653	        self.url_map.add(rule_obj)
   654	        if view_func is not None:
   655	            old_func = self.view_functions.get(endpoint)
   656	            if old_func is not None and old_func != view_func:
   657	                raise AssertionError(
   658	                    "View function mapping is overwriting an existing"
   659	                    f" endpoint function: {endpoint}"
   660	                )
   661	            self.view_functions[endpoint] = view_func
```

### The branches, exactly as written

1. **Flag given explicitly (`provide_automatic_options` kwarg not `None`)** → the config is bypassed entirely; the passed value wins.
2. **Flag still unresolved — fall back to the view function attribute** (lines **635–638**):
   ```python
   if provide_automatic_options is None:
       provide_automatic_options = getattr(
           view_func, "provide_automatic_options", None
       )
   ```
3. **Flag still `None` — the configuration branch** (lines **640–645**):
   ```python
   if provide_automatic_options is None:
       if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
           provide_automatic_options = True
           required_methods.add("OPTIONS")
       else:
           provide_automatic_options = False
   ```
   - `if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:` → `provide_automatic_options = True` **and** `required_methods.add("OPTIONS")` (642–643).
   - `else:` → `provide_automatic_options = False` (644–645).
4. **The decision is then frozen:** `methods |= required_methods` (648) merges the added `OPTIONS` into the rule's method set, then the flag is stored on the werkzeug rule object:
   ```python
   rule_obj = self.url_rule_class(rule, methods=methods, **options)
   rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
   self.url_map.add(rule_obj)
   ```
   (`self.url_rule_class = Rule` is at `src/flask/sansio/app.py:257`.)

**Ordering that matters:** `self.config["PROVIDE_AUTOMATIC_OPTIONS"]` is consulted **only when** `provide_automatic_options` is still `None` after the view-attribute fallback. An explicit kwarg or view/class attribute overrides the config.

---

## 2. Request-time consumption — `Flask.dispatch_request`, `src/flask/app.py`

`grep` anchors confirmed:

```
app.py:879:     def dispatch_request(self) -> ft.ResponseReturnValue:
app.py:896:             getattr(rule, "provide_automatic_options", False)
app.py:897:             and req.method == "OPTIONS"
app.py:899:             return self.make_default_options_response()
app.py:904:     def full_dispatch_request(self) -> Response:
app.py:953:     def make_default_options_response(self) -> Response:
```

Verbatim `nl -ba` (body runs **879–902**):

```python
   879	    def dispatch_request(self) -> ft.ResponseReturnValue:
   880	        """Does the request dispatching.  Matches the URL and returns the
   881	        return value of the view or error handler.  This does not have to
   882	        be a response object.  In order to convert the return value to a
   883	        proper response object, call :func:`make_response`.
   884	
   885	        .. versionchanged:: 0.7
   886	           This no longer does the exception handling, this code was
   887	           moved to the new :meth:`full_dispatch_request`.
   888	        """
   889	        req = request_ctx.request
   890	        if req.routing_exception is not None:
   891	            self.raise_routing_exception(req)
   892	        rule: Rule = req.url_rule  # type: ignore[assignment]
   893	        # if we provide automatic options for this URL and the
   894	        # request came with the OPTIONS method, reply automatically
   895	        if (
   896	            getattr(rule, "provide_automatic_options", False)
   897	            and req.method == "OPTIONS"
   898	        ):
   899	            return self.make_default_options_response()
   900	        # otherwise dispatch to the handler for that endpoint
   901	        view_args: dict[str, t.Any] = req.view_args  # type: ignore[assignment]
   902	        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)  # type: ignore[no-any-return]
```

**The runtime branch is at lines 895–898:** `getattr(rule, "provide_automatic_options", False) and req.method == "OPTIONS"` → `return self.make_default_options_response()` (899); otherwise Flask dispatches to the registered endpoint view (901–902). The frozen value set in `add_url_rule` is what is read here — this is the *consumption* of the decision, not its computation.

### The branch target — `Flask.make_default_options_response`, `src/flask/app.py:953–964`

```python
   953	    def make_default_options_response(self) -> Response:
   954	        """This method is called to create the default ``OPTIONS`` response.
   955	        This can be changed through subclassing to change the default
   956	        behavior of ``OPTIONS`` responses.
   957	
   958	        .. versionadded:: 0.7
   959	        """
   960	        adapter = request_ctx.url_adapter
   961	        methods = adapter.allowed_methods()  # type: ignore[union-attr]
   962	        rv = self.response_class()
   963	        rv.allow.update(methods)
   964	        return rv
```

---

## 3. The application configuration setting `PROVIDE_AUTOMATIC_OPTIONS`

**Default, `src/flask/app.py:208`,** inside `Flask.default_config`:

```python
            "PROVIDE_AUTOMATIC_OPTIONS": True,
```

Context (executor `sed -n '200,210p'`):

```
            "MAX_FORM_PARTS": 1_000,
            "SEND_FILE_MAX_AGE_DEFAULT": None,
            "TRAP_BAD_REQUEST_ERRORS": None,
            "TRAP_HTTP_EXCEPTIONS": False,
            "EXPLAIN_TEMPLATE_LOADING": False,
            "PREFERRED_URL_SCHEME": "http",
            "TEMPLATES_AUTO_RELOAD": None,
            "MAX_COOKIE_SIZE": 4093,
            "PROVIDE_AUTOMATIC_OPTIONS": True,
        }
    )
```

**Uniqueness check** (whole-repo grep, `.venv` excluded):

```
./docs/config.rst:391:.. py:data:: PROVIDE_AUTOMATIC_OPTIONS
./docs/config.rst:449:    Added :data:`PROVIDE_AUTOMATIC_OPTIONS` to control the default
./src/flask/app.py:208:            "PROVIDE_AUTOMATIC_OPTIONS": True,
./src/flask/sansio/app.py:641:            if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
```

Exactly four sites: defined only at `src/flask/app.py:208`, **consulted only at `src/flask/sansio/app.py:641`**, and documented twice.

---

## 4. Supporting sites that feed the flag

### (a) `View` class attribute → view function — `src/flask/views.py`

`grep` confirmed anchors:

```
views.py:16: class View:
views.py:56:     provide_automatic_options: t.ClassVar[bool | None] = None
views.py:86:     def as_view(
views.py:133:         view.methods = cls.methods  # type: ignore
views.py:134:         view.provide_automatic_options = cls.provide_automatic_options  # type: ignore
views.py:138: class MethodView(View):
views.py:165:     def __init_subclass__(cls, **kwargs: t.Any) -> None:
```

Attribute (lines 53–56):

```python
53    #: Control whether the ``OPTIONS`` method is handled automatically.
54    #: Uses the same default (``True``) as ``route`` and
55    #: ``add_url_rule`` by default.
56    provide_automatic_options: t.ClassVar[bool | None] = None
```

Copied onto the generated view function in `as_view` (lines 133–134):

```python
133        view.methods = cls.methods  # type: ignore
134        view.provide_automatic_options = cls.provide_automatic_options  # type: ignore
135        return view
```

`MethodView.__init_subclass__` (**165–180**) derives `cls.methods` from the implemented HTTP handler methods; `http_method_funcs` at the top of the file includes `"options"`:

```python
11    http_method_funcs = frozenset(
12        ["get", "post", "head", "options", "delete", "put", "trace", "patch"]
13    )
```

### (b) Blueprint forwarding — `src/flask/sansio/blueprints.py`

`grep` confirmed: `Blueprint.add_url_rule` at **413**, kwarg declared at **418**, forwarded at **438**:

```python
413    def add_url_rule(
414        self,
415        rule: str,
416        endpoint: str | None = None,
417        view_func: ft.RouteCallable | None = None,
418        provide_automatic_options: bool | None = None,
419        **options: t.Any,
420    ) -> None:
421        """Register a URL rule with the blueprint. See :meth:`.Flask.add_url_rule` for
422        full documentation.
423
424        The URL rule is prefixed with the blueprint's URL prefix. The endpoint name,
425        used with :func:`url_for`, is prefixed with the blueprint's name.
426        """
427        if endpoint and "." in endpoint:
428            raise ValueError("'endpoint' may not contain a dot '.' character.")
429
430        if view_func and hasattr(view_func, "__name__") and "." in view_func.__name__:
431            raise ValueError("'view_func' name may not contain a dot '.' character.")
432
433        self.record(
434            lambda s: s.add_url_rule(
435                rule,
436                endpoint,
437                view_func,
438                provide_automatic_options=provide_automatic_options,
439                **options,
440            )
441        )
```

The blueprint setup-state `add_url_rule` (**87**) forwards `**options` through to the app at `self.app.add_url_rule(...)` (**110–120**).

### (c) Abstract contract — `src/flask/sansio/scaffold.py`

```
scaffold.py:353:        ``OPTIONS`` are added automatically.
scaffold.py:373:        provide_automatic_options: bool | None = None,
scaffold.py:401:        always added automatically, and ``OPTIONS`` is added
scaffold.py:402:        automatically by default.
scaffold.py:417:        If ``view_func`` has a ``required_methods`` attribute, those
scaffold.py:428:        :param provide_automatic_options: Add the ``OPTIONS`` method and
scaffold.py:429:            respond to ``OPTIONS`` requests automatically.
```

### (d) Documentation

`docs/config.rst:391–395` (`grep`-confirmed anchors 391, 395):

```
.. py:data:: PROVIDE_AUTOMATIC_OPTIONS

    Set to ``False`` to disable the automatic addition of OPTIONS
    responses. This can be overridden per route by altering the
    ``provide_automatic_options`` attribute.
```

`docs/config.rst:449–450`:

```
    Added :data:`PROVIDE_AUTOMATIC_OPTIONS` to control the default
    addition of autogenerated OPTIONS responses.
```

`docs/api.rst:667–690` (anchors confirmed at 667, 684, 690):

```
-   `provide_automatic_options`: if this attribute is set Flask will
    either force enable or disable the automatic implementation of the
    HTTP ``OPTIONS`` response. This can be useful when working with
    decorators that want to customize the ``OPTIONS`` response on a per-view
    basis.
...
        index.provide_automatic_options = False
        index.methods = ['GET', 'OPTIONS']

    app.add_url_rule('/', index)

.. versionadded:: 0.8
   The `provide_automatic_options` functionality was added.
```

### (e) Behavioural tests that pin the branches

`tests/test_basic.py` (anchors confirmed: `test_options_work` 30, `test_options_on_multiple_rules` 40, `test_provide_automatic_options_attr` 70, `test_provide_automatic_options_kwarg` 92, `test_request_dispatching` 129, `test_url_mapping` 157):

```python
70    def test_provide_automatic_options_attr():
71        app = flask.Flask(__name__)
72
73        def index():
74            return "Hello World!"
75
76        index.provide_automatic_options = False
77        app.route("/")(index)
78        rv = app.test_client().open("/", method="OPTIONS")
79        assert rv.status_code == 405
80
81        app = flask.Flask(__name__)
82
83        def index2():
84            return "Hello World!"
85
86        index2.provide_automatic_options = True
87        app.route("/", methods=["OPTIONS"])(index2)
88        rv = app.test_client().open("/", method="OPTIONS")
89        assert sorted(rv.allow) == ["OPTIONS"]
```

```python
92    def test_provide_automatic_options_kwarg(app, client):
93        def index():
94            return flask.request.method
95
96        def more():
97            return flask.request.method
98
99        app.add_url_rule("/", view_func=index, provide_automatic_options=False)
100        app.add_url_rule(
101            "/more",
102            view_func=more,
103            methods=["GET", "POST"],
104            provide_automatic_options=False,
105        )
106        assert client.get("/").data == b"GET"
107
108        rv = client.post("/")
109        assert rv.status_code == 405
110        assert sorted(rv.allow) == ["GET", "HEAD"]
111
112        rv = client.open("/", method="OPTIONS")
113        assert rv.status_code == 405
```

`tests/test_views.py` (anchor confirmed at 101):

```python
101   def test_view_provide_automatic_options_attr():
102       app = flask.Flask(__name__)
103
104       class Index1(flask.views.View):
105           provide_automatic_options = False
106
107           def dispatch_request(self):
108               return "Hello World!"
109
110       app.add_url_rule("/", view_func=Index1.as_view("index"))
111       c = app.test_client()
112       rv = c.open("/", method="OPTIONS")
113       assert rv.status_code == 405
114
115       app = flask.Flask(__name__)
116
117       class Index2(flask.views.View):
118           methods = ["OPTIONS"]
119           provide_automatic_options = True
120
121           def dispatch_request(self):
122               return "Hello World!"
123
124       app.add_url_rule("/", view_func=Index2.as_view("index"))
125       c = app.test_client()
126       rv = c.open("/", method="OPTIONS")
127       assert sorted(rv.allow) == ["OPTIONS"]
128
129       app = flask.Flask(__name__)
130
131       class Index3(flask.views.View):
132           def dispatch_request(self):
133               return "Hello World!"
134
135       app.add_url_rule("/", view_func=Index3.as_view("index"))
136       c = app.test_client()
137       rv = c.open("/", method="OPTIONS")
138       assert "OPTIONS" in rv.allow
```

### (f) History / semantics — `CHANGES.rst`

```
830	-   ``Flask.add_url_rule`` accepts the ``provide_automatic_options``
831	    argument to disable adding the ``OPTIONS`` method. :pr:`1489`
...
862	-   The ``View`` class attribute
863	    ``View.provide_automatic_options`` is set in ``View.as_view``, to be
864	    detected by ``Flask.add_url_rule``. :pr:`2316`
...
1481	-   OPTIONS is now automatically implemented by Flask unless the
1482	    application explicitly adds 'OPTIONS' as method to the URL rule. In
1483	    this case no automatic OPTIONS handling kicks in.
```

---

## 5. Semantics in one sentence

`OPTIONS` is auto-added only when the caller did not force the flag (no `provide_automatic_options` kwarg and no `view_func.provide_automatic_options` attribute), **and** the rule's method set does not already contain `OPTIONS` (`"OPTIONS" not in methods`), **and** `app.config["PROVIDE_AUTOMATIC_OPTIONS"]` is truthy — in which case `provide_automatic_options = True`, `OPTIONS` is inserted into `required_methods`, and the value is stored on the werkzeug `Rule` (`rule_obj.provide_automatic_options`); an explicit `provide_automatic_options` (kwarg or view/class attribute) wins over the config, and the frozen flag on the `Rule` is what `Flask.dispatch_request` reads at request time to decide between the default OPTIONS response and the registered view.

---

## 6. Empirical confirmation (executor, no source edits)

`git status --short` showed only a pre-existing untracked directory (`flask_mut2_i417ar2x/`); **nothing was modified**.

### Focused tests

```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests/test_basic.py -k "provide_automatic_options or request_dispatching or url_mapping" -q
....                                                                     [100%]
4 passed, 126 deselected in 0.12s
EXIT=0
```
```
$ PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests/test_views.py -k "provide_automatic_options" -q
.                                                                        [100%]
1 passed, 12 deselected in 0.08s
EXIT=0
```

### Branch probe — all four config × flag combinations match the branches read above

```
--- config=True,  flag UNSET (default) ---
  config PROVIDE_AUTOMATIC_OPTIONS = True
  kwarg  provide_automatic_options = None
  rule('/').methods                = ['GET', 'HEAD', 'OPTIONS']
  rule('/').provide_automatic_options = True
  OPTIONS status                   = 200
  OPTIONS Allow                    = ['GET', 'HEAD', 'OPTIONS']

--- config=False, flag UNSET ---
  config PROVIDE_AUTOMATIC_OPTIONS = False
  kwarg  provide_automatic_options = None
  rule('/').methods                = ['GET', 'HEAD']
  rule('/').provide_automatic_options = False
  OPTIONS status                   = 405
  OPTIONS Allow                    = ['GET', 'HEAD']

--- config=True,  flag=False (explicit wins) ---
  config PROVIDE_AUTOMATIC_OPTIONS = True
  kwarg  provide_automatic_options = False
  rule('/').methods                = ['GET', 'HEAD']
  rule('/').provide_automatic_options = False
  OPTIONS status                   = 405
  OPTIONS Allow                    = ['GET', 'HEAD']

--- config=False, flag=True  (explicit wins) ---
  config PROVIDE_AUTOMATIC_OPTIONS = False
  kwarg  provide_automatic_options = True
  rule('/').methods                = ['GET', 'HEAD']
  rule('/').provide_automatic_options = True
  OPTIONS status                   = 405
  OPTIONS Allow                    = ['GET', 'HEAD']
```

View-class and blueprint paths:

```
=== View class attribute path (View.as_view -> add_url_rule fallback) ===
View.provide_automatic_options=None  -> methods=['GET', 'HEAD', 'OPTIONS'] flag=True OPTIONS=200 Allow=['GET', 'HEAD', 'OPTIONS']
View.provide_automatic_options=False -> methods=['GET', 'HEAD'] flag=False OPTIONS=405 Allow=['GET', 'HEAD']
View.provide_automatic_options=True  -> methods=['GET', 'HEAD'] flag=True OPTIONS=405 Allow=['GET', 'HEAD']

=== Blueprint kwarg pass-through ===
  /x       methods=['GET', 'HEAD']        flag=False
  /y       methods=['GET', 'HEAD', 'OPTIONS'] flag=True
```

Interpretation (matching the code): the config is consulted only when the flag is still `None`; an explicit kwarg or view/class attribute overrides the config; the stored `Rule.provide_automatic_options` equals the resolved value; and when the flag is explicitly `True` while `OPTIONS` was *not* added to `methods` (only the config-default branch calls `required_methods.add("OPTIONS")`), an OPTIONS request yields 405 — which is why `tests/test_basic.py::test_provide_automatic_options_attr` sets `methods=["OPTIONS"]` alongside the attribute.

### Complete test suite (twice)

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q8-TXT\seal
configfile: pyproject.toml
testpaths: tests
collected 489 items
...
============================= 489 passed in 5.62s =============================
EXIT=0
```
Re-run with `-vv -rA --tb=long`: `489 passed in 6.40s`, `EXIT=0`, every test reported `PASSED`, including
`tests/test_basic.py::test_options_work`, `::test_options_on_multiple_rules`, `::test_provide_automatic_options_attr`, `::test_provide_automatic_options_kwarg`, `::test_request_dispatching`, `::test_url_mapping`, and `tests/test_views.py::test_view_provide_automatic_options_attr`.

### Environment caveat for any re-run

The `.venv`'s editable install points at a *different* checkout (`flask.pth` → `...\0d451d4e\q8-SYN\seal\src`). Tests must be run as
`PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest` to exercise **this** tree's `src/flask`.

---

## 7. Boundary note (what is *not* in this repo)

Final HTTP method matching — the 405 response and `Allow`-header population when `OPTIONS` is *not* in the rule's method set — happens inside the routing library's `MapAdapter` (werkzeug), not in this repository's source. The probe's terminal traceback confirms this:

```
werkzeug.exceptions.MethodNotAllowed: 405 Method Not Allowed: The method is not allowed for the requested URL.
  File "...\src\flask\ctx.py", line 362, in match_request
    result = self.url_adapter.match(return_rule=True)  # type: ignore
  File "...\.venv\Lib\site-packages\werkzeug\routing\map.py", line 624, in match
    raise MethodNotAllowed(valid_methods=list(e.have_match_for)) from None
```

So the repo's contribution is: **compute and freeze the flag** in `Flask.add_url_rule` (`src/flask/sansio/app.py:635–651`, config consulted at `:641`), and **consume it** in `Flask.dispatch_request` (`src/flask/app.py:895–898`). Other `OPTIONS` occurrences are unrelated to this control flow: `src/flask/app.py:498` (redirect handling), `src/flask/cli.py:1059/1069` (CLI route listing), `src/flask/debughelpers.py:53` (debugger note).

---

## Anchor table (all re-verified in this worktree)

| Meaning | Path | Lines |
|---|---|---|
| Registration-time decision — first fallback `if` | `src/flask/sansio/app.py` | **635–638** |
| Registration-time decision — config branch (`"OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]`) | `src/flask/sansio/app.py` | **640–645** (config at **641**) |
| `OPTIONS` merged into methods | `src/flask/sansio/app.py` | **648** |
| Flag stored on `Rule` | `src/flask/sansio/app.py` | **650–651**; `url_map.add` **653** |
| `Flask.add_url_rule` full body | `src/flask/sansio/app.py` | **605–661** |
| Request-time consumption (`getattr(rule, "provide_automatic_options", False) and req.method == "OPTIONS"`) | `src/flask/app.py` | **895–898**; `make_default_options_response()` **899** |
| `Flask.dispatch_request` full body | `src/flask/app.py` | **879–902** |
| Default OPTIONS responder | `src/flask/app.py` | **953–964** |
| Config default `True` | `src/flask/app.py` | **208** |
| `View.provide_automatic_options` class attr / copy in `as_view` | `src/flask/views.py` | **56** / **134** |
| Blueprint forwarding | `src/flask/sansio/blueprints.py` | **413–441** (kwarg **418**, forward **438**) |
| Abstract contract | `src/flask/sansio/scaffold.py` | **352–353**, **373**, **400–402**, **417–429** |
| Docs | `docs/config.rst` **391–395**, **449–450**; `docs/api.rst` **667–690** | |
| Tests | `tests/test_basic.py` **30–126**, **129–190**; `tests/test_views.py` **101–138** | |

**No source files were edited.** The only entries the task world produced in verification were command outputs and one pre-existing untracked directory (`flask_mut2_i417ar2x/mutated_test.py`, a subdomain-matching probe unrelated to OPTIONS and not part of this control flow).
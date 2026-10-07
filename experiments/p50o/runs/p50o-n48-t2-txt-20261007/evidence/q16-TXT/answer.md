# Why `test_dotted_name_not_allowed` pins a `ValueError` for dotted blueprint names

## 1. What the test actually does

The test in question lives at `tests/test_blueprints.py:254-256` (verified by direct read of the working copy):

```python
def test_dotted_name_not_allowed(app, client):
    with pytest.raises(ValueError):
        flask.Blueprint("app.ui", __name__)


def test_empty_name_not_allowed(app, client):
    with pytest.raises(ValueError):
        flask.Blueprint("", __name__)
```

It constructs `flask.Blueprint("app.ui", __name__)` — i.e. a blueprint ("modular route component" in the question's paraphrase) whose **first positional argument, `name`, contains a dot** — inside a `pytest.raises(ValueError)` context manager, and asserts that the constructor raises `ValueError`. The `app, client` fixtures are pulled from `tests/conftest.py` (`app` at lines 47–54, `client` at lines 66–68) but are never used by the test body; they are just standard fixtures for this module, which is why the test must be run under pytest rather than as a bare snippet. The test is paired with `test_empty_name_not_allowed`, which pins the adjacent empty-name guard, and is immediately followed by `test_dotted_names_from_app` (`tests/test_blueprints.py:264-278`), which exercises the *legitimate* dotted-endpoint behaviour at runtime:

```python
def test_dotted_names_from_app(app, client):
    test = flask.Blueprint("test", __name__)

    @app.route("/")
    def app_index():
        return flask.url_for("test.index")

    @test.route("/test/")
    def index():
        return flask.url_for("app_index")

    app.register_blueprint(test)

    rv = client.get("/")
    assert rv.data == b"/test/"
```

## 2. Where the `ValueError` comes from

The exception originates in `Blueprint.__init__` at `src/flask/sansio/blueprints.py:195-201` (confirmed by direct read of the working copy):

```python
        if not name:
            raise ValueError("'name' may not be empty.")

        if "." in name:
            raise ValueError("'name' may not contain a dot '.' character.")

        self.name = name
```

The raised message is exactly `'name' may not contain a dot '.' character.`, raised at line 199. Note this is a plain substring test — `"." in name` — so **any** dot anywhere in the submitted name (leading, trailing, or interior) is rejected, not merely an interior one. The executor confirmed this empirically:

```
=== A. The ValueError for a dotted blueprint name ===
Blueprint('app.ui') -> ValueError : 'name' may not contain a dot '.' character.

=== A2. 'any dot anywhere' (leading / trailing / interior) ===
  name='app.ui': ValueError: 'name' may not contain a dot '.' character.
  name='.app': ValueError: 'name' may not contain a dot '.' character.
  name='app.': ValueError: 'name' may not contain a dot '.' character.
  name='a.b.c': ValueError: 'name' may not contain a dot '.' character.
  name='app' -> accepted: True
```

## 3. Why the guard exists: `.` is Flask's reserved endpoint separator

The dot is not a cosmetic restriction. Flask uses `.` as the join character when it builds a fully-qualified endpoint name out of the blueprint's nesting path and the endpoint. Two places do the joining:

**(a) When a blueprint rule is registered** — `BlueprintSetupState.add_url_rule` (`src/flask/sansio/blueprints.py:87-116`) builds the endpoint with `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")`:

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

with the two state fields initialized at `src/flask/sansio/blueprints.py:79-80`:

```python
        self.name = self.options.get("name", blueprint.name)
        self.name_prefix = self.options.get("name_prefix", "")
```

**(b) When a blueprint is registered (including nested blueprints)** — `Blueprint.register` (`src/flask/sansio/blueprints.py:302-304`) builds the registered blueprint name with `f"{name_prefix}.{self_name}".lstrip(".")`:

```python
        name_prefix = options.get("name_prefix", "")
        self_name = options.get("name", self.name)
        name = f"{name_prefix}.{self_name}".lstrip(".")
```

and the nested-blueprint loop (`src/flask/sansio/blueprints.py:349-377`) recurses into child blueprints, handing the parent's composed dotted name down as the child's `name_prefix`:

```python
        for blueprint, bp_options in self._blueprints:
            bp_options = bp_options.copy()
            bp_url_prefix = bp_options.get("url_prefix")
            bp_subdomain = bp_options.get("subdomain")

            if bp_subdomain is None:
                bp_subdomain = blueprint.subdomain

            if state.subdomain is not None and bp_subdomain is not None:
                bp_options["subdomain"] = bp_subdomain + "." + state.subdomain
            elif bp_subdomain is not None:
                bp_options["subdomain"] = bp_subdomain
            elif state.subdomain is not None:
                bp_options["subdomain"] = state.subdomain

            if bp_url_prefix is None:
                bp_url_prefix = blueprint.url_prefix

            if state.url_prefix is not None and bp_url_prefix is not None:
                bp_options["url_prefix"] = (
                    state.url_prefix.rstrip("/") + "/" + bp_url_prefix.lstrip("/")
                )
            elif bp_url_prefix is not None:
                bp_options["url_prefix"] = bp_url_prefix
            elif state.url_prefix is not None:
                bp_options["url_prefix"] = state.url_prefix

            bp_options["name_prefix"] = name
            blueprint.register(app, bp_options)
```

The composed dotted `name` is also the key in the duplicate-registration check and in `app.blueprints` (`src/flask/sansio/blueprints.py:306-313`):

```python
        if name in app.blueprints:
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(
                f"The name '{self_name}' is already registered for"
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )
```

**So the endpoint identifier is a single flat string whose dot boundaries carry structural meaning: they delimit nesting levels and the final endpoint.** Consumers later *parse the string back apart on dots* rather than consulting a tree. In `src/flask/wrappers.py:159-195`:

```python
    @property
    def blueprint(self) -> str | None:
        """The registered name of the current blueprint.

        This will be ``None`` if the endpoint is not part of a
        blueprint, or if URL matching failed or has not been performed
        yet.

        This does not necessarily match the name the blueprint was
        created with. It may have been nested, or registered with a
        different name.
        """
        endpoint = self.endpoint

        if endpoint is not None and "." in endpoint:
            return endpoint.rpartition(".")[0]

        return None

    @property
    def blueprints(self) -> list[str]:
        """The registered names of the current blueprint upwards through
        parent blueprints.

        This will be an empty list if there is no current blueprint, or
        if URL matching failed.

        .. versionadded:: 2.0.1
        """
        name = self.blueprint

        if name is None:
            return []

        return _split_blueprint_path(name)
```

and in `src/flask/helpers.py:627-634`:

```python
@cache
def _split_blueprint_path(name: str) -> list[str]:
    out: list[str] = [name]

    if "." in name:
        out.extend(_split_blueprint_path(name.rpartition(".")[0]))

    return out
```

The same splitting is used when injecting URL defaults (`src/flask/sansio/app.py:908-930`):

```python
    def inject_url_defaults(self, endpoint: str, values: dict[str, t.Any]) -> None:
        """Injects the URL defaults for the given endpoint directly into
        the values dictionary passed.  This is used internally and
        automatically called on URL building.

        .. versionadded:: 0.7
        """
        names: t.Iterable[str | None] = (None,)

        # url_for may be called outside a request context, parse the
        # passed endpoint instead of using request.blueprints.
        if "." in endpoint:
            names = chain(
                names, reversed(_split_blueprint_path(endpoint.rpartition(".")[0]))
            )

        for name in names:
            if name in self.url_default_functions:
                for func in self.url_default_functions[name]:
                    func(endpoint, values)
```

### The ambiguity this creates (the real "why")

Because the blueprint `name`, the nesting prefix, and the endpoint are all joined by `.` and later split by `.`, an author-supplied dot inside `name` would blur the boundary between a legitimate nesting level Flask created and a dot the author typed. Concretely — and this was demonstrated at runtime by the executor, not merely argued:

```
=== B. Composed endpoint formula (from the source) ===
  normal blueprint 'bp' + endpoint 'index'      -> 'bp.index'
  counterfactual 'app.ui' + endpoint 'index'    -> 'app.ui.index'
  legit nested app -> ui (Blueprint.register)   -> 'app.ui'
  legit nested endpoint app.ui + 'index'        -> 'app.ui.index'

=== C. Real nested blueprints actually produce that endpoint ===
  registered endpoints: ['app.ui.index', 'static']
  app.blueprints keys: ['app', 'app.ui']
  url_for('app.ui.index') -> /

=== D. The dot is consumed by splitting on the last dot ===
  Request.blueprint for endpoint 'app.ui.index' -> 'app.ui'
  _split_blueprint_path( 'app.ui' ) -> ['app.ui', 'app']
  So endpoint 'app.ui.index' is read as blueprint 'app.ui', parents ['app.ui','app']
  -> identical shape whether 'app.ui' came from nesting or from a literal dotted name.
```

In other words, `app.ui.index` is *unambiguously* the endpoint of view `index` in blueprint `ui` nested under blueprint `app` — a real, supported arrangement (documented as `url_for('parent.child.create')` in `docs/blueprints.rst:127-141`, and exercised by `test_nested_blueprint` at `tests/test_blueprints.py:793-839`). If a plain blueprint literally named `"app.ui"` were allowed, the same string `app.ui.index` would be produced for a *different* structure, and nothing in `url_for`, `Request.blueprint`, or `Request.blueprints` could tell the two apart, because they resolve structure purely by `rpartition(".")` / recursive dot-splitting on the flat string. The guard in `Blueprint.__init__` therefore reserves the dot so that blueprint nesting remains the sole producer of dot-separated hierarchy.

This is precisely what the changelog states (`CHANGES.rst:504-506`, under Version 2.0.1; verified by direct read):

```rst
-   Show an error when a blueprint name contains a dot. The ``.`` has
    special meaning, it is used to separate (nested) blueprint names and
    the endpoint name. :issue:`4041`
```

The companion feature that introduced the dotted-name scheme is recorded in the same release section (`CHANGES.rst:516-518`):

```rst
-   Nested blueprints are registered with their dotted name. This allows
    different blueprints with the same name to be nested at different
    locations. :issue:`4069`
```

The user-facing contract is documented in `docs/blueprints.rst:103-106`:

```rst
files.  The other two are for the `show` function of the ``simple_page``
blueprint.  As you can see, they are also prefixed with the name of the
blueprint and separated by a dot (``.``).
```

and in the nesting / URL-building sections, `docs/blueprints.rst:127-141` and `265-279`:

```rst
Nesting Blueprints
------------------

It is possible to register a blueprint on another blueprint.

.. code-block:: python

    parent = Blueprint('parent', __name__, url_prefix='/parent')
    child = Blueprint('child', __name__, url_prefix='/child')
    parent.register_blueprint(child)
    app.register_blueprint(parent)

The child blueprint will gain the parent's name as a prefix to its
name, and child URLs will be prefixed with the parent's URL prefix.

.. code-block:: python

    url_for('parent.child.create')
    /parent/child/create
```

```rst
Building URLs
-------------

If you want to link from one page to another you can use the
:func:`url_for` function just like you normally would do just that you
prefix the URL endpoint with the name of the blueprint and a dot (``.``)::

    url_for('admin.index')

Additionally if you are in a view function of a blueprint or a rendered
template and you want to link to another endpoint of the same blueprint,
you can use relative redirects by prefixing the endpoint with a dot only::

    url_for('.index')
```

The relative-endpoint syntax `url_for('.index')` is why the separator must be unambiguous: `App.url_for` (`src/flask/app.py:1003-1072`) prefixes the current blueprint name to a leading-dot endpoint, falling back on the endpoint string itself to recover the blueprint hierarchy:

```python
    def url_for(
        self,
        /,
        endpoint: str,
        *,
        _anchor: str | None = None,
        _method: str | None = None,
        _scheme: str | None = None,
        _external: bool | None = None,
        **values: t.Any,
    ) -> str:
        """Generate a URL to the given endpoint with the given values.

        This is called by :func:`flask.url_for`, and can be called
        directly as well.

        An *endpoint* is the name of a URL rule, usually added with
        :meth:`@app.route() <route>`, and usually the same name as the
        view function. A route defined in a :class:`~flask.Blueprint`
        will prepend the blueprint's name separated by a ``.`` to the
        endpoint.
        ...
        :param endpoint: The endpoint name associated with the URL to
            generate. If this starts with a ``.``, the current blueprint
            name (if any) will be used.
        ...
        """
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
            ...
```

Finally, the composed endpoint is what actually becomes the Werkzeug rule endpoint and the `view_functions` key, in `App.add_url_rule` (`src/flask/sansio/app.py:604-668`):

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

with the default endpoint being the view function's `__name__` (`src/flask/sansio/scaffold.py:701-706`):

```python
def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
    """Internal helper that returns the default endpoint for a given
    function.  This always is the function name.
    """
    assert view_func is not None, "expected view func if endpoint is not provided."
    return view_func.__name__
```

## 4. Corroborating evidence: the guard is part of a consistent "dot is reserved" policy

The same rule is enforced for the other two components of the dotted endpoint, in `Blueprint.add_url_rule` (`src/flask/sansio/blueprints.py:411-436`), so that dots cannot be smuggled in via an explicit endpoint or via a view function's name:

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

Their own test is `test_route_decorator_custom_endpoint_with_dots` (`tests/test_blueprints.py:321-335`):

```python
def test_route_decorator_custom_endpoint_with_dots(app, client):
    bp = flask.Blueprint("bp", __name__)

    with pytest.raises(ValueError):
        bp.route("/", endpoint="a.b")(lambda: "")

    with pytest.raises(ValueError):
        bp.add_url_rule("/", endpoint="a.b")

    def view():
        return ""

    view.__name__ = "a.b"

    with pytest.raises(ValueError):
        bp.add_url_rule("/", view_func=view)
```

and the executor observed both sibling guards firing:

```
=== A3. Sibling guards: dotted endpoint / view_func name ===
  endpoint='x.y': ValueError: 'endpoint' may not contain a dot '.' character.
  view_func.__name__='v.f': ValueError: 'view_func' name may not contain a dot '.' character.
```

The view-function restriction predates the blueprint-name one, per `CHANGES.rst:928`:

```rst
-   Blueprint view function names may not contain dots. :pr:`2450`
```

## 5. Verified test result

The test passes against the working copy (`PYTHONPATH=src` used to force import of this tree's `src/flask` rather than a stale editable-install path):

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q16-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q16-TXT\seal
configfile: pyproject.toml
collecting ... collected 1 item

tests/test_blueprints.py::test_dotted_name_not_allowed PASSED            [100%]

============================== 1 passed in 0.08s ==============================
```

In the full maximally-verbose suite run (`pytest -vv -rA -l --tb=long --showlocals`, 1453-line log saved as `./_full_suite_vv.txt`), the neighbouring tests appear together and all pass:

```
tests/test_blueprints.py::test_dotted_name_not_allowed PASSED            [ 35%]
tests/test_blueprints.py::test_empty_name_not_allowed PASSED             [ 35%]
tests/test_blueprints.py::test_dotted_names_from_app PASSED              [ 35%]
...
tests/test_blueprints.py::test_route_decorator_custom_endpoint_with_dots PASSED [ 36%]
```

and the whole suite reports `489 passed in 7.22s` (the plain run reports `489 passed in 6.10s`).

## 6. Direct answer

The test ensures a `ValueError` because Flask's blueprint `name` is not an opaque label: it is concatenated with dots into a single flat endpoint identifier — `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")` in `BlueprintSetupState.add_url_rule` (`src/flask/sansio/blueprints.py:112`) and `f"{name_prefix}.{self_name}".lstrip(".")` in `Blueprint.register` (`:304`) — and that identifier is later *parsed back apart on dots* (`endpoint.rpartition(".")[0]` in `Request.blueprint`; `_split_blueprint_path` in `src/flask/helpers.py:627-634`). Because nested blueprints legitimately produce dotted names (`app` → `app.ui`), a user-supplied dot in `name` would fabricate a hierarchy level Flask never created and generate a colliding, ambiguous endpoint (e.g. `app.ui.index` from a literal name `"app.ui"` is byte-for-byte identical in shape to the endpoint of blueprint `ui` nested under `app`), breaking `url_for` lookup and the leading-dot relative-endpoint syntax `url_for('.index')`. Hence `Blueprint.__init__` rejects it up front with `if "." in name: raise ValueError("'name' may not contain a dot '.' character.")` (`src/flask/sansio/blueprints.py:198-199`) — a plain substring check, so every dot anywhere in the name is rejected — and `test_dotted_name_not_allowed` (`tests/test_blueprints.py:254-256`) is the regression test that pins that behaviour. This matches the stated rationale in `CHANGES.rst:504-506`: "The `.` has special meaning, it is used to separate (nested) blueprint names and the endpoint name. `:issue:`4041`".
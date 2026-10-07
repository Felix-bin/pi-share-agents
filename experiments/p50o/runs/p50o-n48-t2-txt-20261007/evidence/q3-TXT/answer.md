# How `Blueprint.add_url_rule` defers registration by storing an anonymous function

## Direct answer

In `src/flask/sansio/blueprints.py`, `Blueprint.add_url_rule` does **not** register anything. It wraps the whole intended registration into an anonymous `lambda` whose only parameter is `s` — the `BlueprintSetupState` — and hands that lambda to `self.record(...)`, which appends it to `Blueprint.deferred_functions`. The lambda closes over the arguments as given at definition time (`rule`, `endpoint`, `view_func`, `provide_automatic_options`, and the `**options` dict). Much later, when someone calls `app.register_blueprint(bp, ...)`, `Blueprint.register` constructs a fresh `BlueprintSetupState` for *that* registration and then runs `for deferred in self.deferred_functions: deferred(state)`, calling each stored lambda with that state. Only then does `s.add_url_rule(...)` — i.e. `BlueprintSetupState.add_url_rule` — finally execute, apply the URL prefix / subdomain / url-defaults / endpoint prefixing, and call `self.app.add_url_rule(...)`, the one and only method that mutates `app.url_map` and `app.view_functions`.

The anonymous function is precisely a `DeferredSetupFunction`:

```python
DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]
```
(`src/flask/sansio/blueprints.py:17`)

Because the same stored list is replayed against a newly built state on every registration, one blueprint definition can be mounted multiple times with different `url_prefix`, `subdomain`, `name`, and `url_defaults`.

---

## 1. Where it lives — and the three distinct `add_url_rule`s

`Blueprint.add_url_rule` is at `src/flask/sansio/blueprints.py:412–441`, `def` at 413, decorated with `@setupmethod` (line 412). This is one of three same-named methods that must not be conflated:

| Method | File / lines | What it does |
|---|---|---|
| `Blueprint.add_url_rule` | `blueprints.py:413` | stores a lambda; touches no app |
| `BlueprintSetupState.add_url_rule` | `blueprints.py:87` | prefixes rule/endpoint, then calls the app |
| `App.add_url_rule` (inherited verbatim by `Flask`) | `app.py:605` | mutates `url_map` / `view_functions` |

`Flask` adds no override — the executor confirmed:

```
$ grep -n 'def add_url_rule\|def register_blueprint\|def route' src/flask/app.py
(no output)
exit=1   # 1 = no matches -> Flask inherits App.add_url_rule / App.register_blueprint verbatim
```

`Blueprint` itself subclasses `Scaffold` (`blueprints.py:119`), and `Scaffold.add_url_rule` is a stub:

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
        """Register a rule for routing incoming requests and building
        URLs. The :meth:`route` decorator is a shortcut to call this
        with the ``view_func`` argument. These are equivalent:
        ...
        """
        raise NotImplementedError
```
(`src/flask/sansio/scaffold.py:365–425`; the `raise NotImplementedError` is at line 433 per `grep -n 'raise NotImplementedError' src/flask/sansio/scaffold.py` → `221:` and `433:`)

So the blueprint's override is what gets called from blueprint-side entry points.

---

## 2. What it does *not* do

It never calls `BlueprintSetupState.add_url_rule` and never touches any `app`. A blueprint genuinely has no application yet — its constructor only stores configuration:

```python
        self.name = name
        self.url_prefix = url_prefix
        self.subdomain = subdomain
        self.deferred_functions: list[DeferredSetupFunction] = []

        if url_defaults is None:
            url_defaults = {}

        self.url_values_defaults = url_defaults
        self.cli_group = cli_group
        self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
```
(`src/flask/sansio/blueprints.py:200–211`; the list field is line 204 — verified directly.)

Why it *cannot* register immediately is stated by the class docstring:

```python
class Blueprint(Scaffold):
    """Represents a blueprint, a collection of routes and other
    app-related functions that can be registered on a real application
    later.

    A blueprint is an object that allows defining application functions
    without requiring an application object ahead of time. It uses the
    same decorators as :class:`~flask.Flask`, but defers the need for an
    application by recording them for later registration.

    Decorating a function with a blueprint creates a deferred function
    that is called with :class:`~flask.blueprints.BlueprintSetupState`
    when the blueprint is registered on an application.

    See :doc:`/blueprints` for more information.
```
(`src/flask/sansio/blueprints.py:119–133`)

The documentation says the same in prose:

```
The basic concept of blueprints is that they record operations to execute
when registered on an application.  Flask associates view functions with
blueprints when dispatching requests and generating URLs from one endpoint
to another.
...
When you bind a function with the help of the ``@simple_page.route``
decorator, the blueprint will record the intention of registering the
function ``show`` on the application when it's later registered.
Additionally it will prefix the endpoint of the function with the
name of the blueprint which was given to the :class:`Blueprint`
constructor (in this case also ``simple_page``). The blueprint's name
does not modify the URL, only the endpoint.
```
(`docs/blueprints.rst`; "The basic concept of blueprints is that they record operations to execute" is line 51; "the blueprint will record the intention of registering the" is line 77)

---

## 3. The deferral mechanism itself (verbatim, `blueprints.py:412–441`)

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

The lambda's single parameter is named `s`. It is the *only* free variable that varies per registration; `rule`, `endpoint`, `view_func`, `provide_automatic_options` and the `**options` dict are captured from the enclosing call at definition time. The stored callable therefore structurally *is* `DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]`.

Two important details about the capture:

* `provide_automatic_options` is a **named** parameter of `Blueprint.add_url_rule`, so it is **not** inside the captured `options` dict; it is re-passed to `s.add_url_rule` as an explicit keyword. The executor measured this directly:

  ```
  GOTCHA 1: provide_automatic_options is a NAMED param, outside captured **options
    closure co_freevars: ('endpoint', 'options', 'provide_automatic_options', 'rule', 'view_func')
    closure['options'] = {'methods': ['POST']}  <-- contains only methods
    closure['provide_automatic_options'] = False  <-- separate cell
    'provide_automatic_options' in options dict: False
    signature of Blueprint.add_url_rule: (self, rule: 'str', endpoint: 'str | None' = None, view_func: 'ft.RouteCallable | None' = None, provide_automatic_options: 'bool | None' = None, **options: 't.Any') -> 'None'
    signature of BlueprintSetupState.add_url_rule: (self, rule: 'str', endpoint: 'str | None' = None, view_func: 'ft.RouteCallable | None' = None, **options: 't.Any') -> 'None'
    url_for('g1.v') -> /m
    methods on rule: ['POST'] | provide_automatic_options: False
  ```

* The two dot-character `ValueError`s run **before** `self.record(...)`, i.e. eagerly at definition time, so they are *not* deferred:

  ```
  GOTCHA 3: dot-character ValueErrors are EAGER (definition time, before record)
    len before: 0
    endpoint='a.b': ValueError: 'endpoint' may not contain a dot '.' character. | len after: 0 (unchanged)
    view name 'a.b': ValueError: 'view_func' name may not contain a dot '.' character. | len after: 0 (unchanged)
    final len(deferred_functions): 0 (no partial record stored)
  ```

### `record` — the single append

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
(`src/flask/sansio/blueprints.py:223–230`; the append is line 230 — confirmed by `grep -n 'deferred_functions' src/flask/sansio/blueprints.py` → `204:`, `230:`, `334:`)

`record` does exactly one thing: `self.deferred_functions.append(func)`. Nothing else is stored, no app is consulted.

The sibling `record_once` funnels into the same list — it wraps in a `first_registration`-keyed closure and then calls `self.record(...)`:

```python
    @setupmethod
    def record_once(self, func: DeferredSetupFunction) -> None:
        """Works like :meth:`record` but wraps the function in another
        function that will ensure the function is only called once.  If the
        blueprint is registered a second time on the application, the
        function passed is not called.
        """

        def wrapper(state: BlueprintSetupState) -> None:
            if state.first_registration:
                func(state)

        self.record(update_wrapper(wrapper, func))
```
(`src/flask/sansio/blueprints.py:232–244`)

`Blueprint.add_url_rule` is the **only** user of the plain `record`; every `*_app_*` sibling uses `record_once`. The executor's grep confirms this:

```
$ grep -n 'record_once\|self\.record(' src/flask/sansio/blueprints.py
233:    def record_once(self, func: DeferredSetupFunction) -> None:
244:        self.record(update_wrapper(wrapper, func))
433:        self.record(            <-- Blueprint.add_url_rule: the ONLY plain record() call site
475:        self.record_once(register_template)
513:        self.record_once(register_template)
551:        self.record_once(register_template)
558:        self.record_once(
568:        self.record_once(
578:        self.record_once(
590:        self.record_once(
607:            self.record_once(from_blueprint)
619:        self.record_once(
629:        self.record_once(
exit=0
```

### Runtime confirmation that the stored value is a one-argument lambda and that no app exists

Executor output (exit=0), run with `PYTHONPATH=src .venv/Scripts/python.exe`:

```
flask module file: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q3-TXT\seal\src\flask\__init__.py
blueprints module: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q3-TXT\seal\src\flask\sansio\blueprints.py
==============================================================================
STEP 3 PRE-CHECK: @setupmethod wrapping (update_wrapper leaves __wrapped__)
  Blueprint.add_url_rule             __wrapped__=True
  Blueprint.record                   __wrapped__=True
  Blueprint.record_once              __wrapped__=True
  Blueprint.register                 __wrapped__=False
  Blueprint.make_setup_state         __wrapped__=False
  BlueprintSetupState.add_url_rule   __wrapped__=False
  App.add_url_rule                   __wrapped__=True
  Scaffold.route                     __wrapped__=True
  Blueprint MRO: ['Blueprint', 'Blueprint', 'Scaffold', 'object']
  Blueprint.add_url_rule is Blueprint's own: True
  type(bp).add_url_rule resolves to Blueprint.add_url_rule: Blueprint.add_url_rule
==============================================================================
STEP 3 (i)/(ii): add_url_rule on a blueprint with NO app in existence yet
  any Flask instance constructed so far?  'Flask' in dir namespace only: True
  bp.deferred_functions before add_url_rule: [] id: 3144396080896
  no Flask object exists yet: True
  len(bp.deferred_functions) after one add_url_rule: 1
  type(f): <class 'function'> util.type: <class 'function'>
  f.__name__: <lambda> | f.__qualname__: Blueprint.add_url_rule.<locals>.<lambda>
  f is a plain function object: True
  inspect.signature(f): (s) | n params: 1
  f.__code__.co_freevars: ('endpoint', 'options', 'provide_automatic_options', 'rule', 'view_func')
  closure cell contents:
    'endpoint' = None
    'options' = {}
    'provide_automatic_options' = None
    'rule' = '/x'
    'view_func' = <function index at 0x000002DC1C9CDE40>
  DeferredSetupFunction alias: typing.Callable[[ForwardRef('BlueprintSetupState')], NoneType]
  list annotation: True
==============================================================================
STEP 3: register on app with url_prefix='/bp'
  app.url_map rules:
    '/static/<path:filename>' | endpoint: static | methods: ['GET', 'HEAD', 'OPTIONS']
    '/bp/x' | endpoint: bp.index | methods: ['GET', 'HEAD', 'OPTIONS']
  app.view_functions keys: ['bp.index', 'static']
  url_for('bp.index') -> /bp/x
  rule string in url_map == '/bp/x': True
  endpoint in view_functions == 'bp.index': True
  same stored function object still in list (id unchanged): True
==============================================================================
exit=0
```

Note `f.__qualname__: Blueprint.add_url_rule.<locals>.<lambda>` and `f.__code__.co_freevars: ('endpoint', 'options', 'provide_automatic_options', 'rule', 'view_func')` — the closure captures exactly the definition-time arguments, and the rule string is *not* recomputed from blueprint state.

---

## 4. The deferred execution — who calls the lambda, and with what

The consumer is `Blueprint.register` (`src/flask/sansio/blueprints.py:273`). Its relevant tail:

```python
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
(`src/flask/sansio/blueprints.py:316–335`; the drain is `334–335`.)

And the state factory:

```python
    def make_setup_state(
        self, app: App, options: dict[str, t.Any], first_registration: bool = False
    ) -> BlueprintSetupState:
        """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
        object that is later passed to the register callback functions.
        Subclasses can override this to return a subclass of the setup state.
        """
        return BlueprintSetupState(self, app, options, first_registration)
```
(`src/flask/sansio/blueprints.py:246–253`)

The drain loop is reached from the app side:

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on the application. Keyword
        arguments passed to this method will override the defaults set on the
        blueprint.

        Calls the blueprint's :meth:`~flask.Blueprint.register` method after
        recording the blueprint in the application's :attr:`blueprints`.
        ...
        """
        blueprint.register(self, options)
```
(`src/flask/sansio/app.py:568–595`; the call `blueprint.register(self, options)` is at **595**, verified by grep: `src/flask/sansio/app.py:595:        blueprint.register(self, options)`)

Two structural details the executor verified and that matter for correctness of the mechanism:

* `Blueprint.register` and `Blueprint.make_setup_state` are **not** `@setupmethod`-wrapped (`__wrapped__=False` in the pre-check above). That is why the drain at lines 334–335 still runs even though `self._got_registered_once = True` was set three lines earlier at 320.
* The loop passes **one and the same** state object to every stored callback, in list order. The executor measured:

  ```
  deferred callbacks invoked in list order: ['custom1', 'custom2']
  all received a BlueprintSetupState: True
  all received the SAME state object: True
  state.app is app: True | state.url_prefix: /pre | state.name: bp
  state in appA?  custom callbacks ran during register_blueprint: True
  ```

---

## 5. Why `BlueprintSetupState` is the right indirection

`BlueprintSetupState.add_url_rule` is where all the per-registration context is applied:

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
(`src/flask/sansio/blueprints.py:87–114`; the initializer that populates the fields is `41–85`)

The relevant state fields and their sources:

```python
        subdomain = self.options.get("subdomain")
        if subdomain is None:
            subdomain = self.blueprint.subdomain
        ...
        self.subdomain = subdomain

        url_prefix = self.options.get("url_prefix")
        if url_prefix is None:
            url_prefix = self.blueprint.url_prefix
        ...
        self.url_prefix = url_prefix

        self.name = self.options.get("name", blueprint.name)
        self.name_prefix = self.options.get("name_prefix", "")
        ...
        self.url_defaults = dict(self.blueprint.url_values_defaults)
        self.url_defaults.update(self.options.get("url_defaults", ()))
```
(`src/flask/sansio/blueprints.py:64–85`)

So the lambda defers to the state created at registration time, and the state supplies `url_prefix`, `subdomain`, `name`, `name_prefix`, and `url_defaults` — resolved from the `register_blueprint(...)` overrides falling back to the blueprint's own constructor arguments. That is exactly why the same stored function can be replayed against multiple registrations, which the docs state as a design goal:

```
* Register a blueprint multiple times on an application with different URL
  rules.
```
(`docs/blueprints.rst`, lines 27–28)

```
On top of that you can register blueprints multiple times though not every
blueprint might respond properly to that.  In fact it depends on how the
blueprint is implemented if it can be mounted more than once.
```
(`docs/blueprints.rst`, lines 119–121)

The executor demonstrated the replay with three registrations and a single stored lambda:

```
stored lambda id: 2087430012768 | len(deferred_functions): 1
==============================================================================
STEP 3 REPLAY: number of BlueprintSetupState objects created: 3
  state[0] id=2087420996512 app='appA' url_prefix='/bp' subdomain=None name='bp' name_prefix='' first_registration=True
  state[1] id=2087430085904 app='appB' url_prefix='/other' subdomain=None name='renamed' name_prefix='' first_registration=True
  state[2] id=2087430086224 app='appA' url_prefix='/third' subdomain=None name='third' name_prefix='' first_registration=False

  same lambda object replayed (list unchanged, identity preserved): True

  appA (appA) url_map rules:
    rule: '/bp/x' | endpoint: bp.index
    rule: '/third/x' | endpoint: third.index
      url_for('bp.index') -> /bp/x
      url_for('renamed.index') -> raises BuildError: Could not build url for endpoint 'renamed.index'. Did you mean 'third.index' instead?
      url_for('third.index') -> /third/x

  appB (appB) url_map rules:
    rule: '/other/x' | endpoint: renamed.index
      url_for('bp.index') -> raises BuildError: Could not build url for endpoint 'bp.index'. Did you mean 'renamed.index' instead?
      url_for('renamed.index') -> /other/x
      url_for('third.index') -> raises BuildError: Could not build url for endpoint 'third.index'. Did you mean 'renamed.index' instead?
==============================================================================
exit=0
```

The two formulas the state applies were also measured exhaustively:

```
prefix-join formula: '/'.join((url_prefix.rstrip('/'), rule.lstrip('/')))
  url_prefix=None     rule='/bar'  -> '/bar'       (no prefix (rule unchanged))
  url_prefix=None     rule='bar'   -> 'bar'        (no prefix (rule unchanged))
  url_prefix=None     rule=''      -> ''           (no prefix (rule unchanged))
  url_prefix=''       rule='/bar'  -> '/bar'       (join)
  url_prefix=''       rule='bar'   -> '/bar'       (join)
  url_prefix=''       rule=''      -> ''           (empty rule -> url_prefix)
  url_prefix='/'      rule='/bar'  -> '/bar'       (join)
  url_prefix='/'      rule='bar'   -> '/bar'       (join)
  url_prefix='/'      rule=''      -> '/'          (empty rule -> url_prefix)
  url_prefix='/foo'   rule='/bar'  -> '/foo/bar'   (join)
  url_prefix='/foo'   rule='bar'   -> '/foo/bar'   (join)
  url_prefix='/foo'   rule=''      -> '/foo'       (empty rule -> url_prefix)
  url_prefix='/foo/'  rule='/bar'  -> '/foo/bar'   (join)
  url_prefix='/foo/'  rule='bar'   -> '/foo/bar'   (join)
  url_prefix='/foo/'  rule=''      -> '/foo/'      (empty rule -> url_prefix)
  url_prefix='/foo//' rule='/bar'  -> '/foo/bar'   (join)
  url_prefix='/foo//' rule='bar'   -> '/foo/bar'   (join)
  url_prefix='/foo//' rule=''      -> '/foo//'     (empty rule -> url_prefix)
==============================================================================
endpoint formula: f'{name_prefix}.{name}.{endpoint}'.lstrip('.')
  name_prefix=''        name='bp'      endpoint='index'  -> 'bp.index'
  name_prefix='parent'  name='bp'      endpoint='index'  -> 'parent.bp.index'
  name_prefix=''        name='renamed' endpoint='index'  -> 'renamed.index'
  nested endpoints: ['parent.child.cidx', 'parent.pidx', 'static']
  url_for('parent.child.cidx') -> /p/
```

Note also `options.setdefault("subdomain", self.subdomain)` (line 103): the blueprint's *own* subdomain is never in the captured `options` at definition time — `Blueprint.add_url_rule` has no `subdomain` parameter, so the subdomain is injected per registration by the state.

Crucially, the rule string is **not** recomputed from blueprint state inside the lambda: the lambda carries the raw `rule` it was given; the state performs the prefix join. Any statement that "the closure recomputes the rule from the blueprint" would be wrong.

---

## 6. Guards, and the eager/lazy validation split

`@setupmethod` is the gate:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```
(`src/flask/sansio/scaffold.py:42–49`)

The blueprint's concrete check:

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```
(`src/flask/sansio/blueprints.py:213–221`)

Observed behavior after `_got_registered_once` is set:

```
bp._got_registered_once: True
add_url_rule: AssertionError first line -> The setup method 'add_url_rule' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
record: AssertionError first line -> The setup method 'record' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
record_once: AssertionError first line -> The setup method 'record_once' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
route: AssertionError first line -> The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
get: AssertionError first line -> The setup method 'get' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
post: AssertionError first line -> The setup method 'post' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
len(deferred_functions) after all attempts: 1
exit=0
```

So the append itself is refused after registration — no half-applied changes. (The app-side analogue is `App._check_setup_finished`, keyed on `_got_first_request`, and the closest test is `tests/test_basic.py:1686–1690`. There is **no** test asserting the blueprint-side message: greps for `already been registered at least once` / `no longer be called on the blueprint` in `tests/` returned no matches, so that guard is verified only by reading the code plus the runtime experiment above.)

The timing split, stated precisely:

* **Eager (definition time, before `record`):** the two `ValueError`s for dot-in-endpoint and dot-in-view-name.
* **Deferred (registration time, inside the lambda):** the defaulting of `endpoint` via `_endpoint_from_view_func`, and the `provide_automatic_options` / `OPTIONS` machinery executed by `App.add_url_rule`.

```python
def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
    """Internal helper that returns the default endpoint for a given
    function.  This always is the function name.
    """
    assert view_func is not None, "expected view func if endpoint is not provided."
    return view_func.__name__
```
(`src/flask/sansio/scaffold.py:701–706`)

Observed:

```
GOTCHA 2: endpoint defaulting is DEFERRED (asserts at registration, not definition)
  definition-time call returned OK; len(deferred_functions): 1
  register-time: AssertionError : expected view func if endpoint is not provided.
  _endpoint_from_view_func source:
    def _endpoint_from_view_func(view_func: ft.RouteCallable) -> str:
        """Internal helper that returns the default endpoint for a given
        function.  This always is the function name.
        """
        assert view_func is not None, "expected view func if endpoint is not provided."
        return view_func.__name__
```

---

## 7. Contrast with the app: why the closure is necessary at all

`App.add_url_rule` registers **immediately**:

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
(`src/flask/sansio/app.py:604–661`; `url_map.add` at 653, `view_functions[endpoint] = view_func` at 661)

This version needs real application resources that an unregistered blueprint simply does not have:

* `self.url_rule_class` (line 650) — `url_rule_class = Rule` at `src/flask/sansio/app.py:257`
* `self.url_map` (line 653) — `self.url_map = self.url_map_class(host_matching=host_matching)` at `src/flask/sansio/app.py:405`; `url_map_class = Map` at `:263`
* `self.view_functions` (lines 655, 661)
* `self.config["PROVIDE_AUTOMATIC_OPTIONS"]` (line 641) — default `"PROVIDE_AUTOMATIC_OPTIONS": True` at `src/flask/app.py:208`

Since none of those exist on a blueprint that has not yet been registered, the blueprint has no choice but to defer the call until a `BlueprintSetupState` supplies `self.app`. That is the reason the anonymous function exists.

---

## 8. The decorator path reaches the same line

`@bp.route(...)` and `bp.get/post/put/delete/patch(...)` do not bypass the deferral; they funnel into the same `Blueprint.add_url_rule` override, and therefore into the same `self.record(lambda s: ...)` call:

```python
    @setupmethod
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
(`src/flask/sansio/scaffold.py:336–363`; `route` def at 336, inner `decorator` at 360, the call at 362)

```python
    def _method_route(
        self,
        method: str,
        rule: str,
        options: dict[str, t.Any],
    ) -> t.Callable[[T_route], T_route]:
        if "methods" in options:
            raise TypeError("Use the 'route' decorator to use the 'methods' argument.")

        return self.route(rule, methods=[method], **options)

    @setupmethod
    def get(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        """Shortcut for :meth:`route` with ``methods=["GET"]``.

        .. versionadded:: 2.0
        """
        return self._method_route("GET", rule, options)

    @setupmethod
    def post(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        ...
        return self._method_route("POST", rule, options)

    @setupmethod
    def put(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        ...
        return self._method_route("PUT", rule, options)

    @setupmethod
    def delete(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        ...
        return self._method_route("DELETE", rule, options)

    @setupmethod
    def patch(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        ...
        return self._method_route("PATCH", rule, options)
```
(`src/flask/sansio/scaffold.py:284–334`)

Executor spy output (exit=0):

```
Scaffold.route calls captured (from bp.get/bp.post via _method_route):
   route('/dec', {})
   route('/g', {'methods': ['GET']})
   route('/p', {'methods': ['POST']})
Blueprint.add_url_rule calls captured (route -> self.add_url_rule):
   add_url_rule(rule='/dec', endpoint=None, view_func='dec', args=(), kwargs={})
   add_url_rule(rule='/g', endpoint=None, view_func='g', args=(), kwargs={'methods': ['GET']})
   add_url_rule(rule='/p', endpoint=None, view_func='p', args=(), kwargs={'methods': ['POST']})

len(bp.deferred_functions): 3
every entry is a one-arg lambda function: True
every lambda is 'Blueprint.add_url_rule.<locals>.<lambda>': True
  url_for('bp.dec') -> /bp/dec
  url_for('bp.g') -> /bp/g
  url_for('bp.p') -> /bp/p
  rules: [('/bp/dec', 'bp.dec'), ('/bp/g', 'bp.g'), ('/bp/p', 'bp.p')]

=> @bp.route / bp.get / bp.post all land in the SAME deferred_functions via self.record(lambda s: ...)
exit=0
```

**In one sentence:** `@bp.route(...)`, `bp.get(...)`, `bp.post(...)` all reach the same `self.record(lambda s: ...)` line — the stored entries are literally `Blueprint.add_url_rule.<locals>.<lambda>` — so decorators and direct `bp.add_url_rule` calls share one deferral mechanism.

---

## 9. Observable consequences asserted by the suite

Same blueprint registered twice with different prefixes/names/defaults — the stored lambda replayed per registration:

```python
def test_blueprint_url_defaults(app, client):
    bp = flask.Blueprint("test", __name__)

    @bp.route("/foo", defaults={"baz": 42})
    def foo(bar, baz):
        return f"{bar}/{baz:d}"

    @bp.route("/bar")
    def bar(bar):
        return str(bar)

    app.register_blueprint(bp, url_prefix="/1", url_defaults={"bar": 23})
    app.register_blueprint(bp, name="test2", url_prefix="/2", url_defaults={"bar": 19})

    assert client.get("/1/foo").data == b"23/42"
    assert client.get("/2/foo").data == b"19/42"
    assert client.get("/1/bar").data == b"23"
    assert client.get("/2/bar").data == b"19"
```
(`tests/test_blueprints.py:131–148`)

The eager dot-character errors:

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
(`tests/test_blueprints.py:327–342`)

Renaming / repeated registration of one blueprint object:

```python
def test_unique_blueprint_names(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp", __name__)

    app.register_blueprint(bp)

    with pytest.raises(ValueError):
        app.register_blueprint(bp)  # same bp, same name, error

    app.register_blueprint(bp, name="again")  # same bp, different name, ok
    ...
```

```python
def test_blueprint_renaming(app, client) -> None:
    ...
    bp.register_blueprint(bp2, url_prefix="/a", name="sub")
    app.register_blueprint(bp, url_prefix="/a")
    app.register_blueprint(bp, url_prefix="/b", name="alt")

    assert client.get("/a/").data == b"bp.index"
    assert client.get("/b/").data == b"alt.index"
    assert client.get("/a/a/").data == b"bp.sub.index2"
    assert client.get("/b/a/").data == b"alt.sub.index2"
```
(`tests/test_blueprints.py:994–1028`)

Full suite, both runs, exit 0:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/ -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 7.49s
PYTEST_EXIT=0
```

```
============================= 489 passed in 7.50s =============================
PYTEST_EXIT=0
```

with the directly relevant node IDs all `PASSED`, including `test_blueprint_prefix_slash[...]` (12 cases), `test_blueprint_url_defaults`, `test_route_decorator_custom_endpoint_with_dots`, `test_unique_blueprint_names`, `test_blueprint_renaming`, `test_nested_callback_order`, `test_method_route[get|post|put|delete|patch]`, `test_provide_automatic_options_attr`, `test_provide_automatic_options_kwarg`, `test_no_setup_after_first_request`.

---

## 10. Related machinery that reuses the same list (context only)

`record_once` and the `*_app_*` methods share `deferred_functions` but are not part of the core answer, e.g.:

```python
    @setupmethod
    def before_app_request(self, f: T_before_request) -> T_before_request:
        """Like :meth:`before_request`, but before every request, not only those handled
        by the blueprint. Equivalent to :meth:`.Flask.before_request`.
        """
        self.record_once(
            lambda s: s.app.before_request_funcs.setdefault(None, []).append(f)
        )
        return f
```

```python
    @setupmethod
    def add_app_template_filter(
        self, f: ft.TemplateFilterCallable, name: str | None = None
    ) -> None:
        ...
        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.filters[name or f.__name__] = f

        self.record_once(register_template)
```

Nested blueprints take a different route entirely — they are stored as tuples, not deferred functions:

```python
        if blueprint is self:
            raise ValueError("Cannot register a blueprint on itself")
        self._blueprints.append((blueprint, options))
```
(`src/flask/sansio/blueprints.py:255–271`, inside `register_blueprint`)

and `Blueprint.register` recurses into `self._blueprints` after the drain, giving each child its own `BlueprintSetupState`.

---

## 11. Corrections to the plan's line citations (all confirmed against the tree)

The behavior described in the plan was fully reproduced; several line numbers were off. Verified actual locations:

| Plan citation | Actual location |
|---|---|
| `DeferredSetupFunction` at `blueprints.py:20` | **`blueprints.py:17`** |
| `Blueprint.add_url_rule` body 412–442 | **412–441** (`def` at 413) |
| `BlueprintSetupState.add_url_rule` `:87-117` | **87–114** (`def` at 87) |
| `Blueprint.record`/`record_once` `:223-244` | confirmed; append at **230**, `record_once` `def` at **233** |
| drain loop "`322-334`" | `state = self.make_setup_state(...)` at **321**, drain at **334–335** |
| `setupmethod` `scaffold.py:42-49` | confirmed |
| `_check_setup_finished` `blueprints.py:213-221` | confirmed |
| `Flask.register_blueprint` call at `601-602` | `blueprint.register(self, options)` at **`app.py:595`** (def at 570) |
| `Flask.add_url_rule` `app.py:605-678` | `def` **605**, `url_map.add` **653**, `view_functions[endpoint] =` **661**, block ends **661** |
| `scaffold.py:359-365` inner decorator | `route` def **336**, `decorator` **360**, call **362** |
| `scaffold.py:701-705` `_endpoint_from_view_func` | **701–706** (assert 705, return 706) |
| `blueprints.rst:27-28`, `:119-121` | lines **27** and **119** confirmed |

Environment note carried from the executor: the checked-in `.venv` editable install points at a *different* directory (`.../f2f45b5b/q1-TXT/seal/src`), so every command was run with `PYTHONPATH=src`, which resolves `flask.__file__` inside the working directory. Also, `flask_mut2_i417ar2x/mutated_test.py` contains no `Blueprint`, `deferred`, `add_url_rule`, or `record` references (grep exit 1) and exercises only app-level subdomain `url_for` matching; it is **not** evidence for this question.

---

## 12. Bottom line, in one paragraph

`Blueprint.add_url_rule` (`src/flask/sansio/blueprints.py:413`) performs eager validation, then wraps the call it wants to make — `s.add_url_rule(rule, endpoint, view_func, provide_automatic_options=provide_automatic_options, **options)` — in an anonymous `lambda s: ...` and passes it to `self.record(...)`. `Blueprint.record` (`blueprints.py:224`) does nothing but `self.deferred_functions.append(func)` (`blueprints.py:230`) into the per-instance list declared at `blueprints.py:204` as `list[DeferredSetupFunction]`, where `DeferredSetupFunction = t.Callable[["BlueprintSetupState"], None]` (`blueprints.py:17`). The lambda's only free variable that varies per registration is `s`; the rule, endpoint, view function, `provide_automatic_options`, and `**options` are captured at definition time. When the app later calls `blueprint.register(self, options)` (`app.py:595`), `Blueprint.register` builds `state = self.make_setup_state(app, options, first_bp_registration)` (`blueprints.py:321`) and then executes `for deferred in self.deferred_functions: deferred(state)` (`blueprints.py:334–335`), so each stored anonymous function is invoked with the freshly-created `BlueprintSetupState`. Only at that moment does `BlueprintSetupState.add_url_rule` (`blueprints.py:87`) run: it joins `url_prefix` onto the rule, injects the default `subdomain`, resolves a missing `endpoint` via `_endpoint_from_view_func`, merges `url_defaults`, prefixes the endpoint as `f"{self.name_prefix}.{self.name}.{endpoint}".lstrip(".")`, and finally calls `self.app.add_url_rule(...)` — the method that actually mutates `app.url_map` and `app.view_functions` and consults `self.config["PROVIDE_AUTOMATIC_OPTIONS"]` (`app.py:605–661`). The deferral exists because none of those app resources exist on a blueprint before registration, and it is what lets the same stored lambda be replayed against multiple states with different `url_prefix`/`subdomain`/`name`/`url_defaults`. The `@setupmethod` guard (`scaffold.py:42–49` → `blueprints.py:213–221`) blocks any further `add_url_rule`/`record` once `_got_registered_once` is set; the two dot-character `ValueError`s are the only eager errors, while endpoint defaulting and automatic-`OPTIONS` computation are deferred. Decorators (`@bp.route`, `bp.get/post/put/delete/patch`) reach the identical `self.record(lambda s: ...)` line, and the entire suite passes (489 passed, 0 failed, on two runs).
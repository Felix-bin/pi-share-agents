# Why repeating the blueprint custom-template-filter registration across distinct blueprints degrades startup performance

## Short answer

The mechanism at issue is `Blueprint.add_app_template_filter` / `@bp.app_template_filter`, which defers the actual Jinja write into a `record_once` callback:

```python
        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.filters[name or f.__name__] = f

        self.record_once(register_template)
```

`record_once`'s "only once" guard is *not* keyed on the application or on the filter name — it is keyed on a per-blueprint identity flag:

```python
        def wrapper(state: BlueprintSetupState) -> None:
            if state.first_registration:
                func(state)
```

and that flag is produced by an identity scan over the app's registered blueprints:

```python
        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
```

`first_bp_registration` is therefore `True` for **every distinct blueprint object**, no matter how many other blueprints already registered the same filter. So if the registration mechanism is repeated across N distinct blueprint objects at startup, the "once" dedup never fires: the app-wide filter is written N times into the single shared `app.jinja_env.filters` dict, N deferred callbacks are executed, and each `Blueprint.register` additionally pays an O(len(app.blueprints)) identity scan that makes N registrations cost Θ(N²) in aggregate — all producing exactly the same end state as doing it once. The measured instrumentation confirms this: N distinct blueprints → `register_template` executes N times and performs N dict writes, while `len(filters)` grows by exactly 1.

Nothing in Jinja recompiles templates or invalidates caches because a filter was written — `Environment.filters` is a plain copied dict (`self.filters = DEFAULT_FILTERS.copy()`), lookups are `env_map.get(name)` at render time, and the template cache key is `(weakref.ref(self.loader), name)`. The degradation is **redundant global setup work plus registration-time scaling**, not repeated template compilation.

---

## 1. The mechanism, verbatim

### 1.1 `Blueprint.add_app_template_filter` — `src/flask/sansio/blueprints.py` lines 460–475

```python
    @setupmethod
    def add_app_template_filter(
        self, f: ft.TemplateFilterCallable, name: str | None = None
    ) -> None:
        """Register a template filter, available in any template rendered by the
        application. Works like the :meth:`app_template_filter` decorator. Equivalent to
        :meth:`.Flask.add_template_filter`.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """

        def register_template(state: BlueprintSetupState) -> None:
            state.app.jinja_env.filters[name or f.__name__] = f

        self.record_once(register_template)
```

and the decorator form (lines 442–458):

```python
    @setupmethod
    def app_template_filter(
        self, name: str | None = None
    ) -> t.Callable[[T_template_filter], T_template_filter]:
        """Register a template filter, available in any template rendered by the
        application. Equivalent to :meth:`.Flask.template_filter`.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """

        def decorator(f: T_template_filter) -> T_template_filter:
            self.add_app_template_filter(f, name=name)
            return f

        return decorator
```

Two facts follow immediately from this code, and they are the whole story:

* The write target is `state.app.jinja_env.filters[name or f.__name__] = f` — the **application-level** environment, shared by every blueprint.
* The *only* deduplication available is whatever `record_once` provides. There is no name-based or app-based registry check anywhere.

### 1.2 `record`, `record_once`, `make_setup_state` — lines 223–253

```python
    @setupmethod
    def record(self, func: DeferredSetupFunction) -> None:
        """Registers a function that is called when the blueprint is
        registered on the application.  This function is called with the
        state as argument as returned by the :meth:`make_setup_state`
        method.
        """
        self.deferred_functions.append(func)

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

    def make_setup_state(
        self, app: App, options: dict[str, t.Any], first_registration: bool = False
    ) -> BlueprintSetupState:
        """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
        object that is later passed to the register callback functions.
        Subclasses can override this to return a subclass of the setup state.
        """
        return BlueprintSetupState(self, app, options, first_registration)
```

The docstring states the scope of the guard precisely: *"If the blueprint is registered a second time on the application, the function passed is not called."* It dedupes **re-registration of the same blueprint object**, nothing else.

### 1.3 `first_registration` is a per-setup-state flag — `BlueprintSetupState.__init__`, lines 39–88

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
        ...
```

### 1.4 The per-blueprint deferred list — `Blueprint.__init__`, line 204

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

Every `Blueprint` instance gets a **fresh** `deferred_functions` list, so every instance carries its own `register_template` callback.

### 1.5 `Blueprint.register` — where the flag is computed and callbacks run, lines 273–335

```python
    def register(self, app: App, options: dict[str, t.Any]) -> None:
        """Called by :meth:`Flask.register_blueprint` to register all
        views and callbacks registered on the blueprint with the
        application. Creates a :class:`.BlueprintSetupState` and calls
        each :meth:`record` callback with it.
        ...
        """
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

Line 316 is the crux:

```python
        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
```

This is an **identity** test (`is`) against the values of `app.blueprints`. For a newly created blueprint object, no other object in that registry `is` it, so `first_bp_registration` is `True` **unconditionally on first use of that object** — regardless of what filter names, function names, or callback kinds other blueprints already installed on the same app. That flag flows through `make_setup_state(app, options, first_bp_registration)` (line 321) into `state.first_registration` (line 62), which is exactly the value `record_once`'s wrapper tests.

### 1.6 The per-instance setup guard — `blueprints.py` lines 213–222 and `src/flask/sansio/scaffold.py` lines 42–49

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

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`_got_registered_once` is declared as a class attribute (`_got_registered_once = False`, line 172) and set on `self` at line 320 (`self._got_registered_once = True`). The guard blocks *new setup calls on an already-registered instance*; a freshly created second blueprint passes it and is free to record its own copy of the same filter. The error message even spells out the intended usage discipline ("Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it") — it is per-blueprint, not per-app.

### 1.7 The single shared Jinja environment — `src/flask/sansio/app.py`

```python
        #: Maps registered blueprint names to blueprint objects. The
        #: dict retains the order the blueprints were registered in.
        #: Blueprints can be registered multiple times, this dict does
        #: not track how often they were attached.
        #:
        #: .. versionadded:: 0.7
        self.blueprints: dict[str, Blueprint] = {}
```

```python
    @cached_property
    def jinja_env(self) -> Environment:
        """The Jinja environment used to load templates.

        The environment is created the first time this property is
        accessed. Changing :attr:`jinja_options` after that will have no
        effect.
        """
        return self.create_jinja_environment()
```

One `cached_property`, one environment, one `filters` dict per app — that is the shared object every `register_template` closure mutates.

---

## 2. The test cases that exercise the mechanism

These are the "blueprint test cases" the question refers to — `tests/test_blueprints.py`, lines 362–494. All of them follow the identical shape: create a blueprint, register a filter on it, then `app.register_blueprint(bp)`.

```python
def test_template_filter(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    assert "my_reverse" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["my_reverse"] == my_reverse
    assert app.jinja_env.filters["my_reverse"]("abcd") == "dcba"


def test_add_template_filter(app):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse)
    app.register_blueprint(bp, url_prefix="/py")
    assert "my_reverse" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["my_reverse"] == my_reverse
    assert app.jinja_env.filters["my_reverse"]("abcd") == "dcba"
```

```python
def test_template_filter_with_name(app):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter("strrev")
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    assert "strrev" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["strrev"] == my_reverse
    assert app.jinja_env.filters["strrev"]("abcd") == "dcba"


def test_add_template_filter_with_name(app):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse, "strrev")
    app.register_blueprint(bp, url_prefix="/py")
    assert "strrev" in app.jinja_env.filters.keys()
    assert app.jinja_env.filters["strrev"] == my_reverse
    assert app.jinja_env.filters["strrev"]("abcd") == "dcba"
```

```python
def test_template_filter_with_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def super_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"


def test_template_filter_after_route_with_template(app, client):
    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter()
    def super_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")
    rv = client.get("/")
    assert rv.data == b"dcba"


def test_add_template_filter_with_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    def super_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(super_reverse)
    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"


def test_template_filter_with_name_and_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    @bp.app_template_filter("super_reverse")
    def my_reverse(s):
        return s[::-1]

    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"


def test_add_template_filter_with_name_and_template(app, client):
    bp = flask.Blueprint("bp", __name__)

    def my_reverse(s):
        return s[::-1]

    bp.add_app_template_filter(my_reverse, "super_reverse")
    app.register_blueprint(bp, url_prefix="/py")

    @app.route("/")
    def index():
        return flask.render_template("template_filter.html", value="abcd")

    rv = client.get("/")
    assert rv.data == b"dcba"
```

The identity semantics the guard relies on are pinned down by `tests/test_blueprints.py::test_unique_blueprint_names` (lines 994–1008):

```python
def test_unique_blueprint_names(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp", __name__)

    app.register_blueprint(bp)

    with pytest.raises(ValueError):
        app.register_blueprint(bp)  # same bp, same name, error

    app.register_blueprint(bp, name="again")  # same bp, different name, ok

    with pytest.raises(ValueError):
        app.register_blueprint(bp2)  # different bp, same name, error

    app.register_blueprint(bp2, name="alt")  # different bp, different name, ok
```

Two *distinct* blueprint objects with the same internal name are perfectly legal under different registration names (`bp2` / `name="alt"`), which is exactly the scenario in which the filter registration is duplicated without any dedup. The registration-count scaling is also corroborated by `test_blueprint_url_defaults` (line 143):

```python
    app.register_blueprint(bp, url_prefix="/1", url_defaults={"bar": 23})
    app.register_blueprint(bp, name="test2", url_prefix="/2", url_defaults={"bar": 19})
```

For contrast, the app-level one-shot path (`src/flask/sansio/app.py` lines 686–695) writes the shared dict synchronously, exactly once:

```python
    @setupmethod
    def add_template_filter(
        self, f: ft.TemplateFilterCallable, name: str | None = None
    ) -> None:
        """Register a custom template filter.  Works exactly like the
        :meth:`template_filter` decorator.

        :param name: the optional name of the filter, otherwise the
                     function name will be used.
        """
        self.jinja_env.filters[name or f.__name__] = f
```

`tests/test_templating.py` lines 123–160 exercises this counterpart — same assertions, no `record_once`, no deferred list.

---

## 3. The cause chain, step by step

1. **Deferral.** `Blueprint.add_app_template_filter` does not write Jinja itself. It defines a closure `register_template` that writes `state.app.jinja_env.filters[name or f.__name__] = f` and hands it to `self.record_once(register_template)`, which appends an `update_wrapper`-wrapped guard to *that blueprint's* `deferred_functions`.

2. **The guard is per-blueprint identity, not per-app dedup.** `record_once` only runs the callback `if state.first_registration:`, and `state.first_registration` comes from `Blueprint.register`'s
   ```python
   first_bp_registration = not any(bp is self for bp in app.blueprints.values())
   ```
   For every newly-constructed blueprint object this is `True`, because the app's blueprint registry contains no object that `is` the new one. There is no comparison of filter names, function objects, or previously-installed app-wide registrations.

3. **All state that could have deduplicated is per-instance.** `self.deferred_functions: list[DeferredSetupFunction] = []` is created fresh in every `Blueprint.__init__`; `_got_registered_once` / `_check_setup_finished` / `setupmethod` guard only re-entrant setup on one already-registered instance. Nothing in `Blueprint`, `BlueprintSetupState`, or `App` records "this filter is already installed on this app".

4. **Consequence at startup.** Repeating the mechanism across N distinct blueprints makes startup do, for each of the N blueprints:
   * build a new `register_template` closure and an `update_wrapper`-wrapped deferred callback at definition time (N closures + N wrappers),
   * run `for deferred in self.deferred_functions: deferred(state)` → N `deferred(state)` invocations (line 334),
   * touch the shared cached Jinja environment N times (`state.app.jinja_env`),
   * write the same key into the single shared `jinja_env.filters` dict N times.

   The end state is byte-identical to doing it once: one entry, pointing at the last-written function.

5. **Aggravating factor — quadratic registration cost.** Each `Blueprint.register` recomputes `not any(bp is self for bp in app.blueprints.values())` (line 316), a linear scan over the already-registered blueprints. Registering N distinct blueprints therefore performs 1 + 2 + … + N ≈ N²/2 identity comparisons in aggregate. The duplicated filter registration multiplies the number of `Blueprint.register` calls that exist (and forces the `jinja_env` property access / environment creation to happen earlier than the lazily-cached property intended).

6. **Contrast with the correct one-time paths.** `app.add_template_filter(f)` writes the dict once, synchronously, with no `record_once`; a single blueprint that records the filter once and is registered once runs the wrapper exactly once — including when it is re-registered N times under `name=` variants, because `first_bp_registration` is then `False` for every subsequent registration.

---

## 4. Measured evidence

Environment: Python 3.13.9, Flask 3.2.0.dev0 (this working tree's `src`), Jinja2 3.1.6. Scripts `bench_blueprint_filters.py` (arms, timing, instrumentation of `Blueprint.record_once`, a counting `filters` dict and an `app.jinja_env` proxy) and `step4_side_effects.py`, both placed at the repository root, never touching `src/`. Exit status 0 for both.

### 4.1 Timing: `register()` wall time vs N (best of 7)

```
==============================================================================
STEP 3 TIMING: register() wall time vs N   (best of 7)
==============================================================================
     N |   distinct_filters |  distinct_nofilter |     one_bp_n_times | delta(filt-nofilt)
------------------------------------------------------------------------------------------
     1 |           0.000014 |           0.000007 |           0.000015 |           0.000007
    10 |           0.000046 |           0.000031 |           0.000041 |           0.000014
   100 |           0.000413 |           0.000363 |           0.000279 |           0.000050
   500 |           0.004843 |           0.004381 |           0.001352 |           0.000463
  1000 |           0.015880 |           0.015560 |           0.002721 |           0.000320
  2000 |           0.058822 |           0.058061 |           0.005363 |           0.000762
```

Good controls here: `distinct_nofilter` (N distinct blueprints with no filter registration) differs from `distinct_filters` only by the redundant filter work (`delta(filt-nofilt)` ≤ ~0.8 ms at N=2000), and `one_bp_n_times` — one blueprint registered N times under alt names — stays at ~0.005 s at N=2000, an order of magnitude below the distinct-blueprint arms, because the identity scan is short-circuited… no: because `record_once` runs once and the registration is one object, so the deferred work never repeats.

### 4.2 Instrumentation: how many times the callback actually runs

```
==============================================================================
STEP 3 INSTRUMENTATION (single shot per arm)
==============================================================================
                 arm |      N | register_template_exec | jinja_env_filters_access | filter_dict_writes | len(filters)
---------------------------------------------------------------------------------------------------------------------
         baseline_bp |      1 |                      1 |                        1 |                  1 |           55
    distinct_filters |      1 |                      1 |                        1 |                  1 |           55
    distinct_filters |     10 |                     10 |                       10 |                 10 |           55
    distinct_filters |    100 |                    100 |                      100 |                100 |           55
    distinct_filters |    500 |                    500 |                      500 |                500 |           55
    distinct_filters |   1000 |                   1000 |                     1000 |               1000 |           55
   distinct_nofilter |      1 |                      0 |                        0 |                  0 |           54
   distinct_nofilter |     10 |                      0 |                        0 |                  0 |           54
   distinct_nofilter |    100 |                      0 |                        0 |                  0 |           54
   distinct_nofilter |    500 |                      0 |                        0 |                  0 |           54
   distinct_nofilter |   1000 |                      0 |                        0 |                  0 |           54
      one_bp_n_times |      1 |                      1 |                        1 |                  1 |           55
      one_bp_n_times |     10 |                      1 |                        1 |                  1 |           55
      one_bp_n_times |    100 |                      1 |                        1 |                  1 |           55
      one_bp_n_times |    500 |                      1 |                        1 |                  1 |           55
      one_bp_n_times |   1000 |                      1 |                        1 |                  1 |           55
```

This is the decisive table:

* **N distinct blueprints with the filter → `register_template` runs exactly N times** (1, 10, 100, 500, 1000), i.e. `record_once`'s guard **never** fires across distinct objects.
* **N distinct blueprints with no filter → 0 executions** (control).
* **One blueprint registered N times under `name=f"alt{i}"` → exactly 1 execution for every N** — proving the guard *does* work when the registration stays on one blueprint object.
* Yet `len(filters)` is 55 in both the with-filter and without-filter cases (54 baseline + the single new entry): the N writes collapse to one visible entry. N reads of `jinja_env.filters` and N writes occur regardless.

### 4.3 The quadratic identity scan

```
==============================================================================
STEP 3 SCAN: per-call cost of `not any(bp is self for bp in app.blueprints.values())`
==============================================================================
       N |     per-call seconds |       vs N=1 ratio
----------------------------------------------------
       1 |       0.000000189650 |           1.000000
      10 |       0.000000436800 |           2.303190
     100 |       0.000002407350 |          12.693646
     500 |       0.000017715250 |          93.410229
    1000 |       0.000028306900 |         149.258634
    2000 |       0.000052545750 |         277.066966
```

Per-call scan cost grows with the size of `app.blueprints` (277× from N=1 to N=2000), so aggregating N registrations is quadratic:

```
==============================================================================
STEP 3 SCALING CHECK: aggregate register() growth vs N
==============================================================================
       N |    nofilter wall s | ratio vs 10x smaller |       x10 per decade
--------------------------------------------------------------------------
       1 |           0.000007 |                      |
      10 |           0.000031 |                4.274 |
     100 |           0.000363 |               11.635 |
     500 |           0.004381 |               12.068 |
    1000 |           0.015560 |                3.552 |
    2000 |           0.058061 |                3.731 |
```

`register()` time roughly doubles-plus per doubling in the large-N range (1000 → 2000 is ≈3.7×), consistent with the O(len(app.blueprints)) scan on line 316.

Baseline arms for reference:

```
==============================================================================
STEP 3 ARM 1: baseline_once (app.add_template_filter, once)
==============================================================================
  arm_baseline_once() -> 0.000037600 s
  arm_baseline_once() -> 0.000019200 s
  arm_baseline_once() -> 0.000010800 s

==============================================================================
STEP 3 ARM 1b: baseline_bp (one blueprint, filter, registered once)
==============================================================================
  best=0.000016200 s median=0.000025900 s
```

---

## 5. Correctness side-effects of the repetition

`step4_side_effects.py` output (exit 0):

```
==============================================================================
STEP 4a: N writes to one shared name -> exactly one entry (last wins)
==============================================================================
initial len(app.jinja_env.filters) = 54
after 100 distinct-bp registrations:
  len(app.jinja_env.filters) = 55
  delta = 1 (expected 1)
  'my_reverse' in filters -> True
  stored is funcs[-1] (last written)? -> True
  stored is funcs[0]  (first written)? -> False
  all N blueprints share ONE env? -> True
  calling stored('abcd') -> 'v99:dcba'
  => 100 closures built, 100 deferred callbacks run, 100 dict writes,
     but the end state is identical to ONE registration (v99).

==============================================================================
STEP 4b: collision hazard -- two distinct blueprints, DIFFERENT funcs,
         SAME filter name -> silent overwrite
==============================================================================
after registering bp_a: filters['collide']('x') = 'A:x'
  is reverse_a? -> True
after registering bp_b: filters['collide']('x') = 'B:x'
  is reverse_b? -> True
  is reverse_a? -> False
  len(app2.jinja_env.filters) has 'collide' exactly once -> 1
  => bp_a's filter is GONE with no error; last blueprint wins.

==============================================================================
STEP 4c: no template recompilation / cache invalidation on filter write
==============================================================================
  template object identical after re-write? -> True
  cache size before=1 after=1
  rendered after overwrite -> 'B:dcba'
  => filter writes neither recompile nor invalidate the template cache.
```

So the repeated registration is **purely redundant global work**: N closures, N deferred callbacks, N environment touches, N dict writes, yielding one entry — and it comes with a collision hazard, because two distinct blueprints that happen to register *different* functions under the *same* filter name silently overwrite in registration order, with no error.

---

## 6. What is *not* the cause (important, because it bounds the claim)

* **The Jinja environment is not rebuilt.** `Flask.jinja_env` is a `cached_property`, so it is created at most once (on first access) and shared by all blueprints. Repeating the registration does not create new environments.
* **Filters are a plain dict, not a cached structure.** `Environment.__init__` does `self.filters = DEFAULT_FILTERS.copy()`; a write is an ordinary `dict.__setitem__`.
* **Lookup is at render/call time and is O(1).** `_filter_test_common` does `env_map = self.filters` … `func = env_map.get(name)`; no invalidation is needed or performed on a write.
* **Templates are not recompiled.** The template cache key is `(weakref.ref(self.loader), name)`; filter writes neither clear nor mutate `self.cache`. Step 4c confirms this directly: the template object is identical after the rewrite, cache size stays 1 → 1, and the render just uses whichever function is currently stored.
* **The cost is genuinely (i) loss of the `once` dedup because `first_registration` is per-blueprint identity, (ii) N redundant closure/wrapper constructions, N deferred-callback executions, N shared-dict writes into one environment, and (iii) the Θ(N²) identity scan `not any(bp is self for bp in app.blueprints.values())` inside `Blueprint.register`.**

---

## 7. Test-suite status (regression context)

`.venv/Scripts/python.exe -m pytest tests/` — **489 passed in 5.62s**, exit 0; focused run `tests/test_blueprints.py` → `60 passed in 0.79s`, exit 0. Under maximum verbosity (`-m pytest tests/ -vv -rA --tb=long --durations=0`, exit 0) all 489 entries are `PASSED`, including exactly the tests that exercise this mechanism:

```
PASSED tests/test_blueprints.py::test_template_filter
PASSED tests/test_blueprints.py::test_add_template_filter
PASSED tests/test_blueprints.py::test_template_filter_with_name
PASSED tests/test_blueprints.py::test_add_template_filter_with_name
PASSED tests/test_blueprints.py::test_template_filter_with_template
PASSED tests/test_blueprints.py::test_template_filter_after_route_with_template
PASSED tests/test_blueprints.py::test_add_template_filter_with_template
PASSED tests/test_blueprints.py::test_template_filter_with_name_and_template
PASSED tests/test_blueprints.py::test_add_template_filter_with_name_and_template
PASSED tests/test_blueprints.py::test_template_global
PASSED tests/test_blueprints.py::test_unique_blueprint_names
PASSED tests/test_templating.py::test_template_filter
PASSED tests/test_templating.py::test_add_template_filter
```

The filter-related blueprint tests each take ≤ 0.01 s, precisely because each uses a *single* blueprint — the degradation only appears when the same registration is duplicated across many distinct blueprint objects, which is the scenario the question asks about.

---

## 8. One-line answer restated

Repeating the blueprint filter-registration mechanism across multiple distinct blueprint objects defeats `record_once`'s "once" guard, because that guard is `if state.first_registration:` where `first_registration` is computed as `not any(bp is self for bp in app.blueprints.values())` — true for every newly created blueprint regardless of what other blueprints already installed. Each distinct blueprint therefore re-runs its own deferred `register_template` callback at startup, writing the same key into the one shared `app.jinja_env.filters` dict (app `jinja_env` being a single `cached_property`), N times for N blueprints, while each `Blueprint.register` also pays an O(len(app.blueprints)) identity scan that makes N registrations cost Θ(N²) overall. The end state is identical to one registration; the extra time is redundant setup work and registration-time scaling, not repeated template compilation (Jinja never invalidates or recompiles anything on a filter write). The correct one-time paths are `app.add_template_filter(f)` (a single synchronous dict write) or one blueprint whose `record_once` callback runs exactly once — and repeating under a single name additionally risks silently overwriting another blueprint's filter.
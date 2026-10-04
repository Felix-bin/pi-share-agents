# Answer

## Bottom line

The flag is **`Blueprint._got_registered_once`** — a one-way latch on the blueprint object that flips from `False` to `True` the first time the blueprint is registered, and is never reset. Its purpose is to turn a *silently inconsistent* state into an immediate error: once a blueprint has been registered, any `@setupmethod` call on it (adding routes, request hooks, error handlers, template filters, nested blueprints, `record`/`record_once` callbacks, …) raises `AssertionError` instead of quietly doing nothing for the apps that already replayed the blueprint's recorded setup. A blueprint is only a *recording* of deferred operations that gets materialized into each app at registration time, so anything recorded after the first registration lands in later registrations and not in earlier ones — divergence that would otherwise surface as a mysterious missing route rather than an error.

The error text states the purpose itself: *"any changes will not be applied consistently. Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*

**Scope of the verdict:** verified in this checkout, `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src`, `pyproject.toml` `version = "3.2.0.dev"` (dist metadata `3.2.0.dev0`), git HEAD detached at `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`.

---

## Claim 1 — What the flag is, and where it lives

The class the question calls "the blueprint collection class" is `Blueprint`, and the phrase "collection" is the checkout's own wording, from its docstring (`src/flask/sansio/blueprints.py:119-133`, class statement at 119):

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
    that is called with :class:`flask.blueprints.BlueprintSetupState`
    when the blueprint is registered on an application.

    See :doc:`/blueprints` for more information.
```

The flag is declared once as a **class** attribute, at the end of the class docstring block (`:169` is `.. versionadded:: 0.7`, `:170` closes the docstring), `src/flask/sansio/blueprints.py:172`:

```python
    _got_registered_once = False
```

`__init__` (starting at `:174`) never assigns it — the class attribute is the only default. It is set as an **instance** attribute, once, inside `Blueprint.register`, at `:320`:

```python
        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)
```

A whole-`src` grep for the identifier (`.py` source only) returns **exactly three** lines — declaration, read, assignment — and no writer that ever assigns `False` outside the class body:

```
flask/sansio/blueprints.py:172:     _got_registered_once = False
flask/sansio/blueprints.py:214:         if self._got_registered_once:
flask/sansio/blueprints.py:320:         self._got_registered_once = True
```

So nothing in `src/` ever resets the latch; it is permanent for that blueprint **object instance**. (Correction to the upstream plan: the plan asserted "exactly two occurrences"; the verified count is **three**. The plan's conclusion still holds.) For contrast, the app-side analogue *is* resettable — see Claim 6.

---

## Claim 2 — What the flag gates: `@setupmethod`-decorated mutation, *not* registration

The enforcement chain is: `@setupmethod` wrapper → `Scaffold._check_setup_finished` (abstract) → `Blueprint._check_setup_finished` → `AssertionError`.

`src/flask/sansio/scaffold.py:42-49` (full function):

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`src/flask/sansio/scaffold.py:220-221` (the abstract hook on the shared base of `Flask` and `Blueprint`):

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

`src/flask/sansio/blueprints.py:213-221` — the override that consumes the flag (full function):

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

Note the `\n` is inside the literal ending `" changes will not be applied consistently.\n"`, i.e. immediately before "Make sure…" — that placement matters and was byte-for-byte confirmed at runtime (Claim 3's empirical evidence).

**`Blueprint.register` itself is not decorated with `@setupmethod`.** Its `def` is at `:273`, and line 272 is blank; the `@setupmethod` sites in the file are 223, 232, **255** (`register_blueprint`), 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624 — `register` is not among them. Consequently the latch **forbids mutation of the blueprint, not (re-)registration of it**: the same blueprint can still be registered on a second app, or re-registered on the same app under a different `name=`.

The methods that *are* gated are everything decorated `@setupmethod`. On `Blueprint` itself (full `@setupmethod` list with line numbers): 223 `record`; 232 `record_once`; 255 `register_blueprint`; 412 `add_url_rule`; 443 `app_template_filter`; 460 `add_app_template_filter`; 477 `app_template_test`; 496 `add_app_template_test`; 515 `app_template_global`; 534 `add_app_template_global`; 553 `before_app_request`; 563 `after_app_request`; 573 `teardown_app_request`; 583 `app_context_processor`; 595 `app_errorhandler`; 612 `app_url_value_preprocessor`; 624 `app_url_defaults`. Plus, because `Blueprint` inherits from `Scaffold`, the inherited set also applies: `src/flask/sansio/scaffold.py` decorates 295 `get`, 303 `post`, 311 `put`, 319 `delete`, 327 `patch`, 335 `route`, 367 `add_url_rule`, 435 `endpoint`, 459 `before_request`, 486 `after_request`, 507 `teardown_request`, 541 `context_processor`, 558 `url_value_preprocessor`, 583 `url_defaults`, 597 `errorhandler`, 641 `register_error_handler`.

Two of the gated methods, full bodies (`src/flask/sansio/blueprints.py:223-244`):

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
```

And nesting is gated too (`src/flask/sansio/blueprints.py:255-271`, full method):

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on this blueprint. Keyword
        arguments passed to this method will override the defaults set
        on the blueprint.

        .. versionchanged:: 2.0.1
            The ``name`` option can be used to change the (pre-dotted)
            name the blueprint is registered with. This allows the same
            blueprint to be registered multiple times with unique names
            for ``url_for``.

        .. versionadded:: 2.0
        """
        if blueprint is self:
            raise ValueError("Cannot register a blueprint on itself")
        self._blueprints.append((blueprint, options))
```

The public subclass `src/flask/blueprints.py` is a thin shim — `class Blueprint(SansioBlueprint):` at `:18`, with only `__init__`, `get_send_file_max_age`, `send_static_file`, `open_resource` of its own; a grep for `_got_registered_once|_check_setup_finished` in that file returns **no hits** (exit 1). So a reader of `src/flask/blueprints.py` alone would miss the flag entirely; it lives in `src/flask/sansio/blueprints.py`. `src/flask/__init__.py:3` re-exports `Blueprint` from `flask.blueprints`.

---

## Claim 3 — Why the latch is needed: the blueprint is a *recording*, replayed per app

`Blueprint.register`'s own body is the proof. Full function, `src/flask/sansio/blueprints.py:273-377` (the decisive lines are `:316-321` and the replay loop `:334-335`; the nested-blueprint recursion `blueprint.register(app, bp_options)` closes at `:377`):

```python
    def register(self, app: App, options: dict[str, t.Any]) -> None:
        """Called by :meth:`Flask.register_blueprint` to register all
        views and callbacks registered on the blueprint with the
        application. Creates a :class:`.BlueprintSetupState` and calls
        each :meth:`record` callback with it.

        :param app: The application this blueprint is being registered
            with.
        :param options: Keyword arguments forwarded from
            :meth:`~Flask.register_blueprint`.

        .. versionchanged:: 2.3
            Nested blueprints now correctly apply subdomains.

        .. versionchanged:: 2.1
            Registering the same blueprint with the same name multiple
            times is an error.

        .. versionchanged:: 2.0.1
            Nested blueprints are registered with their dotted name.
            This allows different blueprints with the same name to be
            nested at different locations.

        .. versionchanged:: 2.0.1
            The ``name`` option can be used to change the (pre-dotted)
            name the blueprint is registered with. This allows the same
            blueprint to be registered multiple times with unique names
            for ``url_for``.
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

        cli_resolved_group = options.get("cli_group", self.cli_group)

        if self.cli.commands:
            if cli_resolved_group is None:
                app.cli.commands.update(self.cli.commands)
            elif cli_resolved_group is _sentinel:
                self.cli.name = name
                app.cli.add_command(self.cli)
            else:
                self.cli.name = cli_resolved_group
                app.cli.add_command(self.cli)

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

The consistency argument, grounded in that body:

* The blueprint accumulates deferred work in `self.deferred_functions` (initialized empty at `:204`), and registration **replays that list** — `for deferred in self.deferred_functions: deferred(state)` (`:334-335`).
* Registration additionally merges recorded data into the app via `_merge_blueprint_funcs(app, name)` (`:331-332`; the method is defined at `:379` and copies `error_handler_spec`, `view_functions`, `before_request_funcs`, `after_request_funcs`, `teardown_request_funcs`, `url_default_functions`, `url_value_preprocessors`, `template_context_processors`), and recursively registers `self._blueprints` via `Blueprint.register` (`:377`).
* Each app only gets what was in the recorded lists **at the moment it registered**. A setup call made afterwards is appended to `deferred_functions` / mutated dicts but can only ever be seen by *later* registrations. Apps that registered earlier keep an app object that silently lacks the new route/hook/handler. That is exactly what the error message says: *"any changes will not be applied consistently."*
* `Blueprint`'s own docstring says the same thing structurally: it *"defers the need for an application by recording them for later registration."*

There are exactly two call sites of `Blueprint.register` repo-wide, confirming the replay is per-app:

```
src/flask/sansio/app.py:595:         blueprint.register(self, options)
src/flask/sansio/blueprints.py:377:             blueprint.register(app, bp_options)
```

`src/flask/sansio/app.py:569-595` is that first caller (full method incl. docstring):

```python
    @setupmethod
    def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
        """Register a :class:`~flask.Blueprint` on the application. Keyword
        arguments passed to this method will override the defaults set on the
        blueprint.

        Calls the blueprint's :meth:`~flask.Blueprint.register` method after
        recording the blueprint in the application's :attr:`blueprints`.

        :param blueprint: The blueprint to register.
        :param url_prefix: Blueprint routes will be prefixed with this.
        :param subdomain: Blueprint routes will match on this subdomain.
        :param url_defaults: Blueprint routes will use these default values for
            view arguments.
        :param options: Additional keyword arguments are passed to
            :class:`~flask.blueprints.BlueprintSetupState`. They can be
            accessed in :meth:`~flask.Blueprint.record` callbacks.

        .. versionchanged:: 2.0.1
            The ``name`` option can be used to change the (pre-dotted)
            name the blueprint is registered with. This allows the same
            blueprint to be registered multiple times with unique names
            for ``url_for``.

        .. versionadded:: 0.7
        """
        blueprint.register(self, options)
```

(Note that `App.register_blueprint` *is* `@setupmethod`-guarded — on the *app's* `_got_first_request` latch, not the blueprint's.)

---

## Claim 4 — The practical failure mode it targets

Blueprints are normally registered inside an app factory, while the route modules are imported for their decorators — the canonical pattern is `docs/patterns/appfactories.rst:24-40`:

```rst
The idea is to set up the application in a function.  Like this::

    def create_app(config_filename):
        app = Flask(__name__)
        app.config.from_pyfile(config_filename)

        from yourapplication.model import db
        db.init_app(app)

        from yourapplication.views.admin import admin
        from yourapplication.views.frontend import frontend
        app.register_blueprint(admin)
        app.register_blueprint(frontend)

        return app
```

and `docs/tutorial/views.rst:46-60`:

```rst
Import and register the blueprint from the factory using
:meth:`app.register_blueprint() <Flask.register_blueprint>`. Place the
new code at the end of the factory function before returning the app.

.. code-block:: python
    :caption: ``flaskr/__init__.py``

    def create_app():
        app = ...
        # existing code omitted

        from . import auth
        app.register_blueprint(auth.bp)

        return app
```

In that shape, a route module (or an extra `@bp.route`, hook, or handler) that is registered/imported **after** `app.register_blueprint(bp)` has already run would otherwise register nothing for that app and fail only as a mysterious 404 at request time — or, worse, behave differently in a second app that registers the blueprint later. The latch converts that into an immediate `AssertionError` at the offending call site, naming the method and the blueprint. The project states this design intent for the whole guard class in `docs/lifecycle.rst:36-43`:

```rst
All application setup must be completed before you start serving your application and
handling requests. This is because WSGI servers divide work between multiple workers, or
can be distributed across multiple machines. If the configuration changed in one worker,
there's no way for Flask to ensure consistency between other workers.

Flask tries to help developers catch some of these setup ordering issues by showing an
error if setup-related methods are called after requests are handled. In that case
you'll see this error:
```

(Two caveats on this citation: the message the doc goes on to display is the **application** variant — *"The setup method 'route' can no longer be called on the application. It has already handled its first request…"* — and `Blueprint` is named in this doc only in the subsequent "don't modify … from within view functions" bullet list. Also, the executor found the literal string `"on the blueprint"` *does* appear once under `docs/`, but unrelated to the guard: `docs/errorhandling.rst:169` `"Handlers registered on the blueprint take precedence over those registered"` — so a claim phrased as "the phrase never appears in docs" would be wrong as literally worded.)

For the blueprint case the divergence is broader than the multi-worker story: the same blueprint object can be mounted on multiple apps and/or multiple times on one app (`docs/blueprints.rst:119-121`: *"On top of that you can register blueprints multiple times though not every blueprint might respond properly to that. In fact it depends on how the blueprint is implemented if it can be mounted more than once."*), and the earlier mounts are exactly the ones that would silently miss a late addition.

---

## Claim 5 — The latch must not be confused with `BlueprintSetupState.first_registration` / `record_once`

There are **two different "once" concepts** in this class, and the write-up keeps them separate:

| | `Blueprint._got_registered_once` | `BlueprintSetupState.first_registration` |
|---|---|---|
| Scope | per **blueprint object**, **ever** | per **(blueprint, app, name)** registration event |
| Default | class attribute `False` at `sansio/blueprints.py:172` | constructor argument `:46`, instance attribute `:62` |
| Set | once, to `True`, at `:320` | each registration, from `first_bp_registration` at `:316` |
| Reset | **never** | recomputed for every `register()` call |
| Consumer | `_check_setup_finished` at `:214` → `AssertionError` | `record_once`'s wrapper (`:240-242`) |

`src/flask/sansio/blueprints.py:34-85` — `BlueprintSetupState.__init__` (full), showing the *other* "first registration" notion:

```python
class BlueprintSetupState:
    """Temporary holder object for registering a blueprint with the
    application.  An instance of this class is created by the
    :meth:`~flask.Blueprint.make_setup_state` method and later passed
    to all register callback functions.
    """

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

        url_prefix = self.options.get("url_prefix")
        if url_prefix is None:
            url_prefix = self.blueprint.url_prefix
        #: The prefix that should be used for all URLs defined on the
        #: blueprint.
        self.url_prefix = url_prefix

        self.name = self.options.get("name", blueprint.name)
        self.name_prefix = self.options.get("name_prefix", "")

        #: A dictionary with URL defaults that is added to each and every
        #: URL that was defined with the blueprint.
        self.url_defaults = dict(self.blueprint.url_values_defaults)
        self.url_defaults.update(self.options.get("url_defaults", ()))
```

It is fed by `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (`:316`, quoted in full in Claim 3), passed through `make_setup_state` (`:246-253`):

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

and consumed by `record_once`'s wrapper (`:240-242`): `if state.first_registration: func(state)`.

So `first_registration` answers *"is this the first time this blueprint has been mounted **on this app**?"* — and it is deliberately `False` on a second mount, so `record_once` callbacks don't run twice. `_got_registered_once` answers *"has this blueprint object ever been registered anywhere?"* — and it is deliberately irreversible, because the class object's recorded setup cannot be retro-fitted into apps that already consumed it. Same word "once", opposite lifetimes.

---

## Claim 6 — History, the app-side analogue, and test coverage

**History, as stated by the project itself** (`CHANGES.rst` only — this sandbox has no upstream git history, so these are CHANGES attributions, not a reconstructed commit log):

`CHANGES.rst:160-161` (Version 2.3.0 section, header at `:135`):

```rst
    -   Calling setup methods on blueprints after registration is an error instead of a
        warning. :pr:`4997`
```

`CHANGES.rst:297-300` (Version 2.2.0 section, header at `:237`):

```rst
-   Use Blueprint decorators and functions intended for setup after
    registering the blueprint will show a warning. In the next version,
    this will become an error just like the application setup methods.
    :issue:`4571`
```

So: `_got_registered_once` began life as a **warning** in Flask 2.2.0 and became an **error** in 2.3.0. (Nearby, `CHANGES.rst:165`: *"The ``app.got_first_request`` property is deprecated. :pr:`4997`"*.)

**Why the name says "…_once" and not "_first_request"**: the app-side guard is the sibling mechanism with a nearly identical message, but its latch *is* resettable. `src/flask/sansio/app.py:409-423`:

```python
        # tracks internally if the application already handled at least one
        # request.
        self._got_first_request = False

    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_first_request:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called"
                " on the application. It has already handled its first"
                " request, any changes will not be applied"
                " consistently.\n"
                "Make sure all imports, decorators, functions, etc."
                " needed to set up the application are done before"
                " running it."
            )
```

It is set in `Flask.full_dispatch_request` (`src/flask/app.py:911`: `self._got_first_request = True`) and **reset** in `Flask.run()`'s `finally` block, `src/flask/app.py:663-667`:

```python
        finally:
            # reset the first request information if the development server
            # reset normally.  This makes it possible to restart the server
            # without reloader and that stuff from an interactive shell.
            self._got_first_request = False
```

A whole-`src` grep for `_got_first_request` returns only those four lines (init `sansio/app.py:411`, check `sansio/app.py:414`, reset `app.py:667`, set `app.py:911`). The entire `run()`-restart rationale has no analogue for a blueprint: a blueprint has no "running" subsystem that can be restarted, and its recorded setup can never be retracted from an app that already replayed it — hence the permanent latch and the "…_once" name.

**Test coverage in this checkout is asymmetric.** There is one positive guard test, and it is app-side — `tests/test_basic.py:1678-1690`:

```python
def test_no_setup_after_first_request(app, client):
    app.debug = True

    @app.route("/")
    def index():
        return "Awesome"

    assert client.get("/").data == b"Awesome"

    with pytest.raises(AssertionError) as exc_info:
        app.add_url_rule("/foo", endpoint="late")

    assert "setup method 'add_url_rule'" in str(exc_info.value)
```

There is **no dedicated blueprint-side guard test**. Greps under `tests/` (each its own command, recursive):

```
grep -rn "_got_registered_once"        tests/  → exit 1  (no output)
grep -rn "registered at least once"    tests/  → exit 1  (no output)
grep -rn "no longer be called"         tests/  → exit 1  (no output)
grep -rn "_check_setup_finished"       tests/  → exit 1  (no output)
grep -rn "got_first_request"           tests/  → exit 1  (no output)
grep -rn "setup method"                tests/  → exit 0  → tests/test_basic.py:1690 only (+3 .pyc binaries)
grep -rn "AssertionError"              tests/  → exit 0  → test_basic.py:610,1478,1482,1687,1707; test_helpers.py:233; test_json.py:336; test_reqctx.py:221; test_request.py:15; test_views.py:182 (+.pyc)
```

The only guard assertion anywhere under `tests/` is the app-side one at `test_basic.py:1690`. Related tests do cover the *allowed* behaviour (that the latch does not block re-registration), `tests/test_blueprints.py:994-1014`:

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


def test_self_registration(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    with pytest.raises(ValueError):
        bp.register_blueprint(bp)
```

`app.register_blueprint(bp, name="again")` is `tests/test_blueprints.py:1003` — the same blueprint re-registered *after* the latch is already `True`, and it is expected to succeed. The multi-mount test `tests/test_blueprints.py:1017-1048` (`test_blueprint_renaming`, same blueprint twice on one app under `/a` and `/b`) proves re-registration is intended to keep working:

```python
def test_blueprint_renaming(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp2", __name__)

    @bp.get("/")
    def index():
        return flask.request.endpoint

    @bp.get("/error")
    def error():
        flask.abort(403)

    @bp.errorhandler(403)
    def forbidden(_: Exception):
        return "Error", 403

    @bp2.get("/")
    def index2():
        return flask.request.endpoint

    bp.register_blueprint(bp2, url_prefix="/a", name="sub")
    app.register_blueprint(bp, url_prefix="/a")
    app.register_blueprint(bp, url_prefix="/b", name="alt")

    assert client.get("/a/").data == b"bp.index"
    assert client.get("/b/").data == b"alt.index"
    assert client.get("/a/a/").data == b"bp.sub.index2"
    assert client.get("/b/a/").data == b"alt.sub.index2"
    assert client.get("/a/error").data == b"Error"
    assert client.get("/b/error").data == b"Error"
```

**Therefore:** in this checkout, saying the blueprint latch "is tested" would be wrong; only the app-side analogue is tested, and the blueprint latch's behavioural evidence lives in the executed probes below. The full suite is green regardless: `489 passed in 2.14s` (`win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0`, `rootdir: …\flask-src`, `configfile: pyproject.toml`, `testpaths: tests`), and `pytest tests/test_blueprints.py -q` → `60 passed in 0.39s`.

---

## Empirical evidence (executed probes)

The blueprint latch has no upstream test, so the claims above were reproduced behaviourally. The executor's probes were written to a temp dir outside the repo (`%TEMP%\bp_flag_probe\bp_flag_probe.py`, ASCII-only, `PYTHONIOENCODING=utf-8`), run with the checkout's own venv interpreter (`.venv/Scripts/python.exe`, Python 3.13.9, whose `flask.pth` points at this checkout's `src`, and `importlib.metadata.version('Flask')` → `3.2.0.dev0`). The checkout was not modified.

Reported results, verbatim from the executor's report:

| Probe | Command | Exit | Headline result |
|---|---|---|---|
| **p1** guard fires | `… bp_flag_probe.py p1` | 0 | before: `False`, name **not** in `bp.__dict__`; after register: `True`, name **in** `bp.__dict__`; `bp.add_url_rule(...)` → `AssertionError`; name `'add_url_rule'` in message **True**; message == source literal (starts-with exact source prefix **True**) |
| **p2** all setup methods | `… p2` | 0 | **13/13** raise `AssertionError` with their own method name: `before_request, errorhandler, app_template_filter, get, record, record_once, route, post, teardown_request, context_processor, app_errorhandler, app_url_defaults, register_blueprint` |
| **p3** register not guarded | `… p3` | 0 | latch `True`; late mutation still raises; **(a)** `app2.register_blueprint(bp)` **succeeded** (fresh app); **(b)** `app1.register_blueprint(bp, name='again')` **succeeded** → `app1.blueprints = ['again','bp']`; **(c)** same-name re-register → `ValueError: The name 'bp' is already registered for this blueprint. Use 'name=' to provide a unique name.` Rules: app1 = `bp.x→/x`, `again.x→/x`; app2 = `bp.x→/x`. Latch still `True` |
| **p4** nesting guarded | `… p4` | 0 | `parent.register_blueprint(child)` after registration → `AssertionError`, message names `'register_blueprint'`; child attached *before* registration → app2 registers fine, `app2.blueprints = ['parent2','parent2.child2']` |
| **p5** per-instance | `… p5` | 0 | `sansio Blueprint.__dict__` has flag `True` (`value: False`); public `flask.Blueprint` `__dict__` → `False` (inherited only); `bp_a` registered `True`, `bp_b` untouched `False` and still accepts setup; `Sub(Blueprint)` instance before register `False` (not in instance `__dict__`), after register `True`, late add raises |
| **p6** nothing resets | `… p6` | 0 | flag after 4 registrations (app1, app2, name='again', name='third') = `[True, True, True, True]`; late add raises; `inspect.getsource(flask.Flask.run)` contains `_got_first_request = False` → `['self._got_first_request = False']` |

Probe 2 establishes the "prevents setup methods" claim directly: **13/13** `@setupmethod`-decorated entries tried each raised `AssertionError` carrying that method's own name (the name comes from `setupmethod`'s `f_name = f.__name__`). Probe 3 establishes the crucial scoping: the latch blocks *mutation* but not *registration*.

A pre-existing independent reproduction, `flask-src-scratch/repro_blueprint_setup_guard.py`, re-run by the executor, ended:

```
22/22 checks passed
ALL CHECKS PASSED
```

Its run-2 summary (verbatim):

```
==============================================================================
SUMMARY
==============================================================================
[PASS] 1a: class-level default is False
[PASS] 1b: flag is still False before register()
[PASS] 1c: flag False before register is served by the CLASS attribute (not shadowed)
[PASS] 1d: flag is True after register()
[PASS] 1e: after register the flag IS shadowed in the instance __dict__
[PASS] 2a: bp.get() after register raises AssertionError
[PASS] 2b: runtime message == the literal in blueprints.py:214-220 (byte-for-byte)
[PASS] 3a: same blueprint may be re-registered under name='again' despite the latch
[PASS] 3b: both names are present in app.blueprints
[PASS] 4a: a fresh blueprint's flag is still False
[PASS] 4b: a fresh blueprint still accepts setup calls
[PASS] 5a: setup still blocked even with a second app in play (flag lives on the blueprint)
[PASS] 6a: attaching a child after registration raises AssertionError
[PASS] 6b: a child attached before the parent is registered works
[PASS] 7a: app._got_first_request flips after any served request
[PASS] 7b: app.add_url_rule after first request raises AssertionError
[PASS] 7c: the app flag has NO class-level declaration (pure instance attribute)
[PASS] 8a: Blueprint._got_registered_once is declared on the SANSIO class (flask.sansio.blueprints.Blueprint.__dict__), not on the public subclass
[PASS] 8a2: the public flask.Blueprint merely INHERITS the flag (issubclass(flask.Blueprint, sansio.Blueprint) and same object)
[PASS] 8b: BlueprintSetupState.first_registration is an instance attribute, set in __init__
[PASS] 8b2: a live BlueprintSetupState carries first_registration as an instance attr
[PASS] 8c: Flask._got_first_request is NOT declared on App.__dict__ either (pure instance attribute set in App.__init__)

22/22 checks passed
ALL CHECKS PASSED
```

And the verbatim runtime message, captured byte-for-byte equal to the source literal at `:214-220`:

```
   The setup method 'get' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
   Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
```

Relevant test runs:

| Command | Exit | Output |
|---|---|---|
| `pytest tests/test_basic.py::test_no_setup_after_first_request -q` | 0 | `.` … `1 passed in 0.05s` |
| `pytest tests/test_blueprints.py::test_unique_blueprint_names tests/test_blueprints.py::test_blueprint_renaming tests/test_blueprints.py::test_self_registration -v` | 0 | 3 collected → `test_unique_blueprint_names PASSED`, `test_blueprint_renaming PASSED`, `test_self_registration PASSED` — `3 passed in 0.07s` |
| `pytest tests/test_blueprints.py -q` | 0 | `60 passed in 0.39s` |
| `./.venv/Scripts/pytest.exe` (full suite) | 0 | `collected 489 items` … `489 passed in 2.13s` |
| `./.venv/Scripts/pytest.exe -vv -rA` | 0 | `489 passed in 2.14s` |

---

## Corrections applied to the upstream plan/dossier (verified against the files)

1. The plan said "`grep` over `src/` shows exactly two occurrences of the identifier" — the verified count is **three** (`:172` declaration, `:214` read, `:320` assignment; plus 5 stale `.pyc` binary hits from four interpreter generations, which are why counts of 3 vs 5 appear in different greps). The plan's conclusion — nothing ever resets the latch — still holds: the only assignment of `False` is the class body at `:172`; `:320` assigns `True`.
2. The plan cited the replay loop at `:337-338`; it is actually **`:334-335`**.
3. The plan cited the app-side check at `sansio/app.py:413-422`; the closing `)` is on **`:423`**.
4. The plan cited `sansio/app.py:569-597`; the method body is **569-595** (`iter_blueprints` starts at 597).
5. The plan cited `BlueprintSetupState.__init__` as "`:34-104`"; the class is at 34, `__init__` is **41-85**, `add_url_rule` is 87-118.
6. The plan cited the class docstring as "`:119-126`"; it spans **120-170** (`See :doc:/blueprints for more information.` at 133, `.. versionadded:: 0.7` at 169).
7. The plan cited `record` as "`:223-244`"; `record` is **223-230**, `record_once` is **232-244**.
8. The plan cited `Blueprint.register` as "`:273-378`"; it is **273-377** (the nested `blueprint.register(app, bp_options)` at 377 is the last statement).
9. The dossier's claim that the phrase "on the blueprint" does not appear anywhere in `docs/` is falsified as literally worded by `docs/errorhandling.rst:169` (unrelated to the guard). The substantive claims — `registered at least once`, `after registration`, `record_once|first_registration` all have **no** matches under `docs/` — hold.

## Consistency checklist (from the plan's step 5)

- (a) "collection" is attributed to `Blueprint`'s own docstring (`sansio/blueprints.py:120`), not invented. ✔
- (b) No claim implies the flag blocks `Flask.register_blueprint` / re-registration of an already-registered blueprint — probe 3(a)/(b) and `tests/test_blueprints.py:1003` contradict that, and this answer says the opposite. ✔
- (c) The quoted message matches `:215-220` exactly, including the `\n` after "consistently." — confirmed byte-for-byte at runtime by scratch check `2b`. ✔
- (d) The answer never says the latch is reset; it is permanent for the object instance (probe p6 shows `[True, True, True, True]` across four registrations). ✔
- (e) The verdict is scoped to this checkout, Flask `3.2.0.dev`, `src/flask/sansio/blueprints.py`, commit `85c5d93c….` ✔
# Purpose of the blueprint registration-tracking flag (`Blueprint._got_registered_once`)

**Verification disclosure:** the behavioral claims below were **executed**, not merely statically traced — a 56-check harness was run against the repo's own venv (Python 3.13.9, editable install pinning `src`), plus the complete test suite (489 passed twice, exit 0). No divergence from the static trace was found. Details in the "How this was verified" section at the end; the harness's one initial FAIL was a bug in the harness itself, fixed and re-run to 56/56.

---

## 1. What the "blueprint collection class" is, and the exact flag in question

The class is `Blueprint`. Its own docstring calls it a "collection":

> **`src/flask/sansio/blueprints.py`, lines 119–123 (verbatim)**
> ```python
> class Blueprint(Scaffold):
>     """Represents a blueprint, a collection of routes and other
>     app-related functions that can be registered on a real application
>     later.
> ```

The registration-tracking flag is **`Blueprint._got_registered_once`**. It appears in exactly three source places in the entire working tree, all in one file:

> **`grep -rn "_got_registered_once" .` (run over the whole tree, verbatim output)**
> ```
> ./src/flask/sansio/blueprints.py:172:    _got_registered_once = False
> ./src/flask/sansio/blueprints.py:214:        if self._got_registered_once:
> ./src/flask/sansio/blueprints.py:320:        self._got_registered_once = True
> ```

Note the file split, which is a common source of a false negative: the flag lives in **`src/flask/sansio/blueprints.py`**, *not* in the user-visible `src/flask/blueprints.py`, which is only a subclass/shim and contains no occurrence of the flag at all:

> **`grep -n "_got_registered_once" src/flask/blueprints.py` → `grep exit=1 (1 = no match)`**
> ```
> $ sed -n '1,25p' src/flask/blueprints.py
> from __future__ import annotations
>
> import os
> import typing as t
> from datetime import timedelta
>
> from .cli import AppGroup
> from .globals import current_app
> from .helpers import send_from_directory
> from .sansio.blueprints import Blueprint as SansioBlueprint
> from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
> from .sansio.scaffold import _sentinel
>
> if t.TYPE_CHECKING:  # pragma: no cover
>     from .wrappers import Response
>
>
> class Blueprint(SansioBlueprint):
>     def __init__(
>         self,
>         name: str,
>         import_name: str,
>         static_folder: str | os.PathLike[str] | None = None,
>         static_url_path: str | None = None,
>         template_folder: str | os.PathLike[str] | None = None,
> ```
> ```
> $ grep -n "^class Blueprint" src/flask/blueprints.py
> 18:class Blueprint(SansioBlueprint):
> ```
> Runtime MRO check confirms the inheritance chain:
> ```
> $ ./.venv/Scripts/python.exe -c "import flask;print([c.__module__+'.'+c.__name__ for c in flask.Blueprint.__mro__]);print('flask.blueprints module:',flask.Blueprint.__module__)"
> ['flask.blueprints.Blueprint', 'flask.sansio.blueprints.Blueprint', 'flask.sansio.scaffold.Scaffold', 'builtins.object']
> flask.blueprints module: flask.blueprints
> ```

The `sansio/` placement is deliberate — that directory is defined as implementation-agnostic:

> **`src/flask/sansio/README.md` (whole file, verbatim)**
> ```
> # Sansio
>
> This folder contains code that can be used by alternative Flask
> implementations, for example Quart. The code therefore cannot do any
> IO, nor be part of a likely IO path. Finally this code cannot use the
> Flask globals.
> ```

---

## 2. Purpose, stated in one sentence

`_got_registered_once` is a **fail-fast guard**: once a blueprint has been registered on *any* application, its setup/mutator methods (`route`, `add_url_rule`, `before_request`, `errorhandler`, `record`, …) raise an `AssertionError` instead of silently accepting changes that can no longer be applied consistently — because by that point the blueprint's `deferred_functions` have already been replayed into the app and its callbacks/handlers have already been merged via `_merge_blueprint_funcs`, and in a multi-worker / multi-machine WSGI deployment only the one worker that made the late change would ever see it.

That rationale is documented (for the shared app/blueprint mechanism) in the lifecycle docs:

> **`docs/lifecycle.rst` lines 36–52 (verbatim; quoted by execution as `sed -n '36,52p'`)**
> ```
> All application setup must be completed before you start serving your application and
> handling requests. This is because WSGI servers divide work between multiple workers, or
> can be distributed across multiple machines. If the configuration changed in one worker,
> there's no way for Flask to ensure consistency between other workers.
>
> Flask tries to help developers catch some of these setup ordering issues by showing an
> error if setup-related methods are called after requests are handled. In that case
> you'll see this error:
>
>     The setup method 'route' can no longer be called on the application. It has already
>     handled its first request, any changes will not be applied consistently.
>     Make sure all imports, decorators, functions, etc. needed to set up the application
>     are done before running it.
>
> However, it is not possible for Flask to detect all cases of out-of-order setup. In
> general, don't do anything to modify the ``Flask`` app object and ``Blueprint`` objects
> from within view functions that run during requests. This includes:
> ```
> (Caveat carried forward from the evidence: this doc block quotes only the **application**-side error wording; `grep -rn "already been registered" docs/` → no hit. There is no doc passage quoting the blueprint-side message itself.)

The pre-registration ordering is the sanctioned usage pattern:

> **`examples/tutorial/flaskr/__init__.py` lines 29–52 (verbatim)**
> ```python
>     @app.route("/hello")
>     def hello():
>         return "Hello, World!"
>
>     # register the database commands
>     from . import db
>
>     db.init_app(app)
>
>     # apply the blueprints to the app
>     from . import auth
>     from . import blog
>
>     app.register_blueprint(auth.bp)
>     app.register_blueprint(blog.bp)
> ```

---

## 3. How the flag becomes a gate — mechanics, quoted end to end

### 3a. The declaration (class attribute; default `False`)

> **`src/flask/sansio/blueprints.py` lines 172–212 (verbatim; the flag line plus `__init__`, which never assigns it)**
> ```python
>     _got_registered_once = False
>
>     def __init__(
>         self,
>         name: str,
>         import_name: str,
>         static_folder: str | os.PathLike[str] | None = None,
>         static_url_path: str | None = None,
>         template_folder: str | os.PathLike[str] | None = None,
>         url_prefix: str | None = None,
>         subdomain: str | None = None,
>         url_defaults: dict[str, t.Any] | None = None,
>         root_path: str | None = None,
>         cli_group: str | None = _sentinel,  # type: ignore[assignment]
>     ):
>         super().__init__(
>             import_name=import_name,
>             static_folder=static_folder,
>             static_url_path=static_url_path,
>             template_folder=template_folder,
>             root_path=root_path,
>         )
>
>         if not name:
>             raise ValueError("'name' may not be empty.")
>
>         if "." in name:
>             raise ValueError("'name' may not contain a dot '.' character.")
>
>         self.name = name
>         self.url_prefix = url_prefix
>         self.subdomain = subdomain
>         self.deferred_functions: list[DeferredSetupFunction] = []
>
>         if url_defaults is None:
>             url_defaults = {}
>
>         self.url_values_defaults = url_defaults
>         self.cli_group = cli_group
>         self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
> ```

Because `__init__` never assigns it, the default is read through the class; the only write anywhere is a per-instance assignment in `register`. Execution confirmed both halves of this (from the passing run):

> ```
> [PASS] Blueprint class attr default is False  Blueprint._got_registered_once=False
> [PASS] fresh instance does NOT own the attr in __dict__  bp.__dict__ keys w/ flag = []
> [PASS] fresh instance reads False through the class  bp._got_registered_once=False
> [PASS] instance attr appears in __dict__ only after register  bp.__dict__['_got_registered_once']=True
> [PASS] class attribute is still False (write was per-instance)  Blueprint._got_registered_once=False
> [PASS] other instance still unregistered  bp_other._got_registered_once=False
> ```

### 3b. The guard body (the read site, line 214)

> **`src/flask/sansio/blueprints.py` lines 213–221 (whole method, verbatim)**
> ```python
>     def _check_setup_finished(self, f_name: str) -> None:
>         if self._got_registered_once:
>             raise AssertionError(
>                 f"The setup method '{f_name}' can no longer be called on the blueprint"
>                 f" '{self.name}'. It has already been registered at least once, any"
>                 " changes will not be applied consistently.\n"
>                 "Make sure all imports, decorators, functions, etc. needed to set up"
>                 " the blueprint are done before registering it."
>             )
> ```

### 3c. The wrapper that routes every setup method into the guard

> **`src/flask/sansio/scaffold.py` lines 42–49 (whole function, verbatim)**
> ```python
> def setupmethod(f: F) -> F:
>     f_name = f.__name__
>
>     def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
>         self._check_setup_finished(f_name)
>         return f(self, *args, **kwargs)
>
>     return t.cast(F, update_wrapper(wrapper_func, f))
> ```

> **`src/flask/sansio/scaffold.py` lines 220–221 (whole abstract hook that `Blueprint` overrides, verbatim)**
> ```python
>     def _check_setup_finished(self, f_name: str) -> None:
>         raise NotImplementedError
> ```

The call chain is therefore: `@setupmethod` wrapper → `self._check_setup_finished(f_name)` → (Blueprint override) → `raise AssertionError(...)`. `f_name` is captured at decoration time from `f.__name__`, so the error names the exact method the caller invoked.

### 3d. The single write site — `self._got_registered_once = True` in `Blueprint.register`

> **`src/flask/sansio/blueprints.py` lines 273–377 (whole method, verbatim)**
> ```python
>     def register(self, app: App, options: dict[str, t.Any]) -> None:
>         """Called by :meth:`Flask.register_blueprint` to register all
>         views and callbacks registered on the blueprint with the
>         application. Creates a :class:`.BlueprintSetupState` and calls
>         each :meth:`record` callback with it.
>
>         :param app: The application this blueprint is being registered
>             with.
>         :param options: Keyword arguments forwarded from
>             :meth:`~Flask.register_blueprint`.
>
>         .. versionchanged:: 2.3
>             Nested blueprints now correctly apply subdomains.
>
>         .. versionchanged:: 2.1
>             Registering the same blueprint with the same name multiple
>             times is an error.
>
>         .. versionchanged:: 2.0.1
>             Nested blueprints are registered with their dotted name.
>             This allows different blueprints with the same name to be
>             nested at different locations.
>
>         .. versionchanged:: 2.0.1
>             The ``name`` option can be used to change the (pre-dotted)
>             name the blueprint is registered with. This allows the same
>             blueprint to be registered multiple times with unique names
>             for ``url_for``.
>         """
>         name_prefix = options.get("name_prefix", "")
>         self_name = options.get("name", self.name)
>         name = f"{name_prefix}.{self_name}".lstrip(".")
>
>         if name in app.blueprints:
>             bp_desc = "this" if app.blueprints[name] is self else "a different"
>             existing_at = f" '{name}'" if self_name != name else ""
>
>             raise ValueError(
>                 f"The name '{self_name}' is already registered for"
>                 f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
>                 f" provide a unique name."
>             )
>
>         first_bp_registration = not any(bp is self for bp in app.blueprints.values())
>         first_name_registration = name not in app.blueprints
>
>         app.blueprints[name] = self
>         self._got_registered_once = True
>         state = self.make_setup_state(app, options, first_bp_registration)
>
>         if self.has_static_folder:
>             state.add_url_rule(
>                 f"{self.static_url_path}/<path:filename>",
>                 view_func=self.send_static_file,  # type: ignore[attr-defined]
>                 endpoint="static",
>             )
>
>         # Merge blueprint data into parent.
>         if first_bp_registration or first_name_registration:
>             self._merge_blueprint_funcs(app, name)
>
>         for deferred in self.deferred_functions:
>             deferred(state)
>
>         cli_resolved_group = options.get("cli_group", self.cli_group)
>
>         if self.cli.commands:
>             if cli_resolved_group is None:
>                 app.cli.commands.update(self.cli.commands)
>             elif cli_resolved_group is _sentinel:
>                 self.cli.name = name
>                 app.cli.add_command(self.cli)
>             else:
>                 self.cli.name = cli_resolved_group
>                 app.cli.add_command(self.cli)
>
>         for blueprint, bp_options in self._blueprints:
>             bp_options = bp_options.copy()
>             bp_url_prefix = bp_options.get("url_prefix")
>             bp_subdomain = bp_options.get("subdomain")
>
>             if bp_subdomain is None:
>                 bp_subdomain = blueprint.subdomain
>
>             if state.subdomain is not None and bp_subdomain is not None:
>                 bp_options["subdomain"] = bp_subdomain + "." + state.subdomain
>             elif bp_subdomain is not None:
>                 bp_options["subdomain"] = bp_subdomain
>             elif state.subdomain is not None:
>                 bp_options["subdomain"] = state.subdomain
>
>             if bp_url_prefix is None:
>                 bp_url_prefix = blueprint.url_prefix
>
>             if state.url_prefix is not None and bp_url_prefix is not None:
>                 bp_options["url_prefix"] = (
>                     state.url_prefix.rstrip("/") + "/" + bp_url_prefix.lstrip("/")
>                 )
>             elif bp_url_prefix is not None:
>                 bp_options["url_prefix"] = bp_url_prefix
>             elif state.url_prefix is not None:
>                 bp_options["url_prefix"] = state.url_prefix
>
>             bp_options["name_prefix"] = name
>             blueprint.register(app, bp_options)
> ```

Ordering, line-anchored (confirmed by execution via `grep -n "" ... | sed -n '300,340p'`):

> ```
> 300:            for ``url_for``.
> 301:        """
> 302:        name_prefix = options.get("name_prefix", "")
> 303:        self_name = options.get("name", self.name)
> 304:        name = f"{name_prefix}.{self_name}".lstrip(".")
> 305:
> 306:        if name in app.blueprints:
> 307:            bp_desc = "this" if app.blueprints[name] is self else "a different"
> 308:            existing_at = f" '{name}'" if self_name != name else ""
> 309:
> 310:            raise ValueError(
> 311:                f"The name '{self_name}' is already registered for"
> 312:                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
> 313:                f" provide a unique name."
> 314:            )
> 315:
> 316:        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
> 317:        first_name_registration = name not in app.blueprints
> 318:
> 319:        app.blueprints[name] = self
> 320:        self._got_registered_once = True
> 321:        state = self.make_setup_state(app, options, first_bp_registration)
> 322:
> 323:        if self.has_static_folder:
> 324:            state.add_url_rule(
> 325:                f"{self.static_url_path}/<path:filename>",
> 326:                view_func=self.send_static_file,  # type: ignore[attr-defined]
> 327:                endpoint="static",
> 328:            )
> 329:
> 330:        # Merge blueprint data into parent.
> 331:        if first_bp_registration or first_name_registration:
> 332:            self._merge_blueprint_funcs(app, name)
> 333:
> 334:        for deferred in self.deferred_functions:
> 335:            deferred(state)
> ```
> “confirms: name-collision `ValueError` at 310–314 precedes the write at 320; the write precedes `make_setup_state` (321) and the deferred replay loop (334–335).”

So the flag flips to `True` **after** the duplicate-name check and **before** `make_setup_state` and the deferred-callback replay loop.

### 3e. Which methods are gated

Every mutating method on `Blueprint` (and those inherited from `Scaffold`) carries `@setupmethod`. The complete decorator inventory:

> **`grep -n "@setupmethod" src/flask/sansio/blueprints.py src/flask/sansio/scaffold.py` (verbatim)**
> ```
> src/flask/sansio/blueprints.py:223:    @setupmethod
> src/flask/sansio/blueprints.py:232:    @setupmethod
> src/flask/sansio/blueprints.py:255:    @setupmethod
> src/flask/sansio/blueprints.py:412:    @setupmethod
> src/flask/sansio/blueprints.py:443:    @setupmethod
> src/flask/sansio/blueprints.py:460:    @setupmethod
> src/flask/sansio/blueprints.py:477:    @setupmethod
> src/flask/sansio/blueprints.py:496:    @setupmethod
> src/flask/sansio/blueprints.py:515:    @setupmethod
> src/flask/sansio/blueprints.py:534:    @setupmethod
> src/flask/sansio/blueprints.py:553:    @setupmethod
> src/flask/sansio/blueprints.py:563:    @setupmethod
> src/flask/sansio/blueprints.py:573:    @setupmethod
> src/flask/sansio/blueprints.py:583:    @setupmethod
> src/flask/sansio/blueprints.py:595:    @setupmethod
> src/flask/sansio/blueprints.py:612:    @setupmethod
> src/flask/sansio/blueprints.py:624:    @setupmethod
> src/flask/sansio/scaffold.py:295:    @setupmethod
> src/flask/sansio/scaffold.py:303:    @setupmethod
> src/flask/sansio/scaffold.py:311:    @setupmethod
> src/flask/sansio/scaffold.py:319:    @setupmethod
> src/flask/sansio/scaffold.py:327:    @setupmethod
> src/flask/sansio/scaffold.py:335:    @setupmethod
> src/flask/sansio/scaffold.py:367:    @setupmethod
> src/flask/sansio/scaffold.py:435:    @setupmethod
> src/flask/sansio/scaffold.py:459:    @setupmethod
> src/flask/sansio/scaffold.py:486:    @setupmethod
> src/flask/sansio/scaffold.py:507:    @setupmethod
> src/flask/sansio/scaffold.py:541:    @setupmethod
> src/flask/sansio/scaffold.py:558:    @setupmethod
> src/flask/sansio/scaffold.py:583:    @setupmethod
> src/flask/sansio/scaffold.py:597:    @setupmethod
> src/flask/sansio/scaffold.py:641:    @setupmethod
> ```

Named: on `Blueprint` — `record` (224), `record_once` (233), `register_blueprint` (256), `add_url_rule` (413), `app_template_filter` (444), `add_app_template_filter` (461), `app_template_test` (478), `add_app_template_test` (497), `app_template_global` (516), `add_app_template_global` (535), `before_app_request` (554), `after_app_request` (564), `teardown_app_request` (574), `app_context_processor` (584), `app_errorhandler` (596), `app_url_value_preprocessor` (613), `app_url_defaults` (625). Inherited from `Scaffold`: `get`, `post`, `put`, `delete`, `patch`, `route`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`.

Crucially, **`Blueprint.register` (line 273) and `Blueprint.make_setup_state` (line 246) are NOT decorated** — the `@setupmethod` at 255 belongs to `register_blueprint` at 256:

> ```
> $ sed -n '244,248p;271,275p' src/flask/sansio/blueprints.py
>         self.record(update_wrapper(wrapper, func))
>
>     def make_setup_state(
>         self, app: App, options: dict[str, t.Any], first_registration: bool = False
>     ) -> BlueprintSetupState:
>         self._blueprints.append((blueprint, options))
>
>     def register(self, app: App, options: dict[str, t.Any]) -> None:
>         """Called by :meth:`Flask.register_blueprint` to register all
>         views and callbacks registered on the blueprint with the
> ```
> ```
> [PASS] Flask.register_blueprint is itself gated by @setupmethod  __wrapped__=<function App.register_blueprint at 0x000002C4D569AD40>
> [PASS] Blueprint.register is NOT gated (no __wrapped__)  __wrapped__=None
> [PASS] Blueprint.make_setup_state is NOT gated (no __wrapped__)
> ```

### 3f. What the error actually looks like at runtime

Executed, a fresh call after registration:

> ```
> --- full exact message from a fresh bp.route() call ---
> type: AssertionError
> is AssertionError      : True
> isinstance RuntimeError: False
> isinstance ValueError  : False
> repr(str(exc)):
> "The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.\nMake sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."
> --- rendered ---
> The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
> Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
> --- end message ---
> [PASS] exception type is exactly AssertionError  type=AssertionError
> [PASS] exception is NOT a RuntimeError
> [PASS] exception is NOT a ValueError
> [PASS] message names the offending setup method ('route')
> ```

All 29 setup methods sampled raised identically, e.g.:

> ```
> [PASS] bp.add_url_rule() raised AssertionError w/ blueprint message  type=AssertionError msg="The setup method 'add_url_rule' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently."
> [PASS] bp.before_request() raised AssertionError w/ blueprint message  type=AssertionError msg="The setup method 'before_request' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently."
> [PASS] bp.record() raised AssertionError w/ blueprint message  type=AssertionError msg="The setup method 'record' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently."
> [PASS] bp.record_once() raised AssertionError w/ blueprint message  type=AssertionError msg="The setup method 'record_once' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently."
> [PASS] bp.register_error_handler() raised AssertionError w/ blueprint message  type=AssertionError msg="The setup method 'register_error_handler' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently."
> …
> ```

---

## 4. What the flag does **not** do (boundary precision)

### 4a. It does **not** forbid re-registration

`Blueprint.register` is not a `@setupmethod`, so registering the same blueprint again — on another app, or on the same app under a different `name=` — remains legal. This is executed, not inferred:

> ```
> SUB-CLAIM 2: re-registration stays legal (flag does not block it)
> [PASS] same bp registered twice under different names does NOT raise
> [PASS] both mounts route correctly  /a/ -> 200 b'bp.index' ; /b/ -> 200 b'alt.index'
> [PASS] same bp registered on a different app does NOT raise
> [PASS] bp.register(app4, {}) called directly does NOT raise (not a @setupmethod)
> ```

The suite encodes the same contract (`test_unique_blueprint_names` and `test_blueprint_renaming`):

> **`tests/test_blueprints.py` lines 994–1009 (whole test, verbatim)**
> ```python
> def test_unique_blueprint_names(app, client) -> None:
>     bp = flask.Blueprint("bp", __name__)
>     bp2 = flask.Blueprint("bp", __name__)
>
>     app.register_blueprint(bp)
>
>     with pytest.raises(ValueError):
>         app.register_blueprint(bp)  # same bp, same name, error
>
>     app.register_blueprint(bp, name="again")  # same bp, different name, ok
>
>     with pytest.raises(ValueError):
>         app.register_blueprint(bp2)  # different bp, same name, error
>
>     app.register_blueprint(bp2, name="alt")  # different bp, different name, ok
> ```

> **`tests/test_blueprints.py` lines 1017–1048 (whole test, verbatim)**
> ```python
> def test_blueprint_renaming(app, client) -> None:
>     bp = flask.Blueprint("bp", __name__)
>     bp2 = flask.Blueprint("bp2", __name__)
>
>     @bp.get("/")
>     def index():
>         return flask.request.endpoint
>
>     @bp.get("/error")
>     def error():
>         flask.abort(403)
>
>     @bp.errorhandler(403)
>     def forbidden(_: Exception):
>         return "Error", 403
>
>     @bp2.get("/")
>     def index2():
>         return flask.request.endpoint
>
>     bp.register_blueprint(bp2, url_prefix="/a", name="sub")
>     app.register_blueprint(bp, url_prefix="/a")
>     app.register_blueprint(bp, url_prefix="/b", name="alt")
>
>     assert client.get("/a/").data == b"bp.index"
>     assert client.get("/b/").data == b"alt.index"
>     assert client.get("/a/a/").data == b"bp.sub.index2"
>     assert client.get("/b/a/").data == b"alt.sub.index2"
>     assert client.get("/a/error").data == b"Error"
>     assert client.get("/b/error").data == b"Error"
> ```

Note the exact wording of the guard message: "It has already been registered **at least once**" — deliberately phrased "at least once", because a second registration is still permitted; it is only *setup* after that point that is not.

The multiple-registration contract is also documented:

> **`docs/blueprints.rst` lines 119–121 (verbatim)**
> ```
> On top of that you can register blueprints multiple times though not every
> blueprint might respond properly to that.  In fact it depends on how the
> blueprints is implemented if it can be mounted more than once.
> ```

### 4b. Per-registration behavior is tracked by a **different** mechanism

The flag is a one-way latch on the blueprint object. Whether *this particular* registration is the first one is tracked separately, by `BlueprintSetupState.first_registration` and two locals in `register`:

> **`src/flask/sansio/blueprints.py` lines 34–86 (whole class through `__init__`, verbatim)**
> ```python
> class BlueprintSetupState:
>     """Temporary holder object for registering a blueprint with the
>     application.  An instance of this class is created by the
>     :meth:`~flask.Blueprint.make_setup_state` method and later passed
>     to all register callback functions.
>     """
>
>     def __init__(
>         self,
>         blueprint: Blueprint,
>         app: App,
>         options: t.Any,
>         first_registration: bool,
>     ) -> None:
>         #: a reference to the current application
>         self.app = app
>
>         #: a reference to the blueprint that created this setup state.
>         self.blueprint = blueprint
>
>         #: a dictionary with all options that were passed to the
>         #: :meth:`~flask.Flask.register_blueprint` method.
>         self.options = options
>
>         #: as blueprints can be registered multiple times with the
>         #: application and not everything wants to be registered
>         #: multiple times on it, this attribute can be used to figure
>         #: out if the blueprint was registered in the past already.
>         self.first_registration = first_registration
>
>         subdomain = self.options.get("subdomain")
>         if subdomain is None:
>             subdomain = self.blueprint.subdomain
>
>         #: The subdomain that the blueprint should be active for, ``None``
>         #: otherwise.
>         self.subdomain = subdomain
>
>         url_prefix = self.options.get("url_prefix")
>         if url_prefix is None:
>             url_prefix = self.blueprint.url_prefix
>         #: The prefix that should be used for all URLs defined on the
>         #: blueprint.
>         self.url_prefix = url_prefix
>
>         self.name = self.options.get("name", blueprint.name)
>         self.name_prefix = self.options.get("name_prefix", "")
>
>         #: A dictionary with URL defaults that is added to each and every
>         #: URL that was defined with the blueprint.
>         self.url_defaults = dict(self.blueprint.url_values_defaults)
>         self.url_defaults.update(self.options.get("url_defaults", ()))
> ```

`record_once` is the consumer of that per-registration flag, and `record`/`record_once` are themselves gated by `_got_registered_once` via `@setupmethod`:

> **`src/flask/sansio/blueprints.py` lines 223–253 (whole methods, verbatim)**
> ```python
>     @setupmethod
>     def record(self, func: DeferredSetupFunction) -> None:
>         """Registers a function that is called when the blueprint is
>         registered on the application.  This function is called with the
>         state as argument as returned by the :meth:`make_setup_state`
>         method.
>         """
>         self.deferred_functions.append(func)
>
>     @setupmethod
>     def record_once(self, func: DeferredSetupFunction) -> None:
>         """Works like :meth:`record` but wraps the function in another
>         function that will ensure the function is only called once.  If the
>         blueprint is registered a second time on the application, the
>         function passed is not called.
>         """
>
>         def wrapper(state: BlueprintSetupState) -> None:
>             if state.first_registration:
>                 func(state)
>
>         self.record(update_wrapper(wrapper, func))
>
>     def make_setup_state(
>         self, app: App, options: dict[str, t.Any], first_registration: bool = False
>     ) -> BlueprintSetupState:
>         """Creates an instance of :meth:`~flask.blueprints.BlueprintSetupState`
>         object that is later passed to the register callback functions.
>         Subclasses can override this to return a subclass of the setup state.
>         """
>         return BlueprintSetupState(self, app, options, first_registration)
> ```

Executed demonstration that `record_once` fires once while `record` fires per registration:

> ```
> --- record_once across a second registration ---
> calls: [('once', True), ('always', True), ('always', False)]
> [PASS] record_once callback fired exactly once; record fired twice  calls=[('once', True), ('always', True), ('always', False)]
> [PASS] state.first_registration is True on the first registration  first_registration=True
> ```

And the counter reset for a same-name collision (proving the write is ordered *after* the `ValueError`):

> ```
> [PASS] duplicate name raises ValueError (before flag write)  type=ValueError
> [PASS] colliding bpB did NOT get its flag set (abort is ordered before the write)  bpB.__dict__.get('_got_registered_once')=None
> ```

### 4c. It is **not** the app-side `_got_first_request` flag

The app has an analogous but distinct guard — same `setupmethod`/`_check_setup_finished` protocol, same `AssertionError` type, different flag and different message:

> **`src/flask/sansio/app.py` lines 409–424 (verbatim)**
> ```python
>         # tracks internally if the application already handled at least one
>         # request.
>         self._got_first_request = False
>
>     def _check_setup_finished(self, f_name: str) -> None:
>         if self._got_first_request:
>             raise AssertionError(
>                 f"The setup method '{f_name}' can no longer be called"
>                 " on the application. It has already handled its first"
>                 " request, any changes will not be applied"
>                 " consistently.\n"
>                 "Make sure all imports, decorators, functions, etc."
>                 " needed to set up the application are done before"
>                 " running it."
>             )
> ```

> **`src/flask/sansio/app.py` lines 569–595 (whole method head, verbatim)**
> ```python
>     @setupmethod
>     def register_blueprint(self, blueprint: Blueprint, **options: t.Any) -> None:
>         """Register a :class:`~flask.Blueprint` on the application. Keyword
>         arguments passed to this method will override the defaults set on the
>         blueprint.
>
>         Calls the blueprint's :meth:`~flask.Blueprint.register` method after
>         recording the blueprint in the application's :attr:`blueprints`.
>         …
>         .. versionadded:: 0.7
>         """
>         blueprint.register(self, options)
> ```

> **`src/flask/sansio/app.py` lines 368–377 (verbatim)**
> ```python
>         #: Maps registered blueprint names to blueprint objects. The
>         #: dict retains the order the blueprints were registered in.
>         #: Blueprints can be registered multiple times, this dict does
>         #: not track how often they were attached.
>         #:
>         #: .. versionadded:: 0.7
>         self.blueprints: dict[str, Blueprint] = {}
> ```

Executed proof that the two messages are distinct:

> ```
> SUB-CLAIM 4: app-side analogue _got_first_request (different flag)
> [PASS] app serves before first request  body=b'Awesome'
> [PASS] app._got_first_request is True after a request  app._got_first_request=True
> [PASS] app.add_url_rule() after first request raises AssertionError (app-side analogue)  AssertionError: The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently.
> [PASS] app-side and blueprint-side messages are distinct  app msg="AssertionError: The setup method 'add_url_rule' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently."
> ```

The app-side flag's write sites are in `src/flask/app.py`:

> ```
> src/flask/app.py:667:             self._got_first_request = False     # reset in run(), "reset the first request information if the development server reset normally."
> src/flask/app.py:911:         self._got_first_request = True      # in full_dispatch_request()
> ```

**Do not conflate** — the answer to the question is `_got_registered_once` (blueprint-scoped, set by `Blueprint.register`), not `_got_first_request` (app-scoped, set by `full_dispatch_request`), not `BlueprintSetupState.first_registration` (per-registration, consumed by `record_once`), not the `first_bp_registration`/`first_name_registration` locals.

---

## 5. History and test coverage

**The guard was a warning in 2.2 and became an error in 2.3.** The 2.3.0 changelog entry:

> **`CHANGES.rst` lines 158–161 (verbatim)**
> ```
>         corresponding ``json.JSONEncoder`` and ``JSONDecoder`` classes, are removed.
>     -   The ``json.htmlsafe_dumps`` and ``htmlsafe_dump`` functions are removed.
>     -   Calling setup methods on blueprints after registration is an error instead of a
>         warning. :pr:`4997`
> ```

The 2.2.0 entry — the warning-era antecedent:

> **`CHANGES.rst` lines 297–300 (verbatim)**
> ```
> -   Use Blueprint decorators and functions intended for setup after
>     registering the blueprint will show a warning. In the next version,
>     this will become an error just like the application setup methods.
>     :issue:`4571`
> ```

This checkout is 3.2.0 (Unreleased), so the behavior here is the **error**, not the warning — a version-drift trap worth flagging:

> **`CHANGES.rst` lines 1–5 (verbatim)**
> ```
> Version 3.2.0
> ------------
>
> Unreleased
> ```
> ```
> $ ./.venv/Scripts/python.exe -c "import importlib.metadata as m;print('dist version:',m.version('flask'));import flask;print('flask.__file__:',flask.__file__)"
> dist version: 3.2.0.dev0
> flask.__file__: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
> ```

The `sansio/` relocation is explained by the 3.0.0 restructure entry:

> **`CHANGES.rst` lines 100–101 (verbatim)**
> ```
> -   Restructure the code such that the Flask (app) and Blueprint
>     classes have Sans-IO bases. :pr:`5127`
> ```

**Test gap (important for how confident a reader should be):** no test anywhere asserts the blueprint-side guard. The grep run:

> ```
> $ grep -rn "already been registered" tests/ ; echo "grep(already been registered) exit=$? (1=no match)"
> grep(already been registered) exit=1 (1=no match)
> $ grep -rn "_got_registered_once\|_check_setup_finished" tests/ ; echo "grep(flag/_check_setup_finished in tests) exit=$? (1=no match)"
> grep(flag/_check_setup_finished in tests) exit=1 (1=no match)
> $ grep -rn "setup method" tests/ ; echo "exit=$?"
> tests/test_basic.py:1690:    assert "setup method 'add_url_rule'" in str(exc_info.value)
> Binary file tests/__pycache__/test_basic.cpython-311-pytest-8.4.2.pyc matches
> Binary file tests/__pycache__/test_basic.cpython-312-pytest-8.4.0.pyc matches
> Binary file tests/__pycache__/test_basic.cpython-313-pytest-8.4.0.pyc matches
> exit=0
> ```

The only existing coverage is the **app-side analogue**:

> **`tests/test_basic.py` lines 1678–1690 (whole test, verbatim)**
> ```python
> def test_no_setup_after_first_request(app, client):
>     app.debug = True
>
>     @app.route("/")
>     def index():
>         return "Awesome"
>
>     assert client.get("/").data == b"Awesome"
>
>     with pytest.raises(AssertionError) as exc_info:
>         app.add_url_rule("/foo", endpoint="late")
>
>     assert "setup method 'add_url_rule'" in str(exc_info.value)
> ```

So any behavioral claim about the blueprint-side guard rests on the source trace plus the executed harness — hence the verification disclosure at the top of this answer.

---

## 6. Two sharp edges worth surfacing

**(i) The flag is set *before* the deferred callbacks run, so a blueprint's own `record` callback cannot mutate its own blueprint.** Because `self._got_registered_once = True` is line 320 while the replay loop `for deferred in self.deferred_functions: deferred(state)` is lines 334–335, the flag is already `True` while deferred callbacks execute. Executed:

> ```
> SUB-CLAIM 3: flag is already True DURING the deferred replay loop
> observed: {'flag_at_replay': True, 'first_registration': True, 'mutate_from_callback': "AssertionError: The setup method 'add_url_rule' can no longer be called on the blueprint 'd'. It has already been registered at least once, any changes will not be applied consistently."}
> [PASS] bp._got_registered_once is True inside the record() callback  flag_at_replay=True
> [PASS] calling bp.add_url_rule() from inside its own record() callback raises AssertionError  mutate_from_callback="AssertionError: The setup method 'add_url_rule' can no longer be called on the blueprint 'd'. It has already been registered at least once, any changes will not be applied consistently."
> ```

This is a deliberate-but-sharp constraint: the error message doesn't say "you are inside your own registration callback", yet such a call raises. It is not a bug report — just a boundary the guard actually enforces.

**(ii) The raised exception type is `AssertionError`, not `RuntimeError` or `ValueError`.** Confirmed by execution (`[PASS] exception type is exactly AssertionError`, `[PASS] exception is NOT a RuntimeError`, `[PASS] exception is NOT a ValueError`). This matters because `AssertionError` can be swallowed by `python -O`, and because callers who catch `ValueError` expecting a registration error (the duplicate-name case *is* a `ValueError`, from `register` lines 310–314) will not catch this one.

---

## How this was verified (and the one initial non-pass)

- **Environment:** the working tree's own venv — `flask.pth` pins `src`, and site-packages contains no `flask/` directory, so the source tree is the runtime:
  > ```
  > $ cat .venv/Lib/site-packages/flask.pth; echo "--- exit=$? ---" && ls .venv/Lib/site-packages/ && ls -d .venv/Lib/site-packages/flask 2>&1; echo "exit=$?"
  > D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src--- exit=0 ---
  > MarkupSafe-3.0.2.dist-info
  > …
  > flask-3.2.0.dev0.dist-info
  > flask.pth
  > …
  > ls: cannot access '.venv/Lib/site-packages/flask': No such file or directory
  > exit=2
  > ```
  > ```
  > $ grep -rn "_got_registered_once" .venv 2>/dev/null; echo "grep exit=$? (1 = no matches)"
  > grep exit=1 (1 = no matches)
  > ```
- **Runtime reproduction:** a scratch harness outside the repo (`C:\Users\oobbee\AppData\Local\Temp\bp_flag_check.py`), run with `./.venv/Scripts/python.exe` (Python 3.13.9), covering: class-attribute default/per-instance write; 29 setup methods raising the blueprint message; re-registration legality (`name="alt"`, second app, direct `Blueprint.register`); `@setupmethod` presence/absence via `__wrapped__`; flag live during deferred replay; `record_once` vs `record` across a second registration; app-side analogue distinctness. **Run B: `checks run: 56, passed: 56, failed: 0, RESULT: ALL CHECKS PASSED, EXIT=0`.**
- **The single Run A failure was a harness bug, not a product bug:** it asserted the message text against the first exception captured in a loop over 29 methods (`add_url_rule`) instead of `route`; the per-method `route` check had already passed. The harness was patched to re-capture from a fresh `bp.route()` call and re-run to 56/56.
- **Full suite:** `./.venv/Scripts/python.exe -m pytest` → **`489 passed in 3.50s`**, exit 0; a second verbose run (`-vv -rA --tb=long --durations=0`) → **`489 passed in 5.79s`**, exit 0, with zero `FAILED`/`ERROR` verdict lines (the 18 `^ERROR` lines in the verbose output are captured log records from tests that deliberately trigger logged exceptions).
- **Repo untouched:** final `git status --porcelain` shows only the pre-existing untracked `flask_mut2_i417ar2x/`.

**Non-goals (nothing was changed):** no edits to `src/flask/**`, no new test, no `CHANGES.rst` entry. This is a comprehension answer. One discovered distractor was deliberately *not* used as evidence — `flask_mut2_i417ar2x/mutated_test.py` is a QA/mutation harness about `subdomain` + `url_for` and `SERVER_NAME`, unrelated to blueprint registration:

> **`flask_mut2_i417ar2x/mutated_test.py` (whole file, 20 lines, verbatim)**
> ```python
> import flask
>
> app = flask.Flask(__name__, subdomain_matching=False)
> app.config["SERVER_NAME"] = "example.com"
> client = app.test_client()
>
> @app.route("/", subdomain="<company_id>")
> def view(company_id):
>     return company_id
>
> with app.test_request_context():
>     url = flask.url_for("view", company_id="xxx")
> print("url_for ->", url)
>
> with client:
>     response = client.get(url)
>
> print("status_code:", response.status_code)
> print("data:", response.data)
> assert 200 == response.status_code, f"status {response.status_code}"
> assert b"xxx" == response.data, f"data {response.data!r}"
> print("ASSERTS PASSED (unexpected)")
> ```
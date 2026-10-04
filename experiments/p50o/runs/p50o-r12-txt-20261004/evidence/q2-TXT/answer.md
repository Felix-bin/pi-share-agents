# Answer

**The flag is `_got_registered_once`, a class attribute of `Blueprint` declared at `src/flask/sansio/blueprints.py:172`, read at line 214, and set to `True` at line 320.** Its purpose is to record that this particular blueprint instance has already been mounted on at least one application, so that the `@setupmethod` guard (`Blueprint._check_setup_finished`) can refuse any further *setup* mutation — because changes made to a blueprint's deferred setup data after registration can no longer be applied consistently to an application that has already consumed it. It is a **consistency trip-wire**, not an immutability or thread-safety guarantee, and it is **per-instance** (class-level default, instance-level assignment), so it never leaks across blueprint objects.

Everything below is reproduced verbatim from the working tree `D:/操作系统开源大赛/pi-share-agents-openeuler-wsl/experiments/data/flask-src` and from the executed command transcripts, so no upstream stage needs to be consulted.

---

## 1. Identification: the class and the flag

The "blueprint collection class" is `Blueprint`, whose docstring opens: *"Represents a blueprint, a collection of routes and other app-related functions that can be registered on a real application later."* It is defined at `src/flask/sansio/blueprints.py:119`.

Whole-tree grep for the flag (`grep -rn "_got_registered_once" .`):

```
./src/flask/sansio/blueprints.py:172:    _got_registered_once = False
./src/flask/sansio/blueprints.py:214:        if self._got_registered_once:
./src/flask/sansio/blueprints.py:320:        self._got_registered_once = True
Binary file ./src/flask/sansio/__pycache__/blueprints.cpython-311.pyc matches
Binary file ./src/flask/sansio/__pycache__/blueprints.cpython-312.pyc matches
Binary file ./src/flask/sansio/__pycache__/blueprints.cpython-313.opt-1.pyc matches
Binary file ./src/flask/sansio/__pycache__/blueprints.cpython-313.pyc matches
Binary file ./src/flask/sansio/__pycache__/blueprints.cpython-314.pyc matches
EXIT=0
```

**Exactly three source occurrences: declaration 172, sole reader 214, sole writer 320.** (The bundled "exactly three hits" phrasing was incomplete as a raw grep result — libgit-compiled `__pycache__` binaries also match — but the three source hits are correct. Note that `.pyc` files for CPython 3.11/3.12/3.13/3.14 show this tree has been run under several interpreters.)

Companion grep for the consumer (`_check_setup_finished`, whole tree):

```
src/flask/sansio/scaffold.py:46:         self._check_setup_finished(f_name)
src/flask/sansio/scaffold.py:220:     def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/blueprints.py:213:     def _check_setup_finished(self, f_name: str) -> None:
src/flask/sansio/app.py:413:     def _check_setup_finished(self, f_name: str) -> None:
```

**Worktree version identity** (`pyproject.toml` lines 1–6, plus key index lines):

```toml
[project]
name = "Flask"
version = "3.2.0.dev"
description = "A simple framework for building complex web applications."
readme = "README.md"
license = "BSD-3-Clause"
```

```
2:name = "Flask"
3:version = "3.2.0.dev"
22:requires-python = ">=3.10"
90:name = "flask"
```

**The defining class, verbatim** (`src/flask/sansio/blueprints.py` lines 119–174; note the flag sits at class scope, immediately before `def __init__`):

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

    :param name: The name of the blueprint. Will be prepended to each
        endpoint name.
    :param import_name: The name of the blueprint package, usually
        ``__name__``. This helps locate the ``root_path`` for the
        blueprint.
    :param static_folder: A folder with static files that should be
        served by the blueprint's static route. The path is relative to
        the blueprint's root path. Blueprint static files are disabled
        by default.
    :param static_url_path: The url to serve static files from.
        Defaults to ``static_folder``. If the blueprint does not have
        a ``url_prefix``, the app's static route will take precedence,
        and the blueprint's static files won't be accessible.
    :param template_folder: A folder with templates that should be added
        to the app's template search path. The path is relative to the
        blueprint's root path. Blueprint templates are disabled by
        default. Blueprint templates have a lower precedence than those
        in the app's templates folder.
    :param url_prefix: A path to prepend to all of the blueprint's URLs,
        to make them distinct from the rest of the app's routes.
    :param subdomain: A subdomain that blueprint routes will match on by
        default.
    :param url_defaults: A dict of default values that blueprint routes
        will receive by default.
    :param root_path: By default, the blueprint will automatically set
        this based on ``import_name``. In certain situations this
        automatic detection can fail, so the path can be specified
        manually instead.

    .. versionchanged:: 1.1.0
        Blueprints have a ``cli`` group to register nested CLI commands.
        The ``cli_group`` parameter controls the name of the group under
        the ``flask`` command.

    .. versionadded:: 0.7
    """

    _got_registered_once = False

    def __init__(
```

**`__init__` body confirms the flag is *not* an instance attribute** (`src/flask/sansio/blueprints.py` lines 205–211):

```python
        if url_defaults is None:
            url_defaults = {}

        self.url_values_defaults = url_defaults
        self.cli_group = cli_group
        self._blueprints: list[tuple[Blueprint, dict[str, t.Any]]] = []
```

There is no `self._got_registered_once = ...` anywhere in `__init__` — the class-level `False` stands until `register()` assigns on the instance.

**Critical locating caution:** the module users import as `flask.Blueprint` is `src/flask/blueprints.py`, and it only subclasses the sans-IO class (`src/flask/blueprints.py` lines 1–19):

```python
from __future__ import annotations

import os
import typing as t
from datetime import timedelta

from .cli import AppGroup
from .globals import current_app
from .helpers import send_from_directory
from .sansio.blueprints import Blueprint as SansioBlueprint
from .sansio.blueprints import BlueprintSetupState as BlueprintSetupState  # noqa
from .sansio.scaffold import _sentinel

if t.TYPE_CHECKING:  # pragma: no cover
    from .wrappers import Response


class Blueprint(SansioBlueprint):
    def __init__(
```

A grep scoped to that file for `_got_registered_once|_check_setup_finished|setupmethod` returns **nothing** (exit 1); its only definitions are `__init__` (19), `get_send_file_max_age` (55), `send_static_file` (82), `open_resource` (104). The flag is **inherited**. A runtime MRO check confirms:

```
MRO: ['Blueprint', 'Blueprint', 'Scaffold', 'object']
flag owner: ['Blueprint']
defined in: flask.sansio.blueprints
public class module: flask.blueprints
register wrapped by setupmethod? NO __wrapped__ => not guarded
route wrapped? True
```

---

## 2. The purpose, as stated by the code that reads the flag

`Blueprint._check_setup_finished` is the flag's **only** reader, and it states the purpose in the message it raises (`src/flask/sansio/blueprints.py` lines 213–221):

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

So the flag answers one question — *"has this blueprint been registered at least once?"* — and the guard turns that answer into a hard `AssertionError` for every subsequent setup call. The stated reason is that late changes **"will not be applied consistently."**

---

## 3. Mechanism: how setup methods are wired to the flag

`setupmethod` (`src/flask/sansio/scaffold.py` lines 42–49) wraps every setup method so that the check runs first:

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`Scaffold` is the shared base for both `Flask` and `Blueprint` (`scaffold.py` lines 51–54) and provides the abstract hook (`scaffold.py` lines 220–221):

```python
class Scaffold:
    """Common behavior shared between :class:`~flask.Flask` and
    :class:`~flask.blueprints.Blueprint`.

    :param import_name: The import name of the module where this object
        is defined. Usually :attr:`__name__` should be used.
        ...
    .. versionadded:: 2.0
    """
```

```python
    def _check_setup_finished(self, f_name: str) -> None:
        raise NotImplementedError
```

**The app-side twin uses the identical pattern, keyed on `_got_first_request`** (`src/flask/sansio/app.py` lines 409–423):

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

**Interpretation:** the two objects share one guard, but their trip-wires differ — the app's setup window closes at **first request** (`self._got_first_request` assigned in `__init__` at line 411; reset to `False` after the dev server exits, `src/flask/app.py:663–667`, and set `True` in `Flask.wsgi_app`-adjacent startup, `src/flask/app.py:906–911`), while the blueprint's closes at **registration** (class attribute at line 172, assigned on the instance at line 320).

---

## 4. Why "will not be applied consistently" is literally true

Setup methods funnel into a single list. `record` / `record_once` / `make_setup_state` (`src/flask/sansio/blueprints.py` lines 223–253):

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

`register()` flips the flag and then replays that list exactly once (`src/flask/sansio/blueprints.py` lines 297–335; flag writer at 320 immediately before the replay at 334–335):

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

Structural facts confirmed by grep:

- `def register` (line 273) carries **no** `@setupmethod`. The `-B2` context shows the preceding decorated method ends at 271 and `register` begins clean at 273.
- The duplicate-name `ValueError` (303–313) is raised **before** the flag flips at 320.
- The flag writer (320) sits directly before `state = self.make_setup_state(...)` (321) and the replay loop (334–335):

```
318:
319:        app.blueprints[name] = self
320:        self._got_registered_once = True
321:        state = self.make_setup_state(app, options, first_bp_registration)
322:
333:
334:        for deferred in self.deferred_functions:
335:            deferred(state)
```

**Therefore:** anything appended to `deferred_functions` *after* line 320 is never replayed into any app that already registered the blueprint. Two sub-cases follow:

1. **Same-name re-registration raises `ValueError`** ("The name 'bp' is already registered for this blueprint. Use 'name=' to provide a unique name."), so the late additions cannot ride along.
2. **Different-name re-registration is legal** (the flag does not guard `register`), but it replays only the functions recorded so far — a late addition would silently produce a divergent rule set between apps. And `record_once`-wrapped callbacks are additionally gated on `state.first_registration` (lines 240–242), documented at `src/flask/sansio/blueprints.py` lines 54–57:

```python
        #: as blueprints can be registered multiple times with the
        #: application and not everything wants to be registered
        #: multiple times on it, this attribute can be used to figure
        #: out if the blueprint was registered in the past already.
        self.first_registration = first_registration
```

so a `record_once` callback added late would never run at all on a subsequent registration.

The deferred-recording model is also stated in the user docs (`docs/blueprints.rst` lines 76–84):

```
When you bind a function with the help of the ``@simple_page.route``
decorator, the blueprint will record the intention of registering the
function ``show`` on the application when it's later registered.
Additionally it will prefix the endpoint of the function with the
name of the blueprint which was given to the :class:`Blueprint`
constructor (in this case also ``simple_page``). The blueprint's name
does not modify the URL, only the endpoint.
```

---

## 5. Scope of the guard (what is and is not blocked)

`grep -n "^    @setupmethod" -A1 src/flask/sansio/scaffold.py` and the equivalent line index for `sansio/blueprints.py` give the exact decorated set.

**Decorated in `src/flask/sansio/blueprints.py`** (decorator line / def line): `record` (223/224), `record_once` (232/233), `register_blueprint` (255/256), `add_url_rule` (412/413), `app_template_filter` (443/444), `add_app_template_filter` (460/461), `app_template_test` (477/478), `add_app_template_test` (496/497), `app_template_global` (515/516), `add_app_template_global` (534/535), `before_app_request` (553/554), `after_app_request` (563/564), `teardown_app_request` (573/574), `app_context_processor` (583/584), `app_errorhandler` (595/596), `app_url_value_preprocessor` (612/613), `app_url_defaults` (624/625).

**Inherited from `Scaffold`** (`src/flask/sansio/scaffold.py`): `get` 295, `post` 303, `put` 311, `delete` 319, `patch` 327, `route` 335, `add_url_rule` 367, `endpoint` 435, `before_request` 459, `after_request` 486, `teardown_request` 507, `context_processor` 541, `url_value_preprocessor` 558, `url_defaults` 583, `errorhandler` 597, `register_error_handler` 641.

**Deliberately NOT decorated** in `sansio/blueprints.py`: `__init__` (174), `_check_setup_finished` (213), `make_setup_state` (246), **`register` (273)**, `_merge_blueprint_funcs` (379). The unguarded `register` is precisely what keeps multi-app / multi-name re-registration legal.

Nested registration is itself still guarded as a setup action (`register_blueprint`, lines 255–272):

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

The app side calls `blueprint.register(self, options)` from its own guarded `register_blueprint` (`src/flask/sansio/app.py` lines 569–591):

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

**Runtime confirmation that `register` is outside the guard:**

```
after 1st registration, flag = True
same name re-registration -> ValueError: The name 'bp' is already registered for this blueprint. Use 'name=' to provide a unique name.
different name re-registration -> LEGAL, flag = True
app.blueprints keys: ['again', 'bp']
```

and the wrapper-dunder probe: `register wrapped by setupmethod? NO __wrapped__ => not guarded` / `route wrapped? True`. The corresponding committed test is `tests/test_blueprints.py` lines 994–1008:

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

The same blueprint `bp` is registered twice (lines 998 and 1003) — legal when the name differs.

---

## 6. Runtime behaviour of the flag (executed, via the repo `.venv`)

Environment discovery: the system Python is 3.14 and has **no importable `flask`**, so the suite must go through the uv-managed venv:

```
$ python -V
Python 3.14.0
$ python -c "import flask, sys; print(flask.__file__)"
ModuleNotFoundError: No module named 'flask'
EXIT=1

$ cat .venv/pyvenv.cfg
home = C:\Users\oobbee\AppData\Roaming\uv\python\cpython-3.13.9-windows-x86_64-none
implementation = CPython
uv = 0.9.5
version_info = 3.13.9
include-system-site-packages = false
prompt = flask
```

(The venv site-packages contains `flask-3.2.0.dev0.dist-info`, `flask.pth`, `pytest-8.4.0.dist-info`, `werkzeug-3.1.3.dist-info`, `jinja2-3.1.6.dist-info`.)

**Probe 1 — class-attribute default:**

```
$ .venv/Scripts/python.exe -c "import flask; print('file:', flask.__file__); from flask.sansio.blueprints import Blueprint as B; print('flag default:', B._got_registered_once); print('in __dict__ of class:', '_got_registered_once' in B.__dict__)"
flask: no __version__
file: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\src\flask\__init__.py
flag default: False
in __dict__ of class: True
EXIT=0
```

**Probe 2 — read is class-level before registration, instance-level after; the guard fires:**

```
$ .venv/Scripts/python.exe -c "
import flask
bp = flask.Blueprint('bp', __name__)
app = flask.Flask(__name__)
print('instance dict BEFORE register:', bp.__dict__.get('_got_registered_once', '<absent>'))
print('class attr BEFORE register:', bp._got_registered_once)
app.register_blueprint(bp)
print('instance dict AFTER register:', bp.__dict__.get('_got_registered_once', '<absent>'))
print('value AFTER register:', bp._got_registered_once)
try:
    @bp.route('/late')
    def late(): return 'x'
except AssertionError as e:
    print('AssertionError raised:'); print(e)
print('--- deferred_functions len:', len(bp.deferred_functions))
"
instance dict BEFORE register: <absent>
class attr BEFORE register: False
instance dict AFTER register: True
value AFTER register: True
AssertionError raised:
The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.
Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.
--- deferred_functions len: 0
EXIT=0
```

**Probe 3 — no cross-instance leakage:**

```
$ .venv/Scripts/python.exe -c "
import flask
bp1 = flask.Blueprint('bp1', __name__)
bp2 = flask.Blueprint('bp2', __name__)
app = flask.Flask(__name__)
app.register_blueprint(bp1)
print('bp1:', bp1._got_registered_once, '| bp2 (untouched):', bp2._got_registered_once)
print('bp2 can still set up:')
@bp2.route('/ok')
def ok(): return 'ok'
print('  bp2 routes:', list(bp2.deferred_functions), '-> OK, no leak')
"
bp1: True | bp2 (untouched): False
bp2 can still set up:
  bp2 routes: [<function Blueprint.add_url_rule.<locals>.<lambda> at 0x0000027168502200>] -> OK, no leak
EXIT=0
```

**Probe 4 — `record_once` fires only when `first_registration` is true:**

```
$ .venv/Scripts/python.exe -c "
import flask
calls = []
def cb(state):
    calls.append(('cb', state.name, state.first_registration))
bp = flask.Blueprint('bp', __name__)
bp.record_once(cb)
app = flask.Flask(__name__)
app.register_blueprint(bp)
app.register_blueprint(bp, name='second')
print('record_once callback invocations:', calls)
print('=> called only when first_registration=True (once)')
"
record_once callback invocations: [('cb', 'bp', True)]
=> called only when first_registration=True (once)
EXIT=0
```

---

## 7. History and rationale (git-verified, not only CHANGES prose)

`git blame` shows the flag itself is unchanged since 2011 — **both** the declaration (172) and the writer (320) date to commit `bfd67764f`, Armin Ronacher, 2011-06-07:

```
$ git log --oneline -3
85c5d93c Merge branch 'stable'
85cc7104 svg logo
284273e3 Merge branch 'stable'
$ git blame -L 168,175 -- src/flask/sansio/blueprints.py
3dfc12e8d src/flask/blueprints.py (David Lord     2021-03-10 10:51:06 -0800 168) 
3dfc12e8d src/flask/blueprints.py (David Lord     2021-03-10 10:51:06 -0800 169)     .. versionadded:: 0.7
7a08331ac flask/blueprints.py     (Armin Ronacher 2011-05-29 15:54:58 +0200 170)     """
7a08331ac flask/blueprints.py     (Armin Ronacher 2011-05-29 15:54:58 +0200 171) 
bfd67764f flask/blueprints.py     (Armin Ronacher 2011-06-07 15:32:44 +0200 172)     _got_registered_once = False
bfd67764f flask/blueprints.py     (Armin Ronacher 2011-06-07 15:32:44 +0200 173) 
025589ee7 flask/blueprints.py     (David Baumgold 2019-05-06 15:39:41 -0400 174)     def __init__(
025589ee7 flask/blueprints.py     (David Baumgold 2019-05-06 15:39:41 -0400 175)         self,
$ git blame -L 318,322 -- src/flask/sansio/blueprints.py
a44c72286 src/flask/blueprints.py (pgjones        2021-06-05 16:08:51 +0100 318) 
141fde1d8 src/flask/blueprints.py (pgjones        2021-05-18 13:33:45 +0100 319)         app.blueprints[name] = self
bfd67764f flask/blueprints.py     (Armin Ronacher 2011-06-07 15:32:44 +0200 320)         self._got_registered_once = True
a44c72286 src/flask/blueprints.py (pgjones        2021-06-05 16:08:51 +0100 321)         state = self.make_setup_state(app, options, first_bp_registration)
0f7b3a4f2 flask/blueprints.py     (David Lord     2017-06-14 07:16:55 -0700 322) 
```

The **enforcement** was tightened twice, and the local git history proves each step.

**Flask 2.2.0 — warning only.**

```
$ git log --oneline --all -S "already been registered at least once" | head
fc03d0df setup method on registered blueprint is error
EXIT=0

$ git log --oneline --all --grep="4571" | head
a52a7db6 Merge pull request #4577 from hallacy/hallacy/fix_4571

$ git log --oneline a52a7db6^1..a52a7db6^2
e044b000 avoid triggering setupmethod late in tests
a406c297 apply setupmethod consistently
eb36135c always warn on blueprint setupmethod after registration

$ git show -s --format="%H%n%an%n%ad%n%n%B" eb36135c
eb36135cfe6a17350617e47b70b9ad383206eded
Chris Hallacy
Mon May 2 11:33:29 2022 -0600

always warn on blueprint setupmethod after registration
```

```
$ git show eb36135c -- src/flask/blueprints.py
...
-    warn_on_modifications = False
     _got_registered_once = False
...
     def _is_setup_finished(self) -> bool:
-        return self.warn_on_modifications and self._got_registered_once
+        return self._got_registered_once
...
-        if self._got_registered_once and self.warn_on_modifications:
+        if self._got_registered_once:
+            # TODO: Upgrade this to an error and unify it setupmethod in 2.3
             from warnings import warn
 
             warn(
                 Warning(
                     "The blueprint was already registered once but is"
                     " getting modified now. These changes will not show"
-                    " up."
+                    " up.\n This warning will be become an exception in 2.3."
                 )
             )
```

`git tag --contains eb36135c` → `2.2.0`, `2.2.1`, `2.2.2`, `2.2.3`, `2.2.4`. CHANGES.rst lines 297–300 (under the `Version 2.2.0` header at line 237, "Released 2022-08-01"):

```
-   Use Blueprint decorators and functions intended for setup after
    registering the blueprint will show a warning. In the next version,
    this will become an error just like the application setup methods.
    :issue:`4571`
```

**Flask 2.3.0 — promoted to an error.** The diff literally replaces the warning with the `AssertionError`:

```
$ git show -s --format="%H%n%an%n%ad%n%n%B" fc03d0df
fc03d0dfab64945169e1114cdc1fb39519a1e0c1
David Lord
Thu Feb 23 09:29:36 2023 -0800

setup method on registered blueprint is error

$ git show fc03d0df --stat
commit fc03d0dfab64945169e1114cdc1fb39519a1e0c1
Author: David Lord <davidism@gmail.com>
Date:   Thu Feb 23 09:29:36 2023 -0800

    setup method on registered blueprint is error

 CHANGES.rst             |  2 ++
 src/flask/blueprints.py | 19 ++++++-------------
 2 files changed, 8 insertions(+), 13 deletions(-)

$ git show fc03d0df -- src/flask/blueprints.py
...
     def _check_setup_finished(self, f_name: str) -> None:
         if self._got_registered_once:
-            import warnings
-
-            warnings.warn(
-                f"The setup method '{f_name}' can no longer be called on"
-                f" the blueprint '{self.name}'. It has already been"
-                " registered at least once, any changes will not be"
-                " applied consistently.\n"
-                "Make sure all imports, decorators, functions, etc."
-                " needed to set up the blueprint are done before"
-                " registering it.\n"
-                "This warning will become an exception in Flask 2.3.",
-                UserWarning,
-                stacklevel=3,
+            raise AssertionError(
+                f"The setup method '{f_name}' can no longer be called on the blueprint"
+                f" '{self.name}'. It has already been registered at least once, any"
+                " changes will not be applied consistently.\n"
+                "Make sure all imports, decorators, functions, etc. needed to set up"
+                " the blueprint are done before registering it."
             )
```

`git tag --contains fc03d0df` → `2.3.0`, `2.3.1`, `2.3.2`, `2.3.3`, `2.3.x`, `3.0.0`, `3.0.1`, `3.0.2`, `3.0.3`, `3.1.0` — first shipped in **2.3.0**. CHANGES.rst lines 160–161 (under the `Version 2.3.0` header at line 135, "Released 2023-04-25"):

```
    -   Calling setup methods on blueprints after registration is an error instead of a
        warning. :pr:`4997`
```

(The commit is inside PR #4997, merge `c690f529`; that PR's second commit is `2a33c178 deprecate got_first_request property`.)

The **rationale** is not blueprint-specific in the docs — `docs/lifecycle.rst` lines 36–50 give the "consistency" argument and explicitly concede the limit:

```
All application setup must be completed before you start serving your application and
handling requests. This is because WSGI servers divide work between multiple workers, or
can be distributed across multiple machines. If the configuration changed in one worker,
there's no way for Flask to ensure consistency between other workers.

Flask tries to help developers catch some of these setup ordering issues by showing an
error if setup-related methods are called after requests are handled. In that case
you'll see this error:

    The setup method 'route' can no longer be called on the application. It has already
    handled its first request, any changes will not be applied consistently.
    Make sure all imports, decorators, functions, etc. needed to set up the application
    are done before running it.

However, it is not possible for Flask to detect all cases of out-of-order setup. In
general, don't do anything to modify the ``Flask`` app object and ``Blueprint`` objects
from within view functions that run during requests. This includes:
```

CHANGES.rst line 1–8 confirms the checkout is the unreleased 3.2.0:

```
Version 3.2.0
-------------

Unreleased

-   Drop support for Python 3.9. :pr:`5730`
-   Remove previously deprecated code: ``__version__``. :pr:`5648`
```

---

## 8. Test status (runtime-verified; two full-suite runs)

**Targeted app-side analog:**

```
$ .venv/Scripts/python.exe -m pytest tests/test_basic.py::test_no_setup_after_first_request -q
.                                                                        [100%]
1 passed in 0.05s
EXIT=0
```

`tests/test_basic.py` lines 1678–1690:

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

**Full suite run #1 (normal):**

```
$ .venv/Scripts/python.exe -m pytest
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

============================= 489 passed in 2.27s =============================
EXIT=0
```

**Full suite run #2 (maximal verbosity `-vv -rA -l --tb=long`):** 489 passed in 2.32s, exit 0. The complete 1454-line transcript was archived at `C:\Users\oobbee\AppData\Local\Temp\pi-bash-6420b3f25b3ee345.log` (105,031 bytes). Its header verbatim:

```
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src
configfile: pyproject.toml
testpaths: tests
collecting ... collected 489 items
```

Its footer verbatim (after the 489-line `PASSED` listing):

```
=========================== short test summary info ===========================
PASSED tests/test_appctx.py::test_basic_url_generation
...
PASSED tests/test_basic.py::test_no_setup_after_first_request
...
PASSED tests/test_blueprints.py::test_unique_blueprint_names
PASSED tests/test_blueprints.py::test_self_registration
PASSED tests/test_blueprints.py::test_blueprint_renaming
...
PASSED tests/test_views.py::test_init_once
============================= 489 passed in 2.32s =============================
```

**Both runs: 489 passed, 0 failed, 0 skipped, 0 xfailed — identical counts.**

**Coverage gap (still open):** there is **no committed test** for the blueprint branch of `_check_setup_finished`. Grepping `tests/` finds only the app-level analog:

```
$ grep -rn "_got_registered_once\|registered at least once\|no_setup_after\|setup_after\|after_registration" tests/
tests/test_basic.py:1678:def test_no_setup_after_first_request(app, client):
Binary file tests/__pycache__/test_basic.cpython-311-pytest-8.4.2.pyc matches
Binary file tests/__pycache__/test_basic.cpython-312-pytest-8.4.0.pyc matches
Binary file tests/__pycache__/test_basic.cpython-313-pytest-8.4.0.pyc matches
EXIT=0

$ grep -rn "can no longer be called on the blueprint" tests/
EXIT=1 (1 = no match)

$ grep -rn "setupmethod" tests/ --include=*.py
EXIT=1
```

The flag also appears **nowhere** in `docs/`, `CHANGES.rst`, or `README.md`. The ad-hoc probes in §6 are therefore the only executed demonstration of the blueprint path.

---

## 9. Caveats (all source-backed)

1. **Per-instance, not global.** Class-level default (`_got_registered_once = False`, line 172); `register()` assigns on the *instance* (line 320), shadowing the class attribute. Runtime: before registration `bp.__dict__` has no such key and the class value `False` is read; after registration `bp.__dict__['_got_registered_once'] is True`; a second, untouched blueprint still reads `False` and sets up normally. No leakage. Contrast the app twin, which assigns `self._got_first_request` in `__init__` (`sansio/app.py:411`).
2. **A consistency trip-wire, not a sandbox or immutability guarantee.** `docs/lifecycle.rst:50`: *"it is not possible for Flask to detect all cases of out-of-order setup."* Phrasing it as "rejects changes that would not be applied consistently" is correct; "makes blueprints immutable" over-claims, and it is unrelated to thread-safety.
3. **Version attribution.** This checkout is unreleased **3.2.0.dev** (`pyproject.toml:3`). The 2.2.0 / 2.3.0 CHANGES entries describe *when the behavior changed*, not the checked-out code, which carries no inline version marker for the flag. (Probe output also shows `flask: no __version__`, consistent with the 3.2.0 changelog entry "Remove previously deprecated code: `__version__`".)
4. **Statement of the tooling situation.** The inherited plan and evidence bundle asserted that "no shell/exec tool is available to this role set, so `pytest` and `git blame` cannot be run." That constraint was **false** for the executor role: a shell tool was available, and the suite, `git blame`/`git log -S`/`git tag --contains`, and live runtime probes were all executed as shown above. The static-only constraint must be struck; the test and provenance statements in §6–§8 are runtime-verified.
5. **Residual limits, stated honestly:** (a) the two full-suite transcripts are represented in §8 by header/footer plus an archived path rather than 1454 inline lines, because the raw output exceeds the report budget; (b) the upstream PR *discussion* threads for #4997/#4577 were not read — only the local commits, their diffs, tags, and CHANGES entries; (c) the "no blueprint-level test" conclusion is a grep result over `tests/`, exact for this tree but silent about upstream branches.

**Contamination check.** `flask_mut2_i417ar2x/mutated_test.py` is an unrelated `url_for`/subdomain harness (`subdomain_matching=False`, `SERVER_NAME`, expects `200` / `b"xxx"`) — full content:

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

It contains no blueprint or flag reference and is outside `testpaths`; do not cite it.

---

## 10. Bottom line

`_got_registered_once` is a 14-year-old one-bit latch on `Blueprint` (`src/flask/sansio/blueprints.py:172`, `bfd67764f`, 2011-06-07) that flips at `src/flask/sansio/blueprints.py:320`, immediately before `register()` replays `deferred_functions` into the app. Its sole reader, `Blueprint._check_setup_finished` (line 214/213–221), converts the latch into an `AssertionError` for every `@setupmethod`-decorated setup call — because any setup mutation after that point would be appended to a list that the already-registered app will never replay, hence *"changes will not be applied consistently."* It guards the setup surface (`record`, `record_once`, all decorators, nested `register_blueprint`) but deliberately not `register()` or `make_setup_state()`, so legal multi-name/multi-app re-registration still works; it is per-instance and is a best-effort consistency check rather than an immutability guarantee. The behaviour began as a `UserWarning` in Flask 2.2.0 (`eb36135c`) and was promoted to an error in Flask 2.3.0 (`fc03d0df`, PR #4997), mirroring the app-side `_got_first_request` rule.
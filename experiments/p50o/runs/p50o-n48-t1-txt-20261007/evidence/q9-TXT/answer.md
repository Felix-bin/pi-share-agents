# Final answer

**Question.** What is the dependency chain between the application loading helper, the Flask application instance, and the base Click testing runner that ensures proper CLI command execution in isolation?

**Entity mapping (Flask repo, `pyproject.toml` → `name = "Flask"`, `version = "3.2.0.dev"`):** "application loading helper" = `ScriptInfo` (docstring: *"Helper object to deal with Flask applications"*), plus its import helpers `locate_app`/`find_best_app`/`find_app_by_string` (`src/flask/cli.py:293`, `:241`, `:41`, `:120`); "Flask application instance" = the `Flask` instance with `self.cli = cli.AppGroup()` and `Flask.test_cli_runner()` (`src/flask/app.py:256`, `:727`; `src/flask/sansio/app.py:271-277`); "base Click testing runner" = `click.testing.CliRunner`, subclassed by `FlaskCliRunner` (`src/flask/testing.py:265`; `.venv/Lib/site-packages/click/testing.py:225`, `:423`).

## Short answer

The chain is a single inheritance-and-wiring path whose load-bearing link is the `ScriptInfo` instance that `FlaskCliRunner.invoke` constructs **bound to the specific Flask instance**:

```
click.testing.CliRunner                    # BASE Click testing runner: owns invoke()'s isolated
        ▲ subclass                          # environment, stdout/stderr capture, Result object
FlaskCliRunner(app)               src/flask/testing.py:265
        │  __init__: self.app = app
        │  invoke(): if cli is None: cli = self.app.cli
        │            if "obj" not in kwargs:
        │                kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)   # helper bound to THIS app
        ▼  return super().invoke(cli, args, **kwargs)  # ⇒ click.testing.CliRunner.invoke → isolation
ScriptInfo ("application loading helper")   src/flask/cli.py:293
        │  load_app()                        src/flask/cli.py:333
        ├─ self.create_app()  ──► the same Flask instance        (test path: the lambda above)
        └─ locate_app(import_name, name)     src/flask/cli.py:241
                ──► find_best_app / find_app_by_string           (CLI/import path)
                ──► validates isinstance(app, Flask), returns a Flask instance
        ▼
app.app_context() pushed via with_appcontext (src/flask/cli.py:380) / FlaskGroup.get_command (src/flask/cli.py:609)
        ▼
command callback runs with current_app bound to that same Flask instance, inside the runner's isolation
```

In prose: the **Flask application instance** owns a Click group (`self.cli = cli.AppGroup()`) and exposes `test_cli_runner()`, which instantiates the **base Click testing runner**'s Flask subclass `FlaskCliRunner(self)`. `FlaskCliRunner.__init__` stores `self.app = app`; `FlaskCliRunner.invoke` then defaults `cli = self.app.cli` and, crucially, defaults the Click context object to the **application loading helper**, `ScriptInfo(create_app=lambda: self.app)` — bound to that one app — before delegating to `super().invoke(...)`, i.e. to `click.testing.CliRunner.invoke`, which supplies the isolation (filesystem/streams/env isolation and a `Result`). When the command runs, `ScriptInfo.load_app()` resolves the app either from the bound `create_app` lambda (returning the identical `Flask` instance) or from `locate_app` → `find_best_app`/`find_app_by_string` (both validate `isinstance(app, Flask)`), and finally `with_appcontext` / `FlaskGroup.get_command` push `app.app_context()` so `current_app` is that same instance. Isolation comes from the **base** class; *which* app is loaded and gets its context pushed comes from the **subclass + helper** pair.

## The decisive citation — `FlaskCliRunner.invoke` (`src/flask/testing.py:265-298`, re-verified verbatim in this working tree)

```python
class FlaskCliRunner(CliRunner):
    """A :class:`~click.testing.CliRunner` for testing a Flask app's
    CLI commands. Typically created using
    :meth:`~flask.Flask.test_cli_runner`. See :ref:`testing-cli`.
    """

    def __init__(self, app: Flask, **kwargs: t.Any) -> None:
        self.app = app
        super().__init__(**kwargs)

    def invoke(  # type: ignore
        self, cli: t.Any = None, args: t.Any = None, **kwargs: t.Any
    ) -> Result:
        """Invokes a CLI command in an isolated environment. See
        :meth:`CliRunner.invoke <click.testing.CliRunner.invoke>` for
        full method documentation. See :ref:`testing-cli` for examples.

        If the ``obj`` argument is not given, passes an instance of
        :class:`~flask.cli.ScriptInfo` that knows how to load the Flask
        app being tested.

        :param cli: Command object to invoke. Default is the app's
            :attr:`~flask.app.Flask.cli` group.
        :param args: List of strings to invoke the command with.

        :return: a :class:`~click.testing.Result` object.
        """
        if cli is None:
            cli = self.app.cli

        if "obj" not in kwargs:
            kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)

        return super().invoke(cli, args, **kwargs)
```

Its imports (`src/flask/testing.py:1-18`) establish both external edges:

```python
from click.testing import CliRunner
from click.testing import Result
...
from .cli import ScriptInfo
```

## Edges with citations (five, in dependency order)

1. **Base edge (isolation provider).** `class FlaskCliRunner(CliRunner)` (`src/flask/testing.py:265`; `CliRunner` imported at `:12`). The base `click.testing.CliRunner` is the "base Click testing runner": `class CliRunner` at `.venv/Lib/site-packages/click/testing.py:225`, `invoke` at `:423`, `isolation` at `:276`, `isolated_filesystem` at `:537`. Docstring: *"The CLI runner provides functionality to invoke a Click command line script for unittesting purposes in a isolated environment."*; `invoke` docstring: *"Invokes a command in an isolated environment."*
2. **App-instance edge.** `FlaskCliRunner.__init__(self, app: Flask, **kwargs)` stores `self.app = app` (`src/flask/testing.py:272-274`). `Flask.test_cli_runner()` builds it with `cls(self, **kwargs)`, where `cls = self.test_cli_runner_class` defaults to `FlaskCliRunner` (`src/flask/app.py:727-742`; `src/flask/sansio/app.py:271-277`). The app owns its Click group `self.cli = cli.AppGroup()` (`src/flask/app.py:256-260`).
3. **Helper-wiring edge.** `FlaskCliRunner.invoke` defaults `cli = self.app.cli` and `obj = ScriptInfo(create_app=lambda: self.app)`, then calls `super().invoke(cli, args, **kwargs)` (`src/flask/testing.py:288-298`). This is what makes the helper per-instance: no import path is needed and no other app can leak in.
4. **Helper → app edge.** `ScriptInfo.load_app()` returns the cached `_loaded_app`, else calls `self.create_app()` (here the lambda → the same `Flask` instance), else `locate_app(import_name, name)` (`src/flask/cli.py:333-372`); `locate_app` (`:241-264`) imports the module and dispatches to `find_best_app` (`:41`) or `find_app_by_string` (`:120`), both of which require `isinstance(app, Flask)`.
5. **Context edge.** `with_appcontext` (`src/flask/cli.py:380-402`) and `FlaskGroup.get_command` (`src/flask/cli.py:609-634`) both do `ctx.ensure_object(ScriptInfo).load_app()` and then `ctx.with_resource(app.app_context())`; `AppGroup.command` wraps callbacks in `with_appcontext` by default (`src/flask/cli.py:405-427`); `FlaskGroup.make_context` installs the default `ScriptInfo(create_app=self.create_app, set_debug_flag=self.set_debug_flag, load_dotenv_defaults=self.load_dotenv)` (`src/flask/cli.py:657-676`).

## Supporting code, quoted verbatim

**`ScriptInfo` — the "application loading helper" (`src/flask/cli.py:293-372`, re-verified)**

```python
class ScriptInfo:
    """Helper object to deal with Flask applications.  This is usually not
    necessary to interface with as it's used internally in the dispatching
    to click.  In future versions of Flask this object will most likely play
    a bigger role.  Typically it's created automatically by the
    :class:`FlaskGroup` but you can also manually create it and pass it
    onwards as click object.
    """
```

```python
    def __init__(
        self,
        app_import_path: str | None = None,
        create_app: t.Callable[..., Flask] | None = None,
        set_debug_flag: bool = True,
        load_dotenv_defaults: bool = True,
    ) -> None:
        #: Optionally the import path for the Flask application.
        self.app_import_path = app_import_path
        #: Optionally a function that is passed the script info to create
        #: the instance of the application.
        self.create_app = create_app
        #: A dictionary with arbitrary data that can be associated with
        #: this script info.
        self.data: dict[t.Any, t.Any] = {}
        self.set_debug_flag = set_debug_flag

        self.load_dotenv_defaults = get_load_dotenv(load_dotenv_defaults)
        """Whether default ``.flaskenv`` and ``.env`` files should be loaded.

        ``ScriptInfo`` doesn't load anything, this is for reference when doing
        the load elsewhere during processing.

        .. versionadded:: 3.1
        """

        self._loaded_app: Flask | None = None

    def load_app(self) -> Flask:
        """Loads the Flask app (if not yet loaded) and returns it.  Calling
        this multiple times will just result in the already loaded app to
        be returned.
        """
        if self._loaded_app is not None:
            return self._loaded_app
        app: Flask | None = None
        if self.create_app is not None:
            app = self.create_app()
        else:
            if self.app_import_path:
                path, name = (
                    re.split(r":(?![\\/])", self.app_import_path, maxsplit=1) + [None]
                )[:2]
                import_name = prepare_import(path)
                app = locate_app(import_name, name)
            else:
                for path in ("wsgi.py", "app.py"):
                    import_name = prepare_import(path)
                    app = locate_app(import_name, None, raise_if_not_found=False)

                    if app is not None:
                        break

        if app is None:
            raise NoAppException(
                "Could not locate a Flask application. Use the"
                " 'flask --app' option, 'FLASK_APP' environment"
                " variable, or a 'wsgi.py' or 'app.py' file in the"
                " current directory."
            )

        if self.set_debug_flag:
            # Update the app's debug flag through the descriptor so that
            # other values repopulate as well.
            app.debug = get_debug_flag()

        self._loaded_app = app
        return app
```

**`with_appcontext` — the context edge (`src/flask/cli.py:375-402`, re-verified)**

```python
pass_script_info = click.make_pass_decorator(ScriptInfo, ensure=True)

F = t.TypeVar("F", bound=t.Callable[..., t.Any])


def with_appcontext(f: F) -> F:
    """Wraps a callback so that it's guaranteed to be executed with the
    script's application context.

    Custom commands (and their options) registered under ``app.cli`` or
    ``blueprint.cli`` will always have an app context available, this
    decorator is not required in that case.

    .. versionchanged:: 2.2
        The app context is active for subcommands as well as the
        decorated callback. The app context is always available to
        ``app.cli`` command and parameter callbacks.
    """

    @click.pass_context
    def decorator(ctx: click.Context, /, *args: t.Any, **kwargs: t.Any) -> t.Any:
        if not current_app:
            app = ctx.ensure_object(ScriptInfo).load_app()
            ctx.with_resource(app.app_context())

        return ctx.invoke(f, *args, **kwargs)

    return update_wrapper(decorator, f)  # type: ignore[return-value]
```

**`locate_app` — the import path of the helper's `load_app` (`src/flask/cli.py:241-264`)**

```python
def locate_app(
    module_name: str, app_name: str | None, raise_if_not_found: bool = True
) -> Flask | None:
    try:
        __import__(module_name)
    except ImportError:
        # Reraise the ImportError if it occurred within the imported module.
        # Determine this by checking whether the trace has a depth > 1.
        if sys.exc_info()[2].tb_next:  # type: ignore[union-attr]
            raise NoAppException(
                f"While importing {module_name!r}, an ImportError was"
                f" raised:\n\n{traceback.format_exc()}"
            ) from None
        elif raise_if_not_found:
            raise NoAppException(f"Could not import {module_name!r}.") from None
        else:
            return None

    module = sys.modules[module_name]

    if app_name is None:
        return find_best_app(module)
    else:
        return find_app_by_string(module, app_name)
```

**`Flask` application instance side (`src/flask/app.py:250-260` and `:727-742`, re-verified)**

```python
        #: The Click command group for registering CLI commands for this
        #: object. The commands are available from the ``flask`` command
        #: once the application has been discovered and blueprints have
        #: been registered.
        self.cli = cli.AppGroup()

        # Set the name of the Click group in case someone wants to add
        # the app's commands to another CLI tool.
        self.cli.name = self.name
```

```python
    def test_cli_runner(self, **kwargs: t.Any) -> FlaskCliRunner:
        """Create a CLI runner for testing CLI commands.
        See :ref:`testing-cli`.

        Returns an instance of :attr:`test_cli_runner_class`, by default
        :class:`~flask.testing.FlaskCliRunner`. The Flask app object is
        passed as the first argument.

        .. versionadded:: 1.0
        """
        cls = self.test_cli_runner_class

        if cls is None:
            from .testing import FlaskCliRunner as cls

        return cls(self, **kwargs)  # type: ignore
```

**`test_cli_runner_class` (`src/flask/sansio/app.py:271-277`)**

```python
    #: The :class:`~click.testing.CliRunner` subclass, by default
    #: :class:`~flask.testing.FlaskCliRunner` that is used by
    #: :meth:`test_cli_runner`. Its ``__init__`` method should take a
    #: Flask app object as the first argument.
    #:
    #: .. versionadded:: 1.0
    test_cli_runner_class: type[FlaskCliRunner] | None = None
```

**`FlaskGroup.get_command` (`src/flask/cli.py:609-634`)**

```python
    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
        self._load_plugin_commands()
        # Look up built-in and plugin commands, which should be
        # available even if the app fails to load.
        rv = super().get_command(ctx, name)

        if rv is not None:
            return rv

        info = ctx.ensure_object(ScriptInfo)

        # Look up commands provided by the app, showing an error and
        # continuing if the app couldn't be loaded.
        try:
            app = info.load_app()
        except NoAppException as e:
            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
            return None

        # Push an app context for the loaded app unless it is already
        # active somehow. This makes the context available to parameter
        # and command callbacks without needing @with_appcontext.
        if not current_app or current_app._get_current_object() is not app:  # type: ignore[attr-defined]
            ctx.with_resource(app.app_context())

        return app.cli.get_command(ctx, name)
```

**Documentation statement of the chain** — `docs/testing.rst:248-251` (the only place in the repo attaching "in isolation" to the runner):

```rst
Flask provides :meth:`~flask.Flask.test_cli_runner` to create a
:class:`~flask.testing.FlaskCliRunner`, which runs CLI commands in
isolation and captures the output in a :class:`~click.testing.Result`
object. Flask's runner extends :doc:`Click's runner <click:testing>`,
see those docs for additional information.
```

## Test-side evidence that pins each edge

`tests/test_testing.py:338-380` (app instance → `FlaskCliRunner` → helper bound to that app):

```python
def test_cli_runner_class(app):
    runner = app.test_cli_runner()
    assert isinstance(runner, FlaskCliRunner)

    class SubRunner(FlaskCliRunner):
        pass

    app.test_cli_runner_class = SubRunner
    runner = app.test_cli_runner()
    assert isinstance(runner, SubRunner)


def test_cli_invoke(app):
    @app.cli.command("hello")
    def hello_command():
        click.echo("Hello, World!")

    runner = app.test_cli_runner()
    # invoke with command name
    result = runner.invoke(args=["hello"])
    assert "Hello" in result.output
    # invoke with command object
    result = runner.invoke(hello_command)
    assert "Hello" in result.output


def test_cli_custom_obj(app):
    class NS:
        called = False

    def create_app():
        NS.called = True
        return app

    @app.cli.command("hello")
    def hello_command():
        click.echo("Hello, World!")

    script_info = ScriptInfo(create_app=create_app)
    runner = app.test_cli_runner()
    runner.invoke(hello_command, obj=script_info)
    assert NS.called
```

`tests/test_cli.py:289-304` (context edge: the loaded app **is** `current_app`):

```python
def test_app_cli_has_app_context(app, runner):
    def _param_cb(ctx, param, value):
        # current_app should be available in parameter callbacks
        return bool(current_app)

    @app.cli.command()
    @click.argument("value", callback=_param_cb)
    def check(value):
        app = click.get_current_context().obj.load_app()
        # the loaded app should be the same as current_app
        same_app = current_app._get_current_object() is app
        return same_app, value

    cli = FlaskGroup(create_app=lambda: app)
    result = runner.invoke(cli, ["check", "x"], standalone_mode=False)
    assert result.return_value == (True, True)
```

`tests/test_cli.py:247-286` (`test_scriptinfo`, every branch of `ScriptInfo.load_app`):

```python
def test_scriptinfo(test_apps, monkeypatch):
    obj = ScriptInfo(app_import_path="cliapp.app:testapp")
    app = obj.load_app()
    assert app.name == "testapp"
    assert obj.load_app() is app

    # import app with module's absolute path
    cli_app_path = str(test_path / "cliapp" / "app.py")

    obj = ScriptInfo(app_import_path=cli_app_path)
    app = obj.load_app()
    assert app.name == "testapp"
    assert obj.load_app() is app
    obj = ScriptInfo(app_import_path=f"{cli_app_path}:testapp")
    app = obj.load_app()
    assert app.name == "testapp"
    assert obj.load_app() is app

    def create_app():
        return Flask("createapp")

    obj = ScriptInfo(create_app=create_app)
    app = obj.load_app()
    assert app.name == "createapp"
    assert obj.load_app() is app

    obj = ScriptInfo()
    pytest.raises(NoAppException, obj.load_app)

    # import app from wsgi.py in current directory
    monkeypatch.chdir(test_path / "helloworld")
    obj = ScriptInfo()
    app = obj.load_app()
    assert app.name == "hello"

    # import app from app.py in current directory
    monkeypatch.chdir(test_path / "cliapp")
    obj = ScriptInfo()
    app = obj.load_app()
    assert app.name == "testapp"
```

`tests/conftest.py:45-52` (the Flask application instance fixture used by the CLI-runner tests) and `:72-82` (the sys.path helper that keeps app-loading tests isolated):

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app
```

```python
@pytest.fixture
def test_apps(monkeypatch):
    monkeypatch.syspath_prepend(os.path.join(os.path.dirname(__file__), "test_apps"))
    original_modules = set(sys.modules.keys())

    yield

    # Remove any imports cached during the test. Otherwise "import app"
    # will work in the next test even though it's no longer on the path.
    for key in sys.modules.keys() - original_modules:
        sys.modules.pop(key)
```

## Verification (executed)

Test config: `pyproject.toml` → `[tool.pytest.ini_options]` / `testpaths = ["tests"]` / `filterwarnings = ["error"]`; dependencies `click>=8.1.3`, `werkzeug>=3.1.0`.

Base-class edge at runtime:

```console
$ uv run python -c "from click.testing import CliRunner; from flask.testing import FlaskCliRunner; print('issubclass(FlaskCliRunner, CliRunner) =', issubclass(FlaskCliRunner, CliRunner)); print('MRO:', [c.__module__+'.'+c.__name__ for c in FlaskCliRunner.__mro__])"
issubclass(FlaskCliRunner, CliRunner) = True
MRO: ['flask.testing.FlaskCliRunner', 'click.testing.CliRunner', 'builtins.object']
```
exit 0

Focused chain tests:

```console
$ uv run pytest tests/test_cli.py::test_locate_app tests/test_cli.py::test_scriptinfo tests/test_testing.py::test_cli_runner_class tests/test_testing.py::test_cli_invoke tests/test_testing.py::test_cli_custom_obj -q
............                                                             [100%]
12 passed in 0.29s
```
exit 0

Relevant modules:

```console
$ uv run pytest tests/test_cli.py tests/test_testing.py -q
........................................................................ [ 86%]
...........                                                              [100%]
83 passed in 1.25s
```
exit 0

Same modules at max verbosity (`-vvv -rA --tb=long`): all 83 PASSED, including `tests/test_testing.py::test_cli_runner_class PASSED`, `tests/test_testing.py::test_cli_invoke PASSED`, `tests/test_testing.py::test_cli_custom_obj PASSED`, `tests/test_cli.py::test_scriptinfo PASSED`, `tests/test_cli.py::test_app_cli_has_app_context PASSED`, `tests/test_cli.py::test_with_appcontext PASSED`, `tests/test_cli.py::test_appgroup_app_context PASSED`, `tests/test_cli.py::test_flaskgroup_app_context PASSED`, and all `test_locate_app[...]` / `test_locate_app_raises[...]` parametrizations — `83 passed in 1.11s`, exit 0.

Whole repository suite:

```console
$ uv run pytest -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 4.81s
```
exit 0

(Also run at `-vvv -rA --tb=long`: `489 passed in 4.97s`, exit 0.)

End-to-end runtime demonstration of the chain:

```
=== EDGE 1: base runner (subclass) ===
issubclass(FlaskCliRunner, CliRunner): True
=== EDGE 2: app instance -> runner ===
app.cli type: (<class 'flask.cli.AppGroup'>, <class 'click.core.Group'>, <class 'click.core.Command'>)
test_cli_runner() -> FlaskCliRunner
runner.app is app: True
=== EDGE 3: helper wiring inside invoke ===
default obj passed to super().invoke: <flask.cli.ScriptInfo object at 0x000001AD6C8274D0>
default cli passed to super().invoke is app.cli: True
obj is ScriptInfo: True
obj.create_app() is app: True
obj.load_app() is app: True
=== EDGE 4/5: command runs with current_app == app, isolated ===
exit_code: 0
output: 'name=demo same=True\n'
exception: None
```
exit 0 — the helper is bound to the app (`create_app()`/`load_app() is app`), the default `cli is app.cli`, and the callback saw `current_app._get_current_object() is app`.

Environment notes (reported, not papered over): the first attempt with the system interpreter failed — `python -c "... from flask.testing import FlaskCliRunner ..."` → `ModuleNotFoundError: No module named 'flask'`, exit 1 — so all runs used `uv run` per the plan. `.venv` is a Windows junction to a shared environment and stale `__pycache__` `.pyc` files carry `co_filename` strings from another path; a collection probe showed the test modules import from `.../seal/tests/` (58 + 25 = 83 items) and `flask.cli.__file__` resolves to `...\seal\src\flask\cli.py`, so the verification applies to this working directory's code.

## Aside — unrelated mutant artifact (not part of the chain)

`flask_mut2_i417ar2x/mutated_test.py` is not imported anywhere by the library or the test suite (grep for `flask_mut2`/`mutated_test` outside its own directory returns nothing). It re-implements `tests/test_testing.py::test_subdomain` with `subdomain_matching=False`, hitting the `elif not self.subdomain_matching:` branch of `Flask.create_url_adapter` (`src/flask/app.py:445-470`) — subdomain/`url_for` behavior, unrelated to the CLI dependency chain. Executed:

```console
$ uv run python flask_mut2_i417ar2x/mutated_test.py
url_for -> http://xxx.example.com/
status_code: 404
data: b'<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n'
Traceback (most recent call last):
  File "...\seal\flask_mut2_i417ar2x\mutated_test.py", line 20, in <module>
    assert 200 == response.status_code, f"status {response.status_code}"
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: status 404
```
exit 1 — expected divergence for the flipped flag; reported only as an aside.

The complete artifact has also been written to `answer.md` in the working directory.
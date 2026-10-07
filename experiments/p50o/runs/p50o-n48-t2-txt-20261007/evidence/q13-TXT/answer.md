# Why `ScriptInfo` loads the Flask app lazily via `self._loaded_app` instead of in `__init__`

**Short answer.** The CLI helper is `ScriptInfo` in `src/flask/cli.py`. It cannot load the app in `__init__` because, at the moment it is constructed, the app it is supposed to load is genuinely unknown — the `--app`/`FLASK_APP` value arrives *later*, through Click's eager option callback — and because most invocations (`--help`, `--version`, plugin and built-in commands) must work when no app exists or the app fails to load. It caches the result in `self._loaded_app` because loading is an expensive, side-effecting, once-only operation that several independent call sites (`with_appcontext`, `get_command`, `list_commands`, `run_command`, and user code) must all share, and because errors/reloader semantics must be handled at load time, not construction time. The class's own docstring states the design rule explicitly: *"`ScriptInfo` doesn't load anything, this is for reference when doing the load elsewhere during processing."*

Everything below is grounded in the source, tests, changelog, and the executed experiments. No git history or PR text was available or used.

---

## 1. The class and the cached attribute

`ScriptInfo` is at `src/flask/cli.py` line 293; the cache is `self._loaded_app` (line 331); the lazy entry point is `load_app()` (line 333). Full source, lines 293–372:

```python
class ScriptInfo:
    """Helper object to deal with Flask applications.  This is usually not
    necessary to interface with as it's used internally in the dispatching
    to click.  In future versions of Flask this object will most likely play
    a bigger role.  Typically it's created automatically by the
    :class:`FlaskGroup` but you can also manually create it and pass it
    onwards as click object.

    .. versionchanged:: 3.1
        Added the ``load_dotenv_defaults`` parameter and attribute.
    """

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

Mechanically:
- **Guard / cache read (lines 338–339):** `if self._loaded_app is not None: return self._loaded_app` — a second call never re-runs the factory or the import.
- **Cache write (line 371):** `self._loaded_app = app` happens only *after* resolution succeeds, so a failed load leaves it `None` and can be retried.
- **`__init__` does no discovery at all.** It only stores `app_import_path`, `create_app`, `data`, `set_debug_flag`, `load_dotenv_defaults`, and initialises `self._loaded_app = None`.
- **`NoAppException` is raised only inside `load_app`** (lines 347–353), never in `__init__`. Supporting definition, `src/flask/cli.py` lines 37–38:

```python
class NoAppException(click.UsageError):
    """Raised if an application cannot be found or loaded."""
```

The executor confirmed these exact locations:

```
== CLAIM: ScriptInfo at line 293; _loaded_app; load_app ==
293:class ScriptInfo:
331:        self._loaded_app: Flask | None = None
333:    def load_app(self) -> Flask:
338:        if self._loaded_app is not None:
339:            return self._loaded_app
371:        self._loaded_app = app
Exit status 0.
```

---

## 2. Why not in `__init__` — Reason 1: the app is unknown at construction time

`ScriptInfo` is built in `FlaskGroup.make_context` **before** Click parses argv. `src/flask/cli.py` lines 657–676:

```python
    def make_context(
        self,
        info_name: str | None,
        args: list[str],
        parent: click.Context | None = None,
        **extra: t.Any,
    ) -> click.Context:
        # Set a flag to tell app.run to become a no-op. If app.run was
        # not in a __name__ == __main__ guard, it would start the server
        # when importing, blocking whatever command is being called.
        os.environ["FLASK_RUN_FROM_CLI"] = "true"

        if "obj" not in extra and "obj" not in self.context_settings:
            extra["obj"] = ScriptInfo(
                create_app=self.create_app,
                set_debug_flag=self.set_debug_flag,
                load_dotenv_defaults=self.load_dotenv,
            )

        return super().make_context(info_name, args, parent=parent, **extra)
```

Note what is passed: only `create_app`, `set_debug_flag`, `load_dotenv_defaults`. **`app_import_path` is not among them** — at this instant the `--app` value has not been parsed. It arrives afterwards through the eager `--app` callback `_set_app`, `src/flask/cli.py` lines 440–465:

```python
def _set_app(ctx: click.Context, param: click.Option, value: str | None) -> str | None:
    if value is None:
        return None

    info = ctx.ensure_object(ScriptInfo)
    info.app_import_path = value
    return value


# This option is eager so the app will be available if --help is given.
# --help is also eager, so --app must be before it in the param list.
# no_args_is_help bypasses eager processing, so this option must be
# processed manually in that case to ensure FLASK_APP gets picked up.
_app_option = click.Option(
    ["-A", "--app"],
    metavar="IMPORT",
    help=(
        "The Flask application or factory function to load, in the form 'module:name'."
        " Module can be a dotted import or file path. Name is not required if it is"
        " 'app', 'application', 'create_app', or 'make_app', and can be 'name(args)' to"
        " pass arguments."
    ),
    is_eager=True,
    expose_value=False,
    callback=_set_app,
)
```

`_set_app` reaches the already-constructed object with `ctx.ensure_object(ScriptInfo)` (line 444) and mutates it: `info.app_import_path = value` (line 445). So the object the user's factory ultimately reads was created with `app_import_path is None` and is *filled in later*.

There is a second such path. `FlaskGroup.parse_args` re-runs the option for `no_args_is_help` / `--help`, `src/flask/cli.py` lines 678–689:

```python
    def parse_args(self, ctx: click.Context, args: list[str]) -> list[str]:
        if (not args and self.no_args_is_help) or (
            len(args) == 1 and args[0] in self.get_help_option_names(ctx)
        ):
            # Attempt to load --env-file and --app early in case they
            # were given as env vars. Otherwise no_args_is_help will not
            # see commands from app.cli.
            _env_file_option.handle_parse_result(ctx, {}, [])
            _app_option.handle_parse_result(ctx, {}, [])

        return super().parse_args(ctx, args)
```

The same pattern shows up for debug configuration. `_set_debug` (lines 468–482) routes debug through the **environment**, not the loaded app, precisely so a factory can read it while the app is still being built:

```python
def _set_debug(ctx: click.Context, param: click.Option, value: bool) -> bool | None:
    # If the flag isn't provided, it will default to False. Don't use
    # that, let debug be set by env in that case.
    source = ctx.get_parameter_source(param.name)  # type: ignore[arg-type]

    if source is not None and source in (
        ParameterSource.DEFAULT,
        ParameterSource.DEFAULT_MAP,
    ):
        return None

    # Set with env var instead of ScriptInfo.load so that it can be
    # accessed early during a factory function.
    os.environ["FLASK_DEBUG"] = "1" if value else "0"
    return value
```

The comment at lines 479–480 — *"Set with env var instead of ScriptInfo.load so that it can be accessed early during a factory function"* — is the project's own statement that config cannot be routed through `load_app()` at construction time.

**Empirical confirmation (executor, Experiment 4).** A spy on `_set_app` (command `python trace_setapp.py`) produced:

```
ctx.obj type: ScriptInfo
ctx.obj id: 1214303657600
ctx.obj.app_import_path after make_context: 'some:create_app'
('BEFORE _set_app callback', 1214303657600, None)
('AFTER  _set_app callback', 1214303657600, 'some:create_app')
all ids equal (same object created before parsing): True
EXIT STATUS = 0
```

The same object (`id` identical) was created before parsing with `app_import_path is None`, then mutated to `'some:create_app'`. And running the real CLI (`python -m flask --app appmod:create_app routes`) showed inside the factory:

```
FACTORY CALLED: id(info)=2010934566528 app_import_path='appmod:create_app' create_app=None
Endpoint  Methods  Rule
--------  -------  -----------------------
static    GET      /static/<path:filename>
EXIT STATUS = 0
```

So the import path supplied on the command line is what the factory sees, even though it was never passed to `ScriptInfo.__init__` (`create_app is None` on that instance). **If `__init__` loaded the app, it would run before `--app`/`FLASK_APP` were ever parsed.**

---

## 3. Why not in `__init__` — Reason 2: the CLI must degrade gracefully with no app or a broken app

`--help`, `--version`, and plugin commands must work when no app can be found. `FlaskGroup.get_command` / `list_commands` (lines 609–655) therefore wrap `load_app()` in `try/except`:

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

    def list_commands(self, ctx: click.Context) -> list[str]:
        self._load_plugin_commands()
        # Start with the built-in and plugin commands.
        rv = set(super().list_commands(ctx))
        info = ctx.ensure_object(ScriptInfo)

        # Add commands provided by the app, showing an error and
        # continuing if the app couldn't be loaded.
        try:
            rv.update(info.load_app().cli.list_commands(ctx))
        except NoAppException as e:
            # When an app couldn't be loaded, show the error message
            # without the traceback.
            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
        except Exception:
            # When any other errors occurred during loading, show the
            # full traceback.
            click.secho(f"{traceback.format_exc()}\n", err=True, fg="red")

        return sorted(rv)
```

The comments at lines 611–612 (*"which should be available even if the app fails to load"*) and 620–621/642–647 state the contract directly. The tests pin it — `tests/test_cli.py` lines 398–444:

```python
def test_no_command_echo_loading_error():
    from flask.cli import cli

    try:
        runner = CliRunner(mix_stderr=False)
    except (DeprecationWarning, TypeError):
        # Click >= 8.2
        runner = CliRunner()

    result = runner.invoke(cli, ["missing"])
    assert result.exit_code == 2
    assert "FLASK_APP" in result.stderr
    assert "Usage:" in result.stderr
```

```python
def test_help_echo_loading_error():
    from flask.cli import cli

    try:
        runner = CliRunner(mix_stderr=False)
    except (DeprecationWarning, TypeError):
        # Click >= 8.2
        runner = CliRunner()

    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "FLASK_APP" in result.stderr
    assert "Usage:" in result.stdout
```

```python
def test_help_echo_exception():
    def create_app():
        raise Exception("oh no")

    cli = FlaskGroup(create_app=create_app)

    try:
        runner = CliRunner(mix_stderr=False)
    except (DeprecationWarning, TypeError):
        # Click >= 8.2
        runner = CliRunner()

    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "Exception: oh no" in result.stderr
    assert "Usage:" in result.stdout
```

`--help` exits **0** even when the app is missing or the factory raises; the failure is downgraded to a stderr message. **If loading occurred in `__init__`, `--help` would raise before Click could print anything.**

**Empirical confirmation (executor, Experiment 1).** In an empty directory with `FLASK_APP` unset:

```
env -u FLASK_APP -u FLASK_DEBUG -u FLASK_RUN_FROM_CLI PYTHONPATH="<workdir>/src" .venv/Scripts/python.exe -m flask --help > stdout.txt 2> stderr.txt
```

```
EXIT STATUS = 0
----- STDOUT -----
Usage: python -m flask [OPTIONS] COMMAND [ARGS]...

  A general utility script for Flask applications.

  An application to load must be given with the '--app' option, 'FLASK_APP'
  environment variable, or with a 'wsgi.py' or 'app.py' file in the current
  directory.

Options:
  -e, --env-file FILE   Load environment variables from this file, taking
                        precedence over those set by '.env' and '.flaskenv'.
                        Variables set directly in the environment take highest
                        precedence. python-dotenv must be installed.
  -A, --app IMPORT      The Flask application or factory function to load, in
                        the form 'module:name'. Module can be a dotted import
                        or file path. Name is not required if it is 'app',
                        'application', 'create_app', or 'make_app', and can be
                        'name(args)' to pass arguments.
  --debug / --no-debug  Set debug mode.
  --version             Show the Flask version.
  --help                Show this message and exit.

Commands:
  routes  Show the routes for the app.
  run     Run a development server.
  shell   Run a shell in the app context.
----- STDERR -----
Error: Could not locate a Flask application. Use the 'flask --app' option, 'FLASK_APP' environment variable, or a 'wsgi.py' or 'app.py' file in the current directory.
```

Exit 0, full help on stdout, graceful `Error:` on stderr, **no `NoAppException` traceback**.

And Experiment 2 confirmed the error is genuinely deferred to `load_app`, not construction:

```
CONSTRUCTED OK, _loaded_app = None
load_app() raised NoAppException: Could not locate a Flask application. Use the 'flask --app' option, 'FLASK_APP' environment variable, or a 'wsgi.py' or 'app.py' file in the current directory.
RESULT: construction succeeded; NoAppException came only from load_app()
EXIT STATUS = 0
```

This matches the test at `tests/test_cli.py` lines 273–274, where `obj = ScriptInfo()` succeeds and the exception comes later:

```python
    obj = ScriptInfo()
    pytest.raises(NoAppException, obj.load_app)
```

---

## 4. Why cached — Reason 3: loading is a side-effecting, once-only operation shared by several callers

`load_app()` is invoked from several independent places:

- `get_command` / `list_commands` (above),
- `with_appcontext` (`src/flask/cli.py` lines 375–403), which loads **only if** there is no current app:

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

- `run_command` (`src/flask/cli.py`, load portion at lines ~952–975),
- and user code, e.g. `click.get_current_context().obj.load_app()`.

A factory creates a *new* app on every call, and the reloader, `current_app`, and the command being dispatched must all refer to the *same* object. The memoization guard `if self._loaded_app is not None: return self._loaded_app` is what guarantees that. The tests pin both the once-only factory execution and the identity:

`tests/test_cli.py` lines 247–286:

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

`tests/test_cli.py` lines 289–304 (`test_app_cli_has_app_context`) shows the same object reaching user code:

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

The third construction pattern is in `src/flask/testing.py` lines 282–298 — a `create_app` callable that returns an **existing** app, which only makes sense because loading is deferred until first use:

```python
        if "obj" not in kwargs:
            kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)

        return super().invoke(cli, args, **kwargs)
```

**Empirical confirmation (executor, Experiment 3).** Command `python exp3.py`:

```
factory call count: 1
a is b: True  b is c: True  a is c: True
a.name: cached-app  id(a)=2868268785616 id(b)=2868268785616
second ScriptInfo factory calls: 1  a is d: False
RESULT: factory ran once per ScriptInfo; identity holds across load_app() calls
EXIT STATUS = 0
```

The factory ran exactly once per `ScriptInfo`, and all three `load_app()` results were the identical object. A separate experiment showed the cache is not poisoned by failure (the write happens only after success):

```
first load_app() -> NoAppException: NoAppException
after failure, _loaded_app is None: True
second load_app() -> recovered  _loaded_app set: True
third load_app() is same: True
EXIT STATUS = 0
```

---

## 5. Why cached (continued) — Reason 4: deferral puts error handling and reloader semantics in the right place

`run_command` wraps `info.load_app()` in `try/except Exception` so that, under the reloader, a broken app prints the error immediately but is re-raised later by the WSGI callable; otherwise it fails the command. `src/flask/cli.py` (~lines 952–975):

```python
    try:
        app: WSGIApplication = info.load_app()  # pyright: ignore
    except Exception as e:
        if is_running_from_reloader():
            # When reloading, print out the error immediately, but raise
            # it later so the debugger or server can handle it.
            traceback.print_exc()
            err = e

            def app(
                environ: WSGIEnvironment, start_response: StartResponse
            ) -> cabc.Iterable[bytes]:
                raise err from None

        else:
            # When not reloading, raise the error immediately so the
            # command fails.
            raise e from None
```

This "defer errors to the reloader" behaviour is intentional and documented in the changelog (`CHANGES.rst`; version attributed by the executor's header check):

- `CHANGES.rst` lines 340–345, **Version 2.2.0**:

```
-   Remove the ``--eager-loading/--lazy-loading`` options from the
    ``flask run`` command. The app is always eager loaded the first
    time, then lazily loaded in the reloader. The reloader always prints
    errors immediately but continues serving. Remove the internal
    ``DispatchingApp`` middleware used by the previous implementation.
    :issue:`4715`
```

- `CHANGES.rst` lines 425–427, **Version 2.1.0**:

```
-   When using lazy loading (the default with the debugger), the Click
    context from the ``flask run`` command remains available in the
    loader thread. :issue:`4460`
```

- `CHANGES.rst` lines 480–481, **Version 2.0.2** *(the retriever thought 2.1.0; the executor's grep of `Version` headers confirmed the enclosing section header at line 463 is 2.0.2)*:

```
-   Correctly handle raising deferred errors in CLI lazy loading.
    :issue:`4096`
```

- `CHANGES.rst` lines 545–546, **Version 2.0.0**:

```
-   The CLI shows better error messages when the app failed to load
    when looking up commands. :issue:`2741`
```

- `CHANGES.rst` lines 552–554, **Version 2.0.0**:

```
-   The ``flask run`` command will only defer errors on reload. Errors
    present during the initial call will cause the server to exit with
    the traceback immediately. :issue:`3431`
```

`NoAppException` is designed to be raised and `format_message()`-ed at load time (see `get_command`/`list_commands`), not at construction time.

---

## 6. Why cached — Reason 5: it is consistent with the module's general refusal to import the app eagerly

The rest of `src/flask/cli.py` also defers all app importing: `find_best_app` (lines 41–44) and `find_app_by_string` (lines 120–123) do a function-local `from . import Flask`; `locate_app` (line 230) imports the target module only when called. `ScriptInfo` stores a *path or callable*, never an instance. And the top-level CLI object is created without any app, `src/flask/cli.py` lines 1108–1121:

```python
cli = FlaskGroup(
    name="flask",
    help="""\
A general utility script for Flask applications.

An application to load must be given with the '--app' option,
'FLASK_APP' environment variable, or with a 'wsgi.py' or 'app.py' file
in the current directory.
""",
)


def main() -> None:
    cli.main()
```

`src/flask/app.py` line 256 (`self.cli = cli.AppGroup()`) with the comment "The commands are available from the ``flask`` command **once the application has been discovered**" reinforces that app-defined commands cannot exist before discovery — which is exactly why discovery must be deferrable. The `load_dotenv_defaults` attribute docstring in `__init__` states the rule plainly: *"`ScriptInfo` doesn't load anything, this is for reference when doing the load elsewhere during processing."*

---

## 7. Verification runs (executor)

The relevant test suites pass, pinning all of the above behaviour:

- `python -m pytest tests/test_cli.py tests/test_testing.py` → **83 passed** (exit 0). Per-test `-vv -rA` output includes `test_scriptinfo PASSED`, `test_app_cli_has_app_context PASSED`, `test_no_command_echo_loading_error PASSED`, `test_help_echo_loading_error PASSED`, `test_help_echo_exception PASSED`.
- `python -m pytest` (full suite) → **489 passed** (exit 0).

Reproducibility caveats recorded by the executor: the working directory's `.venv` pointed at an outside checkout, so every command was run with `PYTHONPATH="<workdir>/src"` and `flask.__file__` verified to resolve to `<workdir>\src\flask\__init__.py`; stale `__pycache__` compiled from the original checkout path was deleted so all runs used bytecode built from this working tree.

---

## 8. What the source does **not** say (no invented rationale)

- No commit messages, PR discussions, or git history were available or consulted. The rationale above is drawn only from the source, the tests, `CHANGES.rst`, and the executed experiments.
- `docs/cli.rst` documents the `--app` resolution order (lines 14–56) and app-context behaviour (lines 421–441) and custom scripts (lines 473–505), but **contains no explicit justification for laziness**; the executor confirmed `grep lazy docs/cli.rst` returns no matches (exit 1). The *reason* lives in code comments, tests, and the changelog.
- The cache is a plain attribute with no locking. That is true but is **not** part of the answer to this question and is deliberately excluded.

**In one sentence:** `ScriptInfo` (in `src/flask/cli.py`) defers app loading through the cached `self._loaded_app` because it is constructed before Click parses `--app`/`FLASK_APP` (so the app is unknown at `__init__` time), because `--help`/plugin/built-in commands must survive a missing or broken app, and because loading is a once-only, side-effecting operation whose single result — one app object shared by the factory, `current_app`, the command dispatcher, and the reloader — must be identical across every caller.
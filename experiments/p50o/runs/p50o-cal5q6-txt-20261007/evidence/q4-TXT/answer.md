# Final answer: the CLI dependency chain — `ScriptInfo` (application-loading helper) ↔ the `Flask` application instance ↔ `click.testing.CliRunner` (base Click testing runner)

## Short statement of the chain

The three named pieces are wired together so that a CLI command can be executed in isolation with the *exact same* `Flask` object available inside the command body that the test created outside it:

1. **The Flask application instance is the root object.** `Flask.__init__` creates `self.cli = cli.AppGroup()`, so the app already owns the Click command group.
2. **`Flask.test_cli_runner()`** is the entry point. It reads the overridable class attribute `test_cli_runner_class` (default `None`), lazily imports `flask.testing.FlaskCliRunner`, and constructs it with the app as the first positional argument: `return cls(self, **kwargs)`.
3. **`flask.testing.FlaskCliRunner` *is a subclass of* `click.testing.CliRunner`**, so the base Click testing runner's isolation machinery is inherited unchanged. Its `__init__` stores `self.app = app` and delegates to `super().__init__(**kwargs)`.
4. **`FlaskCliRunner.invoke`** default-selects the command (`cli = self.app.cli`) and injects the application-loading helper into Click's context: `if "obj" not in kwargs: kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)`.
5. **`click.testing.CliRunner.invoke`** runs everything inside `with self.isolation(input=input, env=env, color=color) as outstreams:` and forwards `**extra` (which now contains `obj`) into `cli.main(args=args or (), prog_name=prog_name, **extra)` → `Command.main` → `Command.make_context(..., **extra)` → `Context(..., obj=...)`.
6. **Inside the command**, `with_appcontext` (auto-applied to `app.cli` commands by `AppGroup.command`) or `FlaskGroup.get_command` calls `ctx.ensure_object(ScriptInfo).load_app()`. Because `ScriptInfo` was built with `create_app=lambda: self.app`, `load_app()` returns the identical test app — memoized in `self._loaded_app` — and then pushes `ctx.with_resource(app.app_context())` only `if not current_app`.

So the dependency direction is: **base Click runner (`CliRunner`) ← `FlaskCliRunner` ← `Flask.test_cli_runner()` ← `Flask` instance**, with **`ScriptInfo`** as the object that carries the `Flask` instance *into* the isolated invocation through Click's `obj`/`Context` channel and back out via `load_app()`. Isolation is supplied by the base Click runner; app availability is supplied by `ScriptInfo`; identity between the two is guaranteed by the closure `lambda: self.app`.

---

## Link-by-link, with the load-bearing code quoted

### Link 1 — the Flask instance owns `app.cli` as an `AppGroup`

`src/flask/app.py:256` (inside `Flask.__init__`):

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

`AppGroup` is defined at `src/flask/cli.py:405` as `class AppGroup(click.Group):` and is what makes `@app.cli.command` commands automatically app-context-aware (see Link 6).

### Link 2 — `Flask.test_cli_runner()` selects the runner class and passes the app in

`src/flask/app.py:727-742` (verified verbatim by direct read):

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

The overridable attribute is declared in `src/flask/sansio/app.py:271-277`:

```python
    #: The :class:`~click.testing.CliRunner` subclass, by default
    #: :class:`~flask.testing.FlaskCliRunner` that is used by
    #: :meth:`test_cli_runner`. Its ``__init__`` method should take a
    #: Flask app object as the first argument.
    #:
    #: .. versionadded:: 1.0
    test_cli_runner_class: type[FlaskCliRunner] | None = None
```

`FlaskCliRunner` is imported only under `t.TYPE_CHECKING` in `src/flask/app.py:57-62`, and the runtime import is the lazy one inside `test_cli_runner` above:

```python
if t.TYPE_CHECKING:  # pragma: no cover
    from _typeshed.wsgi import StartResponse
    from _typeshed.wsgi import WSGIEnvironment

    from .testing import FlaskClient
    from .testing import FlaskCliRunner
```

### Link 3 — `FlaskCliRunner` is a subclass of the base Click testing runner

`src/flask/testing.py:265-298` (verified verbatim by direct read):

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

The import that establishes the base-class relationship is `src/flask/testing.py:12` (`from click.testing import CliRunner`) and the helper import is `src/flask/testing.py:17` (`from .cli import ScriptInfo`). The base class itself is `click.testing.CliRunner` (`click/testing.py:225`), whose docstring is explicit about what "isolated" means:

```python
class CliRunner:
    """The CLI runner provides functionality to invoke a Click command line
    script for unittesting purposes in a isolated environment.  This only
    works in single-threaded systems without any concurrency as it changes the
    global interpreter state.
    ...
    .. versionchanged:: 8.2
        Added the ``catch_exceptions`` parameter.

    .. versionchanged:: 8.2
        ``mix_stderr`` parameter has been removed.
    """
```

### Link 4 — `CliRunner.invoke` isolates and forwards `**extra` (carrying `obj`) to `cli.main`

`click/testing.py:480` and `:494` (verified verbatim by direct read):

```python
        with self.isolation(input=input, env=env, color=color) as outstreams:
```

```python
                return_value = cli.main(args=args or (), prog_name=prog_name, **extra)
```

Full `invoke` body as handed over (`click/testing.py:423-534`):

```python
    def invoke(
        self,
        cli: Command,
        args: str | cabc.Sequence[str] | None = None,
        input: str | bytes | t.IO[t.Any] | None = None,
        env: cabc.Mapping[str, str | None] | None = None,
        catch_exceptions: bool | None = None,
        color: bool = False,
        **extra: t.Any,
    ) -> Result:
        """Invokes a command in an isolated environment.  The arguments are
        forwarded directly to the command line script, the `extra` keyword
        arguments are passed to the :meth:`~clickpkg.Command.main` function of
        the command.
        ...
        :param extra: the keyword arguments to pass to :meth:`main`.
        ...
        """
        exc_info = None
        if catch_exceptions is None:
            catch_exceptions = self.catch_exceptions

        with self.isolation(input=input, env=env, color=color) as outstreams:
            return_value = None
            exception: BaseException | None = None
            exit_code = 0

            if isinstance(args, str):
                args = shlex.split(args)

            try:
                prog_name = extra.pop("prog_name")
            except KeyError:
                prog_name = self.get_default_prog_name(cli)

            try:
                return_value = cli.main(args=args or (), prog_name=prog_name, **extra)
            except SystemExit as e:
                exc_info = sys.exc_info()
                e_code = t.cast("int | t.Any | None", e.code)
                ...
                exit_code = e_code

            except Exception as e:
                if not catch_exceptions:
                    raise
                exception = e
                exit_code = 1
                exc_info = sys.exc_info()
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
                stdout = outstreams[0].getvalue()
                stderr = outstreams[1].getvalue()
                output = outstreams[2].getvalue()

        return Result(
            runner=self,
            stdout_bytes=stdout,
            stderr_bytes=stderr,
            output_bytes=output,
            return_value=return_value,
            exit_code=exit_code,
            exception=exception,
            exc_info=exc_info,  # type: ignore
        )
```

`isolation` (`click/testing.py:275-421`) is what actually rebinds stdio/env and restores them in a `finally`:

```python
    @contextlib.contextmanager
    def isolation(
        self,
        input: str | bytes | t.IO[t.Any] | None = None,
        env: cabc.Mapping[str, str | None] | None = None,
        color: bool = False,
    ) -> cabc.Iterator[tuple[io.BytesIO, io.BytesIO, io.BytesIO]]:
        """A context manager that sets up the isolation for invoking of a
        command line tool.  This sets up `<stdin>` with the given input data
        and `os.environ` with the overrides from the given dictionary.
        This also rebinds some internals in Click to be mocked (like the
        prompt functionality).

        This is automatically done in the :meth:`invoke` method.
        ...
        """
        bytes_input = make_input_stream(input, self.charset)
        echo_input = None

        old_stdin = sys.stdin
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        old_forced_width = formatting.FORCED_WIDTH
        formatting.FORCED_WIDTH = 80

        env = self.make_env(env)

        stream_mixer = StreamMixer()
        ...
        sys.stdin = text_input = _NamedTextIOWrapper(
            bytes_input, encoding=self.charset, name="<stdin>", mode="r"
        )
        ...
        sys.stdout = _NamedTextIOWrapper(
            stream_mixer.stdout, encoding=self.charset, name="<stdout>", mode="w"
        )

        sys.stderr = _NamedTextIOWrapper(
            stream_mixer.stderr,
            encoding=self.charset,
            name="<stderr>",
            mode="w",
            errors="backslashreplace",
        )
        ...
        old_env = {}
        try:
            for key, value in env.items():
                old_env[key] = os.environ.get(key)
                if value is None:
                    try:
                        del os.environ[key]
                    except Exception:
                        pass
                else:
                    os.environ[key] = value
            yield (stream_mixer.stdout, stream_mixer.stderr, stream_mixer.output)
        finally:
            for key, value in old_env.items():
                if value is None:
                    try:
                        del os.environ[key]
                    except Exception:
                        pass
                else:
                    os.environ[key] = value
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            sys.stdin = old_stdin
            termui.visible_prompt_func = old_visible_prompt_func
            termui.hidden_prompt_func = old_hidden_prompt_func
            termui._getchar = old__getchar_func
            utils.should_strip_ansi = old_should_strip_ansi  # type: ignore
            _compat.should_strip_ansi = old__compat_should_strip_ansi
            formatting.FORCED_WIDTH = old_forced_width
```

How `obj` reaches the command context (`click/core.py`):

```python
    def __init__(
        self,
        command: Command,
        parent: Context | None = None,
        info_name: str | None = None,
        obj: t.Any | None = None,
        ...
    ) -> None:
        ...
        if obj is None and parent is not None:
            obj = parent.obj

        #: the user object stored.
        self.obj: t.Any = obj
```
— `click/core.py:272/277/314`.

```python
        for key, value in self.context_settings.items():
            if key not in extra:
                extra[key] = value

        ctx = self.context_class(self, info_name=info_name, parent=parent, **extra)

        with ctx.scope(cleanup=False):
            self.parse_args(ctx, args)
        return ctx
```
— `Command.make_context`, `click/core.py:1152-1181`.

```python
        try:
            try:
                with self.make_context(prog_name, args, **extra) as ctx:
                    rv = self.invoke(ctx)
                    ...
```
— `Command.main`, `click/core.py:1295-1390`.

And `Group.invoke` dispatches through the (Flask-overridden) `get_command`:

```python
        if not self.chain:
            # Make sure the context is entered so we do not clean up
            # resources until the result processor has worked.
            with ctx:
                cmd_name, cmd, args = self.resolve_command(ctx, args)
                assert cmd is not None
                ctx.invoked_subcommand = cmd_name
                super().invoke(ctx)
                sub_ctx = cmd.make_context(cmd_name, args, parent=ctx)
                with sub_ctx:
                    return _process_result(sub_ctx.command.invoke(sub_ctx))
```
— `click/core.py:1796-1835`.

### Link 5 — the application-loading helper: `flask.cli.ScriptInfo.load_app`

`src/flask/cli.py:291-375`:

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


pass_script_info = click.make_pass_decorator(ScriptInfo, ensure=True)
```

Verified line anchors in this tree: `def load_app` at `src/flask/cli.py:333`; the memo assignment `self._loaded_app = app` at `src/flask/cli.py:371`.

**Crucial path note:** when `create_app` is set (which is exactly what `FlaskCliRunner.invoke` does), `load_app` executes `app = self.create_app()` and **bypasses** `prepare_import`, `locate_app`, `find_best_app`, and `find_app_by_string`. Those functions are only reached on the `app_import_path` / "look for wsgi.py or app.py" branches, which the test-runner path never takes. So "the application loading helper" in this chain is `ScriptInfo`/`ScriptInfo.load_app`, and the import-based resolution machinery is *not* part of the isolation chain.

### Link 6 — how the loaded app becomes the current app context

`src/flask/cli.py:380-400` (verified verbatim by direct read; `def with_appcontext` is at line 380):

```python
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

This is auto-applied by `AppGroup.command` (`src/flask/cli.py:405-438`):

```python
class AppGroup(click.Group):
    """This works similar to a regular click :class:`~click.Group` but it
    changes the behavior of the :meth:`command` decorator so that it
    automatically wraps the functions in :func:`with_appcontext`.

    Not to be confused with :class:`FlaskGroup`.
    """

    def command(  # type: ignore[override]
        self, *args: t.Any, **kwargs: t.Any
    ) -> t.Callable[[t.Callable[..., t.Any]], click.Command]:
        """This works exactly like the method of the same name on a regular
        click :class:`~click.Group` but it wraps callbacks in :func:`with_appcontext`
        unless it's disabled by passing ``with_appcontext=False``.
        """
        wrap_for_ctx = kwargs.pop("with_appcontext", True)

        def decorator(f: t.Callable[..., t.Any]) -> click.Command:
            if wrap_for_ctx:
                f = with_appcontext(f)
            return super(AppGroup, self).command(*args, **kwargs)(f)  # type: ignore[no-any-return]

        return decorator

    def group(  # type: ignore[override]
        self, *args: t.Any, **kwargs: t.Any
    ) -> t.Callable[[t.Callable[..., t.Any]], click.Group]:
        """This works exactly like the method of the same name on a regular
        click :class:`~click.Group` but it defaults the group class to
        :class:`AppGroup`.
        """
        kwargs.setdefault("cls", AppGroup)
        return super().group(*args, **kwargs)  # type: ignore[no-any-return]
```

And the parallel path for the top-level `flask` command group — `FlaskGroup.get_command` (`src/flask/cli.py:609-634`):

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

The Click plumbing used here (`click/core.py`):

```python
    def find_object(self, object_type: type[V]) -> V | None:
        """Finds the closest object of a given type."""
        node: Context | None = self

        while node is not None:
            if isinstance(node.obj, object_type):
                return node.obj

            node = node.parent

        return None

    def ensure_object(self, object_type: type[V]) -> V:
        """Like :meth:`find_object` but sets the innermost object to a
        new instance of `object_type` if it does not exist.
        """
        rv = self.find_object(object_type)
        if rv is None:
            self.obj = rv = object_type()
        return rv
```

```python
    def with_resource(self, context_manager: AbstractContextManager[V]) -> V:
        """Register a resource as if it were used in a ``with``
        statement. The resource will be cleaned up when the context is
        popped.
        ...
        """
        return self._exit_stack.enter_context(context_manager)
```

And the `AppContext` that gets pushed (`src/flask/ctx.py:238-284`):

```python
class AppContext:
    """The app context contains application-specific information. An app
    context is created and pushed at the beginning of each request if
    one is not already active. An app context is also pushed when
    running CLI commands.
    """
    ...
    def __enter__(self) -> AppContext:
        self.push()
        return self
```

### The `FLASK_RUN_FROM_CLI` guard

`FlaskGroup.make_context` (`src/flask/cli.py:657-676`; the `os.environ` assignment is at line **667** in this tree):

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

which makes `Flask.run` return early (`src/flask/app.py:609-621`):

```python
        # Ignore this call so that it doesn't start another server if
        # the 'flask run' command is used.
        if os.environ.get("FLASK_RUN_FROM_CLI") == "true":
            if not is_running_from_reloader():
                click.secho(
                    " * Ignoring a call to 'app.run()' that would block"
                    " the current 'flask' CLI command.\n"
                    "   Only call 'app.run()' in an 'if __name__ =="
                    ' "__main__"\' guard.',
                    fg="red",
                )

            return
```

### The documented statement of the same chain

`docs/testing.rst:243-256`:

```rst
.. _testing-cli:

Running Commands with the CLI Runner
------------------------------------

Flask provides :meth:`~flask.Flask.test_cli_runner` to create a
:class:`~flask.testing.FlaskCliRunner`, which runs CLI commands in
isolation and captures the output in a :class:`~click.testing.Result`
object. Flask's runner extends :doc:`Click's runner <click:testing>`,
see those docs for additional information.

Use the runner's :meth:`~flask.testing.FlaskCliRunner.invoke` method to
call commands in the same way they would be called with the ``flask``
command from the command line.
```

---

## Empirical verification (commands and outputs, verbatim)

Environment: the plan's literal `python -m pytest` does **not** work here. `python` on `PATH` is 3.14.0 with no `flask`:

```
$ python -c "import sys; print(sys.version)"; python -c "import flask; print(flask.__file__)"
3.14.0 (tags/v3.14.0:ebf955d, Oct  7 2025, 10:15:03) [MSC v.1944 64 bit (AMD64)]
Traceback (most recent call last):
  File "<string>", line 1, in <module>
  import flask; print(flask.__file__); print(flask.__version__)
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ModuleNotFoundError: No module named 'flask'
```

The project virtualenv is `.venv/Scripts/python.exe` (3.13.9), and all CLI suites were run with it:

```
$ .venv/Scripts/python.exe -c "import sys; print(sys.version); print(sys.executable)"
3.13.9 (main, Oct 14 2025, 21:22:32) [MSC v.1944 64 bit (AMD64)]
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q4-TXT\seal\.venv\Scripts\python.exe
EXIT_CODE=0
```

**Caveat observed:** the venv's `flask.pth` points at a *different* checkout, not this working tree:

```
$ cat .venv/Lib/site-packages/flask.pth
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\f2f45b5b\q1-TXT\seal\src
$ .venv/Scripts/python.exe -c "import flask; print(flask.__file__)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\f2f45b5b\q1-TXT\seal\src\flask\__init__.py
```

However `src/` and `tests/` are byte-identical between the two paths, and forcing `PYTHONPATH` at this tree gives the same result:

```
$ diff -rq src "C:/Users/oobbee/AppData/Local/Temp/pi-p50o/f2f45b5b/q1-TXT/seal/src"; echo "diff src exit: $?"
diff src exit: 0
$ diff -rq tests "C:/Users/oobbee/AppData/Local/Temp/pi-p50o/f2f45b5b/q1-TXT/seal/tests"; echo "diff tests exit: $?"
diff tests exit: 0
```
```
$ PYTHONPATH=".../920457b8/q4-TXT/seal/src" .venv/Scripts/python.exe -m pytest tests/test_cli.py tests/test_testing.py -q
EXIT_CODE=0
........................................................................ [ 86%]
...........                                                              [100%]
83 passed in 0.81s
```

### Step 2 — constructor link (Flask → `FlaskCliRunner` → `CliRunner`)

```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py::test_cli_runner_class tests/test_testing.py::test_cli_invoke -q
EXIT_CODE=0
..                                                                       [100%]
2 passed in 0.04s
```

### Step 3 — `ScriptInfo`/`load_app` link (identity + memoization)

```
$ .venv/Scripts/python.exe -m pytest tests/test_cli.py::test_scriptinfo tests/test_testing.py::test_cli_custom_obj -q
EXIT_CODE=0
..                                                                       [100%]
2 passed in 0.09s
```

### Step 4 — app-context link and the `FLASK_RUN_FROM_CLI` flag

```
$ .venv/Scripts/python.exe -m pytest "tests/test_cli.py::test_app_cli_has_app_context" "tests/test_cli.py::test_with_appcontext" "tests/test_cli.py::test_appgroup_app_context" "tests/test_cli.py::test_flaskgroup_app_context" "tests/test_cli.py::test_flaskgroup_nested" -q
EXIT_CODE=0
.....                                                                    [100%]
5 passed in 0.16s
```

### Step 5 — broader CLI suites (isolation proof)

```
$ .venv/Scripts/python.exe -m pytest tests/test_cli.py tests/test_testing.py -q
EXIT_CODE=0
........................................................................ [ 86%]
...........                                                              [100%]
83 passed in 0.73s
```

Verbose re-run (all items PASSED):

```
$ .venv/Scripts/python.exe -m pytest tests/test_cli.py tests/test_testing.py -vv -ra
EXIT_CODE=0
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q4-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q4-TXT\seal
configfile: pyproject.toml
collecting ... collected 83 items

tests/test_cli.py::test_scriptinfo <- ...\tests\test_cli.py PASSED [ 37%]
tests/test_cli.py::test_app_cli_has_app_context <- ...\tests\test_cli.py PASSED [ 38%]
tests/test_cli.py::test_with_appcontext <- ...\tests\test_cli.py PASSED [ 39%]
tests/test_cli.py::test_appgroup_app_context <- ...\tests\test_cli.py PASSED [ 40%]
tests/test_cli.py::test_flaskgroup_app_context <- ...\tests\test_cli.py PASSED [ 42%]
tests/test_cli.py::test_flaskgroup_nested <- ...\tests\test_cli.py PASSED [ 45%]
tests/test_cli.py::test_cli_blueprints <- ...\tests\test_cli.py PASSED [ 67%]
tests/test_cli.py::test_cli_empty <- ...\tests\test_cli.py PASSED [ 68%]
tests/test_testing.py::test_cli_runner_class <- ...\tests\test_testing.py PASSED [ 96%]
tests/test_testing.py::test_cli_invoke <- ...\tests\test_testing.py PASSED [ 97%]
tests/test_testing.py::test_cli_custom_obj <- ...\tests\test_testing.py PASSED [ 98%]
tests/test_testing.py::test_client_pop_all_preserved <- ...\tests\test_testing.py PASSED [100%]

============================= 83 passed in 0.78s ==============================
```

Full `tests/` directory:

```
$ .venv/Scripts/python.exe -m pytest tests/
EXIT_CODE=0
... collected 489 items ...
============================= 489 passed in 2.38s ==============================

$ .venv/Scripts/python.exe -m pytest tests/ -vv -ra
EXIT_CODE=0
... collected 489 items ... every item PASSED ...
============================= 489 passed in 3.06s ==============================
```

### Per-claim probes (one command per claim)

`app.cli` is `AppGroup`; `test_cli_runner()` returns a `FlaskCliRunner` that **is** a `CliRunner`; override honoured:

```
$ PYTHONPATH=".../seal/src" .venv/Scripts/python.exe -c "..."
flask.__file__ = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q4-TXT\seal\src\flask\__init__.py
click.__file__  = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\920457b8\q4-TXT\seal\.venv\Lib\site-packages\click\testing.py
app.cli type            = <class 'flask.cli.AppGroup'>
app.cli is AppGroup     = True
runner type             = <class 'flask.testing.FlaskCliRunner'>
runner is FlaskCliRunner= True
runner is CliRunner     = True
runner.app is app       = True
override honored        = True
EXIT_CODE=0
```

Injected `obj` is `ScriptInfo`; `load_app()` returns the **same** app; memoized; `current_app` is that same app:

```
$ PYTHONPATH=".../seal/src" .venv/Scripts/python.exe -c "..."
--- result.output ---
obj_type=ScriptInfo
obj_is_scriptinfo=True
load_app_is_app=True
load_app_memoized=True
current_app_is_app=True

--- exit_code: 0
EXIT_CODE=0
```

Click isolation swaps and restores stdio/env; `Result` captures the streams:

```
$ PYTHONPATH=".../seal/src" .venv/Scripts/python.exe -c "..."
--- res.output repr ---
'inside: stdout is sys.__stdout__ = False\ninside: stdout.name = <stdout>\ninside: env FLASK_PROBE = injected\ninside: stderr-line\n'
--- res.stdout repr ---
'inside: stdout is sys.__stdout__ = False\ninside: stdout.name = <stdout>\ninside: env FLASK_PROBE = injected\n'
--- res.stderr repr ---
'inside: stderr-line\n'
--- exit_code: 0
stdout restored  : True
env restored     : True (now None )
EXIT_CODE=0
```

`FLASK_RUN_FROM_CLI` (two variants):

```
### G1: FlaskGroup.make_context path
inside FlaskGroup cmd: FLASK_RUN_FROM_CLI='true'
exit_code: 0
EXIT_CODE=0

### G2: app.test_cli_runner() / app.cli (AppGroup) path
inside app.cli cmd: FLASK_RUN_FROM_CLI=None
exit_code: 0
EXIT_CODE=0
```

### Source-line anchors confirmed by grep in this tree

```
src/flask/app.py:727  def test_cli_runner
src/flask/app.py:256  self.cli = cli.AppGroup()
src/flask/app.py:742  return cls(self, **kwargs)
src/flask/sansio/app.py:277  test_cli_runner_class: type[FlaskCliRunner] | None = None
src/flask/testing.py:265  class FlaskCliRunner(CliRunner):
src/flask/testing.py:295  if "obj" not in kwargs:
src/flask/testing.py:296      kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)
src/flask/testing.py:298  return super().invoke(cli, args, **kwargs)
src/flask/cli.py:333   def load_app
src/flask/cli.py:371   self._loaded_app = app
src/flask/cli.py:380   def with_appcontext
src/flask/cli.py:397   app = ctx.ensure_object(ScriptInfo).load_app()
src/flask/cli.py:667   os.environ["FLASK_RUN_FROM_CLI"] = "true"
src/flask/cli.py:609   def get_command
src/flask/cli.py:405   class AppGroup(click.Group):
src/flask/cli.py:531   class FlaskGroup(AppGroup):
.venv/.../click/testing.py:480  with self.isolation(input=input, env=env, color=color) as outstreams:
.venv/.../click/testing.py:494  return_value = cli.main(args=args or (), prog_name=prog_name, **extra)
EXIT_CODE=0
```

### Tests that pin the chain (verbatim)

`tests/test_testing.py`:

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

`tests/test_cli.py::test_scriptinfo` (identity + memoization):

```python
def test_scriptinfo(test_apps, monkeypatch):
    obj = ScriptInfo(app_import_path="cliapp.app:testapp")
    app = obj.load_app()
    assert app.name == "testapp"
    assert obj.load_app() is app
    ...
    def create_app():
        return Flask("createapp")

    obj = ScriptInfo(create_app=create_app)
    app = obj.load_app()
    assert app.name == "createapp"
    assert obj.load_app() is app
    ...
```

`tests/test_cli.py::test_app_cli_has_app_context` (the identity assertion across the two sides of the chain):

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

`tests/conftest.py` supplies the `app` fixture (`Flask("flask_test", root_path=...)`) and the autouse `leak_detector`:

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app
...
@pytest.fixture(autouse=True)
def leak_detector():
    yield

    # make sure we're not leaking a request context since we are
    # testing flask internally in debug mode in a few cases
    leaks = []
    while request_ctx:
        leaks.append(request_ctx._get_current_object())
        request_ctx.pop()

    assert leaks == []
```

---

## Cross-check of the least-obvious link (the injected `obj`)

Two subtle points the answer must not lose, both confirmed against the code and against `test_cli_custom_obj` / `test_app_cli_has_app_context`:

1. **The injected `obj` is a `ScriptInfo` whose `create_app=lambda: self.app` *captures the test-app instance*** — it does not re-import or re-discover anything. The lambda closes over the `runner.app` reference set in `FlaskCliRunner.__init__` (`self.app = app`), and `ScriptInfo.load_app` short-circuits to `app = self.create_app()` because `self.create_app is not None`. Hence identity is preserved (`load_app_is_app=True`) and no `prepare_import`/`locate_app` work happens. `test_scriptinfo`'s `assert obj.load_app() is app` and `test_cli_custom_obj` (which injects its own `ScriptInfo(create_app=create_app)` and checks `NS.called` became `True`) both pin this.
2. **The context is only pushed `if not current_app` / `if not current_app or current_app._get_current_object() is not app`.** `with_appcontext` guards with `if not current_app:` and `FlaskGroup.get_command` with `current_app._get_current_object() is not app`, so a pre-existing active context inside the isolated invocation is **not** double-pushed. The `runner.invoke(..., obj=script_info)` guard `if "obj" not in kwargs` likewise defers to the caller — a caller-supplied `obj` is never overwritten.

This is exactly why `test_app_cli_has_app_context` can assert `result.return_value == (True, True)`: the app produced by `ctx.ensure_object(ScriptInfo).load_app()` and the `current_app` inside the command are the same object.

---

## Divergences, caveats, and things that are *not* part of the chain

1. **Environment: the plan's literal command fails.** `python -m pytest` uses Python 3.14.0 with no `flask` (`ModuleNotFoundError: No module named 'flask'`). Only `.venv/Scripts/python.exe` (3.13.9) works.
2. **`flask.pth` targets a different checkout** (`...\f2f45b5b\q1-TXT\seal\src`), not this tree's `src/`. `src/` and `tests/` are byte-identical (`diff -rq` exit 0 both), and forcing `PYTHONPATH` at this tree's `src` also yields `83 passed`, so the results reflect this tree's code. The working directory is additionally a junction to `D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src`.
3. **Line-number offsets vs the plan's quoted ranges** (content is intact): `def with_appcontext` is at line **380** (plan said 378), `self._loaded_app = app` at **371** (plan said 369), `os.environ["FLASK_RUN_FROM_CLI"] = "true"` at **667** (plan said 665). All quoted code matches; only the numbers shift.
4. **`FLASK_RUN_FROM_CLI` is NOT set on the `app.test_cli_runner()` path.** It is set by `FlaskGroup.make_context` (verified: the `FlaskGroup` command printed `'true'`), but invoking `app.cli` through `app.test_cli_runner()` printed `None`, because that path uses `AppGroup`'s inherited `make_context`. So the "`app.run()` is a no-op" guarantee applies to the top-level `flask`/`FlaskGroup` command path, **not** to the bare `app.cli` runner path. Isolation on the `app.test_cli_runner()` path still holds — it comes from the base Click runner, not from this flag.
5. **Isolation is two complementary layers.** Click's `CliRunner.isolation`/`invoke` isolates stdio + `os.environ` and captures output into `click.testing.Result`; Flask's `AppContext` (pushed via `ctx.with_resource(app.app_context())`) isolates the app/request-context globals, with `tests/conftest.py::leak_detector` additionally asserting no request context leaks after each test. Do not conflate the two. Also note Click here is **8.2.1** (`mix_stderr` removed) with **Python 3.13**: use `result.output`/`result.stdout`/`result.stderr`, as `tests/test_cli.py::test_no_command_echo_loading_error` does:
   ```python
   try:
       runner = CliRunner(mix_stderr=False)
   except (DeprecationWarning, TypeError):
       # Click >= 8.2
       runner = CliRunner()
   ```
6. **The red herring should not drive the answer.** `flask_mut2_i417ar2x/mutated_test.py` is an unrelated subdomain/`url_for` repro and is recorded as failing in `.pytest_cache/v/cache/lastfailed`:

   ```json
   {
     "examples/javascript/tests": true,
     "examples/tutorial/tests": true,
     "flask_mut2_i417ar2x/mutated_test.py": true
   }
   ```
   Its full content is a `Flask(__name__, subdomain_matching=False)` + `url_for` + test-client repro; it imports neither `flask.cli` nor `flask.testing`, is outside `testpaths = ["tests"]`, and does not alter links 1–6. `git status --porcelain` shows it as the only untracked change; the four CLI-path source files are unmodified relative to HEAD (`git diff --stat` over `src/flask/app.py src/flask/sansio/app.py src/flask/testing.py src/flask/cli.py` is empty; HEAD is the detached commit `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`). No CLI failure was observed anywhere.

---

## One-line dependency order (the answer in compact form)

`Flask` instance (`app.cli = AppGroup`) → `Flask.test_cli_runner()` reads `test_cli_runner_class` (default `FlaskCliRunner`) and calls `cls(self, **kwargs)` → `FlaskCliRunner(app)` sets `self.app = app`, `super().__init__()` into **`click.testing.CliRunner`** → `FlaskCliRunner.invoke` defaults `cli = self.app.cli` and injects `obj=ScriptInfo(create_app=lambda: self.app)` → `CliRunner.invoke` runs inside `with self.isolation(...)` and forwards `**extra` to `cli.main(...)` → `Command.make_context` → `Context(obj=ScriptInfo)` → the command body / `AppGroup.command`'s `with_appcontext` calls `ctx.ensure_object(ScriptInfo).load_app()`, returning the identical, memoized app, and pushes `ctx.with_resource(app.app_context())` only `if not current_app`. Isolation = the base Click runner; app availability and identity = `ScriptInfo` + the captured `self.app`.
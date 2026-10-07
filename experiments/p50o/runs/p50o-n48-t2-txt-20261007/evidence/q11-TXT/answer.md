# Why `ScriptInfo` provides both a callable `create_app` parameter and a string `app_import_path` parameter

## Short answer

`ScriptInfo` has exactly one job — `load_app()` must return *a* `Flask` instance — but it is reached by two completely different callers that know different things about the application:

* The **generic `flask` command** is a console script installed by Flask, not by the user's project (`flask = "flask.cli:main"`). It has never imported the user's code at the moment the group is built, so all it can carry is a **string** (`--app` / `FLASK_APP` / auto-detected `wsgi.py`/`app.py`). That string must then be resolved with import machinery: `prepare_import` → `locate_app` → `find_best_app` / `find_app_by_string`.
* A **custom script** written with `FlaskGroup(create_app=...)` has the factory function **already imported and in hand** — it is the program the user installed. Passing a callable is a direct programmatic call, skipping all string parsing, `sys.path` manipulation and import heuristics.

So the two parameters are two *sources* for the same single application object, and the class accepts both because its two clients supply different kinds of information. They are not competing mechanisms: `load_app` checks them in a fixed order, so an explicitly supplied factory always wins and the string is a fallback.

---

## 1. The class itself — the exact code under question

`src/flask/cli.py` lines 293–373 (verbatim):

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

Four structural facts follow directly from this code and drive the entire answer:

1. `create_app` is tested **first**: `if self.create_app is not None: app = self.create_app()`. `app_import_path` is only consulted in the `else` branch.
2. The callable is invoked with **zero arguments** (`app = self.create_app()`, line 342).
3. `app_import_path` is resolved by the string→app pipeline: split on `:` (not preceded by `\` or `/`), then `prepare_import(path)` → `locate_app(import_name, name)`.
4. With neither parameter, `load_app` falls through to auto-detecting `wsgi.py` then `app.py`.

The result is memoized in `self._loaded_app`, so repeated calls return the identical object.

---

## 2. Who fills in `app_import_path` — the generic `flask` command

The shipped `flask` command is a plain `FlaskGroup` built with **no** factory, `src/flask/cli.py` lines 1110–1125:

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


if __name__ == "__main__":
    main()
```

and it is wired to the console script in `pyproject.toml`:

```toml
[project.scripts]
flask = "flask.cli:main"
```

Because this group holds no `create_app`, the only channel open to it is the string. The `--app` option callback fills `app_import_path` on the shared `ScriptInfo` object — `src/flask/cli.py` lines 440–465:

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

Note the mechanism precisely: `--app` does **not** construct a `ScriptInfo`; it retrieves the one `make_context` already installed (`ctx.ensure_object(ScriptInfo)`) and mutates its string field. The callable field is populated at context-creation time, the string field at option-parse time — same object, two phases.

What that string then has to support is a lot of variation, which is why the resolution machinery exists (`docs/cli.rst` lines 1–62, "Application Discovery"):

```
The ``flask`` command is installed by Flask, not your application; it must be
told where to find your application in order to use it. The ``--app``
option is used to specify how to load the application.
...
``--app src/hello``
    Sets the current working directory to ``src`` then imports ``hello``.

``--app hello.web``
    Imports the path ``hello.web``.

``--app hello:app2``
    Uses the ``app2`` Flask instance in ``hello``.

``--app 'hello:create_app("dev")'``
    The ``create_app`` factory in ``hello`` is called with the string ``'dev'``
    as the argument.

If ``--app`` is not set, the command will try to import "app" or
"wsgi" (as a ".py" file, or package) and try to detect an application
instance or factory.
...
If parentheses follow the factory name, their contents are parsed as
Python literals and passed as arguments and keyword arguments to the
function. This means that strings must still be in quotes.
```

The pyproject docstring is explicit that this string route — not the callable — is the *primary* interface of the generic command: *"An application to load must be given with the '--app' option, 'FLASK_APP' environment variable, or with a 'wsgi.py' or 'app.py' file in the current directory."*

### The string→app machinery the import path depends on

`prepare_import` (lines 200–228) turns a file path into a module name and mutates `sys.path`:

```python
def prepare_import(path: str) -> str:
    """Given a filename this will try to calculate the python path, add it
    to the search path and return the actual module name that is expected.
    """
    path = os.path.realpath(path)

    fname, ext = os.path.splitext(path)
    if ext == ".py":
        path = fname

    if os.path.basename(path) == "__init__":
        path = os.path.dirname(path)

    module_name = []

    # move up until outside package structure (no __init__.py)
    while True:
        path, name = os.path.split(path)
        module_name.append(name)

        if not os.path.exists(os.path.join(path, "__init__.py")):
            break

    if sys.path[0] != path:
        sys.path.insert(0, path)

    return ".".join(module_name[::-1])
```

`locate_app` (lines 241–265) imports the module and dispatches on whether a name was given:

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

`find_best_app` (lines 41–92) implements the heuristics — look for `app`/`application`, then any lone `Flask`, then a module-level `create_app`/`make_app` function:

```python
def find_best_app(module: ModuleType) -> Flask:
    """Given a module instance this tries to find the best possible
    application in the module or raises an exception.
    """
    from . import Flask

    # Search for the most common names first.
    for attr_name in ("app", "application"):
        app = getattr(module, attr_name, None)

        if isinstance(app, Flask):
            return app

    # Otherwise find the only object that is a Flask instance.
    matches = [v for v in module.__dict__.values() if isinstance(v, Flask)]

    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        raise NoAppException(
            "Detected multiple Flask applications in module"
            f" '{module.__name__}'. Use '{module.__name__}:name'"
            " to specify the correct one."
        )

    # Search for app factory functions.
    for attr_name in ("create_app", "make_app"):
        app_factory = getattr(module, attr_name, None)

        if inspect.isfunction(app_factory):
            try:
                app = app_factory()

                if isinstance(app, Flask):
                    return app
            except TypeError as e:
                if not _called_with_wrong_args(app_factory):
                    raise

                raise NoAppException(
                    f"Detected factory '{attr_name}' in module '{module.__name__}',"
                    " but could not call it without arguments. Use"
                    f" '{module.__name__}:{attr_name}(args)'"
                    " to specify arguments."
                ) from e

    raise NoAppException(
        "Failed to find Flask application or factory in module"
        f" '{module.__name__}'. Use '{module.__name__}:name'"
        " to specify one."
    )
```

`find_app_by_string` (lines 120–198) parses `"module:name(args)"` with `ast` and calls the factory with literal arguments:

```python
def find_app_by_string(module: ModuleType, app_name: str) -> Flask:
    """Check if the given string is a variable name or a function. Call
    a function to get the app instance, or return the variable directly.
    """
    from . import Flask

    # Parse app_name as a single expression to determine if it's a valid
    # attribute name or function call.
    try:
        expr = ast.parse(app_name.strip(), mode="eval").body
    except SyntaxError:
        raise NoAppException(
            f"Failed to parse {app_name!r} as an attribute name or function call."
        ) from None

    if isinstance(expr, ast.Name):
        name = expr.id
        args = []
        kwargs = {}
    elif isinstance(expr, ast.Call):
        # Ensure the function name is an attribute name only.
        if not isinstance(expr.func, ast.Name):
            raise NoAppException(
                f"Function reference must be a simple name: {app_name!r}."
            )

        name = expr.func.id

        # Parse the positional and keyword arguments as literals.
        try:
            args = [ast.literal_eval(arg) for arg in expr.args]
            kwargs = {
                kw.arg: ast.literal_eval(kw.value)
                for kw in expr.keywords
                if kw.arg is not None
            }
        except ValueError:
            # literal_eval gives cryptic error messages, show a generic
            # message with the full expression instead.
            raise NoAppException(
                f"Failed to parse arguments as literal values: {app_name!r}."
            ) from None
    else:
        raise NoAppException(
            f"Failed to parse {app_name!r} as an attribute name or function call."
        )

    try:
        attr = getattr(module, name)
    except AttributeError as e:
        raise NoAppException(
            f"Failed to find attribute {name!r} in {module.__name__!r}."
        ) from e

    # If the attribute is a function, call it with any args and kwargs
    # to get the real application.
    if inspect.isfunction(attr):
        try:
            app = attr(*args, **kwargs)
        except TypeError as e:
            if not _called_with_wrong_args(attr):
                raise

            raise NoAppException(
                f"The factory {app_name!r} in module"
                f" {module.__name__!r} could not be called with the"
                " specified arguments."
            ) from e
    else:
        app = attr

    if isinstance(app, Flask):
        return app

    raise NoAppException(
        "A valid Flask application was not obtained from"
        f" '{module.__name__}:{app_name}'."
    )
```

**This — `sys.path` mutation, realpath resolution, package walking, `ast` parsing of the `module:name(args)` string — is precisely what the callable parameter exists to bypass.** A caller who already holds the factory needs none of it.

---

## 3. Who fills in `create_app` — `FlaskGroup(create_app=...)` and the custom script

`FlaskGroup` accepts the callable in its constructor and stores it (`src/flask/cli.py` lines 531–598):

```python
class FlaskGroup(AppGroup):
    """Special subclass of the :class:`AppGroup` group that supports
    loading more commands from the configured Flask app.  Normally a
    developer does not have to interface with this class but there are
    some very advanced use cases for which it makes sense to create an
    instance of this. see :ref:`custom-scripts`.

    :param add_default_commands: if this is True then the default run and
        shell commands will be added.
    :param add_version_option: adds the ``--version`` option.
    :param create_app: an optional callback that is passed the script info and
        returns the loaded app.
    :param load_dotenv: Load the nearest :file:`.env` and :file:`.flaskenv`
        files to set environment variables. Will also change the working
        directory to the directory containing the first file found.
    :param set_debug_flag: Set the app's debug flag.

    .. versionchanged:: 3.1
        ``-e path`` takes precedence over default ``.env`` and ``.flaskenv`` files.

    .. versionchanged:: 2.2
        Added the ``-A/--app``, ``--debug/--no-debug``, ``-e/--env-file`` options.

    .. versionchanged:: 2.2
        An app context is pushed when running ``app.cli`` commands, so
        ``@with_appcontext`` is no longer required for those commands.

    .. versionchanged:: 1.0
        If installed, python-dotenv will be used to load environment variables
        from :file:`.env` and :file:`.flaskenv` files.
    """

    def __init__(
        self,
        add_default_commands: bool = True,
        create_app: t.Callable[..., Flask] | None = None,
        add_version_option: bool = True,
        load_dotenv: bool = True,
        set_debug_flag: bool = True,
        **extra: t.Any,
    ) -> None:
        params: list[click.Parameter] = list(extra.pop("params", None) or ())
        # Processing is done with option callbacks instead of a group
        # callback. This allows users to make a custom group callback
        # without losing the behavior. --env-file must come first so
        # that it is eagerly evaluated before --app.
        params.extend((_env_file_option, _app_option, _debug_option))

        if add_version_option:
            params.append(version_option)

        if "context_settings" not in extra:
            extra["context_settings"] = {}

        extra["context_settings"].setdefault("auto_envvar_prefix", "FLASK")

        super().__init__(params=params, **extra)

        self.create_app = create_app
        self.load_dotenv = load_dotenv
        self.set_debug_flag = set_debug_flag

        if add_default_commands:
            self.add_command(run_command)
            self.add_command(shell_command)
            self.add_command(routes_command)

        self._loaded_plugin_commands = False
```

The hand-off happens in `make_context` (lines 657–689) — and note it passes **only** `create_app=`, never `app_import_path=`:

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

Thus a custom script creates the `ScriptInfo` with the callable already attached; the `--app` option still exists on the group (it is added unconditionally to `params`), but its callback runs later and simply overwrites the *string* field, which the branch order then ignores when a factory is present.

Both paths converge on `info.load_app()`, e.g. `FlaskGroup.get_command` (lines 609–635):

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

There is also a third, library-internal user of the callable route — the test runner, `src/flask/testing.py`:

```python
        if cli is None:
            cli = self.app.cli

        if "obj" not in kwargs:
            kwargs["obj"] = ScriptInfo(create_app=lambda: self.app)

        return super().invoke(cli, args, **kwargs)
```

The runner *already has the app object in hand* (`self.app`), so string parsing would be pointless and fragile; it uses `create_app=lambda: self.app`.

---

## 4. Precedence — why having both is composable rather than contradictory

The lookup order in `load_app` gives a strict precedence chain:

1. `if self.create_app is not None: app = self.create_app()` — an explicitly supplied factory **always wins**;
2. `elif self.app_import_path:` — the `--app`/`FLASK_APP` string, resolved via `prepare_import` → `locate_app`;
3. `else:` auto-detect `wsgi.py` then `app.py`.

The relevant block, verbatim from `load_app`:

```python
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
```

If the parameters conflicted, supplying both would be an error; instead the later, more explicit source is simply preferred. The design therefore lets a custom script keep the whole `--app` option surface (users can still override from the command line in principle) while the programmatic factory short-circuits it. Evidence of this was reproduced directly:

```
=== (c) precedence: both supplied, create_app must win ===
c.app.name: 'wins'
c.app_import_path (still set, but ignored) cliapp.app:testapp
```

and, with neither supplied, the auto-detect fallback still fires:

```
=== (c2) auto-detection last resort: neither supplied ===
c2.wsgi_autodetect.name: 'hello'
```

---

## 5. The documented rationale for the callable route

`docs/cli.rst`, "Custom Scripts" lines 471–518 — this is the repository's own statement of why the callable parameter exists, and it frames it exactly as a convenience alternative to the string route:

```
.. _custom-scripts:

Custom Scripts
--------------

When you are using the app factory pattern, it may be more convenient to define
your own Click script. Instead of using ``--app`` and letting Flask load
your application, you can create your own Click object and export it as a
`console script`_ entry point.

Create an instance of :class:`~cli.FlaskGroup` and pass it the factory::

    import click
    from flask import Flask
    from flask.cli import FlaskGroup

    def create_app():
        app = Flask('wiki')
        # other setup
        return app

    @click.group(cls=FlaskGroup, create_app=create_app)
    def cli():
        """Management script for the Wiki application."""

Define the entry point in :file:`pyproject.toml`:

.. code-block:: toml

    [project.scripts]
    wiki = "wiki:cli"

Install the application in the virtualenv in editable mode and the custom
script is available. Note that you don't need to set ``--app``. ::

    $ pip install -e .
    $ wiki run

.. admonition:: Errors in Custom Scripts

    When using a custom script, if you introduce an error in your
    module-level code, the reloader will fail because it can no longer
    load the entry point.

    The ``flask`` command, being separate from your code, does not have
    this issue and is recommended in most cases.
```

Three points in that passage map directly onto the code:

* **"Instead of using `--app` and letting Flask load your application"** — the callable bypasses `find_best_app`/`find_app_by_string`.
* **"pass it the factory"** — `FlaskGroup.__init__` stores it as `self.create_app` and `make_context` hands it to `ScriptInfo(create_app=...)`.
* **"Note that you don't need to set `--app`"** — because the callable branch is checked first, no string is needed; the string is the *other* route.
* The admonition explains why the *string* route remains the recommended default: the `flask` command is a separate installed script, so an error in the user's module-level code cannot break the loader entry point — whereas a custom script is part of that code. This is the flip side of the same design decision: the generic command's ignorance of the user's code (why it needs a string) is also its robustness advantage.

The API reference confirms the intended usage surface, `docs/api.rst` lines 690–715:

```
Command Line Interface
----------------------

.. currentmodule:: flask.cli

.. autoclass:: FlaskGroup
   :members:

.. autoclass:: AppGroup
   :members:

.. autoclass:: ScriptInfo
   :members:

.. autofunction:: load_dotenv

.. autofunction:: with_appcontext

.. autofunction:: pass_script_info

   Marks a function so that an instance of :class:`ScriptInfo` is passed
   as first argument to the click callback.

.. autodata:: run_command
```

with `pass_script_info` defined next to the class (line 375):

```python
pass_script_info = click.make_pass_decorator(ScriptInfo, ensure=True)
```

and consumed by `run_command` (lines 934–982), which mixes both worlds — it is reached through either mechanism but displays the string when there is one:

```python
@pass_script_info
def run_command(
    info: ScriptInfo,
    host: str,
    port: int,
    reload: bool,
    debugger: bool,
    with_threads: bool,
    cert: ssl.SSLContext | tuple[str, str | None] | t.Literal["adhoc"] | None,
    extra_files: list[str] | None,
    exclude_patterns: list[str] | None,
) -> None:
    """Run a local development server.

    This server is for development purposes only. It does not provide
    the stability, security, or performance of production WSGI servers.

    The reloader and debugger are enabled by default with the '--debug'
    option.
    """
    try:
        app: WSGIApplication = info.load_app()  # pyright: ignore
    except Exception as e:
        ...
```

with line 981 `show_server_banner(debug, info.app_import_path)` and (lines 766–778):

```python
def show_server_banner(debug: bool, app_import_path: str | None) -> None:
    """Show extra startup messages the first time the server is run,
    ignoring the reloader.
    """
    if is_running_from_reloader():
        return

    if app_import_path is not None:
        click.echo(f" * Serving Flask app '{app_import_path}'")

    if debug is not None:
        click.echo(f" * Debug mode: {'on' if debug else 'off'}")
```

---

## 6. Tests that pin both mechanisms — and their outputs

`tests/test_cli.py` lines 248–287 (`test_scriptinfo`) exercises *both* mechanisms plus the auto-detect fallback in a single function:

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

The factory it uses is `def create_app(): return Flask("createapp")` — a **zero-argument** factory, matching `app = self.create_app()`.

The canonical end-to-end custom-script usage, `tests/test_cli.py` lines 348–358:

```python
def test_flaskgroup_app_context(runner):
    def create_app():
        return Flask("flaskgroup")

    @click.group(cls=FlaskGroup, create_app=create_app)
    def cli(**params):
        pass

    @cli.command()
    def test():
        click.echo(current_app.name)

    result = runner.invoke(cli, ["test"])
    assert result.exit_code == 0
    assert result.output == "flaskgroup\n"
```

Other consumers of the callable route: `test_flaskgroup_debug` (`@click.group(cls=FlaskGroup, create_app=create_app, set_debug_flag=set_debug_flag)`), `test_flaskgroup_nested` (`FlaskGroup(name="flask", create_app=lambda: app)`), `TestRoutes`' `invoke` fixture (`cli = FlaskGroup(create_app=lambda: app)`), `test_with_appcontext` / `test_appgroup_app_context` (`obj = ScriptInfo(create_app=lambda: Flask("testapp"))`), `test_help_echo_exception` (`cli = FlaskGroup(create_app=create_app)` where the factory raises), `tests/test_testing.py::test_cli_custom_obj` (`script_info = ScriptInfo(create_app=create_app)`), and — in the library itself — `FlaskCliRunner.invoke`.

The fixture these depend on, `tests/conftest.py` lines 71–81:

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

Sample apps: `tests/test_apps/cliapp/app.py` is `testapp = Flask("testapp")`; `tests/test_apps/helloworld/hello.py` holds `app = Flask(__name__)`; `tests/test_apps/helloworld/wsgi.py` is `from hello import app  # noqa: F401` (the auto-detection target).

### Executed verification (full output)

```
$ uv run pytest tests/test_cli.py::test_scriptinfo tests/test_cli.py::test_flaskgroup_app_context tests/test_cli.py::TestRoutes -q
   Building flask @ file:///C:/Users/oobbee/AppData/Local/Temp/pi-p50o/2335aa4c/q11-TXT/seal
      Built flask @ file:///C:/Users/oobbee/AppData/Local/Temp/pi-p50o/2335aa4c/q11-TXT/seal
Uninstalled 1 package in 14ms
Installed 1 package in 63ms
........                                                                 [100%]
8 passed in 0.36s
EXIT=0
```

```
$ uv run pytest -q
........................................................................ [ 14%]
........................................................................ [ 29%]
........................................................................ [ 44%]
........................................................................ [ 58%]
........................................................................ [ 73%]
........................................................................ [ 88%]
.........................................................                [100%]
489 passed in 5.07s
EXIT=0
```

Both mechanisms, reproduced side by side with a scratch script (`scratch_step3/probe_scriptinfo.py`, untracked; no tracked source file modified):

```
=== (a) direct callable factory ===
a.app.name: 'from-callable'
a.memoized_identity: True

=== (b) import-path string (sys.path mirrors tests/test_apps fixture) ===
b.sys.path[0] C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q11-TXT\seal\tests\test_apps
b.app.name: 'testapp'
b.memoized_identity: True

=== (b2) absolute file-path form of the import path (test_scriptinfo fallback) ===
b2.cli_app_path C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q11-TXT\seal\tests\test_apps\cliapp\app.py
b2.app.name: 'testapp'

=== (b3) absolute file-path + :name form ===
b3.app.name: 'testapp'

=== (c) precedence: both supplied, create_app must win ===
c.app.name: 'wins'
c.app_import_path (still set, but ignored) cliapp.app:testapp

=== (c2) auto-detection last resort: neither supplied ===
c2.wsgi_autodetect.name: 'hello'

=== (d) end-to-end custom script via FlaskGroup(create_app=...) + CliRunner ===
d.exit_code: 0
d.output: 'flaskgroup\n'

ALL STEP-3 ASSERTIONS PASSED
EXIT=0
```

The real console script over the string route, end to end:

```
$ cd tests/test_apps && uv run flask --app cliapp.app:testapp routes
Endpoint  Methods  Rule
--------  -------  -----------------------
static    GET      /static/<path:filename>
EXIT=0
```

```
$ cd tests/test_apps/helloworld && uv run flask routes      # no --app; auto-detects wsgi.py -> hello
Endpoint  Methods  Rule
--------  -------  -----------------------
hello     GET      /
static    GET      /static/<path:filename>
EXIT=0
```

---

## 7. The one documentation/code inconsistency you must not be misled by

Both docstrings claim the factory receives the `ScriptInfo`. `ScriptInfo.__init__`'s comment (line 314) says:

```python
        #: Optionally a function that is passed the script info to create
        #: the instance of the application.
```

and `FlaskGroup`'s docstring (line 541) says:

```python
    :param create_app: an optional callback that is passed the script info and
        returns the loaded app.
```

But `load_app` calls it **with no arguments** (`app = self.create_app()`, line 342 — verified by grep), and every test factory is zero-argument: `def create_app(): return Flask("createapp")`, `FlaskGroup(create_app=lambda: app)`, `ScriptInfo(create_app=lambda: Flask("testapp"))`. A direct probe settles it:

```
$ uv run python -c "
from flask import Flask
from flask.cli import ScriptInfo
try:
    ScriptInfo(create_app=lambda script_info: Flask('x')).load_app()
    print('one-arg factory succeeded (docstring contract holds)')
except TypeError as e:
    print('one-arg factory FAILED ->', type(e).__name__, e)
app = ScriptInfo(create_app=lambda: Flask('x')).load_app()
print('zero-arg factory succeeded ->', app.name)
"
one-arg factory FAILED -> TypeError <lambda>() missing 1 required positional argument: 'script_info'
zero-arg factory succeeded -> x
EXIT=0
```

The factual contract today is a **no-argument** factory. The "passed the script info" wording is a leftover from an older API, documented in `CHANGES.rst`:

```
-   Factory functions are not required to take a ``script_info``
    parameter to work with the ``flask`` command. If they take a single
    parameter or a parameter named ``script_info``, the ``ScriptInfo``
    object will be passed. :pr:`2319`
```

then deprecated:

```
-   Passing ``script_info`` to app factory functions is deprecated. This
    was not portable outside the ``flask`` command. Use
    ``click.get_current_context().obj`` if it's needed. :issue:`3552`
```

and removed:

```
-   Remove previously deprecated code. :pr:`4337`

    -   The CLI does not pass ``script_info`` to app factory functions.
```

So: the *mechanism* (a callable the caller already holds) is correct; the *parameter list* (none) is what the code actually uses. Any explanation that says `create_app` receives the `ScriptInfo` would contradict the single source of truth, `load_app`.

Also worth keeping distinct: `find_best_app`'s detection of a module attribute *named* `create_app`/`make_app` is a **different** thing from the `ScriptInfo(create_app=...)` parameter. The former is a name looked up *inside an imported module* (lines 76–92 of `find_best_app`: `app_factory = getattr(module, attr_name, None)`); the latter is a callable object the *caller already holds*. They happen to share zero-argument calling convention, which is why they are easy to conflate — but they sit on opposite sides of the string/callable divide: `find_best_app` is part of the string route, the `create_app` parameter short-circuits it.

---

## 8. Conclusion

`ScriptInfo` supports both instantiation mechanisms because it is the single shared entry point for two distinct CLI front-ends that possess different knowledge:

| | `app_import_path` (string) | `create_app` (callable) |
|---|---|---|
| Who supplies it | the shipped `flask` console script (`flask.cli:main`), via `--app`/`FLASK_APP` in `_set_app`, or auto-detect | a custom script built with `FlaskGroup(create_app=...)`; also `FlaskCliRunner`/`ScriptInfo` in tests |
| What the caller knows | nothing about the user's code — hence a string | the factory object itself, already imported |
| Resolution cost | `prepare_import` (realpath, package walk, `sys.path` insert) → `locate_app` → `find_best_app`/`find_app_by_string` (attribute heuristics, `ast` literal parsing) | one call: `app = self.create_app()` |
| Precedence | fallback | wins whenever present |
| Documented rationale | "Application Discovery": *"The `flask` command is installed by Flask, not your application; it must be told where to find your application"* | "Custom Scripts": *"it may be more convenient to define your own Click script. Instead of using `--app` and letting Flask load your application… Note that you don't need to set `--app`."* |

They are alternatives in exactly the sense the `if self.create_app is not None: … else: if self.app_import_path:` chain encodes: an explicit programmatic factory is the most direct and most trustworthy source, the string is the general-purpose route for a command that has to discover the application, and `wsgi.py`/`app.py` auto-detection is the last resort. Verified end to end by `test_scriptinfo`, `test_flaskgroup_app_context`, `TestRoutes`, the precedence probe (`create_app` wins while the string stays set-but-ignored), the real `flask --app`/auto-detect invocations, and the full suite (489 passed). The only correction to make along the way: the docstrings saying the factory is "passed the script info" are stale — the code calls `self.create_app()` with zero arguments.
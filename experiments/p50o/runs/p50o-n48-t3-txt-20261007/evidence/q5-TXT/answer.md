# Where the control flow decides: `FlaskGroup.get_command`

## Short answer

The decision point is inside **`FlaskGroup.get_command` at `src/flask/cli.py:609-634`**, and it is a **two-way fork**, not a three-way one:

- **Lines 613 + 615-616** return a command from the group's *own* registry: `rv = super().get_command(ctx, name)` and the guard `if rv is not None: return rv`.
- **Line 634** is the fall-through `return app.cli.get_command(ctx, name)`, taken only after the app has been loaded successfully.

**Directly registered commands and entry-point-loaded commands share the same exit (613/615-616)** — they do not get separate branches. The "entry point vs. directly registered" distinction is resolved earlier, at *load* time, by `_load_plugin_commands()` called on line 610, which folds `flask.commands` entry points into the same `self.commands` dict that `click.Group.get_command` reads. A third outcome exists only as an error path: if the app cannot be loaded, the `except NoAppException` block at lines 624-626 prints an error and returns `None` — selecting no command at all.

---

## 1. The method, verbatim

`src/flask/cli.py:609-634` (from the executed `cat -n` output):

```python
   609	    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
   610	        self._load_plugin_commands()
   611	        # Look up built-in and plugin commands, which should be
   612	        # available even if the app fails to load.
   613	        rv = super().get_command(ctx, name)
   614	
   615	        if rv is not None:
   616	            return rv
   617	
   618	        info = ctx.ensure_object(ScriptInfo)
   619	
   620	        # Look up commands provided by the app, showing an error and
   621	        # continuing if the app couldn't be loaded.
   622	        try:
   623	            app = info.load_app()
   624	        except NoAppException as e:
   625	            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
   626	            return None
   627	
   628	        # Push an app context for the loaded app unless it is already
   629	        # active somehow. This makes the context available to parameter
   630	        # and command callbacks without needing @with_appcontext.
   631	        if not current_app or current_app._get_current_object() is not app:  # type: ignore[attr-defined]
   632	            ctx.with_resource(app.app_context())
   633	
   634	        return app.cli.get_command(ctx, name)
```

The class declaration anchors (from `grep -n "class FlaskGroup\|class AppGroup\|def get_command\|def _load_plugin_commands"`):

```
405:class AppGroup(click.Group):
531:class FlaskGroup(AppGroup):
600:    def _load_plugin_commands(self) -> None:
609:    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
636:    def list_commands(self, ctx: click.Context) -> list[str]:
```

So the "CLI group class" is `FlaskGroup` (`cli.py:531`), a subclass of `AppGroup` (`cli.py:405`), itself a subclass of `click.Group`.

## 2. Why direct-registered and entry-point commands share one branch

The first thing `get_command` does is merge plugin commands into the group's own registry:

`src/flask/cli.py:600-607`, verbatim:

```python
   600	    def _load_plugin_commands(self) -> None:
   601	        if self._loaded_plugin_commands:
   602	            return
   603	
   604	        for ep in importlib.metadata.entry_points(group="flask.commands"):
   605	            self.add_command(ep.load(), ep.name)
   606	
   607	        self._loaded_plugin_commands = True
```

The directly registered defaults are added the same way, in `FlaskGroup.__init__` (`cli.py:593-596`, from the `cat -n` output):

```python
   593	        if add_default_commands:
   594	            self.add_command(run_command)
   595	            self.add_command(shell_command)
   596	            self.add_command(routes_command)
```

Both `add_command` calls land in the same `self.commands` dict. `click.Group.add_command` (`click/core.py:1579-1588`), verbatim:

```python
   1579	    def add_command(self, cmd: Command, name: str | None = None) -> None:
   1580	        """Registers another :class:`Command` with this group.  If the name
   1581	        is not provided, the name of the command is used.
   1582	        """
   1583	        name = name or cmd.name
   1584	        if name is None:
   1585	            raise TypeError("Command has no name.")
   1586	        _check_nested_chain(self, name, cmd, register=True)
   1587	        self.commands[name] = cmd
```

The registry lives at `click/core.py:1534`:

```
1534:        self.commands: cabc.MutableMapping[str, Command] = commands
```

And `super().get_command` — i.e. `click.Group.get_command`, `.venv/Lib/site-packages/click/core.py:1735-1739`, verbatim:

```python
   1735	    def get_command(self, ctx: Context, cmd_name: str) -> Command | None:
   1736	        """Given a context and a command name, this returns a :class:`Command`
   1737	        object if it exists or returns ``None``.
   1738	        """
   1739	        return self.commands.get(cmd_name)
```

is a plain dict lookup that **cannot distinguish origin**. That is why an entry-point command and a built-in command are indistinguishable from line 613 onward: `_load_plugin_commands` (line 610) has already inserted the entry points into `self.commands` before the lookup at 613 runs. There is no separate "entry point" fork in `get_command`.

## 3. The third case — application CLI group commands — is the fall-through at line 634

If the name is not in the group's own registry (`rv is None`), `get_command` obtains a `ScriptInfo` (line 618), loads the app (line 623), and, on success, delegates to the app's own CLI group at **line 634**:

```python
   634	        return app.cli.get_command(ctx, name)
```

`app.cli` is an `AppGroup` instance — `src/flask/app.py:256`:

```
256:        self.cli = cli.AppGroup()
```

and `AppGroup` defines **no** `get_command`; it overrides only `command()` and `group()` (`src/flask/cli.py:405-438`, from the `cat -n` output):

```python
   405	class AppGroup(click.Group):
   406	    """This works similar to a regular click :class:`~click.Group` but it
   407	    changes the behavior of the :meth:`command` decorator so that it
   408	    automatically wraps the functions in :func:`with_appcontext`.
   409	
   410	    Not to be confused with :class:`FlaskGroup`.
   411	    """
   412	
   413	    def command(  # type: ignore[override]
   ...
   429	    def group(  # type: ignore[override]
   ...
   437	        return super().group(*args, **kwargs)  # type: ignore[no-any-return]
```

A repo-wide grep confirms only one definition exists anywhere:

```
$ grep -rn "def get_command" src/ tests/ flask_mut2_i417ar2x/ 2>/dev/null
src/flask/cli.py:609:    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
```

and the runtime identity checks confirm the inheritance:

```
'get_command' in AppGroup.__dict__: False
'get_command' in FlaskGroup.__dict__: True
AppGroup.get_command resolves to: <function Group.get_command at 0x0000012A2EAB6700>
AppGroup.get_command is click.Group.get_command: True
app.cli type: AppGroup | app.cli.get_command is click.Group.get_command: True
'get_command' in type(app.cli).__dict__: False
```

So line 634's `app.cli.get_command(...)` is also the plain `self.commands.get(cmd_name)` of `click/core.py:1739`.

Blueprint CLI commands also reach line 634, because `src/flask/sansio/blueprints.py:337-348` merges them into `app.cli`:

```python
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
```

## 4. The error path (`NoAppException`) selects nothing

Lines 622-626 are not a command-selection branch; they are a failure exit. If `info.load_app()` raises `NoAppException` (raised inside `ScriptInfo.load_app`, `src/flask/cli.py:333ff`, when no app can be located), the block prints the error and `return None`:

```python
   622	        try:
   623	            app = info.load_app()
   624	        except NoAppException as e:
   625	            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
   626	            return None
```

## 5. Runtime verification — which lines each case actually executes

The executor traced executed line numbers inside `cli.py:get_command` for each case. The results map exactly onto the fork described above:

**Built-in — `get_command(ctx, 'run')`:**

```
--- A built-in: get_command(ctx, 'run') ---
lines executed in cli.py get_command: [610, 613, 615, 616]
returned: <Command run>
A cmdA is gA.commands['run']: True | is flask.cli.run_command: True
A registry keys: ['plugincmd', 'routes', 'run', 'shell']
```

**Entry-point-loaded — fake `flask.commands` entry point `plugincmd`, same exit lines as the built-in:**

```
--- B plugin: get_command(ctx, 'plugincmd') ---
lines executed in cli.py get_command: [610, 613, 615, 616]
returned: <Command plugincmd>
B cmdB is gB.commands['plugincmd']: True
```

Note `'plugincmd'` appears in the group's own registry (`['plugincmd', 'routes', 'run', 'shell']`), proving it was merged by `_load_plugin_commands` and is therefore indistinguishable from a directly registered command at lookup time.

**Application CLI group — command `apponly` registered on `app.cli`, exit at line 634:**

```
--- C app.cli-only: get_command(ctx, 'apponly') ---
lines executed in cli.py get_command: [610, 613, 615, 618, 622, 623, 631, 632, 634]
returned: <Command apponly>
C cmdC is app.cli.commands['apponly']: True
C 'apponly' in gC.commands (expect False): False
```

**Missing / app-unloadable name — `NoAppException` exit, returns `None`:**

```
--- D missing/app-unloadable: get_command(ctx, 'missing') ---
lines executed in cli.py get_command: [610, 613, 615, 618, 622, 623, 624, 625, 626]
returned: None
D returned None (no command selected): True
```

The same `runner.invoke`-based test (matching how the test suite drives it) reproduces the two main exits:

```
runner.invoke(cli, ['apponly']):
  exit_code: 0
  last lines executed in cli.py get_command: [631, 632, 634]
  output first line: from app.cli

runner.invoke(cli, ['run', '--help']):
  exit_code: 0
  last lines executed in cli.py get_command: [613, 615, 616]
  output first line: Usage: flask run [OPTIONS]
```

A blueprint command merged into `app.cli` also exits at 634:

```
app.cli registry keys: ['customized']
blueprint command invoke exit_code: 0
output: 'custom_result\n'
lines executed in cli.py get_command: [610, 613, 615, 618, 622, 623, 631, 632, 634]
```

## 6. Tests that pin the behavior

The repo's own tests exercise each exit. `tests/test_cli.py:385-395` (`test_flaskgroup_nested`, directly registered command):

```python
def test_flaskgroup_nested(app, runner):
    cli = click.Group("cli")
    flask_group = FlaskGroup(name="flask", create_app=lambda: app)
    cli.add_command(flask_group)

    @flask_group.command()
    def show():
        click.echo(current_app.name)

    result = runner.invoke(cli, ["flask", "show"])
    assert result.output == "flask_test\n"
```

`tests/test_cli.py:289-305` (`test_app_cli_has_app_context`, app-CLI-group path):

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

`tests/test_cli.py:398-410` (`test_no_command_echo_loading_error`, the `NoAppException` exit):

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

Run of the whole relevant suite (both a normal and a verbose run, repeated with a fresh bytecode cache) passes 58/58, e.g.:

```
tests\test_cli.py ...................................................... [ 93%]
....                                                                     [100%]

============================= 58 passed in 1.15s ==============================
```

and the four plan-cited tests specifically:

```
tests/test_cli.py::test_no_command_echo_loading_error PASSED             [ 25%]
tests/test_cli.py::test_app_cli_has_app_context PASSED                   [ 50%]
tests/test_cli.py::test_flaskgroup_nested PASSED                         [ 75%]
tests/test_cli.py::test_cli_blueprints PASSED                            [100%]

============================== 4 passed in 0.57s ==============================
```

## 7. Supporting documentation for the entry-point path

`docs/cli.rst:444-460` documents the entry-point contract that `_load_plugin_commands` consumes:

```rst
Plugins
-------

Flask will automatically load commands specified in the ``flask.commands``
`entry point`_. This is useful for extensions that want to add commands when
they are installed. Entry points are specified in :file:`pyproject.toml`:

.. code-block:: toml

    [project.entry-points."flask.commands"]
    my-command = "my_extension.commands:cli"

.. _entry point: https://packaging.python.org/tutorials/packaging-projects/#entry-points

Inside :file:`my_extension/commands.py` you can then export a Click
object::

    import click

    @click.command()
    def cli():
        ...

Once that package is installed in the same virtualenv as your Flask project,
you can run ``flask my-command`` to invoke the command.
```

Corroborated by `CHANGES.rst:418-419`:

```rst
 -   The CLI uses ``importlib.metadata`` instead of ``pkg_resources`` to
     load command entry points. :issue:`4419`
```

---

## Summary of the decision flow

| Case | Where it ends | Executed lines |
|---|---|---|
| Directly registered command (built-ins `run`/`shell`/`routes` from `cli.py:594-596`, or `add_command`/`@cli.command()`) | `return rv` — `cli.py:615-616`, fed by `rv = super().get_command(ctx, name)` at `cli.py:613` | `[610, 613, 615, 616]` |
| Entry-point-loaded command (`flask.commands`) | **Same** `cli.py:615-616` exit — no separate branch, because `_load_plugin_commands()` at `cli.py:610` merges it into `self.commands` first | `[610, 613, 615, 616]` |
| Application CLI group command (incl. blueprint commands merged into `app.cli`) | Fall-through `return app.cli.get_command(ctx, name)` — `cli.py:634`, after `info.load_app()` succeeds (623) and an app context is pushed (631-632) | `[610, 613, 615, 618, 622, 623, 631, 632, 634]` |
| Name not found and app unloadable | `except NoAppException` → `return None` — `cli.py:624-626` (selects no command) | `[610, 613, 615, 618, 622, 623, 624, 625, 626]` |

So: the branch that determines "group's own registry vs. application CLI group" lives at **`src/flask/cli.py:615-616`** versus **`src/flask/cli.py:634`**. Within the first side, direct-registered and entry-point commands are deliberately collapsed, because both are ordinary entries in the same `self.commands` mapping (`click/core.py:1534`) consumed by the plain dict lookup `click.Group.get_command` (`click/core.py:1739`) — the entry-point/direct distinction is a load-time fact (line 610 → lines 600-607), not a retrieval-time one.
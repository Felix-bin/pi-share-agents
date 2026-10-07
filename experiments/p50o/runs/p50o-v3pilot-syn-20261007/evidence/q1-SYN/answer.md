# Why `ScriptInfo` loads the app lazily into `_loaded_app`

The class is `ScriptInfo` (`src/flask/cli.py:293`), the only class in the worktree that caches a discovered app: `self._loaded_app: Flask | None = None` is created as an empty slot at `src/flask/cli.py:331`, and the app is resolved only on first call to `load_app` (`:333-372`):

```
    def load_app(self) -> Flask:
        """Loads the Flask app (if not yet loaded) and returns it.  Calling
        this multiple times will just result in the already loaded app to
        be returned.
        """
        if self._loaded_app is not None:
            return self._loaded_app          # src/flask/cli.py:338-339
...
        self._loaded_app = app               # src/flask/cli.py:371
```

Loading in `__init__` is not merely a style choice that was skipped; four properties of the surrounding code make it impossible or harmful. Each is set out below.

## 1. The information needed to load does not exist when the object is constructed

`FlaskGroup.make_context` builds the helper with no import path at all (`src/flask/cli.py:657-674`):

```
        if "obj" not in extra and "obj" not in self.context_settings:
            extra["obj"] = ScriptInfo(
                create_app=self.create_app,
                set_debug_flag=self.set_debug_flag,
                load_dotenv_defaults=self.load_dotenv,
            )
```

The `-A/--app` value is applied *afterwards* by the eager option callback (`src/flask/cli.py:440-446`):

```
def _set_app(ctx: click.Context, param: click.Option, value: str | None) -> str | None:
    if value is None:
        return None

    info = ctx.ensure_object(ScriptInfo)
    info.app_import_path = value
```

So at `__init__` time the constructor receives no `app_import_path`; the path arrives later from parsed CLI arguments, the `FLASK_APP` environment variable (`extra["context_settings"].setdefault("auto_envvar_prefix", "FLASK")`, `:587`), or the current-directory fallback scan of `("wsgi.py", "app.py")` (`:350-357`). The error message itself states those three sources (`src/flask/cli.py:359-365`): *"Use the 'flask --app' option, 'FLASK_APP' environment variable, or a 'wsgi.py' or 'app.py' file in the current directory."* Eager loading could only ever run before any of them are known.

## 2. Loading is a fallible side effect, and the CLI must survive its failure

`load_app` imports user code or calls a factory and raises `NoAppException` if nothing is found (`:341-365`). Both consumers tolerate that (`src/flask/cli.py:609-634`):

```
        self._load_plugin_commands()
        # Look up built-in and plugin commands, which should be
        # available even if the app fails to load.
        rv = super().get_command(ctx, name)
...
        info = ctx.ensure_object(ScriptInfo)

        # Look up commands provided by the app, showing an error and
        # continuing if the app couldn't be loaded.
        try:
            app = info.load_app()
        except NoAppException as e:
            click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")
            return None
```

`list_commands` does the same and additionally catches generic `Exception` to print a traceback (`:636-655`, comment *"Add commands provided by the app, showing an error and continuing if the app couldn't be loaded."*). `parse_args` manually processes the eager options for the help cases precisely so that discovery still happens there (`src/flask/cli.py:678-688`):

```
        if (not args and self.no_args_is_help) or (
            len(args) == 1 and args[0] in self.get_help_option_names(ctx)
        ):
            # Attempt to load --env-file and --app early in case they
            # were given as env vars. Otherwise no_args_is_help will not
            # see commands from app.cli.
```

The `_app_option` comment repeats it (`:448-452`): *"This option is eager so the app will be available if --help is given. … no_args_is_help bypasses eager processing, so this option must be processed manually in that case to ensure FLASK_APP gets picked up."* If the app were loaded during `__init__`, this error path could never be reached: `flask --help` and the built-in/plugin commands would abort instead of degrading. The tests pin this deferral directly (`tests/test_cli.py:273-274`):

```
    obj = ScriptInfo()
    pytest.raises(NoAppException, obj.load_app)
```

A bare `ScriptInfo()` constructs without error; only `load_app()` raises — the failure is deliberately moved out of construction.

## 3. The cached instance is a shared-identity contract, not a micro-optimisation

The `load_app` docstring states the contract (`src/flask/cli.py:334-337`): *"Loads the Flask app (if not yet loaded) and returns it. Calling this multiple times will just result in the already loaded app to be returned."* Within a single invocation the loaded app is consumed by four sites: `with_appcontext` (`:397`), `get_command` (`:623`), `list_commands` (`:645`) and `run_command` (`:955`). The identity is asserted in the tests, both across calls and against the active app context:

```
    obj = ScriptInfo(app_import_path="cliapp.app:testapp")
    app = obj.load_app()
    assert app.name == "testapp"
    assert obj.load_app() is app          # tests/test_cli.py:249-251
```

```
        app = click.get_current_context().obj.load_app()
        # the loaded app should be the same as current_app
        same_app = current_app._get_current_object() is app   # tests/test_cli.py:296-299
```

A second load would import user code twice and produce a different app object than the one whose context is pushed, so the cache is what makes "one CLI invocation, one app instance" true.

## 4. Values resolved during argument parsing must be applied at load time

`_env_file_callback` loads dotenv while parsing (`:493-510`), and the ordering is explicit (`src/flask/cli.py:573-577`):

```
        # Processing is done with option callbacks instead of a group
        # callback. This allows users to make a custom group callback
        # without losing the behavior. --env-file must come first so
        # that it is eagerly evaluated before --app.
        params.extend((_env_file_option, _app_option, _debug_option))
```

and `_set_debug` writes the flag into the environment so it survives into the factory (`:479-480`): *"Set with env var instead of ScriptInfo.load so that it can be accessed early during a factory function."* `load_app` then applies the flag at load moment (`:366-369`, `app.debug = get_debug_flag()`). All of these values are produced by parsing, i.e. after construction. `run_command` also branches on loader state around the load (reloader prints the traceback and keeps serving; non-reloader raises immediately, `:954-971`), which is only meaningful if the load happens when the command runs.

## 5. The closest thing to a stated design stance is the "carrier, not loader" docstring

The `load_dotenv_defaults` attribute docstring (`src/flask/cli.py:323-329`) says of `ScriptInfo`:

```
        ``ScriptInfo`` doesn't load anything, this is for reference when doing
        the load elsewhere during processing.
```

That is the object's declared role: it holds configuration and defers every effect; `_loaded_app` follows the same stance for the app.

## Verification status: which of this is documented and which is inferred

- **Documented (quoted first-party text):** the laziness and the identity guarantee (`src/flask/cli.py:334-337`), the "doesn't load anything" stance (`:323-329`), the `--env-file`-before-`--app` ordering (`:573-577`), the "eager so the app will be available if --help is given" rationale (`:448-452`), and the "showing an error and continuing if the app couldn't be loaded" comments (`:619-620`, `:642-643`). The behaviour is also test-pinned (`tests/test_cli.py:249-271`, `:273-286`, `:296-299`).
- **Inferred (no first-party sentence):** the *causal* claim in reasons 1, 2 and 4 — that `__init__` loading is impossible because options arrive later, and that deferral is required for failure tolerance. These are reconstructed from statement order, control flow and the comments; no comment or docstring says "lazy because…".
- **Not established:** any changelog or in-tree issue/PR text arguing the lazy-vs-eager choice for `ScriptInfo`. `CHANGES.rst` mentions it only historically (`CHANGES.rst:854`, about factory functions taking a `script_info` parameter). The nearest entries concern a related but distinct decision — `CHANGES.rst:340-343`: *"Remove the `--eager-loading/--lazy-loading` options from the `flask run` command. The app is always eager loaded the first time, then lazily loaded in the reloader."* — and a bug fix, `CHANGES.rst:480-481`: *"Correctly handle raising deferred errors in CLI lazy loading."* Commit/PR history was not inspected.

## Corrections and contradictions between the collected sources

- The retriever described `load_app()` as having "four sites" but listed three (`:397`, `:618/622`, `:640/644`). The executor's `grep -rn "\.load_app()"` found the fourth: `src/flask/cli.py:955` in `run_command`. The four call sites are `:397`, `:623`, `:645`, `:955` (the retriever's other line numbers are roughly ±2 off; e.g. `get_command` is `:609`, `_set_app`'s assignment is `:445`).
- No substantive contradiction: both sources agree that the class is `ScriptInfo`, that loading is deferred to `load_app`, and that no first-party document states the intent.

## Answered vs. open

- **Answered:** the mechanism (cache slot `:331`, guard `:338-339`, write `:371`) and the four code-grounded reasons lazy loading exists instead of `__init__` loading, each with quoted lines; plus what is stated first-party versus reconstructed.
- **Open:** an authorial statement of intent — no comment, docstring, changelog entry or in-tree PR/issue text in the working directory says why the design was chosen; commit history was not examined, so the rationale above remains an inference from structure even where it is strongly supported.
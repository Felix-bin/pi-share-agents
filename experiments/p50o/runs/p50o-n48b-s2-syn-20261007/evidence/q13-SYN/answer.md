# Where the control flow decides

The method is **`FlaskGroup.get_command` at `src/flask/cli.py:609`** — the only `get_command` in the package (`AppGroup`, declared at `src/flask/cli.py:405`, overrides only `command` at 413 and `group` at 429, so it inherits click's). It is **not a three-way switch**. Two of the three cases you name — directly registered command and entry-point-loaded command — are merged into one registry *before* the lookup happens, so the only conditional that actually decides anything is the two-line test at 613/615–616:

```
609    def get_command(self, ctx: click.Context, name: str) -> click.Command | None:
610        self._load_plugin_commands()
611        # Look up built-in and plugin commands, which should be
612        # available even if the app fails to load.
613        rv = super().get_command(ctx, name)
614
615        if rv is not None:
616            return rv
```

**Directly registered command.** The built-in defaults are registered in the group's `__init__` at 594–596 (`self.add_command(run_command)` / `shell_command` / `routes_command`, under `if add_default_commands:` at 593). They land in `self.commands`.

**Entry-point (plugin) command.** Line 610 calls `self._load_plugin_commands()` (definition at 600): after the guard flag check at 601 (flag initialised `False` at 598, set `True` at 607, so it runs once), it iterates `importlib.metadata.entry_points(group="flask.commands")` at 604 and calls `self.add_command(ep.load(), ep.name)` at 605. That is the *same* registration call the defaults used, into the *same* `self.commands` dict. So when line 613 runs, it returns both kinds from one lookup and **directly registered and entry-point commands are indistinguishable at retrieval time**. The decision between them is made earlier, at registration — not in `get_command`. The comment at 611–612 ("built-in and plugin commands") states exactly this intent, and it is why the plugin load is unconditional and first.

**Application CLI group command.** This is the *fallback*, reached only when the 615 test failed:
- 618 `info = ctx.ensure_object(ScriptInfo)`
- 622 `try:` → 623 `app = info.load_app()`
- 624 `except NoAppException` → 625 red `click.secho(f"Error: {e.format_message()}\n", err=True, fg="red")` → 626 `return None`
- 631–632 push an app context: `if not current_app or current_app._get_current_object() is not app:` / `ctx.with_resource(app.app_context())`
- 634 `return app.cli.get_command(ctx, name)` — `app.cli` being `cli.AppGroup()`, set at `src/flask/app.py:256`

So the "which of the three?" question resolves as: **the group's own registry (built-ins + plugins, lines 613/615/616) or, failing that, the loaded app's CLI group (line 634).** A practical consequence of the ordering and the `NoAppException` handler: if the app cannot be loaded, built-ins and plugin commands still resolve, and an app-level name returns `None` with a printed error rather than raising. `FlaskGroup.list_commands` (636) mirrors the same order — plugin load 637, `set(super().list_commands(ctx))` 639, `info.load_app().cli.list_commands(ctx)` 645, `return sorted(rv)` 657.

# Verification and what remains open

Anchors were read directly from current file content in this worktree (numbered read of `src/flask/cli.py:590–664`, plus `grep` of `src/flask` for `def get_command` / `class AppGroup` / `class FlaskGroup` / `app.cli.get_command`, which returned only `cli.py:405`, `531`, `609`, `634`). Two anchors handed over earlier were off by one and are corrected here: `ctx.ensure_object(ScriptInfo)` is **618** (not 619) and the app-context push is **631–632** (not 630–631); the executor's values match my read. Note also that the ranked chunk path `flask/src/flask/cli.py` **does not exist** in this worktree — the package root is `src/flask/cli.py` — though the line numbers coincide.

- **Not established:** whether "an application CLI group command" was meant to include click's *nested-group* `get_command` override (which also consults `self.sources`). No path inside `src/flask/cli.py` makes that distinction, and `AppGroup` does not use `add_group`/`sources`; the reading above treats 634 (`app.cli.get_command`) as the intended case and answers under that reading.
- **Not established:** test-level corroboration. No test in `tests/` references `flask.commands`, `entry_points` or `get_command`, so the branch behaviour rests on source reading alone.
- **Not established:** that the file matches upstream Flask. `git status --porcelain` shows only `?? flask_mut2_i417ar2x/`, i.e. `src/flask/cli.py` is unmodified vs HEAD — that is a clean-worktree statement, not a comparison against any baseline revision.
- The standalone `flask_mut2_i417ar2x/mutated_test.py` in the worktree exercises `flask.url_for` with `subdomain`/`SERVER_NAME` and asserts a 200; it contains no reference to CLI commands, `FlaskGroup` or entry points, so it is unrelated to this question.

I recorded the answer as shared-memory conclusion `d96d208e9084af97aa8363cf39c3cb1c9d713f743f907f3a468d8eab2214337e` (source `src/flask/cli.py`, which auto-invalidates it if that file changes) and superseded the earlier `15c33c671774` record as `corrected`, since it carried the 619/630–631 offsets that this read refutes.
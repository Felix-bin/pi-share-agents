## Where the decision happens

The dispatch lives in **`FlaskGroup.get_command`, `src/flask/cli.py:609`**. It is the only command-retrieval override in the file (`AppGroup` at `src/flask/cli.py:405` overrides only `command` at 413 and `group` at 429, so it inherits click's plain `Group.get_command` and contains no such logic).

The decision is made at **line 613**, not by a three-way test:

| Line | Code | Effect |
|---|---|---|
| 610 | `self._load_plugin_commands()` | side effect, not a branch — loads entry points into `self.commands` |
| 613 | `rv = super().get_command(ctx, name)` | looks up the group's own commands |
| 615–616 | `if rv is not None:` / `return rv` | **the decision point** — returns a group-own command |
| 618 | `info = ctx.ensure_object(ScriptInfo)` | only reached on a miss |
| 622–626 | `try: app = info.load_app()` … `except NoAppException as e:` … `return None` | app couldn't be loaded → returns `None`, never reaching the app CLI group |
| 631–632 | `if not current_app or … is not app:` / `ctx.with_resource(app.app_context())` | conditional app-context push |
| 634 | `return app.cli.get_command(ctx, name)` | falls through to the **application CLI group** |

**The question's three categories collapse onto two branches, not three.** Directly registered commands (`src/flask/cli.py:593–596`, `add_command(run_command/shell_command/routes_command)` in `__init__`) and entry-point loaded commands (605, `self.add_command(ep.load(), ep.name)` inside `_load_plugin_commands`, over the `importlib.metadata.entry_points(group="flask.commands")` loop at 604) are both inserted into the *same* `self.commands` mapping before lookup; `super().get_command` therefore reads them out of one dict, and no line of 609–634 distinguishes or orders them. The single `if rv is not None` at 615 resolves both together.

So the mapping of the three named categories is: categories 1 and 2 → branch at 613/615; category 3 → fall-through at 634, with an early `return None` at 626 as the failure path. The category-3 delegate is a *different* group instance, not `FlaskGroup` again — `src/flask/app.py:256` sets `self.cli = cli.AppGroup()`.

*(A read of the whole 609–634 body confirms the ordering above verbatim; grep line anchors agree at 610, 613, 615, 618, 623, 626, 632, 634.)*

## What this rests on / what remains open

- **Rests on:** source reads of `src/flask/cli.py` at 405–433, 531, 593–607, 609–634, a grep for all `get_command`/class definitions in that file, and `src/flask/app.py:256`.
- **Not established:** no test execution or runtime trace was performed (the executor stage was skipped by the complexity gate), so the claim that built-in and entry-point commands are indistinguishable at line 613 is read from the source and click's `Group.get_command`, not observed in a run. Callers of `get_command` elsewhere (e.g. `parse_args` around line 680) were not surveyed, and `list_commands` (637–645) mirrors the same two-source shape but was not analysed in depth.
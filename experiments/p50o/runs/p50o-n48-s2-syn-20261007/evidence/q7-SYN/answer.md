# Would repeating the blueprint filter-registration mechanism across many distinct blueprints degrade startup performance?

**Short answer: barely from the filter mechanism itself — but yes from the blueprint registration path it rides on.** Each distinct blueprint that calls `add_app_template_filter` adds a constant amount of work (one closure, one `functools.update_wrapper`, one list append at definition time; one O(1) dict write at startup), measured at ~3.6 µs per blueprint. The measurable super-linear startup growth in the same loop is *not* caused by filters: the executor's control run shows `register_blueprint` costs the same with and without filters (17.98 ms vs 17.96 ms median at N=1000). That growth comes from a pre-existing linear scan inside `Blueprint.register`, which runs on every registration whether or not a filter is involved.

## What the mechanism actually does, per blueprint

The "custom" mechanism the blueprint tests exercise is Flask's built-in API, not a bespoke registry — `tests/test_blueprints.py:365, 381, 391, 407, 417, 438, 453, 467, 487` all use `bp.app_template_filter()` / `bp.add_app_template_filter(...)`, and their only assertion is that the name appears in `app.jinja_env.filters` (`tests/test_blueprints.py:370-372, 383-385, 396-398, 409-411`). A whole-`src/` search for any other registry-shaped name finds nothing beyond the two known sinks.

Per distinct blueprint, the chain is:

- `Blueprint.app_template_filter` (`src/flask/sansio/blueprints.py:444`) → `add_app_template_filter(f, name=name)` (`:455`)
- `add_app_template_filter` (`:461`) defines `register_template(state)` (`:472`) whose body is `state.app.jinja_env.filters[name or f.__name__] = f` (`:473`), then calls `record_once(register_template)` (`:475`)
- `record_once` (`:233`) defines `wrapper(state)` calling `func(state)` only `if state.first_registration` (`:238-240`), then `record(update_wrapper(wrapper, func))` (`:243-246`)
- `record` (`:224`) appends to `self.deferred_functions` (`:230`; list initialised at `:204`)
- At registration, `Blueprint.register` (`:273`) computes `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (`:316`), builds the state (`:321`), and runs `for deferred in self.deferred_functions: deferred(state)` (`:334-335`)
- The write target is the app-level environment: `App.jinja_env` is a `@cached_property` (`src/flask/sansio/app.py:470-477`), and the app-level twin `App.add_template_filter` writes the same dict (`sansio/app.py:695`)

## Why the naive degradation story does not hold

Three intuitions that would explain degradation are each contradicted by the evidence:

1. **"Each blueprint rebuilds or copies the environment."** No. `jinja_env` is a cached property, so it is materialised once. The executor confirmed the environment key is absent from `app.__dict__` before any registration and present after, and that `id(app.jinja_env)` is a single id across all N registrations (per-app distinct-id count `[1,1,1,1,1]` for every cell, N ∈ {1, 10, 100, 1000}).
2. **"Prior blueprints' filters get re-registered."** No. Nothing in `Blueprint.register` or `_merge_blueprint_funcs` (`src/flask/sansio/blueprints.py:378-411`, which handles error handlers, views, request funcs and context processors only) iterates other blueprints' filters. Total filter work is O(N), and `len(bp.deferred_functions)` is 1 per blueprint.
3. **"`record_once` dedups across blueprints."** It does not — the guard is keyed on `state.first_registration`, which is `not any(bp is self for bp in app.blueprints.values())` (`:316`). Any *distinct* blueprint object is absent from `app.blueprints.values()` on its first registration, so its filter closure always executes. But that also means there is no repeated execution to pay for; the guard only suppresses re-registration of the *same* object, as the executor measured (same blueprint registered twice → filters count stays 55).

Measured result of the above: `len(app.jinja_env.filters)` goes 54 (baseline) → 54+N for N distinct names (55/64/154/1054 at N=1/10/100/1000), and stays 55 at every N when all blueprints use the same filter name. That last case is a silent last-write-wins overwrite with no error or warning — a correctness hazard, not a performance one.

## What actually degrades, and where it lives

The executor's timings (worktree `src/flask`, Python 3.14.0, 5 reps, min/median ms, timed region = app creation + loop):

| N | blueprint route (total median) | direct `app.add_template_filter` loop (median) |
|---|---|---|
| 1 | 0.0577 | 0.0141 |
| 10 | 0.1873 | 0.0230 |
| 100 | 1.5121 | 0.1035 |
| 1000 | 30.3327 | 1.2910 |

Phase split of the blueprint route: at N=100 the register phase is 0.5671 ms; at N=1000 it is 18.7484 ms — roughly 33× for a 10× increase, i.e. super-linear, while the build phase grows roughly linearly (0.8871 → 10.4435 ms).

The control run pins the cause. With empty blueprints (no filters at all):

| N | with filters: total / register | no filters: total / register |
|---|---|---|
| 100 | 1.4952 / 0.5531 | 0.9512 / 0.4331 |
| 1000 | 27.7064 / 17.9836 | 24.1324 / 17.9622 |

`register_blueprint` costs the same with and without filters (17.98 vs 17.96 ms at N=1000). The filter marginal cost is the total difference — ~3.6 ms per 1000 blueprints, ~3.6 µs each, all at definition time. So the super-linear term is the `any(bp is self for bp in app.blueprints.values())` scan at `src/flask/sansio/blueprints.py:316`, executed once per `register_blueprint` call, giving O(n²) over n distinct blueprints — a property of blueprint registration in general, which a filter-carrying blueprint merely inherits. Each setup call additionally passes through `@setupmethod` → `_check_setup_finished` (`src/flask/sansio/scaffold.py:42-48`; blueprint override at `blueprints.py:212-221`), but that is a constant per call and does not grow with N.

A residual, unmeasured effect: with distinct names the shared filters dict does grow to 54+N entries. Jinja filter lookup is a dict lookup, so this is not expected to be a lookup-time cost of consequence, but no render or request was exercised, so render-time cost of the larger dict is **not established**.

## What is answered and what is open

Answered: the full call chain for the mechanism the blueprint tests use, with `file:line` for every hop; the scope facts (one shared `app.jinja_env.filters` dict, one environment per app, per-blueprint-object `record_once` guard, default key `f.__name__` with silent overwrite); and the quantified cost structure — O(1) filter work per distinct blueprint, with the observed super-linear startup growth attributable, by control experiment, to the pre-existing registration scan in `Blueprint.register` rather than to the filter mechanism.

Still open / not established: any quadratic claim about the filter mechanism itself (contradicted); any render-time or repeated-registration cost (no request or render was exercised); generalisation off this machine (single interpreter, Python 3.14.0, 5 reps, max outliers up to ~2× min, so min/median are reported rather than maxima). The premise of a distinct "custom registry" is unmet — no such registry exists under `src/`; if the question assumes one, that assumption should be restated in terms of `Blueprint.add_app_template_filter`.

### Basis and caveats
- Source lines re-verified directly in this worktree: `blueprints.py:204, 224-246, 273-335, 444-475`; `sansio/app.py:470-477, 695`; usage at `tests/test_blueprints.py:365-487`.
- Measurements from the executor's `_exec_filter_bench.py` and `_exec_filter_ctrl.py` (worktree root, `PYTHONPATH=src` so the worktree's own `src/flask` is imported); nothing under `src/` or `tests/` was edited.
- Raw measurements are in shared memory `a899e326b82b`; the derived conclusion is recorded as `dc1ca2adb58f` (source-tracked to `src/flask/sansio/blueprints.py`). No prior recalled conclusion contradicts this one.
- Retriever and executor agree on every overlapping point; the only "contradiction" is with the question's implied premise that the filter mechanism is itself the cost centre.
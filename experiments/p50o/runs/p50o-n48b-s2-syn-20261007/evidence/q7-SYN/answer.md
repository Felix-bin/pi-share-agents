# Why repeated per-blueprint filter registration degrades startup — and which part of the degradation is actually caused by it

**The honest answer: the degradation is real but it is not caused by the filter mechanism.** Measured startup grows superlinearly as the number of *distinct* blueprints grows — but the curve is the same whether or not each blueprint registers a filter. The superlinear term comes from blueprint registration bookkeeping, not from filter registration. The filter mechanism adds only a small, linear, and substantially redundant cost.

## 1. What actually degrades, and where it lives

With B distinct `Blueprint` objects each registering one app-wide filter (`bp.app_template_filter("f<i>")`), the registration phase measured (min of 5 reps, Python 3.13.9, this worktree's `src`):

| B | filters branch | control (filter call removed) | same object re-registered |
|---|---|---|---|
| 1 | 0.041 ms | 0.017 ms | 0.049 ms |
| 10 | 0.085 ms | 0.070 ms | 0.106 ms |
| 100 | 0.506 ms | 0.601 ms | 0.368 ms |
| 1000 | 19.459 ms | 22.343 ms | 3.952 ms |

Decade ratios: filters 2.06× / 5.93× / **38.44×**; control 4.18× / 8.57× / **37.16×**. A doubling series confirms it: filters 250→4000 goes 1.83 / 5.90 / 21.61 / 79.12 / 291.89 ms (≈3.2–3.7× per doubling), control 1.41 / 4.09 / 14.72 / 55.10 / 272.10 ms. The filter branch is within noise of control at every B, so the filter call is not contributing the growth.

The growth is quantitatively explained by one line in the registration path: `src/flask/sansio/blueprints.py:316`

```python
first_bp_registration = not any(bp is self for bp in app.blueprints.values())
```

This executes once per `Blueprint.register` (`:273`), which `Flask.register_blueprint` calls (`src/flask/sansio/app.py:570-594`). For a **new** blueprint object the generator cannot short-circuit — it must identity-compare against every already-registered blueprint to conclude absence — so the b-th registration costs b comparisons and B distinct blueprints cost B(B−1)/2, i.e. **O(B²)**. Timing the isolated expression gives 4.27 µs per scan at n=100, 36.43 µs at n=1000, 254.70 µs at n=10000 (≈0.03 µs/compare); that projects to ~18 ms at B=1000 and ~291 ms at B=4000, matching the measured control totals. Re-registering the *same* object short-circuits on the first hit, which is exactly why `same_obj` stays near-linear (10.75×/decade).

So: repeating the mechanism across many **distinct** blueprint objects degrades startup because each distinct object forces the O(R) scan at `:316`, and those scans sum to O(B²). Repeating on one object does not.

## 2. What the filter mechanism itself costs

The blueprint filter mechanism is: `Blueprint.app_template_filter` → `add_app_template_filter` (`src/flask/sansio/blueprints.py:443-458`, `:460-475`), whose body is `state.app.jinja_env.filters[name or f.__name__] = f` (`:472-473`) deferred through `record_once` (`:232-244`, creating a `wrapper` closure gated on `state.first_registration` and calling `functools.update_wrapper`, imported at `src/flask/sansio/scaffold.py:9`), appended to the per-instance `deferred_functions` (`:204`, list append at `:230`), and drained at registration (`:334-335`). Every step is **O(1) per (blueprint, filter)**: one closure, one wrapper closure, one `update_wrapper`, one append, one dict store. The measured dict store is 0.294 µs (1000 stores in 0.294 ms total). One deferred entry per filter-registering blueprint was observed.

Crucially, the write target is the **single shared** `app.jinja_env.filters`. There is one environment per app: `Flask.jinja_env` is a werkzeug `cached_property` (`src/flask/sansio/app.py:469-477`) built once via `create_jinja_environment` (`src/flask/app.py:385-421`); Jinja copies `DEFAULT_FILTERS` once per env (`jinja2/environment.py:351`). Measured environment constructions: 1 per app at B=4000 (3 constructions for 3 reps), and 5 distinct `id(jinja_env)` across 5 separate B=100 apps. Nothing in `src/flask` clears the template cache on blueprint registration. So B blueprints do not multiply environments, filter copies, or any per-blueprint structure — they add B keys to one dict, and fewer if names collide (measured 54+B keys with unique names, flat 55 when all names collide: B overwrites, last-registration-wins because of `name or f.__name__`).

## 3. Why the repetition is empty work, not just slow work

Because all writers share one app-wide dict, registering the same filter from B blueprints is B overwrites of the same key. Worse, Jinja binds filters into the compiled module at compile time (`jinja2/compiler.py:554-565` emits `environment.filters['name']` into generated code; `:1801-1803` records `func = self.environment.filters.get(node.name)`). A template compiled before a later blueprint's overwrite therefore keeps the earlier function. Per-blueprint repetition of an app-wide filter buys inconsistent results, not speed. The blueprint tests use precisely this app-wide API (`tests/test_blueprints.py:362-492`), in contrast to the immediate single dict store of `app.add_template_filter` (`tests/test_templating.py:123-213`; `src/flask/sansio/app.py:686-695`) — the blueprint-level repetition exists to exercise the deferred plumbing, and its per-blueprint cost has no functional payoff.

## 4. Secondary timing side-effect

Because the deferred body reads `state.app.jinja_env` (`:473`), the Jinja environment is constructed *during* `app.register_blueprint` of the first filter-registering blueprint, rather than lazily later. It happens once per app (cached property), so it does not scale with B — but it lands inside the registration phase and will pollute a naive first-registration timing unless the control run warms it or the cost is subtracted.

## 5. Contradictions and open items

- **The plan's criteria both fail.** H1 (10×/decade) and H2 (100×/decade) are bracketed by the observed 38.44× (filters) vs 37.16× (control) — and the value is not filter-attributable, since the control without the filter call shows the same growth.
- **Plan cite drift.** The plan cites `blueprints.py:312` for `first_bp_registration` (actual `:316`), `330-332` for the deferred loop (actual call `:332`, loop `:334-335`), and `461-475` for `add_app_template_filter` (actual `:460-475`). Its claim of a bench artifact under `flask_mut2_i417ar2x/` has **no file backing** — that directory holds only `mutated_test.py` (22 lines: `subdomain_matching=False`, `SERVER_NAME`, a `/` route with `subdomain="<company_id>"`, `url_for` + `client.get`), which contains no template-filter code.
- **Not established:** retained per-blueprint memory (never measured); any wall-clock or memory cost attributable *specifically* to the filter mechanism beyond the control; and which B values make the O(B²) term dominate constant overheads. Whether this worktree carries a source mutation on the filter path is unresolved: `git status --porcelain` showed only `?? flask_mut2_i417ar2x/`, i.e. no uncommitted `src` edits, but `src` was never diffed against a pristine upstream copy, and nothing read on the filter path differs from the documented upstream shape.

## What the answer rests on

- Source: `src/flask/sansio/blueprints.py` (`:204`, `:230`, `:232-244`, `:273`, `:316`, `:334-335`, `:443-475`), `src/flask/sansio/app.py` (`:469-477`, `:570-594`, `:686-695`), `src/flask/app.py` (`:385-421`), `src/flask/sansio/scaffold.py` (`:9`), `tests/test_blueprints.py` (`:362-492`), `tests/test_templating.py` (`:123-213`).
- Measurements: three scratch benchmarks at the worktree root run with `.venv/Scripts/python.exe` (Python 3.13.9); the venv's `flask.pth` resolves `flask` to a foreign session's path, so each script inserted this worktree's `src` on `sys.path` and asserted `flask.__file__` was `...\q7-SYN\seal\src\flask\__init__.py`. No source file was modified; only the three untracked scratch scripts were created.
- Recorded as a consequence in shared memory (topic: blueprint app_template_filter registration startup performance), source `src/flask/sansio/blueprints.py`.

**Answered:** the mechanism being repeated, the exact source of the superlinear startup degradation (O(B²) identity scan at `:316`, not the filter path), the O(1)-per-(blueprint, filter) character of the filter path, and why repetition is functionally redundant given the shared app-wide dict. **Still open:** per-blueprint memory retention, and whether this tree carries a filter-path mutation.
# Why repeated blueprint-level filter registration degrades startup

**Short answer.** Repeating `bp.app_template_filter(...)` / `bp.add_app_template_filter(...)` across N *distinct* `Blueprint` objects does add work proportional to N, but the work itself is linear and small — measured at ~2% of registration time even at N = 3200 (§Executed round 3). The degradation actually observed when this pattern is scaled is a **quadratic term in `Blueprint.register` that is independent of filters** (measured at exactly N(N−1)/2 identity comparisons). Blueprint filter registration inherits that quadratic cost because filters must be attached before their blueprint is registered; it does not cause it.

## The mechanism, and why distinct objects multiply the work

`Blueprint.app_template_filter` (`src/flask/sansio/blueprints.py:443-458`) delegates to `Blueprint.add_app_template_filter` (`blueprints.py:460-475`). Nothing is written to Jinja at call time. The method defines a closure `register_template(state)` whose body is `state.app.jinja_env.filters[name or f.__name__] = f` (`blueprints.py:472-473`) and hands it to `self.record_once(register_template)` (`blueprints.py:475`).

`record_once` wraps it: the wrapper body runs only `if state.first_registration` (`blueprints.py:241`) and is then appended via `Blueprint.record` → `self.deferred_functions.append(func)` (`blueprints.py:224-230`). The list `self.deferred_functions` is created per instance in `Blueprint.__init__` (`blueprints.py:204`). The wrapper is invoked later, by the loop `for deferred in self.deferred_functions: deferred(state)` inside `Blueprint.register` (`blueprints.py:334-335`) — i.e. at `app.register_blueprint(...)` time, which is application startup for import-time registration.

The consequence for repetition: because the deferred list is **per blueprint object**, N distinct objects hold N separate lists and N separate `register_template` closures. `record_once`'s `first_registration` guard is per-registration state, so it can suppress a *repeat of the same object* but has no cross-object memory (`blueprints.py:241`, `321`). Every distinct object therefore executes its own filter write. Measured: filter writes equal N exactly at N = 100/200/400/800 with a counting `filters` dict.

The environment those N writes hit is one shared object: `app.jinja_env` is a `cached_property` (`src/flask/sansio/app.py:469-477`, implemented by `Flask.create_jinja_environment` at `src/flask/app.py:385-418`). It is built once on first access and reused, so there is **no per-blueprint environment creation and no repeated Jinja environment construction** to blame. Each write is a single dict `__setitem__`, O(1) (`blueprints.py:473`).

Linear per-object costs: N appends, N closure calls, N O(1) dict writes.

## Where the measured superlinearity actually comes from

Registration-loop timings (3 reps, best, `PYTHONPATH=src` against this worktree's `.venv`):

| N | best reg time (s) | ratio | filter writes |
|---|---|---|---|
| 100 | 0.000404 | — | 100 |
| 200 | 0.001047 | 2.59 | 200 |
| 400 | 0.003035 | 2.90 | 400 |
| 800 | 0.009407 | 3.10 | 800 |

A wider run (N = 200…3200) fits `t = a·N + b·N²` with `a = 2.52e-06 s`, `b = 1.11e-08 s`, and `t/N²` flattening toward ~1.19e-8 s as N grows — asymptotically quadratic, not merely "slower".

Attribution experiment: instrumenting `app.blueprints` with a counting dict, the number of `values()` yields (one per identity comparison) is exactly N(N−1)/2 at every size (4950, 19900, 79800, 319600 for N = 100/200/400/800). That is the scan `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` at `blueprints.py:316`, which runs before `app.blueprints[name] = self` (`blueprints.py:319`) and therefore always walks all i−1 prior entries. The same run with filters removed gave essentially identical times (N = 3200: 0.121935 s with vs 0.119584 s without, ratio 1.02; N = 1600: 0.032517 s vs 0.031815 s). The quadratic is present with **no filters at all**; the filter mechanism contributes the ~2% difference.

So the causal statement the evidence supports is: the filter registrar is a payload carried by `Blueprint.register`; it is linear in the number of distinct blueprints, and the startup degradation at that scale is the pre-existing O(N²) identity scan (plus the O(1) name-collision lookup at `blueprints.py:307-317`) that registering N blueprints already incurs. The filter path does force the situation the question describes, in one respect: `_check_setup_finished` (`blueprints.py:210-219`) raises `AssertionError` once `_got_registered_once` is set (`blueprints.py:320`), so filters cannot be attached after registration — the repetition and the registration are necessarily in the same startup pass.

## Side effects of the same repetition

- **Silent last-writer-wins on a shared filter name.** Two distinct blueprints registering the same name do not raise and do not dedupe; the later registration overwrites the earlier in the single shared dict. Measured: no exception, two writes, `filters["shared"]` is the second blueprint's function, and rendering through it returned the second function's result. Only identical re-registration of the *same* object is skipped: re-registering one object under `name="alt"` performed **zero** filter writes (`first_registration=False` path at `blueprints.py:241`), with a stable `jinja_env` identity, while `app.blueprints` then held the same object under two keys. No existing test covers that skip — the nine filter tests in `tests/test_blueprints.py:362-495` each build exactly one blueprint, and the only re-registration test (`tests/test_blueprints.py:1017-1045`) uses no filter.
- **Retention and later walks.** Each blueprint object and its closures stay referenced by `app.blueprints` (`blueprints.py:319`), so the count of registered entries grows with the repetition pattern. This lengthens the `_iter_loaders` walk at template-load time (`src/flask/templating.py:101-109`, `for blueprint in self.app.iter_blueprints()`, backed by `self.blueprints.values()` at `src/flask/sansio/app.py:597-602`). That cost is a function of *having* N blueprints, not of registering filters on them, and it was not measured in this run — reporting it as a cost of the filter mechanism would overstate the evidence.

## Under the other reading of the question

If "custom template filter registration mechanism" means the app-level `Flask.add_template_filter` (`src/flask/sansio/app.py:686-695`) used elsewhere in the suite, the premise does not arise: its body writes immediately (`sansio/app.py:695`, `self.jinja_env.filters[name or f.__name__] = f`), with no `record_once`, no `deferred_functions`, and no identity scan. Repeated calls are then N immediate O(1) writes, and there is no per-registration deferral to multiply. The two paths differ behaviorally as well: app-level writes take effect whenever they are made, whereas blueprint-level writes are frozen at registration time.

## What is answered and what stays open

Answered: the full call chain with verified file:line for every hop; the cost model; and the measurement-based attribution — the filter mechanism's own startup cost is O(N) and measured at ~2% of a superlinear registration loop whose quadratic term is `blueprints.py:316`. The premise that the *filter writes* cause meaningful performance degradation is not supported by the measurements; degradation at scale is real but is the pre-existing multi-blueprint registration scan.

Open / not established: (a) all timings are a synthetic microbenchmark of the registration loop, so no real application workload was measured; (b) the template-load-time `iter_blueprints` walk was not timed; (c) whether the question intends template-load time rather than startup was not resolved from the source; (d) the tracked `src/` tree is byte-identical to HEAD (`git diff` empty, only the pre-existing untracked `flask_mut2_i417ar2x/` present, which contains no filter-path code), but no baseline diff against an external copy was possible, so "no other driver exists in this worktree" is an absence-of-evidence observation.

**Basis:** `src/flask/sansio/blueprints.py:204, 210-219, 224-230, 233-244, 307-321, 331-335, 443-475`; `src/flask/sansio/app.py:469-477, 597-602, 686-695`; `src/flask/app.py:385-418`; `src/flask/templating.py:101-109`; `tests/test_blueprints.py:362-495, 1017-1045`; and the executed timing/attribution/behaviour runs plus `pytest tests/test_blueprints.py -q -k "template_filter"` (9 passed) reported in the executed-results section.
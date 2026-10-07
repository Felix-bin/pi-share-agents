# How the deferred registration makes blueprint app-level filters visible under a URL prefix

`Blueprint.add_app_template_filter` is not a URL-scoped feature at all. It defers a *callable* until the blueprint is mounted, and that callable writes into the **application's** Jinja environment. The `url_prefix` is a separate piece of state that only route rules ever read, so it has no path — no mechanism — by which it could affect filter visibility.

## The chain, link by link

1. **Call time writes nothing.** `Blueprint.add_app_template_filter(self, f, name=None)` (`src/flask/sansio/blueprints.py:461-475`) only defines an inner function and queues it:
   ```python
   def register_template(state: BlueprintSetupState) -> None:
       state.app.jinja_env.filters[name or f.__name__] = f

   self.record_once(register_template)
   ```
   The mutation target is `state.app.jinja_env.filters` — the app's environment, reached through the setup state, not through the blueprint.

2. **The queue.** `record_once(func)` (`blueprints.py:233-244`) wraps the callable in `def wrapper(state): if state.first_registration: func(state)` and hands it to `record(func)` (`:224-230`), which appends it to `self.deferred_functions` (created at `:204`). The `first_registration` guard means the filter is installed **at most once per application**, however many times the blueprint is mounted.

3. **`url_prefix` is already just an option by this point.** `Flask.register_blueprint(blueprint, **options)` (`src/flask/sansio/app.py:570-590`) ends with `blueprint.register(self, options)` (`:590`). Everything the caller passed — `url_prefix` included — is an entry in the `options` dict.

4. **The drain is the install point.** `Blueprint.register` (`blueprints.py:273`) computes `first_bp_registration` (`:315`), builds `state = self.make_setup_state(app, options, first_bp_registration)` (`:321`), and then runs (`:334-335`):
   ```python
   for deferred in self.deferred_functions:
       deferred(state)
   ```
   This loop is what actually executes `register_template` and therefore what puts the filter into the environment. It runs during mounting, after the state exists — not at decoration time.

5. **Where the prefix actually lives, and what reads it.** `BlueprintSetupState.__init__` reads `url_prefix = self.options.get("url_prefix")`, falls back to `self.blueprint.url_prefix`, and stores it at `blueprints.py:77`. Its **only** consumer is `BlueprintSetupState.add_url_rule` (`:87-103`), which joins it onto route rules (`:100`) and touches nothing related to Jinja. The deferred `register_template` reads only `state.app` (`:473`); it never reads `state.url_prefix`.

6. **Why the rendering environment is the environment in question.** `jinja_env` is a `cached_property` returning `self.create_jinja_environment()` (`src/flask/sansio/app.py:469-477`) — a single, application-wide `Environment`. `render_template` resolves through `app.jinja_env.get_or_select_template(...)` (`src/flask/templating.py:149`). The dict mutated by the deferred closure is exactly the dict consulted for every template the app renders.

7. **Equivalence to the app method.** `Flask.add_template_filter` (`src/flask/sansio/app.py:686-695`) has a body byte-identical to the deferred closure (`self.jinja_env.filters[name or f.__name__] = f`). The blueprint path is the same mutation, simply postponed to first mount — which is precisely why it is named *app*_template_filter. The siblings run the same shape: `add_app_template_test` (`blueprints.py:497-513`, writes `state.app.jinja_env.tests`, `:511`) and `add_app_template_global` (`:540-551`, `globals`, `:549`).

**Reduced to one sentence:** the filter is installed into the application's Jinja environment at mount time by the `deferred_functions` drain; `url_prefix` exists only on `BlueprintSetupState.url_prefix` and is consumed only by `add_url_rule`, so mounting with a prefix runs the identical drain and produces the identical environment mutation.

## What the executed tests show

`PYTHONPATH=src ./.venv/Scripts/python.exe -m pytest tests/test_blueprints.py -k "template_filter" -v` → **9 passed, 51 deselected in 0.17s**, exit 0, all nine filter tests individually PASSED (`tests/test_blueprints.py::test_add_template_filter PASSED`). The control `-k "template_test"` → 9 passed, 51 deselected, all PASSED.

The prefix independence is over-determined in the suite rather than attested by one test: **every** blueprint-template test mounts with `app.register_blueprint(bp, url_prefix="/py")` (`tests/test_blueprints.py:365, 383, 396, 409, 420, 442, 455, 471, 488, …`), and the `*_with_template` family asserts against a route declared at app level `"/"` (`:422-424, 442, 490-492`) — i.e. rendered *outside* the `/py` prefix the blueprint was mounted with — while still expecting `b"dcba"` from `tests/templates/template_filter.html` (`{{ value|super_reverse }}`).

A direct probe of the idempotency claim (inline script, no file created): one blueprint decorated with `@bp.app_template_filter("myrev")` mounted first at `url_prefix="/a"` then at `url_prefix="/b"` produced exactly one filter write per mount (`['myrev']` both times, count 1), `"myrev" in app.jinja_env.filters` was `True`, and a GET on an app-level `/` route outside both prefixes returned `b'dcba'`. So the deferred write fires once, and its effect is visible from outside any prefix — consistent with `record_once`'s `first_registration` guard and with the app-wide env.

## What it rests on, and what is open

**Rests on:** direct reads of `src/flask/sansio/blueprints.py` (`:77`, `:87-103`, `:204`, `:224-244`, `:315`, `:321`, `:334-335`, `:461-475`, `:497-551`), `src/flask/sansio/app.py` (`:570-590`, `:469-477`, `:686-695`), `src/flask/templating.py:149`, the mounted-with-prefix test matrix in `tests/test_blueprints.py:362-637`, and two pytest runs (9+9 passed) plus one inline write-count probe.

**Open / caveats:**
- Only the `-k template_filter` and `-k template_test` selections were run — not the full `tests/test_blueprints.py`, and not any wider suite.
- Run hygiene: the committed `.venv/Lib/site-packages/flask.pth` points at a **different checkout** (`…\9f4f8f70\q7-TXT\seal\src`), so a bare `pytest tests/...` here would have exercised that checkout's flask. Every result above used `PYTHONPATH=src`, confirmed to resolve to this worktree. This is an environment caveat, not a property of the mechanism.
- An untracked `flask_mut2_i417ar2x/mutated_test.py` sits at the worktree root; it exercises `url_for` with `subdomain="<company_id>"` and `subdomain_matching=False` and contains no blueprint template-filter code, so it is not evidence for or against anything here. Its keep/clean-up status is undecided and untouched.
- No `docs/` page describing this mechanism was located, and the historical version-added/changed notes were not read in full (only a `CHANGES.rst:1272` mention of `Blueprint.add_app_template_filter` was found).
## Direct answer

The flag is `Blueprint._got_registered_once`, and its purpose is a **one‑way latch that freezes a blueprint's configuration at the moment that blueprint is first registered on an app**. It exists because a blueprint is a *deferred collection* of setup operations that are replayed per app: once `register()` has drained that collection, a later setup call cannot be applied back to the apps already registered. Without the latch the result would be a silently half‑configured app, so Flask turns an unenforceable ordering into a loud setup‑time failure. The exception text names the purpose itself: *"It has already been registered at least once, any changes will not be applied consistently"* (`sansio/blueprints.py:216-217`).

## The mechanism (verified in this checkout, Flask 3.2.0.dev)

- **Declared** `sansio/blueprints.py:172` — `_got_registered_once = False`, a bare class attribute on `Blueprint`.
- **Checked** `:213-221` `_check_setup_finished` raises `AssertionError` if the flag is set.
- **Set** `:320` `self._got_registered_once = True` — the immediate next statement after `app.blueprints[name] = self` (`:319`), i.e. before `make_setup_state`, before the merge, before the deferred replay, before nested registration.
- **Enforced** through `setupmethod` (`sansio/scaffold.py:42-49`), whose wrapper's *first* statement is `self._check_setup_finished(f_name)` (`:46`); the base hook `Scaffold._check_setup_finished` (`:220-221`) is `raise NotImplementedError`, so the policy is mandatory and supplied by each subclass. The public `flask/blueprints.Blueprint` overrides neither, so the latch is inherited unchanged.
- **Coverage**: the whole setup surface is latched — 17 own `@setupmethod`s (`record`, `record_once`, `register_blueprint`, `add_url_rule`, the `app_template_*`/`app_*` hooks at `:444`–`:625`) plus 16 inherited from `Scaffold` (`route`, `get/post/put/delete/patch`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_*`, `errorhandler`, …).

## Why the latch has to close at exactly `:320`

I re-read the `register()` body (`:302-377`) line by line. Every sink the late call would write to is consumed *after* `:320`:

- `:331-332` `_merge_blueprint_funcs(app, name)` runs only `if first_bp_registration or first_name_registration` — gated on *first* registration, so a late error/template hook would never reach an app already registered.
- `:334-335` `for deferred in self.deferred_functions: deferred(state)` — the collected setup is drained here; a late `route`/`record`/`add_url_rule` appends *after* the drain and so reaches only apps registered later.
- `:241` `record_once` payloads run only `if state.first_registration` — that gate has already been passed for the first app.
- `:373-377` nested `blueprint.register(app, bp_options)` — a late `register_blueprint` appends to `self._blueprints` after that loop, so nested blueprints land only on future apps.

Net effect in one sentence: the blueprint object and its already-materialised per-app copies drift apart, which is precisely what the message calls out.

**Observed, not just inferred.** The executor reproduced the guard live (`.venv` Python 3.13.9, `flask` imported from this checkout's `src/`) and the traceback goes `scaffold.py:46` → `blueprints.py:215`; `bp.record` produced the identical message with `'record'` substituted, so the latch is not route-specific. The divergence itself was then made observable with an **instrumented bypass** (flag hand-reset to `False`): `/early` on `app1`, then a late `/late` route, then registration on `app2` gave `app1` url_map `['/early', '/static/…']` → `GET /late` **404**, `app2` `['/early', '/late', '/static/…']` → **200**. That is "changes will not be applied consistently" literally.

## Contrast with the app side (and a correction to the handed evidence)

The evidence bundled the app-side anchors as if all in `sansio/app.py`; the grep shows they span two files:

- `sansio/app.py:411` `self._got_first_request = False` — **per-instance** (in `Flask`'s init, comment `:409-410`), with `_check_setup_finished` at `:413-414`.
- `src/flask/app.py:911` `self._got_first_request = True` — inside `wsgi_app`, i.e. triggered by **the first request**, not by registration.
- Additionally, `src/flask/app.py:655-667` resets the app flag to `False` in `Flask.run()`'s `finally` (so the dev server can be restarted).

So the structural difference is sharper than "different flag name": **the app latch trips on serving and is resettable; the blueprint latch trips on registration and has no reset path at all.** I grepped `_got_registered_once` across `src/flask` — exactly three hits (`:172`, `:214`, `:320`) and no assignment back to `False` anywhere. It is genuinely one-way.

## Documented provenance

- `CHANGES.rst:160-161`, under `Version 2.3.0` (`:135`): *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"*.
- Predecessor `CHANGES.rst:298-300`, under `Version 2.2.0` (`:237`): setup-use after registration *"will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"* — the design was deliberately made to mirror the app-side mechanism.
- The prose rationale is documented for the *request* case, not the registration case: `docs/lifecycle.rst:39-46` ("Flask tries to help developers catch some of these setup ordering issues…") quotes the **application** message; `:50-60` mentions blueprints only indirectly. So for the blueprint latch the "why" has to be read from the code ordering and the exception text, not from a prose doc — which is what the section above does.

## Bearing on the question as asked

- **Answered:** what the flag is, where it lives, how it is enforced, when it is set, why it must be one-way at that line, what concrete failure it prevents (reproduced), and its documented history (2.2.0 warning → 2.3.0 error).
- **Reading assumed:** "blueprint collection class" = `Blueprint` (the class that collects setup in `deferred_functions` / `_blueprints`). `BlueprintSetupState` has **no** registration-tracking flag in this checkout — verified by grep, which is consistent with the three-hit result.
- **Still open / bounded:** (1) no test in this checkout covers the blueprint-side message or `AssertionError` — `grep -rn` over `tests/` for both the flag name and the message text returns no matches; only the analogous app-side text is asserted (`tests/test_basic.py:1687-1690`); (2) the divergence was demonstrated under a hand-reset flag, i.e. the *native* behaviour is the refusal, and the *divergence* is the counterfactual the latch forbids — worth stating plainly rather than presenting the 404/200 as normal operation; (3) nothing outside this tree was executed, so nothing is claimed about other Flask versions; (4) the fixture `experiments/data/` is gitignored (`.gitignore:33`), so the executor's memory `eaf6a637…` carries no `sourcePath` and will not auto-retire — conclusions here should be re-checked against the tree, not assumed fresh.

**What it rests on:** `src/flask/sansio/blueprints.py:172/213-221/319-320/331-335/241/373-377`; `src/flask/sansio/scaffold.py:42-49/220-221`; `src/flask/sansio/app.py:411/413-414`; `src/flask/app.py:667/911`; `CHANGES.rst:135/160-161/237/298-300`; `docs/lifecycle.rst:39-46/50-60`; `pyproject.toml:3` (`version = "3.2.0.dev"`); plus the executor's live traceback and instrumented two-app run — all re-verified by me in this checkout except the two runtime runs, which are the executor's observations.
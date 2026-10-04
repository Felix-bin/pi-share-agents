## Purpose of `Blueprint._got_registered_once`

The flag exists to make "setup after registration" a hard error, because a blueprint's setup only means anything at the moment it is registered.

**What it is and where it lives**
- It is `_got_registered_once`, a class attribute defaulting to `False` on `Blueprint` — the class the docstring describes as "a collection of routes and other app-related functions that can be registered on a real application later" (`src/flask/sansio/blueprints.py:119-120`, flag at `:172`).
- It is set to `True` in exactly one place: `Blueprint.register()`, at `:320`, after the duplicate-name `ValueError` check and immediately before `make_setup_state` and the replay of deferred functions (`:316-321`). So the flag records "this blueprint has been registered at least once" for its whole lifetime — not per app, and not "fully succeeded": it is set before the deferred callbacks run, so a registration that raises partway through still leaves the blueprint locked.
- It is read in exactly one place: `Blueprint._check_setup_finished` (`:213-221`), which raises `AssertionError` ("The setup method '…' can no longer be called on the blueprint '…'. It has already been registered at least once, any changes will not be applied consistently…"). The `@setupmethod` decorator (`src/flask/sansio/scaffold.py:42-48`) calls `self._check_setup_finished(f_name)` before the wrapped function body, and every blueprint setup method carries it (`route`, `add_url_rule`, all the `record`/`record_once`-based registration helpers, `app_errorhandler`, `register_blueprint`, `before_request`, etc. — the decorator appears ~25 times in the file, `:223` through `:624`). That guard-and-single-reader pairing is the whole mechanism by which setup methods are blocked once registered.

**Why blocking is the correct behaviour (the purpose, stated positively)**
1. Blueprint setup methods don't touch the app; they append closures to `deferred_functions` (e.g. `record`, `:223-230`), which are only executed during `register` (`for deferred in self.deferred_functions:` `:334`).
2. The two halves of registration have *different* replay rules: deferred functions are replayed on **every** registration, but the direct state merge, `_merge_blueprint_funcs`, runs only when `first_bp_registration or first_name_registration` (`:331-332`). Anything recorded late would therefore take effect only on some registrations and not others.
3. A blueprint is explicitly allowed to be mounted more than once — on multiple apps, and repeatedly on one app under different names (`docs/blueprints.rst:27-28`, `:119-121`; uniqueness is enforced by name at `:298-306`). An app that already received the blueprint would never see later additions, while a subsequent registration would, which is precisely the "not applied consistently" case the error message names.
So the flag converts a silent, order-dependent inconsistency into an immediate assertion at the point of misuse, pushing all decorators and imports ahead of the first `register_blueprint` call — the same design as the app-level `Flask._check_setup_finished` / `_got_first_request` pair (`src/flask/sansio/app.py:405-421`).

**Not to be confused with the per-app flag**
`BlueprintSetupState.first_registration` (`:58-62`) is a different, per app-name value computed in `register` (`:316-317`); it drives `record_once`'s "only run on first registration" wrapper (`:240-242`). `_got_registered_once` is a lifetime latch that gates whether setup is allowed at all.

**Severity and provenance**
The check raises `AssertionError` and is not configurable. It started as a warning in 2.2.0 (`CHANGES.rst:297-300`) and became an error in 2.3.0 (`CHANGES.rst:160-161`, PR 4997).

### What this rests on, what is open
- Rests on direct reads in this working directory: `src/flask/sansio/blueprints.py` (`:119-120`, `:172`, `:213-221`, `:223-230`, `:240-244`, `:255-256`, `:273`, `:316-334`, `:379`), `src/flask/sansio/scaffold.py:42-48`, `src/flask/sansio/app.py:405-421`, `CHANGES.rst:160-161` and `:297-300`, `docs/blueprints.rst:27-28` and `:119-121`.
- The handoff handles named in the task were not readable from this seal (shared-memory namespace mismatch), so no retriever/executor transcript was re-checked; no code was executed during this synthesis, so the runtime behaviour above is inferred from the source rather than observed this run.
- Open/uncertain: there is no test in `tests/` that exercises this specific blueprint guard — grepping `tests/` for `_got_registered_once` or "no longer be called on the blueprint" returns nothing; only the app-level equivalent is asserted (`tests/test_basic.py:1687-1690`). It is therefore established by source and changelog, not by an in-repo passing test.
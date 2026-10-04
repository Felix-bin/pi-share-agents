## Purpose of the registration-tracking flag `_got_registered_once`

The flag is `Blueprint._got_registered_once` in `src/flask/sansio/blueprints.py` — the class the task calls the "blueprint collection class" (its own docstring: "Represents a blueprint, a collection of routes and other app-related functions that can be registered on a real application later", line 124–125). It is a one-way latch that ends the blueprint's setup phase: it exists so Flask can fail loudly when a blueprint is modified after it has been registered, instead of letting the modification silently apply inconsistently.

How it works, in full (three references, all in that file):

- Declared once as a class attribute with the value `False` (line 172).
- Set to `True` in `Blueprint.register()` (line 320), immediately after `app.blueprints[name] = self` and *before* any deferred setup is replayed.
- Read in exactly one place: `Blueprint._check_setup_finished()` (line 214), which raises `AssertionError` naming the offending method. Every method marked `@setupmethod` calls it first, through the `setupmethod` wrapper in `src/flask/sansio/scaffold.py:42-49`.

So the practical effect is: once `register()` has run, any further call to `route`, `get/post/put/delete/patch`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`, `record`, `record_once`, or `register_blueprint` on that blueprint raises:

> The setup method '<name>' can no longer be called on the blueprint '<name>'. It has already been registered at least once, any changes will not be applied consistently.
> Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it.

Why "inconsistently" is the real reason — the mechanism the flag protects:

- A blueprint is deferred, not live: setup calls append to lists (`deferred_functions`, `_blueprints`, per-key hook dicts), and `register()` replays them against a fresh `BlueprintSetupState` for each registration (`for deferred in self.deferred_functions: deferred(state)`, line 337), so *every* registration re-reads that state.
- Only part of it is re-read. `_merge_blueprint_funcs(app, name)` (line 335) runs only when `first_bp_registration or first_name_registration`, and it is the merge step that copies view functions, error handlers, template filters, etc. into the *app* snapshot.
- The same blueprint is legitimately registered more than once, with a different name or `url_prefix` each time (`docs/blueprints.rst:108-121`; `tests/test_blueprints.py:994-1008` registers `bp` twice, under `"again"`).

A hook or route added after registration #1 would therefore reach the app only on registrations #2..n, and the already-registered app would keep the old shape — different apps sharing one blueprint would end up with different behaviour. The flag makes that a hard error at the point of the mistake rather than a divergence at runtime. It is deliberately the blueprint-side twin of the app-side guard `Flask._check_setup_finished` with `_got_first_request` (`src/flask/sansio/app.py:411-419`), and `docs/lifecycle.rst:39-60` gives the underlying rationale for both: WSGI servers run multiple workers or machines, so all setup must be complete and identical before serving.

Two boundary details, both evidenced in the code:

- Re-registration itself is still allowed — `register()` and `make_setup_state()` carry no `@setupmethod`; only setup *mutators* are blocked. That is what lets the same blueprint be mounted twice under different names.
- Because the flag is set at line 320 *before* the deferred loop at line 337 and before nested blueprints are registered (`blueprint.register(app, bp_options)`, line 380), a setup method called from inside a `record`/`record_once` callback during registration also fails, and a nested blueprint gets latched when the parent registers it, not when it is defined.

Version history for the behaviour (from `CHANGES.rst`): the 2.2 series made post-registration setup calls a warning ("In the next version, this will become an error just like the application setup methods", line 297-300, issue 4571); 2.3.0 turned it into an error (line 160-161, PR 4997). The current code is therefore the error form, hence `AssertionError`.

## What this rests on, and what is open

Rests on: `src/flask/sansio/blueprints.py` lines 124-125, 172, 213-220, 254-260, 292-321, 335-380; `src/flask/sansio/scaffold.py` lines 42-49 and the `@setupmethod`-marked methods; `src/flask/sansio/app.py` lines 409-419; `CHANGES.rst` lines 160-161 and 297-300; `docs/blueprints.rst` lines 108-121, 126-155; `docs/lifecycle.rst` lines 39-60; `tests/test_blueprints.py` lines 994-1014.

Open / uncertain:

- The retriever and executor result texts referenced by handle (`b3ca7d40…`, `d3547e96…`) were not present in this session and shared memory is not readable from this working directory (the store replies `namespace-mismatch` — it reports the state as belonging to a sibling directory, not this one), so those two inputs could not be consulted. The conclusion above is built directly from the files cited, not from those handles, and no claim here depends on them.
- No test in `tests/` exercises the blueprint-side message: a repo-wide search for `no longer be called` matches only `src/flask/sansio/blueprints.py`, `src/flask/sansio/app.py` and `docs/lifecycle.rst` (which documents the *app* variant only). So the intent is documented by the error message and the changelog entries, not by an in-repo test or a blueprint-specific doc paragraph.
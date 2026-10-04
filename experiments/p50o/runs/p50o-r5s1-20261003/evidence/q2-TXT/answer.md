## Answer

**The flag is `Blueprint._got_registered_once` in the blueprint "collection" class `flask.sansio.blueprints.Blueprint` (public alias `flask.Blueprint`, subclass at `src/flask/blueprints.py:18`). It is a one-way latch meaning "this blueprint has already been materialised into at least one application." Its purpose is to let every `@setupmethod` fail fast with a descriptive `AssertionError` — naming the offending method and the blueprint — instead of silently accepting post-registration edits that would only apply to *future* registrations while the app that already consumed the blueprint keeps stale wiring. That exact consequence is named by the error itself: *"any changes will not be applied consistently."***

### 1. What the flag is, and where it lives

The class identifies itself as a collection — `src/flask/sansio/blueprints.py:120`:

> `"""Represents a blueprint, a collection of routes and other app-related functions that can be registered on a real application later.`

The declaration is a **class attribute**, immediately after the class docstring and before `__init__` — `blueprints.py:172`:

```python
class Blueprint(Scaffold):
    """Represents a blueprint, a collection of routes and other
    app-related functions that can be registered on a real application
    later.
    ...
    .. versionadded:: 0.7
    """

    _got_registered_once = False
```

Repo-wide grep shows exactly three sites and nothing else (the only extra hits are compiled `.pyc` copies of the same lines):

```
src/flask/sansio/blueprints.py:172:     _got_registered_once = False
src/flask/sansio/blueprints.py:214:         if self._got_registered_once:
src/flask/sansio/blueprints.py:320:         self._got_registered_once = True
```

`Blueprint.__init__` (`blueprints.py:174-211`) never touches it — it sets only `name`, `url_prefix`, `subdomain`, `deferred_functions`, `url_values_defaults`, `cli_group`, `_blueprints`. So the flag is a class-scope default, shadowed on the instance at registration.

### 2. How it is consulted: one shared decorator, one overridden hook

Every setup method is wrapped by `setupmethod` (`src/flask/sansio/scaffold.py:42-49`):

```python
def setupmethod(f: F) -> F:
    f_name = f.__name__

    def wrapper_func(self: Scaffold, *args: t.Any, **kwargs: t.Any) -> t.Any:
        self._check_setup_finished(f_name)
        return f(self, *args, **kwargs)

    return t.cast(F, update_wrapper(wrapper_func, f))
```

`Scaffold` is the base shared by app and blueprint, and its hook is abstract (`scaffold.py:220-221`: `raise NotImplementedError`). `Blueprint` overrides it at `blueprints.py:213-221` (verified verbatim in the snapshot):

```python
    def _check_setup_finished(self, f_name: str) -> None:
        if self._got_registered_once:
            raise AssertionError(
                f"The setup method '{f_name}' can no longer be called on the blueprint"
                f" '{self.name}'. It has already been registered at least once, any"
                " changes will not be applied consistently.\n"
                "Make sure all imports, decorators, functions, etc. needed to set up"
                " the blueprint are done before registering it."
            )
```

`{f_name}` is the offending method's `__name__`; `{self.name}` is the blueprint name. This exact string exists nowhere else in the tree (grep for `no longer be called on the blueprint` / `already been registered at least once` hits only `blueprints.py:216-217`).

### 3. Where it is set: the sole write-site, inside `Blueprint.register()`

`blueprints.py:306-335` (with `def register` at `:273`):

```python
        if name in app.blueprints:
            bp_desc = "this" if app.blueprints[name] is self else "a different"
            existing_at = f" '{name}'" if self_name != name else ""

            raise ValueError(
                f"The name '{self_name}' is already registered for"
                f" {bp_desc} blueprint{existing_at}. Use 'name=' to"
                f" provide a unique name."
            )

        first_bp_registration = not any(bp is self for bp in app.blueprints.values())
        first_name_registration = name not in app.blueprints

        app.blueprints[name] = self
        self._got_registered_once = True
        state = self.make_setup_state(app, options, first_bp_registration)

        if self.has_static_folder:
            state.add_url_rule(...)          # :323-328

        # Merge blueprint data into parent.
        if first_bp_registration or first_name_registration:
            self._merge_blueprint_funcs(app, name)

        for deferred in self.deferred_functions:
            deferred(state)                  # :334-335
```

Note `:320` is the only assignment, placed *immediately after* `app.blueprints[name] = self` (`:319`) and *before* setup-state creation (`:321`), static wiring (`:323-328`), dict merging (`:331-332`), deferred replay (`:334-335`) and CLI wiring (`:337+`). The `ValueError` (`:306-314`, `raise ValueError(` at `:310`) is raised *before* those two lines, so a name collision does **not** latch the blueprint.

### 4. The purpose, stated positively

**(a) A one-way latch.** It records that the blueprint has already been materialised into at least one app — the error wording is the literal specification: *"It has already been registered at least once."* There is no code path that resets it to `False`.

**(b) A fail-fast diagnostic reaching every setup method.** Because all setup methods route through the shared `setupmethod` wrapper (`scaffold.py:46`) into the blueprint's `_check_setup_finished` (`blueprints.py:213`), any one of them called post-registration raises an immediate `AssertionError` naming the method and blueprint. Live repro in the snapshot's venv:

> `The setup method 'route' can no longer be called on the blueprint 'bp'. It has already been registered at least once, any changes will not be applied consistently.`

**(c) Why the inconsistency is real — deferred wiring against a live app.** A blueprint does not execute setup when decorated; it *records* callables. `blueprints.py:223-230`:

```python
    @setupmethod
    def record(self, func: DeferredSetupFunction) -> None:
        """Registers a function that is called when the blueprint is
        registered on the application.  This function is called with the
        state as argument as returned by the :meth:`make_setup_state`
        method.
        """
        self.deferred_functions.append(func)
```

and `record_once` (`:232-244`) wraps them so they only run `if state.first_registration`. Those recorded callables are *replayed only at registration* (`:334-335`: `for deferred in self.deferred_functions: deferred(state)`). Meanwhile registration mutates the **app** in place — `app.blueprints[name] = self` (`:319`), static route added (`:323-328`), dicts merged by `_merge_blueprint_funcs` (`:379-408`, copying `error_handler_spec`, `view_functions`, `before_request_funcs`, etc.), CLI group merged (`:337+`), nested blueprints recursed. Once the app has consumed the blueprint, a route/decorator/handler added later cannot be back-applied; it would affect only subsequent registrations, so the same blueprint object would yield different wiring in different apps — the precise failure the message calls *"any changes will not be applied consistently."* The multi-worker consistency motive is spelled out in `docs/lifecycle.rst:36-40` ("If the configuration changed in one worker, there's no way for Flask to ensure consistency between other workers"), and `docs/lifecycle.rst:41-51` states Flask "tries to help developers catch some of these setup ordering issues by showing an error if setup-related methods are called after requests are handled… However, it is not possible for Flask to detect all cases of out-of-order setup."

**(d) A developer nudge.** The error's second sentence — *"Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."* — is the intended guidance: finish configuring the blueprint before `app.register_blueprint(...)`.

**(e) History confirms it was an intentional escalation of diagnostics, not incidental.** `CHANGES.rst:297-300` (2.2.0):

> `Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571``

`CHANGES.rst:160-161` (2.3.0 removals):

> `Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997``

### 5. Exactly what it blocks — and what it deliberately does not

**Blocked** (all listed sites carry `@setupmethod`, and representative ones were runtime-verified to raise):

- Declared on `Blueprint` (`blueprints.py` `@setupmethod` at lines 223, 232, 255, 412, 443, 460, 477, 496, 515, 534, 553, 563, 573, 583, 595, 612, 624): `record`, `record_once`, `register_blueprint` (nested bp), `add_url_rule`, `app_template_filter` / `add_app_template_filter`, `app_template_test` / `add_app_template_test`, `app_template_global` / `add_app_template_global`, `before_app_request`, `after_app_request`, `teardown_app_request`, `app_context_processor`, `app_errorhandler`, `app_url_value_preprocessor`, `app_url_defaults`.
- Inherited from `Scaffold` (`scaffold.py` `@setupmethod` at 295, 303, 311, 319, 327, 335, 367, 435, 459, 486, 507, 541, 558, 583, 597, 641): `get/post/put/delete/patch`, `route`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`.

**Not blocked:**

- `Blueprint.register()` itself carries **no** `@setupmethod` (`def register` at `blueprints.py:273`; none of the decorator lines precedes it) — it must remain callable to perform registration. Same for `make_setup_state` (`:246`) and `_merge_blueprint_funcs` (`:379`).
- `Flask.register_blueprint` is guarded by the **app's own independent flag**, not this one: `@setupmethod` / `def register_blueprint` at `sansio/app.py:569-570`, checked against `_got_first_request` in `App._check_setup_finished` (`sansio/app.py:411-424`). Runtime repro: *"The setup method 'register_blueprint' can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently."*
- Plain attribute mutation is unguarded: `bp.url_prefix = "/late"` after registration succeeds.
- Registering a **different** blueprint later on the same app is fine (`app.blueprints = ['bp3', 'bp4']`).

### 6. Semantics and non-goals (avoiding the classic conflation)

- **Latch timing.** The flag is set *before* deferred functions run (a deferred function reading `bp._got_registered_once` during replay sees `True`) and immediately after `app.blueprints[name] = self` (`:319-320`). Consequence: a registration that raises part-way through still leaves the blueprint latched (probe: deferred fn raised `RuntimeError`, flag stayed `True`). The name-collision `ValueError` (`:306-314`) precedes the latch, so a collision does not set it.
- **It does not forbid re-registration.** Mounting the same blueprint again under a different name is explicitly allowed — `tests/test_blueprints.py:994-1008`:

```python
def test_unique_blueprint_names(app, client) -> None:
    bp = flask.Blueprint("bp", __name__)
    bp2 = flask.Blueprint("bp", __name__)
    app.register_blueprint(bp)
    with pytest.raises(ValueError):
        app.register_blueprint(bp)  # same bp, same name, error
    app.register_blueprint(bp, name="again")  # same bp, different name, ok
    with pytest.raises(ValueError):
        app.register_blueprint(bp2)  # different bp, same name, error
    app.register_blueprint(bp2, name="alt")  # different bp, different name, ok
```

That `ValueError` comes from the name bookkeeping at `blueprints.py:306-314`, **not** from this flag. The full suite passes (`489 passed in 2.89s`), including `test_unique_blueprint_names`, `test_self_registration` and `test_blueprint_renaming`.

- **Three distinct flags, not one.** (i) `Blueprint._got_registered_once` — blueprint-side latch, **class** attribute at `blueprints.py:172`; (ii) `_got_first_request` — app-side latch, **instance** attribute set in `App.__init__` (`sansio/app.py:411`), with message *"…can no longer be called on the application. It has already handled its first request, any changes will not be applied consistently."*; (iii) `BlueprintSetupState.first_registration` — a per-app/per-name "did this blueprint already contribute here" boolean (`blueprints.py:58-62`), fed by `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (`:316`) through `make_setup_state(app, options, first_bp_registration)` (`:321`) and consumed by `record_once` (`:241`). Its doc comment reads: *"as blueprints can be registered multiple times with the application and not everything wants to be registered multiple times on it, this attribute can be used to figure out if the blueprint was registered in the past already."* These three must not be merged.
- **Scope.** The flag is blueprint-side only. It says nothing about post-first-request setup on the app (that is (ii)) and nothing about once-per-app deferred functions (that is (iii)).

### 7. Test-coverage caveat (no over-claim)

This snapshot contains **no test asserting the blueprint-side `_got_registered_once` message**: `grep -rn -E "registered once|already been registered at least|no longer be called" tests` returns zero matches, `grep -rn "AssertionError" tests/test_blueprints.py` returns zero matches, and the blueprint message string exists only at `src/flask/sansio/blueprints.py:216-217`. The only setup-after-latch test is the **app-side** case `tests/test_basic.py:1676-1690`, which asserts the substring `"setup method 'add_url_rule'"`. So the behaviour above is established by source reading plus a live runtime repro in the snapshot's own venv, not by a blueprint-specific unit test.

### 8. Naming note (the question's "blueprint collection class")

No symbol named `BlueprintCollection` or similar exists (`grep -E "class .*[Cc]ollection|BlueprintCollection|blueprint_collection"` over `src tests docs` → no hits). The only "collection" phrasings are the `Blueprint` docstring at `blueprints.py:120` and `docs/blueprints.rst:23` ("register a collection of blueprints" — blueprints *as a group*, not the class). The question therefore resolves to `flask.sansio.blueprints.Blueprint`.

### 9. Discrepancies in the incoming plan (facts only)

1. The plan cited the name-collision block as `blueprints.py:296-303`; the actual block is `:306-314` (`raise ValueError(` at `:310`).
2. All other plan line numbers checked out: `172` (declaration), guard `213-221`, write-site containing range `316-321` with the assignment at `320`, `scaffold.py:42-49`, `scaffold.py:220-221`, `sansio/app.py:411-424`, `CHANGES.rst:297-300`, `CHANGES.rst:160-161`, `docs/lifecycle.rst:41-51`, `tests/test_blueprints.py:998-1008`.
3. No output file path was configured for this task, so the artifact is this answer; no file was written.

**One-line summary:** `Blueprint._got_registered_once` (class attribute, `flask/sansio/blueprints.py:172`; set true only in `Blueprint.register()` at `:320`; read by `Blueprint._check_setup_finished` at `:214` via the shared `@setupmethod` wrapper) exists so that any setup call after a blueprint has been mounted into an app raises `AssertionError: "The setup method '{f_name}' can no longer be called on the blueprint '{self.name}'. It has already been registered at least once, any changes will not be applied consistently."` — turning a silent, order-dependent wiring mismatch into an immediate, named error and telling the developer to finish blueprint setup before `app.register_blueprint(...)`.
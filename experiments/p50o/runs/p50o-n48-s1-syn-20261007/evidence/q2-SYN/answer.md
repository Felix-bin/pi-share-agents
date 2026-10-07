## Purpose of the registration-tracking flag

The flag is `_got_registered_once` on the `Blueprint` class (`src/flask/sansio/blueprints.py:172`, `_got_registered_once = False`). Its purpose is to make registration a one-way point of no return for blueprint setup: once a blueprint has been registered on an app even once, it refuses any further setup call instead of silently accepting changes that cannot be applied consistently.

**What it tracks.** It records that the blueprint has been registered at least once on some app. `Blueprint.register` (`blueprints.py:271`) sets `self._got_registered_once = True` at line 320, immediately after the duplicate-name check and `app.blueprints[name] = self` (line 319). The flag is declared as a class attribute but only ever assigned as `self._got_registered_once = True`, so each blueprint instance carries its own value. A search of the whole tree for the name returns exactly three occurrences — declaration (172), read (214), write (320) — so nothing resets it to `False`.

**What it prevents.** Every `@setupmethod`-decorated call after that first registration. The decorator (`src/flask/sansio/scaffold.py:42-49`) calls `self._check_setup_finished(f_name)` before delegating to the wrapped function, and the base `Scaffold._check_setup_finished` (`scaffold.py:220`) is `raise NotImplementedError` — the policy is supplied by the subclass. `Blueprint` supplies it at `blueprints.py:213-222`:

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

Because the check lives in the shared decorator, it covers the full setup surface, not one method: in `scaffold.py`, `get`/`post`/`put`/`delete`/`patch`, `route`, `add_url_rule`, `endpoint`, `before_request`, `after_request`, `teardown_request`, `context_processor`, `url_value_preprocessor`, `url_defaults`, `errorhandler`, `register_error_handler`; and in `blueprints.py`, `record`, `record_once`, and `register_blueprint` (line 254). Registering the blueprint itself stays legal — `Blueprintsregister` at line 271 is deliberately *not* decorated, so re-registering an already-registered blueprint is allowed while the flag stays `True`.

**Why it exists.** `register` consumes the blueprint's deferred setup: it builds a `BlueprintSetupState`, calls each entry of `self.deferred_functions` with it, and calls `self._merge_blueprint_funcs(app, name)` when this is the first registration of the blueprint or of the name (`blueprints.py:320-337`). Work recorded after that write is either not replayed or replayed on a later registration only, so it would apply inconsistently across the registrations already done. The source states this rationale in its own error text — "any changes will not be applied consistently" — and the remedy it names is ordering setup before registration. The flag's job is therefore fail-fast: turn a late `route`/`before_request`/`record` into a loud `AssertionError` naming the method and the blueprint, rather than a blueprint that silently behaves differently than its code reads.

**Contrast with the application class.** The same decorator serves `App`, whose trigger is its first *request* rather than its first registration: `self._got_first_request` (`src/flask/sansio/app.py:409-411`) is checked by `App._check_setup_finished` (`app.py:413-421`). The blueprint flag is the blueprint-side analogue of that guard.

Note on the "collection class" wording: the evidence fits `Blueprint` (`src/flask/sansio/blueprints.py`), which owns `deferred_functions`, `_blueprints`, and `register`; `Scaffold` only declares the abstract hook, so it is not the class the flag belongs to.

## What this rests on / what is still open

- Rests on: `blueprints.py:172` (declaration), `:213-222` (guard and full error text), `:271/:319/:320/:331-337` (`register`, flag write, deferred replay and funcs merge), `scaffold.py:42-49` (decorator) and `:220` (abstract hook), `app.py:409-421` (app-side counterpart) — all re-read directly in this run, plus a tree-wide grep for `_got_registered_once` returning only those three lines.
- The design rationale is stated by the source only through the assertion message; the "not applied consistently" phrasing is quoted, while the mechanism-level explanation (deferred functions already replayed/merged) is a reading of `register`'s body rather than a quoted comment.
- Not established: any test pinning the blueprint behaviour. The only match for the message text in `tests/` is `tests/test_basic.py:1690`, which asserts `"setup method 'add_url_rule'"` for the app/first-request branch; there is no blueprint-specific assertion of this flag.
- Out of scope by the task's own framing: whether the flag *should* exist or be relaxed is a design decision, not answered here.
- The mutation script in `flask_mut2_i417ar2x/mutated_test.py` concerns `url_for`/subdomain matching and does not touch this flag, so it does not alter the answer.
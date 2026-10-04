## Answer

**One-line purpose:** `_got_registered_once` is a one-way "sealed" latch on a **single `Blueprint` object** that makes every setup method raise `AssertionError` once that blueprint has been handed to `register()` **for any app**, because `register()` consumes the setup state right then — so any setup call made afterwards would silently take effect only on some apps and not others.

**Premise correction:** the flag is not on a "blueprint collection class." It is a class attribute of `class Blueprint(Scaffold)` (`src/flask/sansio/blueprints.py:119`, declaration at `:172`). The app-side *collection* is `app.blueprints` (a dict, written at `:319`); the flag itself is per-blueprint-object state.

### Mechanism (all in this checkout)
- `setupmethod` (`src/flask/sansio/scaffold.py:40-48`) wraps every setup API so the call first runs `self._check_setup_finished(f_name)` (`:46`).
- `Blueprint` overrides that hook at `sansio/blueprints.py:213-221`: `if self._got_registered_once: raise AssertionError(...)`.
- The write is unconditional, for whatever `app` was passed: `self._got_registered_once = True` at `sansio/blueprints.py:320`, inside `register()` (`:273`), after the same-name `ValueError` (`:~306-314`) and `app.blueprints[name] = self` (`:319`), just before `make_setup_state` (`:321`).
- Whole-tree grep of `src/flask` returns **exactly three** hits (172 declare / 214 read / 320 write) — it is never assigned back to `False`.
- Gated set: every `@setupmethod` method on `Blueprint` — `record` `:224`, `record_once` `:233`, `register_blueprint` `:256`, `add_url_rule` `:413`, plus the `app_/before_/after_/teardown_/errorhandler` family at `:443,460,477,496,515,534,553,563,573,583,595,612,624`. `register()` itself is *not* gated.

### Why it exists (grounded, with the inferential step labelled)
- **Stated reason (from the message itself, `:216-221`):** *"any changes will not be applied consistently… Make sure all imports, decorators, functions, etc. needed to set up the blueprint are done before registering it."*
- **Code that makes that true:** `register()` consumes the accumulated state at that instant — it iterates `self.deferred_functions` once (`:334`) and merges the blueprint's dicts into the app via `_merge_blueprint_funcs`, gated on `first_bp_registration`/`first_name_registration` (`:316-317`, `:331-332`). A `route`/`record`/`before_app_request` after that is applied to no app it was already registered on. *(This causal reading is an inference from the message plus the `register()` body; the "inconsistency" wording in the message is the evidence for it.)*
- **Why "once … any app" rather than "this app":** for the *same* app, a second registration already dies at the name check with a `ValueError` (`:~306-314`) — the executor runtime-reproduced this and confirmed the failure does **not** come from this flag. So the flag's load-bearing cases are setup-after-registration and register-to-app-A-then-setup-for-app-B, where nothing else guards; registering the same object on a *different* app still succeeds (executor runtime run).
- **Maintainer intent, explicit:** 2.2.0 shipped it as a warning — *"Use Blueprint decorators and functions intended for setup after registering the blueprint will show a warning. In the next version, this will become an error just like the application setup methods. :issue:`4571`"* (`CHANGES.rst:297-299`); 2.3.0 escalated — *"Calling setup methods on blueprints after registration is an error instead of a warning. :pr:`4997`"* (`CHANGES.rst:161-162`, inside the 2.3.0 section starting at `:131`). I verified both lines directly, which resolves the retriever's open item (a).
- **It is the app-side latch's mirror:** `Flask._check_setup_finished` (`sansio/app.py:413-416`) raises on `_got_first_request` (init `sansio/app.py:411`, set `True` at `app.py:911`). **Asymmetry worth noting:** the app-side flag *is* reset — `Flask.run()`'s `finally` block sets `self._got_first_request = False` (`app.py:667`) so the dev server can restart in-process — whereas the blueprint flag has no reset anywhere in `src/flask`. Registration is treated as irreversible in-process; first-request is not.
- **Per-instance, not global:** the `False` default lives on the class (`:172`) while `True` is written via `self.…` (`:320`), so other `Blueprint` objects still resolve to `False` (standard attribute shadowing; read from source, not runtime-verified).

### Contradictions / citation corrections found
The retriever's inline evidence and executor memory `6111b798ac16` substantively agree with what I verified, but two citations in them are off:
- the flip changelog entry is **`CHANGES.rst:161-162`**, not `:135` (line 135 is "Drop support for Python 3.7");
- the app-side analogue is **`sansio/app.py:413-416`**, not `app.py:412-421` (`app.py` contains no `_check_setup_finished`).
Substance (2.3.0 flip; app-side analogue) is unaffected. No contradiction of substance between sources.

I attempted to record this as a `conclusion` memory; the write was refused (`summarizer may not write shared memory`), so it is inline only. It refines — does not retire — memory `6111b798ac16`.

### Answered / still open
**Answered:** the flag's purpose, its trigger condition (any app, unconditional write), the full site list and never-reset property, the gating path, the version history and stated maintainer intent, and the same-app case being guarded by a *different* check.
**Open:** (a) no in-repo test asserting the blueprint-side message was found for the patterns searched — "not found," not proof of absence; (b) nothing outside `src/flask` was searched, so whether extensions depend on this flag's semantics is unknown; (c) "never reset" and the shadowing behaviour rest on source reading, and the runtime observations on one script in one environment.

**Rests on:** `src/flask/sansio/blueprints.py:119,172,174-211,213-221,273-334`; `src/flask/sansio/scaffold.py:40-48`; `src/flask/sansio/app.py:411,413-416`; `src/flask/app.py:667,911`; `CHANGES.rst:131,161-162,297-299`; plus the executed runtime run (same-app `ValueError` vs. different-app success) and memories `6111b798ac16` (read, consistent) and the retriever's inline site list. **Not established:** the four open items above.
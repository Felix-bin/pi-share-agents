All central line-level claims check out against the tree. Here is the synthesis.

---

# The hidden coupling between the decorator's state and the response lifecycle

## The answer

`setupmethod` (`src/flask/sansio/scaffold.py:42-49`) is pure indirection — its `wrapper_func` runs `self._check_setup_finished(f_name)` and then the wrapped method; the decorator itself holds no state. The state it consults lives in two flags on the two classes, and **each flag is written by a mechanism that has nothing to do with "the application is now configured"**:

- **`Flask` refuses setup once `self._got_first_request` is true** (`_check_setup_finished`, `src/flask/sansio/app.py:413-422`). That flag is initialised `False` (`sansio/app.py:411`, comment "tracks internally if the application already handled at least one request").
- **`Blueprint` refuses setup once `self._got_registered_once` is true** (`src/flask/sansio/blueprints.py:213-221`), the class default being `False` (`blueprints.py:172`).

The hidden coupling is that **the app-side latch is driven by the response lifecycle, not by configuration or an "app is ready" signal, while the blueprint-side latch is driven by registration, not requests** — yet both gate the same decorator, whose state (the per-scope handler dicts) is read *directly* by the request/response path. So the moment at which nested or conditional registration is refused is decided by whether a request has *started* (app) or a blueprint has been *registered* (blueprint), and the two halves therefore fail in different, non-obvious ways.

### 1. The app latch is set by the first request *starting* — before any response exists

`self._got_first_request = True` is the **first body statement of `Flask.full_dispatch_request`** (`src/flask/app.py:911`, def at `app.py:904`), i.e. it runs *before* `request_started`, `preprocess_request`, `dispatch_request` and `finalize_request`. Reproduced in the worktree (executor cases a4/a5):

- a request that only 404s still latches the flag (`404` status, then `@app.route` raises);
- a request aborted with `abort(403)` in `before_request` still latches it.

So the guard closes not when a response is produced but when one is *begun* — even a failed or aborted request. In-view or `after_request`-hook registration raises the same way (executor a1/a2: body captures `AssertionError: The setup method 'route' can no longer be called ...`), and the full set of gated entry points is large: all of `Scaffold.route/get/post/put/delete/patch/add_url_rule/endpoint/before_request/after_request/teardown_request/context_processor/url_value_preprocessor/url_defaults/errorhandler/register_error_handler`, the app-level template filter/test/global helpers, and `Flask.register_blueprint` (43 `@setupmethod` sites across `sansio/{scaffold,app,blueprints}.py`, verified by source scan).

### 2. Only the dev server ever clears it — so the guard is lifecycle-asymmetric

The single writer that resets the flag is `Flask.run`'s `finally` (`src/flask/app.py:667`, comment "reset the first request information if the development server reset normally"). A whole-package scan gives exactly three app-side write sites: `sansio/app.py:411` (`__init__`, `False`), `app.py:911` (`True`), `app.py:667` (`False`). Nothing clears it for `test_client()` or for a WSGI server. Executor case (d): after a `test_client` request the flag stays `True`; manually setting it back to `False` re-opens every setup method. Consequence: **identical lazy/conditional-registration code raises under a real server or the test client but is silently allowed after a dev-server restart.** Because the flag is not tied to a request *completing*, it is also re-openable by hand, which is not a supported API.

### 3. The blueprint latch closes with **no request at all**

`self._got_registered_once = True` is set at `src/flask/sansio/blueprints.py:320` inside `Blueprint.register`, which `Flask.register_blueprint` calls (`sansio/app.py:569,602`). So the blueprint guard is coupled to *registration*, structurally different from the app guard's coupling to *requests*.

### 4. That is exactly what breaks **nested** registration

`Blueprint.register_blueprint` is itself `@setupmethod` (`blueprints.py:255-256`). Registering a child onto a parent that has already been handed to the app therefore raises with the *blueprint* message, no request involved. Reproduced (executor case c):

```
parent.register_blueprint(child2) after parent registered   AssertionError ... on the blueprint 'parent' ...
child.register_blueprint(grandchild) after child registered AssertionError ... on the blueprint 'child' ...
@child.route after parent registered on app                 AssertionError ... on the blueprint 'child' ...
@child.record_once after parent registered                  AssertionError ... on the blueprint 'child' ...
```

Nested registration succeeds only if the whole tree is assembled **before** the root is passed to the app: pre-registration nesting worked and the child's `record_once` body ran with `first_registration=True` (executor c3, `flags = [('ch.record_once','ch',True)]`). Note also that `Flask.register_blueprint` after the first request reports the *app* message (executor b2), i.e. it is gated by `_got_first_request`, not by any blueprint flag — a second reason the two halves are easy to confuse.

### 5. That is also what breaks **conditional/deferred** registration — with two different failure modes

The `record_once` path carries the subtlest coupling. `Blueprint.record` appends to `self.deferred_functions` (`blueprints.py:230`); `record_once` wraps its callback in `if state.first_registration:` (`blueprints.py:238-244`); `Blueprint.register` computes `first_bp_registration = not any(bp is self for bp in app.blueprints.values())` (`316`) and `first_name_registration = name not in app.blueprints` (`317`), sets the latch (`320`), and builds the setup state with **only** `first_bp_registration` — `state = self.make_setup_state(app, options, first_bp_registration)` (`321`) — while the func-merge uses the **union** `if first_bp_registration or first_name_registration:` (`331`).

Re-registering the *same* blueprint object under a new name therefore merges its dicts into the app and adds it to `app.blueprints`, but **silently skips every `record_once` callback** (executor c2: after `name='renamed'`, only `('record','renamed',False)` fired; `record_once` body skipped, no error). Re-registering under the *same* name instead raises `ValueError: The name 'bpr' is already registered for this blueprint...`. So the same "register it again later" action yields either a hard `AssertionError`, a hard `ValueError`, or a **silent no-op** depending on which knob is turned.

The rest of the story is the documented blind spot: `docs/lifecycle.rst:41-60` states the guard's intent ("Flask tries to help developers catch some of these setup ordering issues by showing an error if setup-related methods are called after requests are handled"), quotes the exact message, and then admits "it is not possible for Flask to detect all cases of out-of-order setup" — listing `app.config`, `app.jinja_env`, `session_interface` and `app.json`, none of which have any flag at all. An app-side test pins the intended behaviour: `tests/test_basic.py:1678-1690` (`test_no_setup_after_first_request`), which asserts `"setup method 'add_url_rule'"` after `client.get("/")` (passes, exit 0).

### 6. Why the decorator exists at all — the other half of the coupling

The guarded registration writes into state the response path reads **directly**, which is the reason a late write "will not be applied consistently": `before_request` appends to `self.before_request_funcs` (`scaffold.py:483`) and `Flask.preprocess_request` iterates it (`app.py:1290`, over `(None, *reversed(request.blueprints))`); `after_request` appends (`scaffold.py:504`) and `Flask.process_response` iterates `reversed(self.after_request_funcs[name])` (`app.py:1318`); same for `teardown_request` (`scaffold.py:538`), `context_processor` (`555`) and `url_defaults` (`594`). These are the `defaultdict(list)`s built in `Scaffold.__init__`, so registration mutates dicts the response path consumes.

One further, request-scoped half of the same coupling: `after_this_request` (`src/flask/ctx.py:117-149`) appends to the **currently active** request context's `_after_request_functions` (line 148), and `process_response` reads that live context (`ctx = request_ctx._get_current_object()` then `for func in ctx._after_request_functions`, `app.py:1311-1314`). A handler registered while a nested request context is current is attached to that context rather than the one being finalised. This one is a code-reading inference (retriever point 9), not an executed reproduction, so treat it as plausible rather than established.

### Summary of the coupling

| | app side | blueprint side |
|---|---|---|
| decorator | `setupmethod` (`scaffold.py:42-49`) | same decorator |
| latch | `_got_first_request` (`sansio/app.py:411`) | `_got_registered_once` (`blueprints.py:172`) |
| check | `sansio/app.py:413-422` | `blueprints.py:213-221` |
| **written by** | the **first request starting** (`app.py:911`, in `full_dispatch_request`) | the **first registration** (`blueprints.py:320`, in `register`) |
| cleared by | `Flask.run`'s `finally` only (`app.py:667`) | never |
| what it breaks | lazy in-view / post-request registration; and behaves differently under `flask run` vs test client / WSGI | nested `Blueprint.register_blueprint`, post-registration `@bp.route`; and re-registration silently skips `record_once` (`321` vs `331`) |

**One contradiction between the two sources, resolved:** the retriever inferred (point 10) that re-registering a blueprint under a second name "silently skips every `record_once` registration …, while any guarded call raises instead" — implying `record` would also be gated. The executor corrected this with the line-level mechanism, which I re-verified: `make_setup_state` receives only `first_bp_registration` (`blueprints.py:321`), whereas the merge uses the union (`331`). So `record` reproduces under a new name; only `record_once` is silently skipped. The corrected version stands.

**Reading chosen for "the decorator":** I read the question as pointing at `setupmethod`, because it is the only decorator whose *guard* is coupled to the response lifecycle (the `_got_first_request` latch written by `full_dispatch_request`). The alternative candidate in the worktree — `@app.route(..., subdomain=...)` and its matching/`url_for` state — is not a decorator-managed latch, and the probe that exercises it (`flask_mut2_i417ar2x/mutated_test.py`) fails for a design reason (`subdomain_matching=False` deliberately forces the empty subdomain, `app.py:457-462`; probe outputs `status_code: 404`), needing no mutation to explain. That probe therefore does not select between the two readings and does not change the answer above.

## What this rests on

- Retriever evidence (handle `bdaedf2b474b`): file/line citations for `setupmethod`, both flags and their writers, the response-path readers, `record`/`record_once`, and `docs/lifecycle.rst:41-60`.
- Executor results (handle `38bf4ed89468`): reproduced failure modes (a)–(d) with verbatim output, the `record_once` silent-skip, the "only `Flask.run` resets" asymmetry, and the source-write-site scans — all run with `PYTHONPATH=<worktree>/src` against this worktree.
- My own re-verification of the load-bearing lines: `grep` on `_got_first_request` (`app.py:667,911`, `sansio/app.py:411,414`), `grep` on `_got_registered_once` / `first_*_registration` (`blueprints.py:172,214,241,316-321,331`), and a direct read of `scaffold.py:42-49`.

## What remains open

- **No injected change exists.** `git status --porcelain` shows only untracked entries (`flask_mut2_i417ar2x/` plus scratch files) and `git diff --stat HEAD` is empty; the tree is unmodified upstream at detached `85c5d93c`. The `flask_mut2_i417ar2x` probe is an artifact, not a modified tracked file.
- **The request-context `after_this_request` nesting** (`ctx.py:117-149`, `app.py:1311-1314`) is a reading inference, not executed — no reproduction of a nested request context attaching to the wrong response was run.
- **No acceptance criterion was stated or applied** — the plan's open decision (whether to relax the guard or ship a patch) was left to the orchestrator and is not answered here; this is an explanation of the coupling, not a fix.
- Whether any late-registration path is intended to be supported (e.g. config/jinja_env) is a product decision not settled by the code, though `docs/lifecycle.rst:41-60` documents it as deliberately undetected.
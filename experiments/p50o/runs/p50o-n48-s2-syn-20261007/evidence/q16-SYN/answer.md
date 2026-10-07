# Where the control flow decides whether a routing rule receives OPTIONS

Two decision points, in sequence: a **registration-time** decision that computes the flag and mutates the rule's method set, and a **request-time** decision that uses the persisted flag to short-circuit dispatch. Both were read at the anchors below and confirmed by a live trace in the worktree (see "Observed outcomes").

## 1. Registration-time — `src/flask/sansio/app.py`, `Flask.add_url_rule`

The parameter is `provide_automatic_options: bool | None = None` (`src/flask/sansio/app.py:610`). The decision block is lines 635–645:

```python
if provide_automatic_options is None:
    provide_automatic_options = getattr(
        view_func, "provide_automatic_options", None
    )

if provide_automatic_options is None:
    if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
        provide_automatic_options = True
        required_methods.add("OPTIONS")
    else:
        provide_automatic_options = False
```

So there is a three-level precedence, and this is the only place the automatic-options flag and the application configuration setting are evaluated together:

1. An explicit `provide_automatic_options=` kwarg wins outright.
2. Otherwise the view object's `provide_automatic_options` attribute supplies the value (`:635-638`).
3. Only if the value is still `None` does the application setting enter: `"OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]` (`:640-641`). Both conditions are required — if the rule already declares `OPTIONS` in `methods`, or the config is false, the branch takes `else: provide_automatic_options = False` (`:645`).

Note the two distinct effects of the branch: it sets the flag, and only inside the true branch does it call `required_methods.add("OPTIONS")` (`:643`). Those are then applied separately — `methods |= required_methods` (`:648`) merges OPTIONS into the rule's method set, and `rule_obj.provide_automatic_options = provide_automatic_options` (`:651`) persists the flag on the Werkzeug rule object. The two are not the same thing: a rule can carry `OPTIONS` in its method set with the flag `False` (the `methods=["GET","OPTIONS"]` path).

## 2. Request-time — `src/flask/app.py`, `Flask.dispatch_request`

The flag persisted at `:651` is consumed at `src/flask/app.py:895-899`:

```python
if (
    getattr(rule, "provide_automatic_options", False)
    and req.method == "OPTIONS"
):
    return self.make_default_options_response()
```

`make_default_options_response` is defined at `src/flask/app.py:953`, and this is its only call site in `src/` (grep for `make_default_options_response` returns the `def` plus this one call). If the target rule's flag is `False`, an `OPTIONS` request is not intercepted here; it is dispatched like any other method, which yields the handler if `OPTIONS` is in the rule's method set, or a 405 if it is not.

## The application configuration setting

- Default: `"PROVIDE_AUTOMATIC_OPTIONS": True` in `default_config` — `src/flask/app.py:208`.
- Sole code read of the key is the branch above — grep for `PROVIDE_AUTOMATIC_OPTIONS` over `src/` returns only `src/flask/app.py:208` and `src/flask/sansio/app.py:641`; remaining hits are docs (`docs/config.rst:391-396`, `docs/api.rst:667`) and CHANGES. Setting it to `False` at the application level therefore gates every rule that does not override the flag explicitly.

## How the flag reaches `add_url_rule` (pass-throughs, no decision of their own)

- Route decorator: `def route(self, rule, **options)` forwards to `self.add_url_rule(rule, endpoint, f, **options)` — `src/flask/sansio/scaffold.py:336,360-361`; abstract parameter at `:373`.
- Blueprint: parameter at `src/flask/sansio/blueprints.py:418`, forwarded via the deferred `self.record(lambda s: s.add_url_rule(..., provide_automatic_options=provide_automatic_options, **options))` — `:436-439`.
- Class-based views: `View.provide_automatic_options: t.ClassVar[bool | None] = None` — `src/flask/views.py:56`, copied onto the generated view by `view.provide_automatic_options = cls.provide_automatic_options` — `:134`, which then feeds the `view_func` attribute path at `sansio/app.py:635-638`.

Each of these only reads or writes the same property; none adds a branch condition.

## Observed outcomes (live trace in the worktree, exit 0)

| registration path | rule methods | persisted flag | `OPTIONS` request |
|---|---|---|---|
| `add_url_rule`, no arg | GET, HEAD, OPTIONS | True | 200, `Allow: GET, HEAD, OPTIONS` |
| kwarg `provide_automatic_options=False` | GET, HEAD | False | 405 |
| `methods=["GET","OPTIONS"]` | GET, HEAD, OPTIONS | False | 200 with the view's own body, `Allow: []` — view ran |
| `@app.route` | GET, HEAD, OPTIONS | True | 200, automatic response |
| `View.provide_automatic_options=False` | GET, HEAD | False | 405 |
| blueprint route kwarg `False` | GET, HEAD | False | 405 |
| built-in `/static/<path:filename>` | GET, HEAD, OPTIONS | True | n/a |

Config default observed `True`; with `app.config["PROVIDE_AUTOMATIC_OPTIONS"]=False`, an otherwise-default rule registered as `['GET','HEAD']` with flag `False`. The `methods=["GET","OPTIONS"]` row is the case that separates the two effects described above: OPTIONS is reachable, but not via `make_default_options_response`.

## Contradictions and dead ends in the supplied material

- `flask_mut2_i417ar2x/mutated_test.py` is a subdomain `url_for` test; it contains no OPTIONS or config-flag logic and is not part of this control flow.
- The ranking-supplied chunk `tests/test_basic.py:65-104` (`test_method_route_no_methods`) is unrelated to OPTIONS. The tests that do exercise these two properties are `tests/test_basic.py:70-107` and `tests/test_views.py:101-136`; the three named ones were run and passed (3 passed, exit 0). They corroborate the wiring but contain no control flow of their own.
- No source-level contradiction between the two stages: the executor re-read the regions and reported the anchors matching the retriever's exactly, and my own re-read of `sansio/app.py:635-651` and `app.py:895-899` matched both.

## What it rests on, and what remains open

Rests on: direct reads of `src/flask/sansio/app.py:610,635-651`, `src/flask/app.py:208,895-899,953`, the pass-through sites in `views.py`/`scaffold.py`/`sansio/blueprints.py`, grep results for the two identifiers, the live end-to-end trace covering all seven registration paths plus the config override, and three passing existing tests.

Open (explicitly not established, and nothing above depends on it): how Werkzeug's `Rule` object itself uses `provide_automatic_options` at match time — the rule internals were not inspected; and the bodies of the `docs/` references beyond grep context. The task's question — the location and branch conditions of the OPTIONS decision — is answered in full by the two code regions above.
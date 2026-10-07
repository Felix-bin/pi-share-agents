# Where the OPTIONS decision is made

Whether a routing rule receives OPTIONS is decided in **two places, split across registration and request time**: the boolean is resolved once when the rule is added — from the caller's keyword argument, then the view's own attribute, then the app config setting — and is stored on the rule object; at request time `dispatch_request` reads only that stored attribute.

## 1. Registration time — the three-way precedence, in `Scaffold.add_url_rule`

`src/flask/sansio/app.py`, `def add_url_rule(` at **:605**, with `provide_automatic_options: bool | None = None` at **:610**. The resolution runs in this order:

- **Explicit kwarg wins outright.** If the caller passed `provide_automatic_options=True/False`, neither branch below runs (both are guarded by `is None`).
- **Stage (a), the automatic-options flag on the view — `:635-638`:**
  ```python
  if provide_automatic_options is None:
      provide_automatic_options = getattr(
          view_func, "provide_automatic_options", None
      )
  ```
  This consults the view callable's attribute, so a view decorated/flagged with `provide_automatic_options = False` (or `True`) disables or force-enables the automatic OPTIONS response.
- **Stage (b), the application configuration setting — `:640-645`:** reached only when both the kwarg and the view attribute are `None`:
  ```python
  if provide_automatic_options is None:
      if "OPTIONS" not in methods and self.config["PROVIDE_AUTOMATIC_OPTIONS"]:
          provide_automatic_options = True
          required_methods.add("OPTIONS")
      else:
          provide_automatic_options = False
  ```
  Two conditions gate the config read: `"OPTIONS"` must not already be in `methods`, and the config value must be truthy. If OPTIONS was already requested explicitly, the config setting is not consulted for enabling — the `else` sets `False`. When the config branch enables it, `OPTIONS` is also added to `required_methods`.
- **The resolved value is persisted onto the rule — `:648` `methods |= required_methods;`, `:650` constructs `rule_obj`, `:651` `rule_obj.provide_automatic_options = provide_automatic_options`.**
- **Config default:** `src/flask/app.py:208` — `"PROVIDE_AUTOMATIC_OPTIONS": True,` inside `default_config = ImmutableDict(` opening at `:178`; the dict is typed on the scaffold base (`src/flask/sansio/app.py:279`, `default_config: dict[str, t.Any]`).
- **Where the per-view flag comes from:** `src/flask/views.py:56` `provide_automatic_options: t.ClassVar[bool | None] = None`, copied onto the generated view function at `src/flask/views.py:134` — that generated function attribute is exactly what stage (a)'s `getattr(view_func, ...)` reads.
- **Forwarding seams (not decisions themselves):** `src/flask/sansio/scaffold.py:368` (abstract signature, parameter at `:373`, docstring at `:428`) and the blueprint pipeline at `src/flask/sansio/blueprints.py:413` / `:418` / `:438`.

## 2. Request time — `Flask.dispatch_request`

`src/flask/app.py`, `def dispatch_request` at **:879**; the decision is **:895-899**:

```python
if (
    getattr(rule, "provide_automatic_options", False)
    and req.method == "OPTIONS"
):
    return self.make_default_options_response()
```

Exact predicate: the **rule attribute** must be truthy and `req.method` must be `"OPTIONS"`. Otherwise execution falls through at **:902** to `self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)` — so when OPTIONS is auto-handled the view is never invoked, and when the attribute is false a non-GET/OPTIONS-style request never reaches the handler for OPTIONS at all (the URL map's `methods` set, built at :648, produces 405 instead).

`make_default_options_response` is defined at `src/flask/app.py:953` and returns an empty response of the app's `response_class` whose `Allow` header comes from `adapter.allowed_methods()`.

**Negative result (grep-verified, not inferred):** a worktree-wide search for `PROVIDE_AUTOMATIC_OPTIONS` returns exactly two source hits — the default at `app.py:208` and the read at `sansio/app.py:641`. There is **no request-time read of the config key**; the app setting can only influence behaviour indirectly, through the attribute written at `sansio/app.py:651`. `dispatch_request` is the only control-flow point that decides whether a rule "receives" OPTIONS at request time.

## 3. Runtime confirmation on this worktree

The executor ran the flow with the bundled interpreter (`sys.path.insert(0, 'src')`; see caveat below), exit 0:

- Default `app.config['PROVIDE_AUTOMATIC_OPTIONS']` → `True`.
- Plain route, no explicit methods → rule attribute `True`, `rule.methods == ['GET','HEAD','OPTIONS']`.
- `View` subclass with `provide_automatic_options = False` → attribute `False`, `methods == ['GET','HEAD']`.
- App with `config['PROVIDE_AUTOMATIC_OPTIONS'] = False` set before registration → attribute `False`, `methods == ['GET','HEAD']`.
- `OPTIONS /plain` → **200** with `Allow: OPTIONS, GET, HEAD`; `OPTIONS /noopt` → **405** (`Allow: GET, HEAD`); `OPTIONS /cfg(off)` → **405**. No view function ran during any OPTIONS request.
- Instrumented `Flask.make_default_options_response`: one call for an auto-handled OPTIONS, zero additional calls on a following GET.

So both branches behave exactly as located, on this worktree's `src/`.

## Corrections, contradictions and gaps

- **Line-number correction:** the stage report cites `def add_url_rule` at `src/flask/sansio/app.py:608`; direct grep/read shows **:605** (its parameters span :606-611, with `provide_automatic_options` at :610 as stated). The stage numbers `635-638`, `640-645`, `648`, `651` were verified correct, as were `app.py:895-899`, `:902`, `:953`, `:208` and `views.py:56`, `:134`. Also, `src/flask/sansio/app.py:279` is the `default_config` annotation, not a declaration of the key itself.
- **Path labelling:** the inherited corpus labels files `flask/src/flask/...`; this worktree's root contains `src/flask/...` directly. All locations above are the real worktree paths.
- **Doc/code mismatch:** `docs/config.rst:391` documents the key and `:449` marks it `.. versionadded:: 3.10`, but `CHANGES.rst` contains no mention of `PROVIDE_AUTOMATIC_OPTIONS` — an internal docs inconsistency that does not affect the code path. `docs/api.rst:667` and `:684` document the per-view attribute.
- **Test coverage gap:** `tests/test_basic.py:70` (`provide_automatic_options_attr`) and `:92` (kwarg) and `tests/test_views.py:101` (`test_view_provide_automatic_options_attr`) exercise the kwarg and view-attribute paths. Grep finds **no test referencing the config key**, so the branch at `sansio/app.py:641` is uncovered by the in-tree suite; its only confirmation here is the executor's ad-hoc runtime check.
- **Mutation:** `flask_mut2_i417ar2x/mutated_test.py` exists in the worktree but exercises `subdomain_matching` / `url_for` and asserts on those — it is unrelated to OPTIONS routing, and no file in the tree carries a deliberately mutated version of this flow.
- **Environment caveat (observed):** the bundled `.venv` editable install resolves `flask` to a *different* checkout, so it does not by itself exercise this worktree; every runtime check forced `sys.path.insert(0, 'src')` and re-confirmed the resolved import path first.

## What is answered and what is still open

Answered in full: the location of the control flow, all branches evaluating the automatic-options flag (`sansio/app.py:635-638`) and the application configuration setting (`sansio/app.py:640-645`, reading `self.config["PROVIDE_AUTOMATIC_OPTIONS"]`), their precedence, where the resolved value is stored (`:651`), and the request-time decision that consumes it (`app.py:895-899`, fall-through `:902`), with runtime confirmation.

Still open: whether this flow has been deliberately mutated (nothing in the tree suggests it); whether the `.venv`-resolves-elsewhere setup is intended or a packaging artifact; and that none of these locations carry version-stable anchors, so the line numbers hold only for the tree as it stands and would shift if these files are edited.
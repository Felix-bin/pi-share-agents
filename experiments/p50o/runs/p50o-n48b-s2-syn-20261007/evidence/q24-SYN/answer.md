# Why the traversal in `_find_error_handler` costs what it costs

## The cost model

`_find_error_handler` (`src/flask/sansio/app.py:823-845`) is three nested loops with **no memoization**:

```python
831  exc_class, code = self._get_exc_class_and_code(type(e))
832  names = (*blueprints, None)
834  for c in (code, None) if code is not None else (None,):
835      for name in names:
836          handler_map = self.error_handler_spec[name][c]
838          if not handler_map:
839              continue
841          for cls in exc_class.__mro__:
842              handler = handler_map.get(cls)
843              if handler is not None:
844                  return handler
845  return None
```

Probes of the inner dict equal

> **probes = Σ over iterated `(code, scope)` pairs of `len(exc_class.__mro__)` if that map is non-empty, else 0 — truncated at the first hit (L843-844).**

The code factor is 2 when `code is not None`, i.e. only for `HTTPException` subclasses (`_get_exc_class_and_code`, `src/flask/sansio/scaffold.py:681-698` returns `(exc_class, exc_class.code)` there, `(exc_class, None)` otherwise), 1 for plain exceptions (L834).

This was measured, not inferred: the unmodified function was run with each inner `handler_map` replaced by a `dict` subclass counting `.get` calls. Closed form matched exactly — depth 1/5/10/40 with the handler at the MRO root gave 2/6/11/41 probes; `len(mro)=13` with the hit in the last scope and *k* non-matching non-empty scopes gave 13k+11 (k=0→11, 1→24, 3→50, 6→89); no match anywhere with 1 and 3 non-empty maps gave 13 and 39.

## Which term multiplies, and which one does not

**Deep inheritance chains are a direct multiplier.** `for cls in exc_class.__mro__` (L841) walks the *full* method-resolution order, one `handler_map.get(cls)` per ancestor, and this walk repeats for **every entered non-empty map**. Every added ancestor therefore costs one probe per code/scope combination entered. Measured: raising depth from 10 to 40 raised probes from 11 to 41, and the scans stop at the hit — a hit at MRO index 3/7/10/40 gave exactly 2/6/11/41. Worst case is a class that never matches: the scan runs to completion (13 probes for the no-match, single-map case).

**Multiple registered handlers only matter if they are spread across scopes.** This is where the task's premise needs correcting. Extra handlers *inside one scope map* add nothing: the inner map is a plain `dict` (`error_handler_spec: dict[AppOrBlueprintKey, dict[int | None, dict[type[Exception], handler]]] = defaultdict(lambda: defaultdict(dict))`, `src/flask/sansio/scaffold.py:123-127`) and the probe at L842 is O(1). Measured: 1 vs 5 vs 50 vs 1000 handlers in one map all gave 2 probes. What enlarges the scan is the `names = (*blueprints, None)` dimension (L832) — i.e. registering handlers on the app *and* on blueprints, since blueprint maps are merged into `app.error_handler_spec[key]` under the blueprint name (`src/flask/sansio/blueprints.py:392-397`). Even then the multiplication is conditional: extra scopes cost **0** probes when the matching handler is already in the first scope (early `return`), and empty maps cost 0 via `if not handler_map: continue` (L838-839) — measured, a blueprint scope with an empty map gave the same 11 probes as no blueprint at all; and a blueprint whose map holds no class in the MRO costs `len(mro)` each.

**The HTTP-code dimension doubles work only when both keys are populated.** `NotFound` (code 404, `len(mro)=5`) with only `[None][None]` non-empty cost 5 probes; with `[None][404]` *and* `[None][None]` both non-empty it cost 10 (5+5). An `Exception` handler registered under code 404 only cost 3.

So the overhead is multiplicative in **inheritance depth × number of entered non-empty scopes (app + blueprint nesting, +1)** and ×2 for HTTP errors, not in handler count.

## Why it shows up as recurring per-error cost

- **Nothing caches the traversal.** `_find_error_handler` at L823 carries no decorator; the only functional cache in the package is `@cache` on `_split_blueprint_path` (`src/flask/helpers.py:8, 627`), which memoizes the scope list — so `len(blueprints)` (current blueprint plus its parents) is free, but the dict-probe scan is re-run in full on every call. `exc_class.__mro__` is an attribute read at the inner-loop header, not recomputed.
- **It runs on every handled error, and twice for unhandled ones.** Callers: `app.py:774` (`handle_http_exception`), `app.py:804` (`handle_user_exception`), and `app.py:857` (`handle_exception`, which constructs a fresh `InternalServerError` and calls again). An exception with no registered handler — the worst case for a single call, since the scan cannot short-circuit — pays a second complete traversal.
- **It also mutates the structure it reads.** Because `error_handler_spec` is a nested `defaultdict`, the read at L836 materializes keys: after one `NotFound` lookup, `spec[None]` keys went from `[None]` to `[404, None]`. This is an allocation/dict-growth side effect of looking up, observed but not measured for cost.

## What is answered, and what stays open

Answered: the loop structure and each multiplying factor with file:line; the closed-form probe count, verified against measured probe counts for depth, scope count, map count, empty scopes and the HTTP code dimension; that handler count within a scope is O(1) and is *not* an amplifier; that no mitigation exists on the traversal and that unhandled exceptions traverse twice.

Open / uncertain: **no wall-clock or latency measurement was taken** — everything above is probe counts plus structure, so "overhead" is an asymptotic claim, and whether it is material next to the rest of error handling is not established. Relatedly, the callers were located but not executed, so it is not established that a given request path actually reaches the function. The premise's own wording ("multiple registered error handlers create overhead") is only partially supported and is contradicted as stated for handlers sharing one scope: the effective multipliers are inheritance depth and the number of non-empty, non-pre-empted app/blueprint scopes. The corpus-ranked path `flask/tests/test_user_error_handler.py` does not exist in this worktree; the content is at `tests/test_user_error_handler.py`, where `test_error_handler_subclass` (lines 79-119) exercises the MRO-scan-finds-ancestor case as behavior, not cost. No source file was edited, so no fix is proposed or validated here.

*Basis and consistency:* the answer rests on direct reads of `src/flask/sansio/app.py:823-845`, `src/flask/sansio/scaffold.py:123-127` and `:653-698`, `src/flask/sansio/blueprints.py:392-397`, `src/flask/helpers.py:8,627` (re-confirmed at synthesis time), and on the executor's instrumentation run of the unmodified function. It agrees with the two pre-existing recalled memory records on this same function body; no contradiction was found. The synthesized conclusion was recorded under topic "flask _find_error_handler traversal cost / error-handler lookup overhead" (memory `8a98c6b5d8e74f63518d591396b5493261f875ad6900b8336ab3b2df5ae04d6c`).
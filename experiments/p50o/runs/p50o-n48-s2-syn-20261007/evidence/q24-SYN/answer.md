# Why `_find_error_handler`'s class-hierarchy walk is expensive

## The short answer

In this worktree, `App._find_error_handler` (`src/flask/sansio/app.py:823-846`) does **not** walk the exception MRO once. The MRO walk is the *innermost* of three nested loops:

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
844              if handler is not None:
845                  return handler
846  return None
```

(verified directly at these exact lines). So the linear class-hierarchy scan is re-executed **once per non-empty `(code, name)` bucket** rather than once per lookup. The per-element cost of the linear walk is trivial — `handler_map.get(cls)` is an O(1) dict lookup on a class object — but the *number of executions of that walk* multiplies:

**lookups per call ≈ (number of non-empty code × scope buckets visited) × (length of `exc_class.__mro__` scanned before a match)**

This was measured, not just read: an executor probe drove the real method from this worktree and got `mro_len=12` with 4 non-empty buckets → 48 `.get` calls; 8 buckets × 12 → 96 calls; the same relation held in every structural case (8/8 checks passed). The multiplication, not the linear order, is where the overhead comes from.

## Why deep inheritance chains add cost

`exc_class.__mro__` (line 841) is linearly as long as the exception's inheritance depth, and that length is paid once per bucket. Measured: shallow MRO (len 4) → 4 calls with one bucket, deep MRO (len 12) → 12 calls with the same one bucket. Because the walk sits inside both outer loops, depth is paid again for every code and every blueprint scope. The scan returns early only when the registered handler sits high in the MRO (a match at index 0 costs a single `.get`, measured), so the chain length is fully paid in the two cases that matter in practice: **no handler is registered for any class on the MRO**, and **the matching handler sits on a distant base class**. `return None` at line 846 is only reached after exhausting every code, every scope name, and every MRO entry.

## Why "multiple registered error handlers" add cost — but only in one specific way

The relevant multiplier is **the number of distinct non-empty `(code, name)` buckets**, not the number of entries in any single map:

- The guard at lines 838-839 (`if not handler_map: continue`) skips codes/scopes with no registrations at all, so those cost nothing.
- Inside a non-empty map, lookups are O(1): the probe put **50 handlers in one bucket and still measured 10 `.get` calls** (MRO length 10). Entry count is irrelevant.
- Registering handlers in *more codes* and *more blueprint scopes* removes `continue` skips and produces more full MRO scans. Per-blueprint registration is what puts extra scopes into the middle loop: `_merge_blueprint_funcs` copies a blueprint's handler maps into `app.error_handler_spec` under the prefixed blueprint key (`src/flask/sansio/blueprints.py:384-397`), alongside the app-level write `self.error_handler_spec[None][code][exc_class] = f` (`src/flask/sansio/scaffold.py:642-654`).
- The scope loop itself grows with blueprint nesting: `names = (*blueprints, None)` (line 832) is fed from `request.blueprints`, documented as "the registered names of the current blueprint upwards through parent blueprints" (`src/flask/wrappers.py` `blueprints` property).
- An HTTP-coded exception multiplies again: line 834 iterates `(code, None)`, so both the `c=code` pass and the `c=None` pass re-run the whole MRO scan over the bucket set. Measured: two non-empty buckets × MRO 6 = 12 calls, versus 6 for a single pass.

## Aggravating factors confirmed by measurement

- **Nothing is cached.** Repeating a byte-identical lookup re-does the full scan (measured 6 → 12 cumulative `.get` calls across two calls).
- **The lookup mutates the structure it reads.** `error_handler_spec` is `defaultdict(lambda: defaultdict(dict))` (`src/flask/sansio/scaffold.py:123-126`), so `self.error_handler_spec[name][c]` at line 836 *creates* empty entries for unseen `name`/`code` pairs during a lookup. The probe observed scope keys going from 0 to 4 on a lookup over blueprints `['x','y','z']`. Repeated error lookups across many blueprint scopes therefore grow the spec rather than merely reading it.
- **A single failing request can pay the product several times.** `_find_error_handler(e, request.blueprints)` is called at `src/flask/app.py:774` (`handle_http_exception`), `:804` (`handle_user_exception`), and `:857` (`handle_exception`, on the synthesised `InternalServerError`) — all three verified in the source. An unhandled error can therefore traverse the nested loops on more than one of these paths, the last of which always carries an HTTP code and thus pays both outer passes.

## The claim I am *not* making

No wall-clock timing was taken anywhere in this run, so "overhead" here is established as a **call-count law and a structural multiplier**, not as a measured slowdown. Per-element cost is deliberately cheap (hash of a class object in C); the cost driver is `depths × scopes × codes` growing together, so the effect is asymptotic in the shape of the application, not a large constant per lookup. It is also not established what a full real request costs end-to-end, since only the lookup method itself was driven.

## What is answered and what is open

**Answered:** why the linear hierarchy walk is the wrong place to look for the cost (it is nested, so it repeats), how deep inheritance chains multiply it (MRO length paid per bucket), and how multiple registered handlers multiply it (bucket count, not map entry count) — with the exact lines and measured call counts behind each.

**Open:** the magnitude in wall-clock terms under a realistic blueprint/handler layout; the end-to-end cost through `app.py:774/804/857` on a real failing request; whether the test suite pins the traversal order (untouched by both the retriever and the executor). A sibling directory `flask_mut2_i417ar2x/mutated_test.py` exists but concerns subdomain URL matching and is unrelated to this lookup.

**Rests on:** direct reads of `src/flask/sansio/app.py:823-846` and `src/flask/sansio/scaffold.py:123-126` in this worktree (line numbers match the retriever's); the retriever's verified citations for `wrappers.py`, `blueprints.py:384-397`, `scaffold.py:642-654` and the three call sites, which I re-verified by grep; the executor's instrumented probe of the real method (8/8 structural checks, with its own self-flagged assertion bug in case 4 that did not affect the measurement); and an earlier instrumented probe recorded for this worktree, whose handler-`.get` counting agrees with the executor's. No contradiction between sources was found — the only discrepancy is a one-line range for the `error_handler_spec` declaration (retriever said 123-125; the assignment including `= defaultdict(...)` ends at 126).
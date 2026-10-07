# Why the linear `__mro__` traversal in `Flask._find_error_handler` costs more as inheritance chains deepen and handler registrations multiply

## 1. The short answer

`_find_error_handler` resolves an exception by a **triple-nested linear scan**: an outer loop over the code buckets `(code, None)`, a middle loop over the scopes `(*blueprints, None)`, and an innermost loop over `exc_class.__mro__` (`src/flask/sansio/app.py:834`, `:835`, `:841`). There is no index from exception type to handler; the function *probes* each candidate class with `handler_map.get(cls)` (`:842`) until one hits or the classes are exhausted. Consequently its cost per handled error is

> **probes ≈ `C × (B + 1) × M`** Python-level `dict.get` calls,

where **M = `len(exc_class.__mro__)`**, **B + 1 = `len(names)` = `len(blueprints) + 1`**, and **C = 2 if the exception has an HTTP `code` (and therefore two buckets `(code, None)` are tried) else C = 1**.

The two conditions named in the question push two *different* factors of that product:

* **Deep exception inheritance chains** make `M` larger — one extra class in the chain adds exactly one more `handler_map.get(cls)` probe, in *every* bucket that is traversed.
* **Multiple registered error handlers** make the number of **non-empty `(scope, code)` buckets** larger. The only short-circuit in the function is `if not handler_map: continue` (`:838–839`), which is *bucket-level*: a bucket that holds a handler for *anything* passes the guard and then forces a **fresh, full re-walk of the same MRO**. So handlers don't just add entries (adding an entry to a `{class: handler}` map is still one O(1) lookup for a known class); they convert buckets from skippable-empty into MRO-walking non-empty.

Because those two factors multiply rather than add, the lookup is a *scaling* problem, not a constant one: it degenerates from a constant-time type-keyed lookup into the full Cartesian product `C × (B+1) × M`, and it is paid on every error — twice for an unhandled non-HTTP error. Flask's own changelog records that this traversal is deliberate: handler caching was *removed* because it produced wrong results for some inheritance hierarchies (`CHANGES.rst:890–893`).

---

## 2. The mechanism, from the source

The entire mechanism is this function, `src/flask/sansio/app.py:823–846` (re-verified in this repository; it occupies exactly lines 823–846, and `def trap_http_exception` starts at 848):

```python
    def _find_error_handler(
        self, e: Exception, blueprints: list[str]
    ) -> ft.ErrorHandlerCallable | None:
        """Return a registered error handler for an exception in this order:
        blueprint handler for a specific code, app handler for a specific code,
        blueprint handler for an exception class, app handler for an exception
        class, or ``None`` if a suitable handler is not found.
        """
        exc_class, code = self._get_exc_class_and_code(type(e))
        names = (*blueprints, None)

        for c in (code, None) if code is not None else (None,):
            for name in names:
                handler_map = self.error_handler_spec[name][c]

                if not handler_map:
                    continue

                for cls in exc_class.__mro__:
                    handler = handler_map.get(cls)

                    if handler is not None:
                        return handler
        return None
```

Three structural facts follow directly from this text:

1. **The MRO walk is the innermost loop** (`for cls in exc_class.__mro__`), and the *same tuple* is iterated once per non-empty `(c, name)` bucket. The MRO is never intersected once and reused; it is re-walked `C × (B+1)` times within a single call.
2. **The only short-circuit is bucket-level** — `if not handler_map: continue` — not class-level. Any bucket containing a handler for *any* class passes the guard and then forces a complete MRO walk, even when nothing in that bucket is relevant to `exc_class`.
3. **`return None` is reached only after the whole nested product is exhausted**, so the worst case is the complete `C × (B + 1) × M` walk. This is exactly the no-match case, and also the case where the match is at a base class (`Exception`, `HTTPException`) after all more specific classes have been probed.

The cost model's three factors come from three lines of that function:

* `C` — `for c in (code, None) if code is not None else (None,):` (`:834`).
* `B + 1` — `names = (*blueprints, None)` (`:832`).
* `M` — `for cls in exc_class.__mro__:` (`:841`), with the per-class probe `handler = handler_map.get(cls)` (`:842`).

### Where each factor is produced

**`C` — from `_get_exc_class_and_code`** (`src/flask/sansio/scaffold.py:656–698`; the `def` is at 656 and the body ends at 698 — note the plan's "656–710" was slightly off):

```python
    @staticmethod
    def _get_exc_class_and_code(
        exc_class_or_code: type[Exception] | int,
    ) -> tuple[type[Exception], int | None]:
        """Get the exception class being handled. For HTTP status codes
        or ``HTTPException`` subclasses, return both the exception and
        status code.

        :param exc_class_or_code: Any exception class, or an HTTP status
            code as an integer.
        """
        exc_class: type[Exception]

        if isinstance(exc_class_or_code, int):
            try:
                exc_class = default_exceptions[exc_class_or_code]
            except KeyError:
                raise ValueError(
                    f"'{exc_class_or_code}' is not a recognized HTTP"
                    " error code. Use a subclass of HTTPException with"
                    " that code instead."
                ) from None
        else:
            exc_class = exc_class_or_code

        if isinstance(exc_class, Exception):
            raise TypeError(
                f"{exc_class!r} is an instance, not a class. Handlers"
                " can only be registered for Exception classes or HTTP"
                " error codes."
            )

        if not issubclass(exc_class, Exception):
            raise ValueError(
                f"'{exc_class.__name__}' is not a subclass of Exception."
                " Handlers can only be registered for Exception classes"
                " or HTTP error codes."
            )

        if issubclass(exc_class, HTTPException):
            return exc_class, exc_class.code
        else:
            return exc_class, None
```

So `code` is `None` for plain exceptions (**C = 1**: only the `(None,)` bucket is scanned) and an int for `HTTPException` subclasses (**C = 2**: `(code, None)` are both scanned).

**`B + 1` — from `request.blueprints` and `_split_blueprint_path`.** `src/flask/wrappers.py:180–195`:

```python
    @property
    def blueprints(self) -> list[str]:
        """The registered names of the current blueprint upwards through
        parent blueprints.

        This will be an empty list if there is no current blueprint, or
        if URL matching failed.

        .. versionadded:: 2.0.1
        """
        name = self.blueprint

        if name is None:
            return []

        return _split_blueprint_path(name)
```

`src/flask/helpers.py:627–634`:

```python
@cache
def _split_blueprint_path(name: str) -> list[str]:
    out: list[str] = [name]

    if "." in name:
        out.extend(_split_blueprint_path(name.rpartition(".")[0]))

    return out
```

For `grandchild` nested as `parent.child.grandchild`, this returns `["parent.child.grandchild", "parent.child", "parent"]` → `B = 3`, so `names = (*blueprints, None)` has **B + 1 = 4** entries. (`@cache` makes the *list construction* cheap; what costs is the *number of buckets probed*.) With no active blueprint, `blueprints == []` and `names == (None,)` → B + 1 = 1.

**The shape of the buckets** — `error_handler_spec` is a three-level tree `{scope: {code: {class: handler}}}`, built as a defaultdict of defaultdict of dict (`src/flask/sansio/scaffold.py:110–126`; the `defaultdict(lambda: defaultdict(dict))` terminator is at line 126, the annotation `self.error_handler_spec: dict[` at 123 — the plan's "118–128" was off by a few lines):

```python
        #: A data structure of registered error handlers, in the format
        #: ``{scope: {code: {class: handler}}}``. The ``scope`` key is
        #: the name of a blueprint the handlers are active for, or
        #: ``None`` for all requests. The ``code`` key is the HTTP
        #: status code for ``HTTPException``, or ``None`` for
        #: other exceptions. The innermost dictionary maps exception
        #: classes to handler functions.
        #:
        #: To register an error handler, use the :meth:`errorhandler`
        #: decorator.
        #:
        #: This data structure is internal. It should not be modified
        #: directly and its format may change at any time.
        self.error_handler_spec: dict[
            ft.AppOrBlueprintKey,
            dict[int | None, dict[type[Exception], ft.ErrorHandlerCallable]],
        ] = defaultdict(lambda: defaultdict(dict))
```

The middle loop's `handler_map = self.error_handler_spec[name][c]` (`sansio/app.py:836`) is therefore **the innermost `{class: handler}` dict** for one scope and one code — precisely one "bucket".

---

## 3. Why deep inheritance chains raise the cost (the `M` multiplier)

Every registered handler is a *single key* in that innermost map. `src/flask/sansio/scaffold.py:641–654`:

```python
    @setupmethod
    def register_error_handler(
        self,
        code_or_exception: type[Exception] | int,
        f: ft.ErrorHandlerCallable,
    ) -> None:
        """Alternative error attach function to the :meth:`errorhandler`
        decorator that is more straightforward to use for non decorator
        usage.

        .. versionadded:: 0.7
        """
        exc_class, code = self._get_exc_class_and_code(code_or_exception)
        self.error_handler_spec[None][code][exc_class] = f
```

(Both `@app.errorhandler(...)` and `@bp.errorhandler(...)` funnel through this write — see the thin decorator at `scaffold.py:598–640`, whose body is `self.register_error_handler(code_or_exception, f)`.)

**Consequence:** lookup of a **known** class is one O(1) `dict.get(cls)`. The linear cost comes *solely* from probing **unknown** classes along the MRO. The scan is nearest-first over `exc_class.__mro__`, so it must keep calling `.get` on successive ancestors until one of them happens to be a key in that bucket — and if none is, it must try every one of them.

For a chain defined as `A1(Exception) … AD(A_{D-1})`, the runtime MRO of `A_D` is

> `[A_D, A_{D-1}, …, A_1, Exception, BaseException, object]`, hence **M = D + 3**.

Each extra ancestor adds **exactly one** further `handler_map.get(cls)` probe — and it adds it in every non-empty bucket, not just once. This is confirmed exactly by the micro-benchmark (Part A): for D = 1 the MRO has 4 entries and the call performs 4 probes; for D = 80 the MRO has 83 entries and the call performs 83 probes — `probes / M` is exactly 1.00 at every depth, with a single non-empty bucket.

Measured (executor, `bench_find_error_handler.py`, run with `PYTHONPATH=src .venv/Scripts/python.exe`, exit 0):

```
=== PART A: MRO-depth scaling (M) ===
plain exception, exactly 1 non-empty bucket (None,None) -> C=1, B+1=1, probes == M
   D len(mro)=M   probes  probes/M    best us  median us
   1          4        4      1.00      1.035      1.092
   2          5        5      1.00      1.235      1.459
   3          6        6      1.00      1.323      1.436
   4          7        7      1.00      1.551      1.656
   5          8        8      1.00      1.658      1.795
  10         13       13      1.00      2.310      2.558
  20         23       23      1.00      3.837      4.097
  40         43       43      1.00      6.825      7.157
  80         83       83      1.00     12.581     12.750
```

Probe counts here are **counted exactly**, not estimated: the benchmark wraps every innermost `{class: handler}` map in a `CountingDict(dict)` subclass, so `dict.get` calls on the innermost maps are tallied — that is the unit of work at `sansio/app.py:842`. The timing column is a separate, secondary observation (≈ +0.157 µs per additional MRO entry across the 4→83-entry range).

---

## 4. Why many registered handlers raise the cost (the bucket multiplier) and defeat the guard

The `if not handler_map: continue` guard at `sansio/app.py:838–839` only spares buckets that are **completely empty**. It is not a relevance test. As soon as a bucket contains *any* handler — for any class, at that code, in that scope — the guard falls through and the entire `for cls in exc_class.__mro__` loop runs for that bucket.

That yields the key non-obvious effect:

> **The number of handlers inside a single map does not lengthen the walk** — matching a known class is still one O(1) `dict.get`. What lengthens the walk is the number of **non-empty `(scope, code)` buckets**, because each such bucket forces a *fresh* full MRO pass.

So the two ways "multiple registered error handlers" translate into cost are:

1. **More scopes.** Every blueprint that registers handlers creates a distinct top-level scope key in the app's tree, and every ancestor blueprint in a nesting chain adds another name to `blueprints`. This is how blueprint scopes are materialised — `src/flask/sansio/blueprints.py:388–397`:

```python
        for key, value in self.error_handler_spec.items():
            key = name if key is None else f"{name}.{key}"
            value = defaultdict(
                dict,
                {
                    code: {exc_class: func for exc_class, func in code_values.items()}
                    for code, code_values in value.items()
                },
            )
            app.error_handler_spec[key] = value
```

   (Called from `Blueprint.register`: `if first_bp_registration or first_name_registration: self._merge_blueprint_funcs(app, name)` at `blueprints.py:330–332`, with the dotted `name` computed at `:304` — the plan's "338–340" was off.)

2. **More code buckets.** Registering catch-alls (`HTTPException`, `Exception`, `500`, `403`, …) across scopes makes those `(scope, code)` pairs non-empty, and raises C to 2 for `HTTPException` subclasses.

The measured scaling (benchmark Part B), fixed `M = 6`, with the app bucket and every blueprint bucket non-empty and the exception non-matching:

```
=== PART B: number of scopes (blueprints) scaling -> B+1 buckets ===
plain non-matching exception; app bucket + every blueprint bucket non-empty; B = len(blueprints)
   B    M  buckets   probes   (B+1)*M    best us   median us
   1    6        2       12        12      2.514      2.583
   2    6        3       18        18      3.750      3.803
   3    6        4       24        24      4.614      4.823
   4    6        5       30        30      5.571      5.914
   5    6        6       36        36      6.608      6.747
   8    6        9       54        54      9.610     10.187
  12    6       13       78        78     13.991     14.907
```

Probes equal `(B+1) × M` exactly at every B — i.e. the same MRO tuple is walked once per bucket. Timing grows by roughly +1.06 µs per extra non-empty bucket (2→13 buckets: 2.5→14.9 µs). The combination of both multipliers, all buckets non-empty, is Part C2:

```
=== PART C2: full product C*(B+1)*M with all buckets non-empty ===
blueprints=['x1.x2', 'x1'] -> B+1=3, C=2, M=5, probes=30, C*(B+1)*M=30, best_us=6.011
```

and the C multiplier in isolation (Part C):

```
=== PART C: C multiplier (both a code bucket and the class bucket non-empty) ===
ExcB(code=409): C=2; M=5; probes=10; C*1*M=10; best_us=0.697 median_us=0.788
plain A3(code=None): C=1; M=6; probes=6; C*1*M=6; best_us=0.485 median_us=0.565
```

The `test_nested_blueprint` scenario is reproduced end-to-end (Part B2), showing that the B multiplier is real in the shipped request path and that a *successful* match short-circuits early while the worst case for the same request is the full product:

```
=== PART B2: real end-to-end nested-blueprint resolution (B=3) ===
replicates tests/test_blueprints.py::test_nested_blueprint setup (url_prefix nesting)
                    /parent/no -> 403 b'Parent no'
              /parent/child/no -> 403 b'Parent no'
   /parent/child/grandchild/no -> 403 b'Grandchild no'
scope keys in error_handler_spec: ['parent', 'parent.child.grandchild', 'parent.child']
_split_blueprint_path('parent.child.grandchild') = ['parent.child.grandchild', 'parent.child', 'parent']  -> names = ['parent.child.grandchild', 'parent.child', 'parent', None] (len 4)
for a 403 in the grandchild: buckets searched = 4, M(Forbidden) = 5
handler found = 'grandchild_forbidden'; total dict.get probes in that real call = 1
  (that real call short-circuits: grandchild bucket holds Forbidden, so cls=Forbidden hits on probe #1)
  worst case for the SAME request (no bucket matches) would be (B+1)*M = 4 * 5 = 20 probes
non-matching 403 subclass: M=5, handler=None, probes=10
  buckets with any handler at code 403 while walking ['parent.child.grandchild', 'parent.child', 'parent']: grandchild + parent (child and the None scope hold nothing at 403)
```

That the multi-bucket ordering is a pinned, load-bearing semantic (and therefore cannot simply be reordered away) is confirmed by the tests: `tests/test_blueprints.py::test_nested_blueprint` registers `errorhandler(403)` on both `parent` and `grandchild` and asserts

```python
    assert client.get("/parent/no").data == b"Parent no"
    assert client.get("/parent/child/no").data == b"Parent no"
    assert client.get("/parent/child/grandchild/no").data == b"Grandchild no"
```

and `tests/test_user_error_handler.py` pins the cross-product ordering (`test_default_error_handler`, `test_error_handler_blueprint`, `test_error_handler_subclass`, `test_error_handler_http_subclass`, `TestGenericHandlers`), while `tests/test_blueprints.py::test_blueprint_specific_error_handling` pins the fallback to the `None` scope. Grepping the test suite for `_find_error_handler`, `error_handler_spec`, `__mro__` or `mro` returns **no matches** — the semantics are pinned behaviourally only, so the loop structure is the thing under discussion, not an implementation detail some test asserts on directly.

---

## 5. Where it sits on the request path (hot-path amplification)

There are exactly three call sites, all in `src/flask/app.py` (lines 774, 804, 857):

**`handle_http_exception`** — `app.py:770–777`:

```python
        handler = self._find_error_handler(e, request.blueprints)
        if handler is None:
            return e
        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

Its docstring documents the traversal semantic (`app.py:757`): `Exceptions are looked up by code *and* by MRO, so`.

**`handle_user_exception`** — `app.py:802–809`:

```python
        handler = self._find_error_handler(e, request.blueprints)

        if handler is None:
            raise

        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

**`handle_exception`** — `app.py:853–861`:

```python
        self.log_exception(exc_info)
        server_error: InternalServerError | ft.ResponseReturnValue
        server_error = InternalServerError(original_exception=e)
        handler = self._find_error_handler(server_error, request.blueprints)

        if handler is not None:
            server_error = self.ensure_sync(handler)(server_error)
```

`full_dispatch_request` funnels into the second (`app.py:918–919`: `except Exception as e: rv = self.handle_user_exception(e)`), and `wsgi_app` funnels into the third (`app.py:1513–1514`: `except Exception as e: error = e; response = self.handle_exception(e)`).

**Amplification:** because `handle_user_exception` *re-raises* when no handler matches, a single unhandled non-HTTP error runs the lookup **twice** — once at `:804` for the original exception (full walk, `C = 1`, returns `None`), and once at `:857` for the wrapping `InternalServerError`, whose `code == 500` forces **C = 2** buckets `(500, None)` regardless of the original exception class. Meanwhile, every 404 counts as an error for `handle_http_exception`, so in 404-heavy or API workloads this walk is on the steady-state path, not an exceptional one. The benchmark's Part F shows there is no cache consulted at all for repeated identical errors:

```
=== PART F: repeated identical errors on the hot path ===
D=20 (M=23), 1 bucket: 1.039 us/call over 100000 calls; no cache is consulted
```

That this is by design is recorded in `CHANGES.rst:890–893`:

```
-   Removed error handler caching because it caused unexpected results
    for some exception inheritance hierarchies. Register handlers
    explicitly for each exception if you want to avoid traversing the
    MRO. :pr:`2362`
```

This is the only `MRO` hit in `CHANGES.rst` (line 893) and it is the strongest external corroboration: caching was deliberately removed because it returned handlers Flask considered wrong for some inheritance hierarchies, so the per-call traversal is what remains, with "register handlers explicitly for each exception" offered as the documented avoidance strategy. The documented semantics the traversal implements are in `docs/errorhandling.rst:158–172`:

```
When Flask catches an exception while handling a request, it is first looked up by code.
If no handler is registered for the code, Flask looks up the error by its class hierarchy; the most specific handler is chosen.
If no handler is registered, :class:`~werkzeug.exceptions.HTTPException` subclasses show a
generic message about their code, while other exceptions are converted to a
generic "500 Internal Server Error".

For example, if an instance of :exc:`ConnectionRefusedError` is raised,
and a handler is registered for :exc:`ConnectionError` and
:exc:`ConnectionRefusedError`, the more specific :exc:`ConnectionRefusedError`
handler is called with the exception instance to generate the response.

Handlers registered on the blueprint take precedence over those registered
globally on the application, assuming a blueprint is handling the request that
raises the exception. However, the blueprint cannot handle 404 routing errors
because the 404 occurs at the routing level before the blueprint can be
determined.
```

and `docs/errorhandling.rst:231–234`:

```
Error handlers still respect the exception class hierarchy. If you
register handlers for both ``HTTPException`` and ``Exception``, the
``Exception`` handler will not handle ``HTTPException`` subclasses
because the ``HTTPException`` handler is more specific.
```

`CHANGES.rst:865–867` documents the same nesting as the loop order:

```
-   Error handling will try handlers registered for ``blueprint, code``,
    ``app, code``, ``blueprint, exception``, ``app, exception``.
    :pr:`2314`
```

---

## 6. The cost model, stated precisely (and verified)

Using the definitions above, with `M = len(exc_class.__mro__)`, `B = len(blueprints)`, and `C ∈ {1, 2}`:

1. **Probe count.** The worst case — no handler, or a match only at a base class such as `Exception`/`HTTPException` after all specific classes have been probed — is exactly **`C × (B + 1) × M`** `dict.get` calls plus loop overhead. This is an *equality*, not just a bound, and it was measured exactly: Part A gives `probes == M` at every depth (1.00 ratio); Part B gives `probes == (B+1)×M` at every B; Part C gives 10 = 2·M for C = 2; Part C2 gives 30 = 2·3·5. It is emphatically **not O(1)** — it is the product of three independent sizes.
2. **Deep chains raise M linearly.** `A1(Exception) … AD(A_{D-1})` gives `M = D + 3` (`A_D … A_1, Exception, BaseException, object`), and each extra ancestor costs exactly one more `handler_map.get(cls)` in every non-empty bucket.
3. **Many handlers enlarge the bucket count and defeat the guard.** `if not handler_map: continue` skips only *empty* buckets. Any non-empty bucket forces a fresh full MRO walk, even when its contents are irrelevant. So the walk is *multiplied* by the number of non-empty `(scope, code)` buckets; more entries inside a single map do not lengthen the inner loop (a known class is still O(1)) — the growth is cross-bucket and cross-code.
4. **The MRO is re-walked per bucket, not intersected once.** The same tuple is iterated `C × (B + 1)` times inside one call (Part B: 2·M, 3·M, …, 13·M probes from one shared MRO).
5. **Hot-path amplification.** `handle_exception` re-invokes the lookup for the wrapping `InternalServerError` (C = 2), and errors are the steady state for 404-heavy/API workloads; nothing is cached (Part F; `CHANGES.rst:890–893`).
6. **Contrast with an O(1) alternative.** Part D measures the direct alternative:

```
=== PART D: contrast with a direct type-keyed dict.get (O(1)) ===
direct dict.get: 0.0790 us/call over 500000 calls
(that constant is what a type-keyed/reverse-index lookup would cost per bucket)
```

   i.e. ~0.08 µs per bucket for `handler_map.get(type(e))` versus 1.0–14.9 µs per whole lookup for the walk — a ~13× to ~190× difference at the depths and bucket counts measured. The linear scan is what makes depth and breadth compound instead of staying constant.
7. **Secondary side note (flagged, not the cause).** Because `error_handler_spec` is `defaultdict(lambda: defaultdict(dict))`, the line `handler_map = self.error_handler_spec[name][c]` (`sansio/app.py:836`) *allocates and inserts* empty dicts for previously unseen `(name, c)` pairs. Part E measured this:

```
=== PART E: defaultdict first-touch insertion side effect ===
len(error_handler_spec): before=0, after registration=1, after lookup w/ 2 unseen scopes=3
keys now: [None, 'never.seen.scope', 'another.scope']
code-key sizes: {None: [None], 'never.seen.scope': [None], 'another.scope': [None]}
```

   This is a real first-touch mutation cost, but it is a small constant term and **not** the cause of the linear-overhead concern; the MRO probe count is.

---

## 7. Calibrated caveat — a scaling argument, not "Flask is slow"

This must be stated plainly so the answer is accurate rather than sensationalised:

* In ordinary applications the MRO is short — a custom `Custom(Exception)` has `M = 4`, and a `NotFound`/`Forbidden` has `M = 5`; with no blueprint, `B + 1 = 1`; a plain exception gives `C = 1`. That is ~4–5 probes, well under a microsecond (Part A: D = 1 → 1.0 µs; Part C: C = 1, M = 6 → 0.49 µs).
* Error handling is not on the success path of a request: it runs only when an exception is raised (or for `HTTPException`s such as 404s).
* Therefore the honest framing is a **scaling** argument: the lookup is `O(C · (B + 1) · M)` dict probes versus the `O(1)` a type-keyed lookup would achieve. The overhead bites in the regimes the question names — **pathologically deep inheritance hierarchies** (M large), **many non-empty handler buckets across nested blueprints and codes** (B + 1 and C large), **generic catch-all handlers** at base classes (forcing the scan to run to the end of each MRO), and **error-heavy traffic** (the multiply is paid per error, and twice per unhandled error). It is not a claim that a typical app is measurably slow.
* The two multipliers must not be conflated: "more handlers" is not itself the cause. More handlers *inside one map* leave the inner loop length unchanged (O(1) `dict.get` per class). The cost growth comes from *more non-empty `(scope, code)` buckets*, each adding a full extra MRO walk, multiplied by a longer MRO.

---

## 8. Fix direction (why the linear scan is avoidable)

Three options follow directly from the mechanism, and each restores O(1):

1. **Key on the exact runtime type** — `handler_map.get(type(e))` — when exact-type registration is what is wanted; Part D shows this is ~0.08 µs per bucket and constant in M.
2. **Reverse-index the MRO-to-handler mapping at registration time**: instead of probing each bucket with each class, build (at registration, off the hot path) a single structure keyed by exception class with pre-resolved nearest-ancestor handlers, so lookup is one `.get` on `type(e)`.
3. **Memoise per exception type** — a `type -> handler` (or `type -> None`) cache. This is precisely what Flask removed: `CHANGES.rst:890–893` says *"Removed error handler caching because it caused unexpected results for some exception inheritance hierarchies. Register handlers explicitly for each exception if you want to avoid traversing the MRO."* Any reintroduction must key on `(type(e), code, tuple(blueprints))` and account for handlers registered after first use, which is presumably why caching regressed before.

The documented user-side mitigation today is the one the changelog offers: **register handlers explicitly for each exception class** so matches occur at the first `.get` of the first non-empty bucket (as in Part B2, where a 403 in the `grandchild` bucket hits on probe #1), instead of relying on the MRO walk to find a base-class handler after probing many unknowns.

---

## 9. Verification and repo integrity

* The function text, the `error_handler_spec` declaration and terminator, `register_error_handler`, `_get_exc_class_and_code`, `_split_blueprint_path`, `Request.blueprints`, the three call sites, the blueprint merge, the changelog entries and the docs excerpts were all re-read and match, **except for the minor line-number offsets** noted inline: `error_handler_spec` block/terminator is `scaffold.py:110–126` (not 118–128); `_get_exc_class_and_code` body ends at 698 (not 710); `_merge_blueprint_funcs` is called at `blueprints.py:330–332` (not 338–340); `_split_blueprint_path` spans `helpers.py:627–634`; test `def`s are at lines 10, 61, 100, 136, 163, 217/253/269/283 (not the plan's ranges).
* Benchmark and probe counts were produced by a scratch script outside the repository (`C:/Users/oobbee/AppData/Local/Temp/fh_executor/bench_find_error_handler.py`), run as `PYTHONPATH=src .venv/Scripts/python.exe ...` (exit 0), with `PYTHONPATH=src` used specifically so `import flask` resolves to *this* tree (the executor verified this before trusting any number). Chains were built with `type(f"A{i}", (prev,), {})`, and every innermost map was wrapped in a `CountingDict(dict)` so probe counts are exact rather than inferred from timing. All timings are secondary; the structural claims rest on the exact probe-count equalities (`probes == M`, `probes == (B+1)·M`, `probes == C·(B+1)·M`).
* The complete test suite passed twice, unchanged, with no repo modifications — run #1: `489 passed in 6.16s`; run #2 (`-vvv -rA -p no:cacheprovider`): all 489 reported `PASSED`, no failures, no skips, `489 passed in 6.35s`, with `tests/test_user_error_handler.py` (9 tests, including `test_error_handler_subclass`, `test_error_handler_no_match`, `TestGenericHandlers::*`) and `tests/test_blueprints.py` (60 tests, including `test_nested_blueprint`) all green. `git status --short` shows only the pre-existing untracked `flask_mut2_i417ar2x/`; `git diff --stat` is empty. Nothing in `src/`, `tests/` or `docs/` was created, edited or deleted.
* `flask_mut2_i417ar2x/mutated_test.py` was inspected and is **unrelated** to this question: it is a `url_for`/subdomain-matching script (`app.config["SERVER_NAME"] = "example.com"`, `@app.route("/", subdomain="<company_id>")`, `flask.url_for("view", company_id="xxx")`) with no exception handling, no error handlers and no `__mro__`. It contributes nothing to this answer and is not relied upon.

**Bottom line:** `_find_error_handler` is a triple-nested linear scan whose work is `C × (B + 1) × M` dictionary probes per error. Deep exception chains inflate `M` (one extra probe per ancestor, per bucket), many registered handlers inflate the count of non-empty `(scope, code)` buckets and each such bucket re-walks the whole MRO (the `if not handler_map: continue` guard only skips truly empty buckets), and the two effects **multiply**. The result stays cheap for ordinary apps (M ≈ 4–5, few buckets, errors off the success path) but scales badly — versus the O(1) a type-keyed or reverse-indexed lookup would give — for deep hierarchies, catch-all handlers, heavily nested blueprints, and error-heavy traffic.
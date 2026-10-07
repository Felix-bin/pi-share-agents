# Where the error-handler lookup traverses blueprint scopes, HTTP status codes, and the exception-class MRO

## Short answer

The whole sequence lives in one method: **`App._find_error_handler`, defined at `src/flask/sansio/app.py:823–846`** (inherited unchanged by `Flask`, declared `class Flask(App):` at `src/flask/app.py:81`). The three axes are the three nested loops inside it:

| Axis | Line in `src/flask/sansio/app.py` | Loop |
|---|---|---|
| HTTP status code | **834** (outermost loop) | `for c in (code, None) if code is not None else (None,):` |
| Blueprint scope | **835** (middle loop; scope tuple built at **832**) | `names = (*blueprints, None)` / `for name in names:` |
| Exception-class MRO | **841** (innermost loop) | `for cls in exc_class.__mro__:` |

**The literal nesting order is code → blueprint scope → MRO, not blueprint → code → MRO.** The question's phrasing ("blueprint scopes then HTTP status codes then exception class MRO") describes the *precedence* the docstring states, not the loop nesting: within a given status-code bucket the blueprint scope is tried before the app scope, and the `code` bucket is exhausted before the `None` bucket. The precise reconciliation is given in "Ordering" below.

---

## 1. The method, quoted verbatim

Read directly from `src/flask/sansio/app.py` (lines 823–846; the preceding line 822 is blank and `def trap_http_exception(self, e: Exception) -> bool:` begins at line 848):

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

Line-by-line anchors:

- **823–825** signature `def _find_error_handler(self, e: Exception, blueprints: list[str]) -> ft.ErrorHandlerCallable | None:`
- **826–830** docstring stating the intended precedence
- **831** `exc_class, code = self._get_exc_class_and_code(type(e))` — derives the status `code` for HTTP exceptions
- **832** `names = (*blueprints, None)` — the blueprint-scope tuple, with the app scope (`None`) appended **last**
- **833** blank
- **834** `for c in (code, None) if code is not None else (None,):` — **HTTP-status-code axis, outermost loop**
- **835** `for name in names:` — **blueprint-scope axis, middle loop (nested inside the code loop)**
- **836** `handler_map = self.error_handler_spec[name][c]` — the scope × code lookup; also the only read of `error_handler_spec` in the resolver
- **837–839** blank / `if not handler_map:` / `continue`
- **840** blank
- **841** `for cls in exc_class.__mro__:` — **exception-class MRO axis, innermost loop**
- **842** `handler = handler_map.get(cls)`
- **843–845** blank / `if handler is not None:` / `return handler`
- **846** `return None`

Verified with `grep -rn "_find_error_handler" src`:

```
flask/app.py:774:         handler = self._find_error_handler(e, request.blueprints)
flask/app.py:804:         handler = self._find_error_handler(e, request.blueprints)
flask/app.py:857:         handler = self._find_error_handler(server_error, request.blueprints)
flask/sansio/app.py:823:     def _find_error_handler(
```

So there is exactly **one definition and three call sites** — no override in `Flask`. And `grep -rn "error_handler_spec" src` gives:

```
flask/sansio/app.py:836:                 handler_map = self.error_handler_spec[name][c]
flask/sansio/blueprints.py:388:         for key, value in self.error_handler_spec.items():
flask/sansio/blueprints.py:397:             app.error_handler_spec[key] = value
flask/sansio/scaffold.py:123:         self.error_handler_spec: dict[
flask/sansio/scaffold.py:623:             :attr:`error_handler_spec` directly, for application wide error
flask/sansio/scaffold.py:654:         self.error_handler_spec[None][code][exc_class] = f
```

The only *consultation* of the spec for resolution is line 836 inside `_find_error_handler` (blueprints.py:388 reads a blueprint's own spec while merging it into the app; scaffold.py:654 writes; `blueprints.py:397` writes during merge), which independently confirms this is the resolution method.

---

## 2. Ordering — how "blueprint scopes then HTTP status codes then MRO" maps onto the loops

Because the loops nest **code (834) outer → scope (835) middle → MRO (841) inner**, the sequence of `(c, name)` map-visits is exactly:

```
(code, each blueprint scope) → (code, None) → (None, each blueprint scope) → (None, None)
```

and, inside every visited non-empty `(scope, code)` map, the MRO is walked from the raised class outward.

Concretely, for an HTTP exception with code `403` raised inside `parent.child.grandchild`, `blueprints = ["parent.child.grandchild", "parent.child", "parent"]` and `names = ("parent.child.grandchild", "parent.child", "parent", None)`, giving the visit order:

```
(403, 'parent.child.grandchild'), (403, 'parent.child'), (403, 'parent'), (403, None),
(None, 'parent.child.grandchild'), (None, 'parent.child'), (None, 'parent'), (None, None)
```

The word "blueprint-then-code" in the question is therefore true only in the precedence sense: *within any one status-code bucket*, all blueprint scopes (most specific first) are tried before the app scope `None`, and that ordering exists only because line 832 appends `None` last. The status-code bucket as a whole is the *outer* axis: the `None` bucket is not reached until the `code` bucket has been exhausted across all scopes and the full MRO. This is precisely what the method's own docstring (lines 826–829) says:

```python
        """Return a registered error handler for an exception in this order:
        blueprint handler for a specific code, app handler for a specific code,
        blueprint handler for an exception class, app handler for an exception
        class, or ``None`` if a suitable handler is not found.
        """
```

Note the docstring lists blueprint-for-code before app-for-code (scope beats app inside a bucket) and code-specific before class-specific (the `code` bucket is tried before the `None` bucket) — the loops implement both, with the code axis as the outer loop.

---

## 3. Where each axis gets its data

### 3a. The blueprint-scope axis: `request.blueprints` → `_split_blueprint_path` (most-specific first)

`Request.blueprints` (`src/flask/wrappers.py:180–195`, verified directly):

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

`_split_blueprint_path` (`src/flask/helpers.py:627–634`, verified directly):

```python
@cache
def _split_blueprint_path(name: str) -> list[str]:
    out: list[str] = [name]

    if "." in name:
        out.extend(_split_blueprint_path(name.rpartition(".")[0]))

    return out
```

This is most-specific-first: `parent.child.grandchild` → `["parent.child.grandchild", "parent.child", "parent"]`. Hence line 832's `names` puts the deepest blueprint first, parents next, and the app scope `None` last.

### 3b. The status-code axis: `_get_exc_class_and_code` and the bucket structure

`error_handler_spec` is declared in `Scaffold.__init__` with its documented shape (`src/flask/sansio/scaffold.py:110–126`, verified directly):

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

Registration writes into that structure (`src/flask/sansio/scaffold.py:641–654`, verified directly):

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

and the `(exc_class, code)` pair is produced by `_get_exc_class_and_code` (`src/flask/sansio/scaffold.py:656–698`, verified directly):

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

**Critical consequence for the code axis:** for any `HTTPException` subclass the bucket key is `exc_class.code`. So a handler registered by *class* (`@app.errorhandler(Forbidden)`) and one registered by *code* (`@app.errorhandler(403)`) land in the **same** bucket `[403][Forbidden]` — for HTTP errors the "status code" axis and the "exception class" axis are not independent; they share a bucket. Only `HTTPException` itself (whose `.code is None`) lands in the `None` bucket, along with all non-HTTP exceptions. The docs state the same equivalence: "`werkzeug.exceptions.HTTPException` subclasses like `~werkzeug.exceptions.BadRequest` and their HTTP codes are interchangeable when registering handlers. (`BadRequest.code == 400`)" (`docs/errorhandling.rst:114–116`).

### 3c. Blueprint scopes are dotted-namespaced at registration

`Blueprint._merge_blueprint_funcs` (`src/flask/sansio/blueprints.py:379–397`, verified directly):

```python
    def _merge_blueprint_funcs(self, app: App, name: str) -> None:
        def extend(
            bp_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
            parent_dict: dict[ft.AppOrBlueprintKey, list[t.Any]],
        ) -> None:
            for key, values in bp_dict.items():
                key = name if key is None else f"{name}.{key}"
                parent_dict[key].extend(values)

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

This is why the dotted `name` strings compared at line 835 match exactly the strings produced by `_split_blueprint_path` at line 832.

---

## 4. The three call sites all pass `request.blueprints`

All three are in `src/flask/app.py`, verified directly:

- **`handle_http_exception`**, call at line **774** (inside the method defined at line 744, after the `e.code is None` and `RoutingException` guards):

```python
        handler = self._find_error_handler(e, request.blueprints)
        if handler is None:
            return e
        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

- **`handle_user_exception`**, call at line **804** (method defined at line 779; HTTP exceptions are forwarded to `handle_http_exception` first):

```python
        if isinstance(e, HTTPException) and not self.trap_http_exception(e):
            return self.handle_http_exception(e)

        handler = self._find_error_handler(e, request.blueprints)

        if handler is None:
            raise

        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

- **`handle_exception`**, call at line **857** (method defined at line 811; wraps the original error in an `InternalServerError`):

```python
        self.log_exception(exc_info)
        server_error: InternalServerError | ft.ResponseReturnValue
        server_error = InternalServerError(original_exception=e)
        handler = self._find_error_handler(server_error, request.blueprints)

        if handler is not None:
            server_error = self.ensure_sync(handler)(server_error)

        return self.finalize_request(server_error, from_error_handler=True)
```

Every entry point passes the same most-specific-first list from §3a, so the scope order is always "current (most specific) blueprint → parent blueprints → app (`None`)" — exactly the order that line 832 builds into `names`.

---

## 5. Verification (executed on this checkout)

### 5a. Targeted test run

The executor ran the plan's command. Under the system interpreter it failed to import flask (exit 4):

```
ImportError while loading conftest '...\seal\tests\conftest.py'.
D:\操作系统开源大赛\pi-share-agents-openeuler-wsl\experiments\data\flask-src\tests\conftest.py:7: in <module>
    from flask import Flask
E   ModuleNotFoundError: No module named 'flask'
```

With the project's `.venv` interpreter — both with default resolution and with `PYTHONPATH=src` forcing this checkout's source — the run passed (exit 0):

```
.venv/Scripts/python.exe -m pytest tests/test_user_error_handler.py "tests/test_basic.py::test_errorhandler_precedence" "tests/test_basic.py::test_http_error_subclass_handling" "tests/test_blueprints.py::test_nested_blueprint" -q
............                                                             [100%]
12 passed in 0.26s
EXIT=0
```

and identically with `PYTHONPATH=src`. The full suite also passes on both resolutions: `489 passed in 6.45s` (exit 0) with `PYTHONPATH=src`, and `489 passed in 5.63s` (exit 0) default; a fresh-bytecode run (`PYTHONPATH=src PYTHONPYCACHEPREFIX=_pycache_probe .venv/Scripts/python.exe -m pytest -q --assert=plain -p no:cacheprovider`) gave `489 passed in 6.13s`, exit 0.

Two caveats the executor established: bare `python` cannot run the suite (no `flask` on the system interpreter), and the `.venv` by default resolves `flask` outside this working directory via a stale `flask.pth`; the executor therefore double-ran everything with `PYTHONPATH=src`. Also, `grep -rn "_find_error_handler\|error_handler_spec\|__mro__" tests/` returns **no matches**, so the tests verify the behaviour empirically but never name the method or its line numbers — the line-level pinning rests on the direct source reads above plus the probe below.

The tests that encode the precedence (quoted verbatim from the executor's verified reads):
- `tests/test_basic.py::test_errorhandler_precedence` (def at line 999; assertions at 1025–1029): `rv = client.get("/E1")` / `assert rv.data == b"Exception"` / `rv = client.get("/E3")` / `assert rv.data == b"E2"` — the MRO walk at line 841 beats the generic base.
- `tests/test_basic.py::test_http_error_subclass_handling` (def at 967; assertions at 994–996): `assert client.get("/1").data == b"banana"` / `assert client.get("/2").data == b"apple"` / `assert client.get("/3").data == b"apple"` — class vs code registration sharing a bucket.
- `tests/test_user_error_handler.py::test_error_handler_blueprint` (def at 136; assertions at 159–160): `assert c.get("/error").data == b"app-error"` / `assert c.get("/bp/error").data == b"bp-error"` — blueprint scope beats app inside the blueprint.
- `tests/test_blueprints.py::test_nested_blueprint` (def at 793; assertions at 834–839): including `assert client.get("/parent/no").data == b"Parent no"` / `assert client.get("/parent/child/no").data == b"Parent no"` / `assert client.get("/parent/child/grandchild/no").data == b"Grandchild no"` — the scope-chain fallback.

### 5b. Direct axis-order probe

The executor ran a probe (written to `_probe_error_order.py`) that registers markers at every `(scope, code)` pair and prints the real traversal. Output under both resolutions (exit 0):

```
A: b'app-403'
B: b'bp-http'
B-app: 200
C: b'parent-forbidden'
D names: ('bp.child.grandchild', 'bp.child', 'bp', None)
D (code, scope) visit order: [(403, 'bp.child.grandchild'), (403, 'bp.child'), (403, 'bp'), (403, None), (None, 'bp.child.grandchild'), (None, 'bp.child'), (None, 'bp'), (None, None)]
D MRO: ['Forbidden', 'HTTPException', 'Exception', 'BaseException', 'object']
EXIT=0
```

Reading of that output:

- **(i)** The code axis is the **outer** loop (all `403` pairs first), the blueprint scope the **middle** axis, the MRO the **innermost** — confirmed by the `D (code, scope) visit order` list.
- **(ii)** Within a code bucket the blueprint scope beats the app scope — confirmed (all four bp scopes precede `None` for `403`), and by case B printing `b'bp-http'` (a blueprint `HTTPException` handler in the `None` bucket winning inside the blueprint).
- **(iii)** The `None` bucket is reached only after the `code` bucket is exhausted across all scopes and the full MRO — confirmed by the list order and by case A: `b'app-403'`, i.e. the `403`/`Forbidden` entry wins over the `HTTPException` handler that lives in the `None` bucket.
- Case C prints `b'parent-forbidden'`, showing the scope chain walking up to the parent blueprint before the app.

**One discrepancy was reported and must be carried here:** the plan predicted the probe's `B-app` line would print `404 from app, no route`; it actually printed `B-app: 200`. The executor diagnosed this with a second probe (`_probe_bapp.py`), whose output under both resolutions was:

```
B-app status: 200
B-app data: b'app-exception'
  spec[None][None] -> {'Exception': 'app_exc'}
  spec[None][404] -> {}
  spec['bp'][None] -> {'HTTPException': 'bp_http'}
NotFound -> NotFound code: 404
NotFound MRO: ['NotFound', 'HTTPException', 'Exception', 'BaseException', 'object']
None-bucket map: {'Exception': 'app_exc'}
would a 404 with no blueprint scopes match the Exception handler? True
bp route status: 200 b'bp-http'
bp 405 status: 200 b'app-exception'
EXIT=0
```

The raw facts: the routing-level 404 has `request.blueprints == []`, so only the app scope is tried; `spec[None][404]` is empty; the app's `Exception` handler sits in the `None` bucket; `NotFound.__mro__` includes `Exception`; hence the response body is `b'app-exception'`. This is consistent with the method (the `None` code bucket is reached because the `404` bucket has no handler for the MRO of `NotFound`) and with the docs' note that "the blueprint cannot handle 404 routing errors because the 404 occurs at the routing level before the blueprint can be determined" (`docs/errorhandling.rst:169–173`). The plan's other four expected values (cases A, B, C, and the `D` order/MRO) matched exactly. One further non-behavioural difference: `D names` prints a **tuple** (consistent with `names = (*blueprints, None)`), not the list the plan predicted.

No tracked source file was modified during verification: `git diff --stat` is empty; the only untracked additions are the executor's scratch files (`_probe_error_order.py`, `_probe_bapp.py`, `_pytest_verbose.txt`) plus the pre-existing, unrelated `flask_mut2_i417ar2x/` directory (a `url_for`/subdomain script, not evidence here and not edited).

---

## 6. Answer, stated in one place

- **Method:** `App._find_error_handler`, `src/flask/sansio/app.py:823–846`; inherited by `Flask` (`src/flask/app.py:81`) with no override. Its only consumers are the three calls at `src/flask/app.py:774`, `804`, `857`.
- **Blueprint-scope traversal:** built at line **832** (`names = (*blueprints, None)`) and iterated at line **835** (`for name in names:`), driven by `request.blueprints` → `_split_blueprint_path` (`src/flask/wrappers.py:180–195`, `src/flask/helpers.py:627–634`), most-specific-first.
- **HTTP-status-code traversal:** line **834** (`for c in (code, None) if code is not None else (None,):`), driven by `exc_class, code = self._get_exc_class_and_code(type(e))` at line **831**.
- **Exception-class MRO traversal:** line **841** (`for cls in exc_class.__mro__:`), applied to the innermost `{class: handler}` map fetched at line **836** (`handler_map = self.error_handler_spec[name][c]`).
- **Order actually executed:** code (outer) → blueprint scope (middle) → MRO (inner), i.e. `(code, each bp) → (code, None) → (None, each bp) → (None, None)`, MRO walked inside each non-empty map. The question's "blueprint scopes then HTTP status codes then MRO" is true as a *precedence* statement matching the docstring at lines 826–829; it is not the loop nesting order, which is code-first because line 834 encloses line 835.
- **HTTP-error nuance:** for `HTTPException` subclasses `_get_exc_class_and_code` returns `exc_class.code`, so class-based and code-based registration share the `[code][class]` bucket; the `None` bucket holds non-HTTP exceptions and `HTTPException` itself.
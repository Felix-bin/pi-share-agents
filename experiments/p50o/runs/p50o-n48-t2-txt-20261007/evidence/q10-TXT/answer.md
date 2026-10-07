## Final answer

I verified the two anchors the executor flagged, and confirm both corrections: `grep` returns `app.py:939: response = self.make_response(rv)` (not `:933`, which is a docstring line), and `grep` for `AsyncIterable|:pr:\`5659\`` returns `CHANGES.rst:21-22`, under the 3.1.1 entry (not `:24-30`, which is the 3.1.0 header). `grep` also confirms `views.py:16: class View:` and `views.py:138: class MethodView(View):`, and `CHANGES.rst:473: -   Support View and MethodView instances with async handlers. :issue:\`4112\``.

---

# Short version

The async HTTP method view does **not** need its own async dispatch because Flask has exactly **one** class-based view hierarchy — `View` (`src/flask/views.py:16`) and `MethodView(View)` (`src/flask/views.py:138`) — and synchronous-vs-asynchronous is decided per *handler function* at call time, not per view *class*. `MethodView`'s single job is to pick the handler named after the request method and call it, and it does so through `return current_app.ensure_sync(meth)(**kwargs)` (`src/flask/views.py:191`); likewise `View.as_view` calls `current_app.ensure_sync(self.dispatch_request)(**kwargs)` (`src/flask/views.py:110`, `:116`). `current_app.ensure_sync` is `Flask.ensure_sync` (`src/flask/app.py:966`), which tests `if iscoroutinefunction(func): return self.async_to_sync(func)` (`:975-976`) and otherwise returns the function unchanged (`:978`); `async_to_sync` (`:980`) returns `asgiref.sync.async_to_sync(func)` (`:995`, `:1001`). So a fully async method view is just a normal `MethodView` with `async def get` / `async def post` — exactly what `tests/test_async.py:30-34` defines — and the inherited sync dispatch adapts it, with no `methods` declaration needed. No async view class exists anywhere under `src/`.

**Why not a separate/independent async class — the reasons:**

- **The WSGI boundary demands a sync callable and a plain value.** `Flask.dispatch_request` runs the view through `self.ensure_sync(...)` (`src/flask/app.py:902`) and the result goes straight to `finalize_request` (`:920`) → `make_response` (`:939`). A class returning a coroutine from `dispatch_request` hands that coroutine to `make_response` — verified live: it produces `TypeError: The view function did not return a valid response. ... but it was a coroutine.` and a 500.
- **Sync/async is orthogonal to HTTP-method dispatch.** `ensure_sync` passes plain `def` handlers through untouched and wraps only coroutines (`src/flask/app.py:966-978`), so one class mixes both — `AsyncMethodView` (`tests/test_async.py:30-34`) vs. the sync `Index` (`tests/test_views.py:28-37`). A separate class would be a false dichotomy.
- **Handler registration is already free for coroutines.** `MethodView.__init_subclass__` merges `methods` from bases and discovers handlers with `for key in http_method_funcs: if hasattr(cls, key)` (`src/flask/views.py:165-180`, `:171-173`, `:175-176`); `hasattr(cls, "get")` is true for `async def get`, so `AsyncMethodView.methods == {'GET', 'POST'}` with no declaration (runtime-confirmed). An async twin would need a verbatim copy, including the base-class merge that `tests/test_views.py::test_methods_var_inheritance` (`:204`), `::test_multiple_inheritance` (`:207-221`) and `::test_remove_method_from_parent` (`:226-240`) depend on.
- **All non-dispatch behaviour comes for free from `View.as_view`.** `decorators` (`src/flask/views.py:118-122`), `init_every_request` branches (`:105-116`), `view.view_class` (`:128`, used by `tests/test_views.py::test_view_patching` at `:57`), `view.methods` / `view.provide_automatic_options` (`:133-134`, consumed at `src/flask/sansio/app.py:622`/`:636-638`); duplicating this forks the public API and breaks one `as_view` callable registered on several rules (`tests/test_helpers.py:144-163`).
- **Multiple inheritance across the two trees would break.** `GetView(MethodView)` + `DeleteView(MethodView)` → `GetDeleteView(GetView, DeleteView)` works today (`tests/test_views.py:207-221`), and `MethodView` is documented as “extends the basic `View`” (`docs/views.rst:232`); with two parallel hierarchies a user would have to pick a base before knowing whether a handler later becomes `async` — which they cannot know, because the decision is made by `iscoroutinefunction` at call time.
- **There is a single, documented override point.** Extensions adapt async by wrapping with `ensure_sync` (`docs/async-await.rst:98-112`) or overriding `Flask.ensure_sync` (`:123-125`), not by subclassing a view; `docs/async-await.rst:20-24` promises async for exactly `View.dispatch_request` and the `MethodView` HTTP handlers.

**Disambiguation (both readings of the question are answered by the above):** reading A = “the async-capable `MethodView` inherits from the generic sync `View`” (`src/flask/views.py:138`); reading B = “the test’s async class `AsyncMethodView` inherits from the synchronous `MethodView` rather than implementing async dispatch independently” (`tests/test_async.py:30`). Either way the class inherits the *same* synchronous dispatch machinery and relies on `ensure_sync` at call time; neither reading describes an independent async dispatcher, because none exists in the tree.

---

# Full answer

## 1. Direct answer

There is only **one** method-dispatching class in this codebase, and async support is *not* a property of a view class at all — it is a property of each individual handler function, decided at call time by `Flask.ensure_sync` (`src/flask/app.py:966-978`, which tests `inspect.iscoroutinefunction` at `:975`). `MethodView` (`src/flask/views.py:138`) does the only job a method view has — pick the handler named after the request method and call it — and it does that through `current_app.ensure_sync(meth)` (`src/flask/views.py:191`). So an async method view needs **no async dispatch of its own**: it writes `async def get` / `async def post` on a normal `MethodView`, exactly as `tests/test_async.py:30-34` does, and the *inherited* sync dispatch adapts those coroutine handlers.

There is no async class anywhere under `src/`. Verified inventory:

```
$ grep -rn "class Async" src/
(no match, exit 1)
$ grep -rn "class .*View" --include="*.py" src/
src/flask/views.py:16:class View:
src/flask/views.py:27:        class Hello(View):
src/flask/views.py:138:class MethodView(View):
src/flask/views.py:152:        class CounterAPI(MethodView):
```

Runtime confirmation (executed; full log in §5):

```
flask.__file__ = ...\q10-TXT\seal\src\flask\__init__.py
flask.views.__file__ = ...\q10-TXT\seal\src\flask\views.py
(i) AsyncMethodView.__mro__ = (<class '__main__.AsyncMethodView'>, <class 'flask.views.MethodView'>, <class 'flask.views.View'>, <class 'object'>)
(ii) AsyncMethodView.methods = {'GET', 'POST'}
(iii) inspect.iscoroutinefunction(AsyncMethodView.get) = True
(iv) type(app.ensure_sync(AsyncMethodView.get)) = <class 'asgiref.sync.AsyncToSync'>
(iv) __module__ = asgiref.sync | __name__ = AsyncToSync
(v) ensure_sync identity for plain def: True
(v) type for plain def: <class 'function'>
MethodView.__mro__ = (<class 'flask.views.MethodView'>, <class 'flask.views.View'>, <class 'object'>)
View in MethodView.__bases__: True
```

Note (ii): `methods` is correct with **no** `methods` attribute declared on the test class.

## 2. Mechanism — the sync/async adapter chain, hop by hop

1. **Registration.** `AsyncMethodView.as_view("methodview")` produces the generated `view` function (`tests/test_async.py:76`). Inside `View.as_view` the closure calls `current_app.ensure_sync(self.dispatch_request)` — `src/flask/views.py:110` (`init_every_request=True`) and `:116` (`init_every_request=False`). It also sets `view.view_class` (`:128`), `view.methods` (`:133`), `view.provide_automatic_options` (`:134`).
2. **Routing consumes those attributes.** `src/flask/sansio/app.py:622` (`methods = getattr(view_func, "methods", None) or ("GET",)`) and `:636-638` (`provide_automatic_options = getattr(view_func, "provide_automatic_options", None)`), set on the rule at `:651`.
3. **WSGI boundary.** `Flask.dispatch_request` calls `self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)` — `src/flask/app.py:902`. The argument here is the generated `view` function, a plain `def`, so `ensure_sync` returns it as-is.
4. **Inside the generated view.** `current_app.ensure_sync(self.dispatch_request)(**kwargs)` — `src/flask/views.py:110`/`:116`. For a `MethodView`, `self.dispatch_request` is the ordinary `def` at `src/flask/views.py:182`, so again returned as-is.
5. **Method dispatch.** `meth = getattr(self, request.method.lower(), None)` (`src/flask/views.py:183`), HEAD→GET fallback (`:186-188`), then `return current_app.ensure_sync(meth)(**kwargs)` — `src/flask/views.py:191`. **This** is where the coroutine surfaces: `meth` is `async def get`, so `iscoroutinefunction(meth)` is true and it gets wrapped.
6. **The only sync/async decision point.** `Flask.ensure_sync` (`src/flask/app.py:966`): `if iscoroutinefunction(func): return self.async_to_sync(func)` (`:975-976`), otherwise `return func` (`:978`).
7. **The wrapper.** `Flask.async_to_sync` (`src/flask/app.py:980`), returning `asgiref.sync.async_to_sync(func)` (`:995`, `:1001`).
8. **The result must be a plain value.** `full_dispatch_request` does `rv = self.dispatch_request()` (`:917`) and `return self.finalize_request(rv)` (`:920`); `finalize_request` does `response = self.make_response(rv)` (`src/flask/app.py:939`). Nothing there awaits anything.

Who converts what: only `Flask.ensure_sync` converts; every hop before it merely *calls* it (`src/flask/views.py:110`, `:116`, `:191`; `src/flask/app.py:902`). The same adapter serves view functions, before/after-request, teardown, error handlers, signals and template context processors (`src/flask/app.py:530`, `:777`, `:809`, `:840`, `:860`, `:902`, `:914`, `:943`, `:1291`, `:1314`, `:1319`, `:1356`, `:1382`; `templating.py:129/133/170/176`; `ctx.py:191/254/272`) — an “async twin” view class could not avoid it either.

## 3. Why *not* a parallel/independent async hierarchy

**(i) The WSGI boundary requires a sync callable and a plain return value.** `src/flask/app.py:902` hands the result to `finalize_request` (`:920`) → `make_response` (`:939`). This is not theoretical — the adversarial run in §5 shows a `View` whose plain `def dispatch_request` returns `coro()` failing with `TypeError: The view function did not return a valid response. ... but it was a coroutine.` and a `500`, while the same class with `async def dispatch_request` returns `200 b'OK-from-coroutine'`. Conversion therefore has to happen *inside* the shared single machinery (`ensure_sync`), not inside a separate dispatch implementation.

**(ii) Sync vs async is orthogonal to HTTP-method dispatch.** `ensure_sync` passes plain `def` handlers through unchanged and wraps only coroutine functions (`src/flask/app.py:966-978`), so one class mixes both: `AsyncMethodView` is fully async (`tests/test_async.py:30-34`) while `tests/test_views.py::Index` stays sync (`tests/test_views.py:28-37`), and both register with the identical `as_view`/`add_url_rule` call shape. A separate async class would be a false dichotomy — even a single view can have async and sync methods side by side.

**(iii) Handler registration is free on the existing class.** `MethodView.__init_subclass__` (`src/flask/views.py:165-180`) merges `methods` from bases (`:171-173`) and discovers handlers with `for key in http_method_funcs: if hasattr(cls, key)` (`:175-176`). `hasattr(cls, "get")` is true for `async def get`, so `AsyncMethodView` gets `methods == {"GET", "POST"}` with no declaration. An async twin would need a verbatim copy of that logic — including the base-class merge that `tests/test_views.py::test_methods_var_inheritance` (assertion at `:204`: `assert ChildView.methods == {"PROPFIND", "GET"}`), `::test_multiple_inheritance` (`:207-221`) and `::test_remove_method_from_parent` (`:226-240`) rely on.

**(iv) Everything non-dispatch comes for free from `View.as_view`.** `decorators` (`src/flask/views.py:118-122`), the `init_every_request` branches (`:105-116`), `view.view_class` (`:128`, used by `tests/test_views.py::test_view_patching`, `view.view_class = Other` at `:57`), `view.methods`/`view.provide_automatic_options` (`:133-134`) consumed by `src/flask/sansio/app.py:622`/`:636-638`, plus the typing that permits both `Callable` and `Callable[..., Awaitable[...]]` for routes (`src/flask/typing.py:84-87`). Duplicating this in a second class would fork the public API and break usage where one `as_view` callable is registered on several rules (`tests/test_helpers.py:144-163`).

**(v) Inheritance and multiple inheritance would break.** `GetView(MethodView)` + `DeleteView(MethodView)` → `GetDeleteView(GetView, DeleteView)` works today (`tests/test_views.py:207-221`), and the documented contract is that `MethodView` “extends the basic `View`” (`docs/views.rst:232`). With two parallel trees, `class GetDeleteView(GetView, DeleteView)` could not mix an async and a sync base, and a user would have to choose the base class *before* knowing whether a handler might later become `async` — which they cannot know, because the decision is made by `iscoroutinefunction` at call time, not at class-definition time.

**(vi) One override point, not many classes.** Extensions and alternate runtimes adjust async behaviour by overriding `Flask.ensure_sync`/`async_to_sync` (`docs/async-await.rst:98-112`, `:123-125`), not by subclassing a view. `docs/async-await.rst:20-24` promises async support for exactly `View.dispatch_request` and the `MethodView` HTTP handlers — i.e. for the *existing* classes, with no async class named anywhere in the docs.

## 4. Historical note

Async support for class-based views arrived as a change to the existing classes, not as a class: “Support View and MethodView instances with async handlers. :issue:`4112`” in 2.0.2 (`CHANGES.rst:473`) — implemented by routing `View.as_view` and `MethodView.dispatch_request` through `ensure_sync` (`src/flask/views.py:110`, `:116`, `:191`). Generic async views/error handlers/hooks came earlier in 2.0.0 (`CHANGES.rst:600-601`). The design rationale is stated in `docs/design.rst:187-201`: coroutines are run on a thread to stay backwards compatible with WSGI and pre-`async` extensions, rather than adopting an ASGI dispatch model.

## 5. Evidence appendix (verbatim) and executed results

### `src/flask/views.py:138` — the inheritance edge in question

```python
class MethodView(View):
```

### `src/flask/views.py:106-116` — `View.as_view` bridges through `ensure_sync`

```python
        if cls.init_every_request:

            def view(**kwargs: t.Any) -> ft.ResponseReturnValue:
                self = view.view_class(  # type: ignore[attr-defined]
                    *class_args, **class_kwargs
                )
                return current_app.ensure_sync(self.dispatch_request)(**kwargs)  # type: ignore[no-any-return]

        else:
            self = cls(*class_args, **class_kwargs)  # pyright: ignore

            def view(**kwargs: t.Any) -> ft.ResponseReturnValue:
                return current_app.ensure_sync(self.dispatch_request)(**kwargs)  # type: ignore[no-any-return]
```

### `src/flask/views.py:128-135` — attributes `as_view` propagates

```python
        view.view_class = cls  # type: ignore
        view.__name__ = name
        view.__doc__ = cls.__doc__
        view.__module__ = cls.__module__
        view.methods = cls.methods  # type: ignore
        view.provide_automatic_options = cls.provide_automatic_options  # type: ignore
        return view
```

### `src/flask/views.py:165-180` — `MethodView.__init_subclass__` (handler discovery from coroutine methods)

```python
    def __init_subclass__(cls, **kwargs: t.Any) -> None:
        super().__init_subclass__(**kwargs)

        if "methods" not in cls.__dict__:
            methods = set()

            for base in cls.__bases__:
                if getattr(base, "methods", None):
                    methods.update(base.methods)  # type: ignore[attr-defined]

            for key in http_method_funcs:
                if hasattr(cls, key):
                    methods.add(key.upper())

            if methods:
                cls.methods = methods
```

### `src/flask/views.py:182-191` — `MethodView.dispatch_request`, per-handler `ensure_sync`, HEAD→GET fallback

```python
    def dispatch_request(self, **kwargs: t.Any) -> ft.ResponseReturnValue:
        meth = getattr(self, request.method.lower(), None)

        # If the request method is HEAD and we don't have a handler for it
        # retry with GET.
        if meth is None and request.method == "HEAD":
            meth = getattr(self, "get", None)

        assert meth is not None, f"Unimplemented method {request.method!r}"
        return current_app.ensure_sync(meth)(**kwargs)  # type: ignore[no-any-return]
```

### `src/flask/app.py:902` — the WSGI dispatch boundary

```python
        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)  # type: ignore[no-any-return]
```

### `src/flask/app.py:917-920` and `:939` — the plain value path

```python
                rv = self.dispatch_request()
        except Exception as e:
            rv = self.handle_user_exception(e)
        return self.finalize_request(rv)
```
```python
        response = self.make_response(rv)
```

### `src/flask/app.py:966-978` — `ensure_sync`, the single decision point

```python
    def ensure_sync(self, func: t.Callable[..., t.Any]) -> t.Callable[..., t.Any]:
        """Ensure that the function is synchronous for WSGI workers.
        Plain ``def`` functions are returned as-is. ``async def``
        functions are wrapped to run and wait for the response.

        Override this method to change how the app runs async views.

        .. versionadded:: 2.0
        """
        if iscoroutinefunction(func):
            return self.async_to_sync(func)

        return func
```

### `src/flask/app.py:980-1001` — `async_to_sync`

```python
    def async_to_sync(
        self, func: t.Callable[..., t.Coroutine[t.Any, t.Any, t.Any]]
    ) -> t.Callable[..., t.Any]:
        """Return a sync function that will run the coroutine function.

        .. code-block:: python

            result = app.async_to_sync(func)(*args, **kwargs)

        Override this method to change how Flask converts async code
        to be synchronously callable.

        .. versionadded:: 2.0
        """
        try:
            from asgiref.sync import async_to_sync as asgiref_async_to_sync
        except ImportError:
            raise RuntimeError(
                "Install Flask with the 'async' extra in order to use async views."
            ) from None

        return asgiref_async_to_sync(func)
```

### `tests/test_async.py:22-34` — the only async view classes; no async dispatch of their own

```python
class AsyncView(View):
    methods = ["GET", "POST"]

    async def dispatch_request(self):
        await asyncio.sleep(0)
        return request.method


class AsyncMethodView(MethodView):
    async def get(self):
        await asyncio.sleep(0)
        return "GET"

    async def post(self):
        await asyncio.sleep(0)
        return "POST"
```

### `tests/test_async.py:74-88` — registration and exercise

```python
    app.add_url_rule("/view", view_func=AsyncView.as_view("view"))
    app.add_url_rule("/methodview", view_func=AsyncMethodView.as_view("methodview"))

    return app


@pytest.mark.parametrize("path", ["/", "/home", "/bp/", "/view", "/methodview"])
def test_async_route(path, async_app):
    test_client = async_app.test_client()
    response = test_client.get(path)
    assert b"GET" in response.get_data()
    response = test_client.post(path)
    assert b"POST" in response.get_data()
```

### `tests/test_views.py:189-204` / `:207-221` / `:226-240` — behaviours that depend on a single class tree

```python
def test_methods_var_inheritance(app, client):
    class BaseView(flask.views.MethodView):
        methods = ["GET", "PROPFIND"]

    class ChildView(BaseView):
        def get(self):
            return "GET"

        def propfind(self):
            return "PROPFIND"

    app.add_url_rule("/", view_func=ChildView.as_view("index"))

    assert client.get("/").data == b"GET"
    assert client.open("/", method="PROPFIND").data == b"PROPFIND"
    assert ChildView.methods == {"PROPFIND", "GET"}
```
```python
def test_multiple_inheritance(app, client):
    class GetView(flask.views.MethodView):
        def get(self):
            return "GET"

    class DeleteView(flask.views.MethodView):
        def delete(self):
            return "DELETE"

    class GetDeleteView(GetView, DeleteView):
        pass

    app.add_url_rule("/", view_func=GetDeleteView.as_view("index"))

    assert client.get("/").data == b"GET"
    assert client.delete("/").data == b"DELETE"
    assert sorted(GetDeleteView.methods) == ["DELETE", "GET"]
```
```python
def test_remove_method_from_parent(app, client):
    class GetView(flask.views.MethodView):
        def get(self):
            return "GET"

    class OtherView(flask.views.MethodView):
        def post(self):
            return "POST"

    class View(GetView, OtherView):
        methods = ["GET"]

    app.add_url_rule("/", view_func=View.as_view("index"))

    assert client.get("/").data == b"GET"
    assert client.post("/").status_code == 405
    assert sorted(View.methods) == ["GET"]
```

### `tests/test_views.py:57` (`test_view_patching`) and `tests/test_helpers.py:146-158`

```python
    view = Index.as_view("index")
    view.view_class = Other
```
```python
        class MyView(MethodView):
            def get(self, id=None):
                if id is None:
                    return "List"
                return f"Get {id:d}"

            def post(self):
                return "Create"

        myview = MyView.as_view("myview")
        app.add_url_rule("/myview/", methods=["GET"], view_func=myview)
        app.add_url_rule("/myview/<int:id>", methods=["GET"], view_func=myview)
        app.add_url_rule("/myview/create", methods=["POST"], view_func=myview)
```

### `src/flask/sansio/app.py:622` / `:636-638` / `:651` — consumers of the propagated attributes

```python
            methods = getattr(view_func, "methods", None) or ("GET",)
```
```python
            provide_automatic_options = getattr(
                view_func, "provide_automatic_options", None
            )
```
```python
        rule_obj.provide_automatic_options = provide_automatic_options  # type: ignore[attr-defined]
```

### `src/flask/typing.py:84-87` — one callable shape permits sync or awaited results

```python
RouteCallable = (
    t.Callable[..., ResponseReturnValue]
    | t.Callable[..., t.Awaitable[ResponseReturnValue]]
)
```

### `docs/views.rst:232` / `docs/api.rst:523-535` / `docs/async-await.rst:20-24`, `:98-112`, `:117-125`

```rst
method. :class:`MethodView` extends the basic :class:`View` to dispatch
```
```rst
Class-Based Views
-----------------

.. versionadded:: 0.7

.. currentmodule:: None

.. autoclass:: flask.views.View
   :members:

.. autoclass:: flask.views.MethodView
   :members:
```
```rst
Pluggable class-based views also support handlers that are implemented as
coroutines. This applies to the :meth:`~flask.views.View.dispatch_request`
method in views that inherit from the :class:`flask.views.View` class, as
well as all the HTTP method handlers in views that inherit from the
:class:`flask.views.MethodView` class.
```
```rst
Extension authors can support async functions by utilising the
:meth:`flask.Flask.ensure_sync` method. For example, if the extension
provides a view function decorator add ``ensure_sync`` before calling
the decorated function,

.. code-block:: python

    def extension(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            ...  # Extension logic
            return current_app.ensure_sync(func)(*args, **kwargs)

        return wrapper
```
```rst
Other event loops
-----------------

At the moment Flask only supports :mod:`asyncio`. It's possible to
override :meth:`flask.Flask.ensure_sync` to change how async functions
are wrapped to use a different library.
```

### `CHANGES.rst:473`, `:600-601`; `docs/design.rst:187-201`

```rst
-   Support View and MethodView instances with async handlers. :issue:`4112`
```
```rst
-   Support async views, error handlers, before and after request, and
    teardown functions. :pr:`3412`
```
```rst
Async/await and ASGI support
----------------------------

Flask supports ``async`` coroutines for view functions by executing the
coroutine on a separate thread instead of using an event loop on the
main thread as an async-first (ASGI) framework would. This is necessary
for Flask to remain backwards compatible with extensions and code built
before ``async`` was introduced into Python. This compromise introduces
a performance cost compared with the ASGI frameworks, due to the
overhead of the threads.

Due to how tied to WSGI Flask's code is, it's not clear if it's possible
to make the ``Flask`` class support ASGI and WSGI at the same time. Work
is currently being done in Werkzeug to work with ASGI, which may
eventually enable support in Flask as well.
```

### Executed commands and raw outputs (verbatim)

**Environment / orientation**

```
$ pwd && ls
/tmp/pi-p50o/2335aa4c/q10-TXT/seal
CHANGES.rst  LICENSE.txt  README.md  docs  examples  flask_mut2_i417ar2x  pyproject.toml  src  tests  uv.lock

$ ls .venv/Scripts/
activate ... python.exe  pythonw.exe  pytest.exe  ruff.exe ...   (full venv, exit 0)

$ .venv/Scripts/python.exe --version
Python 3.13.9                       exit=0

$ .venv/Scripts/python.exe -c "import asgiref, os; print(asgiref.__version__); print(os.path.dirname(asgiref.__file__))"
3.8.1
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q10-TXT\seal\.venv\Lib\site-packages\asgiref     exit=0
```

**Claim-by-claim verification**

```
$ sed -n '16p' src/flask/views.py        -> class View:
$ sed -n '138p' src/flask/views.py       -> class MethodView(View):
$ sed -n '110p;116p;191p' src/flask/views.py
                return current_app.ensure_sync(self.dispatch_request)(**kwargs)  # type: ignore[no-any-return]
                return current_app.ensure_sync(self.dispatch_request)(**kwargs)  # type: ignore[no-any-return]
        return current_app.ensure_sync(meth)(**kwargs)  # type: ignore[no-any-return]
$ sed -n '165p;171p;175p;176p' src/flask/views.py
    def __init_subclass__(cls, **kwargs: t.Any) -> None:
            for base in cls.__bases__:
            for key in http_method_funcs:
                if hasattr(cls, key):

$ sed -n '9p;902p;966p;975p;976p;980p;995p;1001p' src/flask/app.py
from inspect import iscoroutinefunction
        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)  # type: ignore[no-any-return]
    def ensure_sync(self, func: t.Callable[..., t.Any]) -> t.Callable[..., t.Any]:
        if iscoroutinefunction(func):
            return self.async_to_sync(func)
    def async_to_sync(
            from asgiref.sync import async_to_sync as asgiref_async_to_sync
        return asgiref_async_to_sync(func)
$ sed -n '914p;917p;920p;933p;943p' src/flask/app.py
            request_started.send(self, _async_wrapper=self.ensure_sync)
                rv = self.dispatch_request()
        return self.finalize_request(rv)
        failure a special safe mode is available which can be enabled        <-- :933 is a DOCSTRING line, falsifies the evidence
                self, _async_wrapper=self.ensure_sync, response=response
$ grep -n "response = self.make_response(rv)" src/flask/app.py
939:        response = self.make_response(rv)

$ sed -n '20,37p' tests/test_async.py   -> class AsyncView(View) at 22; class AsyncMethodView(MethodView) at 30 (no methods decl)
$ sed -n '73,89p' tests/test_async.py   -> add_url_rule("/methodview", view_func=AsyncMethodView.as_view("methodview")) at 76

$ grep -rn "class Async" src/                    -> NO MATCH (exit 1)
$ grep -rn "AsyncMethodView" --include="*.py" . (minus .venv)
./tests/test_async.py:30:class AsyncMethodView(MethodView):
./tests/test_async.py:76:    app.add_url_rule("/methodview", view_func=AsyncMethodView.as_view("methodview"))
$ grep -rn "class .*View" --include="*.py" src/
src/flask/views.py:16:class View:
src/flask/views.py:27:        class Hello(View):
src/flask/views.py:138:class MethodView(View):
src/flask/views.py:152:        class CounterAPI(MethodView):
$ grep -n "ensure_sync" src/flask/views.py   -> 110, 116, 191 only

$ sed -n '618,624p;634,640p;648,652p' src/flask/sansio/app.py
            methods = getattr(view_func, "methods", None) or ("GET",)       (:622)
                view_func, "provide_automatic_options", None                (:636-638)
        rule_obj.provide_automatic_options = provide_automatic_options       (:651)
$ grep -n "flask.views.View\|flask.views.MethodView\|Class-Based Views" docs/api.rst -> 523, 530, 533
$ sed -n '204p;207,221p;226,240p;57p' tests/test_views.py   -> assertions as claimed (204 = ChildView.methods == {"PROPFIND","GET"}; 57 = view.view_class = Other)
$ sed -n '144,163p' tests/test_helpers.py   -> one as_view callable on three rules (146/155/156-158)
$ sed -n '20,22p' CHANGES.rst
-   Mark sans-io base class as being able to handle views that return
    ``AsyncIterable``. This is not accurate for Flask, but makes typing easier
    for Quart. :pr:`5659`
$ sed -n '24,30p' CHANGES.rst
Version 3.1.0
-------------
Released 2024-11-13
-   Drop support for Python 3.8. :pr:`5623`     <-- falsifies evidence's ":24-30 = AsyncIterable"
$ sed -n '463,474p' CHANGES.rst   -> 473: Support View and MethodView instances with async handlers. :issue:`4112`
$ sed -n '600,601p' CHANGES.rst   -> Support async views, error handlers, before and after request, and teardown functions. :pr:`3412`
$ sed -n '168,171p' CHANGES.rst   -> 170: Signals support ``async`` subscriber functions. :pr:`5049`
$ sed -n '688,689p;832,833p;862,864p' CHANGES.rst -> historical MethodView/View entries as claimed
$ sed -n '20,24p;33,41p;98,112p;117,125p' docs/async-await.rst -> as claimed (override line at :124)
$ sed -n '228,239p' docs/views.rst -> 232: MethodView extends the basic View to dispatch ...
$ sed -n '187,201p' docs/design.rst -> coroutines on a separate thread; WSGI/ASGI tension
$ sed -n '36,42p;84,87p' src/flask/typing.py -> ResponseReturnValue; RouteCallable = Callable|Callable[..., Awaitable[...]]
$ grep -n "asgiref" pyproject.toml -> 33: async = ["asgiref>=3.2"], plus tests extras

$ cat .venv/Lib/site-packages/flask.pth
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q9-TXT\seal\src      <-- stale/foreign; PYTHONPATH=src used everywhere
$ cat .pytest_cache/v/cache/lastfailed
{ "examples/javascript/tests": true, "examples/tutorial/tests": true, "flask_mut2_i417ar2x/mutated_test.py": true }
$ cat .git/HEAD   -> 85c5d93cbd049c4bd0679c36fd1ddcae8c37b642 (detached)
$ head -20 flask_mut2_i417ar2x/mutated_test.py   -> url_for/subdomain script, no view classes (not this task's test)
$ grep -rn "View" examples/  -> only examples/tutorial/flaskr/auth.py:20 (docstring), nothing relevant
```

**One-off runtime script** (exit 0)

```
flask.__file__ = ...\q10-TXT\seal\src\flask\__init__.py
flask.views.__file__ = ...\q10-TXT\seal\src\flask\views.py
(i) AsyncMethodView.__mro__ = (<class '__main__.AsyncMethodView'>, <class 'flask.views.MethodView'>, <class 'flask.views.View'>, <class 'object'>)
(ii) AsyncMethodView.methods = {'GET', 'POST'}
(iii) inspect.iscoroutinefunction(AsyncMethodView.get) = True
(iv) type(app.ensure_sync(AsyncMethodView.get)) = <class 'asgiref.sync.AsyncToSync'>
(iv) __module__ = asgiref.sync | __name__ = AsyncToSync
(v) ensure_sync identity for plain def: True
(v) type for plain def: <class 'function'>
MethodView.__mro__ = (<class 'flask.views.MethodView'>, <class 'flask.views.View'>, <class 'object'>)
View in MethodView.__bases__: True
```

**Narrow async suite**

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_async.py -q
........                                                                 [100%]
8 passed in 0.21s                                                        exit=0
```

**Complete suite, run 1 — normal** (`PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/`), exit 0:

```
collected 489 items
tests\test_appctx.py ..............                                      [  2%]
tests\test_async.py ........                                             [  4%]
tests\test_basic.py .................................................... [ 15%]
... (all files) ...
tests\test_views.py .............                                        [100%]
============================= 489 passed in 6.17s =============================
```

**Complete suite, run 2 — max verbosity** (`PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/ -vv -rA --tb=long`), exit 0. Result: `489 passed in 6.47s`, with the full `-rA` list of every PASSED test (including `tests/test_async.py::test_async_route[/methodview]`, `::test_async_error_handler[/error]`, `::test_async_before_after_request`, and all 13 `tests/test_views.py` tests). The on-screen dump was truncated by the tool at its 50 KB limit; the pre-truncation portion contained only captured stdout/stderr/log blocks from tests that deliberately raise (`test_werkzeug_passthrough_errors`, `test_session_error_pops_context`, `test_request_exception_signal`, `test_test_client_context_binding`, `test_error_handler_no_match`, `TestGenericHandlers...`, `test_templates_auto_reload_debug_run`, `test_template_loader_debugging`) — all of them `PASSED`; the summary and full PASSED list are complete in the capture.

**Adversarial falsification of reason (i)** — a `View` whose *sync* `dispatch_request` returns `coro()` (exit 0):

```
  File "...\src\flask\app.py", line 920, in full_dispatch_request
    return self.finalize_request(rv)
  File "...\src\flask\app.py", line 939, in finalize_request
    response = self.make_response(rv)
  File "...\src\flask\app.py", line 1249, in make_response
TypeError: The view function did not return a valid response. The return type must be a string, dict, list, tuple with headers or status, Response instance, or WSGI callable, but it was a coroutine.
status_code: 500
good status_code: 200 data: b'OK-from-coroutine'
```
(The same class with `async def dispatch_request` succeeds — confirming the conversion must live in the shared `ensure_sync` machinery, not in a separate dispatch.)

**Post-write checks**: `ls -la answer.md` → 21979 bytes; `git status --porcelain` → only `?? answer.md` and the pre-existing `?? flask_mut2_i417ar2x/`; `pytest tests/test_async.py tests/test_views.py -q` → `21 passed in 0.36s`.

## 6. Corrections to the inherited evidence

1. The dossier cites `response = self.make_response(rv)` as `src/flask/app.py:933` — **wrong**: line 933 is a docstring line; the real line is **`src/flask/app.py:939`** (confirmed by `grep -n` and by the runtime traceback).
2. The dossier cites the `AsyncIterable`/Quart changelog note as `CHANGES.rst:24-30` — **wrong**: those lines are the 3.1.0 header; the real location is **`CHANGES.rst:20-22`** (under 3.1.1 at `:10`, released `:13`).

All other claims in the dossier re-verified exactly as stated. Nothing in the tree was modified; no file outside the working directory was read or written. The long version above remains available alongside the short version, and the short version contains no statement absent from the long version.
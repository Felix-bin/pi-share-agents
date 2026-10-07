# How `MethodView.__init_subclass__` resolves conflicting `methods` attributes under multiple inheritance

**Short answer.** The HTTP method-dispatching view class is `flask.views.MethodView`. Its subclass hook is `MethodView.__init_subclass__`, and when a new subclass has no `methods` of its own it resolves parent conflicts by **set union over the direct bases** — not by MRO precedence. Concretely, for each direct base in `cls.__bases__` whose `methods` attribute is truthy it calls `methods.update(base.methods)` into a fresh `set()`; it then adds `key.upper()` for each of the eight names in `http_method_funcs` that the class has via `hasattr`, and only assigns `cls.methods = methods` if that set is non-empty. So two bases declaring `{"GET"}` and `{"DELETE"}` yield `{"GET", "DELETE"}` — every method survives, nothing shadows anything. Which *implementation* handles a given verb is decided later, outside the hook, by ordinary MRO lookup in `dispatch_request`. And a subclass that writes `methods = [...]` in its own class body opts out of the whole computation (that is how a subclass *removes* an inherited method).

---

## 1. The class and the hook, verbatim

The class is `MethodView`, a subclass of `View` (`src/flask/views.py`, line 138). The hook itself, `src/flask/views.py` lines 165–180 (the only `__init_subclass__` anywhere in the worktree — the executor's grep confirms `./src/flask/views.py:165` and `:166`, and nothing else):

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

The bound on the self-detection loop is a module-level frozenset of **eight lowercase names** (`src/flask/views.py` lines 11–13):

```python
http_method_funcs = frozenset(
    ["get", "post", "head", "options", "delete", "put", "trace", "patch"]
)
```

The attribute the hook writes is declared on `View` (`src/flask/views.py` lines 48–51):

```python
    #: The methods this view is registered for. Uses the same default
    #: (``["GET", "HEAD", "OPTIONS"]``) as ``route`` and
    #: ``add_url_rule`` by default.
    methods: t.ClassVar[t.Collection[str] | None] = None
```

And the value travels to the router through `View.as_view`, which copies it onto the generated view function (line 133):

```python
        view.view_class = cls  # type: ignore
        view.__name__ = name
        view.__doc__ = cls.__doc__
        view.__module__ = cls.__module__
        view.methods = cls.methods  # type: ignore
        view.provide_automatic_options = cls.provide_automatic_options  # type: ignore
        return view
```

`src/flask/sansio/app.py` (`Flask.add_url_rule`) then consumes it at line 622:

```python
        options["endpoint"] = endpoint
        methods = options.pop("methods", None)

        # if the methods are not given and the view_func object knows its
        # methods we can use that instead.  If neither exists, we go with
        # a tuple of only ``GET`` as default.
        if methods is None:
            methods = getattr(view_func, "methods", None) or ("GET",)
        if isinstance(methods, str):
            raise TypeError(
                "Allowed methods must be a list of strings, for"
                ' example: @app.route(..., methods=["POST"])'
            )
        methods = {item.upper() for item in methods}
```

---

## 2. The mechanism, step by step, each point tied to its line

**Step 1 — entry and the opt-out guard.** The hook first calls `super().__init_subclass__(**kwargs)` (line 166), keeping it cooperative for further mixins, and then does nothing at all if the new class's *own* namespace already contains `methods`:

```python
        if "methods" not in cls.__dict__:
```

At hook time `cls.__dict__` holds only the class body, so an explicit `methods = [...]` — or even `methods = None` or `methods = []` — short-circuits everything. This is the authoritative-override path, and it is what `test_remove_method_from_parent` exercises.

**Step 2 — the base merge (the conflict resolution proper).** Otherwise the hook starts a fresh accumulator and unions in the `methods` of every **direct** base that has a truthy one:

```python
            methods = set()

            for base in cls.__bases__:
                if getattr(base, "methods", None):
                    methods.update(base.methods)  # type: ignore[attr-defined]
```

Three things to note, each of which is easy to get wrong:

- It is `update` — a **set union, not MRO precedence**. Nothing shadows anything: if `GetView.methods == {"GET"}` and `DeleteView.methods == {"DELETE"}`, the child gets `{"GET", "DELETE"}`.
- It walks `cls.__bases__` — **direct bases only**. Transitivity comes from the fact that each base's own `methods` was itself produced by this same hook (or declared); there is no scan of the full MRO for `methods`.
- The values are copied into a fresh `set`, so parents' attributes (including lists) are never mutated by a child.

**Step 3 — the self-detection pass.** Then it loops the eight names in `http_method_funcs` and adds the uppercase form of every one the class has anywhere in its MRO:

```python
            for key in http_method_funcs:
                if hasattr(cls, key):
                    methods.add(key.upper())
```

`hasattr` spans the whole MRO, so inherited handlers count; `key.upper()` is why the resulting set contains `"GET"`, `"DELETE"`, etc. Verbs outside that frozenset (e.g. `PROPFIND` from a `propfind` handler) are invisible to this pass and must arrive through an explicit base `methods`.

**Step 4 — the conditional commit.** The class attribute is set to the union of uppercase strings, but only when non-empty:

```python
            if methods:
                cls.methods = methods
```

Consequences: a class body that declared a list keeps a list and is not converted to a set; a computed-empty result means `cls.methods` is *not* set on the class, so lookup falls through the MRO to whatever the first base had (`()` or `None`); and because `as_view` copies `cls.methods` onto the view function (line 133), the union is exactly what `add_url_rule` registers — merged methods are routable, non-merged ones return 405.

**Step 5 — what the hook does *not* resolve.** Conflicts about *which implementation* answers a method are handled elsewhere, by ordinary attribute lookup, in `MethodView.dispatch_request` (`src/flask/views.py` lines 182–192):

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

So the hook unions *which methods are registered*, while `getattr(self, request.method.lower(), None)` (plus the `HEAD`→`get` fallback) lets normal MRO order pick the *winning handler*. The two roles are separate: with `class C(A, B)` where both define `get`, `C.methods` is still just `{"GET"}` and `A.get` wins.

---

## 3. The executable statements of truth

`tests/test_views.py` — the multiple-inheritance case in full (lines 207–220):

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

The override/opt-out case (lines 226–240):

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

The base-`methods` seeding case (lines 189–204):

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

And the single-level inheritance case (lines 62–77):

```python
def test_view_inheritance(app, client):
    class Index(flask.views.MethodView):
        def get(self):
            return "GET"

        def post(self):
            return "POST"

    class BetterIndex(Index):
        def delete(self):
            return "DELETE"

    app.add_url_rule("/", view_func=BetterIndex.as_view("index"))

    meths = parse_set_header(client.open("/", method="OPTIONS").headers["Allow"])
    assert sorted(meths) == ["DELETE", "GET", "HEAD", "OPTIONS", "POST"]
```

The documentation states the class-level effect (`docs/views.rst`, “Method Dispatching and APIs”):

> ``MethodView`` automatically sets :attr:`View.methods` based on the methods defined by the class. It even knows how to handle subclasses that override or define other methods.

The changelog records the two historical intents (`CHANGES.rst`):

```rst
-   The ``MethodView.methods`` attribute set in a base class is used by
    subclasses. :issue:`3138`
```
```rst
-   ``MethodView`` subclasses inherit method handlers from base classes.
    :pr:`1936`
```

---

## 4. Executed confirmation

Environment note first, because it matters for trusting the runs: the `.venv`'s editable-install pointer is stale. `.venv/Lib/site-packages/flask.pth` contains a path from a *different* checkout, and the venv interpreter without `PYTHONPATH` resolves `flask` elsewhere:

```
$ .venv/Scripts/python.exe -c "import flask; print(flask.__file__)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q7-TXT\seal\src\flask\__init__.py
```

With `PYTHONPATH=src` it resolves to this worktree:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -c "import flask; print(flask.__file__)"
C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q8-TXT\seal\src\flask\__init__.py
```

All runs below were therefore pinned with `PYTHONPATH=src`. The focused subset the plan asked for:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_views.py -q -k "multiple_inheritance or methods_var_inheritance or remove_method_from_parent or view_inheritance or method_based_view"
.....                                                                    [100%]
5 passed, 8 deselected in 0.11s
```

The whole relevant file:

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_views.py
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q8-TXT\seal
configfile: pyproject.toml
collected 13 items

tests\test_views.py .............                                        [100%]

============================= 13 passed in 0.18s ==============================
```

`test_multiple_inheritance`, `test_methods_var_inheritance` and `test_remove_method_from_parent` appear in the verbose `PASSED` listing, and the full project suite passes:

```
============================= 489 passed in 6.54s =============================
```

### Isolated demonstrations of the resolution mechanics

**(a) Two auto-detecting bases → union, and the container is a `set`:**

```python
from flask.views import MethodView
class GetView(MethodView):
    def get(self): return "GET"
class DeleteView(MethodView):
    def delete(self): return "DELETE"
class Both(GetView, DeleteView):
    pass
print("GetView.methods   =", GetView.methods)
print("DeleteView.methods=", DeleteView.methods)
print("Both.methods      =", Both.methods)
print("type(Both.methods)=", type(Both.methods).__name__)
print("Both.__bases__    =", Both.__bases__)
```
```
GetView.methods   = {'GET'}
DeleteView.methods= {'DELETE'}
Both.methods      = {'DELETE', 'GET'}
type(Both.methods)= set
Both.__bases__    = (<class '__main__.GetView'>, <class '__main__.DeleteView'>)
```

**(b) Two bases with *opposing* explicit `methods` → still a union (no shadowing):**

```python
from flask.views import MethodView
class A(MethodView):
    methods = {"GET", "POST"}
    def get(self): return "A"
class B(MethodView):
    methods = {"PUT"}
    def put(self): return "B"
class C(A, B):
    pass
print("A.methods =", A.methods)
print("B.methods =", B.methods)
print("C.methods =", C.methods)
print("type(C.methods) =", type(C.methods).__name__)
```
```
A.methods = {'POST', 'GET'}
B.methods = {'PUT'}
C.methods = {'POST', 'GET', 'PUT'}
type(C.methods) = set
```

**(c) Same handler on both bases → one `"GET"`, winner picked later by MRO:**

```python
from flask.views import MethodView
class A(MethodView):
    def get(self): return "A"
class B(MethodView):
    def get(self): return "B"
class C(A, B):
    pass
print("C.methods     =", C.methods)
print("C().get()     =", C().get())
print("C.__mro__     =", [c.__name__ for c in C.__mro__])
print("winner via getattr(C(), 'get') ->", getattr(C(), "get")())
```
```
C.methods     = {'GET'}
C().get()     = A
C.__mro__     = ['C', 'A', 'B', 'MethodView', 'View', 'object']
winner via getattr(C(), 'get') -> A
```

**(d) A class-body `methods` opts out, is left untouched, and parents are not mutated:**

```python
from flask.views import MethodView
class GetView(MethodView):
    def get(self): return "GET"
class DeleteView(MethodView):
    def delete(self): return "DELETE"
class V(GetView, DeleteView):
    methods = ["GET"]
print("V.methods        =", V.methods)
print("type(V.methods)  =", type(V.methods).__name__)
print("'methods' in V.__dict__ =", "methods" in V.__dict__)
print("GetView.methods  =", GetView.methods, "(parent untouched)")
print("DeleteView.methods =", DeleteView.methods, "(parent untouched)")
```
```
V.methods        = ['GET']
type(V.methods)  = list
'methods' in V.__dict__ = True
GetView.methods  = {'GET'} (parent untouched)
DeleteView.methods = {'DELETE'} (parent untouched)
```

**(e) Falsy opt-out, and an empty computed set is never assigned:**

```python
from flask.views import MethodView
class NoMethods(MethodView):
    methods = None
class EmptyBase(MethodView):
    methods = ()
    def dispatch_request(self): return "x"
class EmptyChild(EmptyBase):
    pass
print("NoMethods.methods  =", repr(NoMethods.methods), "| 'methods' in __dict__:", "methods" in NoMethods.__dict__)
print("EmptyBase.methods  =", repr(EmptyBase.methods))
print("EmptyChild.methods =", repr(EmptyChild.methods), "| 'methods' in __dict__:", "methods" in EmptyChild.__dict__)
class FalsyOptOut(MethodView):
    methods = None
    def get(self): return "GET"
    def post(self): return "POST"
print("FalsyOptOut.methods =", repr(FalsyOptOut.methods), "(kept None; handlers defined)", "| __dict__:", "methods" in FalsyOptOut.__dict__)
class EmptyListOptOut(MethodView):
    methods = []
    def get(self): return "GET"
print("EmptyListOptOut.methods =", repr(EmptyListOptOut.methods), "| __dict__:", "methods" in EmptyListOptOut.__dict__)
```
```
NoMethods.methods  = None | 'methods' in __dict__: True
EmptyBase.methods  = ()
EmptyChild.methods = () | 'methods' in __dict__: False
FalsyOptOut.methods = None (kept None; handlers defined) | __dict__: True
EmptyListOptOut.methods = [] | __dict__: True
```

Note the last line of that block: `EmptyChild` has no `"methods"` in its `__dict__` (the computed set was empty and `if methods:` skipped the assignment), so it reads `()` from its base through the MRO. Note also that `EmptyListOptOut.methods` stays a `list`, not a `set` — the declared object is never touched.

**(f) Verbs outside `http_method_funcs` are never auto-added; they need an explicit base `methods`:**

```python
from flask.views import MethodView
from flask.views import http_method_funcs
print("http_method_funcs =", sorted(http_method_funcs), "| n =", len(http_method_funcs))
class OnlyPropfind(MethodView):
    def propfind(self): return "PROPFIND"
print("OnlyPropfind.methods =", repr(OnlyPropfind.methods), "(not auto-added: 'propfind' not in http_method_funcs)")
print("hasattr(OnlyPropfind,'propfind') =", hasattr(OnlyPropfind, "propfind"))
class BaseView(MethodView):
    methods = ["GET", "PROPFIND"]
class ChildView(BaseView):
    def get(self): return "GET"
    def propfind(self): return "PROPFIND"
print("BaseView.methods  =", BaseView.methods, type(BaseView.methods).__name__)
print("ChildView.methods =", ChildView.methods, type(ChildView.methods).__name__)
print("ChildView.methods == {'PROPFIND','GET'} ->", ChildView.methods == {"PROPFIND", "GET"})
print("BaseView.methods mutated? ->", BaseView.methods)
class Arbitrary(MethodView):
    def report(self): return "REPORT"
    def mkcol(self): return "MKCOL"
print("Arbitrary.methods =", repr(Arbitrary.methods), "(REPORT/MKCOL not detected)")
```
```
http_method_funcs = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] | n = 8
OnlyPropfind.methods = None (not auto-added: 'propfind' not in http_method_funcs)
hasattr(OnlyPropfind,'propfind') = True
BaseView.methods  = ['GET', 'PROPFIND'] list
ChildView.methods = {'PROPFIND', 'GET'} set
ChildView.methods == {'PROPFIND','GET'} -> True
BaseView.methods mutated? -> ['GET', 'PROPFIND']
Arbitrary.methods = None (REPORT/MKCOL not detected)
```

That last pair of lines is the direct proof of two claims: the base `list` is **not** mutated by the child's merge, and the child's result **is** a `set`.

**Transitivity via direct bases only:**

```python
from flask.views import MethodView
class G(MethodView):
    methods = ["GET", "PROPFIND"]
class P(G):
    def get(self): return "GET"
class P2(G):
    def post(self): return "POST"
class Child(P, P2):
    def delete(self): return "DELETE"
print("G.methods    =", G.methods)
print("P.methods    =", P.methods)
print("P2.methods   =", P2.methods)
print("Child.methods=", Child.methods, type(Child.methods).__name__)
```
```
G.methods    = ['GET', 'PROPFIND']
P.methods    = {'GET', 'PROPFIND'}
P2.methods   = {'GET', 'POST', 'PROPFIND'}
Child.methods= {'PROPFIND', 'GET', 'POST', 'DELETE'} set
Leaf.methods = {'GET', 'PROPFIND'} | Leaf.__bases__ = ['Mid2']
```

Here `G.methods` is a `list`, and `P`, `P2` (auto-detecting subclasses) turn it into a set by seeding from their direct base; `Child` unions its two direct bases and its own `delete`. The value flows downward one level at a time through `cls.__bases__` only.

**End-to-end routing check** (first attempt failed only for an unrelated import reason, worth recording verbatim):

```
Traceback (most recent call last):
  File "<stdin>", line 6, in <module>
AttributeError: module 'flask' has no attribute 'views'
```

`flask.views` is not re-exported by `import flask` in this version — it must be imported explicitly, exactly as `tests/test_views.py` does with `import flask.views`. With that fixed, running a `GetView`/`DeleteView`/`GetDeleteView` app and the `methods = ["GET"]` override:

```
GET /     -> b'GET' 200
DELETE /  -> b'DELETE' 200
POST /    -> 405 (not in union -> 405)
Allow header -> ['DELETE', 'GET', 'HEAD', 'OPTIONS']
GetDeleteView.methods -> {'GET', 'DELETE'}
view func methods -> {'GET', 'DELETE'} (as_view copies cls.methods, views.py:133)
override opt-out: GET -> b'GET' | POST -> 405 | V.methods -> ['GET']
```

So the union is what the router registers, a verb not in the union is a 405, and the class-body override really does remove the parent's method (POST → 405).

---

## 5. The precise, load-bearing qualifications

These are the ways the mechanism is commonly mis-stated, each contradicted by a line quoted above:

1. **Not MRO precedence.** The conflict resolution is `methods.update(base.methods)` — a union. `Both.methods == {'DELETE', 'GET'}` and `C(A, B).methods == {'POST', 'GET', 'PUT'}` in the runs above. Precedence appears only later, in `dispatch_request`'s `getattr(self, request.method.lower(), None)`, which is why `C(A, B).get()` returns `"A"` while the *registered* method set is unchanged.
2. **Direct bases only.** The loop is `for base in cls.__bases__:`; it does not scan the full MRO for `methods`. Transitivity is a consequence of each base having already run the same hook (see the `G → P/P2 → Child` output).
3. **Only eight verbs are auto-detected.** The second loop iterates `http_method_funcs` (`get, post, head, options, delete, put, trace, patch`, `n = 8`), so `propfind`/`report`/`mkcol` handlers produce nothing on their own (`OnlyPropfind.methods = None`, `Arbitrary.methods = None`); `PROPFIND` in `test_methods_var_inheritance` exists only because `BaseView` declares `methods = ["GET", "PROPFIND"]`.
4. **Parents are never mutated.** The child accumulates into a fresh `set()`; `BaseView.methods mutated? -> ['GET', 'PROPFIND']`.
5. **`cls.methods` is not always set, and a declared object is not coerced.** The commit is `if methods: cls.methods = methods`, so an empty computation leaves the class without its own `methods` (`EmptyChild`: `'methods' in __dict__: False`) and a class-body list stays a list (`V.methods` → `['GET']`, `type ... list`; `EmptyListOptOut.methods` → `[]`). But note the opt-out is keyed on presence in `cls.__dict__`, not truthiness: `methods = None` and `methods = []` still opt out (`'methods' in NoMethods.__dict__: True`).
6. **The guard wins over everything.** `if "methods" not in cls.__dict__:` means `test_remove_method_from_parent`'s `class View(GetView, OtherView): methods = ["GET"]` never unions the parents' `{"GET", "POST"}` — the explicit declaration is authoritative, which is exactly the escape hatch for removing an inherited method.

One last scoping note: the working directory also contains an unrelated `flask_mut2_i417ar2x/mutated_test.py` that exercises `subdomain_matching`/`url_for`; a grep for `MethodView|__init_subclass__|http_method_funcs` in it returns no match (exit 1), and it is not collected by pytest (`testpaths = ["tests"]`), so it is not evidence for anything above. Likewise, `MethodView` is referenced only in `src/flask/views.py`, `tests/test_views.py`, `tests/test_async.py` (async handlers, where `hasattr` detection works identically) and `tests/test_helpers.py`, and there is no second `__init_subclass__` in the worktree.
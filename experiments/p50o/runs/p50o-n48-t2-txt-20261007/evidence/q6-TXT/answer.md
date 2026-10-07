# How `_AppCtxGlobals` balances `AttributeError` vs. defaults

**What the object is.** The class in question is `_AppCtxGlobals` in `src/flask/ctx.py:29`, described in its own docstring as *"A plain object. Used as a namespace for storing data during an application context."* It is the default of `Flask.app_ctx_globals_class`:

```python
    #: The class that is used for the :data:`~flask.g` instance.
    #:
    #: Example use cases for a custom class:
    #:
    #: 1. Store arbitrary attributes on flask.g.
    #: 2. Add a property for lazy per-request database connectors.
    #: 3. Return None instead of AttributeError on unexpected attributes.
    #: 4. Raise exception if an unexpected attr is set, a "controlled" flask.g.
    app_ctx_globals_class = _AppCtxGlobals
```

Every `AppContext` instantiates it (`self.g: _AppCtxGlobals = app.app_ctx_globals_class()`, `src/flask/ctx.py:248`), and users reach it through a proxy: `g: _AppCtxGlobals = LocalProxy(_cv_app, "g", unbound_message=_no_app_msg)` (`src/flask/globals.py:31-33`).

**The raising side — attribute syntax is strict.** All four instance attributes live in `self.__dict__`, and both lookup and deletion convert a miss into `AttributeError`:

```python
    def __getattr__(self, name: str) -> t.Any:
        try:
            return self.__dict__[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name: str, value: t.Any) -> None:
        self.__dict__[name] = value

    def __delattr__(self, name: str) -> None:
        try:
            del self.__dict__[name]
        except KeyError:
            raise AttributeError(name) from None
```

Nothing is defaulted on this path, so a typo fails loudly and standard protocols (`hasattr`, `getattr(x, name, fallback)`) keep their normal semantics — because `__getattr__` is consulted only *after* normal lookup fails, the real methods (`get`, `pop`, `setdefault`) are never shadowed. The `from None` is deliberate: it suppresses the chained `KeyError` so the traceback shows one clean error.

**The defaulting side — dict-method syntax is lenient.**

```python
    def get(self, name: str, default: t.Any | None = None) -> t.Any:
        return self.__dict__.get(name, default)

    def pop(self, name: str, default: t.Any = _sentinel) -> t.Any:
        """... :param default: Value to return if the attribute is not present,
            instead of raising a ``KeyError``.
        """
        if default is _sentinel:
            return self.__dict__.pop(name)
        else:
            return self.__dict__.pop(name, default)

    def setdefault(self, name: str, default: t.Any = None) -> t.Any:
        return self.__dict__.setdefault(name, default)
```

**The actual balance.** The strategy is *strict by attribute syntax, lenient by dict-method syntax*, and it deliberately does **not** unify exception types: attribute access and deletion raise `AttributeError`, while `pop(name)` without a default raises **`KeyError`** (straight from `dict.pop`) — matching the `dict.pop` contract the docstring cites. The module-level `_sentinel = object()` (`src/flask/ctx.py:26`) is what makes `g.pop("x", None)` distinguishable from `g.pop("x")`; without it an explicit `None` would read as "no default" and `pop` could never raise. Presence can also be tested exception-free via `'key' in g` / `iter(g)`, which the docs' own idiom uses:

```python
    def get_db():
        if 'db' not in g:
            g.db = connect_to_database()

        return g.db

    @app.teardown_appcontext
    def teardown_db(exception):
        db = g.pop('db', None)

        if db is not None:
            db.close()
```

Lenient *attribute* access is explicitly an opt-in customization (use case 3 above), implemented by subclassing and assigning `app.app_ctx_globals_class`. History matches: `CHANGES.rst:1198` records that ``flask.g`` "now gained a ``get()`` method for not erroring out on non existing items" (0.10), and `CHANGES.rst:1116` that it "now has ``pop()`` and ``setdefault`` methods" (0.11). The sentinel idiom recurs in `AppContext.pop`/`RequestContext.pop` (`src/flask/ctx.py:256`, `:396`).

**Caveat — the proxy is not the namespace.** Outside a pushed context the `g` proxy itself raises `RuntimeError` ("Working outside of application context.") and is falsy (`tests/test_basic.py:1489-1491`). The `AttributeError`-vs-default story applies only to the namespace object.

## Verified runtime behavior (executed against this tree)

| Expression (in a pushed app context) | Result | Source of truth |
|---|---|---|
| `flask.g.get("k")` | `None`, never raises — observed `None True` | `get` → `__dict__.get` |
| `flask.g.get("k", 7)` | `7` — observed `'D'` for default `'D'` | `get` → `__dict__.get` |
| `flask.g.setdefault("a", 1)` then `setdefault("a", 2)` | `1`, then `1` (inserted once, stored value returned) | `setdefault` |
| `flask.g.pop("missing")` | `KeyError('missing')` — **not** `AttributeError` | `if default is _sentinel: __dict__.pop(name)` |
| `flask.g.pop("missing", "D")` | `'D'` | `__dict__.pop(name, default)` |
| `flask.g.pop("k", d)` when present | stored value returned and removed (`9`, then `False` for `"k" in g`) | same |
| `flask.g.missing` | `AttributeError('missing')` | `__getattr__` |
| `del flask.g.missing` | `AttributeError('missing')` | `__delattr__` |
| `e.__cause__` / `e.__suppress_context__` on those errors | `None` / `True` (proof of `from None`) | `raise AttributeError(name) from None` |
| `hasattr(g, "missing")` / `getattr(g, "missing", "D")` | `False` / `'D'` | normal Python protocol |
| `'x' in g` after `del g.x` | `False` | `__contains__` |
| unbound `bool(flask.g)` / `repr(flask.g)` | `False` / `"<LocalProxy unbound>"` | `LocalProxy` fallbacks |
| unbound `flask.g.k` | `RuntimeError: Working outside of application context.` | `unbound_message=_no_app_msg` |

The three targeted regression tests pass (`3 passed in 0.12s`), including the authoritative spec, which asserts the split directly:

```python
def test_app_ctx_globals_methods(app, app_ctx):
    # get
    assert flask.g.get("foo") is None
    assert flask.g.get("foo", "bar") == "bar"
    ...
    # pop
    assert flask.g.pop("bar") == "the cake is a lie"
    with pytest.raises(KeyError):
        flask.g.pop("bar")
    assert flask.g.pop("bar", "more cake") == "more cake"
```

Notably, no test in the tree asserts `AttributeError` on `g` (`grep -rn "AttributeError\|__delattr__\|del g\." tests/` → no matches); the raising behavior is exercised only indirectly via `assert not hasattr(flask.g, "value")` (`tests/test_testing.py:233`). The full suite passes unchanged (`489 passed`), so the observed behavior is the tree's behavior, not a mutated one.
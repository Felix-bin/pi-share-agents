## Where the parent/child inheritance chain enters config resolution

The sole point is `Config.from_object` in `src/flask/config.py` (defined at line 218). Its entire resolution body is lines 250–254:

```python
if isinstance(obj, str):
    obj = import_string(obj)
for key in dir(obj):          # line 252
    if key.isupper():
        self[key] = getattr(obj, key)   # line 254
```

Inheritance enters twice, at those same two lines. `dir(obj)` on a class enumerates attributes along the class MRO, so an uppercase key that exists *only* on a parent config class is discovered and loaded. `getattr(obj, key)` also resolves along the MRO, so when a child class redefines a key, the child's value is the one written into `self[key]`. The loop makes a single pass with one value per key, so precedence is decided by the MRO rather than by iteration order.

**What does not resolve inheritance.** `from_pyfile` reaches this loop only indirectly — `src/flask/config.py:215` calls `self.from_object(d)` — so file/module loading picks up the same MRO behaviour. `from_mapping` (`src/flask/config.py:304`) and hence `from_file` use a plain mapping loop (`for key, value in mappings.items()` at line 318) with no `dir`/`getattr`, so no class-inheritance chain is consulted on that path. Flask's internal `config_class = Config` (`src/flask/sansio/app.py:196`, used at 496) is a different mechanism: it selects which `Config` implementation the app instantiates and plays no part in per-key inheritance resolution.

**Corroboration.** `tests/test_config.py:132` `test_config_from_class` defines `class Base: TEST_KEY = "foo"` and `class Test(Base): SECRET_KEY = "config"`, calls `app.config.from_object(Test)`, and asserts via `common_object_test` — pinning that a parent-only key survives when the child class is loaded. `docs/config.rst:686–714` documents the same intended pattern (a parent `Config` with `ProductionConfig`/`DevelopmentConfig`/`TestingConfig` children, then `app.config.from_object('configmodule.ProductionConfig')`). The method's own docstring, `src/flask/config.py:236–238`, adds the caveat that the class is *not* instantiated, so an inherited `@property` is read as the property object unless the class is instantiated first — restated at `docs/config.rst:704–714`.

## What this rests on, and what is open

- Rests on: verified line numbers in `src/flask/config.py` (218 def; 215 `from_object` call; 252/254 the `dir`/`getattr` lines; 304/318 the non-inheriting mapping path), `tests/test_config.py:132`, `docs/config.rst:686–714`.
- Ambiguity resolved: "parent and child configuration classes" is read as user-authored class-to-class inheritance of config classes, because that is exactly what `test_config_from_class` and the docs example exercise; the internal `config_class` override is a different, key-independent mechanism.
- Open / not established: no test in `tests/test_config.py` pins the *child-overrides-parent* precedence case, and none covers an inherited `@property` without instantiation — that behaviour is read from MRO + `getattr` semantics, not from an executed assertion. No command was run; no code change is implied or suggested.
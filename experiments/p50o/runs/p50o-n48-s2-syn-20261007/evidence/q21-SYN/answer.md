## Where the inheritance chain affects resolution

**`src/flask/config.py:252–254`, inside `Config.from_object` (defined at line 218)** — the `dir()` scan and the `getattr` that feed the copy into the config dict. The tail of the method is exactly these five lines (re-read and verified in this worktree):

```
250  if isinstance(obj, str):
251      obj = import_string(obj)
252  for key in dir(obj):
253      if key.isupper():
254          self[key] = getattr(obj, key)
```

The chain has no dedicated code — there is no explicit base-class or `__mro__` walk in the config module (a grep for `__mro__`/`__bases__` in `src/` hits only the exception-class handling in `flask/sansio/app.py:841`). The parent→child effect is a by-product of two builtins on those two lines:

- **Line 252, `for key in dir(obj)` — inclusion.** `dir()` on a class enumerates inherited attributes as well as the class's own, so passing a child config class also yields the parent class's uppercase names. That is how the parent's defaults become entries in `app.config` at all. Each name appears once, so a key defined in both classes arrives as a single iteration of `key`.
- **Line 254, `self[key] = getattr(obj, key)` — override.** `getattr` resolves through the MRO, so for a key defined in both parent and child the child's value is the one read. Combined with single assignment per key, the outcome is inclusion-then-override with no Flask-side precedence logic: precedence is `getattr`'s MRO resolution plus "a later `from_object` call overwrites an earlier key".
- **Line 253, `key.isupper()`,** is only the filter; it has no inheritance dimension.

**Corroboration in the tree.** The seam is the documented and tested one for class-based config. `docs/config.rst` (~683–709) shows `class Config(object): TESTING = False` with `class ProductionConfig(Config): DATABASE_URI = ...` loaded via `app.config.from_object('configmodule.ProductionConfig')` — the child load is expected to pick up the parent's `TESTING`. `tests/test_config.py:132–141` (`test_config_from_class`) defines `class Base: TEST_KEY = "foo"` / `class Test(Base): SECRET_KEY = "config"`, calls `app.config.from_object(Test)`, and asserts via `common_object_test` (lines 15–18) that both `app.config["TEST_KEY"] == "foo"` (parent-only) and `app.secret_key == "config"` (child-only) hold. `from_pyfile` reaches the same line because it routes back through `from_object` (`src/flask/config.py:215`); `Config` is a plain `dict` subclass (line 52) with no resolution-order override.

**The unrelated lookalike:** the second `if key.isupper():` at `src/flask/config.py:319` sits in `from_mapping` (defined at line 304) and iterates a merged mapping/kwargs dict. Mappings carry no inheritance chain, so the parent/child question does not apply there.

**Input form does not move the seam.** If the caller passes an instance (`ProductionConfig()`), as the docs' `@property` note describes, `dir`/`getattr` still traverse the class MRO for the instance, so lines 252–254 remain the location.

### What this rests on, and what is open

- Directly verified in this worktree: `src/flask/config.py:218` / `250–254` / `304` / `319`, `tests/test_config.py:1–40` and `125–148` (class test at 132–141, `common_object_test` at 15–18), `docs/config.rst:678–722`.
- **Not established:** no runtime execution was performed — the "`dir()` includes inherited names / `getattr` follows the MRO" behaviour is stated as Python semantics, not as output observed here. The existing test uses *disjoint* parent/child keys, so no test in the tree pins the winning value when both classes define the same uppercase key (the override direction on line 254 is inference). Nothing was changed in the code.
- **Open:** whether the `dir()`-based scan should be changed (explicit MRO walk, `vars()`-only), and whether this is an explanation request or a bug report — neither is answered by this evidence.
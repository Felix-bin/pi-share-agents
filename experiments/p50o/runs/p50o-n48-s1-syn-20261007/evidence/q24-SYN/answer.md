## How `MethodView.__init_subclass__` resolves conflicting `methods` from multiple parents

**It merges them — a set-union — and never applies precedence.** There is no MRO ordering rule, no "left-most base wins", and no first-match rule: the hook iterates `cls.__bases__` and accumulates each base's `methods` into one set, so parents with conflicting values all contribute and nothing is dropped.

The hook is `MethodView.__init_subclass__` in `src/flask/views.py:165-180`, defined in the body of the method-dispatching view class (`dispatch_request`, lines 182-194, dispatches via `getattr(self, request.method.lower(), None)` with a HEAD→`get` fallback and an assert otherwise). Walking its branches in the order they execute:

1. **`super().__init_subclass__(**kwargs)`** — line 166, before anything else.
2. **Own-attribute guard** — line 168: `if "methods" not in cls.__dict__:`. If the subclass body declares `methods`, the entire computation is skipped: no union with parents, and no handler scan either. This is the only way to *narrow* an inherited set.
3. **Union over direct bases** — lines 169-173:
   ```python
   methods = set()
   for base in cls.__bases__:
       if getattr(base, "methods", None):
           methods.update(base.methods)
   ```
   Each parent's value is merged with `set.update` into a plain `set`. Names appearing in more than one parent collapse to a single entry; the result is independent of base order. Only direct bases are iterated, but `getattr` reads inherited attributes, so a base whose own creation already computed a union passes that union down transitively.
   The truthiness test matters as written: a base whose `methods` is empty or `None` is skipped rather than contributing an empty set, and an explicit `methods = []` in the subclass body still short-circuits at branch 2.
4. **Handler-implied verbs** — lines 175-177: for each name in `http_method_funcs` (`frozenset` at lines 11-13: get, post, head, options, delete, put, trace, patch), `hasattr(cls, key)` adds `key.upper()`. `hasattr` sees handlers inherited from any ancestor, so even a class defining no handlers of its own collects its parents' handler-implied methods.
5. **Write-back only when non-empty** — lines 179-180: `if methods: cls.methods = methods`. If nothing was contributed, the class keeps inheriting `View.methods = None` (line 51).
6. **Downstream** — `View.as_view` copies the set: `view.methods = cls.methods` (line 133), which is what registration consumes.

**The tests assert exactly this rule, including the two-parent case.** `tests/test_views.py:207-222` `test_multiple_inheritance`: `GetView(MethodView)` defines `get`, `DeleteView(MethodView)` defines `delete`, `class GetDeleteView(GetView, DeleteView): pass` (line 216, no own `methods`), and line 222 asserts `sorted(GetDeleteView.methods) == ["DELETE", "GET"]` — two unrelated parents unioned. `tests/test_views.py:226-242` `test_remove_method_from_parent` covers the short-circuit: `class View(GetView, OtherView): methods = ["GET"]` (line 235) yields a working GET, a `405` on POST (line 241) and `sorted(View.methods) == ["GET"]` (line 242) — the conflicting parent method is genuinely dropped. For contrast, `tests/test_views.py:189-204` `test_methods_var_inheritance` shows single-parent propagation: `ChildView.methods == {"PROPFIND", "GET"}` (line 204), again stored as a set.

So for the question as asked: conflicting `methods` attributes on multiple parent classes are **unioned into one set**, and inheritance priority is never consulted. Every verb any direct base advertises survives, plus every verb implied by a handler visible on the class; the only way to remove one is to declare `methods` in the subclass's own body, which disables the automatic computation entirely.

### What this rests on, and what is still open
- Resting on: `src/flask/views.py:165-180` (verbatim body re-read), lines 11-13, 51, 133, 182-194; `tests/test_views.py:189-204`, `207-222`, `226-242` (assertions re-read verbatim).
- Evidence and code agree — no contradiction between the retriever's report and the source I re-read.
- The plan's step 3 was carried out here; the executor stage was skipped by the complexity gate, so no runtime confirmation of the semantics was performed — they are established by the cited code plus the cited assertions only.
- Gap: no prose documentation states the multi-parent union rule. `docs/views.rst:236-238` and `CHANGES.rst:688-689` describe base-class `methods` inheritance generally; the union-vs-precedence rule for two parents rests on the hook's code and on `test_multiple_inheritance` alone.
- Not decided (and out of scope here): whether this behavior should change, be documented, or be re-tested; which tests, if any, to add.
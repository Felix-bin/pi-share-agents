## Answer

The lookup sequence is in `App._find_error_handler` (inherited by `Flask`, since `src/flask/app.py:81` declares `class Flask(App)`), body at **`src/flask/sansio/app.py:823-846`**. The sequence itself is the nested loop at **lines 834-845**:

```python
832  names = (*blueprints, None)
833
834  for c in (code, None) if code is not None else (None,):   # HTTP status code tier — OUTERMOST
835      for name in names:                                     # blueprint scope tier — MIDDLE
836          handler_map = self.error_handler_spec[name][c]
837
838          if not handler_map:
839              continue
840
841          for cls in exc_class.__mro__:                      # exception class MRO tier — INNERMOST
842              handler = handler_map.get(cls)
843
844              if handler is not None:
845                  return handler
846  return None
```

**The premise in the question does not match the source.** The method does not traverse blueprint scopes first. Reading the actual nesting in `src/flask/sansio/app.py`:

- **Line 834** (`for c in (code, None) ...`) is the **outermost** tier — it iterates HTTP status codes (the exception's specific code first, then `None`).
- **Lines 835/832** (`names = (*blueprints, None)`, then `for name in names`) are the **middle** tier — blueprint scopes, walking each blueprint name in scope and then `None` for the app.
- **Line 841** (`for cls in exc_class.__mro__`) is the **innermost** tier — the exception class method resolution order, with `handler_map.get(cls)` at line 842 and the return at line 845.

So the runtime order is **HTTP status code → blueprint scope → exception class MRO**, not blueprint scope → HTTP status code → MRO. On the question's three labels in the order given ("blueprint scopes then HTTP status codes then exception class MRO"), only the exception-MRO position agrees with the code.

The reordered premise appears to come from reading the *tier names as they first appear in the body* rather than the loop nesting: blueprint scopes are introduced first at line 832 (`names = ...`), HTTP codes at 834, MRO at 841. The method's own docstring (`src/flask/sansio/app.py:826-829`) confirms the nesting, not the line-of-first-appearance ordering: "blueprint handler for a specific code, app handler for a specific code, blueprint handler for an exception class, app handler for an exception class, or ``None``" — i.e. all specific-code lookups (both blueprint and app scope) are exhausted for a given code before class-scoped lookups are tried, which is exactly what the `c`-outer loop produces.

Callers pass `request.blueprints` (leaf-first through parents), so within the middle tier `names` walks innermost blueprint → outer blueprints → app; this is documented at the call sites in the same file (lines 774, 804, 857).

## What this rests on

- Direct read of the defining method: `src/flask/sansio/app.py:823-846`, confirming the block at lines 832, 834-836, 841-845 verbatim.
- Inheritance: `class Flask(App)` at `src/flask/app.py:81`, `from .sansio.app import App` at `src/flask/app.py:44`.
- Docstring ordering at `src/flask/sansio/app.py:826-829`.
- Spec/registration/merge context: `error_handler_spec` typed at `src/flask/sansio/scaffold.py:123-125`, written at `src/flask/sansio/scaffold.py:654`, blueprint specs merged under namespaced keys at `src/flask/sansio/blueprints.py:388-397`; `request.blueprints` at `src/flask/wrappers.py:181-197` via `_split_blueprint_path` (`src/flask/helpers.py:628-634`). These background sites were taken from the retriever stage and are consistent with the verified block; the core ordering claim was re-checked against the file itself.

## Open / not established

- No variant of the method traverses blueprint scopes before HTTP status codes — no such ordering exists in this worktree, so the question as phrased has no matching location; the answer above gives the ordering the source actually implements.
- The distractor `flask_mut2_i417ar2x/mutated_test.py` was checked and does not concern error handling (it exercises `url_for`/subdomain routing), so it is not the resolution site.
## Answer

The lookup lives in `Flask._find_error_handler` at **`src/flask/sansio/app.py:823–846`** (the method is the only definition of that name in the worktree; `__mro__` appears nowhere else under `src/flask`). All three traversals are the three loops in its body:

| Position | Line | Header | Dimension |
|---|---|---|---|
| outer | 834 | `for c in (code, None) if code is not None else (None,):` | HTTP status code |
| middle | 835 | `for name in names:` | blueprint scope (then app scope `None`) |
| inner | 841 | `for cls in exc_class.__mro__:` | exception-class MRO |

So the answer to "where" is: **lines 834–841, nested inside `_find_error_handler`**, where:

- the status-code traversal is the outer loop (834), iterating the specific code first then `None`;
- the scope traversal is the middle loop (835), over `names = (*blueprints, None)` set at line 832 — each active blueprint scope first, then the app scope `None`;
- the exception-MRO traversal is the inner loop (841), over `exc_class.__mro__`, returning the first non-`None` handler from `handler_map` (842–845).

`handler_map` itself is fetched per (scope, code) pair at line 836: `handler_map = self.error_handler_spec[name][c]`, with `exc_class, code` produced at line 831 by `self._get_exc_class_and_code(type(e))`. The callers pass `request.blueprints` as the scope chain (`src/flask/app.py:774`, `:804`, `:857`).

**On the order in the question.** The code's actual outer→inner order is **status code → blueprint/app scope → MRO**, not "blueprint scopes then HTTP status codes then MRO". The question's phrase is therefore best read as an unordered enumeration of the three dimensions it traverses, since no method in the worktree nests them in the order literally listed. If it is instead read as a strict outer-to-inner requirement, then no method satisfies it literally; `_find_error_handler` is the closest candidate and fails only on the position of the blueprint-scope loop (middle, not outer).

The separate priority the method's own docstring claims (826–829) — "blueprint handler for a specific code, app handler for a specific code, blueprint handler for an exception class, app handler for an exception class" — is realized by the combination of the 834 `(code, None)` order with the 832 `(*blueprints, None)` ordering, not by the loop nesting alone.

## What this rests on
- `src/flask/sansio/app.py:823–846` read verbatim: method signature, docstring, `names = (*blueprints, None)` (832), the three loop headers (834, 835, 841), `handler_map = self.error_handler_spec[name][c]` (836), `return None` (846).
- grep `__mro__` over `src/flask` → single hit at `sansio/app.py:841`; grep `def _find_error_handler` → single hit at `sansio/app.py:823`; `error_handler_spec[name][c]` read is unique to line 836 (other `error_handler_spec[` hits are writers in `scaffold.py` and `blueprints.py`).
- Caller sites `src/flask/app.py:774, :804, :857` passing `request.blueprints`.

## Still open
- No authority in the source rules on which ordering is "the" answer for grading (literal loop nesting vs. docstring priority); both are reported above. The docstring describes handler *priority*, the loops describe *traversal nesting*, and the question conflates them.
- `_get_exc_class_and_code` (`src/flask/sansio/scaffold.py:657–702`) is not a competing location: it resolves the class/code pair but traverses neither blueprints nor MRO. The only other directory in the tree contains no error-handler code.
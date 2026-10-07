# Architectural decisions encoded by `UnexpectedUnicodeError(AssertionError, UnicodeError)`

The dual inheritance is a deliberate statement about **which layer a failure belongs to, not just what went wrong**. The class (declared at `src/flask/debughelpers.py:17-20`) fuses two roles into one class statement:

- `UnicodeError` supplies the **domain**: this is an encoding/binary-data problem. It also drags in `ValueError` through the stdlib hierarchy, so the failure stays inside the standard-library *value* hierarchy rather than the I/O (`OSError`) hierarchy or an HTTP one.
- `AssertionError` supplies the **channel**: Flask reports it as a debug-mode diagnostic — the same channel it uses for framework/programming errors, not for expected client errors.

That pairing, in that order, is the decision. What it asserts architecturally:

## 1. Encoding issues are separated from request-validation failures by exception base, not by naming
Every debug diagnostic in the file follows the same pattern: keep the standard-library semantic base of the failure, mix in `AssertionError` as the debug marker, and **derive from nothing in `werkzeug.exceptions`**:

- `UnexpectedUnicodeError(AssertionError, UnicodeError)` — `debughelpers.py:17`
- `DebugFilesKeyError(KeyError, AssertionError)` — `debughelpers.py:23`
- `FormDataRoutingRedirect(AssertionError)` — `debughelpers.py:50`

None of the three is an `HTTPException`. That is the load-bearing separation: validation failures travel the HTTP path (`BadRequest` / `BadRequestKeyError` / `HTTPException` handling at `src/flask/app.py:780-809` and `src/flask/sansio/app.py:848-881`, which traps bad-request errors and maps them to 4xx), while encoding diagnostics are deliberately kept out of that path. A problem with the bytes the framework received is treated as an *unmet precondition in Flask's own machinery*, not as a client validation error to be rendered as a status code.

## 2. The MRO order fixes both the message behaviour and the catch channel
Measured against this tree (repo venv, `PYTHONPATH=src`):

```
UnexpectedUnicodeError -> AssertionError -> UnicodeError -> ValueError -> Exception -> BaseException -> object
```

`AssertionError` sits first as declared, so `str()`/`__init__` behaviour comes from the common base while both roles remain catchable. The measured matrix: `issubclass` is `True` for `AssertionError`, `UnicodeError`, `ValueError`, `Exception`; `False` for `OSError`, `KeyError`, `UnicodeDecodeError`, `UnicodeEncodeError`. Two consequences follow directly:

- It is reachable by generic handlers — `except AssertionError`, `except UnicodeError`, **and** `except ValueError` — so callers that treat value-domain errors generically still catch it, without Flask having to route it through its HTTP exception layer.
- It occupies the *generic* `UnicodeError` slot, not the concrete codec-error slots. Real `UnicodeDecodeError`/`UnicodeEncodeError` keep their own identity; this class cannot be confused with an actual codec failure.

## 3. The `AssertionError` base is the contract callers actually rely on
This is what makes the channel distinction real rather than cosmetic. `tests/test_basic.py:1707` catches `AssertionError` — not the concrete `FormDataRoutingRedirect` — for the routing-redirect debug case. And `tests/test_basic.py:610-612` documents that without `app.testing`, an `AssertionError` surfaces as a **500**, not a client error. So the inheritance says: in debug/testing this surfaces as a developer-facing assertion; in production it is a server-side failure. That is the opposite end of the architecture from a validation failure, which is a 4xx by design.

## 4. The class documents an intended boundary at a specific layer — and that boundary is now vestigial
Lineage (`git log -S`) shows the separation was originally *enforced at the serialization boundary*, not merely declared:

- **Introduced 2012-10-30** (`2b885ce4`, "Added better error reporting for unicode errors in sessions"): `flask/sessions.py`'s `TaggedJSONSerializer` did `except UnicodeError: raise UnexpectedUnicodeError('A byte string with non-ASCII data was passed to the session system …')`. The decision there was explicit: catch the stdlib codec failure where the raw bytes enter Flask's serializer, and re-raise it on the debug diagnostics channel with a better message.
- **Removed 2017-06-01** (`5e1ced3c`, serializer refactor): the `raise` block was deleted from `sessions.py`, but the class definition was kept (`git show 5e1ced3c:flask/debughelpers.py` still has it).

In the current worktree an exhaustive grep across `src/`, `tests/`, `docs/` and `CHANGES.rst` returns only the class statement — no raise site, no import, no test, no doc, no changelog entry. So the class now reflects a **declared but unreachable contract**: the architecture says encoding failures are reported through the assertion channel, but nothing in this tree exercises it. Meanwhile the live encoding/JSON failure path runs through the opposite route — `src/flask/wrappers.py:215-221` catches `BadRequest` and, in debug, re-raises it raw rather than converting it.

## 5. Contradiction and what is not established
There is a real tension to report rather than resolve: the class's inheritance states a clean encoding-vs-validation separation, but the code that would demonstrate it has been gone for years and current encoding paths use the HTTP layer. Whether keeping the dead class is **deliberate back-compat policy or an oversight** is a maintainer-intent question, and the evidence does not settle it. Also not established: any runtime behaviour of the class in a live debug path, because no live raise site exists here to exercise it. The architectural *intent* is legible from the class statement and its siblings; the architectural *practice* in this revision does not follow it.

---

**What this rests on:** `src/flask/debughelpers.py:17-20, 23, 50, 85-99` (read directly in this worktree); the exhaustive `UnexpectedUnicodeError` grep (single hit); the measured MRO/catchability matrix from the repo venv with `PYTHONPATH=src` (the venv's `flask.pth` points at another checkout's `src`, so `PYTHONPATH=src` was required for provenance); the git pickaxe lineage (introduction `2b885ce4` 2012-10-30, removal `5e1ced3c` 2017-06-01, class retained); the sibling wiring at `src/flask/app.py:492-504`, `src/flask/wrappers.py:200-221`, `src/flask/templating.py:83`; the HTTP layer at `src/flask/app.py:780-809`, `src/flask/sansio/app.py:848-881`, `src/flask/wrappers.py:215-221`; and `tests/test_basic.py:1707, 1106-1118, 610-612`.

**Still open:** maintainer intent for keeping the unreachable class (deliberate policy vs. oversight); and confirmation of which part of the original question counts as "answered" — the *architecture the inheritance encodes* is answered from the declaration plus its siblings and lineage, while any claim that Flask *currently* separates encoding from validation at runtime is contradicted by the removal of the only raise site.
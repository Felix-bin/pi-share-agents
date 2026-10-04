## Bottom line

**The question's premise does not survive the evidence.** The dual inheritance on `UnexpectedUnicodeError(AssertionError, UnicodeError)` (`src/flask/debughelpers.py:17`) does not encode a *separation* between validation failures and encoding issues, and in the current tree it encodes nothing operational at all: the class is **defined, never imported, never raised, never tested, never documented** (single grep hit for `UnexpectedUnicode` in the whole tree, and it is the class statement itself). Whatever decision the bases record is vestigial. What the bases *do* express, as an idiom with live siblings, is the opposite of separation — a deliberate **union of catch categories across a layer boundary**.

## What the dual inheritance mechanically means

- `AssertionError` and `UnicodeError` both derive directly from `Exception`, so the MRO is `UnexpectedUnicodeError → AssertionError → UnicodeError → Exception → BaseException → object`. Executed by the executor (runtime script, plus a re-run under `-O`): the class is caught by `except UnexpectedUnicodeError`, `except AssertionError`, `except UnicodeError` **and** `except Exception`.
- So the design intent readable off the type is a *compatibility bridge*: a debug-mode raise stays catchable both by code written for Flask's assertion-style debug failures and by code written for Python's native decoding failures. It is dual citizenship, not a taxonomy.
- The bridge is one-directional and purely for callers: I verified `src/flask` itself contains **no `except AssertionError` / `except UnicodeError`** anywhere, so within Flask the multi-base catch surface is never exercised. It only matters to user code.
- `-O` behaviour: the class is never used with a bare `assert` (zero hits), so it is not exposed to assertion stripping. For context, the debughelpers file does contain exactly one bare `assert` (`debughelpers.py:59`, inside `FormDataRoutingRedirect`), and bare asserts elsewhere (`app.py:268`, `views.py:190`, `sansio/scaffold.py:705`, `testing.py:59`) are `-O`-strippable, whereas `raise AssertionError(...)` sites (`ctx.py:268`, `ctx.py:429`, `sansio/app.py:415`, `sansio/app.py:657`, `sansio/blueprints.py:215`) are not.

## Separation vs. union: what the tree actually does

Flask's debug layer separates *two different things*, and the dual-base class sits ambiguously across both:

1. **"AssertionError" as "you (the developer) used the API wrong", debug-only.** Live instances: `FormDataRoutingRedirect(AssertionError)` raised at `app.py:504` behind an explicit `self.debug` gate; `DebugFilesKeyError(KeyError, AssertionError)` raised at `debughelpers.py:98` from `attach_enctype_error_multidict`, which *patches `request.files.__class__`* — a layer-crossing monkeypatch over the Werkzeug multidict.
2. **Encoding/binary data as a value, not an error.** The `TagBytes` tag (`json/tag.py:159-168`) base64-encodes `bytes` on the way out and decodes on the way in. I read it: `check()` is `isinstance(value, bytes)`, `to_json()` is `b64encode(value).decode("ascii")`. Bytes and binary payloads are *supported*, not rejected.

`UnexpectedUnicodeError` was the third thing: the case where raw bytes reach a text-only seam. Its docstring (`debughelpers.py:18-19`) is in the **present tense and stale** — it says "Raised in places where we want some better error reporting…", but there are no places. The census confirms the shape: there are exactly **2** multi-base exceptions in the tree, both in `debughelpers.py` (`UnexpectedUnicodeError`, `DebugFilesKeyError`), and it is the only one with no remaining raise site. The pattern "natural lower-layer error type + `AssertionError`, so the lower layer's failure stays catchable in its own terms while being Flask-typed" is real; the encoding instance of that pattern is retired.

## Historical resolution (SHA-attributed by the executor)

Introduced in `2b885ce4` (2012, same vintage as the docstring and the commit subject stating the intent), raise sites removed in `5e1ced3c`, superseded by `TagBytes`. The architectural decision Flask actually landed on for unexpected unicode/binary data was therefore **not** to partition validation failures from encoding issues, but to stop treating bytes as a failure in the JSON layer. The class was left behind unreferenced.

## Task coverage

**Answered:** the runtime semantics of the dual inheritance (MRO, full catch surface, `-O` non-exposure); its reachability status (dead, with a reproducible one-hit ledger); its relationship to the live debug-exception idiom and where those live raises occur; the historical arc with commits; the bytes/`.decode(` boundary inventory in `src/flask` (only `json/tag.py:167` decodes, and it is Flask's own base64, not untrusted input).

**Still open:** (a) *why* the specific pair was chosen — no in-tree or commit-message rationale exists, and upstream PR/issue text (#1452/#1438/#1908) is remote and was not fetched; (b) the exact original raise conditions at the removed call site — the removing/SHAs and the `TagBytes` replacement are established, but the pre-removal code's precise validation-vs-encoding semantics were not reproduced; (c) Werkzeug's decoding-site census (4 sites read, not exhaustive), so the claim "the lower layer surfaces native `UnicodeError`" is pattern-based, not a complete inventory.

## Rests on

`src/flask/debughelpers.py:17-19, 23, 50-59, 88-100`; `src/flask/app.py:490-504, 268`; `src/flask/json/tag.py:159-168`; `src/flask/ctx.py:262-270, 429`; `src/flask/sansio/app.py:415, 657`; `src/flask/sansio/blueprints.py:215`; executor runtime run (MRO/catch/`-O`) at HEAD `85c5d93` with the `.venv` flask pinned to this source tree; grep ledgers above. No prior shared-memory conclusion exists on this topic (two searches returned empty), so nothing here contradicts or retires an earlier record.
## Answer

The decorator is `copy_current_request_context` (`src/flask/ctx.py:155`, re-exported at `src/flask/__init__.py:6`). It achieves isolation between lightweight concurrent execution contexts (greenlets) by relying on `contextvars` rather than on any lock or on deep-copying state, and it deliberately *does not* isolate the session — carrying the same session object into the copy is exactly how session data survives the boundary.

**Capture happens at decoration time; one copy serves every call.** The decorator body is:

```python
ctx = _cv_request.get(None)                      # ctx.py:179
if ctx is None:
    raise RuntimeError("'copy_current_request_context' can only be used when a"
        " request context is active, such as in a view function.")   # :181-185
ctx = ctx.copy()                                 # :186
def wrapper(*args, **kwargs):
    with ctx:
        return ctx.app.ensure_sync(f)(*args, **kwargs)   # :188-190
return update_wrapper(wrapper, f)                # :192
```

Decorating outside an active request context raises immediately (confirmed at runtime by the executor, and matching the docstring `ctx.py:156-163`: "The moment the function is decorated a copy of the request context is created and then pushed when the function is called"). Exactly one `RequestContext` instance exists per decoration — there is no per-call copy, so a decorated function invoked twice pushes and pops the *same* object.

**Isolation of the concurrent context comes from `contextvars`, not from copying the binding.** `_cv_request` is a `contextvars.ContextVar[RequestContext]` (`src/flask/globals.py`). `push()` binds it with `self._cv_tokens.append((_cv_request.set(self), app_ctx))` (`ctx.py:382`); `pop()` undoes it with `_cv_request.reset(token)` (`ctx.py:421-424`). Because a `ContextVar.set` inside a greenlet writes into that greenlet's own execution context, the push performed in the greenlet never mutates the binding the originating execution context sees, and the `reset` restores the outer value. The executor measured this directly on this tree: after a greenlet ran the copy's push/pop, the outer context object was identical before and after (`outer ctx restored after greenlet : True`). The isolation is therefore **greenlet-scoped and not thread-safe** — the `copy()` docstring makes this explicit (`ctx.py:339-341`): "Because the actual request object is the same this cannot be used to move a request context to a different thread unless access to the request object is locked." Flask only documents the precondition, not the mechanism: greenlet>=1.0 is required "otherwise context locals such as `request` will not work as expected" (`installation.rst:51-56`, `docs/deploying/gevent.rst:27`, `docs/deploying/eventlet.rst:27`, `docs/deploying/gunicorn.rst:105-106`).

The app-context half is handled the same way in `push()`: if `_cv_app.get(None)` is `None` or belongs to another app, a **new** `AppContext` is created and pushed (`ctx.py:365-372`). Inside a greenlet that binding is absent, so `current_app` and `g` there come from a fresh app context, not from the original request's `g`.

**What `copy()` shares vs. regenerates** (`ctx.py:337-355`):

```python
return self.__class__(self.app, environ=self.request.environ,
                      request=self.request, session=self.session)
```

- **Shared:** `app`, the **same `request` object**, and the **same mutable session object**.
- **Fresh per copy**, because `__init__` (`ctx.py:310-333`) rebuilds them: `url_adapter` (recomputed by `app.create_url_adapter`), `flashes = None`, `_after_request_functions = []`, `_cv_tokens = []`.

The executor's identity checks on this tree match: `copy_is_new_ctx: True`, while `copy_request_same_obj`, `copy_session_same_obj` and `copy_app_same_obj` were all `True`, with `cv_tokens_len 1`, `flashes_is_none True`, `after_req_fns_empty True`.

**Session data crosses the boundary by shared reference.** Since `copy()` passes `session=self.session`, `push()`'s guard `if self.session is None:` (`ctx.py:384`) is false for the copy, so `session_interface.open_session` (which would re-read and deserialize the cookie) is skipped and the live in-memory session object is reused. This is intentional and versioned: `copy()`'s `versionchanged 1.1` note says "The current session object is used instead of reloading the original data. This prevents `flask.session` pointing to an out-of-date object" (`ctx.py:346-349`), corroborated by `CHANGES.rst:676-678` (`:issue:`2935``). The `push()` comment reinforces it: "Only open a new session if this is the first time the request was pushed, otherwise `stream_with_context` loses the session" (`ctx.py:385-387`). The executor observed a write made through the copy being visible on the original side (`original sees write from greenlet : 7`), and the in-tree test asserts `flask.session.get("fizz") == "buzz"` inside the greenlet after the view set it (`tests/test_reqctx.py:155,166` and `:186,195`).

Per-context caches are *not* shared even though the session is: `flashes` starts `None` on the copy, and `get_flashed_messages` caches into `request_ctx.flashes` while the backing store is the shared `session["_flashes"]` (`src/flask/helpers.py:333-335, 376-379`). So flashed data travels only through the session object.

**Re-entrancy of the single copy** is accounted for in `pop()` (`ctx.py:398-433`): `clear_request = len(self._cv_tokens) == 1`, so teardown (`do_teardown_request`) and `request.close()` run only on the last pop, and `raise AssertionError(f"Popped wrong request context. ...")` guards mismatched pops. That is what lets one shared copy be pushed more than once.

### Verification status and open points

- The two tests covering this path (`tests/test_reqctx.py:150-177` and `:179-202`, class guarded by `@pytest.mark.skipif(greenlet is None, ...)` at `:148-149`) both run the greenlet *after* `client.get("/")` returned (`:173-176`, `:198-201`), i.e. after the original context was popped. Their `assert not flask.request` lines therefore do not by themselves prove isolation *while* an outer context is live; they show push-then-restore within the greenlet. Runtime isolation-while-live was supplied by the executor's inline check instead, not by in-tree tests.
- Environment caveat: `.venv/Lib/site-packages/flask.pth` points at a sibling tree's `src` and this worktree has no top-level `flask` package, so a bare `python -m pytest` imports another tree and establishes nothing here. With `PYTHONPATH=<worktree>/src` (verified to resolve `flask` to `src/flask/__init__.py`), `pytest tests/test_reqctx.py -k greenlet -x -rA` gave `2 passed, 12 deselected in 0.07s` with greenlet 3.2.3 present (so the class ran, not skipped), and the whole file gave `14 passed in 0.14s`.
- **Not established:** behaviour under genuinely concurrent/racing greenlets sharing one decorated function. All runs (in-tree and this session's) are sequential, and no in-tree test invokes a single decorated function concurrently. The consequence — that concurrent calls share the copy's `_cv_tokens`, `flashes` and `_after_request_functions`, and that no lock exists in `src/flask/ctx.py` — is inference from the closure over a single `ctx`, not an observation. Thread-safety beyond the `copy()` docstring warning is likewise untested.
- Related limitation worth stating with the session claim: `save_session` runs only in `process_response` (`src/flask/app.py:1322`), so session mutations made inside a copy after the response is finalized are not persisted, even though they are visible in-process on the shared object.
- `stream_with_context` (`src/flask/helpers.py:108-116`) is a distinct path — it does `with ctx:` on the *current* context without `.copy()` — and is the subject of the "loses the session" comment in `push()`, not this decorator.

So: the part of the task about *how isolation is achieved* is answered (contextvars bindings are per execution context; the copy's `request`/`session`/`app` are shared objects and only the binding is scoped; greenlet-scoped, explicitly not thread-safe). The part about *session preservation* is answered (`copy(session=self.session)` plus the `if self.session is None` guard in `push()`). What remains open is the concurrency stress case and any thread-safety guarantee beyond the docstring warning.
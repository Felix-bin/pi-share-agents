# How the unhandled-exception path chooses between re-raising and an HTTP 500

The method is `Flask.handle_exception`, defined at `src/flask/app.py:811` (`def handle_exception(self, e: Exception) -> Response:`, span 811–862). Its docstring states both properties in question: it handles "an exception that did not have an error handler associated with it, or that was raised from an error handler. This always causes a 500 `InternalServerError`", and "If :data:`PROPAGATE_EXCEPTIONS` is ``True``, such as in debug mode, the error will be re-raised so that the debugger can display it. Otherwise, the original exception is logged, and an :exc:`~werkzeug.exceptions.InternalServerError` is returned."

The determination happens in a single straight-line block. First the config value is read and, only if it is unset, replaced by the testing/debug state; then the resulting boolean picks exactly one of two continuations:

```
839:         exc_info = sys.exc_info()
840:         got_request_exception.send(self, _async_wrapper=self.ensure_sync, exception=e)
841:         propagate = self.config["PROPAGATE_EXCEPTIONS"]
842:
843:         if propagate is None:
844:             propagate = self.testing or self.debug
845:
846:         if propagate:
847:             # Re-raise if called with an active exception, otherwise
848:             # raise the passed in exception.
849:             if exc_info[1] is e:
850:                 raise
851:
852:             raise e
853:
854:         self.log_exception(exc_info)
855:         server_error: InternalServerError | ft.ResponseReturnValue
856:         server_error = InternalServerError(original_exception=e)
857:         handler = self._find_error_handler(server_error, request.blueprints)
858:
859:         if handler is not None:
860:             server_error = self.ensure_sync(handler)(server_error)
861:
862:         return self.finalize_request(server_error, from_error_handler=True)
```

Ordered, branch by branch:

1. **Read the explicit setting.** `propagate = self.config["PROPAGATE_EXCEPTIONS"]` (:841). The `got_request_exception` signal is sent just before this (:840), so it fires on both outcomes.
2. **Default substitution when unset.** `if propagate is None: propagate = self.testing or self.debug` (:843–844). `None` — not falsy in general — is the sentinel for "not configured"; only in that case are the two mode flags consulted. Either flag being truthy makes `propagate` truthy.
3. **Truthy → re-raise to the caller.** (:846–852.) The docstring ties this to the debugger seeing the error. Which statement runs depends on the call context: if the currently active exception (`sys.exc_info()` captured at :839) is the same object as the passed-in `e`, a bare `raise` at :850 re-raises it with its existing traceback; otherwise `raise e` at :852 raises the argument. So when `handle_exception` is invoked from inside an `except` block for the same exception, traceback fidelity is preserved.
4. **Falsy → log and return a 500 response.** (:854–862.) `self.log_exception(exc_info)` (:854) records it; the exception is wrapped as `InternalServerError(original_exception=e)` (:856), which is what makes the original error available to a handler/docstring consumers; a registered `InternalServerError`/`500` handler, if any, is resolved with `_find_error_handler` (:857) and applied sync-safely (:859–860), replacing the default error object; finally `self.finalize_request(server_error, from_error_handler=True)` (:862) turns it into the response, with `from_error_handler=True` so that request finalization (e.g. `after_request` functions) still runs. The `server_error` annotation at :855 (`InternalServerError | ft.ResponseReturnValue`) reflects that a handler may return something other than an error object.

## The three configuration inputs it reads

- **`PROPAGATE_EXCEPTIONS`** — default `None` in `Flask.default_config`: `"PROPAGATE_EXCEPTIONS": None` (`src/flask/app.py:182`). Documented at `docs/config.rst:88–94`: "Exceptions are re-raised rather than being handled by the app's error handlers. If not set, this is implicitly true if ``TESTING`` or ``DEBUG`` is enabled." with "Default: ``None``" at :94. The documented default and the code default agree.
- **`testing`** — `testing = ConfigAttribute[bool]("TESTING")` (`src/flask/sansio/app.py:208`; docstring at :197–207 says: "If this is enabled and PROPAGATE_EXCEPTIONS is not changed from the default it's implicitly enabled"). Underlying default `"TESTING": False` (`src/flask/app.py:181`), documented as `Default: ``False``` (`docs/config.rst:80–86`). So `self.testing` is a config read, not an independent attribute.
- **`debug`** — a property, not stored state: `@property def debug(self) -> bool` at `src/flask/sansio/app.py:550–558`, whose body is `return self.config["DEBUG"]`; the setter at :562–567 writes `self.config["DEBUG"]` (and syncs `TEMPLATES_AUTO_RELOAD`). So `self.debug` also resolves to config.

**Interaction, stated explicitly:** an explicit `PROPAGATE_EXCEPTIONS` value wins outright and short-circuits the mode flags entirely; `testing` and `debug` are consulted only when it is `None`, and they are OR-ed, so either alone enables propagation. Consequently, with shipped defaults, the effective behaviour is `PROPAGATE_EXCEPTIONS == TESTING or DEBUG`: default `False or False` → falsy → log + HTTP 500, whereas enabling either `TESTING` or `DEBUG` (or setting `PROPAGATE_EXCEPTIONS = True` directly) flips to re-raise. This matches the docstring's "such as in debug mode" and the `PROPAGATE_EXCEPTIONS` docs quoted above. (That equivalence is a derivation from the quoted lines plus the defaults, not a single line of source.)

## Discrepancy worth recording

The literal default of `DEBUG` is documented as `False` — `docs/config.rst:78` ("Default: ``False``") and the `debug` property's own docstring (`src/flask/sansio/app.py:557`, "Default: ``False``") — but the code default is `"DEBUG": None` (`src/flask/app.py:180`). Both are falsy, so this branch behaves identically either way; the contradiction matters only because `handle_exception` reads `self.debug` directly from config (:844). `TESTING` (`False`) and `PROPAGATE_EXCEPTIONS` (`None`) have matching code and documented defaults.

## Status of the question

- **Answered:** which method it is (`Flask.handle_exception`, `src/flask/app.py:811–862`), the full ordered determination, every branch condition tied to a quoted line, the source and default of all three configuration inputs, and their interaction.
- **Open / deliberately not settled:** the true intent of the `DEBUG` `None`-vs-`False` mismatch is not resolvable from the code alone; and no behaviour is claimed for Flask versions other than this worktree. The adjacent `handle_user_exception` / `trap_http_exception` re-raise paths were out of scope — they deal with `HTTPException`s that have handlers and do not read `PROPAGATE_EXCEPTIONS`.
- **Provenance of the run:** this was planned as a simple task, so the executor stage was skipped; the conclusion rests on the retriever's bodies plus direct re-verification of `src/flask/app.py:811–862` and :180–182, `src/flask/sansio/app.py:197–208` and :550–567, and `docs/config.rst:68–94`. No executed test run backs it — it is a source-reading result.
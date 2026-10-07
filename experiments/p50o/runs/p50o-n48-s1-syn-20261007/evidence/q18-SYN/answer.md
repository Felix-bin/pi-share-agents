## How unhandled exceptions decide between re-raise and HTTP 500

The method is `App.handle_exception(self, e)` at `src/flask/app.py:811` (called from `wsgi_app`'s `except Exception as e:` block at line 1514 for any exception escaping `full_dispatch_request()`). Its decision is a single ordered procedure:

1. **Capture and always signal first.** `exc_info = sys.exc_info()` (line 839), then unconditionally `got_request_exception.send(self, _async_wrapper=self.ensure_sync, exception=e)` (line 840). This happens before the configuration check, so the signal fires on both branches.
2. **Read the configuration value.** `propagate = self.config["PROPAGATE_EXCEPTIONS"]` (line 841).
3. **Resolve `None` by fallback.** `if propagate is None: propagate = self.testing or self.debug` (lines 843–844). `testing` is a `ConfigAttribute` bound to the `TESTING` key (`src/flask/sansio/app.py:208`) and `debug` is a property returning `self.config["DEBUG"]` (`src/flask/sansio/app.py:550-560`). So an unset `PROPAGATE_EXCEPTIONS` inherits the effective TESTING/DEBUG state.
4. **Truthy `propagate` → re-raise.** Lines 846–851: `if exc_info[1] is e: raise` (re-raise with the live traceback when `e` is the active exception), otherwise `raise e`. This lets the debugger / error page surface the original exception instead of a 500.
5. **Falsy `propagate` → convert to 500.** Lines 853–861: `self.log_exception(exc_info)`; `server_error = InternalServerError(original_exception=e)`; look up `self._find_error_handler(server_error, request.blueprints)`; if found, `server_error = self.ensure_sync(handler)(server_error)`; then `return self.finalize_request(server_error, from_error_handler=True)`. The handler (registered for `InternalServerError` or `500`) always receives the `InternalServerError`, with the original exception on `.original_exception`.

**Which configuration states force which branch.** The defaults in `default_config` (`src/flask/app.py:180-182`) are `"DEBUG": None`, `"TESTING": False`, `"PROPAGATE_EXCEPTIONS": None`. Because `PROPAGATE_EXCEPTIONS` defaults to `None`, the out-of-the-box path is the fallback `self.testing or self.debug`:

- `PROPAGATE_EXCEPTIONS` explicitly truthy → re-raise, regardless of `TESTING`/`DEBUG`.
- `PROPAGATE_EXCEPTIONS` explicitly falsy → 500, regardless of `TESTING`/`DEBUG`.
- `PROPAGATE_EXCEPTIONS` left as `None` (the default) → re-raise iff `TESTING` is truthy **or** `DEBUG` is truthy; otherwise 500. With all defaults intact (`TESTING=False`, `DEBUG=None` → falsy), the result is the 500 branch.

This matches the method's own docstring (lines 811–815, 818–820): "This always causes a 500 `InternalServerError`" for the non-propagating case, and re-raising "such as in debug mode … so that the debugger can display it" when `PROPAGATE_EXCEPTIONS` is `True`.

**Reading used.** "Configuration state" is taken as the runtime values of `self.config["PROPAGATE_EXCEPTIONS"]`, `TESTING` and `DEBUG` (including the `None` fallback and the derived `testing`/`debug` attributes), because the decision in the method body is implemented entirely from those values. External settings that feed those keys (CLI, environment, `app.testing`/`app.debug` assignment) are outside the method and were not part of the decision.

### What this rests on / what remains open
- Rests on: `handle_exception` body `src/flask/app.py:811-861` (verified verbatim, including signal at 840, config read at 841, `None` fallback 843–844, re-raise 846–851, 500 path 853–861); default config `src/flask/app.py:180-182`; `testing`/`debug` mappings `src/flask/sansio/app.py:208` and `550-560`; call site `wsgi_app` at `src/flask/app.py:1514`.
- Adjacent but not this decision: `handle_user_exception` (`src/flask/app.py:779`) decides dispatch-to-handler vs raise for *handled* exceptions and does not convert to 500 — correctly excluded as a candidate.
- Still open (not needed for this answer): how `PROPAGATE_EXCEPTIONS`/`TESTING`/`DEBUG` get set outside the app object (environment, CLI flags, `app.config` mutation), and the actual runtime values in any particular deployment.
- Path note: the ranking cited `flask/src/flask/app.py`, but in this worktree the file is `src/flask/app.py` at the repository root; the cited line regions align, so this is a path-prefix discrepancy, not a content contradiction.
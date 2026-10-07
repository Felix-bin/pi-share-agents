All decisive anchors verified against the working tree. Composing the final answer.

---

# How `Flask.handle_exception` decides: re-raise vs. HTTP 500

## Answer in one paragraph

The method is **`Flask.handle_exception`** (`src/flask/app.py:811`). It reads exactly one piece of configuration state — `self.config["PROPAGATE_EXCEPTIONS"]` (line 841) — and, if that value is `None` (the shipped default), falls back to `self.testing or self.debug` (lines 843–844). If the resulting value is truthy it re-raises the exception (`raise` at 850 when there is a live exception, otherwise `raise e` at 852) and builds no response; if it is falsy it logs the exception, wraps it in `InternalServerError(original_exception=e)`, runs any registered 500/`InternalServerError` handler on that wrapper, and finalizes it with `from_error_handler=True`, producing an HTTP 500. So the precedence is: **an explicit `PROPAGATE_EXCEPTIONS` value always wins; `None` defers to `TESTING or DEBUG`; otherwise the 500 path is taken.** `got_request_exception` is sent unconditionally before the branch (line 840).

---

## 1. The method, in full

`src/flask/app.py:811–862` (verified: `def handle_exception(self, e: Exception) -> Response:` is at line 811; the executable body begins at line 839):

```python
811	    def handle_exception(self, e: Exception) -> Response:
812	        """Handle an exception that did not have an error handler
813	        associated with it, or that was raised from an error handler.
814	        This always causes a 500 ``InternalServerError``.
815	
816	        Always sends the :data:`got_request_exception` signal.
817	
818	        If :data:`PROPAGATE_EXCEPTIONS` is ``True``, such as in debug
819	        mode, the error will be re-raised so that the debugger can
820	        display it. Otherwise, the original exception is logged, and
821	        an :exc:`~werkzeug.exceptions.InternalServerError` is returned.
822	
823	        If an error handler is registered for ``InternalServerError`` or
824	        ``500``, it will be used. For consistency, the handler will
825	        always receive the ``InternalServerError``. The original
826	        unhandled exception is available as ``e.original_exception``.
827	
828	        .. versionchanged:: 1.1.0
829	            Always passes the ``InternalServerError`` instance to the
830	            handler, setting ``original_exception`` to the unhandled
831	            error.
832	
833	        .. versionchanged:: 1.1.0
834	            ``after_request`` functions and other finalization is done
835	            even for the default 500 response when there is no handler.
836	
837	        .. versionadded:: 0.3
838	        """
839	        exc_info = sys.exc_info()
840	        got_request_exception.send(self, _async_wrapper=self.ensure_sync, exception=e)
841	        propagate = self.config["PROPAGATE_EXCEPTIONS"]
842	
843	        if propagate is None:
844	            propagate = self.testing or self.debug
845	
846	        if propagate:
847	            # Re-raise if called with an active exception, otherwise
848	            # raise the passed in exception.
849	            if exc_info[1] is e:
850	                raise
851	
852	            raise e
853	
854	        self.log_exception(exc_info)
855	        server_error: InternalServerError | ft.ResponseReturnValue
856	        server_error = InternalServerError(original_exception=e)
857	        handler = self._find_error_handler(server_error, request.blueprints)
858	
859	        if handler is not None:
860	            server_error = self.ensure_sync(handler)(server_error)
861	
862	        return self.finalize_request(server_error, from_error_handler=True)
```

Note the ordering: `sys.exc_info()` is captured **first** (839), before any other call, so the correct traceback is available for both the re-raise decision (849) and the logging call (854).

---

## 2. The decision, line by line

**Step 1 — read config (841).** `propagate = self.config["PROPAGATE_EXCEPTIONS"]`. This is the only read of that key anywhere in `src/`; the executor's grep confirms it:

```
$ grep -rn "PROPAGATE_EXCEPTIONS" src/
src/flask/app.py:182:            "PROPAGATE_EXCEPTIONS": None,
src/flask/app.py:818:        If :data:`PROPAGATE_EXCEPTIONS` is ``True``, such as in debug
src/flask/app.py:841:        propagate = self.config["PROPAGATE_EXCEPTIONS"]
src/flask/sansio/app.py:203:    #: If this is enabled and PROPAGATE_EXCEPTIONS is not changed from the
Binary file src/flask/__pycache__/app.cpython-311.pyc matches
... (5 more .pyc hits)
```
exit 0 — only 841 is a *read*; 182 is the default, 818 a docstring, `sansio/app.py:203` a comment.

**Step 2 — the `None` fallback (843–844).** `if propagate is None: propagate = self.testing or self.debug`. Because the test is `is None`, not falsiness, an explicit `False` is *not* replaced by the fallback: `False` short-circuits the fallback entirely and forces the 500 path even when `TESTING`/`DEBUG` are on.

**Step 3 — the branch (846).** `if propagate:` — an ordinary truthiness test on the (possibly substituted) value.

---

## 3. The configuration state it reads

**`PROPAGATE_EXCEPTIONS` default** — `src/flask/app.py:182`, inside `default_config`:

```python
178	    default_config = ImmutableDict(
179	        {
180	            "DEBUG": None,
181	            "TESTING": False,
182	            "PROPAGATE_EXCEPTIONS": None,
```

**`self.testing`** — `src/flask/sansio/app.py`, declaration at line 208 (comment block 195–207; grep anchor confirms `sansio/app.py:208`):

```python
195	    #: The testing flag.  Set this to ``True`` to enable the test mode of
196	    #: Flask extensions (and in the future probably also Flask itself).
197	    #: For example this might activate test helpers that have an
198	    #: additional runtime cost which should not be enabled by default.
199	    #:
200	    #: If this is enabled and PROPAGATE_EXCEPTIONS is not changed from the
201	    #: default it's implicitly enabled.
202	    #:
203	    #: This attribute can also be configured from the config with the
204	    #: ``TESTING`` configuration key.  Defaults to ``False``.
205	    testing = ConfigAttribute[bool]("TESTING")
```
(Line 205 in this excerpt is the declaration at absolute line 208 per grep; the excerpt's window starts at 195 in the evidence read.)

**`self.debug`** — `src/flask/sansio/app.py:549–568`:

```python
549	    @property
550	    def debug(self) -> bool:
551	        """Whether debug mode is enabled. When using ``flask run`` to start the
552	        development server, an interactive debugger will be shown for unhandled
553	        exceptions, and the server will be reloaded when code changes. This maps to the
554	        :data:`DEBUG` config key. It may not behave as expected if set late.
555	
556	        **Do not enable debug mode when deploying in production.**
557	
558	        Default: ``False``
559	        """
560	        return self.config["DEBUG"]  # type: ignore[no-any-return]
561	
562	    @debug.setter
563	    def debug(self, value: bool) -> None:
564	        self.config["DEBUG"] = value
565	
566	        if self.config["TEMPLATES_AUTO_RELOAD"] is None:
567	            self.jinja_env.auto_reload = value
```

**Why `self.testing` is literally `config["TESTING"]`** — `ConfigAttribute`, `src/flask/config.py:20–47`:

```python
20	class ConfigAttribute(t.Generic[T]):
21	    """Makes an attribute forward to the config"""
22	
23	    def __init__(
24	        self, name: str, get_converter: t.Callable[[t.Any], T] | None = None
25	    ) -> None:
26	        self.__name__ = name
27	        self.get_converter = get_converter
...
35	    def __get__(self, obj: App | None, owner: type[App] | None = None) -> T | te.Self:
36	        if obj is None:
37	            return self
38	
39	        rv = obj.config[self.__name__]
40	
41	        if self.get_converter is not None:
42	            rv = self.get_converter(rv)
43	
44	        return rv  # type: ignore[no-any-return]
45
46	    def __set__(self, obj: App, value: t.Any) -> None:
47	        obj.config[self.__name__] = value
```

So line 844's `self.testing or self.debug` is exactly `config["TESTING"] or config["DEBUG"]`.

---

## 4. The two re-raise forms (849–852)

* `if exc_info[1] is e: raise` (849–850) — a bare `raise`, taken when `handle_exception` is called *with an active exception*, which is the normal path from `wsgi_app`. It re-raises the same object with its original traceback.
* `raise e` (852) — taken when no exception is active (e.g. `handle_exception` called directly, or from an error handler that is not itself inside an `except` block). It re-raises the passed object but appends the frame at line 852.

The executor measured both forms directly:

```
A1 identity: True
   A1 frame[0]: <stdin> line 11 func <module>
   A1 frame[1]: C:\...\q2-TXT\seal\src\flask\app.py line 852 func handle_exception
A2 identity: True
   A2 frame[0]: <stdin> line 23 func <module>
   A2 frame[1]: <stdin> line 20 func <module>
```
exit 0 — "the `raise e` at line 852 is the one taken when there is no live exception (frame at `app.py:852`); with a live exception the bare `raise` path is taken and the original traceback is preserved."

And in the real `wsgi_app` path, the bare-raise branch is the one that fires — the re-raise line does **not** appear in the traceback:

```
   frame[7]: src/flask/app.py line 1514 func wsgi_app
   frame[8]: src/flask/app.py line 1511 func wsgi_app
   frame[9]: src/flask/app.py line 919 func full_dispatch_request
   frame[10]: src/flask/app.py line 917 func full_dispatch_request
   frame[11]: src/flask/app.py line 902 func dispatch_request
   frame[12]: <stdin> line 10 func index
   -> app.py line 852 (`raise e`) present: False
   -> app.py line 850 (bare `raise`) present: False
=== sys.exc_info() capture position: exc_info[1] is e when called from wsgi_app ===
observed: {'exc_info_type': <class 'ValueError'>, 'exc_info_is_e': True, 'exc_info_value_repr': "ValueError('active-check')"}
=> exc_info[1] is e -> True (so the bare `raise` at app.py:850 is taken, not `raise e` at 852)
```
exit 0.

Nothing is logged and no `InternalServerError` is constructed on this branch — the `if propagate:` block exits via `raise`, so lines 854–862 are unreachable.

---

## 5. The 500 branch (854–862)

```python
854	        self.log_exception(exc_info)
855	        server_error: InternalServerError | ft.ResponseReturnValue
856	        server_error = InternalServerError(original_exception=e)
857	        handler = self._find_error_handler(server_error, request.blueprints)
858	
859	        if handler is not None:
860	            server_error = self.ensure_sync(handler)(server_error)
861	
862	        return self.finalize_request(server_error, from_error_handler=True)
```

`log_exception` (`app.py:864–877`):

```python
864	    def log_exception(
865	        self,
866	        exc_info: (tuple[type, BaseException, TracebackType] | tuple[None, None, None]),
867	    ) -> None:
868	        """Logs an exception.  This is called by :meth:`handle_exception`
869	        if debugging is disabled and right before the handler is called.
870	        The default implementation logs the exception as error on the
871	        :attr:`logger`.
872	
873	        .. versionadded:: 0.8
874	        """
875	        self.logger.error(
876	            f"Exception on {request.path} [{request.method}]", exc_info=exc_info
877	        )
```

(Note the docstring says "if debugging is disabled"; the actual condition is `not propagate`, which is also false when `TESTING` turns propagation on.)

`finalize_request` with `from_error_handler=True` (`app.py:922–951`) — the safety valve that prevents an infinite loop if response processing itself fails while handling an error:

```python
922	    def finalize_request(
923	        self,
924	        rv: ft.ResponseReturnValue | HTTPException,
925	        from_error_handler: bool = False,
926	    ) -> Response:
...
932	        Because this means that it might be called as a result of a
933	        failure a special safe mode is available which can be enabled
934	        with the `from_error_handler` flag.  If enabled, failures in
935	        response processing will be logged and otherwise ignored.
936	
937	        :internal:
938	        """
939	        response = self.make_response(rv)
940	        try:
941	            response = self.process_response(response)
942	            request_finished.send(
943	                self, _async_wrapper=self.ensure_sync, response=response
944	            )
945	        except Exception:
946	            if not from_error_handler:
947	                raise
948	            self.logger.exception(
949	                "Request finalizing failed with an error while handling an error"
950	            )
951	        return response
```

The executor observed the whole branch end-to-end:

```
C: status: 500 body: b'custom 500 body'
C: recorded: [('handler', 'InternalServerError', 'ZeroDivisionError'), ('after_request', 500)]
```
exit 0 — "matches `app.py:854–862`: `log_exception`, `InternalServerError(original_exception=e)`, handler receives the `InternalServerError`, then `finalize_request(..., from_error_handler=True)` still runs `after_request`"; and the swallow path:

```
ERROR in app: Request finalizing failed with an error while handling an error
Traceback (most recent call last):
  ...
  File "C:\...\src\flask\app.py", line 941, in finalize_request
    response = self.process_response(response)
  File "C:\...\src\flask\app.py", line 1319, in process_response
    response = self.ensure_sync(func)(response)
  File "<stdin>", line 84, in bad_after
RuntimeError: after_request blew up while handling the 500
```

---

## 6. The always-fired signal (840)

`got_request_exception.send(self, _async_wrapper=self.ensure_sync, exception=e)` is line 840 — **before** the branch, so it fires on both paths. The executor's re-run (after fixing a weak-reference bug in an earlier attempt) shows:

```
B: PROPAGATE_EXCEPTIONS=True -> re-raised; got_request_exception fired 1x -> [('RuntimeError', 'sig')]
B: PROPAGATE_EXCEPTIONS=False -> 500-response; got_request_exception fired 1x -> [('RuntimeError', 'sig')]
B: PROPAGATE_EXCEPTIONS=None -> 500-response; got_request_exception fired 1x -> [('RuntimeError', 'sig')]
```
exit 0.

This matches the documented contract, `docs/api.rst:402–414`:

```rst
.. data:: got_request_exception

    This signal is sent when an unhandled exception happens during
    request processing, including when debugging. The exception is
    passed to the subscriber as ``exception``.

    This signal is not sent for
    :exc:`~werkzeug.exceptions.HTTPException`, or other exceptions that
    have error handlers registered, unless the exception was raised from
    an error handler.
```

---

## 7. How an exception gets here (the call chain)

`wsgi_app` (`src/flask/app.py:1479–1527`; the call to `handle_exception` is at **1514**):

```python
1506	        ctx = self.request_context(environ)
1507	        error: BaseException | None = None
1508	        try:
1509	            try:
1510	                ctx.push()
1511	                response = self.full_dispatch_request()
1512	            except Exception as e:
1513	                error = e
1514	                response = self.handle_exception(e)
1515	            except:  # noqa: B001
1516	                error = sys.exc_info()[1]
1517	                raise
1518	            return response(environ, start_response)
1519	        finally:
1520	            if "werkzeug.debug.preserve_context" in environ:
1521	                environ["werkzeug.debug.preserve_context"](_cv_app.get())
1522	                environ["werkzeug.debug.preserve_context"](_cv_request.get())
1523	
1524	            if error is not None and self.should_ignore_error(error):
1525	                error = None
1526	
1527	            ctx.pop(error)
```

`full_dispatch_request` (`src/flask/app.py:904–920`) hands exceptions to `handle_user_exception`:

```python
904	    def full_dispatch_request(self) -> Response:
...
911	        self._got_first_request = True
912	
913	        try:
914	            request_started.send(self, _async_wrapper=self.ensure_sync)
915	            rv = self.preprocess_request()
916	            if rv is None:
917	                rv = self.dispatch_request()
918	        except Exception as e:
919	            rv = self.handle_user_exception(e)
920	        return self.finalize_request(rv)
```

`handle_user_exception` (`src/flask/app.py:779–809`) — the bare `raise` at **807** is what makes an exception "unhandled" and sends it on to `handle_exception`:

```python
779	    def handle_user_exception(
780	        self, e: Exception
781	    ) -> HTTPException | ft.ResponseReturnValue:
782	        """This method is called whenever an exception occurs that
783	        should be handled. A special case is :class:`~werkzeug
784	        .exceptions.HTTPException` which is forwarded to the
785	        :meth:`handle_http_exception` method. This function will either
786	        return a response value or reraise the exception with the same
787	        traceback.
788	
789	        .. versionchanged:: 1.0
790	            Key errors raised from request data like ``form`` show the
791	            bad key in debug mode rather than a generic bad request
792	            message.
793	
794	        .. versionadded:: 0.7
795	        """
796	        if isinstance(e, BadRequestKeyError) and (
797	            self.debug or self.config["TRAP_BAD_REQUEST_ERRORS"]
798	        ):
799	            e.show_exception = True
800	
801	        if isinstance(e, HTTPException) and not self.trap_http_exception(e):
802	            return self.handle_http_exception(e)
803	
804	        handler = self._find_error_handler(e, request.blueprints)
805	
806	        if handler is None:
807	            raise
808	
809	        return self.ensure_sync(handler)(e)  # type: ignore[no-any-return]
```

**Important attribution:** `handle_user_exception` decides on *whether an error handler exists* — not on `PROPAGATE_EXCEPTIONS`. Its `raise` at 807 is unconditional; the config-driven re-raise-vs-500 decision belongs exclusively to `handle_exception` at 841/843–844/846. Its sibling `handle_http_exception` (`app.py:744–775`) likewise returns the `HTTPException` unchanged when no handler is found rather than consulting config.

The execution trace confirms exactly this chain (`wsgi_app:1511 → full_dispatch_request:919 → full_dispatch_request:917 → dispatch_request:902 → view`) and that line 1514 is the invocation site.

---

## 8. Empirical confirmation: the four cases

The parametrized test that pins the tri-state behaviour, `tests/test_basic.py:1581–1595`:

```python
1581	@pytest.mark.parametrize("key", ["TESTING", "PROPAGATE_EXCEPTIONS", "DEBUG", None])
1582	def test_exception_propagation(app, client, key):
1583	    app.testing = False
1584	
1585	    @app.route("/")
1586	    def index():
1587	        raise ZeroDivisionError
1588	
1589	    if key is not None:
1590	        app.config[key] = True
1591	
1592	        with pytest.raises(ZeroDivisionError):
1593	            client.get("/")
1594	    else:
1595	        assert client.get("/").status_code == 500
```

(The `app` fixture in `tests/conftest.py` sets `TESTING=True` by default — `app.config.update(TESTING=True, SECRET_KEY="test key")` — which line 1583 immediately overrides; that override is what makes the `None` case meaningful.)

Focused run:

```
$ PYTHONPATH=... ./.venv/Scripts/python.exe -m pytest tests/test_basic.py -k test_exception_propagation -q
....                                                                     [100%]
4 passed, 126 deselected in 0.11s
EXIT=0
```

Verbose run confirming `PYTHONPYCACHEPREFIX` forced recompilation from the working-directory sources:

```
tests/test_basic.py::test_exception_propagation[TESTING] PASSED          [ 25%]
tests/test_basic.py::test_exception_propagation[PROPAGATE_EXCEPTIONS] PASSED [ 50%]
tests/test_basic.py::test_exception_propagation[DEBUG] PASSED            [ 75%]
tests/test_basic.py::test_exception_propagation[None] PASSED             [100%]

====================== 4 passed, 126 deselected in 0.40s ======================
```
exit 0.

Direct runtime probing of every branch combination (app + view raising `ZeroDivisionError`, `GET "/"`):

```
--- Case 1: PROPAGATE_EXCEPTIONS=True ---
case1: RAISED ZeroDivisionError(ZeroDivisionError('boom')) propagate_cfg=True TESTING=False DEBUG=False

--- Case 1b: PROPAGATE_EXCEPTIONS=True with TESTING=False DEBUG=False ---
case1b: RAISED ZeroDivisionError(ZeroDivisionError('boom')) propagate_cfg=True TESTING=False DEBUG=False

--- Case 2: PROPAGATE_EXCEPTIONS=False, TESTING=True, DEBUG=True (explicit False must override) ---
case2: RESPONSE status=500 data=b'<!doctype html>\n<html lang=en>\n<title>50' propagate_cfg=False TESTING=True DEBUG=True

--- Case 2b: PROPAGATE_EXCEPTIONS=False only ---
case2b: RESPONSE status=500 data=b'<!doctype html>\n<html lang=en>\n<title>50' propagate_cfg=False TESTING=False DEBUG=False

--- Case 3a: PROPAGATE_EXCEPTIONS=None (default) + TESTING=True ---
case3a: RAISED ZeroDivisionError(ZeroDivisionError('boom')) propagate_cfg=None TESTING=True DEBUG=False

--- Case 3b: PROPAGATE_EXCEPTIONS=None (default) + DEBUG=True ---
case3b: RAISED ZeroDivisionError(ZeroDivisionError('boom')) propagate_cfg=None TESTING=False DEBUG=True

--- Case 4: PROPAGATE_EXCEPTIONS=None + TESTING=False + DEBUG=False ---
case4: RESPONSE status=500 data=b'<!doctype html>\n<html lang=en>\n<title>50' propagate_cfg=None TESTING=False DEBUG=False

--- Case 5: no explicit config at all (all defaults) ---
case5: default config -> {'PROPAGATE_EXCEPTIONS': None, 'TESTING': False, 'DEBUG': False} status 500 b'<!doctype html>\n<html lang=en>\n<title>50'
```
exit 0 — "All four plan cases confirmed by observed behaviour, plus case 2 (explicit `False` wins over `TESTING=True, DEBUG=True`) and case 5 (all-defaults → 500)."

And the runtime values that resolve the `"DEBUG": None` literal:

```
fresh app config defaults:
   config['DEBUG'] = False
   config['TESTING'] = False
   config['PROPAGATE_EXCEPTIONS'] = None
app.debug  = False   (property -> config['DEBUG'])
app.testing = False   (ConfigAttribute -> config['TESTING'])

docs/config.rst says DEBUG 'Default: False' but default_config has 'DEBUG': None -> MISMATCH (None is falsy, so behaviourally equivalent to False, but the literal default value differs)

explicit False with TESTING=True DEBUG=True -> effective propagate = False
PROPAGATE_EXCEPTIONS left at None with TESTING=True DEBUG=True -> effective propagate = True
```
exit 0. (Explanation: `make_config` overrides the literal — `src/flask/sansio/app.py:494–495`: `defaults = dict(self.default_config)` / `defaults["DEBUG"] = get_debug_flag()`.)

### Truth table

| `PROPAGATE_EXCEPTIONS` | `TESTING` | `DEBUG` | effective `propagate` | outcome |
|---|---|---|---|---|
| `True` | any | any | `True` | re-raise (`raise` at 850 from `wsgi_app`) |
| `False` | True | True | `False` | HTTP 500 (854–862) |
| `None` | `True` | any | `True` | re-raise |
| `None` | any | `True` | `True` | re-raise |
| `None` | `False` | `False` | `False` | HTTP 500 |

Full relevant suite (7 test files) and complete suite, both re-run with fresh compilation:

```
$ PYTHONPATH=... PYTHONPYCACHEPREFIX=... ./.venv/Scripts/python.exe -m pytest <7 files> -q
192 passed in 1.61s
PIPE_EXIT=0

$ PYTHONPATH=... PYTHONPYCACHEPREFIX=... ./.venv/Scripts/python.exe -m pytest tests -q --tb=long
489 passed in 6.83s
PIPE_EXIT=0
```

---

## 9. Documentation corroboration

`docs/config.rst:88–93` (TESTING at 80, DEBUG at 68) — the tri-state contract in prose:

```rst
.. py:data:: TESTING

    Enable testing mode. Exceptions are propagated rather than handled by the
    the app's error handlers. Extensions may also change their behavior to
    facilitate easier testing. You should enable this in your own tests.

    Default: ``False``

.. py:data:: PROPAGATE_EXCEPTIONS

    Exceptions are re-raised rather than being handled by the app's error
    handlers. If not set, this is implicitly true if ``TESTING`` or ``DEBUG``
    is enabled.

    Default: ``None``
```

`docs/errorhandling.rst:237–255`:

```rst
Unhandled Exceptions
````````````````````

When there is no error handler registered for an exception, a 500
Internal Server Error will be returned instead. See
:meth:`flask.Flask.handle_exception` for information about this
behavior.

If there is an error handler registered for ``InternalServerError``,
this will be invoked. As of Flask 1.1.0, this error handler will always
be passed an instance of ``InternalServerError``, not the original
unhandled error.

The original error is available as ``e.original_exception``.

An error handler for "500 Internal Server Error" will be passed uncaught
exceptions in addition to explicit 500 errors. In debug mode, a handler
for "500 Internal Server Error" will not be used. Instead, the
interactive debugger will be shown.
```

`docs/reqcontext.rst:138–148`:

```rst
If an exception is raised before the teardown functions, Flask tries to
match it with an :meth:`~Flask.errorhandler` function to handle the
exception and return a response. If no error handler is found, or the
handler itself raises an exception, Flask returns a generic
``500 Internal Server Error`` response. The teardown functions are still
called, and are passed the exception object.

If debug mode is enabled, unhandled exceptions are not converted to a
``500`` response and instead are propagated to the WSGI server. This
allows the development server to present the interactive debugger with
the traceback.
```

History, `CHANGES.rst:1418–1422`:

```rst
-   Added a ``PROPAGATE_EXCEPTIONS`` configuration variable that can be
    used to flip the setting of exception propagation which previously
    was linked to ``DEBUG`` alone and is now linked to either ``DEBUG``
    or ``TESTING``.
```

And `CHANGES.rst:660–669` records the `original_exception` wrapping that line 856 implements.

---

## 10. Line-number corrections and caveats

The executor verified every anchor against the file; several numbers in the upstream plan were stale and are corrected here:

| Anchor | Plan/evidence said | Verified value |
|---|---|---|
| `response = self.handle_exception(e)` | 1517 | **`app.py:1514`** |
| `wsgi_app` span | 1509–1533 | **`app.py:1479–1527`** |
| `full_dispatch_request` span | 910–926 | **`app.py:904–920`** |
| bare `raise` in `handle_user_exception` | 805–806 | **`app.py:807`** |
| `testing = ConfigAttribute[bool]("TESTING")` | 205 / 196–211 | **`sansio/app.py:208`** (comment 195–207) |
| `handle_exception` body start | 838 | **`app.py:839`** (`exc_info = sys.exc_info()`) |

Everything else matched exactly: `handle_exception` def at 811, decisive lines 841 / 843–844 / 846 / 849–852 / 854–862; `default_config["PROPAGATE_EXCEPTIONS"]` at 182; `docs/config.rst` PROPAGATE_EXCEPTIONS at 88; `docs/errorhandling.rst` "Unhandled Exceptions" at 237; `test_exception_propagation` at 1581–1595.

Caveats worth stating:

1. **The docstring's first line is over-broad.** "This always causes a 500 `InternalServerError`" (app.py:813–814) holds only for the non-propagating branch; the paragraph immediately below (818–821) describes the re-raise. Likewise `log_exception`'s "if debugging is disabled" (868–869) is really `not propagate`.
2. **`BaseException` never reaches this method.** The bare `except:` at `wsgi_app:1515–1517` re-raises it directly. Observed:
   ```
   E: KeyboardInterrupt escaped even with PROPAGATE_EXCEPTIONS=False
   E: handle_exception was called for: [] (empty => BaseException never reaches it)
   ```
   exit 0. Confirmed by `tests/test_basic.py:926–934` (`test_baseexception_error_handling`).
3. **Docs mention only "debug mode" for suppressing a 500 handler**, but `TESTING=True` (via the `None` fallback) does the same:
   ```
   F: TESTING=True -> re-raised ZeroDivisionError; 500-handler called: []
   F: DEBUG=True   -> re-raised ZeroDivisionError; 500-handler called: []
   F: both off     -> response 500 body=b'500 handler'; 500-handler called: ['InternalServerError']
   ```
   exit 0.
4. **`debug`/`testing` are read late.** `self.debug` maps to `config["DEBUG"]` with the documented warning "It may not behave as expected if set late" (sansio/app.py:554; docs/config.rst:92), so any claim about toggling them mid-request must be caveated.
5. **Environment note (does not change the answer).** The venv's `flask.pth` pointed at a different session directory (`.../q1-TXT/seal`), so every run required `PYTHONPATH=<cwd>/src`; shipped `.pyc` files embed a foreign origin path and validated against the current sources, so each recorded run was repeated with `PYTHONPYCACHEPREFIX` set to force recompilation from the working tree — results identical (192/489 passed). No tracked file was modified; the throwaway cache directory was deleted.

---

### Bottom line

`Flask.handle_exception` decides on exactly one tri-state config read: `PROPAGATE_EXCEPTIONS`. Explicit `True` → re-raise; explicit `False` → 500 even with `TESTING`/`DEBUG` on; `None` (the default) → inherit `self.testing or self.debug`, where a truthy result re-raises (`raise` at 850 under `wsgi_app`, preserving the original traceback) and a falsy result logs, wraps in `InternalServerError(original_exception=e)`, runs an optional 500 handler, and finalizes with `from_error_handler=True` to return HTTP 500. `got_request_exception` is always sent first.
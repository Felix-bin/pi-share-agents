# How the `TypedDict` view-return annotation decouples JSON serialization from HTTP status

## Short answer

In this Flask checkout the "type-safe dictionary structure" is `typing.TypedDict` (the fixture is `class StatusJSON(t.TypedDict)`). The decoupling works because the type system partitions a response into **two independent type positions**:

1. **The body/JSON payload** is described by `ResponseValue`, whose mapping member is deliberately `t.Mapping[str, t.Any]` (not `dict[str, t.Any]`) so that a `TypedDict` is statically admissible while the runtime `isinstance(rv, (dict, list))` check still matches, since a `TypedDict` instance *is* an ordinary `dict`.
2. **The HTTP status** is never part of the payload type at all; it is a **separate tuple slot typed `int`** in `ResponseReturnValue` (`tuple[ResponseValue, int]`, `tuple[ResponseValue, int, HeadersValue]`).

At runtime `Flask.make_response` mirrors exactly that split: the body is serialized in one branch (`elif isinstance(rv, (dict, list)): rv = self.json.response(rv)`) and the status is applied in a later, disjoint branch (`if status is not None: ... rv.status_code = status`). The serializer itself takes no status argument. So the two concerns are **typed separately, checked separately, and executed separately** — neither can be mistaken for, or silently alter, the other.

---

## 1. The type definitions: `src/flask/typing.py`

`ResponseValue` and `ResponseReturnValue` are the unions that the route decorator enforces. The decisive region (verified verbatim from the working tree):

```python
# The possible types that are directly convertible or are a Response object.
ResponseValue = t.Union[
    "Response",
    str,
    bytes,
    list[t.Any],
    # Only dict is actually accepted, but Mapping allows for TypedDict.
    t.Mapping[str, t.Any],
    t.Iterator[str],
    t.Iterator[bytes],
    cabc.AsyncIterable[str],  # for Quart, until App is generic.
    cabc.AsyncIterable[bytes],
]

# the possible types for an individual HTTP header
HeaderValue = str | list[str] | tuple[str, ...]

# the possible types for HTTP headers
HeadersValue = t.Union[
    "Headers",
    t.Mapping[str, HeaderValue],
    t.Sequence[tuple[str, HeaderValue]],
]

# The possible types returned by a route function.
ResponseReturnValue = t.Union[
    ResponseValue,
    tuple[ResponseValue, HeadersValue],
    tuple[ResponseValue, int],
    tuple[ResponseValue, int, HeadersValue],
    "WSGIApplication",
]
```

Two facts here *are* the decoupling:

- **The mapping member is `t.Mapping[str, t.Any]`, not `dict[str, t.Any]`**, and the inline comment states the design intent explicitly: *"Only dict is actually accepted, but Mapping allows for TypedDict."* `TypedDict` is not assignable to a mutable `dict[str, t.Any]` under static analysis (mutable-dict invariance), but it *is* assignable to the read-only/covariant `Mapping[str, t.Any]`. That single substitution is what lets a `TypedDict` be accepted as a body type.
- **Status is a separate tuple slot typed `int`** — `tuple[ResponseValue, int]` and `tuple[ResponseValue, int, HeadersValue]`. The status type never appears inside `ResponseValue`; the payload type never appears in the status position. They are structurally disjoint.

The route callable is bound to this union in the same file:

```python
RouteCallable = (
    t.Callable[..., ResponseReturnValue]
    | t.Callable[..., t.Awaitable[ResponseReturnValue]]
)
```

and so are error handlers:

```python
ErrorHandlerCallable = (
    t.Callable[[t.Any], ResponseReturnValue]
    | t.Callable[[t.Any], t.Awaitable[ResponseReturnValue]]
)
```

The decorator that actually applies this bound is in `src/flask/sansio/scaffold.py`:

```python
T_route = t.TypeVar("T_route", bound=ft.RouteCallable)
```

```python
    def route(self, rule: str, **options: t.Any) -> t.Callable[[T_route], T_route]:
        ...
        def decorator(f: T_route) -> T_route:
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f

        return decorator
```

and the view's return value flows unmodified into `make_response`: `dispatch_request` is typed `-> ft.ResponseReturnValue`, and `finalize_request(rv: ft.ResponseReturnValue | HTTPException, ...)` calls `response = self.make_response(rv)` (line 939), whose signature is `def make_response(self, rv: ft.ResponseReturnValue) -> Response:` (line 1129).

## 2. The fixture that proves `TypedDict` is the accepted body type

`tests/type_check/typing_route.py` (verified verbatim, fixture at lines 41–47):

```python
class StatusJSON(t.TypedDict):
    status: str


@app.route("/typed-dict")
def typed_dict() -> StatusJSON:
    return {"status": "ok"}
```

Contrasting status-as-tuple fixtures in the same file (lines 69–77) show the *other* channel — status carried as a second tuple element:

```python
@app.route("/status")
@app.route("/status/<int:code>")
def tuple_status(code: int = 200) -> tuple[str, int]:
    return "hello", code


@app.route("/status-enum")
def tuple_status_enum() -> tuple[str, int]:
    return "hello", HTTPStatus.OK
```

The fixture's typed-dict view is annotated **plain `-> StatusJSON`** with no status pairing: the typed-dict guarantee applies to the *payload only*, and status is expressed orthogonally through the tuple form.

The changelog records the change with exactly that scope (`CHANGES.rst`, under Version 2.2.0, lines 336–339):

```
-   Allow returning a list from a view function, to convert it to a
    JSON response like a dict is. :issue:`4672`
-   When type checking, allow ``TypedDict`` to be returned from view
    functions. :pr:`4695`
```

*"When type checking, allow `TypedDict` to be returned from view functions"* — the change extended the **body** type accepted by the checker (PR 4695); the status-tuple channel is a separate, pre-existing feature. The decoupling is the composition of the two, not either one alone.

The harness that exercises this fixture (`pyproject.toml`):

```toml
[tool.mypy]
python_version = "3.10"
files = ["src", "tests/type_check"]
show_error_codes = true
pretty = true
strict = true

[[tool.mypy.overrides]]
module = [
    "asgiref.*",
    "dotenv.*",
    "cryptography.*",
    "importlib_metadata",
]
ignore_missing_imports = true

[tool.pyright]
pythonVersion = "3.10"
include = ["src", "tests/type_check"]
typeCheckingMode = "basic"
```

## 3. The runtime mirrors the type split: `Flask.make_response`

The full body of `make_response` (verified verbatim from `src/flask/app.py`) shows the two concerns handled in physically separate code paths:

```python
        status: int | None = None
        headers: HeadersValue | None = None

        # unpack tuple returns
        if isinstance(rv, tuple):
            len_rv = len(rv)

            # a 3-tuple is unpacked directly
            if len_rv == 3:
                rv, status, headers = rv  # type: ignore[misc]
            # decide if a 2-tuple has status or headers
            elif len_rv == 2:
                if isinstance(rv[1], (Headers, dict, tuple, list)):
                    rv, headers = rv  # pyright: ignore
                else:
                    rv, status = rv  # type: ignore[assignment,misc]
            # other sized tuples are not allowed
            else:
                raise TypeError(
                    "The view function did not return a valid response tuple."
                    " The tuple must have the form (body, status, headers),"
                    " (body, status), or (body, headers)."
                )

        # the body must not be None
        if rv is None:
            raise TypeError(
                f"The view function for {request.endpoint!r} did not"
                " return a valid response. The function either returned"
                " None or ended without a return statement."
            )

        # make sure the body is an instance of the response class
        if not isinstance(rv, self.response_class):
            if isinstance(rv, (str, bytes, bytearray)) or isinstance(rv, cabc.Iterator):
                # let the response class set the status and headers instead of
                # waiting to do it manually, so that the class can handle any
                # special logic
                rv = self.response_class(
                    rv,  # pyright: ignore
                    status=status,
                    headers=headers,  # type: ignore[arg-type]
                )
                status = headers = None
            elif isinstance(rv, (dict, list)):
                rv = self.json.response(rv)
            elif isinstance(rv, BaseResponse) or callable(rv):
                # evaluate a WSGI callable, or coerce a different response
                # class to the correct type
                try:
                    rv = self.response_class.force_type(
                        rv,  # type: ignore[arg-type]
                        request.environ,
                    )
                except TypeError as e:
                    raise TypeError(
                        f"{e}\nThe view function did not return a valid"
                        " response. The return type must be a string,"
                        " dict, list, tuple with headers or status,"
                        " Response instance, or WSGI callable, but it"
                        f" was a {type(rv).__name__}."
                    ).with_traceback(sys.exc_info()[2]) from None
            else:
                raise TypeError(
                    "The view function did not return a valid"
                    " response. The return type must be a string,"
                    " dict, list, tuple with headers or status,"
                    " Response instance, or WSGI callable, but it was a"
                    f" {type(rv).__name__}."
                )

        rv = t.cast(Response, rv)
        # prefer the status if it was provided
        if status is not None:
            if isinstance(status, (str, bytes, bytearray)):
                rv.status = status
            else:
                rv.status_code = status

        # extend existing headers with provided headers
        if headers:
            rv.headers.update(headers)

        return rv
```

Line-anchored, the separation is exact:

- **Serialization branch** — `app.py:1230–1231`:
  ```python
            elif isinstance(rv, (dict, list)):
                rv = self.json.response(rv)
  ```
  It keys off `(dict, list)`. A `TypedDict` value is, at runtime, an ordinary `dict`, so it matches this check even though its *static* type is not `dict` — which is precisely why the annotation had to be broadened to `Mapping` rather than `dict`.
- **Status branch** — `app.py:1259–1263`:
  ```python
        if status is not None:
            if isinstance(status, (str, bytes, bytearray)):
                rv.status = status
            else:
                rv.status_code = status
  ```
  The serialization branch never mentions `status`; the status branch never touches the JSON content. The tuple unpacking above them (`rv, status, headers = rv`) is the same body/status split expressed as data layout.

The method's own docstring documents the same division for the two forms:

```
            ``dict``
                A dictionary that will be jsonify'd before being returned.
            ...
            ``tuple``
                Either ``(body, status, headers)``, ``(body, status)``, or
                ``(body, headers)``, where ``body`` is any of the other types
                allowed here, ``status`` is a string or an integer, and
                ``headers`` is a dictionary or a list of ``(key, value)``
                tuples. If ``body`` is a :attr:`response_class` instance,
                ``status`` overwrites the exiting value and ``headers`` are
                extended.
            ...
        .. versionchanged:: 1.1
            A dict will be converted to a JSON response.
```

## 4. The serializer is status-free by construction

`self.json.response(rv)` resolves to `JSONProvider.response`, which takes no status argument (verified via `grep`, `src/flask/json/provider.py` lines 89, 189; `src/flask/sansio/app.py` lines 230, 329):

```python
    def response(self, *args: t.Any, **kwargs: t.Any) -> Response:
        """Serialize the given arguments as JSON, and return a
        :class:`~flask.Response` object with it. The response mimetype
        will be "application/json" and can be changed with
        :attr:`mimetype`.
        ...
        """
        obj = self._prepare_response_obj(args, kwargs)
        dump_args: dict[str, t.Any] = {}

        if (self.compact is None and self._app.debug) or self.compact is False:
            dump_args.setdefault("indent", 2)
        else:
            dump_args.setdefault("separators", (",", ":"))

        return self._app.response_class(
            f"{self.dumps(obj, **dump_args)}\n", mimetype=self.mimetype
        )
```

`self.json` is typed as the provider on the app:

```python
        self.json: JSONProvider = self.json_provider_class(self)
```

and `jsonify` delegates to it:

```python
def jsonify(*args: t.Any, **kwargs: t.Any) -> Response:
    """Serialize the given arguments as JSON, and return a
    :class:`~flask.Response` object with the ``application/json``
    mimetype. A dict or list returned from a view will be converted to a
    JSON response automatically without needing to call this.

    This requires an active request or application context, and calls
    :meth:`app.json.response() <flask.json.provider.JSONProvider.response>`.
    ...
    """
    return current_app.json.response(*args, **kwargs)  # type: ignore[return-value]
```

Neither `response` nor `_prepare_response_obj` accepts a `status` parameter — the JSON layer is structurally incapable of setting a status, just as the status branch is incapable of touching serialized content.

## 5. Verification performed (full command outputs)

The plan's optional verification sub-step was executed against the working tree.

**Type checkers — mypy (project config, `files = ["src", "tests/type_check"]`, `strict = true`):**

```
$ .venv/Scripts/mypy.exe
```
Exit status: **1**

```
src\flask\cli.py:1041: error: Module has no attribute "set_completer" 
[attr-defined]
                readline.set_completer(Completer(ctx).complete)
                ^~~~~~~~~~~~~~~~~~~~~~
Found 1 error in 1 file (checked 27 source files)
```

The only error is an unrelated Python-3.13/typeshed issue in `cli.py`; **no error is reported for `tests/type_check/typing_route.py`** — `typed_dict() -> StatusJSON` type-checks.

**Type checkers — pyright, venv interpreter supplied:**

```
$ .venv/Scripts/pyright.exe --pythonpath .venv/Scripts/python.exe tests/type_check/typing_route.py
```
Exit status: **0**

```
0 errors, 0 warnings, 0 informations 
```

```
$ .venv/Scripts/pyright.exe --pythonpath .venv/Scripts/python.exe src tests/type_check
```
Exit status: **1**

```
c:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q7-TXT\seal\src\flask\cli.py
  c:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q7-TXT\seal\src\flask\cli.py:1041:22 - error: "set_completer" is not a known attribute of module "readline" (reportAttributeAccessIssue)
1 error, 0 warnings, 0 informations 
```

Both checkers agree: the only error in the configured include set is the unrelated `cli.py:1041`; `tests/type_check` passes cleanly.

**Scratch experiments proving the specific claims.** A pass-case file (`-> StatusJSON`, `-> tuple[StatusJSON, int]`, `-> tuple[StatusJSON, dict[str,str]]`, `-> tuple[StatusJSON, int, dict[str,str]]`, `Mapping[str, Any]` assignment, `HTTPStatus.OK` in the `int` slot):

```
$ .venv/Scripts/mypy.exe --python-version 3.10 --strict --show-error-codes scratch_exec_check/pass_cases.py
```
Exit status: **0**

```
Success: no issues found in 1 source file
```

A fail-case file (`dict[str, Any] = StatusJSON(...)`, `-> tuple[StatusJSON, str]`, `return {"status": 123}`):

```
$ .venv/Scripts/mypy.exe --python-version 3.10 --strict --show-error-codes scratch_exec_check/fail_cases.py
```
Exit status: **1**

```
scratch_exec_check\fail_cases.py:15: error: Incompatible types in assignment
(expression has type "StatusJSON", variable has type "dict[str, Any]") 
[assignment]
    g: dict[str, t.Any] = StatusJSON(status="ok")
                          ^~~~~~~~~~~~~~~~~~~~~~~
scratch_exec_check\fail_cases.py:19: error: Value of type variable "T_route" of
function cannot be "Callable[[], tuple[StatusJSON, str]]"  [type-var]
    @app.route("/h")
     ^
scratch_exec_check\fail_cases.py:27: error: Incompatible types (expression has
type "int", TypedDict item "status" has type "str")  [typeddict-item]
        return {"status": 123}
                          ^~~
Found 3 errors in 1 file (checked 1 source file)
```

Same files under pyright:

```
$ .venv/Scripts/pyright.exe --pythonpath .venv/Scripts/python.exe scratch_exec_check/pass_cases.py
```
Exit status: **0**

```
0 errors, 0 warnings, 0 informations 
```

```
$ .venv/Scripts/pyright.exe --pythonpath .venv/Scripts/python.exe scratch_exec_check/fail_cases.py
```
Exit status: **1**

```
c:\Users\oobbee\AppData\Local\Temp\pi-p50o\2335aa4c\q7-TXT\seal\scratch_exec_check\fail_cases.py
  c:\...\scratch_exec_check\fail_cases.py:15:23 - error: Type "StatusJSON" is not assignable to declared type "dict[str, Any]"
    "StatusJSON" is not assignable to "dict[str, Any]" (reportAssignmentType)
  c:\...\scratch_exec_check\fail_cases.py:19:2 - error: Argument of type "() -> tuple[StatusJSON, str]" cannot be assigned to parameter of type "T_route@route"
    Type "() -> tuple[StatusJSON, str]" is not assignable to type "RouteCallable"
      Type "() -> tuple[StatusJSON, str]" is not assignable to type "RouteCallable"
        Type "() -> tuple[StatusJSON, str]" is not assignable to type "(...) -> ResponseReturnValue"
          Function return type "tuple[StatusJSON, str]" is incompatible with type "ResponseReturnValue"
            Type "tuple[StatusJSON, str]" is not assignable to type "ResponseReturnValue"
        Type "() -> tuple[StatusJSON, str]" is not assignable to type "(...) -> Awaitable[ResponseReturnValue]"
          Function return type "tuple[StatusJSON, str]" is incompatible with type "Awaitable[ResponseReturnValue]"
            "tuple[StatusJSON, str]" is incompatible with protocol "Awaitable[ResponseReturnValue]" (reportArgumentType)
  c:\...\scratch_exec_check\fail_cases.py:27:23 - error: Type "dict[str, int]" is not assignable to return type "StatusJSON"
    "Literal[123]" is not assignable to "str" (reportReturnType)
3 errors, 0 warnings, 0 informations 
```

Both checkers accept every pass case (including `-> tuple[StatusJSON, int]`) and reject exactly the three fail cases. Crucially:

- `TypedDict` is **not** assignable to `dict[str, Any]` — this is the mechanical proof why the union member must be `Mapping`, not `dict`, and the reason the inline comment exists.
- A `str` in the status tuple slot is rejected (`tuple[StatusJSON, str]` is not assignable to `ResponseReturnValue`) — the status slot is `int`.
- A wrong payload value type (`{"status": 123}`) is rejected by the `TypedDict` itself — the JSON schema is independently enforced.

**Runtime check of the split:**

```
$ PYTHONPATH=src .venv/Scripts/python.exe scratch_exec_check/runtime_check.py
```
Exit status: **0**

```
type(StatusJSON(status='ok')) -> <class 'dict'>
isinstance(inst, dict) -> True
isinstance(inst, list) -> False
body-only:  200 application/json b'{"status":"ok"}\n'
tuple+int:  404 application/json b'{"status":"ok"}\n'
tuple+int+hdrs: 201 application/json {'Content-Type': 'application/json', 'Content-Length': '16', 'X-Test': 'yes'}
JSONProvider.response signature: (*args: 't.Any', **kwargs: 't.Any') -> 'Response'
DefaultJSONProvider.response signature: (self, *args: 't.Any', **kwargs: 't.Any') -> 'Response'
```

A `TypedDict` instance is a runtime `dict` (so `isinstance(rv, (dict, list))` matches); the body is jsonified to `application/json`; the status is applied independently (`404`, `201`); and `JSONProvider.response` takes no `status` argument. (All scratch files were removed afterwards; `git status --short` shows only the pre-existing `flask_mut2_i417ar2x/`, HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`.)

**Full test suite, run twice:**

```
$ .venv/Scripts/pytest.exe
```
Exit status: **0**, `489 passed in 3.51s`.

```
$ .venv/Scripts/pytest.exe -vv -rA --tb=long
```
Exit status: **0**, `489 passed in 4.08s` (identical count; the verbose log was truncated by the display limit and saved separately — all 489 short-summary lines are `PASSED`, including `tests/test_basic.py::test_make_response`, `tests/test_basic.py::test_make_response_with_response_instance`, and `tests/test_basic.py::test_jsonify_mimetype`).

Those runtime tests confirm the independence of the two concerns (from `tests/test_basic.py`):

```python
def test_make_response(app, req_ctx):
    rv = flask.make_response()
    assert rv.status_code == 200
    assert rv.data == b""
    assert rv.mimetype == "text/html"

    rv = flask.make_response("Awesome")
    assert rv.status_code == 200
    assert rv.data == b"Awesome"
    assert rv.mimetype == "text/html"

    rv = flask.make_response("W00t", 404)
    assert rv.status_code == 404
    assert rv.data == b"W00t"
    assert rv.mimetype == "text/html"

    rv = flask.make_response(c for c in "Hello")
    assert rv.status_code == 200
    assert rv.data == b"Hello"
    assert rv.mimetype == "text/html"


def test_make_response_with_response_instance(app, req_ctx):
    rv = flask.make_response(flask.jsonify({"msg": "W00t"}), 400)
    assert rv.status_code == 400
    assert rv.data == b'{"msg":"W00t"}\n'
    assert rv.mimetype == "application/json"
    ...
def test_jsonify_mimetype(app, req_ctx):
    app.json.mimetype = "application/vnd.api+json"
    msg = {"msg": {"submsg": "W00t"}}
    rv = flask.make_response(flask.jsonify(msg), 200)
    assert rv.mimetype == "application/vnd.api+json"
```

## 6. Documentation context (and its limits)

The general conversion rules are documented in "About Responses" (`docs/quickstart.rst`, heading at line 682):

```
The return value from a view function is automatically converted into
a response object for you. If the return value is a string it's
converted into a response object with the string as response body, a
``200 OK`` status code and a :mimetype:`text/html` mimetype. If the
return value is a dict or list, :func:`jsonify` is called to produce a
response. The logic that Flask applies to converting return values into
response objects is as follows:

1.  If a response object of the correct type is returned it's directly
    returned from the view.
2.  If it's a string, a response object is created with that data and
    the default parameters.
3.  If it's an iterator or generator returning strings or bytes, it is
    treated as a streaming response.
4.  If it's a dict or list, a response object is created using
    :func:`~flask.json.jsonify`.
5.  If a tuple is returned the items in the tuple can provide extra
    information. Such tuples have to be in the form
    ``(response, status)``, ``(response, headers)``, or
    ``(response, status, headers)``. The ``status`` value will override
    the status code and ``headers`` can be a list or dictionary of
    additional header values.
6.  If none of that works, Flask will assume the return value is a
    valid WSGI application and convert that into a response object.
```

The docs describe item 4 (dict/list → JSON) and item 5 (tuple status/headers) as separate rules but do **not** name the type unions. A repo-wide grep is a verified negative result:

```
$ grep -rn "TypedDict\|ResponseReturnValue\|ResponseValue\|Mapping\[str" docs/
```
Exit status: **1** (no matches)

```
$ grep -rn "annotation\|type hint\|type check" docs/
```
Exit status: **1** (no matches)

So the evidence for the decoupling is the code (`src/flask/typing.py`, `src/flask/app.py`, `src/flask/json/`), the type-check fixture (`tests/type_check/typing_route.py`), and the changelog line — not any documentation paragraph.

---

## Conclusion

The `TypedDict` used as a view return annotation (`class StatusJSON(t.TypedDict)`, returning `{"status": "ok"}`) captures **only the JSON-serializable payload shape**. It is admitted into the accepted return types not through `dict` but through `t.Mapping[str, t.Any]`, whose inline comment — *"Only dict is actually accepted, but Mapping allows for TypedDict"* — records the exact reason: static compatibility with `Mapping` (covariant) for the checker, while runtime `isinstance(rv, (dict, list))` still matches because a `TypedDict` value is an ordinary `dict`.

HTTP status is represented **completely outside that payload type**, as a distinct tuple position typed `int` in `ResponseReturnValue` (`tuple[ResponseValue, int]` / `tuple[ResponseValue, int, HeadersValue]`). The two never share a type position, so a checker can verify the JSON schema and the status type independently — and the scratch runs confirm both directions: `-> tuple[StatusJSON, int]` passes, while `-> tuple[StatusJSON, str]` and `dict[str, Any] = StatusJSON(...)` both fail.

The runtime function physically enacts the same partition: `make_response` serializes the body in the `isinstance(rv, (dict, list)) → self.json.response(rv)` branch and applies the status in the later `if status is not None → rv.status_code = status` branch, with a JSON serializer (`JSONProvider.response(*args, **kwargs)`) that has no `status` parameter at all. Therefore the JSON body contract and the HTTP status contract are typed separately, checked separately by mypy/pyright, and executed separately at request time — which is exactly the decoupling that preserves type safety, and is the behavior recorded by the changelog entry *"When type checking, allow `TypedDict` to be returned from view functions"* (PR 4695) layered on the pre-existing tuple-status channel.
# Answer

## The class: `TestStreaming` in `tests/test_helpers.py`

The test class the question describes is **`TestStreaming`**, defined at `tests/test_helpers.py:236`. It is the only **class** in the whole test suite that combines request-context lifecycle handling with streaming-response generation — confirmed both by reading the file and by an exhaustive `^class` grep across `tests/**/*.py`:

```
tests/test_async.py:14: class AppError(Exception):
tests/test_async.py:18: class BlueprintError(Exception):
tests/test_async.py:22: class AsyncView(View):
tests/test_async.py:30: class AsyncMethodView(MethodView):
tests/test_cli.py:446: class TestRoutes:
tests/test_helpers.py:11: class FakePath:
tests/test_helpers.py:25: class PyBytesIO:
tests/test_helpers.py:33: class TestSendfile:
tests/test_helpers.py:102: class TestUrlFor:
tests/test_helpers.py:217: class TestNoImports:
tests/test_helpers.py:236: class TestStreaming:
tests/test_helpers.py:310: class TestHelpers:
tests/test_json.py:145: class FixedOffset(datetime.tzinfo):
tests/test_reqctx.py:149: class TestGreenletContextCopying:
tests/test_user_error_handler.py:217: class TestGenericHandlers:
```

The complete class, verbatim (`tests/test_helpers.py` lines 236–307):

```python
class TestStreaming:
    def test_streaming_with_context(self, app, client):
        @app.route("/")
        def index():
            def generate():
                yield "Hello "
                yield flask.request.args["name"]
                yield "!"

            return flask.Response(flask.stream_with_context(generate()))

        rv = client.get("/?name=World")
        assert rv.data == b"Hello World!"

    def test_streaming_with_context_as_decorator(self, app, client):
        @app.route("/")
        def index():
            @flask.stream_with_context
            def generate(hello):
                yield hello
                yield flask.request.args["name"]
                yield "!"

            return flask.Response(generate("Hello "))

        rv = client.get("/?name=World")
        assert rv.data == b"Hello World!"

    def test_streaming_with_context_and_custom_close(self, app, client):
        called = []

        class Wrapper:
            def __init__(self, gen):
                self._gen = gen

            def __iter__(self):
                return self

            def close(self):
                called.append(42)

            def __next__(self):
                return next(self._gen)

            next = __next__

        @app.route("/")
        def index():
            def generate():
                yield "Hello "
                yield flask.request.args["name"]
                yield "!"

            return flask.Response(flask.stream_with_context(Wrapper(generate())))

        rv = client.get("/?name=World")
        assert rv.data == b"Hello World!"
        assert called == [42]

    def test_stream_keeps_session(self, app, client):
        @app.route("/")
        def index():
            flask.session["test"] = "flask"

            @flask.stream_with_context
            def gen():
                yield flask.session["test"]

            return flask.Response(gen())

        rv = client.get("/")
        assert rv.data == b"flask"
```

## The architectural pattern

**`TestStreaming` is a plain, un-inherited pytest/xUnit-style class-based grouping of four test methods; the isolation it demonstrates is separation of concerns implemented by the wrapper (decorator) pattern.** Each of the four methods keeps the two responsibilities apart in exactly the same way:

1. **Request-context lifecycle management** (push → keep alive across the returned response → teardown/cleanup) is delegated entirely to Flask's `flask.stream_with_context` wrapper. None of the test methods push, copy, or pop a context themselves.
2. **Streaming response generation** (producing chunks) lives in a separate, plain generator function that knows nothing about context lifecycle — `generate()`, `generate(hello)`, and `gen()` respectively — and simply `yield`s strings.

The class has **no base class** (a pytest class-based grouping, not an inheritance hierarchy). It consumes only the two fixtures `app` and `client`, defined in `tests/conftest.py`:

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app


@pytest.fixture
def app_ctx(app):
    with app.app_context() as ctx:
        yield ctx


@pytest.fixture
def req_ctx(app):
    with app.test_request_context() as ctx:
        yield ctx


@pytest.fixture
def client(app):
    return app.test_client()
```

## Where the isolation is actually implemented: `stream_with_context`

The architectural split that the class exercises is implemented by `stream_with_context` in `src/flask/helpers.py` (lines 50–136). Its docstring states the problem in exactly the lifecycle/generation terms of the question:

```python
    """Request contexts disappear when the response is started on the server.
    This is done for efficiency reasons and to make it less likely to encounter
    memory leaks with badly written WSGI middlewares.  The downside is that if
    you are using streamed responses, the generator cannot access request bound
    information any more.

    This function however can help you keep the context around for longer::

        from flask import stream_with_context, request, Response

        @app.route('/stream')
        def streamed_response():
            @stream_with_context
            def generate():
                yield 'Hello '
                yield request.args['name']
                yield '!'
            return Response(generate())

    Alternatively it can also be used around a specific generator::

        from flask import stream_with_context, request, Response

        @app.route('/stream')
        def streamed_response():
            def generate():
                yield 'Hello '
                yield request.args['name']
                yield '!'
            return Response(stream_with_context(generate()))

    .. versionadded:: 0.9
    """
```

The body shows the two patterns explicitly — a **decorator branch** (for the callable form used by `test_streaming_with_context_as_decorator` and `test_stream_keeps_session`) and a **wrapper branch** (for the iterator form used by `test_streaming_with_context` and `test_streaming_with_context_and_custom_close`), plus the nested `generator()` that owns the lifecycle while delegating chunk production:

```python
    try:
        gen = iter(generator_or_function)  # type: ignore[arg-type]
    except TypeError:

        def decorator(*args: t.Any, **kwargs: t.Any) -> t.Any:
            gen = generator_or_function(*args, **kwargs)  # type: ignore[operator]
            return stream_with_context(gen)

        return update_wrapper(decorator, generator_or_function)  # type: ignore[arg-type]

    def generator() -> t.Iterator[t.AnyStr | None]:
        ctx = _cv_request.get(None)
        if ctx is None:
            raise RuntimeError(
                "'stream_with_context' can only be used when a request"
                " context is active, such as in a view function."
            )
        with ctx:
            # Dummy sentinel.  Has to be inside the context block or we're
            # not actually keeping the context around.
            yield None

            # The try/finally is here so that if someone passes a WSGI level
            # iterator in we're still running the cleanup logic.  Generators
            # don't need that because they are closed on their destruction
            # automatically.
            try:
                yield from gen
            finally:
                if hasattr(gen, "close"):
                    gen.close()

    # The trick is to start the generator.  Then the code execution runs until
    # the first dummy None is yielded at which point the context was already
    # pushed.  This item is discarded.  Then when the iteration continues the
    # real generator is executed.
    wrapped_g = generator()
    next(wrapped_g)
    return wrapped_g  # type: ignore[return-value]
```

In pattern terms this is a **wrapper/decorator for the iterator-or-callable boundary** (`iter(...)` vs. `update_wrapper(decorator, ...)`) layered over a **context-manager re-entry** (`with ctx:`) with a **priming sentinel** (`yield None` consumed by `next(wrapped_g)`), and cleanup delegated to the wrapped object in a `finally: gen.close()`. The *lifecycle* is owned by the outer `generator()`; the *generation* is untouched, delegated by `yield from gen`.

The corresponding context-manager protocol is on `RequestContext` itself (`src/flask/ctx.py`), which is what `with ctx:` invokes:

```python
    def __enter__(self) -> RequestContext:
        self.push()
        return self

    def __exit__(
        self,
        exc_type: type | None,
        exc_value: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.pop(exc_value)
```

And the reason the re-push is safe (and why `test_stream_keeps_session` passes) is stated directly in `RequestContext.push` (`src/flask/ctx.py`, lines 369–401):

```python
        # Open the session at the moment that the request context is available.
        # This allows a custom open_session method to use the request context.
        # Only open a new session if this is the first time the request was
        # pushed, otherwise stream_with_context loses the session.
        if self.session is None:
            session_interface = self.app.session_interface
            self.session = session_interface.open_session(self.app, self.request)

            if self.session is None:
                self.session = session_interface.make_null_session(self.app)
```

## The four isolations, one per method

- **`test_streaming_with_context`** — iterator form: context lifecycle goes to `flask.stream_with_context(generate())`; generation stays in the plain `generate()` that yields `"Hello "`, `request.args["name"]`, `"!"`. Asserted by streamed content: `assert rv.data == b"Hello World!"`.
- **`test_streaming_with_context_as_decorator`** — decorator form: lifecycle via `@flask.stream_with_context` on `generate(hello)`; generation still just yields. Asserted by `assert rv.data == b"Hello World!"`.
- **`test_streaming_with_context_and_custom_close`** — lifecycle/cleanup isolation is sharpened with an inner **adapter class** `Wrapper` exposing `__iter__`/`__next__`/`close` (note `next = __next__`). The test asserts the generation concern (`assert rv.data == b"Hello World!"`) *and* the lifecycle/cleanup concern (`assert called == [42]`, i.e. the wrapper's `finally: gen.close()` reached the user iterator's `close`). This is where the class shows all three GoF-ish readings at once: class-based grouping, wrapper, and adapter.
- **`test_stream_keeps_session`** — decorator form proving the context remains active inside the generator: `flask.session["test"] = "flask"` is set in the view, then `gen()` reads `flask.session["test"]` *after* the view returned, and the streamed body is `b"flask"`.

## Documentation framing of the same split

`docs/patterns/streaming.rst`, "Streaming with Context" (lines 49–86):

```rst
Streaming with Context
----------------------

The :data:`~flask.request` will not be active while the generator is
running, because the view has already returned at that point. If you try
to access ``request``, you'll get a ``RuntimeError``.

If your generator function relies on data in ``request``, use the
:func:`~flask.stream_with_context` wrapper. This will keep the request
context active during the generator.

.. code-block:: python

    from flask import stream_with_context, request
    from markupsafe import escape

    @app.route('/stream')
    def streamed_response():
        def generate():
            yield '<p>Hello '
            yield escape(request.args['name'])
            yield '!</p>'
        return stream_with_context(generate())

It can also be used as a decorator.

.. code-block:: python

    @stream_with_context
    def generate():
        ...

    return generate()

The :func:`~flask.stream_template` and
:func:`~flask.stream_template_string` functions automatically
use :func:`~flask.stream_with_context` if a request is active.
```

The same wrapper is applied in the library's template streaming (`src/flask/templating.py`, `_stream`, lines 165–185), keeping the two concerns separate in production code too:

```python
def _stream(
    app: Flask, template: Template, context: dict[str, t.Any]
) -> t.Iterator[str]:
    app.update_template_context(context)
    before_render_template.send(
        app, _async_wrapper=app.ensure_sync, template=template, context=context
    )

    def generate() -> t.Iterator[str]:
        yield from template.generate(context)
        template_rendered.send(
            app, _async_wrapper=app.ensure_sync, template=template, context=context
        )

    rv = generate()

    # If a request context is active, keep it while generating.
    if request:
        rv = stream_with_context(rv)

    return rv
```

And `CHANGES.rst` records the same design decision historically (release 2.2 notes):

```
    -   ``stream_with_context`` preserves context separately from a
        ``with client`` block. It will be cleaned up when
        ``response.get_data()`` or ``response.close()`` is called.
```

```
-   Only open the session if the request has not been pushed onto the
    context stack yet. This allows ``stream_with_context`` generators to
    access the same session that the containing view uses. :pr:`2354`
```

## Executed verification

The target class was run with the repository's own virtualenv interpreter:

```
$ .venv/Scripts/python.exe -m pytest tests/test_helpers.py::TestStreaming -q
....                                                                     [100%]
4 passed in 0.11s
exit status 0
```

Verbose, per-test:

```
$ .venv/Scripts/python.exe -m pytest tests/test_helpers.py::TestStreaming -v
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q11-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\9f4f8f70\q11-TXT\seal
configfile: pyproject.toml
collecting ... collected 4 items

tests/test_helpers.py::TestStreaming::test_streaming_with_context PASSED [ 25%]
tests/test_helpers.py::TestStreaming::test_streaming_with_context_as_decorator PASSED [ 50%]
tests/test_helpers.py::TestStreaming::test_streaming_with_context_and_custom_close PASSED [ 75%]
tests/test_helpers.py::TestStreaming::test_stream_keeps_session PASSED   [100%]

============================== 4 passed in 0.11s ==============================
exit status 0
```

The surrounding context-lifecycle evidence (a function, and a non-streaming class) also passes:

```
$ .venv/Scripts/python.exe -m pytest tests/test_testing.py::test_client_pop_all_preserved tests/test_reqctx.py -q
...............                                                          [100%]
15 passed in 0.23s
exit status 0
```

The complete suite passes 489 tests: `489 passed in 5.58s`, and `489 passed in 7.77s` in the most verbose `-vv -rA --tb=long` run (`exit status 0`), including all four `TestStreaming` methods.

Most importantly, a behavioral probe demonstrates the live separation of the two concerns — the *same* generator body fails without the wrapper and succeeds with it:

```
$ PYTHONPATH=src .venv/Scripts/python.exe - <<'EOF'
import flask
app = flask.Flask("demo", root_path=".")
app.config["TESTING"] = True
app.secret_key = "k"
called = []
class Wrapper:
    def __init__(self, gen): self._gen = gen
    def __iter__(self): return self
    def close(self): called.append(42)
    def __next__(self): return next(self._gen)
    next = __next__
@app.route("/plain")
def plain():
    def generate():
        yield flask.request.args["name"]   # no active request ctx here
    return flask.Response(generate())
@app.route("/wrapped")
def wrapped():
    def generate():
        yield "Hello "
        yield flask.request.args["name"]
        yield "!"
    return flask.Response(flask.stream_with_context(generate()))
@app.route("/close")
def close():
    def generate():
        yield flask.request.args["name"]
    return flask.Response(flask.stream_with_context(Wrapper(generate())))
@app.route("/sess")
def sess():
    flask.session["test"] = "flask"
    @flask.stream_with_context
    def gen():
        yield flask.session["test"]
    return flask.Response(gen())
c = app.test_client()
try:
    c.get("/plain?name=World")
    print("A) unexpected: no error")
except RuntimeError as e:
    print("A) RuntimeError while generating ->", str(e).splitlines()[0])
rv = c.get("/wrapped?name=World")
print("B) rv.data =", rv.data)
rv = c.get("/close?name=X")
print("C) rv.data =", rv.data, "| close() called =", called)
rv = c.get("/sess")
print("D) rv.data =", rv.data)
EOF
```

Output:

```
A) RuntimeError while generating -> Working outside of request context.
B) rv.data = b'Hello World!'
C) rv.data = b'X' | close() called = [42]
D) rv.data = b'flask'
exit status 0
```

**Which assertion checks which concern** (from the executed code): the *generation* concern is asserted by the streamed-body equalities — `assert rv.data == b"Hello World!"` (first three methods) and `assert rv.data == b"flask"` (session test); the *context lifecycle / cleanup* concern is asserted by `assert called == [42]` (the `finally: gen.close()` path reaching the user iterator) and by `test_stream_keeps_session`'s session read inside the generator, which is only possible because the context is still active. The probe shows the counterfactual: the identical generator raises `RuntimeError: Working outside of request context.` when not wrapped.

## Corroboration and exclusions (so the identification is unambiguous)

- `TestGreenletContextCopying` (`tests/test_reqctx.py:149`) also concerns request-context lifecycle — copying, pushing, popping via `request_ctx.copy()` and `flask.copy_current_request_context` — but uses **no streaming and no `stream_with_context`**, so it is corroboration, not the answer:

```python
@pytest.mark.skipif(greenlet is None, reason="greenlet not installed")
class TestGreenletContextCopying:
    def test_greenlet_context_copying(self, app, client):
        ...
```

- `test_client_pop_all_preserved` (`tests/test_testing.py:382`) touches streaming *plus* context (its own comment names the mechanism: "stream_with_context pushes a third context, preserved by response") but is a **function, not a class**:

```python
def test_client_pop_all_preserved(app, req_ctx, client):
    @app.route("/")
    def index():
        # stream_with_context pushes a third context, preserved by response
        return flask.stream_with_context("hello")

    # req_ctx fixture pushed an initial context
    with client:
        # request pushes a second request context, preserved by client
        rv = client.get("/")

    # close the response, releasing the context held by stream_with_context
    rv.close()
    # only req_ctx fixture should still be pushed
    assert _cv_request.get(None) is req_ctx
```

- `flask_mut2_i417ar2x/mutated_test.py` is unrelated: it is a flat top-level script with **no class**, no generator, no `stream_with_context`, and no context-lifecycle API — a `url_for`/subdomain-matching scenario (`subdomain_matching=False`, `SERVER_NAME = "example.com"`, `subdomain="<company_id>"`) that fails at runtime with a 404 on its first assertion. It is not collected by pytest (`testpaths = ["tests"]`).
- A repo-wide grep confirms `stream_with_context` appears in tests only in `tests/test_helpers.py` (lines 245, 253, 289, 300) and `tests/test_testing.py` (lines 385–386).

## Bottom line

The test class is **`TestStreaming`** (`tests/test_helpers.py:236`). Its architectural pattern is a **plain, un-inherited pytest/xUnit-style class-based grouping whose four test methods each enforce separation of concerns through the wrapper (decorator) pattern**, implemented by Flask's `stream_with_context`: the **request-context lifecycle** (push / keep-alive / teardown) is owned by the wrapper — via a decorator branch (`update_wrapper(decorator, ...)`), a nested `generator()` that re-enters the active `RequestContext` with `with ctx:`, a priming sentinel `yield None` consumed by `next(wrapped_g)`, and `finally: gen.close()` cleanup — while **streaming response generation** is confined to a separate, untouched plain generator that only yields chunks. The third method additionally embeds a small **adapter class** (`Wrapper` with `__iter__`/`__next__`/`close`) to prove the cleanup half of the lifecycle independently of the generation half (`assert called == [42]`).
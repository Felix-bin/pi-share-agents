# How the `--cert` fallback chain works in `src/flask/cli.py`

## Short answer

The CLI certificate option is typed with a custom Click parameter type, `CertParamType` (`src/flask/cli.py:780`), whose single `convert` method implements the whole chain. It tries three tiers in a fixed order, each triggered when the previous one fails:

1. **Guard 0 — SSL availability.** `convert` first executes `import ssl`; if Python was not built with SSL support it raises `BadParameter('Using "--cert" requires Python to be compiled with SSL support.')` before *any* value is examined.
2. **Tier 1 — existing file path.** It delegates to an internal `click.Path(exists=True, dir_okay=False, resolve_path=True)`. A success returns a resolved absolute path. A failure raises `click.BadParameter` — and that exception is caught by `except click.BadParameter:`, which is the actual driver of the fallback.
3. **Normalization.** The value is coerced with `click.STRING(value, param, ctx).lower()`, so matching and importing happen on a lower-cased string.
4. **Tier 2 — `"adhoc"`.** If the lower-cased value equals `"adhoc"`, it verifies the `cryptography` library is importable (raising a dedicated `BadParameter` if not) and returns the literal `"adhoc"`.
5. **Tier 3 — `SSLContext` import.** Otherwise it calls `import_string(value, silent=True)`; if the result `isinstance(obj, ssl.SSLContext)` it returns that object. If not, it executes a **bare `raise`**, which re-raises the still-handled Tier-1 path error — not an import error.

A separate callback, `_validate_key` (`src/flask/cli.py:828`), then post-processes the result: it rejects `--key` combined with `"adhoc"` or an `SSLContext`, requires `--key` when `--cert` is a file (rewriting `ctx.params["cert"]` into a `(cert, key)` tuple), and errors when no `--cert` is present. The final value is handed to `run_simple(..., ssl_context=cert, ...)` (`src/flask/cli.py:990`).

The key code (verbatim, `src/flask/cli.py:780–825`):

```python
class CertParamType(click.ParamType):
    """Click option type for the ``--cert`` option. Allows either an
    existing file, the string ``'adhoc'``, or an import for a
    :class:`~ssl.SSLContext` object.
    """

    name = "path"

    def __init__(self) -> None:
        self.path_type = click.Path(exists=True, dir_okay=False, resolve_path=True)

    def convert(
        self, value: t.Any, param: click.Parameter | None, ctx: click.Context | None
    ) -> t.Any:
        try:
            import ssl
        except ImportError:
            raise click.BadParameter(
                'Using "--cert" requires Python to be compiled with SSL support.',
                ctx,
                param,
            ) from None

        try:
            return self.path_type(value, param, ctx)
        except click.BadParameter:
            value = click.STRING(value, param, ctx).lower()

            if value == "adhoc":
                try:
                    import cryptography  # noqa: F401
                except ImportError:
                    raise click.BadParameter(
                        "Using ad-hoc certificates requires the cryptography library.",
                        ctx,
                        param,
                    ) from None

                return value

            obj = import_string(value, silent=True)

            if isinstance(obj, ssl.SSLContext):
                return obj

            raise
```

---

## Full explanation, part by part

### 1. Entry point and typing

`CertParamType` subclasses `click.ParamType`, declares `name = "path"`, and stores the Tier-1 validator as `self.path_type = click.Path(exists=True, dir_okay=False, resolve_path=True)`. `convert` is the only method that performs the fallback chain; it is invoked through the type's `__call__` (`click/types.py:83–90`):

```python
    def __call__(
        self,
        value: t.Any,
        param: Parameter | None = None,
        ctx: Context | None = None,
    ) -> t.Any:
        if value is not None:
            return self.convert(value, param, ctx)
```

`convert` can return one of three shapes — a resolved file-path string, the literal `"adhoc"`, or an `ssl.SSLContext` instance. A later callback can turn the file-path case into a `(cert, key)` tuple. The public annotation reflects exactly these shapes (`src/flask/cli.py:942`):

```python
    cert: ssl.SSLContext | tuple[str, str | None] | t.Literal["adhoc"] | None,
```

`ssl` itself is imported only under `t.TYPE_CHECKING` (`cli.py:27–33`) and the file starts with `from __future__ import annotations`, so that annotation is a string; the runtime SSL import happens inside `convert` (line 795) and `_validate_key` (line 836).

### 2. Guard 0 — SSL availability

```python
        try:
            import ssl
        except ImportError:
            raise click.BadParameter(
                'Using "--cert" requires Python to be compiled with SSL support.',
                ctx,
                param,
            ) from None
```

This guard runs *before* the file/adhoc/import attempts, so on a non-SSL build every `--cert` value fails with the SSL message — even a nonexistent path. That is exactly what `test_run_cert_no_ssl` asserts (see §9), and it matches the historical note in `CHANGES.rst` (lines 732–733):

```
-   The ``flask run`` command no longer fails if Python is not built
    with SSL support. Using the ``--cert`` option will show an
    appropriate error message. :issue:`3211`
```

### 3. Tier 1 — file path, and what actually drives the fallback

```python
        try:
            return self.path_type(value, param, ctx)
        except click.BadParameter:
            value = click.STRING(value, param, ctx).lower()
```

`self.path_type(...)` runs `click.Path.convert` (`click/types.py:924`), where a non-existent file reaches `self.fail(...)`:

```python
    def convert(
        self,
        value: str | os.PathLike[str],
        param: Parameter | None,
        ctx: Context | None,
    ) -> str | bytes | os.PathLike[str]:
        rv = value

        is_dash = self.file_okay and self.allow_dash and rv in (b"-", "-")

        if not is_dash:
            if self.resolve_path:
                rv = os.path.realpath(rv)

            try:
                st = os.stat(rv)
            except OSError:
                if not self.exists:
                    return self.coerce_path_result(rv)
                self.fail(
                    _("{name} {filename!r} does not exist.").format(
                        name=self.name.title(), filename=format_filename(value)
                    ),
                    param,
                    ctx,
                )
```

`self.fail` is `ParamType.fail` (`click/types.py:136–143`), which raises precisely the exception the chain catches:

```python
    def fail(
        self,
        message: str,
        param: Parameter | None = None,
        ctx: Context | None = None,
    ) -> t.NoReturn:
        """Helper method to fail with an invalid value message."""
        raise BadParameter(message, ctx=ctx, param=param)
```

Every later failure mode of `Path.convert` (`not file_okay`, `not dir_okay`, `readable`, `writable`, `executable` — `click/types.py:955–991`) likewise calls `self.fail(...)`, so **any** path-validation failure raises `click.BadParameter` and lands in the `except` branch. Success returns a resolved absolute path via `resolve_path=True` — confirmed by probe 1 in the executor run ("Tier 1 returns resolved abs path → `str`, `isabs=True`, `== realpath`, exists").

Because Tier 1 is attempted first, it wins even when the value also names a valid module (probe 2: an existing file `os.py` returned the path, not the `os` module).

### 4. Normalization

```python
            value = click.STRING(value, param, ctx).lower()
```

The value is coerced to a lower-cased string before the `"adhoc"` comparison and before the import. Consequence, verified by probe 8: an import path containing uppercase characters cannot be imported as written (`mixedcase.SomeContext` → `File 'mixedcase.SomeContext' does not exist.`), whereas an all-lowercase path resolves (`lowercase.actx` → `SSLContext`).

### 5. Tier 2 — `"adhoc"`

```python
            if value == "adhoc":
                try:
                    import cryptography  # noqa: F401
                except ImportError:
                    raise click.BadParameter(
                        "Using ad-hoc certificates requires the cryptography library.",
                        ctx,
                        param,
                    ) from None

                return value
```

When the lower-cased value is `"adhoc"`, the code only checks that `cryptography` is *importable* (not its version or any functionality), raising a dedicated `BadParameter` if not, and otherwise returning `"adhoc"`. This matches the historical note in `CHANGES.rst` (lines 558–559):

```
-   When using ad-hoc certificates, check for the cryptography library
    instead of PyOpenSSL. :pr:`3492`
```

Probe 3 confirmed case-insensitivity (`adhoc`/`ADHOC`/`AdHoc` all → `'adhoc'`); probe 4 confirmed the guard (`sys.modules["cryptography"] = None` → `BadParameter: ...requires the cryptography library.`; a dummy module → `'adhoc'`).

### 6. Tier 3 — importing an `SSLContext`, and the bare `raise`

```python
            obj = import_string(value, silent=True)

            if isinstance(obj, ssl.SSLContext):
                return obj

            raise
```

`import_string` is the Werkzeug helper (`werkzeug/utils.py:580`), which accepts dotted notation or `module:attr` notation and returns `None` on failure when `silent=True`:

```python
def import_string(import_name: str, silent: bool = False) -> t.Any:
    """Imports an object based on a string.  This is useful if you want to
    use import paths as endpoints or something similar.  An import path can
    be specified either in dotted notation (``xml.sax.saxutils.escape``)
    or with a colon as object delimiter (``xml.sax.saxutils:escape``).

    If `silent` is True the return value will be `None` if the import fails.

    :param import_name: the dotted name for the object to import.
    :param silent: if set to `True` import errors are ignored and
                   `None` is returned instead.
    :return: imported object
    """
    import_name = import_name.replace(":", ".")
    try:
        try:
            __import__(import_name)
        except ImportError:
            if "." not in import_name:
                raise
        else:
            return sys.modules[import_name]

        module_name, obj_name = import_name.rsplit(".", 1)
        module = __import__(module_name, globals(), locals(), [obj_name])
        try:
            return getattr(module, obj_name)
        except AttributeError as e:
            raise ImportError(e) from None

    except ImportError as e:
        if not silent:
            raise ImportStringError(import_name, e).with_traceback(
                sys.exc_info()[2]
            ) from None

    return None
```

If the imported object is an `ssl.SSLContext` instance, it is returned as-is (probe 5 confirmed identity is preserved: `r is ctxobj` → `True`). Otherwise the code executes an **argument-less `raise`**, which Python interprets as "re-raise the exception currently being handled" — i.e. the Tier-1 `click.BadParameter` from line 804 that the `except click.BadParameter:` block caught. So a missing import (`not_here`) and a valid-but-wrong import (`flask`, a module rather than an `SSLContext`) both surface the same path-shaped diagnostic (probe 6: `File 'not_here' does not exist.` / `File 'flask' does not exist.`).

Two precision points, both verified:

- **The re-raised message says `File '...'`, not `Path '...'`.** The internal `path_type` is `click.Path(file_okay=True, dir_okay=False, ...)` whose `__init__` sets `self.name = _("file")` (`click/types.py:892–898`: `if self.file_okay and not self.dir_okay: self.name: str = _("file")`). `CertParamType.name = "path"` is a separate attribute of the outer type and does not affect the message.
- **`silent=True` swallows inner `ImportError`s too** — an `ImportError` raised *inside* the target module is caught by `import_string`'s `except ImportError` and becomes `None`, hence "not a certificate". Probe 11 demonstrated this with a real module that raises `ImportError` at import time: `import_string(..., silent=True)` → `None`; `silent=False` → `ImportStringError`; through `convert` → `File 'innermod' does not exist.`

### 7. Post-processing — `_validate_key`

The `--key` option carries the callback `_validate_key` (`src/flask/cli.py:828–864`, verbatim):

```python
def _validate_key(ctx: click.Context, param: click.Parameter, value: t.Any) -> t.Any:
    """The ``--key`` option must be specified when ``--cert`` is a file.
    Modifies the ``cert`` param to be a ``(cert, key)`` pair if needed.
    """
    cert = ctx.params.get("cert")
    is_adhoc = cert == "adhoc"

    try:
        import ssl
    except ImportError:
        is_context = False
    else:
        is_context = isinstance(cert, ssl.SSLContext)

    if value is not None:
        if is_adhoc:
            raise click.BadParameter(
                'When "--cert" is "adhoc", "--key" is not used.', ctx, param
            )

        if is_context:
            raise click.BadParameter(
                'When "--cert" is an SSLContext object, "--key" is not used.',
                ctx,
                param,
            )

        if not cert:
            raise click.BadParameter('"--cert" must also be specified.', ctx, param)

        ctx.params["cert"] = cert, value

    else:
        if cert and not (is_adhoc or is_context):
            raise click.BadParameter('Required when using "--cert".', ctx, param)

    return value
```

The branches:

- `--key` **given** and cert is `"adhoc"` → `BadParameter('When "--cert" is "adhoc", "--key" is not used.')`.
- `--key` **given** and cert is an `ssl.SSLContext` → `BadParameter('When "--cert" is an SSLContext object, "--key" is not used.')`.
- `--key` **given** and no cert at all → `BadParameter('"--cert" must also be specified.')`.
- `--key` **given** and cert is a file path → `ctx.params["cert"] = cert, value`, i.e. rewrite into the `(cert, key)` tuple.
- `--key` **not given** and cert is present but is neither `"adhoc"` nor an `SSLContext` → `BadParameter('Required when using "--cert".')`.

Two wiring details make this work regardless of option order (`src/flask/cli.py:883–896`):

```python
@click.command("run", short_help="Run a development server.")
@click.option("--host", "-h", default="127.0.0.1", help="The interface to bind to.")
@click.option("--port", "-p", default=5000, help="The port to bind to.")
@click.option(
    "--cert",
    type=CertParamType(),
    help="Specify a certificate file to use HTTPS.",
    is_eager=True,
)
@click.option(
    "--key",
    type=click.Path(exists=True, dir_okay=False, resolve_path=True),
    callback=_validate_key,
    expose_value=False,
    help="The key file to use when specifying a certificate.",
)
```

`--cert` is `is_eager=True`, so it is converted before `--key`'s callback runs (hence `ctx.params.get("cert")` is already populated); `--key` is `expose_value=False`, so it is never surfaced as its own parameter — it is folded into `ctx.params["cert"]`. This is the mechanism behind the "either order" change in `CHANGES.rst` (lines 370–371):

```
-   The ``--cert`` and ``--key`` options on ``flask run`` can be given
    in either order. :issue:`4459`
```

Probes 9 and 10 confirmed every branch and that both option orders produce the identical `(cert, key)` tuple.

### 8. Delivery

The validated value flows into the dev server (`src/flask/cli.py:984–995`):

```python
    run_simple(
        host,
        port,
        app,
        use_reloader=reload,
        use_debugger=debugger,
        threaded=with_threads,
        ssl_context=cert,
        extra_files=extra_files,
        exclude_patterns=exclude_patterns,
    )
```

All three produced shapes are exactly what Werkzeug accepts. `run_simple`'s parameter is typed `_TSSLContextArg` (`werkzeug/serving.py:83–85`):

```python
_TSSLContextArg = t.Optional[
    t.Union["ssl.SSLContext", tuple[str, t.Optional[str]], t.Literal["adhoc"]]
]
```

and its docstring (`serving.py:1026–1029`) says:

```
    :param ssl_context: Configure TLS to serve over HTTPS. Can be an
        :class:`ssl.SSLContext` object, a ``(cert_file, key_file)``
        tuple to create a typical context, or the string ``'adhoc'`` to
        generate a temporary self-signed certificate.
```

The dispatch (`werkzeug/serving.py:799–806`) consumes them directly:

```python
        if ssl_context is not None:
            if isinstance(ssl_context, tuple):
                ssl_context = load_ssl_context(*ssl_context)
            elif ssl_context == "adhoc":
                ssl_context = generate_adhoc_ssl_context()

            self.socket = ssl_context.wrap_socket(self.socket, server_side=True)
            self.ssl_context: ssl.SSLContext | None = ssl_context
```

So: `(cert, key)` tuple → `load_ssl_context`, `"adhoc"` → `generate_adhoc_ssl_context()`, and an `SSLContext` → used as-is.

### 9. Tests that pin the behavior

The four tests (`tests/test_cli.py:584–647`, verbatim):

```python
def test_run_cert_path():
    # no key
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", __file__])

    # no cert
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--key", __file__])

    # cert specified first
    ctx = run_command.make_context("run", ["--cert", __file__, "--key", __file__])
    assert ctx.params["cert"] == (__file__, __file__)

    # key specified first
    ctx = run_command.make_context("run", ["--key", __file__, "--cert", __file__])
    assert ctx.params["cert"] == (__file__, __file__)


def test_run_cert_adhoc(monkeypatch):
    monkeypatch.setitem(sys.modules, "cryptography", None)

    # cryptography not installed
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "adhoc"])

    # cryptography installed
    monkeypatch.setitem(sys.modules, "cryptography", types.ModuleType("cryptography"))
    ctx = run_command.make_context("run", ["--cert", "adhoc"])
    assert ctx.params["cert"] == "adhoc"

    # no key with adhoc
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "adhoc", "--key", __file__])


def test_run_cert_import(monkeypatch):
    monkeypatch.setitem(sys.modules, "not_here", None)

    # ImportError
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "not_here"])

    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "flask"])

    # SSLContext
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)

    monkeypatch.setitem(sys.modules, "ssl_context", ssl_context)
    ctx = run_command.make_context("run", ["--cert", "ssl_context"])
    assert ctx.params["cert"] is ssl_context

    # no --key with SSLContext
    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "ssl_context", "--key", __file__])


def test_run_cert_no_ssl(monkeypatch):
    monkeypatch.setitem(sys.modules, "ssl", None)

    with pytest.raises(click.BadParameter):
        run_command.make_context("run", ["--cert", "not_here"])
```

Mapping to the chain:

- `test_run_cert_path` — Tier 1 plus the `(cert, key)` tuple from `_validate_key`, in both option orders.
- `test_run_cert_adhoc` — Tier 2, the `cryptography` guard (presence check only, monkeypatched via `sys.modules`), and `--key` rejection for adhoc.
- `test_run_cert_import` — Tier 3: `not_here` (failed import) and `flask` (bare module, not an `SSLContext`) both raise; `ssl_context` returns the object with identity `ctx.params["cert"] is ssl_context`; `--key` rejected for an `SSLContext`.
- `test_run_cert_no_ssl` — Guard 0: with `sys.modules["ssl"] = None`, even `--cert not_here` raises `BadParameter`, proving the SSL import guard precedes the fallback.

---

## Summary chain

| Input | Tier that handles it | Output |
|---|---|---|
| Existing file (non-directory) | Tier 1 — `path_type` | Resolved absolute path `str` (later `(cert, key)` tuple if `--key`) |
| `adhoc`, any case, `cryptography` importable | Tier 2 | `"adhoc"` |
| `adhoc` without `cryptography` | Tier 2 guard | `BadParameter: Using ad-hoc certificates requires the cryptography library.` |
| Importable `SSLContext` (lowercase path) | Tier 3 | `ssl.SSLContext` object (identity preserved) |
| Anything else / failed import / non-context import | Tier 3 fallthrough | Re-raised Tier-1 `BadParameter: File '<name>' does not exist.` |
| Any value when `ssl` cannot be imported | Guard 0 | `BadParameter: Using "--cert" requires Python to be compiled with SSL support.` |

**Why the bare `raise` matters:** `import_string(value, silent=True)` deliberately converts every `ImportError` into `None`, so no import-specific diagnostic is ever constructed. The argument-less `raise` re-raises the original Tier-1 path error, which is therefore the single, shared failure message for both "file missing" and "not an `SSLContext`" cases. A further consequence is that a legitimate `ImportError` raised inside the target module is also swallowed and reported as `File '<name>' does not exist.`, and that uppercase characters in an import path make the import impossible because the value was lower-cased in step 4.

## Verification runs (executor, verbatim results)

The executor confirmed all of the above against the local checkout (git HEAD `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`, python 3.13.9, pytest 8.4.0, click 8.2.1), running tests with `PYTHONPATH=src`. Source anchors confirmed: `def convert` at line 791, `return self.path_type(...)` at 804, `obj = import_string(value, silent=True)` at 820, the bare `raise` at 825, `def _validate_key` at 828; `import_string` at `werkzeug/utils.py:580`; `ParamType.fail` at `click/types.py:136`; `Path.convert` at `click/types.py:924`; `run_simple`'s `ssl_context` at `werkzeug/serving.py:976` with dispatch at `799–806`.

Test runs:

```
tests/test_cli.py::test_run_cert_path PASSED
test_run_cert_adhoc PASSED | test_run_cert_import PASSED | test_run_cert_no_ssl PASSED
=> 4 passed, EXIT 0
```

```
tests/test_cli.py: 58 passed in 1.22s          EXIT 0
tests/ (full):     489 passed in 6.06s          EXIT 0
```

```
tests/test_cli.py -vv -rA --tb=long --durations=0 → 58 passed in 1.18s, EXIT 0
tests/ -vv -rA --tb=long                          → 489 passed in 5.90s, EXIT 0
```

Twelve behavioral probes (all EXIT 0) confirmed: Tier-1 resolsolution/precedence, adhoc case-insensitivity and cryptography guard, `SSLContext` identity, the re-raised `File '...' does not exist.` message, the SSL guard firing for every value, lower-casing before import, all `_validate_key` branches in both option orders, silent-import behavior for inner `ImportError`s, and downstream delivery.

**One correction to the upstream evidence worth flagging:** the earlier evidence text claimed the re-raised message is `Path 'not_here' does not exist.` That is wrong. Because the internal `click.Path` has `file_okay=True, dir_okay=False`, its `__init__` sets `self.name = _("file")` (`click/types.py:892–898`, read verbatim above), so the actual message is `File 'not_here' does not exist.`, as the executor's probe directly observed. All other evidence anchors were verified as-is, with two line-number refinements: `def _validate_key` is at line 828 (not 827), and the option block is 884–896 (not 884–899).

The `flask_mut2_i417ar2x/mutated_test.py` file in the repository is unrelated to this question (it concerns `subdomain_matching`/`url_for`, with no `cert`, `ssl`, or CLI content) and was excluded from all evidence.
# Why `test_existing_handler` asserts that `app.logger.handlers` is empty

## Short answer

Because Flask deliberately adds its `default_handler` to the app logger **only when nothing already in that logger's propagation chain can handle its effective level**. A fresh `logging.StreamHandler()` added to the root logger has level `NOTSET` (= 0), which satisfies `handler.level <= logger.getEffectiveLevel()`, so `has_level_handler(app.logger)` returns `True`. That makes `create_logger` skip `logger.addHandler(default_handler)` entirely, leaving `app.logger.handlers == []`. The empty list therefore *is* the assertion of the behavior under test: Flask sees an ancestor handler and stays out of the way rather than installing a second handler. The app logger's records then propagate up to the root handler and are handled exactly once.

## The test and the code it exercises

`tests/test_logging.py`, lines 48–51 (verified verbatim by reading the file):

```python
def test_existing_handler(app):
    logging.root.addHandler(logging.StreamHandler())
    assert app.logger.level == logging.NOTSET
    assert not app.logger.handlers
```

`src/flask/logging.py` — the whole decision chain (verified verbatim by reading the file):

```python
def has_level_handler(logger: logging.Logger) -> bool:
    """Check if there is a handler in the logging chain that will handle the
    given logger's :meth:`effective level <~logging.Logger.getEffectiveLevel>`.
    """
    level = logger.getEffectiveLevel()
    current = logger

    while current:
        if any(handler.level <= level for handler in current.handlers):
            return True

        if not current.propagate:
            break

        current = current.parent  # type: ignore

    return False
```

```python
default_handler = logging.StreamHandler(wsgi_errors_stream)  # type: ignore
default_handler.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s in %(module)s: %(message)s")
)
```

```python
def create_logger(app: App) -> logging.Logger:
    """Get the Flask app's logger and configure it if needed.

    The logger name will be the same as
    :attr:`app.import_name <flask.Flask.name>`.

    When :attr:`~flask.Flask.debug` is enabled, set the logger level to
    :data:`logging.DEBUG` if it is not set.

    If there is no handler for the logger's effective level, add a
    :class:`~logging.StreamHandler` for
    :func:`~flask.logging.wsgi_errors_stream` with a basic format.
    """
    logger = logging.getLogger(app.name)

    if app.debug and not logger.level:
        logger.setLevel(logging.DEBUG)

    if not has_level_handler(logger):
        logger.addHandler(default_handler)

    return logger
```

The app logger is created by this function. `src/flask/sansio/app.py:28` imports it (`from ..logging import create_logger`) and lines 442–467 define the property:

```python
    @cached_property
    def logger(self) -> logging.Logger:
        """A standard Python :class:`~logging.Logger` for the app, with
        the same name as :attr:`name`.

        In debug mode, the logger's :attr:`~logging.Logger.level` will
        be set to :data:`~logging.DEBUG`.

        If there are no handlers configured, a default handler will be
        added. See :doc:`/logging` for more information.

        .. versionchanged:: 1.1.0
            The logger takes the same name as :attr:`name` rather than
            hard-coding ``"flask.app"``.

        .. versionchanged:: 1.0.0
            Behavior was simplified. The logger is always named
            ``"flask.app"``. The level is only set during configuration,
            it doesn't check ``app.debug`` each time. Only one format is
            used, not different ones depending on ``app.debug``. No
            handlers are removed, and a handler is only added if no
            handlers are already configured.

        .. versionadded:: 0.3
        """
        return create_logger(self)
```

That docstring is the invariant the test encodes: *"No handlers are removed, and a handler is only added if no handlers are already configured."*

## The mechanism, step by step

The `app` fixture in `tests/conftest.py` (lines 44–51) names the app `"flask_test"`, so `app.logger` is `logging.getLogger("flask_test")`:

```python
@pytest.fixture
def app():
    app = Flask("flask_test", root_path=os.path.dirname(__file__))
    app.config.update(
        TESTING=True,
        SECRET_KEY="test key",
    )
    return app
```

The autouse `reset_logging` fixture (lines 12–33) clears the root logger's handlers and resets `logging.getLogger("flask_test")` before each test, but it does **not** change `logging.root.level` — it only saves `root_level` and restores it afterwards:

```python
@pytest.fixture(autouse=True)
def reset_logging(pytestconfig):
    root_handlers = logging.root.handlers[:]
    logging.root.handlers = []
    root_level = logging.root.level

    logger = logging.getLogger("flask_test")
    logger.handlers = []
    logger.setLevel(logging.NOTSET)

    logging_plugin = pytestconfig.pluginmanager.unregister(name="logging-plugin")

    yield

    logging.root.handlers[:] = root_handlers
    logging.root.setLevel(root_level)

    logger.handlers = []
    logger.setLevel(logging.NOTSET)

    if logging_plugin:
        pytestconfig.pluginmanager.register(logging_plugin, "logging-plugin")
```

So at the start of `test_existing_handler`: root has no handlers but its default level (WARNING = 30), and the `"flask_test"` logger has no handlers, level `NOTSET`, `propagate=True`. The test then adds a fresh handler to root, and finally touches `app.logger` (triggering the `cached_property` → `create_logger`).

Evaluation inside `has_level_handler(app.logger)`:

- `level = logger.getEffectiveLevel()` = 30. The logger's *own* `level` is `NOTSET` (0), but since it has no level of its own it inherits the root's effective level, 30. (The test's other assertion, `app.logger.level == logging.NOTSET`, is about the logger's own level, not its effective level.)
- Iteration 1: `current = "flask_test"`, `current.handlers == []`, so `any(handler.level <= 30 ...)` is `False`; `propagate` is `True`, so the walk continues to `current.parent` = root.
- Iteration 2: root's handler is a fresh `logging.StreamHandler()`, whose level defaults to `logging.NOTSET` = 0. `0 <= 30` is `True`, so `has_level_handler` returns `True`.

Back in `create_logger`, `if not has_level_handler(logger):` is `if not True:` → the `logger.addHandler(default_handler)` line is **not executed**. Hence `app.logger.handlers == []` and `assert not app.logger.handlers` passes.

This was confirmed at runtime. The executor's reproduction printed:

```
=== Case 2: StreamHandler on root ===
root_handler.level = 0 (NOTSET==0)
has_level_handler BEFORE create_logger = True
has_level_handler AFTER  create_logger = True
logger.level = 0 | getEffectiveLevel = 30 | root.level = 30 | propagate = True
logger.handlers = []
(not logger.handlers) = True
```

and the manual parent-chain walk reproduced the loop exactly:

```
=== Manual parent-chain walk ===
step 1: current='flask_test' handlers=[] any(h.level <= 30)=False propagate=True
step 2: current='root' handlers=[<StreamHandler <stderr> (NOTSET)>] any(h.level <= 30)=True propagate=True
  -> returns True
```

The contrast case (no handler anywhere) printed the opposite, matching `test_logger`:

```
=== Case 1: no root handler ===
has_level_handler BEFORE create_logger = False
has_level_handler AFTER  create_logger = True
logger.level = 0 | getEffectiveLevel = 30 | root.level = 30 | propagate = True
logger.handlers = [<StreamHandler <stderr> (NOTSET)>]
logger.handlers == [default_handler]: True
```

The executor also isolated each condition in `has_level_handler`:

```
A) root handler level=NOTSET(0), eff= 30 -> has_level_handler = True
   handlers after create_logger = []
B) root handler level=ERROR(40), eff= 30 -> has_level_handler = False
   handlers after create_logger = [<StreamHandler <stderr> (NOTSET)>]
C) root handler NOTSET, logger.propagate=False, eff= 30 -> has_level_handler = False
   handlers after create_logger = [<StreamHandler <stderr> (NOTSET)>]
D) debug=True, root handler NOTSET, eff(before)= 30 -> has_level_handler = True
   logger.level = 10 eff = 10 handlers = []
```

Variant B shows that raising the root handler to `ERROR` flips the decision and the default handler *is* added; variant C shows `propagate=False` breaks the walk; variant D shows debug mode only moves the logger's own level and still adds nothing when an ancestor handler exists. That is precisely the `handler.level <= level` and `propagate` logic in `has_level_handler`.

## The contrast tests prove it is about ancestor handlers, not an accident

`tests/test_logging.py`, lines 36–45:

```python
def test_logger(app):
    assert app.logger.name == "flask_test"
    assert app.logger.level == logging.NOTSET
    assert app.logger.handlers == [default_handler]


def test_logger_debug(app):
    app.debug = True
    assert app.logger.level == logging.DEBUG
    assert app.logger.handlers == [default_handler]
```

In these tests nothing is in the chain, so `has_level_handler` is `False`, `create_logger` *does* add `default_handler`, and the assertion is `app.logger.handlers == [default_handler]`. The only difference between them and `test_existing_handler` is the root handler. And `test_has_level_handler` (lines 70–83) unit-tests the predicate directly, including the `propagate` switch:

```python
def test_has_level_handler():
    logger = logging.getLogger("flask.app")
    assert not has_level_handler(logger)

    handler = logging.StreamHandler()
    logging.root.addHandler(handler)
    assert has_level_handler(logger)

    logger.propagate = False
    assert not has_level_handler(logger)
    logger.propagate = True

    handler.setLevel(logging.ERROR)
    assert not has_level_handler(logger)
```

Three commands confirm all of this in the checked-out tree (executed from the working directory with `PYTHONPATH=src` so the local `src/flask` is imported):

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_logging.py::test_existing_handler -q
.                                                                        [100%]
1 passed in 0.05s
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_logging.py::test_logger -q
.                                                                        [100%]
1 passed in 0.06s
```

```
$ PYTHONPATH=src .venv/Scripts/python.exe -m pytest tests/test_logging.py -vv -rA -s
============================= test session starts =============================
platform win32 -- Python 3.13.9, pytest-8.4.0, pluggy-1.6.0 -- C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q3-TXT\seal\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q3-TXT\seal
configfile: pyproject.toml
collecting ... collected 6 items

tests/test_logging.py::test_logger <- D:\...\tests\test_logging.py PASSED
tests/test_logging.py::test_logger_debug <- D:\...\tests\test_logging.py PASSED
tests/test_logging.py::test_existing_handler <- D:\...\tests\test_logging.py PASSED
tests/test_logging.py::test_wsgi_errors_stream <- D:\...\tests\test_logging.py PASSED
tests/test_logging.py::test_has_level_handler <- D:\...\tests\test_logging.py PASSED
tests/test_logging.py::test_log_view_exception <- D:\...\tests\test_logging.py PASSED

=================================== PASSES ====================================
=========================== short test summary info ===========================
PASSED tests/test_logging.py::test_logger
PASSED tests/test_logging.py::test_logger_debug
PASSED tests/test_logging.py::test_existing_handler
PASSED tests/test_logging.py::test_wsgi_errors_stream
PASSED tests/test_logging.py::test_has_level_handler
PASSED tests/test_logging.py::test_log_view_exception
============================== 6 passed in 0.10s ==============================
```

## Why the design behaves this way

The rationale is double-logging avoidance plus honoring user configuration. `has_level_handler` is flock-aware: it checks the *logging chain*, not just the logger's own `handlers` list. If the user has already installed a handler on the root logger that can see the app logger's messages (which it can, because the app logger propagates), then adding Flask's `default_handler` to `app.logger` too would make every record handled twice — once by `default_handler` and once by the user's root handler. The test asserts the empty list to lock in that Flask does not do this.

This matches the documented usage pattern in `docs/logging.rst` ("Other Libraries", lines 144–167), which explicitly recommends adding handlers to the root logger instead of the app logger:

```rst
Other Libraries
---------------

Other libraries may use logging extensively, and you want to see relevant
messages from those logs too. The simplest way to do this is to add handlers
to the root logger instead of only the app logger. ::

    from flask.logging import default_handler

    root = logging.getLogger()
    root.addHandler(default_handler)
    root.addHandler(mail_handler)
```

The same document notes in "Basic Configuration": *"If `app.logger` is accessed before logging is configured, it will add a default handler. If possible, configure logging before creating the application object."* — i.e., configure-the-root-first is the supported way to pre-empt Flask's own handler, and `test_existing_handler` verifies that this pre-emption actually works. The corresponding historical note is in `CHANGES.rst` for Flask 1.0:

```rst
-   ``Flask.logger`` has been simplified. ``LOGGER_NAME`` and
    ``LOGGER_HANDLER_POLICY`` config was removed. The logger is always
    named ``flask.app``. The level is only set on first access, it
    doesn't check ``Flask.debug`` each time. Only one format is used,
    not different ones depending on ``Flask.debug``. No handlers are
    removed, and a handler is only added if no handlers are already
    configured. :pr:`2436`
```

The source contains no counteracting logic: greps across `src/flask` show the only reads/writes of handlers are `src/flask/logging.py:39` (the read inside `has_level_handler`) and `src/flask/logging.py:77` (`logger.addHandler(default_handler)`), with no `removeHandler` and no `handlers = []` assignment anywhere in the Flask source, and exactly one definition each of `def has_level_handler` (`src/flask/logging.py:31`) and `def create_logger` (`src/flask/logging.py:58`).

## Bottom line

`assert not app.logger.handlers` in `test_existing_handler` is not incidental — it is the positive assertion that `has_level_handler(app.logger)` returned `True` because the freshly added root `StreamHandler` has level `NOTSET` (0) ≤ the app logger's effective level, so `create_logger`'s `if not has_level_handler(logger): logger.addHandler(default_handler)` branch was skipped. It verifies that when a handler already exists anywhere up the propagation chain, Flask does not install its own default handler on `app.logger`, letting records propagate to the root handler instead — the propagation-aware, non-duplicating behavior documented in `docs/logging.rst` and stated in the `logger` property's docstring ("a handler is only added if no handlers are already configured"). Its siblings `test_logger` / `test_logger_debug` assert `app.logger.handlers == [default_handler]` precisely because no handler exists in their chains, confirming that the empty list in `test_existing_handler` is caused by the root handler and nothing else.
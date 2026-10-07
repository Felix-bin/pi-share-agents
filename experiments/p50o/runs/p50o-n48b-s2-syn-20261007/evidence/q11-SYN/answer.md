## Why `assert not app.logger.handlers` after adding a root handler

The assertion is the observable proof that Flask *declines* to install its default handler when one already exists anywhere up the propagation chain — it pins the "only add a handler if no handlers are already configured" contract of `create_logger`.

The chain, verified end to end:

1. `app.logger` is a `cached_property` that returns `create_logger(self)` (`src/flask/sansio/app.py:442-467`).
2. `create_logger` attaches the shared default only conditionally (`src/flask/logging.py:76-77`):
   ```python
   if not has_level_handler(logger):
       logger.addHandler(default_handler)
   ```
3. `has_level_handler` (`src/flask/logging.py:31-47`) takes the logger's `getEffectiveLevel()`, then walks the logger and, while `propagate` is true, each parent, returning `True` if any handler in that chain has `handler.level <= level`.
4. In the test (`tests/test_logging.py:48-51`) the autouse `reset_logging` fixture has already emptied `logging.root.handlers` and the `flask_test` logger's handlers, and reset the logger level to `NOTSET` (`tests/test_logging.py:11-31`). The `app` fixture never touches `.logger` (`tests/conftest.py:45-51`), so the root handler added at line 49 is in place *before* `app.logger` is first evaluated.
5. A bare `logging.StreamHandler()` has level `NOTSET` (0), and line 50 asserts the app logger's level is also `NOTSET` (0), so its effective level is 0 and `0 <= 0` makes `has_level_handler(app.logger)` return `True`. `create_logger` therefore skips `logger.addHandler(default_handler)`, and the app logger's own `handlers` list stays empty — which is exactly what line 51 asserts.

Why it matters — the failure it guards against. The documented supported pattern is to add handlers to the root logger so other libraries' logs are seen too (`docs/logging.rst:149-156`: `root = logging.getLogger(); root.addHandler(default_handler)`). Because the app logger's records propagate to root, a user who configures the root logger already gets those records emitted. If Flask nevertheless appended `default_handler`, the same record would be emitted twice (the app logger's own handler *and* the root's), and Flask would be silently overriding an explicit user configuration. The empty list is the test's way of saying: Flask detected the existing handler and added nothing.

The assertion is deliberately the mirror image of neighboring tests. With no root handler present, `test_logger` (`:36-39`) and `test_logger_debug` (`:42-45`) assert `app.logger.handlers == [default_handler]`; `test_existing_handler` is the negative case of the same contract. The helper that decides this has its own direct unit test, `test_has_level_handler` (`:70-83`), which confirms the behaviour is intended: no root handler → `not has_level_handler(logger)`; after `logging.root.addHandler(handler)` → `True`; `logger.propagate = False` → `False` again; `handler.setLevel(logging.ERROR)` → `False`. `default_handler` itself is a single module-level `logging.StreamHandler(wsgi_errors_stream)` (`src/flask/logging.py:52`), so "the app logger added the default" is exactly equivalent to "`handlers` is non-empty" in this test — the test never adds anything else to the app logger.

Two qualifications the evidence supports:

- `has_level_handler` would return `False` — inverting the rationale — if the root handler carried an explicit level above the app logger's effective level (that is precisely the last case in `test_has_level_handler`). The test passes specifically because the added handler is a bare, `NOTSET` `StreamHandler` and the app logger's level is `NOTSET`.
- The stated rationale explains why Flask adds nothing; it does not explain why the assertion is phrased as a fully empty list rather than, say, `default_handler not in app.logger.handlers`. No test comment, changelog entry or docstring addresses that phrasing choice, and no history/blame was inspected — that part of the "why" is not established.

## What this rests on

- `tests/test_logging.py:48-51` (test body), `:36-39`/`:42-45` (mirror assertions), `:11-31` (`reset_logging`), `:70-83` (`test_has_level_handler`).
- `src/flask/logging.py:31-47` (`has_level_handler`), `:52` (`default_handler`), `:59-79` (`create_logger`, condition at `:76-77`).
- `src/flask/sansio/app.py:442-467` (`app.logger` cached property → `create_logger`), `tests/conftest.py:45-51` (app fixture).
- `docs/logging.rst:149-156` (root-logger pattern).

## Still open

- Why the assertion is worded as an empty list rather than a check excluding `default_handler` — no comment, docstring, changelog or history evidence found.
- Whether the test is kept in this exact form is a maintainer judgement, not something this evidence settles.
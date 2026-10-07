## Where the root path is transformed

The swap happens inside **`Flask.make_config`**, in the shared `sansio` application base, at **`src/flask/sansio/app.py:491–493`**:

```
491  root_path = self.root_path
492  if instance_relative:
493      root_path = self.instance_path
```

The transformed value is a local variable (`root_path`) that is never written back to `self.root_path`; it is handed directly to the configuration storage object on the method's return line, `src/flask/sansio/app.py:496`: `return self.config_class(root_path, defaults)`. `self.config_class` is bound once to `Config` at `src/flask/sansio/app.py:196` (`config_class = Config`), so the receiver is `flask.config.Config`.

The path into that method, verified end to end:

1. `Flask.__init__` (`src/flask/app.py`) declares `instance_relative_config: bool = False` at line 236 and forwards it verbatim to the parent at line 248 (`instance_relative_config=instance_relative_config`).
2. The shared `App.__init__` receives the same flag (`src/flask/sansio/app.py:292`) and calls `self.config = self.make_config(instance_relative_config)` at `src/flask/sansio/app.py:319` — i.e. the transform runs during initialization, before any config object exists.
3. `make_config` (`src/flask/sansio/app.py:482`) does the swap; its docstring (lines 483–487) states the parameter "indicates if the config should be relative to the instance path or the root path of the application", confirming the choice of path is made here.
4. `Config.__init__` (`src/flask/config.py:94–98`) takes `root_path` as its first parameter and stores it unchanged as `self.root_path` (`src/flask/config.py:100`). It performs no further transformation — it receives an already-swapped value.
5. The stored path is what later joins relative filenames: `os.path.join(self.root_path, filename)` in `from_pyfile` (`src/flask/config.py:204`) and `from_file` (`src/flask/config.py:290`). This is the observable effect of the transform (the causal reading is inference from these two join sites, not an executed test).

So: **`Flask.make_config`, `src/flask/sansio/app.py:491–493`, invoked from `App.__init__` at `src/flask/sansio/app.py:319`, with the result passed to `Config.__init__` (`src/flask/config.py:94–100`).**

Related but distinct: `self.instance_path` itself (the value substituted in) is resolved earlier in `App.__init__` — `src/flask/sansio/app.py:302–304` via `auto_find_instance_path()` when `instance_path` is `None`, otherwise the supplied absolute path is validated. That is path *computation*, not the config-mode transform, and its implementation inside the parent class was not read.

## What this rests on, and what is open

Rests on: direct reads of `src/flask/sansio/app.py` (lines 295–324, 482–496 and greps for `instance_relative`, `make_config`, `config_class`), `src/flask/config.py:94–100`, and `src/flask/app.py:236/248`. The retriever's cited line numbers were re-checked against the files and match; no contradiction appeared between the planner's stated expectation and the retrieved evidence.

Open / not established:
- No subclass anywhere in the worktree overrides `make_config` or `config_class` (only `src/flask/sansio/app.py:196` defines `config_class = Config`; `tests/test_config.py:198–203` re-declares it as `Config` without overriding `make_config`), so the transform is single-sited in this worktree. Overrides introduced outside it would not be visible here.
- The single-sited claim applies to `src/flask/` as source; whether an installed/running Flask matches these lines was not checked.
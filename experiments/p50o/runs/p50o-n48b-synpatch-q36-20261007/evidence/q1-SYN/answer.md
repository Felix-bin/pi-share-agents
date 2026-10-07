# Where the root path is transformed

The transformation happens in `SansioFlask.make_config` (`src/flask/sansio/app.py:482`), which substitutes the application's root path with its instance path *only* when instance-relative mode is on, one statement before the configuration storage object is constructed. Verified against the file (grep-confirmed line numbers):

```python
# src/flask/sansio/app.py:491-496
root_path = self.root_path
if instance_relative:
    root_path = self.instance_path
defaults = dict(self.default_config)
defaults["DEBUG"] = get_debug_flag()
return self.config_class(root_path, defaults)
```

- **Transformation:** line 491 seeds `root_path` from `self.root_path`; line 493 replaces it with `self.instance_path`, guarded by `if instance_relative:` on line 492. Observed in `src/flask/sansio/app.py:491-493`.
- **Hand-off to the storage object:** the (possibly substituted) `root_path` is passed as the first positional argument at line 496, `self.config_class(root_path, defaults)`, with `config_class = Config` at `src/flask/sansio/app.py:196`. Observed.
- **Destination:** `Config.__init__(self, root_path, defaults=None)` stores it as `self.root_path = root_path` (`src/flask/config.py:100`), and that attribute is what loaders join filenames against — `filename = os.path.join(self.root_path, filename)` in `from_pyfile` (`src/flask/config.py:204`) and in the JSON loader (`src/flask/config.py:290`). Observed.

The flag's path to that point, also observed:

- `Flask.__init__(..., instance_relative_config: bool = False, ...)` declares the public parameter (`src/flask/app.py:225`) and forwards it as `instance_relative_config=instance_relative_config` into `super().__init__(...)` at `src/flask/app.py:248`.
- `SansioFlask.__init__` declares `instance_relative_config: bool = False` at `src/flask/sansio/app.py:292` and calls the transformation at `src/flask/sansio/app.py:319`: `self.config = self.make_config(instance_relative_config)`.
- The swap source is already populated when `make_config` runs: `self.instance_path = instance_path` is set at `src/flask/sansio/app.py:314`, after `instance_path = self.auto_find_instance_path()` at `:305` for the `None` case and a `ValueError` for a relative explicit path (`:306-310`). So the `make_config` call at `:319` sees a resolved `instance_path`. Observed.
- No competing definition: grep for `make_config|config_class` across `src/flask` returns only `sansio/app.py:196, :319, :482, :496`; `src/flask/app.py` overrides neither, so `Flask.__init__` funnels through the sansio implementation. Observed.
- Docstrings state the intent: the `make_config` docstring says `instance_relative` "indicates if the config should be relative to the instance path or the root path of the application" (`src/flask/sansio/app.py:483-486`), and `Config`'s `root_path` parameter is documented as the application's `~flask.Flask.root_path` when the config object is created by the application (`src/flask/config.py:88-90`). Observed.

Interpretation adopted, and why: "transformed" is read as the **substitution of the root path by the instance path** under the instance-relative flag. That is the only site in the initialization path gated on that flag, which is the task's stated condition. An alternative reading — normalization of the root path to an absolute path — belongs to `auto_find_instance_path` (`src/flask/sansio/app.py:510`) and `get_root_path` (`src/flask/sansio/scaffold.py:95-100`) and is not specific to instance-relative mode, so it is not the target here.

Contradiction / discrepancy with the collected evidence: the retriever attributed the swap to lines "492-496" with `root_path = self.instance_path` at 492; my direct read and grep place the `if` at 492 and the reassignment at **493**, with the return at 496. The substance is identical (the swap occurs inside `make_config` immediately before `self.config_class(...)`); only the off-by-one line attribution differs. All other cited coordinates (`make_config` at 482, call site 319, `config_class` 196, `Config.__init__` 100, loader joins 204/290) reproduce exactly.

## What this rests on, and what is open

Rests on: direct reads of `src/flask/sansio/app.py` (lines 288-323, 478-502), `src/flask/app.py` (240-253), `src/flask/config.py` (88-105), plus grep confirmation of every cited line number and of the absence of any `make_config`/`config_class` override.

Open / not established: **no test-level confirmation** exists in this worktree — grep for `instance_relative|make_config` under `tests/` returns no matches, and the corpus-ranked `flask/tests/test_instance_config.py` chunk cannot be matched to an existing file here, so the behaviour is established only from source, not from a passing test. The task is answered for the question as asked (the transformation site, its guard, the call site, and the storage object that receives the value). The directory `flask_mut2_i417ar2x/` is unrelated to the initialization path and was not used as evidence.
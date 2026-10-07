## Answer

The root path is transformed **inside `App.make_config()` at `src/flask/sansio/app.py`, lines 491–493** — a purely *local* reassignment of a local variable named `root_path`, guarded by the `instance_relative` flag — and only *after* that reassignment is the value handed to the configuration storage object (`Config`) at line 496. Neither `Config.__init__` nor `Scaffold.__init__` performs the switch, and the app's own `self.root_path` attribute is **never mutated**; only the value passed into `Config` changes.

### The transformation site (verbatim)

`src/flask/sansio/app.py:482–496`:

```python
    def make_config(self, instance_relative: bool = False) -> Config:
        """Used to create the config attribute by the Flask constructor.
        The `instance_relative` parameter is passed in from the constructor
        of Flask (there named `instance_relative_config`) and indicates if
        the config should be relative to the instance path or the root path
        of the application.

        .. versionadded:: 0.8
        """
        root_path = self.root_path
        if instance_relative:
            root_path = self.instance_path
        defaults = dict(self.default_config)
        defaults["DEBUG"] = get_debug_flag()
        return self.config_class(root_path, defaults)
```

Line-by-line:

- **491** — `root_path = self.root_path` (local variable seeded from the application root)
- **492** — `if instance_relative:`
- **493** — `root_path = self.instance_path` ← **the transformation**
- **496** — `return self.config_class(root_path, defaults)` ← transformed value handed to the storage object

Absolute line numbers verified by grep:

```
491:        root_path = self.root_path
493:            root_path = self.instance_path
496:        return self.config_class(root_path, defaults)
```

### The call chain

```
Flask.__init__                     src/flask/app.py:226–250
  └─ super().__init__(...)          forwards instance_relative_config verbatim
       App.__init__                 src/flask/sansio/app.py:282–319
         ├─ super().__init__(...)   Scaffold.__init__  src/flask/sansio/scaffold.py:75–100
         │                            └─ self.root_path = root_path (or get_root_path(), helpers.py:570)
         ├─ self.instance_path = instance_path            (line 314)
         │     (from auto_find_instance_path, app.py:510–521, or the passed absolute path)
         └─ self.config = self.make_config(instance_relative_config)   (line 319)
              App.make_config      src/flask/sansio/app.py:482–496
                ├─ root_path = self.root_path                  (491)
                ├─ if instance_relative: root_path = self.instance_path   (492–493)  ◄── TRANSFORMATION
                └─ return self.config_class(root_path, defaults)          (496)
                     Config.__init__   src/flask/config.py:94–100
                       └─ self.root_path = root_path             (100)   ◄── STORED
```

**`Flask.__init__` performs no transformation** — it only forwards the flag (`src/flask/app.py:226–250`):

```python
    def __init__(
        self,
        import_name: str,
        static_url_path: str | None = None,
        static_folder: str | os.PathLike[str] | None = "static",
        static_host: str | None = None,
        host_matching: bool = False,
        subdomain_matching: bool = False,
        template_folder: str | os.PathLike[str] | None = "templates",
        instance_path: str | None = None,
        instance_relative_config: bool = False,
        root_path: str | None = None,
    ):
        super().__init__(
            import_name=import_name,
            static_url_path=static_url_path,
            static_folder=static_folder,
            static_host=static_host,
            host_matching=host_matching,
            subdomain_matching=subdomain_matching,
            template_folder=template_folder,
            instance_path=instance_path,
            instance_relative_config=instance_relative_config,
            root_path=root_path,
        )
```

`grep -rn "def make_config" src/flask/` returns exactly one match — `src/flask/sansio/app.py:482` — so `Flask` (in `src/flask/app.py`) defines **no override**; the inherited sans-IO `App.make_config` is the code that runs. `grep -n "Config" src/flask/app.py` returns nothing.

**`App.__init__` computes `instance_path` and then routes through `make_config`** (`src/flask/sansio/app.py:295–319`, body):

```python
        super().__init__(
            import_name=import_name,
            static_folder=static_folder,
            static_url_path=static_url_path,
            template_folder=template_folder,
            root_path=root_path,
        )

        if instance_path is None:
            instance_path = self.auto_find_instance_path()
        elif not os.path.isabs(instance_path):
            raise ValueError(
                "If an instance path is provided it must be absolute."
                " A relative path was given instead."
            )

        #: Holds the path to the instance folder.
        #:
        #: .. versionadded:: 0.8
        self.instance_path = instance_path

        #: The configuration dictionary as :class:`Config`.  This behaves
        #: exactly like a regular dictionary but supports additional methods
        #: to load a config from files.
        self.config = self.make_config(instance_relative_config)
```

Grep line numbers: `282: def __init__`, `314: self.instance_path = instance_path`, `319: self.config = self.make_config(instance_relative_config)`, `482: def make_config`.

### The configuration storage object (what it receives and stores)

Selected by the overridable class attribute (`src/flask/sansio/app.py:188–196`):

```python
    #: Defaults to :class:`~flask.Config`.
    #:
    #: Example use cases for a custom class:
    #:
    #: 1. Default values for certain config options.
    #: 2. Access to config values through attributes in addition to keys.
    #:
    #: .. versionadded:: 0.11
    config_class = Config
```

`Config.__init__` (`src/flask/config.py:88–100`) merely stores whatever it is given — it does **not** transform:

```python
    :param root_path: path to which files are read relative from.  When the
                      config object is created by the application, this is
                      the application's :attr:`~flask.Flask.root_path`.
    :param defaults: an optional dictionary of default values
    """

    def __init__(
        self,
        root_path: str | os.PathLike[str],
        defaults: dict[str, t.Any] | None = None,
    ) -> None:
        super().__init__(defaults or {})
        self.root_path = root_path
```

Grep: `src/flask/config.py:94: def __init__`, `src/flask/config.py:100: self.root_path = root_path`. `Config.root_path` is the field that ends up holding the transformed value, and it is what the relative-path loaders consume (`config.py:204` in `from_pyfile`: `filename = os.path.join(self.root_path, filename)`; `config.py:290` in `from_file`).

**The two upstream paths** feeding `make_config`:

- `self.root_path` is set in `Scaffold.__init__` (`src/flask/sansio/scaffold.py:90–100`), which knows nothing about `instance_relative_config`:

```python
        if root_path is None:
            root_path = get_root_path(self.import_name)

        #: Absolute path to the package on the filesystem. Used to look
        #: up resources contained in the package.
        self.root_path = root_path
```

  with `get_root_path` defined at `src/flask/helpers.py:570` (`grep: 570:def get_root_path(import_name: str) -> str:`).

- `self.instance_path` comes from `App.auto_find_instance_path` (`src/flask/sansio/app.py:510–521`) when not supplied, or from the absolute `instance_path` argument:

```python
    def auto_find_instance_path(self) -> str:
        """Tries to locate the instance path if it was not provided to the
        constructor of the application class.  It will basically calculate
        the path to a folder named ``instance`` next to your main file or
        the package.

        .. versionadded:: 0.8
        """
        prefix, package_path = find_package(self.import_name)
        if prefix is None:
            return os.path.join(package_path, "instance")
        return os.path.join(prefix, "var", f"{self.name}-instance")
```

**Repo-wide confirmation that only `Config`'s own attribute is affected:** `grep -rn "\.root_path =" src/ tests/` returns only

```
src/flask/config.py:100:        self.root_path = root_path
src/flask/sansio/scaffold.py:100:        self.root_path = root_path
tests/test_helpers.py:93:        app.root_path = os.path.join(
```

i.e. there is no assignment anywhere that mutates the app's `self.root_path` to the instance path during initialization.

### Empirical confirmation (executed in this worktree with `PYTHONPATH="$PWD/src"`, Python 3.13.9)

The check ran against this checkout's source (`flask file: ...\seal\src\flask\__init__.py`); a venv caveat applied because the repo's `.venv` had an editable install pointing at a different tree, hence the forced `PYTHONPATH`. Observed output:

```
--- default app (instance_relative_config=False) ---
a.root_path        = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal
a.instance_path    = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\instance
a.config.root_path = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal
ASSERT A1 PASSED: default config.root_path == app.root_path
ASSERT A2 PASSED: default config.root_path != app.instance_path

--- instance-relative app (instance_relative_config=True) ---
b.root_path        = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal
b.instance_path    = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\instance
b.config.root_path = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\instance
ASSERT B1 PASSED: config.root_path == app.instance_path
ASSERT B2 PASSED: config.root_path != app.root_path
ASSERT B3 PASSED: app.root_path is NOT mutated by the switch (b.root_path == a.root_path)
ASSERT B4 PASSED: instance_path != root_path

--- explicit absolute instance_path + instance_relative_config=True ---
c.instance_path    = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\some_instance
c.config.root_path = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\some_instance
ASSERT C1 PASSED: config.root_path == explicit instance_path

ALL EMPIRICAL ASSERTIONS PASSED
```

Tabulated:

| app | `app.root_path` | `app.instance_path` | `app.config.root_path` |
|---|---|---|---|
| default (`instance_relative_config=False`) | `...\seal` | `...\seal\instance` | `...\seal` (= root) |
| `instance_relative_config=True` | `...\seal` | `...\seal\instance` | `...\seal\instance` (= instance) |
| explicit instance_path + `True` | `...\seal` | `...\seal\some_instance` | `...\seal\some_instance` |

Subclass probing confirmed the constructor routes through `make_config` and that a recording `config_class` receives the *transformed* path:

```
make_config called with: [False]
make_config called with: [False, True]
ASSERT PASSED: constructor routes through make_config(instance_relative_config)
RecordingConfig received root_path = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\instance
app.root_path                       = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal
app.instance_path                   = C:\Users\oobbee\AppData\Local\Temp\pi-p50o\b745bec7\q4-TXT\seal\instance
ASSERT PASSED: Config storage object is handed the transformed (instance) path
```

Negative case (relative `instance_path`) raises before reaching `make_config`:

```
ValueError raised: If an instance path is provided it must be absolute. A relative path was given instead.
```

Full test suite run twice — `PYTHONPATH="$PWD/src" ./.venv/Scripts/python.exe -m pytest tests/` and with `-v -rA --tb=long -l` — both **exit 0**:

```
============================= 489 passed in 7.51s =============================
```
```
============================= 489 passed in 7.40s =============================
```

There is **no test that directly asserts `config.root_path` or exercises the `instance_relative` branch of `make_config`**: `grep -rn "config\.root_path\|make_config\|instance_relative" tests/` exits 1 with no output. The behavioral coverage of the switch is indirect, via relative-path resolution in `from_pyfile`. The closest test is `tests/test_config.py:198–207`:

```python
def test_custom_config_class():
    class Config(flask.Config):
        pass

    class Flask(flask.Flask):
        config_class = Config

    app = Flask(__name__)
    assert isinstance(app.config, Config)
```

### Corroborating documentation of intent

`docs/config.rst:810–832`:

```rst
Since the config object provided loading of configuration files from
relative filenames we made it possible to change the loading via filenames
to be relative to the instance path if wanted.  The behavior of relative
paths in config files can be flipped between “relative to the application
root” (the default) to “relative to instance folder” via the
`instance_relative_config` switch to the application constructor::

    app = Flask(__name__, instance_relative_config=True)
```

And the constructor docstring present in both `src/flask/app.py:169–172` and `src/flask/sansio/app.py:147–150`:

```python
    :param instance_relative_config: if set to ``True`` relative filenames
                                     for loading the config are assumed to
                                     be relative to the instance path instead
                                     of the application root.
```

### Precise answer

- **File / function / lines:** `src/flask/sansio/app.py`, `App.make_config()`, lines **491–493**; the value produced there is consumed at line **496**.
- **The three-line transform:**
  ```python
        root_path = self.root_path
        if instance_relative:
            root_path = self.instance_path
  ```
- **Storing field:** `Config.root_path`, assigned in `Config.__init__` at `src/flask/config.py:100` (`self.root_path = root_path`); the class is selected by `config_class = Config` (`src/flask/sansio/app.py:196`).
- **Call chain:** `Flask.__init__` (`src/flask/app.py:226`, forwards only) → `App.__init__` (`src/flask/sansio/app.py:282`, sets `self.instance_path` at 314) → `self.make_config(instance_relative_config)` (line 319) → `self.config_class(root_path, defaults)` (line 496) → `Config.__init__` (`src/flask/config.py:94–100`).
- **App attribute unchanged:** `self.root_path` (computed in `Scaffold.__init__`, `src/flask/sansio/scaffold.py:100`, from `get_root_path`, `src/flask/helpers.py:570`) is not mutated; only the local variable inside `make_config` is switched, so `app.root_path` still points at the application root while `app.config.root_path` points at the instance folder when `instance_relative_config=True`.

Two scope caveats worth stating: the transformation exists in the **default `App.make_config`** — because `config_class` is overridable and `make_config` itself may be overridden, a custom subclass can bypass it; and `instance_path` must be absolute or auto-derived, since a relative one raises `ValueError` in `App.__init__` before `make_config` is ever called.

(For completeness: the worktree also contains `flask_mut2_i417ar2x/mutated_test.py`, a subdomain-routing script that fails with a 404 assertion. It is outside `testpaths = ["tests"]`, touches none of `instance_relative_config` / `root_path` / `instance_path` / `make_config` / `config.root_path`, and is unrelated to this question.)
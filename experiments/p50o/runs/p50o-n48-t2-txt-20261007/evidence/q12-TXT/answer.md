# Why does `Flask.open_resource` (the root-path resource opener) restrict file opening to read-only modes?

## Short answer

Because the directory it opens files from — `root_path` — is the **application's own module/package source directory**, which is shipped, installable, and therefore *not* a place where an application may legitimately mutate files at runtime. The method's contract is literally "open a resource file relative to `root_path` **for reading**", and the framework deliberately offers a *different* location for anything writable: the **instance folder**, exposed through `Flask.open_instance_resource`, whose docstring says outright that "**Unlike** `open_resource`, files in the instance folder **can be opened for writing**." The restriction is not a limitation to be worked around — it is the enforcement of the root-path/instance-path split that the documentation defines: `root_path` holds the package's shipped data (templates, static files, `schema.sql`), while the instance folder is "the perfect place to drop things that either change at runtime or configuration files."

The same restriction exists on `Blueprint.open_resource`. It is enforced by a single whitelist guard, pinned by tests, and consistent with the fact that every in-repo usage of the method is a read.

---

## 1. The method and the exact guard

`Flask.open_resource` — `src/flask/app.py`, lines 330–361 (verified by re-reading lines 328–387):

```python
    def open_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = None
    ) -> t.IO[t.AnyStr]:
        """Open a resource file relative to :attr:`root_path` for reading.

        For example, if the file ``schema.sql`` is next to the file
        ``app.py`` where the ``Flask`` app is defined, it can be opened
        with:

        .. code-block:: python

            with app.open_resource("schema.sql") as f:
                conn.executescript(f.read())

        :param resource: Path to the resource relative to :attr:`root_path`.
        :param mode: Open the file in this mode. Only reading is supported,
            valid values are ``"r"`` (or ``"rt"``) and ``"rb"``.
        :param encoding: Open the file with this encoding when opening in text
            mode. This is ignored when opening in binary mode.

        .. versionchanged:: 3.1
            Added the ``encoding`` parameter.
        """
        if mode not in {"r", "rt", "rb"}:
            raise ValueError("Resources can only be opened for reading.")

        path = os.path.join(self.root_path, resource)

        if mode == "rb":
            return open(path, mode)  # pyright: ignore

        return open(path, mode, encoding=encoding)
```

Three things the source fixes in place:

- The docstring states the purpose as opening a resource "**for reading**" and repeats the restriction on the parameter: "**Only reading is supported, valid values are `"r"` (or `"rt"`) and `"rb"`**."
- The guard is exactly `if mode not in {"r", "rt", "rb"}: raise ValueError("Resources can only be opened for reading.")` — a positive whitelist, not a blacklist, so any mode not enumerated (including `w`, `x`, `a`, `r+`, `w+`, `wb`, `ab`, `rb+`, `br`, …) is rejected.
- The path is built from `self.root_path`: `path = os.path.join(self.root_path, resource)`.

`.venv/Scripts/python.exe -m pytest` runs on this checkout confirm the suite is green (489 passed in 5.85s; a verbose re-run also 489 passed, exit 0), so the behaviour described is the behaviour shipped here.

**The blueprint twin** — `Blueprint.open_resource`, `src/flask/blueprints.py`, lines 104–128 (verified by re-reading lines 100–131) — is identical in the guard and error string:

```python
    def open_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = "utf-8"
    ) -> t.IO[t.AnyStr]:
        """Open a resource file relative to :attr:`root_path` for reading. The
        blueprint-relative equivalent of the app's :meth:`~.Flask.open_resource`
        method.

        :param resource: Path to the resource relative to :attr:`root_path`.
        :param mode: Open the file in this mode. Only reading is supported,
            valid values are ``"r"`` (or ``"rt"``) and ``"rb"``.
        :param encoding: Open the file with this encoding when opening in text
            mode. This is ignored when opening in binary mode.

        .. versionchanged:: 3.1
            Added the ``encoding`` parameter.
        """
        if mode not in {"r", "rt", "rb"}:
            raise ValueError("Resources can only be opened for reading.")

        path = os.path.join(self.root_path, resource)

        if mode == "rb":
            return open(path, mode)  # pyright: ignore

        return open(path, mode, encoding=encoding)
```

A repo-wide search shows the exact error string occurs in only those two source locations:

```
$ grep -rn "Resources can only be opened for reading" src/ docs/ tests/ CHANGES.rst
src/flask/app.py:354:            raise ValueError("Resources can only be opened for reading.")
src/flask/blueprints.py:121:            raise ValueError("Resources can only be opened for reading.")
Binary file src/flask/__pycache__/app.cpython-311.pyc matches
Binary file src/flask/__pycache__/app.cpython-312.pyc matches
Binary file src/flask/__pycache__/app.cpython-313.opt-1.pyc matches
Binary file src/flask/__pycache__/app.cpython-313.pyc matches
Binary file src/flask/__pycache__/app.cpython-314.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-311.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-312.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-313.opt-1.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-313.pyc matches
Binary file src/flask/__pycache__/blueprints.cpython-314.pyc matches
exit=0
```

and the surrounding wording ("for reading", "Only reading is supported", "opened for writing") occurs only in the intended spots (the other hits are unrelated JSON dump/load file-object wording):

```
$ grep -rn "for reading\|Only reading\|opened for writing\|only be opened" src/ | grep -v "json"
src/flask/app.py:333:        """Open a resource file relative to :attr:`root_path` for reading.
src/flask/app.py:345:        :param mode: Open the file in this mode. Only reading is supported,
src/flask/app.py:354:            raise ValueError("Resources can only be opened for reading.")
src/flask/app.py:368:        instance folder can be opened for writing.
src/flask/blueprints.py:107:        """Open a resource file relative to :attr:`root_path` for reading. The
src/flask/blueprints.py:112:        :param mode: Open the file in this mode. Only reading is supported,
src/flask/blueprints.py:121:            raise ValueError("Resources can only be opened for reading.")
Binary file src/flask/__pycache__/app.cpython-311.pyc matches
... (pyc entries omitted) ...
exit=0
```

---

## 2. What `root_path` is, and why it is read-only territory

`root_path` is not some arbitrary directory the developer chose; it is discovered from the application's `import_name` and points at the code/package itself. `src/flask/sansio/scaffold.py` (class `Scaffold`, the shared base of `Flask` and `Blueprint`), lines 63–65 and 95–100:

```
    :param root_path: The path that static, template, and resource files
        are relative to. Typically not set, it is discovered based on
        the ``import_name``.
```

```python
        if root_path is None:
            root_path = get_root_path(self.import_name)

        #: Absolute path to the package on the filesystem. Used to look
        #: up resources contained in the package.
        self.root_path = root_path
```

The comment on the assignment says it plainly: "**Absolute path to the package on the filesystem. Used to look up resources contained in the package.**" The resources are *contained in the package* — i.e. shipped data, part of the distributable, not runtime state.

`get_root_path` — `src/flask/helpers.py`, lines 570–624 — resolves that to the directory of the app's own module/package file:

```python
def get_root_path(import_name: str) -> str:
    """Find the root path of a package, or the path that contains a
    module. If it cannot be found, returns the current working
    directory.

    Not to be confused with the value returned by :func:`find_package`.

    :meta private:
    """
    # Module already imported and has a file attribute. Use that first.
    mod = sys.modules.get(import_name)

    if mod is not None and hasattr(mod, "__file__") and mod.__file__ is not None:
        return os.path.dirname(os.path.abspath(mod.__file__))

    # Next attempt: check the loader.
    try:
        spec = importlib.util.find_spec(import_name)

        if spec is None:
            raise ValueError
    except (ImportError, ValueError):
        loader = None
    else:
        loader = spec.loader

    # Loader does not exist or we're referring to an unloaded main
    # module or a main module without path (interactive sessions), go
    # with the current working directory.
    if loader is None:
        return os.getcwd()

    if hasattr(loader, "get_filename"):
        filepath = loader.get_filename(import_name)  # pyright: ignore
    else:
        # Fall back to imports.
        __import__(import_name)
        mod = sys.modules[import_name]
        filepath = getattr(mod, "__file__", None)

        # If we don't have a file path it might be because it is a
        # namespace package. In this case pick the root path from the
        # first module that is contained in the package.
        if filepath is None:
            raise RuntimeError(
                "No root path can be found for the provided module"
                f" {import_name!r}. This can happen because the module"
                " came from an import hook that does not provide file"
                " name information or because it's a namespace package."
                " In this case the root path needs to be explicitly"
                " provided."
            )

    # filepath is import_name.py for a module, or __init__.py for a package.
    return os.path.dirname(os.path.abspath(filepath))  # type: ignore[no-any-return]
```

Consequences that justify read-only access:

- The opened file lives **inside the application's code tree** — the same directory as `app.py` / `__init__.py`, per the docstring example: "if the file `schema.sql` is next to the file `app.py` where the `Flask` app is defined".
- That tree is what gets packaged, installed under `site-packages`, and (historically) could be zipped; it may be **read-only on disk** or not a normal file at all. Writing there is either impossible or an unintended mutation of installed, version-controlled content.
- The class comment and the blueprint docs reinforce the same reading: `docs/blueprints.rst` shows `simple_page.root_path` resolving to `/Users/username/TestProject/yourapplication` and calls it "the resource folder", and the design doc frames resources as something the framework "access[es] the package to figure out where the templates and static files **are stored**".

The design rationale for resolving relative to the module rather than the process working directory is set out in `docs/design.rst`, lines 53–66:

```
create a Flask instance you usually pass it `__name__` as package name.
Flask depends on that information to properly load resources relative
to your module.  With Python's outstanding support for reflection it can
then access the package to figure out where the templates and static files
are stored (see :meth:`~flask.Flask.open_resource`).  Now obviously there
are frameworks around that do not need any configuration and will still be
able to load templates relative to your application module.  But they have
to use the current working directory for that, which is a very unreliable
way to determine where the application is.  The current working directory
is process-wide and if you are running multiple applications in one
process (which could happen in a webserver without you knowing) the paths
will be off.  Worse: many webservers do not set the working directory to
the directory of your application but to the document root which does not
have to be the same folder.
```

So `open_resource` exists to make *package-relative* lookup reliable and unambiguous. Package resources are therefore, by construction, **fixed content that ships with the code** — hence "for reading".

---

## 3. The writable counterpart: the instance folder and `open_instance_resource`

The framework does not simply refuse writable opens everywhere; it redirects them to a different, deliberately mutable location. `Flask.open_instance_resource` — `src/flask/app.py`, lines 363–383 (verified in the same read window) — is the contrast case:

```python
    def open_instance_resource(
        self, resource: str, mode: str = "rb", encoding: str | None = "utf-8"
    ) -> t.IO[t.AnyStr]:
        """Open a resource file relative to the application's instance folder
        :attr:`instance_path`. Unlike :meth:`open_resource`, files in the
        instance folder can be opened for writing.

        :param resource: Path to the resource relative to :attr:`instance_path`.
        :param mode: Open the file in this mode.
        :param encoding: Open the file with this encoding when opening in text
            mode. This is ignored when opening in binary mode.

        .. versionchanged:: 3.1
            Added the ``encoding`` parameter.
        """
        path = os.path.join(self.instance_path, resource)

        if "b" in mode:
            return open(path, mode)

        return open(path, mode, encoding=encoding)
```

The docstring is the closest thing in the repository to an explicit statement of the reason. It says the two locations differ precisely on writability: "**Unlike `open_resource`, files in the instance folder can be opened for writing.**" And structurally the method differs in exactly the way you would expect if that sentence is the rationale: it joins `self.instance_path` rather than `self.root_path`, and it performs **no** mode whitelist whatsoever — every mode string is passed through to `open`.

Why is the instance folder the sanctioned writable location? `docs/config.rst`, "Instance Folders" (lines 763–805) — re-read and quoted in full:

```
Flask 0.8 introduces instance folders.  Flask for a long time made it
possible to refer to paths relative to the application's folder directly
(via :attr:`Flask.root_path`).  This was also how many developers loaded
configurations stored next to the application.  Unfortunately however this
only works well if applications are not packages in which case the root
path refers to the contents of the package.

With Flask 0.8 a new attribute was introduced:
:attr:`Flask.instance_path`.  It refers to a new concept called the
“instance folder”.  The instance folder is designed to not be under
version control and be deployment specific.  It's the perfect place to
drop things that either change at runtime or configuration files.

You can either explicitly provide the path of the instance folder when
creating the Flask application or you can let Flask autodetect the
instance folder.  For explicit configuration use the `instance_path`
parameter::

    app = Flask(__name__, instance_path='/path/to/instance/folder')

Please keep in mind that this path *must* be absolute when provided.

If the `instance_path` parameter is not provided the following default
locations are used:

-   Uninstalled module::

        /myapp.py
        /instance

-   Uninstalled package::

        /myapp
            /__init__.py
        /instance

-   Installed module or package::

        $PREFIX/lib/pythonX.Y/site-packages/myapp
        $PREFIX/var/myapp-instance

    ``$PREFIX`` is the prefix of your Python installation.  This can be
    ``/usr`` or the path to your virtualenv.  You can print the value of
    ``sys.prefix`` to see what the prefix is set to.
```

Two points in that passage are decisive:

1. "**The instance folder is designed to not be under version control and be deployment specific. It's the perfect place to drop things that either change at runtime or configuration files.**" That is the role of the *writable* location. `root_path` is defined by contrast: it "refers to the contents of the package", and the passage even notes that loading config "next to the application" via `root_path` "only works well if applications are not packages".
2. For an **installed** package, the writable location is deliberately placed **outside** the package tree: `$PREFIX/lib/pythonX.Y/site-packages/myapp` (the read-only-ish package resources) versus `$PREFIX/var/myapp-instance` (the writable instance). The framework treats the package directory as install-owned.

`docs/config.rst` (lines 827–838) also presents `open_instance_resource` as the shortcut for the instance folder specifically:

```
The path to the instance folder can be found via the
:attr:`Flask.instance_path`.  Flask also provides a shortcut to open a
file from the instance folder with :meth:`Flask.open_instance_resource`.

Example usage for both::

    filename = os.path.join(app.instance_path, 'application.cfg')
    with open(filename) as f:
        config = f.read()

    # or via open_instance_resource:
    with app.open_instance_resource('application.cfg') as f:
        config = f.read()
```

The same split is baked into the machinery that *chooses* the instance path. `src/flask/sansio/app.py`, lines 303–314 and 510–522 (re-read):

```python
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
```

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

`find_package` (`src/flask/sansio/scaffold.py`, lines 759–792) is what detects the installed/`site-packages` case and moves the instance folder out of the package:

```python
def find_package(import_name: str) -> tuple[str | None, str]:
    """Find the prefix that a package is installed under, and the path
    that it would be imported from.

    The prefix is the directory containing the standard directory
    hierarchy (lib, bin, etc.). If the package is not installed to the
    system (:attr:`sys.prefix`) or a virtualenv (``site-packages``),
    ``None`` is returned.

    The path is the entry in :attr:`sys.path` that contains the package
    for import. If the package is not installed, it's assumed that the
    package was imported from the current working directory.
    """
    package_path = _find_package_path(import_name)
    py_prefix = os.path.abspath(sys.prefix)

    # installed to the system
    if pathlib.PurePath(package_path).is_relative_to(py_prefix):
        return py_prefix, package_path

    site_parent, site_folder = os.path.split(package_path)

    # installed to a virtualenv
    if site_folder.lower() == "site-packages":
        parent, folder = os.path.split(site_parent)

        # Windows (prefix/lib/site-packages)
        if folder.lower() == "lib":
            return parent, package_path

        # Unix (prefix/lib/pythonX.Y/site-packages)
        if os.path.basename(parent).lower() == "lib":
            return os.path.dirname(parent), package_path

        # something else (prefix/site-packages)
        return site_parent, package_path

    # not installed
    return None, package_path
```

And that behaviour is verified by a test — `tests/test_instance_config.py`, lines 100–111:

```python
def test_prefix_package_paths(
    modules_tmp_path, modules_tmp_path_prefix, purge_module, site_packages
):
    app = site_packages / "site_package"
    app.mkdir()
    (app / "__init__.py").write_text("import flask\napp = flask.Flask(__name__)\n")
    purge_module("site_package")

    import site_package

    assert site_package.app.instance_path == os.fspath(
        modules_tmp_path / "var" / "site_package-instance"
    )
```

The changelog states the same design intent when the instance folder was introduced — `CHANGES.rst`, lines 1352–1357 (re-read):

```
-   Applications now not only have a root path where the resources and
    modules are located but also an instance path which is the
    designated place to drop files that are modified at runtime (uploads
    etc.). Also this is conceptually only instance depending and outside
    version control so it's the perfect place to put configuration files
    etc.
```

"Applications now **not only** have a root path where the resources and modules are located **but also** an instance path which is the **designated place to drop files that are modified at runtime**" — that is the division of labour that makes read-only `open_resource` coherent rather than restrictive.

---

## 4. Enforcement: the guard, the tests, and empirical confirmation

### Tests that pin it

`tests/test_helpers.py`, lines 338–360 (re-read in full):

```python
@pytest.mark.parametrize("mode", ("r", "rb", "rt"))
def test_open_resource(mode):
    app = flask.Flask(__name__)

    with app.open_resource("static/index.html", mode) as f:
        assert "<h1>Hello World!</h1>" in str(f.read())


@pytest.mark.parametrize("mode", ("w", "x", "a", "r+"))
def test_open_resource_exceptions(mode):
    app = flask.Flask(__name__)

    with pytest.raises(ValueError):
        app.open_resource("static/index.html", mode)


@pytest.mark.parametrize("encoding", ("utf-8", "utf-16-le"))
def test_open_resource_with_encoding(tmp_path, encoding):
    app = flask.Flask(__name__, root_path=os.fspath(tmp_path))
    (tmp_path / "test").write_text("test", encoding=encoding)

    with app.open_resource("test", mode="rt", encoding=encoding) as f:
        assert f.read() == "test"
```

`test_open_resource` enumerates exactly the accepted whitelist `("r", "rb", "rt")`; `test_open_resource_exceptions` asserts `ValueError` for exactly the write/append/update modes `("w", "x", "a", "r+")`. The suite fixture also shows `root_path` being pointed at the tests directory explicitly (`tests/conftest.py:46`: `app = Flask("flask_test", root_path=os.path.dirname(__file__))`), consistent with root-path being package/code territory.

Notable gap: a search for `instance_resource` under `tests/` returns no matches —

```
$ grep -rn "instance_resource" tests/ || echo "NO MATCHES IN tests/"
NO MATCHES IN tests/
exit=0
```

so the writable *sibling's* permissiveness is documented but not pinned by a test; only the read-only restriction on `open_resource` has explicit test coverage.

### Empirical run

```
$ PYTHONPATH="$(pwd)/src" .venv/Scripts/python.exe -m pytest tests/test_helpers.py -k open_resource -q
.........                                                                [100%]
9 passed, 25 deselected in 0.09s
EXIT=0
```

Direct replication of the parametrized cases, plus extra modes and the instance-folder contrast:

```
app.root_path: <cwd>\tests
app.instance_path: <cwd>\instance

--- read modes on root_path resource ---
  open_resource('r') -> OK, type=str, head='<h1>Hello World!</h1>\n'
  open_resource('rb') -> OK, type=bytes, head=b'<h1>Hello World!</h1>\n'
  open_resource('rt') -> OK, type=str, head='<h1>Hello World!</h1>\n'

--- non-read modes on root_path resource ---
  open_resource('w') -> ValueError: Resources can only be opened for reading.
  open_resource('x') -> ValueError: Resources can only be opened for reading.
  open_resource('a') -> ValueError: Resources can only be opened for reading.
  open_resource('r+') -> ValueError: Resources can only be opened for reading.
  open_resource('w+') -> ValueError: Resources can only be opened for reading.
  open_resource('wb') -> ValueError: Resources can only be opened for reading.
  open_resource('ab') -> ValueError: Resources can only be opened for reading.
  open_resource('a+') -> ValueError: Resources can only be opened for reading.
  open_resource('rb+') -> ValueError: Resources can only be opened for reading.
  open_resource('wb+') -> ValueError: Resources can only be opened for reading.
  open_resource('br') -> ValueError: Resources can only be opened for reading.
  open_resource('br+') -> ValueError: Resources can only be opened for reading.

--- contrast: open_instance_resource (no whitelist) ---
app2.instance_path: <tmp dir>
  wrote via open_instance_resource('new.cfg','w'): hello
  read back: hello
  open_resource('new.cfg','w') -> ValueError: Resources can only be opened for reading.

--- Blueprint.open_resource ---
has open_instance_resource: False
  Blueprint.open_resource('r') -> OK
  Blueprint.open_resource('rb') -> OK
  Blueprint.open_resource('rt') -> OK
  Blueprint.open_resource('w') -> ValueError: Resources can only be opened for reading.
  Blueprint.open_resource('a') -> ValueError: Resources can only be opened for reading.
  Blueprint.open_resource('x') -> ValueError: Resources can only be opened for reading.
  Blueprint.open_resource('r+') -> ValueError: Resources can only be opened for reading.
with EXIT=0
```

This is the strongest available confirmation: not only do `w`/`x`/`a`/`r+` raise, but so do every other non-whitelisted spelling, including binary and `+` variants (`w+`, `wb`, `ab`, `a+`, `rb+`, `wb+`, `br`, `br+`) — a positive whitelist behaves exactly that way. Meanwhile the *same* runtime writes happily through `open_instance_resource("new.cfg", "w")` and reads the value back, demonstrating that the read-only rule is specific to the root-path/package-resource method, not to the framework as a whole.

---

## 5. Every shipped usage of the method is a read — the read-only API matches actual needs

Full-repo search for call sites:

```
$ grep -rn "open_resource\|open_instance_resource" docs/ examples/ tests/ --include=*.py --include=*.rst
docs/blueprints.rst:186::meth:`~Blueprint.open_resource` function::
docs/blueprints.rst:188:    with simple_page.open_resource('static/style.css') as f:
docs/config.rst:829:file from the instance folder with :meth:`Flask.open_instance_resource`.
docs/config.rst:837:    # or via open_instance_resource:
docs/config.rst:838:    with app.open_instance_resource('application.cfg') as f:
docs/design.rst:59:are stored (see :meth:`~flask.Flask.open_resource`).  Now obviously there
docs/patterns/sqlite3.rst:140:            with app.open_resource('schema.sql', mode='r') as f:
docs/tutorial/database.rst:126:        with current_app.open_resource('schema.sql') as f:
docs/tutorial/database.rst:141::meth:`open_resource() <Flask.open_resource>` opens a file relative to
examples/tutorial/flaskr/db.py:37:    with current_app.open_resource("schema.sql") as f:
tests/test_helpers.py:39:        with app.open_resource("static/index.html") as f:
tests/test_helpers.py:339:def test_open_resource(mode):
tests/test_helpers.py:342:    with app.open_resource("static/index.html", mode) as f:
tests/test_helpers.py:347:def test_open_resource_exceptions(mode):
tests/test_helpers.py:351:        app.open_resource("static/index.html", mode)
tests/test_helpers.py:355:    def test_open_resource_with_encoding(tmp_path, encoding):
tests/test_helpers.py:359:    with app.open_resource("test", mode="rt", encoding=encoding) as f:
exit=0
```

Each real call site:

- `docs/patterns/sqlite3.rst:137–142`:
  ```python
      def init_db():
          with app.app_context():
              db = get_db()
              with app.open_resource('schema.sql', mode='r') as f:
                  db.cursor().executescript(f.read())
              db.commit()
  ```
  (explicit `mode='r'` — a read)
- `docs/tutorial/database.rst:123–127`:
  ```python
      def init_db():
          db = get_db()

          with current_app.open_resource('schema.sql') as f:
              db.executescript(f.read().decode('utf8'))
  ```
  accompanied by the prose explanation: ":meth:`open_resource() <Flask.open_resource>` opens a file relative to the ``flaskr`` package, which is useful since you won't necessarily know where that location is when deploying the application later." That sentence is itself the rationale compressed: the method exists to *find and read* packaged data at deployment time, when the path is unknown to the developer.
- `docs/blueprints.rst:185–189`:
  ```
  To quickly open sources from this folder you can use the
  :meth:`~Blueprint.open_resource` function::

      with simple_page.open_resource('static/style.css') as f:
          code = f.read()
  ```
- `examples/tutorial/flaskr/db.py:33–38`:
  ```python
      def init_db():
          """Clear existing data and create new tables."""
          db = get_db()

          with current_app.open_resource("schema.sql") as f:
              db.executescript(f.read().decode("utf8"))
  ```
- `tests/test_helpers.py:39`:
  ```python
          with app.open_resource("static/index.html") as f:
              rv.direct_passthrough = False
              assert rv.data == f.read()
  ```

All are reads of shipped, package-relative data (schemas, static assets). There is no in-repo example of anyone needing a write mode through this method — the only documented writing path is `open_instance_resource`, used for `application.cfg` (a config file that "change[s] at runtime").

The docstrings themselves are the rendered API documentation (`docs/api.rst:14–23` uses `.. autoclass:: Flask` / `:members:` and `.. autoclass:: Blueprint` / `:members:` with no separate hand-written entry), so "for reading" / "Only reading is supported" is the published contract of the method, not an internal detail.

---

## 6. Historical corroboration: only read modes have ever been accepted

`CHANGES.rst` records two changes to these methods, neither of which loosened the mode restriction:

```
-   ``Flask.open_resource``/``open_instance_resource`` and
    ``Blueprint.open_resource`` take an ``encoding`` parameter to use when
    opening in text mode. It defaults to ``utf-8``. :issue:`5504`
```
(v3.1.0, `CHANGES.rst:35–37`)

```
-   ``open_resource`` accepts the "rt" file mode. This still does the
    same thing as "r". :issue:`3163`
```
(v1.0, `CHANGES.rst:686–687`)

The `"rt"` addition was purely about text-mode clarity ("This still does the same thing as `"r"`") — it widened the *read* whitelist from `{"r", "rb"}` to `{"r", "rt", "rb"}`, it did not open the door to writing. And the `encoding` parameter (v3.1) is about text decoding, entirely orthogonal to file mode. Background in the same file also notes zipped/egg applications and custom module hooks (`CHANGES.rst:1253–1265`) and that support for zipped applications was "(temporarily) dropped" (`CHANGES.rst:1541–1543`) — i.e. package resources have historically been things that may not even be ordinary writable files, which is precisely why an API promising *reading* of them is safe while an API promising *writing* would not be.

---

## 7. Summary of the reasoning chain

1. **The method's stated purpose is reading package data.** `open_resource` opens "a resource file relative to `:attr:`root_path` **for reading**"; the parameter doc says "**Only reading is supported**".
2. **`root_path` is the application's own package/code directory**, not a chosen data directory: it is discovered via `get_root_path(self.import_name)`, and the attribute is annotated "Absolute path to the package on the filesystem. Used to look up resources **contained in the package**." Those files are shipped, version-controlled, possibly install-owned (`site-packages`) or non-file (zipped), so mutating them is not supported or safe.
3. **The framework provides a distinct writable location instead**, and says so explicitly: `open_instance_resource` — "**Unlike** `:meth:`open_resource`, files in the instance folder **can be opened for writing**" — which joins `self.instance_path` and applies **no** mode whitelist. `docs/config.rst` defines that folder as "designed to not be under version control and be deployment specific. It's the perfect place to drop things that either change at runtime or configuration files", and places it outside the package for installed apps (`$PREFIX/var/myapp-instance` vs `$PREFIX/lib/pythonX.Y/site-packages/myapp`); `CHANGES.rst:1352` calls it "the designated place to drop files that are modified at runtime (uploads etc.)".
4. **The boundary is enforced by one positive whitelist**, `if mode not in {"r", "rt", "rb"}: raise ValueError("Resources can only be opened for reading.")`, present identically in `Flask.open_resource` (`src/flask/app.py:354`) and `Blueprint.open_resource` (`src/flask/blueprints.py:121`), and pinned by `test_open_resource` (`("r","rb","rt")` succeed) and `test_open_resource_exceptions` (`("w","x","a","r+")` raise `ValueError`).
5. **Nothing in the repository ever asks to write through it** — every documented/example/test call site reads `schema.sql`, `static/index.html`, or `static/style.css`.

---

## 8. Caveats worth stating explicitly

- **The rationale is inferential, not stated in one sentence.** No changelog entry or doc line says literally "writing is forbidden because …". The reason has to be assembled from (a) the docstrings "for reading" / "Only reading is supported"; (b) the explicit contrast "Unlike `open_resource`, files in the instance folder can be opened for writing"; (c) `docs/config.rst`'s definition of the instance folder as the runtime-writable, deployment-specific place and its placement of installed packages' mutable folder outside the package; and (d) `CHANGES.rst`'s "designated place to drop files that are modified at runtime". No upstream PR/commit number for the read-only decision exists in this repository (the only `:issue:` references are `3163` for `"rt"` and `5504` for `encoding`), so none is cited here.
- **Two methods share the behaviour.** `Flask.open_resource` and `Blueprint.open_resource` both apply the identical guard. Only `Flask` additionally has `open_instance_resource`; the blueprint's lack of a writable sibling is not an omission to be conflated with the app's separate method.
- **`encoding` is unrelated to this question.** The differing defaults (`None` for `Flask.open_resource`, `"utf-8"` for `Blueprint.open_resource` and `open_instance_resource`) concern text decoding, not file modes, and are not the reason for the read-only rule.
- **One half of the contrast is untested.** No test exercises `open_instance_resource`'s writability (grep for `instance_resource` in `tests/` yields nothing); the writable-side claim rests on the docstring, `docs/config.rst`, and the ad-hoc run above, whereas the read-only side is pinned by `test_open_resource_exceptions`.
- **Verification caveat for this environment.** The venv's editable install points outside this working directory, so a bare `import flask` would exercise a different checkout; all runs above used `PYTHONPATH="$(pwd)/src"` to force the working directory's `src/flask` under test, confirmed by `sys.modules['flask'].__file__` resolving to the local `src/flask/__init__.py`.
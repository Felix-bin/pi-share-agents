# Where the parent/child inheritance chain affects configuration resolution when loading from a class object

**Short answer.** There is exactly one executable site in the whole repository where a class-inheritance chain is read during configuration resolution from a class object: the loop in **`Config.from_object`**, at **`src/flask/config.py:252`** (`for key in dir(obj):`) with the value fetch at **`src/flask/config.py:254`** (`self[key] = getattr(obj, key)`). Flask itself never walks an MRO — the parent/child behaviour is entirely an emergent property of the built-ins `dir()` and `getattr()` used inside that loop. A second, *destination-side* inheritance chain exists at **`src/flask/sansio/app.py:196`** (`config_class = Config`), consumed by **`make_config`** at **`src/flask/sansio/app.py:482`**/`496`, which decides *which* `Config` subclass receives the resolved values. Both are described below.

---

## 1. The primary site: `Config.from_object` — `src/flask/config.py:218–254`

The full method, verbatim (method begins at line 218; the resolution loop is the last three lines, 252–254):

```python
218    def from_object(self, obj: object | str) -> None:
219        """Updates the values from the given object.  An object can be of one
220        of the following two types:
221
222        -   a string: in this case the object with that name will be imported
223        -   an actual object reference: that object is used directly
224
225        Objects are usually either modules or classes. :meth:`from_object`
226        loads only the uppercase attributes of the module/class. A ``dict``
227        object will not work with :meth:`from_object` because the keys of a
228        ``dict`` are not attributes of the ``dict`` class.
229
230        Example of module-based configuration::
231
232            app.config.from_object('yourapplication.default_config')
233            from yourapplication import default_config
234            app.config.from_object(default_config)
235
236        Nothing is done to the object before loading. If the object is a
237        class and has ``@property`` attributes, it needs to be
238        instantiated before being passed to this method.
239
240        You should not use this function to load the actual configuration but
241        rather configuration defaults.  The actual config should be loaded
242        with :meth:`from_pyfile` and ideally from a location not within the
243        package because the package might be installed system wide.
244
245        See :ref:`config-dev-prod` for an example of class-based configuration
246        using :meth:`from_object`.
247
248        :param obj: an import name or object
249        """
250        if isinstance(obj, str):
251            obj = import_string(obj)
252        for key in dir(obj):
253            if key.isupper():
254                self[key] = getattr(obj, key)
255
```

Grep confirmation of the exact loop lines, from the executed verification pass:

```
== config.py ==
23:    def __init__(
50:class Config(dict):  # type: ignore[type-arg]
94:    def __init__(
218:    def from_object(self, obj: object | str) -> None:
252:        for key in dir(obj):
253:            if key.isupper():
254:                self[key] = getattr(obj, key)
319:            if key.isupper():
```

### Why the inheritance chain matters here

`dir(obj)` does not return only the names in `obj.__dict__`; for a class it enumerates attribute names collected **across the class's whole MRO** (`type(obj).__mro__`). Because Python attribute names are unique in that enumeration, an inherited name that the child overrides appears **once**, and `getattr(obj, key)` resolves it along the MRO with the **most-derived (child) definition winning**. Consequently:

- A parent-class `UPPER_CASE` attribute is loaded into the config even though it is absent from the child's `__dict__` — because it is still in `dir(Child)` and `getattr(Child, name)` finds it on the parent.
- A child override of the same name silently replaces the parent value — because the name occurs once in `dir()` and `getattr` returns the child's value.
- The only membership gate is `key.isupper()` (line 253). There is **no explicit parent-then-child merge loop and no precedence rule written in Flask**; ordering, overriding, and "child wins" are emergent from `dir()`/`getattr()`.

The values are written into a plain `dict` subclass. `Config.__init__` (`src/flask/config.py:94–100`) is:

```python
 94    def __init__(
 95        self,
 96        root_path: str | os.PathLike[str],
 97        defaults: dict[str, t.Any] | None = None,
 98    ) -> None:
 99        super().__init__(defaults or {})
100        self.root_path = root_path
```

and `Config` subclasses `dict` (`class Config(dict):`, `src/flask/config.py:50`), so each `self[key] = getattr(obj, key)` write is an ordinary dict insertion.

### Empirical confirmation (executed, no source edits)

A direct repro of the MRO mechanism was run (`/tmp/mro_repro.py`, `.venv/Scripts/python.exe /tmp/mro_repro.py`, exit status **0**). Script:

```python
import flask

class Base:
    INHERITED_KEY = "from-base"
    OVERRIDE_KEY = "base-value"

class Child(Base):
    OVERRIDE_KEY = "child-value"
    OWN_KEY = "child-only"

app = flask.Flask(__name__)
print("dir(Child) uppercase names:", sorted(k for k in dir(Child) if k.isupper()))

app.config.from_object(Child)
print("INHERITED_KEY present in app.config:", "INHERITED_KEY" in app.config)
print("app.config['INHERITED_KEY'] =", app.config.get("INHERITED_KEY"))
print("app.config['OVERRIDE_KEY']  =", app.config.get("OVERRIDE_KEY"))
print("app.config['OWN_KEY']       =", app.config.get("OWN_KEY"))

assert app.config["INHERITED_KEY"] == "from-base", "inherited attribute not loaded"
assert app.config["OVERRIDE_KEY"] == "child-value", "child override did not win"
assert app.config["OWN_KEY"] == "child-only", "own attribute not loaded"

print("Child.__mro__:", [c.__name__ for c in Child.__mro__])
print("'INHERITED_KEY' in Child.__dict__:", "INHERITED_KEY" in Child.__dict__)
print("'INHERITED_KEY' in Base.__dict__:", "INHERITED_KEY" in Base.__dict__)
print("MRO REPRO ASSERTS PASSED")
```

Complete output:

```
dir(Child) uppercase names: ['INHERITED_KEY', 'OVERRIDE_KEY', 'OWN_KEY']
INHERITED_KEY present in app.config: True
app.config['INHERITED_KEY'] = from-base
app.config['OVERRIDE_KEY']  = child-value
app.config['OWN_KEY']       = child-only
Child.__mro__: ['Child', 'Base', 'object']
'INHERITED_KEY' in Child.__dict__: False
'INHERITED_KEY' in Base.__dict__: True
MRO REPRO ASSERTS PASSED
```

This shows the exact three effects: the parent-only `INHERITED_KEY` (absent from `Child.__dict__`) is loaded; the child `OVERRIDE_KEY` defeats the parent value; the child-only `OWN_KEY` loads.

---

## 2. The secondary chain: which `Config` subclass is the destination — `src/flask/sansio/app.py:196`, `:482`, `:496`

The question's phrase "parent and child configuration classes" also admits an app-level reading: a `Flask` subclass whose `config_class` is a child of `Config`. That chain is a *separate* inheritance lookup, and it determines the type of the mapping that `from_object` writes into.

`config_class`, `src/flask/sansio/app.py:187–196`:

```python
187    #: The class that is used for the ``config`` attribute of this app.
188    #: Defaults to :class:`~flask.Config`.
189    #:
190    #: Example use cases for a custom class:
191    #:
192    #: 1. Default values for certain config options.
193    #: 2. Access to config values through attributes in addition to keys.
194    #:
195    #: .. versionadded:: 0.11
196    config_class = Config
```

`make_config`, `src/flask/sansio/app.py:482–496` — the consumer of `config_class` (line 496):

```python
482    def make_config(self, instance_relative: bool = False) -> Config:
483        """Used to create the config attribute by the Flask constructor.
484        The `instance_relative` parameter is passed in from the constructor
485        of Flask (there named `instance_relative_config`) and indicates if
486        the config should be relative to the instance path or the root path
487        of the application.
488
489        .. versionadded:: 0.8
490        """
491        root_path = self.root_path
492        if instance_relative:
493            root_path = self.instance_path
494        defaults = dict(self.default_config)
495        defaults["DEBUG"] = get_debug_flag()
496        return self.config_class(root_path, defaults)
```

Line-number confirmation from the executed pass:

```
== sansio/app.py ==
21:from ..config import Config
22:from ..config import ConfigAttribute
196:    config_class = Config
319:        self.config = self.make_config(instance_relative_config)
482:    def make_config(self, instance_relative: bool = False) -> Config:
496:        return self.config_class(root_path, defaults)
```

`make_config` is invoked from `App.__init__` at line 319 (`self.config = self.make_config(instance_relative_config)`). Because both `self.make_config` and `self.config_class` are ordinary attribute lookups that follow the **app-class MRO**, a `Flask` subclass that sets `config_class` changes the *destination type* of the object that `from_object` later writes into — while §1 describes the *source* inheritance chain of the class being loaded. The concrete `class Flask(App)` in `src/flask/app.py` (line 81) does **not** override `config_class` or `make_config`.

---

## 3. Corroborating test: `test_config_from_class` proves the parent→child chain is honoured

`tests/test_config.py`, constants + assertion helper (lines 8–16):

```python
  8    # config keys used for the TestConfig
  9    TEST_KEY = "foo"
 10    SECRET_KEY = "config"
 11
 12
 13    def common_object_test(app):
 14        assert app.secret_key == "config"
 15        assert app.config["TEST_KEY"] == "foo"
 16        assert "TestConfig" not in app.config
```

`test_config_from_class`, `tests/test_config.py:132–141` — the canonical parent→child proof: `TEST_KEY` exists **only** on `Base`, yet the shared helper asserts `app.config["TEST_KEY"] == "foo"`:

```python
132    def test_config_from_class():
133        class Base:
134            TEST_KEY = "foo"
135
136        class Test(Base):
137            SECRET_KEY = "config"
138
139        app = flask.Flask(__name__)
140        app.config.from_object(Test)
141        common_object_test(app)
```

`test_custom_config_class`, `tests/test_config.py:198–208` — the proof for the §2 `config_class` chain:

```python
198    def test_custom_config_class():
199        class Config(flask.Config):
200            pass
201
202        class Flask(flask.Flask):
203            config_class = Config
204
205        app = Flask(__name__)
206        assert isinstance(app.config, Config)
207        app.config.from_object(__name__)
208        common_object_test(app)
```

Both were executed and pass. Narrow selection run (`.venv/Scripts/pytest.exe tests/test_config.py -v --tb=short -k "from_class or custom_config_class or from_object"`, exit **0**):

```
tests/test_config.py::test_config_from_object PASSED                     [ 33%]
tests/test_config.py::test_config_from_class PASSED                      [ 66%]
tests/test_config.py::test_custom_config_class PASSED                    [100%]

====================== 3 passed, 16 deselected in 0.06s =======================
```

Full config suite (`.venv/Scripts/pytest.exe tests/test_config.py`, exit **0**):

```
tests\test_config.py ...................                                 [100%]

============================= 19 passed in 0.14s ==============================
```

Related suites together (`tests/test_config.py tests/test_instance_config.py tests/test_subclassing.py`, exit **0**): `27 passed in 0.34s`. Full repository suite (`tests/`, exit **0**): `489 passed in 5.06s`. No source files were modified.

---

## 4. Documented pattern + the `@property` caveat — `docs/config.rst:683–737`

The docs describe exactly the class-inheritance pattern this loop makes possible. Lead-in at line 683:

```
683    An interesting pattern is also to use classes and inheritance for
684    configuration::
685
686        class Config(object):
687            TESTING = False
688
689        class ProductionConfig(Config):
690            DATABASE_URI = 'mysql://user@localhost/foo'
691
692        class DevelopmentConfig(Config):
693            DATABASE_URI = "sqlite:////tmp/foo.db"
694
695        class TestingConfig(Config):
696            DATABASE_URI = 'sqlite:///:memory:'
697            TESTING = True
698
699    To enable such a config you just have to call into
700    :meth:`~flask.Config.from_object`::
701
702        app.config.from_object('configmodule.ProductionConfig')
703
704    Note that :meth:`~flask.Config.from_object` does not instantiate the class
705    object. If you need to instantiate the class, such as to access a property,
706    then you must do so before calling :meth:`~flask.Config.from_object`::
707
708        from configmodule import ProductionConfig
709        app.config.from_object(ProductionConfig())
710
711        # Alternatively, import via string:
712        from werkzeug.utils import import_string
713        cfg = import_string('configmodule.ProductionConfig')()
714        app.config.from_object(cfg)
715
716    Instantiating the configuration object allows you to use ``@property`` in
717    your configuration classes::
718
719        class Config(object):
720            """Base config, uses staging database server."""
721            TESTING = False
722            DB_SERVER = '192.168.1.56'
723
724            @property
725            def DATABASE_URI(self):  # Note: all caps
726                return f"mysql://user@{self.DB_SERVER}/foo"
727
728        class ProductionConfig(Config):
729            """Uses production database server."""
730            DB_SERVER = '192.168.19.32'
731
732        class DevelopmentConfig(Config):
733            DB_SERVER = 'localhost'
734
735        class TestingConfig(Config):
736            DB_SERVER = 'localhost'
737            DATABASE_URI = 'sqlite:///:memory:'
```

The `ProductionConfig(Config)` / `TestingConfig(Config)` pattern only works because `from_object` sees inherited names — this is the documentation-side confirmation of the answer.

**The `@property` caveat** (lines 704–717 above, echoed in the method docstring at `src/flask/config.py:236–238`): `from_object` does **not** instantiate the class. When a class (not an instance) is passed, `getattr(cls, name)` returns the `property` object itself rather than invoking the descriptor, so a `@property DATABASE_URI` would load the descriptor, not the computed string. Passing `ProductionConfig()` instead makes `dir()`/`getattr()` operate on an instance, where MRO lookup on the instance's type again finds inherited members — but with the descriptor correctly invoked. The docstring states it directly: "If the object is a class and has ``@property`` attributes, it needs to be instantiated before being passed to this method."

Corroborating doc/change statements:
- `docs/config.rst:25`: "The :attr:`~flask.Flask.config` is actually a subclass of a dictionary and can be modified just like any dictionary::"
- `docs/config.rst:506–508`: "The configuration files themselves are actual Python files.  Only values in uppercase are actually stored in the config object later on.  So make sure to use uppercase letters for your config keys."
- `docs/config.rst:674`: "there are alternative ways as well.  For example you could use imports or subclassing."
- `CHANGES.rst:1068`: "Added ``Flask.config_class``."

---

## Summary table

| Role of inheritance chain | Location | What it affects | Proof |
|---|---|---|---|
| **Source** — the class object passed to `from_object` | `src/flask/config.py:252` `for key in dir(obj):`; `:253` `if key.isupper():`; `:254` `self[key] = getattr(obj, key)` | Which uppercase names are enumerated and which value wins. `dir()` spans the class MRO; `getattr()` resolves along it, child override wins, parent-only names are still loaded. | `test_config_from_class` (`tests/test_config.py:132`, inherited `TEST_KEY`); MRO repro (`dir(Child)` → `['INHERITED_KEY','OVERRIDE_KEY','OWN_KEY']`, child override wins) |
| **Destination** — the app's `config_class` chain | `src/flask/sansio/app.py:196` `config_class = Config`, consumed at `:496` `return self.config_class(root_path, defaults)` in `make_config` (`:482`), invoked at `:319` | Which `Config` subclass instance receives the resolved values. `self.config_class` follows the app-class MRO. | `test_custom_config_class` (`tests/test_config.py:198`) |

**Precise location to cite for "loading from a class object":** `Config.from_object`, **`src/flask/config.py:252`** (`for key in dir(obj):`, with the value fetch on line 254). Everything about parent/child resolution behaviour happens there, implicitly, through `dir()` and `getattr()` — Flask writes no MRO walk and no explicit override rule of its own.

*(Note: the directory also contains `flask_mut2_i417ar2x/mutated_test.py`, but it is a subdomain-routing/`url_for` artifact with only a plain `app.config["SERVER_NAME"] = ...` assignment — no class-based loading and no inheritance — and it does not bear on this question.)*
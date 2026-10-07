# Final Answer

**Short answer:** The JSON tag class that handles Markup API objects is **`TagMarkup`**, defined at **`src/flask/json/tag.py:173–188`**. Its two conversion methods — `TagMarkup.to_json` (`:184–185`) and `TagMarkup.to_python` (`:187–188`) — are inlined one-liners that call **no in-repo helper function at all**; they delegate only to the external MarkupSafe API (`value.__html__()`, the builtin `str()`, and the imported `Markup(...)` constructor, `from markupsafe import Markup` at `:52`). The lower-level helper **methods** that actually drive the serialization pipeline live in the *same file*, on **`TaggedJSONSerializer`** (class at `:219`): `tag` (`:289`), `untag` (`:297`), `_untag_scan` (`:309`), `dumps` (`:321`), `loads` (`:325`) — plus the tag-agnostic wrapper **`JSONTag.tag`** (`:87`). That pipeline bottoms out in the module-level functions in **`src/flask/json/__init__.py`**: `dumps` (`:13`, body `:41–44`) and `loads` (`:77`, body `:103–106`). A distinct, sibling location for the same `__html__` protocol — used only on the plain (non-tagged) provider path — is **`_default` in `src/flask/json/provider.py`** (`:108`, `__html__` branch `:118–119`).

---

## 1. The Markup tag class: `TagMarkup` (no in-repo helper inside it)

`src/flask/json/tag.py:173–188` (verbatim, re-read and confirmed):

```python
class TagMarkup(JSONTag):
    """Serialize anything matching the :class:`~markupsafe.Markup` API by
    having a ``__html__`` method to the result of that method. Always
    deserializes to an instance of :class:`~markupsafe.Markup`."""

    __slots__ = ()
    key = " m"

    def check(self, value: t.Any) -> bool:
        return callable(getattr(value, "__html__", None))

    def to_json(self, value: t.Any) -> t.Any:
        return str(value.__html__())

    def to_python(self, value: t.Any) -> t.Any:
        return Markup(value)
```

- `to_json` (`:185`) = `str(value.__html__())` → MarkupSafe protocol method + builtin `str`.
- `to_python` (`:188`) = `Markup(value)` → MarkupSafe constructor imported at `:52`.
- Grep over lines 173–188 for `self.` returns **nothing** — no `self.serializer.*` delegation, unlike the other tags: `TagDict.to_json` (`:112`), `PassDict.to_json` (`:128`), `TagTuple.to_json` (`:141`), `PassList.to_json` (`:154`) all call `self.serializer.tag(...)`.

It is the only Markup-handling tag class in `src/`: `grep -rn "Markup" src/` yields only `tag.py:52,173,174,176,188,229,244` and `provider.py:134`; `grep -rn "__html__" src/` yields only `provider.py:118,119,134,135` and `tag.py:175,182,185`.

## 2. The pipeline helpers on `TaggedJSONSerializer` (same file, `src/flask/json/tag.py`)

Verbatim, `:289–327` (re-read and confirmed):

```python
    def tag(self, value: t.Any) -> t.Any:
        """Convert a value to a tagged representation if necessary."""
        for tag in self.order:
            if tag.check(value):
                return tag.tag(value)

        return value

    def untag(self, value: dict[str, t.Any]) -> t.Any:
        """Convert a tagged representation back to the original type."""
        if len(value) != 1:
            return value

        key = next(iter(value))

        if key not in self.tags:
            return value

        return self.tags[key].to_python(value[key])

    def _untag_scan(self, value: t.Any) -> t.Any:
        if isinstance(value, dict):
            # untag each item recursively
            value = {k: self._untag_scan(v) for k, v in value.items()}
            # untag the dict itself
            value = self.untag(value)
        elif isinstance(value, list):
            # untag each item recursively
            value = [self._untag_scan(item) for item in value]

        return value

    def dumps(self, value: t.Any) -> str:
        """Tag the value and dump it to a compact JSON string."""
        return dumps(self.tag(value), separators=(",", ":"))

    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

and the tag-agnostic wrapper on the base class, `:87–90`:

```python
    def tag(self, value: t.Any) -> dict[str, t.Any]:
        """Convert the value to a valid JSON type and add the tag structure
        around it."""
        return {self.key: self.to_json(value)}
```

`TagMarkup` is registered at `:244` inside `default_tags`, so the `" m"` key routes back to it in `self.tags` (`:283`).

**Serialize edge list:** `TaggedJSONSerializer.dumps` `:321` → `dumps(self.tag(value), separators=(",", ":"))` `:323` → `TaggedJSONSerializer.tag` `:289` → `tag.check(value)` `:292` → `TagMarkup.check` `:181–182` → `tag.tag(value)` `:293` → `JSONTag.tag` `:87–90` → `TagMarkup.to_json` `:184–185` → `src/flask/json/__init__.py:13`.

**Deserialize edge list:** `TaggedJSONSerializer.loads` `:325` → `self._untag_scan(loads(value))` `:327` → `src/flask/json/__init__.py:77` → `_untag_scan` `:309` → `self.untag(value)` **`:314`** → `untag` `:297` → `self.tags[key].to_python(value[key])` `:307` → `TagMarkup.to_python` `:187–188`.

Runtime confirmation (from the executed results, using the working directory's source): `dumps(Markup("<html>")) == '{" m":"<html>"}'` and `loads` returns `Markup('<html>')`; `inspect.getsourcelines` reported `TaggedJSONSerializer.tag` at 289, `untag` 297, `_untag_scan` 309, `dumps` 321, `loads` 325, `JSONTag.tag` 87.

## 3. Where the pipeline bottoms out (`src/flask/json/__init__.py`)

```python
def dumps(obj: t.Any, **kwargs: t.Any) -> str:
    ...
    if current_app:
        return current_app.json.dumps(obj, **kwargs)

    kwargs.setdefault("default", _default)
    return _json.dumps(obj, **kwargs)
```
(`:13`; body `:41–44` — imports of these bare names into `tag.py` are `from ..json import dumps` / `from ..json import loads`, `tag.py:56–57`)

```python
def loads(s: str | bytes, **kwargs: t.Any) -> t.Any:
    ...
    if current_app:
        return current_app.json.loads(s, **kwargs)

    return _json.loads(s, **kwargs)
```
(`:77`; body `:103–106`)

## 4. Distinct sibling: plain-provider Markup path (`src/flask/json/provider.py`)

Not part of the tag serializer, but the other place the `__html__` API is converted:

```python
def _default(o: t.Any) -> t.Any:
    if isinstance(o, date):
        return http_date(o)

    if isinstance(o, (decimal.Decimal, uuid.UUID)):
        return str(o)

    if dataclasses and dataclasses.is_dataclass(o):
        return dataclasses.asdict(o)  # type: ignore[arg-type]

    if hasattr(o, "__html__"):
        return str(o.__html__())

    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")
```
(`:108`; `__html__` branch `:118–119`; wired as `DefaultJSONProvider.default` at `:138`, used in `DefaultJSONProvider.dumps` at `:166` with `kwargs.setdefault("default", self.default)` at `:176`.) Runtime: `flask.json.dumps(Markup("<html>"))` → `'"<html>"'`.

---

## Disambiguating the question's two readings

- If "conversion method" = `TagMarkup.to_json`/`to_python`: **there are no lower-level in-repo helper functions**; the helpers are external MarkupSafe (`__html__`, `str`, `Markup`) — `tag.py:184–188`, import at `:52`.
- If "conversion method" = the serializer's `dumps`/`loads`: the lower-level helpers are `TaggedJSONSerializer.tag` (`tag.py:289`), `untag` (`:297`), `_untag_scan` (`:309`), `dumps` (`:321`), `loads` (`:325`), plus `JSONTag.tag` (`:87`) — all in `src/flask/json/tag.py`, with `src/flask/json/__init__.py` `dumps`/`loads` as the final bottom-out.

**Correction to an inherited citation:** the `self.untag(value)` call inside `_untag_scan` is at `src/flask/json/tag.py:314`, not `:315` (verified by re-read and by `grep -n`). All other line numbers above were re-verified against the files.

**Context that is not an answer:** `flask_mut2_i417ar2x/mutated_test.py` is a `url_for`/subdomain-routing script unrelated to JSON/Markup; `tests/test_json_tag.py::test_dump_load_unchanged[<html>]` and `tests/test_basic.py` session assertions merely exercise the round trip. Full suite: 489 passed, plus the 14 `tests/test_json_tag.py` tests.
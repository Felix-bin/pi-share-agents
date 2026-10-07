# Where the delegates live

The JSON tag class that handles Markup API objects is **`TagMarkup`**, with `key = " m"`, at `src/flask/json/tag.py:173-188` (registered in `TaggedJSONSerializer.default_tags`, `tag.py:244`). Its serialization conversion method is:

```python
# src/flask/json/tag.py:184-185
def to_json(self, value: t.Any) -> t.Any:
    return str(value.__html__())
```

That method delegates to exactly two things, and **neither is defined inside the tag module**:

- **`value.__html__()`** — resolved on the argument's own class, not from Flask. For a `Markup` instance it lands on `Markup.__html__`, `.venv/Lib/site-packages/markupsafe/__init__.py:133-134`, whose body is `return self`.
- **`str`** — the Python builtin, not a project helper. This matters because the natural expectation of a `Markup.__str__` helper is *wrong*: line 369 of `.venv/Lib/site-packages/markupsafe/__init__.py` (read directly, confirmed) is the `__str__` of `_MarkupEscapeHelper` (class at line 357, `__slots__ = ("obj", "escape")`, body `return str(self.escape(self.obj))`). `Markup` is declared at line 84 and defines no own `__str__`; the executor's run returned `Markup.__str__ is str.__str__` → `True`. So the second half of `str(value.__html__())` resolves to the builtin over the inherited `str` base.

On the deserialization side, the delegate is also external: `TagMarkup.to_python`, `tag.py:187-188` → `Markup(value)` → `Markup.__new__`, `.venv/Lib/site-packages/markupsafe/__init__.py:122-131` (`if hasattr(object, "__html__"): object = object.__html__()`, then `super().__new__(...)`). The import that connects them is `from markupsafe import Markup` at `tag.py:52`.

The full in-repo pipeline reaching that conversion method, each frame confirmed by reading the file:

```
TaggedJSONSerializer.dumps   tag.py:321-323  → dumps(self.tag(value), separators=(",", ":"))
TaggedJSONSerializer.tag     tag.py:289-295  → for tag in self.order: if tag.check(value): return tag.tag(value)
JSONTag.tag                  tag.py:87-90    → return {self.key: self.to_json(value)}
TagMarkup.to_json            tag.py:184-185  → return str(value.__html__())
```

So the only module-level helper anywhere on `TagMarkup`'s serialization path is `dumps` (`from ..json import dumps`, `tag.py:53`, defined `src/flask/json/__init__.py:13`); the other module-level imports of `tag.py` (`loads`, `b64encode`/`b64decode`, `http_date`/`parse_date`) belong to `TagBytes`/`TagDateTime`, not `TagMarkup`. The leaf delegates — `__html__` and `str` — are outside the repository's `src/` tree entirely, in the installed `markupsafe` package.

**A separate, non-tag path with the identical shape** exists at `src/flask/json/provider.py:118-119`: `if hasattr(o, "__html__"): return str(o.__html__())` inside `_default`. It is reached from `json.dumps(default=_default)` via `src/flask/json/__init__.py:13`, not from any JSON tag class — worth naming so it is not confused with the tag pipeline.

**End-to-end confirmation by execution** (`.venv/Scripts/python.exe`, worktree root): `TagMarkup(s).to_json(Markup('<b>x</b>'))` → `'<b>x</b>'`; `TaggedJSONSerializer().dumps(Markup('<b>x</b>'))` → `{" m":"<b>x</b>"}`; `loads(dumps(Markup('<b>x</b>')))` → `Markup('<b>x</b>')`; `pytest tests/test_json_tag.py -q` → `14 passed`. Note `.venv/` is gitignored (`git check-ignore -v` → `.venv/.gitignore:1:*`), so a default repo-wide search does **not** reach the markupsafe helpers — they must be opened under `.venv/Lib/site-packages/`.

## Reading ambiguity (reported, not silently decided)

"the conversion method" admits three readings; I answer under the first because the question says *serialization* and `to_json` is the direction-specific method on this class:

1. **`TagMarkup.to_json`** (chosen) → delegates to `__html__` and `str`, both outside the tag module.
2. **The inherited wrapper `JSONTag.tag`** (`tag.py:87-90`) → its immediately lower helper is `TagMarkup.to_json` itself, same file and class.
3. **Module-level `dumps`** as the "helper function" → `src/flask/json/__init__.py:13`.

Also unresolved by the wording: whether the expected answer location is the repo file `src/flask/json/tag.py` or the installed-package file, and whether the plural "helper functions" means `__html__`/`str` or `Markup.__new__`/`__html__`. Both are given above; the wording does not decide them. (Path note: the session's ranking corpus labels files `flask/src/flask/json/tag.py`; in this worktree the same content is at `src/flask/json/tag.py`.)

## What this rests on, and what remains open

Rests on: direct reads of `src/flask/json/tag.py:170-190` and `.venv/Lib/site-packages/markupsafe/__init__.py` (lines 84, 122-134, 355-372) performed here; retriever's reading of `tag.py:52-54, 87-90, 238-247, 289-295, 321-323` and `provider.py:108-121`; executor's run results (tag method outputs, round trip, the `Markup.__str__ is str.__str__` check, `14 passed` pytest). No files were edited.

Contradiction carried forward: the planner's expectation of `Markup.__str__` at `markupsafe/__init__.py:369` is **contradicted**, not confirmed — that `__str__` belongs to `_MarkupEscapeHelper`.

Open: which of the three readings the question intends; whether the requested location is the in-repo `tag.py` or the installed `markupsafe` file; whether plural "helper functions" is meant literally (only one method plus one builtin exist for `to_json`). No mutation affecting the tag/Markup code was found in the worktree; `flask_mut2_i417ar2x/mutated_test.py` is an unrelated subdomain-routing repro with no `Markup`/`__html__`/tag references.
# Where the Markup tag's conversion helpers live

**Short answer: the premise doesn't hold for `TagMarkup`. Its two conversion methods delegate to no helper defined in this worktree — their only callees are external (`value.__html__()` and `markupsafe.Markup`). The in-file helpers that surround the conversion sit one level *above* it, on the serializer side; nothing sits below it.**

The tag class that handles Markup API objects is `TagMarkup` (`src/flask/json/tag.py:173-188`), identified by `key = " m"` (line 179) and by `check` (181-182) `return callable(getattr(value, "__html__", None))`. It is the only `*Tag` class whose `check`/docstring turn on `__html__`; the other `__html__` site in the tree is the provider's generic hook, not a tag class.

Its conversion method bodies are one line each and were verified both statically and at runtime (the executor's monkeypatch trace and direct-body probe):

- `to_json` — `tag.py:184-185`: `return str(value.__html__())`. Callee = the value's own duck-typed `__html__`, wrapped in the builtin `str`.
- `to_python` — `tag.py:187-188`: `return Markup(value)`. Callee = `markupsafe.Markup`, imported at `tag.py:52`.

Neither callee is a function defined in the worktree, and `TagMarkup` does not override `tag` — it inherits the base at `tag.py:87-90` (`return {self.key: self.to_json(value)}`).

So the *lower-level* helper functions the question looks for do not exist below the conversion. The helpers that actually drive the conversion are **upstream of it**, and are what calls the conversion:

**Dump path** (executor's traced call order on `s.dumps({"x": Markup("<b>hi</b>")})` → `{"x":{" m":"<b>hi</b>"}}`):
`TaggedJSONSerializer.dumps` (`tag.py:321-323`) → `TaggedJSONSerializer.tag` (`289-294`, dispatches in `self.order`) → `JSONTag.tag` (`87-90`, wraps the result with the key) → `TagMarkup.to_json` (`184-185`) → module-level `dumps` imported at `tag.py:56-57` from `..json`.

**Load path** (round-trip result `markupsafe.Markup('<b>hi</b>')`, equality `True`):
`TaggedJSONSerializer.loads` (`325-327`) → `_untag_scan` (`309-318`, recursive, ×3) → `untag` (`297-307`, delegating at line 307 `return self.tags[key].to_python(value[key])`) → `TagMarkup.to_python` (`187-188`).

`TagMarkup` is registered for that dispatch in `default_tags` at `tag.py:244` (`TaggedJSONSerializer.register`, `256-287`).

**The one genuinely separate second conversion of the same kind** is *not* part of `TagMarkup`'s path: `_default` in `src/flask/json/provider.py:108-121` has a Markup-relevant branch at lines 118-119, `if hasattr(o, "__html__"): return str(o.__html__())` — the same one-line conversion, reached in parallel through the provider (`DefaultJSONProvider.dumps` at `provider.py:166-179` → `json.dumps(..., default=self.default)`) when a Markup object survives tagging. The executor confirmed this branch is not reached in the traced TagMarkup round trip.

**Contradiction to report plainly:** the question's phrase "lower-level helper functions that the conversion method delegates to" has no literal referent at `TagMarkup`. Greps over `__html__`, `to_json`, `to_python` and `class .*Tag` returned no in-worktree callee at lines 184-188, and the runtime trace showed none intervening. The nearest in-file helpers (`JSONTag.tag` 87-90; `TaggedJSONSerializer.tag`/`untag`/`_untag_scan` 289-318) are delegates of `TaggedJSONSerializer.dumps`/`loads` — i.e. one level **above** the conversion, not below it. If the intended referent was meant to be those, the answer is 289-318; if it meant markupsafe internals, that is outside this worktree and unread.

Path note: corpus paths are prefixed `flask/`; in this worktree the file is `src/flask/json/tag.py` (repo root = worktree root).

## What this rests on
- `TagMarkup` static layout and one-line bodies — `src/flask/json/tag.py:173-188`, `Markup` import at `52` (memory `a1ce99dd49d6`; re-read here).
- Tag-layer helper layout — `src/flask/json/tag.py:87-90`, `289-294`, `297-307`, `309-318`, `321-327` (memory `84c490dfed3d`; re-read here).
- Parallel provider conversion — `src/flask/json/provider.py:108-121` (branch at 118-119).
- Runtime call traces, direct-body probe and `tests/test_json_tag.py` 14 passed in 0.07s (exit 0), with `PYTHONPATH=src` — executor under handle `5614fa3593fb`, memory `e0bc3679b606`.

## Still open
- Internals of `markupsafe.Markup.__html__` and the `Markup()` constructor were not read (external package) — if that is the intended referent, it remains unverified.
- The full test suite was not run; only `tests/test_json_tag.py` was exercised, plus the provider-path test definitions at `tests/test_json.py:341-343` were read but not run.
- The `.venv` has an editable `flask` install resolving outside the worktree; all runtime results depend on `PYTHONPATH=src` being set.
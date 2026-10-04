## The ASCII-only control and Unicode representation: a direct, one-attribute relationship

The framework's JSON serialization provider has a single attribute that governs it: **`DefaultJSONProvider.ensure_ascii`**, declared `True` at `src/flask/json/provider.py:144`, with the docstring *"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*

The relationship is causal and per-character: **`ensure_ascii` is forwarded as the `ensure_ascii` default to the standard-library `json.dumps` call, and therefore decides whether each non-ASCII code point in the serialized JSON text appears as a literal Unicode character or as a `\uXXXX` escape sequence.** With `ensure_ascii = True` (the default) non-ASCII characters are replaced by escapes and the serialized text is pure ASCII; with `False` they survive literally.

**How the attribute reaches the output.** `DefaultJSONProvider.dumps` (`provider.py:167–179`) does:

```
kwargs.setdefault("default", self.default)
kwargs.setdefault("ensure_ascii", self.ensure_ascii)
kwargs.setdefault("sort_keys", self.sort_keys)
return json.dumps(obj, **kwargs)
```

Because it is `setdefault`, the attribute is a *default*, not a hard setting: an explicit `ensure_ascii=` argument passed to `dumps` wins. The executor's probe confirmed this — with the attribute set to `False`, `app.json.dumps("\N{SNOWMAN}", ensure_ascii=True)` still returned `'"\\u2603"'`.

**Scope.** It is app-level, not call-site-level. `DefaultJSONProvider` is the class bound to every app (`src/flask/sansio/app.py:230`, instantiated as `self.json` at `app.py:329`), and `EnvironBuilder.json_dumps` (`src/flask/testing.py:88–94`) is just `self.app.json.dumps(obj, **kwargs)`, so test-client input encoding inherits the same attribute — demonstrated by `tests/test_testing.py:110–114`. Note the attribute is declared only on `DefaultJSONProvider`; the abstract base `JSONProvider` (`provider.py:19`) does not declare it. The legacy `JSON_AS_ASCII` config key no longer exists: `grep` finds no occurrence in `src/flask`, and `docs/config.rst:440–443` records it as removed in 2.3 with "The default `app.json` provider has equivalent attributes instead."

**Observed effect, text and bytes.** `tests/test_json.py:47–54` parametrizes the snowman `"\N{SNOWMAN}"` over both settings and asserts `'"\\u2603"'` for `True` versus `'"☃"'` for `False` — i.e. an ASCII escape (8 characters) versus the literal code point (3 characters). Both results are `str`; only the escaping differs. The executor measured the end-to-end consequence: with `True` the response body is `b'"\\u2603"\n'`; with `False` it is `b'"\xe2\x98\x83"\n'`, the UTF-8 bytes of U+2603, with `Content-Type: application/json` in both cases. That UTF-8 body-encoding step — left as an inference by the retriever — is now directly observed.

**Verification status and limits.** The parametrized test and the `EnvironBuilder` test pass against the worktree source (3 passed; the whole `tests/test_json.py` file, 31 passed). All checks were read-only probes: no defaults were changed, no config alias was added, and no non-JSON suites were run — so the question of *whether the default should be either value* is untouched by this evidence, as is the existence or absence of any provider alias other than `JSONProvider.ensure_ascii`. One tooling caveat qualifies the executed results: the worktree venv's `flask.pth` points outside the working directory, so every command required `PYTHONPATH=<worktree>/src`; `inspect.getfile(flask)` confirmed that without it the tests import a different source tree.

**What this rests on:** `src/flask/json/provider.py:144,167–179,190–217`; `src/flask/sansio/app.py:230,329`; `src/flask/testing.py:88–94`; `tests/test_json.py:47–54`; `tests/test_testing.py:110–114`; `docs/config.rst:440–443`; `CHANGES.rst:285–288`; the executor's pytest run (3 passed, file 31 passed) and its `dumps`/`response` byte-level probe.

**Still open:** whether the default `True` is the intended behaviour for any particular deployment (not evaluated — no edits made); the absence of any `JSON_AS_ASCII`-style alias is established only for `src/flask`, not for docs or tests at large; and the unrelated `flask_mut2_i417ar2x/mutated_test.py` mutation scaffold in the worktree is not part of this relationship.
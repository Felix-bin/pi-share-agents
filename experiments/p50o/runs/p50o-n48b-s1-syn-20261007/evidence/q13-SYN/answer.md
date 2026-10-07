# How `_lazy_sha1` defers hash-algorithm access to runtime

The wrapper is the module-level function `_lazy_sha1` in `src/flask/sessions.py`. It works by decoupling *when the name is bound* from *when the hash constructor is looked up*: import binds only the plain function object, and the expression `hashlib.sha1(...)` sits inside the function body, where it is not evaluated until the callable is actually invoked.

**The wrapper itself** — `src/flask/sessions.py:290`–294:

```python
def _lazy_sha1(string: bytes = b"") -> t.Any:
    """Don't access ``hashlib.sha1`` until runtime. FIPS builds may not include
    SHA-1, in which case the import and use as a default would fail before the
    developer can configure something else.
    """
```

with the deferred expression in the body at `:295`:

```python
    return hashlib.sha1(string)
```

Three properties of the code produce the delay:

1. **The module import touches only `hashlib`, never `sha1`.** `src/flask/sessions.py:4` is `import hashlib`. Importing a module does not require that any particular algorithm be present, so this line is safe in a build without SHA-1. The algorithm access is the attribute lookup `hashlib.sha1` at `:295`, which lives inside the function body and therefore runs only when `_lazy_sha1` is called, not when the module is loaded.

2. **The class binding is a function object, not a digest.** `src/flask/sessions.py:307`, inside `SecureCookieSessionInterface`: `digest_method = staticmethod(_lazy_sha1)`. Running the class body evaluates only the name `_lazy_sha1`; no call is made. Wrapping it in `staticmethod` is what keeps the function from becoming a descriptor-bound method, so its single positional parameter `string` receives the data argument directly instead of being consumed by an implicit `self`. The default `string: bytes = b""` means even a zero-argument invocation stays inside the deferred path rather than failing on the signature (that a caller ever does so is not established here).

3. **The invocation point is session signing/verification, after startup.** `get_signing_serializer` at `src/flask/sessions.py:329`–337 builds the serializer and passes the class attribute through:

```python
            signer_kwargs={
                "key_derivation": self.key_derivation,
                "digest_method": self.digest_method,
            },
```

`URLSafeTimedSerializer` stores that callable; itsdangerous invokes it when a session cookie is signed or verified, which happens through `open_session`/`save_session` on each request. That is the point at which `hashlib.sha1(string)` finally executes.

**Consequence.** In an environment where SHA-1 is unavailable (the docstring's FIPS case), importing `flask.sessions` succeeds; no hash constructor is resolved. Failure occurs only if the default `digest_method` is actually exercised — i.e. when a session cookie is signed or verified — and by then `digest_method` is an overridable class attribute, so the application can point it at an approved algorithm first. That is the "developer has time to configure something else" of the docstring and of `CHANGES.rst:62`–64, the Version 3.0.3 entry (released 2024-04-07, issue 5448): "The default `hashlib.sha1` may not be available in FIPS builds. Don't access it at import time so the developer has time to change the default."

So the delay mechanism is: **bind the function, not the algorithm** — an inert body holding the deferred lookup, a `staticmethod` binding that performs no call at import, and a call site that only fires when the serializer is used.

**What this answer rests on, and what is open**

- Rests on: `src/flask/sessions.py:4, 290`–295, `307`, `329`–337` (read directly in this worktree); `CHANGES.rst:62`–64.
- Coverage: the task's mechanism question is fully answered — the wrapper's identity, its deferral, its import-time versus runtime distinction, and the restricted-environment (FIPS) rationale each trace to a specific quoted line.
- Not established: the exact invocation site inside itsdangerous (that library's source is outside the read window — the per-request timing follows from itsdangerous receiving the callable as `signer_kwargs["digest_method"]`), and whether any code outside this worktree overrides `digest_method`. A repo-wide grep for `digest_method|lazy_sha1|hashlib` matches only `src/flask/sessions.py:4,290,307,333`, `CHANGES.rst:62`, and the unrelated example `docs/patterns/requestchecksum.rst:17,23`; no test overrides `digest_method`, and `flask_mut2_i417ar2x/` is unrelated (it tests subdomain `url_for`). The wording "restricted environments" is read as FIPS builds per the docstring and the changelog; a sandbox lacking `hashlib` altogether would produce the same mechanism.
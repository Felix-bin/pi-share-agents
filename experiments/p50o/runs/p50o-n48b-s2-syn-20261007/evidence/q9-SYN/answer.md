# Why repeated serializer construction in the session handler is a bottleneck — and where that premise does not hold

## The mechanism

The session persistence handler is `SecureCookieSessionInterface` (`src/flask/sessions.py`), the default session interface stored as an app-lifetime class attribute (`src/flask/app.py:224`). The method that instantiates the cryptographic serializer is `get_signing_serializer` (`src/flask/sessions.py:317-335`), and it is the only construction site of `URLSafeTimedSerializer` in the whole of `src/flask` (import at `sessions.py:11`, the single construction at `sessions.py:327`).

It is invoked on **every request**, and not once per session — the construction happens before the code knows whether a session cookie even exists:

- `open_session` calls it **unconditionally as its first statement** (`sessions.py:338`), *before* the cookie is read (`sessions.py:341`). It is driven once per request-context push (`src/flask/ctx.py:385-386`).
- `save_session` calls it again at `sessions.py:387` (`... .dumps(dict(session))`), but only *after* the early returns for an empty session (`sessions.py:368-381`) and a non-writable one (`sessions.py:383-384`).

So the count is **one construction per request** when the session is empty or absent, and **two** when the session is non-empty and must be written. This refines the "twice per request" framing: the no-cookie path constructs once, not twice, and the measurement confirms it — removing the constructor from the empty-session `save_session` path changes it by +0.005 µs, i.e. that path builds nothing (the +6.312 µs and +12.904 µs deltas land on the two `open_session` paths).

**Why it is rebuilt every time instead of reused:** the key list is assembled fresh in the method body — `keys: list[str | bytes] = []` (`sessions.py:321`), extend with `SECRET_KEY_FALLBACKS` (`sessions.py:323-324`), append `app.secret_key` (`sessions.py:326`, comment "itsdangerous expects current key at top"). This is deliberate: reading the current secret and its fallbacks live is how key rotation works without invalidating active sessions (`docs/config.rst:128-132`). Nothing memoizes the result — `get_signing_serializer` stores nothing on `self` or the app; a repo-wide grep for `lru_cache|@cache|_cached|cachetools|functools` in `src/flask` finds only `helpers.py:627` on `_split_blueprint_path` and unrelated `cached_property` uses in `sansio/`, and nothing in `sessions.py`. The interface object is app-lifetime, so there is simply no place where a constructed serializer survives between requests.

**What one construction actually costs — and a correction:** `URLSafeTimedSerializer` and `TimedSerializer` define no `__init__`; construction lands in itsdangerous 2.2.0's `Serializer.__init__` (`serializer.py:192-235`), which copies the key list (`_make_keys_list`), coerces the salt, and stores the signer **class**, `signer_kwargs`, and a copy of `fallback_signers`. It performs **no hashing**. The signer/HMAC object graph is built lazily per operation in `make_signer` (`serializer.py:280-289`), reached by `dumps`/`iter_unsigners`, and the HMAC key derivation itself (`Signer.derive_key`, "hmac" branch) runs on every sign/verify and is likewise not memoized. The plan's step-3 claim that `Serializer.__init__` builds `TimestampSigner`/`Signer`/`HMACAlgorithm` is not what this version does; the heavier work sits in `dumps`/`loads`, not in the constructor.

## Where the "bottleneck" holds, and where it does not

Measured on this worktree (Flask 3.2.0.dev0, itsdangerous 2.2.0, Python 3.13.9, Windows; `.venv`, canonical run `_executor_measurements/_exec_measure.out`, no source file edited):

- **It is real and repeated, but small per call.** `get_signing_serializer` costs **4.513 µs** (1 key) / 4.742 µs (3 keys) per call. Removing it saves **+6.312 µs** on the unconditional no-cookie `open_session` (77 % of that 8.182 µs call), **+12.904 µs** on the valid-cookie `loads` path, and **+10.692 µs (13.6 %)** of a full cookie write. In a construction+dumps loop, a fresh serializer costs 37.520 µs/iter versus 28.747 µs/iter for a reused one — a **23.4 %** constructor share.
- **Under threads it does not parallelize.** The work is GIL-serialized: 2 and 4 processes reach 70.0k and 92.1k iter/s (2.5× and 3.3× the single process's 28.0k), while 2 and 4 threads reach 24.0k and 23.7k iter/s — i.e. *slower* than one process. So in a threaded worker model, concurrent requests contend on the same GIL for this per-call construction and the concurrency gain is lost; in a multi-process model each worker pays the cost independently and scales with cores.

**But the evidence does not support a *meaningful end-to-end* bottleneck, and the premise should be qualified.** The repeated construction is only ~**2–4 %** of a ~270–290 µs trivial in-process request, and in the common empty-session case it happens only once. The request-level caching control is not decisive: one run showed min-deltas of +21.6 / +24.1 / +15.7 µs in favour of the cached interface, but two earlier runs of the *same design* (`_exec_req.py`, `_exec_req2.py`) gave the **opposite sign** (−32.4 / −28.0 / +16.1 and −28.7 / −16.9 µs), so the effect sits below that harness's ~±30 µs noise. The arithmetic bound (4.5 µs × 1–2 per request) is the usable figure.

## Contradiction to report across the collected sources

The plan (via the retriever's step-3 audit) asserted that serializer construction builds the signer/HMAC graph; the retriever's source read and the executor's timing both show the opposite — construction is a key-list copy plus attribute assignments with no hashing, and the signer/HMAC work is per `dumps`/`loads`. The timing numbers (4.5 µs construction vs. 0.9 µs signer construction + 2.6 µs key derivation + 8.1 µs signature on the operation path) side with the retriever. This is a genuine correction, not a measurement-vs-source disagreement.

## What is answered and what remains open

**Answered:** *why* repeated invocation exists (per-request, un-cacheable by design because of key rotation, one unconditional call in `open_session` plus one conditional call in `save_session`), *what it costs* (~4.5 µs/call, 1–2 per request, up to 13.6 % of a cookie write), and *why high concurrency can amplify it* (the work holds the GIL, so threaded workers serialize on it and gain nothing from more threads).

**Not established:** any end-to-end effect on a real WSGI deployment. The concrete server model — threaded vs. multi-process — is pinned by no file in the worktree, and the amplification argument applies only to the threaded model; the retriever flagged that as an assumption and nothing in the evidence removes it. The request-level delta is below the test harness's noise floor. On the evidence collected, a *per-construction bottleneck of large magnitude* is not supported; a small, GIL-bound, structurally irreducible per-request cost is.

### Rests on
- Retriever (7bf2a9d02a31): target method and sole construction site; two call sites and lifecycle slots (`ctx.py:385-386`, `app.py:1321-1322`); key-list rebuild rationale (`docs/config.rst:128-132`); itsdangerous 2.2.0 construction/laziness chain; absence of caching.
- Executor (2a64dfe4545d) and `_executor_measurements/_exec_measure.out`: all unit, isolation, loop, thread/process and request-level numbers; discarded wrong variants `_exec_req.py`/`_exec_req2.py`.
- Direct checks: `src/flask/sessions.py:295-395`, `_executor_measurements/_exec_measure.py`, `_exec_measure.out`.

### Open
- Server/concurrency model not pinned anywhere in the worktree.
- No low-noise request-level measurement; deployment-level need not demonstrated.
- `flask_mut2_i417ar2x/mutated_test.py` not examined (out of scope; touches no session code).
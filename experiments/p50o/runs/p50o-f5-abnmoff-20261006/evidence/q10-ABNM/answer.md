## Dependency chain: `tests/test_testing.py::test_subdomain` (lines 302–317)

The function is `test_subdomain` (def at `tests/test_testing.py:302`). Its chain, in the order the links must hold:

1. **App construction with subdomain matching on** — `app = flask.Flask(__name__, subdomain_matching=True)` (`:303`). This is the load-bearing link: `subdomain_matching` defaults to `False` (`src/flask/app.py:233`) and the docs state setting `SERVER_NAME` does not imply it (`src/flask/app.py:143–145`, `:431–437`).
2. **Configuration** — `app.config["SERVER_NAME"] = "example.com"` (`:304`). Supplies the base host the subdomain is relative to; it does not enable matching (step 1), so it is a separate link.
3. **Test client** — `client = app.test_client()` (`:305`), created before the route is added.
4. **Route registration** — `@app.route("/", subdomain="<company_id>")` decorating `view` (`:306–308`); the rule carries a *dynamic* subdomain and the view returns the converted value.
5. **Request-context creation** — `with app.test_request_context():` (`:311`) → `url = flask.url_for("view", company_id="xxx")` (`:312`). With no request object, the URL adapter binds directly to `SERVER_NAME` (`src/flask/app.py:466–472`), so `url_for` yields the external URL captured by the lifted artifact as `url_for -> http://xxx.example.com/`.
6. **Dispatch through the same app** — `with client:` / `response = client.get(url)` (`:314–315`). Now a request exists, so the adapter takes the `request is not None` branch: with matching on, the host-derived subdomain `xxx` is kept and the `<company_id>` rule matches; `SERVER_NAME` no longer restricts the host (`src/flask/app.py:430–433`).
7. **Assertions** — `200 == response.status_code` and `b"xxx" == response.data` (`:316–317`). The body is the converted subdomain value, so the test verifies routing, not merely URL building.

So each link feeds only the next: steps 1 + 4 + 5 + 6 determine the 200/404 outcome, while steps 2 + 5 determine only the URL string. The run confirms the split: `pytest tests/test_testing.py::test_subdomain -v` → **1 passed, exit 0**, against unmodified `src/` (`git status --porcelain` shows only `?? flask_mut2_i417ar2x/`); the same body with *only* `subdomain_matching=True`→`False` (`flask_mut2_i417ar2x/mutated_test.py:3`) exits **1** — `url_for` still prints `http://xxx.example.com/`, but the request returns 404 (`AssertionError: status 404`, its line 20). The 404 follows from `src/flask/app.py:458–462`, which forces the request subdomain to `url_map.default_subdomain or ""` when `subdomain_matching` is false.

**Why this function and not the other two candidates.** Three functions in `tests/` contain configuration + subdomain registration + request-context creation:

- `test_subdomain` (`tests/test_testing.py:302`) — the answer: `SERVER_NAME` (`:304`), `@app.route(..., subdomain=...)` (`:307`), `app.test_request_context()` (`:311`), plus a real dispatch (`client.get(url)`, `:315`). It is also the body the artifact was lifted from, i.e. the only one of the three that is mutation-verified (runs above).
- `test_blueprint_with_subdomain` (`tests/test_testing.py:117–139`) — has `SERVER_NAME` (`:119`) and `Blueprint(..., subdomain="xxx")` (`:123`), but the subdomain is passed **explicitly** to `app.test_request_context("/", subdomain="xxx")` (`:131`) and `client.get("/", subdomain="xxx")` (`:137`), so it never depends on `SERVER_NAME` as the source of the subdomain; it also sets `APPLICATION_ROOT="/foo"` (`:120`) and asserts on `request.url` strings (`:132`, `:138`). Passes (ran: 1 passed).
- `test_proper_test_request_context` (`tests/test_reqctx.py:63–104`) — has `SERVER_NAME` (`:64`) and a `subdomain="foo"` rule (`:70`), but both contexts (`:74`, `:80`) only assert `url_for(..., _external=True)` strings (`:75–79`, `:81–85`); no request reaches the subdomain rule, and it uses the `app` fixture, which sets only `TESTING`/`SECRET_KEY` (`tests/conftest.py:45–52`), so subdomain matching is not even enabled. Passes (ran: 1 passed).

Nothing inside the test files themselves marks `test_subdomain` as canonical; the tie-break is the artifact being its body with one flag flipped.

### Rests on / still open

- Rests on: verbatim reads of `tests/test_testing.py:302–317`, `:117–139`, `tests/test_reqctx.py:60–101`, `tests/conftest.py:45–52`; `src/flask/app.py:139–145, 233, 430–437, 454–472` and `src/flask/sansio/app.py:289, 407`; and the executed runs (target test 1 passed; mutated artifact exit 1 / 404; three neighbouring subdomain tests 3 passed).
- Not established: the exact werkzeug matching step that turns the forced empty subdomain into the 404 — inferred from `app.py:458–462` plus the observed 404, not traced into werkzeug.
- Not established: whether any *other* test in the suite also catches the `subdomain_matching` flip; no full-suite run was performed, and only `test_subdomain` was actually mutated.
- Not established: the "less specific" ranking of the two alternatives rests on reading their bodies, not on mutating them.
- Not established: the `P3` grep hits outside functions matching `P1`/`P2` were not exhaustively classified, so a further three-element function outside that set cannot be ruled out (the `P1 ∧ P2 ∧ P3` intersection within the grep sets is exactly the three listed).
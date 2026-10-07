## Direct answer

`b64decode` is invoked at **`src/flask/json/tag.py:170`**, in `TagBytes.to_python`, and it is reached *during* the recursive untagging pass — i.e. after the JSON text has already been parsed — by the chain `TaggedJSONSerializer.loads` → `_untag_scan` (recursive descent into dicts/lists) → `untag` → `self.tags[key].to_python(...)` when the recursion encounters a one-item dict whose sole key is the byte tag key `" b"`. The framework entry point above that is `SecureCookieSessionInterface.open_session` (`src/flask/sessions.py:337`), where `data = s.loads(val, max_age=max_age)` (line 346) hits itsdangerous' `URLSafeTimedSerializer`, which calls the Flask `TaggedJSONSerializer.loads`.

## The invocation site

`src/flask/json/tag.py:159–170` — the tag class and the sole `b64decode` call in the repository (imported at line 47):

```python
class TagBytes(JSONTag):
    __slots__ = ()
    key = " b"

    def check(self, value: t.Any) -> bool:
        return isinstance(value, bytes)

    def to_json(self, value: t.Any) -> t.Any:
        return b64encode(value).decode("ascii")

    def to_python(self, value: t.Any) -> t.Any:
        return b64decode(value)
```

`b64encode` is used only at line 167; `b64decode` only at line 170. Grep over the tree (excluding `.venv`) confirms exactly two hits: `tag.py:47` (import) and `tag.py:170` (call).

## The recursive untagging chain

**Step 1 — the post-parse entry point, `tag.py:325–327`.** Parsing happens first; untagging strictly after (`loads` here is the pure-JSON `flask.json.loads`, not this method):

```python
    def loads(self, value: str) -> t.Any:
        """Load data from a JSON string and deserialized any tagged objects."""
        return self._untag_scan(loads(value))
```

**Step 2 — the recursion, `tag.py:309–319`.** Dict values are scanned recursively *before* the containing dict is untagged:

```python
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
```

**Step 3 — the dispatch that calls the decoder, `tag.py:297–307`.** Line 307 is the bridge to `to_python`; for `key == " b"` that resolves to the `TagBytes` instance:

```python
    def untag(self, value: dict[str, t.Any]) -> t.Any:
        """Convert a tagged representation back to the original type."""
        if len(value) != 1:
            return value

        key = next(iter(value))

        if key not in self.tags:
            return value

        return self.tags[key].to_python(value[key])
```

`self.tags[" b"]` is the `TagBytes` instance because `TagBytes` is listed in `default_tags` (`tag.py:238`, entry at line 243) and `register` (`tag.py:256`) adds a tag only when its key is non-empty (`tag.py:277–282`):

```python
        tag = tag_class(self)
        key = tag.key

        if key:
            if not force and key in self.tags:
                raise KeyError(f"Tag '{key}' is already registered.")

            self.tags[key] = tag
```

The key `" b"` is defined exactly once (`TagBytes.key`, `tag.py:161`) and looked up through `self.tags` — never as a scattered literal. Tags with an empty key (`PassDict`, `PassList`) never enter `self.tags` and never participate in `untag` dispatch.

## Why this happens "during recursion" (the tag is a one-key dict)

`JSONTag.tag` wraps the encoded payload in a dict keyed by the tag, `tag.py:87–91`:

```python
    def tag(self, value: t.Any) -> dict[str, t.Any]:
        """Convert the value to a valid JSON type and add the tag structure
        around it."""
        return {self.key: self.to_json(value)}
```

So a `bytes` value becomes `{" b": "<base64-ascii>"}`. When it sits inside a container — e.g. `{" t__": b"a"}` becomes `{" t__": {" b": "YQ=="}}` — `_untag_scan` must first descend into the enclosing dict (line 312) to reach that inner one-key dict, and only then does `untag` collapse it (line 314 → 307 → 169 → 170). That is precisely why the decode fires inside the recursive scan rather than during JSON parsing.

## Distinguish the two `loads` (a common conflation point)

The `loads` called inside `TaggedJSONSerializer.loads` is the module-level Flask function `src/flask/json/__init__.py:77`, imported at `tag.py:57` (`from ..json import loads`); it does pure JSON parsing only:

```python
    if current_app:
        return current_app.json.loads(s, **kwargs)

    return _json.loads(s, **kwargs)
```

It contains no base64 or tag logic. Base64 decoding happens only in `TaggedJSONSerializer.loads`' recursion, after this returns.

## Outer framework path (session cookies)

`src/flask/sessions.py` — the singleton and the call site:

```python
session_json_serializer = TaggedJSONSerializer()   # line 287
    serializer = session_json_serializer           # line 314
```

```python
    def open_session(self, app: Flask, request: Request) -> SecureCookieSession | None:
        s = self.get_signing_serializer(app)
        if s is None:
            return None
        val = request.cookies.get(self.get_cookie_name(app))
        if not val:
            return self.session_class()
        max_age = int(app.permanent_session_lifetime.total_seconds())
        try:
            data = s.loads(val, max_age=max_age)
            return self.session_class(data)
        except BadSignature:
            return self.session_class()
```

`open_session` is at line 337 and `data = s.loads(...)` at line 346; the serializer is passed into `URLSafeTimedSerializer(..., serializer=self.serializer, ...)` in `get_signing_serializer` (lines 327–335), so itsdangerous' `s.loads` calls `TaggedJSONSerializer.loads`.

## Complete chain

```
SecureCookieSessionInterface.open_session       src/flask/sessions.py:337
  └ data = s.loads(val, max_age=max_age)        src/flask/sessions.py:346  [itsdangerous]
      └ TaggedJSONSerializer.loads              src/flask/json/tag.py:325
          ├ loads(value)                        src/flask/json/__init__.py:77  — parse only
          └ self._untag_scan(loads(value))      src/flask/json/tag.py:327
              ├ _untag_scan recursion           tag.py:312 (dict) / 317 (list)
              ├ self.untag(value)               tag.py:314
              │   └ self.tags[key].to_python()  tag.py:307   (key == " b" → TagBytes)
              │       └ TagBytes.to_python      tag.py:169
              │           └ b64decode(value)    tag.py:170   ← the base64-decoding invocation
```

## Runtime confirmation (executed results)

Instrumenting `flask.json.tag.b64decode` in-process:

```
Case A: dumps(b"\xff")        -> {" b":"/w=="}
  calls: ['/w==']  stack: loads:327 → _untag_scan:314 → untag:307 → to_python:170

Case B: dumps({" t__": b"a"}) -> {" t__":{" b":"YQ=="}}
  calls: ['YQ==']  stack: loads:327 → _untag_scan:312 → _untag_scan:314 → untag:307 → to_python:170
```

Case B shows two `_untag_scan` frames: the outer dict recursed at line 312 into the nested one-key `{" b": "YQ=="}` dict, which was then untagged via line 314 → 307 → 170. A full cookie round-trip (set session, reload cookie) produced this stack:

```
src/flask/sessions.py:open_session:346
.venv/.../itsdangerous/timed.py:loads:207
.venv/.../itsdangerous/serializer.py:load_payload:263
src/flask/json/tag.py:loads:327
src/flask/json/tag.py:_untag_scan:312
src/flask/json/tag.py:_untag_scan:314
src/flask/json/tag.py:untag:307
src/flask/json/tag.py:to_python:170        ← b64decode(value)
```

## Test evidence

`tests/test_json_tag.py:11–29` — the round-trip that genuinely exercises the decode (nested case at line 16, top-level bytes at line 21):

```python
@pytest.mark.parametrize(
    "data",
    (
        {" t": (1, 2, 3)},
        {" t__": b"a"},
        {" di": " di"},
        {"x": (1, 2, 3), "y": 4},
        (1, 2, 3),
        [(1, 2, 3)],
        b"\xff",
        ...
    ),
)
def test_dump_load_unchanged(data):
    s = TaggedJSONSerializer()
    assert s.loads(s.dumps(data)) == data
```

With `b64decode` instrumented across the whole 489-test suite, it is called exactly **twice**, both from this test: `'YQ=='` (the nested `{" t__": b"a"}` case, proving recursive descent reaches the decoder) and `'/w=='` (top-level `b"\xff"`).

Note: `tests/test_basic.py::test_session_special_types` (route sets `flask.session["b"] = b"\xff"`, assertions at lines 468–469) does **not** itself trigger a decode — it only encodes on assignment and reads back the live in-memory object without reloading the cookie (`b64decode` calls observed: 0). The session-cookie entry point is nevertheless confirmed by the real two-request round-trip above, whose stack passes through `sessions.py:open_session:346`.

## Corrections to line references in the upstream material

Verified against the working tree: `b64decode` call at `tag.py:170`; `TagBytes` class 159, `key = " b"` 161, `to_python` 169; `b64decode`/`b64encode` imports 47/48; `TagBytes` entry in `default_tags` 243; `register` 256; `JSONTag.tag` 87; `TagDict` 93 with `key = " di"` 101; `untag` 297 (dispatch 307); `_untag_scan` 309 (312/314/317); `loads` 325 (body 327); `from ..json import loads` at 57 (not 53); `sessions.py` singleton 287, `serializer = ...` 314, `open_session` 337, `s.loads` 346 (not 347); `tests/test_json_tag.py` lines 16/21/27–29. One attribution in the upstream evidence is wrong and should not be reused: the dump-side tagging of `{" t__": b"a"}` is done by `PassDict`, not `TagDict` (`TagDict.check({" t__": b"a"})` is `False` because `" t__"` is not a registered key). The load-side recursion conclusion is unaffected and is confirmed above.
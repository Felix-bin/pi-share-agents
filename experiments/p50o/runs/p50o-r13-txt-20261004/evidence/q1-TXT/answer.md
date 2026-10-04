# 最终答案：Flask `ensure_ascii` 与序列化输出中 Unicode 字符表示的关系

## 直接结论

在快照 Flask `3.2.0.dev`（`85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`）中，那个「ASCII-only encoding control parameter」是 **`DefaultJSONProvider.ensure_ascii`**（`src/flask/json/provider.py:144`），默认值为 **`True`**，它是 Flask 2.3 移除的 `JSON_AS_ASCII` 配置键的等价替代。二者的关系是纯粹的**表示层开关**：

- **`True`（默认）**：序列化器把每个非 ASCII 码位替换成 JSON 转义序列（BMP 用 `\uXXXX`，星平面用 UTF-16 代理对）。生成的 Python 字符串**只含 ASCII 码位**（`s.isascii() is True`），UTF-8 编码后全是单字节，字节更多但客户端兼容性最好。
- **`False`**：非 ASCII 字符**原样保留**在字符串中；响应体在编码为 UTF-8 时变成多字节序列（`☃` → `e2 98 83`），且 JSON 文本里有字面的 `☃`。

关键点：**这只改字符的书写形态，不改 JSON 的值、合法性或语义**——`json.loads`（以及 `Response.get_json()`）对两种形态解出的 Python 值完全相同。属性 docstring 原文即：*"Replace non-ASCII characters with escape sequences. This may be more compatible with some clients, but can be disabled for better performance and size."*

---

## 1. 参数本体的定义与默认值

`src/flask/json/provider.py:124-148`（`ensure_ascii` 定义在 144 行）：

```python
class DefaultJSONProvider(JSONProvider):
    """Provide JSON operations using Python's built-in :mod:`json`
    library. Serializes the following additional data types:
    ...
    """

    default: t.Callable[[t.Any], t.Any] = staticmethod(_default)
    """Apply this function to any object that :meth:`json.dumps` does
    not know how to serialize. It should return a valid JSON type or
    raise a ``TypeError``.
    """

    ensure_ascii = True
    """Replace non-ASCII characters with escape sequences. This may be
    more compatible with some clients, but can be disabled for better
    performance and size.
    """

    sort_keys = True
    """Sort the keys in any serialized dicts. This may be useful for
    some caching situations, but can be disabled for better performance.
    When enabled, keys must all be strings, they are not converted
    before sorting.
    """

    compact: bool | None = None
    """If ``True``, or ``None`` out of debug mode, the :meth:`response`
    output will not add indentation, newlines, or spaces. If ``False``,
    or ``None`` in debug mode, it will use a non-compact representation.
    """

    mimetype = "application/json"
    """The mimetype set in :meth:`response`."""
```

默认值是 `True`，且**没有任何测试断言过这个默认值**（`tests/test_json.py:269-275` 只有 `sort_keys` 的对应断言 `assert app.json.sort_keys`；`tests/conftest.py:44-57` 的 `app` fixture 完全不碰 `ensure_ascii`）。实测结构性确认：`class default ensure_ascii: True`、`instance default: True`。

## 2. 参数如何被消费（`setdefault` 决定覆盖优先级）

`src/flask/json/provider.py:166-179`：

```python
    def dumps(self, obj: t.Any, **kwargs: t.Any) -> str:
        """Serialize data as JSON to a string.

        Keyword arguments are passed to :func:`json.dumps`. Sets some
        parameter defaults from the :attr:`default`,
        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.

        :param obj: The data to serialize.
        :param kwargs: Passed to :func:`json.dumps`.
        """
        kwargs.setdefault("default", self.default)
        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
        kwargs.setdefault("sort_keys", self.sort_keys)
        return json.dumps(obj, **kwargs)
```

三个控制手段因此同时有效，且互不冲突：

1. **实例属性**：`app.json.ensure_ascii = False`（全局改）；
2. **逐次调用覆盖**：`app.json.dumps(obj, ensure_ascii=False)` —— 因为 `setdefault` 在键已存在时是 no-op，**传入的 kwargs 优先于实例属性**；
3. **子类改类属性**（provider 类可替换）。

解码侧**完全不涉及该参数**（`src/flask/json/provider.py:181-187`）：

```python
    def loads(self, s: str | bytes, **kwargs: t.Any) -> t.Any:
        """Deserialize data as JSON from a string or bytes.

        :param s: Text or UTF-8 bytes.
        :param kwargs: Passed to :func:`json.loads`.
        """
        return json.loads(s, **kwargs)
```

实测 `loads sig: (self, s: 'str | bytes', **kwargs: 't.Any') -> 't.Any'`，且 `loads equality: True`。

## 3. 官方判定性测试（语义的权威表述）

`tests/test_json.py:48-54` —— `True→'"\\u2603"'`，`False→'"\u2603"'`：

```python
@pytest.mark.parametrize(
    "test_value,expected", [(True, '"\\u2603"'), (False, '"\u2603"')]
)
def test_json_as_unicode(test_value, expected, app, app_ctx):
    app.json.ensure_ascii = test_value
    rv = app.json.dumps("\N{SNOWMAN}")
    assert rv == expected
```

`tests/test_testing.py:110-114` —— 测试客户端 JSON 体也吃这个属性，且线上是 UTF-8 字节：

```python
def test_environbuilder_json_dumps(app):
    """EnvironBuilder.json_dumps() takes settings from the app."""
    app.json.ensure_ascii = False
    eb = EnvironBuilder(app, json="\u20ac")
    assert eb.input_stream.read().decode("utf8") == '"\u20ac"'
```

这两条测试是仓库内**唯一**使用该属性的两处（全仓 `ensure_ascii` 检索共 5 个命中：`src/flask/json/provider.py:144`、`:171`、`:177`、`tests/test_json.py:52`、`tests/test_testing.py:112`，确认无第 6 个消费者）。执行器复跑：

```
$ grep -rn "ensure_ascii" --include=*.py --include=*.rst --include=*.txt --include=*.toml . | grep -v "^./.venv/"
./src/flask/json/provider.py:144:    ensure_ascii = True
./src/flask/json/provider.py:171:        :attr:`ensure_ascii`, and :attr:`sort_keys` attributes.
./src/flask/json/provider.py:177:        kwargs.setdefault("ensure_ascii", self.ensure_ascii)
./tests/test_json.py:52:    app.json.ensure_ascii = test_value
./tests/test_testing.py:112:    app.json.ensure_ascii = False
exit=0
```

## 4. 实证输出（执行器原始 stdout，四列区分法而非 `repr`）

探针脚本刻意用 `len()` / `utf-8 hex` / `isascii()` / 与两个字面量的相等比较来区分两种形态（因为 `repr()`/`ascii()` 会把字面 `☃` 再转义一次，两种形态在 repr 下看起来一样）。原始输出：

```
$ cd <snapshot> && PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe .scratch-ensure-ascii/probe.py
default len=8 utf8=22 5c 75 32 36 30 33 22 isascii=True eq_escaped=True eq_literal=False
kw-false len=3 utf8=22 e2 98 83 22 isascii=False eq_escaped=False eq_literal=True
attr-false len=3 utf8=22 e2 98 83 22 isascii=False eq_escaped=False eq_literal=True
astral-escaped: '"\\ud83d\\ude00"'
astral-literal: '"\U0001f600"'
key-escaped: '{"\\u96ea": 1}'
response ascii=True ctype='application/json' bytes=7b 22 73 6e 6f 77 6d 61 6e 22 3a 22 5c 75 32 36 30 33 22 7d 0a json_ok=True
response ascii=False ctype='application/json' bytes=7b 22 73 6e 6f 77 6d 61 6e 22 3a 22 e2 98 83 22 7d 0a json_ok=True
tojson(ensure_ascii=False, ascii-printed): '{"name": "\\u003c/script\\u003e", "s": "\u2603"}'
---EXIT:0---
```

逐条解读（均为实测）：

- **`default`（类属性）**：`len=8`、字节 `22 5c 75 32 36 30 33 22`（即 `"` `\` `u` `2` `6` `0` `3` `"`）、`isascii=True`、等于 `'"\\u2603"'` → `True` 时非 ASCII 变成 `\uXXXX`，字符串纯 ASCII，UTF-8 后全单字节。
- **`kw-false`（逐次 kwargs）与 `attr-false`（实例属性）**：两者输出**完全相同**——`len=3`、字节 `22 e2 98 83 22`、`isascii=False`、等于 `'"☃"'` → 字面字符，UTF-8 为 3 字节（`e2 98 83`）。证明两种控制手段等价。
- **`json.loads` 等价性断言通过**（脚本中 `assert json.loads(s_default) == json.loads(s_kw) == "\N{SNOWMAN}"` 未抛 `AssertionError`）→ **表示不同、值相同**。
- **星平面字符**：`True` → `'"\\ud83d\\ude00"'`（UTF-16 代理对）；`False` → `'"\U0001f600"'`（单个字符）。
- **对象 key 同样受影响**：`{"雪": 1}` 在 `True` 下是 `'{"\\u96ea": 1}'`。
- **响应层**：`True` 时 body 全 ASCII（`... 5c 75 32 36 30 33 ...`），`False` 时同一位置是 `e2 98 83` 多字节；两种情况下 `Content-Type` **都是 `application/json`（无 charset）**，`get_json()` 都等于原值。
- **Jinja `|tojson`**：`ensure_ascii=False` 下 `\u003c/script\u003e` 的 HTML 转义仍在，而雪人以真实字符出现（`ascii()` 打印才显示为 `\u2603`）。

## 5. 生效范围：谁来吃这个属性

属性挂在 provider 实例上（`src/flask/sansio/app.py:230-240` 与 `:329-345`）：

```python
    json_provider_class: type[JSONProvider] = DefaultJSONProvider
```

```python
        self.json: JSONProvider = self.json_provider_class(self)
```

由 `dumps` 一处消费，所有上层入口都最终汇到它（`file:line` 清单）：

| 入口 | 位置 | 说明 |
|---|---|---|
| `app.json.dumps(obj, **kw)` | `provider.py:166-179` | 直接入口 |
| `provider.dump(obj, fp)` 写文件 | `provider.py:49-57`（`fp.write(self.dumps(obj, **kwargs))`） | 继承该参数 |
| `provider.response()` → `jsonify()` | `provider.py:189-214`；`json/__init__.py:161-171`（`return current_app.json.response(*args, **kwargs)`） | 响应体 |
| 视图 `return {…}` / `[…]` 自动 JSON 化 | `src/flask/app.py:1231`（`rv = self.json.response(rv)`） | 同上 |
| `flask.json.dumps`（模块级） | `src/flask/json/__init__.py:13-45`：`if current_app: return current_app.json.dumps(obj, **kwargs)`；否则 `_json.dumps` | **无 app 上下文直落 stdlib（stdlib 默认也是 `ensure_ascii=True`）** |
| `flask.json.dump`（模块级，写文件） | `src/flask/json/__init__.py:47-74`：`if current_app: current_app.json.dump(...)` | 同上 |
| Jinja `\|tojson` | `src/flask/app.py:422`：`rv.policies["json.dumps_function"] = self.json.dumps` | 模板内 JSON |
| 会话 cookie | `src/flask/json/tag.py:321-327` → `flask.json.dumps`；链路 `sessions.py:330`/`:387` → itsdangerous `dump_payload` → `TaggedJSONSerializer.dumps` | 见下条 |
| 测试客户端 JSON 体 | `src/flask/testing.py:88-94`：`return self.app.json.dumps(obj, **kwargs)` | 出厂请求体 |

会话 cookie 链的完整证据（`D5`）：`SecureCookieSessionInterface.get_signing_serializer` 显式传 `serializer=self.serializer`（`sessions.py:325-335`），`save_session` 调 `self.get_signing_serializer(app).dumps(dict(session))`（`:387`），itsdangerous 的 `Serializer.dump_payload` 用 `self.serializer.dumps(obj, **self.serializer_kwargs)`，而 `serializer_kwargs = {}`（`itsdangerous/serializer.py:236`）——itsdangerous 不注入 `ensure_ascii`，所以 Flask 会话路径**确实**服从 `app.json.ensure_ascii`。

**对象的 key 与 value 都受影响**（实测 `key-escaped: '{"\\u96ea": 1}'`）。

执行器还发现一个**下游对照事实**（不改变上述结论）：itsdangerous 自己的回退紧凑序列化器默认 `ensure_ascii=False`，但它只在调用方没有传 `serializer=` 时才会被用到：

```
$ cat -n .venv/Lib/site-packages/itsdangerous/_json.py
     1  from __future__ import annotations
     2
     3  import json as _json
     4  import typing as t
     5
     6
     7  class _CompactJSON:
     8      """Wrapper around json module that strips whitespace."""
     9
    10      @staticmethod
    11      def loads(payload: str | bytes) -> t.Any:
    12          return _json.loads(payload)
    13
    14      @staticmethod
    15      def dumps(obj: t.Any, **kwargs: t.Any) -> str:
    16          kwargs.setdefault("ensure_ascii", False)
    17          kwargs.setdefault("separators", (",", ":"))
    18          return _json.dumps(obj, **kwargs)
```

因为 Flask **总是**传 `serializer=self.serializer`（`sessions.py:330`），Flask 不会被这个 `False` 默认值影响。

## 6. 字节层：字符串怎么落到线上

`str` 型响应体在 Werkzeug 里被 UTF-8 编码（`.venv/Lib/site-packages/werkzeug/wrappers/response.py:285-294`）:

```python
    def set_data(self, value: bytes | str) -> None:
        """Sets a new string as response.  The value must be a string or
        bytes. If a string is set it's encoded to the charset of the
        response (utf-8 by default).
        ...
        """
        if isinstance(value, str):
            value = value.encode()
        self.response = [value]
        if self.automatically_set_content_length:
            self.headers["Content-Length"] = str(len(value))
```

而 `application/json` **不会被加上 charset**（`.venv/Lib/site-packages/werkzeug/utils.py:157-190`）：

```python
def get_content_type(mimetype: str, charset: str) -> str:
    ...
    if (
        mimetype.startswith("text/")
        or mimetype in _charset_mimetypes
        or mimetype.endswith("+xml")
    ):
        mimetype += f"; charset={charset}"

    return mimetype
```

这与实测一致：两种 `ensure_ascii` 取值下 `Content-Type` 都是 `application/json`（无 charset），解码仍按 JSON 规范固定为 UTF-8。

## 7. 三个必须避免的误答 / 边界

**(a) `|tojson` 的 HTML 转义与 `ensure_ascii` 无关。** `<` `>` `&` `'` 的 `\u003c`/`\u003e`/`\u0026`/`\u0027` 是 Jinja 层做的，在 `dumps` 之后 `.replace(...)`（`.venv/Lib/site-packages/jinja2/utils.py:637-670`）：

```python
    return markupsafe.Markup(
        dumps(obj, **kwargs)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("'", "\\u0027")
    )
```

调用链为 `jinja2/filters.py:1713-1721` 取 `policies["json.dumps_function"]`（Flask 在 `app.py:422` 设成 `self.json.dumps`）。所以把 `ensure_ascii=False` **不会**让 `<script>` 裸奔——实测 `tojson(ensure_ascii=False, ascii-printed): '{"name": "\\u003c/script\\u003e", "s": "\u2603"}'` 印证。注意 Jinja 默认策略里的 `"compiler.ascii_str": True` 是模板编译器开关，与本题的参数无关。

**(b) 抽象基类 `JSONProvider` 没有这个属性。** `provider.py:19-57` 只有抽象 `dumps`（`raise NotImplementedError`）与透传 kwargs；自定义 provider 若不自己消费它，该属性是 inert。`provider.py:19-105` 中不存在 `ensure_ascii` 字符串，实测 `base has attr: False`、`base instance has attr: False`。

**(c) 无 app 上下文时走 stdlib。**（见第 5 节 `flask.json.dumps`）实测 `no-ctx flask.json.dumps : "\u2603"`、`no-ctx isascii: True` —— stdlib 自己的默认也是 `ensure_ascii=True`。

## 8. 边界行为：孤立代理字符（stdlib 语义，实测确认）

`True` 能吞下不成对代理，`False` 会把裸代理留给 UTF-8 编码器：

```
$ PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c " ... "
stdlib True  : '"\\ud800"'
stdlib False : '"\ud800"'
utf-8 encode: UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800' in position 1: surrogates not allowed
provider False: '"\ud800"'
provider True : '"\\ud800"'
response(False): UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800' in position 1: surrogates not allowed
---EXIT:0---
```

即：`ensure_ascii=True` 时孤立代理会被转义成 `\ud800` 安全输出；`False` 时字面保留，随后在 UTF-8 编码 / `response()` 阶段抛 `UnicodeEncodeError`。

## 9. 历史来源：它是 `JSON_AS_ASCII` 的替代

`CHANGES.rst:143-160`（2.3 移除）：

```
-   Remove previously deprecated code. :pr:`4995`
    ...
    -   The ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
        ``JSONIFY_PRETTYPRINT_REGULAR`` config keys are removed.
```

`CHANGES.rst:286-289`（2.2 迁移）：

```
-   JSON configuration is moved to attributes on the default
    ``app.json`` provider. ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``,
    ``JSONIFY_MIMETYPE``, and ``JSONIFY_PRETTYPRINT_REGULAR`` are
    deprecated. :pr:`4692`
```

`docs/config.rst:408-444`：

```
.. versionadded:: 0.10
   ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_PRETTYPRINT_REGULAR``
...
.. versionchanged:: 2.3
    ``JSON_AS_ASCII``, ``JSON_SORT_KEYS``, ``JSONIFY_MIMETYPE``, and
    ``JSONIFY_PRETTYPRINT_REGULAR`` were removed. The default ``app.json`` provider has
    equivalent attributes instead.
```

全仓 `JSON_AS_ASCII` 只有 4 处命中，全为历史散文（`CHANGES.rst:153`、`:286`、`docs/config.rst:419`、`:441`），**没有任何活代码读取它**。

## 10. 验证与实验纪律

**判定性测试 + 整套回归**：

```
$ PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -m pytest tests/test_json.py::test_json_as_unicode tests/test_testing.py::test_environbuilder_json_dumps -q
...                                                                      [100%]
3 passed in 0.05s
---EXIT:0---
```

（3 passed = `test_json_as_unicode[True]` + `[False]` + `test_environbuilder_json_dumps`。）

```
$ PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -m pytest
...
collected 489 items
...
tests\test_json.py ...............................                       [ 74%]
...
============================= 489 passed in 2.12s =============================
---EXIT:0---
```

全套两次运行均为 **489 passed / 0 failed / 0 errors / 0 skipped**（`-vv -rA --tb=long` 第二次亦 489 passed in 1.98s；完整 1454 行日志存于 `C:\Users\oobbee\AppData\Local\Temp\pi-bash-fc982fb0f4587bf2.log`）。

**快照未被改动**：`git rev-parse HEAD` 全程仍为 `85c5d93cbd049c4bd0679c36fd1ddcae8c37b642`；`git diff --stat` 为空；`git status --porcelain` 只有运行前后都存在的 `?? flask_mut2_i417ar2x/`（与本题无关的残留物，其内容为 subdomain 断言，未用作证据）；临时脚本目录 `.scratch-ensure-ascii/` 已删除。`.pytest_cache/` 早于本次运行即存在且被 gitignore。未读任何 benchmark 参考答案 / `sample.jsonl` / `Benchmarks*/` / judge 材料；未 commit、未 push。

**证据定级说明**（据 retriever 的 flags）：星平面代理对形态、孤立代理的 `UnicodeEncodeError`、"两种形态 `loads` 等价"、逐次 kwargs 覆盖优先级——这四条在仓库内**没有测试直接覆盖**，本题由执行器实测（第 4、8 节）确认，故按"实测"呈现；"better performance and size" 仅是 docstring 自述（`provider.py:145-148`），快照内无基准数据支撑。
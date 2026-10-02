# SYNAPSE Python 原型（初赛参考实现）

SYNAPSE 最初以独立 Python 包的形式实现（初赛交付），位于本仓库 `源代码及readme文档/`。
它把赛题要求的机制（结构化通信、非文本状态传递、共享记忆、评测）完整实现了一遍，
是当前 TypeScript 实现（`src/synapse/`）的**对照物**：判断某个设计是不是原型里已经验证过的，
或者某个能力缺口在原型里是怎么解的，先看它。原型在初赛后保持只读，不再演进。

## 与本仓库 `src/synapse/` 的对照

两边解决的是同一批问题，但本仓库主实现是 Pi 扩展、原型是独立 Python 包，所以只有机制对应，
没有代码对应。逐模块的迁移覆盖核验（含判定与证据）见
[初赛机制迁移覆盖核验](./migration-coverage-vs-python-prototype.md)——本节的对应表只给主干。

| 原型（Python） | 本仓库（TypeScript） | 说明 |
|---|---|---|
| `protocol/messages.py` | `envelope.ts`、`capability.ts` | 结构化通信单元 `{action, params, result, capability}` |
| `protocol/handshake.py` | `capability.ts` | 能力协商；本仓库为二档（state/text），无原型那种运行时探测 |
| `protocol/transport.py` | `envelope-inbox.ts` | 原型走 AF_UNIX 长度前缀 framing；本仓库走文件投递 |
| `protocol/scheduler.py`、`runtime/team.py` | `delegation.ts`、`handoff.ts`、`roles.ts` | 委派、上下文准备与角色能力声明 |
| `runtime/exec_child.py` | `child-contract.ts`、`lifecycle.ts` | 子侧启动契约与校验 |
| `stateplane/cas.py` | `content-store.ts` | 内容寻址存储 |
| `stateplane/checksum.py` | `canonical-json.ts`、`source-fingerprint.ts` | 确定性摘要与来源指纹 |
| `stateplane/residual.py`、`embedding.py` | `delta.ts`、`delta-params.ts`、`state-payload.ts`、`embedding.ts` | 残差编码与句向量 |
| `stateplane/vector_index.py` | `corpus.ts`、`state-retrieval.ts` | 向量检索（两侧同为暴力余弦） |
| `memory/store.py` | `memory-store.ts` | 共享记忆单元与统一 schema |
| `memory/retrieval.py` | `retrieval.ts` | 关键词/标签/语义三路检索 |
| `config.py` | `config.ts` | 配置 |
| `cli.py` | `setup-command.ts` | 入口命令 |

**原型有、本仓库确实没有的**（逐条理由见核验文档 §4）：

- `runtime/model.py`、`runtime/subprocess_executor.py` —— CodeAct 与轻量沙箱（赛题 M11 加分项）。
- `memory/consolidate.py` —— 记忆固化/合并（本仓库以取代事件 + 不可变日志替代一部分职责）。
- `eval/` 的运行器部分、`qa/`、`tasks.py` —— A/B 运行器、数据集流水线与关联任务族。
  本仓库的指标口径在 `src/synapse/metering.ts`，比原型更严（拒绝代理值）。
- `stateplane/projection.py` —— 原型默认关闭，故不迁移。

## 跑一遍原型

需要 Python 3.11+ 和 [`uv`](https://docs.astral.sh/uv/)。离线自检和单元测试不需要网络或 API 密钥。

```bash
cd 源代码及readme文档
uv sync --locked --extra dev --no-editable
uv run --no-sync ruff check .
uv run --no-sync pytest -q
uv run --no-sync synapse smoke
```

Windows PowerShell 下先设 `$env:PYTHONUTF8 = "1"` 和 `$env:PYTHONIOENCODING = "utf-8"`：父目录
路径含中文时，Python 3.11 会按系统 locale 读取 editable-install 的 `.pth` 而触发 GBK 解码错误，
`--no-editable` 与这两个环境变量共同避开该问题。

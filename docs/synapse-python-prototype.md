# SYNAPSE Python 原型（参考实现）

本项目的共享记忆层 `SYNAPSE` 有一个更早的 Python 原型，来自第三届中国研究生操作系统开源大赛的
社区赛题作品。原型把赛题要求的机制（结构化通信、非文本状态传递、共享记忆、评测）完整实现了一遍，
是本仓库 TypeScript 实现的**对照物**：判断某个设计是不是原型里已经验证过的，或者某个能力缺口在
原型里是怎么解的，先看它。

**它不随本仓库分发。** 下面的命令会在 `reference/synapse-py/` 建一个本地检出，该路径已写入
[`.gitignore`](../.gitignore)。

## 为什么不 vendor 进仓库

上游工作区约 89MB，其中 `SYNAPSE作品介绍PPT.pptx`（44MB）和 `SYNAPSE演示视频.mp4`（40MB）
两个参赛物料就占了 84MB，真正的 Python 源码只有约 5MB。本仓库的推荐安装方式是
`pi install git:github.com/Felix-bin/pi-share-agents`——每次安装都要 clone 本仓库，把这 84MB
提交进来会永久留在 git 历史里，拖慢所有人的安装。原型是只读参考，没有随仓分发的必要。

## 创建本地检出

```bash
git clone --depth 1 https://github.com/yangchunwanwusheng/synapse.git reference/synapse-py
```

- 上游：<https://github.com/yangchunwanwusheng/synapse>（公开，默认分支 `master`，迁移自 GitLink）
- 本文撰写时的上游 HEAD：`3491b37ade90c863734e900b404144e19e274721`（2026-09-03）
- `--depth 1` 只是为了省时间；需要完整历史时在该目录执行 `git fetch --unshallow`
- 目录保留自己的 `.git`，后续 `git pull` 即可同步上游

## 目录结构

```
reference/synapse-py/
├── README.md                    # 项目总览、机制说明、实验结论（21KB，先读这个）
├── 竞赛赛题.md                   # 赛题原文，M1–M11 机制编号的出处
├── 源代码及readme文档/            # 可安装的 Python 包，真正的代码在这里
│   ├── src/synapse/             # 见下方对照表
│   ├── tests/                   # 离线单元与集成测试，零密钥
│   ├── configs/                 # 离线与真实后端配置
│   ├── data/                    # 可随仓复现的公开数据样例（HotpotQA / MuSiQue / CoQA）
│   ├── scripts/                 # 数据获取与实验辅助脚本
│   └── Dockerfile               # openEuler 24.03-LTS-SP3 复现镜像
├── docs/                        # 设计文档、实验协议、CodeAct 边界实测报告
└── SYNAPSE*.pptx / .mp4 / .docx # 参赛物料，共约 86MB
```

## 与本仓库 `src/synapse/` 的对照

两边解决的是同一批问题，但本仓库是 Pi 扩展、原型是独立 Python 包，所以只有机制对应，没有代码对应。
**逐模块的迁移覆盖核验**（含判定、证据行号与缺口处置）见
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
  本仓库的指标口径在 `src/synapse/metering.ts`，比原型更严（拒绝代理值），但出数装置尚未迁移。
- `stateplane/projection.py` —— 原型默认关闭，故不迁移。

## 跑一遍原型

需要 Python 3.11+ 和 [`uv`](https://docs.astral.sh/uv/)。离线自检和单元测试不需要网络或 API 密钥。

```bash
cd reference/synapse-py/源代码及readme文档
uv sync --locked --extra dev --no-editable
uv run --no-sync ruff check .
uv run --no-sync pytest -q
uv run --no-sync synapse smoke
```

Windows PowerShell 下先设 `$env:PYTHONUTF8 = "1"` 和 `$env:PYTHONIOENCODING = "utf-8"`：父目录
路径含中文时，Python 3.11 会按系统 locale 读取 editable-install 的 `.pth` 而触发 GBK 解码错误，
`--no-editable` 与这两个环境变量共同避开该问题。**本仓库的路径恰好含中文目录名**（`源代码及readme文档`），
所以这条约束在这里一定会碰到。

更多复现细节见 `reference/synapse-py/源代码及readme文档/README.md`。

## 许可

**上游仓库目前没有 LICENSE 文件**，GitHub 也未识别出许可证。也就是说它是"公开可见但未授权"的
代码：可以阅读和参考思路，但把其中的代码搬进本仓库（MIT，见 [LICENSE](../LICENSE)）之前，必须先
向上游作者确认授权。这也是不把它 vendor 进本仓库、而是写进 `.gitignore` 的另一个理由。

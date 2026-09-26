# experiments/

新的同 harness 三臂 SWE-bench Lite 实验见 [`swebench/README.md`](swebench/README.md)。下述 `bench/` 是旧实验，CrewAI / AutoGen 对比不纳入新的同 Pi harness 结论。

SYNAPSE 评测所需的一切（产品代码除外）：多臂评测装置、分析脚本、早期实验脚本和公开数据集。
实验方案的完整说明见 [`docs/experiments/experiment-design.md`](../docs/experiments/experiment-design.md)，内容包括：实验设计、冻结的分析口径、指标定义、已有结果和口径修订记录。
历次预登记与结果的原件在 `legacy/records/`。

## 目录

| 路径 | 内容 | 进 git |
|---|---|---|
| `bench/` | 评测装置：`runner.mjs`（经真实 pi CLI 跑 臂 × 组 × 轮）、`aggregate.mjs`、`supervise.sh`（provider 额度回退）、`build-public-families.mjs` 与 `prepare-public-data.sh`（生成公开 benchmark 任务族）、`families/` | 是 |
| `analysis/` | 跑后分析，见下表 | 是 |
| `legacy/` | 早期实验脚本（`records/` 为预登记、结果报告与标定数据的原件）：P4-5 残差 A/B、delta 标定。保留它们是为了让对应报告仍可复现。P50 的脚本与旧 AutoGen/CrewAI harness 已删除（被 E1 取代，数据不在仓库内）；其预登记原件仍在 `records/` | 是 |
| `data/` | 下载的数据集、构建好的工作树和 venv | **否**（写在 `.gitignore` 里，由 `bench/prepare-public-data.sh` 重建） |

`analysis/` 下的脚本：

| 脚本 | 作用 |
|---|---|
| `score-public.mjs` | 质量评分：Q 组算 EM/F1/Cover-EM；R 组用 SWE-QA 原版五维评审，每个答案评 5 次 |
| `edge-bytes.mjs` | 各臂同一口径的 Agent 间通信字节，分下行、上行、按需拉取三部分 |
| `agent-split.mjs` | 把每个 Agent 的 token 拆成"交接"和"自己干活"两部分 |
| `memhit.mjs` | 对照金标准链接，统计记忆的检索命中与跨轮复用 |
| `judge.mjs` | G1/G2 的评分要点 judge |
| `causal-state.mjs`、`transport.mjs` | 不需要 LLM 的状态面实验 |

以下几项特意留在本目录之外：
- `scripts/build-corpus.mjs`：产品工具。
- `scripts/gen-delta-golden.mjs`：生成测试夹具。
- `scripts/synapse/`：S1–S3 验收脚本，runbook 会引用这里。

## 臂与任务组

pi 的四个臂只在插件的 `synapse` 配置上不同；CREWAI、AUTOGEN 是外部框架臂，不跑在 pi 上。详见 `bench/README.md`：

| 臂 | 含义 |
|---|---|
| **SYN0** | SYNAPSE 全关，就是普通的 pi 多 Agent，作为纯文本协作基线 |
| TXT | text 模式：全文转贴，记忆正文以文本形式注入 |
| **SYN** | 完整系统：结果块加句柄交接、按引用取回记忆、状态向量、自动蒸馏 |
| SYNCOLD | 和 SYN 相同，但每次尝试前清空记忆（没有跨轮记忆） |
| **CREWAI** | CrewAI 默认协作（sequential crew），同样四个角色、模型与工具，不开记忆 |
| **AUTOGEN** | AutoGen 默认协作（RoundRobinGroupChat 广播），同样四个角色、模型与工具，不开记忆 |

| 组 | 来源 | 任务 | 评分 |
|---|---|---|---|
| **Q** | MuSiQue-Ans v1.0 dev | 10 道 3/4 跳题，共享同一条桥接链（永乐帝接见受诏者之城 → 南京），每题问南京的一个不同属性；67 个段落文件，含干扰段 | 末行 `ANSWER:` 的 EM / F1，另报 Cover-EM |
| **R** | SWE-QA（ACL 2026 Findings）Flask 子集 | 10 道题，围绕带标签的 JSON 序列化器与会话接口，仓库为 pallets/flask@85c5d93 | SWE-QA 原版五维 LLM 评审（满分 100），每个答案评 5 次取中位数 |
| G1、G2 | 自建（openEuler 调研链、本仓库代码分析链） | 各 10 道 | 评分要点 judge；只作补充演示 |

## 复现

```sh
# 1. 准备数据：MuSiQue、SWE-QA、锁定 commit 的 Flask、工作树、venv、外部框架环境（放到 experiments/data/）
#    外部框架臂的 DeepSeek key：export EXTERNAL_LLM_API_KEY=…，或写进 experiments/data/external.env（已被 git 忽略）
experiments/bench/prepare-public-data.sh

# 2. 运行：每臂每轮最多 2 次尝试，同一轮六臂并发；pi 臂 commandcode 额度用完自动切到 DeepSeek 官方
#    （外部框架臂始终走 DeepSeek 官方，额度用完即终止实验）
#    Q、R 可以放在一个实验里一起跑，也可以分开跑（见下文）
experiments/bench/supervise.sh s5-public-q-<日期> --groups Q --rounds 10 \
  --arms TXT,SYN,SYNCOLD,SYN0,CREWAI,AUTOGEN --attempts 2 --parallel-arms \
  --worktree experiments/data/worktree --path-prepend experiments/data/venv/bin
experiments/bench/supervise.sh s5-public-r-<日期> --groups R --rounds 10 \
  --arms TXT,SYN,SYNCOLD,SYN0,CREWAI,AUTOGEN --attempts 2 --parallel-arms \
  --worktree experiments/data/worktree --path-prepend experiments/data/venv/bin

# 3. 分析（EXP=~/.pi/agent/synapse/experiments/<实验 id>）
node experiments/bench/aggregate.mjs $EXP                  # token、消息、状态、记忆、有效性
node experiments/analysis/edge-bytes.mjs $EXP              # Agent 间通信字节（四臂同口径）
node experiments/analysis/agent-split.mjs $EXP             # 每个 Agent 的交接与自身工作
node experiments/analysis/score-public.mjs $EXP --votes 5  # 质量：Q 组 EM/F1，R 组 SWE-QA 评审
node experiments/analysis/memhit.mjs $EXP                  # 记忆复用，对照金标准链接
```

每个实验的产物放在 `~/.pi/agent/synapse/experiments/<id>/`：manifest、rounds.jsonl、evidence/、每个子 Agent 的 artifacts，分析结果也写在同一目录下。

**Q 组和 R 组分开跑时：**
- 两组共用同一棵工作树（`musique/` 与 `flask/`）和同一个语料库，环境完全一致。
- 各自是独立的实验 id，也各自有独立的记忆库，所以不存在跨组的记忆串扰。
- 两组可以同时启动。这时会同时运行 8 个 pi 会话，需要 provider 的限流扛得住；墙钟时间大约减半。

## 冒烟结果：`smoke6-public`（2026-09-25，本机）

- **环境**：WSL2 openEuler 24.03 SP1 / 内核 6.6。模型 `commandcode/deepseek-v4.1-flash`，嵌入 `bge-m3/1024`，judge `glm-5.3-flashx`。
- **规模**：Q、R 各前 2 轮 × 4 臂，同一轮四臂并发。
- **说明**：每组每臂只有 n=2，只用于验证装置能否跑通、看数值的方向，**不能作为结论**。正式结论以正式重跑为准。

### 装置检查

| 检查项 | 结果 |
|---|---|
| 有效轮数 | 16/16。共 17 次尝试，其中 R r1 的 TXT 第 1 次尝试超时（见下）后重试成功 |
| 结果块 | SYN / SYNCOLD 每轮 3 块，没有回退；交给编排者的约 1.9–3.4 KB，对应全文约 8.7–13.6 KB |
| 状态面 | SYN / SYNCOLD 每轮发送 1 次，4096 B |
| 四角色 | 每轮都齐 |
| 超时原因 | 本机没有 Flask 依赖，executor 执行 `find / -name pytest`，扫遍了 WSL 挂载的 Windows 盘，用了 27 分钟。已修复：新增装好依赖和 pytest<9 的 venv，并用 `--path-prepend` 放到 PATH 最前面 |

### 通信与 token（每轮均值）

| 臂 | EdgeBytes（Agent 间通信） | 其中：按需拉取 | Q 组总 token | R 组总 token | 交接占总处理量 |
|---|---|---|---|---|---|
| SYN0 | 86.3 KB | 0 | 111k | 126k | 25% |
| TXT | 137.9 KB | 4.2 KB | 214k | 202k | 29% |
| **SYN** | **56.9 KB** | 18.7 KB（每轮 5.8 次） | 192k | 135k | **17%** |
| SYNCOLD | 67.5 KB | 12.9 KB | 124k | 103k | 22% |

- **EdgeBytes**：SYN 比 SYN0 少 34%，95% 区间 [6.1k, 49.7k] 不跨 0；比 TXT 少 59%。
- **总 token（父会话 + 子会话，input+output）**：SYN **没有**比 SYN0 省。
  - Q 组 SYN 192k，SYN0 111k。主要原因是 Q r1 那一轮 SYN 的父会话花了 170k，一轮的波动就占了大头。
  - R 组 SYN 135k，SYN0 126k，基本持平。
  - 通信字节减少，还没有转化成总 token 的减少。能不能转化，要看正式重跑的配对统计。
- **按需拉取**：SYN 每轮按句柄读回 5.8 次，共 18.7 KB。这部分已经计入 EdgeBytes，没有被算作免费。

### 质量

| 臂 | Q 组 Cover-EM | R 组 SWE-QA 总分（满分 100） |
|---|---|---|
| SYN0 | 1.00 | 81.5 |
| TXT | 1.00 | 78.5 |
| SYN | 1.00 | 79.5 |
| SYNCOLD | 1.00 | 81.0 |

- **Q 组**：8 个答案内容全对，Cover-EM 都是 1。但冒烟用的是旧的格式说明，不少 `ANSWER:` 行写成了整句解释，所以 EM/F1 失真，不能用来比较。格式说明已收紧为"只写实体、数字或短语，不加解释"（S5 §6.9 已登记），正式重跑使用新题面。
- **R 组**：SWE-QA 五维评审能正常解析，各臂在 78.5–81.5 之间。SYN 对 SYN0 的非劣检验（δ = 5 分）通过；n=2，只看方向。

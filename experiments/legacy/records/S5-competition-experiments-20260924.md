# S5 赛题实验：设计、冻结的分析口径与已出数据

> **当前状态（2026-09-25）**：本文是预登记记录，一律只追加修订、不改写，所以正文前几节里有些内容已被后面的修订取代。现行口径按以下顺序看：
> - §6.8：计量修正与主指标；
> - §6.9：任务族改为公开 benchmark Q（MuSiQue）和 R（SWE-QA Flask）；
> - §6.10：目录调整。
>
> 运行和复现方法见 [`experiments/README.md`](../../README.md)，其中也记录了冒烟结果。§1 的"状态"列和 §5 的待办都是 09-24 的快照。

- 日期：2026-09-24。代码基线 `5bb7a98`。
- 本文档一式三用：
  1. 赛题评分项 → 实验映射；
  2. 正式 LLM 主跑的**分析口径**（在其任何数据产生前冻结）；
  3. 两组无 LLM 实验的结果。
- 分工：
  - `experiments/bench/`（G1/G2 × 10 轮，TXT / SYN / SYNCOLD / SYN0 交替；臂的含义以 §6 修订为准）归主跑会话所有。
  - `experiments/analysis/`（本文的 causal-state、transport、judge、memhit）为补充实验。
  - 两者产物都在 `~/.pi/agent/synapse/experiments/<id>/`，控制台统一读取。

## 1. 评分项 → 实验

| 评分项（分值） | 要证明什么 | 实验 | 状态 |
|---|---|---|---|
| 通信效率（25） | 质量不降时 token/字节更少 | E1：synapse-bench TXT vs SYN（记忆两臂都开，只差协议）；主指标 tokens、handoffBytes、wallMs，质量由 judge 兜底 | 主跑待启动 |
| 状态传递创新（20） | 向量确实携带任务信息；传它比传文本省 | E2a **causal-state**（§3）；E2b **transport**（§4） | **已出数** |
| 记忆复用（20） | 关联任务链上后轮复用前轮，命中有金标准 | E3：~~SYN0 vs SYN~~ → **SYNCOLD vs SYN** 隔离跨轮记忆效应（§6 修订）；**memhit** 离线按 dependsOn / anchors 金标准评分（§2.2） | 主跑待启动；评分器已就绪 |
| 系统完整性（20） | 四角色、≥10 轮连续、失败不吞 | E4：主跑 2 组 × 10 轮 × 3 臂 = 60 轮，每轮保留证据；有效性、重试、问题清单入 rounds.jsonl | 主跑待启动 |
| 实验验证（15） | 口径先于数据、配对统计、独立计量 | 本文 §2 冻结；配对 bootstrap；eBPF 内核侧独立账本（S3） | 持续 |

对照依据（调研见会话记录）：

- AgentPrune（2410.02506）：token 取自 API usage，按成功任务折算。
- Optima（2410.08115）。
- AWM（2409.07429）：分组流式、按轮报告。
- Evo-Memory（2511.20857）。
- 因果审计（2608.04893、2607.26773）：错配消息和置零消息作对照。
- MeanCache（2403.02694）：误命中单列。

## 2. 主跑的分析口径（冻结于主跑任何数据之前）

### 2.1 质量：`experiments/analysis/judge.mjs`

- **评分方式：**
  - 每个 (arm, group, round) 取最后一次有效尝试的 `answer.md`，调用一次 LLM。
  - 对该任务的 keypoints 逐条判 0/1，本轮得分 = 命中数 / 要点数。
  - family 文件的 sha256 必须与主跑 manifest 一致，否则拒绝评分。
- **评判模型：** `deepseek/deepseek-v4.1-flash`，与被测模型 `z-ai/glm-5.3-flashx` 不同族，以避免自偏好。调用走 `pi -p`，关闭工具、扩展和上下文文件，key 由 pi 自己管理。
- **自检：** 使用 `--self-check` 双判，报告逐要点翻转率（flip rate）。
  - 翻转率 > 10% 时，改用人工对 10 轮抽样评分，并在报告中声明。
- **统计：** 对两臂都有得分的 (group, round) 做配对 SYN − TXT，percentile bootstrap，B = 10000，seed 20260921。
- **缺失值：** 没有答案，或评判回复重试 2 次仍解析失败的，记为 unavailable，不计 0。
- **执行时机：** 只在主跑结束后运行，不与主跑穿插。

### 2.2 记忆命中：`experiments/analysis/memhit.mjs`（无 LLM）

- **定位：**
  - 每条记忆记录按 `provenance.runId` 定位到**产生轮**。
  - 每个 `memory-reuse` 事件（记录被交给某个子 agent）按账本文件的 runId 定位到**消费轮**。
- **按来源分类：**

  | 类别 | 含义 |
  |---|---|
  | intra-round | 同轮内角色之间传递 |
  | dep | 产生轮属于消费任务的 `dependsOn`，是**金标准链接** |
  | chain | 同组更早的轮，但不在 dependsOn 里 |
  | cross-group | 另一组产生的记录 |

- **按相关性（独立于轮次）：** 记录的 `source.path` 属于消费任务或其 dependsOn 任务的 anchors 时，记为 **anchor-relevant**。
- **报告指标：**

  | 指标 | 定义 |
  |---|---|
  | 检索命中率 | 有 ≥1 条授权有效命中的 query 数 / query 总数 |
  | 跨轮复用率 | 第 2 轮起，有跨轮复用的轮次占比 |
  | dep 召回率 | dependsOn 轮产生的记录中，本轮被复用过的比例 |
  | anchor 精度 | 被复用记录中 anchor-relevant 的比例 |
  | G2 跨组占比 | G2 跨轮复用中来自 G1 的比例，作为误命中的代理指标 |

- **学习曲线：** 以上指标都按轮给出序列。

### 2.3 协议与记忆的归因

| 对比 | 含义 |
|---|---|
| TXT vs SYN | 协议效应（两臂都开记忆） |
| SYN0 vs SYN | 记忆效应（同一协议，SYN0 关闭记忆） |
| TXT vs SYN0 | 协议效应叠加去掉记忆 |

每个对比都同时报告质量（§2.1）；质量显著下降时，省下的 token 不作为节省的证据。

> **本节表格已被 §6 修订取代（2026-09-25，主跑任何数据之前）。** 上表对 SYN0 的两行解读不成立：SYN0 不是"同一协议、关闭记忆"，而是 SYNAPSE 全关。保留原表只为留痕，引用时以 §6.2 为准。

## 3. E2a causal-state：状态向量是否携带任务特定信息

**产物：** `~/.pi/agent/synapse/experiments/causal-state-20260924-025506/`

**装置：**

- **语料：** 本仓库 HEAD（`5bb7a98`）的 src/docs/scripts/prompts/agents/skills 和顶层 md，用产品的 corpus builder 切分。
  - 窗口 40 行、重叠 8 行，共 **4121 chunks**。
  - 没用默认的 200/40：那样最大 chunk 约 45 KB，超过 bge-m3 的 8K token 输入上限。
  - 已排除 test/、docs/experiments/*.json，以及含答案要点的 synapse-bench families。
- **嵌入：** 产品客户端加 `/synapse-setup` 存储的 key，模型 SiliconFlow `BAAI/bge-m3`，1024 维。key 在进程内解析，从不打印。
- **查询与金标准：** G1/G2 共 20 个任务的题面，金标准为该任务的 anchors 文件。副集用 90 条 keypoint 文本作查询。
- **打分：** 接收方用产品的 `rankCorpusChunks`（余弦，稳定次序）排序。

**结果（主集 n=20）：**

| 接收方拿到的状态 | hit@1 | hit@5 | coverage@5 | MRR@10 | 线上字节 |
|---|---|---|---|---|---|
| **正确向量（float32）** | 0.60 | **0.85** | 0.51 | 0.72 | 4096 |
| int8 网格往返 | 0.60 | 0.85 | 0.54 | 0.72 | —（非产品编码） |
| 相对上一题向量的 delta 残差（n=18） | 0.50 | 0.83 | 0.50 | 0.67 | **1863** |
| 错配：另一组同序号任务的向量 | 0.00 | **0.00** | 0.00 | 0.01 | 4096 |
| 错配：同链相邻任务的向量 | 0.20 | 0.40 | 0.16 | 0.28 | 4096 |
| 随机高斯向量（20 个种子取均值） | 0.01 | 0.03 | 0.01 | 0.02 | 4096 |
| 全零向量 | 产品拒收（`integrity: left vector is all zeros`） | | | | |
| 无状态，按题面 BM25 检索（参照检索器，非产品文本通道） | 0.20 | 0.35 | 0.14 | 0.28 | 389 |

**差值（正确向量减去各对照，配对 bootstrap 95% CI；hit@5 用 McNemar 精确检验）：**

| 对照 | Δhit@5 [95% CI] | McNemar p |
|---|---|---|
| 另一组错配 | +0.85 [0.70, 1.00] | < 0.0001 |
| 随机向量 | +0.82 [0.66, 0.97] | — |
| 同链相邻错配 | +0.45 [0.20, 0.70] | 0.012 |
| BM25 | +0.50 [0.30, 0.70] | 0.002 |

- 副集（keypoint 作查询，n=90）：正确向量 hit@5 为 0.78，错配 0.08，BM25 0.49，两两 McNemar p < 0.0001。

**解读：**

1. **向量携带的是任务特定内容，而不只是“有消息”。** 同样 4096 B 的错配向量或随机向量，命中率降到接近 0。
2. **同链相邻错配**在 G1 是 0.70，在 G2 是 0.10。G1 的相邻任务主题本身重叠，这说明关联任务链确实是相关的，也是 E3 记忆复用的前提。
3. **在关联任务链上可以只发残差。** 以上一题向量为基底，delta 平均 1863 B（比 4096 B 省 54.5%），hit@5 不变（0.85 → 0.83，p = 1）。
   - 这里的前提是接收方已经持有基底向量（热基底）。
   - P45 的全账本净亏，来自冷基底选择时要读 12 条记录。本实验没有测这部分读取开销，不能直接和 P45 的全账本比较。
4. **字节对比。** 状态交接的线上字节是信封 1143 B 加向量 4096 B，共 5239 B。若把 top-5 证据原文交给下游，平均要 11327 B，状态交接省 54%。
5. **时延对比。** 接收方省掉一次 embedding 调用（未缓存时平均 299 ms），代价是本地余弦排序 4121 个 chunk（38 ms）。

**局限：**

- n=20 偏小。G2 的题面大多直接点名目标文件，这对 BM25 和向量都有利，但 BM25 的 G2 hit@5 为 0：文档和变更记录里对同名文件的高频提及把它带偏了。
- BM25 是本脚本自带的简化实现，不代表产品 text 档的效果（产品 text 档是子 agent 自己 grep）。

## 4. E2b transport：一次交接在各条路径上的代价

**产物：** `~/.pi/agent/synapse/experiments/transport-20260924-030109/`

**装置：**

- 环境：WSL2 6.6.87，ext4 与 tmpfs，node v24.21。
- 每条路径 2000 次，另有 200 次预热。
- 调用的全是产品模块：`publishEnvelope`/`readDeliveredEnvelope`、`publishEnvelopeViaUds`/`receiveDeliveredEnvelopeViaUds`、content store。

**结果：**

| 路径 | 字节/次 | p50 µs | p95 µs | p99 µs |
|---|---|---|---|---|
| 信封，file 档 | 1143 | 73.5 | 160.5 | 394.9 |
| 信封，uds 档（产品：每封信绑一个新监听端） | 1147 | **10106.7** | 10814.0 | 13646.6 |
| uds 常驻监听（参照，非产品路径） | 1147 | 38.4 | 88.6 | 200.0 |
| 向量载荷，ext4 | 4096 | 28.7 | 39.9 | 79.3 |
| 向量载荷，tmpfs | 4096 | 18.8 | 42.0 | 57.7 |
| 文本交接（11327 B 证据原文，ext4） | 11327 | 81.8 | 133.4 | 203.5 |
| **状态交接 = file 信封 + 载荷** | 5239 | 102.2 | 200.5 | — |

**解读：**

1. **所有本地路径都是 100 µs 量级。** 一轮流水线的 LLM 耗时约 12 分钟（主跑冒烟实测），传输时延在单任务总耗时里可以忽略。协议的收益要看 token 和字节，不看这里的微秒。
2. **发现：uds 档每条消息多出约 10 ms。**
   - 原因：产品的 `receiveOnce` 每条消息新绑定一个监听端，而对新绑定监听端的首次 connect 要约 10 ms。
   - 旁证：用裸 `node:net` 复现，在 ext4、tmpfs、/tmp 上结果都是约 10.1 ms。
   - 常驻监听只要 38 µs。
   - 这可能是 WSL2 内核特有的现象，需要在 openEuler 真机上复测。如果真机也是这样，uds 档应改为每个子 agent 一个常驻监听端。这属于产品改动，需要另行批准。

## 5. 待办

1. **主跑：** G1,G2 × 10 × TXT,SYN,SYNCOLD,SYN0（§6 修订后的装置），由用户批准后启动。之后依次运行：
   ```sh
   node experiments/bench/aggregate.mjs <dir>
   node experiments/analysis/judge.mjs <dir> --self-check
   node experiments/analysis/memhit.mjs <dir>
   ```
2. **openEuler 24.03-LTS-SP3 真机：** 复跑 transport（重点看 uds 的 10 ms 是否还在），以及 S1、S2、S3 验收。
3. **复现：**
   ```sh
   NODE_USE_ENV_PROXY=1 node --experimental-strip-types experiments/analysis/causal-state.mjs
   node --experimental-strip-types experiments/analysis/transport.mjs
   ```
   需要代理的环境要加 `NODE_USE_ENV_PROXY=1`：Node 的 fetch 默认不走 https_proxy。

## 6. 修订（2026-09-25，冻结于正式主跑任何数据之前）

起因：首次主跑 `s5-main-20260924` 跑到第 7 次尝试时停下检查，发现三处装置问题。那 7 次尝试（G1 r1–r3）只作 pilot，**不进入任何正式表格**；它们的配置与下文不同，数字永不与正式数据并列。

### 6.1 发现

1. **SYN0 是 SYNAPSE 全关，不是"协议无记忆"。**
   - `memory:"off"` 时，`resolveSynapseChildContract` 返回 null（`src/synapse/child-contract.ts:184`）；信封、状态、记忆、计量四条路径都以 `synapse === undefined` 提前返回（`src/runs/shared/synapse-delegation.ts:51/130/273`）；父侧 SYNAPSE 工具也不注册（`src/synapse/register-tools.ts:227`）。
   - pilot 实测：`store-SYN0/` 为空，rpc 日志中 envelope 与 `synapse_*` 调用均为 0 次，四个角色照常委派。
   - 所以 SYN0 是普通 pi 多 Agent，没有账本，子会话 token、消息、字节、记忆指标原本全部缺失。
2. **SYN 臂从不发送状态。** bench 没有配置 `corpusSnapshotId`，状态面不启动；pilot 中 `state.sent` 恒为 0。
3. **答案泄露。** 工作树是整个仓库的拷贝，含 `experiments/bench/families/*.json`（评分要点原文）。pilot 中 TXT G1 r3 的 retriever 用 grep 命中了该文件的要点行，另有多份转录出现该路径。

### 6.2 臂与对比（取代 §2.3）

| 臂 | 配置 | 含义 |
|---|---|---|
| TXT | `mode:text, memory:project` | SYNAPSE text 模式：有契约和信封，记忆正文以文本注入，无状态面 |
| SYN | `mode:synapse, memory:project, autoDistill, corpusSnapshotId` | 完整系统：记忆按引用交接、自动蒸馏、状态面 |
| SYNCOLD | 同 SYN；每次尝试前把 `memory/ supersessions/ objects/ receipts/ envelopes/` 移到 `store/_cold-archive/<标签>/` | 同一协议与状态面，无跨轮记忆（轮内交接照常） |
| SYN0 | `mode:synapse, memory:off` | SYNAPSE 全关：纯 pi 多 Agent 基线 |

| 对比（A → B） | 含义 |
|---|---|
| TXT → SYN | 协议效应：text 模式 vs synapse 模式（记忆两侧都开，SYN 另有状态面） |
| SYNCOLD → SYN | 跨轮记忆效应（同协议、同状态面） |
| SYN0 → SYN | SYNAPSE 整体效应 |
| SYN0 → TXT | text 模式加文本记忆的效应 |

- "TXT → SYN" 同时改变了协议和状态面，报告时写"协议＋状态面"，不写"纯协议"。
- 状态面单独的效应本装置不隔离；向量携带任务信息的证据以 §3 causal-state 为准。

### 6.3 指标来源

- **子会话 token：** 有账本的臂取账本 `model-usage`（role child）；SYN0 取各子 Agent 的 `<tmp>/artifacts/*_meta.json` usage 之和。pilot 中两者并存的 5 次尝试（TXT、SYN）input+output 与 cacheRead **逐位一致**。runner 每轮都记录 `childArtifacts`，aggregate 在 `tokens.child.sources` 标明来源。
- **SYN0 的消息数、交接字节、信封字节、状态、记忆指标：** 记为 **N/A（该臂没有这项机制）**，不是"不可用"，也从不按 0 计。凡是需要这些指标的对比，只在有该机制的臂之间进行。
- **四角色齐全：** SYN0 按 meta 文件中的 agent 名判断；有效性要求至少 1 个子 Agent 的 meta 文件。

### 6.4 语料库与防泄露

- **语料：** 由产品构建器生成，窗口 40/8，与 §3 相同；来源是工作树中的 `src docs scripts prompts agents skills` 和顶层 md。缓存在 `<out>/_corpus-cache`，复制进 SYN / SYNCOLD 的 store，manifest 记录 snapshot id、chunk 数和排除项。
- **工作树与语料同时排除：** `experiments/bench/`、`experiments/analysis/`、`docs/experiments/`。这三处都不是任何任务的 anchor。
- **残余风险：** 子 Agent 有 bash，理论上能读到工作树外的实验目录（例如其他臂的 answer.md）。本装置不做沙箱隔离，事后用转录做一次路径审计：在 transcript 中 grep `synapse/experiments` 与 `families`，结果随报告披露。

### 6.5 judge 与 memhit

- `judge.mjs`：对 §6.2 的每一对报告配对 B − A 的得分差和 bootstrap 区间；`comparison.score`（TXT/SYN）保持原形，供控制台读取。
- `memhit.mjs`：SYNCOLD 的记录连同 `_cold-archive/*/memory` 一起读入。SYNCOLD 的跨轮复用率预期为 0，可当作装置自检。


### 6.6 被测模型与 judge 更换（2026-09-25，主跑启动时）

- **被测模型：** 由 `z-ai/glm-5.3-flashx` 改为 `deepseek/deepseek-v4.1-flash`，provider 为 `commandcode`，理由是成本。正式主跑是 `s5-main-20260925`。此前所有 glm 数据（smoke2、pilot `s5-main-20260924`、smoke3、smoke4）都只用于装置验证，不与正式数据并列。
- **judge：** §2.1 选 `deepseek-v4.1-flash` 的理由是"与被测模型不同族"。被测模型换成 DeepSeek 后，这条理由不再成立，所以 judge 改为 **`z-ai/glm-5.3-flashx`**。§2.1 的其余条款不变，包括双判自检、翻转率超过 10% 时转人工抽样、配对 bootstrap、缺失值记 unavailable。
- **judge 的运行方式：** `node experiments/analysis/judge.mjs <dir> --self-check --judge-model z-ai/glm-5.3-flashx`，只在主跑结束后运行。

### 6.7 provider 回退（2026-09-25，主跑进行中）

- **起因：** commandcode 的额度可能在主跑中途耗尽。备用通道是 DeepSeek 官方 API（`https://api.deepseek.com`），模型 `deepseek-flash`；它的 `/models` 自述为 DeepSeek-V4.1-Flash，与 commandcode 上的 `deepseek/deepseek-v4.1-flash` 是同一个模型、不同的托管方。
- **装置：**
  - runner 新增 `--resume`：臂、组、轮次、语料库和各臂配置一律取自原 manifest，不重新计算；已有有效记录的步骤跳过；新尝试的编号排在磁盘上所有已有尝试之后。每次续跑都记入 `manifest.resumes`，每条记录都写明它实际使用的 provider 和 model。
  - 某次尝试失败，且 rpc 日志中出现额度或鉴权类错误（40x、insufficient、credit、quota、balance 等）时，runner 以退出码 75 停下，不再耗用剩余尝试。网络错误和普通限流不算在内。
  - 守护脚本在两轮之间把原 runner 交给续跑 runner；收到退出码 75 后，改用 DeepSeek 官方通道继续跑。
- **交接留下的痕迹：** 原 runner 停下的那一刻，下一步可能刚启动就被中止。这次尝试不写 rounds 记录，只留下 `evidence/.../attempt-N/prompt.md`，续跑从 N+1 开始编号。所以个别步骤会出现"缺了第 N 次尝试"，这是如实的痕迹，不是数据丢失。
- **分析口径：**
  - 配对比较照常按所有有效轮进行。
  - 另做一次敏感性分析：剔除同一 (组, 轮) 内各臂 provider 不一致的轮次后重算，两套结果并列报告。
  - 缺少 `provider` 字段的早期记录，使用的是 manifest 中的原始 provider（commandcode）。

### 6.8 阶段结果交接的正式重跑：口径冻结（2026-09-25，新数据产生之前）

- **起因：** `s5-main-20260925` 的前 7 轮（暂停于 G1 r3）看不到 token 节省。按归因分析，根因有三：阶段之间的交接是全文转贴；子 Agent 的全文会回流给父会话；synapse 模式下召回的记忆写进系统提示词，绕开了计量。设计见 `docs/superpowers/specs/2026-09-25-synapse-stage-result-handoff-design.md`。
- **旧 7 轮的处理：** 这 7 轮只作为"改前"参照单独报告，不与新数据合并。它们的父会话 token 已按下面第 2 条的口径重算。
- **计量修正：**
  1. 父会话 token 只累加父会话自己 assistant 消息的 `message_end` usage，记为 `record.parentUsage`；旧记录从 `pi-rpc.log` 重新读取。`get_session_stats` 已经包含进程内子会话，此前的总 token 因此把子会话重复计入了一次，这个口径作废。
  2. 由此重算的旧 7 轮每轮均值：TXT 197k（n=3）、SYN 220k、SYNCOLD 209k、SYN0 278k（后三者 n=2）。
- **主指标（通信效率）：**
  1. **EdgeBytes**（`experiments/analysis/edge-bytes.mjs`）：四个臂用同一个算法，统计 下行 + 上行 + 按需拉取 三部分的 UTF-8 字节。下行包含 `memory-redeem` 事件记下的取回字节。
  2. **总 API token**：父会话自己的 token 加子会话 token，按 input+output 计，cacheRead 单列。
- **主对比：** SYN0 → SYN，即相对纯文本多 Agent 协作的节省。分解对比有三组：TXT → SYN（协议）、SYNCOLD → SYN（跨轮记忆）、SYN0 → TXT。
- **质量门槛：** judge 使用 `z-ai/glm-5.3-flashx`，开 `--self-check`。对 SYN − SYN0 的配对得分做 TOST 非劣检验，δ = 0.05。未通过非劣时，节省不作为证据。
- **统计：** 配对 bootstrap，B = 10000，seed 20260921。区间跨 0 时只报告方向。多组对比一起报告时，另附 Holm 校正后的结论。
- **额外报告的项：**
  - 结果块压缩比：`stageResults.renderedBytes / fullBytes`；
  - 发生回退的次数；
  - 按需拉取的次数与字节；
  - 编排者未按规则原样转交结果块的次数。这一项由人工抽查转录得出，并注明抽查了多少份。
- **装置：** 新的实验 ID；G1+G2 × 10 轮 × 4 臂；每轮最多尝试 2 次；启用 `--parallel-arms`（同一轮四臂并发，四臂都结束后再进入下一轮）。模型 `deepseek-v4.1-flash`，经 `commandcode`；额度耗尽时按 §6.7 回退到 DeepSeek 官方通道。

### 6.9 任务族改用公开 benchmark（2026-09-25，正式数据产生之前）

- **起因：** 自建的 G1、G2 任务族说服力不足，而且分析对象是本项目自己的代码。同类工作普遍在公开 benchmark 上评测：
  - 通信效率方向：Optima 用 HotpotQA 和 2WikiMultiHopQA 做信息交换任务；
  - 记忆与持续改进方向：StreamBench 用 HotpotQA，并有多 Agent 共享记忆基线 MAM-StreamICL；
  - 仓库级代码问答：SWE-QA（ACL 2026 Findings）。
  - 赛题要求"关联连续任务"，所以按 StreamBench、Evo-Memory、AWM 的做法，把公开数据集的题目**重新组织成任务流**。
- **新任务族**（由 `experiments/bench/build-public-families.mjs` 固定 id 生成，重建结果不变）：
  - **Q：MuSiQue-Ans v1.0 dev，10 题**
    - 10 题共享同一条桥接链：从"明代汉藏关系"出发，找到永乐帝接见受诏者的城市，即南京。每题再问南京的一个不同属性。
    - 答案两两不同，含糊答案（如 "thousands"、"two"）已排除。
    - 段落池是 10 题各自 20 段的并集，去重后共 67 个文件，含干扰段，放在工作树 `musique/` 下。
    - 评分：取回答末行的 `ANSWER:`，做 SQuAD 式归一化后计算 EM 和 F1（对标准答案及其别名取最大值）；另报 Cover-EM。
  - **R：SWE-QA Flask 子集，10 题**
    - 选题围绕带标签的 JSON 序列化器（`src/flask/json/tag.py`）和会话接口（`src/flask/sessions.py`），按"序列化器核心 → 各 tag → 会话"的顺序排列；题面是 SWE-QA 原文。
    - 仓库为 pallets/flask@85c5d93（SWE-QA 固定的 commit），放在工作树 `flask/` 下，已去掉 `.git`。
    - 评分：SWE-QA 原版 LLM-as-judge 提示词，从基准仓库原文读取，5 个维度各 1–20 分，满分 100；每个回答判 5 次，每个维度取中位数。
- **工作树与防泄露：**
  - 两组共用一棵工作树（`musique/` 与 `flask/`），语料库也用这棵工作树建（`--worktree`）。
  - 答案和参考答案只存在于 `experiments/bench/families/`，这个目录不进入工作树。
- **judge：** Q 组不用 LLM 评分；R 组的 judge 使用 `z-ai/glm-5.3-flashx`。
- **非劣界值 δ：** Q 组 F1 为 0.05，R 组总分为 5 分（满分 100）。主对比和统计方法与 §6.8 相同。
- **G1、G2 降为补充演示：** 只用来展示系统在 openEuler 本机上的能力，不再进入正式的四臂对比。另外，G2 第 8 题有一个评分要点已经过时：它写"schemaVersion 为 5"，但 HEAD 上是 6。这个问题记在这里，G2 不再修正。
- **正式实验：** Q、R 两组各 10 轮 × 4 臂，`--parallel-arms`，每轮最多 2 次尝试。模型为 `deepseek-v4.1-flash`，额度用尽时的回退方式按 §6.7。
- **修订（同日，冒烟 `smoke6-public` 之后、正式数据之前）：** Q 组题面末尾的格式说明收紧为 `ANSWER: <short answer only — the entity, number or phrase itself, no explanation>`。
  - 原因：冒烟中各臂答案的内容都对，但有些 ANSWER 行写成了整句解释。按 EM 计分，这类回答会被判错；它反映的是输出格式问题，与答案对错无关。
  - MuSiQue 的问题原文不变，只改了这一行格式说明。改动后 Q 族文件的 sha 会变化，以正式实验 manifest 中记录的为准。

### 6.10 目录调整（2026-09-25，正式数据之前）

- 实验相关文件统一移到 `experiments/`：
  - `scripts/synapse-bench/` 移到 `experiments/bench/`；
  - `scripts/synapse-exp/` 移到 `experiments/analysis/`；
  - P45 / P50 / 标定相关脚本移到 `experiments/legacy/`；
  - 数据集移到 `experiments/data/`。数据集不进 git，由 `experiments/bench/prepare-public-data.sh` 重建。
- 本文和其他文档中的路径已经改成新位置。旧实验的 manifest 里记录的仍是旧路径，分析脚本会自动把旧路径映射到新位置。
- 工作树防泄露：runner 现在排除整个 `experiments/` 目录（加上 `docs/experiments/`），所以 G1、G2 的 Agent 同样看不到答案文件、实验脚本和数据集。

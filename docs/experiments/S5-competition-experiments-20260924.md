# S5 赛题实验：设计、冻结的分析口径与已出数据

- 日期：2026-09-24。代码基线 `5bb7a98`。
- 本文档一式三用：
  1. 赛题评分项 → 实验映射；
  2. 正式 LLM 主跑的**分析口径**（在其任何数据产生前冻结）；
  3. 两组无 LLM 实验的结果。
- 分工：
  - `scripts/synapse-bench/`（G1/G2 × 10 轮，TXT / SYN / SYN0 交替）归主跑会话所有。
  - `scripts/synapse-exp/`（本文的 causal-state、transport、judge、memhit）为补充实验。
  - 两者产物都在 `~/.pi/agent/synapse/experiments/<id>/`，控制台统一读取。

## 1. 评分项 → 实验

| 评分项（分值） | 要证明什么 | 实验 | 状态 |
|---|---|---|---|
| 通信效率（25） | 质量不降时 token/字节更少 | E1：synapse-bench TXT vs SYN（记忆两臂都开，只差协议）；主指标 tokens、handoffBytes、wallMs，质量由 judge 兜底 | 主跑待启动 |
| 状态传递创新（20） | 向量确实携带任务信息；传它比传文本省 | E2a **causal-state**（§3）；E2b **transport**（§4） | **已出数** |
| 记忆复用（20） | 关联任务链上后轮复用前轮，命中有金标准 | E3：SYN0（synapse、memory off）vs SYN 隔离记忆效应；**memhit** 离线按 dependsOn / anchors 金标准评分（§2.2） | 主跑待启动；评分器已就绪 |
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

### 2.1 质量：`scripts/synapse-exp/judge.mjs`

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

### 2.2 记忆命中：`scripts/synapse-exp/memhit.mjs`（无 LLM）

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

1. **主跑：** G1,G2 × 10 × TXT,SYN,SYN0，由用户批准后启动（约 12 h）。之后依次运行：
   ```sh
   node scripts/synapse-bench/aggregate.mjs <dir>
   node scripts/synapse-exp/judge.mjs <dir> --self-check
   node scripts/synapse-exp/memhit.mjs <dir>
   ```
2. **openEuler 24.03-LTS-SP3 真机：** 复跑 transport（重点看 uds 的 10 ms 是否还在），以及 S1、S2、S3 验收。
3. **复现：**
   ```sh
   NODE_USE_ENV_PROXY=1 node --experimental-strip-types scripts/synapse-exp/causal-state.mjs
   node --experimental-strip-types scripts/synapse-exp/transport.mjs
   ```
   需要代理的环境要加 `NODE_USE_ENV_PROXY=1`：Node 的 fetch 默认不走 https_proxy。

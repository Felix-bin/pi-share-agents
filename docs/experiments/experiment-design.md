# SYNAPSE 实验方案设计

> 赛题：一种面向多智能体协作的低开销通信、状态传递与共享记忆机制
>
> - 版本：2026-09-25。本文件取代原先 `docs/experiments/` 下的分散文档。
> - 历史原件（各次预登记、结果报告、标定数据）原样保存在 [`experiments/legacy/records/`](../../experiments/legacy/records/)，口径的演变见 §11。
> - 实验脚本、数据集与复现命令见 [`experiments/README.md`](../../experiments/README.md)。
>
> **纪律**：分析口径在对应数据产生之前冻结。改口径必须在 §11 登记日期、原因，并声明被取代的旧口径；出数之后只填数，不改判据。负结果与正结果一样全文披露。

---

## 1. 目标与评分项映射

| 评分项（分值） | 要证明什么 | 实验 | 主要证据 | 状态 |
|---|---|---|---|---|
| 通信效率（25） | 在质量不下降的前提下，Agent 间通信比纯文本协作更少，总 token 不增加 | **E1** 四臂主实验（Q、R 两组公开 benchmark） | EdgeBytes、总 API token、按 Agent 拆分的交接占比；质量非劣 | 冒烟通过，正式重跑待启动 |
| 状态传递创新（20） | 向量确实携带任务特定信息；传向量比传文本省字节；接收方真的用上了它 | **E2a** causal-state（离线因果审计）、**E2b** transport（传输代价）、E1 在线状态面 | 正确 / 错配 / 随机 / 零向量四组对照的 hit@k；各路径字节与时延；E1 中的 state.sent / consumed | E2a、E2b 已出数 |
| 记忆复用（20） | 关联任务链上，后面的轮次复用前面轮次的记忆，命中有金标准可查，并带来收益 | **E3**：SYNCOLD 对 SYN（同协议，只差跨轮记忆），memhit | 跨轮复用率、dep 召回、anchor 精度；token 与质量的差异 | 随 E1 |
| 系统完整性（20） | 4 个角色、每组 10 轮以上连续运行、失败不被吞掉 | **E4**：E1 的 80 轮本身 | 有效率、重试、超时、结果块回退、provider 回退 | 随 E1 |
| 实验验证（15） | 口径先于数据、同条件配对、统计充分、独立计量 | 本文 §8–§9；**E5** eBPF 内核侧独立账本（S3） | 预登记与修订记录；配对 bootstrap；TOST | 持续 |

---

## 2. 被测系统

### 2.1 宿主与运行时

- **宿主**：pi coding agent（`@earendil-works/pi-coding-agent@0.87.0`），以 RPC 模式运行。每轮启动一个父会话，只加载本插件：`-e index.ts --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session`。
- **编排**：父会话读取 `prompts/role-pipeline.md` 模板加上本轮任务文本，依次委派 planner → retriever → executor → summarizer 四个子会话。父会话可以用单次调用、chain 或 workflowScript 三种方式编排，编排方式由模型自行选择。
- **子会话**：每个阶段都是全新的子会话，按 `asyncByDefault:false` 在前台运行，父会话等它完成后再继续。

### 2.2 四个角色（`agents/*.md`，所有臂相同）

| 角色 | 工具 | 推理强度 | 产出 |
|---|---|---|---|
| planner | read / grep / find / ls / write | high | `plan.md`：3–6 个可核验步骤，每步写明由哪个角色执行 |
| retriever | read / grep / find / ls / write | medium | `evidence.md`：带文件和行号的证据，末尾写 ESTABLISHED / NOT ESTABLISHED |
| executor | read / grep / find / ls / **bash** | medium | 执行的命令、退出码和实际输出；默认先读 plan.md 和 evidence.md |
| summarizer | read / grep / find / ls / write | high | `summary.md`：先给答案，再写依据和仍未确定的部分 |

### 2.3 SYNAPSE 机制，以及它们在实验中的作用

| 机制 | 实现 | 在 E1 中的作用 |
|---|---|---|
| **结构化信封（请求）** | `src/synapse/envelope.ts`。字段包括 action（delegate / retrieve）、inputParams（canonical JSON）、capabilityId、memoryRefs（最多 32 个）、stateRef。schema 禁止未知字段，协议版本为 2 | 每次委派都有一个信封，字节计入 `control.envelopeBytes` |
| **能力协商** | `capability.ts` 的 negotiate，运行期探针见 `capability-probe.ts` | 决定每次交接走状态通道还是文本通道，结果记入账本 |
| **阶段结果（响应）** | `stage-result.ts`。planner、retriever、executor 完成后，完整输出存为一条记忆记录；交给编排者的是一个不超过 1.5 KB 的 `[SYNAPSE result]` 块，内容是结论行加句柄。回执带 `result` 字段，`outputRef` 指向全文对象。summarizer 是交付物，返回全文 | 取代"上游全文回流给父会话、再转贴给下游"的做法，是通信节省的主要来源 |
| **句柄交接** | 下游需要细节时，用 `synapse_read get <memoryId>` 按句柄分页读取 | 按需拉取的字节计入 EdgeBytes，不算作免费 |
| **非文本状态** | 查询文本经 bge-m3 编码为 1024 维 float32 向量（4096 B），存入 CAS；stateRef 随信封下发；接收方在冻结语料上做余弦排序，把 top-5 片段的预览注入上下文。残差编码（delta）已实现，但默认关闭（依据见 §10.3） | 每轮交给 retriever 时发送 1 次 |
| **共享记忆** | `memory-store.ts` / `retrieval.ts`。每条记录都有 memoryId、来源 Agent、createdAt、taskTopic、summary、kind、assurance、tags、向量和源指纹。检索按关键词 0.3、标签 0.2、语义 0.5 加权；源文件变化后记录自动判为 stale | 跨轮、跨 Agent 复用；召回的记忆以"300 B 预览加句柄"注入 |
| **宿主侧自动蒸馏** | `auto-distill.ts`。委派完成后，宿主按一条固定规则抽取 ESTABLISHED 行（最多 12 行），写入记忆 | 记忆的来源；不依赖模型自己决定写不写 |
| **计量账本** | `metering.ts`。只追加的事件日志加纯函数聚合；账本是主记录，聚合可以离线重算 | 所有协议侧指标都来自这里；SYN0 没有账本，按 §7 的方式另行取数 |

---

## 3. 实验总览

| 编号 | 名称 | 问题 | 方法 | 数据 |
|---|---|---|---|---|
| **E1** | 四臂主实验 | 相比纯文本协作，是否少通信、少 token，且质量不下降 | 4 臂 × 2 组（Q、R）× 10 轮，同一轮的四臂并发 | §10.7 冒烟；正式重跑待启动 |
| **E2a** | causal-state | 向量是否携带任务特定信息 | 离线：同一接收方、同一语料，分别给正确、错配、随机、零向量，比较 hit@k | §10.1 |
| **E2b** | transport | 一次交接在各条传输路径上的字节与时延 | 离线：直接调用产品模块，每条路径 2000 次 | §10.2 |
| **E3** | 记忆复用 | 跨轮记忆是否被复用、命中是否正确、是否带来收益 | 从 E1 中取 SYNCOLD 对 SYN；memhit 对照金标准链接 | 随 E1 |
| **E4** | 系统完整性 | 80 轮连续运行是否稳定、失败是否可见 | 从 E1 的 rounds.jsonl 统计有效率、重试、回退 | 随 E1 |
| **E5** | 内核侧独立计量 | 应用账本的字节是否与内核观测一致 | S3 的 eBPF 采集器与产品账本逐轮对账 | 本机采集器已验收 5/5；对账待真机 |

---

## 4. 实验臂（E1）

### 4.1 定义

四个臂只在插件 `synapse` 配置块上有差别，其余条件全部相同（§4.2）：

| 臂 | 配置 | 含义 |
|---|---|---|
| **SYN0** | `{mode:"synapse", memory:"off"}` | **SYNAPSE 全关**。memory off 时不签发 child contract，所以没有信封、状态、记忆和账本，等同于普通的 pi 多 Agent。它是**纯文本协作基线** |
| **TXT** | `{mode:"text", memory:"project"}` | SYNAPSE 的 text 模式：阶段之间全文转贴，召回的记忆正文以文本形式随任务下发，没有状态面 |
| **SYN** | `{mode:"synapse", memory:"project", autoDistill:true, corpusSnapshotId, embedding}` | 完整系统：结果块加句柄交接、按引用取回记忆、状态向量、自动蒸馏 |
| **SYNCOLD** | 与 SYN 相同，另外在每次尝试前把 `memory/ supersessions/ objects/ receipts/ envelopes/` 移到 `store/_cold-archive/<标签>/` | 同一套协议和状态面，但**没有跨轮记忆**（同一轮内部的交接照常） |

### 4.2 控制变量（四臂完全相同）

- 同一个 pi 版本、同一个插件 commit；父会话和子会话用同一个模型；嵌入模型相同。
- 同一个编排模板、同一段任务文本、相同的题目顺序。
- 同一套角色定义，同一份工作树副本（内容逐字节一致），同一个 venv（`--path-prepend`）。
- 相同的超时（单轮 30 分钟）、尝试次数（每轮最多 2 次）和有效性规则。
- 同一轮的四臂并发（`--parallel-arms`），处在同一个 provider 时间窗口；四臂都结束后才进入下一轮。
- 每个臂有独立的记忆库，跨轮、跨组都不清空（SYNCOLD 除外）。

### 4.3 对比关系

| 对比（A → B） | 含义 | 用途 |
|---|---|---|
| **SYN0 → SYN** | SYNAPSE 整体相对纯文本协作 | **主结论**（通信效率 25 分） |
| TXT → SYN | text 模式换成 synapse 模式：协议、结果块、状态面一起变化 | 分解 |
| SYNCOLD → SYN | 跨轮记忆的效果（协议和状态面相同） | E3 记忆复用 |
| SYN0 → TXT | text 模式加文本记忆，相对不开 SYNAPSE | 分解 |

状态面的单独效果不在 E1 中隔离；"向量携带信息"由 E2a 证明。

---

## 5. 任务族

### 5.1 为什么用公开 benchmark

自建任务说服力不足，而且分析对象是本项目自己的代码。同类工作都在公开 benchmark 上评测：

- **Optima**（通信效率）：HotpotQA、2WikiMultiHopQA 等信息交换任务。
- **AgentPrune**：MMLU、GSM8K、HumanEval。
- **LatentMAS**（隐状态通信）：GSM8K、AIME、GPQA、MBPP+ 等。
- **StreamBench**（持续改进，含多 Agent 共享记忆基线 MAM-StreamICL）：Spider、BIRD、HotpotQA 等。
- **SWE-QA**（ACL 2026 Findings）：仓库级代码问答。
- **我们的 Python 原型**：用过 HotpotQA、MuSiQue、CoQA。

赛题要求"关联的连续任务"，而公开 benchmark 的题目大多相互独立。所以这里沿用 StreamBench、Evo-Memory、AWM 的做法：**把公开数据集的题目重新组织成一条任务流**。选哪些题、按什么顺序由固定 id 决定，重建结果不变（`experiments/bench/build-public-families.mjs`）。

我们的系统是"编码 Agent 加四个角色"，工具是读文件、grep 和 bash，所以选了两类与它匹配的任务：一类是在文档库中检索的多跳问答，一类是仓库级代码问答。数学和代码生成类 benchmark 用不上检索和记忆，SWE-bench 等需要重型环境，都没有选。

### 5.2 Q 组：MuSiQue-Ans v1.0 dev（多跳问答）

- **来源**：HuggingFace `dgslibisey/MuSiQue` 的 `musique_ans_v1.0_dev.jsonl`，共 2417 题。
- **选题规则**：
  - 选出支撑段落同时包含 "Nanjing" 和 "Sino-Tibetan relations during the Ming dynasty" 的题。这些题共享同一条桥接链：从"明代汉藏关系"出发，找到永乐帝接见受诏者的城市，也就是南京；然后每题问南京的一个不同属性。
  - 答案两两不同，且能精确匹配。含糊的答案（例如 "thousands"、"two"、"one-party"）不选；Myanmar 簇的题几乎相同、答案也相同，整簇不选。
  - 第一题负责把桥接链解出来。能记住已学内容的系统，可以在后面 9 题中复用这条链。
- **10 道题**（按顺序）：

  | # | MuSiQue id | 问的属性 |
  |---|---|---|
  | 1 | 3hop1__857_846_7701 | 何时成为中国首都 |
  | 2 | 3hop1__857_846_7702 | 城市名的含义 |
  | 3 | 3hop1__857_846_7798 | 占绝大多数的民族 |
  | 4 | 3hop1__857_846_7794 | 2010 年人口 |
  | 5 | 3hop1__857_846_7769 | 面积（平方英里） |
  | 6 | 3hop1__857_846_7846 | 本地的京剧院团 |
  | 7 | 3hop1__857_846_7872 | 足球俱乐部 |
  | 8 | 3hop1__857_846_7752 | 谁把首都迁往北京 |
  | 9 | 3hop1__857_846_7810 | 2013 年人均 GDP |
  | 10 | 4hop3__857_846_326964_7713 | 4 跳：经由 Yaxing Coach 总部所在地，问南京作为首都的年数 |

- **文档池**：10 题各自 20 段的并集，去重后共 67 段，其中包括干扰段。每段一个文件（`musique/NNN-<title>.md`）。这比标准的"每题 20 段"设定稍难，因为干扰更多。
- **题面**：MuSiQue 原题，后面加一段固定说明："只使用 `musique/` 下的文档作答；最后一行写成 `ANSWER: <short answer only — the entity, number or phrase itself, no explanation>`。"
- **评分**：对最后一行 ANSWER 做 SQuAD 式归一化（小写、去标点、去冠词、合并空白），与标准答案及其别名比较，EM 和 token F1 都取最大值。另报 **Cover-EM**：归一化后的全文中是否包含任一标准答案，agent 类 QA 论文常用这个指标。没有 ANSWER 行的回答记 0 分，并单独计数。

### 5.3 R 组：SWE-QA Flask 子集（仓库级代码问答）

- **来源**：GitHub `peng-weihan/SWE-QA-Bench`，Flask 子集共 48 题，仓库为 `pallets/flask@85c5d93`（SWE-QA 在 `repo_commit.txt` 中固定的 commit）。
- **选题规则**：选 10 道围绕同一子系统的题：带标签的 JSON 序列化器（`src/flask/json/tag.py`），以及通过它做序列化的会话接口（`src/flask/sessions.py`）。排列顺序是：序列化器的核心，然后各个 tag，最后是使用它的会话代码。题面保持 SWE-QA 原文，不做改写。
- **10 道题**：`flask.jsonl` 的第 16、43、9、38、33、37、24、12、32、29 题，依次是：
  1. bytes tag 的 base64 可逆性
  2. base64 解码在 untag 中的调用位置
  3. tuple 递归 tagging 链
  4. list tag 与分派器
  5. 透传 dict tag 只处理值、不处理键
  6. Markup tag 的辅助函数
  7. UUID tag
  8. 会话中延迟取 hash 算法
  9. 会话中重复创建序列化器的性能
  10. 会话访问跟踪与签名 cookie 的性能
- **工作树**：Flask 仓库检出到固定 commit 后，去掉 `.git`，放在 `flask/` 下。
- **执行环境**：`experiments/data/venv` 里装有 Python 3.11，以可编辑方式安装的 Flask 及其依赖，以及 pytest<9（pytest 9 移除了 Flask 这个 commit 的 conftest 用到的 `monkeypatch.notset`）。通过 `--path-prepend` 放到 Agent 的 PATH 最前面，executor 就能直接运行这个仓库自己的测试。
- **评分**：使用 SWE-QA 原版的 LLM-as-judge 提示词，从基准仓库 `Benchmark construction/score/llm-as-a-judge.py` 按原文读取，不做改写。五个维度（correctness、completeness、relevance、clarity、reasoning）各 1–20 分，满分 100，对照参考答案打分。每个回答独立评 5 次，每个维度取中位数。

### 5.4 工作树与防泄露

- Q、R 两组共用一棵工作树 `experiments/data/worktree/{musique,flask}`。每个臂拿到的是它的一份副本，语料库也由这棵工作树构建。
- 答案和参考答案只存在于 `experiments/bench/families/`，不会进入工作树。
- 用本仓库作为工作树的 G1/G2 运行，会排除整个 `experiments/` 和 `docs/experiments/`。
- 每次运行结束后，都用转录审计一遍，确认没有 Agent 读到答案文件、其他轮的作答，或者其他臂的工作树和记忆库（`experiments/bench/README.md`）。

### 5.5 补充任务族 G1 / G2（自建，只作演示）

- **G1**：openEuler 系统能力调研链，从平台基线到 S1/S2/S3 真机验收清单，共 10 题。答案依赖本机状态。
- **G2**：本仓库代码分析链，从信封协议一直到配置解析与端到端数据流，共 10 题。其中第 8 题有一个评分要点已经过时：要点写"schemaVersion 为 5"，HEAD 上实际是 6，未修正。
- 两组都用评分要点逐条判 0/1（`experiments/analysis/judge.mjs`），不进入正式的四臂对比。

---

## 6. 运行设置

| 项 | 设置 |
|---|---|
| 被测模型 | `deepseek-v4.1-flash`：父会话和四个子会话都用它 |
| provider | 优先 `commandcode`；额度或鉴权失败时，runner 以退出码 75 退出，`experiments/bench/supervise.sh` 自动 `--resume` 到 DeepSeek 官方 API 的 `deepseek-flash`（官方自述为 DeepSeek-V4.1-Flash）。每条记录都写明实际使用的 provider |
| judge | `z-ai/glm-5.3-flashx`：与被测模型不同族，避免模型偏向自己的回答。Q 组不需要 judge |
| 嵌入 | SiliconFlow `BAAI/bge-m3`，1024 维 |
| 语料库 | 由工作树构建，窗口 40 行、重叠 8 行（产品默认 200/40 的最大块会超出 bge-m3 的输入上限），共 1005 块；只配给 SYN 和 SYNCOLD |
| 并发与轮次 | 同一轮的四臂并发（`--parallel-arms`）；每组 10 轮；Q、R 可以放在一个实验里，也可以分开跑（分开时记忆库也分开） |
| 超时与尝试 | 单轮 30 分钟；每轮最多 2 次尝试；所有尝试都保留证据 |
| 有效性 | 流水线正常结束，且有最终回答；有账本的臂要求本轮至少写出一个计量运行，SYN0 要求至少有一个子 Agent 的 meta 文件 |
| 续跑 | `--resume`：臂、组、轮次、语料库和各臂配置都取自原 manifest；有效轮次跳过；新尝试的编号排在磁盘上已有尝试之后 |
| 产物 | `~/.pi/agent/synapse/experiments/<id>/`：manifest（代码、pi、模型、配置、工作树摘要、pip freeze）、rounds.jsonl、progress.ndjson、evidence/（每次尝试的 rpc 日志、prompt、answer、计量副本）、tmp/（每个子 Agent 的 input、output、transcript、meta）、store-/work-/agent-<臂>/ |

---

## 7. 指标定义

### 7.1 通信（主指标）

1. **EdgeBytes**（`experiments/analysis/edge-bytes.mjs`）：统计每轮 Agent 之间实际传递的 UTF-8 字节，四个臂用同一个算法。
   - **下行**：每个子 Agent 收到的任务消息，加上注入的 user 消息（状态 steer），再加上宿主写进它系统提示词的召回记忆（`memory-redeem` 事件的字节数）。
   - **上行**：父会话收到的所有 subagent 工具结果，包括 workflowScript 的返回值。
   - **按需拉取**：子 Agent 所有 `synapse_read` 调用的结果。按句柄读取全文也算通信，不能因为走了句柄就当成免费。

   这里不用产品自带的 `text.handoffBytes` 做跨臂比较，因为它不可比：synapse 模式下召回的记忆写进系统提示词，不经过它计量的那条通道；SYN0 又没有账本。
2. **总 API token**：父会话自己的 token 加各子会话的 token，只计 input + output，cacheRead 单列。
   - 父会话 token：累加 RPC 流中父会话每条 assistant `message_end` 的 usage（`record.parentUsage`）。**不用** `get_session_stats`，因为它已经包含了进程内子会话，用它会把子会话算两遍（§11 修订 8）。
   - 子会话 token：有账本的臂用账本里的 `model-usage`（role=child）；SYN0 用各子 Agent `*_meta.json` 中 usage 的总和。两种来源在同一轮都存在时，逐位一致。
3. **按 Agent 拆分**（`experiments/analysis/agent-split.mjs`）：把每个 Agent 的处理量（prompt 的 input + cacheRead，再加 output）拆成两部分。
   - **交接**：读取其他 Agent 交来的内容，乘以它在上下文中停留的调用次数；再加上它写给其他 Agent 的内容。
   - **自己干活**：固定开销（系统提示和工具定义）、工具结果与自身历史、推理与工具调用。
   - 文本到 token 的换算比例为 3.26 字节/token。这个比例是在 smoke5 上用 343 对相邻调用的增量标定出来的，中位数 3.12，四分位 2.76–3.48，所以结果误差大约 ±15%。
4. **并列指标**：
   - 消息投递次数；
   - 信封控制字节；
   - 结果块压缩比 `stageResults.renderedBytes / fullBytes`，以及回退次数；
   - 按需拉取的次数；
   - 编排者没有原样转交结果块的次数（人工抽查转录，注明抽查了多少份）。

### 7.2 状态传递

- **在线**：`state.sent`、`sentBytes`、`consumed`、`failedSends`、`restoreCount`；每轮交给 retriever 的发送次数。
- **离线（E2a）**：hit@1、hit@5、coverage@5、MRR@10，以 anchors 为金标准。对照组包括错配向量（另一组同序号题、同链相邻题）、随机高斯向量（20 个种子）、全零向量和 BM25。
- **传输（E2b）**：每条路径的字节数，以及 p50、p95、p99 时延（微秒）。

### 7.3 记忆复用（E3）

- **账本指标**：`memory.queries`；命中率 = 有授权有效命中的查询数 / 查询数（查询数为 0 时记 N/A）；复用次数、跨 Agent 复用次数；`distilled` 写入条数；`redeemedBytes`。
- **memhit**（`experiments/analysis/memhit.mjs`）：
  - 每条记录按 provenance.runId 归到它的**产生轮**，每次复用归到**消费轮**。
  - 复用按来源分为四类：同一轮内部、属于 dependsOn 的轮（金标准）、同组更早但不在 dependsOn 中的轮、跨组。
  - 汇报指标：检索命中率、第 2 轮起有跨轮复用的轮次占比、dep 召回率、anchor 精度（被复用的记录的 source.path 落在题目 anchors 中的比例）、跨组复用占比。
  - SYNCOLD 的跨轮复用应为 0，这一项同时用作装置自检。

### 7.4 时延

- 每轮墙钟时间：从 prompt 发出到流水线结束（`wallMs`）。
- 每个子 Agent 的 `durationMs` 和轮数（取自 meta 文件）。

### 7.5 质量（门槛）

- Q 组：EM、F1、Cover-EM（§5.2）。
- R 组：SWE-QA 五维总分，满分 100（§5.3）。

### 7.6 稳定性（E4）

有效率、重试次数、超时次数、结果块回退次数、provider 回退次数、四角色齐全率。

---

## 8. 统计与判定

- **样本单位**：（组，轮）配对。每组 10 对，两组合计 20 对。
- **区间**：配对差的 percentile bootstrap，B = 10000，seed 20260921。
- **表述规则**：
  - 区间不跨 0 时，可以写"节省 / 多耗 X%（区间 …）"。
  - 区间跨 0 时，只写方向和区间，**不写"显著"**。
  - 多组对比同时报告时，另附 Holm 校正后的结论。
- **质量非劣（TOST 单侧形式）**：B − A 的配对差，其 95% 区间下界大于 −δ，即判为非劣。
  - Q 组 F1：δ = 0.05。
  - R 组总分：δ = 5（满分 100）。
  - **判为非劣时，省下的 token 才算作证据**；未判为非劣时，节省照常报告，但标注"质量未证非劣"。
- **缺失值**：没有回答、或评审重试后仍解析失败，记为 unavailable，从不按 0 计。唯一例外是 Q 组缺少 ANSWER 行，按 §5.2 记 0 分并单独计数。
- **混用 provider 的敏感性分析**：同一（组，轮）内各臂用的 provider 不一致时，把这些轮剔除后重算一遍，与全量结果并列报告。
- **负结果**：全文披露，并给出归因（用 §7.1 第 3 条的拆分）。
- **禁止**：
  - 用字符数冒充 token；
  - 把 cacheRead 并入合计来夸大节省；
  - 只挑一部分任务来报告；
  - 看过数据之后再更换主指标。

---

## 9. 有效性威胁与控制

| 威胁 | 控制 |
|---|---|
| **答案泄露**（工作树中有评分要点） | 工作树与语料排除 `experiments/` 和 `docs/experiments/`；Q/R 的工作树本身不含答案；跑完审计转录（§5.4）。曾在 pilot 中发现泄露，已修复（§11 修订 4） |
| **编排者行为波动**（父会话的调用次数、是否亲自干活，每轮差异很大） | 四臂并发、按轮配对；报告父会话调用次数；用按 Agent 拆分做归因；单轮异常值只看配对统计，不单独解读 |
| **provider 波动与中途切换** | 同一轮的四臂在同一时间窗口；每条记录写明 provider；做混用 provider 的敏感性分析（§8） |
| **输出格式造成的伪差异**（ANSWER 行写成长句） | 收紧格式说明（§11 修订 12）；同时报告 Cover-EM |
| **环境缺失**（缺少依赖时，executor 去全盘搜索） | 提供 venv，并用 `--path-prepend` 放到 PATH 最前面（§11 修订 13） |
| **计量口径不一致**（synapse 模式召回的记忆没有计量；SYN0 没有账本） | EdgeBytes 四臂同口径；新增 `memory-redeem` 事件；SYN0 从 meta 文件取数（§11 修订 3、10） |
| **父会话 token 重复计算** | 改用父会话自己的 `message_end` 累加（§11 修订 8） |
| **judge 偏向同族模型** | judge 与被测模型不同族；R 组每个回答评 5 次取中位数 |
| **样本量小**（每组 10 轮） | 配对设计、bootstrap 区间、区间跨 0 时不下结论；Q、R 两组合并与分组各报一次 |
| **任务选择偏差**（公开题集的一个子簇） | 选题规则固定，写死 id，重建结果不变；局限写入报告（§13） |
| **自建题的"自证"** | 主实验只用公开 benchmark；G1/G2 只作演示 |

---

## 10. 已有结果

### 10.1 E2a causal-state：状态向量是否携带任务特定信息

- **装置**：
  - 语料：本仓库 HEAD（`5bb7a98`），用产品的 corpus builder 构建，窗口 40/8，共 4121 块。
  - 嵌入：bge-m3 / 1024。
  - 查询：G1/G2 的 20 个任务题面；金标准为各题的 anchors 文件。
  - 接收方：用产品的 `rankCorpusChunks` 排序。
- **结果**（主集 n=20）：

  | 接收方拿到的状态 | hit@1 | hit@5 | coverage@5 | MRR@10 | 线上字节 |
  |---|---|---|---|---|---|
  | **正确向量（float32）** | 0.60 | **0.85** | 0.51 | 0.72 | 4096 |
  | 相对上一题向量的 delta 残差（n=18） | 0.50 | 0.83 | 0.50 | 0.67 | **1863** |
  | 错配：另一组同序号题的向量 | 0.00 | **0.00** | 0.00 | 0.01 | 4096 |
  | 错配：同链相邻题的向量 | 0.20 | 0.40 | 0.16 | 0.28 | 4096 |
  | 随机高斯向量（20 个种子的均值） | 0.01 | 0.03 | 0.01 | 0.02 | 4096 |
  | 全零向量 | 被产品拒收（`integrity: left vector is all zeros`） | | | | |
  | 无状态，按题面做 BM25 | 0.20 | 0.35 | 0.14 | 0.28 | 389 |

- **正确向量相对各对照的 hit@5 差值**：
  - 相对另一组错配：+0.85 [0.70, 1.00]，McNemar p < 0.0001；
  - 相对随机向量：+0.82 [0.66, 0.97]；
  - 相对同链相邻错配：+0.45 [0.20, 0.70]，p = 0.012；
  - 相对 BM25：+0.50 [0.30, 0.70]，p = 0.002。
  - 副集（以 keypoint 作为查询，n=90）：正确向量 0.78，错配 0.08，BM25 0.49。
- **解读**：
  1. 同样是 4096 B，错配向量和随机向量的命中都接近 0。这说明向量携带的是任务特定的内容，而不只是"有一条消息"。
  2. 同链相邻题的错配向量仍有部分命中，说明关联任务链确实相关。这是记忆复用能起作用的前提。
  3. 接收方已持有基底时，只发残差就够了：平均 1863 B，比完整向量省 54.5%，hit@5 基本不变。
  4. 状态交接的线上字节是 5239 B（信封 1143 B 加向量 4096 B）；如果改为下发 top-5 证据原文，平均 11327 B。状态交接省 54%。
- **局限**：n=20 偏小；这里的 BM25 是脚本自带的简化实现，不代表产品的 text 档。

### 10.2 E2b transport：一次交接在各条路径上的代价

环境为 WSL2 6.6 + node v24。每条路径跑 2000 次，另加 200 次预热，全部直接调用产品模块。

| 路径 | 字节/次 | p50 µs | p95 µs | p99 µs |
|---|---|---|---|---|
| 信封，file 档 | 1143 | 73.5 | 160.5 | 394.9 |
| 信封，uds 档（产品：每封信新绑一个监听端） | 1147 | **10106.7** | 10814.0 | 13646.6 |
| uds 常驻监听（参照，非产品路径） | 1147 | 38.4 | 88.6 | 200.0 |
| 向量载荷，ext4 | 4096 | 28.7 | 39.9 | 79.3 |
| 向量载荷，tmpfs | 4096 | 18.8 | 42.0 | 57.7 |
| 文本交接（11327 B 证据原文，ext4） | 11327 | 81.8 | 133.4 | 203.5 |
| **状态交接 = file 信封 + 载荷** | 5239 | 102.2 | 200.5 | — |

- 所有本地路径都在 100 µs 量级，一轮 LLM 流水线要几分钟，传输时延可以忽略。协议的收益要看字节和 token，不看这里的微秒。
- uds 档每条消息多出约 10 ms，原因是每条消息都新绑定一个监听端，首次 connect 需要约 10 ms。这可能是 WSL2 特有的现象，要在 openEuler 真机上复测；如果真机上也一样，就应该改为每个子 Agent 一个常驻监听端，这属于产品改动。

### 10.3 P4-5：残差（delta）A/B —— 负结果（2026-09-20）

- **设计**：两臂只差开关 `synapse.delta`。S2 臂发完整 float32 向量；R1 臂发残差，接收方按 baseMemoryId 从自己的记忆库中重建基底。n=30 配对，在任何数据产生之前预登记。
- **结果**：
  - 线上载荷：R1 1866 B，S2 4096 B，**省 54.4%**，区间不跨 0。压缩本身是成立的。
  - 全账（冷基底）：R1 为 56,842 B/轮，S2 为 5,771 B/轮，**是 S2 的 9.85 倍**，区间 [51,043, 51,097] 不跨 0。多出的开销全部来自基底读取：发送侧选基底时要读 12 条记忆记录的向量，每轮 49,152 B；接收侧重建基底每轮 4,096 B。
  - 热基底（推导值，不是实测）：净省 37.7%。
  - 检索一致性：有序 top-5 为 3/30，top-1 为 23/30。
- **结论**：按预登记的判定规则为**净亏**。所以生产路径默认关闭 `synapse.delta`，参赛主实现使用完整 float32 向量；残差编码标为"已实现，待扩样"。它成立的条件是基底常驻、可以被反复复用，而现在"每轮一个进程"的装置无法摊薄这部分成本。
- **全账口径规则**：谁花的字节记在谁的账上，由事件自带的 `purpose`、`restore`、`hop` 字段决定，不靠上下文推断。实现在 `metering.ts` 的 `FullAccount`。

### 10.4 delta 参数标定（2026-09-19）

- **判据**：检索一致性（恢复向量的 top-k 与真实向量的 top-k 相同），不是余弦阈值。
- **选定参数**：grid = 127，threshold = 0.99，int8 / stride 3（`src/synapse/delta-params.ts`）。
- **数据**：预留轮次 progression / followup 各 240 轮，其中 followup 扩到 991 轮。
  - 在前 240 轮的子样本上，选定参数的有序一致性为 56.9%，top-1 为 97.9%。
  - 扩到 991 轮后，有序一致性降到 45.4%：前 240 轮是一个更容易的子总体。
  - 所以"更高档参数至多能好 6.84 个百分点"这个悬念，在可达的样本量内无法判定。
- **定位**："标定完成"只代表原型或代理验证，净收益没有证明，并被 §10.3 的全账结果否定。

### 10.5 P50：通信效率 A/B（早期，2026-09-21）

- **设计**：SYN 对 TXT，单轮单个 retriever 委派，30 题独立任务；另有 AutoGen / CrewAI 作跨系统参照。
- **数据**：已跑过，数据存放在仓库之外。当时的 SYN 臂记忆一直闲置：30 轮跑完，记忆库是 0 条。这直接催生了宿主侧自动蒸馏。
- **现状**：P50 的任务是单轮独立题，不满足"关联的连续任务"，已被 E1 取代。
- **P50M**：记忆复用三臂实验。预登记后一直没有执行，已废止，由 E3 取代。

### 10.6 优化前基线：`s5-main-20260925`（G1 前 7 轮，2026-09-25 暂停）

改造之前的设计（阶段之间全文转贴、召回记忆写进系统提示词、协议没有"结果"半边）下，按修正后的口径（§11 修订 8）计算的每轮均值：

| 臂 | 父会话 | 子会话 | **合计** | 下发给子会话的任务文本 |
|---|---|---|---|---|
| TXT（n=3） | — | — | 197k | 105.6 kB（n=2） |
| SYN（n=2） | 71.6k | 148.5k | 220k | 43.4 kB（不含写进系统提示词的召回记忆） |
| SYNCOLD（n=2） | 65.2k | 143.5k | 209k | 58.4 kB |
| SYN0（n=2） | 57.1k | 221.4k | 278k | 92.2 kB |

归因分析找到三个问题：`role-pipeline` 模板要求把上游全文逐级转贴；子会话的全文会回流给父会话；synapse 模式下召回的记忆写进系统提示词，没有计量。据此做了"阶段结果加句柄交接"的改造（spec `docs/superpowers/specs/2026-09-25-synapse-stage-result-handoff-design.md`）。这 7 轮只作为"改造前"参照，不与之后的数据合并。

### 10.7 改造后冒烟

**`smoke5-stage`**（G1 前 2 轮 × 4 臂，四臂并发，8/8 有效）：

- SYN 每轮交出 3 个结果块，没有回退，交给编排者的内容只有全文的约 21–25%。
- 按 Agent 拆分后的交接量：SYN 173k，TXT 542k，SYN0 515k。
- 交接占各自处理量的比例：SYN 16%，TXT 27%，SYN0 22%。
- 纯文本协作里，summarizer 约 62%、executor 约 48% 的处理量花在读交接上；SYN 降到 29% 和 23%。

**`smoke6-public`**（Q、R 各前 2 轮 × 4 臂，16/16 有效，共 17 次尝试）：

| 臂 | EdgeBytes | 其中：按需拉取 | Q 组总 token | R 组总 token | 交接占比 | Q 组 Cover-EM | R 组 SWE-QA 总分 |
|---|---|---|---|---|---|---|---|
| SYN0 | 86.3 KB | 0 | 111k | 126k | 25% | 1.00 | 81.5 |
| TXT | 137.9 KB | 4.2 KB | 214k | 202k | 29% | 1.00 | 78.5 |
| **SYN** | **56.9 KB** | 18.7 KB（5.8 次） | 192k | 135k | **17%** | 1.00 | 79.5 |
| SYNCOLD | 67.5 KB | 12.9 KB | 124k | 103k | 22% | 1.00 | 81.0 |

- **EdgeBytes**：SYN 比 SYN0 少 34%，95% 区间 [6.1k, 49.7k] 不跨 0；比 TXT 少 59%。
- **总 token**：SYN **没有**比 SYN0 省。
  - Q 组：主要是 Q r1 那一轮 SYN 的父会话花了 170k，一轮的波动就把均值拉高了。
  - R 组：基本持平。
  - 通信字节的减少，要在正式重跑的配对统计中才能看出能否转化为总 token 的减少。
- **Q 组的 EM/F1 这次不可用**：当时的 ANSWER 行常写成整句，已通过修订 12 收紧格式说明。
- **R 组**：五维评审能正常解析，各臂分数在 78.5–81.5 之间。
- **装置问题**：R r1 的 TXT 第 1 次尝试超时，原因是 executor 执行 `find / -name pytest`，扫遍了 WSL 挂载的 Windows 盘，用了 27 分钟。已通过修订 13 修复。

每组每臂只有 n=2，**只用于检查装置，不作结论**。

---

## 11. 口径修订记录

按时间排序。每条修订都发生在它所影响的数据产生之前；原始的逐条记录保存在 `experiments/legacy/records/`。

| # | 日期 | 修订 | 原因 |
|---|---|---|---|
| 1 | 09-19 | 预登记 P4-5（AC-17）判定规则，全账口径冻结 | delta 的净收益方向是结论性问题，判据必须先于数据定下来 |
| 2 | 09-24 | 冻结 S5 分析口径：judge、memhit、协议与记忆的归因 | 主跑开始之前 |
| 3 | 09-25 | **SYN0 重新定义为"SYNAPSE 全关"**，不再称"协议无记忆"；新增 SYNCOLD 臂，用来隔离跨轮记忆；SYN0 的子会话 token 改从 meta 文件取；它没有的机制记为 N/A | pilot 发现：memory off 时不签发契约，信封、状态、记忆、账本全部不存在 |
| 4 | 09-25 | 工作树与语料排除答案文件；SYN、SYNCOLD 配置语料库，状态面才真正发送 | pilot 发现：retriever 的 grep 命中了评分要点；SYN 的 `state.sent` 一直是 0 |
| 5 | 09-25 | 修复前台路径自动蒸馏拿到空文本的问题 | 冒烟发现 `distilled` 一直是 0 |
| 6 | 09-25 | 被测模型改为 `deepseek-v4.1-flash`；judge 改为 `glm-5.3-flashx` | 成本；judge 必须与被测模型不同族 |
| 7 | 09-25 | provider 回退（`--resume`、退出码 75、supervise.sh）；混用 provider 做敏感性分析 | commandcode 额度可能用尽 |
| 8 | 09-25 | **父会话 token 改用它自己的 `message_end` 累加**；此前的总 token 口径作废 | `get_session_stats` 已包含进程内子会话，子会话被算了两遍 |
| 9 | 09-25 | 协议加上"结果"半边：阶段结果块加句柄交接、回执 result、召回记忆只注入预览加句柄 | 归因发现全文转贴、全文回流才是通信开销的主要来源（§10.6） |
| 10 | 09-25 | 主指标改为 EdgeBytes 与总 API token；新增 `stage-result`、`memory-redeem` 事件；四臂并发；质量用 TOST 判非劣 | 产品自带的 `handoffBytes` 在不同模式之间不可比 |
| 11 | 09-25 | **任务族改为公开 benchmark**：Q（MuSiQue）、R（SWE-QA Flask）；G1/G2 降为补充演示 | 自建题说服力不足 |
| 12 | 09-25 | Q 组的格式说明收紧为"只写实体、数字或短语，不加解释" | 冒烟中答案内容都对，但 ANSWER 行写成整句，EM 被判错 |
| 13 | 09-25 | R 组提供 Flask venv，并用 `--path-prepend` 加入 PATH；实验文件统一移到 `experiments/`；本文取代分散的文档 | 冒烟中 executor 全盘搜索 pytest 导致超时；目录整理 |

---

## 12. 复现

```sh
# 1. 数据（写到 experiments/data/，不进 git）
experiments/bench/prepare-public-data.sh

# 2. 运行（Q、R 分开跑；同一轮的四臂并发；额度用尽时自动回退）
experiments/bench/supervise.sh s5-public-q-<日期> --groups Q --rounds 10 \
  --arms TXT,SYN,SYNCOLD,SYN0 --attempts 2 --parallel-arms \
  --worktree experiments/data/worktree --path-prepend experiments/data/venv/bin
experiments/bench/supervise.sh s5-public-r-<日期> --groups R --rounds 10 \
  --arms TXT,SYN,SYNCOLD,SYN0 --attempts 2 --parallel-arms \
  --worktree experiments/data/worktree --path-prepend experiments/data/venv/bin

# 3. 分析
node experiments/bench/aggregate.mjs $EXP
node experiments/analysis/edge-bytes.mjs $EXP
node experiments/analysis/agent-split.mjs $EXP
node experiments/analysis/score-public.mjs $EXP --votes 5
node experiments/analysis/memhit.mjs $EXP

# 离线状态面实验（不需要 LLM；causal-state 需要嵌入 key）
NODE_USE_ENV_PROXY=1 node --experimental-strip-types experiments/analysis/causal-state.mjs
node --experimental-strip-types experiments/analysis/transport.mjs
```

---

## 13. 局限与待办

**局限**：

- 每组 10 轮、两组合计 20 对，统计功效有限。
- 两个公开任务簇都各自围绕一个主题，结论外推到其他题材时需要谨慎。
- 只用了一个被测模型：结构化协议的收益与模型强弱有关，这是同类研究的已知结论。
- 编排者（父会话 LLM）的行为波动是 token 方差的主要来源。

**待办**：

1. 正式重跑 E1：Q、R 各 10 轮 × 4 臂。
2. 用 E1 数据产出 E3、E4 的统计。
3. 在 openEuler 24.03-LTS-SP3 真机上完成：transport 复测（uds 的 10 ms）、S1/S2/S3 验收、E5 内核账本对账。
4. 可选：换一个模型档位，复跑 SYN0 对 SYN。

**不做**：CodeAct 沙箱（按规划中表述）、ToM 显式建模、记忆巩固、A2A 协议映射。

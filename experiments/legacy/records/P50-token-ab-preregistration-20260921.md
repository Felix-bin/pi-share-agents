# P50（通信效率 A/B）判定规则预登记（2026-09-21）

> **性质**：本文件在 **P50 任何数据产生之前**冻结判定口径。依据：赛题通信效率 25 分原文＝
> "相比纯文本协作的 **token 节省效果**"＋M3 硬要求（纯文本模式 ⊕ 结构化模式，同条件可复现对比）。
> 方向文档：`synapse/docs/决赛冲刺-方向校准与对比实验筹备-20260921.md`（含 §七执行修正：
> v3 种子与任务答案重叠 ⇒ 两臂空记忆重跑，v3 只作 M8 基数）。
> **纪律**：出数后只填数，不改口径；改口径须另立修订并声明旧值作废。

---

## 1. 受试系统与臂（受控条件）

| 臂 | 配置 | 语义 |
|---|---|---|
| **SYN**（结构化） | `synapse.mode: "synapse"`、`memory: "project"`（**库为空**：无种子记录）、`delta` 键省略（默认关）、`stateVerify` 省略（off）、`vectorCache` 省略（off）、`SYNAPSE_STATE_BUDGET_MS=2500` | 状态面开：查询向量经 CAS 传递，接收侧对冻结语料排序后把 top-5 命中注入子会话上下文 |
| **TXT**（纯文本基线） | `synapse.mode: "text"`（memory 随 mode 默认 off，**不显式写键**），其余开关全部省略 | 状态面关：委派只有任务文本，子代理用自己的工具（read/grep/glob）自检索 |

**两臂唯一差异＝`synapse.mode` 一个键**（synapse vs text）。`mode:"text"` 是产品预留的 M3 基线
模式（`config.ts`：text mode 不积累记忆）。两臂的记忆状态均为"无内容"（SYN 空库、TXT 关闭），
召回注入两侧都不发生——**隔离的正是状态面（向量传递＋命中注入）的贡献**。

其余条件两臂一致并写入 manifest：任务族＝p45 冻结 30 条（`[output=false]` 同文本，family sha
`37d8609c…`）；模型 `paratera/DeepSeek-V4-Flash`；嵌入 `paratera/GLM-Embedding-3/1024`（仅 SYN 用）；
语料快照 `c4b1279d…`（仅 SYN 的状态面排序用；TXT 臂 store 同样带语料拷贝，保持存储位等）；
每轮一进程；retriever 角色；工作目录＝同一冻结工作树。

## 2. 主指标与并列指标（不得事后替换）

| # | 指标 | 来源 | 方向 |
|---|---|---|---|
| ① | **子会话总 token**（input+output 合计；cacheRead 单列不入合计） | `model-usage` 计量事件（与 API usage 同源） | 越小越好（主） |
| ② | Agent 间消息次数 | `message-delivered` 计数 | 越小越好 |
| ③ | 文本通信字符 | 委派面 `textBytes`；SYN 另列命中注入字节（转录测） | 越小越好 |
| ④ | 非文本状态传递次数与规模（SYN 独有，如实标注"TXT 无此机制"） | `state-send.payloadBytes`＋信封控制字节 | 展示项 |
| ⑤ | 单任务总耗时 | `task-span` start→end 的 monotonicMs 差 | 越小越好 |
| ⑥ | 任务成功率 | 判分（见 §3） | 越大越好 |

**为什么 ① 只算子会话**：本装置的父侧是宿主机器（无 LLM 对话），token 全部发生在子会话；
框架基线（P50-B）的编排若用 LLM，其 token 计入该系统总数（架构差异即被测差异，如实报告）。

## 3. 成功率判分（先冻结方法）

1. 每题**预期关键点**由代码库事实人工整理（不取自任何一臂的作答），每题 2–4 个可核验要点
   （文件/常量/行为），随本预登记附录在跑数前落盘（`grading-keypoints.json`）；
2. 判分器＝LLM judge（同 API 通道、固定提示词：给定题目与关键点，判断作答是否命中各点，
   逐点 0/1），作答文本取自子会话转录的**最后一条 assistant 消息**；
3. 每臂得分＝命中点数/总点数；抽样 10 份人工复核 judge 一致性，分歧率 >10% 时改全人工并缩样；
4. judge 调用与被测运行分离（事后离线批处理）。

## 4. 判定规则（预登记）

1. **方向主张**：①的配对差（TXT−SYN）点估计与 95% bootstrap 区间（B=10000，seed=20260921）
   一并报告；区间不跨 0 时可写"节省/多耗 X%（区间 …）"，**跨 0 时只写方向与区间，不得写
   "显著节省"**。
2. ②③⑤同法并列；⑥按臂报告成功率差与区间。
3. **本实验是测量性对比**（赛题要求"展示对比"），不设通过/失败门槛；任何方向的负结果
   （如 SYN token 更高）如实全文披露并给归因分析。
4. 禁止：不得以字符数冒充 token；不得把 cacheRead 并入合计夸大节省；不得挑选任务子集报告。

## 5. 装置与重试

- 装置＝`p50-runner.mjs`（自 p45-runner 派生：`seed` 只建命名空间＋语料拷贝、**不嵌任何记忆
  记录**；`run --arm SYN|TXT` 单臂单目录；TXT 轮有效性＝账本出现＋task-span end＋委派送达＋
  零 error 事件＋记忆零漂移（空库），**不要求任何状态事件**）；
- 重试：每轮最多 3 次尝试（同 p45 规则），全部尝试留证；
- 止损：连续 5 次 provider 失败或 403/额度类错误立即停手写报告。

## 6. 成本与产出

- 真实 API：2 臂 × 30 轮子会话（TXT 臂自检索预计多轮工具调用、token 高于 SYN——这正是被测
  差异）；judge ≈60 次小调用。已获用户全矩阵授权。
- 产出：`_state/p50-token-ab-20260921/{syn-n30, txt-n30}/`（manifest/rounds/evidence）＋聚合
  报告＋判分表；experiment-log 追加记录。

## 7. P50-B（框架基线）的原则性条款（细则在 harness 离线自测通过后另立附录冻结）

- 基线＝AutoGen（AG2）与 CrewAI 各一 harness：同一任务族 30 条、同模型同 API、任务文本原样
  投喂、不做提示词调优、系统全部 LLM token 计入（编排者若是 LLM 也计入）；
- token 一律从 **API usage 层**取（响应 usage 字段累加），不采信框架自报；配置全量披露；
- 与 SYN 的对比＝跨系统并列（非配对），按臂报告均值与范围；先 pilot n=3 自测通过再跑 n=10–15。

## 8. 未覆盖面

- 未覆盖 M7 式"连续任务记忆复用"（另立实验线）；未覆盖多子会话/多轮委派拓扑（本装置一轮一
  委派）；未覆盖 A2A（用户裁决暂不做）；判分器为 LLM（方法与一致性检查见 §3）。

## 9. 附录（跑数前）：TXT 臂无计量账本的发现与指标来源修正

pilot 装置验证（2026-09-21，2 轮 TXT 试跑）发现：**`synapse.mode=text` 下被测系统不落任何
`model-usage` 计量账本**（存储目录只有语料与命名空间，无 metering/）——账本写入只发生在
synapse 模式的状态通路。因此指标来源按臂修正如下（先于全量数据冻结）：

| 指标 | SYN 臂来源 | TXT 臂来源 |
|---|---|---|
| ① token（input/output/cacheRead/cost/turns） | `model-usage` 计量事件 | RPC 日志最终 `subagent-slash-result` 行内嵌 `Return:` JSON 的 `usage` 字段（与 API usage 同源，同为子会话口径） |
| ⑤ 耗时 | task-span start→end monotonicMs | **墙钟**（委派发出→`Workflow completed` 日志行出现）；SYN 臂同列墙钟，两臂同口径并列 |
| 作答文本 | 转录最后一条 assistant 消息（不变） | 同上（另存 evidence/answer.md） |

TXT 轮有效性随之修正为：`Workflow completed` 出现＋零 error 行＋记忆零漂移（空库）＋最终
usage 可解析；不再要求"账本出现/task-span end"（该两事件在 text 模式不存在）。SYN 臂有效性
规则不变（§5）。此修正只改**取数通道**，不改指标定义（①仍=子会话 input+output，cacheRead
单列不入合计）。

## 10. 附录（跑数前）：任务族 v4 更换——v3 族系 TS 移植口径，与受测代码树不符

**发现（2026-09-21 跑数前的语料落地审计）**：P4-5 任务族（p45-family.mjs，下称 v3）的预期
事实按 TypeScript 插件移植版书写（grid 127、stride 3、cosine 0.99、float32 信封、vectorCache
开关、inbox 布局等标识符）。而本实验子代理实际搜索与语料排序的对象是 **synapse 仓 master
3491b37**（语料快照 sourceCommit，与子代理工作树逐字节一致）——Python 实现：quant_grid 默认
64、verify_threshold 默认 0.97、stride 按索引宽自适应，且不存在上述 TS 标识符。P4-5 只测
字节，可答性无关紧要；P50 要以 LLM judge 评作答质量，沿用 v3 会把"如实报告 Python 事实的
正确作答"判错、并让两臂为不存在的标识符空耗检索轮次（噪声，非被测差异）。

**处置（先于任何全量数据）**：

1. P50 启用新任务族 **`experiments/legacy/p50-family.mjs`（v4，30 题）**：每题均对照 3491b37 真实代码
   落地，任务文本不预设任何实现名/常数值；配对的判分关键点
   **`experiments/legacy/records/p50-grading-keypoints.json`（95 点，含逐题文件锚点）**同刻冻结，
   §3 第 1 条所指文件即此件。
2. v3 族文件保留不动，仅供 P4-5 字节线溯源；**两族数字永不并列、永不混算**。
3. 此前的 SYN/TXT pilot（各 2 轮）定位为**装置工程验证**（验证行缓冲/解析/取数通道），
   不作为 P50 数据进入任何表格；全量数据只含本附录冻结后以 v4 族跑出的轮次。
4. 其余条款（§1 臂配置、§2 指标、§4 判定规则、§6 成本上限）不变。

## 11. 附录（P50-B 跑数前）：框架基线 harness 细则——离线自测通过后冻结

§7 的原则条款落地为以下装置（`experiments/legacy/p50b/`，uv + Python 3.12；mock 离线自测两臂各
2/2 VALID，自测目录 `_state/p50b-mocktest/` 仅验管线不进数据）：

1. **拓扑（诚实镜像）**：AutoGen（autogen-agentchat）＝ RoundRobinGroupChat[retriever(带工具),
   summarizer]，终止＝TERMINATE 提及或 30 消息；CrewAI ＝ sequential crew[retriever(带工具)
   → summarizer]，max_iter 12/4。两臂均为框架**原生纯文本交接**：无共享记忆、无非文本状态
   ——架构差异即被测差异，不做提示词调优（系统提示仅声明角色职责，不喂关键点、不教检索策略）。
2. **任务与工具**：同一 v4 族 30 题（p50-family.mjs 单一事实源，loader 校验 30 条）；
   工具与 P50 子代理同工作树（`p45-runs/work`）：`grep_worktree`（子串检索，40 命中上限）、
   `read_file`（行区间，12KB 上限）、`list_worktree`；路径逃逸即拒。
3. **token 口径**：AutoGen 取 `OpenAIChatCompletionClient.total_usage()`（客户端按 API 响应
   usage 聚合）；CrewAI 取 `CrewOutput.usage_metrics`（同样源自底层 LLM 响应）。两臂均在
   manifest 声明"API usage 层，非框架自报"；**usage 合计为 0 的轮判 invalid**（防静默漏计）。
4. **模型/通道**：同 P50——paratera `DeepSeek-V4-Flash`，temperature 0；密钥只经
   `PARATERA_API_KEY` 环境变量引用。
5. **有效性**：valid＝非空最终作答＋usage 非零＋无 harness 异常；失败轮如实记录 problems，
   不重试超 1 次的框架性失败（框架行为本身是被测对象）。
6. **节奏**：pilot n=3（pairs 1-3）两臂先跑，审 manifest/记录形态后再跑 n=10–15（pairs 1-15）；
   成本上限＝2 框架 × 15 轮 × 每轮 ≤30 LLM 调用。
7. **对比口径**：与 SYN/TXT 为**跨系统并列（非配对）**——按臂报告均值与极差，不做逐轮配对
   bootstrap；任何"省/费"表述只相对 P50 两臂的均值，并标注 n 差异（30 vs 15）。

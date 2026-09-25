# 阶段结果与句柄交接：让结构化协议真正替代全文转贴

- 日期：2026-09-25
- 状态：设计已逐节确认（2026-09-25 会话），待审阅 spec
- 相关：`docs/experiments/experiment-design.md`（原 S5 §6）；`prompts/role-pipeline.md`；`src/runs/shared/synapse-delegation.ts`；`src/synapse/{handoff,delegation,redemption,memory-service,roles}.ts`
- 时间盒：3 天，其中实现 ≤ 1.5 天，其余用于冒烟、正式重跑、评分和报告

## 1. 背景

### 1.1 问题

赛题"通信效率（25 分）"比的是相对纯文本协作的 token 节省。正式主跑 `s5-main-20260925` 的前 7 轮（已暂停）没有看到节省。

去掉一个计量 bug（§5.1）之后，每轮均值如下（n=2，只作方向参考）：

| 臂 | 父会话 token | 子会话 token | 合计 | 下发给子 Agent 的任务文本 |
|---|---|---|---|---|
| TXT（text 模式） | 46.8k | 158.5k | 205k | 105.6 kB |
| SYN（synapse 模式） | 71.6k | 148.5k | 220k | 43.4 kB |
| SYN0（SYNAPSE 全关） | 57.1k | 221.4k | 278k | 92.2 kB |

"任务文本"一列里 SYN 看起来少，这有一部分是口径造成的假象（§1.2 第 3 条）。

### 1.2 根因（代码核实）

1. **阶段之间交接的是自然语言全文。** 编排者（父会话 LLM）按照 `prompts/role-pipeline.md`，把 plan、evidence、results 原文贴进下游任务。它最常用 `workflowScript` 来做这件事：`runs.run(...).output` 被原样拼接进下一个阶段的任务。summarizer 的第一次调用就要读 15–23k token。
2. **子 Agent 的完整输出原样回流给父会话。** 前台路径交回的是完整的最终文本（`subagent-executor.ts:4156-4240`、`execution.ts:1572,1681`）；后台路径的 summary 是 `agent:\n` 加全文（`subagent-runner.ts:5027`）。每轮 44–92 kB 的回流内容，会在父会话之后的每一次调用里被重新读取。
3. **synapse 模式并没有真正少传。** 记忆正文按引用取回后，被追加进子 Agent 的**系统提示词**（`subagent-prompt-runtime.ts:981-983`，上限 8 KB）。模型照样读到全文，只是这部分离开了计量的通道：`handoffBytes` 只统计任务文本（`delegation.ts:382`）。
4. **协议里没有"结果"。** 信封只有请求半边：action、参数、能力、`memoryRefs`、`stateRef`（`envelope.ts:82-140`）。回执只保存一份截断到 2 KB 的摘要，`outputRef` 写死为 `null`（`delegation.ts:406-411`），而且只有控制台读它。
5. **固定开销。** synapse 模式给父会话多注册了 `synapse_read` 和 `synapse_write` 两个工具，每次请求多带约 3.6 KB 的定义。

对照 Python 原型可以看到：原型里的消息携带的是**句柄**，正文放在 CAS，下游"通过编号引用，避免把大内容重复塞进每条消息"。迁移到现在的版本时，阶段交接这一层丢掉了句柄。本设计把它补回来。

## 2. 目标与非目标

### 2.1 目标

- 在 synapse 模式下，Agent 之间传递的是**结构化结果加句柄**，而不是全文。
- text 模式和 off 模式的行为**逐字节不变**，保证纯文本基线（TXT、SYN0）原样可比。
- 补上协议的响应半边：回执带 `result`，`outputRef` 填入句柄。
- 计量口径在四个臂之间统一，并修正父会话 token 被重复计算的问题。

### 2.2 非目标

- 不改 text 模式的交接方式，不削弱基线。
- 不改 summarizer 等交付物角色的输出。
- 不做工具定义瘦身和编排约束（方案 C 中的那几项，时间有富余再另立任务）。
- 不引入配置开关。按 VISION 的硬切换原则，synapse 模式直接启用新行为，旧路径删除。

## 3. 设计

### 3.1 数据流

```
改前 synapse：子 → [全文] → 父 → [全文拼进任务] → 下游（每次调用都重读全文）
改后 synapse：子 → [全文存成记忆] ─句柄─┐
                  └→ [结果块 ≤1.5KB] → 父 → [结果块] → 下游 ─按需 synapse_read─┘
text / off：  与改前完全相同
```

只改一个接缝：子 Agent 完成时的 `closeChildDelegation`。自动蒸馏已经挂在这里，拿到的是子 Agent 的最终输出。单次调用的工具结果、chain 的 `{previous}`、workflow 的 `run.output` 都取自同一个"交给编排者的输出"，所以在这里做替换，三条路径同时生效。

### 3.2 新模块 `src/synapse/stage-result.ts`

模块只做三件事，不依赖运行时对象。

1. **`publishStageResult(input) → { memoryId, bytes }`**
   - 把完整输出发布成一条记忆记录：
     - `kind` 按角色映射：planner → `strategy`，retriever → `evidence`，executor → `tool-result`，映射定义在 `roles.ts`；
     - `assurance: "derived"`；
     - `tags: ["stage-output", <role>]`；
     - `summary` 取第一条 ESTABLISHED 行，没有就取第一行非空文本，最多 12 个词；
     - `taskTopic` 与自动蒸馏相同；
     - `provenance` 取自子 Agent 契约。
   - **不做向量嵌入。** 这类记录不参与召回（§3.5），所以发布只是一次本地写入，没有 embedding 调用。
2. **`renderStageResult(input) → string`**，生成交给编排者的结果块：
   ```
   [SYNAPSE result] agent=<role> status=completed handle=<memoryId> bytes=<全文字节数>
   ESTABLISHED:
   - …
   NOT ESTABLISHED:
   - …
   Full text: synapse_read {"action":"get","memoryId":"<memoryId>"}
   ```
   - 结论行的提取沿用 `distillMemoryLines` 的同一条冻结规则：优先取 ESTABLISHED / NOT ESTABLISHED 段，没有就退回取列表行。
   - 上限：最多 12 行，每行最多 200 字符，整块不超过 1536 B。
   - 全文本身不超过 1536 B 时：返回全文，末尾附一行 `handle=<memoryId>`，没有信息损失。
   - 既没有结论段也没有列表行时：取全文开头 1 KB，并注明"已截断，全文按句柄读取"。
3. **`stageResultApplies(role, options) → boolean`**
   - 只对流水线的中间角色生效：`planner`、`retriever`、`executor`。
   - 交付物角色（`summarizer`，在 `roles.ts` 里标记 `deliverable`）和所有非流水线 agent 一律不处理。
   - 子 Agent 带 `outputSchema` 时也不处理。

### 3.3 接入点

- `closeChildDelegation` 的返回类型从 `Promise<void>` 改为 `Promise<StageOutcome | null>`，其中 `StageOutcome = { memoryId, rendered, fullBytes, renderedBytes }`。只有在以下条件同时满足时才返回非 null：synapse 模式、正常完成（outcome=completed）、`stageResultApplies` 为真、发布成功。
- 前台路径（`src/runs/foreground/execution.ts`）：收到 `StageOutcome` 后，把交给编排者的输出（`result.finalOutput`，以及由它得到的展示输出）换成 `rendered`。完整全文仍然照常写入 `savedOutputPath` 等 artifacts。
- 后台路径（`src/runs/background/run-child-session.ts`，以及 runner 生成 summary 的位置）：做同样的替换，前后台保持一致。
- 自动蒸馏照常运行，与阶段结果互不影响：蒸馏写的是原子化的结论行，阶段结果写的是整段全文。

### 3.4 协议回执

- `Receipt` 新增 `result: { status, memoryId, bytes, established: string[] }`。
- `outputRef` 由 `null` 改为填入 `memoryId`。
- 回执 schema 版本加 1。这里是硬切换，旧版本的回执只供控制台读取，不做兼容。

请求（信封）加上响应（回执），合起来覆盖赛题要求的动作、参数、结果、能力四项。

### 3.5 记忆召回

- **取回渲染**（`src/synapse/redemption.ts`）：子 Agent 系统提示词里自动注入的每条记忆，从完整正文改为"`summary` + 正文前 300 B 预览 + 句柄"。总预算 8 KB 不变，实际预计只占 1–2 KB。
- **召回过滤**（`src/synapse/memory-service.ts`）：自动召回排除带 `stage-output` 标签的记录，召回的只是原子化的蒸馏结论。阶段全文只能通过句柄显式读取。

### 3.6 编排提示词

在 `prompts/role-pipeline.md` 已有的 synapse 模式说明旁边，加一条规则：

> 当共享记忆处于 `synapse` 模式时，中间阶段返回的是 `[SYNAPSE result]` 块。把这个块原样交给下一阶段；不要自己读取全文再粘贴。下一阶段需要细节时，会按块里的句柄读取。

text 模式读到的是同一份模板，但这条规则只对 synapse 模式生效，text 模式的行为不变。

## 4. 错误处理与回退

原则：出任何问题都退回到"交付原文"，即现有行为。每次回退都记入计量并写明原因，不静默降级。

| 情况 | 处理 |
|---|---|
| 子 Agent 失败、被取消或超时 | 不发布，返回原文 |
| 发布失败（store 报错，或超出 `SYNAPSE_DISTILL_BUDGET_MS`） | 返回原文，输出 warning，记一条 `stage-result` 事件，带上 `fallback: <原因>` |
| 全文为空 | 原样返回 |
| 全文不超过 1536 B | 返回全文，附句柄 |
| 没有结论段，也没有列表行 | 取全文开头 1 KB，注明已截断 |
| 带 `outputSchema` 的子 Agent | 不处理 |
| 下游按句柄读取失败 | `synapse_read` 返回明确错误；下游按角色约定写入 NOT ESTABLISHED，不凭空补全 |

- **访问权限：** 下游子 Agent 需要能读到同一命名空间里其他角色写入的阶段结果。实现时先核实 `receiverMayRead` 和 scope 在这种情况下是否放行；如果现有权限模型不允许，**停下来找 owner 裁决，不自行放宽**。
- **SYNCOLD：** 冷重置会连阶段结果一起移走，句柄只在本轮内有效，与"无跨轮记忆"的定义一致。

## 5. 计量

### 5.1 修正父会话 token 的重复计算（bench bug）

- runner 从 RPC 流中累加父会话自己的 `message_end`（role 为 assistant）usage，记为 `parentUsage`，包括调用次数。
- `get_session_stats` 只保留为原始记录，不再用于计算：它已经包含了在进程内运行的子 Agent，这是重复计算的来源。
- aggregate 的总 token = `parentUsage` + 子会话 token。旧记录没有 `parentUsage` 时，从 evidence 里的 `pi-rpc.log` 重新解析。
- 核验：TXT G1 r1 的 stats input 是 109,124，恰好等于父会话 25.9k 加子会话 83.2k。

### 5.2 统一口径的 EdgeBytes（离线计算，四个臂用同一个算法）

新脚本 `experiments/analysis/edge-bytes.mjs`，按轮统计 UTF-8 字节数和字符数：

- **下行（父 → 子）：** 子 Agent 收到的任务消息、注入的 user 消息（状态 steer），加上取回记忆时注入的字节数（`redeemedBytes`，见 §5.3）。
- **上行（子 → 父）：** 父会话收到的 subagent 工具结果，即 rpc 日志里的 `tool_execution_end`。workflowScript 的返回值也包含在内。
- **按需拉取：** 子 Agent 调用 `synapse_read get` 读回的内容，同样计入。

### 5.3 产品侧新增的计量字段（只增加，不改已有字段的语义）

- `stage-result` 事件：`{ memoryId, fullBytes, renderedBytes, fallback? }`。
- 取回记忆时记录实际注入系统提示词的字节数 `redeemedBytes`。这部分目前完全没有计量。

### 5.4 预先冻结的分析口径（在新数据产生前写入 S5 §6.8）

- **主指标：**
  - EdgeBytes；
  - 总 API token：修正后的父会话 token 加子会话 token，按 input+output 计，cacheRead 单独列出。
- **主对比：** SYN0 → SYN（相对纯文本协作）；TXT → SYN 作为分解。
- **质量门槛：** judge 得分做 TOST 非劣检验，δ = 0.05。质量不达标时，省下的 token 不作为节省的证据。
- **统计方法：** 配对 bootstrap，B = 10000，seed 20260921。区间跨 0 时只报告方向，不写"显著"。
- **旧数据：** 改前的 7 轮正式数据只作"优化前"参照，单独报告，不与新数据合并。
- **结果披露：** 不论正负，全文披露。

## 6. 测试

### 6.1 单元测试

- `renderStageResult`：
  - ESTABLISHED / NOT ESTABLISHED 的提取；
  - 12 行、200 字符、1536 B 三个上限；
  - 小输出原样返回并附句柄；
  - 无结构时截取开头 1 KB；
  - 交付物角色和非流水线角色不被处理。
- `publishStageResult`：
  - kind 按角色映射；
  - 带 `stage-output` 标签，不做向量嵌入；
  - 用 `synapse_read get` 能读回全文。
- 回执的 `result` 与 `outputRef`。
- 取回渲染：只输出 summary、预览和句柄，不超预算；召回会排除 `stage-output`。

### 6.2 集成测试（`runSync` + mock pi，沿用 `test/integration/synapse-foreground-auto-distill.test.ts` 的装置）

- synapse 模式下的 retriever：编排者收到结果块；按句柄能读回全文；产生 `stage-result` 事件。
- **text 模式：交给编排者的输出与改前逐字节相同**（基线保护）。
- summarizer 返回全文；子 Agent 失败时返回原文。
- 后台路径与前台路径行为一致。
- 全量测试套件通过。已知的不稳定用例（`runner-http-dispatcher` 两个，在 HEAD 上就会失败；`supervisor-ask-registration` 的超时用例，在 HEAD 上时好时坏）单独列出，并附 HEAD 对照结果。

### 6.3 bench 装置

- runner 记录 `parentUsage`，aggregate 改用它；用旧的 7 轮数据重算，与手工核算的结果一致。
- `edge-bytes.mjs` 先在现有数据上跑一遍验证。
- runner 新增 `--parallel-arms`：同一轮的四个臂并发运行，都结束后再进入下一轮。配对仍按轮对齐，而且四个臂处在同一时间窗口，更能抵消 provider 波动。预计墙钟时间从约 11 小时降到约 3.5 小时。

## 7. 验收

### 7.1 冒烟（G1 前 2 轮 × 4 臂）

冒烟通过需要同时满足以下几条：

- SYN / SYNCOLD 中间阶段交给编排者的是结果块，每块不超过 1536 B；
- `stage-result` 事件没有回退；
- 状态面、自动蒸馏、冷重置仍然正常；
- 四个臂都有 EdgeBytes 的读数；
- 并发运行时没有触发限流导致的失败；
- TXT 的交接方式与改前一致；
- 人工抽看两轮 summarizer 的答案，没有出现明显的质量退化。

### 7.2 正式重跑

- 使用新的实验 ID，G1+G2 × 10 轮 × TXT / SYN / SYNCOLD / SYN0，每轮最多尝试 2 次，四臂并行。
- 模型 `deepseek-v4.1-flash`，provider 为 `commandcode`；额度耗尽时，通过 `--resume` 回退到 DeepSeek 官方通道，规则见 S5 §6.7。
- 跑完之后依次执行：aggregate、EdgeBytes、judge（`glm-5.3-flashx`，开启 self-check）、memhit、token 归因。结果按 §5.4 的口径报告。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 下游只拿到结论行，漏掉了细节，质量下降 | 按需按句柄读取全文；judge 做非劣检验；冒烟时人工抽查 |
| 下游频繁按句柄读全文，省下的量又被读取吃回去 | EdgeBytes 把拉取计入；如实报告拉取次数与字节 |
| 编排者不遵守"原样传结果块"，自己去取全文再粘贴 | 结果块本身就很小，即便转贴，代价也有上限；拉取计入 EdgeBytes；在报告里统计违规次数 |
| 访问权限不允许跨角色读取 | 实现时先核实，不行就停下来找 owner 裁决（§4） |
| 3 天时间不够 | 按以下顺序砍范围：`--parallel-arms` → 取回渲染 → 回执字段；结果块与接入点是不可砍的核心 |

# 外部框架对照臂：在 E1 中加入 CrewAI 与 AutoGen

- 日期：2026-09-25
- 状态：设计已逐节确认（2026-09-25 会话），待审阅 spec
- 相关：`docs/experiments/experiment-design.md`（E1，§3–§9、§11）；`experiments/bench/runner.mjs`、`supervise.sh`；`experiments/analysis/{edge-bytes,agent-split,score-public}.mjs`、`experiments/bench/aggregate.mjs`；`agents/{planner,retriever,executor,summarizer}.md`；旧 harness `experiments/legacy/p50b/`（仅作参考，未复用代码，已在清理中删除）

## 1. 背景

E1 目前的四个臂（SYN0 / TXT / SYN / SYNCOLD）都跑在 pi 上，纯文本基线 SYN0 是"不开 SYNAPSE 的 pi 多 Agent"。实验缺少与**其他多智能体框架**的对比，评委无法判断 SYNAPSE 的收益是相对 pi 自身，还是相对业界通行做法。

P50 时期留有 CrewAI 与 AutoGen 的 harness（`experiments/legacy/p50b/`），但不能直接用：

- 只有 2 个角色（retriever + summarizer），E1 是 4 个；
- 路径写死为 Windows 路径，任务来自已废弃的 P50 题族；
- 工具只有自写的 grep / read / list，没有 bash，executor 无法运行 Flask 的测试；
- 口径是"跨系统并列、不配对"，与 E1 的按轮配对不兼容。

## 2. 目标与非目标

### 2.1 目标

- 在 E1 中新增 **CREWAI** 与 **AUTOGEN** 两个臂，在 Q、R 两组上与 pi 四臂**同批并发、按（组，轮）配对**。
- 两个框架都以**各自的默认形态**运行：纯文本交接，不开记忆，编排与交接完全由框架决定。
- 外部臂的 token、EdgeBytes、按 Agent 拆分、质量、有效性，与 pi 四臂用**同一套定义**计算，能进入同一张对比表和同一组配对统计。

### 2.2 非目标

- 带记忆的外部臂（CrewAI `memory=True`、AutoGen Memory）：留作后续增量。
- 为了与 pi 同形而改用 CrewAI hierarchical、AutoGen SelectorGroupChat：已否决，理由见 §3。
- 调优外部框架的提示词或交接方式。
- `experiments/legacy/p50b/` 的去留：归入另一个任务（清理废弃的实验结果和数据）；该任务已将其与 P50 脚本一并删除。

## 3. 已确认的决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 外部臂只比较默认的文本协作，不开框架自带记忆 | 先把"相对主流框架的默认用法"这一基准做扎实；与 SYN0 → SYN 同性质 |
| D2 | 编排方式采用各框架跑固定流水线的惯用写法：CrewAI `Process.sequential`，AutoGen `RoundRobinGroupChat` | 比较对象是"这个框架的使用者会怎么写"。pi 多一个编排者 LLM，这一架构差异本身就是被测对象，由按 Agent 拆分归因 |
| D3 | `role-pipeline.md` 是本项目自己的编排机制，**不施加给外部框架**。任务如何分配、下游能看到什么、交接什么，一律用框架默认行为 | 用户裁决：框架应该怎么执行就怎么执行 |
| D4 | 集成方式：runner 新增外部臂，每次尝试配一个本地记录代理 | 与 pi 四臂同批并发、同一 provider 窗口，从而能配对；resume、provider 回退、manifest、有效性规则全部复用；token 取自 API 层，与框架无关 |

## 4. 控制变量与自由变量

**与 pi 四臂相同（控制变量）**

- 同一个模型（DeepSeek-V4.1-Flash）。provider **不同**：外部臂不基于 pi，不读 pi 的 provider 配置，固定走 DeepSeek 官方接口（§5.4）；pi 四臂主用 commandcode，额度耗尽后回退到 DeepSeek 官方。
- 同样 4 个 agent，角色定义取自 `agents/<角色>.md`（按 §6.1 去掉 pi 专有段）。
- 工具能力相同（§6.3），推理强度相同（§6.4）。
- 任务原文原样投喂；工作树内容逐字节一致；PATH 前置同一个 Flask venv。
- 单轮超时 30 分钟，每轮最多 2 次尝试，同一轮的所有臂并发。

**由框架决定（自由变量，照实记录）**

- 任务分配、上下文传递、交接内容、agent 之间的消息可见性。

## 5. 架构

### 5.1 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| `external-arm.mjs` | `experiments/bench/` | runner 调用的外部臂模块：准备工作树副本，启动代理，拉起 Python harness，收集产物，判定有效性，产出 record。runner 只保留调度入口 |
| `llm-proxy.mjs` | `experiments/bench/` | 本地 OpenAI 兼容记录代理（Node http），每次尝试一个实例，监听 `127.0.0.1` 随机端口。把 `/<角色>/v1/chat/completions` 透明转发到真实 provider 的 `/chat/completions`（流式与非流式都支持），逐条写 `llm-calls.jsonl` |
| `tool-server.mjs` | `experiments/bench/` | 本地工具服务，每次尝试一个实例。直接加载 runner 所用 pi 安装中的 `create*ToolDefinition`（cwd = 该臂工作树），提供 `GET /tools`（schema 与描述）和 `POST /tools/<名称>`（执行，返回 pi 工具的原样文本输出） |
| `external/common.py` | `experiments/bench/external/` | 两个框架共用：读取 round-spec、加载角色提示词、按 `/tools` 的 schema 生成框架工具（调用转发给 tool-server）、`handoffs.jsonl` 与 `answer.md` 的写入 |
| `external/run_crewai.py`、`external/run_autogen.py` | 同上 | 各自按框架惯用写法搭 4 角色流水线，跑一轮后退出 |
| `external/requirements.lock` | 同上 | 钉死 `crewai`、`autogen-agentchat`、`autogen-ext` 及其全部传递依赖的版本 |
| frameworks-venv | `experiments/data/frameworks-venv/`（不进 git） | 由 `prepare-public-data.sh` 按 lock 文件建立；本机 Python 3.11，两个框架都支持 |

### 5.2 一次尝试的数据流

```
runner（与 pi 四臂同批，Promise.allSettled）
  └─ external-arm
       ├─ 复制工作树 → work-<臂>/（与 pi 臂同样排除答案文件）
       ├─ 启动 llm-proxy：上游 = DeepSeek 官方接口（§5.4），key 由代理持有
       ├─ 启动 tool-server：cwd = work-<臂>/，PATH 前置 Flask venv
       ├─ 写 round-spec.json：任务原文、角色提示词、各角色工具集、模型 id、代理与工具服务端口
       ├─ spawn frameworks-venv/bin/python external/run_<框架>.py <round-spec.json>
       │     cwd = work-<臂>/，PATH 前置 Flask venv
       │     每个角色一个客户端，base_url = http://127.0.0.1:<端口>/<角色>/v1，api_key = 假 key
       └─ 收集到 evidence/<臂>/<组>/round-NN/attempt-K/：
            answer.md · handoffs.jsonl · llm-calls.jsonl · harness.log · round-spec.json
          → rounds.jsonl 追加一行（与 pi 臂同一 schema，外部臂专有字段放进 external:{…}）
```

### 5.3 密钥

- 真 key 只存在于代理进程里，由代理在转发时注入。Python 进程拿到的是假 key。
- 框架如果绕过代理直连 provider，会因鉴权失败而报错，不会出现静默漏计。
- `llm-calls.jsonl`、`harness.log`、`round-spec.json` 都不含真 key，测试钉住这一点。

### 5.4 provider（外部臂自有配置）

- 外部臂不基于 pi，**不从 pi 取 provider**（用户裁决，2026-09-25）。固定配置在 `external-arm.mjs` 的 `EXTERNAL_PROVIDER`：OpenAI 兼容接口 `https://api.deepseek.com`，模型 id `deepseek-flash`（接口 `/models` 返回的名称为 DeepSeek-V4.1-Flash）。
- key 来自环境变量 `EXTERNAL_LLM_API_KEY`，没有时读 git 忽略的 `experiments/data/external.env`（权限 0600）；不进仓库、不进 manifest、不进任何日志。runner 在开跑与续跑前检查 key，缺失即拒绝启动。
- 与 pi 臂的 provider 相互独立：pi 四臂主用 commandcode（`deepseek/deepseek-v4.1-flash`），额度耗尽后 supervise 回退到 DeepSeek 官方；外部臂始终是 DeepSeek 官方。因此回退之前，同一轮内 pi 臂与外部臂的网关不同，模型相同。每条记录写明实际 provider，由 experiment-design §8 的混用 provider 敏感性分析覆盖。
- 外部臂的上游返回额度或鉴权类错误（沿用 runner 的 `PROVIDER_EXHAUSTED` 正则）时，这次尝试判无效，并以普通错误**终止实验（退出码 1）**，而不是退出码 75：supervise 的回退只切换 pi 臂的 provider，帮不了外部臂。

### 5.5 manifest

- `arms[]` 中的外部臂条目记录：框架名与版本、`requirements.lock` 的 sha256、harness 脚本与 `common.py` 的 sha256、框架参数（§6.2）、工具集定义的 sha256。
- 记忆库、语料库、agentDir 对外部臂不适用，记为 N/A。
- `--resume` 时逐项核对上述 sha256，任何一项变化即拒绝续跑（与 pi 臂的配置核对同理）。

## 6. harness 内部

### 6.1 角色提示词

读取 `agents/<角色>.md` 的正文（去掉 frontmatter），机械地删掉两处：

1. 以 `Shared memory, when it is enabled` 开头的整段，到下一个空行为止；
2. 提到 `contact_supervisor` 的列表条目。

其余逐字保留。删除规则写在 `common.py`，一个测试钉住四个角色的输出。删除后的提示词写进 `round-spec.json` 留作证据。

### 6.2 编排：框架默认

**CrewAI**：`Process.sequential`，一个 agent 对应一个 Task，顺序为 planner → retriever → executor → summarizer。

- Agent：`role` = 角色名，`goal` = frontmatter 的 `description`，`backstory` = §6.1 处理后的正文。
- Task：`description` = 本轮任务原文；`expected_output` = 该角色 frontmatter 的 `description`（CrewAI 的必填字段，只取角色自带的一句话）。
- **不设 `context=`**，上游输出如何传给下游由 CrewAI 默认决定。
- `max_iter` 取默认值 25；不开 memory、planning；关闭遥测与交互提示（`CREWAI_TELEMETRY_OPT_OUT`、`OTEL_SDK_DISABLED`）。

**AutoGen**：`RoundRobinGroupChat`，参与者顺序为 planner → retriever → executor → summarizer，任务原文作为组内第一条消息。

- 每个 `AssistantAgent`：`system_message` = §6.1 处理后的提示词，`tools` = 该角色的工具集，`max_tool_iterations=25`，`reflect_on_tool_use=True`。默认的 `max_tool_iterations=1` 意味着调用一次工具就结束发言，跑不了多步检索。
- 终止条件：`MaxMessageTermination(5)`（任务加 4 个回复，不计 agent 内部事件）。
- 组内广播与消息可见性按框架默认。

以上只设循环上限这类必需参数，不干预交接内容。`temperature` 不设，与 pi 一致。

**实现时核对并写进附录 A**：CrewAI 在 sequential 下默认传给下游的是上一个任务的输出还是全部上游输出；AutoGen 的 agent 内部工具调用事件是否不广播给其他 agent；`MaxMessageTermination` 是否不计内部事件。核对结果只记录，不改变框架行为。

### 6.3 工具

6 个工具**直接使用 pi 自己的实现**，不做移植：`tool-server.mjs` 加载 runner 所用 pi 安装导出的 `createReadToolDefinition` 等 6 个工厂，名称、参数 schema、描述与输出都与 pi 逐字节相同。bash 工具需要的 `ctx.sessionManager` 由一个只提供 `getSessionId()` 的桩对象满足（返回本次尝试的标签）。

| 角色 | 工具 |
|---|---|
| planner、retriever、summarizer | read、grep、find、ls、write |
| executor | read、grep、find、ls、bash |

- 截断、ripgrep、bash 超时等行为因此与 pi 完全一致；bash 在工作树中执行，PATH 前置 Flask venv。
- 与 pi 一样不设沙箱。
- 工具结果以 pi 返回的文本原样交给框架；框架如何把工具结果放进上下文，由框架决定。

### 6.4 推理强度

- planner、summarizer 为 high；retriever、executor 为 medium，与 `agents/*.md` 的 `thinking` 字段一致。
- **由代理按角色注入**：代理从路径前缀知道角色，按 pi-ai `openai-completions` 的 compat 逻辑补上 pi 在同一接口上会发出的字段，框架本身不做推理配置。外部臂的接口是 DeepSeek 官方，适用下面的 `deepseek` 一行。已从 pi-ai 源码核实（pi 0.87.0）：
  - `commandcode`（compat 为默认 openai 分支）：`reasoning_effort: <level>`；
  - `deepseek`（`thinkingFormat: "deepseek"`）：`thinking: {type: "enabled"}` 与 `reasoning_effort: <level>`；并且 `requiresReasoningContentOnAssistantMessages` 为真，即带工具调用的多轮请求须回传上一轮的 `reasoning_content`。框架通常会丢掉这个字段，代理按 tool_call id 缓存响应里的 `reasoning_content`，在后续请求的对应 assistant 消息上回填。
- 流式请求一律补 `stream_options.include_usage`（与 pi 相同），保证 usage 可得。
- DeepSeek 官方 `/models` 声明的推理档位为 `low/high/max`，没有 `medium`；pi 在 DeepSeek 上把 `medium` 原样发出（模型未配置 `thinkingLevelMap`），外部臂同样发 `medium`，接口是否接受由 pilot 验证，结果写进附录 C。

### 6.5 交接的被动观测

harness 不决定交接什么，只截获框架实际发生的交付，写入 `handoffs.jsonl`，每行一条：

```json
{"from": "planner", "to": "retriever", "kind": "task|context|broadcast", "bytes": 1234, "text": "…"}
```

- 任务文本送达某个 agent：`from = "user"`，`kind = "task"`。
- CrewAI：通过事件总线或 task callback，取每个 Task 实际渲染进 prompt 的 context 字符串，`kind = "context"`。
- AutoGen：从 `run_stream` 的消息流取每条最终回复，按收件人各记一条，`kind = "broadcast"`。

### 6.6 答案

`answer.md` = summarizer 的最终输出：CrewAI 取 `CrewOutput.raw`；AutoGen 取 summarizer 最后一条 `TextMessage`。

## 7. 指标口径

### 7.1 总 API token

- 全部取自 `llm-calls.jsonl`，按调用逐条累加响应中的 usage，不采用框架自报。
- usage 映射与 pi 对 `openai-completions` 类 provider 的映射完全相同（实现时读 pi 源码核对）：input = prompt_tokens − cached_tokens，cacheRead = cached_tokens（单列，不并入合计），output = completion_tokens（含推理 token）。
- 按角色归属：取自请求路径前缀 `/<角色>/v1`。不带合法前缀的调用记为 `unattributed`，**照样计入总 token**。
- 父会话 token 记为 N/A（没有编排者 LLM）。合计 = 4 个角色 + unattributed。
- cacheRead 依次取 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`（DeepSeek）、`cached_tokens`；cacheWrite 取 `prompt_tokens_details.cache_write_tokens`；input = prompt_tokens − cacheRead − cacheWrite（与 pi-ai `parseChunkUsage` 相同）。
- 流式响应的 usage：代理请求上游时要求返回 usage（`stream_options.include_usage`）；若上游仍未返回，该调用记 `usage: "unavailable"`，这一轮的总 token 即为 unavailable，不补 0。

### 7.2 EdgeBytes

统一定义：**每个干活 agent 的上下文里从外部送进来的内容，加上编排者收到的 worker 结果**。pi 四臂按此定义重新表述，算法不变。

| 分量 | pi 臂（现状不变） | 外部臂 |
|---|---|---|
| 下行 | 父会话写给子会话的任务消息、注入的消息、召回的记忆 | `handoffs.jsonl` 中送达每个 agent 的全部内容（任务文本，以及 context 或广播），按收件人各计一次 |
| 上行 | 子会话结果回到父会话 | 0（没有编排者；最终答案交给用户，不是 agent 之间的边） |
| 按需拉取 | `synapse_read` 的结果 | 0（没有句柄机制） |

两边都按**送达次数**计，不按 LLM 调用次数。内容在上下文里被反复读取的代价由 §7.3 体现。

### 7.3 按 Agent 拆分

- 从 `llm-calls.jsonl` 按角色取每次调用的 prompt 与 output。
- 交接部分 = 送达该 agent 的内容（§7.2 下行）× 它此后的调用次数，加上它自己的最终输出；其余为自己干活。
- 沿用 3.26 字节/token 的换算比（模型相同）。外部臂没有 parent 行。

### 7.4 质量

`score-public.mjs` 按现有路径读 `answer.md`，Q 组 EM/F1/Cover-EM、R 组 SWE-QA 五维评审，规则不变。

### 7.5 有效性

有效 = 进程正常退出 + 答案非空 + 4 个角色都至少有一次 LLM 调用 + 总 usage 大于 0。超时、框架异常、跳过角色都判为无效，写明原因，照常最多重试一次。

### 7.6 N/A 项

记忆、状态、信封、结果块等 SYNAPSE 机制的指标，外部臂记为 N/A（该臂没有这些机制），不记 0，也不记"不可用"。

### 7.7 对比与统计

| 对比（A → B） | 用途 |
|---|---|
| **CREWAI → SYN**、**AUTOGEN → SYN** | 主对比：SYNAPSE 相对主流框架的默认协作 |
| CREWAI → SYN0、AUTOGEN → SYN0 | 辅助：不开 SYNAPSE 的 pi 与主流框架的差距 |

统计规则沿用 experiment-design §8：配对 bootstrap（B = 10000，seed 20260921）；SYN 相对外部臂的质量用 TOST 判非劣，δ 不变（Q 组 F1 0.05，R 组总分 5）；新增的 4 组对比与原有对比一起做 Holm 校正。

## 8. 错误处理

| 情况 | 处理 |
|---|---|
| provider 额度或鉴权错误 | 见 §5.4 |
| 超时（30 分钟） | 杀掉 Python 进程组与代理，保留已产生的调用日志，判无效，problems 写 `timeout` |
| 框架异常、跳过角色、答案为空 | 判无效，把原因和 `harness.log` 尾部写进 problems，照常重试。框架自身的失败也是被测对象，不做额外补救 |
| 代理自身出错（端口占用、上游网络错误） | 网络错误原样返回给框架，由框架自行处理，并在 `llm-calls.jsonl` 中记录；代理启动失败则判无效，写明原因 |
| runner 收到 SIGINT/SIGTERM | 与 pi 子进程一样纳入 `LIVE_CHILDREN`，一起终止 |
| 并发 | 同一批 6 个臂；每个外部臂一个代理实例、一个端口、一个工作树副本，互不共享状态 |

## 9. 测试

放在 `experiments/bench/test/`（node --test）与 `experiments/bench/external/tests/`（Python 标准库 unittest），不进产品的 `test:all`。

1. **代理**：上游用本地 stub。流式与非流式都能原样透传；usage 映射正确；按路径前缀归属角色，缺前缀记 `unattributed`；上游返回 401/402 时标记 exhausted；假 key 被替换为真 key，真 key 不出现在任何日志中。
2. **harness 离线端到端**：stub 按剧本返回（含工具调用），两个框架各跑一轮。断言：4 个角色都被调用；`handoffs.jsonl` 如实记录框架的默认交接（同时完成 §6.2 所列的行为核对）；`answer.md` 取自 summarizer；工具调用真实落在工作树里。
3. **角色提示词**：§6.1 的删除规则对四个角色的输出与快照一致。
4. **工具服务**：`/tools` 返回的 schema 与 pi 工具定义一致；6 个工具各执行一次，输出与直接调用 pi 工具相同；bash 的 PATH 前置生效。
5. **分析脚本**：用人工构造的外部臂实验目录，验证 `edge-bytes`、`agent-split`、`aggregate`、`score-public` 能读外部臂，N/A 项不被当成 0，新增对比出现在报告中。

## 10. 上线步骤

1. 离线测试全部通过。
2. **pilot**：Q、R 各 1 轮，6 个臂，真实 provider。审查 manifest、`llm-calls.jsonl`、`handoffs.jsonl`、答案的形态；审一遍转录，确认没有读到答案文件或其他臂的产物；核对附录 C 的推理强度字段。
3. 正式重跑 E1：Q、R 各 10 轮，6 个臂同批配对。

## 11. 文档改动

- `docs/experiments/experiment-design.md`：
  - §1：通信效率一行加入"对照主流框架"；
  - §3、§4：新增 CREWAI、AUTOGEN 的定义、控制变量与对比关系；
  - §6：框架版本与依赖锁定；
  - §7：外部臂的指标口径（本 spec §7）；
  - §9：新增有效性威胁——架构差异（没有编排者、组内广播）、框架默认行为、代理注入的模型参数；
  - §11：**修订 14**，在外部臂的正式数据产生之前登记。
- `experiments/README.md`、`experiments/bench/README.md`：外部臂的用法与产物说明。

## 12. 有效性威胁（写入 experiment-design §9）

| 威胁 | 控制 |
|---|---|
| 架构不同构：pi 有编排者 LLM，外部框架是 agent 直接交接；AutoGen 组内广播让下游看到全部上游 | 这是被测差异本身，不去消除；用按 Agent 拆分归因 token 花在编排、交接还是干活上 |
| 工具实现不一致 | 直接调用 pi 自己的工具实现，不存在移植差异 |
| 框架默认行为未必最优 | 这正是"默认用法"对比的定义；不调优，附录 A 公开框架实际行为 |
| 框架绕过代理导致漏计 | 假 key，绕过即鉴权失败 |
| 推理强度字段不对等 | 代理按 pi 的 compat 逻辑注入（附录 C） |
| provider 不同：回退之前 pi 臂走 commandcode、外部臂走 DeepSeek 官方 | 同一模型；每条记录写明 provider；混用 provider 的轮次做剔除后的敏感性分析 |
| 代理修改请求（注入推理参数、回填 `reasoning_content`） | 只补 pi 本来就会发出的字段，不改消息内容；修改前后的请求都写进 `llm-calls.jsonl` |

## 附录

### 附录 A：框架默认行为（离线端到端测试核实，crewai 1.15.22 / autogen-agentchat 0.7.5）

| 行为 | 核实结果 | 依据 |
|---|---|---|
| CrewAI sequential 下，不设 `context=` 时下游收到什么 | **全部上游任务的输出**，拼接为一个 context 字符串（retriever 收到 planner 的；executor 收到 planner+retriever 的；summarizer 收到前三者的） | `crew.py` `_get_context`：同步任务传入累计的 `task_outputs`；`test/external-arm.test.mjs` 断言 |
| CrewAI 的 LLM 调用路径 | 1.x 直接用 OpenAI SDK（不经 litellm，环境中未安装 litellm），走 chat completions | `crewai/llms/providers/openai/completion.py` |
| AutoGen 组内广播 | 每个 agent 在自己发言前收到此前**所有** agent 的最终回复（planner→3 个下游，retriever→2 个，executor→1 个）以及任务原文 | 测试断言交接序列 |
| AutoGen agent 内部工具调用是否外传 | **不外传**：retriever 的第一次请求里没有 planner 的 tool 调用或 tool 结果 | 测试检查 retriever 首次请求的消息 |
| AutoGen `max_tool_iterations` 默认值 | 1（调用一次工具即结束发言），故设为 25 | `_assistant_agent.py` |
| retriever frontmatter `description` 含 "and shared memory" | 按 §6.1 的机械规则保留原文，作为 CrewAI 的 `goal`/`expected_output` 与 AutoGen 的 `description` | 如实记录，不另行改写 |

### 附录 C：推理与模型参数（依据 pi-ai 0.87.0 源码）

| 接口 | pi 发出的字段 | 外部臂经代理发出的字段 |
|---|---|---|
| DeepSeek 官方（外部臂所用） | `thinking: {type: "enabled"}`，`reasoning_effort: <角色档位>`，每条 assistant 消息带 `reasoning_content`（无则 `""`），流式时 `stream_options.include_usage` | 相同（代理注入；`reasoning_content` 按 tool_call id 或正文匹配回填） |
| commandcode（pi 臂主用） | `reasoning_effort: <角色档位>` | 不适用（外部臂不走 commandcode） |

usage 映射同 pi-ai `parseChunkUsage`（§7.1）。`medium` 档在 DeepSeek 官方的实际行为见 pilot 记录。

# pi-share-agents

> **本仓库是一个 fork。** `pi-share-agents` 派生自
> [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 的 `47bae7f7`
> （v0.67.0），上游为 MIT 许可，见 [LICENSE](./LICENSE)。
> 上游历史未一并保留：本仓库只有一个 `init` commit，其中同时包含上游代码树与本项目的新增内容，
> 新增范围见[本 fork 新增了什么](#本-fork-新增了什么)。

上游 `pi-subagents` 让 Pi 把工作委派给专注的子 Agent。本 fork 在此之上加入
**pi-agent-share**（代码与配置中称 `SYNAPSE`）：让这些 Agent 之间能够共享已经查明的事实，
而不是各自重新发现一遍。

具体而言，它提供一套**可核验的共享记忆**——内容寻址的正文、不可变记录、基于来源指纹的有效性、
授权投影——以及围绕它的若干契约：由宿主签发、携带冻结快照的信封，面向非文本状态交换的能力协商，
前台与后台共用的单一启动契约，以及只追加的逐项计量日志。

`synapse.mode` 默认为 `off`。关闭时不注册任何工具、不创建任何目录，因此**未经修改的上游行为**
既是产品默认值，也是受控对比实验可以直接对照的控制条件。

---

## 本 fork 新增了什么

| 路径 | 内容 |
|------|------|
| `src/synapse/**`（22 个模块，约 3.9k 行） | pi-agent-share 的全部实现，逐模块职责见[模块地图](#模块地图)。 |
| `src/runs/shared/synapse-delegation.ts` | 前台与后台共用的委派接缝调用点。 |
| `agents/{planner,retriever,executor,summarizer}.md`、`prompts/role-pipeline.md` | 四个协作角色与流水线快捷命令。 |
| `test/unit/synapse-*.test.ts`（21 个文件） | 锚定规范验收标准（AC）的行为测试。 |
| `test/integration/synapse-shared-memory.test.ts` | 跨 Agent 复用、来源失效、授权、存储完整性。 |
| `tsconfig.synapse-tests.json` | 对新增测试做类型检查——上游 `tsconfig.json` 的 `include` 只覆盖 `src/`。 |
| 7 个上游文件 | [接入点](#与上游的接入点)。除此之外未改动任何上游代码。 |

## 实现状态

按子系统如实列出，因为"已实现"与"已接入真实链路"不是一回事。

| 子系统 | 状态 |
|--------|------|
| 共享记忆：`synapse_read` / `synapse_write` | **已接入。** 在主会话与被委派的子 Agent 中均已注册。 |
| 来源有效性（按工作树字节计算指纹） | **已接入。** |
| 授权投影（项目授权 ∩ 子 Agent 授权） | 通过子 Agent 契约**已接入**。 |
| 启动契约、重建校验、前台/后台一致性 | **已接入。** 两条路径的输入由同一个函数导出。 |
| 四个协作角色与能力声明 | **已接入。** `planner` / `retriever` / `executor` / `summarizer` 各自声明动作与编码，能力 ID 进入启动契约与信封。 |
| 能力协商、信封与冻结快照、自动交接、计量、回执 | **已接入真实委派消息流。** 每次子 Agent 委派都先协商能力、召回记忆、冻结快照、生成信封，并把投递、模型用量、记忆复用与终态写入只追加计量日志。 |
| 非文本状态传递（向量/残差载荷） | **未实现。** 本版本没有任何工具能消费解码后的状态，因此协商结果诚实地落在文本路径，并记录落回原因，而不是把文本回退计为向量成功。 |
| 语义检索 / 嵌入 | **未实现。** 检索为确定性关键词 + 标签加权，语义分量显式报 `unavailable`；请求向量状态会以 `capability-unavailable` 失败，而不会悄悄退化为关键词检索。 |
| 残差（`delta`）编码 | **协议已预留，算法未实现。** `stateRef` 已携带 `encoding` 与 `baseMemoryId`，补上算法无需改协议版本。 |

完整的已知缺口见[下文](#已知缺口)。

## 快速开始

从一个 checkout 临时加载扩展（不做全局安装，也不写入 `~/.pi/agent/settings.json`）：

```bash
pi -e /path/to/pi-share-agents
```

共享记忆默认 `off`。开启后需要**新开一个会话**——工具是在扩展激活时注册的，因此模式变更永远不会
影响做出该变更的那个会话：

```text
/synapse-setup synapse
```

不带参数执行 `/synapse-setup` 会报告当前模式、存储位置、已有记忆条数，以及是否能看到嵌入密钥。
等价的手工修改位于 `<agent dir>/extensions/subagent/config.json`：

```json
{ "synapse": { "mode": "synapse" } }
```

之后照常用自然语言委派即可。子 Agent 发现值得保留的结论时写入记忆，后续的子 Agent 在重做之前先检索：

```text
Use scout to map the auth flow, then have worker implement the fix.
```

## 四个协作角色

赛题要求至少 3 个 Agent 覆盖规划 / 检索 / 执行 / 总结。本 fork 按 Python 版
SYNAPSE 的角色划分补齐了四个内置 Agent，与上游原有的 7 个内置 Agent **并存**：

| 角色 | 职责 | 声明的动作 | 工具 |
|------|------|-----------|------|
| `planner` | 把一个请求拆成 3–6 个可验收的步骤，并指名由哪个角色执行 | `delegate` | read, grep, find, ls, write |
| `retriever` | 从工作树与共享记忆中取证，区分"观察到的"与"推断的" | `delegate`、`retrieve` | read, grep, find, ls, write |
| `executor` | 运行步骤所需的命令并如实回报结果 | `delegate` | read, grep, find, ls, bash |
| `summarizer` | 把证据与结果综合为保留不确定性的结论 | `delegate` | read, grep, find, ls, write |

`/role-pipeline` 按 `planner → retriever → executor → summarizer` 顺序跑完整条流水线，
每个阶段是独立子会话，交接的是产物而不是对话。

角色不只是提示词：`src/synapse/roles.ts` 为每个角色声明能力（动作、编码、是否具备
消费状态的工具），委派前由 `capability.ts` 做交集协商，能力 ID 进入启动契约与信封。
本版本没有任何工具能消费解码后的状态，因此 `consumesState` 一律为 `false`，协商结果
是**带原因的文本路径**而不是伪造的向量路径；不被本模块认识的 Agent（含上游 7 个）
按纯文本 delegate 声明处理，而不是猜一个能力出来。

## 委派消息流

每次委派子 Agent（前台与后台同一条代码路径）都会经过 `src/synapse/delegation.ts` 的接缝：

1. **协商**：接收方角色声明 ∩ 主会话声明；接收方无可读范围时直接拒绝，此时这次委派
   与未安装本扩展完全一致。
2. **召回**：按子 Agent **自己的**授权范围检索共享记忆，`text` 模式携带正文、`synapse`
   模式只携带引用与摘要——同一批记忆、同一条链路，字节数可直接对比。
3. **冻结与信封**：把召回到的记忆 ID 冻结进快照，生成绑定请求 / 运行 / 双方会话身份的信封。
4. **计量**：`task-span` / `memory-query` / `memory-reuse` / `message-delivered`（文本字节 +
   信封字节）写入只追加日志 `<storageRoot>/metering/<runId>.jsonl`。
5. **回执**：子 Agent 结束后记录 `message-received`、必要时 `message-failed`（按固定错误类别
   分类，取消与超时各有其类）、`model-usage`（未上报即 `unavailable`，绝不记 0）与
   `task-span end`，并把回执写入 `<storageRoot>/receipts/<requestId>.json`。回执沿用运行自身
   的终态，不会把失败提升为完成。

预算只作用于注入的记忆段：预算再紧也只会整条丢弃记忆，绝不缩短用户的任务文本。
共享记忆是委派的**增量而非前提**——存储打不开时会打印一条警告并退回上游原有行为，
计量失败不会让用户损失这次运行。

## 两个工具

所有身份字段——哪个 Agent、在哪个会话、哪次运行、第几次尝试——一律由宿主提供。下面的参数表里
**没有任何位置可以填写身份**，这正是模型无法把记忆挂到别的 Agent 名下的原因。

**`synapse_read`**

| 动作 | 参数 | 返回 |
|------|------|------|
| `search` | `query`、`tags?`、`k?`（默认 5，最大 20）、`includeHistorical?` | 排序后的摘要，附 provenance、有效性、得分分量，以及 `semantic: "unavailable"`。 |
| `get` | `memoryId`、`offsetBytes?`、`limitBytes?`（≤ 16 KiB）、`allowHistorical?` | 经校验的一页正文，附 `nextOffsetBytes`。 |

**`synapse_write`**

| 动作 | 参数 | 返回 |
|------|------|------|
| `remember` | `content`、`summary`（≤ 2 KiB）、`topic`、`tags?`、`kind?`（`evidence` \| `tool-result` \| `conclusion` \| `strategy`）、`sourcePath?` | `memoryId`、`assurance`、捕获到的来源、当前有效性。 |
| `supersede` | `oldId`、`newId`、`reason?`（`source-changed` \| `superseded-by-newer-observation` \| `corrected`） | 记录下来的取代事件。 |

只要结论来自某个文件，就应给出 `sourcePath`：带来源的记忆会在该文件变化时自动失效，
**未提交的修改同样算数**。

## 配置

所有配置项都在扩展配置的 `synapse` 块下。未知键会被**拒绝**而不是忽略——被静默丢掉的键会让一次
运行的实际条件与它的清单对不上。

| 键 | 默认值 | 含义 |
|----|--------|------|
| `mode` | `off` | `off`（上游行为，不注册任何东西）/ `text`（基线：正文以文本携带）/ `synapse`（只带引用与摘要）。 |
| `memory` | 跟随 `mode` | `off` / `project`。`mode` 为 `off` 时必须为 `off`。 |
| `storageRoot` | `<agent dir>/synapse/<namespaceId>` | 绝对路径或 `~/...`。覆盖它是把一条实验序列的记忆与另一条隔开的方式。 |
| `contextBudgetBytes` | `8192` | 预算**只**作用于注入的记忆段。它可以裁掉召回的材料，但永远不会缩短用户任务及其关键约束。 |
| `maxObjectBytes` | `1048576` | 内容存储接受的单个正文上限。 |
| `stateRecovery` | `resend-then-text` | `resend` / `resend-then-text`。 |
| `embedding` | 未设置 | `{ provider, model, dim, endpoint, keyEnv }`。只接受 `siliconflow`；测试专用的 provider 名会被拒绝，以免一次运行声称做了语义检索、实际测的是哈希。 |

嵌入密钥**永远不属于**这份配置。它来自 `SILICONFLOW_API_KEY`（始终优先），或来自
`/synapse-setup key`——后者在对话框中询问，并以仅属主可读的方式存放在配置之外。把密钥作为命令参数
粘贴会被拒绝且不回显，因为会话转录恰恰是它最不该出现的地方。

**存储布局。** `namespaceId` 为 `sha256(规范化工作树路径)[:16]`；存储目录下保留 `namespace.json`
标记，使一个哈希目录可以被人追溯回它的工作树；属于其他工作树的存储会报 `namespace-mismatch`，
而不是被就地接管。

## 不变量

以下是测试要守住的性质，也正是让这些测量结果值得一读的原因。

- **失败不会变成成功。** 错误类别固定，且只映射到 `failed` 或 `cancelled`；无法识别的失败标为
  `unclassified`，不并入相邻类别。
- **缺报不是零。** 未上报 usage 的提供方记为 `unavailable`；只有在全部必需报告齐备时才计算 Token 节省。
- **不重复计数。** 接收方不增加发送侧计数；重复投递被识别为重复；重试是真实的第二次尝试；任务耗时
  按墙钟计，而不是子任务求和。
- **文本回退不是向量成功。** 协商结果在类型上区分 `state` / `text` / `refused`；而且"声明了编码"
  不等于"具备消费该编码的工具"。
- **语义分量绝不伪装。** 没有嵌入提供方就报 `unavailable`，不给近似值。
- **记录不可变，状态由事件导出。** 取代是独立事件，在加载时重放。同一祖先有两个后继时标为
  `conflict` 且两者都保留——不按时钟或相似度择一。
- **正文先于元数据落地。** 读者不会顺着引用读到空；事后发现的孤立记录会被报告，而不是跳过。
- **有效性不看 commit。** 指纹取自工作树中的实际字节，因此未提交的修改与提交一样会让证据失效。
- **记忆是数据，永不扩权。** 可见性是项目授权与子 Agent 自身授权的交集；没有变更类工具的子 Agent
  只获得只读记忆。仅仅 `mode=synapse` 不授予任何权限。
- **授权先于评分。** 检索把 scope 作为必填入参并在排序前过滤，越权摘要不会因某处遗漏过滤而泄漏。
- **记录无法自称"已验收"。** `assurance` 只有 `observation` 与 `derived`；写入记忆不等于该任务被接受，
  回执也不能把失败的任务提升为完成。
- **恢复不会扩权。** 权限收窄则拒绝续跑，权限放宽则仍按冻结时的范围执行。

## 模块地图

| 模块 | 职责 |
|------|------|
| `canonical-json.ts` | 所有摘要与 ID 背后的确定性编码；拒绝非有限数字。 |
| `content-store.ts` | 内容寻址的正文；同目录临时文件 rename 发布；每次读取重新校验摘要。 |
| `memory-store.ts` | 不可变记录与取代事件；状态由事件重放导出。 |
| `memory-service.ts` | 四个工具动作的宿主侧实现。 |
| `retrieval.ts` | 确定性关键词（0.6）+ 标签（0.4）排序，不含语料统计，因此历史运行的排序可复算。 |
| `source-fingerprint.ts` | 工作树字节指纹；捕获与校验都交还其所哈希的字节。 |
| `access.ts` | 授权投影；路径前缀按整段比较。 |
| `namespace.ts` | `namespaceId` 推导、存储标记、`storageRoot` 覆盖。 |
| `config.ts` | 以 schema 解析的配置边界；未知键拒绝。 |
| `credentials.ts` | 嵌入密钥的解析、指纹与仅属主存放。任何路径都不打印密钥。 |
| `register-tools.ts` | 注册 `synapse_read` / `synapse_write`；`mode=off` 不注册、不建目录。 |
| `setup-command.ts`、`setup-registration.ts` | `/synapse-setup`：状态、模式切换、密钥处理。 |
| `errors.ts` | 固定错误类别；无法识别的失败保持 `unclassified`。 |
| `metering.ts` | 只追加事件日志 + 可重算聚合。 |
| `capability.ts` | 动作 / 编码 / 表示 / 消费能力的协商。 |
| `envelope.ts` | 宿主信封、冻结快照、`stateRef`。 |
| `handoff.ts` | 预算内的上下文准备与紧凑回执。 |
| `lifecycle.ts` | 单一启动契约、重建校验、运行对账、重试上限。 |
| `child-contract.ts` | 被委派子 Agent 的存储、身份与授权。 |
| `roles.ts` | 四个协作角色及其能力声明；未知 Agent 按纯文本 delegate 处理。 |
| `delegation.ts` | 委派接缝：协商 → 召回 → 冻结 → 信封 → 计量 → 回执。 |

## 与上游的接入点

| 文件 | 改动 |
|------|------|
| `src/extension/index.ts` | 在 `registerWaitTool` 之后注册工具与 `/synapse-setup`。 |
| `src/shared/types.ts` | `ExtensionConfig` 增加 `synapse` 字段。 |
| `src/runs/shared/child-launch.ts` | 在唯一的子会话构造点解析子 Agent 契约。 |
| `src/runs/shared/child-runtime-config.ts` | 把 `synapse` 传递给子进程。 |
| `src/runs/shared/subagent-prompt-runtime.ts` | 在子进程内注册工具。 |
| `src/runs/foreground/execution.ts` | 前台委派在发送任务前后打开 / 关闭委派接缝。 |
| `src/runs/background/run-child-session.ts` | 后台委派在同一位置调用同一对函数。 |

前台与后台都经过 `buildInProcessChildLaunch` 这一个位置，因此两条路径的存储、命名空间与授权
**在结构上同源**——不依赖两份代码被人工保持一致。

## 测试与门禁

```bash
# pi-agent-share 单元测试
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/synapse-*.test.ts

# pi-agent-share 集成测试
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/synapse-*.test.ts

# 对 src 与新增测试做类型检查
npx tsc --noEmit -p tsconfig.synapse-tests.json

# 上游测试套件
npm run test:all && npm run typecheck
```

最近一次实测：2026-09-17，Node 24.11.1，Windows——**单元测试 336 通过 / 集成测试 15 通过 / 0 失败**，
类型检查通过；`oxlint` 携仓库的 `anti-slop` 插件对 `src/synapse/**`、`src/runs/shared/synapse-delegation.ts`
与 `test/**/synapse-*` 报告 **0 违规**。上游完整单元测试套件 3671 项中有约 20 项依赖环境的既有失败
（Windows 符号链接权限、外部进程超时等），在改动前后同样复现，逐批记录而不作静默吸收。

## 已知缺口

1. **没有非文本状态载荷。** 委派消息流已接入信封与计量，但本版本没有任何工具能消费解码后的
   状态，协商因此始终落在文本路径（并记录落回原因）。向量/残差载荷要等嵌入通道落地。
2. **无嵌入通道。** `synapse.embedding` 可配置，但尚未真正调用。
3. **委派的 `attempt` 恒为 1。** 一次通过接缝即一次投递；上游重试会新建子会话，日志中体现为
   第二次投递而不是同一次的重复。
4. **没有多进程并发写压测。** 目前的并发覆盖来自同 ID 发布冲突检测与发布顺序不变量。
5. **openEuler 24.03-LTS-SP3 未验证**（AC-15），记为明确的已知欠债。代码按严格 POSIX 路径纪律实现，
   但该平台本身未经实测。

---

## 上游能力：子 Agent 委派

以下全部来自上游 `pi-subagents`，未作改动且依然可用。Pi 是父会话，子 Agent 是一个有明确职责的
子 Pi 会话。前台子 Agent 在对话中流式呈现；后台子 Agent 运行在分离的 runner 进程中，可稍后查看。
安装扩展本身不会自动启动任何东西——它只是给 Pi 一个委派工具。

内置 Agent：`scout`（代码库侦察）、`researcher`（网页/文档调研）、`evidence-auditor`（核查重要结论
是否被其来源支持）、`worker`（实现）、`reviewer`（评审与小修）、`oracle`（第二意见，不编辑）、
`delegate`（轻量通用委派）。经验法则是 `clarify → scout → worker → fresh reviewers → worker`。

用自然语言提出要求即可——"use reviewer to review this diff"、"run reviewers for correctness,
tests and cleanup"、"run this in the background"、"show active async runs"。打包的快捷命令
`/council`、`/parallel-review`、`/review-loop` 让常见模式可复用，`/subagents-fleet` 打开对运行中
子 Agent 的实时检查器，`/subagents-doctor` 检查安装配置，`/subagents-guide [topic]` 提供与所装版本
一致的文档。

完整的上游参考文档位于 [`docs/`](./docs)：[agents](docs/agents.md)、[models](docs/models.md)、
[workflows](docs/workflows.md)、[watchdog](docs/watchdog.md)、
[tool reference](docs/tool-reference.md)、[observability](docs/observability.md)、
[missions and schedules](docs/missions.md)、[configuration](docs/configuration.md)、
[extension API](docs/extension-api.md)、
[standalone background execution](docs/standalone-background.md)。

## 许可证

上游与本 fork 同为 MIT，见 [LICENSE](./LICENSE)，其中保留了上游的著作权署名。

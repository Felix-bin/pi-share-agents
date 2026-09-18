# pi-share-agents

**让一个 Pi 会话委派多个子 Agent，并在任务之间复用可追溯、可校验的发现。**

`pi-share-agents` 基于 `pi-subagents`，新增共享记忆层 **pi-agent-share**（代码与配置中称为
`SYNAPSE`）。父会话负责协调和决策，子 Agent 负责有明确边界的工作；共享记忆保留结论的来源，
来源文件发生变化时，相关记忆会被标记失效，包括尚未提交的修改。

- **复用证据**：子 Agent 可检索和记录发现，宿主在委派时自动召回授权范围内的记忆。
- **控制上下文**：支持传递正文，或只传递引用与摘要；记忆预算不截断用户任务。
- **保留运行证据**：前台和后台共用启动契约，记录投递、用量与终态，失败不会记为成功。

共享记忆默认关闭，`/synapse-setup` 始终可用。当前检索采用关键词与标签，**尚不支持语义检索、
向量或残差状态传递**；使用现有共享记忆功能无需嵌入 API 密钥。

> 本仓库派生自 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 的
> `47bae7f7`（v0.67.0），未导入完整上游提交历史。项目边界见 [VISION.md](./VISION.md)，
> 上游与本 fork 均采用 [MIT 许可证](./LICENSE)。

[快速开始](#快速开始) · [运行模式](#运行模式) · [协作角色](#四个协作角色) ·
[实现状态](#实现状态) · [工具](#两个工具) · [配置](#配置) ·
[测试](#测试与门禁) · [已知缺口](#已知缺口) · [上游文档](#上游能力子-agent-委派)

## 快速开始

### 1. 安装扩展

前置条件：已配置模型、可正常启动的 Pi（安装流程在 0.85.1 上验证过），以及 `PATH` 中可用的
`npm`——Pi 安装 git 包时会自己执行 `npm install --omit=dev` 拉取运行时依赖。

```bash
pi install git:github.com/Felix-bin/pi-share-agents
```

Pi 会把仓库克隆到 `~/.pi/agent/git/github.com/Felix-bin/pi-share-agents`，安装运行时依赖，
并把这个源写入 `~/.pi/agent/settings.json`。`package.json` 中的 `pi` 清单声明了扩展、skills
与提示模板，因此 `/role-pipeline` 等快捷命令随安装一并注册，不需要再传 `--prompt-template`；
内置角色由扩展自行发现。安装完成后新开的 Pi 会话即可使用委派工具（`subagent`、`bg_wait`、
`subagent_supervisor`）；共享记忆工具需要先完成下一步。

| 场景 | 命令 |
|------|------|
| 只对当前项目安装（写入 `.pi/settings.json`） | `pi install -l git:github.com/Felix-bin/pi-share-agents` |
| 钉住某个 tag 或 commit | `pi install git:github.com/Felix-bin/pi-share-agents@<tag\|commit>` |
| 不落盘试用一次（临时目录，不改 settings） | `pi -e git:github.com/Felix-bin/pi-share-agents` |
| 卸载 | `pi remove git:github.com/Felix-bin/pi-share-agents` |

git 源的 ref 是钉住的：`pi update --extensions` 只把克隆对齐到已配置的 ref，不会自行升到更新的提交；
换版本用 `pi install ...@<新 ref>`。

**从源码开发时**，改用临时加载，不写入 `settings.json`：

```bash
npm ci --ignore-scripts
pi -e ./index.ts --prompt-template ./prompts
```

在其他项目目录里这样加载时，把两处相对路径换成本仓库的绝对路径。仓库自带的 `install.mjs`
（`npx pi-subagents`）是上游遗留的安装脚本，把仓库克隆到 `~/.pi/agent/extensions/subagent`；
它已指向本 fork，但推荐的安装方式仍是上面的 `pi install`——该目录一旦存在且不是本仓库的克隆
（例如只放了 `config.json`），脚本会拒绝写入并要求先手工清理。

### 2. 开启共享记忆

在 Pi 会话中执行：

```text
/synapse-setup synapse
```

随后**退出 Pi，重新启动一个新会话**（源码开发方式则重复上面的 `pi -e` 命令）。
工具在扩展激活时注册，修改模式不会改变当前会话的工具列表。
开启操作会更新 `<agent dir>/extensions/subagent/config.json`；`<agent dir>` 默认是 `~/.pi/agent`。

在新会话中查看状态：

```text
/synapse-setup
```

默认配置下应显示 `mode: synapse`、`memory: project` 和当前项目的存储位置。
`semantic: unavailable` 是当前版本的正常状态；若曾显式设置 `memory: off`，需按[配置](#配置)调整为 `project`。

### 3. 运行一次协作任务

```text
/role-pipeline 梳理本项目的测试入口，运行一个相关测试，并总结验证结果与尚未验证的部分。
```

也可以直接用自然语言委派：

```text
让 retriever 查找测试入口，将可复用的发现写入共享记忆并注明 sourcePath；
然后让 summarizer 先检索这些记忆，再总结测试覆盖范围与不确定之处。
```

工具调用中可检查 `synapse_write` 返回的 `memoryId`，以及后续 `synapse_read` 的检索结果。
带 `sourcePath` 的记忆会随来源字节变化失效；没有可用记忆时，子 Agent 仍可正常执行任务。

关闭共享记忆可执行 `/synapse-setup off`，同样需重启 Pi 生效；已有记忆保留在磁盘上。

## 运行模式

| `mode` | 默认 `memory` | 共享记忆行为 | 用途 |
|--------|---------------|--------------|------|
| `off` | `off` | 不注册共享记忆工具，不创建共享记忆存储。 | 使用原有委派能力。 |
| `text` | `off` | 默认不启用记忆；显式设置 `memory: "project"` 后，委派时携带召回记忆的正文。 | 文本基线与正文传递对比。 |
| `synapse` | `project` | 启用记忆，委派时携带引用与摘要，子 Agent 可按需读取正文。 | 跨 Agent、跨任务复用发现。 |

如需对比正文与引用两种传递方式，分别使用 `text` / `synapse`，并将两组的 `memory` 都设为
`project`，保持授权范围、任务与记忆数据一致。`synapse` 模式仍通过文本传递引用与摘要，
不代表启用了向量传输，也不预设 Token 节省比例。

## 本 fork 新增了什么

| 路径 | 内容 |
|------|------|
| [`src/synapse/`](./src/synapse) | pi-agent-share 的实现，逐模块职责见[模块地图](#模块地图)。 |
| `src/runs/shared/synapse-delegation.ts` | 前台与后台共用的委派接缝调用点。 |
| `agents/{planner,retriever,executor,summarizer}.md`、`prompts/role-pipeline.md` | 四个协作角色与流水线快捷命令。 |
| `test/unit/synapse-*.test.ts` | 锚定规范验收标准（AC）的行为测试。 |
| `test/integration/synapse-shared-memory.test.ts` | 跨 Agent 复用、来源失效、授权、存储完整性。 |
| `tsconfig.synapse-tests.json` | 对新增测试做类型检查——上游 `tsconfig.json` 的 `include` 只覆盖 `src/`。 |
| 委派与扩展生命周期文件 | 主要运行时改动见[接入点](#与上游的接入点)。 |

## 实现状态

以下区分已接入委派链路的能力与尚未实现的协议能力。共享记忆相关行为以 `mode` 和 `memory` 均开启为前提。

| 子系统 | 状态 |
|--------|------|
| 共享记忆：`synapse_read` / `synapse_write` | **已接入。** 在主会话与被委派的子 Agent 中均已注册。 |
| 来源有效性（按工作树字节计算指纹） | **已接入。** |
| 授权投影（项目授权 ∩ 子 Agent 授权） | 通过子 Agent 契约**已接入**。 |
| 启动契约、重建校验、前台/后台一致性 | **已接入。** 两条路径的输入由同一个函数导出。 |
| 四个协作角色与能力声明 | **已接入。** `planner` / `retriever` / `executor` / `summarizer` 各自声明动作与编码，能力 ID 进入启动契约与信封。 |
| 能力协商、信封与冻结快照、自动交接、计量、回执 | **已接入真实委派消息流。** 每次子 Agent 委派都先协商能力、召回记忆、冻结快照、生成信封，并把投递、模型用量、记忆复用与终态写入只追加计量日志。 |
| 非文本状态传递（向量载荷） | **已实现且已验证**（限 AC-04/05/11 集成测试范围；集成测试经本地 HTTP stub 提供合成向量，真实 provider 验证待实验批次）：retrieve 委派协商为 state 时，发送侧嵌入查询并把 float32 向量发布到 CAS，信封携带 `stateRef`，接收侧校验（sha-256/维度/表示）后对固定的 `corpusSnapshotId` 语料做余弦 top-k 检索；prepare/send/receive/consume 四类事件分开计量，信封字节与失败/拒绝也入日志，对象损坏按重传≤1、文本回退≤1 的有限恢复链处理。生产宿主的检索委派触发点尚未接线（模块级 API 已就绪）。 |
| 语义检索 / 嵌入 | **已实现且已验证**（单元与工具级测试范围）：配置 `synapse.embedding` 后记忆检索带语义余弦分量（冻结 0.3/0.2/0.5 权重），无嵌入配置时诚实报 `unavailable`；状态检索（`stateId`）走独立路径消费已验证的向量载荷。 |
| 残差（`delta`）编码 | **协议已预留，算法未实现。** `stateRef` 已携带 `encoding` 与 `baseMemoryId`，补上算法无需改协议版本。 |

完整的已知缺口见[下文](#已知缺口)。

## 四个协作角色

本 fork 新增四个内置角色，覆盖规划、取证、执行与总结，与上游角色并存：

| 角色 | 职责 | 声明的动作 | 主要工具 |
|------|------|-----------|------|
| `planner` | 把一个请求拆成 3–6 个可验收的步骤，并指名由哪个角色执行 | `delegate` | read, grep, find, ls, write |
| `retriever` | 从工作树与共享记忆中取证，区分"观察到的"与"推断的" | `delegate`、`retrieve` | read, grep, find, ls, write |
| `executor` | 运行步骤所需的命令并如实回报结果 | `delegate` | read, grep, find, ls, bash |
| `summarizer` | 把证据与结果综合为保留不确定性的结论 | `delegate` | read, grep, find, ls, write |

`/role-pipeline` 按 `planner → retriever → executor → summarizer` 顺序跑完整条流水线，
每个阶段是独立子会话，交接的是产物而不是对话。

四个角色均可通过 `contact_supervisor` 上报需要决策的问题。`executor` 按角色约定负责运行命令、
报告结果，不编辑源码；实现类任务可交给上游 `worker`。

角色不只是提示词：`src/synapse/roles.ts` 为每个角色声明能力（动作、编码、是否具备
消费状态的工具），委派前由 `capability.ts` 做交集协商，能力 ID 进入启动契约与信封。
本版本没有任何工具能消费解码后的状态，因此 `consumesState` 一律为 `false`，协商结果
是**带原因的文本路径**而不是伪造的向量路径；不被本模块认识的 Agent（含上游 7 个）
按纯文本 delegate 声明处理，而不是猜一个能力出来。

## 委派消息流

启用共享记忆后，委派子 Agent 的前台与后台路径都会调用 `src/synapse/delegation.ts`：

1. **协商**：接收方角色声明 ∩ 主会话声明；接收方无可读范围时拒绝共享记忆交接，
   子 Agent 的原有委派流程继续执行。
2. **召回**：按子 Agent **自己的**授权范围检索共享记忆，`text` 模式携带正文、`synapse`
   模式只携带引用与摘要。控制记忆数据与授权范围一致后，可以比较两种传递方式的字节数。
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

配置文件位于 `<agent dir>/extensions/subagent/config.json`。手工启用共享记忆时，将以下
`synapse` 块合并到现有配置，保留其他配置项，然后重启 Pi：

```json
{
  "synapse": {
    "mode": "synapse",
    "memory": "project",
    "contextBudgetBytes": 8192
  }
}
```

所有配置项都在扩展配置的 `synapse` 块下。未知键会被**拒绝**而不是忽略——被静默丢掉的键会让一次
运行的实际条件与它的清单对不上。

| 键 | 默认值 | 含义 |
|----|--------|------|
| `mode` | `off` | `off` / `text` / `synapse`，具体行为见[运行模式](#运行模式)。关闭时仍保留 `/synapse-setup` 命令。 |
| `memory` | `synapse` 下为 `project`，其他为 `off` | `off` / `project`。`mode` 为 `off` 时必须为 `off`；`text` 下启用记忆需显式设为 `project`。 |
| `storageRoot` | `<agent dir>/synapse/<namespaceId>` | 绝对路径或 `~/...`。覆盖它是把一条实验序列的记忆与另一条隔开的方式。 |
| `contextBudgetBytes` | `8192` | 预算**只**作用于注入的记忆段。它可以裁掉召回的材料，但永远不会缩短用户任务及其关键约束。 |
| `maxObjectBytes` | `1048576` | 内容存储接受的单个正文上限。 |
| `stateRecovery` | `resend-then-text` | `resend` / `resend-then-text`。 |
| `embedding` | 未设置 | `{ provider, model, dim, endpoint, keyEnv }`。只接受 `siliconflow`；当前仅解析配置，尚不调用嵌入服务。 |

嵌入密钥**永远不属于**这份配置。它来自 `SILICONFLOW_API_KEY`（始终优先），或来自
`/synapse-setup key`——后者在对话框中询问，并存放在配置之外；支持权限控制的文件系统会设置为仅属主可读，
无法强制执行时会明确提示。不要把密钥粘贴到命令参数中：即使命令拒绝处理且不回显，输入仍可能进入会话记录。
当前版本无需配置嵌入密钥。

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

# 完整测试套件（含本 fork 测试）与源码类型检查
npm run test:all
npm run typecheck
```

测试结果以当前提交的实际运行输出为准。[主测试流程](./.github/workflows/test.yml) 使用 Node.js 24，
覆盖 Ubuntu 与 Windows；Windows 的单元和集成测试使用 `--test-concurrency=2`。
复现失败时应保留平台、Node 版本、失败用例与日志，不能仅以“环境问题”认定通过。

## 已知缺口

1. **状态载荷的宿主触发点未接线。** 向量载荷的发送、消费、恢复链与计量已在模块层实现并经
   AC-04/05/11 集成测试验证（嵌入向量由本地 stub 提供），但上游宿主目前只发起文本 `delegate`，
   生产路径的 `retrieve` 触发属于实验阶段接线。
2. **状态平面的取消/超时语义未完整实现**（spec §8.2 第 5 行）。嵌入子步受客户端 30s 超时保护；
   委派级的取消信号、预算与"迟到结果不更新终态"机制尚未接入，随宿主触发点一并处理。
3. **委派的 `attempt` 恒为 1。** 一次通过接缝即一次投递；上游重试会新建子会话，日志中体现为
   第二次投递而不是同一次的重复。（状态恢复链内部的重传在计量中以新 attempt 单列。）
4. **没有多进程并发写压测。** 目前的并发覆盖来自同 ID 发布冲突检测与发布顺序不变量。
5. **openEuler 24.03-LTS-SP3 未验证**（AC-15），记为明确的已知欠债。代码按严格 POSIX 路径纪律实现，
   但该平台本身未经实测。

---

## 上游能力：子 Agent 委派

本 fork 保留上游 `pi-subagents` 的委派能力。Pi 是父会话，子 Agent 是一个有明确职责的
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

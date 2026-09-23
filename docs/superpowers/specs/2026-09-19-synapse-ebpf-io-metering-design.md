# SYNAPSE eBPF I/O 观测与归因（S3）设计

- 日期：2026-09-19
- 状态：设计已确认，待实现计划
- 目标平台：openEuler 24.03-LTS-SP3
- 相关：`src/synapse/metering.ts`、`src/synapse/envelope-inbox.ts`、`src/synapse/content-store.ts`

## 1. 背景

赛题要求"统计并展示 Agent 间消息次数、文本通信 token 或字符开销、非文本状态传递次数及数据规模、
单任务总耗时、共享记忆命中率及整体性能提升情况"，评分中"通信效率"占 25 分、"实验验证"占 15 分。

本仓库已有一套计量层 `src/synapse/metering.ts`：追加写的 NDJSON 事件日志加一个纯函数聚合器，
日志是主记录、聚合是派生的，因此一次跑完的实验可以离线重新计分。它记录的是**应用层自报**的量
（`envelopeBytes`、`textBytes`、`payloadBytes`）。

自报的量是自证。S3 的作用是从**内核侧独立测一遍同一批 I/O**，给应用层的数字一个外部对照物，
并回答应用层看不见的问题：一次委派到底触发了多少次 syscall、多少次重复读取、单次文件操作的
内核耗时分布是什么。

### 1.1 为什么现在做这个

S1（iSulad 容器化）与 S2（跨进程共享内存数据面）都会改变通信路径，并且都会声称"更省"。
没有先建立好的基线测量，那些声称只能是口径而不是实测——Python 原型 README 里"逻辑消息字节
降低 94.6%"标注的正是"进程内共享 CAS 口径"，并自认"真实跨进程传输字节将在数据平面实测"。
S3 先落地，S1/S2 的收益才有对照物。

S3 同时是三者中风险最低的一个：非侵入、不碰启动路径、不进热路径。

## 2. 范围

### 2.1 做

- 一个只在 openEuler 上、只在跑对照实验时**显式启动**的旁路采集器。
- 一个新的计量事件 `process-identity`，把操作系统进程身份绑定到 SYNAPSE 的运行身份。
- 一个确定性 joiner，把内核侧记录归因到 `{runId, nodeId, agent, attempt}`。
- 一个不改动现有聚合签名的汇总出口。

### 2.2 不做

- 不碰启动路径，不修改 `src/runs/background/async-execution.ts`。
- 不常驻、不默认开启、不进任务热路径。
- 不在产品代码里加平台分支。
- 不做通信图可视化。先把数字与归因做对。
- 不做 iSulad 容器化、不做共享内存、不做 Kmesh / Gazelle。那些属于 S1 / S2。
- **不填 `MeteringTotals.control.transportBytes`。** 理由见 §5.1。

## 3. 架构与组件

```text
  父会话                            子 Agent 进程                  synapse-trace
    │                                    │                        （独立进程，实验期手动启）
createDelegationDeps              createDelegationDeps                  │
    │                                    │                          eBPF 探针
    ├─ process-identity ──┐        ┌─── process-identity ─┤              │
    │  {pid, startTicks,  │        │    {pid, ...}        │              │
    │   uptimeAtRecord}   │        │                      │              │
    ▼                     ▼        ▼                      ▼              ▼
  ┌────────────────────────────────────────────┐   ┌──────────────────────────┐
  │  <storageRoot>/metering/<runId>.jsonl      │   │ <storageRoot>/trace/     │
  │  （已有，父子进程并发 append）                │   │    <runId>.ndjson        │
  └────────────────────┬───────────────────────┘   └───────────┬──────────────┘
                       │                                       │
                       └──────────────┬────────────────────────┘
                                      ▼
                              joiner（纯函数）
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                   I/O 归因结果                 归因诊断
              （或 "unavailable"）      unattributedBytes / lostEvents
```

### 3.1 采集器 `synapse-trace`

独立进程，**不属于 Pi 的进程树**，崩溃不影响任何一次运行。

挂载点：`sys_enter_write` / `sys_exit_write`、`sys_enter_read` / `sys_exit_read`、
`sys_enter_openat` / `sys_exit_openat`、`sys_enter_renameat2`。

输出：逐行 JSON 到 `<storageRoot>/trace/<runId>.ndjson`，每条形如
`{pid, tid, startTicks, nsecs, syscall, fd, path?, bytes, ret}`。

**采集器必须遵守的两条契约要求**（实现 §3.1 时必读，二者都已被下游代码依赖）：

1. **`path` 必须是已解析的绝对路径。** 下游按存储根做前缀判定，相对路径会被判为"存储根之外"
   而整条不计入——安全但静默少计。`path` 在 `openat` / `renameat2` 上是必填，在 `read` / `write`
   上必须不存在（下游按此做判别联合校验）。
2. **`syscall` 只有四个：`write` / `read` / `openat` / `renameat2`。没有 `close`，没有 `dup`。**
   这是刻意的：fd 复用无需 `close` 事件即可正确处理（内核只在 close 后复用 fd 号，而复用后的
   首次使用必为 `openat`，因此"后一次 openat 覆盖同一 fd"语义天然正确）。代价是 `dup` / `dup2`
   与 fork 继承的 fd 不可观测，其上的读写会落进显式的 **unknown-fd** 桶并被计数——可见，
   不静默归零。若 §7.3 的自洽性验收显示大量字节落进该桶，再扩展契约补 `close` / `dup` 事件。

字节口径：只记**实际返回**的正数字节（`ret > 0`）。短写只记它真正搬了多少。`ret < 0` 计入失败
计数，不贡献字节。

### 3.2 `process-identity` 计量事件

`MeteringPayload` 新增一个 kind，在 `createDelegationDeps`（`src/synapse/delegation.ts:96`）
中记录一次：

```ts
| { kind: "process-identity"; pid: number; startTicks: number; uptimeAtRecordSeconds: number }
```

- `pid`：`process.pid`。
- `startTicks`：`/proc/self/stat` 第 22 字段，进程启动时刻（自 boot 起的时钟嘀嗒数）。
- `uptimeAtRecordSeconds`：读取时刻的 `/proc/uptime` 第一个字段。

**这是产品代码唯一的改动。** 非 Linux 平台上 `/proc` 不存在，此时不记录该事件——
joiner 收不到映射即判定无法归因，这与"采集器没启动"是同一条路径，不需要平台分支。

### 3.3 joiner

纯函数模块，输入是两个数组（metering 事件、trace 记录），输出是结果对象。
不碰内核、不碰文件系统、不需要 root。

归因键设计为**可替换**：v1 用 `(pid, startTicks)`，S1 容器化落地后可替换为 cgroup id，
替换点限制在一个函数内，不把 pid 焊进归因逻辑。

### 3.4 汇总出口

新增 `aggregateWithKernelIo(events, trace)`，**不改** `aggregateMetering` 的签名。
现有调用方行为一字不变；只有显式带上 trace 的调用方拿到内核侧数据。

函数名刻意不叫 `aggregateWithTransport`：它产出的是内核 VFS 字节，不是传输字节。
命名与 §5.1 的口径保持一致，避免读者把两者当成同一个量。

## 4. 归因算法

### 4.1 建表

从 metering log 取出全部 `process-identity` 事件，建 `(pid, startTicks) → MeteringIdentity` 映射。

用 `startTicks` 而不是时间窗，是因为 PID 复用必须**可判定**而不是概率性的：同一个 PID 在两个
不同启动时刻是两个不同的进程，这是确定性事实。

### 4.2 过滤

只归因 SYNAPSE 相关的 I/O。`write` syscall 只提供 fd 不提供路径，因此：

1. `openat` 返回时，建立 `(pid, fd) → path` 映射。
2. `read` / `write` 时查表得到路径。
3. 路径相对存储根做前缀判定：`envelopes/` → 信封，`objects/` → 内容对象，
   `memory/` / `supersessions/` / `namespace.json` → 记忆索引与元数据。
4. **`metering/` 与 `trace/` 显式排除**，避免观测自身进入观测。
5. 存储根下无法归类的路径记为 `unclassified`，**不猜测**。

必须处理的边界，在实现计划里逐条列为可验收项：

- fd 继承：`fork` 后子进程继承父进程的 fd 表。
- `dup` / `dup2`：同一 path 出现多个 fd。
- 进程退出时的表清理，以及 fd 关闭后被复用。
- **`renameat2`：内容对象与信封都用"临时文件 + rename 发布"写入**
  （`content-store.ts:180`，以及 `atomic-json.ts:59-61` 的 `writeAtomicJson`）。
  字节实际写进的是临时文件名，发布后才变成最终路径。

  **但归类不需要跟随 rename。** 两个写入方都把临时文件建在**目标文件的同一目录**下
  （`path.join(path.dirname(filePath), ...)` / `path.join(dir, ...)`），因此 `.tmp` 文件的
  路径前缀已经是 `envelopes/` 或 `objects/`，按前缀分类天然正确。跟随 rename 只有在需要
  **逐文件身份**（"这些字节属于哪一个具体的内容对象"）时才必要，而本设计不要求逐文件身份。

  据此 `renameat2` 记录只需携带目的路径。要验收的是：对 `.tmp` 名的写入按前缀落进正确类别。
  若将来某个写入方把临时文件建在别处，那部分字节会计入 `unclassified` 并被显式报告——
  可见，而不是静默错误。

### 4.3 对齐时钟

这是本设计里最容易出错的一处，必须在实现中显式处理。

- 采集器侧 `nsecs` 是 boot-based 单调时钟。
- `MeteringEvent.monotonicMs` 是**每进程各自**从自己启动算起的 hrtime（`metering.ts:80-81`）。

**两者不同源，直接比较是错的。** 对齐办法是 `process-identity` 同时记下 `startTicks`
（boot 起的 ticks）与 `uptimeAtRecordSeconds`，让两侧共享 "since boot" 这一个基准。

### 4.4 判定

| 情形 | 处理 |
|---|---|
| trace 里的 pid 查不到映射 | 进 `unattributed` 桶并计数，不丢弃、不猜测 |
| 采集器报告事件丢失（ring buffer 溢出） | 该 run 的内核侧结果整体记 `unavailable` |
| `unattributed` 字节占比超过阈值 | 同上，整体记 `unavailable` |
| 归因成功但有 `unclassified` 路径 | 正常返回，`unclassified` 字节单列，不并入任何类别 |
| 没有 trace 输入 | 记 `"N/A"`：这个部署根本没有采集 |
| 同一 pid 出现多个 `startTicks` | 按 `startTicks` 分别归因，互不串账 |
| **存储根不可用**（非绝对路径、空串） | **`unavailable`，理由 `unusable-storage-root`** |
| **全部观测字节都落在存储根之外** | **不得以"通过"呈现**：根虽是合法绝对路径但与 trace 路径不在同一棵树时，归因损失是 100% |
| 一个 pid 绑定多个 `nodeId` | 报告身份**集合**加 `ambiguousProcesses` 计数，不做 first-wins，也不 orphan |

关于最后三行，各有一条必须记住的理由：

- **`unusable-storage-root` 是第四条拒报理由，与前三条共用同一个 `unavailableReasons` 通道。**
  它拒的是调用方错误而非采集失败，但对消费者的契约完全相同（这本账不可报）。若把它分成独立的
  失败类别，一个只检查 `unavailableReasons` 的调用方就会把被拒的结果读成可报——silent pass 由此重生。

- **"绝对但错误的根"必须被挡住，而不只是"非绝对的根"。** `startsWith("/")` 只关上语法那扇门。
  在本设计服务的部署形态（每个 Agent 一个 iSulad 容器）下，宿主上的采集器看到宿主路径、
  容器里的 Pi 用容器路径，**根不匹配是预期中的第一个故障，不是边缘情况**。判定必须基于字节而非行数：
  一个没有搬运任何可归因字节的进程行，不应为任何结论背书。

- **一个 pid 绑定多个 `nodeId` 是常态**：`createDelegationDeps` 按每次委派运行，所以一个父进程
  可服务多个节点。而内核 I/O 是**进程级**的，这些字节本就无法在那些 `nodeId` 之间拆分。
  **已知限制：多委派父进程的内核字节只能到进程粒度，不到节点粒度。** 这是诚实的下限，
  不是待修的缺陷；first-wins 会把它变成一个隐形猜测。

阈值不留给读者猜：`unattributed` 占比阈值定为常量，**默认 1%**，实际占比无论是否触发阈值
都随结果一并报告。阈值本身是个待真机校准的数——§7.3 的验收会给出它该定在哪里的依据。

**宁可 `unavailable`，绝不给残缺数字。** 一个丢了 3% 事件的字节数看起来和真值一样可信，
但它不是证据。`metering.ts` 从第一行注释起就在区分"没报上来"（`unavailable`）和"报了个零"，
也在区分"这个部署产不出来"（`N/A`）。内核侧采集服从同一条规矩。

这条纪律的现实意义：S3 的产出将被用来证明 S1 / S2 的收益。一套会在压力下悄悄给出偏小数字的
测量系统，比没有测量更糟——它会让后续优化看起来比真实情况更好，而那正是评审最该怀疑的方向。

## 5. 关键决策

### 5.1 `transportBytes` 保持 `"N/A"`

`MeteringTotals.control.transportBytes`（`metering.ts:126`）当前硬编码为 `"N/A"`，
注释为 *"A quantity this deployment cannot produce at all, such as socket bytes."*

**S3 不填它。** 内核 VFS 字节与"传输字节"是两个不同的量：今天的投递是写文件，VFS 字节可能
整段命中页缓存，从未触及任何传输介质。把 VFS 字节填进 `transportBytes`，或与 `envelopeBytes`
相加，都是范畴错误。

内核字节与逻辑信封字节**分栏展示，不相加**。

`transportBytes` 要等 S2 把信封投递换成 AF_UNIX socket 之后才真正存在，届时由 S2 填充。

### 5.2 旁路离线 join，而非在线回灌

考虑过的另一条路是让采集器实时把内核事件写进同一条 metering log，`aggregateMetering` 直接吃，
不需要 joiner。否决理由有两条：

1. `<storageRoot>/metering/<runId>.jsonl` 今天已经是父子进程并发 append
   （`delegation.ts:98` 在两侧都会调用），而 README 已知缺口 #4 明写"**没有多进程并发写压测**"。
   往一个未经压测的并发写点上再加第三个写者，等于把证据链的根建在未验证的假设上。
2. 采集器自身出错会**污染主日志**，而主日志一旦污染，"随时可离线重算"这个性质就没了。

### 5.3 不用 USDT / uprobe 精确打点

在 Node 侧埋静态探针可以让 eBPF 直接读出 `runId`，归因零歧义。否决理由：Node.js 的 USDT 需要
dtrace-enabled build，uprobe 挂 JIT 后的 JS 函数基本不可行。投入与脆弱度远超它买到的精度。

## 6. 失败行为

观测层不参与任务路径。以下情况**全部只改变结果的覆盖状态，不影响任务执行**：

- 采集器没启动、输出文件不存在、权限不足（缺少 `CAP_BPF` / root）；
- 采集器中途崩溃（trace 文件截断，joiner 判定为丢失，结果记 `unavailable`）；
- 运行平台不是 Linux（`/proc` 不存在，不记 `process-identity`）；
- 内核缺少所需 BTF 或探针挂不上（采集器启动即报具体原因并退出，**不静默降级**）。

## 7. 测试与验收

难点是：采集只能在 openEuler 上发生，但正确性必须在 CI 里被证明。现有 CI 跑 Ubuntu 与 Windows、
Node 24，没有内核探针、没有 root。分三层解决。

### 7.1 joiner 纯函数测试（CI，覆盖全部归因逻辑）

joiner 是整个 S3 里**唯一做判断、因而唯一可能算错的地方**，必须被完整覆盖：

- PID 复用：同一 pid、两个 `startTicks` → 断言分别归到两个 identity，不串账。
- 孤儿记录：pid 查不到映射 → 断言进 `unattributed` 且计数正确。
- 事件丢失：采集器报 `lost` → 断言结果为 `unavailable` 而非部分和。
- `unattributed` 超阈值 → 断言结果为 `unavailable`。
- 空 trace → 断言 `"N/A"`，且与 `aggregateMetering` 的现有输出逐字段一致。
- 时钟对齐：构造跨 boot 基准的记录 → 断言换算无漂移。
- fd 映射边界：fd 继承、`dup`、关闭后复用 → 断言路径归类正确。

### 7.2 采集器输出契约测试（CI，不需要内核）

采集器的**输出格式**是一份契约。用固定样本输出喂给解析器，断言 schema 与字段语义。
脚本本身跑不了，但"它吐出来的东西能被正确读懂"可以被证明。

事件丢失那一行的识别**必须**纳入这一层：它是诚实性的关键路径，不能只靠真机撞上一次才发现写错。

### 7.3 openEuler 真机验收（手动，出报告）

只有这层能回答"数字是不是真的"。三个可证伪的验收点：

1. **自洽性。** 跑一次已知规模的委派，把 joiner 算出的信封类内核字节与 `envelopeBytes` 对照。
   今天走文件投递，信封写一次读一次，因此内核字节应当约等于 `2 × envelopeBytes` 加文件系统
   元数据开销。**对不上就是归因错了。** 这是一个能证伪的预测，不是"看起来合理"。
2. **可重复性。** 同一任务跑 3 次，字节数应当稳定；时延可以波动，字节不该波动。
3. **诚实性。** 故意调小 ring buffer 逼出事件丢失，断言结果确实变成 `unavailable`，
   而不是悄悄给一个偏小的数。

第 3 点是主动证明这套东西**在失败时会说自己失败**。

## 8. 开放风险

### 8.1 内核侧进程启动时间的可得性（唯一"验不过要改设计"的点）

§4.1 的归因要求采集器侧也能拿到进程启动时间，预期通过 BTF 访问
`curtask->group_leader->start_time`。

**未在 openEuler 24.03-LTS-SP3 真机上验证。** 开发机为 Windows，目标环境在另一台机器上。

验证方式（在目标机上执行）：

```sh
# 1. 内核是否带 BTF
ls -l /sys/kernel/btf/vmlinux

# 2. bpftrace 是否可用及版本
bpftrace --version

# 3. 关键字段访问是否可编译并取到非零值
bpftrace -e 'tracepoint:syscalls:sys_enter_write { printf("%d %llu\n", pid, curtask->group_leader->start_time); exit(); }'

# 4. 记录环境信息，随验收报告一并提交
uname -r; cat /etc/openEuler-release
```

**回退方案：** 若该字段不可访问，归因退回"pid + 进程生命周期时间窗"。代价是精度下降，
且 PID 复用从可判定退化为不可判定——此时任何落在窗口边界上的记录必须计入 `unattributed`，
而不是就近归属。回退方案不阻塞实现，但会改变 §4.1 与 §7.1 的第一条测试。

### 8.2 采集器实现形态未定

本设计未固定采集器用 bpftrace 脚本还是 libbpf CO-RE 程序。两者的**输出契约相同**（§3.1），
joiner 与全部 CI 测试都不受影响。选型在实现计划中决定，判据是目标机上 §8.1 的验证结果与
是否要求目标机预装 bpftrace。

## 9. 交付边界与后续

S3 交付后，仓库获得的能力是：在 openEuler 上跑一次对照实验，拿到一份可溯源、可离线重算、
在证据不全时会诚实说 `unavailable` 的内核侧 I/O 账。

它**不会**自动让任何东西变快。它的价值在于让后续的"变快"可以被证明：

- **S1（iSulad 容器化）** — 每个 Agent 一个容器、共享 IPC namespace。落地后 S3 的归因键可从
  `(pid, startTicks)` 换成 cgroup id，归因从"可判定"升级为"结构性正确"。
- **S2（跨进程共享内存数据面）** — CAS 进 `/dev/shm`、投递换 AF_UNIX socket。这是
  `transportBytes` 真正诞生的地方，也是 S3 提供的基线第一次派上用场的地方。
- **S4（双模式对照实验框架）** — text / structured 同条件 A/B、≥10 轮连续任务、记忆命中率。
  消费 S3 与现有计量层的输出。

每一项各自走自己的 spec → plan → 实现循环。

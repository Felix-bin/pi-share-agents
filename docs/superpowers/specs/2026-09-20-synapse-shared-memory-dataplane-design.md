# S2：跨进程共享内存数据面设计

- 日期：2026-09-20
- 状态：设计草案，待评审（2026-09-20 修订：传输原语、存储根做法、验收承诺与依赖顺序）
- 目标平台：openEuler 24.03-LTS-SP3
- 依赖：[S1 iSulad 容器化运行时](2026-09-20-synapse-isulad-runtime-design.md)
- 相关：[S3 eBPF I/O 观测](2026-09-19-synapse-ebpf-io-metering-design.md)、`src/synapse/content-store.ts`、`src/synapse/envelope-inbox.ts`

## 1. 背景

赛题要求验证"结构化通信、非文本状态传递和共享记忆复用在减少重复计算、降低协作开销和提升任务效率方面的
实际效果"，并统计"文本通信 token 或字符开销、非文本状态传递次数及数据规模"。

Python 原型 README 对自己的字节数字有一句诚实的限定：

> 进程内共享 CAS 口径下，逻辑消息字节降低 HotpotQA **94.6%**、MuSiQue **96.5%**
> （**真实跨进程传输字节将在数据平面实测**）。

"进程内口径"意味着那是**理论上界**。本仓库今天的情况相同：`content-store.ts` 是本地文件 CAS，
`envelope-inbox.ts` 是原子写文件投递，README 已知缺口 #5 写着「信封的句柄尚未兑现」——
子 Agent 校验完信封就丢弃，不会按 `memoryRefs` 去取正文。

S2 把这个口径变成实测。

### 1.1 与 PR #11 的边界

PR #11「P3 完整向量状态交换 + P4-1 残差编解码」覆盖 `embedding.ts`、`delta.ts`、`corpus.ts`、
`state-retrieval.ts`。它解决的是**传什么**：把语义状态编码成残差，线缆上只走句柄。

**S2 解决的是字节怎么动**：CAS 放在哪、投递走什么传输、句柄如何兑现。

**合并状态已确认：PR #11 未合入本分支。** `src/synapse/` 下不存在上述四个模块中的任何一个。
S2 因此不与它们发生接口耦合，也不为它们预留接缝——真要合并时，句柄兑现点是
`subagent-prompt-runtime.ts` 里的一处，协调成本很小。

**S2 不得重新实现 PR #11 的任何部分。**

## 2. 范围

### 2.1 做

- **让 `<storageRoot>/objects` 落在 tmpfs 上**（bind mount，见 §3.2），并用 preflight 证明它
  确实落上了。`content-store.ts` 零改动。
- 信封投递从原子写文件换成 **AF_UNIX `SOCK_STREAM` + 长度前缀 framing**（见 §3.1）。
- **兑现句柄**：子进程启动时按 `memoryRefs` 从本地 CAS 确定性地读取正文，而不是随提示词接收
  引用加摘要（关闭已知缺口 #5）。
- 让 `MeteringTotals.control.transportBytes` 第一次成为真实的量——**并说清它是哪个量**（§4.1）。

### 2.2 不做

- 不做语义层。embedding、残差编码、向量检索属 PR #11。
- 不做跨节点。Gazelle / DPDK 只在跨节点大吞吐场景才值得，而本设计是同机。
- 不做自适应传输策略引擎（按消息大小在 UDS / SHM / 网络间选档）。那需要 S2 与 S3 都落地后
  用实测数据校准；没有数据的选档就是拍脑袋。
- 不删除文件投递路径。它是对照组，也是 S1 降级时的退路。
- **不碰 `src/runs/shared/container-launch.ts`。** S1 的启动路径已经把 storageRoot 原样挂进
  每个容器，§3.2 的做法因此不需要任何启动侧改动。
- **不碰 `access.ts` 的 scope 推导。** 今天每个子 Agent 的 scope 都是整 worktree
  （`child-contract.ts:94`）。收窄它是一个独立的权限模型改动，见 §4.2。
- **不动 `trace-classify.ts` 的单根不变量。** §3.2 的做法保住了"一个存储根"这个前提，那正是
  它的主要收益。

## 3. 架构

```text
   父会话                                          子 Agent
      │                                               │
      │  1. put(bytes) ──────────────┐                │
      │                              ▼                │
      │              ┌───────────────────────────┐    │
      │              │  <storageRoot>/objects    │◄───┤ 3. 启动时按 memoryRefs
      │              │  （宿主 tmpfs 的挂载点）    │    │    读取正文
      │              │  路径不变 → S3 归因不变     │    │
      │              └───────────────────────────┘    │
      │                                               │
      │  2. 信封（只含句柄 + 校验码，几百字节）           │
      └── AF_UNIX SOCK_STREAM，4 字节大端长度前缀 ─────►│
                                                       │
                 大数据不传，只传引用
```

### 3.1 `SOCK_STREAM` + 长度前缀 framing，而不是 `SOCK_SEQPACKET`

信封是有边界的消息而不是字节流，`SOCK_SEQPACKET` 原生保留消息边界，本来是更贴切的原语。

**但 Node 24 没有它。** `node:net` 对 AF_UNIX 只做 SOCK_STREAM，`node:dgram` 只有 udp4/udp6，
仓库依赖里也没有任何 seqpacket 绑定。拿到 `SOCK_SEQPACKET` 需要 N-API 原生插件——而那与 §3.2
拒绝 `shm_open` 的理由（VISION 的「Compose before inventing」，先用现有原语）直接冲突，并且会
引入一整块无法在 Windows CI 上测的代码。

所以 S2 走长度前缀 framing，和 Python 原型的 `protocol/transport.py` 同构。**这是代价，不是收益**：
半包、粘包、超长帧、帧头截断这一整类错误回来了。抵消它的办法是把 framing 做成纯函数——
一个 `encodeFrame(bytes): Buffer` 和一个喂字节、吐完整帧的增量 `FrameDecoder`——
在 Windows CI 上按字节边界穷举地测，包括每一个可能的分片位置。

帧头是 4 字节大端无符号长度，帧体是信封的 UTF-8 JSON。超过上限的长度前缀在解码处直接拒绝，
不分配缓冲区。

### 3.2 bind mount，而不是「把存储根换成 /dev/shm」

Node 没有原生 POSIX 共享内存绑定，用 `shm_open` 需要 N-API 原生插件。`/dev/shm` 是 tmpfs，
普通文件 API 就能读写，因此 `content-store.ts` 的现有实现可以原样复用。到这里为止，上一版设计
是对的。

**但"只换存储根"这句话低估了一件事：换根就是换 S3 的账本。**
`trace-classify.ts:134` 的 `classifyTracePath(storageRoot, filePath)` 只认一个根，`objects/` 是
它的子目录（`trace-classify.ts:57-63`）。对象一旦搬出 storageRoot，所有 content 字节落进
`outside-root`，而 `09b3999`、`aae80bb` 那几个提交专门把这种情况判成不可报告——S2 会把 S3 刚
加固的归因打回去。

**做法改成：把宿主上一个 tmpfs 目录 bind mount 到 `<storageRoot>/objects`。**

S3 的采集器契约要求 `path` 是**已解析的绝对路径**（S3 设计 §3.1 第 1 条）。bind mount 之下，
进程打开的和内核解析出的都是 `<storageRoot>/objects/...`，路径不变。**symlink 不行**：它会被解析
成 `/dev/shm/...`，正好落进 `outside-root`——这是这个决策里唯一容易做错的地方，实现时必须用
mount 而非 ln -s。

代价是这一步是运维动作而不是代码，所以它需要一个**能证伪的 preflight**：用 `statfs` 判
`<storageRoot>/objects` 的 `f_type` 是否为 `TMPFS_MAGIC`（或解析 `/proc/mounts`），判不出 tmpfs
就拒绝启用共享内存档并在产物中标记。没有这个检查，"共享内存档"会在挂载没生效时静默通过，
产出一组看起来正常、实际测的是普通磁盘的数字。

若 S3 的实测显示 tmpfs 的页缓存拷贝构成瓶颈，再考虑原生 mmap——但那要有数据支持，不是预判。

### 3.3 跨容器可见性来自挂载，不是 IPC namespace

上一版设计把跨容器可见性挂在 S1 的共享 IPC namespace 上。**在 §3.2 的做法下这不再成立**：
`<storageRoot>` 已经在 S1 的 `CONTAINER_MOUNTS_ENV` 里逐路径原样挂进每个容器
（`container-launch.ts:179`），所以 `objects/` 在每个容器里都是同一个宿主 tmpfs 目录，
与容器加入了哪个 IPC namespace 无关。

anchor 容器仍然该留着——它是 S1 已评审的承诺，也是将来真用 `shm_open` 或容器自带 `/dev/shm`
时的前提。但**它不再是"跨容器读不到对象"这条失败的解释**，§5 相应修正。

## 4. 关键决策

### 4.1 `transportBytes` 是信封字节，不是那个 94.6%

S3 刻意把 `control.transportBytes` 保持为 `"N/A"`，理由写在其 §5.1：内核 VFS 字节与传输字节
是两个量，文件投递的字节可能整段命中页缓存而从未触及任何传输介质。

S2 把投递换成 socket 之后，`transportBytes` 第一次真实存在。类型从 `NotApplicable` 放宽为
`number | NotApplicable`：socket 档报字节，文件档仍报 `"N/A"`。

**必须写清它是哪个量。** 信封只含句柄与校验码，量级是几百字节。真正的字节差在
`handoff.ts:86`——text 档把正文拼进提示词，synapse 档只给引用行——而那个差今天就已经记在
`message-delivered` 的 `textBytes` 上。把 `transportBytes` 当成"94.6%"的实测支撑是范畴错误，
会让 S4 拿错数字做标题。

`transportBytes` 的唯一职责是下面这条对账：

```text
socket 上发出的字节（应用层自报）
        ≈
内核侧观测到的、这条 socket 上的字节（S3 采集器）
```

两者不符即有一方错了。这是 S2 的核心验收，也是 S3 存在的意义第一次兑现。

**S3 的线协议要扩展，但扩展哪几个 syscall 必须先在真机上测出来，不能猜。**
上一版设计写的是"扩展 `sendmsg`/`recvmsg`"。这个假设很可能是错的：libuv 在 POSIX 上写流数据用
`writev()`，`sendmsg()` 只在传递文件描述符时才用。而且 S3 现有契约的 fd 归因完全依赖 `openat`
事件，socket fd 从不经过 `openat`，其上的字节会落进显式的 `unknown-fd` 桶——可见，但无法归因。

所以实现计划里，**对账实验之前必须先有一条真机观测任务**：在 openEuler 上对一个跑着 S2 socket
投递的 Node 24 进程 strace，记录它在 AF_UNIX 流上实际发出的 syscall 序列，据此确定 S3 要补的
事件集（预期是 `writev` + `socket`/`connect`/`accept4` 这一组，但以实测为准）。这是 S2 对 S3 的
反向依赖，须按 S3 的纪律重新验收其解析器与归因。

### 4.2 句柄兑现改变了消息的含义，但它不是沙箱

今天记忆以"引用加摘要"随提示词传递——子 Agent 拿到的是**文本**。
兑现句柄后父进程只发引用，正文在接收端本地读出：

```text
今天：  State → Text → 文件 → Text → State
S2：    State ──────── 共享 ─────────→ State
        同时：Instruction → 小控制消息 → Agent
```

**兑现在子进程启动时确定性地发生**，不是模型按需调工具。本质是把 `handoff.ts` 的 `readBody`
从父侧挪到子侧：父→子只过句柄，字节真的省在传输上，而兑现结果不依赖模型是否想起来调工具——
否则 S4 的 A/B 会把"模型没调工具"记成 synapse 档的任务质量劣势，那是测量污染而不是发现。

实现上这是两处小改动：`subagent-prompt-runtime.ts:397-402` 验完信封后保留 `delivered.wire`
而不是丢弃；`delegation.ts:245` 的 `promptWith` 在 synapse 档不再拼摘要行。

**权限投影天然保住**：子进程用的是 `child-contract.ts:106` 已经注册好的、按它自己 scope 建的
MemoryService，`isReadable` 校验的就是子 Agent 自己的 scope。兑现路径不得绕开它直接读 CAS 文件。
越权 memoryId 在兑现处拒绝，归类为权限错误。

**但这条约束能证明的是"兑现路径拒绝越权引用"，不是"权限不被旁路"。**
`access.ts:12-13` 自己写着这是宿主访问策略的投影，不是沙箱。S1 + S2 之后所有容器共享同一块
tmpfs 上的 objects/，任何带 bash 的子 Agent 在文件层面都读得到全部对象。把这条叫做"权限不被
旁路"是承诺了一件 S2 做不到的事。真实隔离属于另一份 spec。

### 4.3 文件路径保留为对照组

赛题明确要求"系统需同时支持纯文本协作模式和结构化协议协作模式，并在相同任务条件下完成可复现实验对比"。
S2 因此不删除文件投递，而是让传输方式成为可配置档位，由 S4 的实验框架在同条件下 A/B。

### 4.4 共享内存档是 per-boot 易失的

tmpfs 重启即失，而 memory 索引在磁盘上持久。重启后每个 `memoryId` 都会解析成
`object-unavailable`。

**这是接受的行为，不是待修的缺陷。** 现有分类已经覆盖它，S4 的实验在一次 boot 内跑完。
做磁盘回填缓存会引入"对象在两个地方、以哪个为准"的一致性问题，而它要解决的场景（跨重启复用
CAS）今天没有人需要。若将来需要，那是一个独立决策。

## 5. 失败行为

| 情况 | 处理 |
|---|---|
| `<storageRoot>/objects` 不在 tmpfs 上 | preflight 拒绝启用共享内存档，退回普通文件 CAS，**在产物中标记** |
| 跨容器读不到对端写入的对象 | 病因是 bind mount 未生效或未挂进容器，**不是** IPC namespace（§3.3）。拒绝，不得静默退回 |
| socket 连接失败 / 对端不在 | 按现有错误分类处理；投递失败不得被记为"投递成功但内容为空" |
| 收到超长或截断的帧 | 在解码处拒绝，不分配缓冲区，归类为投递失败（§3.1） |
| 句柄兑现时对象已不存在 | 走现有 `object-unavailable` 分类，与 `rehydrateLaunchContract` 的语义一致；重启后这是预期结果（§4.4） |
| 子 Agent 无权读取所引用对象 | **拒绝兑现**，记为权限错误。见 §4.2 |

## 6. 测试与验收

### 6.1 CI 层（Windows 可测，现在就能做）

1. **framing 编解码** —— `encodeFrame` / `FrameDecoder` 按字节边界穷举分片，每个可能的切点都
   还原出同一条消息；超长前缀与截断帧被拒绝而不是被缓冲。
2. **句柄兑现** —— 注入一个 MemoryService，断言子侧按 `memoryRefs` 取到正文，且 synapse 档的
   提示词里不再有摘要行。
3. **权限归类** —— 注入一个窄 scope，断言越权 `memoryId` 的兑现被拒绝并归类为权限错误（§4.2）。
4. **preflight 判定** —— 注入 `statfs` / `/proc/mounts` 的返回，断言非 tmpfs 判成拒绝、tmpfs
   判成通过，且拒绝时产物里有标记。
5. **`transportBytes` 分档** —— socket 档报数字、文件档报 `"N/A"`，且两者都不与 `envelopeBytes`
   相加。

### 6.2 真机层（全部阻塞，见 §6.3）

1. **跨容器可见性** —— A 容器 `put` 的对象，B 容器读到且摘要一致。
2. **socket syscall 观测** —— strace 一个跑着 S2 投递的 Node 24 进程，记录它在 AF_UNIX 流上
   实际发出的 syscall 序列（§4.1）。**这条排在验收 3 之前**，它的输出决定 S3 要补什么。
3. **`transportBytes` 对账** —— 应用层自报的 socket 字节与 S3 内核侧观测的字节相符（§4.1）。
   **这是 S2 最重要的一条**：它同时证明 S2 的计量与 S3 的采集都是对的。
4. **A/B 可复现** —— 同任务、同模型、同种子下文件档与共享内存档各跑一次，字节与时延的差值
   稳定可复现。

### 6.3 依赖顺序

```text
S1 Task 7 真机报告 ─────────┐
                            ├──> 真机验收 1
                            │
真机验收 2（strace 观测）────┴──> S3 线协议扩展 ──> 真机验收 3 ──> 真机验收 4

CI 层 5 条 ── 不依赖任何人，现在就能做
```

真机四条今天一条都跑不了：S1 的 Task 7（真机执行与报告归档）尚未执行。因此实现计划按
"能否在 Windows 上证明"分层，与 S1 的计划同构。

## 7. 开放风险

- **S1 真机验收未执行。** 单进程内的 tmpfs CAS 与 socket 投递可以先实现并在 CI 层测穷，
  但"跨进程真实传输字节"这个核心目标要等 S1 的真机报告。
- **S3 要补哪几个 syscall 尚未测出。** §4.1 给了预期（`writev` + socket 建立事件），但它是
  推理而不是观测，真机验收 2 就是为了把它变成事实。在那之前不得修改 S3 的契约。
- **长度前缀 framing 是 S2 自己引入的一类新错误。** §3.1 用纯函数 + 穷举分片测试抵消它，
  但这是缓解不是消除。
- **bind mount 是运维动作，不是代码。** 它会在代码之外的地方做错（尤其是用 symlink 代替
  mount），§3.2 的 preflight 是唯一能发现这件事的机制，必须先于任何共享内存档的运行存在。
- **tmpfs 总量约束是新问题。** 现有 `SYNAPSE_DEFAULT_MAX_OBJECT_BYTES`（1 MiB）约束的是单对象，
  tmpfs 的总量（通常为内存的一半）约束的是全体。清理策略未定；在实验规模下先不做，但要在
  preflight 里报告可用容量，好让"跑着跑着写不进去"有一个可查的前因。

## 8. 交付边界与后续

S2 交付后：

- 信封投递真的走了传输介质，`transportBytes` 成为真实的量，并被内核侧独立对账（§4.1）。
- 句柄第一次被兑现，父→子之间只过引用（§4.2），已知缺口 #5 关闭。
- 内容对象落在 tmpfs 上，且 S3 的归因口径不变（§3.2）。

S2 **不**交付的是"94.6% 的跨进程实测支撑"。那个数字来自提示词里带不带正文的差
（`handoff.ts:86`），它今天就记在 `textBytes` 上，S2 让它的分母变得更诚实（synapse 档真的不再
携带摘要），但它不是 `transportBytes`。把两者混为一谈是 §4.1 专门要防的范畴错误。

后续（S5，本设计不涉及）：拿到 S2 与 S3 的实测数据后，才谈得上按消息大小、扇出度与队列长度
在 UDS / 共享内存 / 网络之间自适应选档。

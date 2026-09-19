# 系统技术选型调研：IPC / 共享内存 / Socket / 向量检索 / WASM 沙箱 / eBPF

> 对象：`src/synapse/`（TypeScript 实现）。参照物：`reference/synapse-py/`（Python 原型）与
> `reference/synapse-py/竞赛赛题.md`（赛题原文，末句"鼓励结合 IPC、共享内存、Socket、向量数据库、
> WASM/容器沙箱、eBPF 等系统技术提升实现质量"）。
> 日期：2026-09-19。本文只做选型调研与排序，不改代码。

## 0. 结论摘要

赛题把六项系统技术并列写在"鼓励"一句里，但它们对本项目的边际价值差了一个数量级。按**当前实现的
失分点**排序，而不是按赛题的列举顺序平均用力：

| 技术 | 它解决本项目的哪个问题 | 首选方案 | 增量 | 主要影响的评分维度 | 优先级 |
|---|---|---|---|---|---|
| 向量检索 + 嵌入通道 | 检索的 `semantic` 分量目前硬编码 `unavailable`；`stateRef` 协议已留好但没有向量可填 | 本地 WASM 嵌入（transformers.js）+ 纯 TS 余弦；向量库延后 | 中 | 记忆复用 20 / 状态传递 20 | **P0** |
| Socket（AF_UNIX） | 信封走文件投递，`transportBytes` 永远是 `"N/A"`，没有真实传输量可报 | `node:net` + 4 字节长度前缀，抽出 `Transport` 接口 | 中 | 通信效率 25 / 系统完整性 20 | **P0** |
| eBPF | 所有字节数都是应用自报；评委一问"你怎么证明"就只剩源码 | `bpftrace` 旁路观测，三层计量对账 | 低 | 实验验证 15 | **P0**（性价比最高） |
| 共享内存 | CAS 落在普通文件系统，跨进程大状态没有独立数据平面 | `/dev/shm` tmpfs 作为 CAS 后端 + 租约 GC | 低-中 | 状态传递 20 / 系统完整性 20 | P1 |
| IPC（进程内/线程间） | 前台子 Agent 在同进程内，没有真正的进程边界可测 | 后台 runner already spawn；补 `worker_threads` + SAB 零拷贝档 | 低 | 系统完整性 20 | P2 |
| WASM/容器沙箱 | 本仓库目前没有 CodeAct 执行路径 | Pyodide on Node（WASM CPython） | 高 | 赛题"鼓励项"，不在五个计分维度内 | P2 |

**一句话结论**：真正堵住分数的是**嵌入通道**——它一个人卡住了"记忆复用"和"非文本状态传递"两个
20 分维度（合计 40 分）。Socket / 共享内存 / eBPF 不创造新机制，它们的作用是把已有机制搬到真实的
系统边界上，并让报出来的数字**能被第三方核验**。WASM 沙箱是新功能而非补缺口，排在最后。

---

## 1. 约束先行

选型不是从技术清单里挑好听的，而是先把不可协商的边界钉死。

### 1.1 运行时与分发约束（最硬的一条）

- 运行时是 **Node 24 + TypeScript**（CI 用 Node 24，本机实测 v24.11.1），执行方式是
  `--experimental-strip-types`，没有构建步骤。
- `package.json` 的 `dependencies` 目前是 `acorn / jiti / typebox / undici / yaml` —— **五个纯 JS 包，
  零原生依赖**。
- 推荐安装方式是 `pi install git:github.com/Felix-bin/pi-share-agents`，Pi 会执行
  `npm install --omit=dev`。**用户机器上不保证有 C++ 编译器**。
- CI 同时跑 **Ubuntu 与 Windows**（`.github/workflows/test.yml`）。

推论：任何需要现场编译的原生模块（`better-sqlite3`、`hnswlib-node`、`node-libsharedmemory`）
**不能进 `dependencies`**。可选路径只有三条：纯 JS、WASM、或 `optionalDependencies` + 运行时能力探测
+ 显式降级。这条约束会反复出现在下面每一节。

### 1.2 目标环境

openEuler 24.03-LTS-SP3，内核 6.6，自 23.03 起支持 eBPF CO-RE（BTF 随内核分发）。
README「已知缺口 8」诚实记录了该平台**尚未实测**（AC-15）。本文的 eBPF / `/dev/shm` / AF_UNIX
方案都只依赖 Linux 通用能力，不依赖 openEuler 特性，但**都必须在 SP3 上实跑一遍再写进材料**。

### 1.3 进程模型（决定 Socket 方案的边界）

- 前台子 Agent：`buildInProcessChildLaunch`（`src/runs/shared/child-launch.ts:195`）——**同进程内**。
- 后台子 Agent：`spawn`（`src/runs/background/async-execution.ts:726`）——**真实独立进程**。

所以"四 Agent 跨进程协作"这个演示只能走**后台 run**。前台路径上加 Socket 是在同一进程里绕一圈，
除了增加延迟没有任何收益。这一点必须在材料里写清楚，否则等于把 Python 原型"进程内 CAS 冒充数据
平面"的错误换个语言重犯一次。

### 1.4 术语纪律

**共享记忆（shared memory of experience）≠ 共享内存（shared memory IPC）**。本仓库里
`test/integration/synapse-shared-memory.test.ts` 指的是前者。引入 `/dev/shm` 后这两个词会在同一份文档里
高频出现，建议此后代码与文档统一用 `sharedMemory`（记忆层）和 `shmCas` / `tmpfs`（IPC 层）区分。

### 1.5 从 Python 原型继承的四条教训

原型的 `docs/决赛夺冠总路线图.md` §2.2 和 `docs/工程化基线.md` 已经把坑踩过一遍，直接继承结论：

1. **进程内 dict 不是数据平面。** 原型 `stateplane/cas.py` 是 `dict[str, bytes]`，README 却一度写成
   "提供共享内存跨进程后端"，被自审列为硬伤。本仓库的 `content-store.ts` 至少是真落盘的，起点更好。
2. **校验和必须接收方可复算。** 原型 `residual.py` 最初对全量量化 Y 取哈希，而接收方根本没有 Y，
   数学上永远无法复算；重设计为 `H(residual 字节 ‖ base_handle ‖ generation ‖ …)`，且长度前缀防拼接
   歧义（见 `stateplane/checksum.py:digest_packet`）。本仓库上向量载荷时直接照抄这个形状。
3. **"沙箱"是个要付责任的词。** 原型的 subprocess + RLIMIT 档被如实降称为"**非安全沙箱**（同用户
   文件系统/网络未隔离）"。本仓库若上 WASM 沙箱，边界声明要同样保守。
4. **自报字节不是证据。** 原型把 `transport = Σ帧长` 与 `logical = Σ(header+payload)` 分列对账。
   本仓库的 `metering.ts` 已经预留了这个分列（见下节），但缺第三层——内核视角。

### 1.6 现有代码里已经留好的接缝

调研中最值得高兴的发现：**计量 schema 跑在机制前面**，下列位置已经为本文所有方案预埋好了字段，
上机制时不需要改 schema，也就不需要重跑历史实验：

| 位置 | 已预留的东西 | 谁来兑现 |
|---|---|---|
| `src/synapse/metering.ts:126` | `control.transportBytes: "N/A"` | Socket 方案 |
| `src/synapse/metering.ts:51` | `state-prepare / state-send / state-receive / state-consume` 四个事件 | 向量载荷 |
| `src/synapse/metering.ts:53` | `embedding-call`（含 `costUsd` / `inputTokens` / `ok`） | 嵌入通道 |
| `src/synapse/metering.ts:56` | `object-io`（read/write bytes） | 共享内存 CAS |
| `src/synapse/envelope.ts:57` | `StateRef { encoding: "float32-vector" \| "delta", baseMemoryId, dim, sha256 }` | 向量/残差载荷 |
| `src/synapse/capability.ts:24` | `SYNAPSE_ENCODINGS` 已含 `delta` | 残差编码 |
| `src/synapse/retrieval.ts:28` | `components.semantic: number \| "unavailable"` | 语义检索 |
| `src/synapse/config.ts:46` | `embedding { provider, model, dim, endpoint, keyEnv }` | 嵌入通道 |
| `src/synapse/content-store.ts:86` | `createContentStore(rootDir, limits)`——后端就是一个路径参数 | 共享内存 CAS |

---

## 2. 逐项调研

### 2.1 Socket / AF_UNIX 控制面 —— P0

**问题。** 信封现在写到 `<storageRoot>/envelopes/<runId>/<childIndex>.json`
（`envelope-inbox.ts:61`），子侧读文件校验。这条路是对的（背景子进程拿不到活对象），但它有两个
后果：一是 `MeteringTotals.control.transportBytes` 只能是 `"N/A"`，**没有任何真实传输字节可报**；
二是"结构化控制面"在评委眼里等于"往文件里写 JSON"。

**方案。** 抽 `Transport` 接口（直接对照原型 `protocol/transport.py`），三个实现：

| 实现 | 场景 | 说明 |
|---|---|---|
| `FileInboxTransport` | 现状，保留为降级档 | 不产生 framing 字节，`transportBytes` 记 `N/A` |
| `LocalSocketTransport` | Linux/openEuler 主链路 | `node:net` AF_UNIX + `!I` 4 字节网络序长度前缀 |
| `LocalSocketTransport`（同一份代码） | Windows CI | Node 在 Windows 上把 `net.connect(path)` 解释为命名管道，接口不变 |

framing 语义直接抄原型已经测透的故障矩阵（`transport.py` + `tests/test_transport.py` 16 项）：
长度前缀恢复消息边界、并发 `send` 串行化不让前缀与载荷交错、连接/发送/接收/accept 超时转显式异常、
`sendall` 超时留下半帧后**立即关闭失步连接**而不是继续复用、对端死亡与超限帧显式失败、`close()`
幂等。这批语义在 Python 侧已经有现成测试可对照移植，是本方案能压到"中等增量"的原因。

**Node 特有的坑（与原型不同的地方）：**

- **不要承诺 fd 传递。** Node 不暴露 `SCM_RIGHTS`；`subprocess.send(msg, handle)` 只能传
  `net.Socket` / `net.Server` / `dgram.Socket`，传不了 `memfd`。原型路线图里的 "memfd + SCM_RIGHTS"
  在 Node 上**需要原生扩展**，按 §1.1 应直接放弃，不要写进材料。
- 权限：`bind` 后立刻 `chmod 0600`（原型 `transport.py:154` 就是这么做的），并按 inode 身份
  （`st_dev, st_ino`）判断再 `unlink`，避免删掉别人替换上来的同名 socket。
- socket 路径长度上限 108 字节（`sun_path`），而 `storageRoot` 默认在
  `<agent dir>/synapse/<namespaceId>` 下——**路径可能超限**。放 `/run/user/<uid>/` 或
  `/tmp/` 下短名，路径本身写进信封元数据。这是一个会在 openEuler 上才炸、在 Windows 开发机上
  永远碰不到的问题。
- 背压与重连：原型明确"不承诺"。本仓库同样**不要承诺**，但要显式设置队列上限并在超限时报错，
  而不是无界堆积。

**它解锁的度量。** `control.transportBytes = Σ(4 + len(wire))`，与 `control.envelopeBytes`
（逻辑口径）分列，两者的差就是 framing 开销——这正是"通信效率"维度里一个诚实的、别人通常省略
不报的成本项。

**风险。** 前台路径没有进程边界（§1.3），Socket 只对后台 run 有意义；Windows 下是命名管道不是
AF_UNIX，材料里不能混为一谈。

---

### 2.2 嵌入通道 + 向量检索 —— P0（最高投入产出）

**问题。** 两处硬缺口，一个根因：

- `retrieval.ts:86` 的 `semantic: "unavailable"` 是**硬编码常量**。赛题第 6 条要求"按关键词、标签
  **或语义相似度**检索"，"记忆复用效果"20 分整整一个维度目前建立在 Jaccard 关键词匹配上。
- `envelope.ts` 的 `StateRef` 结构完整、校验齐全，但**没有任何东西产生向量**，所以协商永远落在
  文本路径。"状态传递创新"20 分目前是 0 分起步。

值得说明的是，当前的处理方式在诚实度上是对的（`config.ts:27` 的 `TEST_ONLY_PROVIDERS` 显式拒绝
`hash` / `fake` 这类冒充语义分量的 provider，注释写着"接受它会让一次运行报告语义检索而实际测量的
是哈希"）。缺的不是诚实，是真的嵌入。

**方案 A（推荐，先做）：本地 WASM 嵌入 + 纯 TS 余弦。**

- 嵌入：`@huggingface/transformers`（transformers.js）走 **onnxruntime-web 的 WASM 后端**，
  模型如 `Xenova/all-MiniLM-L6-v2`（384 维）或 `Xenova/bge-small-zh`（中文语料更合适，需实测）。
  纯 WASM 意味着**没有原生 addon**，满足 §1.1；代价是比原生 ONNX 慢（业界观测原生 vs WASM 约
  2–10× 差距），首次要下载模型权重。
- 检索：记忆条数是**项目级**的，量级在 10²–10⁴。这个规模下暴力余弦（Float32Array 点积）是
  微秒级，**不需要向量库**。纯 TS 实现还保住了 `retrieval.ts` 头注释强调的性质：排序可复算，
  历史运行的排名不随语料增长漂移。
- 融合：现有 `KEYWORD_WEIGHT 0.6 / TAG_WEIGHT 0.4` 扩为三路，权重写进配置并进 manifest
  （对照原型的"关键词集合相似度 / 标签过滤 / 语义余弦"三路召回）。

**为什么本地模型优先于 API。** `config.ts` 目前只允许 `provider: "siliconflow"`。API 方案要真跑一遍
`embedding-call` 计量确实更简单，但有三个硬伤：评审现场无网络就演示不了；每次实验的嵌入 token 是
额外成本且必须计入分母（原型的答辩问答专门准备了这条）；密钥管理已经在 `credentials.ts` 里花了
成本。**两条都要**，但顺序是：本地 WASM 做离线黄金路径 + 可复现实验，API 做规模化主实验。
`SYNAPSE_EMBEDDING_PROVIDERS` 需要新增一个 `local-onnx` 之类的 provider——注意这不是被禁止的
stub，它是真模型，但**扩 allowlist 必须是显式动作**，并且 `representationId` 要覆盖
provider+model+dim，否则两种 provider 产生的向量会被当成同一表示混用。

**方案 B（按需，后做）：`node:sqlite` + `sqlite-vec`。**

本机已实测 Node 24.11.1 的 `node:sqlite` **带 `loadExtension`**（`new DatabaseSync(path,
{allowExtension:true})`，带 `ExperimentalWarning`）。`sqlite-vec` 的 npm 包把平台二进制拆成
`sqlite-vec-linux-x64` 这类子包分发。所以技术上可行，但：

- 扩展是平台原生 `.so`/`.dll`，必须进 `optionalDependencies` + 加载失败时降级到暴力余弦，
  绝不能让安装在某个平台上直接失败；
- 已有社区报告**手工加载成功但嵌入上下文加载失败**的情形，根因指向 SQLite ABI 与
  `node:sqlite` 的 OMIT 编译标志，要在 openEuler 上实测而不是假设；
- 在 10⁴ 条以下，它换来的召回延迟收益基本看不见。

**结论：先不做。** 只有当记忆规模真的进入 10⁵ 级、或者需要在材料里写"向量数据库"这四个字时才
启动，且必须带降级路径。为它预留的接口就是一个 `VectorIndex { put, search }`——原型
`stateplane/vector_index.py` 已经演示过这个接口在"进程内线性扫描 → faiss/共享内存后端"之间
保持不变。

**下一步解锁的东西。** 有了真向量，`StateRef` 才填得上；填上之后残差编码（`delta`）才有意义：
`Z = Y − Ŷ`，Ŷ 来自共享记忆里检索到的预测基。原型 `stateplane/residual.py` 的贪心稀疏 int8 编码
（按 |残差分量| 降序加入，余弦达阈值即停）可以直接照着实现，且**接收方语义校验 + 失败回退全文**
这条 VLC 链路必须一起上——有损传递没有校验就是静默损坏。

---

### 2.3 eBPF —— P0（增量最低，可信度收益最高）

**问题。** 现在报出去的每一个字节都是应用自己写进日志的。`metering.ts` 的设计已经很克制
（缺报记 `unavailable` 而不是 0、重复投递识别为重复、任务耗时按墙钟），但它终究是**自证**。

**方案。只用 eBPF 做观测，绝不用它做机制。** 这条边界很重要：把 eBPF 放进数据通路会引入
CAP_BPF 依赖和内核版本耦合，而放在旁路只会在"实验验证"维度加分。

三层计量对账（第三层是新的）：

| 层 | 来源 | 语义 |
|---|---|---|
| logical | `envelopeBytes + textBytes`（已有） | 应用语义字节 |
| transport | `Σ(4 + len(wire))`（§2.1 上线后） | 帧层字节，含 framing |
| **kernel** | bpftrace 旁路观测 | 内核实际看到的字节与系统调用 |

具体探针（openEuler 6.6 内核，BTF 齐备）：

- `kprobe:unix_stream_sendmsg` 或 `tracepoint:syscalls:sys_enter_write`，按 pid 过滤 →
  **内核视角的控制面字节**，与 transport 层对账，差值应当只来自非 SYNAPSE 的 I/O；
- `tracepoint:sched:sched_switch` → 上下文切换次数，量化"多进程协作"的真实系统开销；
- `tracepoint:exceptions:page_fault_user` / `softirqs` → `/dev/shm` 方案上线后量化缺页成本；
- **`tracepoint:syscalls:sys_enter_connect` + `sys_enter_openat`** → 这一条最有价值：它是
  **WASM 沙箱声明的独立证据**。"沙箱内代码没有发起网络连接、没有打开沙箱外文件"这句话，由内核
  观测来证明，比由沙箱自己声明强一个量级。

工程形态建议：`scripts/probe-ebpf.bt`（bpftrace 脚本）+ 一个把输出归并进 manifest 的 Node 脚本。
**不引入任何 Node 侧 eBPF 依赖**（`bpftrace` 是外部命令，不是 npm 包），所以它对 §1.1 的分发约束
零影响。

**风险与降级。** 容器内跑 eBPF 需要 `CAP_BPF`/`CAP_PERFMON`（或 `--privileged`），普通
`docker run` 没有。降级链：bpftrace 不可用 → `/proc/<pid>/io` + `getrusage` → 如实标 `N/A`。
`metering.ts` 已经区分了 `Unavailable` 与 `NotApplicable` 两种类型，这个降级在类型层面已经表达得了。
**待验证**：SP3 仓库里 `bpftrace` / `libbpf` 的实际包版本与 `/sys/kernel/btf/vmlinux` 是否存在，
必须在目标机上跑 `bpftrace --info` 确认后再写进材料。

---

### 2.4 共享内存（`/dev/shm`）—— P1

**问题。** `content-store.ts` 是一个设计得相当干净的 CAS：SHA-256 内容寻址、同目录临时文件
rename 发布、每次读取重新校验摘要。它唯一的"不够系统"之处是落在普通文件系统上——跨进程交换
大状态时要走磁盘 I/O 和 page cache 回写。

**方案。** `createContentStore(rootDir)` 的后端就是一个路径参数，所以把 `rootDir` 指到
`/dev/shm/synapse/<namespaceId>/` 即可，**核心代码一行不用改**。tmpfs 是真正的 POSIX 共享内存：
两个进程读同一个对象命中同一份物理页，不落盘。

需要补的是三件外围事：

1. **租约与 GC。** tmpfs 是内存，泄漏就是吃内存。对象带 `lease_expiry`，run 结束清理，
   进程崩溃后由下次启动扫描回收。验收标准照抄原型 G2 门槛：**`/dev/shm` 零残留**。
2. **容量。** 裸 `docker run` 的 `/dev/shm` 默认只有 64M；原型的 `docker-compose.yml` 预置了
   `shm_size: "1gb"` 才实测到 1.0G。本仓库若出容器配置要带同样的预置，并在 `put` 超容量时
   报显式错误而不是写半个对象。
3. **降级。** Windows 没有 `/dev/shm`，CI 必须能落回普通目录。这是一个**运行时探测 + 配置项**，
   不是编译期分支。

**诚实边界（重要）。** Node **没有内置 mmap**，也没有跨进程的 `SharedArrayBuffer`（SAB 只在同一
进程的 worker 线程间共享）。要真正的零拷贝映射必须上原生扩展，按 §1.1 排除。所以材料里的表述
只能是："**基于 tmpfs 的共享内存后端——对象驻留内存、跨进程共享物理页、不落盘；不是 mmap 零拷贝，
读写仍经系统调用与一次拷贝。**" 这个区别可以用 §2.3 的 page-fault 探针量化出来，把边界变成数据。

**收益的实话实说。** 在本项目的载荷规模（信封几 KB、向量 384×4 B、记忆正文上限 1 MB）下，
tmpfs 相对普通文件系统的**延迟收益大概率测不出显著差异**——page cache 本来就挡住了大部分磁盘
开销。它的真实价值是**架构正确性**（状态平面与控制平面物理分离、大状态不进控制面）和**可讲述性**，
不是性能。如果实验做出来没有显著差异，就如实报告没有显著差异——这比编一个百分比更值钱，
路线图 §八已经把"不为了系统感堆名词"写成明令。

---

### 2.5 IPC（进程内 / 线程间）—— P2

前台子 Agent 在同进程内（§1.3），这里没有 IPC 可言，也不需要造一个。真实的跨进程边界只有后台
runner，而它已经在 `spawn` 了——**赛题要求的"多 Agent 运行时"这一条其实已经满足**，只是没有被
当成系统技术讲出来。

唯一值得补的一档：`worker_threads` + `SharedArrayBuffer`，作为**同进程内的零拷贝状态交换档**。
它是纯 Node 内置能力，零依赖，能给实验矩阵提供一个干净的对照点：

`in-process SAB（零拷贝）` < `tmpfs CAS（一次拷贝，共享物理页）` < `AF_UNIX 传全文（两次拷贝）`
< `文件投递（落盘）`

这四档一张表，比任何"我们用了共享内存"的声明都有说服力。代价也诚实：SAB 需要 `Atomics` 做
同步，竞态是真实风险，只在状态载荷落地之后再考虑。

---

### 2.6 WASM / 容器沙箱（CodeAct）—— P2

**先说定位。** 赛题把 CodeAct 写在"鼓励"一段，**不在五个计分维度里**。而本仓库目前根本没有
CodeAct 执行路径——`executor` 角色的做法是"运行步骤所需的命令"，用的是宿主的 `bash` 工具。
所以这是**新增功能**，不是补缺口，排在最后。

**如果做，方案对比：**

| 方案 | 隔离强度 | 增量 | 对 §1.1 的影响 |
|---|---|---|---|
| **Pyodide（WASM CPython）** | WASM 线性内存隔离，默认无网络、虚拟 fs | 高（~10 MB+ 运行时下载） | 纯 WASM，无 addon ✅ |
| QuickJS-wasm | 同上，但只能跑 JS | 低 | ✅ |
| 子进程 + RLIMIT（原型做法） | 进程边界 + 资源遏制，**文件系统/网络未隔离** | 低 | ✅ |
| 容器 / bubblewrap / gVisor | 强 | 需要宿主装 podman/bwrap | 外部依赖 |

**Pyodide 是相对原型的实质升级**：原型自己把 subprocess 档如实降称为"非安全沙箱（同用户文件
系统/网络未隔离）"，而 WASM 线性内存 + 无绑定的默认虚拟 fs 确实**能挡住**文件系统与网络访问。
但它有两个必须写进边界声明的硬伤：

1. **无法中途中断。** Pyodide 跑起来就停不下来，模型写个 `while True` 就挂死。超时必须靠外部：
   放进 `worker_threads` 用 `terminate()`，或放进子进程用 `kill`。**两层都要**（WASM 管隔离，
   进程/线程管遏制）——这恰好和原型的两档执行器是同一个结论，只是隔离那一层换成了真沙箱。
2. **它是内存边界，不是 VM。** 对自家 Agent 生成的代码足够，对刻意对抗的输入不够。表述用
   "轻量 WASM 沙箱，内存隔离 + 默认无网络无文件系统"，**不要用"安全沙箱"**。

再补一句：§2.3 的 `sys_enter_connect` / `sys_enter_openat` 探针能把"默认无网络无文件系统"
从声明变成**内核观测到的事实**。WASM + eBPF 这个组合是本文里唯一一处两项技术互相加成的地方。

---

## 3. 建议的推进顺序

按"解锁下一步的能力"排，不按技术难度排。

**批次 1——先把两个 20 分维度点亮（嵌入 + Socket）**

- 本地 WASM 嵌入 provider + 纯 TS 余弦，`retrieval.ts` 三路融合，`semantic` 从 `unavailable`
  变成真实数值；`embedding-call` 计量兑现。
- `Transport` 接口 + `LocalSocketTransport`，移植原型的故障矩阵测试；`transportBytes` 兑现。
- 门槛：语义分量有真实值且排序可复算；`transportBytes = Σ帧长` 有断言锁定；两项都不破坏
  "文本回退不是向量成功"这条不变量。

**批次 2——非文本状态真通路**

- 向量载荷写入 CAS，`StateRef` 填满，接收方**仅凭句柄重建并消费**（这是原型 V3-04 的核心验收：
  删掉重建逻辑，答案必须改变——否则就是旁路读了全文）。
- 校验和照 `digest_packet` 的形状：只哈希线缆双方可见内容，带长度前缀，接收方可复算。
- 随后才是 `delta` 残差编码 + VLC 校验回退。
- 门槛：三档（text / float32-vector / delta）字节构成有断言；回退率可报。

**批次 3——系统平面与内核旁证**

- `/dev/shm` CAS 后端 + 租约 GC，`/dev/shm` 零残留验收。
- bpftrace 探针脚本 + 三层计量对账进 manifest。
- 后台四 Agent 跨进程 10 轮稳定性。
- 门槛：内核观测字节与应用自报字节的差值可解释。

**批次 4——加分项**

- Pyodide CodeAct（双层：WASM 隔离 + worker/进程遏制），用 eBPF 探针佐证隔离声明。

每一批都遵守原型路线图的回归防护三条款：**新机制一律 config flag 门控且默认关**、每 PR 必过
完整门禁、锁旧口径的测试基线变更须独立 commit 并说明差量原因。这也正好符合本仓库 VISION.md 的
"Scope must earn size"——一个 PR 证明一个不变量。

---

## 4. 实验矩阵：每项技术要回答的问题

赛题要求"同条件双模式对比"，但单一对比回答不了"收益来自哪里"。建议两个正交矩阵（照搬原型
V3-07 的双矩阵设计，它已经被两轮审阅打磨过）：

**矩阵 A：语义层（回答"省的 token 从哪来"）**

1. 纯文本全上下文
2. 结构化信封，但仍传全文
3. 结构化 + 完整 float32 向量
4. 结构化 + 残差（无共享记忆预测基 → 对照组，应当几乎不收缩）
5. 完整路径（结构化 + 残差 + 记忆预测基）

**矩阵 B：系统层（回答"系统技术带来了什么"）**

| 路径 | 控制面 | 状态面 | 应报指标 |
|---|---|---|---|
| 基线 | 文件投递 | 普通文件 CAS | logical bytes |
| +Socket | AF_UNIX | 普通文件 CAS | + transport bytes、+ 内核字节 |
| +SHM | AF_UNIX | tmpfs CAS | + page fault、+ object-io |
| +SAB | 同进程 worker | SharedArrayBuffer | 零拷贝上界（对照用） |

矩阵 B 的诚实预期见 §2.4：**延迟差异可能不显著**。矩阵 B 的价值在于证明控制面/状态面真的分离了，
以及给出一条从落盘到零拷贝的完整成本谱，不在于刷一个百分比。

---

## 5. 明确不建议做的事

- **不要引入需要现场编译的原生依赖。** 一次 `npm install` 失败毁掉的是整个安装体验，换来的是
  一个在 10⁴ 条记忆下测不出差异的索引。
- **不要承诺 mmap 零拷贝、memfd + SCM_RIGHTS。** Node 做不到，除非上原生扩展。
- **不要把 eBPF 放进数据通路。** 旁路观测已经拿到全部叙事收益，进通路只会引入 CAP_BPF 依赖。
- **不要在前台路径上加 Socket。** 同进程内绕一圈只增加延迟。
- **不要用 "安全沙箱" 这个词。** 用"WASM 内存隔离 + 默认无网络无文件系统 + 外层进程遏制"。
- **不要为了写"向量数据库"四个字而引入向量数据库。** 除非记忆规模真的到了那个量级。
- **不要让 `semantic` 分量出现任何形式的近似替身。** `config.ts:27` 已经把这条写成了代码里的
  守卫，新增 provider 时别绕过它。

---

## 6. 待验证清单（不能从本机推断的事实）

| # | 待验证 | 验证方式 |
|---|---|---|
| 1 | SP3 上 `bpftrace` / `libbpf` 包版本与 BTF 可用性 | 目标机 `dnf info bpftrace`、`ls /sys/kernel/btf/vmlinux`、`bpftrace --info` |
| 2 | 容器内 eBPF 所需能力 | `docker run --cap-add BPF --cap-add PERFMON` 实跑，记录失败形态 |
| 3 | `storageRoot` 下 AF_UNIX 路径是否超 108 字节 | 目标机实测默认 `namespaceId` 路径长度 |
| 4 | 目标环境 `/dev/shm` 容量 | `df -h /dev/shm`；容器需预置 `shm_size` |
| 5 | transformers.js WASM 后端在 openEuler 上的冷启动与单次嵌入延迟 | 实测，决定它能否进"黄金演示路径" |
| 6 | 中文语料下 MiniLM vs BGE-zh 的召回质量 | 用本项目自己的记忆样本小规模对比 |
| 7 | `sqlite-vec` 在 `node:sqlite` 上的加载（如果启动方案 B） | openEuler 实测，注意已知的 ABI/OMIT 问题 |
| 8 | Pyodide 在 worker 中 `terminate()` 能否可靠打断死循环 | 写死循环探针实测，记录残留线程 |
| 9 | openEuler 24.03-LTS-SP3 本身（README 已知缺口 8 / AC-15） | 全套测试在真实 SP3 上跑一遍 |

---

## 参考来源

- [sqlite-vec 在 Node.js / Deno / Bun 中的使用](https://alexgarcia.xyz/sqlite-vec/js.html) 与
  [安装说明](https://alexgarcia.xyz/sqlite-vec/installation.html)
- [@photostructure/sqlite-vec（预编译分发形态）](https://www.npmjs.com/package/@photostructure/sqlite-vec)
- [openEuler 24.03 LTS SP3 版本页](https://www.openeuler.org/en/download/archive/detail/?version=openEuler+24.03+LTS+SP3)、
  [SP3 服务器文档](https://docs.openeuler.org/en/docs/24.03_LTS_SP3/server/index.html)、
  [openEuler 的 eBPF CO-RE 支持](https://www.linkedin.com/pulse/ebpf-co-re-easy-porting-across-kernel-versions-openeuler)
- [langchain-sandbox：Pyodide + Deno 运行不可信 Python](https://github.com/langchain-ai/langchain-sandbox)、
  [Simon Willison：Deno 中的 Pyodide 沙箱](https://til.simonwillison.net/deno/pyodide-sandbox)、
  [WASM 轻量 AI 沙箱：Pyodide 与 QuickJS](https://foundrysoft.co/blog/wasm-sandbox-ai-code-pyodide-quickjs)
- [mStream PR #1000：onnxruntime WASM 回退方案](https://github.com/IrosTheBeggar/mStream/pull/1000)、
  [Node.js RAG 库选型（原生 ONNX vs transformers.js）](https://www.redhopai.com/guides/nodejs-library-for-rag/)
- [MDN：SharedArrayBuffer（仅同进程线程间共享）](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- 本地实测：Node v24.11.1 的 `node:sqlite` 提供 `DatabaseSync#loadExtension`（带 `ExperimentalWarning`）
- 仓内参照：`reference/synapse-py/docs/决赛夺冠总路线图.md`、`reference/synapse-py/docs/决赛T45总执行方案-v3.md`、
  `reference/synapse-py/docs/工程化基线.md`、`reference/synapse-py/源代码及readme文档/src/synapse/{protocol/transport.py,stateplane/*.py}`

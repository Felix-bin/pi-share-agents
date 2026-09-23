# S1：iSulad 容器化运行时设计

- 日期：2026-09-20
- 状态：设计草案，待评审
- 目标平台：openEuler 24.03-LTS-SP3 + iSulad
- 相关：[S3 eBPF I/O 观测](2026-09-19-synapse-ebpf-io-metering-design.md)、`src/runs/shared/*-adapter.ts`、`src/runs/background/async-execution.ts`

## 1. 背景

赛题鼓励"结合 IPC、共享内存、Socket、WASM/容器沙箱、eBPF 等系统技术提升实现质量"。
iSulad 是 openEuler 自己的容器引擎，其 `--ipc container:<id>` 共享 IPC namespace 是原生机制
（[官方文档](https://docs.openeuler.org/zh/docs/24.03_LTS_SP4/cloud/container_engine/isula_container_engine/container_resource_management.html)）。

本仓库今天的子 Agent 是**同机 Node 子进程**：`async-execution.ts:726` 用 `spawn(command, args, {cwd, env, stdio})`
启动，共享父进程的 worktree、继承环境变量与 stdout/stderr 文件描述符。

S1 把这层换成：每个 Agent 一个 iSulad 容器，容器之间共享 IPC namespace 与 `/dev/shm`。

### 1.1 为什么 S1 本身不产生性能收益

必须说清楚：**S1 一分不加。** 它不让任何东西变快，也不减少任何字节。
它的全部价值是成为 S2 的前置——没有共享 IPC namespace，`/dev/shm` 就跨不了容器，
S2 的跨进程共享内存数据面无从谈起——以及为 S3 提供一个结构性正确的归因键。

把 S1 当作独立交付物来评估会得出"不值得做"的结论。它只应在确定要做 S2 时才做。

## 2. 范围

### 2.1 做

- 一个 iSulad 启动适配器，把子 Agent 的启动表达为 `isula run --ipc container:<parent> ... -- pi ...`。
- 一份**路径映射契约**：容器内路径与宿主路径的对应关系，以及它如何传达给采集器。
- 容器生命周期与现有 runner 生命周期的对接：kill / cancel / 进程树归属 / 日志捕获。
- 一个明确的降级路径：iSulad 不可用时退回今天的 `spawn`，且该退化**可见**。

### 2.2 不做

- 不做跨节点。Kmesh 与 Gazelle 不在范围内——同机 Agent 之间没有 TCP 可治理，
  引入它们只会得到"论文里写了但实验证不出来"的部分。
- 不做 Kuasar 多沙箱运行时。它解决的是隔离强度，不是通信。
- 不改 SYNAPSE 的协议、状态或记忆层。
- 不把容器化设为默认。默认仍是今天的进程模型。

## 3. 架构

### 3.1 接缝：启动适配器，而非 `async-execution.ts`

本仓库已有一层外部 runner 适配器（`src/runs/shared/codex-exec-adapter.ts`、`claude-code-adapter.ts`、
`cursor-agent-adapter.ts`），形状为：

```ts
{ command, args, environment: { allowlist }, preflight, parser }
```

`isula run ... -- pi ...` 可以表达为同一层的**启动包装**，不必改动 `async-execution.ts`
那个 5000 行的上游热点。这符合 VISION「Scope must earn size」对 launch path 的约束：

> Broad changes need approval before they expand across launch paths, public APIs, persistence,
> or runner lifecycle code.

**设计约束：容器化必须落在适配器层。** 任何需要修改 `async-execution.ts` 的方案都应先退回重新设计，
或取得 owner 的明确批准。

### 3.2 容器拓扑

```text
              宿主：Pi 父会话（不在容器内）
                         │
            isula run --ipc container:<anchor>
                         │
   ┌─────────────────────┼─────────────────────┐
   │                     │                     │
┌──┴────────┐      ┌─────┴─────┐        ┌──────┴────┐
│ Agent A   │      │ Agent B   │        │ Agent C   │
│ 容器       │      │ 容器       │        │ 容器       │
└──┬────────┘      └─────┬─────┘        └──────┬────┘
   │                     │                     │
   └─────── 共享 IPC namespace + /dev/shm ──────┘
                         │
              worktree 以 bind mount 挂入
```

需要一个 **anchor 容器**持有 IPC namespace，其余容器 `--ipc container:<anchor>` 加入。
anchor 的生命周期必须长于任何 Agent 容器——这是要在实现计划里明确验收的一条。

## 4. 关键决策

### 4.1 路径映射是 S1 最重要的产出，不是容器本身

S3 的最终评审发现了一个 Critical，其根因正是 S1 将要引入的东西：

> 宿主上的采集器看到**宿主路径**，容器里的 Pi 用**容器路径**。根不匹配是这套部署下
> 预期中的第一个故障，不是边缘情况。

而 S3 的实测证明，**部分**不匹配（一部分路径 bind-mount 一致、一部分不一致）比全量不匹配更隐蔽：
100 B 落在根内、10,000,000 B 落在根外时，账面一度显示"无缺口通过"。

因此 S1 必须交付的不只是"容器跑起来了"，而是：

1. **worktree 与存储根在容器内外使用同一绝对路径**（bind mount 到相同挂载点），使路径天然一致；
   若做不到，则
2. 交付一个**显式的路径映射表**，并让 S3 的采集器或 joiner 据此换算；且
3. 无论走哪条，都必须有一个**验收实验**证明映射正确：容器内写入的字节，在宿主侧采集器的账里
   落进正确的类别，而不是 `outsideRoot`。

方案 1 更可取，因为它让映射问题消失而不是被管理。只有当 bind mount 到同路径不可行时才用方案 2。

### 4.2 归因键从 `(pid, startTicks)` 换成 cgroup id

S3 的归因键刻意封装在单个函数内（`attributionKeyOf`），就是为了这次替换。
一个容器一个 cgroup，cgroup id → 容器 → Agent 是确定性映射，不像 PID 会复用。

S1 落地后，S3 的归因从"可判定"升级为"结构性正确"，并顺带关掉一个已记录的已知限制
（`(pid, startTicks, fd)` 表在 fork 继承 fd 上的盲区）。

### 4.3 降级必须可见

iSulad 不可用、镜像缺失、IPC namespace 加入失败——这些情况下退回 `spawn` 是可以接受的，
但**不得静默**。运行产物里必须能区分"这次跑在容器里"和"这次退回了进程模型"，
否则 S2 的实验会把两种拓扑的数据混在一起而无人察觉。

这与 S3 的 `unavailable` / `"N/A"` 纪律同源：不能产出的量与没报上来的量是两件事。

## 5. 失败行为

| 情况 | 处理 |
|---|---|
| iSulad 不存在或不可执行 | preflight 阶段报出具体原因，退回 `spawn`，在产物中标记拓扑为 `process` |
| anchor 容器启动失败 | 同上，不得让 Agent 容器各自持有独立 IPC namespace（那会静默破坏 S2 的前提） |
| Agent 容器加入 IPC namespace 失败 | 拒绝启动该 Agent，而非降级为隔离容器——静默隔离会让 S2 的共享内存读不到对端 |
| 容器被外部杀死 | 与现有 runner 的 kill/cancel 语义对齐，进程树归属须明确 |
| worktree 挂载失败 | 拒绝启动。子 Agent 拿不到代码时不应"成功"运行 |

## 6. 测试与验收

现有 CI 跑 Ubuntu 与 Windows，没有 iSulad。分层同 S3：

**CI 层（纯函数）**：适配器的参数构造、preflight 判定、降级决策、路径映射换算——
这些都是把输入映射到 `{command, args, env}` 的纯函数，可在 Windows 上证明。

**openEuler 真机层（手动，出报告）**：

1. **IPC 共享真的生效** —— 在 A 容器创建一个 POSIX 共享内存对象，B 容器能打开它。
   这是 S2 的前置条件，必须先于 S2 证明。
2. **路径一致性** —— 容器内写入的文件，宿主侧采集器的账里落进正确类别（见 §4.1）。
   这是 S3 那条 Critical 的直接回归测试。
3. **降级可见** —— 故意让 iSulad 不可用，断言产物标记为 `process` 拓扑而非静默通过。
4. **生命周期** —— kill / cancel / 父会话退出时容器不泄漏。

## 7. 开放风险

- **iSulad 在目标机上的可用性未验证。** 若目标环境只有 docker/podman，`--ipc container:` 语义相同，
  但 preflight 与命令构造需要抽象一层。这会改变 §3.1 的适配器形状。
- **Node 24 在 openEuler 24.03-LTS-SP3 上的可得性未验证。** 容器镜像需要它。
- **stdout/stderr 捕获方式会变。** 今天父进程 `openSync` 日志文件并把 fd 交给子进程
  （`async-execution.ts:715-729`）；容器化后 fd 无法跨容器传递，日志捕获须改走容器引擎的机制。
  **这会改变 S3 观测到的 `unknownDescriptor` 字节构成**——S3 目前依赖"继承 fd 上的写入恒存在"
  这一事实，S1 落地后该事实可能不再成立，需重新验证 S3 的相关测试。

## 8. 交付边界与后续

S1 交付后，仓库获得的是：一个可选的、默认关闭的容器化拓扑，以及一份被实验证明正确的路径契约。

它**不会**让任何东西变快。它使 S2 成为可能，并使 S3 的归因结构性正确。

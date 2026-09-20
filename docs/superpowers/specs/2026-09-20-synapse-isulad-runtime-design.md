# S1：iSulad 容器化运行时设计

- 日期：2026-09-20
- 状态：设计草案，待评审
- 目标平台：openEuler 24.03-LTS-SP3 + iSulad（引擎不写死，见 §3.3）
- 相关：[S3 eBPF I/O 观测](2026-09-19-synapse-ebpf-io-metering-design.md)、`src/runs/background/async-execution.ts:726`、`src/synapse/trace-attribute.ts`

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

- 一个纯函数 `resolveContainerLaunch`（`src/runs/shared/container-launch.ts`），
  把子 Agent 的启动改写为 `isula run --ipc container:<anchor> ... -- <原命令>`；
  `async-execution.ts` 只增加一行调用（§3.1）。
- 一份**路径对齐契约**：四个路径根在容器内外使用同一绝对路径，对齐不了就拒绝启动（§4.1）。
- 容器生命周期与现有 runner 生命周期的对接：kill / cancel / 进程树归属 / 日志捕获。
- 一个明确的降级路径：容器引擎不可用时退回今天的 `spawn`，且该退化**可见**（§4.3）。
- 一个自包含的真机验收脚本包，输出结构化 JSON 报告（§6）。

### 2.2 不做

- 不做跨节点。Kmesh 与 Gazelle 不在范围内——同机 Agent 之间没有 TCP 可治理，
  引入它们只会得到"论文里写了但实验证不出来"的部分。
- 不做 Kuasar 多沙箱运行时。它解决的是隔离强度，不是通信。
- 不改 SYNAPSE 的协议、状态或记忆层。
- 不把容器化设为默认。默认仍是今天的进程模型。

## 3. 架构

### 3.1 接缝：一个纯函数，加一行调用

本仓库确实有一层外部 runner 适配器（`src/runs/shared/codex-exec-adapter.ts`、`claude-code-adapter.ts`、
`cursor-agent-adapter.ts`），形状为 `{ command, args, environment: { allowlist }, preflight, parser }`。
**但它不是 S1 的接缝。** 那一层由 `subagent-runner.ts:975` 调用，而 `subagent-runner` 本身
运行在 `async-execution.ts:726` 已经 spawn 出来的子进程*内部*——适配器层在要被容器化的进程的下一层，
它启动的是第三方 CLI，不是 Pi 子 Agent。把容器化放在那里，S2 的跨进程共享内存仍然无从谈起。

S1 要容器化的就是 `:726` 这个 spawn。接缝因此是：

```ts
// src/runs/shared/container-launch.ts
resolveContainerLaunch(input: {
	topology: "process" | "container";
	engine: ContainerEngineSpec;            // §3.3
	anchorContainerId: string;
	identicalPathRoots: readonly string[];  // §4.1
	launch: { command: string; args: readonly string[]; cwd: string };
}): {
	command: string;
	args: string[];
	topology: "process" | "container";
	degradedReason?: string;
}
```

容器命令构造、preflight 判定、降级决策、路径根校验全部落在这个纯函数里，
`async-execution.ts` 只在 `:726` 之前增加**一行调用**，`spawn` 本身不变。

**设计约束（取代原先的「不得改动 `async-execution.ts`」）：容器化逻辑必须全部落在纯函数中，
`async-execution.ts` 的改动面限定为一行调用。** 任何需要在该文件中新增分支、状态或生命周期逻辑的方案，
都应先退回重新设计。

这一行仍然触及 launch path，因此仍受 VISION「Scope must earn size」约束：

> Broad changes need approval before they expand across launch paths, public APIs, persistence,
> or runner lifecycle code.

**实现计划必须把这一行的 owner 批准列为显式前置项**，而不是在改动发生后才发现需要批准。

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
        §4.1 的四个路径根以 bind mount 挂入同一绝对路径
```

需要一个 **anchor 容器**持有 IPC namespace，其余容器 `--ipc container:<anchor>` 加入。
anchor 的生命周期必须长于任何 Agent 容器——这是要在实现计划里明确验收的一条。

### 3.3 容器引擎是一张命令构造表，不是一个写死的二进制名

目标 openEuler 服务器不在开发机上，其 iSulad 是否已安装在动工时无法当场确认。
因此引擎不写死为 `isula`：

```ts
type ContainerEngineSpec = { id: "isula" | "docker" | "podman"; binary: string };
```

三者在本设计用到的全部语义相同——`--ipc container:<id>` 加入既有 IPC namespace、
`-v <host>:<container>` bind mount、`--rm` 自动清理。差异只在二进制名与 preflight 的版本字符串形状。
在纯函数里这是一张表加三行；事后再抽象，则要改动一个已评审的函数签名。

**只实现 `isula` 一档的构造与 preflight，`docker` / `podman` 作为表中的第二、三行同时给出。**
这不是"以防万一的通用化"——它是把一个未验证的环境假设，从函数签名里挪出去的最便宜的办法。

## 4. 关键决策

### 4.1 路径对齐是 S1 最重要的产出，不是容器本身

S3 的最终评审发现了一个 Critical，其根因正是 S1 将要引入的东西：

> 宿主上的采集器看到**宿主路径**，容器里的 Pi 用**容器路径**。根不匹配是这套部署下
> 预期中的第一个故障，不是边缘情况。

而 S3 的实测证明，**部分**不匹配（一部分路径 bind-mount 一致、一部分不一致）比全量不匹配更隐蔽：
100 B 落在根内、10,000,000 B 落在根外时，账面一度显示"无缺口通过"。

#### 要对齐的是四个根，不是两个

`async-execution.ts:721-739` 交给子进程的 args 与 env 里带的全是**宿主绝对路径**。
因此"同路径"要覆盖的不止 worktree 与存储根：

| 根 | 来源 | 如何固定为同路径 |
|---|---|---|
| worktree | `spawn` 的 `cwd` | bind mount 到相同挂载点 |
| SYNAPSE 存储根 | 配置 | bind mount 到相同挂载点 |
| `TEMP_ROOT_DIR`（`cfgPath`、`asyncDir`、日志） | `PI_SUBAGENTS_TEMP_ROOT`（`src/shared/types.ts:2794`） | **显式设为可挂载的固定路径**，不用 `os.tmpdir()` 下的随机 scope 目录 |
| Pi 安装根 | `piPackageRoot` / `binaryHost` / runner 源码路径 | 镜像内置于同一路径，或 bind mount |

`TEMP_ROOT_DIR` 可由环境变量覆盖这一点是关键：它让"容器内外同一绝对路径"从一个愿望变成一项可配置的事实。

#### 因此 S1 必须交付

1. **上表四个根在容器内外使用同一绝对路径**，使路径不匹配问题消失而非被管理；
2. `resolveContainerLaunch` 在任一根未被 `identicalPathRoots` 覆盖时**拒绝构造容器命令**，
   改为退回 `process` 拓扑并附 `degradedReason`——而不是启动一个路径会错位的容器。
   静默错位正是本节开头那条 Critical 的成因。
   注意这与 §5 中「anchor 启动失败」「IPC namespace 加入失败」两行的处理**不同**：
   那两种情况必须拒绝启动该 Agent，因为一个静默隔离的容器会让 S2 读不到对端；
   而路径错位不妨碍 Agent 正常工作，只会污染账目，所以可见地降级到进程模型是正确的处理；
3. 一个**验收实验**证明对齐正确：容器内写入的字节，在宿主侧采集器的账里落进正确的类别，
   而不是 `outsideRoot`。

**原先作为备选的"显式路径映射表 + 由采集器换算"方案予以删除。**
要换算的是四个根而非两个，且部分对齐比全量不对齐更隐蔽（见上文 100 B / 10,000,000 B 的实测）——
映射表只会让 S3 那条 Critical 换个地方复发。对齐不了就拒绝启动，是唯一不会静默出错的选择。

### 4.2 归因键从 `(pid, startTicks)` 换成 cgroup id

S3 的归因键刻意封装在单个函数内（`attributionKeyOf`），就是为了这次替换。
一个容器一个 cgroup，cgroup id → 容器 → Agent 是确定性映射，不像 PID 会复用。

S1 落地后，S3 的归因从"可判定"升级为"结构性正确"，并顺带关掉一个已记录的已知限制
（`(pid, startTicks, fd)` 表在 fork 继承 fd 上的盲区）。

### 4.3 降级必须可见

容器引擎不可用、镜像缺失、路径根对不齐——这些情况下退回 `spawn` 是可以接受的，
但**不得静默**。运行产物里必须能区分"这次跑在容器里"和"这次退回了进程模型"，
否则 S2 的实验会把两种拓扑的数据混在一起而无人察觉。

这与 S3 的 `unavailable` / `"N/A"` 纪律同源：不能产出的量与没报上来的量是两件事。

## 5. 失败行为

| 情况 | 处理 |
|---|---|
| 表中所有容器引擎都不存在或不可执行（§3.3） | preflight 阶段报出具体原因，退回 `spawn`，在产物中标记拓扑为 `process` 并附 `degradedReason` |
| 任一路径根无法对齐到同一绝对路径（§4.1） | 拒绝构造容器命令，退回 `process` 拓扑并附 `degradedReason`；不得启动路径错位的容器 |
| anchor 容器启动失败 | 同上，不得让 Agent 容器各自持有独立 IPC namespace（那会静默破坏 S2 的前提） |
| Agent 容器加入 IPC namespace 失败 | 拒绝启动该 Agent，而非降级为隔离容器——静默隔离会让 S2 的共享内存读不到对端 |
| 容器被外部杀死 | 与现有 runner 的 kill/cancel 语义对齐，进程树归属须明确 |
| worktree 挂载失败 | 拒绝启动。子 Agent 拿不到代码时不应"成功"运行 |

## 6. 测试与验收

现有 CI 跑 Ubuntu 与 Windows，没有 iSulad；目标 openEuler 服务器不在开发机上。分层同 S3：

**CI 层（纯函数）**：`resolveContainerLaunch` 的参数构造、引擎选择、preflight 判定、降级决策、
四个路径根的对齐校验，以及**真机报告的解析与断言**——这些都是纯函数，可在 Windows 上证明。

**openEuler 真机层：交付一个脚本包，而非一串手工步骤。**

服务器是远程的，所以验收不能是"照着文档手动敲一遍"——那样的结果没人重复得了，也无法回归。
S1 必须交付 `scripts/synapse/s1-acceptance.sh`：一次执行依次跑完下列各条，
输出一份**结构化 JSON 报告**（每条 pass / fail / unavailable，附证据字节数与实际路径）。
使用方式是把脚本包 `scp` 到服务器执行，取回 JSON 评审。

脚本只负责采集事实；判定阈值与"是否通过"的逻辑放在纯函数里，先在 Windows 上写测试。
`unavailable` 与 `fail` 必须可区分——这与 S3 的 `unavailable` / `"N/A"` 纪律同源。

1. **IPC 共享真的生效** —— 在 A 容器创建一个 POSIX 共享内存对象，B 容器能打开它且内容摘要一致。
   这是 S2 的前置条件，必须先于 S2 证明。
2. **路径一致性** —— 容器内写入的文件，在宿主侧采集器的账里落进正确类别（见 §4.1）。
   实验只在存储根内写入，因此 `outsideRoot` 必须恰为 0；且须同时写入一个小文件与一个大文件
   （量级参照 §4.1 的 100 B / 10,000,000 B），使"部分对齐"这种隐蔽情形也会被这条实验抓住。
   这是 S3 那条 Critical 的直接回归测试。
3. **降级可见** —— 故意让所有容器引擎不可用，断言产物标记为 `process` 拓扑并带 `degradedReason`，
   而非静默通过。
4. **生命周期** —— kill / cancel / 父会话退出时容器不泄漏，anchor 容器的存活覆盖所有 Agent 容器。
5. **S3 的 fd 前提重新验证** —— 见 §7：容器化改变了日志捕获方式，S3 依赖的
   "继承 fd 上的写入恒存在"可能不再成立。重跑 S3 的相关断言，记录 `unknownDescriptor`
   字节构成的变化。**这一条是 S1 可能打破 S3 的地方，必须实测，不能只作为风险登记。**

## 7. 开放风险

- ~~iSulad 在目标机上的可用性未验证。~~ **已由 §3.3 关闭**：引擎抽象为一张命令构造表，
  `isula` / `docker` / `podman` 三档语义相同，由 preflight 探测选档。
- **Node 24 在 openEuler 24.03-LTS-SP3 上的可得性未验证。** 容器镜像需要它。
  实现计划应把镜像构建排在真机验收之前，并在失败时给出具体的版本来源结论。
- **stdout/stderr 捕获方式会变。** 今天父进程 `openSync` 日志文件并把 fd 交给子进程
  （`async-execution.ts:715-729`）；容器化后 fd 无法跨容器传递，日志捕获须改走容器引擎的机制。
  **这会改变 S3 观测到的 `unknownDescriptor` 字节构成**——S3 目前依赖"继承 fd 上的写入恒存在"
  这一事实，S1 落地后该事实可能不再成立。**此项已升级为 §6 真机验收第 5 条**，须实测而非登记。
- **`PI_SUBAGENTS_TEMP_ROOT` 被固定为可挂载路径后的副作用未评估。** 该变量原本按 scope 隔离
  （`resolveTempScopeId()`），固定它会改变同机多会话之间的 temp 目录隔离性质。
  实现计划须确认这不会让两个并行会话互相写入对方的 `asyncDir`。

## 8. 交付边界与后续

S1 交付后，仓库获得的是：一个可选的、默认关闭的容器化拓扑，一份被实验证明正确的路径对齐契约，
以及一个可重复执行、产出结构化报告的真机验收脚本包。

它**不会**让任何东西变快。它使 S2 成为可能，并使 S3 的归因结构性正确。

验收报告本身是交付物的一部分：没有那份 JSON，S1 的五条真机结论就只是声称。

# 内核文件 I/O 实时观测

> **实验性。** 采集器尚未在真实内核上编译与实跑，接线工作见
> [system-observation-plan.md](system-observation-plan.md) 的遗留清单。在那之前，本文描述的是已实现的契约，
> 不是已验证的结论。

多 Agent 协作的开销大部分落在文件上：信封投递、内容对象读写、共享记忆索引更新。
应用层自己报的字节是自证；这个功能用 eBPF 从内核侧独立测一遍同样的事，用来定位重复读取、
频繁写入和慢 I/O。

## 快速开始

1. 按 [`native/synapse-io-collector/README.md`](../native/synapse-io-collector/README.md) 构建并由管理员启动采集器。
2. 在配置里打开：

```json
{
  "systemObservation": {
    "enabled": true,
    "socketPath": "/run/synapse-io/collector.sock"
  }
}
```

默认 `enabled: false`。关闭时不建立连接、不创建描述符、不启动任何轮询。
`socketPath` 接受绝对路径或 `~/` 开头的路径，缺省为 `/run/synapse-io/collector.sock`。
配置在会话启动时生效；未知键会被拒绝而不是忽略。

## 指标口径

| 指标 | 定义 |
|---|---|
| 读取／写入字节 | 内核读写操作**实际返回**的正数字节数。短读只记它真正搬了多少 |
| 操作次数 | 完成的 `vfs_read` / `vfs_write` / `vfs_readv` / `vfs_writev` 调用。一次向量写算一次 |
| 失败次数 | 返回负值的调用。不贡献字节 |
| I/O 耗时 | 该线程最外层 VFS 调用的入口到返回。嵌套调用不重复计时 |
| 平均耗时 | 累计时长 ÷ 被计时的操作数 |
| 近似 P95 | 由 32 桶对数直方图推出，显示为 `≤<桶上界>`。它是有界声明，不是采样分位数 |

分类按打开时的路径相对存储根判定：`envelopes/` 为信封，`objects/` 为内容对象，
`memory/`、`supersessions/`、`namespace.json` 为记忆索引与元数据。
`metering/` 与 `observation/` 完全排除，避免观测自身进入观测。
存储根下无法归类的路径记为 unclassified，不猜测。

### 这些数字不等于什么

- **不等于物理磁盘流量。** 这是 VFS 层字节，可能完全命中页缓存。
- **不等于端到端消息延迟。** 它是单次文件操作的内核耗时。
- **不等于逻辑信封字节。** 内核字节与 SYNAPSE 的 `envelopeBytes` 分栏展示，**不相加**：
  两者测的是不同的东西。`control.transportBytes` 仍然是 `"N/A"`。

## 覆盖状态

FleetView 显示五种状态之一：

| 状态 | 含义 |
|---|---|
| `active` | 快照在持续到达，没有缺口、没有丢失、登记不晚于任务开始 |
| `partial` | 有数据，但不是完整账。原因逐条列出（登记晚了多少毫秒、采集器重启、丢了多少条、几个文件没归类、进程被多个 Agent 共用） |
| `stale` | 连续 3 秒没有新快照，或连接已断。显示的是最后一次已知的累计值 |
| `unavailable` | 功能开着但没有测量：采集器没连上、平台不支持、这个运行没有登记进程 |
| `disabled` | `systemObservation.enabled` 为 false |

**未知值显示为 `—`，不显示为 `0`。** 这条和 `metering.ts` 的 `unavailable` 纪律是同一条。

## 归因

- 后台 run 是独立进程，按进程归因。
- 一个进程被多个 Agent 共用时，标为 `shared`，只汇总一次，不按 Agent 平分。
- 前台子 Agent 与宿主同进程，汇总显示一次，不重复分摊给每个子 Agent。
- pid 与进程启动时间（`/proc/<pid>/stat` 第 22 字段）一起校验，pid 复用不会串账。

## 失败行为

观测层不参与任务路径。以下情况全部只改变展示状态，不影响任务执行：

- 采集器没启动、socket 不存在、权限不足；
- 握手超过 300 ms（宿主继续执行任务，覆盖标为不完整）；
- 采集器中途崩溃或重启（旧区间封存，缺口显式记录，新区间重新累计，不重复计数）；
- 采集器说的协议版本对不上（客户端断开，而不是解析一半）；
- 平台不是 Linux。

Pi 退出只释放自己的登记与连接。采集器进程的生命周期归管理员。

## 运行产物

运行结束写入 `<storageRoot>/observation/<runId>.json`，与计量日志同级、同保留策略。
产物始终带自己的覆盖边界（watched / excluded 调用路径）和 `incompleteReasons`。
没有测到的运行也会写产物——否则读者无法区分"没有 I/O"和"没有观测"。

高频指标只进内存与产物，**不注入模型上下文**。

## 性能门禁

```sh
node test/perf/observation-overhead.mjs --out report.json --socket /run/synapse-io/collector.sock
```

固定文件交接负载，分别跑关闭／开启观测，覆盖 1、4、8 个后台进程，预热后每组至少 30 次。
门禁：中位数增幅 ≤5%，P95 增幅 ≤10%。采集器不可达时脚本判定 `not-evaluated` 并以非零退出——
没跑到的门禁不算通过。

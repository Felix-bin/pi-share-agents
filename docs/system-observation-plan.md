# eBPF 文件 I/O 实时观测：任务拆分与进度

> 范围与口径见本文 §0 的约束摘要；技术选型背景见 [system-tech-research.md](system-tech-research.md) §2.3。
> 面向使用者的安装与指标说明见 [system-observation.md](system-observation.md)。

本文是实现清单，不是设计文档。每一项要么可验收，要么标明为什么还不能验收。

## 0. 不可协商的约束

1. 观测失败不得影响任务。连接不上、没有权限、平台不支持、采集器崩溃，全部只改变展示状态。
2. 缺证据显示为 `unavailable`，不显示为 `0`。这是 `src/synapse/metering.ts` 已有的纪律，观测层沿用。
3. 内核字节与逻辑信封字节分栏展示，不相加。`control.transportBytes` 仍为 `"N/A"`。
4. `npm install` 不编译任何原生代码。采集器单独构建、由管理员启动。
5. 未在真实 Linux 上实跑之前，功能标记为实验性，不得宣称"低开销"。

---

## 阶段一：内核采集验证

- [x] T1.1 定义线协议常量与内核侧数据结构（`native/synapse-io-collector/src/protocol.h`）
- [x] T1.2 eBPF CO-RE 程序：VFS 读写入口/返回探针，按 (pid, 类别) 聚合（`src/synapse_io.bpf.c`）
- [x] T1.3 文件分类：登记的存储根 + 路径前缀 → envelope / content / memory-index / unclassified
- [x] T1.4 延迟对数直方图（内核侧 32 桶累计，P95 在用户态/TS 侧近似计算）
- [x] T1.5 固定容量映射 + 溢出/丢失计数，绝不阻塞业务进程
- [x] T1.6 用户态加载器与能力探测（BTF、探针可挂载性、平台/架构）（`src/synapse_io.c`）
- [x] T1.7 确定性 I/O 测试程序，用于字节对账（`tests/io_workload.c`）
- [x] T1.8 构建与自检脚本（`Makefile`、`make check`）
- [ ] **T1.9 在 x86_64 Linux 6.6 上实跑并对账**（阻塞项：本机为 Windows，无法执行）

验收：已知字节的读写可精确对账；短读写、失败返回、重复读取、临时文件、重命名、多线程均正确；
不读取文件正文；缺少 BTF 或探针时报出具体原因而不是静默降级。

## 阶段二：运行关联与容错

- [x] T2.1 配置项 `systemObservation.enabled` / `socketPath`，默认关闭，未知键拒绝（`src/observation/config.ts`）
- [x] T2.2 版本化逐行 JSON 协议的编解码与边界校验，含消息大小上限（`src/observation/protocol.ts`）
- [x] T2.3 客户端：握手 300 ms 预算、登记、注销、断线不重试成阻塞（`src/observation/client.ts`）
- [x] T2.4 累计快照聚合：按序号去重、采集器实例换代、缺口记录、共享进程标记（`src/observation/aggregate.ts`）
- [x] T2.5 对数直方图 → 近似 P95（`src/observation/histogram.ts`）
- [x] T2.6 运行结束写出观测产物，含覆盖区间与缺口说明（`src/observation/artifact.ts`）
- [x] T2.7 单元测试覆盖上述全部分支（60 个用例，Windows/Linux 通用）
- [ ] **T2.8 与后台 Runner / 宿主接线**（待 owner 批准：改动触及启动路径与 runner 生命周期，
      按 [VISION.md](../VISION.md)「Scope must earn size」需要先批准；且真实价值要等 T1.9）

验收：并发运行不串账；PID 复用、共享 Runner、进程退出、采集器重启与重连不产生错误归因或重复累计；
中途启用不能报告为全程覆盖。

## 阶段三：实时展示

- [x] T3.1 投影函数：读写字节、操作次数、耗时、状态标签（`src/observation/render.ts`）
- [x] T3.2 五种状态 `active / partial / stale / unavailable / disabled`，3 秒无快照判定过期
- [x] T3.3 详情标注"后台独立进程"/"共享进程汇总"，并显示观测缺口
- [x] T3.4 关闭时零连接、零额外轮询（`resolveObservationStartup` 在构造任何描述符前返回，测试验证连接函数零次调用）
- [ ] **T3.5 接入 `src/runs/background/fleet-view.ts` 的渲染点**（同 T2.8，待批准）

投影只读内存，不扫描目录、不调外部命令、不读内核映射——这是接入 FleetView 刷新循环的前提。

验收：正常负载下指标 2 秒内可见；断连显示过期；未知值不显示为零；前台汇总不重复统计。
前四项已由单元测试覆盖，"2 秒内可见"要等 T3.5 与真实采集器。

## 阶段四：回归与性能门禁

- [x] T4.1 Windows/Linux 常规单元测试（配置、协议、聚合、投影、失败路径）
- [x] T4.2 性能对照脚本：固定文件交接负载，关闭/开启观测，1/4/8 进程（`test/perf/observation-overhead.mjs`）
- [ ] **T4.3 特权 Linux 测试验证真实 eBPF 行为**（阻塞项：同 T1.9）
- [ ] **T4.4 跑满性能门禁并出报告**（阻塞项：需要 T4.3 的真实采集器）

门禁：任务耗时中位数增幅 ≤5%，P95 增幅 ≤10%；记录采集器 CPU、内存、丢失计数与环境信息。
未通过则继续缩减采集成本，不得默认启用，不得宣称"低开销"。

---

## 遗留与已知边界

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 eBPF 行为验证 | 未完成 | 开发机为 Windows；采集器代码已写但未编译、未实跑 |
| Runner / FleetView 接线 | 待批准 | 触及启动路径、runner 生命周期与 FleetView 刷新三个面，VISION 要求先批准；且无法在本机端到端验证 |
| 性能门禁数据 | 未完成 | 同上；脚本已就绪并自测可跑，采集器不可达时判定 `not-evaluated` 且非零退出 |
| 容器 PID 命名空间 | 不支持 | 首版只做宿主机进程 |
| 远程主机 | 不支持 | socket 为本机 UDS |
| 前台每 Agent 内核归因 | 不支持 | 前台子 Agent 在同进程内，只做汇总一次 |
| `mmap` / `io_uring` | 不覆盖 | 覆盖声明里显式排除，不在完整覆盖中声称 |

**完成标准（尚未达成）**：用户可在真实后台协作任务运行时，看到可追溯的文件 I/O 指标及其覆盖边界；
关闭或损坏观测系统，原有多智能体协作仍能正常运行。后半句已由当前代码保证（观测默认关闭且全路径失败安全），
前半句需要 T1.9 / T2.8 / T4.3 完成后才能声称。

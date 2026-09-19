# S3 eBPF I/O 观测与归因 实现计划

**目标：** 在 openEuler 上跑一次对照实验后，能拿到一份可溯源、可离线重算的内核侧 I/O 账，
按 `{runId, nodeId, agent, attempt}` 归因，并在证据不全时报 `unavailable` 而不是残缺数字。

**范围：** `src/synapse/`（新增归因与解析模块，`metering.ts` 与 `delegation.ts` 各改一处）、
`test/unit/`、采集器（新增，不随 `npm install` 编译）。

**Spec：** [2026-09-19-synapse-ebpf-io-metering-design.md](../specs/2026-09-19-synapse-ebpf-io-metering-design.md)

## 全局约束

- 产品代码的改动**只有** `process-identity` 事件。不碰启动路径，不改
  `src/runs/background/async-execution.ts`。
- Task 2–6 的全部逻辑必须是纯函数，在 Windows 与 Ubuntu CI 上可测：不需要内核、不需要 root、
  不碰文件系统。这是"采集只能在 openEuler 发生，但正确性必须在 CI 被证明"的解法。
- 不改 `aggregateMetering` 的签名。现有调用方行为逐字段不变。
- 证据不全一律 `unavailable`，无采集一律 `N/A`，两者不可互相替代。
- 测试按现有约定落在 `test/unit/synapse-*.test.ts`；每个任务以
  `npm run test:unit` 与 `npm run typecheck` 全绿为完成条件。
- `npm install` 不编译任何原生代码。

---

### Task 1: 真机验证内核侧进程启动时间可得性

- [ ] Change: 在目标 openEuler 24.03-LTS-SP3 机器上执行 spec §8.1 的四条命令，确认
      `/sys/kernel/btf/vmlinux` 存在、探针可挂载、`curtask->group_leader->start_time`
      能取到非零值。记录 `uname -r` 与 `/etc/openEuler-release`。
- Verify: 产出一份环境记录，明确回答归因键用 `(pid, startTicks)`（可判定）还是退回
      时间窗（PID 复用不可判定）。结果写回 spec §8.1，把开放风险项改成已定事实。
- 备注: **先做这个。** 它是唯一一个"验不过就要改设计"的点，而它只花几条命令。
      在它之前写归因逻辑，有把 Task 4 建在错误假设上的风险。

### Task 2: `process-identity` 计量事件

- [ ] Change: `metering.ts` 的 `MeteringPayload` 增加 `process-identity` kind，
      携带 `pid`、`startTicks`（`/proc/self/stat` 第 22 字段）、`uptimeAtRecordSeconds`
      （`/proc/uptime` 第一个字段）。在 `delegation.ts` 的 `createDelegationDeps` 中记录一次。
- Verify: Linux 上父子两侧各产生一条事件且字段可解析；非 Linux 平台上 `/proc` 不存在时
      **不记录该事件且不抛错**；`aggregateMetering` 遇到这个新 kind 时输出与不带它时逐字段一致
      （它不参与任何既有累加）。
- Depends on: Task 1（决定是否需要 `startTicks`）

### Task 3: trace 输出契约与解析器

- [ ] Change: 定义采集器逐行 JSON 的线协议（`{pid, tid, startTicks, nsecs, syscall, fd, path?, bytes, ret}`），
      实现解析器与边界校验。识别采集器的事件丢失报告行。
- Verify: 固定样本输出能被正确解析；字段缺失、类型错误、超长行被拒绝而不是部分解析；
      **丢失报告行被识别**（这条是诚实性的关键路径，不能只靠真机撞上才发现）；
      `ret < 0` 计入失败计数且不贡献字节，`ret > 0` 按实际返回值计字节（短写只记真正搬了多少）。

### Task 4: fd → path 映射与路径分类

- [ ] Change: 从 trace 记录重建 `(pid, fd) → path`，并按存储根相对前缀分类为
      envelope / content / memory-index / unclassified。`metering/` 与 `trace/` 显式排除。
- Verify: 覆盖 spec §4.2 的全部边界——fd 继承、`dup`/`dup2`、进程退出清理、fd 关闭后复用；
      **`renameat2` 跟随**：写入先落在 `.<basename>.<pid>.<ms>.<rand>.tmp`、rename 后才成为
      最终路径，归类必须跟随 rename（不跟随时所有写入会静默掉进 `unclassified`，
      用一个专门的测试钉死这条）；存储根外的路径不计入；无法归类的记 `unclassified` 而不猜测。
- Depends on: Task 3

### Task 5: 归因与判定

- [ ] Change: 从 `process-identity` 事件建 `(pid, startTicks) → MeteringIdentity` 映射，
      对齐两侧时钟（trace 的 boot-based `nsecs` 与 metering 的每进程 hrtime 不同源，
      经 `startTicks` + `uptimeAtRecordSeconds` 换算到同一 "since boot" 基准），
      产出归因结果与诊断。归因键封装在单个函数内，便于 S1 落地后替换为 cgroup id。
- Verify: PID 复用（同 pid、两个 `startTicks`）分别归因不串账；孤儿记录进 `unattributed`
      并计数；采集器报丢失 → 整体 `unavailable`；`unattributed` 占比 > 1% → 整体 `unavailable`
      且无论是否触发都报告实际占比；空 trace → `N/A`；时钟换算无漂移。
- Depends on: Task 2, Task 4

### Task 6: `aggregateWithKernelIo` 汇总出口

- [ ] Change: 新增 `aggregateWithKernelIo(events, trace)`，返回既有 `MeteringTotals` 加内核侧分栏。
      内核字节与 `envelopeBytes` **分栏，不相加**；`control.transportBytes` 保持 `"N/A"`。
- Verify: 不带 trace 调用时输出与 `aggregateMetering` 逐字段一致；`aggregateMetering` 的签名
      与现有调用点均未改动；`transportBytes` 在任何输入下都是 `"N/A"`。
- Depends on: Task 5

### Task 7: 采集器

- [ ] Change: 实现 eBPF 采集器，挂 `sys_enter/exit_write`、`sys_enter/exit_read`、
      `sys_enter/exit_openat`、`sys_enter_renameat2`，按 Task 3 的契约输出到
      `<storageRoot>/trace/<runId>.ndjson`。固定容量映射 + 溢出计数，**绝不阻塞业务进程**。
      单独构建，由管理员启动，独立于 Pi 进程树。形态（bpftrace 脚本 / libbpf CO-RE）按 Task 1 的
      结果与"是否要求目标机预装 bpftrace"决定。
- Verify: 缺少 BTF 或探针挂不上时报出具体原因并退出，**不静默降级**；ring buffer 溢出时
      产生可被 Task 3 识别的丢失报告；不读取文件正文；采集器崩溃时业务进程不受影响。
- Depends on: Task 1, Task 3

### Task 8: openEuler 真机验收

- [ ] Change: 在目标机跑 spec §7.3 的三个验收点并出报告。
- Verify: **自洽性**——信封类内核字节 ≈ `2 × envelopeBytes` + 文件系统元数据开销，对不上即
      归因有错（这是可证伪的预测，不是"看起来合理"）；**可重复性**——同任务跑 3 次字节稳定，
      时延可波动；**诚实性**——故意调小 ring buffer 逼出丢失，断言结果确实变成 `unavailable`
      而不是悄悄给一个偏小的数。报告同时给出 §4.4 那个 1% 阈值该定在哪里的依据。
- Depends on: Task 6, Task 7

---

## 开放问题

- **采集器形态未定**（spec §8.2）。输出契约（Task 3）两种形态相同，joiner 与全部 CI 测试
  不受影响，因此不阻塞 Task 2–6。由 Task 1 的结果决定。
- Task 1 若判定 `curtask->group_leader->start_time` 不可访问，Task 5 的归因退回时间窗，
  其第一条验收（PID 复用可判定）随之改为"窗口边界上的记录一律计入 `unattributed`"。

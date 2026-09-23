# S1 iSulad 容器化运行时 实现计划

**Goal:** 一个默认关闭的容器化子 Agent 拓扑，四个路径根在容器内外对齐，降级可见；
并在远程 openEuler 上跑出一份结构化 JSON 验收报告，证明跨容器 IPC 共享生效（S2 的硬前置）。

**Scope:** `src/runs/shared/container-launch.ts`（新增）、`src/runs/background/async-execution.ts`（一行）、
`src/synapse/metering.ts` 的 `process-identity` 事件、`scripts/synapse/`（新增）、`test/unit/`。
不改 SYNAPSE 协议/状态/记忆层，不改 `subagent-runner.ts` 的外部 CLI 适配器层。

**Spec:** [2026-09-20-synapse-isulad-runtime-design.md](../specs/2026-09-20-synapse-isulad-runtime-design.md)

## Global Constraints

- **Task 3 的 `async-execution.ts` 改动需 owner 事先批准**（spec §3.1，VISION「Scope must earn size」
  对 launch path 的约束）。未获批准时 Task 1、2、5 仍可独立推进——它们不触及该文件。
- 容器化默认关闭。默认拓扑仍是今天的 `spawn`。
- 开发与 CI 在 Windows，真机在远程 openEuler。凡是只能在真机证明的结论，
  不得在 CI 层用 mock 假装已证明；未跑的验收记为 `unavailable`，不是 `pass`。
- 测试跟随现有约定：`test/unit/<module>.test.ts`，`npm run test:unit`。

---

### Task 1: `resolveContainerLaunch` 纯函数

- [x] Change: 新增 `src/runs/shared/container-launch.ts`，导出 `resolveContainerLaunch`
      与 `ContainerEngineSpec`（spec §3.1、§3.3）。职责：按引擎表构造 `isula run --ipc container:<anchor>
      -v <root>:<root> ... -- <原命令>`；校验四个路径根是否都被 `identicalPathRoots` 覆盖；
      产出 `{command, args, topology, degradedReason?}`。`isula` 一档完整实现，
      `docker` / `podman` 作为表中另两行同时给出。
- Verify: `test/unit/container-launch.test.ts` 在 Windows 上证明——
  (a) `topology: "process"` 时原样返回输入的 command/args；
  (b) 容器档构造出的 args 含 `--ipc container:<anchor>` 与每个根的 `-v <root>:<root>`；
  (c) 任一根未被覆盖时返回 `topology: "process"` 且 `degradedReason` 命名了**是哪个根**未覆盖，
      而不是一个笼统的失败字符串；
  (d) 三个引擎 id 各自构造出正确的二进制名，且其余参数形状一致。

### Task 2: 引擎 preflight 探测

- [x] Change: 在同一模块加入引擎探测：按表顺序探测可执行性与版本，选出第一个可用的
      `ContainerEngineSpec`；全部不可用时返回一个具名的不可用原因（spec §5 第一行）。
      探测的副作用（执行子进程）走可注入接缝，判定逻辑保持纯函数。
- Verify: 单测覆盖「首选可用」「首选缺失回退次选」「全部缺失」三条路径，
  第三条的原因字符串须区分"二进制不存在"与"存在但版本不被接受"。
- Depends on: Task 1

### Task 3: 接入 `async-execution.ts` 并让拓扑进入产物

- [x] Change: 在 `async-execution.ts:726` 的 `spawn` 之前增加一行 `resolveContainerLaunch` 调用，
      用其返回的 command/args 替换原值；`spawn` 的其余参数不变。
      同时把 `topology` 与 `degradedReason` 记入运行产物——候选载体是
      `src/synapse/metering.ts:59` 的 `process-identity` 事件（它已经是"把一个 OS 进程绑到一次 run"
      的那条记录，拓扑属于同一层事实）。
- Verify: `test/unit/async-execution.test.ts` 增加断言——默认配置下 spawn 收到的 command/args
  与改动前逐字相同（证明"默认关闭"不是声称）；容器档下 spawn 收到的是包装后的命令。
  产物侧断言 `process` 与 `container` 两种拓扑可区分，且降级时 `degradedReason` 非空。
- Depends on: Task 1、Task 2、**owner 对该文件改动的批准**

### Task 4: 容器镜像与 anchor 容器生命周期

- [x] Change: 提供镜像构建方式（Node 24 + Pi 安装根置于与宿主相同的绝对路径，spec §4.1 第四行），
      以及 anchor 容器的创建与销毁：anchor 必须先于任何 Agent 容器创建、后于其全部退出才销毁。
      Agent 容器加入 IPC namespace 失败时拒绝启动该 Agent（**不**降级为隔离容器，spec §5）。
- Verify: 这一条的正确性只能在真机证明，由 Task 7 的验收 1 与 4 覆盖。
  本任务在 CI 层可证的部分是生命周期的**决策函数**（给定 anchor 状态与 Agent 请求，
  应允许启动 / 拒绝 / 等待），单测覆盖三种输出。
  Node 24 在 openEuler 24.03-LTS-SP3 上的可得性若不成立，在此任务给出具体结论与替代来源，
  不要让它以"镜像构建失败"的形式在验收阶段才暴露（spec §7）。
- Depends on: Task 1

### Task 5: 验收报告的解析与断言

- [x] Change: 定义 JSON 报告的形状（每条验收：`pass` / `fail` / `unavailable`，附证据字节数与实际路径），
      并实现解析与判定的纯函数。`unavailable`（没跑）与 `fail`（跑了没过）必须是两种结论，
      不得合并——与 S3 的 `unavailable` / `"N/A"` 纪律同源（spec §6）。
- Verify: 单测用夹具报告证明——全 pass 的报告判为通过；任一条 `fail` 判为不通过；
  任一条 `unavailable` 既不判通过也不判失败，而是报出"哪一条未跑"；
  缺字段或字节数为负的畸形报告被拒绝而非默认通过。

### Task 6: 真机验收采集脚本

- [x] Change: 新增 `scripts/synapse/s1-acceptance.sh`，一次执行依次采集 spec §6 的五条，
      输出 Task 5 定义形状的 JSON。脚本只采集事实，不做判定。
      五条依次为：跨容器 IPC 共享、路径一致性（小文件与大文件各一，量级参照 100 B / 10,000,000 B）、
      降级可见、生命周期不泄漏、S3 的 fd 前提重验。
      须自包含到可直接 `scp` 到服务器执行。
- Verify: 脚本在无容器引擎的环境下运行时，五条全部输出 `unavailable` 并给出原因，
  而不是崩溃或输出 `fail`——这条可在本机验证。
  报告能被 Task 5 的解析函数接受。
- Depends on: Task 4、Task 5

### Task 7: 远程 openEuler 执行与报告归档

- [ ] Change: 把脚本包交付给人工上机执行，取回 JSON 报告并归档进仓库（连同执行环境的引擎与内核版本）。
- Verify: 报告经 Task 5 的判定函数给出结论。验收 1（A 容器建的共享内存对象，B 容器能打开且摘要一致）
  必须 `pass`——它不过，S2 无从开工，这是 S1 是否达成目标的单一判据。
  验收 2 的 `outsideRoot` 必须恰为 0。验收 5 记录 `unknownDescriptor` 字节构成的变化，
  若 S3 依赖的"继承 fd 上的写入恒存在"不再成立，产出一条给 S3 的具体结论而非笼统告警。
- Depends on: Task 3、Task 6

### Task 8: `PI_SUBAGENTS_TEMP_ROOT` 固定后的会话隔离验证

- [x] Change: 确认把 `TEMP_ROOT_DIR` 固定为可挂载路径后，同机并行会话不会互相写入对方的 `asyncDir`
      （spec §7）。该变量原按 `resolveTempScopeId()` 隔离，固定它改变了这一性质。
- Verify: 单测或集成测试证明两个并行会话在固定 temp 根下仍各自拥有独立的 `asyncDir`；
  若隔离确实被破坏，在此任务给出处理方式（例如在固定根之下保留 scope 子目录），
  而不是把它留到真机上以数据错乱的形式出现。
- Depends on: Task 1

## Open Questions

- **§4.2 的归因键替换（`(pid, startTicks)` → cgroup id）是否属于 S1？**
  spec §2.1 的"做"清单未列它，但 §4.2 与 §8 都说 S1 使 S3 的归因结构性正确。
  我的建议是**不在 S1 做替换**：真正的替换要求 S3 的采集器在 trace 事件里带上 cgroup id，
  那是对已评审的 S3 线协议的修改，应按 S3 的纪律走。S1 只做到让 cgroup id 可得
  并随拓扑一起记入产物（可并入 Task 3），替换本身留给 S3 的后续。
  若你认为替换应在 S1 内完成，这会新增一个依赖 Task 7 的任务，并把 S3 的线协议变更拉进范围。

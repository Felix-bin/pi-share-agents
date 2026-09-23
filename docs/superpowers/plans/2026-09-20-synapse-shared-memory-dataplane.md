# S2 跨进程共享内存数据面 实现计划

**Goal:** 信封投递走真实传输介质，`transportBytes` 成为可与内核账对账的真值；句柄第一次被兑现，
父→子之间只过引用（关闭已知缺口 #5）；内容对象落在 tmpfs 上且 S3 的归因口径不变。

**Scope:** `src/synapse/` 下新增 framing 与 socket 投递、`envelope-inbox.ts` 增加传输档位、
`metering.ts` 的 `transportBytes` 与一个新 payload、`delegation.ts` 的提示词拼装、
`src/runs/shared/subagent-prompt-runtime.ts` 的信封处理、`config.ts` 的档位键、
`scripts/synapse/`（新增）、`test/unit/`。
**不改** `container-launch.ts`、`access.ts` 的 scope 推导、`trace-classify.ts` 的单根不变量、
S3 的线协议。

**Spec:** [2026-09-20-synapse-shared-memory-dataplane-design.md](../specs/2026-09-20-synapse-shared-memory-dataplane-design.md)

## Global Constraints

- **socket 档默认关闭。** 默认传输仍是今天的原子写文件投递（spec §4.3：它同时是 S4 的对照组
  与 S1 降级时的退路）。档位走 `config.ts` 的 schema 而不是环境变量——该文件的既有理由是
  "实验配置里被静默丢弃的键会产出一次条件与清单不符的运行"，而传输档位正是 S4 的实验条件。
- **tmpfs 不是代码档位。** `<storageRoot>/objects` 的路径永远不变（spec §3.2），它是否落在
  tmpfs 上是环境事实，由 preflight 报告，不由配置声明。`content-store.ts` 零改动。
- 开发与 CI 在 Windows，真机在远程 openEuler。凡是只能在真机证明的结论，不得在 CI 层用 mock
  假装已证明；未跑的验收记为 `unavailable`，不是 `pass`（与 S1、S3 同源纪律）。
- **不修改 S3 的线协议。** Task 8 的产出是一条给 S3 的具体结论，不是一次契约变更。
- 测试跟随现有约定：`test/unit/<module>.test.ts`，`npm run test:unit`。

---

### Task 1: 长度前缀 framing 的编解码纯函数

- [x] Change: 新增 framing 模块，导出 `encodeFrame(bytes)` 与一个增量 `FrameDecoder`
      （喂任意切分的字节块，吐出零到多条完整帧）。4 字节大端无符号长度 + UTF-8 JSON 帧体
      （spec §3.1）。超过上限的长度前缀在读到前缀时即拒绝，**不分配缓冲区**；截断帧在流结束时
      是错误而不是静默丢弃。
- Verify: `test/unit/synapse-framing.test.ts` 在 Windows 上证明——
  (a) 对一条多帧字节流，**穷举每一个可能的切分位置**（含切在帧头中间），解出的帧序列逐字相同；
  (b) 声明长度超上限时解码器拒绝，且未分配该长度的缓冲区（以拒绝发生在消费帧体之前来证明）；
  (c) 字节流在帧体中途结束时报错，而不是返回一条短帧；
  (d) 零长度帧与恰好等于上限的帧都能往返。

### Task 2: AF_UNIX 投递档位

- [x] Change: `envelope-inbox.ts` 的发布/读取扩展出第二档：`uds` 走 AF_UNIX `SOCK_STREAM`
      + Task 1 的 framing，`file` 保持今天的原子写文件。档位由 `config.ts` 新增的键选择
      （schema 显式加键，否则会被既有的未知键拒绝逻辑挡下）。socket 端点路径与生命周期由
      本任务确定；I/O 走可注入接缝，选档与错误分类保持纯函数。
      `sun_path` 有 108 字节上限，端点路径必须在这个预算内构造，且超限是一个具名的拒绝
      而不是一个来自内核的截断。
- Verify: 单测证明——(a) 默认配置下走 `file` 档，且发布与读取的行为与改动前逐字相同
  （"默认关闭"不是声称）；(b) `uds` 档下一条信封经端点往返后与原信封逐字相同；
  (c) 对端不在时是具名的投递失败，**不是**"投递成功但内容为空"（spec §5）；
  (d) 端点路径超过 `sun_path` 预算时拒绝并命名超限的是哪一段。
- Depends on: Task 1

### Task 3: `transportBytes` 进计量

- [x] Change: `MeteringTotals.control.transportBytes` 的类型从 `NotApplicable` 放宽为
      `number | NotApplicable`，并新增一条记录实际过 socket 字节的 payload。
      `file` 档仍报 `"N/A"`，`uds` 档报数字。内核字节、`envelopeBytes` 与 `transportBytes`
      三者**分栏，互不相加**（spec §4.1，承 S3 §5.1 的纪律）。
- Verify: 单测证明——(a) 不含新 payload 的事件流聚合出的 `transportBytes` 仍是 `"N/A"`，
  且其余字段与 `aggregateMetering` 改动前逐字段一致；(b) `uds` 档的事件流聚合出的数字等于
  发出的帧总字节（含帧头）；(c) 任何输入下 `transportBytes` 都不进入 `envelopeBytes` 或
  内核字节的和。
- Depends on: Task 2

### Task 3a: 把 uds 档接进投递路径

> 本任务是执行期补入的。Task 2 交付后暴露出一个计划缺口：没有任何任务把 uds 档接进真实的投递
> 路径，于是这个档位存在但没有人走。后果不是少一个功能，而是 `transportBytes` 在真实运行里
> 恒为零，spec §4.1 的对账——S2 自称的核心验收——根本无从发生。

- [x] Change: `LaunchContract` 携带传输档位，使子侧知道该从哪里收；`delegation.ts` 的
      `publishEnvelope` 调用点按档位分流；`subagent-prompt-runtime.ts` 的信封校验从同步
      `readFileSync` 改为可等待的接收。**接收端必须早绑定**——惰性绑定会让父侧先发、子侧后听，
      信封落空。`file` 档的行为与时序必须逐字不变。
- Verify: 单测证明——(a) 默认 `file` 档下，`delegation.ts` 与子侧的调用序列与改动前逐字相同；
  (b) `uds` 档下一条信封从父侧发出、子侧收到，并通过既有的 `verifyEnvelopeAgainstContract`；
  (c) 接收端未就绪时是具名失败，**不是**"投递成功但内容为空"；
  (d) 同步改异步之后，「信封缺失不是失败」这条既有语义不变——父侧在协商拒绝或计量打不开时
      本来就会跳过投递，子侧那时必须照常运行上游的任务。
- Depends on: Task 2、Task 3

### Task 4: 句柄兑现

- [x] Change: `subagent-prompt-runtime.ts` 的信封处理保留 `delivered.wire` 而不是校验后丢弃；
      子进程启动时按 `memoryRefs` 用**它自己已注册的 MemoryService** 读取正文并拼进提示词
      （spec §4.2，确定性兑现，不依赖模型调工具）。`delegation.ts` 的提示词拼装在 synapse 档
      不再携带摘要行。兑现路径不得绕开 MemoryService 直接读 CAS 文件。
- Depends on: Task 3a（两者都改 `subagent-prompt-runtime.ts` 的信封处理；3a 先把它改成异步，
      本任务再在其上保留 `delivered.wire` 并兑现）
- Verify: 单测证明——(a) synapse 档下父侧提示词不再含记忆摘要段，而子侧兑现后的提示词含正文；
  (b) text 档的行为逐字不变（对照组不能被这个改动污染）；
  (c) 注入一个窄 scope 后，scope 之外的 `memoryId` 兑现被拒绝并归类为**权限错误**，
      而不是 `object-unavailable`（两者是不同的事实，spec §5）；
  (d) 对象不存在时走 `object-unavailable`，且这在重启后是预期结果而非失败（spec §4.4）。

### Task 5: tmpfs preflight 与 bind mount 交付物

- [x] Change: 新增 preflight：判定 `<storageRoot>/objects` 是否落在 tmpfs 上
      （`statfs` 的 `f_type` 或解析 `/proc/mounts`），判不出就拒绝启用共享内存档并**在产物中标记**
      （spec §5 第一行）。同时给出 bind mount 的交付物（脚本或手册），并在其中明确
      **必须用 mount 而非 symlink**——symlink 会被解析成 `/dev/shm/...` 而落进 `outside-root`，
      这是本设计里唯一容易做错且后果静默的地方（spec §3.2）。
      preflight 同时报告 tmpfs 的可用容量（spec §7 最后一条）。
- Verify: 单测把 `statfs` / `/proc/mounts` 的返回做成注入——(a) 非 tmpfs 判成拒绝且产物有标记；
  (b) tmpfs 判成通过并带出可用容量；(c) 在没有 `/proc` 的平台（Windows）上判成"无法判定"，
  这与"判定为非 tmpfs"是两种结论，不得合并；(d) 目标是 symlink 时被识别并拒绝。

### Task 6: S2 验收报告的形状与判定

- [x] Change: 定义 S2 验收报告的 JSON 形状与判定纯函数，沿用 S1 的三态纪律
      （`pass` / `fail` / `unavailable`，`unavailable` 既不判通过也不判失败）。
      复用 `scripts/synapse/judge-s1-report.ts` 已确立的模式，不重新发明一套。
      对账条目须同时携带应用层自报字节与内核侧观测字节，以及两者的差——**判定依据是差值**，
      不是任一单边的数字。
- Verify: 单测用夹具报告证明——全 pass 判为通过；任一 `fail` 判为不通过；任一 `unavailable`
  报出"哪一条未跑"；对账条目只有单边数字时判为 `unavailable` 而不是用零补齐另一边；
  畸形报告（缺字段、负字节）被拒绝而非默认通过。

### Task 7: 真机采集脚本

- [x] Change: 新增 `scripts/synapse/s2-acceptance.sh`，一次执行依次采集 spec §6.2 的四条，
      输出 Task 6 定义形状的 JSON。脚本只采集事实，不做判定。
      **验收 2（strace 观测）排在验收 3 之前**：它记录 Node 24 在 AF_UNIX 流上实际发出的
      syscall 序列，其输出决定 S3 要补哪些事件（spec §4.1）。须自包含到可直接 `scp` 执行。
- Verify: 脚本在无容器引擎、无 tmpfs 挂载的环境下运行时，四条全部输出 `unavailable` 并给出
  原因，而不是崩溃或输出 `fail`——这条可在本机验证。报告能被 Task 6 的判定函数接受。
- Depends on: Task 2、Task 5、Task 6

### Task 8: 远程 openEuler 执行、归档，与给 S3 的结论

- [ ] Change: 把脚本包交付人工上机执行，取回 JSON 报告并归档进仓库（连同引擎与内核版本）。
      据验收 2 的 strace 输出，产出一条**给 S3 的具体结论**：要补的事件集是什么、socket fd 的
      归因如何建立。不在本任务修改 S3 的契约。
- Verify: 报告经 Task 6 的判定函数给出结论。
  验收 1（跨容器可见性）与验收 3（对账）必须 `pass`——验收 3 是 S2 是否达成目标的单一判据，
  它同时证明 S2 的计量与 S3 的采集都是对的。
  给 S3 的结论必须是可执行的事件清单，不是"需要扩展 socket 观测"这类笼统告警。
- Depends on: Task 7、**S1 计划的 Task 7（真机验收报告）**

## Open Questions

- ~~**socket 端点放在存储根内还是根外？**~~ **已由 Task 2 回答：根内，`<storageRoot>/uds/`。**
  结论与原先的倾向一致，但理由不是原先那个。原以为取舍是"归类收益 vs 布局例外"；实测后发现
  归类收益是理论上的——`trace-classify.ts` 那张表按 `openat`/`renameat2` 的路径分类，
  `bind`/`connect` 从不产生这类事件，在 S3 补上 socket 事件之前两种放法都不会进 envelope 类目。
  真正起作用的是字节预算：`sun_path` 只有 108 字节（含内核 NUL 终止符，实际可用 107），
  `envelopes/`（10 字节）比 `uds/`（3 字节）多出的 7 字节足以让普通 home 目录下的部署路径超预算。
  于是选了更短的独立顶层目录，而不是嵌进 `envelopes/`。超预算是 `udsEndpointPath` 的一次具名
  拒绝（指出 storageRoot/runId/childIndex 哪一段最费字节），不是内核的截断。

- ~~**验收 4（A/B 可复现）属于 S2 还是 S4？**~~ **已定：留给 S4。**
  S2 只跑一次单轮对照——同一任务在 `file` 档与 `uds` 档各跑一次，记录字节与时延，
  **不判定稳定性**。"同任务、同模型、同种子"这套条件控制是 S4 实验框架的职责，S2 自己没有它，
  硬要在 S2 内证明等于先造半个 S4 并把 S2 的交付推到 S4 之后。
  因此 Task 6 的条目集是四条：跨容器可见性、strace 观测、`transportBytes` 对账，
  外加一条单轮对照——**它的 `pass` 只意味着"两档各跑了一次并各自报出了数字"，
  绝不断言可复现**，否则这条会变成一个 S2 给不出证据的声称。

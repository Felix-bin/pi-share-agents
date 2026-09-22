# S2 真机验收运行手册

写给：要在远程 openEuler 服务器上跑 S2 验收的人（开发在 Windows，验收在服务器）。

- 设计：[S2 跨进程共享内存数据面](../specs/2026-09-20-synapse-shared-memory-dataplane-design.md)
- 计划：[实现计划](../plans/2026-09-20-synapse-shared-memory-dataplane.md)
- 前一份：[S1 真机验收运行手册](./s1-acceptance-runbook.md)

## 这份验收要回答什么

一句话：**应用层说它放上 socket 的字节，和内核在那条 socket 上看到的字节，对不对得上。**

这是 S2 是否达成目标的**单一判据**。它同时证明两件事：S2 的计量是对的，S3 的采集也是对的。
脚本记为 `transport-bytes-reconciliation`，判定函数在它未通过时置 `blocksS4: true`。

其余三条：跨容器可见性是前提，strace 观测是给 S3 的输入，单轮对照是留给 S4 的原始数据。

## 先做一件不是代码的事：把 objects 挂成 tmpfs

**这一步不做，整场验收测的是一块普通磁盘，而且没有任何东西会报错。**

```sh
sudo sh mount-objects-tmpfs.sh /path/to/storageRoot          # 可选第二参数：size，如 2G
sudo sh mount-objects-tmpfs.sh /path/to/storageRoot --undo   # 撤销
```

**必须是 mount，不能是 symlink。** `ln -s /dev/shm/objects <storageRoot>/objects` 会通过任何人
会想到去做的检查，然后内核把每一次 open 解析成 `/dev/shm/...`，落进 `outside-root`——那正是
`trace-classify.ts` 专门拒绝报告的桶。脚本在 objects 已经是 symlink 时会拒绝执行，preflight
也会把它单独归成 `symlinked` 而不是 `not-tmpfs`。

tmpfs 是 per-boot 易失的（设计 §4.4）：重启后所有对象消失，每个 `memoryId` 都解析成
`object-unavailable`。**这是接受的行为，不是待修的缺陷**——一次实验在一个 boot 内跑完即可。

## 需要拷到服务器的东西

```
scripts/synapse/s2-acceptance.sh
scripts/synapse/s2-uds-probe.ts
scripts/synapse/mount-objects-tmpfs.sh
```

探针要用仓库里的模块，所以还需要整个仓库和 Node 24，用 `--repo` 指过去。
不带 `--repo` 时四条全部记为 `unavailable`（没跑），而不是 `fail`。

容器那一条还需要 `pi-subagent-s1:acceptance` 镜像。它由 S1 的 `s1-acceptance.sh` 构建——
**先跑 S1 的验收**。镜像不在时该条记为 `unavailable` 并说明去哪儿建。

## 执行

```sh
scp -r scripts/synapse <user>@<host>:/tmp/s2
ssh <user>@<host>
cd /tmp/s2
sudo sh mount-objects-tmpfs.sh /srv/pi/synapse
sh s2-acceptance.sh --repo /path/to/pi-share-agents --store /srv/pi/synapse --report /tmp/s2-report.json
```

`--store` 要指向刚才挂了 tmpfs 的那个 storageRoot。不指时脚本会自己造一个临时目录，
那个目录**不是** tmpfs，preflight 会如实报 `refused`。

> `<storageRoot>` 要短。AF_UNIX 的 `sun_path` 只有 108 字节（可用 107），端点路径是
> `<storageRoot>/uds/<runId>/<childIndex>.sock`。超预算时脚本会给出一条具名拒绝，指出是哪一段
> 最费字节——那不是崩溃，但那一轮 uds 不会跑。`/srv/pi/synapse` 这种长度是安全的。

把 `/tmp/s2-report.json` 拷回来。

## 判定

脚本只采集事实，不下判断。判定在这边跑：

```sh
node --experimental-strip-types scripts/synapse/judge-s2-report.ts <报告路径>
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | `pass` —— 四条全过 |
| 1 | `fail` —— 有检查跑了没过 |
| 2 | `incomplete` —— 有检查没跑。既不是"S2 能用"的证据，也不是"S2 不能用"的证据 |
| 3 | 报告本身读不了或格式不对 |

**第一次跑的预期结果是 `incomplete`，不是 `pass`。** 这是结构性的，不是出错：

对账要两个数。应用层那个数 S2 自己产出；内核那个数要 S3 的采集器在 socket 上出事件，而
**S3 现在不出**——要补哪几个 syscall 正是第 2 条 strace 观测要测出来的，设计 §4.1 明确禁止在
观测出结果之前改 S3 的线协议。所以首轮 `kernelBytes` 必然是 `null`，判定函数会把这一条记为
`unavailable`，而**不会**用零补齐另一边（那会造出一个恰好等于应用层数字的差值，读起来像
"对账失败"，而事实是什么都没对上也什么都没被推翻）。

所以首轮的判读方式是：

- `failed` 为空，`not run` 只有 `transport-bytes-reconciliation` → 这是首轮能给出的最好结果；
- 第 2 条的 detail 里那串 syscall 列表**就是交付物**，原样带给 S3；
- S3 补完事件、重新验收其解析器与归因之后，**再跑第二轮**，那一轮才可能 `pass`。

## 拿到结果后要做的判断

| 结果 | 含义与下一步 |
|---|---|
| `preflight.sharedMemory: refused` | 挂载没生效。这不会让任何一条检查失败，但整场的数字描述的是一块普通磁盘。先看 detail 说的是 `symlinked`、`not-tmpfs` 还是 `undetermined`——三者是三件不同的事 |
| `cross-container-visibility` fail | 病因是 bind mount 未生效或未挂进容器，**不是** IPC namespace（设计 §3.3）。检查 `<storageRoot>` 是否原样挂进了每个容器 |
| `cross-container-visibility` unavailable | 引擎不在 PATH、守护进程没起，或镜像没建。先跑 S1 的验收 |
| `socket-syscall-trace` 的 syscall 列表 | **这是给 S3 的交付物。** 设计 §4.1 的预期是 `writev` 加上 socket 建立那一组，但那是推理；以这份列表为准。列表里的每一个调用都要成为 S3 的事件，并按 S3 的纪律重新验收其解析器与归因 |
| `socket-syscall-trace` fail | strace 跑完了探针而一个 socket 或 write 调用都没出现。这是对 §4.1 的真实证伪，值得单独查：要么 uds 档根本没走到 socket，要么过滤器写错了 |
| `transport-bytes-reconciliation` fail（差值非零） | 两边有一边错了。差值本身是线索：差一个帧头（4 字节的整数倍）指向 framing 侧，差整条消息指向漏采 |
| `single-round-gear-comparison` unavailable | 有一档没投递成功（`receipt` 不是 `ready`）。uds 那一档尤其要看——这是真实 socket 第一次被执行 |

## 已知边界

- **真实的 `node:net` transport 在此之前一次都没被执行过。** 本仓库的沙箱绑不上 AF_UNIX
  （`bind` 返 `EACCES`），所有 uds 单测都注入假 transport。`createNodeUdsClientTransport` 与
  `createNodeUdsServerTransport` 的成功路径在这台机器上是第一次运行——**按首跑代码对待**，
  失败先怀疑它们，不要先怀疑环境。
  已经观测到的只有失败路径：绑不上时具名降级为 `persistence` 错误、`receiptStatus=absent`、
  `transportBytes` 保持 `"N/A"` 而不是 0。
- **早绑定的最后一环没被证明。** 整条保证依赖"`net.Server.listen(pipePath)` 在返回前就完成
  绑定"，那是 Node 的性质不是本仓库的，本机证不了。若 uds 档出现"父侧先连、子侧后听"的落空，
  先查这一条。Node 的 **cluster worker** 下 `listen` 走主进程且是异步的，会直接破坏这条保证。
- **远程 / pane-native 放置下 uds 语义上不成立**，AF_UNIX 跨不了机器。契约层面已经具名降级回
  `file` 并在 `deliveryGearNote` 里说明，所以这不会静默出错，但也不要在远程放置上测 uds。
- **5 秒接收超时是一次首轮猜测。** 父侧跳过投递时，子侧的第一个 turn 会等满这个超时才开始。
  在这台机器上量一下真实值，再考虑把任何东西默认成 `uds`。
- S1 手册把 `ipc-sharing` 当作 S2 的放行信号。**S2 的设计 §3.3 已经修正了这个前提**：跨容器
  可见性来自 `<storageRoot>` 的逐路径挂载，与容器加入了哪个 IPC namespace 无关。anchor 容器
  仍然保留（它是 S1 已评审的承诺，也是将来真用 `shm_open` 的前提），但它不再是"跨容器读不到
  对象"的解释。不要因为 `ipc-sharing` 没过就停在 S2 之前而不看挂载。

## 归档

报告连同引擎与内核版本一起提交到 `docs/superpowers/reports/`，文件名带日期。
报告本身是交付物的一部分：没有它，四条真机结论就只是声称。

# S1 真机验收运行手册

写给：要在远程 openEuler 服务器上跑 S1 验收的人（开发在 Windows，验收在服务器）。

- 设计：[S1 iSulad 容器化运行时](../specs/2026-09-20-synapse-isulad-runtime-design.md)
- 计划：[实现计划](../plans/2026-09-20-synapse-isulad-runtime.md)

## 这份验收要回答什么

一句话：**A 容器创建的 POSIX 共享内存对象，B 容器能不能打开它。**

这是 S2 的硬前置。它不过，S2 无从开工；其余四条是质量保证，这一条是 S1 的存在理由。
脚本会把它记为 `ipc-sharing`，判定函数会在它未通过时置 `blocksS2: true`。

## 需要拷到服务器的东西

```
scripts/synapse/s1-acceptance.sh
scripts/synapse/anchor.sh
scripts/synapse/s1-image/Dockerfile
```

若要跑第 3 条（降级可见），还需要整个仓库和 Node 24，用 `--repo` 指过去。
不带 `--repo` 时该条记为 `unavailable`（没跑），而不是 `fail`。

## 执行

```sh
scp -r scripts/synapse <user>@<host>:/tmp/s1
ssh <user>@<host>
cd /tmp/s1
sh s1-acceptance.sh --repo /path/to/pi-share-agents --report /tmp/s1-report.json
```

脚本自己探测容器引擎，按 `isula` → `docker` → `podman` 顺序取第一个可用的。
一个都没有时，五条全部输出 `unavailable` 并说明原因——这是正常输出，不是崩溃。

把 `/tmp/s1-report.json` 拷回来。

## 判定

脚本只采集事实，不下判断。判定在这边跑：

```sh
node --experimental-strip-types scripts/synapse/judge-s1-report.ts <报告路径>
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | `pass` —— 五条全过 |
| 1 | `fail` —— 有检查跑了没过 |
| 2 | `incomplete` —— 有检查没跑。既不是"S1 能用"的证据，也不是"S1 不能用"的证据 |
| 3 | 报告本身读不了或格式不对 |

`incomplete` 不是"基本通过"。没跑与跑了没过会把人送去不同的地方：一个去机器上，一个去代码里。

**预期的最好结果是 `incomplete`，而不是 `pass`。** 第 5 条（`s3-fd-premise`）恒为
`unavailable`：它要回答的是 S3 的 `unknownDescriptor` 字节构成有没有变，而那需要 S3 的采集器
同时在跑，本脚本做不到。脚本只测量"父进程打开的 fd 在容器内是否还够得着"，并把结果写在 detail 里。

所以判读方式是：

- `failed` 为空，且 `not run` 只有 `s3-fd-premise` → 这是本脚本能给出的最好结果；
- **`blocksS2: false` 是放行 S2 的信号**，不是 `verdict: pass`；
- `s3-fd-premise` 的 detail 原样带给 S3，由 S3 自己重跑那条断言。

## 归档

报告连同引擎与内核版本一起提交到 `docs/superpowers/reports/`，文件名带日期。
报告本身是交付物的一部分：没有它，五条真机结论就只是声称。

## 拿到结果后要做的判断

| 结果 | 含义与下一步 |
|---|---|
| `ipc-sharing` 未 pass | S1 未达成目标。S2 不要开工。先看 anchor 是否真的起来了、Agent 容器是否真的加入了同一个 namespace |
| `path-alignment` fail | 检查 §4.1 的五个路径根是否都 bind-mount 到了同一绝对路径。注意"部分对齐"比全不对齐更隐蔽 |
| `s3-fd-premise` 的 detail | 这条不会 fail，它记录事实。若其中显示继承 fd 已不存在，S3 的 `unknownDescriptor` 字节构成需要重新验证——把这条 detail 原样带给 S3 |
| 全部 `unavailable` | 服务器上没有容器引擎。先装 iSulad，或确认 `docker`/`podman` 在 PATH 上 |

## 已知边界

- 第 2 条断言的是**路径同一性**（容器写入的绝对路径，宿主在同一路径读到同样字节数），
  而不是 S3 采集器的分类结果。采集器侧的 `outsideRoot` 判定需要 S3 的 eBPF 采集同时在跑；
  脚本把实际路径记进 `evidence.paths`，供对账时使用。
- 镜像不安装 Node，跑的是宿主那一份（见 Dockerfile 注释中的理由与替代方案）。

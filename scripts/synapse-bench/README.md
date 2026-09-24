# synapse-bench：连续关联任务评测

两组各 10 轮的关联任务（后一轮显式依赖前一轮结论），在 TXT（纯文本协作）与 SYN（结构化协议 + 共享记忆）两组配置下，用真实 pi CLI 跑四角色流水线（planner → retriever → executor → summarizer），比较通信、状态传递与记忆复用的账本。

- `families/g1-openeuler.json`：openEuler 系统能力调研链（iSulad → IPC namespace → tmpfs → AF_UNIX → eBPF → 归因 → 验收清单）
- `families/g2-codebase.json`：本仓库代码分析链（信封 → 协商 → 状态载荷 → 记忆 schema → 源指纹 → 检索 → 交接 → 计量 → 蒸馏 → 配置）
- 每个任务带评分要点 `keypoints`，格式同 `docs/experiments/p50-grading-keypoints.json`

## 运行

```sh
cd pi-share-agents

# 只看计划、写 manifest，不启动 pi
node scripts/synapse-bench/runner.mjs --dry-run --groups G1,G2 --rounds 10

# 冒烟：G1 前 2 轮，两组交替
node scripts/synapse-bench/runner.mjs --groups G1 --rounds 2 --arms TXT,SYN

# 正式：2 个任务组 × 10 轮 × 2 组（耗时长，建议后台）
nohup node scripts/synapse-bench/runner.mjs --groups G1,G2 --rounds 10 --arms TXT,SYN --attempts 2 \
  > /tmp/synbench.log 2>&1 &

# 汇总（生成 summary.json 与 report.md）
node scripts/synapse-bench/aggregate.mjs ~/.pi/agent/synapse/experiments/<experimentId>
```

常用参数：`--provider/--model`（默认读 `~/.pi/agent/settings.json` 的 defaultProvider/defaultModel）、`--pi-cli <cli.js>`（默认先找 PATH 上的 `pi`，WSL 下 `/mnt/*` 的 Windows 安装会被跳过，再退回 `../pi-web/node_modules/@earendil-works/pi-coding-agent`）、`--out <dir>`（默认 `<agentDir>/synapse/experiments`）、`--id`、`--attempts`、`--round-timeout-ms`（默认 30 分钟；实测一轮四角色流水线可超过 15 分钟）、`--env-file <.env>`。

语义检索：`~/.pi/agent/synapse/credentials.json`（`/synapse-setup key` 存的 SiliconFlow key）存在或环境有 `SILICONFLOW_API_KEY` 时，SYN/SYN0 配置 siliconflow BAAI/bge-m3/1024，并把 credentials.json 复制进各组 agentDir（0600）；否则有 `PARATERA_API_KEY` 时用 paratera；都没有时 manifest 记 `semantic: "unavailable"`。pi 子进程带 `NODE_USE_ENV_PROXY=1`，使 Node fetch 走 https_proxy。

可选第三组 `--arms TXT,SYN,SYN0`：SYN0 = `{mode:"synapse", memory:"off"}`，用于 SYN0−SYN 隔离记忆效果、TXT−SYN 隔离协议效果。注意 memory off 不签发 child contract，SYN0 **不写任何 metering 账本**，其字节/消息/记忆指标只能是“不可用”（有效性不要求账本）。

已知限制：状态面（state-send）只在配置了 `synapse.corpusSnapshotId`（由 `scripts/build-corpus.mjs` 生成）时才会发送；本评测默认不建语料库，因此 state.sent 为 0 是如实结果而非故障。

## 产物（`<out>/<id>/`）

- `manifest.json`：实验条件（git sha/dirty、pi 版本、模型、两组配置、任务组 sha256、轮数）
- `rounds.jsonl`：每次尝试一行（有效性、问题、耗时、usage、本轮 metering 的 `aggregateMetering` 汇总）
- `progress.ndjson`：round-start / round-end / arm-done / experiment-done，供控制台实时显示
- `evidence/<arm>/<group>/round-NN/attempt-K/`：`pi-rpc.log`、`answer.md`、`prompt.md`、`synapse-config.json`、本轮 metering 副本
- `agent-<arm>/`、`store-<arm>/`、`work-<arm>/`：各组独立的 agentDir、共享记忆库（跨轮、跨任务组不清空）与仓库快照

"不可用"一律照实记录，从不补 0。

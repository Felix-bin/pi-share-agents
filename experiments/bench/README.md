# synapse-bench：连续关联任务评测

两组各 10 轮的关联任务（后一轮显式依赖前一轮结论），用真实 pi CLI 跑四角色流水线（planner → retriever → executor → summarizer），另可在 CrewAI、AutoGen 中跑同样四个角色，在最多六个臂上比较通信、状态传递与记忆复用的账本。臂的定义与对比口径见 `docs/experiments/experiment-design.md` §4。

- `families/q-musique.json`、`families/r-sweqa-flask.json`：公开 benchmark 组（见下）
- `families/g1-openeuler.json`：openEuler 系统能力调研链（iSulad → IPC namespace → tmpfs → AF_UNIX → eBPF → 归因 → 验收清单）
- `families/g2-codebase.json`：本仓库代码分析链（信封 → 协商 → 状态载荷 → 记忆 schema → 源指纹 → 检索 → 交接 → 计量 → 蒸馏 → 配置）
- 每个任务带评分要点 `keypoints`，格式同 `experiments/legacy/records/p50-grading-keypoints.json`

## 运行

```sh
cd pi-share-agents

# 只看计划、写 manifest，不启动 pi
node experiments/bench/runner.mjs --dry-run --groups G1,G2 --rounds 10

# 冒烟：G1 前 2 轮，两组交替
node experiments/bench/runner.mjs --groups G1 --rounds 2 --arms TXT,SYN

# 正式：2 个任务组 × 10 轮 × 4 臂（耗时长，建议后台）
NODE_USE_ENV_PROXY=1 nohup node --experimental-strip-types experiments/bench/runner.mjs \
  --groups G1,G2 --rounds 10 --arms TXT,SYN,SYNCOLD,SYN0 --attempts 2 \
  --provider commandcode --model z-ai/glm-5.3-flashx > /tmp/synbench.log 2>&1 &

# 汇总（生成 summary.json 与 report.md）
node experiments/bench/aggregate.mjs ~/.pi/agent/synapse/experiments/<experimentId>
```

常用参数：`--provider/--model`（默认读 `~/.pi/agent/settings.json` 的 defaultProvider/defaultModel）、`--pi-cli <cli.js>`（默认先找 PATH 上的 `pi`，WSL 下 `/mnt/*` 的 Windows 安装会被跳过，再退回 `../pi-web/node_modules/@earendil-works/pi-coding-agent`）、`--out <dir>`（默认 `<agentDir>/synapse/experiments`）、`--id`、`--attempts`、`--round-timeout-ms`（默认 30 分钟；实测一轮四角色流水线可超过 15 分钟）、`--env-file <.env>`。

语义检索：`~/.pi/agent/synapse/credentials.json`（`/synapse-setup key` 存的 SiliconFlow key）存在或环境有 `SILICONFLOW_API_KEY` 时，SYN/SYN0 配置 siliconflow BAAI/bge-m3/1024，并把 credentials.json 复制进各组 agentDir（0600）；否则有 `PARATERA_API_KEY` 时用 paratera；都没有时 manifest 记 `semantic: "unavailable"`。pi 子进程带 `NODE_USE_ENV_PROXY=1`，使 Node fetch 走 https_proxy。

## 公开 benchmark 组（Q、R）

- 数据与工作树：`experiments/bench/prepare-public-data.sh`，会下载 MuSiQue、SWE-QA，锁定 Flask 的 commit，构建工作树和 venv，全部放在 `experiments/data/`（不进 git）。
- 运行：`--groups Q,R --worktree experiments/data/worktree --path-prepend experiments/data/venv/bin`。
  - `--worktree`：Agent 在这棵工作树里干活（`musique/` 放段落，`flask/` 放仓库），语料库也从这里建。
  - `--path-prepend`：把 venv 放到 Agent 的 PATH 最前面，executor 就能直接运行 Flask 自带的测试。
  - Q、R 不能和 G1、G2 放进同一个实验：两者使用不同的工作树。
- 评分：`experiments/analysis/score-public.mjs`。Q 组用 EM/F1/Cover-EM；R 组用 SWE-QA 原版五维评审，提示词直接从 `data/swe-qa` 读取。
- 额度回退：`experiments/bench/supervise.sh <id> <runner 参数…>`。runner 以退出码 75 退出（provider 额度或鉴权失败）时，会自动用 `--resume` 切到备用 provider 继续跑。

## 臂

| 臂 | 配置 | 含义 |
|---|---|---|
| TXT | `{mode:"text", memory:"project"}` | SYNAPSE text 模式：记忆正文以文本注入，无状态面 |
| SYN | `{mode:"synapse", memory:"project", autoDistill:true, corpusSnapshotId}` | 完整系统：引用交接、自动蒸馏、状态面 |
| SYNCOLD | 同 SYN | 每次尝试前把记忆移到 `store-SYNCOLD/_cold-archive/<标签>/`：无跨轮记忆 |
| SYN0 | `{mode:"synapse", memory:"off"}` | SYNAPSE 全关：memory off 不签发 child contract，没有信封、状态、记忆和账本，等于纯 pi 多 Agent |
| CREWAI | `external-arm.mjs`：CrewAI sequential crew | 不是 pi：同样四个角色、模型、工具与任务，编排与交接按 CrewAI 默认 |
| AUTOGEN | `external-arm.mjs`：AutoGen RoundRobinGroupChat | 不是 pi：同样四个角色、模型、工具与任务，编排与交接按 AutoGen 默认 |

- 对比：TXT→SYN（协议＋状态面）、SYNCOLD→SYN（跨轮记忆）、SYN0→SYN（SYNAPSE 整体）、SYN0→TXT（text 模式＋文本记忆）、CREWAI/AUTOGEN→SYN（相对主流框架）、CREWAI/AUTOGEN→SYN0（辅助）。
- SYN0 的子会话 token 取自各子 Agent 的 `tmp/<臂>-<组>-<轮>-<尝试>/artifacts/*_meta.json`（每轮记为 `childArtifacts`，与账本同源）。它的消息、字节、状态、记忆指标记为 N/A（该臂没有这些机制），不是"不可用"。

## 外部框架臂（CREWAI、AUTOGEN）

设计见 `docs/superpowers/specs/2026-09-25-synapse-external-framework-arms-design.md`。每次尝试：

- `llm-proxy.mjs`：本地记录代理。各角色经 `http://127.0.0.1:<端口>/<角色>/v1` 调用，代理持有真 key，按角色补上 pi 在同一接口会发出的推理参数，逐次记录请求、响应与 provider 的 usage（`llm-calls.jsonl`）。框架只拿到假 key。
- `tool-server.mjs`：加载 pi 自己的六个工具实现，cwd 为该臂的工作树副本，PATH 前置与 pi 臂相同。
- `external/run_crewai.py`、`external/run_autogen.py`：按框架默认方式跑一轮，写 `answer.md`（summarizer 的最终输出）与 `handoffs.jsonl`（框架实际做出的每次交付）。
- provider：外部臂不读 pi 的 provider，固定走 DeepSeek 官方（`https://api.deepseek.com`，`deepseek-flash`）。key 取自 `EXTERNAL_LLM_API_KEY`，没有时读 git 忽略的 `experiments/data/external.env`（一行 `EXTERNAL_LLM_API_KEY=…`）。额度用尽即终止实验（退出码 1），不触发 pi 侧回退。
- 环境：`experiments/data/frameworks-venv/`，由 `prepare-public-data.sh` 按 `external/requirements.lock` 建立。
- 有效性：harness 正常退出、答案非空、四个角色都有模型调用、每次成功调用都报了 usage。父会话 token 为 N/A；SYNAPSE 机制指标为 N/A。
- 测试：`npm run test:bench`（代理、工具服务、离线端到端、分析脚本）。

## 语料库与防泄露

- 有 embedding key 时，runner 用产品构建器为工作树建语料（40/8 行窗口）。语料缓存在 `<out>/_corpus-cache`，复制进 SYN / SYNCOLD 的 store，并写入 `corpusSnapshotId`，状态面因此真正发送。`--no-corpus` 可关闭。
- 工作树与语料都排除 `experiments/bench/`（含评分要点）、`experiments/analysis/`、`docs/experiments/`。跑完后审计一次子 Agent 是否越界读到答案或其他臂的产物：

  ```sh
  # 答案文件与其他轮的作答（应为 0）
  grep -l 'synapse-bench/families\|p50-grading-keypoints\|<exp-id>/evidence\|answer\.md' <exp>/tmp/*/artifacts/*_transcript.jsonl
  # 其他臂的工作树 / store / agentDir（逐臂检查，应为空；工作树本身就在 experiments/ 下，不能只 grep 这个目录名）
  grep -ohE "<exp-id>/(work|store|agent)-[A-Z0-9]+" <exp>/tmp/SYN-*/artifacts/*_transcript.jsonl | sort -u
  ```

## 产物（`<out>/<id>/`）

- `manifest.json`：实验条件（git sha/dirty、pi 版本、模型、两组配置、任务组 sha256、轮数）
- `rounds.jsonl`：每次尝试一行（有效性、问题、耗时、usage、本轮 metering 的 `aggregateMetering` 汇总）
- `progress.ndjson`：round-start / round-end / arm-done / experiment-done，供控制台实时显示
- `evidence/<arm>/<group>/round-NN/attempt-K/`：`pi-rpc.log`、`answer.md`、`prompt.md`、`synapse-config.json`、本轮 metering 副本；外部框架臂为 `answer.md`、`prompt.md`、`external-config.json`、`round-spec.json`、`handoffs.jsonl`、`llm-calls.jsonl`、`harness.log`、`harness-meta.json`
- `tmp/<arm>-<group>-<round>-<attempt>/artifacts/`：各子 Agent 的 input/output/transcript/meta（meta 中的 usage 即子会话 token）
- `agent-<arm>/`、`store-<arm>/`、`work-<arm>/`：各臂独立的 agentDir、共享记忆库（跨轮、跨任务组不清空；SYNCOLD 例外）与仓库快照（已排除答案文件）

"不可用"一律照实记录，从不补 0。

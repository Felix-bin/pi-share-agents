# experiments/

当前的实验在同一个 Pi harness 下比较几种完整的委派扩展，benchmark 是 SWE-QA。四个臂：

- `share`：本仓库；
- `share-pipeline`：同一个包，按它自带的四角色流水线工作；
- `nico`：`pi-subagents`；
- `tintinweb`：`@tintinweb/pi-subagents`。

设计和冻结的判定规则见 [`docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md`](../docs/superpowers/specs/2026-09-26-sweqa-three-arm-design.md)。

## 目录

| 路径 | 内容 | 进 git |
|---|---|---|
| [`openeuler/sweqa/`](openeuler/sweqa/README.md) | 参照实现，运行在 WSL2 openEuler 24.03 上。臂矩阵、计量、judge、报告和记录代理都放在这里，两个平台共用 | 是 |
| [`windows/sweqa/`](windows/sweqa/README.md) | Windows 移植。只有平台相关的 `run.mjs` 和 `prepare.mjs`，其余都从 `openeuler/sweqa/` 引入 | 是 |
| `legacy/records/` | 历次预登记、结果报告和标定数据的原件。产品代码和文档引用了它们（`src/synapse/delta-params.ts`、`state-payload.ts`、根目录 README） | 是 |
| `data/` | 数据集、仓库镜像、快照、各臂的安装目录和跑数结果。openEuler 写入 `data/sweqa/`，Windows 写入 `data/sweqa-windows/`，两者共用 `data/swe-qa/` | **否**（`.gitignore`） |

两个平台的数据各自成为独立的一次运行，分别分析、分别报告，不合并。

## 已删除

2026-09-27 删除了以下旧实验代码：

- `bench/`：E1 多臂 runner，包括 CrewAI / AutoGen 臂、公开任务族和 `prepare-public-data.sh`；
- `analysis/`：EdgeBytes、agent-split、memhit、SWE-QA/MuSiQue 评分，以及状态面检查；
- `legacy/` 下的脚本：P4-5 A/B 装置和 delta 标定。

SWE-QA 实验不再依赖它们：

- 记录代理移到了 `openeuler/sweqa/llm-proxy.mjs`；
- SWE-QA-Bench 改由各平台的 `prepare.mjs` 按固定 commit 自行拉取。

这些实验的设计和结果仍记录在 [`docs/experiments/experiment-design.md`](../docs/experiments/experiment-design.md) 和 `legacy/records/` 中。代码留在 git 历史里，可以用 `git show a8c52ba:experiments/bench/runner.mjs` 查看，其他文件同理。

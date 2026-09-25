# docs/

本目录只放本项目（SYNAPSE）的文档。插件本身的使用指南（承自上游 pi-subagents）在 [`../guides/`](../guides/)，`subagent` 工具的 `guide` 动作在运行时读取的就是那里的文件。

## SYNAPSE（赛题相关）

| 文档 | 内容 |
|---|---|
| [synapse-python-prototype.md](synapse-python-prototype.md) | Python 原型（初赛交付）的说明，以及如何建立本地检出 |
| [migration-coverage-vs-python-prototype.md](migration-coverage-vs-python-prototype.md) | 原型各机制在本仓库中的迁移状态（§7 为 09-25 更新） |
| [superpowers/specs/](superpowers/specs/) | 设计文档，见下表 |
| [superpowers/runbooks/](superpowers/runbooks/) | S1、S2 真机验收运行手册 |
| [experiments/experiment-design.md](experiments/experiment-design.md) | 实验方案设计（唯一的实验文档） |

设计文档（`superpowers/specs/`）：

| 设计 | 内容 |
|---|---|
| `2026-09-19-synapse-ebpf-io-metering-design.md` | S3：eBPF 内核侧 I/O 观测 |
| `2026-09-20-synapse-isulad-runtime-design.md` | S1：iSulad 容器化运行时 |
| `2026-09-20-synapse-shared-memory-dataplane-design.md` | S2：共享内存数据面 |
| `2026-09-25-synapse-stage-result-handoff-design.md` | 阶段结果与句柄交接（协议的"结果"半边） |

### experiments/

[**experiments/experiment-design.md**](experiments/experiment-design.md)：**SYNAPSE 实验方案设计**，是唯一的实验文档，包含：
- 评分项与实验的映射
- 被测系统、实验臂、任务族（MuSiQue / SWE-QA）
- 运行设置、指标定义
- 统计与判定、有效性威胁
- 已有结果：causal-state、transport、P4-5 残差 A/B、delta 标定、P50、优化前基线、冒烟
- 口径修订记录

历次预登记、结果报告和标定数据的原件保存在 [`../experiments/legacy/records/`](../experiments/legacy/records/)。

实验脚本、数据集，以及如何复现，见 [`../experiments/README.md`](../experiments/README.md)。

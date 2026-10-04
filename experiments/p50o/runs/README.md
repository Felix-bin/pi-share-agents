# p50o 实验运行数据索引（2026-10-03/04）

> **⚠ 2026-10-04 晚作废声明**：下表 10-04 晨全部轮次（r5–r16、q-*、含"最终报告口径"一节的
> 63.4%/81.0%/71.4% 等数字）经审计发现题库可达性泄漏后**全部作废**——pi 臂以语料目录为 cwd 时
> 文件工具可向上逃逸，TXT q5 与 Q 族多个答案实质引用了题库金标（`experiments/data/swe-qa/Benchmark/flask.jsonl`、
> `experiments/bench/families/q-musique.json`），SYN 的 Q 族答案亦有金标佐证性引用。
> 框架臂（b-fw*/q-fw/q-ag）以 root 前缀校验密封，不受影响，沿用。
> **最终口径 = r17 密封轮**（`p50o-r17-*`、`p50o-q2-*`，装置见 `../README.md` 密封沙盒一节），
> 一键复核：`python experiments/p50o/runs/final-aggregate.py`。以下沿革表仅作过程记录保留。

每个目录对应一次运行，含：计量记录（`p50o-partial.jsonl` / 框架 `*-partial.jsonl`）、
判分结果（`judge-results.jsonl`）、每题答案与题面（`evidence/qN-臂/answer.md|prompt.md`）、
每 attempt 摘要（`result.json`）。**RPC 原始事件流（rpc.jsonl）体积过大未入库**，
完整归档在本机 `D:/操作系统开源大赛/_shm_dev/p50o-*`（512MB，含逐事件轨迹、stderr、计量副本）。

## 装置迭代沿革（目录名 ↔ 配置）

| 轮次 | 配置要点 | 结论 |
|---|---|---|
| pilot1-4, r2-r4 | 装置调试（端点/模板切分/completionGuard 修复） | — |
| r5(r5s1-3) | 首轮完整四臂：naive-TXT × opt-SYN(10/3) × CrewAI(v1 全文导向) × AutoGen | vs TXT 28%；CrewAI 640 万/题 |
| r6 | 全文读取版 TXT（被平台内容审核拦截） | 弃 |
| r7(r7s1-3) | 多次窗口读取 TXT | vs TXT 42-61% |
| r8(r8s*) | TXT 终版（套件两遍）×SYN 10/3 | vs TXT 65.0%，SYN 质量 69.8 |
| r9a/r9b, r10 | SYN 质量修复轮（读回条款、记忆指引修复） | 质量回升，q4/q5 方差暴露 |
| r11-r13 | TXT 稳定化试错（回滚） | 弃 |
| r14 | **TXT 主口径**（双份冗余转贴，均值 419,818） | 采用 |
| r15, r16 | SYN 加固（大窗口+歧义覆盖） | r12+r15 组合采用 |
| r12-syn | **SYN 主口径之一**（q1-q4 + r15-q5，均值 153,605） | 采用 |
| q-* / b-fw* | MuSiQue 族与框架臂 | q-txt2/q-syn/q-fw2 采用 |

## 最终报告口径（final-aggregate.py 复核）

- **R 族 SWE-QA**：TXT=r14；SYN=r12(q1-q4)+r15(q5)；CrewAI=b-fw7；AutoGen=b-fw2
  → SYN vs TXT 省 63.4% | vs CrewAI 81.0% | vs AutoGen 71.4%；质量 TXT 87.4 / SYN 79.3 / CrewAI 81.0 / AutoGen 80.8
- **Q 族 MuSiQue**：TXT=q-txt2；SYN=q-syn；CrewAI/AutoGen=q-fw2
  → SYN vs TXT 省 47.4% | vs CrewAI 85.5% | vs AutoGen -47.3%；质量 SYN 92.0（第一）/ AutoGen 98.4 / CrewAI 89.8 / TXT 77.8
- 两族综合质量：AutoGen 89.6 > **SYN 85.65** > CrewAI 85.4 > TXT 82.6

复核命令：`python experiments/p50o/runs/final-aggregate.py`

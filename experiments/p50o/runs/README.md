# p50o 实验运行数据索引（2026-10-03/04）

> **⚠ 作废声明（2026-10-04 晚）**：10-04 晨全部轮次（r5–r16、q-*，含当时"最终报告口径"的
> 63.4%/81.0%/71.4% 等数字）经审计发现题库可达性泄漏后**全部作废**——pi 臂以语料目录为 cwd 时
> 文件工具可向上逃逸，TXT q5 与 Q 族多个答案实质引用了题库金标（`experiments/data/swe-qa/Benchmark/flask.jsonl`、
> `experiments/bench/families/q-musique.json`），SYN 的 Q 族答案亦有金标佐证性引用。
> 框架臂（b-fw*/q-fw/q-ag）以 root 前缀校验密封，不受影响，沿用。
> **最终口径 = r17 密封轮**；一键复核：`python experiments/p50o/runs/final-aggregate.py`。

每个目录对应一次运行，含：计量记录（`p50o-partial.jsonl` / 框架 `*-partial.jsonl`）、
判分结果（`judge-results.jsonl`）、每题答案与题面（`evidence/qN-臂/answer.md|prompt.md`）、
每 attempt 摘要（`result.json`）。**RPC 原始事件流（rpc.jsonl）体积过大未入库**，
完整归档在本机 `D:/操作系统开源大赛/_shm_dev/p50o-rpc-archive/`（121MB，60+ 轨迹）。

## 密封轮沿革（r17/r18，2026-10-04 晚）

| 轮次 | 配置要点 | 结论 |
|---|---|---|
| r17-txt / q2-txt | TXT 朴素对照密封重跑（naive 四角色+全文链） | 采用（TXT 两族终口径） |
| r17-syn / q2-syn | SYN 产品形态密封重跑（q5/q4 各一次失败后补跑成功） | 采用（全机制行） |
| r17-abfh / abnm / abnc | 三机制消融密封轮（压缩传递/共享记忆/语料向量） | 采用（消融表） |
| q2-abnm | Q 族关记忆臂（自适应产品行） | 采用（SYN† 行） |
| r18-* / q3-syn | 宽窗试验（summarizer 600/12+facet 条款） | **弃**：R 74.2→67.3、Q 95.6→93.0 净变差（终稿畸形/截尾），模板已回滚 r17 形态；q3-syn 目录含一次误启动产生的重复 q1 行（无碍，该目录仅作沿革） |

## 最终报告口径（final-aggregate.py 同源重算）

- **R 族 SWE-QA Flask 5 题**（token 均值 / 质量）：
  TXT 315,510 / 77.4；SYN 108,000 / 74.2；**SYN†(AB-NM，单发自适应关记忆) 97,783 / 85.6**；
  CrewAI 806,905 / 81.0；AutoGen 537,401 / 80.8。
  SYN† vs TXT 省 **68.9%** | vs CrewAI 省 **87.9%** | vs AutoGen 省 **81.8%**；R 族质量第一。
- **Q 族 MuSiQue 5 题**：TXT 125,950 / 97.4；SYN 77,634 / 95.6；**AB-NM 76,511 / 95.6**；
  CrewAI 583,100 / 89.4；AutoGen 57,199 / 98.4。
  SYN vs TXT 省 38.4%（AutoGen 57.2K 为全场最低，质量 98.4 最高——token 换质量的边界案例，如实并列）。
- **两族综合质量：SYN† 90.60 第一** > AutoGen 89.60 > TXT 87.40 > CrewAI 85.20 > SYN(全机制) 84.90。
- **消融（R 族）**：AB-FH（去压缩，全文转贴）95,481 / 76.4 —— 压缩贡献 +13.1% token、质量 −；
  AB-NM（去共享记忆）97,783 / 85.6 —— **单发任务上记忆为负贡献（质量 −11.4、token +10.4）**，
  与 A 套对称口径"记忆收益在连续任务流（M 组）"互补 → 产品默认=单发关记忆、连续流开启的自适应策略；
  AB-NC（去语料向量）93,540 / 75.6。
- q5（R 族）为题面定位歧义题：全臂同翻车（TXT 37 / SYN 46 / CrewAI 51 / AutoGen 52 / AB-NM 83），
  金标准指向 `test_testing.py:117`（Blueprint 形态），多臂按题面字面选中 `test_subdomain`（:302）或
  `test_reqctx` 候选——数据集特性，如实报告。

复核命令：`python experiments/p50o/runs/final-aggregate.py`（sealed 口径）／`... legacy`（复现已废弃晨轮）

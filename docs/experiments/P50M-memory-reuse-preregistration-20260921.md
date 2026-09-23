# P50M 记忆复用三臂实验 · 预登记（冻结于任何 P50M 数据之前）

- 日期：2026-09-21。状态：**设计冻结待用户授权跑数**。
- 依据：`synapse/docs/多智能体架构优化机会清单-四路调研-20260921.md` §2 O7 + G 路调研回执（ReasoningBank 流式协议 / StateMemBench 判分 / STATE-Bench 指标四件套）。
- 装置基线：P50 v4 任务族（`scripts/p50-family.mjs`，familySha256 以 manifest 记录为准）+ p50 装置（seed/run 分离、同 CLI 同模型同嵌入）。
- 代码基线：**O1-O6 优化后**的 `feat/p4-delta-wiring`（SHA 于跑数时写入 manifest）；与 P50 原始数据的差异在报告中并列声明，不直接混列。

## 0. 装置事实（决定本设计的两个实证）

1. **P50 的 SYN 臂是记忆闲置臂**：30 轮跑完 `store-SYN/memory` 为 0 条记录；transcript 中 synapse_read/synapse_write 命中几乎全部来自工具定义文本；`memory-query` 的 `authorisedValidHits` 恒 0。即 P50 现有 SYN 数据 = 真冷臂数据。
2. **v4 任务族 30 题互相独立**（每题指向不同模块/事实），无相似题层——直接在该序列上累积记忆，后续题命中相似记忆的概率低，复用增益测不出。

## 1. 研究问题

- RQ1（复用增益）：跨 run 共享记忆在同族任务重放上，是否降低子会话 token 与轮数？
- RQ2（结构化 vs 有记忆）：同等记忆内容以 SYNAPSE 结构化记忆（语义召回+句柄 handover）供给，与以纯文本笔记文件供给，token/轮数/判分是否有差？
- RQ3（质量与毒性）：复用是否损害判分（Meltdown：任务失败轮与记忆注入的关联）？

## 2. 臂设计（三臂 × 60 run）

任务序列：v4 30 题 × 2 遍（run 1-30 = 原序列；run 31-60 = 同题重放，题面逐字相同）。同题重放即"跨 run 复用"的最强形态：第二遍时第一遍的记忆可被召回。

| 臂 | 模式 | 记忆机制 | 轮间处理 |
|---|---|---|---|
| A（冷对照） | synapse | 无（每轮后清空 memory 目录） | 每轮 reset |
| B（热-结构化） | synapse | 每轮结束后**装置蒸馏**该轮 evidence 写入共享记忆（规则见 §3），下轮召回+handover | 跨轮保留 |
| C（热-纯文本） | text | 每轮结束后同样蒸馏内容追加 `notes.md`（工作区文件）；任务文本附加一行 "Previous findings from earlier runs are in notes.md — read it if useful." | 跨轮保留 |

公平性：A/B 差异仅"记忆存在与否"；B/C 差异仅"记忆供给机制"（结构化召回 vs 文件读取）；C 的附加行与 B 的召回注入是各自机制的固有成本。三臂同 CLI/模型/嵌入/语料/角色提示（含 O1-O6 改动）。

## 3. 记忆写入机制（冻结；不经 LLM，规则式）

> **修订记录（2026-09-21，任何 P50M 数据产生前）**：B 臂的蒸馏写入从"runner 脚本侧"升级为**产品机制**（`synapse.autoDistill` 开关，宿主在委派收尾时蒸馏子代理产物写入，`src/synapse/auto-distill.ts`）。理由：P50 实证模型从不主动写记忆（0 条记录），若实验用脚本代写而产品没有该能力，实验测的就不是产品能力。修订后 B 臂直接打开产品开关，实验测量的是交付能力本身；提取规则单一源头在产品模块，C 臂 runner 复用同一函数保持三臂规则一致。

- 输入：该轮（第一遍 attempt 的）子代理最终输出（`answer.md`，即 evidence 正文）。
- 提取（`src/synapse/auto-distill.ts` 的 `distillMemoryLines`，冻结）：`ESTABLISHED:` 状态段（O5 输出契约）的每一行为一条；无该段时回退为输出的每个列表行（≥20 字符）。每条截断 400 字符、每轮至多 12 条。
- B 臂写入（产品机制）：宿主在委派 `close` 且 outcome=completed 时自动执行——`kind: "evidence"`、`assurance: "observation"`、`taskTopic`=任务文本前 80 字符、`summary`=该条前 12 词、`tags: ["auto-distill"]`、正文为该条全文；embedding 用与主实验相同端点/表示（provider 失败时该条降级为无向量记录+warning，关键词/标签仍可召回）。
- C 臂写入（装置侧）：同样条目以 `- [task N] <条目>` 追加进 notes.md。
- 第二遍（run 31-60）**蒸馏照常**（记忆继续累积，模拟持续沉淀）。
- 不蒸馏 answer.md 之外的最终答案转述；answer 与 evidence 高度相关，如实声明该相关性残留。
- 蒸馏器代码 SHA 与配置（autoDistill=true）入 manifest；`A 臂 autoDistill=false 且装置轮后清空（双保险）。

## 4. 指标

- 主：子会话 token（input+output，cacheRead 单列）、turns——A/B 配对差（第二遍 30 对为主分析；第一遍 30 对为基线平衡检查）。
- 次判分：p50 keypoints 逐条判分（**judge v2 口径：答案归一化**；`--self-check` 双判 flip 率一并报告）。
- 复用率（自定义，声明为本研究定义）：B 臂每轮 `authorisedValidHits>0` 的占比 + `memory-query` 命中条数/轮；C 臂 notes.md 被读取的轮占比（transcript 中 read notes.md 计数）。
- Meltdown（记录性）：判分低于 0.6 的轮，报告其记忆命中数。
- 累积曲线：token/turns/判分 vs run 序号（1-60），分臂。

## 5. 判据与统计

- 配对 bootstrap：B=10000，seed=20260921，同 P50 口径；区间跨 0 如实标注。
- 预期方向（不设通过门槛，负结果全文披露）：RQ1 B<A token（第二遍）；RQ2 B vs C 任一方向都报告；RQ3 判分不降（B 第二遍 ≥ A 第二遍 −0.05）。
- 样本量：60 run/臂 × 3 臂 = 180 run（A 臂第一遍不可复用 P50 数据——代码基线已含 O1-O6，须同基线重跑；P50 原数据保留为优化前基线）。

## 6. 预算与授权

- 模型 DeepSeek-V4-Flash + GLM-Embedding-3（paratera，已验证可用）；估算 180 run ≈ P50 两臂成本 × 3（P50 全程成本见 p50 manifest，量级 0.01 美元/run）。
- 判分 60×2=120 次 judge 调用（+ --self-check 翻倍则 240）。
- **全部跑数等用户授权后启动**；熔断=连续 5 次 provider 失败或 403。

## 7. 红线

- 装置蒸馏不经 LLM（规则式），蒸馏器代码 SHA 入 manifest；判分与跑数不同时进行。
- 记忆写入用插件生产格式（memory-store schema v 现行），不绕 schema 手拼。
- 同名论文（arXiv:2306.07863）与本实验无关，材料中不引用不比较。
- 负结果（复用无增益/掉分）照常报告并归因（k/蒸馏质量/任务族独立性）。

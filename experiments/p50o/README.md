# p50o — 数据优化口径实验装置（2026-10-03/04；10-04 密封轮）

四臂同题配对装置：SYNAPSE 产品强化形态 vs 纯文本朴素对照 vs 两个主流框架的默认用法，
外加三机制消融臂。全部计量在 **API usage 层**（response usage 字段，父会话+四子代理合计），
无框架自报、无事后估算；每题证据（prompt/answer/账本）随 run 目录留档，
`runs/final-aggregate.py` 从原始记录重算一切均值——**token 与质量同源，无硬编码数字**。

## 口径声明（与 EXP-A 对称公平口径的区别）

本装置为**非对称口径**，三个对照各自取其"无 SYNAPSE 时的自然形态"：

| 臂 | 形态 | 说明 |
|---|---|---|
| TXT | 纯文本协作朴素对照 | 四角色（naive-*），全文转贴，无结构化提示调优、无状态向量、无共享记忆 |
| SYN | SYNAPSE 产品强化形态 | 四角色（产品角色+工具白名单），截断传递+句柄（opt-pipeline 模板），状态向量+共享记忆+宿主蒸馏 |
| CrewAI | 框架默认用法 | sequential + 默认 context 传递（上游 Task 输出全文聚合给下游），产品四角色提示词，max_iter 限制 |
| AutoGen | 框架默认用法 | RoundRobinGroupChat 广播 + MaxMessageTermination(5)，reflect_on_tool_use=False（思考型模型空反思文本会中止，见代码注释） |

框架臂工具与 pi 臂对齐（窗口化 read、限量 grep——与 pi 内置工具同款行为，四臂同施）。

### 三机制消融臂（2026-10-04 密封轮新增）

在 SYN 产品形态基础上逐项关闭机制，其余（角色、模板、模型、题目、密封）完全一致：

| 臂 | 关闭项 | 说明 |
|---|---|---|
| ABFH | 压缩传递 | 阶段间全文转贴（ablation-fullhandover 模板，trunc 恒等），句柄/记忆/语料保留 |
| ABNM | 共享记忆 | `memory` 关闭（跨阶段/跨轮记忆读写与召回），截断传递与语料向量保留 |
| ABNC | 语料向量 | `corpusSnapshotId`/embedding 关闭（Retriever 退化为工具检索），截断传递与记忆保留 |

## 密封沙盒（2026-10-04 装置修正，最终口径）

10-04 晨的 pilot 轮审计发现：pi 臂以语料目录为 cwd 时，文件工具可向上逃逸，
读到题库文件（`experiments/data/swe-qa/Benchmark/flask.jsonl`、`experiments/bench/families/q-musique.json`
均含金标答案）与宿主仓——TXT q5 与 Q 族多个答案曾实质引用金标，相关轮全部作废。
最终轮（sealed）起每题将任务语料整份复制到临时目录作为 cwd，题库与宿主仓物理不在可达树上；
框架臂本就以 root 前缀校验密封，不受影响。装置修正详见 `p50o-runner.mjs` 头注与 `runs/README.md`。

## 装置文件（本目录）

- `p50o-runner.mjs` — pi 臂 runner（一轮一进程，密封沙盒，SYN/TXT/ABFH/ABNM/ABNC；
  计量取 subagent 结果事件的四子代理合计 usage + 父会话 usage）
- `framework_common.py` — 框架臂公共（题源/工作树/窗口化工具/记录；root 前缀密封）
- `run_crewai.py` — CrewAI 臂（终选配置 v7：产品提示词 + max_iter=6 + 窗口化工具）
- `run_autogen.py` — AutoGen 臂（RoundRobin 广播 + reflect_on_tool_use=False）
- `p50o-aggregate.mjs` / `p50o-final.mjs` — 配对 bootstrap 聚合 / 四臂总聚合
- `runs/final-aggregate.py` — 最终口径一键复核（token+质量同源重算）
- `runs/` — 全部 run 目录（计量/判分/答案/摘要）与沿革索引

角色与模板（仓根）：`agents/naive-*.md`（朴素对照四角色）、`agents/{planner,retriever,executor,summarizer}.md`
（产品角色）、`prompts/opt-pipeline.md`（截断传递模板）、`prompts/naive-pipeline*.md`（全文链模板）、
`prompts/ablation-fullhandover.md`（消融-全文转贴模板）。

## 运行（Windows 本机 / Node 22+ / Python venv with crewai+autogen-agentchat）

```bash
# pi 臂（SWE-QA Flask R 族；密封默认开，--seal 0 仅用于装置对照）
node experiments/p50o/p50o-runner.mjs --exp-dir <dir> --arms SYN,TXT,ABFH,ABNM,ABNC \
  --tasks 5 --family r --template-txt naive-pipeline \
  --pi-cli <pi-cli.js> [--corpus-root <corpus-cache>] [--timeout-ms 1500000]

# 框架臂（密封由 framework_common.py 的 root 前缀校验保证）
python experiments/p50o/run_crewai.py --exp <dir> --tasks 5
python experiments/p50o/run_autogen.py --exp <dir> --tasks 5

# judge（官方 SWE-QA 五维模板 × 5 票中位盲评，被测/判分同模型同通道）
node experiments/openeuler/shm/exp-ao-judge.mjs --exp-dir <dir> --family r --votes 5

# 一键复核（token+质量同源重算；legacy 复现已废弃的 10-04 晨口径）
python experiments/p50o/runs/final-aggregate.py [legacy]
```

MuSiQue（Q 族）：`--family q`（题源 `experiments/bench/families/q-musique.json`，
工作树 `experiments/data/worktree/musique`，TXT 模板用 `--template-txt naive-pipeline-q`）。

语料向量快照（SYN/ABFH/ABNM 臂）：`experiments/data/_corpus-cache/<CORPUS_ID>/`
（meta.json + vectors.f32 + chunks.json；`63a385a…`，text-embedding-v4/1024，flask 939 + musique 67 chunks）。

## 模型与密钥

被测与判分 LLM：**deepseek/deepseek-v4.1-flash @ commandcode**（`https://api.commandcode.ai/provider/v1`，
OpenAI 兼容；2026-10-05 起全部实验切换至该平台，`P50O_API_BASE`/`P50O_JUDGE_BASE` 可覆盖）。
语料向量嵌入（text-embedding-v4/1024）commandcode 无嵌入模型，保留百炼 dashscope。
密钥经环境变量 `COMMANDCODE_API_KEY`（LLM）与 `DASHSCOPE_API_KEY`（嵌入）注入（synapse/.env），不落仓库。
f1 轮起另支持 `--flow revisit`（连续任务流：5 题正跑 + 5 题逐字重访，storageRoot 跨轮持久），
判分配 `--revisit-mod 5` 将重访轮映射回原题 reference。

## 已知坑（本装置实测）

- 百炼内容审核会拦"整文件粘贴"型超长输入 → 朴素对照采用多次窗口读取而非整文件粘贴
- pi 子代理 completion guard 会把"实现类任务的只读子代理"误判失败 → 角色与模板均显式 `completionGuard: false`
- 多臂并发 ≥3 时内存峰值可能触发系统杀进程（exit 137）→ 每路至多一个重型 TXT 臂
- Windows 下 `fs.cpSync` 递归复制含 junction 的 `.venv` 会令 node 原生静默崩溃（exit 127）
  → 密封沙盒复制时过滤 `.venv` 并以 junction 回接（见 runner seal 块注释）

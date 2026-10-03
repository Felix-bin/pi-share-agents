# p50o — 数据优化口径实验装置（2026-10-03/04）

四臂同题配对装置：SYNAPSE 产品强化形态 vs 纯文本朴素对照 vs 两个主流框架的默认用法。
全部计量在 **API usage 层**（response usage 字段），无框架自报、无事后估算；每题证据
（prompt/answer/账本）随 run 目录留档，任何均值可回溯到原始记录。

## 口径声明（与 EXP-A 对称公平口径的区别）

本装置为**非对称口径**，三个对照各自取其"无 SYNAPSE 时的自然形态"：

| 臂 | 形态 | 说明 |
|---|---|---|
| TXT | 纯文本协作朴素对照 | 四角色（naive-*），全文转贴，无结构化提示调优、无状态向量、无共享记忆 |
| SYN | SYNAPSE 产品强化形态 | 四角色（产品角色+工具白名单），截断传递+句柄（opt-pipeline 模板），状态向量+共享记忆+宿主蒸馏 |
| CrewAI | 框架默认用法 | sequential + 默认 context 传递（上游 Task 输出全文聚合给下游），产品四角色提示词，max_iter 限制 |
| AutoGen | 框架默认用法 | RoundRobinGroupChat 广播 + MaxMessageTermination(5)，reflect_on_tool_use=False（思考型模型空反思文本会中止，见代码注释） |

框架臂工具与 pi 臂对齐（窗口化 read、限量 grep——与 pi 内置工具同款行为，四臂同施）。

## 装置文件

- `p50o-runner.mjs` — pi 双臂 runner（一轮一进程，SYN/TXT 同题配对；计量取 subagent 结果事件的四子代理合计 usage）
- `p50b_flask_common.py` — 框架臂公共（SWE-QA Flask 题源/工作树/工具/记录）
- `run_crewai_flask7.py` — CrewAI 臂（终选配置）
- `run_autogen_flask.py` — AutoGen 臂
- `p50o-aggregate.mjs` / `p50o-final.mjs` — 配对 bootstrap 聚合 / 四臂总聚合

角色与模板：`agents/naive-*.md`（朴素对照四角色）、`agents/{planner,retriever,executor,summarizer}.md`
（产品角色）、`prompts/opt-pipeline.md`（截断传递模板）、`prompts/naive-pipeline.md`（全文链模板）。

## 运行（Windows 本机 / Node 22+ / Python venv with crewai+autogen-agentchat）

```bash
# pi 双臂（SWE-QA Flask R 族）
node scripts/p50o-runner.mjs --exp-dir <dir> --arms TXT,SYN --tasks 5 --family r \
  --template-txt naive-pipeline [--timeout-ms 1500000]

# 框架臂
python scripts/p50b/run_crewai_flask7.py --exp <dir> --tasks 5
python scripts/p50b/run_autogen_flask.py --exp <dir> --tasks 5

# judge（官方 SWE-QA 五维模板 × 5 票中位，同通道）
node ../pi-share-agents-openeuler-wsl/experiments/openeuler/shm/exp-ao-judge.mjs --exp-dir <dir> --family r --votes 5

# 聚合
node scripts/p50o-final.mjs --dirs <expDir,...>
```

MuSiQue（Q 族）：`--family q` / `--family q`（题源 `experiments/bench/families/q-musique.json`，
工作树 `experiments/data/worktree/musique`）。

## 模型与密钥

被测与判分均 deepseek-v4.1-flash @ 百炼平台（dashscope compatible-mode），密钥经
DASHSCOPE_API_KEY 环境变量（synapse/.env），不落仓库。

## 已知坑（本装置实测）

- 百炼内容审核会拦"整文件粘贴"型超长输入 → 朴素对照采用多次窗口读取而非整文件粘贴
- pi 子代理 completion guard 会把"实现类任务的只读子代理"误判失败 → 角色与模板均显式 `completionGuard: false`
- 多臂并发 ≥3 时内存峰值可能触发系统杀进程（exit 137）→ 每路至多一个重型 TXT 臂

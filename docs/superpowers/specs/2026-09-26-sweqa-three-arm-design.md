# 同一 Pi harness 三臂 SWE-QA 实验：分发、token 与 Agent 间通信

- 日期：2026-09-26
- 状态：设计已逐节确认（2026-09-26 会话），待审阅 spec
- 相关：`experiments/swebench/`（本设计取代它）；`experiments/bench/llm-proxy.mjs`；`experiments/analysis/score-public.mjs`（SWE-QA judge 与 bootstrap 的现有实现）；`docs/experiments/experiment-design.md` §5.3、§7.1
- 取代：`a5e961f` 引入的 SWE-bench Lite 三臂 harness（硬切换，不保留）

## 1. 背景

### 1.1 为什么从 SWE-bench 换到 SWE-QA

`a5e961f` 的 SWE-bench Lite pilot（`pilot-20260926`，第一次尝试后中止）暴露了下面几个问题：

1. **分数需要 Docker。** SWE-bench 的 resolved 需要在各题的镜像里跑隐藏测试。本机 WSL 里没有 Docker，而用 LLM 来判 patch 得到的就不是 SWE-bench 分数了。
2. **执行环境不公平。** 宿主机上没有各仓库的依赖，子 agent 为了找 Python 执行了 `find / -name "python*"`，在 WSL 下这会扫遍整个 `/mnt/c`。每个臂在环境上的开销都很大，而且随机，直接污染了 token 和耗时这两项指标。
3. **计量口径对不上实验目的。**
   - `delegationCount` 把 `subagent {"action":"list"}` 也算作一次委派；
   - token 总量里算进了 cacheRead；
   - `observedHandoffBytes` 只统计父会话 RPC 上的字节，不是 token，还漏掉了宿主注入给子会话的内容。
4. **子会话加载了本仓库的 AGENTS.md。** 工作树放在 `experiments/data` 下，share 子会话的 system prompt 里出现了 `<project_instructions path=".../pi-share-agents/AGENTS.md">`：Pi 从 cwd 沿父目录向上查找，找到了本仓库的项目说明。
5. **固定模型条件有漏洞。** share 和 nico 的内置 agent 里有 `claude-code` / `codex-exec`，而本机正好装了这两个 CLI（`~/.local/bin`）。父会话一旦选中它们，子进程就换成了别的模型，调用也不经过记录代理。

旧实验的 R 组（SWE-QA Flask）用的是 SWE-QA 原版 LLM judge，不需要 Docker。SWE-QA 是只读的代码问答，不需要运行环境，上面第 2 条的问题也就不存在了。

### 1.2 实验目的

在同一个 Pi harness 下比较三个子代理扩展，指标有四项：

1. **Agent 分发数量**
2. **Token 消耗**：分层到父会话、子会话、agent 类型
3. **Agent 间通信 token**
4. **SWE-QA 分数**

比较对象是**整个委派扩展**，不单独分离 share 的记忆、状态、信封等机制的作用，那需要另做扩展内部的消融实验。

## 2. 实验条件

### 2.1 三个臂

| 臂 | 包 | 委派工具 | 配置 |
|---|---|---|---|
| `share` | 本仓库 checkout（commit 记入 manifest） | `subagent` | `asyncByDefault: false`；`synapse: { mode: "synapse", memory: "project", autoDistill: true, storageRoot: <每次尝试一个新目录> }` |
| `nico` | `npm:pi-subagents@0.71.0` | `subagent` | 包的默认配置 |
| `tintinweb` | `npm:@tintinweb/pi-subagents@0.19.0` | `Agent` | 包的默认配置 |

安装方式沿用 `prepare.mjs`：每个臂装在独立的 agent 目录里，模型目录只复制 `deepseek-flash` 的定义，不复制任何凭据。

### 2.2 固定条件

- **Pi**：父会话和所有子会话都用同一个 CLI，即 `../pi-web` 的 0.87.0，版本记入 manifest。
- **模型**：`deepseek/deepseek-flash`，`--thinking high`。
- **启动参数**：`-e <extension> --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session --offline --mode rpc`。
- **父会话工具**：只开委派工具（`--tools subagent`，或 `--tools Agent`），读仓库的工作全部由子 agent 完成。如果 pilot 证明某个臂只有这一个工具就完成不了前台委派，就补上它必需的最少工具，并在正式跑之前记入 manifest 和本 spec 的修订记录。
- **PATH**：Pi 进程的 PATH 只包含：
  - 一个包装目录，里面有两样东西：`pi`，指向上面那个 0.87.0 CLI，每次被调用都把 argv 追加写入证据目录的 `pi-invocations.log`；`node`，一个指向当前 node 可执行文件的链接；
  - `/usr/local/bin:/usr/bin:/bin`。

  这样一来，`claude`、`codex`、`cursor-agent` 在三个臂里都会显示为 missing，Windows 那边的路径也不会进入 PATH。
- **网络**：Pi 只能访问本地记录代理，代理用真实 key 连接 DeepSeek，Pi 和子进程拿到的是假 key（沿用现有做法）。
- **并发**：同一题的三个臂并发跑，让它们处在同一个 API 时间窗口里；题与题之间顺序执行。每次尝试用一个独立的代理实例。
- **超时**：每次尝试 20 分钟，只跑一次，失败的记录保留。
- **跨题状态**：没有。每次尝试都是全新的 Pi 会话；share 用全新的 `storageRoot`；上游两个臂各自的 agent 目录里如果有持久化状态，在每次尝试前清空，具体清哪些目录在 pilot 中核实后列入 manifest。

### 2.3 数据

- **来源**：SWE-QA-Bench（`experiments/data/swe-qa`），15 个仓库，每个仓库 48 题，commit 固定为 `repo_commit.txt` 中的值。短 sha 在 prepare 阶段解析成完整 sha，记入样本文件。
- **抽样**：按仓库分层，每个仓库抽 4 题，共 60 题。每个仓库的种子是 `(20260926 ^ fnv1a32(<仓库名>)) >>> 0`，只取决于仓库名，与仓库的遍历顺序无关。用这个种子初始化 mulberry32 生成器，对该仓库的 48 个题目下标做 Fisher–Yates 洗牌，取前 4 个。
- **样本文件**：写入 `experiments/data/sweqa/sample.jsonl`。每行包含 `id`（`<repo>#<源下标>`）、`repo`、`repoUrl`、`commit`（完整 sha）、`question`、`referenceAnswer`、`sourceIndex`。已存在时拒绝覆盖，SHA-256 记入 manifest。
- **仓库镜像**：用 blobless 的 bare clone（`--filter=blob:none`），放在 `experiments/data/sweqa/repos/`。

### 2.4 工作树与题面

- **工作树**：每次尝试都从镜像执行 `git archive <commit>`，导出到 `<工作根>/<尝试>/<repo>/`，不带 `.git`；尝试结束后删除。工作根放在 `os.tmpdir()` 下，不放在本仓库目录里，这样 agent 沿父目录往上走也碰不到 `experiments/data`。父会话的 cwd 是 `<工作根>/<尝试>/`。
- **题面**：由三部分组成：
  1. SWE-QA 原题，一字不改；
  2. R 组的固定说明："The code is the <owner>/<repo> repository at commit <短 sha>, in the <repo>/ directory of this worktree. Answer from the code, citing the files and functions involved."；
  3. 委派说明，大意是：你只能通过已安装扩展提供的委派工具工作；把调查交给子 agent，并在前台等待结果；最后一条回复写出完整答案。

  题面文本放在 `matrix.mjs` 里，SHA-256 记入 manifest。
- **答案**：父会话最后一条 assistant `message_end` 的文本部分。

## 3. 计量口径

所有计量都由离线脚本 `analyze.mjs` 从证据文件中计算，三个臂用同一套逻辑，不依赖任何扩展自己的账本。数据来源：

- `llm-calls.jsonl`：记录代理保存的每次调用的完整请求、响应和 usage；
- `pi-rpc.jsonl`：父会话的 RPC 事件流。

### 3.1 会话归因

对每次尝试的调用按顺序处理：

1. 一次调用的消息如果只有 system 加若干 user、还没有 assistant 轮，就开启一个新会话。
2. 如果它的消息以某个现有会话上一次调用的请求消息为前缀，就接到那个会话上。有多个候选时，取前缀最长的那个。比较消息时忽略 `reasoning_content`。
2a. 如果它带有历史消息、又接不上任何会话，但 system prompt 与所有现有会话都不同，就视为一个继承了父上下文的新会话，标记 `inheritedHistory`。如果它的 system prompt 与某个现有会话相同，就算作归因不了。
3. 首条 user 消息等于题面的会话是**父会话**，其余都是**子会话**。
4. 子会话的归属和 agent 类型按以下方式确定：父会话委派调用的参数里有任务文本，找到被包含在子会话首条 user 消息中的那一段，取对应调用的 agent 参数。匹配不上时，归到它启动时正处于执行窗口内的那次委派调用（窗口从该调用的响应开始，到发起方的下一次调用为止；有多个窗口时取最内层的那个），agent 类型记为 `unmatched`。会话本身照常计数。子会话再派出的子会话同样计入，并记录发起它的会话。
5. 归因不了的调用逐条列出，保留它们在日志中的原始顺序。

**判无效**：只要有调用归因不了，或者有调用的请求模型不是 `deepseek-flash`，这次尝试的计量就判为无效，原因写明，不做任何猜测性归因。

### 3.2 Agent 分发数量

- **主指标**：每次尝试中子会话的个数，并列出 agent 类型分布和嵌套深度。
- **辅助指标**：父会话发起委派调用的次数。`list` 这类不产生会话的调用不会出现在主指标里。

### 3.3 Token 消耗

每个会话按调用累加 usage，映射方式沿用 `llm-proxy.mjs`，与 pi-ai 一致：

- **prompt** = input（不含缓存）+ cacheRead + cacheWrite；
- **output** = completion，包含 reasoning；reasoning 另外单列。
- **总 token** = prompt + output。

报告里分三层：父会话、子会话合计、各 agent 类型。uncached input 和 cacheRead 也分别列出。

**和旧 §7.1 口径的差异**：§7.1 不把 cacheRead 计入总量。本实验把它计入，原因是缓存命中取决于 DeepSeek 服务端的缓存状态和并发时序，这些不是扩展设计造成的差异，按 §7.1 的口径会把这部分噪声混进比较里。

### 3.4 Agent 间通信

**原则**：凡是进入某个 agent 上下文、并且来自另一个 agent 或宿主交接机制的内容，都算通信；agent 自己用工作类工具干活拿到的结果不算。

**工作类工具**：Pi 内置的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`。

**通信类工具**：每个臂有一份显式清单，放在 `matrix.mjs` 里，例如 share 的 `synapse_read`、`synapse_search`。清单在 pilot 中逐一核实后冻结。两类都不属于的工具，结果单独列为"未分类"，不静默丢弃。

通信分三部分统计：

- **下行**（发给子 agent 的）：
  - 子会话首个请求里除 system 以外的全部消息，包括任务文本和继承来的父上下文；
  - 子会话 system prompt 的**可变部分**；
  - 子会话中途追加的非工具结果类 user 消息，比如 steer 或 supervisor 的回复。
- **上行**（回给调用方的）：
  - 派出过子会话的委派工具调用的结果，以及 `get_subagent_result` 的结果；
  - 扩展注入给父会话的其他消息，比如完成通知。
- **按需拉取**：子会话里通信类工具的返回内容。

**控制类**：没有派出子会话的委派工具调用，其结果（比如 `list` 返回的 agent 目录）单列为控制类，不计入通信。旧实验发现，这类工具文档曾占上行的 57–85%。

**system prompt 可变部分的算法**：

1. 先把每次尝试特有的字符串替换成占位符，包括工作根路径、尝试 id、日期。
2. 对同一臂、同一 agent 类型在整次运行中的全部首请求 system prompt，求最长公共前缀和最长公共后缀（两者不重叠），这是固定部分，剩下的是可变部分。
3. 如果某个 agent 类型在整次运行里只出现过一次，可变部分就无法计算，标记为 unavailable，该次尝试的通信合计标为"部分"。
4. 如果一段 system prompt 有多个注入点，中间夹着的固定文本也会被算进可变部分，所以可变部分是一个上界。报告里会注明这一点。

**单位**：字节数精确统计。换算成 token 用本次运行自己标定的比例：对同一会话内相邻的两次调用，计算 Δprompt_tokens 与新增消息的 Δbytes 之比，全部三个臂合在一起取中位数，报告里附上四分位范围。三个臂用同一个比例，所以按字节还是按 token 做判定，结论相同。判定按字节进行。

## 4. 评分

- **judge 提示词**：从 `experiments/data/swe-qa/Benchmark construction/score/llm-as-a-judge.py` 原样读取，提取方式和 `score-public.mjs` 相同。五个维度（correctness、completeness、relevance、clarity、reasoning）各 1–20 分，满分 100。
- **judge 模型**：deepseek provider 上的 `deepseek-flash`，调用方式为 `pi -p --no-tools --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`。
- **投票**：每个回答评 5 次，每个维度取中位数。解析失败最多重试 10 次，仍然拿不到分数就记为 unavailable。
- **盲评**：judge 只看到题目、参考答案和父会话的最终答案，看不到臂名。评分顺序按固定种子打乱。
- **时机**：评分在跑数全部结束后单独进行。judge 自己的 token 消耗单独记账，不计入实验。
- **披露**：judge 和被测模型是同一个模型，分数只能作为三臂之间的相对比较，不能和旧 R 组（judge 为 `glm-5.3-flashx`）的分数直接对比。

## 5. 有效性与判定规则（在跑数之前冻结）

### 5.1 有效尝试

一次尝试要同时满足以下条件才算有效：

1. Pi 在超时之前 `agent_settled`，没有抛异常；
2. 至少有 1 个子会话；
3. 最终答案不为空；
4. 每次调用都有 usage；
5. 所有调用都能归因（§3.1）；
6. 所有调用的模型都是 `deepseek-flash`；
7. 泄露审计通过（§5.2）。

无效尝试的分数和计量都记为 unavailable，不按 0 算。报告会把各臂的失败率和失败原因放在最前面。

### 5.2 泄露与越界审计

扫描全部会话的工具调用参数：

- **判无效**（原因记为"可能泄露"）：参数中出现本仓库的 `experiments/` 路径，或出现 `swe-qa`、`SWE-QA`、`sample.jsonl`、`llm-as-a-judge` 这类 benchmark 相关的路径或文件名。
- **只计数、不判无效**：其他访问工作根以外路径的调用（比如 `find /`、读取 `/usr/lib`）。按臂统计次数并报告。

### 5.3 配对比较与判定

- **比较对象**：share 对 nico、share 对 tintinweb。
- **范围**：只在双方都有效的题上比较，同时报告因无效被排除的题数。
- **统计方法**：每项指标取配对差 share − 基线，报告均值和 bootstrap 95% CI。重采样 10000 次，种子 20260921，复用 `score-public.mjs` 的实现。
- **"更少"**（分发数量、总 token、通信字节）：配对差 CI 的上界小于 0。
- **质量非劣**：配对差 CI 的下界大于 −5 分（δ = 5，满分 100，与 R 组相同）。
- **token 节省的证据资格**：质量没有被判为非劣时，token 或通信的节省照常报告，但标注"质量未证非劣"。

## 6. 文件布局

`experiments/swebench/` 改名为 `experiments/sweqa/`，删掉只和 SWE-bench 有关的部分（`download.py`、`export.mjs`、patch 提取、Docker 评测说明）。

| 文件 | 职责 |
|---|---|
| `matrix.mjs` | 臂、包、委派工具、父会话工具、通信类工具清单、题面、抽样函数 |
| `prepare.mjs` | 安装三个扩展；建仓库镜像；解析完整 sha；冻结 `sample.jsonl` |
| `run.mjs` | 逐题并发跑三个臂；manifest 记录 share 产品源码（`src`、`index.ts`、`package*.json`）的 git 对象哈希，续跑时比对；收窄 PATH、包装 `pi`；导出和清理工作树；取答案；写证据和 `result.json` |
| `analyze.mjs` | 会话归因、分发、token、通信、泄露审计、比例标定；写每次尝试的 `metrics.json` |
| `score.mjs` | SWE-QA judge；写 `scores.jsonl` |
| `report.mjs` | 汇总三臂，配对 bootstrap，套用判定规则；写 `report.json` 和 `report.md` |
| `test.mjs` | 单元测试和集成测试（§7） |
| `README.md` | 准备、跑数、评分、报告的步骤和口径说明 |

`docs/experiments/experiment-design.md` 和 `experiments/README.md` 顶部的入口说明改为指向 `experiments/sweqa/`。

我在 SWE-bench pilot 期间建的 `experiments/data/.venv` 删除。已有的 `experiments/data/swebench/` pilot 数据只留在本地（被 git 忽略），不进入任何结论。

## 7. 测试与 pilot

### 7.1 自动测试（`node --test experiments/sweqa/test.mjs`）

- **抽样**：同一种子下结果确定；每个仓库 4 题；源下标不重复；样本文件已存在时拒绝覆盖。
- **会话归因**：前缀链接；多个候选时取最长前缀；父会话识别；子会话再派子会话；归因不了的调用判无效；模型不符判无效。
- **分发**：`list` 这类不产生会话的调用不计数；agent 类型能正确匹配，匹配不上时记为 `unmatched`。
- **通信**：下行、上行、按需拉取三部分的分类；未分类工具单独列出；system prompt 固定和可变部分的拆分，包括只出现一次时标 unavailable；占位符替换。
- **比例标定**：用合成的相邻调用验证中位数和四分位范围的计算。
- **泄露审计**：越界路径和 benchmark 文件名都能被识别。
- **judge**：提示词原样提取；解析；中位数投票；解析失败达到上限后记为 unavailable。
- **报告**：配对只在双方都有效的题上进行；unavailable 不按 0 算；判定规则的边界情况。
- **集成**：沿用现有的假 Pi CLI 做法，跑通 `run.mjs` → `analyze.mjs` 全流程，覆盖工作树的导出和清理、PATH 收窄、`pi-invocations.log`。

### 7.2 pilot

3 个仓库各 1 题（flask、requests、sphinx），每题跑 3 个臂，共 9 次尝试，运行 id 用 `pilot-*`。pilot 要确认：

1. 子会话的调用都经过记录代理，模型是 `deepseek-flash`；`pi-invocations.log` 证明子进程用的是 0.87.0；
2. 在三个臂里，`claude` / `codex` 都显示为 missing；
3. 每个臂只用委派工具就能完成前台委派；
4. 每个臂实际用到的工具，据此冻结通信类工具清单；
5. 上游两个臂需要在每次尝试前清空的持久化目录；
6. 会话归因没有归因不了的调用；
7. 字节/token 比例的标定结果，以及单次尝试的耗时和 token 量级，用来估算正式跑的时长和成本。

pilot 的数据不与正式数据合并。pilot 暴露问题后，修改会在正式跑之前记入本 spec 末尾的修订记录。

## 8. 有效性威胁

| 威胁 | 处理 |
|---|---|
| judge 和被测模型是同一个模型 | 三个臂的答案都出自同一个模型，自我偏好对三臂的影响大致相同；只报告相对比较，并披露不能和旧 R 组对比 |
| 配置不对称：share 用非默认配置，上游用默认配置 | 结论表述为"share 的这套配置对比上游的默认配置"；配置记入 manifest |
| 比较的是整个扩展，而不是具体机制 | 如实声明；机制层面的作用留给扩展内部的消融实验 |
| 每个"臂 × 题"只跑一次，编排者行为的波动大 | 60 题配对加 bootstrap CI；波动反映在 CI 的宽度里，不另做重复 |
| agent 拥有宿主机权限，可能去读答案 | 工作根放在仓库外；泄露审计失败即判无效（§5.2） |
| 并发导致 API 争用 | 三个臂同时跑，所受影响对称；墙钟时间只作为辅助指标 |
| system prompt 可变部分是上界 | 在报告中注明；下行里的消息部分是精确值 |

## 修订记录

- 实现期（2026-09-26，任何 SWE-QA 数据之前）：§3.1 增加 2a 条（继承父上下文的会话）与执行窗口归属；§3.4 增加控制类；§1.1 增加第 4 条（AGENTS.md）；runner 冻结 share 产品源码的哈希，而不是 HEAD commit，因为实验代码自身的提交不改变被测扩展。

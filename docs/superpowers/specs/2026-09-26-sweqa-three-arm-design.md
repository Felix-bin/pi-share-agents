# 同一 Pi harness 四臂 SWE-QA 实验：分发、token 与 Agent 间通信

- 日期：2026-09-26
- 状态：设计已逐节确认（2026-09-26 会话）；pilot2 之后按用户裁定改为四臂（见修订记录）
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

### 2.1 四个臂

| 臂 | 包 | 题面 | 配置 |
|---|---|---|---|
| `share` | 本仓库 checkout（产品源码哈希记入 manifest） | 题目 + 委派说明（§2.4） | `asyncByDefault: false`；`synapse: { mode: "synapse", memory: "project", autoDistill: true, storageRoot: <每次尝试一个新目录> }` |
| `share-pipeline` | 同上，装在自己的 agent 目录里 | `/role-pipeline <题目>`，由 Pi 按包自带的模板展开 | 同 share |
| `nico` | `npm:pi-subagents@0.71.0` | 题目 + 委派说明 | 包的默认配置 |
| `tintinweb` | `npm:@tintinweb/pi-subagents@0.19.0` | 题目 + 委派说明 | 包的默认配置 |

share-pipeline 和 share 用的是同一个包，差别只在于它按插件推荐的四角色流水线（planner → retriever → executor → summarizer）工作。share 的阶段结果块、句柄兑现、自动蒸馏等机制主要挂在这四个角色上，自由编排时多数不会触发。

安装方式沿用 `prepare.mjs`：每个臂装在独立的 agent 目录里，且只装自己的那一个包。模型目录只复制模型定义，不复制任何凭据。

### 2.2 固定条件

- **Pi**：父会话和所有子会话都用同一个 CLI，即 `../pi-web` 的 0.87.0，版本记入 manifest。
- **模型**：commandcode 上的 `deepseek/deepseek-v4.1-flash`，`--thinking high`。目录里这个模型没有声明 `maxTokens` 和 `contextWindow`，分别设为 32768（同 E1 修订 16）和 1048576（与 DeepSeek 官方定义一致），都记入 manifest。
- **启动参数**：`--no-themes --no-context-files --no-session --offline --mode rpc --provider commandcode --model deepseek/deepseek-v4.1-flash --thinking high`。不带 `-e`，也不带 `--no-extensions --no-skills --no-prompt-templates`：Pi 加载 agent 目录里已安装的整个插件包，包括扩展、skills 和 prompt 模板，剩下的由插件自己决定。
- **父会话工具**：Pi 的默认内置工具（`read`、`bash`、`edit`、`write`），加上插件注册的全部工具。
- **PATH**：Pi 进程的 PATH 只包含：
  - 一个包装目录，里面有两样东西：`pi`，指向上面那个 0.87.0 CLI，每次被调用都把 argv 追加写入证据目录的 `pi-invocations.log`；`node`，一个指向当前 node 可执行文件的链接；
  - `/usr/local/bin:/usr/bin:/bin`。

  这样一来，`claude`、`codex`、`cursor-agent` 在四个臂里都会显示为 missing，Windows 那边的路径也不会进入 PATH。
- **网络**：Pi 只能访问本地记录代理，代理用真实 key 连接 `https://api.commandcode.ai/provider/v1`，Pi 和子进程拿到的是假 key。真实 key 只通过环境变量 `COMMANDCODE_API_KEY` 交给 runner，不写入任何文件。
- **并发**：同一题的四个臂并发跑，让它们处在同一个 API 时间窗口里；题与题之间顺序执行。每次尝试用一个独立的代理实例。
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
  3. 委派说明，share-pipeline 没有这一部分：用已安装的子代理扩展把仓库调查交给子 agent；等所有结果都回来再回答，不要留下后台任务；最后一条回复写出完整答案。说明里不写工具名，也不规定怎么派。

  题面文本放在 `matrix.mjs` 里，SHA-256 记入 manifest。
- **答案**：父会话最后一条 assistant `message_end` 的文本部分。

## 3. 计量口径

所有计量都由离线脚本 `analyze.mjs` 从证据文件中计算，四个臂用同一套逻辑，不依赖任何扩展自己的账本。数据来源：

- `llm-calls.jsonl`：记录代理保存的每次调用的完整请求、响应和 usage；
- `pi-rpc.jsonl`：父会话的 RPC 事件流。

### 3.1 会话归因

对每次尝试的调用按顺序处理：

1. 一次调用的消息如果只有 system 加若干 user、还没有 assistant 轮，就开启一个新会话。
2. 如果它的消息以某个现有会话上一次调用的请求消息为前缀，就接到那个会话上。有多个候选时，取前缀最长的那个。比较消息时忽略 `reasoning_content`。
2a. 如果它带有历史消息、又接不上任何会话，但 system prompt 与所有现有会话都不同，就视为一个继承了父上下文的新会话，标记 `inheritedHistory`。如果它的 system prompt 与某个现有会话相同，就算作归因不了。
3. 本次尝试的第一次调用开出的会话是**父会话**，前提是它不带历史消息；其余都是**子会话**。子会话要等父会话的第一次响应返回之后才可能启动。share-pipeline 的题面是由 Pi 展开的模板，不能靠题面文本来识别父会话。
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
  - 派出过子会话的委派工具调用的结果，以及取回类工具的结果：`get_subagent_result`、`bg_wait`、`subagent_supervisor`；
  - 扩展注入给父会话的其他消息，比如完成通知。
- **按需拉取**：子会话里通信类工具的返回内容。

**控制类**：没有派出子会话的委派工具调用，其结果（比如 `list` 返回的 agent 目录）单列为控制类，不计入通信。旧实验发现，这类工具文档曾占上行的 57–85%。

**system prompt 可变部分的算法**：

1. 先把每次尝试特有的字符串替换成占位符，包括工作根路径、尝试 id、日期。
2. 对同一臂、同一 agent 类型在整次运行中的全部首请求 system prompt，求最长公共前缀和最长公共后缀（两者不重叠），这是固定部分，剩下的是可变部分。
3. 如果某个 agent 类型在整次运行里只出现过一次，可变部分就无法计算，标记为 unavailable，该次尝试的通信合计标为"部分"。
4. 如果一段 system prompt 有多个注入点，中间夹着的固定文本也会被算进可变部分，所以可变部分是一个上界。报告里会注明这一点。

**单位**：字节数精确统计。换算成 token 用本次运行自己标定的比例：对同一会话内相邻的两次调用，计算 Δprompt_tokens 与新增消息的 Δbytes 之比，全部四个臂合在一起取中位数，报告里附上四分位范围。四个臂用同一个比例，所以按字节还是按 token 做判定，结论相同。判定按字节进行。

## 4. 评分

- **judge 提示词**：从 `experiments/data/swe-qa/Benchmark construction/score/llm-as-a-judge.py` 原样读取，提取方式和 `score-public.mjs` 相同。五个维度（correctness、completeness、relevance、clarity、reasoning）各 1–20 分，满分 100。
- **judge 模型**：被测模型本身，即 commandcode 上的 `deepseek/deepseek-v4.1-flash`，调用方式为 `pi -p --no-tools --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`。judge 也经过它自己的记录代理，token 用量取自 `judge-calls.jsonl`。
- **投票**：每个回答评 5 次，每个维度取中位数。解析失败最多重试 10 次，仍然拿不到分数就记为 unavailable。
- **盲评**：judge 只看到题目、参考答案和父会话的最终答案，看不到臂名。评分顺序按固定种子打乱。
- **时机**：评分在跑数全部结束后单独进行。judge 自己的 token 消耗单独记账，不计入实验。
- **披露**：judge 和被测模型是同一个模型，分数只能作为四臂之间的相对比较，不能和旧 R 组（judge 为 `glm-5.3-flashx`）的分数直接对比。

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

- **比较对象**：share 对 nico、share 对 tintinweb、share-pipeline 对 nico、share-pipeline 对 tintinweb、share-pipeline 对 share（流水线相对自由编排）。
- **范围**：只在双方都有效的题上比较，同时报告因无效被排除的题数。
- **统计方法**：每项指标取配对差（处理臂 − 基线），报告均值和 bootstrap 95% CI。重采样 10000 次，种子 20260921，复用 `score-public.mjs` 的实现。
- **"更少"**（分发数量、总 token、通信字节）：配对差 CI 的上界小于 0。
- **质量非劣**：配对差 CI 的下界大于 −5 分（δ = 5，满分 100，与 R 组相同）。
- **token 节省的证据资格**：质量没有被判为非劣时，token 或通信的节省照常报告，但标注"质量未证非劣"。

## 6. 文件布局

`experiments/swebench/` 改名为 `experiments/sweqa/`，删掉只和 SWE-bench 有关的部分（`download.py`、`export.mjs`、patch 提取、Docker 评测说明）。

| 文件 | 职责 |
|---|---|
| `matrix.mjs` | 臂、包、委派工具、父会话工具、通信类工具清单、题面、抽样函数 |
| `prepare.mjs` | 安装三个扩展；建仓库镜像；解析完整 sha；冻结 `sample.jsonl` |
| `run.mjs` | 逐题并发跑四个臂；manifest 记录 share 产品源码（`src`、`index.ts`、`prompts`、`skills`、`package*.json`）的 git 对象哈希，续跑时比对；收窄 PATH、包装 `pi`；导出和清理工作树；取答案；写证据和 `result.json` |
| `analyze.mjs` | 会话归因、分发、token、通信、泄露审计、比例标定；写每次尝试的 `metrics.json` |
| `score.mjs` | SWE-QA judge；写 `scores.jsonl` |
| `report.mjs` | 汇总四臂，配对 bootstrap，套用判定规则；写 `report.json` 和 `report.md` |
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

- 实现期（2026-09-26，任何 SWE-QA 数据产生之前）：§3.1 增加 2a 条（继承父上下文的会话）与执行窗口归属；§3.4 增加控制类；§1.1 增加第 4 条（AGENTS.md）；runner 冻结 share 产品源码的哈希，而不是 HEAD commit，因为实验代码自身的提交不改变被测扩展。
- pilot `pilot-20260926`（flask#37、requests#7 两题，5 次尝试后中止，数据不用于任何结论）暴露的问题及处置，均在下一轮 pilot 之前完成：
  1. **`rg` / `fd` 缺失。** Pi 的 `grep`、`find` 工具先在 `<agentDir>/bin` 找这两个程序，然后才找 PATH；各臂的 agent 目录里没有，`--offline` 又不允许下载，内置工具因此不可用，子 agent 只能退回 bash。处置：prepare 把宿主机 `~/.pi/agent/bin/{rg,fd}` 复制进各臂的 `bin/`，并把哈希记入 `installed.json`；每次尝试的 bin 目录也放上它们的链接。
  2. **`find /` 扫遍 `/mnt/c`。** tintinweb 在 flask#37 上执行 `find / -name markupsafe`，在 WSL 下遍历整个 Windows 盘，最终超时。处置：不拦截；超时判无效，并如实报告。第 1 条修复后，agent 退回 bash 的动机会变小。
  3. **临时目录共享。** pi-subagents 系（share、nico）把运行状态和输出产物放在 `os.tmpdir()/pi-subagents-uid-<uid>/`，所有尝试共用这一个目录。处置：每次尝试设独立的 `TMPDIR`，结束后复制进证据目录；分析时把它视为该尝试自己的目录。
  4. **agent 类型识别。** 三个臂的子会话 system prompt 都带有 `<active_agent name="…"/>`。处置：它成为 agent 类型的首要来源，任务文本匹配作为后备。这样 workflowScript 派出的子会话也能识别出类型。
  5. **system prompt 中的运行期标识。** 产物路径里含有 uuid 和 call id。处置：在拆分固定部分和可变部分之前，把它们替换为占位符。
  6. **越界审计的口径。** 原来会把写入文件的内容也当成路径。处置：只审计 bash 的 `command` 和各工具的 `path` 类参数，并记录前 20 个越界路径。
  7. **share 在 requests#7 上卡住。** 4 分钟内完成 97 次调用、没有任何错误之后，再没有新的调用。代理只在调用完成后才写日志，所以卡在哪里无法判断。处置：记录代理跟踪进行中的请求（`inflight()`），尝试失败时把它们写入 `result.json` 的 `inflightAtEnd`。
  8. **子进程使用的 CLI。** 核实结果：share 和 nico 用 `process.argv[1]` 启动父进程正在运行的 CLI，tintinweb 在进程内起会话，所以三个臂的子会话都用固定的 0.87.0，`pi-invocations.log` 为 0 属于预期。
  9. **通信类工具清单。** 实际观察到的工具都在现有清单之内（工作类工具、`subagent`、`Agent`），没有未分类的工具。清单维持不变。

  观察记录（不是修订）：share 在 requests#7 上用 workflowScript 并行派出 scout ×2、retriever、reviewer 四个子会话。reviewer 以 1–60 行的窗口大量读取，上下文涨到 15.9 万 token，51 次调用累计约 401 万 prompt token；同一题 nico 用了 51 万，tintinweb 用了 26 万。这是被测扩展自身的行为，由正式数据来衡量。
- pilot `pilot2-20260926`（3 题 × 3 臂，9 次尝试全部完成，数据不用于任何结论）之后，用户裁定四项改动，均在正式数据产生之前完成：
  1. **父会话工具**：去掉 `--tools` 限制，改用 Pi 默认工具加插件工具。题面仍然要求委派，但不规定方式；没有子会话的尝试仍然判为无效。
  2. **新增 `share-pipeline` 臂**：share 的自由编排不会走 role-pipeline，协议机制多数不触发（pilot2 中 `memory-redeem` 为 0，也没有出现句柄）。配对比较相应扩展为 5 组。
  3. **整包加载插件**：每个臂都加载已安装的整个插件包，不再只用 `-e` 入口，也不再关闭 skills 和 prompt 模板。RPC `get_commands` 核实：share 系有 7 个模板（含 `role-pipeline`）和 2 个 skill；nico 有 6 个模板和 2 个 skill；tintinweb 只有扩展命令。
  4. **provider 改为 commandcode**：模型为 `deepseek/deepseek-v4.1-flash`，key 只通过环境变量传入。judge 同步改用这个模型。

  随之调整：§3.1 父会话按第一次调用来识别；share 产品源码的冻结范围加入 `prompts/` 和 `skills/`。
  pilot3 开跑时核实：父会话有了默认工具之后，pi-subagents 系的父会话还会拿到 `bg_wait` 和 `subagent_supervisor`。两者返回的都是子会话的结果或请求，归为取回类，计入上行。
- pilot3 分析时发现：Pi 发给 commandcode 的请求里，system prompt 的 role 是 `developer`。分析器原先只认 `system`，结果 agent 类型识别失败，system prompt 还被当成下行任务。现在两种 role 都视为 system prompt。这一处只影响分析，已有数据可以直接重算。
- pilot3（flask#37 四臂完成，requests#7 只完成 tintinweb，其余中止；数据不用于任何结论）暴露的两个问题，均在 pilot4 之前处置：
  1. **agent 目录暴露。** tintinweb 的父会话从 `PI_CODING_AGENT_DIR` 找到了自己的 agent 目录，并对其执行 `ls`、`cat`。这个目录位于 `experiments/data/sweqa/agent/` 下，往上两层就是 `sample.jsonl`，旁边的 `runs/` 里还有其他臂的答案。此外，agent 目录会跨尝试积累状态（tintinweb 的 `sessions/`，share 的 `missions/`、`run-history.jsonl`），违反 §2.2 的"跨题状态：没有"。处置：每次尝试只复制加载插件所需的文件（`settings.json`、`models.json`、`bin/`、`npm/`），放到工作根下的 `.agent/<题>/<臂>`，并把本地包路径改写为绝对路径；尝试结束后，把 agent 在该目录里写下的内容存入证据（不含 `npm/` 和 `bin/`），再删除副本。安装目录本身不再被任何尝试改写。分析时把这个副本视为该尝试自己的目录。
  2. **后台派发的归因。** nico 以后台方式派发（调用立即返回句柄），子会话在父会话进行下一次调用之后才启动，执行窗口因此已经关闭；任务文本又藏在 workflowScript 里，按文本也匹配不上。处置：§3.1 第 4 条的归属规则变为三级：任务文本匹配 → 执行窗口 → 此前最近一次"发起类"委派调用（带任务、agent 或 workflowScript；`list`、`status`、`interrupt` 等不算）。每个子会话记录它按哪一级归属（`attribution`）。
- pilot4（仅 flask#37，四臂都跑完，数据不用于任何结论）的分析暴露了两处归因问题，已修正，只影响分析：
  1. nico 父会话的 system prompt 在第一轮之后被改写：`subagent` 工具延后注册，prompt 多了一行工具说明，原来的前缀链接因此断开。处置：会话链接只比较对话消息，不比较 system prompt；允许同一会话的 system prompt 被改写，但 `<active_agent>` 身份不能变，身份变了就是另一个会话。被改写的字节单独报告为 `systemRewrites`，不计入通信。
  2. tintinweb 的首次调用遇到网络失败，Pi 原样重试了一次。原来的规则把重试当成了"父会话重启"。处置：内容与上一次失败调用完全相同的调用算作重试，归入同一会话；只有成功的调用缺 usage 才判无效，失败的调用计入 `audit.failedCalls`。


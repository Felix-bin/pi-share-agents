# 初赛机制迁移覆盖核验（对照 Python 原型）

> **核验日期**：2026-09-20
> **基准（初赛交付）**：Python 原型 `master`，`源代码及readme文档/src/synapse/` 共 41 个文件（含各包
> `__init__.py`）。`master` 上的模块清单经 `git ls-tree -r --name-only master` 逐条取定，
> **不含** v5 分支新增的 `runtime/oeipc.py`、`runtime/node.py`、`qa/distributed.py`、
> `memory/{bandit,policy,drift}.py` —— 这些是初赛之后的工作，不在本次迁移范围。
> **被核验方**：本仓库 `src/synapse/`，HEAD `27defe1`（分支 `feat/p4-delta-wiring`）。
> **方法**：对原型的每一个模块，在本仓库找对应实现并核对代码与测试证据；每条判定都给出可复算的
> 证据位置。判定分四档：**已迁移**（等价或更强）/ **降级迁移**（功能在，语义收窄）/ **未迁移** /
> **不适用**（分工或与原型默认态一致）。

---

## 1. 赛题硬要求（M1–M11）逐条

| 编号 | 要求要点 | 本仓库状态 | 证据 |
|---|---|---|---|
| M1 | ≥3 Agent、≥3 类角色、多步复杂任务 | ✅ 四个角色 `planner`/`retriever`/`executor`/`summarizer`（覆盖赛题点名的全部四类） | `src/synapse/roles.ts:20`、`roles.ts:54-59`；角色提示词 `agents/{planner,retriever,executor,summarizer}.md` |
| M2 | 结构化通信（动作/参数/结果/能力）+ 握手/能力发现/协议映射 | 🟡 动作、参数、能力、能力协商齐备；**无运行时能力探测**、无 A2A 协议映射 | `envelope.ts:132-152`（`action`/`inputParamsJson`/`capabilityId`/`stateRef`/`memoryRefs`）、`capability.ts:100-127`（协商）、`roles.ts:79`（能力声明） |
| M3 | 纯文本 ⊕ 结构化双模式，同条件 A/B | ✅ 三态开关，比原型的两态更细 | `config.ts:19`（`SYNAPSE_MODES = ["off","text","synapse"]`）、`capability.ts:104/118` |
| M4 | 非文本中间状态传递（生成/传递/接收/使用四环） | ✅ 四环齐备；**语义校验换成了密码学完整性校验**（见 §3） | `embedding.ts`（生成）、`state-payload.ts:89-119`（选档+封装）、`content-store.ts`（存储）、`state-retrieval.ts`（接收+排序）、`envelope.ts:57-66`（`StateRef`） |
| M5 | 共享记忆单元（ID/来源 Agent/创建时间/任务主题/摘要） | ✅ 五项元数据齐备，另有种类、确信度、标签、来源指纹、取代状态 | `memory-store.ts:64-77`（`MemoryRecord`）、`memory-store.ts:57-62`（`provenance.agent`） |
| M6 | 关键词/标签/语义检索 + 跨 Agent 跨任务复用 | ✅ 三路检索（0.3/0.2/0.5 语义融合；无向量时如实报 unavailable），跨 Agent 复用计数在计量里 | `retrieval.ts`、`metering.ts:107-108`（`memory-query`/`memory-reuse`） |
| M7 | ≥2 组关联性连续任务验证 | ❌ **未迁移**：本仓库无任务族定义，也没有 A/B 运行器 | 见 §2「缺口 A」 |
| M8 | 消息数/文本开销/非文本规模/耗时/命中率/提升 | ✅ 计量层覆盖全部六项，且**拒绝代理值** | `metering.ts:48-123`（事件）、`metering.ts:200-206`（聚合：`hitRate`/`crossAgentReuses`/`textBytes`/`payloadBytes`/`duration.byTask`）、`metering.ts:201`（`transportBytes: "N/A"`——不报代理值） |
| M9 | 五大模块 + ≥10 轮连续任务 | 🟡 五大模块齐备（协议/状态/记忆/运行时/计量）；**≥10 轮的执行装置未迁移** | 同 M7 |
| M10 | 源码+文档+部署+实验报告+视频，openEuler 可复现 | 🟡 本仓库层面：openEuler 适配归操作系统分支；文档在 | `docs/`、README |
| M11 | CodeAct + 轻量沙箱（加分） | ❌ **未迁移**（原型有双档执行器与边界实测报告） | 见 §2「缺口 B」 |

---

## 2. 模块级对照

| 原型（Python，初赛 master） | 本仓库（TypeScript） | 判定 |
|---|---|---|
| `protocol/messages.py` 结构化消息单元 + 大结果 spill 句柄 | `envelope.ts`、`canonical-json.ts` | **已迁移（更强）**：TypeBox 全字段校验、未知字段拒绝（`additionalProperties: false`）、canonical JSON 保证同参数同字节 |
| `protocol/handshake.py` CNR：`hello`/`discover`/`negotiate` + `check_fn` 运行时探测（TTL） | `capability.ts` | **降级迁移**：协商在，但只有 `state`/`text`/`refused` 三出口；无 probe 运行时探测、无多档编码秩（原型 hidden>residual>embedding>text）、无 A2A 映射 |
| `protocol/scheduler.py` | `delegation.ts`、`handoff.ts`、`lifecycle.ts` | 已迁移（调度由宿主 Pi 运行时驱动，形态不同） |
| `protocol/transport.py`（AF_UNIX 长度前缀 framing / 进程内） | `envelope-inbox.ts`（同侧文件投递） | 已迁移（形态不同）；Socket / 共享内存属操作系统适配面 |
| `stateplane/embedding.py` | `embedding.ts` | 已迁移（更强：线格式按 provider 显式声明、两级缓存计入计量、已存密钥回落） |
| `stateplane/residual.py`（率失真编码 + 自适应索引宽度 + `verify()`） | `delta.ts`、`delta-params.ts`、`state-payload.ts` | 已迁移；**收窄**：`verify()` 的语义校验换为发送侧准入策略 + 密码学完整性校验 |
| `stateplane/cas.py` | `content-store.ts` | 已迁移 |
| `stateplane/checksum.py` | `canonical-json.ts`、`source-fingerprint.ts` | 已迁移（更强：语料与载荷的端到端摘要校验） |
| `stateplane/vector_index.py`（纯 Python 暴力索引） | `corpus.ts` + `state-retrieval.ts` | 已迁移（两侧同为暴力余弦，均未引入 faiss） |
| `stateplane/projection.py`（JL 投影，默认关） | —— | **不适用**：原型该能力默认关闭（`residual_project_dim > 0` 才惰性构建），不迁移与其默认态一致 |
| `memory/store.py`（`MemoryUnit` + CAS 去重） | `memory-store.ts` | 已迁移（更强：不可变记录 + 取代事件重放派生状态 + 孤儿正文报告） |
| `memory/retrieval.py`（关键词 jaccard + 标签 + 余弦融合） | `retrieval.ts` | 已迁移（更强：无向量时语义位如实报 `unavailable`，不用哈希占位） |
| `memory/consolidate.py`（记忆固化/合并） | —— | **未迁移**（有取代 `supersede`，但不是合并式固化） |
| `memory/tom.py`（`ToMPredictor`） | `predict-base.ts`、`memory-service.ts` | **功能位等价、方法不同**：以语义相似度选基，无显式心智理论建模 |
| `modes/text_mode.py`、`modes/synapse_mode.py` | `config.ts` 的 `synapse.mode`、`capability.ts` | 已迁移（更强：`off`/`text`/`synapse` 三态） |
| `runtime/team.py`（`build_team`：角色 + 能力 + check_fn） | `roles.ts` + Pi 委派运行时 | 已迁移 |
| `runtime/exec_child.py`（子侧启动契约） | `child-contract.ts`、`lifecycle.ts`、`access.ts` | 已迁移 |
| `runtime/model.py`、`runtime/subprocess_executor.py`（CodeAct 双档执行器） | —— | **未迁移**（赛题 M11 加分项） |
| `eval/harness.py`（`ABRunner`）、`eval/manifest.py`、`eval/schema.py`、`eval/metrics.py` | `metering.ts` + `docs/experiments/` | **部分迁移**：计量与指标在且更强（拒报代理值、父侧 writer 才计总时长）；**缺 A/B 运行器、manifest 自动采集、结果 schema 校验** |
| `qa/dataset.py`、`qa/pipeline.py`、`qa/harness.py`、`qa/scoring.py`、`qa/stats.py` | —— | **未迁移**：数据集加载、F1/EM 打分、bootstrap CI 与配对检验在本仓库没有对应物 |
| `tasks.py`（G1/G2 关联任务族、漂移序列、负样本族） | —— | **未迁移**：连续任务序列目前写在实验 runbook 里人工冻结 |
| `cli.py`（`smoke`/`probe`/`ab`/`signal`/`m7`/数据集子命令） | `setup-command.ts` + Pi 斜杠命令 | **降级迁移**：只剩配置与状态报告入口，无自检/探针/A-B 子命令 |
| `config.py`、`prompts.py` | `config.ts`、`agents/*.md` | 已迁移 |

---

## 3. 三处「形似而实异」的机制，必须随数字一起说明

1. **残差可靠性校验的层级不同。** 原型是 VLC：接收方重嵌入比对 `cos(Ŷ, Y_true)`，语义失配才回退全文。
   本仓库**刻意不重嵌入原查询**（`state-retrieval.ts:13-17` 的设计声明），改为：发送侧准入（残差必须
   小于向量、且不超过其一半，`state-payload.ts:115`）+ 接收侧密码学与结构校验（摘要、维度、表示、
   非零向量、分块数，`state-retrieval.ts:110-188`）。**能防篡改与错位，不能防"语义偏移但字节完好"**。
2. **能力发现是"声明式"而非"可验证承诺"。** 原型握手时对声明项跑真实探针（`check_fn` + TTL），
   本仓库的能力来自"角色声明 ∩ 实际授予的工具"（`roles.ts:69-90`），不做事后实测。
3. **"载体"从消息体换成宿主信封。** 原型的残差句柄与内容句柄走自建消息帧；本仓库走宿主生成的
   信封，且 `stateRef` 只在 `retrieve` 动作上承载（`capability.ts:119`）。协议版本号是
   `SYNAPSE_PROTOCOL_VERSION = 2`（`envelope.ts:20`），未知字段一律拒绝。

---

## 4. 缺口清单与处置建议

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| A | **连续任务装置**（对应原型 `tasks.py` + `eval/harness.py`） | 赛题 M7「≥2 组关联连续任务」与 M9「≥10 轮」的直接证据来源；也是 P4-5 与决赛实验的执行基座 | **建议迁移**（改写为 TypeScript，落在实验脚本层） |
| B | **CodeAct + 轻量沙箱**（原型 `runtime/model.py` + `subprocess_executor.py`） | 赛题 M11 加分项，原型有双档执行器与边界实测报告可背书 | **需裁决**：本仓库设计规范 v1.1 明确"不实施 CodeAct"，重新引入是范围变更 |
| C | **评测装置**：A/B 运行器、manifest 自动采集、结果 schema 校验、配对统计 | 支撑"实验验证"分值与决赛的可复现要求；不补则每轮实验靠人工聚合 | **建议迁移**（打分与统计按决赛所需数据集裁剪） |
| D | **CNR 运行时能力探测 + 多档编码秩** | M2 的"能力发现"深度；原型把"声明即可验证"作为卖点 | **建议迁移探测**（与现有 `CapabilityDeclaration` 结构天然契合）；多档秩视状态面叙事是否需要 |
| E | **`memory/consolidate.py`**（记忆固化/合并） | M6 记忆演化的完整度 | 评估后迁移，或明确记录"以取代事件 + 不可变日志替代"的判定与理由 |
| F | **`memory/tom.py`**（显式心智理论） | 与 `predict-base.ts` 功能位重叠 | **不迁移**，但对外口径不得声称"ToM 建模"已实现 |
| G | **`stateplane/projection.py`**（JL 投影） | 原型默认关 | **不迁移**（与其默认态一致），材料中不得作为已实现能力 |
| H | **操作系统中介面**（Socket / 共享内存 / IPC 四级通道） | 赛题 M10 的系统技术加分 | **不迁移**：按分工归操作系统适配分支（且 `oeipc.py`/`node.py` 属 v5 而非初赛） |

---

## 5. 复算方式

```bash
# 初赛（master）模块清单
git -C <原型检出的仓库> ls-tree -r --name-only master -- 源代码及readme文档/src/synapse

# 本仓库对应实现的测试证据
npm run lint:synapse
node --experimental-strip-types --test test/unit/synapse-*.test.ts
node --experimental-strip-types --test test/integration/synapse-*.test.ts
```

本表所有判定均可按上表「证据」列的 `文件:行号` 直接核对；行号对应本仓库 HEAD `27defe1`。

---

## 6. 本仓库有、原型没有的机制（2026-09-20 增补）

迁移不等于逐条照抄：下列机制是在初赛原型之外新增的，也一并登记，以免"覆盖核验"被读成两者等价。

| 机制 | 位置 | 与原型的关系 |
|---|---|---|
| **全账口径的归因、聚合与冷/热分层** | `src/synapse/metering.ts`（`FullAccount`、`fullAccount.fallback`、`hotBase.bytesIfBaseResident`）、`docs/experiments/full-account-attribution-rule.md` | 原型的 `eval/metrics.py` 只有分项计数，没有把"这笔字节由谁付"编码进事件，也没有冷/热两行与一致性检查；原型 README 自陈部分字节口径是代理值，本仓库在无法实测处直接记 `"N/A"` 而不报代理值 |
| **记录向量驻留索引** | `src/synapse/vector-cache.ts`、`synapse.vectorCache`（默认关） | 原型的 `stateplane/vector_index.py` 是**接收侧**恢复面的文本句柄→量化向量表；本仓库的索引针对**发送侧选基**的重复读取，使"每轮读全部记录"变为"每进程一次" |
| **表示空间守卫** | `corpus.ts`（跨表示空间的幂等命中拒绝）、`state-payload.ts`（`requiredRepresentationId` 校验） | 无等价物：同一份语料在两种嵌入空间下会得到同一个快照 id，静默复用会把占位向量当真实向量用 |
| **跨进程计量的写者归属** | `metering.ts` 的 `writer` 字段与 `totalMs` 只取父侧读数 | 原型单进程计量，无此问题 |
| **状态预算与超时语义** | `SYNAPSE_STATE_BUDGET_MS`（2500 ms，超时按"本次未传递状态"放行并记 `error(category="timeout")`） | 原型无预算机制（其超时行为是进程级强制终止） |

**仍未追平原型的两处**（见 §2 缺口 A–H）：接收侧的**语义校验**（原型 VLC：重嵌入比对 `cos(Ŷ,Y_true)`，
失配回退全文）与**运行期能力探测**（原型 CNR 的 `check_fn` + TTL）。这两项在同一次收口中处理。

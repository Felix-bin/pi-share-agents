# 全账口径的归因规则（冻结件 · 2026-09-20）

> **性质**：预登记 `AC-17-acceptance-preregistration-20260919.md` §3 要求"P4-4 落地时必须给出**归因规则**
> 并把规则写进证据包"。本文件就是那条规则，随计量代码一起冻结；改规则要另立文件并声明旧规则作废，
> **不得就地改写**。
> **实现位置**：`src/synapse/metering.ts`（`FullAccount`、`FULL_ACCOUNT_DEFINITION`、
> `aggregateMetering` 的 `object-io` / `state-send` / `state-restore` 分支），事件写入点见
> `src/synapse/memory-service.ts`、`src/synapse/state-retrieval.ts`、`src/synapse/delegation.ts`。
> **与预登记的接口**：本规则对 ② 中两处措辞的读法已在预登记 **§10**（append-only 修订）里声明，
> 本文件与 §10 冲突时以 §10 为准。

---

## 1. 规则本身（一句话）

**谁花的字节记在谁的账上，由事件自带的 `purpose`、`restore`、`hop` 字段决定；没有这些字段的事件属于
任何一臂都不拥有的普通存储流量，不进入残差路径的账。**

这条规则之所以必须写死成"读字段"而不是"看上下文推断"，是因为推断会让同一条日志在不同人手里算出
不同的账：`object-io` 事件本身看不出它读的是基还是正文，只有写入点知道自己为什么读。

## 2. 冻结的全账口径（②）

```
② = 载荷（首发）+ 恢复重传 + 信封控制字节 + 接收侧基重建读取 + 发送侧选基读取
```

| 项 | 取值字段 | 只出现在哪一臂 |
|---|---|---|
| 载荷（首发） | `state-send` 且 `restore` 缺省 | 两臂 |
| 恢复重传 | `state-send` 且 `restore` 存在 | 主要是残差臂 |
| 信封控制字节 | `message-delivered.envelopeBytes` | 两臂 |
| 基重建读取 | `object-io` 且 `purpose="base-rebuild"` | **仅残差臂** |
| 选基读取 | `object-io` 且 `purpose="base-selection"` | **仅残差臂** |

- **载荷与重传互斥且完备**：两者相加恒等于 `state.sentBytes`。任何"重传另计一笔再相加"的写法都会把
  一条消息报成两条。
- **控制字节不能省**：两臂都付，省略会让消息更多的那一臂显得更省。
- **典实现唯一**：② 的规范实现是 `aggregateMetering`（`metering.ts`）——失败发送的字节**计入**
  （到达过线就花了）。P4-5 聚合器自带的 `metricsOf` 曾在 `!ok` 发送上与之分歧（2026-09-20 K3 P2-1
  对齐修复），任何重实现必须与典实现对齐而不是自立口径。
- **嵌入调用**：`embedding-call` 的 `requests` / `inputTokens` 以**调用与 token** 为单位并列报告
  （`fullAccount.embeddingCalls`），**绝不折算成字节再加进 ②**——token 与字节无法换算，混加出来的数
  既不是 A 也不是 B。

### 2.1 回退链（预登记 §3 ② 的"回退链产生的全部字节"）

回退链的字节**已经**在 ② 里，落在不同列上，不另设一个会把同一笔字节再算一次的合计项：

| 回退动作 | 字节去哪一列 | 依据 |
|---|---|---|
| `resend`（原样重发） | `components.resendBytes` | 它是一次 `state-send`，带 `restore` 标记 |
| `full-vector`（换成完整向量重发） | `components.resendBytes` | 同上 |
| `text`（退回文本检索） | 它没有"传递字节"：成本是**一次重新嵌入**（`embeddingCalls`）与**一次二次检索的读取**（`notNamed.rankingReadBytes`）；命中渲染进子会话的文本**没有计量事件**，是预登记 §3 (c) 已声明的缺口 | 见 `fullAccount.fallback` 的说明 |

`fullAccount.fallback` 给出回退的**次数分布**（`hops`，其总数即预登记的指标 ④）与一条**一致性检查**
`partitionConsistent`：当"自称是 hop 的发送条数"与"记录的 hop 条数"不等时置 `false`。该不一致**不影响
②**（两个载荷分量都在 ② 内），它使**分量拆分**失效，因此按分量出表时须先看这一位。

## 3. 明确不进入 ②、但必须并列报告的两项

| 项 | 为什么不进 ② | 怎么报 |
|---|---|---|
| 接收侧读取载荷对象（`purpose="payload-read"`） | **两臂都付**：向量臂也要把自己的载荷读回来。计入残差臂的列等于让一臂替另一臂付账 | `fullAccount.notNamed.payloadReadBytes` |
| 语料排序读取（`purpose="ranking"`） | 那是"状态被用来做的事"（检索），不是传输本身 | `fullAccount.notNamed.rankingReadBytes` |

两项都在聚合结果里给出数字；把它们排除在 ② 之外**不等于不报告它们**。任何对外表格若只印 ② 而不印
这两项，必须在表下注明它们的量级。

**第三项同样不入 ②、且当前无计量事件的边界（2026-09-20 随预登记 §14 补声明）**：每次消费（以及
每个进程的首次探针）对冻结语料向量的**全量加载**（`loadCorpusVectors`：≈5.07 MB @ 1238 块×1024 维，
两臂对称）。它是状态路径单笔最大的本地 I/O，但属"检索执行成本"而非"传输与基经济学"，故不入 ②、
亦不入 notNamed（`purpose:"ranking"` 只覆盖记忆记录向量读取）。引用"全账 9.85×"时必须声明此边界：
按全本地 I/O 口径对账，比值坍缩至 ≈1.005——②回答的是"残差 vs 完整向量谁更省"，不是"总 I/O 谁更少"。

### 3.1 缓存打开时，按 `purpose` 拆分的行不可逐行比较

记录向量驻留索引（`synapse.vectorCache`，默认关）打开后，一个向量由**进程内首次触达它的那次排序**付费，
其后同一进程内的其他排序命中即零成本。于是"哪个 purpose 变便宜"取决于该轮运行的触达顺序，这是一个
**未声明的自由度**，不能拿来当结论：

- `state.baseSelectionReadBytes` 与 `fullAccount.notNamed.rankingReadBytes` 在缓存打开的run 里
  **不可与缓存关闭的 run 逐行对照**；
- 可比的是**总账**（② 与 `state.vectorCacheHits/Misses` 一并看），并且必须在 manifest 声明该开关取值；
- 报告若要打印分项，须同时打印缓存开关取值与命中/未命中计数，否则分项差会被误读成机制差异。

## 4. 冷基 / 热基

- **冷基**：每轮都从存储重建基（`synapse.vectorCache` 默认 false 时的行为）。
  这是**实测**列，也是 ② 的默认报表口径。
- **热基**：基常驻时的同一笔账。进程内向量缓存（`synapse.vectorCache`）已存在，但**"每轮一进程"
  的评测装置不摊薄它**——每个进程的首次排序都付全量冷填充，其后没有第二轮。因此聚合器给出的
  `fullAccount.hotBase.bytesIfBaseResident = ② − 基读取` 在**常驻进程多轮装置**落地之前始终是
  推导值，并带 `derived: true` 与说明。**落表时必须标"推导 / 非实测"，且不得与实测列混排**——
  把推导值印成实测值，是这份预登记最忌讳的那种"看过数字再解释口径"。字段名本身写成条件式
  （`…IfBaseResident`），是为了让警告在消费端丢掉 `derived` 标志时仍然留在数字旁边。

## 5. 复算方式

聚合是纯函数、日志是只追加的，因此任何已完成实验都可以用同一份原始日志重算：

```bash
node --experimental-strip-types --test test/unit/synapse-metering.test.ts          # 口径单测
node --experimental-strip-types --import ./test/support/register-loader.mjs \
     --test test/integration/synapse-production-trigger.test.ts                    # 真实触发路径上的全账断言
```

变异测试 `synapse/_state/p46-gate-logs-20260920/mutate-full-account.mjs` 的 12 个变异体全部被现有测试
杀死（记录见同目录 `mutation-results-fullaccount.txt`），即本文件描述的每一条规则都有测试依赖它。

## 6. 与三本账（M8）的关系

本文件管的是**② 全账字节**。赛题 M8 的"非文本状态传递规模"另有三本账口径（任务面文本 / 状态面非文本 /
状态命中渲染文本），规则见预登记 §3 末段，**三者互不相加**，与本文件的 ② 也不是同一个数字：
② 是"这次协作总共花了多少字节"，三本账是"其中非文本部分有多大"。两张表同时出现时必须分别标注口径。

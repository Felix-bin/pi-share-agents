# P50 复跑与判分口径修订（2026-09-22，冻结于任何复跑数据之前）

- 地位：`P50-token-ab-preregistration-20260921.md`（§9/§10 附录之后）的**装置与判分修订附录**。原预登记与原始数据（`_state/p50-token-ab-20260921/`）不修改不覆盖。
- 授权：用户 2026-09-22 授权"优化后 A/B 复跑 + P50M 三臂 + judge 重判"。

## 1. 装置变更声明（全部先于复跑数据冻结）

复跑使用的代码为 `feat/p4-delta-wiring` @ `53d6040`（含 O1-O7 与 async 接线修复），相对原 P50（`37be404` 时代）的变更及臂间对称性：

| 变更 | 提交 | 影响臂 | 对称性 |
|---|---|---|---|
| O2 检索型子代理不注册 bg_wait（-4.4KB/request 工具定义） | bd5a6be | 两臂 | 对称（检索型角色两臂都有） |
| O1/O3/O5 retriever 提示：窗口化读取+收窄 grep+投入量规则+ESTABLISHED 状态行 | eab04a6 | 两臂 | 对称（角色提示两臂同文） |
| O6 handover 命中携带 chunk 首行预览锚 | 0603d4d | **仅 SYN** | 不对称：SYN 臂 steer 每 hit 约增加一行预览（≤80 字符）；TXT 无状态平面不受影响。如实声明 |
| async 委派收尾接线统一（runtime/taskText 贯通） | 53d6040 | 两臂 | 对称（TXT 无 synapse 契约，该接线为空操作） |
| synapse.autoDistill 开关（默认关） | c62c43d | 两臂 | 对称（P50 复跑不开启；P50M B 臂专用） |

O4 判分口径变更见 §2。除上表外，装置（CLI 0.85.1 同版、模型 DeepSeek-V4-Flash、嵌入 GLM-Embedding-3/dim1024、语料快照 c4b1279d、任务族 v4、seed 与配对设计、retry=3、valid 判定）与原 P50 完全一致。

## 2. judge 口径 v2（答案归一化）

- 判分提示词与逐要点 0/1 协议**不变**（原 §3 冻结）；变更仅一处：候选答案在送判前经 `normalizeAnswer` 归一化（去 markdown 形态：标题/引用/列表标记/粗斜体/行内码/围栏），两臂同规则，归一化函数 SHA 随结果落盘（`normalize.normalizeSha256`）。
- 动机：消除"结构化产物更长更整齐"的篇幅/印象偏差空间（H 路调研：judge 篇幅偏差有 MT-Bench 依据）。
- **重判义务**：归一化口径为 v2；原 judge-results.json（v1 口径）保留并列。复跑数据与旧 30 轮均以 v2 重判，报告 v2 口径为主、v1 并列。
- `--self-check` 双判：重判与新判分开启，flip 率（判分噪声地板）随结果披露。

## 3. 复跑目录与并列披露规则

- 复跑目录：`_state/p50-token-ab-rerun-20260922/{syn-n30, txt-n30}/`（p50-runner 装置原样，manifest 记录 code.sha=53d6040 与本修订文档 SHA）。
- P50M 目录：`_state/p50m-20260922/{a, b, c}/`（p50m-runner，预登记=P50M-memory-reuse-preregistration-20260921.md 含 §3 修订版）。
- 披露规则：新旧数字**并列分列**，不混池、不做跨池配对；结论表述注明各自装置版本。
- 熔断：沿用原 §（连续 5 次 provider 失败或 403 即停）；跑数期间禁改 `pi-share-agents` 的 `src/**` 与 `index.ts`（子进程从仓库现场加载）。

## 4. 装置缺陷修复（2026-09-22 smoke 阶段发现，先于任何复跑/P50M 数据）

1. **状态预算上调 2500→8000 ms**：单轮 smoke 六轮中两次 `state budget expired after 2500 ms`（paratera 嵌入延迟波动，原 P50 时期嵌入稳定 <2.5s）。该预算只决定"宿主为嵌入等多久"，不影响计量口径与臂间对称（TXT 本无状态平面）；不修复会产生大量非代码性报废轮。两 runner manifest 同步记录 8000。
2. **autoDistill 执行语义改 outbox（B 臂/P50M 专属）**：宿主 rpc 进程在 final result 后 event loop 停滞（文件探针实证：pending 嵌入 fetch 及其 abort timer 均不再触发），进程内执行蒸馏必被截断。改为：宿主 close 时**同步写蒸馏意图**至 `<storeRoot>/distill-pending/`（outbox，进程退出也不丢），由装置 runner 在进程结束后调用产品函数 `executePendingDistill` 执行（提取/嵌入/写库仍全部是 `auto-distill.ts` 产品代码）。交互式会话（宿主长活）不受此限制；pending 文件在向量齐全后删除，部分失败保留重试。
3. smoke 验证（`_state/p50m-smoke-20260922/`）：委派完成→意图排队→runner 执行→记忆记录含 dim1024 向量落库全链路通过后，方开跑全量。

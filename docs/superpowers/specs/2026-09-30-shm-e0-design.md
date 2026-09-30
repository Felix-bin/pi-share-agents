# SHM 记忆平面 E0/E1s 实验设计（判定规则在数据产生之前冻结）

- 日期：2026-09-30
- 状态：设计冻结（用户批准总计划 2026-09-30）；本设计继承 sweqa 设计的纪律骨架（判定规则先于数据、unavailable≠0、一切身份哈希入 manifest、pilot 永不并轨）
- 实现：`src/synapse/shm/`（P6-1 绑定层、P6-2 段布局、P6-3 语料常驻接线）；装置 `experiments/openeuler/shm/`
- 上位设计：`synapse/docs/`《跨进程共享记忆-真SHM设计-v1-20260921》（段布局 §4.2、并发协议 §4.3、信任模型 §4.4、生命周期 §4.5、计量 §9 全部继承；本期裁剪：不做 P6-4 残差判定、P6-5 正文装段、P6-6 自进化）
- 环境：openEuler 24.03-LTS-SP3（WSL2，内核 6.6，16C/15.8G）；koffi 3.3.2（npmmirror）；材料口径如实标注 WSL2

## 1. 被测机制（一句话）

SYNAPSE 共享记忆的语料向量矩阵从"每次状态消费全量读文件 + 全量 SHA-256 + 逐块解码"（`state-retrieval.ts loadCorpusVectors`）升级为"POSIX 命名共享段内零拷贝视图"；磁盘仍是真相源，段是可丢弃重建的物化视图；段缺失/绑定缺失一律静默回落文件路径，默认关闭（`synapse.shm.enabled: false`，绝不默认）。

## 2. 臂定义（全部实验共用）

| 臂 | 配置 | 语义 |
|---|---|---|
| `shm` | `synapse.shm.enabled: true` | 段命中→零拷贝 Float32Array 视图；未命中→文件路径加载后由 writer 投影进段 |
| `file` | 现状（shm 关） | 每次全量读+SHA-256+逐块解码——今天的默认路径，字节级不动 |

其余一切（模型、语料快照、提示词、工具、种子、启动参数）两臂严格一致并全部写入 manifest。SHM 是 SYNAPSE 自身机制的一部分，段开/关是机制对比不是装置缺陷。

## 3. 实验组与判定规则（冻结）

### 3.1 E0a 微基准（零 API 成本）

- 单元：同一段真实语料数据（`corpus/<snapshot>/vectors.f32` + `chunks.json`），同进程内两种加载路径配对。
- 指标（每单元配对差 = file − shm，正 = shm 更快/更省）：
  1. 加载延迟（attach+首查 vs readFileSync+sha256+解码全流程），P50/P95；
  2. 宿主读字节（文件路径的 read 字节 vs 段路径 0）；
  3. attach 延迟双口径（未预热/预热后）单独报告，不进配对。
- 规模：≥100 个配对单元（用 chunk 子集构造多粒度负载）。
- 判定：**加载延迟配对差 95% CI 上界 < 0（bootstrap B=10000，seed=20260921，percentile 法）才可表述"段路径显著更快"；跨 0 如实报告。**
- 有效性：任一路径抛错该单元无效（unavailable，不按 0），无效数与原因随报告列出。

### 3.2 E0b 链路计量（零 API 成本）

- 单元：同一查询序列直接驱动 `retrieveWithState`（不经模型），两臂各跑相同轮次（≥10 轮次 × ≥5 查询）。
- 指标：每轮 `object-io`/语料文件读字节与次数（来自 metering 账本）；`state-consume` 延迟；`shm-attach`/`shm-hit`/`shm-miss` 事件。
- 判定（功能断言，非统计）：**段开臂第 2 轮起语料文件读字节 = 0（账本逐轮证明）；两臂 `rankCorpusChunks` 输出（chunkId 有序序列）逐字节一致（钉扎）。** 任一不满足 = 装置缺陷，停跑修复后换 run id 重跑，不做原地续跑。
- 有效性：排序不一致的轮次无效且升级为缺陷；延迟照报但标注。

### 3.3 E0c 端到端冒烟（少量 API，预算 ≈3–5 元）

- 单元：真实 pi 四角色任务（SWE-QA Flask 题面，与学长线同族）× 3–5 题，每题两臂各 1 次，交替执行（shm q1 → file q1 → …）。
- 模型：bailian `deepseek-v4.1-flash`（凭据只走环境变量 DASHSCOPE_API_KEY，不落盘不进 manifest）。
- 指标：全账本（token——预期两臂同分布、如实记录不作宣称；宿主侧字节与延迟——预期段开更省）；任务答案留存。
- 判定：**功能判定——两臂全部产出有效答案与完整账本；不设显著性判据（n=3–5 只做冒烟）。** token 结论禁止从 E0c 产生。
- 有效性：答案缺失/账本缺失/超时 = 无效尝试，留 evidence 列原因。

### 3.4 E1s 小规模对照臂（API ≈15–25 元）

- 单元：SYN 臂（完整 synapse 模式+记忆+语料）段开 vs 段关 × 5–10 题（同题配对，交替执行），题面与 E0c 同族不重叠抽样。
- 指标（按重要性冻结）：
  1. 宿主侧语料加载字节与次数（主指标，预期段开 → 0）；
  2. `state-consume` 墙钟延迟（配对差）；
  3. 每任务总墙钟（配对差）；
  4. token（并列报告，预期不变——SHM 不改变模型输入输出，此预期写死防事后编故事）。
- 判定：主指标功能断言（段开臂第 2 任务起语料文件字节=0）+ 延迟配对差 95% CI（B=10000，seed=20260921）；**"显著"仅当 CI 上界<0；n<10 时一切结论标注"已实现待扩样"。**
- **边界（防过度宣称，冻结）**：本期不装 chunk 正文进段（P6-5 决赛后），子代理的文件读（reads/轮）不受本机制影响，E1s 不测 reads/轮、不据此下任何结论。

## 4. 统计与报告纪律（与两线装置同源）

1. bootstrap B=10000、seed=20260921、percentile 95% CI；CI 跨 0 禁止表述"显著"。
2. unavailable ≠ 0：失败/缺报单元记 unavailable，配对只在双方有效单元上进行，排除数随报告列出。
3. 一切身份入 manifest：代码 sha+dirty（正式跑拒绝脏树）、runner/matrix/负载文件 sha256、语料快照 id、模型与 maxTokens、段配置（segmentBytes/命名前缀）、环境（openEuler 版本/内核/WSL2 标注）。
4. 断点续跑只补缺（result.json 存在即跳过）；中断的正式 run 换 id 重跑不原地续；pilot 数据永不与正式数据合并。
5. 失败不中断跑数：每尝试问题写 result.problem；证据复制失败写 evidence-errors.log。
6. 秘密只走环境变量；被测进程不接触真实 key 的路径沿用 sweqa 记录代理模式（E0c/E1s）。
7. runs 只增不改：产物在 `~/.pi/agent/synapse/experiments/shm-{e0a,e0b,e0c,e1s}-<date>/`。

## 5. 预检事实（2026-09-30 实测，非实验数据，不进任何结论）

- koffi 3.3.2 经 npmmirror 安装成功；`koffi.view(bigint, len)` 返回零拷贝 ArrayBuffer（构造器即 ArrayBuffer），`new Float32Array(ab)` 直接可用。
- 单进程：1 MiB 段（262144 floats）写读回零错；attach（open+ftruncate+mmap+close）173.8 μs；预热后全量扫描 353.9 μs/遍；首遍（首触缺页）2.8 ms。
- 双进程：writer 写 4 MiB，两个独立 reader 只读 attach（5.6–6.6 μs）全量零错匹配。
- 教训（已入实现约束）：koffi 3.3.2 中 `void *` 返回值一律为 BigInt 地址；不要假设 `koffi.view` 返回 Node Buffer。

## 6. 修订记录

- 2026-09-30：初版冻结（在 E0a/E0b/E0c/E1s 任何数据产生之前）。

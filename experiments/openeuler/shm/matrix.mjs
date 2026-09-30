// SHM E0 实验矩阵（spec: docs/superpowers/specs/2026-09-30-shm-e0-design.md）。
//
// 这里冻结的是"实验是什么"：臂、负载、规模、判定参数。run.mjs 只执行，
// report.mjs 只判定；三者任何改动都要求新的 run id（manifest 拒绝原地重启），
// 与 sweqa 装置同一条纪律：判定规则先于数据。

import { createHash } from "node:crypto";

/** 两臂：file = 现状文件路径（每加载全量读+摘要+解码）；shm = 段命中零拷贝。 */
export const ARMS = ["file", "shm"];

/** E0a 配对重复数（预登记下限 100，取 120）。 */
export const E0A_PAIRS = 120;

/** E0a 负载：真实语料的前缀子集（chunks/vectors 同步截取，meta 重算）。 */
export const E0A_SUBSET_SIZES = [64, 256, 1006];

/** E0b：跨进程轮数（每轮一个全新 node 子进程）× 每轮查询数。 */
export const E0B_ROUNDS = 10;
export const E0B_QUERIES = 5;
export const E0B_K = 8;

/** 统计口径与两线装置同源（aggregate.mjs / sweqa report.mjs 一字不改的常量）。 */
export const BOOTSTRAP_B = 10_000;
export const BOOTSTRAP_SEED = 20260921;

/** 语料快照：E1 正式跑同一份（1006 chunks × 1024 dim, bailian/text-embedding-v4）。 */
export const CORPUS_SNAPSHOT = "63a385a420d3bdd080b21981640d964d46b9f1637050a4276ee0510ec8fd56dc";
export const CORPUS_DIM = 1024;
export const CORPUS_REPRESENTATION = "bailian/text-embedding-v4/1024";

/** 命名空间 id：16 hex，只用于段命名，与任何真实 worktree 无关。 */
export const SHM_NAMESPACE = "e0a1b2c3d4e5f607";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** mulberry32 + percentile bootstrap，与 aggregate.mjs 同源实现。 */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 配对差的有放向重采样，percentile 95% CI。diff[i] = A_i − B_i（正 = B 更省/更快）。 */
export function bootstrapInterval(diffs, { b = BOOTSTRAP_B, seed = BOOTSTRAP_SEED } = {}) {
	const rng = mulberry32(seed);
	const means = new Float64Array(b);
	for (let i = 0; i < b; i++) {
		let sum = 0;
		for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rng() * diffs.length)];
		means[i] = sum / diffs.length;
	}
	const sorted = Float64Array.from(means).sort();
	const lo = sorted[Math.floor(0.025 * b)];
	const hi = sorted[Math.ceil(0.975 * b) - 1];
	return { hi, lo, mean: diffs.reduce((a, c) => a + c, 0) / diffs.length };
}

export const crossesZero = ({ hi, lo }) => lo < 0 && hi > 0;

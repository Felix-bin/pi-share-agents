#!/usr/bin/env node
/**
 * Real-API smoke probe for the SiliconFlow embedder (task card P3-1).
 *
 * CI runs without a key: that case prints SKIP and exits 0 so the gate stays
 * green without credentials. With a key, one query is embedded and only
 * scalars are printed — never vector contents.
 */
import { createSiliconFlowEmbedder } from "../src/synapse/embedding.ts";

const key = (process.env.SILICONFLOW_API_KEY ?? "").trim();
if (key.length === 0) {
	// No process.exit here: an explicit exit can cut off the piped log line before
	// it is flushed; the script ends naturally with exit code 0.
	console.log("SKIP: SILICONFLOW_API_KEY is not set; no network call was made.");
} else {

const embedder = createSiliconFlowEmbedder(
	{
		dim: 1024,
		endpoint: "https://api.siliconflow.cn/v1/embeddings",
		keyEnv: "SILICONFLOW_API_KEY",
		model: "BAAI/bge-m3",
		provider: "siliconflow",
	},
	{ key },
);

try {
	const result = await embedder.embedQuery("SYNAPSE embedding probe: 多智能体共享记忆与状态传递");
	const norm = Math.hypot(...result.vector);
	let dotWithSelf = 0;
	for (const value of result.vector) dotWithSelf += value * value;
	console.log(
		JSON.stringify(
			{
				cached: result.cached,
				dim: result.vector.length,
				latencyMs: result.latencyMs,
				normL2: norm,
				promptTokens: result.promptTokens,
				selfCosine: dotWithSelf,
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(`embedding probe failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
}

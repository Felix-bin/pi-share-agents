/**
 * The P4-5 task family and the memory records both arms are seeded with.
 *
 * Frozen BEFORE any P4-5 data is produced: the manifest records the sha-256 of
 * this file, and a change to it after the first round is a new experiment, not
 * a continuation. Tasks are delegation texts for the `retriever` role; the state
 * query each arm embeds is `Task: <task>`.
 *
 * Byte-identity across arms is a PROPERTY OF THE RUNNER, not of this file: the
 * host's /run command appends a single-output instruction carrying a per-run
 * output path (arm name + UUID) to the task text unless it is disabled, and the
 * n30 run did not disable it — so its two arms embedded DIFFERENT query texts
 * every round and ③'s reference was contaminated (K3 P0-2, preregistration
 * §14). The runner now sends `/run retriever[output=false] <task>`, which
 * removes the instruction and makes the query byte-identical across arms.
 * Family v3 = this file plus that runner flag; the n30 numbers belong to the
 * v2 form (614-char queries with the per-run path tail) and must not be mixed
 * with v3 results.
 *
 * The seed records are the base pool residual encoding selects from: twelve
 * derived conclusions (no source path, therefore always "current" and readable
 * by the whole-worktree scope the child contract grants). Both arms receive
 * bit-identical copies of the seed store — one store is built, then copied — so
 * no arm can hold vectors the other lacks.
 */

export const SEED_RECORDS = [
	{
		topic: "state plane payload encoding",
		summary: "The retrieve action publishes the query vector to the content store as little-endian float32 and names it in the envelope stateRef; float32-vector is 4096 bytes at dim 1024.",
		content: "The state plane carries a query vector, not retrieved text: the sender embeds the query, unit-normalises it, writes 4096 float32 bytes to the content-addressed store, and the envelope's stateRef carries payloadId, sha256, dim and representationId. The receiver verifies the digest, rebuilds the vector and ranks the pinned corpus with it.",
		tags: ["state-plane", "encoding", "retrieve"],
	},
	{
		topic: "residual quantisation parameters",
		summary: "Delta encoding quantises to an int8 grid of 127 levels with stride 3 and stops when cosine to the original reaches 0.99; the frozen constants are shared by encoder and decoder.",
		content: "The residual path quantises the full vector and a predicted base onto the same grid, encodes only the differing cells as index/value pairs, and the decoder rebuilds the vector from the base plus the correction. The stopping threshold 0.99 is the same number the receiver's optional semantic verification uses.",
		tags: ["delta", "quantisation", "grid-127"],
	},
	{
		topic: "predicted base selection",
		summary: "The sender picks the base as the first ranked memory record that still owns a usable vector — the frozen shared-retrieval order, query-top1, never an oracle nearest-vector rule.",
		content: "Base selection reuses the memory ranking: searchMemories scores keyword, tag and semantic cosine with the frozen 0.3/0.2/0.5 weights, and the first ranked record with a stored vector in the same representation becomes the base. A record whose source cannot be verified is skipped rather than used.",
		tags: ["delta", "base-selection", "retrieval"],
	},
	{
		topic: "metering full account",
		summary: "The full account sums first transmissions, recovery re-transmissions, envelope control bytes, receiver base rebuilds and sender base-selection reads; embedding calls are counted as calls and tokens, never folded into bytes.",
		content: "The full-account figure is frozen as payload plus resend bytes plus control bytes plus both base-read purposes, with payload-read and ranking-read bytes reported beside it rather than inside it, because both arms pay them and folding them in would bias one arm for the other.",
		tags: ["metering", "full-account", "attribution"],
	},
	{
		topic: "capability negotiation",
		summary: "Negotiation requires a common float32-vector encoding and a receiver that holds a state-consuming tool; the delta encoding is declared but chosen per message by rate distortion, not by negotiation.",
		content: "The sender declares text, float32-vector and delta and the receiver declares what its role may accept; negotiation only opens the state path, while the encoding actually sent is decided afterwards by chooseStatePayload from the payload's own numbers.",
		tags: ["negotiation", "capability", "encodings"],
	},
	{
		topic: "shared memory authorisation",
		summary: "A record is visible only where the project grant and the subagent grant overlap: records without a source are readable only by whole-worktree scopes, and writes require the mutating-tool projection.",
		content: "Memory is a projection of existing grants. The scope carries path prefixes intersected between project and agent; isReadable admits a sourceless record only to the whole-worktree prefix, and requireWritable demands both the write flag and a non-empty prefix set.",
		tags: ["memory", "authorisation", "scope"],
	},
	{
		topic: "corpus snapshot identity",
		summary: "The corpus snapshot id is a function of the source tree and the chunking only — window 40, overlap 8, the .json/.md/.py/.ts/.txt/.yaml allowlist — never of the embedding vectors.",
		content: "buildCorpus walks the source, slices files into overlapping windows, and derives the 64-hex snapshot id from the chunks; vectors are written beside them. Rebuilding with a stub embedder reproduces the same id, which is why stub builds are only ever pointed at throw-away stores.",
		tags: ["corpus", "snapshot", "chunking"],
	},
	{
		topic: "envelope inbox and node addressing",
		summary: "Every run addresses children as runId/childIndex; the delegate envelope lands in the inbox as <runId>/<childIndex>.json and the state envelope as the .state.json sibling.",
		content: "The node id is derived, not carried, so the sender's metering and the receiver's inbox cannot drift. A delivery that publishes no state clears the sibling file, because the receiver reads that path by name and a stale file would be consumed as if this pass had sent it.",
		tags: ["envelope", "inbox", "node-id"],
	},
	{
		topic: "recovery hops on the state plane",
		summary: "Object-class failures recover by one re-send; a residual the receiver cannot rebuild is replaced by a full vector; a semantic verification refusal skips the re-send entirely and goes straight to the text path.",
		content: "state-restore records each hop — resend, full-vector or text — and the send that performed the hop declares itself with a restore marker so the byte partition stays checkable. A recovery that repeats a semantically refused residual would only fail identically one round trip later.",
		tags: ["recovery", "resend", "text-fallback"],
	},
	{
		topic: "vector cache and cold base convention",
		summary: "With synapse.vectorCache off every ranking reads every record vector from the store — the frozen cold-base convention; the cache switch is the difference between the cold row and the hot row of the pre-registered table.",
		content: "The pre-registration measures the residual path under the cold-base convention by default: base selection's reads are real store reads, metered with purpose base-selection. The in-process cache makes those reads once per process instead, and both settings must rank identically or a defect is present.",
		tags: ["vector-cache", "cold-base", "convention"],
	},
	{
		topic: "semantic verification of decoded state",
		summary: "The receiver may re-embed the sender's own query text from the envelope and refuse a decoded state below cosine 0.99; refusal never triggers a re-send, only the text path or a terminal failure.",
		content: "Verification is per message, unlike the one-shot calibration: it catches a decoded vector that no longer means the query, including a sender that encoded a stale query. It cannot catch both sides drifting together, and it needs the query text the envelope carries.",
		tags: ["verification", "state-verify", "cosine"],
	},
	{
		topic: "offline mock configuration",
		summary: "configs/default.yaml keeps the offline self-check on a hash embedder with zero keys and zero network; the real evaluation runs the same CLI against a configured provider with dim 1024.",
		content: "The dual-track configuration keeps mechanism self-checks runnable anywhere: the mock track answers whether the plumbing works, the real track answers whether the semantics pay, and every command accepts --config to choose between them.",
		tags: ["config", "mock", "dual-track"],
	},
];

export const TASKS = [
	"Find where the retrieve action publishes a query vector to the content store and report what the envelope stateRef carries. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the residual quantisation constants and report the grid, the stride and the cosine the encoder stops at. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the base-selection rule for residual encoding and report whether the base is chosen by retrieval order or by nearest vector. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the full-account aggregation and list exactly which byte components it sums and which it reports beside the figure. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the capability negotiation code and report which encoding the state path requires before it can be taken. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the memory authorisation checks and report when a record without a source path is readable. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the corpus builder and report how the snapshot id is derived and which file types the allowlist admits. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the envelope inbox layout and report the file names a delegate delivery and a state delivery land in. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the recovery paths for a failed state consume and report what each hop does and how hops are counted. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the vector cache switch and report what changes in the metering account when it is turned on. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the receiver-side semantic verification and report what cosine it enforces and what a refusal leads to. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the offline mock configuration and report which embedder it pins and why no key is needed. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where the state budget bounds the sender's wait and report what happens when the budget expires. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the text fallback search on the receiver and report which query it embeds when the state plane fails. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the k bounds the search path enforces and report the default k and the maximum the receiver accepts. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the freezeSnapshot inputs and report which facts about the launch the snapshot binds. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where a superseded memory record is handled and report whether historical records can still be read. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the delegation receipt writer and report what a receipt may and may not claim about outputs. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the semantic retrieval weights and report the keyword, tag and cosine split the ranking freezes. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the canonical JSON serialiser and report why the wire envelope hashes to a stable digest. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the embedding client's two-level cache and report what a cache hit does to the metering account. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the namespace marker and report what happens when a store's marker names a different worktree. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where child tools are projected into capability and report which tool makes a child a state consumer. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the deterministic stub embedder used by tests and report why its provider name is rejected in real runs. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the QA pipeline entry point and report which datasets the evaluation commands accept. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the smoke command and report what the offline acceptance check exercises without keys. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the probe command and report what it verifies about a configured provider before evaluation starts. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the ablation entry points and report which mechanisms the signal and m7 commands toggle. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the dataset fetch scripts and report how many samples each fetch writes and where they land. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the CI gate scripts and report which checks a behaviour change must pass before commit. Do not record anything into shared memory during this task; answer from what you read only.",
];

/** The role every task is delegated to; its spec accepts the retrieve action. */
export const AGENT = "retriever";

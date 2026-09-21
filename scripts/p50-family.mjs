/**
 * The P50 task family (v4): thirty codebase-fact retrieval tasks, frozen BEFORE any
 * P50 full-run data. The manifest records the sha-256 of this file; a change to it
 * after the first full round is a new experiment, not a continuation.
 *
 * Why v4 exists (preregistration §10): the P4-5 family (p45-family.mjs, v3) was
 * written against the TypeScript plugin port — its expected constants (grid 127,
 * stride 3, cosine 0.99, float32 envelopes, vector-cache switch, inbox layout) do
 * not exist in the tree the children actually search. That tree is the synapse
 * repository at master 3491b37 (the corpus snapshot's sourceCommit, byte-identical
 * to the child worktree): Python, with grid 64, verify_threshold 0.97, and its own
 * module names. P4-5 measured bytes, so task answerability never mattered there;
 * P50 scores answer quality with an LLM judge, so every task below was grounded
 * against the real code at 3491b37 on 2026-09-21 before any full run.
 * The v3 file stays untouched for the P4-5 line; nothing here is retro-applied.
 *
 * Tasks are delegation texts for the `retriever` role. Each asks for facts that
 * live in 源代码及readme文档/ (package src/synapse + scripts + configs) and can be
 * verified against p50-grading-keypoints.json. Every task forbids memory writes:
 * the A/B runs with an intentionally EMPTY memory store, and the runner restores
 * any drifted store from the seed between attempts.
 */

export const TASKS = [
	"Find the content-addressed store in the synapse package and report how a handle is derived from stored bytes and which operations the store exposes. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the residual codec and report which grid vectors are quantised onto, what cosine target stops the greedy encoding, and how wide a residual index is on the wire. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the theory-of-mind predictor and report the three base-selection policies it implements and which one is described as receiver-reproducible. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the metrics aggregation and report which byte components make up the logical wire figure and what the transport byte figure counts instead. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the capability negotiation code and report how the negotiated encoding is chosen and what happens when the two sides share no encoding. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the shared memory unit definition and report its metadata fields and which kinds a record may have. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where a run's manifest is collected and report which facts about the code, the configuration and the environment it binds. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the control-plane transport and report how messages are framed on the Unix socket and what the maximum frame size is. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the receiver-side recovery chain for a failed state frame and report the hops it walks and how each hop is counted. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the vector-addressable index and report what it maps and how the receiver uses it to recover the content behind a reconstructed vector. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the two-level frame verification and report what the L1 checksum commits to and what the L2 semantic check verifies. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the default offline configuration and report which LLM backend and which embedder it pins and why no API key is needed. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the replay protection for consumed frames and report what key identifies an already-consumed frame and how the replay window stays bounded. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where the legacy transfer path falls back to full text and report what triggers the fallback and what messages are then sent. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the retrieval defaults and report the default k, how a memory hit is decided, and which retrieved units count as reused. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the frozen-snapshot memory injection and report what is injected into the retriever prompt and why the snapshot is not updated mid-task. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find where a memory record is superseded and report what triggers supersession and whether historical versions can still be retrieved. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the result-spill mechanism and report when a structured result is spilled to the content store and what replaces it in the message. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the hybrid retrieval scoring and report the exact weight split and the similarities it fuses. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find how a message is serialised for the wire and report which serialisation choices make the transport byte count exact. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the API embedder's cache and report what a cache hit changes in the request and token accounting. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find how a session binds its frames and report which domains go into the authenticated checksum and how its key is provisioned. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find how the team agents advertise their capabilities and report which encodings every role declares and which role declares a runtime-probed capability. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the embedder factory and report when each embedder variant is chosen and what makes the offline one deterministic. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the real-dataset evaluation commands and report which datasets they accept and what each one validates. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the smoke command and report which acceptance checks it runs fully offline without any API key. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the probe command and report what it verifies about a configured provider before an evaluation run starts. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the ablation entry points and report which mechanisms the signal and m7 commands exercise and what each is meant to show. Do not record anything into shared memory during this task; answer from what you read only.",
	"Find the dataset fetch scripts and report how many samples each fetches by default and where the samples land. Do not record anything into shared memory during this task; answer from what you read only.",
	"Locate the local CI gate scripts and report which checks a behaviour change must pass before commit. Do not record anything into shared memory during this task; answer from what you read only.",
];

/** The role every task is delegated to; its spec accepts the retrieve action. */
export const AGENT = "retriever";

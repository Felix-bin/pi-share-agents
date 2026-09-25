#!/usr/bin/env node
/**
 * P4-5 device v4b (§18): a single-process seam driver for the hot-base row.
 *
 *   node --experimental-strip-types experiments/legacy/p45-seam-hot.mjs <expDir> [--pairs 1-10]
 *
 * Calls the PRODUCTION delegation entry (`openChildDelegationWithState`, the
 * same function, vectorCache wiring and probe TTL the host /run path uses) N
 * times per arm inside ONE process, against a bit-identical copy of the seed
 * store and the real embedding provider. Round 1 pays the cache fill; rounds 2+
 * are the hot condition the v4 resident device could not produce (the host
 * forks a fresh process per /run — writer-PID evidence in the preregistration
 * §18 preamble). The consume side is NOT driven (no child session): the
 * base-rebuild term is carried as the code-derived 4,096 B/round (P-C2) and
 * disclosed, never claimed as measured here.
 *
 * The API key is read from synapse/.env into the environment, never printed.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN_REPO = REPO.replaceAll("\\", "/");
const SRC = (name) => `file:///${WIN_REPO}/src/${name}`;
const SCRIPT_SRC = (rel) => `file:///${WIN_REPO}/experiments/legacy/${rel}`;

const ENV_FILE = "D:/操作系统开源大赛/synapse/.env";
const CORPUS_ID = "c4b1279d58ae01e6b855e2c5b5cb01037c6e722d7d8132139528c2c32a585e1a";
const WORK_DIR = "D:/操作系统开源大赛/synapse/_state/p45-runs/work";

const EMBEDDING = {
	provider: "paratera",
	endpoint: "https://llmapi.paratera.com/v1/embeddings",
	model: "GLM-Embedding-3",
	dim: 1024,
	keyEnv: "PARATERA_API_KEY",
};

function loadDotEnv(file) {
	const out = {};
	for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

function copyTree(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(from, to);
		else fs.copyFileSync(from, to);
	}
}

const log = (message) => console.log(`[p45-seam] ${new Date().toISOString()} ${message}`);

const expDir = path.resolve(process.argv[2]);
const pairsArg = process.argv.indexOf("--pairs");
const pairsSpec = pairsArg === -1 ? "1-10" : process.argv[pairsArg + 1];
const pairMatch = pairsSpec.match(/^(\d+)(?:-(\d+))?$/);
if (pairMatch === null) throw new Error(`bad --pairs: ${pairsSpec}`);
const pairs = Array.from({ length: Number(pairMatch[2] ?? pairMatch[1]) - Number(pairMatch[1]) + 1 }, (_, i) => Number(pairMatch[1]) + i);

// The key only ever lands in the environment.
const dotenv = loadDotEnv(ENV_FILE);
const key = dotenv[EMBEDDING.keyEnv] ?? process.env[EMBEDDING.keyEnv];
if (key === undefined || key.length === 0) throw new Error(`${EMBEDDING.keyEnv} not present`);
process.env[EMBEDDING.keyEnv] = key;

const seedStore = path.join(expDir, "store-seed");
if (!fs.existsSync(seedStore)) throw new Error(`seed store missing — run p45-runner.mjs seed first: ${seedStore}`);
const namespaceId = JSON.parse(fs.readFileSync(path.join(expDir, "seed-manifest.json"), "utf-8")).namespaceId;

const { TASKS } = await import(SCRIPT_SRC("p45-family.mjs"));
const { openChildDelegationWithState } = await import(SRC("runs/shared/synapse-delegation.ts"));
const { resolveConfiguredEmbedder } = await import(SRC("synapse/embedding.ts"));

fs.writeFileSync(
	path.join(expDir, "seam-manifest.json"),
	`${JSON.stringify(
		{
			experimentId: path.basename(expDir),
			device: "v4b-seam: single process, production entry openChildDelegationWithState called N times per arm; vectorCache=true both arms; consume side NOT driven (base-rebuild carried as code-derived 4,096 B/round, P-C2)",
			preregistration: "§18 (registered BEFORE any v4b data)",
			embedding: { ...EMBEDDING, representationId: `${EMBEDDING.provider}/${EMBEDDING.model}/${EMBEDDING.dim}` },
			corpusSnapshotId: CORPUS_ID,
			namespaceId,
			roundsPlanned: pairs,
			createdAt: new Date().toISOString(),
			node: process.version,
			pid: process.pid,
		},
		null,
		"\t",
	)}\n`,
	"utf-8",
);

const roundsPath = path.join(expDir, "seam-rounds.jsonl");
fs.writeFileSync(roundsPath, "");
for (const arm of ["S2", "R1"]) {
	const storeRoot = path.join(expDir, `seam-store-${arm}`);
	fs.rmSync(storeRoot, { force: true, recursive: true });
	copyTree(seedStore, storeRoot);
	const embedder = resolveConfiguredEmbedder({ ...EMBEDDING }, storeRoot);
	if (embedder === undefined) throw new Error("embedder could not be built (key env?)");
	for (const round of pairs) {
		const task = TASKS[round - 1];
		if (task === undefined) throw new Error(`task ${round} missing from the family`);
		const runId = `seam-${arm}-${String(round).padStart(2, "0")}-${randomUUID().slice(0, 8)}`;
		const contract = {
			capabilityId: "seam-driver-capability",
			contractId: "seam-driver-contract",
			corpusSnapshotId: CORPUS_ID,
			memoryRefs: [],
			mode: "synapse",
			namespaceId,
			representationId: embedder.representationId,
			scope: { pathPrefixes: [""], write: true },
			stateVerify: "off",
			storageRoot: storeRoot.replaceAll("\\", "/"),
		};
		const synapse = {
			// The contract belongs to the DELEGATED CHILD; negotiation maps agent
			// names to role capabilities, and only a real role (retriever) declares
			// the retrieve action the state plane needs — "parent" would negotiate
			// to a refusal, which is exactly what the first pilot round showed.
			agent: "retriever",
			capabilityTools: ["read", "grep", "glob", "synapse_read"],
			contextBudgetBytes: 0,
			contract,
			delta: arm === "R1",
			embedding: { ...EMBEDDING },
			runId,
			sessionId: "seam-driver",
			vectorCache: true,
		};
		log(`arm ${arm} round ${round}: ${task.slice(0, 60)}…`);
		const startedAt = new Date();
		let outcomeKind = null;
		let reason = null;
		try {
			const result = await openChildDelegationWithState({
				cwd: WORK_DIR,
				embedder,
				message: `Task: ${task}`,
				receiverSessionId: `seam-child-${runId}`,
				runtime: { childIndex: 0, synapse },
			});
			// The entry returns BOTH planes: { delegation, state } — the state half
			// is the measurement target here.
			const state = result?.state;
			outcomeKind = state === null || state === undefined ? "null" : state.kind;
			reason = state !== null && state !== undefined && state.kind !== "state" ? state.reason : null;
		} catch (error) {
			outcomeKind = "throw";
			reason = error instanceof Error ? error.message : String(error);
		}
		// The round's ledger, written by the production seam itself.
		const ledger = path.join(storeRoot, "metering", `${runId}.jsonl`);
		let metrics = null;
		if (fs.existsSync(ledger)) {
			const events = fs.readFileSync(ledger, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
			metrics = {
				baseSelectionBytes: events.filter((e) => e.kind === "object-io" && e.direction === "read" && e.purpose === "base-selection").reduce((s, e) => s + e.bytes, 0),
				payloadBytes: events.filter((e) => e.kind === "state-send").reduce((s, e) => s + e.payloadBytes, 0),
				encoding: events.find((e) => e.kind === "state-send")?.encoding ?? null,
				vectorCache: events.filter((e) => e.kind === "vector-cache").map((e) => ({ h: e.hits, m: e.misses })),
				probeMs: events.filter((e) => e.kind === "capability-probe").map((e) => e.durationMs),
				envelopeBytes: events.filter((e) => e.kind === "message-delivered" && e.textBytes === 0).reduce((s, e) => s + e.envelopeBytes, 0),
				embeddingCalls: events.filter((e) => e.kind === "embedding-call").length,
			};
		}
		fs.appendFileSync(roundsPath, `${JSON.stringify({ arm, round, runId, startedAt: startedAt.toISOString(), outcomeKind, reason, metrics })}\n`, "utf-8");
		log(`arm ${arm} round ${round}: outcome=${outcomeKind}${reason !== null ? ` (${String(reason).slice(0, 60)})` : ""} ${metrics !== null ? JSON.stringify(metrics) : "NO LEDGER"}`);
	}
}
log(`seam experiment complete: ${expDir}`);

/**
 * One real delegation of known size across two real processes, for S3's
 * acceptance (design §7.3).
 *
 *   node --experimental-strip-types scripts/synapse/s3-probe.ts \
 *     --store <storageRoot> --worktree <path> --run <runId>
 *
 * The parent opens a delegation on the `file` gear — which records the parent's
 * process-identity and publishes the envelope — then launches a second Node
 * process as the receiver. The receiver records its own process-identity and
 * reads and verifies the envelope. The envelope is therefore written once by one
 * process and read once by another, which is the arithmetic design §7.3 point 1
 * predicts: kernel envelope bytes ≈ 2 × envelopeBytes.
 *
 * Prints one JSON object of facts on stdout; judges nothing.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { meteringLogPath, openDelegation } from "../../src/synapse/delegation.ts";
import { selectEnvelopeRoute } from "../../src/synapse/envelope-gear.ts";
import { nodeIdFor, readDeliveredEnvelope, verifyEnvelopeAgainstContract } from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, createMeteringLog, readMeteringLog, recordProcessIdentity } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";

const AGENT = "retriever";
const CHILD_TOOLS = ["read", "grep"];
const CHILD_INDEX = 0;

function parseArgs(argv: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === undefined || !key.startsWith("--") || value === undefined) throw new Error(`bad argument near ${JSON.stringify(key)}`);
		values.set(key.slice(2), value);
	}
	for (const required of ["store", "worktree", "run"]) if (!values.get(required)) throw new Error(`--${required} is required`);
	return values;
}

function contractFor(store: string, worktree: string): LaunchContract {
	return resolveLaunchContract({
		capabilityId: capabilityForAgent({ agent: AGENT, childTools: CHILD_TOOLS, representationId: "unavailable" }).capabilityId,
		corpusSnapshotId: "unset",
		deliveryGear: "file",
		memoryRefs: [],
		mode: "synapse",
		namespaceId: deriveNamespaceId(worktree),
		representationId: "unavailable",
		scope: { pathPrefixes: [""], write: true },
		storageRoot: store,
	});
}

/** The receiving process: bind itself to the run, then read and verify the envelope. */
function receive(store: string, worktree: string, run: string): void {
	const contract = contractFor(store, worktree);
	recordProcessIdentity(createMeteringLog(meteringLogPath(contract, run)), {
		agent: AGENT,
		attempt: 1,
		mode: contract.mode,
		nodeId: nodeIdFor(run, CHILD_INDEX),
		runId: run,
		sessionId: "s3-probe-child",
		snapshotId: null,
	});
	const route = selectEnvelopeRoute({ childIndex: CHILD_INDEX, deliveryGear: "file", runId: run, storageRoot: store });
	const delivered = readDeliveredEnvelope(route.address);
	const mismatch = delivered.status === "ready" ? verifyEnvelopeAgainstContract({ contract, wire: delivered.wire }) : null;
	process.stdout.write(JSON.stringify({ mismatch, status: delivered.status }));
}

async function send(store: string, worktree: string, run: string): Promise<void> {
	fs.mkdirSync(store, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	const contract = contractFor(store, worktree);
	// One recalled memory, so the envelope carries a handle — the shape a real
	// delegation has rather than an empty special case.
	await createMemoryService({
		provenance: { agent: AGENT, attempt: 1, runId: run, sessionId: "s3-probe" },
		scope: { agent: AGENT, namespaceId: contract.namespaceId, pathPrefixes: [""], write: true },
		storeRoot: store,
		worktreeRoot: worktree,
	}).remember({
		content: "the login path checks the session cookie first",
		kind: "evidence",
		operationId: `${run}/seed`,
		summary: "login is verified in src/auth.ts",
		tags: ["auth"],
		topic: "auth flow",
	});
	const delegation = openDelegation({
		budgetBytes: 8192,
		contract,
		identity: {
			agent: AGENT,
			attempt: 1,
			childIndex: CHILD_INDEX,
			childTools: CHILD_TOOLS,
			receiverSessionId: "s3-probe-child",
			requestId: `${run}-req`,
			runId: run,
			senderSessionId: "s3-probe-parent",
		},
		message: "Task: explain the auth flow",
		worktreeRoot: worktree,
	});
	if (delegation === null) throw new Error("negotiation refused the delegation");
	const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--role", "child", "--store", store, "--worktree", worktree, "--run", run], { encoding: "utf-8" });
	let receipt: { mismatch: string | null; status: string } = { mismatch: null, status: "child-failed" };
	try {
		receipt = JSON.parse(child.stdout) as typeof receipt;
	} catch {
		receipt.mismatch = child.stderr.slice(0, 300);
	}
	const totals = aggregateMetering(readMeteringLog(meteringLogPath(contract, run)));
	process.stdout.write(
		`${JSON.stringify({
			envelopeBytes: totals.control.envelopeBytes,
			envelopeFileBytes: fs.statSync(selectEnvelopeRoute({ childIndex: CHILD_INDEX, deliveryGear: "file", runId: run, storageRoot: store }).address).size,
			meteringLog: meteringLogPath(contract, run),
			parentPid: process.pid,
			receiptMismatch: receipt.mismatch,
			receiptStatus: receipt.status,
			runId: run,
			storageRoot: store,
		})}\n`,
	);
}

const args = parseArgs(process.argv.slice(2));
if (args.get("role") === "child") receive(args.get("store")!, args.get("worktree")!, args.get("run")!);
else await send(args.get("store")!, args.get("worktree")!, args.get("run")!);

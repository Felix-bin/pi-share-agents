/**
 * One real envelope delivery, at one gear, on a real host.
 *
 *   node --experimental-strip-types scripts/synapse/s2-uds-probe.ts \
 *     --gear <file|uds> --store <storageRoot> --worktree <path> [--run <id>]
 *
 * Prints one JSON object of facts on stdout and judges nothing. Called twice by
 * `s2-acceptance.sh`, once per gear, and run under `strace` for the syscall
 * observation.
 *
 * **This is the first code path in S2 that touches a real AF_UNIX socket.**
 * Every `uds` test in this repository injects a fake transport, because this
 * sandbox cannot bind an AF_UNIX path at all (`bind` returns `EACCES` on
 * Windows). `createNodeUdsClientTransport` and `createNodeUdsServerTransport`
 * have never been executed anywhere. Treat a failure here as first-run code
 * rather than as a regression.
 *
 * The receiver binds before the sender is constructed, in that order and
 * deliberately: the endpoint has to be live before the parent connects, which
 * is the same ordering `beginEnvelopeReceipt` establishes inside a real child.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { meteringLogPath, openDelegation } from "../../src/synapse/delegation.ts";
import { receiveEnvelopeViaUdsRoute, selectEnvelopeRoute } from "../../src/synapse/envelope-gear.ts";
import { readDeliveredEnvelope, verifyEnvelopeAgainstContract } from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, createMeteringLog, readMeteringLog } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import type { SynapseDeliveryGear } from "../../src/synapse/config.ts";

type Args = { gear: SynapseDeliveryGear; run: string; store: string; worktree: string };

function parseArgs(argv: string[]): Args {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === undefined || !key.startsWith("--") || value === undefined) {
			throw new Error(`bad argument near ${JSON.stringify(key)}`);
		}
		values.set(key.slice(2), value);
	}
	const gear = values.get("gear");
	if (gear !== "file" && gear !== "uds") throw new Error("--gear must be file or uds");
	const store = values.get("store");
	const worktree = values.get("worktree");
	if (!store || !worktree) throw new Error("--store and --worktree are required");
	return { gear, run: values.get("run") ?? `p${Date.now() % 100000}`, store, worktree };
}

const AGENT = "retriever";
const CHILD_TOOLS = ["read", "grep"];
const CHILD_INDEX = 0;

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	fs.mkdirSync(args.store, { recursive: true });
	fs.mkdirSync(args.worktree, { recursive: true });

	const contract = resolveLaunchContract({
		capabilityId: capabilityForAgent({ agent: AGENT, childTools: CHILD_TOOLS, representationId: "unavailable" }).capabilityId,
		corpusSnapshotId: "unset",
		deliveryGear: args.gear,
		memoryRefs: [],
		mode: "synapse",
		namespaceId: deriveNamespaceId(args.worktree),
		representationId: "unavailable",
		scope: { pathPrefixes: [""], write: true },
		storageRoot: args.store,
	});

	const service = createMemoryService({
		provenance: { agent: AGENT, attempt: 1, runId: args.run, sessionId: "probe" },
		scope: { agent: AGENT, namespaceId: contract.namespaceId, pathPrefixes: [""], write: true },
		storeRoot: args.store,
		worktreeRoot: args.worktree,
	});
	// One recalled memory, so the envelope carries a handle and the run exercises
	// the same shape a real delegation has rather than an empty special case.
	await service.remember({
		content: "the login path checks the session cookie first",
		kind: "evidence",
		operationId: `${args.run}/seed`,
		summary: "login is verified in src/auth.ts",
		tags: ["auth"],
		topic: "auth flow",
	});

	const route = selectEnvelopeRoute({ childIndex: CHILD_INDEX, deliveryGear: args.gear, runId: args.run, storageRoot: args.store });

	// Bind first. A receiver that binds after the parent connects is a receiver
	// the parent already failed to reach.
	let received: Promise<{ delivered: { status: string }; silentReason: string | null }> | undefined;
	if (route.gear === "uds") {
		fs.mkdirSync(path.dirname(route.address), { recursive: true });
		received = receiveEnvelopeViaUdsRoute(route.address);
	}

	const log = createMeteringLog(meteringLogPath(contract, args.run));
	const startedAt = process.hrtime.bigint();
	const delegation = openDelegation({
		budgetBytes: 8192,
		contract,
		deps: { log, service },
		identity: {
			agent: AGENT,
			attempt: 1,
			childIndex: CHILD_INDEX,
			childTools: CHILD_TOOLS,
			receiverSessionId: "probe-child",
			requestId: `${args.run}-req`,
			runId: args.run,
			senderSessionId: "probe-parent",
		},
		message: "Task: explain the auth flow",
		worktreeRoot: args.worktree,
	});
	if (delegation === null) throw new Error("negotiation refused the delegation");
	if (delegation.envelopeDelivery !== undefined) await delegation.envelopeDelivery;

	// Verify on the receiving side, so the probe reports a delivery that was
	// actually accepted rather than one that merely left the process.
	let receiptStatus = "absent";
	let mismatch: string | null = null;
	if (received !== undefined) {
		const outcome = await received;
		receiptStatus = outcome.delivered.status;
		if (outcome.delivered.status === "ready") {
			mismatch = verifyEnvelopeAgainstContract({ contract, wire: (outcome.delivered as { wire: Parameters<typeof verifyEnvelopeAgainstContract>[0]["wire"] }).wire });
		}
	} else {
		const delivered = readDeliveredEnvelope(route.address);
		receiptStatus = delivered.status;
		if (delivered.status === "ready") mismatch = verifyEnvelopeAgainstContract({ contract, wire: delivered.wire });
	}
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

	delegation.close({ outcome: "completed", summary: "probe", usage: null });
	const totals = aggregateMetering(readMeteringLog(meteringLogPath(contract, args.run)));

	process.stdout.write(`${JSON.stringify({
		elapsedMs: Math.round(elapsedMs * 1000) / 1000,
		endpoint: route.address,
		envelopeBytes: totals.control.envelopeBytes,
		gear: args.gear,
		mismatch,
		receiptStatus,
		// `"N/A"` on the file gear by design: file bytes may never touch a
		// transport at all, so a number there would be an invention.
		transportBytes: totals.control.transportBytes,
	})}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});

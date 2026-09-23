import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveSynapseConfig } from "../../src/synapse/config.ts";
import { buildEnvelope, freezeSnapshot, type Envelope } from "../../src/synapse/envelope.ts";
import {
	envelopeInboxPath,
	nodeIdFor,
	publishEnvelope,
	readDeliveredEnvelope,
	verifyEnvelopeAgainstContract,
} from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";

const CAPABILITY_ID = "c".repeat(64);
const MEMORY_ID = "a".repeat(64);
const OTHER_MEMORY_ID = "b".repeat(64);
const NAMESPACE_ID = "0123456789abcdef";
const OTHER_NAMESPACE_ID = "fedcba9876543210";
const RUN_ID = "run-1";

let root = "";
let store = "";

type ContractOverrides = {
	capabilityId?: string;
	namespaceId?: string;
	pathPrefixes?: string[];
};

function contractFor(overrides: ContractOverrides = {}): LaunchContract {
	return resolveLaunchContract({
		capabilityId: overrides.capabilityId ?? CAPABILITY_ID,
		corpusSnapshotId: "unset",
		deliveryGear: "file",
		memoryRefs: [],
		mode: "synapse",
		namespaceId: overrides.namespaceId ?? NAMESPACE_ID,
		representationId: "unavailable",
		scope: { pathPrefixes: overrides.pathPrefixes ?? ["src"], write: false },
		stateVerify: "off",
		storageRoot: store,
	});
}

/** An envelope frozen against the given contract, so a clean verification is the default. */
function envelopeFor(contract: LaunchContract, memoryRefs: string[] = [MEMORY_ID]): Envelope {
	return buildEnvelope({
		action: "delegate",
		attempt: 1,
		inputParams: { agent: "retriever", task: "explain the auth flow" },
		nodeId: nodeIdFor(RUN_ID, 0),
		ownerRunId: RUN_ID,
		receiverSessionId: "sess-child",
		requestId: "req-1",
		runId: RUN_ID,
		senderSessionId: "sess-parent",
		snapshot: freezeSnapshot({
			capabilityId: contract.capabilityId,
			corpusSnapshotId: contract.corpusSnapshotId,
			memoryRefs,
			namespaceId: contract.namespaceId,
			permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
			representationId: contract.representationId,
		}),
	});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-envelope-inbox-"));
	store = path.join(root, "store");
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("envelope inbox addressing", () => {
	it("gives the sender and the receiver the same address for the same node", () => {
		// The parent knows the run and the child index before it publishes; the
		// child knows both before it starts. Deriving the path here is what stops
		// the two from disagreeing.
		assert.equal(envelopeInboxPath(store, RUN_ID, 0), envelopeInboxPath(store, RUN_ID, 0));
		assert.equal(envelopeInboxPath(store, RUN_ID, 0), path.join(store, "envelopes", RUN_ID, "0.json"));
	});

	it("keeps a run id with separators inside one directory component", () => {
		const target = envelopeInboxPath(store, "owner/run:1", 2);
		assert.equal(target, path.join(store, "envelopes", "owner_run_1", "2.json"));
	});

	it("addresses an unattributed child index consistently on both sides", () => {
		assert.equal(envelopeInboxPath(store, RUN_ID, undefined), path.join(store, "envelopes", RUN_ID, "unattributed.json"));
		assert.equal(nodeIdFor(RUN_ID, undefined), `${RUN_ID}/unattributed`);
		assert.notEqual(envelopeInboxPath(store, RUN_ID, undefined), envelopeInboxPath(store, RUN_ID, 0));
	});

	it("derives the metered node id from the same parts as the inbox", () => {
		assert.equal(nodeIdFor(RUN_ID, 0), `${RUN_ID}/0`);
	});
});

describe("envelope delivery", () => {
	it("round-trips the wire form through the inbox", () => {
		const contract = contractFor();
		const envelope = envelopeFor(contract);
		const target = publishEnvelope(store, RUN_ID, 0, envelope);

		assert.equal(target, envelopeInboxPath(store, RUN_ID, 0));
		const delivered = readDeliveredEnvelope(target);
		assert.equal(delivered.status, "ready");
		assert.deepEqual(delivered.status === "ready" ? delivered.wire : null, envelope.wire);
	});

	it("reports an undelivered envelope as absent rather than as a failure", () => {
		// The parent skips delegation whenever negotiation refuses it or the meter
		// cannot be opened. The child must then run upstream's own task.
		const delivered = readDeliveredEnvelope(envelopeInboxPath(store, RUN_ID, 0));
		assert.equal(delivered.status, "absent");
	});

	it("routes the default config to the file gear, and publish/read behave exactly as before S2 (verify a)", () => {
		// "Off by default" is a claim this test enforces rather than states: an
		// experiment config that names nothing must still resolve to the gear
		// this module has always used, and the round trip through it must be the
		// same round trip synapse-envelope-inbox has always proven.
		const config = resolveSynapseConfig(undefined);
		assert.equal(config.deliveryGear, "file");

		const contract = contractFor();
		const envelope = envelopeFor(contract);
		const target = publishEnvelope(store, RUN_ID, 0, envelope);
		assert.equal(target, envelopeInboxPath(store, RUN_ID, 0));
		assert.equal(fs.existsSync(target), true);
		assert.equal(target.endsWith(".json"), true);

		const delivered = readDeliveredEnvelope(target);
		assert.equal(delivered.status, "ready");
		assert.deepEqual(delivered.status === "ready" ? delivered.wire : null, envelope.wire);
	});

	it("replaces the envelope when the same node is delegated to again", () => {
		const contract = contractFor();
		const target = publishEnvelope(store, RUN_ID, 0, envelopeFor(contract, [MEMORY_ID]));
		publishEnvelope(store, RUN_ID, 0, envelopeFor(contract, [OTHER_MEMORY_ID]));

		const delivered = readDeliveredEnvelope(target);
		assert.deepEqual(delivered.status === "ready" ? delivered.wire.memoryRefs : null, [OTHER_MEMORY_ID]);
	});

	it("rejects a delivered envelope that is not valid JSON", () => {
		const target = envelopeInboxPath(store, RUN_ID, 0);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "{ not json", "utf-8");

		const delivered = readDeliveredEnvelope(target);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /not valid JSON/);
	});

	it("rejects v1, which named the memory refs as context refs", () => {
		// The rename was a hard cutover. No envelope was ever persisted under v1,
		// so accepting one would only make a stale contract look current.
		const envelope = envelopeFor(contractFor());
		const target = envelopeInboxPath(store, RUN_ID, 0);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ ...envelope.wire, protocolVersion: 1 }), "utf-8");

		const delivered = readDeliveredEnvelope(target);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /protocolVersion/);
	});

	it("rejects an unknown field, since an ignored field is a silently different contract", () => {
		const envelope = envelopeFor(contractFor());
		const target = envelopeInboxPath(store, RUN_ID, 0);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ ...envelope.wire, residualHint: true }), "utf-8");

		assert.equal(readDeliveredEnvelope(target).status, "rejected");
	});
});

describe("envelope verification", () => {
	it("accepts an envelope frozen against this receiver's contract", () => {
		const contract = contractFor();
		assert.equal(verifyEnvelopeAgainstContract({ contract, wire: envelopeFor(contract).wire }), null);
	});

	it("refuses an envelope frozen for another namespace", () => {
		const contract = contractFor();
		const foreign = envelopeFor(contractFor({ namespaceId: OTHER_NAMESPACE_ID }));

		const reason = verifyEnvelopeAgainstContract({ contract, wire: foreign.wire });
		assert.match(reason ?? "", /namespace/);
	});

	it("refuses an envelope negotiated for another capability", () => {
		const contract = contractFor();
		const foreign = envelopeFor(contractFor({ capabilityId: "d".repeat(64) }));

		const reason = verifyEnvelopeAgainstContract({ contract, wire: foreign.wire });
		assert.match(reason ?? "", /capability/);
	});

	it("refuses an envelope whose memory refs were edited after it was frozen", () => {
		// Refreezing from the envelope's own refs is what catches this: the
		// snapshot id it carries no longer matches the contents it describes.
		const contract = contractFor();
		const tampered = { ...envelopeFor(contract).wire, memoryRefs: [OTHER_MEMORY_ID] };

		const reason = verifyEnvelopeAgainstContract({ contract, wire: tampered });
		assert.match(reason ?? "", /snapshot/);
	});

	it("refuses an envelope frozen against a wider authorisation than this launch has", () => {
		const contract = contractFor({ pathPrefixes: ["src"] });
		const wider = envelopeFor(contractFor({ pathPrefixes: [""] }));

		const reason = verifyEnvelopeAgainstContract({ contract, wire: wider.wire });
		assert.match(reason ?? "", /snapshot/);
	});
});

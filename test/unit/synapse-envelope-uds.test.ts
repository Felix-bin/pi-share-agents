import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	classifyUdsSendFailure,
	publishEnvelopeViaUds,
	receiveDeliveredEnvelopeViaUds,
	SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES,
	udsEndpointPath,
	type UdsClientTransport,
	type UdsServerTransport,
} from "../../src/synapse/envelope-uds.ts";
import { classifySynapseError } from "../../src/synapse/errors.ts";
import { buildEnvelope, freezeSnapshot, type Envelope } from "../../src/synapse/envelope.ts";
import { nodeIdFor } from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";

const CAPABILITY_ID = "c".repeat(64);
const MEMORY_ID = "a".repeat(64);
const NAMESPACE_ID = "0123456789abcdef";
const RUN_ID = "run-1";
const STORE = "/store";

function contractFor(): LaunchContract {
	return resolveLaunchContract({
		capabilityId: CAPABILITY_ID,
		corpusSnapshotId: "unset",
		memoryRefs: [],
		mode: "synapse",
		namespaceId: NAMESPACE_ID,
		representationId: "unavailable",
		scope: { pathPrefixes: ["src"], write: false },
		storageRoot: STORE,
	});
}

function envelopeFor(contract: LaunchContract): Envelope {
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
			memoryRefs: [MEMORY_ID],
			namespaceId: contract.namespaceId,
			permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
			representationId: contract.representationId,
		}),
	});
}

/**
 * An in-memory stand-in for a real AF_UNIX socket pair, used because this
 * environment cannot bind a real one (`EACCES`, confirmed against this
 * sandbox — see envelope-uds.ts's module header). `listening` tracks which
 * endpoints have an active receiver, the same fact a real kernel tracks by
 * whether `listen()` was ever called on that path; `send` before any matching
 * `receiveOnce` call reproduces exactly the "peer is not there" case a real
 * `connect()` would report as `ECONNREFUSED`.
 */
function createFakeUdsChannel() {
	const listening = new Set<string>();
	const pendingFrames = new Map<string, Buffer[]>();
	const waitingReaders = new Map<string, (frame: Buffer) => void>();

	const client: UdsClientTransport = {
		send(endpointPath, frame) {
			if (!listening.has(endpointPath)) {
				// SAFETY: this Error is constructed right here for the sole purpose of
				// carrying a `code`, matching the shape Node attaches to a real
				// ECONNREFUSED so classifyUdsSendFailure sees the same input it would
				// from a real socket.
				const error = new Error(`connect ECONNREFUSED ${endpointPath}`) as NodeJS.ErrnoException;
				error.code = "ECONNREFUSED";
				return Promise.reject(error);
			}
			const waiting = waitingReaders.get(endpointPath);
			if (waiting) {
				waitingReaders.delete(endpointPath);
				waiting(frame);
			} else {
				const queue = pendingFrames.get(endpointPath) ?? [];
				queue.push(frame);
				pendingFrames.set(endpointPath, queue);
			}
			return Promise.resolve(frame.byteLength);
		},
	};

	const server: UdsServerTransport = {
		receiveOnce(endpointPath) {
			listening.add(endpointPath);
			const queue = pendingFrames.get(endpointPath);
			const queued = queue?.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise((resolve) => waitingReaders.set(endpointPath, resolve));
		},
	};

	return { client, server };
}

describe("uds endpoint addressing", () => {
	it("addresses a node under its own top-level entry, parallel to envelopeInboxPath's layout", () => {
		assert.equal(udsEndpointPath(STORE, RUN_ID, 0), path.join(STORE, "uds", RUN_ID, "0.sock"));
	});

	it("addresses an unattributed child index the same way envelopeInboxPath does", () => {
		assert.equal(udsEndpointPath(STORE, RUN_ID, undefined), path.join(STORE, "uds", RUN_ID, "unattributed.sock"));
	});

	it("stays within the sun_path budget for an ordinary storage root", () => {
		const endpoint = udsEndpointPath("/home/dev/.pi/agent/synapse", "run-abc123", 3);
		assert.ok(Buffer.byteLength(endpoint, "utf-8") <= SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES);
	});
});

describe("uds endpoint path budget (verify d)", () => {
	it("refuses a path over the sun_path budget and names the overflowing component", () => {
		const longStorageRoot = `/${"a".repeat(120)}`;
		assert.throws(
			() => udsEndpointPath(longStorageRoot, RUN_ID, 0),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^uds-endpoint-path-too-long: storageRoot contributes \d+ of the \d+ bytes/);
				assert.match(error.message, /exceeds the 107-byte sun_path budget/);
				return true;
			},
		);
	});

	it("names runId when it is the largest contributor instead of always blaming storageRoot", () => {
		const shortRoot = "/s";
		const longRunId = "r".repeat(120);
		// assert.throws matches a RegExp against Error.prototype.toString(), which
		// prepends "Error: " — unanchored so that prefix does not defeat the match.
		assert.throws(() => udsEndpointPath(shortRoot, longRunId, 0), /uds-endpoint-path-too-long: runId contributes/);
	});

	it("accepts a path exactly at the budget and refuses one byte over it", () => {
		// Binary-search the exact boundary rather than hard-coding a byte count
		// that would silently go stale if the fixed suffix (`envelopes/.../N.sock`)
		// ever changes shape.
		let fits = 1;
		let overflows = 200;
		while (overflows - fits > 1) {
			const mid = Math.floor((fits + overflows) / 2);
			const root = `/${"x".repeat(mid)}`;
			try {
				udsEndpointPath(root, "r", 0);
				fits = mid;
			} catch {
				overflows = mid;
			}
		}
		assert.doesNotThrow(() => udsEndpointPath(`/${"x".repeat(fits)}`, "r", 0));
		assert.throws(() => udsEndpointPath(`/${"x".repeat(overflows)}`, "r", 0), /uds-endpoint-path-too-long/);
	});

	it("classifies the refusal as configuration, the same bucket as other bound violations", () => {
		const longStorageRoot = `/${"a".repeat(120)}`;
		try {
			udsEndpointPath(longStorageRoot, RUN_ID, 0);
			assert.fail("expected udsEndpointPath to throw");
		} catch (error) {
			assert.equal(classifySynapseError(error), "configuration");
		}
	});
});

describe("uds send failure classification", () => {
	it("names a refused connection as a persistence failure, not a silent empty delivery", () => {
		// SAFETY: constructed here purely to carry a `code`, the same shape Node
		// attaches to a real ECONNREFUSED — see the identical note above.
		const refused = new Error("connect ECONNREFUSED /store/envelopes/run-1/0.sock") as NodeJS.ErrnoException;
		refused.code = "ECONNREFUSED";
		const classified = classifyUdsSendFailure(refused, "/store/envelopes/run-1/0.sock");
		assert.match(classified.message, /^persistence: uds delivery to .*found no peer listening \(ECONNREFUSED\)/);
		assert.equal(classifySynapseError(classified), "persistence");
	});

	it("still names an unrecognised transport failure, distinct from a peer that is absent", () => {
		const classified = classifyUdsSendFailure(new Error("write EPIPE"), "/store/envelopes/run-1/0.sock");
		assert.match(classified.message, /^persistence: uds delivery to .* failed: write EPIPE/);
		assert.doesNotMatch(classified.message, /no peer listening/);
	});

	it("handles a non-Error cause without throwing from the classifier itself", () => {
		const classified = classifyUdsSendFailure("boom", "/store/x.sock");
		assert.match(classified.message, /^persistence: uds delivery to .* failed: boom/);
	});
});

describe("uds round trip (verify b)", () => {
	it("delivers an envelope through the endpoint byte-identical to the original", async () => {
		const { client, server } = createFakeUdsChannel();
		const contract = contractFor();
		const envelope = envelopeFor(contract);
		const endpoint = udsEndpointPath(STORE, RUN_ID, 0);

		// The receiver binds first, as the connection-lifetime design in
		// envelope-uds.ts's module header requires: the sender's connect() must
		// have somewhere to land. Starting the receive before the publish (rather
		// than via Promise.all, whose array elements are evaluated left-to-right
		// synchronously) is what makes that ordering deterministic here.
		const deliveredPromise = receiveDeliveredEnvelopeViaUds(endpoint, server);
		const published = await publishEnvelopeViaUds(endpoint, envelope, client);
		const delivered = await deliveredPromise;

		assert.ok(published.bytesWritten > 0);
		// The frame header (4 bytes) plus the JSON body, exactly what encodeFrame produced.
		assert.equal(published.bytesWritten, 4 + Buffer.byteLength(JSON.stringify(envelope.wire), "utf-8"));
		assert.equal(delivered.status, "ready");
		assert.deepEqual(delivered.status === "ready" ? delivered.wire : null, envelope.wire);
	});
});

describe("uds peer absent (verify c)", () => {
	it("rejects the publish with a named failure instead of reporting success", async () => {
		const { client } = createFakeUdsChannel();
		const contract = contractFor();
		const envelope = envelopeFor(contract);
		const endpoint = udsEndpointPath(STORE, RUN_ID, 0);

		await assert.rejects(publishEnvelopeViaUds(endpoint, envelope, client), (error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^persistence: uds delivery to .*found no peer listening \(ECONNREFUSED\)/);
			assert.equal(classifySynapseError(error), "persistence");
			return true;
		});
	});
});

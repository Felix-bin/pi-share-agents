import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	classifyUdsSendFailure,
	publishEnvelopeViaUds,
	receiveDeliveredEnvelopeViaUds,
	SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES,
	SYNAPSE_UDS_DEADLINE_MS,
	udsEndpointPath,
	withUdsDeadline,
	type UdsClientTransport,
	type UdsServerTransport,
} from "../../src/synapse/envelope-uds.ts";
import { classifySynapseError } from "../../src/synapse/errors.ts";
import { encodeFrame, SYNAPSE_MAX_FRAME_BYTES } from "../../src/synapse/envelope-framing.ts";
import { buildEnvelope, freezeSnapshot, type Envelope } from "../../src/synapse/envelope.ts";
import { nodeIdFor } from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";

const CAPABILITY_ID = "c".repeat(64);
const MEMORY_ID = "a".repeat(64);
const NAMESPACE_ID = "0123456789abcdef";
// A realistic runId: production always mints one with randomUUID() (36 bytes,
// hyphens included — see subagent-executor.ts:1957/2082/6888), never the
// short literal this file used before the fix-round review caught it.
const RUN_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const STORE = "/store";
const ENDPOINT = udsEndpointPath(STORE, RUN_ID, 0);

function contractFor(): LaunchContract {
	return resolveLaunchContract({
		capabilityId: CAPABILITY_ID,
		corpusSnapshotId: "unset",
		deliveryGear: "file",
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

type FakeReceiver = {
	finish: (error?: Error) => void;
	onChunk: (chunk: Buffer) => "continue" | "stop";
};

/**
 * An in-memory stand-in for a real AF_UNIX byte stream, used because this
 * environment cannot bind a real one (`EACCES`, confirmed against this
 * sandbox — see envelope-uds.ts's module header). Unlike a first attempt at
 * this fake (fix-round review caught it), this one is chunk-oriented rather
 * than message-oriented: `chunkBytes` controls how many bytes of a frame are
 * delivered to the receiver's `onChunk` per call, so a caller can force a
 * frame across an arbitrary number of splits — including one byte at a time
 * — and prove reassembly through the real `receiveDeliveredEnvelopeViaUds`
 * code path, not just through envelope-framing.ts's own (already-exhaustive)
 * unit tests.
 *
 * `receivers` holds at most one pending receiver per endpoint, matching this
 * module's one-connection-per-node lifecycle. `send` before any matching
 * `receiveOnce` reproduces exactly the "peer is not there" case a real
 * `connect()` would report as `ECONNREFUSED`; the map entry is only created
 * once `receiveOnce` is *called* (not once its promise settles), the same
 * fact a real `listen()` establishes before any `connect()` needs to land.
 */
function createFakeUdsChannel(options: { chunkBytes?: number } = {}) {
	const chunkBytes = options.chunkBytes ?? Number.POSITIVE_INFINITY;
	const receivers = new Map<string, FakeReceiver>();

	const client: UdsClientTransport = {
		async send(endpointPath, frame) {
			const receiver = receivers.get(endpointPath);
			if (!receiver) {
				// SAFETY: this Error is constructed right here for the sole purpose of
				// carrying a `code`, matching the shape Node attaches to a real
				// ECONNREFUSED so classifyUdsSendFailure sees the same input it would
				// from a real socket.
				const error = new Error(`connect ECONNREFUSED ${endpointPath}`) as NodeJS.ErrnoException;
				error.code = "ECONNREFUSED";
				throw error;
			}
			let offset = 0;
			let stopped = false;
			while (offset < frame.byteLength) {
				const end = Math.min(offset + chunkBytes, frame.byteLength);
				const piece = frame.subarray(offset, end);
				offset = end;
				if (receiver.onChunk(piece) === "stop") {
					stopped = true;
					receiver.finish();
					break;
				}
			}
			if (!stopped) receiver.finish();
			receivers.delete(endpointPath);
			return frame.byteLength;
		},
	};

	const server: UdsServerTransport = {
		receiveOnce(endpointPath, onChunk) {
			return new Promise((resolve, reject) => {
				receivers.set(endpointPath, {
					finish: (error) => {
						receivers.delete(endpointPath);
						if (error === undefined) resolve();
						else reject(error);
					},
					onChunk,
				});
			});
		},
	};

	return { client, server };
}

/** A one-shot fake for tests that drive `receiveDeliveredEnvelopeViaUds` directly against a hand-built byte sequence, bypassing `publishEnvelopeViaUds` entirely. */
function fixedDeliveryTransport(deliver: (onChunk: (chunk: Buffer) => "continue" | "stop") => void | Promise<void>): UdsServerTransport {
	return {
		async receiveOnce(_endpointPath, onChunk) {
			await deliver(onChunk);
		},
	};
}

describe("uds endpoint addressing", () => {
	it("addresses a node under its own top-level entry, parallel to envelopeInboxPath's layout", () => {
		assert.equal(udsEndpointPath(STORE, RUN_ID, 0), path.join(STORE, "uds", RUN_ID, "0.sock"));
	});

	it("addresses an unattributed child index the same way envelopeInboxPath does", () => {
		assert.equal(udsEndpointPath(STORE, RUN_ID, undefined), path.join(STORE, "uds", RUN_ID, "unattributed.sock"));
	});

	it("stays within the sun_path budget for a realistic storage root and a real (36-byte) runId", () => {
		// /home/dev/.pi/agent/synapse/<16-hex> is 33 bytes; comfortably fits even
		// with a full-length UUID runId. See the task report for the margin case.
		const endpoint = udsEndpointPath("/home/dev/.pi/agent/synapse/0123456789abcdef", RUN_ID, 3);
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

	it("accepts a path exactly at the budget and refuses one byte over it, pinned to the actual 107-byte constant", () => {
		// Binary-search the exact boundary rather than hard-coding a storageRoot
		// length that would silently go stale if the fixed suffix
		// (`uds/<run>/<receiver>.sock`) ever changes shape.
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
		const atBudget = udsEndpointPath(`/${"x".repeat(fits)}`, "r", 0);
		// Pins the boundary to the actual constant, not merely to "some sharp
		// edge": a `>` → `>=` slip in udsEndpointPath would move `fits` down by
		// one and this assertion would catch it, where a purely relative
		// before/after comparison would not.
		assert.equal(Buffer.byteLength(atBudget, "utf-8"), SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES);
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

describe("uds deadlines", () => {
	/** A promise that models the failure mode the deadline exists for: a peer that neither answers nor closes. */
	function neverSettles<T>(): Promise<T> {
		return new Promise<T>(() => {});
	}

	it("names the operation and the endpoint when the peer never answers, and tears it down", async () => {
		let torndown = 0;
		await assert.rejects(
			withUdsDeadline(neverSettles<number>(), { endpointPath: ENDPOINT, onExpire: () => (torndown += 1), operation: "delivery", timeoutMs: 1 }),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^timeout: uds delivery at .* did not complete within 1ms$/);
				// A stalled peer is neither a refusal nor corruption; misfiling it as
				// `persistence` would put it in the same bucket as a full disk.
				assert.equal(classifySynapseError(error), "timeout");
				return true;
			},
		);
		// Left listening or left connected, the handle would outlive the failure
		// and the next attempt would collide with it.
		assert.equal(torndown, 1);
	});

	it("names the receive side distinctly, so a log says which half of the exchange stalled", async () => {
		await assert.rejects(
			withUdsDeadline(neverSettles<void>(), { endpointPath: ENDPOINT, onExpire: () => {}, operation: "receive", timeoutMs: 1 }),
			/^Error: timeout: uds receive at /,
		);
	});

	it("leaves an operation that finishes in time completely untouched", async () => {
		let torndown = 0;
		const value = await withUdsDeadline(Promise.resolve(42), { endpointPath: ENDPOINT, onExpire: () => (torndown += 1), operation: "delivery", timeoutMs: 1 });
		assert.equal(value, 42);
		// Given 1ms, a deadline that fired anyway would be a deadline that keeps
		// firing after its operation settled — the bug this asserts against.
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(torndown, 0);
	});

	it("passes a real transport failure through as itself rather than reporting a timeout", async () => {
		let torndown = 0;
		// SAFETY: constructed here to carry the `code` a real refused connect has.
		const refused = new Error(`connect ECONNREFUSED ${ENDPOINT}`) as NodeJS.ErrnoException;
		refused.code = "ECONNREFUSED";
		await assert.rejects(
			withUdsDeadline(Promise.reject(refused), { endpointPath: ENDPOINT, onExpire: () => (torndown += 1), operation: "delivery", timeoutMs: 1 }),
			(error) => {
				assert.equal(error, refused, "the original cause must reach classifyUdsSendFailure unchanged");
				return true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(torndown, 0);
	});

	it("uses a default deadline rather than waiting forever when a caller names none", () => {
		// The constant is what a live delegation gets; a test that only ever
		// passed its own timeoutMs would not notice the default going missing.
		assert.equal(SYNAPSE_UDS_DEADLINE_MS, 5_000);
	});
});

describe("uds send failure classification", () => {
	it("passes a deadline failure through unchanged instead of re-filing it as persistence", () => {
		const expired = new Error(`timeout: uds delivery at ${ENDPOINT} did not complete within 5000ms`);
		const classified = classifyUdsSendFailure(expired, ENDPOINT);
		assert.equal(classified, expired);
		assert.equal(classifySynapseError(classified), "timeout");
	});

	it("names a refused connection as a persistence failure, not a silent empty delivery", () => {
		// SAFETY: constructed here purely to carry a `code`, the same shape Node
		// attaches to a real ECONNREFUSED — see the identical note above.
		const refused = new Error(`connect ECONNREFUSED ${ENDPOINT}`) as NodeJS.ErrnoException;
		refused.code = "ECONNREFUSED";
		const classified = classifyUdsSendFailure(refused, ENDPOINT);
		assert.match(classified.message, /^persistence: uds delivery to .*found no peer listening \(ECONNREFUSED\)/);
		assert.equal(classifySynapseError(classified), "persistence");
	});

	it("still names an unrecognised transport failure, distinct from a peer that is absent", () => {
		const classified = classifyUdsSendFailure(new Error("write EPIPE"), ENDPOINT);
		assert.match(classified.message, /^persistence: uds delivery to .* failed: write EPIPE/);
		assert.doesNotMatch(classified.message, /no peer listening/);
	});

	it("handles a non-Error cause without throwing from the classifier itself", () => {
		const classified = classifyUdsSendFailure("boom", ENDPOINT);
		assert.match(classified.message, /^persistence: uds delivery to .* failed: boom/);
	});

	it("passes an envelope-framing frame-too-large error through unchanged instead of re-wrapping it", () => {
		// Re-wrapping under "persistence:" would defeat errors.ts's own
		// frame-too-large -> configuration classification.
		const original = new Error("frame-too-large: length prefix declares 99999999 bytes, exceeding the 1048576-byte limit");
		const classified = classifyUdsSendFailure(original, ENDPOINT);
		assert.equal(classified, original);
		assert.equal(classifySynapseError(classified), "configuration");
	});
});

describe("uds publish short-write postcondition", () => {
	it("throws rather than reporting success when the transport under-writes the frame", async () => {
		const transport: UdsClientTransport = {
			send: async (_endpointPath, frame) => frame.byteLength - 1,
		};
		const envelope = envelopeFor(contractFor());
		await assert.rejects(publishEnvelopeViaUds(ENDPOINT, envelope, transport), (error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^persistence: uds delivery to .* wrote \d+ of \d+ bytes, a short write/);
			assert.equal(classifySynapseError(error), "persistence");
			return true;
		});
	});
});

describe("uds round trip (verify b)", () => {
	it("delivers an envelope through the endpoint byte-identical to the original, split one byte at a time", async () => {
		// chunkBytes: 1 forces the maximum possible number of splits, so this
		// exercises envelope-framing.ts's incremental reassembly through the real
		// receive path rather than through one pre-joined buffer.
		const { client, server } = createFakeUdsChannel({ chunkBytes: 1 });
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
		// 逐字相同 (verify b's own wording): compare the serialised wire form, not
		// a structural deepEqual, which would still pass under a key reordering
		// that canonical hashing (envelope.snapshotId, envelopeBytes) would not
		// treat as identical.
		assert.equal(JSON.stringify(delivered.status === "ready" ? delivered.wire : null), JSON.stringify(envelope.wire));
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

describe("uds receive-side failure branches", () => {
	it("reports a transport-level rejection as rejected, not silently absent", async () => {
		const transport = fixedDeliveryTransport(() => {
			throw new Error("ECONNRESET");
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /could not be received/);
	});

	it("rejects an oversized declared length the instant the header is read (decoder throw: frame-too-large)", async () => {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(SYNAPSE_MAX_FRAME_BYTES + 1, 0);
		let signalSeen: "continue" | "stop" | undefined;
		const transport = fixedDeliveryTransport((onChunk) => {
			// Only the 4-byte header is ever delivered — no body bytes exist to
			// send — so a "stop" here can only be explained by rejection at the
			// header, before any body byte was read or buffered.
			signalSeen = onChunk(header);
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(signalSeen, "stop");
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /^frame-too-large/);
		assert.equal(classifySynapseError(new Error(delivered.status === "rejected" ? delivered.reason : "")), "configuration");
	});

	it("rejects a stream that ends mid-frame (decoder throw on end: frame-truncated)", async () => {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(10, 0); // declares 10 body bytes
		const partialBody = Buffer.from("short"); // only 5 arrive before the peer closes
		const transport = fixedDeliveryTransport((onChunk) => {
			const signal = onChunk(Buffer.concat([header, partialBody]));
			assert.equal(signal, "continue", "5 of 10 declared body bytes is not yet a complete frame");
			// The fake's receiveOnce resolves here, simulating the peer's FIN with
			// nothing more ever sent.
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /^frame-truncated/);
		assert.equal(classifySynapseError(new Error(delivered.status === "rejected" ? delivered.reason : "")), "integrity");
	});

	it("rejects more than one frame arriving before onChunk has a chance to stop", async () => {
		const frameA = encodeFrame(Buffer.from("a"));
		const frameB = encodeFrame(Buffer.from("b"));
		const transport = fixedDeliveryTransport((onChunk) => {
			const signal = onChunk(Buffer.concat([frameA, frameB]));
			assert.equal(signal, "stop");
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /expected exactly one frame, got 2/);
	});

	it("rejects a complete frame whose body is not valid JSON", async () => {
		const frame = encodeFrame(Buffer.from("{ not json"));
		const transport = fixedDeliveryTransport((onChunk) => {
			onChunk(frame);
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(delivered.status, "rejected");
		assert.match(delivered.status === "rejected" ? delivered.reason : "", /is not valid JSON/);
	});

	it("rejects a complete frame that parses as JSON but fails envelope schema validation", async () => {
		const frame = encodeFrame(Buffer.from(JSON.stringify({ not: "an envelope" })));
		const transport = fixedDeliveryTransport((onChunk) => {
			onChunk(frame);
		});
		const delivered = await receiveDeliveredEnvelopeViaUds(ENDPOINT, transport);
		assert.equal(delivered.status, "rejected");
		assert.notEqual(delivered.status === "rejected" ? delivered.reason : "", "");
	});
});

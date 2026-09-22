import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { meteringLogPath, openDelegation, type DelegationIdentity } from "../../src/synapse/delegation.ts";
import { receiveEnvelopeViaUdsRoute, selectEnvelopeRoute, verifiedTransportByteCount } from "../../src/synapse/envelope-gear.ts";
import { envelopeInboxPath, nodeIdFor } from "../../src/synapse/envelope-inbox.ts";
import { encodeFrame } from "../../src/synapse/envelope-framing.ts";
import { udsEndpointPath, type UdsClientTransport, type UdsServerTransport } from "../../src/synapse/envelope-uds.ts";
import { classifySynapseError } from "../../src/synapse/errors.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, createMeteringLog, readMeteringLog, type MeteringEvent, type MeteringLog } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import type { SynapseDeliveryGear } from "../../src/synapse/config.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";

/**
 * Gear dispatch: the map from `LaunchContract.deliveryGear` to a gear that
 * actually runs, and the two ends of the `uds` route meeting through it.
 *
 * AF_UNIX cannot be bound in this repository's sandbox, so the socket itself
 * is a fake on both sides. What that fake stands in for is exactly the byte
 * stream `envelope-uds.ts` was designed against: chunk-oriented, one receiver
 * per endpoint, and refusing a sender whose peer has not bound yet.
 */

const AGENT = "retriever";
const CHILD_TOOLS = ["read", "grep"] as const;
const CHILD_INDEX = 0;
/**
 * Short on purpose. These tests address a real temp directory, and a 36-byte
 * UUID run id plus a deep `os.tmpdir()` can push a `uds` endpoint past the
 * 107-byte `sun_path` budget on some hosts and not others — which would make
 * this file fail for a reason that has nothing to do with gear dispatch.
 * Endpoint length is `synapse-envelope-uds.test.ts`'s subject, and it pins the
 * realistic UUID case there.
 */
const RUN_ID = "r1";
const REQUEST_ID = "req-gear-1";

let root = "";
let store = "";
let worktree = "";

function contractFor(deliveryGear: SynapseDeliveryGear): LaunchContract {
	return resolveLaunchContract({
		// Must be the capability the negotiation will mint for this same child,
		// or the envelope would fail verification for a reason unrelated to the
		// gear under test.
		capabilityId: capabilityForAgent({ agent: AGENT, childTools: [...CHILD_TOOLS], representationId: "unavailable" }).capabilityId,
		corpusSnapshotId: "unset",
		deliveryGear,
		memoryRefs: [],
		mode: "synapse",
		namespaceId: deriveNamespaceId(worktree),
		representationId: "unavailable",
		scope: { pathPrefixes: [""], write: true },
		storageRoot: store,
	});
}

function identity(): DelegationIdentity {
	return {
		agent: AGENT,
		attempt: 1,
		childIndex: CHILD_INDEX,
		childTools: [...CHILD_TOOLS],
		receiverSessionId: "sess-child",
		requestId: REQUEST_ID,
		runId: RUN_ID,
		senderSessionId: "sess-parent",
	};
}

/** The production log at the production path: these tests read the file back, so what they assert is what a real run leaves behind. */
function createLog(contract: LaunchContract): MeteringLog {
	return createMeteringLog(meteringLogPath(contract, RUN_ID));
}

function createService(contract: LaunchContract) {
	return createMemoryService({
		provenance: { agent: AGENT, attempt: 1, runId: RUN_ID, sessionId: "sess-child" },
		scope: { agent: AGENT, namespaceId: contract.namespaceId, pathPrefixes: [...contract.scope.pathPrefixes], write: contract.scope.write },
		storeRoot: contract.storageRoot,
		worktreeRoot: worktree,
	});
}

function events(contract: LaunchContract): MeteringEvent[] {
	// process-identity exists only where /proc does; it carries no application
	// work and would make an ordered expectation platform-dependent.
	return readMeteringLog(meteringLogPath(contract, RUN_ID)).filter((event) => event.kind !== "process-identity");
}

type FakeReceiver = {
	finish: (error?: Error) => void;
	onChunk: (chunk: Buffer) => "continue" | "stop";
};

/**
 * The in-memory stand-in for an AF_UNIX byte stream, shaped like the one
 * `synapse-envelope-uds.test.ts` uses: a receiver must have called
 * `receiveOnce` before a sender can connect, which is the fact this whole
 * "bind early" requirement is about.
 */
function createFakeUdsChannel(options: { chunkBytes?: number } = {}) {
	const chunkBytes = options.chunkBytes ?? Number.POSITIVE_INFINITY;
	const receivers = new Map<string, FakeReceiver>();
	const boundAt: string[] = [];

	const client: UdsClientTransport = {
		async send(endpointPath, frame) {
			const receiver = receivers.get(endpointPath);
			if (!receiver) {
				// SAFETY: constructed here purely to carry the `code` Node attaches to
				// a real refused connect, so the classifier sees its real input.
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
			boundAt.push(endpointPath);
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

	return { boundAt, client, server };
}

/** A server transport that binds and then hears nothing at all before the peer's stream ends. */
function silentServer(boundAt: string[]): UdsServerTransport {
	return {
		receiveOnce(endpointPath) {
			boundAt.push(endpointPath);
			return Promise.resolve();
		},
	};
}

type Handlers = Map<string, (payload?: unknown) => unknown>;

function childConfig(contract: LaunchContract, overrides: Partial<ChildRuntimeConfig> = {}): ChildRuntimeConfig {
	return {
		childIndex: CHILD_INDEX,
		depth: 1,
		fanoutChild: false,
		fast: false,
		synapse: { agent: AGENT, contextBudgetBytes: 8192, contract, runId: RUN_ID, sessionId: "sess-child" },
		waitTool: { enabled: false },
		...overrides,
	};
}

/**
 * Registers the child runtime and returns its handlers alongside a timeline
 * that interleaves registration with any bind the runtime performed. The
 * timeline is what makes "binds early" checkable: a bind entry between
 * `register:start` and `register:end` happened during registration and could
 * not have happened at the first agent turn.
 *
 * No `registerTool` is supplied, so the wait tool and the child memory tools
 * — neither of which has anything to do with envelope delivery — stay out of
 * these tests.
 */
function registerChild(contract: LaunchContract, transport?: UdsServerTransport): { handlers: Handlers; timeline: string[] } {
	const handlers: Handlers = new Map();
	const timeline: string[] = [];
	const traced: UdsServerTransport | undefined =
		transport === undefined
			? undefined
			: {
					receiveOnce(endpointPath, onChunk) {
						timeline.push(`bind:${endpointPath}`);
						return transport.receiveOnce(endpointPath, onChunk);
					},
				};
	timeline.push("register:start");
	registerSubagentPromptRuntime(
		{
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [],
		} as never,
		childConfig(contract),
		undefined,
		traced === undefined ? {} : { udsServerTransport: traced },
	);
	timeline.push("register:end");
	return { handlers, timeline };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-gear-"));
	store = path.join(root, "store");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("gear selection is a pure function", () => {
	it("routes the default gear to the file inbox and the uds gear to the socket endpoint", () => {
		assert.deepEqual(selectEnvelopeRoute({ childIndex: 0, deliveryGear: "file", runId: RUN_ID, storageRoot: "/store" }), {
			address: envelopeInboxPath("/store", RUN_ID, 0),
			gear: "file",
		});
		assert.deepEqual(selectEnvelopeRoute({ childIndex: 0, deliveryGear: "uds", runId: RUN_ID, storageRoot: "/store" }), {
			address: udsEndpointPath("/store", RUN_ID, 0),
			gear: "uds",
		});
	});

	it("addresses the same node both gears address, including an unattributed child", () => {
		const file = selectEnvelopeRoute({ childIndex: undefined, deliveryGear: "file", runId: RUN_ID, storageRoot: "/store" });
		const uds = selectEnvelopeRoute({ childIndex: undefined, deliveryGear: "uds", runId: RUN_ID, storageRoot: "/store" });
		assert.match(file.address, /unattributed\.json$/);
		assert.match(uds.address, /unattributed\.sock$/);
	});

	it("touches no filesystem, so a caller can decide a route before anything exists", () => {
		// Directly under the filesystem root, so the uds branch has room inside
		// the sun_path budget and this test measures purity, not path length.
		const absent = path.join(path.parse(root).root, "sg-purity-probe");
		for (const gear of ["file", "uds"] as const) {
			selectEnvelopeRoute({ childIndex: 0, deliveryGear: gear, runId: RUN_ID, storageRoot: absent });
		}
		// A selection that created a directory, opened a file or bound a socket
		// would leave exactly one trace, and this is it.
		assert.equal(fs.existsSync(absent), false);
	});

	it("refuses a uds endpoint over the sun_path budget instead of returning a truncated address", () => {
		assert.throws(
			() => selectEnvelopeRoute({ childIndex: 0, deliveryGear: "uds", runId: RUN_ID, storageRoot: `/${"a".repeat(120)}` }),
			/^Error: uds-endpoint-path-too-long/,
		);
		// The same overlong root is fine for the file gear: no kernel buffer bounds it.
		assert.doesNotThrow(() => selectEnvelopeRoute({ childIndex: 0, deliveryGear: "file", runId: RUN_ID, storageRoot: `/${"a".repeat(120)}` }));
	});
});

describe("transport byte counts are checked before they are metered", () => {
	it("accepts a plausible count unchanged", () => {
		assert.equal(verifiedTransportByteCount(0, "/e.sock"), 0);
		assert.equal(verifiedTransportByteCount(1, "/e.sock"), 1);
		assert.equal(verifiedTransportByteCount(Number.MAX_SAFE_INTEGER, "/e.sock"), Number.MAX_SAFE_INTEGER);
	});

	it("refuses every number that cannot be a count of bytes", () => {
		// metering.ts is deliberately permissive, matching every other counter in
		// that file; this is the seam where a real socket's self-report arrives,
		// so the check lives here instead.
		for (const bad of [-1, -0.5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
			assert.throws(
				() => verifiedTransportByteCount(bad, "/e.sock"),
				(error) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /^integrity: uds delivery to \/e\.sock reported .* bytes written, which is not a byte count$/);
					assert.equal(classifySynapseError(error), "integrity");
					return true;
				},
				`expected ${String(bad)} to be refused`,
			);
		}
	});
});

describe("uds receive distinguishes nothing-arrived from arrived-and-wrong", () => {
	it("reports a receive that saw no bytes at all as absent, keeping the parent's skip a skip", async () => {
		const outcome = await receiveEnvelopeViaUdsRoute("/e.sock", { receiveOnce: () => Promise.resolve() });
		assert.deepEqual(outcome.delivered, { status: "absent" });
		// Absent, but not silent: the reason the receive produced nothing is still
		// reported so an operator can tell a skip from a broken endpoint.
		assert.match(outcome.silentReason ?? "", /closed before a full frame/);
	});

	it("reports a transport that failed before any byte as absent rather than as a refusal", async () => {
		const outcome = await receiveEnvelopeViaUdsRoute("/e.sock", { receiveOnce: () => Promise.reject(new Error("EACCES")) });
		assert.deepEqual(outcome.delivered, { status: "absent" });
		assert.match(outcome.silentReason ?? "", /EACCES/);
	});

	it("keeps a receive that saw bytes and still failed as rejected: that envelope is present and wrong", async () => {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(10, 0);
		const outcome = await receiveEnvelopeViaUdsRoute("/e.sock", {
			async receiveOnce(_endpointPath, onChunk) {
				onChunk(Buffer.concat([header, Buffer.from("short")]));
			},
		});
		assert.equal(outcome.delivered.status, "rejected");
		assert.equal(outcome.silentReason, null);
		// One byte is the whole difference between the two outcomes above, so the
		// rule is "did anything arrive", not "did the reason look benign".
		assert.match(outcome.delivered.status === "rejected" ? outcome.delivered.reason : "", /^frame-truncated/);
	});
});

describe("default file gear leaves both call sequences unchanged (verify a)", () => {
	it("performs exactly the parent-side effects it performed before the gear existed, in the same order", () => {
		const contract = contractFor("file");
		const udsCalls: string[] = [];
		const inbox = envelopeInboxPath(store, RUN_ID, CHILD_INDEX);
		const seenAtDelivery: boolean[] = [];

		const realLog = createLog(contract);
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: {
				log: {
					path: realLog.path,
					record: (meterIdentity, payload) => {
						// Pins the one ordering the module's own comment promises: the
						// envelope is on disk before any delivery is written down, so a
						// logged delivery never names an envelope nobody could find.
						if (payload.kind === "message-delivered") seenAtDelivery.push(fs.existsSync(inbox));
						return realLog.record(meterIdentity, payload);
					},
				},
				service: createService(contract),
				udsClient: {
					send: async (endpointPath) => {
						udsCalls.push(endpointPath);
						return 0;
					},
				},
			},
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation);

		// 1. No socket code ran. The injected client is the only way the uds gear
		//    can send, so an empty log here is a complete proof, not a sample.
		assert.deepEqual(udsCalls, []);
		// 2. Nothing for a caller to await, so the two host call sites execute the
		//    same statements they always did.
		assert.equal(delegation.envelopeDelivery, undefined);
		// 3. The envelope landed in the file inbox, byte-identical to the wire form.
		assert.equal(fs.existsSync(inbox), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(inbox, "utf-8")), delegation.envelope.wire);
		assert.equal(fs.existsSync(path.join(store, "uds")), false);
		// 4. Publish strictly precedes the delivery record.
		assert.deepEqual(seenAtDelivery, [true]);

		// 5. The full ordered effect trace, transcribed from the pre-Task-3a
		//    implementation (c365188). Written out in full rather than as a
		//    subset: an extra event, a missing one or a reordering all fail here,
		//    which is what "逐字相同" has to mean for a call sequence.
		assert.deepEqual(
			events(contract).map((event) => event.kind),
			["task-span", "memory-query", "message-delivered"],
		);
		const delivered = events(contract).at(-1);
		assert.equal(delivered?.kind, "message-delivered");
		assert.equal(delivered?.snapshotId, delegation.envelope.snapshotId);
		assert.equal(delivered?.nodeId, nodeIdFor(RUN_ID, CHILD_INDEX));

		delegation.close({ outcome: "completed", summary: "done", usage: null });
		assert.deepEqual(
			events(contract).map((event) => event.kind),
			["task-span", "memory-query", "message-delivered", "message-received", "model-usage", "task-span"],
		);
		// 6. transportBytes stays the quantity this deployment cannot produce —
		//    "N/A", never 0, which is the difference between "no socket gear ran"
		//    and "a socket gear ran and moved nothing".
		assert.equal(aggregateMetering(events(contract)).control.transportBytes, "N/A");
	});

	it("keeps the child's read synchronous, at the first agent turn, and never binds a socket", () => {
		const contract = contractFor("file");
		const boundAt: string[] = [];
		const { handlers, timeline } = registerChild(contract, silentServer(boundAt));

		// Registration binds nothing under the file gear, which is what keeps the
		// default path free of socket code entirely: a transport was available
		// and was never reached.
		assert.deepEqual(boundAt, []);
		assert.deepEqual(timeline, ["register:start", "register:end"]);

		// Written *after* registration: if the read had moved earlier, the inbox
		// would have been empty at the moment it happened and this envelope would
		// go unnoticed instead of refusing the run.
		const inbox = envelopeInboxPath(store, RUN_ID, CHILD_INDEX);
		fs.mkdirSync(path.dirname(inbox), { recursive: true });
		fs.writeFileSync(inbox, "{ not json", "utf-8");

		// Synchronously thrown, in the same tick as the handler call. An async
		// verification would return a rejected promise here and the refusal would
		// depend on whether the host awaits its handlers.
		assert.throws(() => handlers.get("agent_start")?.({}), /SYNAPSE envelope rejected: .*not valid JSON/);
	});

	it("returns undefined from agent_start rather than a promise when there is nothing to await", () => {
		const contract = contractFor("file");
		const { handlers } = registerChild(contract);
		// An absent envelope is the common case; the handler must still be the
		// plain synchronous function it was.
		assert.equal(handlers.get("agent_start")?.({}), undefined);
	});
});

describe("uds gear carries one envelope from parent to child (verify b)", () => {
	it("delivers, verifies against the contract, and meters the bytes that crossed", async () => {
		const contract = contractFor("uds");
		const { boundAt, client, server } = createFakeUdsChannel({ chunkBytes: 1 });
		const endpoint = udsEndpointPath(store, RUN_ID, CHILD_INDEX);

		// The child binds first, and it binds *during registration* — strictly
		// before the parent's send, which is the ordering a lazy bind would lose.
		const { handlers, timeline } = registerChild(contract, server);
		assert.deepEqual(timeline, ["register:start", `bind:${endpoint}`, "register:end"]);
		assert.deepEqual(boundAt, [endpoint], "the receiver must bind at the endpoint the sender will use");

		const log = createLog(contract);
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log, service: createService(contract), udsClient: client },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation);
		assert.ok(delegation.envelopeDelivery, "the uds gear's send is what the caller awaits before prompting");
		await delegation.envelopeDelivery;

		// The child accepts it: absent would mean nothing arrived, a throw would
		// mean it arrived and did not describe this launch.
		await handlers.get("agent_start")?.({});

		// No file was written: the uds gear is the only gear that ran.
		assert.equal(fs.existsSync(envelopeInboxPath(store, RUN_ID, CHILD_INDEX)), false);

		const frameBytes = 4 + Buffer.byteLength(JSON.stringify(delegation.envelope.wire), "utf-8");
		const transport = events(contract).filter((event) => event.kind === "transport-bytes");
		assert.equal(transport.length, 1, "recorded once, on the uds path only");
		assert.equal(transport[0]?.kind === "transport-bytes" ? transport[0].bytes : -1, frameBytes);

		const totals = aggregateMetering(events(contract));
		assert.equal(totals.control.transportBytes, frameBytes);
		// Three columns, never summed (design §4.1): the envelope the application
		// serialised, and the frame that actually crossed, differ by the header
		// and are reported separately.
		assert.equal(totals.control.envelopeBytes, delegation.envelope.envelopeBytes);
		assert.notEqual(totals.control.transportBytes, totals.control.envelopeBytes);
		assert.equal(totals.control.transportBytes, totals.control.envelopeBytes + 4);
	});

	it("refuses an envelope that arrived over the socket but describes another launch", async () => {
		const contract = contractFor("uds");
		const { client, server } = createFakeUdsChannel();
		// The child's own contract differs in namespace, which is exactly what
		// verifyEnvelopeAgainstContract exists to catch — and it must still catch
		// it now that the envelope came off a socket instead of out of a file.
		const foreign = resolveLaunchContract({
			capabilityId: contract.capabilityId,
			corpusSnapshotId: "unset",
			deliveryGear: "uds",
			memoryRefs: [],
			mode: "synapse",
			namespaceId: "f".repeat(16),
			representationId: "unavailable",
			scope: { pathPrefixes: [""], write: true },
			storageRoot: store,
		});
		const { handlers } = registerChild(foreign, server);

		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log: createLog(contract), service: createService(contract), udsClient: client },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation?.envelopeDelivery);
		await delegation.envelopeDelivery;

		await assert.rejects(async () => await handlers.get("agent_start")?.({}), /SYNAPSE envelope rejected: envelope belongs to namespace/);
	});
});

describe("a uds receiver that is not there is a named failure (verify c)", () => {
	it("records a classified error and no byte count at all, never a zero one", async () => {
		const contract = contractFor("uds");
		// Nobody bound this endpoint: the fake refuses the connect exactly as a
		// real ECONNREFUSED would.
		const { client } = createFakeUdsChannel();
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log: createLog(contract), service: createService(contract), udsClient: client },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation?.envelopeDelivery);
		// Degraded, not thrown: the child still runs the task upstream sent.
		await delegation.envelopeDelivery;

		const errors = events(contract).filter((event) => event.kind === "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0]?.kind === "error" ? errors[0].category : "", "persistence");
		assert.match(errors[0]?.kind === "error" ? errors[0].detail : "", /found no peer listening \(ECONNREFUSED\)/);

		assert.deepEqual(events(contract).filter((event) => event.kind === "transport-bytes"), []);
		// The distinction spec §5 turns on: a failed delivery must not read as a
		// successful one that carried nothing.
		assert.equal(aggregateMetering(events(contract)).control.transportBytes, "N/A");
	});

	it("classifies a stalled peer as timeout rather than as a refusal", async () => {
		const contract = contractFor("uds");
		const stalled: UdsClientTransport = {
			send: (endpointPath) => Promise.reject(new Error(`timeout: uds delivery at ${endpointPath} did not complete within 5000ms`)),
		};
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log: createLog(contract), service: createService(contract), udsClient: stalled },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation?.envelopeDelivery);
		await delegation.envelopeDelivery;

		const errors = events(contract).filter((event) => event.kind === "error");
		assert.equal(errors[0]?.kind === "error" ? errors[0].category : "", "timeout");
		assert.deepEqual(events(contract).filter((event) => event.kind === "transport-bytes"), []);
	});

	it("stays a resolved promise even when writing the failure down is what fails", async () => {
		const contract = contractFor("uds");
		const realLog = createLog(contract);
		// A meter that cannot record. Both host call sites `await
		// delegation.envelopeDelivery` inside the try whose catch fails the run, so
		// a rejection here would turn a metering failure into a lost run — exactly
		// what the `file` gear refuses to do (synapse-delegation.ts's header).
		const brokenLog: MeteringLog = {
			path: realLog.path,
			record: (meterIdentity, payload) => {
				if (payload.kind === "error") throw new Error("ENOSPC: no space left on device");
				return realLog.record(meterIdentity, payload);
			},
		};
		const { client } = createFakeUdsChannel(); // nobody bound: the send is refused
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log: brokenLog, service: createService(contract), udsClient: client },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation?.envelopeDelivery);
		await assert.doesNotReject(delegation.envelopeDelivery);
		// And still no byte count: a meter that broke must not leave a zero behind.
		assert.equal(aggregateMetering(events(contract)).control.transportBytes, "N/A");
	});

	it("records no byte count when the transport reports one that cannot be a byte count", async () => {
		const contract = contractFor("uds");
		const lying: UdsClientTransport = {
			// Two guards stand between this and control.transportBytes, and this
			// test pins the outer one: publishEnvelopeViaUds compares the reported
			// count against the frame length, and NaN fails that comparison. The
			// inner guard, verifiedTransportByteCount, is unreachable while the
			// outer one holds — the only count that survives `!==` is the right
			// one — which is why it is proven directly above rather than through
			// a path that would credit it with a catch it did not make.
			send: async () => Number.NaN,
		};
		const delegation = openDelegation({
			budgetBytes: 8192,
			contract,
			deps: { log: createLog(contract), service: createService(contract), udsClient: lying },
			identity: identity(),
			message: "Task: explain the auth flow",
			worktreeRoot: worktree,
		});
		assert.ok(delegation?.envelopeDelivery);
		await delegation.envelopeDelivery;
		const errors = events(contract).filter((event) => event.kind === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0]?.kind === "error" ? errors[0].detail : "", /wrote NaN of \d+ bytes, a short write/);
		assert.deepEqual(events(contract).filter((event) => event.kind === "transport-bytes"), []);
		assert.equal(aggregateMetering(events(contract)).control.transportBytes, "N/A");
	});
});

describe("an absent envelope is still not a failure (verify d)", () => {
	it("runs the child's task when the parent skipped delegation and nothing was ever sent", async () => {
		const contract = contractFor("uds");
		const boundAt: string[] = [];
		const { handlers } = registerChild(contract, silentServer(boundAt));
		assert.deepEqual(boundAt, [udsEndpointPath(store, RUN_ID, CHILD_INDEX)]);

		// No openDelegation at all: this is the shape of a run whose negotiation
		// refused, or whose meter could not be opened.
		await handlers.get("agent_start")?.({});
	});

	it("runs the child's task when the receiver could not even bind", async () => {
		const contract = contractFor("uds");
		const { handlers } = registerChild(contract, { receiveOnce: () => Promise.reject(new Error("bind EACCES")) });
		await handlers.get("agent_start")?.({});
	});

	it("still refuses when something did arrive and was wrong, so absent is not a catch-all", async () => {
		const contract = contractFor("uds");
		const { handlers } = registerChild(contract, {
			async receiveOnce(_endpointPath, onChunk) {
				onChunk(encodeFrame(Buffer.from(JSON.stringify({ not: "an envelope" }))));
			},
		});
		await assert.rejects(async () => await handlers.get("agent_start")?.({}), /SYNAPSE envelope rejected/);
	});

	it("verifies once and stays verified, so a later turn does not wait on a closed endpoint again", async () => {
		const contract = contractFor("uds");
		const boundAt: string[] = [];
		const { handlers } = registerChild(contract, silentServer(boundAt));
		await handlers.get("agent_start")?.({});
		// A second bind would mean the receive was restarted per turn, which under
		// a real socket would fail on an address already in use.
		assert.equal(handlers.get("agent_start")?.({}), undefined);
		assert.equal(boundAt.length, 1);
	});
});

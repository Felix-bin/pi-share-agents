import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCollectorLine, encodeHello, encodeRegister, encodeUnregister, OBSERVATION_MAX_LINE_BYTES, OBSERVATION_PROTOCOL } from "../../src/observation/protocol.ts";

const COUNTERS = { failedOps: 0, readBytes: 0, readHist: [], readNs: 0, readOps: 0, writeBytes: 0, writeHist: [], writeNs: 0, writeOps: 0 };

function snapshotLine(overrides: Record<string, string | number> = {}): string {
	return JSON.stringify({
		collectorInstance: "c1",
		emittedAtMs: 1000,
		processes: [
			{
				attribution: "exclusive",
				categories: { content: COUNTERS, envelope: { ...COUNTERS, readBytes: 512, readHist: [[9, 3]], readNs: 900, readOps: 3 }, memoryIndex: COUNTERS, unclassified: COUNTERS },
				exited: false,
				nodeId: "node-1",
				observedFromMs: 900,
				pid: 42,
				registrationId: "c1-42-77",
				runId: "run-1",
				startTicks: 77,
			},
		],
		protocol: OBSERVATION_PROTOCOL,
		quality: { classifyIncomplete: 0, mapOverflows: 0, unpairedReturns: 0 },
		sequence: 1,
		type: "snapshot",
		...overrides,
	});
}

describe("collector message decoding", () => {
	it("decodes a snapshot and keeps its counters intact", () => {
		const decoded = decodeCollectorLine(snapshotLine());
		assert.equal(decoded.ok, true);
		assert.ok(decoded.ok && decoded.message.type === "snapshot");
		const [process] = decoded.ok && decoded.message.type === "snapshot" ? decoded.message.processes : [];
		assert.equal(process?.categories.envelope.readBytes, 512);
		assert.deepEqual(process?.categories.envelope.readHist, [[9, 3]]);
	});

	it("refuses a message from a protocol version it does not speak", () => {
		const decoded = decodeCollectorLine(snapshotLine({ protocol: "synapse-io/2" }));
		assert.equal(decoded.ok, false);
	});

	it("refuses an unknown field instead of ignoring it", () => {
		const decoded = decodeCollectorLine(snapshotLine({ droppedEvents: 3 }));
		assert.equal(decoded.ok, false);
	});

	it("refuses malformed JSON with a reason rather than throwing", () => {
		const decoded = decodeCollectorLine("{\"type\":\"snapshot\"");
		assert.equal(decoded.ok, false);
		assert.match(decoded.ok ? "" : decoded.reason, /not valid JSON/);
	});

	it("refuses a line past the size limit before parsing it", () => {
		const oversized = `{"padding":"${"x".repeat(OBSERVATION_MAX_LINE_BYTES)}"}`;
		const decoded = decodeCollectorLine(oversized);
		assert.equal(decoded.ok, false);
		assert.match(decoded.ok ? "" : decoded.reason, /exceeds/);
	});

	it("decodes the welcome that states what was and was not watched", () => {
		const decoded = decodeCollectorLine(
			JSON.stringify({
				abiVersion: 1,
				collectorInstance: "c1",
				coverage: ["vfs_read", "vfs_write"],
				excluded: ["mmap", "io_uring"],
				protocol: OBSERVATION_PROTOCOL,
				snapshotIntervalMs: 1000,
				type: "welcome",
			}),
		);
		assert.ok(decoded.ok && decoded.message.type === "welcome" && decoded.message.excluded.includes("mmap"));
	});
});

describe("client message encoding", () => {
	it("emits one newline-terminated flat object per message", () => {
		const hello = encodeHello("0.67.0");
		assert.ok(hello.endsWith("\n"));
		assert.equal(hello.trimEnd().includes("\n"), false);
		const parsed = JSON.parse(hello);
		assert.equal(parsed.protocol, OBSERVATION_PROTOCOL);
	});

	it("carries the process start time so a recycled pid cannot be registered", () => {
		const line = encodeRegister({ nodeId: "node-1", pid: 42, requestId: "r1", runId: "run-1", startTicks: 77, storageRoot: "/srv/synapse" });
		const parsed = JSON.parse(line);
		assert.equal(parsed.startTicks, 77);
		assert.equal(parsed.type, "register");
		// The collector parses these with a small reader, so no value may nest.
		for (const value of Object.values(parsed)) {
			assert.ok(value === null || Array.isArray(value) === false);
			assert.notEqual(Object.prototype.toString.call(value), "[object Object]");
		}
	});

	it("names the registration being released", () => {
		const parsed = JSON.parse(encodeUnregister("u1", "c1-42-77"));
		assert.deepEqual(parsed, { registrationId: "c1-42-77", requestId: "u1", type: "unregister" });
	});
});

import assert from "node:assert/strict";
import * as net from "node:net";
import { afterEach, describe, it } from "node:test";
import { createObservationClient, readProcessStartTicks, type ObservationClient } from "../../src/observation/client.ts";
import { OBSERVATION_PROTOCOL } from "../../src/observation/protocol.ts";

/**
 * A stand-in collector. It speaks the real line protocol over a loopback
 * socket, so the client is exercised against framing, ordering and disconnects
 * rather than against a mock of itself.
 */
type FakeCollector = {
	close: () => Promise<void>;
	connect: () => net.Socket;
	dropAll: () => void;
	instance: string;
	received: string[];
	send: (payload: string) => void;
};

async function startCollector(behaviour: { greet: boolean; instance?: string }): Promise<FakeCollector> {
	const sockets: net.Socket[] = [];
	const received: string[] = [];
	const instance = behaviour.instance ?? "c1";
	const server = net.createServer((socket) => {
		sockets.push(socket);
		let buffer = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				received.push(line);
				const message = JSON.parse(line);
				if (message.type === "hello" && behaviour.greet) {
					socket.write(
						`${JSON.stringify({
							abiVersion: 1,
							collectorInstance: instance,
							coverage: ["vfs_read", "vfs_write"],
							excluded: ["mmap"],
							protocol: OBSERVATION_PROTOCOL,
							snapshotIntervalMs: 1000,
							type: "welcome",
						})}\n`,
					);
				}
				if (message.type === "register" && behaviour.greet) {
					socket.write(
						`${JSON.stringify({
							collectorInstance: instance,
							observedFromMs: 1000,
							registrationId: `${instance}-${message.pid}-77`,
							requestId: message.requestId,
							type: "registered",
						})}\n`,
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = address !== null && Object.prototype.hasOwnProperty.call(address, "port") ? Number(Object(address).port) : 0;

	return {
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
		connect: () => net.connect(port, "127.0.0.1"),
		dropAll: () => {
			for (const socket of sockets) socket.destroy();
		},
		instance,
		received,
		send: (payload: string) => {
			for (const socket of sockets) socket.write(payload);
		},
	};
}

function snapshotLine(instance: string, sequence: number, readBytes: number): string {
	const empty = { failedOps: 0, readBytes: 0, readHist: [], readNs: 0, readOps: 0, writeBytes: 0, writeHist: [], writeNs: 0, writeOps: 0 };
	return `${JSON.stringify({
		collectorInstance: instance,
		emittedAtMs: 5000,
		processes: [
			{
				attribution: "exclusive",
				categories: { content: empty, envelope: { ...empty, readBytes, readHist: [[10, 1]], readNs: 1200, readOps: 1 }, memoryIndex: empty, unclassified: empty },
				exited: false,
				nodeId: "node-1",
				observedFromMs: 1000,
				pid: 4242,
				registrationId: `${instance}-4242-77`,
				runId: "run-1",
				startTicks: 77,
			},
		],
		protocol: OBSERVATION_PROTOCOL,
		quality: { classifyIncomplete: 0, mapOverflows: 0, unpairedReturns: 0 },
		sequence,
		type: "snapshot",
	})}\n`;
}

async function settle(ms = 60): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

let collector: FakeCollector | null = null;
let client: ObservationClient | null = null;

afterEach(async () => {
	client?.close();
	client = null;
	await collector?.close();
	collector = null;
});

describe("collector client", () => {
	it("never opens a socket when the feature is disabled", async () => {
		let attempts = 0;
		client = createObservationClient({
			clientVersion: "test",
			connect: () => {
				attempts++;
				return net.connect(1);
			},
			readStartTicks: () => 77,
			startup: { reason: "disabled", start: false },
		});
		const outcome = await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		assert.equal(attempts, 0, "a disabled feature must not create a descriptor");
		assert.equal(outcome.registered, false);
		assert.equal(client.state().link, "disabled");
	});

	it("registers a process and folds the snapshots that follow", async () => {
		collector = await startCollector({ greet: true });
		client = createObservationClient({ clientVersion: "test", connect: collector.connect, readStartTicks: () => 77, startup: { socketPath: "/unused", start: true } });

		const outcome = await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		assert.equal(outcome.registered, true);

		collector.send(snapshotLine("c1", 1, 4096));
		await settle();
		const state = client.state();
		assert.equal(state.link, "connected");
		assert.equal(state.live.size, 1);

		const registerLine = collector.received.find((line) => line.includes("\"register\""));
		assert.ok(registerLine);
		assert.equal(JSON.parse(registerLine ?? "{}").startTicks, 77, "the start time travels with the pid");
	});

	it("gives up waiting after the handshake budget and lets the task continue", async () => {
		// A collector that accepts the connection but never greets is the worst
		// case: without a budget the caller would wait for it forever.
		collector = await startCollector({ greet: false });
		client = createObservationClient({
			clientVersion: "test",
			connect: collector.connect,
			handshakeBudgetMs: 80,
			readStartTicks: () => 77,
			startup: { socketPath: "/unused", start: true },
		});
		const started = Date.now();
		const outcome = await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		assert.equal(outcome.registered, false);
		assert.match(outcome.registered === false ? outcome.reason : "", /did not answer within 80ms/);
		assert.ok(Date.now() - started < 1000, "the caller must not be held past the budget");
	});

	it("refuses a process whose start time cannot be read rather than guessing", async () => {
		collector = await startCollector({ greet: true });
		client = createObservationClient({ clientVersion: "test", connect: collector.connect, readStartTicks: () => null, startup: { socketPath: "/unused", start: true } });
		const outcome = await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		assert.equal(outcome.registered, false);
		assert.match(outcome.registered === false ? outcome.reason : "", /cannot read the start time/);
	});

	it("keeps the measured bytes and marks a gap when the collector drops the connection", async () => {
		collector = await startCollector({ greet: true });
		client = createObservationClient({ clientVersion: "test", connect: collector.connect, readStartTicks: () => 77, startup: { socketPath: "/unused", start: true } });
		await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		collector.send(snapshotLine("c1", 1, 4096));
		await settle();

		collector.dropAll();
		await settle();
		const state = client.state();
		assert.equal(state.link, "disconnected");
		assert.equal(state.sealed.length, 1, "the last cumulative value survives the disconnect");
		assert.equal(state.gaps.length, 1);
	});

	it("disconnects rather than trusting a collector that speaks a different protocol", async () => {
		collector = await startCollector({ greet: true });
		client = createObservationClient({ clientVersion: "test", connect: collector.connect, readStartTicks: () => 77, startup: { socketPath: "/unused", start: true } });
		await client.register({ nodeId: "node-1", pid: 4242, runId: "run-1", storageRoot: "/srv/synapse" });
		collector.send(`${JSON.stringify({ protocol: "synapse-io/9", type: "snapshot" })}\n`);
		await settle();
		assert.equal(client.state().link, "disconnected");
	});
});

describe("process start time", () => {
	it("parses field 22 even when the command name contains spaces and parentheses", () => {
		const line = "4242 (weird ) name) S 1 4242 4242 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 3 0 987654 12345 6789\n";
		assert.equal(readProcessStartTicks(4242, () => line), 987654);
	});

	it("returns nothing when the process is gone, rather than a plausible number", () => {
		assert.equal(
			readProcessStartTicks(4242, () => {
				throw new Error("ENOENT");
			}),
			null,
		);
	});
});

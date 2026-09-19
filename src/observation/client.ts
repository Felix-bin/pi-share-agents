import * as fs from "node:fs";
import * as net from "node:net";
import { applyDisconnect, applySnapshot, emptyObservationState, type ObservationState } from "./aggregate.ts";
import type { ObservationStartup } from "./config.ts";
import { decodeCollectorLine, encodeHello, encodeRegister, encodeUnregister, OBSERVATION_MAX_LINE_BYTES, type RegisterRequest } from "./protocol.ts";

/**
 * The only part of observation that touches a socket.
 *
 * Its contract to the rest of the system is narrow and absolute: nothing it
 * does can fail a task. A missing collector, a refused connection, a collector
 * that dies mid-run and a collector that speaks a protocol we do not know all
 * end the same way — the in-memory state says the measurement is unavailable or
 * stale, and the caller carries on.
 *
 * Registration is therefore time-boxed rather than awaited. A host that blocked
 * on a handshake would have made an observability feature into a dependency of
 * the work it observes.
 */

/** How long a caller will wait for the collector before getting on with the task. */
export const OBSERVATION_HANDSHAKE_BUDGET_MS = 300;

const RECONNECT_DELAY_MS = 2000;

export type RegisterProcessRequest = {
	nodeId: string;
	pid: number;
	runId: string;
	storageRoot: string;
};

export type RegistrationOutcome =
	| { registered: true; registrationId: string }
	| { reason: string; registered: false };

export type ObservationClient = {
	close: () => void;
	register: (request: RegisterProcessRequest) => Promise<RegistrationOutcome>;
	state: () => ObservationState;
	unregister: (registrationId: string) => void;
};

/**
 * Field 22 of `/proc/<pid>/stat`, the process start time in USER_HZ units.
 *
 * The comm field is parenthesised and may itself contain spaces and
 * parentheses, so parsing restarts after the last `)`. Paired with the pid this
 * is what stops a recycled pid from inheriting another run's measurements.
 */
export function readProcessStartTicks(pid: number, readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf-8")): number | null {
	let raw = "";
	try {
		raw = readFile(`/proc/${pid}/stat`);
	} catch {
		return null;
	}
	const closing = raw.lastIndexOf(")");
	if (closing < 0) return null;
	const fields = raw.slice(closing + 1).trim().split(/\s+/);
	// Fields 3..22 of the original line are fields 0..19 of this remainder.
	const startTicks = fields[19];
	if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
	return Number.parseInt(startTicks, 10);
}

export type ObservationClientOptions = {
	clientVersion: string;
	/** Injected so the socket-level behaviour can be exercised without a collector. */
	connect?: (socketPath: string) => net.Socket;
	handshakeBudgetMs?: number;
	now?: () => number;
	/** Injected in tests, where there is no `/proc` to read a start time from. */
	readStartTicks?: (pid: number) => number | null;
	startup: ObservationStartup;
};

type PendingRegistration = {
	request: RegisterRequest;
	settle: (outcome: RegistrationOutcome) => void;
	settled: boolean;
};

/**
 * A client that never connects, for the disabled and unsupported cases.
 *
 * Returning this rather than a client with a dormant socket is what makes "off
 * means off" checkable: with the feature disabled there is no descriptor, no
 * timer and no reconnect loop in the process at all.
 */
function inertClient(state: ObservationState, reason: string): ObservationClient {
	return {
		close: () => {},
		register: () => Promise.resolve({ reason, registered: false }),
		state: () => state,
		unregister: () => {},
	};
}

export function createObservationClient(options: ObservationClientOptions): ObservationClient {
	const startup = options.startup;
	if (!startup.start) {
		if (startup.reason === "disabled") return inertClient(emptyObservationState("disabled"), "systemObservation.enabled is false");
		return inertClient(emptyObservationState("unsupported", startup.detail), startup.detail);
	}

	const socketPath = startup.socketPath;
	const now = options.now ?? (() => Date.now());
	const budgetMs = options.handshakeBudgetMs ?? OBSERVATION_HANDSHAKE_BUDGET_MS;
	const connect = options.connect ?? ((target: string) => net.connect(target));
	const startTicksOf = options.readStartTicks ?? readProcessStartTicks;

	let state = emptyObservationState("never-connected");
	let socket: net.Socket | null = null;
	let greeted = false;
	let buffer = "";
	let closed = false;
	let nextRequestId = 0;
	const pending = new Map<string, PendingRegistration>();
	const registered = new Map<string, RegisterRequest>();
	let reconnectTimer: NodeJS.Timeout | null = null;

	function write(line: string): void {
		if (socket === null || socket.destroyed) return;
		// Errors surface on the socket's error handler; a failed write must not
		// propagate into whatever agent operation happened to trigger it.
		socket.write(line, () => {});
	}

	function flushPending(): void {
		for (const [requestId, entry] of pending) {
			write(encodeRegister({ ...entry.request, requestId }));
		}
	}

	function handleLine(line: string): void {
		const decoded = decodeCollectorLine(line);
		if (!decoded.ok) {
			// An undecodable line means this collector is not speaking our
			// protocol. Continuing would mean reporting numbers we cannot parse.
			teardown(`collector sent an unreadable message: ${decoded.reason}`);
			return;
		}
		const message = decoded.message;
		if (message.type === "welcome") {
			greeted = true;
			flushPending();
			return;
		}
		if (message.type === "registered") {
			const entry = pending.get(message.requestId);
			if (entry === undefined) return;
			pending.delete(message.requestId);
			registered.set(message.registrationId, entry.request);
			if (!entry.settled) {
				entry.settled = true;
				entry.settle({ registered: true, registrationId: message.registrationId });
			}
			return;
		}
		if (message.type === "error") {
			const entry = pending.get(message.requestId);
			if (entry === undefined) return;
			pending.delete(message.requestId);
			if (!entry.settled) {
				entry.settled = true;
				entry.settle({ reason: `${message.code}: ${message.message}`, registered: false });
			}
			return;
		}
		if (message.type === "snapshot") {
			state = applySnapshot(state, message).state;
		}
	}

	function onData(chunk: Buffer): void {
		buffer += chunk.toString("utf-8");
		if (buffer.length > OBSERVATION_MAX_LINE_BYTES * 2) {
			teardown("collector exceeded the line size limit");
			return;
		}
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim().length > 0) handleLine(line);
			if (socket === null) return;
		}
	}

	function teardown(reason: string): void {
		const active = socket;
		socket = null;
		greeted = false;
		buffer = "";
		if (active !== null) {
			active.removeAllListeners();
			active.destroy();
		}
		state = applyDisconnect(state, now());
		for (const [requestId, entry] of pending) {
			pending.delete(requestId);
			if (!entry.settled) {
				entry.settled = true;
				entry.settle({ reason, registered: false });
			}
		}
		scheduleReconnect();
	}

	function scheduleReconnect(): void {
		if (closed || reconnectTimer !== null) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			open();
		}, RECONNECT_DELAY_MS);
		// An observation reconnect must never be the reason a process stays alive.
		reconnectTimer.unref?.();
	}

	function open(): void {
		if (closed || socket !== null) return;
		let opened: net.Socket;
		try {
			opened = connect(socketPath);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = opened;
		opened.setNoDelay?.(true);
		opened.unref?.();
		opened.on("data", onData);
		opened.on("error", () => teardown("collector connection failed"));
		opened.on("close", () => {
			if (socket === opened) teardown("collector connection closed");
		});
		opened.on("connect", () => write(encodeHello(options.clientVersion)));
		// A socket injected by a test, or a connection that completed before the
		// listener was attached, still needs its greeting.
		if (opened.connecting === false) write(encodeHello(options.clientVersion));

		// Re-registering after a reconnect is what recovers from a collector
		// restart. The new interval starts now, which the view reports as a gap
		// rather than pretending the missing seconds were quiet.
		for (const request of registered.values()) {
			const requestId = `r${++nextRequestId}`;
			pending.set(requestId, { request: { ...request, requestId }, settle: () => {}, settled: true });
		}
		registered.clear();
		if (greeted) flushPending();
	}

	open();

	return {
		close(): void {
			closed = true;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			// Only our own registrations are released. The collector process is
			// the administrator's to start and stop, not this session's.
			for (const registrationId of registered.keys()) {
				write(encodeUnregister(`u${++nextRequestId}`, registrationId));
			}
			registered.clear();
			const active = socket;
			socket = null;
			if (active !== null) {
				active.removeAllListeners();
				active.end();
				active.destroy();
			}
			state = applyDisconnect(state, now());
		},

		register(request: RegisterProcessRequest): Promise<RegistrationOutcome> {
			const startTicks = startTicksOf(request.pid);
			if (startTicks === null) {
				return Promise.resolve({ reason: `cannot read the start time of pid ${request.pid}`, registered: false });
			}
			const requestId = `r${++nextRequestId}`;
			const wire: RegisterRequest = {
				nodeId: request.nodeId,
				pid: request.pid,
				requestId,
				runId: request.runId,
				startTicks,
				storageRoot: request.storageRoot,
			};
			return new Promise<RegistrationOutcome>((resolve) => {
				const entry: PendingRegistration = { request: wire, settle: resolve, settled: false };
				pending.set(requestId, entry);
				if (greeted) write(encodeRegister(wire));

				// The budget bounds the caller's wait, not the registration: a
				// reply that arrives later still takes effect, and the late start
				// shows up as partial coverage instead of as a silent full one.
				const timer = setTimeout(() => {
					if (entry.settled) return;
					entry.settled = true;
					entry.settle = () => {};
					resolve({ reason: `collector did not answer within ${budgetMs}ms`, registered: false });
				}, budgetMs);
				timer.unref?.();
			});
		},

		state: () => state,

		unregister(registrationId: string): void {
			if (!registered.delete(registrationId)) return;
			write(encodeUnregister(`u${++nextRequestId}`, registrationId));
		},
	};
}

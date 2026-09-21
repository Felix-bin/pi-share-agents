import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { CanonicalValue } from "./canonical-json.ts";
import { safeComponent, UNATTRIBUTED, type DeliveredEnvelope } from "./envelope-inbox.ts";
import { createFrameDecoder, encodeFrame } from "./envelope-framing.ts";
import { parseEnvelope, type Envelope } from "./envelope.ts";

/**
 * The `uds` delivery gear for the structured envelope (design §3.1).
 *
 * `envelope-inbox.ts`'s `file` gear writes one JSON file with `fs.*Sync` and
 * is the default; it is untouched by this module, on purpose — verify item
 * (a) is that the default path stays byte-identical, and the only way to
 * prove that is to not touch the code that implements it. This module is the
 * second gear the plan asks for: it puts the same wire form
 * (`envelope.wire`) on an AF_UNIX `SOCK_STREAM` connection, framed by
 * `envelope-framing.ts`'s length-prefixed codec, and it is additive — the
 * `file` gear keeps working exactly as it did before this file existed.
 *
 * Real socket I/O is asynchronous in Node: there is no synchronous
 * counterpart to `fs.readFileSync` for `net.Socket`. So this gear's publish
 * and receive functions return Promises where `envelope-inbox.ts`'s do not.
 * That divergence is deliberate rather than unified behind one signature:
 * making `publishEnvelope` async to share a shape with this module would
 * change the default gear's own behaviour, which is exactly what must not
 * happen.
 *
 * Everything here splits into a pure half and an injectable-I/O half, so the
 * hard-to-get-wrong parts are provable without a socket. `udsEndpointPath`
 * and `classifyUdsSendFailure` touch no filesystem or network and are tested
 * directly. `UdsClientTransport` / `UdsServerTransport` are the seam a caller
 * supplies; `createNodeUdsClientTransport` / `createNodeUdsServerTransport`
 * are the real `node:net` implementation, which this repository's own test
 * environment cannot exercise — binding an AF_UNIX path here fails with
 * `EACCES`, confirmed empirically against this sandbox rather than assumed —
 * so tests inject an in-memory fake pair that stands in for a real socket
 * file instead of skipping the behaviour the seam exists to prove.
 *
 * The seam is drawn on the byte-stream side of `envelope-framing.ts`'s
 * decoder, not on the message side: `UdsServerTransport.receiveOnce` hands
 * `receiveDeliveredEnvelopeViaUds` each chunk of bytes as it arrives, and that
 * function drives `createFrameDecoder` incrementally, exactly the way Task 1
 * proved the decoder works. Handing the decoder one fully-accumulated buffer
 * instead — the first version of this module did — would defeat two things
 * at once: `SYNAPSE_MAX_FRAME_BYTES` exists so a hostile or corrupt length
 * prefix is rejected the moment its header is read, not after every byte of
 * an unbounded body has already been buffered; and the decoder's own
 * reassembly-across-arbitrary-splits guarantee becomes untestable through
 * this module if it only ever sees one pre-joined buffer. Chunk-at-a-time
 * delivery, with `onChunk` able to signal `"stop"` as soon as one frame
 * completes, keeps both properties reachable from a fake — no real socket
 * required — and lets a receive finish as soon as its one frame is in, rather
 * than waiting on the peer's `FIN`.
 *
 * Endpoint placement: `<storageRoot>/uds/<run>/<receiver>.sock`, a new
 * top-level entry alongside `envelopes/`, `objects/` and `memory/` — not
 * nested inside `envelopes/` next to the `file` gear's `.json`, even though
 * that was the first design tried here. Nesting under `envelopes/` would
 * have let `trace-classify.ts`'s `CATEGORY_BY_ROOT_ENTRY` attribute this
 * traffic to the `envelope` category instead of `unclassified` — but that
 * benefit turned out to be theoretical: `CATEGORY_BY_ROOT_ENTRY` classifies
 * by `openat`/`renameat2` paths, and `bind`/`connect` never produce those
 * (spec §4.1), so nothing on this path is attributed either way until S3
 * extends its wire protocol to observe socket syscalls at all. What is not
 * theoretical is the sun_path budget below: counting the leading separator
 * consistently, `/envelopes` is 10 bytes and `/uds` is 4, a 6-byte saving on
 * the one segment this module controls. `runId` is a `randomUUID()` (36
 * bytes, hyphens included, `safeComponent` leaves it untouched) — measured
 * against this repo's own layout (`resolveStorageRoot` in `namespace.ts`,
 * `<agentDir>/synapse/<16-hex namespace id>`, `agentDir` typically
 * `~/.pi/agent`), the fixed cost below `storageRoot` is 48 bytes
 * (`/uds/` + a 36-byte runId + `/` + a 1-byte childIndex + `.sock`), so
 * `storageRoot` itself must stay at or under 59 bytes for the path to fit —
 * `/home/<user>/.pi/agent/synapse/<16-hex>` works through an 18-character
 * `<user>` and overflows at 19 (see the task report for the worked table).
 * That 6-byte saving is genuinely load-bearing at this margin, not padding:
 * it is the difference between an 18-character username fitting and not.
 * `trace-classify.ts`'s own header already documents a new top-level entry
 * landing in `unclassified` as visible-but-expected, not a bug this module
 * needs to work around.
 *
 * `sockaddr_un.sun_path` is a fixed 108-byte kernel buffer, and one of those
 * bytes is the NUL terminator the kernel itself appends, so the path text has
 * 107 usable bytes, not 108. `udsEndpointPath` enforces that budget itself
 * and names whichever input — `storageRoot`, `runId` or `childIndex` —
 * contributed the most bytes to an overlong path, rather than constructing a
 * path the kernel would either silently truncate or refuse with a bare
 * `ENAMETOOLONG`.
 *
 * Connection lifetime: the receiver is the AF_UNIX server (it binds, accepts
 * one connection, reads exactly one frame, and closes); the sender is the
 * client (it connects, writes exactly one frame, half-closes, and closes).
 * This mirrors the `file` gear's one-envelope-per-node model, and it is what
 * makes "the peer is not there" a synchronous `connect()` failure on the
 * sender's side — a named, classified failure (spec §5) — rather than a
 * delivery that hangs or, worse, is recorded as having succeeded with
 * nothing actually sent.
 *
 * Not wired into `delegation.ts` or `subagent-prompt-runtime.ts` by this
 * module. `LaunchContract` carries no delivery gear today, and the child-side
 * read happens synchronously at the first agent turn
 * (`subagent-prompt-runtime.ts`'s `verifyDeliveredEnvelope`), which cannot
 * await a socket without changing that call site's own signature — a change
 * outside this task's stated scope (`envelope-inbox.ts` + `config.ts`). Both
 * call sites keep using the unmodified `file`-only functions.
 */

/** A new top-level storage-root entry, deliberately shorter than `envelopes/` — see the module header. */
const UDS_DIR = "uds";
const UDS_SUFFIX = ".sock";

/** `sockaddr_un.sun_path`'s fixed size on Linux (and the comparable buffer on other POSIX platforms). */
export const SYNAPSE_SUN_PATH_BYTES = 108;

/** One byte of `SYNAPSE_SUN_PATH_BYTES` is the kernel's own NUL terminator, not path text. */
export const SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES = SYNAPSE_SUN_PATH_BYTES - 1;

type UdsPathContribution = { bytes: number; name: string };

/** Names whichever input contributed the most bytes, so the refusal points at one thing to shorten. */
function worstContributor(storageRoot: string, runComponent: string, receiverComponent: string): UdsPathContribution {
	const contributions: UdsPathContribution[] = [
		{ bytes: Buffer.byteLength(storageRoot, "utf-8"), name: "storageRoot" },
		{ bytes: Buffer.byteLength(runComponent, "utf-8"), name: "runId" },
		{ bytes: Buffer.byteLength(receiverComponent, "utf-8"), name: "childIndex" },
	];
	return contributions.reduce((worst, candidate) => (candidate.bytes > worst.bytes ? candidate : worst));
}

/**
 * The AF_UNIX endpoint a node's envelope is delivered to under the `uds`
 * gear. Pure: no filesystem access, so a caller can check a path fits its
 * budget before ever attempting to bind or connect to it.
 *
 * Throws `uds-endpoint-path-too-long` rather than handing back a path that
 * overflows `sockaddr_un.sun_path` — a truncated path handed to the kernel
 * would bind or connect to a different, wrong address silently, and a bare
 * `ENAMETOOLONG` from the kernel does not say which input needs to shrink.
 */
export function udsEndpointPath(storageRoot: string, runId: string, childIndex: number | undefined): string {
	const receiver = childIndex === undefined ? UNATTRIBUTED : String(childIndex);
	const runComponent = safeComponent(runId);
	const receiverComponent = safeComponent(receiver);
	const candidate = path.join(storageRoot, UDS_DIR, runComponent, `${receiverComponent}${UDS_SUFFIX}`);
	const totalBytes = Buffer.byteLength(candidate, "utf-8");
	if (totalBytes > SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES) {
		const worst = worstContributor(storageRoot, runComponent, receiverComponent);
		throw new Error(
			`uds-endpoint-path-too-long: ${worst.name} contributes ${worst.bytes} of the ${totalBytes} bytes in "${candidate}", which exceeds the ${SYNAPSE_MAX_UDS_ENDPOINT_PATH_BYTES}-byte sun_path budget (${SYNAPSE_SUN_PATH_BYTES} bytes minus the kernel's NUL terminator); shorten ${worst.name} to fit`,
		);
	}
	return candidate;
}

function errorCodeOf(cause: unknown): string | undefined {
	// SAFETY: the `"code" in cause` check just above confirms this Error carries
	// the errno-style `code` field Node attaches to socket/fs failures.
	return cause instanceof Error && "code" in cause ? String((cause as NodeJS.ErrnoException).code) : undefined;
}

/**
 * Turns a raw transport failure into the named, classified refusal spec §5
 * requires: a socket delivery that fails must never be recorded as
 * "delivered but empty". Pure — it inspects only the error it is given, so
 * every branch is testable with a synthetic cause, no socket required.
 *
 * A cause already named by `envelope-framing.ts` (`frame-too-large` from
 * `encodeFrame`) is passed through unchanged rather than re-wrapped: it is
 * already precise, and `errors.ts` classifies that exact prefix to
 * `configuration` directly. Everything else is a genuine transport failure,
 * which `classifySynapseError` (errors.ts) routes via the `persistence:`
 * prefix to the `persistence` category — the same bucket `maxObjectBytes
 * exceeded` and `disk full` already use: in all these cases the sink could
 * not accept what was handed to it.
 */
export function classifyUdsSendFailure(cause: unknown, endpointPath: string): Error {
	if (cause instanceof Error && cause.message.startsWith("frame-too-large")) {
		return cause;
	}
	const code = errorCodeOf(cause);
	const detail = cause instanceof Error ? cause.message : String(cause);
	if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK") {
		// Nobody is listening at this endpoint (yet, or ever). Unlike the `file`
		// gear's "absent inbox is not a failure", a `uds` delivery has no later
		// reader who might still find the bytes — the connection attempt itself
		// is the only chance this envelope gets, so this is a real failure.
		return new Error(`persistence: uds delivery to ${endpointPath} found no peer listening (${code}): ${detail}`);
	}
	return new Error(`persistence: uds delivery to ${endpointPath} failed: ${detail}`);
}

export type UdsClientTransport = {
	/** Connects to `endpointPath`, writes `frame` in full, then closes. Resolves with the bytes actually written. */
	send: (endpointPath: string, frame: Buffer) => Promise<number>;
};

export type UdsServerTransport = {
	/**
	 * Binds `endpointPath`, accepts exactly one connection, and delivers each
	 * chunk of bytes to `onChunk` as it arrives — not accumulated first — so a
	 * caller driving `envelope-framing.ts`'s incremental decoder can reject an
	 * oversized or corrupt frame the moment its header is read, and can stop
	 * reading before the peer closes by returning `"stop"`. Resolves once
	 * `onChunk` returns `"stop"`, or once the peer's stream ends on its own;
	 * rejects on a transport-level failure (before any chunk decided the
	 * outcome).
	 */
	receiveOnce: (endpointPath: string, onChunk: (chunk: Buffer) => "continue" | "stop") => Promise<void>;
};

/** The real transport: a `node:net` AF_UNIX client. Not exercised by this repo's own tests — see the module header. */
export function createNodeUdsClientTransport(): UdsClientTransport {
	return {
		send(endpointPath, frame) {
			return new Promise((resolve, reject) => {
				const socket = net.createConnection({ path: endpointPath });
				socket.once("error", reject);
				socket.once("connect", () => {
					socket.end(frame, () => resolve(frame.byteLength));
				});
			});
		},
	};
}

/** The real transport: a `node:net` AF_UNIX server. Not exercised by this repo's own tests — see the module header. */
export function createNodeUdsServerTransport(): UdsServerTransport {
	return {
		receiveOnce(endpointPath, onChunk) {
			return new Promise((resolve, reject) => {
				fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
				// A socket file left behind by a process that never cleaned up after
				// itself must not make this bind look like the address is in use.
				fs.rmSync(endpointPath, { force: true });
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					server.close(() => fs.rmSync(endpointPath, { force: true }));
					if (error === undefined) resolve();
					else reject(error);
				};
				const server = net.createServer((socket) => {
					socket.on("data", (chunk: Buffer) => {
						if (settled) return;
						// Handed straight to the caller's decoder as it arrives, not
						// accumulated here — see the module header on why.
						if (onChunk(chunk) === "stop") {
							socket.destroy();
							finish();
						}
					});
					socket.once("end", () => finish());
					socket.once("error", finish);
				});
				server.once("error", finish);
				server.listen(endpointPath);
			});
		},
	};
}

export type UdsPublishResult = {
	/** Bytes actually written to the socket, frame header included. `metering.ts`'s `recordTransportBytes` turns this into the metered `control.transportBytes`; this module only exposes it. */
	bytesWritten: number;
};

/**
 * Publishes one envelope to `endpointPath` over AF_UNIX. Encodes exactly the
 * same wire bytes `envelope.envelopeBytes` was measured from
 * (`JSON.stringify(envelope.wire)`), so the frame body and the accounted
 * envelope size can never silently diverge.
 *
 * Both `encodeFrame` (which can reject an oversized envelope with
 * `frame-too-large`) and the transport write sit inside the classified
 * region: either failure reaches the caller as a named, classified error
 * rather than an unclassified exception. A transport that resolves having
 * written fewer bytes than the frame contains is a short write — the partial
 * form of the "delivered but empty" outcome spec §5 forbids — so that is
 * checked and rejected explicitly rather than trusted; `metering.ts`'s
 * `recordTransportBytes` turns `bytesWritten` into the metered
 * `transportBytes`, and an unverified count here would become an unverified
 * meter there.
 */
export async function publishEnvelopeViaUds(
	endpointPath: string,
	envelope: Envelope,
	transport: UdsClientTransport = createNodeUdsClientTransport(),
): Promise<UdsPublishResult> {
	let frame: Buffer;
	let bytesWritten: number;
	try {
		frame = encodeFrame(Buffer.from(JSON.stringify(envelope.wire), "utf-8"));
		bytesWritten = await transport.send(endpointPath, frame);
	} catch (cause) {
		throw classifyUdsSendFailure(cause, endpointPath);
	}
	if (bytesWritten !== frame.byteLength) {
		throw new Error(`persistence: uds delivery to ${endpointPath} wrote ${bytesWritten} of ${frame.byteLength} bytes, a short write`);
	}
	return { bytesWritten };
}

/**
 * Receives one envelope from `endpointPath` over AF_UNIX and parses it the
 * same way `readDeliveredEnvelope` parses a file: decode the frame, parse the
 * JSON, validate against the envelope schema. Any failure along that chain —
 * transport, framing, JSON, or schema — comes back as `status: "rejected"`
 * rather than a thrown exception, mirroring `readDeliveredEnvelope`'s shape
 * so a caller that already handles that union does not need a second one.
 *
 * The frame decoder is fed one chunk at a time, as `UdsServerTransport`
 * delivers them, rather than from one buffer accumulated after the
 * connection closes — see the module header. `onChunk` decides the outcome
 * (`result`) and tells the transport to stop as soon as it can: the instant a
 * declared length is too large (rejected before any body byte is read), the
 * instant one full frame is decoded, or the instant more than one frame
 * appears in a single delivery (a well-behaved sender writes exactly one).
 * If the transport instead ends the stream on its own without `onChunk` ever
 * deciding — nothing arrived, or what arrived stopped short of a full frame
 * — `decoder.end()` is what surfaces that as `frame-truncated`.
 *
 * There is no `"absent"` outcome here, unlike the file gear. Absence for
 * `file` means "the parent never wrote a file, which is a normal skip"; a
 * `uds` receive has no equivalent passive state to observe — it either reads
 * a connection or its transport rejects — so every non-`"ready"` outcome is
 * reported as a failure.
 */
export async function receiveDeliveredEnvelopeViaUds(
	endpointPath: string,
	transport: UdsServerTransport = createNodeUdsServerTransport(),
): Promise<DeliveredEnvelope> {
	const decoder = createFrameDecoder();
	let result: DeliveredEnvelope | null = null;

	const onChunk = (chunk: Buffer): "continue" | "stop" => {
		let frames: Buffer[];
		try {
			frames = decoder.push(chunk);
		} catch (error) {
			result = { reason: error instanceof Error ? error.message : String(error), status: "rejected" };
			return "stop";
		}
		if (frames.length === 0) return "continue";
		if (frames.length > 1) {
			result = { reason: `envelope at ${endpointPath} expected exactly one frame, got ${frames.length}`, status: "rejected" };
			return "stop";
		}
		let parsed: CanonicalValue;
		try {
			// SAFETY: frames.length === 1 was just checked, so frames[0] is defined.
			parsed = JSON.parse((frames[0] as Buffer).toString("utf-8"));
		} catch {
			result = { reason: `envelope at ${endpointPath} is not valid JSON`, status: "rejected" };
			return "stop";
		}
		try {
			result = { status: "ready", wire: parseEnvelope(parsed) };
		} catch (error) {
			result = { reason: error instanceof Error ? error.message : String(error), status: "rejected" };
		}
		return "stop";
	};

	try {
		await transport.receiveOnce(endpointPath, onChunk);
	} catch (cause) {
		// A transport-level failure while a chunk had already decided the
		// outcome is still that outcome: the decision was made from bytes that
		// really arrived, and a teardown error afterward does not undo it.
		if (result !== null) return result;
		return { reason: `envelope at ${endpointPath} could not be received: ${cause instanceof Error ? cause.message : String(cause)}`, status: "rejected" };
	}

	if (result !== null) return result;

	// The connection ended on its own — onChunk never saw a complete frame.
	try {
		decoder.end();
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error), status: "rejected" };
	}
	return { reason: `envelope at ${endpointPath} closed before a full frame was received`, status: "rejected" };
}

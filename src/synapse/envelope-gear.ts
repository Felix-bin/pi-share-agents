import type { SynapseDeliveryGear } from "./config.ts";
import { envelopeInboxPath, type DeliveredEnvelope } from "./envelope-inbox.ts";
import { createNodeUdsServerTransport, receiveDeliveredEnvelopeViaUds, udsEndpointPath, type UdsServerTransport } from "./envelope-uds.ts";

/**
 * Which gear carries an envelope, and where.
 *
 * Tasks 1 to 3 built a framing codec, an AF_UNIX gear and a `transportBytes`
 * counter, and left `config.deliveryGear` mapping to nothing: the gear existed
 * and no code walked it, so `transportBytes` was structurally incapable of
 * being anything but `"N/A"` and the design's §4.1 reconciliation could never
 * happen. This module is that map.
 *
 * It is deliberately two halves. `selectEnvelopeRoute` is pure — it turns a
 * contract's gear into an address and nothing else, no filesystem, no socket —
 * so "which gear, addressed how" is decided by a function a test can call in
 * one line. Everything effectful is a separate call the caller makes with the
 * route in hand, against an injectable transport. The sandbox this repository
 * is developed in cannot bind an AF_UNIX path at all (`EACCES`), so anything
 * that must be proven here has to be reachable through that seam.
 *
 * The `file` gear's own functions are not re-exported or wrapped. A caller on
 * the `file` route calls `publishEnvelope` / `readDeliveredEnvelope` directly,
 * exactly as it did before this module existed, because the default path's
 * call sequence has to stay what it was — and the surest way to keep a
 * sequence unchanged is to leave the code that produces it alone.
 */

export type EnvelopeRoute = {
	/** The inbox file for `file`, the socket endpoint for `uds`. */
	address: string;
	gear: SynapseDeliveryGear;
};

export type SelectEnvelopeRouteInput = {
	childIndex: number | undefined;
	deliveryGear: SynapseDeliveryGear;
	runId: string;
	storageRoot: string;
};

/**
 * The gear this delegation uses and the address both sides must agree on.
 *
 * Pure, and total except for the one refusal `udsEndpointPath` owns: an
 * endpoint over the kernel's `sun_path` budget throws
 * `uds-endpoint-path-too-long` here rather than at bind time, where it would
 * arrive as a bare `ENAMETOOLONG` naming nothing.
 */
export function selectEnvelopeRoute(input: SelectEnvelopeRouteInput): EnvelopeRoute {
	if (input.deliveryGear === "uds") {
		return { address: udsEndpointPath(input.storageRoot, input.runId, input.childIndex), gear: "uds" };
	}
	return { address: envelopeInboxPath(input.storageRoot, input.runId, input.childIndex), gear: "file" };
}

/**
 * Checks a transport's self-reported byte count before it becomes a metered
 * quantity.
 *
 * `metering.ts` accepts whatever number it is handed, matching the
 * permissiveness of every other counter in that file, and this is the one
 * place where the number does not come from our own arithmetic: it is what a
 * socket write reported. A negative, fractional or `NaN` count would flow
 * straight into `control.transportBytes` and quietly poison the §4.1
 * reconciliation, whose entire value is that the application's count and the
 * kernel's count can be compared. So the check lives at the call site, pure
 * and separate from the recording, rather than loosening a shared module.
 *
 * Classified as `integrity` rather than `persistence`: the bytes may well have
 * been written, what failed is our ability to say how many.
 *
 * It is the second of two guards, and today the outer one subsumes it:
 * `publishEnvelopeViaUds` already rejects any count that is not exactly the
 * frame length, and the only number that survives a `!==` against a real
 * length is a real length. That makes this unreachable through the current
 * call path — deliberately kept anyway, because it is the guard that still
 * holds if the short-write check is ever relaxed, or if a second gear reports
 * bytes from somewhere other than a verified frame write. Its tests exercise
 * it directly rather than through a path where the other check would take the
 * credit.
 */
export function verifiedTransportByteCount(bytesWritten: number, endpointPath: string): number {
	if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0) {
		throw new Error(`integrity: uds delivery to ${endpointPath} reported ${bytesWritten} bytes written, which is not a byte count`);
	}
	return bytesWritten;
}

export type UdsReceiveOutcome = {
	delivered: DeliveredEnvelope;
	/** Why nothing arrived, when the outcome was downgraded to `absent`; null otherwise. */
	silentReason: string | null;
};

/**
 * Starts the receiver for the `uds` route and reports what turned up.
 *
 * **Call this as early as the receiving process can.** The underlying
 * transport binds while `receiveOnce` runs, so the endpoint is addressable
 * from the moment this function is called; bind lazily — at the first agent
 * turn, say — and the parent will already have tried to connect, and the
 * envelope is simply gone.
 *
 * The one thing this adds over `receiveDeliveredEnvelopeViaUds` is the
 * distinction that keeps the file gear's oldest rule alive under a socket:
 * **an absent envelope is not a failure.** The parent skips delegation
 * whenever negotiation refuses it or the meter cannot be opened, and the child
 * must then run exactly the task upstream would have sent. Under `file` that
 * case is a missing file; under `uds` it is a receive that ends having seen no
 * bytes at all — nobody ever connected, or the deadline expired first. Those
 * become `absent`.
 *
 * A receive that saw *some* bytes and still failed is the opposite fact: an
 * envelope that is present and wrong, which stops the run. Counting the bytes
 * is what separates the two, and it is why this wraps the transport rather
 * than reading `receiveDeliveredEnvelopeViaUds`'s reason string and guessing.
 */
export async function receiveEnvelopeViaUdsRoute(
	endpointPath: string,
	transport: UdsServerTransport = createNodeUdsServerTransport(),
): Promise<UdsReceiveOutcome> {
	let bytesSeen = 0;
	const counted: UdsServerTransport = {
		receiveOnce: (address, onChunk) =>
			transport.receiveOnce(address, (chunk) => {
				bytesSeen += chunk.byteLength;
				return onChunk(chunk);
			}),
	};
	// Invoked, not merely scheduled, before this function's first suspension:
	// the bind is complete by the time the caller holds the returned promise.
	const delivered = await receiveDeliveredEnvelopeViaUds(endpointPath, counted);
	if (delivered.status === "rejected" && bytesSeen === 0) {
		return { delivered: { status: "absent" }, silentReason: delivered.reason };
	}
	return { delivered, silentReason: null };
}

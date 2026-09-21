/**
 * Length-prefixed message framing for envelope delivery over AF_UNIX.
 *
 * Node 24 has no `SOCK_SEQPACKET`, so envelope delivery (design §3.1) rides
 * `SOCK_STREAM`, which delivers a byte stream with no message boundaries of
 * its own. This module puts the boundaries back: `encodeFrame` prepends a
 * 4-byte big-endian length to a body, and `createFrameDecoder` reassembles
 * bodies from bytes handed to it in whatever pieces the socket happens to
 * deliver them — one chunk, half a header, three frames at once, anything.
 *
 * Every function here is pure: no `node:fs`, no `node:net`, nothing that
 * touches a real socket. Task 2 wires this codec to an actual AF_UNIX
 * connection; keeping the codec itself I/O-free is what makes the hard part —
 * exhaustive testing over every possible split point of a byte stream —
 * provable on Windows CI, where a real AF_UNIX socket is not available.
 *
 * `SYNAPSE_MAX_FRAME_BYTES` bounds the declared length in an incoming header,
 * not legitimate traffic: an envelope is a handful of handles plus task text,
 * nowhere near this ceiling. The ceiling exists so a corrupt or hostile
 * length prefix is rejected the moment it is read, instead of being taken as
 * a license to keep appending bytes while waiting for a body that may never
 * arrive.
 *
 * A decoder that rejects an oversized prefix is left unusable: the byte
 * stream is corrupt at a point this module cannot safely resynchronise past
 * (there is no way to know where the next real frame would start), so every
 * later call reports the same failure rather than guessing.
 */

const LENGTH_PREFIX_BYTES = 4;

/**
 * Matches `SYNAPSE_DEFAULT_MAX_OBJECT_BYTES` in content-store.ts. Envelopes
 * carry references, not bodies, so they never approach this size; it exists
 * only to bound a corrupt or hostile length prefix.
 */
export const SYNAPSE_MAX_FRAME_BYTES = 1024 * 1024;

function frameTooLargeError(declaredLength: number): Error {
	return new Error(`frame-too-large: length prefix declares ${declaredLength} bytes, exceeding the ${SYNAPSE_MAX_FRAME_BYTES}-byte limit`);
}

/** Prepends a 4-byte big-endian length prefix to `body`. */
export function encodeFrame(body: Uint8Array): Buffer {
	if (body.byteLength > SYNAPSE_MAX_FRAME_BYTES) {
		throw frameTooLargeError(body.byteLength);
	}
	const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
	header.writeUInt32BE(body.byteLength, 0);
	return Buffer.concat([header, Buffer.from(body)]);
}

export type FrameDecoder = {
	/**
	 * Feeds one chunk of bytes, however it happened to be split by the
	 * transport, and returns every frame body completed by this call (zero,
	 * one, or many). Buffers the remainder for the next call.
	 */
	push: (chunk: Uint8Array) => Buffer[];
	/**
	 * Signals that the underlying stream has ended. Throws if bytes remain
	 * buffered for a frame that never completed, because a truncated frame is
	 * lost data, not a short frame to hand back silently.
	 */
	end: () => void;
};

/** Creates a decoder holding no state beyond what is buffered across calls. */
export function createFrameDecoder(): FrameDecoder {
	let buffered = Buffer.alloc(0);
	let failure: Error | undefined;

	function fail(error: Error): never {
		// Once framing is known to be desynchronised, every later call must see
		// the same failure. Continuing to interpret `buffered` after this point
		// would be reading bytes at an offset this module can no longer trust.
		failure = error;
		throw error;
	}

	return {
		push(chunk: Uint8Array): Buffer[] {
			if (failure) throw failure;
			buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, Buffer.from(chunk)]);
			const frames: Buffer[] = [];
			for (;;) {
				if (buffered.length < LENGTH_PREFIX_BYTES) break;
				const declaredLength = buffered.readUInt32BE(0);
				// Reject as soon as the header itself is readable, before waiting
				// for (or allocating anything sized by) the body it claims to have.
				if (declaredLength > SYNAPSE_MAX_FRAME_BYTES) fail(frameTooLargeError(declaredLength));
				const frameEnd = LENGTH_PREFIX_BYTES + declaredLength;
				if (buffered.length < frameEnd) break;
				frames.push(Buffer.from(buffered.subarray(LENGTH_PREFIX_BYTES, frameEnd)));
				buffered = buffered.subarray(frameEnd);
			}
			return frames;
		},
		end(): void {
			if (failure) throw failure;
			if (buffered.length > 0) {
				fail(new Error(`frame-truncated: stream ended with ${buffered.length} buffered byte(s) short of a complete frame`));
			}
		},
	};
}

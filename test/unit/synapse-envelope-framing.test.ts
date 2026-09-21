import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFrameDecoder, encodeFrame, SYNAPSE_MAX_FRAME_BYTES } from "../../src/synapse/envelope-framing.ts";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function assertFramesEqual(actual: Buffer[], expected: Uint8Array[]): void {
	assert.equal(actual.length, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.equal(Buffer.compare(actual[i] ?? Buffer.alloc(0), Buffer.from(expected[i] ?? new Uint8Array(0))), 0, `frame ${i} differs`);
	}
}

// Four bodies chosen to exercise an empty frame, a one-byte frame, a plain
// ASCII frame, and a multi-byte UTF-8 frame back to back in one stream.
const SAMPLE_BODIES: Uint8Array[] = [bytes(""), bytes("a"), bytes("hello world"), bytes("多字节内容测试 — 混合 ASCII 与中文")];

describe("synapse envelope framing", () => {
	describe("encodeFrame / createFrameDecoder round trip", () => {
		it("reproduces the identical frame sequence for every possible split of the encoded stream into two chunks", () => {
			const fullStream = Buffer.concat(SAMPLE_BODIES.map((body) => encodeFrame(body)));
			// Exhaustive, not sampled: every cut point from 0 (all bytes in the
			// second chunk) through the full length (all bytes in the first
			// chunk) must reproduce the same frame sequence, including the cuts
			// that land inside one of the 4-byte length headers.
			for (let cut = 0; cut <= fullStream.length; cut++) {
				const decoder = createFrameDecoder();
				const first = decoder.push(fullStream.subarray(0, cut));
				const second = decoder.push(fullStream.subarray(cut));
				decoder.end();
				assertFramesEqual([...first, ...second], SAMPLE_BODIES);
			}
		});

		it("reproduces the identical frame sequence when fed one byte at a time", () => {
			const fullStream = Buffer.concat(SAMPLE_BODIES.map((body) => encodeFrame(body)));
			const decoder = createFrameDecoder();
			const frames: Buffer[] = [];
			for (let i = 0; i < fullStream.length; i++) {
				frames.push(...decoder.push(fullStream.subarray(i, i + 1)));
			}
			decoder.end();
			assertFramesEqual(frames, SAMPLE_BODIES);
		});
	});

	describe("oversized length prefix", () => {
		function headerDeclaring(declaredLength: number): Buffer {
			const header = Buffer.alloc(4);
			header.writeUInt32BE(declaredLength, 0);
			return header;
		}

		it("rejects a declared length one byte over the limit as soon as the header is read, without ever seeing a body", () => {
			const decoder = createFrameDecoder();
			// Only the 4-byte header is pushed. No body bytes are ever supplied,
			// so a throw here can only be explained by the decoder rejecting the
			// length prefix itself, before it could consume (or wait for) a body.
			assert.throws(() => decoder.push(headerDeclaring(SYNAPSE_MAX_FRAME_BYTES + 1)), /frame-too-large/);
		});

		it("rejects a hostile 4 GiB-scale length prefix immediately, proving no buffer of that size is allocated", () => {
			const decoder = createFrameDecoder();
			// If the decoder tried to allocate or accumulate 0xFFFFFFFF bytes
			// before rejecting, this call would hang or crash instead of
			// returning synchronously with the framing error asserted below.
			assert.throws(() => decoder.push(headerDeclaring(0xffffffff)), /frame-too-large/);
		});

		it("keeps reporting the same failure on every later call once desynchronised", () => {
			const decoder = createFrameDecoder();
			assert.throws(() => decoder.push(headerDeclaring(SYNAPSE_MAX_FRAME_BYTES + 1)), /frame-too-large/);
			assert.throws(() => decoder.push(bytes("more")), /frame-too-large/);
			assert.throws(() => decoder.end(), /frame-too-large/);
		});
	});

	describe("truncated stream", () => {
		it("errors when the stream ends mid-body instead of returning a short frame", () => {
			const decoder = createFrameDecoder();
			const stream = encodeFrame(bytes("hello"));
			const frames = decoder.push(stream.subarray(0, stream.length - 2));
			assert.equal(frames.length, 0);
			assert.throws(() => decoder.end(), /frame-truncated/);
		});

		it("errors when the stream ends mid-header", () => {
			const decoder = createFrameDecoder();
			assert.deepEqual(decoder.push(Buffer.from([0, 0])), []);
			assert.throws(() => decoder.end(), /frame-truncated/);
		});

		it("does not error when the stream ends exactly on a frame boundary", () => {
			const decoder = createFrameDecoder();
			decoder.push(encodeFrame(bytes("clean")));
			decoder.end();
		});
	});

	describe("round trip at the size extremes", () => {
		it("round-trips a zero-length frame", () => {
			const decoder = createFrameDecoder();
			const frames = decoder.push(encodeFrame(bytes("")));
			decoder.end();
			assertFramesEqual(frames, [bytes("")]);
		});

		it("round-trips a frame exactly at SYNAPSE_MAX_FRAME_BYTES", () => {
			const body = Buffer.alloc(SYNAPSE_MAX_FRAME_BYTES, 9);
			const decoder = createFrameDecoder();
			const frames = decoder.push(encodeFrame(body));
			decoder.end();
			assertFramesEqual(frames, [body]);
		});

		it("rejects encoding a body larger than the limit", () => {
			const oversized = Buffer.alloc(SYNAPSE_MAX_FRAME_BYTES + 1);
			assert.throws(() => encodeFrame(oversized), /frame-too-large/);
		});
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approximateQuantileNs, histogramCount, mergeHistograms, readLatency, writeLatency } from "../../src/observation/histogram.ts";
import type { ObservationCounters } from "../../src/observation/protocol.ts";

describe("log2 latency histograms", () => {
	it("reports no percentile at all when nothing was sampled", () => {
		assert.equal(approximateQuantileNs([], 0.95), null);
		assert.equal(histogramCount([]), 0);
	});

	it("returns the upper bound of the bucket holding the quantile", () => {
		// 100 samples in bucket 10 (1–2µs), 5 in bucket 20 (1–2ms).
		const buckets: [number, number][] = [
			[10, 100],
			[20, 5],
		];
		// The 100th of 105 samples is still inside bucket 10.
		assert.equal(approximateQuantileNs(buckets, 0.95), 2 ** 11);
		// The 105th is in bucket 20.
		assert.equal(approximateQuantileNs(buckets, 1), 2 ** 21);
	});

	it("does not depend on the order buckets arrive in", () => {
		const ascending = approximateQuantileNs(
			[
				[3, 1],
				[9, 9],
			],
			0.95,
		);
		const descending = approximateQuantileNs(
			[
				[9, 9],
				[3, 1],
			],
			0.95,
		);
		assert.equal(ascending, descending);
	});

	it("rounds the target sample up so a small histogram is not under-reported", () => {
		// With 2 samples the 95th percentile is the 2nd, not the 1st.
		assert.equal(
			approximateQuantileNs(
				[
					[1, 1],
					[8, 1],
				],
				0.95,
			),
			2 ** 9,
		);
	});

	it("merges two sparse histograms without materialising empty buckets", () => {
		const merged = mergeHistograms(
			[
				[4, 2],
				[7, 1],
			],
			[[4, 3]],
		);
		assert.deepEqual(merged, [
			[4, 5],
			[7, 1],
		]);
	});
});

describe("latency summaries", () => {
	const counters: ObservationCounters = {
		failedOps: 0,
		readBytes: 4096,
		readHist: [[10, 4]],
		readNs: 8000,
		readOps: 4,
		writeBytes: 0,
		writeHist: [],
		writeNs: 0,
		writeOps: 0,
	};

	it("averages over the operations that were actually timed", () => {
		assert.equal(readLatency(counters).meanNs, 2000);
		assert.equal(readLatency(counters).operations, 4);
	});

	it("leaves a direction with no operations unavailable rather than zero", () => {
		assert.equal(writeLatency(counters).meanNs, null);
		assert.equal(writeLatency(counters).approxP95Ns, null);
	});
});

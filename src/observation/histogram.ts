import type { ObservationCounters } from "./protocol.ts";

/**
 * Latency summaries from the kernel's log2 histogram.
 *
 * The kernel records a bucket index, not a sample, so a percentile derived here
 * is an approximation with a known shape: bucket `i` covers
 * `[2^i, 2^(i+1))` nanoseconds. Reporting the bucket's upper bound makes the
 * error one-sided and stated, which is the only honest way to publish a P95
 * that was never measured as a sample.
 *
 * Nothing here invents a number from an empty histogram: no samples means
 * `null`, which the view renders as unavailable rather than as zero.
 */

export type HistogramBucket = [number, number];

export function histogramCount(buckets: readonly HistogramBucket[]): number {
	let total = 0;
	for (const [, count] of buckets) total += count;
	return total;
}

/**
 * Upper bound, in nanoseconds, of the bucket holding the requested quantile.
 *
 * Buckets arrive sparse and unordered in principle, so they are sorted here
 * rather than trusted to be ascending.
 */
export function approximateQuantileNs(buckets: readonly HistogramBucket[], quantile: number): number | null {
	const total = histogramCount(buckets);
	if (total === 0) return null;
	const ordered = [...buckets].sort((left, right) => left[0] - right[0]);
	// Ceiling: with 20 samples the 95th percentile is the 19th, not the 19th
	// rounded down to the 18th.
	const target = Math.max(1, Math.ceil(total * quantile));
	let seen = 0;
	for (const [bucket, count] of ordered) {
		seen += count;
		if (seen >= target) return 2 ** (bucket + 1);
	}
	// Unreachable: `seen` accumulates to `total`, which is at least `target`.
	return null;
}

export type LatencySummary = {
	approxP95Ns: number | null;
	meanNs: number | null;
	operations: number;
};

export function readLatency(counters: ObservationCounters): LatencySummary {
	return {
		approxP95Ns: approximateQuantileNs(counters.readHist, 0.95),
		meanNs: counters.readOps === 0 ? null : Math.round(counters.readNs / counters.readOps),
		operations: counters.readOps,
	};
}

export function writeLatency(counters: ObservationCounters): LatencySummary {
	return {
		approxP95Ns: approximateQuantileNs(counters.writeHist, 0.95),
		meanNs: counters.writeOps === 0 ? null : Math.round(counters.writeNs / counters.writeOps),
		operations: counters.writeOps,
	};
}

/** Merges two sparse histograms without materialising the empty buckets. */
export function mergeHistograms(left: readonly HistogramBucket[], right: readonly HistogramBucket[]): HistogramBucket[] {
	const totals = new Map<number, number>();
	for (const [bucket, count] of [...left, ...right]) {
		totals.set(bucket, (totals.get(bucket) ?? 0) + count);
	}
	return [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, count]): HistogramBucket => [bucket, count]);
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeS3AcceptanceReport, S3_ACCEPTANCE_SCHEMA_VERSION, type S3AcceptanceReport, type S3KernelAccount, type S3RunFacts } from "../../src/runs/shared/s3-acceptance-report.ts";

/**
 * The S3 acceptance judgement, proven on fixtures: the script that gathers the
 * facts needs root and a kernel, the decisions over them need neither.
 */

const reportedAccount = (envelope: { readBytes: number; writeBytes: number }): S3KernelAccount => ({
	byCategory: { content: { readBytes: 120, writeBytes: 60 }, envelope, "memory-index": { readBytes: 0, writeBytes: 400 } },
	kind: "reported-no-gap-found",
	losses: 0,
	pathlessBytes: 900,
	unclassified: { readBytes: 0, writeBytes: 0 },
});

function run(overrides: Partial<S3RunFacts> = {}, index = 1): S3RunFacts {
	return {
		envelopeBytes: 703,
		envelopeFileBytes: 776,
		identities: [
			{ pid: 100, startTicks: 5000 },
			{ pid: 101, startTicks: 5010 },
		],
		kernel: reportedAccount({ readBytes: 776, writeBytes: 776 }),
		receiptStatus: "ready",
		runId: `s3-${index}`,
		traceStartTicks: { 100: [5000], 101: [5010] },
		...overrides,
	};
}

function report(overrides: Partial<S3AcceptanceReport> = {}): S3AcceptanceReport {
	return {
		collectorStartError: null,
		environment: { bpftraceVersion: "bpftrace v0.19.1", btf: true, kernel: "Linux 6.6", nodeVersion: "v24", osRelease: "openEuler 24.03", root: true },
		honesty: { ...run({ kernel: { kind: "refused", losses: 42, reasons: ["collector-reported-loss"] } }, 9), ringBufferPages: 1 },
		runs: [run({}, 1), run({}, 2), run({}, 3)],
		schemaVersion: S3_ACCEPTANCE_SCHEMA_VERSION,
		...overrides,
	};
}

const outcomeOf = (value: S3AcceptanceReport, id: string) => judgeS3AcceptanceReport(value).checks.find((check) => check.id === id)?.outcome;

describe("S3 acceptance judgement", () => {
	it("passes a report in which every prediction held", () => {
		const verdict = judgeS3AcceptanceReport(report());
		assert.equal(verdict.verdict, "pass", JSON.stringify(verdict.checks));
	});

	it("is incomplete, not failed, when nothing could run without root", () => {
		const verdict = judgeS3AcceptanceReport(report({ environment: { ...report().environment, root: false }, honesty: null, runs: [] }));
		assert.equal(verdict.verdict, "incomplete");
		assert.ok(verdict.checks.every((check) => check.outcome === "unavailable"));
	});

	it("fails the collector on a kernel without BTF, and when bpftrace would not attach", () => {
		assert.equal(outcomeOf(report({ environment: { ...report().environment, btf: false } }), "collector-start"), "fail");
		assert.equal(outcomeOf(report({ collectorStartError: "probe would not attach", runs: [] }), "collector-start"), "fail");
	});

	it("fails start ticks that the kernel half read differently from /proc", () => {
		assert.equal(outcomeOf(report({ runs: [run({ traceStartTicks: { 100: [5001], 101: [5010] } })] }), "start-ticks-agree"), "fail");
	});

	it("fails self-consistency when the kernel moved other than the file's size each way", () => {
		assert.equal(outcomeOf(report({ runs: [run({ kernel: reportedAccount({ readBytes: 776, writeBytes: 1552 }) })] }), "self-consistency"), "fail");
		// A refused account on the consistency run is a failure of the measurement, not a skipped check.
		assert.equal(outcomeOf(report({ runs: [run({ kernel: { kind: "refused", losses: 0, reasons: ["unattributed-over-threshold"] } })] }), "self-consistency"), "fail");
	});

	it("does not grade consistency for a delegation that never delivered", () => {
		assert.equal(outcomeOf(report({ runs: [run({ receiptStatus: "absent" })] }), "self-consistency"), "unavailable");
	});

	it("fails repeatability when any category's bytes differ between runs", () => {
		const drifted = run({ kernel: { ...reportedAccount({ readBytes: 776, writeBytes: 776 }), byCategory: { ...(reportedAccount({ readBytes: 776, writeBytes: 776 }) as { byCategory: never }).byCategory, content: { readBytes: 121, writeBytes: 60 } } } as S3KernelAccount }, 3);
		assert.equal(outcomeOf(report({ runs: [run({}, 1), run({}, 2), drifted] }), "repeatability"), "fail");
		assert.equal(outcomeOf(report({ runs: [run({}, 1), run({}, 2)] }), "repeatability"), "unavailable");
	});

	it("fails honesty when events were lost and a number was still reported", () => {
		const lostButReported = { ...run({ kernel: { ...reportedAccount({ readBytes: 700, writeBytes: 776 }), losses: 42 } as S3KernelAccount }, 9), ringBufferPages: 1 };
		assert.equal(outcomeOf(report({ honesty: lostButReported }), "honesty"), "fail");
	});

	it("does not claim the refusal path was proven when the small buffer lost nothing", () => {
		const nothingLost = { ...run({}, 9), ringBufferPages: 1 };
		assert.equal(outcomeOf(report({ honesty: nothingLost }), "honesty"), "unavailable");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	judgeS2AcceptanceReport,
	parseS2AcceptanceReport,
	preflightMarkerFor,
	reconciliationDifference,
	s2AcceptanceExitCode,
	S2_ACCEPTANCE_CHECK_IDS,
	S2_ACCEPTANCE_SCHEMA_VERSION,
	type S2AcceptanceCheckId,
} from "../../src/runs/shared/s2-acceptance-report.ts";

/**
 * The judgement over the report the openEuler host sends back.
 *
 * Everything here is about a report being unable to claim more than it measured.
 * The reconciliation is the case that needed its own rules: its subject is the
 * *difference* between two collectors, so a report carrying one side and a
 * confident `pass` is the exact shape a half-broken collection produces, and the
 * judge has to be the thing that notices.
 */

function check(id: S2AcceptanceCheckId, outcome: string, extra: Record<string, unknown> = {}) {
	return { id, outcome, ...extra };
}

function report(overrides: { checks?: unknown[]; preflight?: unknown } = {}) {
	return JSON.stringify({
		checks: overrides.checks ?? [
			check("cross-container-visibility", "pass"),
			check("socket-syscall-trace", "pass"),
			check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 4096, kernelBytes: 4096 } }),
			check("single-round-gear-comparison", "pass"),
		],
		engine: { id: "isulad", version: "2.1.5" },
		kernel: "5.10.0-openEuler",
		preflight: overrides.preflight ?? { availableBytes: 2 * 1024 ** 3, detail: "tmpfs confirmed via statfs", sharedMemory: "tmpfs" },
		schemaVersion: S2_ACCEPTANCE_SCHEMA_VERSION,
	});
}

function judge(raw: string) {
	const parsed = parseS2AcceptanceReport(raw);
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
	if (!parsed.ok) throw new Error("unreachable");
	return judgeS2AcceptanceReport(parsed.report);
}

describe("the verdict", () => {
	it("passes only when every check passed", () => {
		const verdict = judge(report());
		assert.equal(verdict.verdict, "pass");
		assert.deepEqual(verdict.failed, []);
		assert.deepEqual(verdict.notRun, []);
		assert.equal(verdict.blocksS4, false);
		assert.equal(s2AcceptanceExitCode({ ok: true, verdict: verdict.verdict }), 0);
	});

	it("fails on any failure, and names which", () => {
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "fail"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 4096, kernelBytes: 4096 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(verdict.verdict, "fail");
		assert.deepEqual(verdict.failed, ["cross-container-visibility"]);
		assert.equal(s2AcceptanceExitCode({ ok: true, verdict: verdict.verdict }), 1);
	});

	it("reports which check never ran instead of grading the report without it", () => {
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "unavailable"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 4096, kernelBytes: 4096 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(verdict.verdict, "incomplete");
		assert.deepEqual(verdict.notRun, ["socket-syscall-trace"]);
		assert.equal(s2AcceptanceExitCode({ ok: true, verdict: verdict.verdict }), 2);
	});

	it("lets a real failure outrank a missing run", () => {
		// A check that never happened cannot excuse one that happened and failed.
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "fail"),
				check("socket-syscall-trace", "unavailable"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 1, kernelBytes: 1 } }),
				check("single-round-gear-comparison", "unavailable"),
			],
		}));
		assert.equal(verdict.verdict, "fail");
	});

	it("gives an unparseable report its own exit code, distinct from a failure", () => {
		assert.equal(s2AcceptanceExitCode({ ok: false }), 3);
		assert.notEqual(s2AcceptanceExitCode({ ok: false }), s2AcceptanceExitCode({ ok: true, verdict: "fail" }));
	});
});

describe("the reconciliation is judged on the difference, not on either side", () => {
	it("passes when the two collectors agree", () => {
		const verdict = judge(report());
		assert.equal(verdict.reconciliationDifference, 0);
		assert.equal(verdict.blocksS4, false);
	});

	it("fails when they disagree, whatever the script claimed", () => {
		// The script said pass. The numbers say otherwise, and the numbers are the
		// check: one of the two sides is wrong and S2's core claim is unproven.
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 4096, kernelBytes: 3072 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(verdict.verdict, "fail");
		assert.deepEqual(verdict.failed, ["transport-bytes-reconciliation"]);
		assert.equal(verdict.reconciliationDifference, 1024);
		assert.equal(verdict.blocksS4, true);
	});

	it("calls a one-sided reconciliation unavailable, and never fills the missing side with zero", () => {
		// Zero-filling would produce a difference of exactly 4096 — a *failed*
		// reconciliation, when in fact nothing was reconciled and nothing was
		// contradicted. The missing number is a fact about the collector.
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 4096, kernelBytes: null } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(verdict.verdict, "incomplete");
		assert.deepEqual(verdict.notRun, ["transport-bytes-reconciliation"]);
		assert.deepEqual(verdict.failed, []);
		assert.equal(verdict.reconciliationDifference, null);
		assert.equal(verdict.blocksS4, true, "S4 would be comparing numbers nobody has proven");
	});

	it("treats a missing kernel side and a missing application side the same way", () => {
		for (const evidence of [{ applicationBytes: null, kernelBytes: 4096 }, { applicationBytes: null, kernelBytes: null }]) {
			const verdict = judge(report({
				checks: [
					check("cross-container-visibility", "pass"),
					check("socket-syscall-trace", "pass"),
					check("transport-bytes-reconciliation", "pass", { reconciliation: evidence }),
					check("single-round-gear-comparison", "pass"),
				],
			}));
			assert.equal(verdict.verdict, "incomplete");
			assert.equal(verdict.reconciliationDifference, null);
		}
	});

	it("keeps a script's own failure even when the numbers happen to match", () => {
		// The collector knows things the two totals do not show — a truncated
		// trace, a run that died halfway. Recomputing from the numbers must not
		// overwrite that into a pass.
		const verdict = judge(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "fail", { reconciliation: { applicationBytes: 4096, kernelBytes: 4096 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(verdict.verdict, "fail");
		assert.deepEqual(verdict.failed, ["transport-bytes-reconciliation"]);
	});

	it("computes the gap symmetrically", () => {
		assert.equal(reconciliationDifference({ applicationBytes: 10, kernelBytes: 4 }), 6);
		assert.equal(reconciliationDifference({ applicationBytes: 4, kernelBytes: 10 }), 6);
		assert.equal(reconciliationDifference({ applicationBytes: null, kernelBytes: 10 }), null);
	});
});

describe("a malformed report is rejected rather than defaulted to a pass", () => {
	it("rejects a report that omits a check", () => {
		const parsed = parseS2AcceptanceReport(report({ checks: [check("cross-container-visibility", "pass")] }));
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.match(parsed.error, /omits/);
	});

	it("rejects the reconciliation check when it carries no evidence to judge", () => {
		const parsed = parseS2AcceptanceReport(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass"),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.match(parsed.error, /no reconciliation evidence/);
	});

	it("rejects a negative or fractional byte count", () => {
		// NaN is absent on purpose: `JSON.stringify` writes it as `null`, which is a
		// legal value here, so it can never reach the parser as a number at all.
		for (const bytes of [-1, 1.5, "4096", true]) {
			const parsed = parseS2AcceptanceReport(report({
				checks: [
					check("cross-container-visibility", "pass"),
					check("socket-syscall-trace", "pass"),
					check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: bytes, kernelBytes: 4096 } }),
					check("single-round-gear-comparison", "pass"),
				],
			}));
			assert.equal(parsed.ok, false, `${JSON.stringify(bytes)} is not a byte count`);
		}
	});

	it("rejects a report with no preflight marker, since an unproven tmpfs must be visible", () => {
		const raw = JSON.parse(report());
		delete raw.preflight;
		const parsed = parseS2AcceptanceReport(JSON.stringify(raw));
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.match(parsed.error, /preflight/);
	});

	it("carries a refused preflight through to the verdict's report rather than dropping it", () => {
		// A refused tmpfs does not by itself fail the run — the checks do that —
		// but it must survive into the artifact, or a reader cannot tell that the
		// numbers describe an ordinary disk.
		const parsed = parseS2AcceptanceReport(report({
			preflight: { availableBytes: null, detail: "symlinked: /srv/objects is a symbolic link", sharedMemory: "refused" },
		}));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.report.preflight.sharedMemory, "refused");
		assert.match(parsed.report.preflight.detail, /symlinked/);
	});

	it("rejects an unknown or duplicated check id", () => {
		assert.equal(parseS2AcceptanceReport(report({ checks: [check("made-up" as S2AcceptanceCheckId, "pass")] })).ok, false);
		const duplicated = parseS2AcceptanceReport(report({
			checks: [
				check("cross-container-visibility", "pass"),
				check("cross-container-visibility", "pass"),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 1, kernelBytes: 1 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(duplicated.ok, false);
		if (duplicated.ok) return;
		assert.match(duplicated.error, /more than once/);
	});

	it("refuses a report written to a schema this judge does not read", () => {
		const raw = JSON.parse(report());
		raw.schemaVersion = S2_ACCEPTANCE_SCHEMA_VERSION + 1;
		const parsed = parseS2AcceptanceReport(JSON.stringify(raw));
		assert.equal(parsed.ok, false);
	});

	it("refuses reconciliation evidence on a check that has no difference to judge", () => {
		const parsed = parseS2AcceptanceReport(report({
			checks: [
				check("cross-container-visibility", "pass", { reconciliation: { applicationBytes: 1, kernelBytes: 1 } }),
				check("socket-syscall-trace", "pass"),
				check("transport-bytes-reconciliation", "pass", { reconciliation: { applicationBytes: 1, kernelBytes: 1 } }),
				check("single-round-gear-comparison", "pass"),
			],
		}));
		assert.equal(parsed.ok, false);
	});
});

describe("the shape s2-acceptance.sh actually emits", () => {
	/**
	 * Copied from a real run of the collector on a host with no reachable engine,
	 * no Linux strace and no tmpfs — the case its own verify item names. If the
	 * script's JSON and this parser ever drift apart, a report brought back from
	 * openEuler is rejected on arrival, which is the most expensive place to find
	 * out.
	 */
	const COLLECTED = JSON.stringify({
		checks: [
			{ detail: "the docker engine is on PATH but not reachable: Server: failed to connect", id: "cross-container-visibility", outcome: "unavailable" },
			{ detail: "the traced probe did not complete, so no sequence was observed", id: "socket-syscall-trace", outcome: "unavailable" },
			{ detail: "S3's collector emits no socket events yet", id: "transport-bytes-reconciliation", outcome: "unavailable", reconciliation: { applicationBytes: null, kernelBytes: null } },
			{ detail: "a gear ran but did not deliver, so there is no round to compare", id: "single-round-gear-comparison", outcome: "unavailable" },
		],
		engine: { id: "docker", version: "Docker version 29.1.2" },
		kernel: "MINGW64_NT-10.0-26200",
		preflight: { availableBytes: null, detail: "undetermined: this host offers neither a POSIX f_type nor /proc/mounts", sharedMemory: "refused" },
		schemaVersion: 1,
	});

	it("parses, and judges as incomplete rather than as a failure", () => {
		const verdict = judge(COLLECTED);
		assert.equal(verdict.verdict, "incomplete");
		assert.deepEqual(verdict.failed, [], "a host that could not run the checks has not failed them");
		assert.equal(verdict.notRun.length, 4);
		assert.equal(verdict.blocksS4, true);
		assert.equal(s2AcceptanceExitCode({ ok: true, verdict: verdict.verdict }), 2);
	});
});

describe("the check set", () => {
	it("puts the strace observation before the reconciliation it decides the shape of", () => {
		const trace = S2_ACCEPTANCE_CHECK_IDS.indexOf("socket-syscall-trace");
		const reconcile = S2_ACCEPTANCE_CHECK_IDS.indexOf("transport-bytes-reconciliation");
		assert.ok(trace < reconcile, "reconciling against a collector not yet watching the right syscalls means nothing");
	});

	it("carries the single-round comparison and no reproducibility check", () => {
		// Reproducibility is S4's: "same task, same model, same seed" is condition
		// control S2 has no way to establish. A check named for it here would be a
		// claim S2 cannot support.
		assert.ok(S2_ACCEPTANCE_CHECK_IDS.includes("single-round-gear-comparison"));
		assert.equal(S2_ACCEPTANCE_CHECK_IDS.length, 4);
		assert.ok(!S2_ACCEPTANCE_CHECK_IDS.some((id) => /reproduc/i.test(id)));
	});

	it("builds a marker the parser accepts, from either preflight outcome", () => {
		const accepted = preflightMarkerFor({ availableBytes: 4096, evidence: "statfs", status: "tmpfs" });
		assert.deepEqual(accepted, { availableBytes: 4096, detail: "tmpfs confirmed via statfs", sharedMemory: "tmpfs" });
		const refused = preflightMarkerFor({ cause: "undetermined", reason: "no /proc here", status: "refused" });
		assert.equal(refused.sharedMemory, "refused");
		assert.equal(refused.availableBytes, null);
		// Round-trips through the parser, so the two halves cannot drift apart.
		assert.equal(parseS2AcceptanceReport(report({ preflight: refused })).ok, true);
		assert.equal(parseS2AcceptanceReport(report({ preflight: accepted })).ok, true);
	});
});

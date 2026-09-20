import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	S1_ACCEPTANCE_CHECK_IDS,
	judgeS1AcceptanceReport,
	parseS1AcceptanceReport,
} from "../../src/runs/shared/s1-acceptance-report.ts";

function check(id: string, overrides: Record<string, unknown> = {}) {
	return { id, outcome: "pass", evidence: { bytes: 0, paths: [] }, ...overrides };
}

function report(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: 1,
		engine: { id: "isula", version: "Version 2.1.5" },
		kernel: "6.6.0-72.0.0.76.oe2403sp3.x86_64",
		checks: S1_ACCEPTANCE_CHECK_IDS.map((id) => check(id)),
		...overrides,
	});
}

describe("S1 acceptance report parsing", () => {
	it("rejects a report that is not JSON at all rather than treating it as empty", () => {
		const parsed = parseS1AcceptanceReport("not json");
		assert.equal(parsed.ok, false);
	});

	it("rejects a report missing a check the design requires", () => {
		const parsed = parseS1AcceptanceReport(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.slice(1).map((id) => check(id)),
		}));

		assert.equal(parsed.ok, false);
		assert.match(parsed.ok ? "" : parsed.error, new RegExp(S1_ACCEPTANCE_CHECK_IDS[0] ?? ""));
	});

	it("rejects a negative byte count instead of counting it", () => {
		const parsed = parseS1AcceptanceReport(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id, index) => check(id, index === 0 ? { evidence: { bytes: -1, paths: [] } } : {})),
		}));

		assert.equal(parsed.ok, false);
		assert.match(parsed.ok ? "" : parsed.error, /byte/i);
	});

	it("rejects an outcome word it does not know", () => {
		const parsed = parseS1AcceptanceReport(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id, index) => check(id, index === 0 ? { outcome: "probably" } : {})),
		}));

		assert.equal(parsed.ok, false);
	});

	it("accepts a well-formed report", () => {
		assert.equal(parseS1AcceptanceReport(report()).ok, true);
	});
});

describe("S1 acceptance verdict", () => {
	function judge(raw: string) {
		const parsed = parseS1AcceptanceReport(raw);
		assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
		return judgeS1AcceptanceReport(parsed.ok ? parsed.report : (undefined as never));
	}

	it("passes a report whose every check passed", () => {
		const verdict = judge(report());

		assert.equal(verdict.verdict, "pass");
		assert.deepEqual(verdict.failed, []);
		assert.deepEqual(verdict.notRun, []);
	});

	it("fails a report with any failed check, naming it", () => {
		const verdict = judge(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id, index) => check(id, index === 2 ? { outcome: "fail", detail: "outsideRoot was 10000000" } : {})),
		}));

		assert.equal(verdict.verdict, "fail");
		assert.deepEqual(verdict.failed, [S1_ACCEPTANCE_CHECK_IDS[2]]);
	});

	it("neither passes nor fails a report with a check that never ran", () => {
		const verdict = judge(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id, index) => check(id, index === 1 ? { outcome: "unavailable", detail: "no container engine on this host" } : {})),
		}));

		assert.equal(verdict.verdict, "incomplete");
		assert.deepEqual(verdict.notRun, [S1_ACCEPTANCE_CHECK_IDS[1]]);
		assert.deepEqual(verdict.failed, []);
	});

	it("reports a real failure as failure even when another check never ran", () => {
		const verdict = judge(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id, index) =>
				check(id, index === 0 ? { outcome: "unavailable" } : index === 1 ? { outcome: "fail" } : {})),
		}));

		// A run that did not happen cannot excuse one that happened and failed.
		assert.equal(verdict.verdict, "fail");
		assert.deepEqual(verdict.failed, [S1_ACCEPTANCE_CHECK_IDS[1]]);
		assert.deepEqual(verdict.notRun, [S1_ACCEPTANCE_CHECK_IDS[0]]);
	});

	it("fails when the one check S2 depends on did not pass, whatever the rest did", () => {
		const verdict = judge(report({
			checks: S1_ACCEPTANCE_CHECK_IDS.map((id) => check(id, id === "ipc-sharing" ? { outcome: "unavailable" } : {})),
		}));

		assert.notEqual(verdict.verdict, "pass");
		assert.equal(verdict.blocksS2, true);
	});

	it("does not block S2 when the shared-memory check passed", () => {
		assert.equal(judge(report()).blocksS2, false);
	});
});

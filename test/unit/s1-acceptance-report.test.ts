import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import {
	S1_ACCEPTANCE_CHECK_IDS,
	judgeS1AcceptanceReport,
	parseS1AcceptanceReport,
	s1AcceptanceExitCode,
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

describe("the report the collection script actually emits", () => {
	// Captured from a real `s1-acceptance.sh` run on a host with no container
	// engine. It pins the contract between the shell that collects and the
	// TypeScript that judges — the two halves live in different languages on
	// different machines, so nothing else would notice them drifting apart.
	const raw = fs.readFileSync(new URL("../fixtures/s1/no-engine-report.json", import.meta.url), "utf-8");

	it("parses without modification", () => {
		const parsed = parseS1AcceptanceReport(raw);
		assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
	});

	it("is judged incomplete, not passed and not failed", () => {
		const parsed = parseS1AcceptanceReport(raw);
		assert.ok(parsed.ok);
		const verdict = judgeS1AcceptanceReport(parsed.report);

		assert.equal(verdict.verdict, "incomplete");
		assert.deepEqual(verdict.failed, []);
		assert.equal(verdict.notRun.length, S1_ACCEPTANCE_CHECK_IDS.length);
		assert.equal(verdict.blocksS2, true);
	});

	it("would be rejected if the script ever dropped a check", () => {
		const shortened = JSON.parse(raw);
		shortened.checks = shortened.checks.slice(1);
		const parsed = parseS1AcceptanceReport(JSON.stringify(shortened));

		assert.equal(parsed.ok, false);
	});
});

describe("acceptance exit code", () => {
	it("gives each verdict its own exit code, so a caller cannot confuse them", () => {
		const codes = new Set([
			s1AcceptanceExitCode({ ok: true, verdict: "pass" }),
			s1AcceptanceExitCode({ ok: true, verdict: "fail" }),
			s1AcceptanceExitCode({ ok: true, verdict: "incomplete" }),
			s1AcceptanceExitCode({ ok: false }),
		]);

		assert.equal(codes.size, 4);
	});

	it("succeeds only on a pass", () => {
		assert.equal(s1AcceptanceExitCode({ ok: true, verdict: "pass" }), 0);
		assert.notEqual(s1AcceptanceExitCode({ ok: true, verdict: "incomplete" }), 0);
		assert.notEqual(s1AcceptanceExitCode({ ok: true, verdict: "fail" }), 0);
		assert.notEqual(s1AcceptanceExitCode({ ok: false }), 0);
	});
});

describe("report schema version", () => {
	it("rejects a version it was not written to read", () => {
		const parsed = parseS1AcceptanceReport(report({ schemaVersion: 2 }));

		assert.equal(parsed.ok, false);
		// A later script revision could narrow what `pass` means on a check; grading
		// it under v1 semantics would print a confident verdict computed from the
		// wrong rules.
		assert.match(parsed.ok ? "" : parsed.error, /schemaVersion/);
	});

	it("still accepts the version it knows", () => {
		assert.equal(parseS1AcceptanceReport(report({ schemaVersion: 1 })).ok, true);
	});
});

/**
 * Judges a report brought back from the openEuler host.
 *
 *   node --experimental-strip-types scripts/synapse/judge-s1-report.ts <report.json>
 *
 * Exit codes: 0 pass, 1 fail, 2 incomplete, 3 the report could not be read.
 * Every decision here comes from `s1-acceptance-report.ts`, which is unit-tested;
 * this file only reads a file and prints.
 */
import * as fs from "node:fs";
import { judgeS1AcceptanceReport, parseS1AcceptanceReport, s1AcceptanceExitCode } from "../../src/runs/shared/s1-acceptance-report.ts";

const reportPath = process.argv[2];
if (!reportPath) {
	console.error("usage: judge-s1-report.ts <report.json>");
	process.exit(64);
}

let raw: string;
try {
	raw = fs.readFileSync(reportPath, "utf-8");
} catch (error) {
	console.error(`Could not read ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(s1AcceptanceExitCode({ ok: false }));
}

const parsed = parseS1AcceptanceReport(raw);
if (!parsed.ok) {
	console.error(`Report rejected: ${parsed.error}`);
	process.exit(s1AcceptanceExitCode({ ok: false }));
}

const verdict = judgeS1AcceptanceReport(parsed.report);
console.log(`engine:  ${parsed.report.engine.id} ${parsed.report.engine.version}`);
console.log(`kernel:  ${parsed.report.kernel}`);
for (const check of parsed.report.checks) {
	const mark = check.outcome === "pass" ? "PASS" : check.outcome === "fail" ? "FAIL" : "N/R ";
	console.log(`  ${mark}  ${check.id}${check.evidence.bytes ? ` (${check.evidence.bytes} B)` : ""}${check.detail ? ` — ${check.detail}` : ""}`);
}
console.log(`verdict: ${verdict.verdict}`);
if (verdict.failed.length > 0) console.log(`failed:  ${verdict.failed.join(", ")}`);
if (verdict.notRun.length > 0) console.log(`not run: ${verdict.notRun.join(", ")}`);
if (verdict.blocksS2) console.log("S2 is blocked: the cross-container shared-memory check did not pass.");

process.exit(s1AcceptanceExitCode({ ok: true, verdict: verdict.verdict }));

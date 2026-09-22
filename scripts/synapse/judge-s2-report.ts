/**
 * Judges a report brought back from the openEuler host.
 *
 *   node --experimental-strip-types scripts/synapse/judge-s2-report.ts <report.json>
 *
 * Exit codes: 0 pass, 1 fail, 2 incomplete, 3 the report could not be read.
 * Every decision here comes from `s2-acceptance-report.ts`, which is unit-tested;
 * this file only reads a file and prints.
 */
import * as fs from "node:fs";
import { judgeS2AcceptanceReport, parseS2AcceptanceReport, reconciliationDifference, s2AcceptanceExitCode } from "../../src/runs/shared/s2-acceptance-report.ts";

const reportPath = process.argv[2];
if (!reportPath) {
	console.error("usage: judge-s2-report.ts <report.json>");
	process.exit(64);
}

let raw: string;
try {
	raw = fs.readFileSync(reportPath, "utf-8");
} catch (error) {
	console.error(`Could not read ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(s2AcceptanceExitCode({ ok: false }));
}

const parsed = parseS2AcceptanceReport(raw);
if (!parsed.ok) {
	console.error(`Report rejected: ${parsed.error}`);
	process.exit(s2AcceptanceExitCode({ ok: false }));
}

const verdict = judgeS2AcceptanceReport(parsed.report);
console.log(`engine:    ${parsed.report.engine.id} ${parsed.report.engine.version}`);
console.log(`kernel:    ${parsed.report.kernel}`);
const capacity = parsed.report.preflight.availableBytes;
console.log(`objects:   ${parsed.report.preflight.sharedMemory}${capacity === null ? "" : ` (${capacity} B free)`} — ${parsed.report.preflight.detail}`);
for (const check of parsed.report.checks) {
	// The reconciliation's printed outcome is the judged one, not the one the
	// script claimed: the judge regrades it from its own two numbers.
	const judged = verdict.failed.includes(check.id) ? "fail" : verdict.notRun.includes(check.id) ? "unavailable" : "pass";
	const mark = judged === "pass" ? "PASS" : judged === "fail" ? "FAIL" : "N/R ";
	let evidence = "";
	if (check.reconciliation) {
		const difference = reconciliationDifference(check.reconciliation);
		const bytes = (value: number | null): string => (value === null ? "not reported" : `${value} B`);
		evidence = ` (app ${bytes(check.reconciliation.applicationBytes)} vs kernel ${bytes(check.reconciliation.kernelBytes)}, Δ ${difference === null ? "not computable" : `${difference} B`})`;
	}
	console.log(`  ${mark}  ${check.id}${evidence}${check.detail ? ` — ${check.detail}` : ""}`);
}
console.log(`verdict:   ${verdict.verdict}`);
if (verdict.failed.length > 0) console.log(`failed:    ${verdict.failed.join(", ")}`);
if (verdict.notRun.length > 0) console.log(`not run:   ${verdict.notRun.join(", ")}`);
if (verdict.blocksS4) console.log("S4 is blocked: the transportBytes reconciliation did not pass, so nobody has proven the numbers S4 would compare.");

process.exit(s2AcceptanceExitCode({ ok: true, verdict: verdict.verdict }));

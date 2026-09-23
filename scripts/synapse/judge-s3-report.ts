/**
 * Judges a report from `s3-acceptance.ts`.
 *
 *   node --experimental-strip-types scripts/synapse/judge-s3-report.ts <report.json>
 *
 * Exit codes, as for S1 and S2: 0 pass, 1 fail, 2 incomplete (a check did not
 * run — neither evidence for nor against), 3 the report could not be read.
 */
import * as fs from "node:fs";
import { judgeS3AcceptanceReport, S3_ACCEPTANCE_SCHEMA_VERSION, type S3AcceptanceReport } from "../../src/runs/shared/s3-acceptance-report.ts";

const file = process.argv[2];
if (file === undefined) {
	console.error("usage: judge-s3-report.ts <report.json>");
	process.exit(3);
}
let report: S3AcceptanceReport;
try {
	report = JSON.parse(fs.readFileSync(file, "utf-8")) as S3AcceptanceReport;
} catch (error) {
	console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(3);
}
if (report.schemaVersion !== S3_ACCEPTANCE_SCHEMA_VERSION) {
	console.error(`schema version ${String(report.schemaVersion)} is not ${S3_ACCEPTANCE_SCHEMA_VERSION}`);
	process.exit(3);
}
const verdict = judgeS3AcceptanceReport(report);
for (const check of verdict.checks) console.log(`${check.outcome.padEnd(11)} ${check.id}: ${check.detail}`);
console.log(`verdict: ${verdict.verdict}`);
process.exit(verdict.verdict === "pass" ? 0 : verdict.verdict === "fail" ? 1 : 2);

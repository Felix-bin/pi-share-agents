#!/usr/bin/env node
// Join run records with the official SWE-bench per-instance report.json files.
import fs from "node:fs";
import path from "node:path";
import { ARMS } from "./matrix.mjs";

const runDir = path.resolve(process.argv[2] ?? "");
const evalDir = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!process.argv[2]) throw new Error("usage: node report.mjs <run-directory> [official-logs/evaluation]");
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));

function officialResult(arm, id) {
	if (!evalDir) return null;
	const file = path.join(evalDir, `${manifest.id}-${arm}`, `deepseek-flash-pi-${arm}`, id, "report.json");
	if (!fs.existsSync(file)) return null;
	const report = JSON.parse(fs.readFileSync(file, "utf8"));
	return report.resolved === true;
}

const byArm = {};
for (const arm of ARMS) {
	const rows = manifest.instances.map((id) => {
		const file = path.join(runDir, "evidence", id, arm, "result.json");
		const run = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
		const rawOfficial = officialResult(arm, id);
		const resolved = run === null ? null : run.valid === false ? false : rawOfficial;
		return { id, valid: run?.valid === true, problem: run?.problem ?? "not run", resolved, rawOfficial,
			tokens: run?.usage?.missing === 0 ? run.usage.total : null,
			wallMs: run?.wallMs ?? null, handoffBytes: run?.observedHandoffBytes ?? null };
	});
	byArm[arm] = { rows, count: rows.length, valid: rows.filter((x) => x.valid).length,
		resolved: rows.filter((x) => x.resolved === true).length,
		scoreCoverage: rows.filter((x) => x.resolved !== null).length,
		officialEvaluated: rows.filter((x) => x.rawOfficial !== null).length,
		rawOfficialResolved: rows.filter((x) => x.rawOfficial === true).length,
		tokens: rows.reduce((n, x) => n + (x.tokens ?? 0), 0),
		tokenCoverage: rows.filter((x) => x.tokens !== null).length,
		wallMs: rows.reduce((n, x) => n + (x.wallMs ?? 0), 0),
		handoffBytes: rows.reduce((n, x) => n + (x.handoffBytes ?? 0), 0),
	};
}
const pairs = {};
for (const baseline of ["nico", "tintinweb"]) {
	let shareOnly = 0, baselineOnly = 0, both = 0, neither = 0, unevaluated = 0;
	for (let i = 0; i < manifest.instances.length; i++) {
		const a = byArm.share.rows[i].resolved, b = byArm[baseline].rows[i].resolved;
		if (a === null || b === null) { unevaluated++; continue; }
		if (a && b) both++;
		else if (a) shareOnly++;
		else if (b) baselineOnly++;
		else neither++;
	}
	pairs[`share-vs-${baseline}`] = { shareOnly, baselineOnly, both, neither, unevaluated };
}
const report = { experimentId: manifest.id, datasetSha256: manifest.datasetSha256, total: manifest.instances.length,
	arms: Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(Object.entries(byArm[arm]).filter(([key]) => key !== "rows"))])), pairs };
fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

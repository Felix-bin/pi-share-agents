#!/usr/bin/env node
/**
 * Fills the calibration report's scan tables from the shipped JSON reports.
 *
 * The Markdown is a reviewer's only source, and a table typed by hand is a table
 * that can disagree with the JSON it claims to summarise — which is exactly what
 * happened once. This script owns those tables: the report carries a marker per
 * table, the tables are generated here, and re-running it is the only supported
 * way to change them. Run it after any re-calibration and diff the result.
 *
 * Markers: `<!-- TABLE:FOLLOWUP -->`, `<!-- TABLE:PROGRESSION -->`, `<!-- TABLE:CEILING -->`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPERIMENTS = path.join(REPO, "experiments", "legacy", "records");
const REPORT_ID = "delta-calibration-20260919";

const TABLES = [
	{
		file: `${REPORT_ID}-grid-ceiling.json`,
		// The ceiling rows come from a scan whose threshold is a single stale value;
		// the payload and top-1 columns therefore belong to that threshold, which the
		// caption says out loud so the columns are not read as the cost of a lossless
		// representation.
		columns: ["grid", "layout", "stride", "ceiling", "top1", "meanBytes"],
		marker: "TABLE:CEILING",
	},
	{
		file: `${REPORT_ID}.json`,
		columns: ["grid", "layout", "stride", "threshold", "top1", "set", "ordered", "ceiling", "meanBytes", "p95Bytes", "meanNnz"],
		marker: "TABLE:FOLLOWUP",
	},
	{
		file: `${REPORT_ID}-progression.json`,
		columns: ["grid", "layout", "stride", "threshold", "top1", "set", "ordered", "ceiling", "meanBytes", "p95Bytes", "meanNnz"],
		marker: "TABLE:PROGRESSION",
	},
];

const HEADERS = {
	ceiling: "量化上界(有序)",
	grid: "grid",
	layout: "布局",
	meanBytes: "平均载荷 B",
	meanNnz: "平均 nnz",
	ordered: "top-5 有序",
	p95Bytes: "p95 载荷 B",
	set: "top-5 集合",
	stride: "stride",
	threshold: "threshold",
	top1: "top-1",
};

const percent = (value) => `${(value * 100).toFixed(1)}%`;

function cellFor(column, row) {
	switch (column) {
		case "grid":
			return String(row.grid);
		case "layout":
			return row.layout;
		case "stride":
			return String(row.bytesPerComponent);
		case "threshold":
			return row.threshold.toFixed(2);
		case "top1":
			return percent(row.top1Consistency);
		case "set":
			return percent(row.setConsistency);
		case "ordered":
			return percent(row.consistency);
		case "ceiling":
			return percent(row.quantizeOnlyConsistency);
		case "meanBytes":
			return String(row.meanPayloadBytes);
		case "p95Bytes":
			return String(row.p95PayloadBytes);
		case "meanNnz":
			return String(row.meanNnz);
		default:
			throw new Error(`no cell renderer for column ${column}`);
	}
}

function renderTable(spec) {
	const reportPath = path.join(EXPERIMENTS, spec.file);
	const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
	const lines = [
		`| ${spec.columns.map((column) => HEADERS[column]).join(" | ")} |`,
		`|${spec.columns.map(() => "---").join("|")}|`,
	];
	for (const row of report.scan) {
		lines.push(`| ${spec.columns.map((column) => cellFor(column, row)).join(" | ")} |`);
	}
	return lines.join("\n");
}

/**
 * Finds the line holding exactly `marker`. Only a standalone line counts: the
 * report's own preface names the markers inline, and a substring search would
 * treat that mention as a second table.
 */
function markerLineIndex(lines, marker) {
	const hits = [];
	lines.forEach((line, index) => {
		if (line.trim() === marker) hits.push(index);
	});
	if (hits.length === 0) throw new Error(`${marker} has no standalone line in the report`);
	if (hits.length > 1) throw new Error(`${marker} appears on ${hits.length} lines; a table would be filled twice`);
	return hits[0];
}

const reportPath = path.join(EXPERIMENTS, `${REPORT_ID}.md`);
let lines = fs.readFileSync(reportPath, "utf-8").split("\n");
for (const spec of TABLES) {
	const marker = `<!-- ${spec.marker} -->`;
	const at = markerLineIndex(lines, marker);
	// The block the marker owns is the run of table lines that follows it. It is
	// REPLACED, not appended to: inserting would leave the previous fill in place and
	// the report would then carry two conflicting copies of the same table.
	let blockStart = at + 1;
	while (blockStart < lines.length && lines[blockStart].trim() === "") blockStart += 1;
	let blockEnd = blockStart;
	while (blockEnd < lines.length && lines[blockEnd].trim().startsWith("|")) blockEnd += 1;
	const tail = lines.slice(blockEnd);
	while (tail.length > 0 && tail[0].trim() === "") tail.shift();
	lines = [...lines.slice(0, at + 1), "", ...renderTable(spec).split("\n"), "", ...tail];
}
const markdown = lines.join("\n");
// Every marker must now be followed by a table header and separator; a block left
// over from an earlier fill has no marker of its own and would survive as a stale
// duplicate, so the shape is checked after the rewrite rather than before.
for (const spec of TABLES) {
	const marker = `<!-- ${spec.marker} -->`;
	const blockLines = markdown.split("\n");
	const at = markerLineIndex(blockLines, marker);
	const header = blockLines[at + 2] ?? "";
	const separator = blockLines[at + 3] ?? "";
	if (!header.startsWith("|") || !separator.includes("---")) throw new Error(`${spec.marker} is not followed by a table`);
}
fs.writeFileSync(reportPath, markdown, "utf-8");
console.error(`filled ${TABLES.length} tables in ${path.basename(reportPath)} from the shipped JSON reports`);

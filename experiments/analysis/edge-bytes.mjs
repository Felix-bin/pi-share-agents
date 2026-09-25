#!/usr/bin/env node
/**
 * EdgeBytes: what the agents of a round actually passed each other, measured
 * one way for every arm (spec 2026-09-25-synapse-stage-result-handoff §5.2).
 *
 *   node experiments/analysis/edge-bytes.mjs <benchExpDir>
 *
 * The product's own `text.handoffBytes` cannot compare arms: in synapse mode
 * recalled memory reaches the child through its system prompt, off the wire
 * that figure meters, and SYN0 writes no ledger at all. This counts, per valid
 * round, from the artifacts every arm leaves:
 *
 *   down  — each child's task message and every other user message it was
 *           handed (the state steer), plus the recalled memory its host
 *           redeemed into its system prompt (`memory-redeem` events);
 *   up    — every subagent tool result the parent received (pi-rpc.log);
 *   pull  — every `synapse_read` result a child read, because reading a
 *           handle's text is communication too: a result block that sends its
 *           detail by handle must not look free by leaving the reads out.
 *
 * External-framework arms (CREWAI, AUTOGEN; spec
 * 2026-09-25-synapse-external-framework-arms §7.2) have no orchestrator and no
 * handles: down is every delivery their harness recorded in handoffs.jsonl (the
 * task text to each agent, plus CrewAI's context or AutoGen's broadcast to each
 * recipient), up and pull are 0.
 *
 * UTF-8 bytes and characters are both reported. Paired differences use the
 * aggregate's bootstrap (B = 10000, seed 20260921) over (group, round) pairs.
 */
import fs from "node:fs";
import path from "node:path";

const expDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!expDir || !fs.existsSync(path.join(expDir, "manifest.json"))) {
	console.error("usage: edge-bytes.mjs <benchExpDir>");
	process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(expDir, "manifest.json"), "utf-8"));
const records = fs.readFileSync(path.join(expDir, "rounds.jsonl"), "utf-8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
// Last valid attempt per arm × group × round, as the aggregate keeps.
const latest = new Map();
for (const record of records) if (record.valid) latest.set(`${record.arm}/${record.group}/${record.round}`, record);

const bytesOf = (text) => Buffer.byteLength(text, "utf-8");
const charsOf = (text) => [...text].length;
const textOf = (content) => (Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : typeof content === "string" ? content : "");
const readJsonl = (file) => fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim()).flatMap((line) => {
	try {
		return [JSON.parse(line)];
	} catch {
		return [];
	}
});

function measure(record) {
	const tag = `${record.arm}-${record.group}-${record.round}-${record.attempt}`;
	const artifacts = path.join(expDir, "tmp", tag, "artifacts");
	const evidence = path.join(expDir, "evidence", record.arm, record.group, `round-${String(record.round).padStart(2, "0")}`, `attempt-${record.attempt}`);
	const sum = { down: { bytes: 0, chars: 0 }, up: { bytes: 0, chars: 0 }, pull: { bytes: 0, chars: 0 }, redeemedBytes: 0, handoffs: 0, pulls: 0 };
	const add = (slot, text) => {
		sum[slot].bytes += bytesOf(text);
		sum[slot].chars += charsOf(text);
	};
	if (record.external) {
		for (const handoff of readJsonl(path.join(evidence, "handoffs.jsonl"))) {
			add("down", handoff.text);
			sum.handoffs += 1;
		}
		const total = { bytes: sum.down.bytes, chars: sum.down.chars };
		return { ...sum, total };
	}
	if (fs.existsSync(artifacts)) {
		for (const file of fs.readdirSync(artifacts).filter((name) => name.endsWith("_transcript.jsonl"))) {
			const entries = readJsonl(path.join(artifacts, file));
			const pullIds = new Set(entries.filter((entry) => entry.recordType === "tool_start" && entry.toolName === "synapse_read").map((entry) => entry.toolCallId));
			for (const entry of entries) {
				const message = entry.recordType === "message" ? entry.message : null;
				if (message?.role === "user") {
					const text = textOf(message.content);
					if (text.startsWith("[prompt redacted]")) continue;
					add("down", text);
					sum.handoffs += 1;
				}
				if (message?.role === "toolResult" && (message.toolName === "synapse_read" || pullIds.has(message.toolCallId))) {
					add("pull", textOf(message.content));
					sum.pulls += 1;
				}
			}
		}
	}
	const meteringDir = path.join(evidence, "metering");
	if (fs.existsSync(meteringDir)) {
		for (const file of fs.readdirSync(meteringDir)) for (const event of readJsonl(path.join(meteringDir, file))) if (event.kind === "memory-redeem") sum.redeemedBytes += event.bytes;
	}
	sum.down.bytes += sum.redeemedBytes;
	const log = path.join(evidence, "pi-rpc.log");
	if (fs.existsSync(log)) {
		for (const line of fs.readFileSync(log, "utf-8").split("\n")) {
			if (!line.includes('"tool_execution_end"')) continue;
			let event;
			try {
				event = JSON.parse(line.slice(line.indexOf("{")));
			} catch {
				continue;
			}
			if (event.type === "tool_execution_end" && event.toolName === "subagent") add("up", textOf(event.result?.content));
		}
	}
	const total = { bytes: sum.down.bytes + sum.up.bytes + sum.pull.bytes, chars: sum.down.chars + sum.up.chars + sum.pull.chars };
	return { ...sum, total };
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function bootstrap(diffs) {
	if (diffs.length === 0) return null;
	const rng = mulberry32(20260921);
	const means = [];
	for (let b = 0; b < 10_000; b += 1) {
		let total = 0;
		for (let i = 0; i < diffs.length; i += 1) total += diffs[Math.floor(rng() * diffs.length)];
		means.push(total / diffs.length);
	}
	means.sort((x, y) => x - y);
	return [means[250], means[9750]];
}

const arms = manifest.arms.map((entry) => entry.arm);
const groups = manifest.groups.map((entry) => entry.group);
const rows = [];
for (const [key, record] of latest) rows.push({ arm: record.arm, attempt: record.attempt, group: record.group, key, round: record.round, ...measure(record) });
rows.sort((a, b) => a.group.localeCompare(b.group) || a.round - b.round || arms.indexOf(a.arm) - arms.indexOf(b.arm));

const mean = (values) => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);
const perArm = Object.fromEntries(arms.map((arm) => {
	const mine = rows.filter((row) => row.arm === arm);
	return [arm, { rounds: mine.length, totalBytes: mean(mine.map((r) => r.total.bytes)), totalChars: mean(mine.map((r) => r.total.chars)), downBytes: mean(mine.map((r) => r.down.bytes)), upBytes: mean(mine.map((r) => r.up.bytes)), pullBytes: mean(mine.map((r) => r.pull.bytes)), redeemedBytes: mean(mine.map((r) => r.redeemedBytes)), pulls: mean(mine.map((r) => r.pulls)) }];
}));
const PAIRS = [["SYN0", "SYN"], ["TXT", "SYN"], ["SYNCOLD", "SYN"], ["SYN0", "TXT"], ["CREWAI", "SYN"], ["AUTOGEN", "SYN"], ["CREWAI", "SYN0"], ["AUTOGEN", "SYN0"]];
const comparisons = {};
for (const [a, b] of PAIRS) {
	if (!arms.includes(a) || !arms.includes(b)) continue;
	const diffs = [];
	const pa = [];
	for (const group of groups) for (let round = 1; round <= manifest.rounds; round += 1) {
		const ra = rows.find((row) => row.arm === a && row.group === group && row.round === round);
		const rb = rows.find((row) => row.arm === b && row.group === group && row.round === round);
		if (!ra || !rb) continue;
		diffs.push(ra.total.bytes - rb.total.bytes);
		pa.push(ra.total.bytes);
	}
	const meanA = mean(pa);
	const diff = mean(diffs);
	comparisons[`${a}-${b}`] = { ci: bootstrap(diffs), diff, pairs: diffs.length, savingPct: meanA ? diff / meanA : null };
}

const outDir = path.join(expDir, "edge-bytes");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "rounds.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify({ comparisons, definition: "down (child task + injected user messages + redeemed memory; external arms: every recorded delivery into an agent's context) + up (subagent tool results to the parent; 0 without an orchestrator) + pull (child synapse_read results; 0 without handles); UTF-8 bytes", experimentId: manifest.experimentId, perArm }, null, "\t")}\n`);
const kb = (n) => (n === null ? "n/a" : `${(n / 1000).toFixed(1)}k`);
const lines = [`# EdgeBytes — ${manifest.experimentId}`, "", "| arm | rounds | total/round | down | up | pull (reads) | redeemed |", "|---|---|---|---|---|---|---|"];
for (const [arm, a] of Object.entries(perArm)) lines.push(`| ${arm} | ${a.rounds} | ${kb(a.totalBytes)} | ${kb(a.downBytes)} | ${kb(a.upBytes)} | ${kb(a.pullBytes)} (${a.pulls?.toFixed(1) ?? "n/a"}) | ${kb(a.redeemedBytes)} |`);
lines.push("", "| pair A→B | pairs | A − B per round | saving % of A | 95% CI |", "|---|---|---|---|---|");
for (const [pair, c] of Object.entries(comparisons)) lines.push(`| ${pair} | ${c.pairs} | ${kb(c.diff)} | ${c.savingPct === null ? "n/a" : `${(c.savingPct * 100).toFixed(1)}%`} | ${c.ci ? `[${kb(c.ci[0])}, ${kb(c.ci[1])}]` : "n/a"} |`);
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));

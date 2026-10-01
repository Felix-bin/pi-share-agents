// The analysis scripts read an external-framework arm beside a pi arm: a hand-built
// experiment with one Q round of SYN0 (pi, no ledger) and one of CREWAI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const FAMILY = "experiments/bench/families/q-musique.json";
let root;
let exp;

const write = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const run = (script, ...args) => {
	const out = spawnSync(process.execPath, [path.join(REPO, script), ...args], { encoding: "utf-8" });
	assert.equal(out.status, 0, out.stderr);
	return out.stdout;
};

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-external-"));
	exp = path.join(root, "exp");
	const familySha = createHash("sha256").update(fs.readFileSync(path.join(REPO, FAMILY))).digest("hex");
	write(path.join(exp, "manifest.json"), JSON.stringify({ experimentId: "exp", rounds: 1, attempts: 1, provider: "p", model: "m", arms: [{ arm: "SYN0", config: { synapse: { mode: "synapse", memory: "off" } } }, { arm: "CREWAI", config: { external: { framework: "crewai", orchestration: "sequential", versions: { crewai: "1.15.22" } } } }], groups: [{ group: "Q", title: "q", file: FAMILY, familySha256: familySha, tasks: 10 }] }));
	const roles = { expected: ["planner", "retriever", "executor", "summarizer"], seen: ["planner", "retriever", "executor", "summarizer"] };
	write(
		path.join(exp, "rounds.jsonl"),
		jsonl([
			{ arm: "SYN0", group: "Q", round: 1, attempt: 1, valid: true, problems: [], wallMs: 1000, parentUsage: { calls: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, childArtifacts: { children: 1, usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 } }, totals: null, roles, runIds: [], answerBytes: 20 },
			{ arm: "CREWAI", group: "Q", round: 1, attempt: 1, valid: true, problems: [], wallMs: 900, usage: { input: 400, output: 40, cacheRead: 5, cacheWrite: 0 }, parentUsage: null, totals: null, roles, runIds: [], answerBytes: 20, memory: "N/A", external: { framework: "crewai", perRole: {} } },
		]),
	);
	// SYN0: one child transcript, the parent's RPC log.
	const piEvidence = path.join(exp, "evidence", "SYN0", "Q", "round-01", "attempt-1");
	write(path.join(piEvidence, "answer.md"), "ANSWER: Jin dynasty\n");
	write(path.join(piEvidence, "pi-rpc.log"), jsonl([{ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 0 }, content: [{ type: "toolCall", name: "subagent", arguments: { task: "plan it" } }] } }, { type: "tool_execution_end", toolName: "subagent", result: { content: [{ type: "text", text: "the plan" }] } }]));
	write(path.join(exp, "tmp", "SYN0-Q-1-1", "artifacts", "run_planner_transcript.jsonl"), jsonl([{ recordType: "message", message: { role: "user", content: "plan it" } }, { recordType: "message", message: { role: "assistant", content: [{ type: "text", text: "the plan" }], usage: { input: 200, output: 20, cacheRead: 0 } } }]));
	// CREWAI: the harness's hand-overs and the proxy's call log.
	const extEvidence = path.join(exp, "evidence", "CREWAI", "Q", "round-01", "attempt-1");
	write(path.join(extEvidence, "answer.md"), "ANSWER: Jin dynasty\n");
	write(path.join(extEvidence, "handoffs.jsonl"), jsonl([{ from: "user", to: "planner", kind: "task", bytes: 4, text: "task" }, { from: "user", to: "retriever", kind: "task", bytes: 4, text: "task" }, { from: "planner", to: "retriever", kind: "context", bytes: 8, text: "the plan" }]));
	write(path.join(extEvidence, "llm-calls.jsonl"), jsonl([{ role: "planner", path: "/chat/completions", usage: { input: 150, output: 20, cacheRead: 5, cacheWrite: 0 }, response: { content: "the plan" } }, { role: "retriever", path: "/chat/completions", usage: { input: 250, output: 20, cacheRead: 0, cacheWrite: 0 }, response: { content: "evidence" } }]));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("aggregate: external tokens come from the proxy usage, parent is N/A, SYNAPSE metrics are N/A, the pair is compared", () => {
	run("experiments/bench/aggregate.mjs", exp);
	const summary = JSON.parse(fs.readFileSync(path.join(exp, "summary.json"), "utf-8"));
	assert.equal(summary.overall.CREWAI.tokens.total, 440);
	assert.equal(summary.overall.CREWAI.tokens.parent.total, "N/A");
	assert.deepEqual(summary.overall.CREWAI.tokens.child.sources, ["proxy-usage"]);
	assert.equal(summary.overall.CREWAI.memory.queries, "N/A");
	assert.equal(summary.overall.SYN0.tokens.total, 330);
	assert.equal(summary.comparisons["CREWAI-SYN0"].tokens.diff, 110);
	assert.match(fs.readFileSync(path.join(exp, "report.md"), "utf-8"), /CREWAI = crewai（sequential）/);
});

test("edge-bytes: external down is every recorded delivery; up and pull are 0", () => {
	run("experiments/analysis/edge-bytes.mjs", exp);
	const rows = fs.readFileSync(path.join(exp, "edge-bytes", "rounds.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const crew = rows.find((row) => row.arm === "CREWAI");
	assert.deepEqual([crew.down.bytes, crew.up.bytes, crew.pull.bytes, crew.handoffs], [16, 0, 0, 3]);
	const pi = rows.find((row) => row.arm === "SYN0");
	assert.deepEqual([pi.down.bytes, pi.up.bytes], [7, 8]);
	const summary = JSON.parse(fs.readFileSync(path.join(exp, "edge-bytes", "summary.json"), "utf-8"));
	assert.equal(summary.comparisons["CREWAI-SYN0"].diff, 16 - 15);
});

test("agent-split: external roles are split from the call log, with no parent row", () => {
	const out = run("experiments/analysis/agent-split.mjs", exp);
	const crewSection = out.split("### CREWAI")[1].split("###")[0];
	assert.match(crewSection, /\| planner \|/);
	assert.match(crewSection, /\| retriever \|/);
	assert.doesNotMatch(crewSection, /\| parent \|/);
});

test("score-public: the external arm's answer is scored like any other", () => {
	run("experiments/analysis/score-public.mjs", exp);
	const summary = JSON.parse(fs.readFileSync(path.join(root, "score-exp", "summary.json"), "utf-8"));
	assert.equal(summary.byArm.Q.CREWAI.em.mean, 1);
	assert.equal(summary.comparisons.Q["CREWAI-SYN0"].em.diff, 0);
});

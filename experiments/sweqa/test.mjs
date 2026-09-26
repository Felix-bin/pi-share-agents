import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeAttempt, attributeSessions, calibrate, commonAffixes, finalizeRun } from "./analyze.mjs";
import { ARMS, PARENT_TOOLS, loadSample, parseRepoCommits, sampleQuestions, shuffledIndices, taskPrompt } from "./matrix.mjs";
import { compare } from "./report.mjs";
import { judgePrompt, judgeTemplate, parseScores, vote } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sweqa-test-"));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const bytes = (text) => Buffer.byteLength(text);

// Chat-completions fixtures in the shape llm-proxy.mjs records.
const sys = (content) => ({ role: "system", content });
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const asst = (text, calls = [], reasoning = "") => ({ role: "assistant", content: text, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls } : {}) });
const tool = (id, content) => ({ role: "tool", tool_call_id: id, content });
const usage = (input, output = 10, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, reasoning: 2 });
let seq = 0;
const call = (messages, response, u = usage(100), model = "deepseek-flash") =>
	({ seq: ++seq, path: "/chat/completions", status: 200, request: { model, messages }, response, usage: u });

const PROMPT = "How does the session serializer work?\n\nThe code is ...";
const WORK = "/tmp/sweqa-work/run/flask#1/share";
const TASK = "Investigate the tagged JSON serializer in flask/src/flask/json/tag.py thoroughly";

function scenario() {
	seq = 0;
	const P = [sys("parent system"), user(PROMPT)];
	const listCall = tc("p1", "subagent", { action: "list" });
	const spawn = tc("p2", "subagent", { agent: "scout", task: TASK });
	const C = [sys(`scout system <cwd>\n${WORK}\n</cwd> tail`), user(`Task: ${TASK}`)];
	const read = tc("c1", "read", { path: "flask/src/flask/json/tag.py" });
	const pull = tc("c2", "synapse_read", { handle: "h1" });
	const calls = [];
	calls.push(call(P, asst("", [listCall])));
	const P2 = [...P, asst("", [listCall]), tool("p1", "agents: scout, worker")];
	calls.push(call(P2, asst("", [spawn]), usage(160)));
	calls.push(call(C, asst("", [read], "think"), usage(300)));
	const C2 = [...C, asst("", [read], "think"), tool("c1", "class TagDict: ...")];
	calls.push(call(C2, asst("", [pull]), usage(340)));
	const C3 = [...C2, asst("", [pull]), tool("c2", "memory: tags are reversible")];
	calls.push(call(C3, asst("FINDINGS: TagDict round-trips"), usage(380)));
	const P3 = [...P2, asst("", [spawn]), tool("p2", "FINDINGS: TagDict round-trips"), user("[notice] scout finished")];
	calls.push(call(P3, asst("The serializer tags values..."), usage(220)));
	return calls;
}

test("sampling is deterministic, stratified and never overwrites", () => {
	assert.deepEqual(shuffledIndices(48, 7), shuffledIndices(48, 7));
	assert.notDeepEqual(shuffledIndices(48, 7), shuffledIndices(48, 8));
	assert.deepEqual([...shuffledIndices(10, 3)].sort((a, b) => a - b), [...Array(10).keys()]);
	const dir = temp(), bench = path.join(dir, "Benchmark");
	for (const name of ["flask", "requests"]) {
		write(path.join(bench, `${name}.jsonl`), Array.from({ length: 6 }, (_, i) => JSON.stringify({ question: `${name} q${i}`, answer: `${name} a${i}` })).join("\n"));
	}
	const repos = parseRepoCommits("https://github.com/pallets/flask 85c5d93\n\nhttps://github.com/psf/requests 46e939b\n");
	const resolve = (repo) => repo.shortCommit.padEnd(40, "0");
	const first = sampleQuestions(bench, repos, resolve), second = sampleQuestions(bench, [...repos].reverse(), resolve);
	assert.equal(first.length, 8);
	assert.deepEqual(first.filter((row) => row.name === "flask"), second.filter((row) => row.name === "flask"));
	assert.equal(new Set(first.map((row) => row.id)).size, 8);
	const row = first[0];
	assert.equal(row.referenceAnswer, row.question.replace(" q", " a"));
	const prompt = taskPrompt(row);
	assert.ok(prompt.startsWith(row.question));
	assert.ok(!prompt.includes(row.referenceAnswer));
	assert.match(prompt, /in the flask\/ directory of this worktree/);
	const file = path.join(dir, "sample.jsonl");
	write(file, first.map((x) => JSON.stringify(x)).join("\n"));
	assert.equal(loadSample(file).length, 8);
	write(file, [first[0], first[0]].map((x) => JSON.stringify(x)).join("\n"));
	assert.throws(() => loadSample(file), /duplicate id/);
});

test("sessions chain by message prefix; the parent is the one holding the task prompt", () => {
	const { sessions, unattributed } = attributeSessions(scenario(), PROMPT);
	assert.equal(unattributed.length, 0);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[0].parent, true);
	assert.deepEqual(sessions[0].calls, [1, 2, 6]);
	assert.deepEqual(sessions[1].calls, [3, 4, 5]);
});

test("dispatch, tokens and communication are measured per session", () => {
	const m = analyzeAttempt({ calls: scenario(), prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	assert.deepEqual(m.problems, []);
	assert.equal(m.dispatch.children, 1);
	assert.equal(m.dispatch.delegationCalls, 2);
	assert.equal(m.dispatch.spawningCalls, 1);
	assert.deepEqual(m.dispatch.byAgent, { scout: 1 });
	const child = m.sessions[1];
	assert.equal(child.agentType, "scout");
	assert.equal(child.spawnedBy, 0);
	assert.equal(m.tokens.parent.prompt, 100 + 160 + 220);
	assert.equal(m.tokens.children.prompt, 300 + 340 + 380);
	assert.equal(m.tokens.total, m.tokens.parent.total + m.tokens.children.total);
	assert.equal(m.tokens.total, 1500 + 60);
	assert.equal(m.comm.downlink.task, bytes(`Task: ${TASK}`));
	assert.equal(m.comm.uplink.results, bytes("FINDINGS: TagDict round-trips"));
	assert.equal(m.comm.uplink.injected, bytes("[notice] scout finished"));
	assert.equal(m.comm.pull, bytes("memory: tags are reversible"));
	assert.equal(m.comm.control, bytes("agents: scout, worker"));
	assert.equal(m.comm.work, bytes("class TagDict: ..."));
	assert.deepEqual(m.comm.unclassified, {});
	assert.equal(m.answer, "The serializer tags values...");
});

test("an attempt without a child, with a foreign model, or with an unattributable call is invalid", () => {
	const calls = scenario();
	const noChild = analyzeAttempt({ calls: calls.filter((c) => ![3, 4, 5].includes(c.seq)), prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	assert.ok(noChild.problems.includes("no child session"));
	const foreign = scenario();
	foreign[3].request.model = "claude-sonnet";
	assert.ok(analyzeAttempt({ calls: foreign, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" }).problems.some((p) => /model/.test(p)));
	const broken = scenario();
	// Same system prompt as the child, history present, but no prefix match: a rewritten context.
	broken.push(call([broken[2].request.messages[0], user("x"), asst("y"), tool("z", "w")], asst("q")));
	const b = analyzeAttempt({ calls: broken, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	assert.ok(b.problems.some((p) => /unattributed/.test(p)));
	const missing = scenario();
	missing[1].usage = "unavailable";
	assert.ok(analyzeAttempt({ calls: missing, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" }).problems.some((p) => /usage/.test(p)));
});

test("a child with inherited history but its own system prompt opens a session", () => {
	const calls = scenario();
	calls.push(call([sys("forked worker system"), user(PROMPT), asst("earlier"), user(`Continue: ${TASK} and more`)], asst("done")));
	const m = analyzeAttempt({ calls, prompt: PROMPT, arm: "tintinweb", workRoot: WORK, repoRoot: "/repo" });
	assert.equal(m.dispatch.children, 2);
	assert.equal(m.sessions[2].inheritedHistory, true);
	assert.ok(!m.problems.some((p) => /unattributed/.test(p)));
});

test("an unmatched child is attributed to the delegation call whose window it started in", () => {
	seq = 0;
	const P = [sys("parent"), user(PROMPT)];
	const wf = tc("p1", "subagent", { workflowScript: "runs.run({agent:'scout'})" });
	const calls = [call(P, asst("", [wf])), call([sys("scout sys"), user("Task: something generated by the script")], asst("r")),
		call([sys('<active_agent name="scout"/>\nscout sys'), user("Task: another generated task")], asst("r"))];
	calls.push(call([...P, asst("", [wf]), tool("p1", "workflow output")], asst("answer")));
	const m = analyzeAttempt({ calls, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	assert.equal(m.sessions[1].spawnedBy, 0);
	assert.equal(m.sessions[1].agentType, "unmatched");
	assert.equal(m.sessions[2].agentType, "scout");
	assert.equal(m.sessions[2].agentTypeSource, "system");
	assert.deepEqual(m.dispatch.byAgent, { unmatched: 1, scout: 1 });
	assert.equal(m.comm.uplink.results, bytes("workflow output"));
	assert.equal(m.dispatch.spawningCalls, 1);
});

test("leak audit invalidates benchmark access and counts out-of-bounds paths", () => {
	seq = 0;
	const P = [sys("parent"), user(PROMPT)];
	const spawn = tc("p1", "subagent", { agent: "scout", task: TASK });
	const C = [sys("scout"), user(`Task: ${TASK}`)];
	const find = tc("c1", "bash", { command: "find / -name '*.py' | head" });
	const peek = tc("c2", "read", { path: "/repo/experiments/data/swe-qa/Benchmark/flask.jsonl" });
	const calls = [call(P, asst("", [spawn])), call(C, asst("", [find])),
		call([...C, asst("", [find]), tool("c1", "/usr/lib/x.py")], asst("", [peek])),
		call([...C, asst("", [find]), tool("c1", "/usr/lib/x.py"), asst("", [peek]), tool("c2", "{}")], asst("done")),
		call([...P, asst("", [spawn]), tool("p1", "done")], asst("answer"))];
	const m = analyzeAttempt({ calls, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	assert.ok(m.problems.includes("possible answer leak"));
	assert.equal(m.audit.leaks.length, 1);
	assert.deepEqual(m.audit.outOfBoundsPaths, ["/", "/repo/experiments/data/swe-qa/Benchmark/flask.jsonl"]);
	// Contents written by the agent and the attempt's own tmp directory are not out-of-bounds access.
	seq = 0;
	const note = tc("c3", "write", { path: "/tmp/own/context.md", content: "a / b and /etc/passwd" });
	const quiet = [call(P, asst("", [spawn])), call(C, asst("", [note])), call([...C, asst("", [note]), tool("c3", "ok")], asst("done")),
		call([...P, asst("", [spawn]), tool("p1", "done")], asst("answer"))];
	const q = analyzeAttempt({ calls: quiet, prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo", ownDirs: ["/tmp/own"] });
	assert.equal(q.audit.outOfBounds, 0);
	assert.deepEqual(q.problems, []);
});

test("system-prompt variable parts and the byte-per-token ratio are computed across the run", () => {
	assert.deepEqual(commonAffixes(["headAAAtail", "headBtail", "headtail"]), { prefix: "head", suffix: "tail" });
	assert.deepEqual(commonAffixes(["aa", "aa"]), { prefix: "aa", suffix: "" });
	const withId = (calls, id) => calls.map((c) => [3, 4, 5].includes(c.seq)
		? { ...c, request: { ...c.request, messages: [sys(c.request.messages[0].content.replace(" tail", ` out /tmp/x/${id}/context.md tail`)), ...c.request.messages.slice(1)] } } : c);
	const a = analyzeAttempt({ calls: withId(scenario(), "0fe695b3-7463-40e5-8a19-dbc18eaa0b29"), prompt: PROMPT, arm: "share", workRoot: WORK, repoRoot: "/repo" });
	const b = analyzeAttempt({ calls: withId(scenario().map((c) => c.seq === 3 || c.seq === 4 || c.seq === 5
		? { ...c, request: { ...c.request, messages: [sys(`scout system RECALLED MEMORY <cwd>\n/tmp/other\n</cwd> tail`), ...c.request.messages.slice(1)] } } : c), "8dafb8f8-f7b2-4e39-8054-68fac57d6358"),
		prompt: PROMPT, arm: "share", workRoot: "/tmp/other", repoRoot: "/repo" });
	const lonely = analyzeAttempt({ calls: scenario(), prompt: PROMPT, arm: "nico", workRoot: WORK, repoRoot: "/repo" });
	const run = finalizeRun([a, b, lonely]);
	assert.equal(a.comm.downlink.system, 0);
	assert.equal(b.comm.downlink.system, bytes("RECALLED MEMORY "));
	assert.equal(lonely.comm.downlink.system, null);
	assert.equal(lonely.comm.partial, true);
	assert.ok(run.ratio.median > 0 && run.ratio.pairs > 0);
	const c = calibrate([{ sessions: [{ pairs: [{ bytes: 30, tokens: 10 }, { bytes: 40, tokens: 10 }, { bytes: 50, tokens: 10 }] }] }]);
	assert.deepEqual(c, { median: 4, q1: 3.5, q3: 4.5, pairs: 3 });
});

test("judge prompt is read verbatim; unparsable votes leave the score unavailable", async () => {
	const dir = temp();
	write(path.join(dir, "Benchmark construction", "score", "llm-as-a-judge.py"), 'x = 1\nprompt = f"""Q: {question}\nR: {reference}\nC: {candidate}\nReply {{"correctness": n}}"""\n');
	const template = judgeTemplate(dir);
	assert.equal(judgePrompt(template, "q", "r", "c"), 'Q: q\nR: r\nC: c\nReply {"correctness": n}');
	const good = '{"correctness": 18, "completeness": 16, "relevance": 20, "clarity": 17, "reasoning": 15}';
	assert.deepEqual(parseScores(`verdict: ${good}`), { correctness: 18, completeness: 16, relevance: 20, clarity: 17, reasoning: 15 });
	assert.equal(parseScores('{"correctness": 21}'), null);
	const replies = [good, "garbage", good.replace("18", "10"), good.replace("18", "14")];
	const scored = await vote(async () => replies.shift() ?? good, 3);
	assert.equal(scored.votes, 3);
	assert.equal(scored.parseFailures, 1);
	assert.equal(scored.correctness, 14);
	assert.equal(scored.total, 14 + 16 + 20 + 17 + 15);
	assert.deepEqual(await vote(async () => "no json", 2), { total: null, votes: 0, parseFailures: 4 });
});

test("pairs use only questions where both arms are valid; rules decide at the CI bounds", () => {
	const attempt = (id, arm, children, total, score, valid = true) => ({ id, arm, score: score === null ? null : { total: score },
		metrics: { valid, problems: valid ? [] : ["x"], wallMs: 1, dispatch: { children }, tokens: { total }, comm: { bytes: { total: total / 10, downlink: 1, uplink: 1, pull: 0 } } } });
	const attempts = [];
	for (const [i, id] of ["q1", "q2", "q3", "q4"].entries()) {
		attempts.push(attempt(id, "share", 1, 1000 + i, 80));
		attempts.push(attempt(id, "nico", 3, 2000 + i, id === "q2" ? null : 80, id !== "q4"));
		attempts.push(attempt(id, "tintinweb", 1, 900 + i, 60));
	}
	const nico = compare(attempts, "nico");
	assert.equal(nico.children.n, 3);
	assert.equal(nico.children.excluded, 1);
	assert.equal(nico.children.meanDiff, -2);
	assert.equal(nico.children.shareFewer, true);
	assert.equal(nico.totalTokens.shareFewer, true);
	assert.equal(nico.score.n, 2);
	assert.equal(nico.score.nonInferior, true);
	const tin = compare(attempts, "tintinweb");
	assert.equal(tin.totalTokens.shareFewer, false);
	assert.equal(tin.score.nonInferior, true);
	assert.equal(tin.children.shareFewer, false);
});

test("runner isolates each arm: tmp worktree, pinned pi on a narrowed PATH, delegation-only tools", () => {
	const dir = temp(), out = path.join(dir, "data"), commit = "c".repeat(40);
	const item = { id: "demo#3", repo: "acme/demo", name: "demo", repoUrl: "https://github.com/acme/demo", commit, shortCommit: "ccccccc",
		sourceIndex: 3, question: "How does demo work?", referenceAnswer: "It demos." };
	write(path.join(out, "sample.jsonl"), `${JSON.stringify(item)}\n`);
	const tree = path.join(dir, "tree");
	write(path.join(tree, "README.md"), "demo\n");
	fs.mkdirSync(path.join(out, "snapshots"), { recursive: true });
	assert.equal(spawnSync("tar", ["-C", tree, "-cf", path.join(out, "snapshots", `demo-${commit}.tar`), "."]).status, 0);
	write(path.join(dir, "fake-extension.js"), "export default function() {}\n");
	for (const arm of ARMS) {
		write(path.join(out, "agent", arm, "installed.json"), JSON.stringify({ entry: path.join(dir, "fake-extension.js"), version: "test" }));
		write(path.join(out, "agent", arm, "models.json"), JSON.stringify({ providers: { deepseek: { api: "openai-completions", models: [{ id: "deepseek-flash" }] } } }));
		for (const bin of ["rg", "fd"]) { write(path.join(out, "agent", arm, "bin", bin), `#!/bin/sh\necho ${bin}-${arm}\n`); fs.chmodSync(path.join(out, "agent", arm, "bin", bin), 0o755); }
	}
	const fakePi = path.join(dir, "fake-pi");
	write(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
import { execSync } from "node:child_process";
if (process.argv.includes("--version")) { console.log("0.87.0"); process.exit(0); }
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; let at; while ((at = input.indexOf("\\n")) >= 0) {
  const line = input.slice(0, at); input = input.slice(at + 1);
  const command = JSON.parse(line);
  if (command.type === "get_state") console.log(JSON.stringify({ id: command.id, type: "response", success: true, data: {} }));
  if (command.type === "prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", success: true }));
    let claude = true;
    try { execSync("command -v claude", { stdio: "pipe", shell: "/bin/sh" }); } catch { claude = false; }
    const facts = { tools: process.argv[process.argv.indexOf("--tools") + 1], repo: fs.existsSync("demo/README.md"), cwd: process.cwd(),
      claude, child: execSync("pi --version", { encoding: "utf8" }).trim(), proxy: process.env.HTTPS_PROXY ?? null,
      rg: execSync("rg", { encoding: "utf8" }).trim(), tmp: process.env.TMPDIR };
    fs.writeFileSync(process.env.TMPDIR + "/artifact.md", "kept");
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(facts) }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
} });
`);
	fs.chmodSync(fakePi, 0o755);
	const id = `fake-${process.pid}`;
	const result = spawnSync(process.execPath, [path.join(here, "run.mjs"), "--out", out, "--id", id, "--pi", fakePi, "--timeout-ms", "5000"],
		{ encoding: "utf8", timeout: 60_000, env: { ...process.env, DEEPSEEK_API_KEY: "unused-in-test", HTTPS_PROXY: "http://127.0.0.1:9" } });
	assert.equal(result.status, 0, result.stderr);
	const runDir = path.join(out, "runs", id);
	for (const arm of ARMS) {
		const evidence = path.join(runDir, "evidence", "demo-3", arm);
		const attempt = JSON.parse(fs.readFileSync(path.join(evidence, "result.json"), "utf8"));
		assert.equal(attempt.problem, null);
		assert.equal(attempt.childPiLaunches, 1);
		const facts = JSON.parse(fs.readFileSync(path.join(evidence, "answer.md"), "utf8"));
		assert.equal(facts.tools, PARENT_TOOLS[arm].join(","));
		assert.equal(facts.repo, true);
		assert.equal(facts.claude, false);
		assert.equal(facts.child, "0.87.0");
		assert.equal(facts.proxy, null);
		assert.equal(facts.rg, `rg-${arm}`);
		assert.equal(facts.tmp, attempt.tmpDir);
		assert.ok(facts.tmp.startsWith(os.tmpdir()) && !facts.tmp.startsWith(facts.cwd));
		assert.equal(fs.readFileSync(path.join(evidence, "tmp", "artifact.md"), "utf8"), "kept");
		assert.equal(fs.existsSync(facts.tmp), false);
		assert.ok(facts.cwd.startsWith(os.tmpdir()) && !facts.cwd.startsWith(path.resolve(here, "../..")));
		assert.equal(fs.existsSync(facts.cwd), false);
		assert.ok(!fs.readFileSync(path.join(evidence, "prompt.md"), "utf8").includes("It demos."));
	}
	const analyzed = spawnSync(process.execPath, [path.join(here, "analyze.mjs"), runDir], { encoding: "utf8" });
	assert.equal(analyzed.status, 0, analyzed.stderr);
	const metrics = JSON.parse(fs.readFileSync(path.join(runDir, "evidence", "demo-3", "share", "metrics.json"), "utf8"));
	assert.equal(metrics.valid, false);
	assert.ok(metrics.problems.includes("no parent session"));
	const reported = spawnSync(process.execPath, [path.join(here, "report.mjs"), runDir], { encoding: "utf8" });
	assert.equal(reported.status, 0, reported.stderr);
	assert.match(fs.readFileSync(path.join(runDir, "report.md"), "utf8"), /\| share \| 0\/1 \|/);
});

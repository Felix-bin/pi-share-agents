// Windows-only tests of the port (node --test experiments/windows/sweqa/test.mjs). The shared matrix, metering,
// scoring and reporting are tested by experiments/openeuler/sweqa/test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeAttempt } from "../../openeuler/sweqa/analyze.mjs";
import { ARMS, MODEL, PARENT_TOOLS } from "../../openeuler/sweqa/matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const skip = process.platform !== "win32" && "Windows only";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sweqa-win-test-"));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

const sys = (content) => ({ role: "system", content });
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const asst = (text, calls = []) => ({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
const tool = (id, content) => ({ role: "tool", tool_call_id: id, content });
let seq = 0;
const call = (messages, response) => ({ seq: ++seq, path: "/chat/completions", status: 200, request: { model: MODEL.id, messages }, response,
	usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });

// One child runs the given tool calls one after another.
function childRun(toolCalls) {
	seq = 0;
	const P = [sys("parent"), user("How does it work?")];
	const spawn = tc("p1", "subagent", { agent: "scout", task: "Investigate the serializer thoroughly please" });
	let C = [sys('<active_agent name="scout"/>'), user("Task: Investigate the serializer thoroughly please")];
	const calls = [call(P, asst("", [spawn]))];
	toolCalls.forEach((t, i) => {
		calls.push(call(C, asst("", [t])));
		C = [...C, asst("", [t]), tool(t.id, `result ${i}`)];
	});
	calls.push(call(C, asst("done")), call([...P, asst("", [spawn]), tool("p1", "done")], asst("answer")));
	return calls;
}

const WORK = "C:\\Users\\u\\AppData\\Local\\Temp\\pi-sweqa\\run\\flask-1\\share";
const REPO = "C:\\Users\\u\\Desktop\\pi-share-agents";

test("the Windows audit folds C:\\x, C:/x and Git Bash /c/x into one path", () => {
	const inside = childRun([
		tc("c1", "read", { path: `${WORK}\\flask\\app.py` }),
		tc("c2", "bash", { command: "cd /c/Users/u/AppData/Local/Temp/pi-sweqa/run/flask-1/share && ls flask" }),
		tc("c3", "grep", { pattern: "x", path: "flask/src" }),
		tc("c4", "read", { path: "c:/users/u/appdata/local/temp/pi-sweqa/run/.tmp/flask-1/share/out.md" }),
	]);
	const quiet = analyzeAttempt({ calls: inside, arm: "share", workRoot: WORK, repoRoot: REPO, pathStyle: "win32",
		ownDirs: ["C:\\Users\\u\\AppData\\Local\\Temp\\pi-sweqa\\run\\.tmp\\flask-1\\share"] });
	assert.equal(quiet.audit.outOfBounds, 0, JSON.stringify(quiet.audit.outOfBoundsPaths));
	assert.deepEqual(quiet.problems, []);

	const outside = childRun([
		tc("c1", "bash", { command: "find /c/ -name '*.py' | head" }),
		tc("c2", "read", { path: "C:\\Windows\\win.ini" }),
		tc("c3", "bash", { command: "ls /usr/bin" }),
	]);
	const loud = analyzeAttempt({ calls: outside, arm: "share", workRoot: WORK, repoRoot: REPO, pathStyle: "win32" });
	assert.equal(loud.audit.outOfBounds, 3);
	assert.deepEqual(loud.audit.outOfBoundsPaths, ["c:/", "c:/windows/win.ini", "/usr/bin"]);
	assert.deepEqual(loud.problems, []);

	for (const peek of [
		tc("c1", "read", { path: `${REPO}\\experiments\\data\\sweqa\\sample.jsonl` }),
		tc("c1", "bash", { command: "cat /c/Users/u/Desktop/pi-share-agents/experiments/README.md" }),
		tc("c1", "read", { path: "C:/USERS/U/DESKTOP/PI-SHARE-AGENTS/EXPERIMENTS/x" }),
	]) {
		const m = analyzeAttempt({ calls: childRun([peek]), arm: "share", workRoot: WORK, repoRoot: REPO, pathStyle: "win32" });
		assert.ok(m.problems.includes("possible answer leak"), peek.function.arguments);
	}
});

test("runner isolates each arm on Windows: tmp worktree, pinned pi on a narrowed PATH, Git Bash, tree cleanup", { skip }, () => {
	const dir = temp(), out = path.join(dir, "data"), commit = "c".repeat(40);
	const item = { id: "demo#3", repo: "acme/demo", name: "demo", repoUrl: "https://github.com/acme/demo", commit, shortCommit: "ccccccc",
		sourceIndex: 3, question: "How does demo work?", referenceAnswer: "It demos." };
	write(path.join(out, "sample.jsonl"), `${JSON.stringify(item)}\n`);
	const tree = path.join(dir, "tree");
	write(path.join(tree, "README.md"), "demo\n");
	fs.mkdirSync(path.join(out, "snapshots"), { recursive: true });
	const tar = path.join(process.env.SystemRoot, "System32", "tar.exe");
	assert.equal(spawnSync(tar, ["-C", tree, "-cf", path.join(out, "snapshots", `demo-${commit}.tar`), "."]).status, 0);
	write(path.join(dir, "fake-extension.js"), "module.exports = function() {};\n");
	for (const arm of ARMS) {
		write(path.join(out, "agent", arm, "installed.json"), JSON.stringify({ entry: path.join(dir, "fake-extension.js"), version: "test" }));
		write(path.join(out, "agent", arm, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: { api: "openai-completions", models: [{ id: MODEL.id }] } } }));
		write(path.join(out, "agent", arm, "settings.json"), JSON.stringify({ packages: [arm.startsWith("share") ? "../../pkg" : `npm:${arm}`] }));
		write(path.join(out, "agent", arm, "sessions", "old.jsonl"), "earlier attempt");
		// Any executable proves PATH resolution; node itself stands in for rg and fd.
		for (const bin of ["rg.exe", "fd.exe"]) { fs.mkdirSync(path.join(out, "agent", arm, "bin"), { recursive: true }); fs.copyFileSync(process.execPath, path.join(out, "agent", arm, "bin", bin)); }
	}
	const fakePi = path.join(dir, "fake-pi.js");
	write(fakePi, `const fs = require("node:fs");
const { execSync, spawnSync } = require("node:child_process");
if (process.argv.includes("--version")) { console.log("0.87.0"); process.exit(0); }
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; let at; while ((at = input.indexOf("\\n")) >= 0) {
  const line = input.slice(0, at); input = input.slice(at + 1);
  const command = JSON.parse(line);
  if (command.type === "get_state") console.log(JSON.stringify({ id: command.id, type: "response", success: true, data: {} }));
  if (command.type === "prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", success: true }));
    const found = (name) => spawnSync("where", [name], { stdio: "pipe" }).status === 0;
    const bash = process.env.ProgramFiles + "\\\\Git\\\\bin\\\\bash.exe";
    const inBash = (script) => execSync(\`"\${bash}" -c "\${script}"\`, { encoding: "utf8" }).trim();
    const facts = { args: process.argv.slice(2), repo: fs.existsSync("demo/README.md"), cwd: process.cwd(),
      claude: found("claude") || found("codex"), child: execSync("pi --version", { encoding: "utf8" }).trim(),
      bashChild: inBash("pi --version"), bashLs: inBash("ls demo"), proxy: process.env.HTTPS_PROXY ?? null,
      rg: execSync("rg --version", { encoding: "utf8" }).trim(), tmp: process.env.TMPDIR, temp: process.env.TEMP, appdata: process.env.APPDATA,
      agent: process.env.PI_CODING_AGENT_DIR, agentFiles: fs.readdirSync(process.env.PI_CODING_AGENT_DIR).sort(),
      packages: JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", "utf8")).packages };
    fs.writeFileSync(process.env.PI_CODING_AGENT_DIR + "/run-history.jsonl", "state");
    fs.writeFileSync(process.env.TMPDIR + "/artifact.md", "kept");
    // A read-only file the agent leaves behind must not stop the copy or the cleanup.
    fs.writeFileSync(process.env.TMPDIR + "/locked.txt", "x"); fs.chmodSync(process.env.TMPDIR + "/locked.txt", 0o444);
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(facts) }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
} });
`);
	const id = `fake-${process.pid}`, workRoot = path.join(dir, "work");
	const result = spawnSync(process.execPath, [path.join(here, "run.mjs"), "--out", out, "--id", id, "--pi", fakePi, "--timeout-ms", "20000", "--work-root", workRoot],
		{ encoding: "utf8", timeout: 120_000, env: { ...process.env, COMMANDCODE_API_KEY: "unused-in-test", HTTPS_PROXY: "http://127.0.0.1:9" } });
	assert.equal(result.status, 0, result.stderr);
	const runDir = path.join(out, "runs", id);
	assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")).platform, "win32");
	for (const arm of ARMS) {
		const evidence = path.join(runDir, "evidence", "demo-3", arm);
		const attempt = JSON.parse(fs.readFileSync(path.join(evidence, "result.json"), "utf8"));
		assert.equal(attempt.problem, null);
		assert.equal(attempt.childPiLaunches, 2);
		const facts = JSON.parse(fs.readFileSync(path.join(evidence, "answer.md"), "utf8"));
		for (const flag of ["-e", "--no-extensions", "--no-skills", "--no-prompt-templates"]) assert.ok(!facts.args.includes(flag), flag);
		assert.equal(facts.args[facts.args.indexOf("--tools") + 1], PARENT_TOOLS[arm].join(","));
		assert.ok(facts.args.includes("--no-context-files"));
		assert.equal(facts.args[facts.args.indexOf("--model") + 1], MODEL.id);
		assert.equal(facts.repo, true);
		assert.equal(facts.claude, false);
		assert.equal(facts.child, "0.87.0");
		assert.equal(facts.bashChild, "0.87.0");
		assert.equal(facts.bashLs, "README.md");
		assert.equal(facts.proxy, null);
		assert.equal(facts.rg, process.version);
		assert.equal(facts.tmp, attempt.tmpDir);
		assert.equal(facts.temp, attempt.tmpDir);
		assert.ok(facts.appdata.startsWith(attempt.tmpDir));
		assert.equal(fs.readFileSync(path.join(evidence, "tmp", "artifact.md"), "utf8"), "kept");
		assert.equal(fs.existsSync(path.join(evidence, "evidence-errors.log")), false);
		assert.equal(fs.existsSync(facts.tmp), false);
		// The agent directory is a per-attempt copy outside the repository, without installed.json or earlier state.
		assert.equal(facts.agent, attempt.agentDir);
		assert.ok(facts.agent.startsWith(workRoot) && !facts.agent.startsWith(repo));
		assert.deepEqual(facts.agentFiles, arm.startsWith("share") ? ["bin", "extensions", "models.json", "settings.json"] : ["bin", "models.json", "settings.json"]);
		assert.deepEqual(facts.packages, [arm.startsWith("share") ? path.join(out, "pkg") : `npm:${arm}`]);
		assert.equal(fs.readFileSync(path.join(evidence, "agent", "run-history.jsonl"), "utf8"), "state");
		assert.equal(fs.existsSync(path.join(evidence, "agent", "bin")), false);
		assert.equal(fs.existsSync(facts.agent), false);
		assert.equal(fs.existsSync(path.join(out, "agent", arm, "run-history.jsonl")), false);
		assert.ok(facts.cwd.startsWith(workRoot));
		assert.equal(fs.existsSync(facts.cwd), false);
		assert.ok(!fs.readFileSync(path.join(evidence, "prompt.md"), "utf8").includes("It demos."));
	}
	assert.equal(fs.existsSync(path.join(workRoot, id)), false);
	const analyze = path.resolve(here, "../../openeuler/sweqa/analyze.mjs"), report = path.resolve(here, "../../openeuler/sweqa/report.mjs");
	const analyzed = spawnSync(process.execPath, [analyze, runDir], { encoding: "utf8" });
	assert.equal(analyzed.status, 0, analyzed.stderr);
	const metrics = JSON.parse(fs.readFileSync(path.join(runDir, "evidence", "demo-3", "share", "metrics.json"), "utf8"));
	assert.ok(metrics.problems.includes("no parent session"));
	const reported = spawnSync(process.execPath, [report, runDir], { encoding: "utf8" });
	assert.equal(reported.status, 0, reported.stderr);
	assert.match(fs.readFileSync(path.join(runDir, "report.md"), "utf8"), /\| share \| 0\/1 \|/);
});

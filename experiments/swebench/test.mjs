import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ARMS, loadInstances, taskPrompt, validPatch } from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const instance = { instance_id: "sample__repo-1", repo: "sample/repo", base_commit: "a".repeat(40), problem_statement: "Fix the regression." };
const diff = "diff --git a/a.py b/a.py\nindex 1234567..abcdef0 100644\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "swebench-test-"));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

test("dataset loader exposes only task inputs and rejects duplicate IDs", () => {
	const dir = temp(), file = path.join(dir, "rows.jsonl");
	write(file, `${JSON.stringify({ ...instance, patch: "gold hidden" })}\n`);
	assert.deepEqual(loadInstances(file), [instance]);
	assert.match(taskPrompt(instance), /Before using repository tools yourself/);
	assert.equal(validPatch(diff), true);
	assert.equal(validPatch(""), false);
	write(file, `${JSON.stringify(instance)}\n${JSON.stringify(instance)}\n`);
	assert.throws(() => loadInstances(file), /duplicate instance_id/);
});

test("export preserves all arms and report keeps missing official scores unavailable", () => {
	const dir = temp(), run = path.join(dir, "run"), evalRoot = path.join(dir, "eval");
	write(path.join(run, "manifest.json"), JSON.stringify({ id: "trial", instances: [instance.instance_id], datasetSha256: "test" }));
	for (const arm of ARMS) {
		write(path.join(run, "evidence", instance.instance_id, arm, "result.json"), JSON.stringify({ valid: true, usage: { total: 17, missing: 0 }, wallMs: 500, observedHandoffBytes: 10 }));
		if (arm !== "nico") write(path.join(run, "evidence", instance.instance_id, arm, "patch.diff"), diff);
	}
	const exported = spawnSync(process.execPath, [path.join(here, "export.mjs"), run], { encoding: "utf8" });
	assert.equal(exported.status, 0, exported.stderr);
	for (const arm of ARMS) {
		const row = JSON.parse(fs.readFileSync(path.join(run, "predictions", `${arm}.jsonl`), "utf8"));
		assert.equal(row.model_patch, arm === "nico" ? "" : diff);
	}
	write(path.join(evalRoot, "trial-share", "deepseek-flash-pi-share", instance.instance_id, "report.json"), '{"resolved":true}');
	write(path.join(evalRoot, "trial-nico", "deepseek-flash-pi-nico", instance.instance_id, "report.json"), '{"resolved":false}');
	const reported = spawnSync(process.execPath, [path.join(here, "report.mjs"), run, evalRoot], { encoding: "utf8" });
	assert.equal(reported.status, 0, reported.stderr);
	const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
	assert.equal(report.arms.share.resolved, 1);
	assert.equal(report.arms.tintinweb.officialEvaluated, 0);
	assert.deepEqual(report.pairs["share-vs-nico"], { shareOnly: 1, baselineOnly: 0, both: 0, neither: 0, unevaluated: 0 });
	assert.equal(report.pairs["share-vs-tintinweb"].unevaluated, 1);
});

test("runner keeps three worktrees isolated and retains an invalid attempt with its patch", () => {
	const dir = temp(), out = path.join(dir, "data"), source = path.join(dir, "source");
	fs.mkdirSync(source);
	const git = (...argv) => {
		const result = spawnSync("git", argv, { cwd: source, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "-q");
	write(path.join(source, "a.txt"), "old\n");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
	const base_commit = git("rev-parse", "HEAD");
	const row = { ...instance, base_commit };
	const dataset = path.join(dir, "dataset.jsonl");
	write(dataset, `${JSON.stringify(row)}\n`);
	const mirror = path.join(out, "repos", "sample__repo.git");
	fs.mkdirSync(path.dirname(mirror), { recursive: true });
	const cloned = spawnSync("git", ["clone", "-q", "--bare", source, mirror], { encoding: "utf8" });
	assert.equal(cloned.status, 0, cloned.stderr);
	for (const arm of ARMS) {
		const folder = path.join(out, "agent", arm);
		write(path.join(folder, "installed.json"), JSON.stringify({ entry: path.join(dir, "fake-extension.js"), version: "test" }));
		write(path.join(folder, "models.json"), JSON.stringify({ providers: { deepseek: { api: "openai-completions", models: [{ id: "deepseek-flash" }] } } }));
	}
	write(path.join(dir, "fake-extension.js"), "export default function() {}\n");
	const fakePi = path.join(dir, "fake-pi");
	write(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("0.87.0"); process.exit(0); }
const tool = process.env.PI_CODING_AGENT_DIR.endsWith("tintinweb") ? "Agent" : "subagent";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; let at; while ((at = input.indexOf("\\n")) >= 0) {
  const line = input.slice(0, at); input = input.slice(at + 1);
  const command = JSON.parse(line);
  if (command.type === "get_state") console.log(JSON.stringify({ id: command.id, type: "response", success: true, data: {} }));
  if (command.type === "prompt") {
    fs.writeFileSync("a.txt", "new\\n");
    console.log(JSON.stringify({ id: command.id, type: "response", success: true }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "one", name: tool, arguments: { task: "inspect" } }] } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "one", toolName: tool, result: { content: [{ type: "text", text: "done" }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
} });
`);
	fs.chmodSync(fakePi, 0o755);
	const result = spawnSync(process.execPath, [path.join(here, "run.mjs"), "--dataset", dataset, "--out", out,
		"--id", "fake", "--pi", fakePi, "--timeout-ms", "5000"], { encoding: "utf8", timeout: 30_000,
		env: { ...process.env, DEEPSEEK_API_KEY: "unused-in-test" } });
	assert.equal(result.status, 0, result.stderr);
	for (const arm of ARMS) {
		const evidence = path.join(out, "runs", "fake", "evidence", row.instance_id, arm);
		const attempt = JSON.parse(fs.readFileSync(path.join(evidence, "result.json"), "utf8"));
		assert.equal(attempt.problem, "missing provider usage");
		assert.equal(attempt.delegationCount, 1);
		assert.match(fs.readFileSync(path.join(evidence, "patch.diff"), "utf8"), /^diff --git /);
	}
});

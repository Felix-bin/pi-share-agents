import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { FRAMEWORKS_PYTHON, externalRole, externalRoles, runExternalAttempt, summarizeCalls } from "../external-arm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_DIR = process.env.PI_PACKAGE_DIR ?? path.resolve(HERE, "..", "..", "..", "..", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent");
const EXHAUSTED = /\b40[123]\b|insufficient|quota/i;

test("externalRole cuts the shared-memory section and contact_supervisor, keeps the rest verbatim", () => {
	const md = ["---", "name: executor", "description: Runs commands", "tools: read, bash, contact_supervisor", "thinking: medium", "---", "", "You are `executor`.", "", "Working rules:", "- Run it.", "- Escalate through `contact_supervisor` when stuck.", "- Report it.", "", "Shared memory, when it is enabled for this session:", "- `synapse_read` first.", "- `synapse_write` after.", "", "Output: the commands."].join("\n");
	const role = externalRole(md);
	assert.deepEqual(role.tools, ["read", "bash"]);
	assert.equal(role.thinking, "medium");
	assert.equal(role.prompt, "You are `executor`.\n\nWorking rules:\n- Run it.\n- Report it.\n\nOutput: the commands.");
});

test("the four shipped roles lose every pi-only mention and keep their tools", () => {
	const roles = externalRoles();
	assert.deepEqual(roles.map((role) => role.name), ["planner", "retriever", "executor", "summarizer"]);
	for (const role of roles) {
		assert.doesNotMatch(role.prompt, /contact_supervisor|synapse_read|synapse_write|Shared memory/);
		assert.ok(role.prompt.startsWith(`You are \`${role.name}\``));
	}
	assert.deepEqual(roles.find((role) => role.name === "executor").tools, ["read", "grep", "find", "ls", "bash"]);
	assert.deepEqual(roles.find((role) => role.name === "planner").tools, ["read", "grep", "find", "ls", "write"]);
});

test("summarizeCalls: totals are null when a successful call reported no usage; errors are counted apart", () => {
	const ok = summarizeCalls([
		{ path: "/chat/completions", role: "planner", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 } },
		{ path: "/chat/completions", role: "planner", error: { status: 500, message: "x" }, usage: "unavailable" },
	]);
	assert.deepEqual(ok.total, { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 });
	assert.equal(ok.perRole.planner.errors, 1);
	const missing = summarizeCalls([{ path: "/chat/completions", role: "planner", usage: "unavailable" }]);
	assert.equal(missing.total, null);
	assert.equal(missing.unavailableCalls, 1);
});

// Scripted upstream: every agent first calls `ls`, then answers in text once it has a tool result.
function startStub(received) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
				received.push(body);
				const system = body.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
				const role = /You are `([a-z]+)`/.exec(system)?.[1] ?? "unknown";
				const last = body.messages.at(-1);
				const toolNames = (body.tools ?? []).map((tool) => tool.function?.name);
				const reply = { id: "x", object: "chat.completion", created: 0, model: body.model, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
				if (body.stream) throw new Error("stub does not stream");
				if (last.role !== "tool" && toolNames.includes("ls")) {
					reply.choices = [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_${role}_${received.length}`, type: "function", function: { name: "ls", arguments: JSON.stringify({ path: "." }) } }] } }];
				} else {
					reply.choices = [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `${role} done. ANSWER: Nanjing` } }];
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(reply));
			});
		});
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

describe("offline end to end", { skip: !fs.existsSync(FRAMEWORKS_PYTHON) && "frameworks venv not built" }, () => {
	let stub;
	let root;
	const received = [];
	before(async () => {
		stub = await startStub(received);
		root = fs.mkdtempSync(path.join(os.tmpdir(), "external-arm-"));
		fs.mkdirSync(path.join(root, "agent"));
		fs.mkdirSync(path.join(root, "work", "musique"), { recursive: true });
		fs.writeFileSync(path.join(root, "work", "musique", "001-Nanjing.md"), "Nanjing was the capital.\n");
	});
	after(() => {
		stub.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	for (const arm of ["CREWAI", "AUTOGEN"]) {
		test(`${arm}: four roles run through proxy and tool server; hand-over recorded as the framework made it`, { timeout: 180_000 }, async () => {
			received.length = 0;
			const evidenceDir = path.join(root, `evidence-${arm}`);
			fs.mkdirSync(evidenceDir);
			const out = await runExternalAttempt({ arm, task: "Which city? End with ANSWER: <city>.", workDir: path.join(root, "work"), agentDir: path.join(root, "agent"), evidenceDir, endpoint: { provider: "stub", baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, model: "stub-model", apiKey: "sk-stub-real" }, piPackageDir: PI_DIR, pathPrepend: null, timeoutMs: 150_000, liveChildren: new Set(), exhaustedPattern: EXHAUSTED, sessionId: `test-${arm}` });
			assert.deepEqual(out.problems, [], fs.existsSync(path.join(evidenceDir, "harness.log")) ? fs.readFileSync(path.join(evidenceDir, "harness.log"), "utf-8").slice(-3000) : "no harness log");
			assert.match(out.answer, /summarizer done\. ANSWER: Nanjing/);
			for (const role of ["planner", "retriever", "executor", "summarizer"]) assert.ok(out.perRole[role]?.calls >= 2, `${role} made ${out.perRole[role]?.calls} calls`);
			assert.equal(out.perRole.unattributed, undefined);
			assert.ok(out.usage.input > 0);
			// Every request carried pi's reasoning_effort for its role (openai format on a non-DeepSeek provider).
			const efforts = new Set(received.map((body) => body.reasoning_effort));
			assert.deepEqual([...efforts].sort(), ["high", "medium"]);
			// The tool really ran in the worktree: a tool result lists the file.
			assert.ok(received.some((body) => body.messages.some((m) => m.role === "tool" && String(m.content).includes("musique"))));
			// No real key anywhere the harness can see or write.
			for (const file of fs.readdirSync(evidenceDir)) assert.equal(fs.readFileSync(path.join(evidenceDir, file), "utf-8").includes("sk-stub-real"), false, file);
			const tasks = out.handoffs.filter((h) => h.kind === "task");
			assert.deepEqual(tasks.map((h) => h.to).sort(), ["executor", "planner", "retriever", "summarizer"]);
			const upstream = out.handoffs.filter((h) => h.kind !== "task");
			if (arm === "CREWAI") {
				// CrewAI default: each later task gets the aggregated outputs of all earlier tasks.
				assert.deepEqual(upstream.map((h) => `${h.from}>${h.to}`), ["planner>retriever", "planner,retriever>executor", "planner,retriever,executor>summarizer"]);
			} else {
				// Group chat broadcast: each agent receives every earlier reply; its own tool calls stay private.
				assert.deepEqual(upstream.map((h) => `${h.from}>${h.to}`), ["planner>retriever", "planner>executor", "retriever>executor", "planner>summarizer", "retriever>summarizer", "executor>summarizer"]);
				const calls = fs.readFileSync(path.join(evidenceDir, "llm-calls.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
				const retrieverFirst = calls.find((call) => call.role === "retriever");
				assert.equal(retrieverFirst.request.messages.some((m) => m.role === "tool" || m.tool_calls), false);
			}
		});
	}
});

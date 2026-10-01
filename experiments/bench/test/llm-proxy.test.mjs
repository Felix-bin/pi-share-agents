import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { mapUsage, piParamProfile, startLlmProxy } from "../llm-proxy.mjs";

const REAL_KEY = "sk-real-secret-0123456789";
let upstream;
let received;
let script;
let dir;

function startUpstream() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : null;
				received.push({ url: req.url, auth: req.headers.authorization, body });
				const next = script.shift();
				next(res, body);
			});
		});
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

beforeEach(async () => {
	received = [];
	script = [];
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-proxy-"));
	upstream = await startUpstream();
});

afterEach(async () => {
	await new Promise((resolve) => upstream.close(resolve));
	fs.rmSync(dir, { recursive: true, force: true });
});

const upstreamUrl = () => `http://127.0.0.1:${upstream.address().port}/v1`;
const readLog = (file) => fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));

async function post(url, body) {
	const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer dummy", "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: response.status, text: await response.text() };
}

test("non-streaming call: relayed unchanged, attributed by path, usage mapped as pi does", async () => {
	const reply = { choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } };
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(reply));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["planner"], logFile });
	const out = await post(`${proxy.baseUrlFor("planner")}/chat/completions`, { model: "m", messages: [{ role: "user", content: "hi" }] });
	await proxy.close();
	assert.equal(out.status, 200);
	assert.deepEqual(JSON.parse(out.text), reply);
	assert.equal(received[0].url, "/v1/chat/completions");
	assert.equal(received[0].auth, `Bearer ${REAL_KEY}`);
	const [entry] = readLog(logFile);
	assert.equal(entry.role, "planner");
	assert.deepEqual(entry.usage, { input: 70, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 0 });
	assert.equal(entry.response.content, "hello");
});

test("streaming call: chunks relayed, include_usage requested, message and usage rebuilt", async () => {
	const events = [
		{ choices: [{ delta: { reasoning_content: "think " } }] },
		{ choices: [{ delta: { content: "par" } }] },
		{ choices: [{ delta: { content: "tial", tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: "tool_calls" }] },
		{ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 5 } },
	];
	const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	script.push((res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse);
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["retriever"], logFile });
	const out = await post(`${proxy.baseUrlFor("retriever")}/chat/completions`, { model: "m", stream: true, messages: [] });
	await proxy.close();
	assert.equal(out.text, sse);
	assert.deepEqual(received[0].body.stream_options, { include_usage: true });
	const [entry] = readLog(logFile);
	assert.equal(entry.response.content, "partial");
	assert.equal(entry.response.reasoning_content, "think ");
	assert.deepEqual(entry.response.tool_calls, [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }]);
	assert.deepEqual(entry.usage, { input: 45, output: 10, cacheRead: 5, cacheWrite: 0, reasoning: 0 });
});

test("a call without a known role prefix is forwarded and counted as unattributed", async () => {
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	});
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "y" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["planner"], logFile });
	await post(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { messages: [] });
	await post(`http://127.0.0.1:${proxy.port}/stranger/v1/chat/completions`, { messages: [] });
	await proxy.close();
	assert.deepEqual(readLog(logFile).map((entry) => entry.role), ["unattributed", "unattributed"]);
	assert.deepEqual(received.map((r) => r.url), ["/v1/chat/completions", "/v1/chat/completions"]);
});

test("an upstream 402 is relayed and recorded with its status and message", async () => {
	script.push((res) => {
		res.writeHead(402, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Insufficient balance" } }));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["planner"], logFile });
	const out = await post(`${proxy.baseUrlFor("planner")}/chat/completions`, { messages: [] });
	await proxy.close();
	assert.equal(out.status, 402);
	const [entry] = readLog(logFile);
	assert.deepEqual(entry.error, { status: 402, message: "Insufficient balance" });
	assert.equal(entry.usage, "unavailable");
	assert.deepEqual(proxy.calls()[0].error, { status: 402, message: "Insufficient balance" });
});

test("the real key never reaches the call log", async () => {
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["planner"], logFile });
	await post(`${proxy.baseUrlFor("planner")}/chat/completions`, { messages: [{ role: "user", content: "q" }] });
	await proxy.close();
	assert.equal(fs.readFileSync(logFile, "utf-8").includes(REAL_KEY), false);
});

test("piParamProfile: openai format sends reasoning_effort only; deepseek adds thinking and needs reasoning_content", () => {
	const efforts = { planner: "high", retriever: "medium" };
	const cc = piParamProfile({ provider: "commandcode", baseUrl: "https://api.commandcode.ai/provider/v1", efforts });
	assert.equal(cc.format, "openai");
	assert.equal(cc.reasoningContent, false);
	assert.deepEqual(cc.paramsFor("planner"), { reasoning_effort: "high" });
	assert.deepEqual(cc.paramsFor("unattributed"), {});
	const ds = piParamProfile({ provider: "deepseek", baseUrl: "https://api.deepseek.com", efforts, extra: { max_tokens: 1000 } });
	assert.equal(ds.format, "deepseek");
	assert.equal(ds.reasoningContent, true);
	assert.deepEqual(ds.paramsFor("retriever"), { max_tokens: 1000, thinking: { type: "enabled" }, reasoning_effort: "medium" });
});

test("per-role params are added to the upstream request and logged", async () => {
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const profile = piParamProfile({ provider: "commandcode", baseUrl: "https://x", efforts: { summarizer: "high" } });
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["summarizer"], logFile, paramsFor: profile.paramsFor });
	await post(`${proxy.baseUrlFor("summarizer")}/chat/completions`, { model: "m", messages: [] });
	await proxy.close();
	assert.equal(received[0].body.reasoning_effort, "high");
	assert.deepEqual(readLog(logFile)[0].added, { reasoning_effort: "high" });
});

test("deepseek: reasoning_content of an earlier response is put back on the matching assistant message, else empty", async () => {
	const toolTurn = { choices: [{ message: { role: "assistant", content: "", reasoning_content: "I should read a", tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(toolTurn));
	});
	script.push((res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	});
	const logFile = path.join(dir, "calls.jsonl");
	const proxy = await startLlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: REAL_KEY, roles: ["retriever"], logFile, reasoningContent: true });
	await post(`${proxy.baseUrlFor("retriever")}/chat/completions`, { messages: [{ role: "user", content: "q" }] });
	await post(`${proxy.baseUrlFor("retriever")}/chat/completions`, {
		messages: [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "earlier answer from another agent" },
			{ role: "assistant", content: "", tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "call_9", content: "file text" },
		],
	});
	await proxy.close();
	const sent = received[1].body.messages;
	assert.equal(sent[1].reasoning_content, "");
	assert.equal(sent[2].reasoning_content, "I should read a");
	assert.equal(sent[3].reasoning_content, undefined);
});

test("mapUsage matches pi-ai parseChunkUsage", () => {
	assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }), { input: 5, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 1 });
	assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 4, cached_tokens: 6 }), { input: 4, output: 4, cacheRead: 6, cacheWrite: 0, reasoning: 0 });
});

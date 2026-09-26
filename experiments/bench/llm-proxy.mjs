/**
 * Recording OpenAI-compatible proxy for the external-framework arms (spec
 * 2026-09-25-synapse-external-framework-arms §5, §6.4, §7.1).
 *
 * One instance per attempt, on 127.0.0.1 and a free port. Each agent of the
 * framework gets its own base URL, `http://127.0.0.1:<port>/<role>/v1`, so every
 * call is attributed to a role by its path; a call without a known role prefix
 * is still forwarded and counted, as `unattributed`. The framework holds a dummy
 * key: the real one lives only here and is put on the upstream request, so a
 * framework that bypassed the proxy would fail authentication instead of going
 * unmetered.
 *
 * Per chat completion the proxy
 *   - adds the model-call parameters pi itself would send for that role on this
 *     provider (`paramsFor(role)`, see piParamProfile), and on DeepSeek puts the
 *     previous turns' `reasoning_content` back on the assistant messages, as pi
 *     does (frameworks drop that field);
 *   - forwards the request, streaming or not, and relays the response unchanged;
 *   - appends one line to the call log: role, the request as sent upstream, the
 *     reconstructed response message, the provider's raw usage and pi's mapping
 *     of it, status and timing. Headers are never logged.
 *
 * Token usage comes from the provider's response only (never a framework's own
 * count). mapUsage is pi-ai's parseChunkUsage (openai-completions.js), so an
 * external arm's input/output/cacheRead mean exactly what a pi arm's do.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

/**
 * pi-ai's parseChunkUsage: cacheRead from prompt_tokens_details.cached_tokens,
 * DeepSeek's prompt_cache_hit_tokens or a top-level cached_tokens; input is the
 * prompt minus cache reads and writes; output is completion_tokens, which
 * already includes reasoning tokens.
 */
export function mapUsage(raw) {
	const promptTokens = raw.prompt_tokens || 0;
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
	const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens || 0;
	return {
		input: Math.max(0, promptTokens - cacheRead - cacheWrite),
		output: raw.completion_tokens || 0,
		cacheRead,
		cacheWrite,
		reasoning: raw.completion_tokens_details?.reasoning_tokens || 0,
	};
}

/**
 * The parameters pi 0.87.0 sends on a chat completion for one role, by
 * provider (pi-ai openai-completions.js getCompat/buildParams):
 *   - DeepSeek (provider "deepseek" or a deepseek.com base URL) uses the
 *     "deepseek" thinking format: thinking {type: enabled} plus reasoning_effort,
 *     and requires reasoning_content on every assistant message;
 *   - any other OpenAI-compatible provider uses the "openai" format:
 *     reasoning_effort only.
 * `extra` carries anything else pi was observed to send (e.g. its max token
 * field) and is applied to every role.
 */
export function piParamProfile({ provider, baseUrl, efforts, extra = {} }) {
	const deepseek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
	return {
		format: deepseek ? "deepseek" : "openai",
		reasoningContent: deepseek,
		paramsFor(role) {
			const effort = efforts[role];
			const params = { ...extra };
			if (effort === undefined) return params;
			if (deepseek) params.thinking = { type: "enabled" };
			params.reasoning_effort = effort;
			return params;
		},
	};
}

const ROLE_PATH = /^\/([a-z][a-z0-9-]*)\/v1(\/.*)?$/;
const PLAIN_PATH = /^\/v1(\/.*)?$/;

/**
 * Starts the proxy. Resolves to { port, baseUrlFor(role), calls(), close() }.
 *
 * @param {object} options
 * @param {string} options.upstreamBaseUrl  provider base URL as in pi's models.json (no trailing /chat/completions)
 * @param {string} options.apiKey           the real key; never logged
 * @param {string[]} options.roles          the role prefixes that attribute a call
 * @param {string} options.logFile          JSONL call log, appended
 * @param {(role: string) => object} [options.paramsFor]  parameters to add per role
 * @param {boolean} [options.reasoningContent]  put reasoning_content back on assistant messages
 */
export async function startLlmProxy({ upstreamBaseUrl, apiKey, roles, logFile, paramsFor = () => ({}), reasoningContent = false }) {
	const upstream = upstreamBaseUrl.replace(/\/+$/, "");
	const known = new Set(roles);
	const summary = [];
	// reasoning_content of past responses, by tool-call ids or by answer text.
	const reasoningByKey = new Map();
	let seq = 0;
	const sockets = new Set();

	const append = (entry) => fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf-8");

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			handle(req, res, Buffer.concat(chunks)).catch((error) => {
				if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `proxy error: ${error instanceof Error ? error.message : String(error)}` } }));
			});
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	async function handle(req, res, rawBody) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const roleMatch = ROLE_PATH.exec(url.pathname);
		const plainMatch = roleMatch === null ? PLAIN_PATH.exec(url.pathname) : null;
		const role = roleMatch !== null && known.has(roleMatch[1]) ? roleMatch[1] : "unattributed";
		const rest = roleMatch !== null ? (roleMatch[2] ?? "") : plainMatch !== null ? (plainMatch[1] ?? "") : url.pathname;
		const target = `${upstream}${rest}${url.search}`;
		const isChat = req.method === "POST" && rest === "/chat/completions";
		const startedAt = Date.now();
		const entry = { seq: ++seq, ts: new Date(startedAt).toISOString(), role, method: req.method, path: rest, status: null, durationMs: null };

		let body = rawBody;
		let request = null;
		if (isChat) {
			request = JSON.parse(rawBody.toString("utf-8"));
			const added = paramsFor(role);
			Object.assign(request, added);
			if (request.stream === true) request.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
			if (reasoningContent) backfillReasoning(request.messages);
			entry.added = added;
			entry.stream = request.stream === true;
			entry.request = request;
			body = Buffer.from(JSON.stringify(request), "utf-8");
		}

		const headers = { authorization: `Bearer ${apiKey}`, "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*" };
		let upstreamResponse;
		try {
			upstreamResponse = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
		} catch (error) {
			entry.status = 0;
			entry.durationMs = Date.now() - startedAt;
			entry.error = { status: 0, message: `network: ${error instanceof Error ? error.message : String(error)}` };
			if (isChat) entry.usage = "unavailable";
			append(entry);
			summary.push(entry);
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: entry.error.message } }));
			return;
		}
		entry.status = upstreamResponse.status;
		const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
		res.writeHead(upstreamResponse.status, { "content-type": contentType });

		const isStream = contentType.includes("text/event-stream");
		let text = "";
		const decoder = new TextDecoder();
		if (upstreamResponse.body !== null) {
			for await (const chunk of upstreamResponse.body) {
				res.write(chunk);
				text += decoder.decode(chunk, { stream: true });
			}
			text += decoder.decode();
		}
		res.end();
		entry.durationMs = Date.now() - startedAt;

		if (upstreamResponse.status >= 400) {
			entry.error = { status: upstreamResponse.status, message: errorMessageOf(text) };
			if (isChat) entry.usage = "unavailable";
		} else if (isChat) {
			const parsed = isStream ? parseStream(text) : parseJson(text);
			entry.response = parsed.message;
			entry.finishReason = parsed.finishReason;
			entry.rawUsage = parsed.usage;
			entry.usage = parsed.usage === null ? "unavailable" : mapUsage(parsed.usage);
			if (reasoningContent) rememberReasoning(parsed.message);
		}
		append(entry);
		summary.push(entry);
	}

	function keysOf(message) {
		const keys = [];
		const ids = (message.tool_calls ?? []).map((call) => call.id).filter(Boolean);
		if (ids.length > 0) keys.push(`tools:${ids.join(",")}`);
		const content = typeof message.content === "string" ? message.content : "";
		if (content.length > 0) keys.push(`text:${createHash("sha256").update(content).digest("hex")}`);
		return keys;
	}

	function rememberReasoning(message) {
		if (message === null || typeof message.reasoning_content !== "string" || message.reasoning_content.length === 0) return;
		for (const key of keysOf(message)) reasoningByKey.set(key, message.reasoning_content);
	}

	// pi: every assistant message carries the reasoning it was produced with, or "".
	function backfillReasoning(messages) {
		for (const message of messages ?? []) {
			if (message.role !== "assistant" || message.reasoning_content !== undefined) continue;
			const found = keysOf(message).map((key) => reasoningByKey.get(key)).find((value) => value !== undefined);
			message.reasoning_content = found ?? "";
		}
	}

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	return {
		port,
		baseUrlFor: (role) => `http://127.0.0.1:${port}/${role}/v1`,
		calls: () => summary.map(({ seq: n, role, path, status, usage, error, durationMs }) => ({ seq: n, role, path, status, usage, error, durationMs })),
		close: () =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

function errorMessageOf(text) {
	try {
		const parsed = JSON.parse(text);
		const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
		if (typeof message === "string") return message.slice(0, 500);
	} catch {
		// not JSON
	}
	return text.slice(0, 500);
}

function parseJson(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { message: null, finishReason: null, usage: null };
	}
	const choice = parsed.choices?.[0];
	const message = choice?.message ?? null;
	return { message, finishReason: choice?.finish_reason ?? null, usage: parsed.usage ?? choice?.usage ?? null };
}

/** Rebuilds the assistant message and the final usage from an SSE body. */
function parseStream(text) {
	let content = "";
	let reasoning = "";
	let finishReason = null;
	let usage = null;
	const calls = new Map();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const data = trimmed.slice(5).trim();
		if (data === "[DONE]" || data.length === 0) continue;
		let chunk;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		if (!chunk.usage && choice.usage) usage = choice.usage;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta ?? {};
		if (typeof delta.content === "string") content += delta.content;
		if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
		for (const call of delta.tool_calls ?? []) {
			const index = call.index ?? calls.size;
			const current = calls.get(index) ?? { id: null, type: "function", function: { name: "", arguments: "" } };
			if (call.id) current.id = call.id;
			if (call.function?.name) current.function.name += call.function.name;
			if (call.function?.arguments) current.function.arguments += call.function.arguments;
			calls.set(index, current);
		}
	}
	const message = { role: "assistant", content };
	if (reasoning.length > 0) message.reasoning_content = reasoning;
	if (calls.size > 0) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
	return { message, finishReason, usage };
}

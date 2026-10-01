#!/usr/bin/env node
/**
 * Serves pi's own coding tools to an external-framework harness (spec
 * 2026-09-25-synapse-external-framework-arms §6.3).
 *
 *   node experiments/bench/tool-server.mjs --pi <pi-coding-agent package dir> \
 *     --cwd <worktree> --session <label>
 *
 * The tools are not ported: this loads the create*ToolDefinition factories the
 * runner's own pi install exports, so names, parameter schemas, descriptions and
 * output are pi's byte for byte. Run as its own process with the arm's cwd and
 * PATH (the runner prepends the Flask venv), so `bash` sees exactly what a pi
 * child's bash sees.
 *
 *   GET  /tools          → [{ name, description, parameters }]
 *   POST /tools/<name>   { arguments } → { text, isError }
 *
 * A tool that throws answers with its error message as the text and
 * isError: true, which is what pi's agent loop hands the model
 * (createErrorToolResult). Prints one line `{"port": N}` once listening.
 */
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (flag) => {
	const at = args.indexOf(flag);
	if (at === -1 || args[at + 1] === undefined) throw new Error(`tool-server: ${flag} is required`);
	return args[at + 1];
};
const piDir = path.resolve(opt("--pi"));
const cwd = path.resolve(opt("--cwd"));
const sessionId = opt("--session");

const pi = await import(pathToFileURL(path.join(piDir, "dist", "index.js")).href);
const definitions = [
	pi.createReadToolDefinition(cwd),
	pi.createGrepToolDefinition(cwd),
	pi.createFindToolDefinition(cwd),
	pi.createLsToolDefinition(cwd),
	pi.createWriteToolDefinition(cwd),
	pi.createBashToolDefinition(cwd),
];
const byName = new Map(definitions.map((definition) => [definition.name, definition]));
// bash exports PI_SESSION_ID (and PI_SESSION_FILE when there is one) from ctx.sessionManager; nothing else of a session is needed.
const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } };
let callSeq = 0;

const textOf = (content) => (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", async () => {
		const reply = (status, value) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === "/tools") {
			reply(200, definitions.map(({ name, description, parameters }) => ({ name, description, parameters })));
			return;
		}
		const match = /^\/tools\/([a-z]+)$/.exec(url.pathname);
		const definition = match === null ? undefined : byName.get(match[1]);
		if (req.method !== "POST" || definition === undefined) {
			reply(404, { error: `no such tool endpoint: ${req.method} ${url.pathname}` });
			return;
		}
		let input;
		try {
			input = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}").arguments ?? {};
		} catch (error) {
			reply(400, { error: `bad request body: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		try {
			const result = await definition.execute(`ext-${++callSeq}`, input, undefined, () => {}, ctx);
			reply(200, { text: textOf(result.content), isError: false });
		} catch (error) {
			reply(200, { text: error instanceof Error ? error.message : String(error), isError: true });
		}
	});
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

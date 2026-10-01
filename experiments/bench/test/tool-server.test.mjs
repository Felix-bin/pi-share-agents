import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_DIR = process.env.PI_PACKAGE_DIR ?? path.resolve(HERE, "..", "..", "..", "..", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent");
let dir;
let binDir;
let child;
let base;

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-server-"));
	fs.writeFileSync(path.join(dir, "a.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1} needle${i % 3}`).join("\n"));
	binDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-server-bin-"));
	fs.writeFileSync(path.join(binDir, "only-in-prepended-path"), "#!/bin/sh\necho prepended-ok\n", { mode: 0o755 });
	child = spawn(process.execPath, [path.join(HERE, "..", "tool-server.mjs"), "--pi", PI_DIR, "--cwd", dir, "--session", "test-session"], {
		cwd: dir,
		env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await new Promise((resolve, reject) => {
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
			if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).port);
		});
		child.on("exit", (code) => reject(new Error(`tool-server exited ${code}`)));
	});
	base = `http://127.0.0.1:${port}`;
});

after(() => {
	child.kill("SIGTERM");
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(binDir, { recursive: true, force: true });
});

const call = async (name, args) => (await fetch(`${base}/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ arguments: args }) })).json();

test("GET /tools lists pi's six tools with pi's own schema and description", async () => {
	const tools = await (await fetch(`${base}/tools`)).json();
	assert.deepEqual(tools.map((tool) => tool.name), ["read", "grep", "find", "ls", "write", "bash"]);
	const pi = await import(pathToFileURL(path.join(PI_DIR, "dist", "index.js")).href);
	const direct = pi.createGrepToolDefinition(dir);
	const grep = tools.find((tool) => tool.name === "grep");
	assert.equal(grep.description, direct.description);
	assert.deepEqual(grep.parameters, JSON.parse(JSON.stringify(direct.parameters)));
});

test("read and grep return exactly what pi's tools return", async () => {
	const pi = await import(pathToFileURL(path.join(PI_DIR, "dist", "index.js")).href);
	const ctx = { cwd: dir };
	const directRead = await pi.createReadToolDefinition(dir).execute("x", { path: "a.txt", offset: 5, limit: 3 }, undefined, undefined, ctx);
	assert.equal((await call("read", { path: "a.txt", offset: 5, limit: 3 })).text, directRead.content[0].text);
	const directGrep = await pi.createGrepToolDefinition(dir).execute("y", { pattern: "needle2", limit: 4 }, undefined, undefined, ctx);
	assert.equal((await call("grep", { pattern: "needle2", limit: 4 })).text, directGrep.content[0].text);
});

test("bash runs in the worktree with the server's PATH", async () => {
	const out = await call("bash", { command: "pwd; only-in-prepended-path" });
	assert.equal(out.isError, false);
	assert.match(out.text, new RegExp(`${path.basename(dir)}\\n`));
	assert.match(out.text, /prepended-ok/);
});

test("write lands in the worktree", async () => {
	const out = await call("write", { path: "plan.md", content: "step 1" });
	assert.equal(out.isError, false);
	assert.equal(fs.readFileSync(path.join(dir, "plan.md"), "utf-8"), "step 1");
});

test("a failing tool answers with its error message and isError, as pi's agent loop does", async () => {
	const out = await call("read", { path: "missing.txt" });
	assert.equal(out.isError, true);
	assert.match(out.text, /missing\.txt/);
});

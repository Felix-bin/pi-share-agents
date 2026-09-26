#!/usr/bin/env node
// Install each extension using its documented Pi package source, in an isolated agent directory.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, PACKAGES, sha256 } from "./matrix.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.resolve(process.argv[2] ?? "experiments/data/swebench");
fs.mkdirSync(out, { recursive: true });
const source = path.join(os.homedir(), ".pi", "agent", "models.json");
if (!fs.existsSync(source)) throw new Error(`Pi model catalog missing: ${source}`);
const catalog = JSON.parse(fs.readFileSync(source, "utf8"));
if (!catalog.providers?.deepseek?.models?.some((m) => m.id === "deepseek-flash")) {
	throw new Error("Pi model catalog must contain deepseek/deepseek-flash");
}
for (const arm of ARMS) {
	const agentDir = path.join(out, "agent", arm);
	fs.mkdirSync(agentDir, { recursive: true });
	const packageSource = arm === "share" ? repo : PACKAGES[arm];
	const result = spawnSync("pi", ["install", packageSource], {
		cwd: repo, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 180_000,
	});
	if (result.status !== 0) throw new Error(`pi install ${arm} failed: ${result.stderr || result.stdout || result.error}`);
	// The official model is copied into an isolated catalog. run.mjs substitutes only its URL/key per attempt.
	const model = structuredClone(catalog.providers.deepseek.models.find((m) => m.id === "deepseek-flash"));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { deepseek: {
		api: catalog.providers.deepseek.api, baseUrl: "https://api.deepseek.com", models: [model],
	} } }, null, 2));
	fs.chmodSync(path.join(agentDir, "models.json"), 0o600);
	const packageDir = arm === "share" ? repo : path.join(agentDir, "npm", "node_modules", arm === "nico" ? "pi-subagents" : "@tintinweb/pi-subagents");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	const entry = manifest.pi?.extensions?.[0];
	if (!entry) throw new Error(`${arm} package has no Pi extension entry`);
	const git = arm === "share" ? spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageDir, encoding: "utf8" }) : null;
	const lockFile = path.join(agentDir, "npm", "package-lock.json");
	const info = { arm, packageSource, packageDir, entry: path.resolve(packageDir, entry), version: manifest.version,
		commit: git?.status === 0 ? git.stdout.trim() : null,
		packageLockSha256: fs.existsSync(lockFile) ? sha256(lockFile) : null };
	fs.writeFileSync(path.join(agentDir, "installed.json"), JSON.stringify(info, null, 2));
	console.log(`${arm}: ${manifest.name}@${manifest.version} ${info.commit ?? "npm package"}`);
}

#!/usr/bin/env node
// Installs the three extensions with the pinned Pi CLI, mirrors the SWE-QA repositories at their pinned
// commits as snapshot tarballs, and freezes the stratified sample (spec §2.1, §2.3). Idempotent; never
// replaces an existing sample.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, MODEL, PACKAGES, parseRepoCommits, sampleQuestions, sha256 } from "./matrix.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (flag, fallback) => (argv.includes(flag) ? path.resolve(argv[argv.indexOf(flag) + 1]) : fallback);
const out = opt("--out", path.join(repo, "experiments/data/sweqa"));
const sweqa = opt("--sweqa", path.join(repo, "experiments/data/swe-qa"));
const piCli = opt("--pi", path.resolve(repo, "../pi-web/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
fs.mkdirSync(out, { recursive: true });

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed: ${r.stderr || r.error || r.stdout}`);
	return r.stdout.trim();
}

function installArms() {
	const source = path.join(os.homedir(), ".pi", "agent", "models.json");
	const catalog = JSON.parse(fs.readFileSync(source, "utf8"));
	const provider = catalog.providers?.[MODEL.provider];
	const model = provider?.models?.find((m) => m.id === MODEL.id);
	if (!model) throw new Error(`Pi model catalog must contain ${MODEL.provider}/${MODEL.id}`);
	for (const arm of ARMS) {
		const agentDir = path.join(out, "agent", arm);
		fs.mkdirSync(agentDir, { recursive: true });
		const packageSource = arm === "share" ? repo : PACKAGES[arm];
		run(process.execPath, [piCli, "install", packageSource], { cwd: repo, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 300_000 });
		// Only the model definition is copied, never credentials; run.mjs points it at the recorder per attempt.
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: {
			api: provider.api, baseUrl: "https://api.deepseek.com", models: [structuredClone(model)] } } }, null, 2));
		fs.chmodSync(path.join(agentDir, "models.json"), 0o600);
		// Pi's grep and find tools look for rg and fd in <agentDir>/bin first; --offline forbids downloading them.
		const tools = {};
		for (const bin of ["rg", "fd"]) {
			const from = path.join(os.homedir(), ".pi", "agent", "bin", bin), to = path.join(agentDir, "bin", bin);
			if (!fs.existsSync(from)) throw new Error(`${from} missing: run Pi once online so it fetches ${bin}`);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
			fs.chmodSync(to, 0o755);
			tools[bin] = sha256(to);
		}
		const packageDir = arm === "share" ? repo : path.join(agentDir, "npm", "node_modules", arm === "nico" ? "pi-subagents" : "@tintinweb/pi-subagents");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
		const entry = manifest.pi?.extensions?.[0];
		if (!entry) throw new Error(`${arm} package has no Pi extension entry`);
		const lockFile = path.join(agentDir, "npm", "package-lock.json");
		const info = { arm, packageSource, packageDir, entry: path.resolve(packageDir, entry), version: manifest.version,
			commit: arm === "share" ? run("git", ["rev-parse", "HEAD"], { cwd: repo }) : null,
			packageLockSha256: fs.existsSync(lockFile) ? sha256(lockFile) : null, tools };
		fs.writeFileSync(path.join(agentDir, "installed.json"), JSON.stringify(info, null, 2));
		console.log(`${arm}: ${manifest.name}@${manifest.version} ${info.commit ?? "npm package"}`);
	}
}

// A blobless bare mirror; the pinned tree is checked out once and kept as a tarball without .git.
function snapshot(entry) {
	const mirror = path.join(out, "repos", `${entry.name}.git`);
	if (!fs.existsSync(mirror)) {
		fs.mkdirSync(path.dirname(mirror), { recursive: true });
		run("git", ["clone", "--quiet", "--bare", "--filter=blob:none", entry.repoUrl, mirror]);
	}
	const commit = run("git", [`--git-dir=${mirror}`, "rev-parse", "--verify", `${entry.shortCommit}^{commit}`]);
	const tar = path.join(out, "snapshots", `${entry.name}-${commit}.tar`);
	if (!fs.existsSync(tar)) {
		const tree = fs.mkdtempSync(path.join(os.tmpdir(), `sweqa-${entry.name}-`));
		fs.rmSync(tree, { recursive: true });
		run("git", [`--git-dir=${mirror}`, "worktree", "add", "--quiet", "--detach", tree, commit]);
		try {
			fs.mkdirSync(path.dirname(tar), { recursive: true });
			run("tar", ["-C", tree, "--exclude=./.git", "-cf", `${tar}.partial`, "."]);
			fs.renameSync(`${tar}.partial`, tar);
		} finally {
			run("git", [`--git-dir=${mirror}`, "worktree", "remove", "--force", tree]);
		}
	}
	console.log(`${entry.name}: ${commit}`);
	return { name: entry.name, commit, tar: path.relative(out, tar), tarSha256: sha256(tar) };
}

installArms();
const repos = parseRepoCommits(fs.readFileSync(path.join(sweqa, "repo_commit.txt"), "utf8"));
const snapshots = repos.map(snapshot);
fs.writeFileSync(path.join(out, "snapshots.json"), JSON.stringify(snapshots, null, 2));
const sampleFile = path.join(out, "sample.jsonl");
if (fs.existsSync(sampleFile)) {
	console.log(`sample kept (never replaced): ${sampleFile} ${sha256(sampleFile)}`);
} else {
	const commits = new Map(snapshots.map((s) => [s.name, s.commit]));
	const rows = sampleQuestions(path.join(sweqa, "Benchmark"), repos, (r) => commits.get(r.name));
	fs.writeFileSync(sampleFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	console.log(`sample: ${rows.length} questions, ${sha256(sampleFile)}`);
}

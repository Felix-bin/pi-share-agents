#!/usr/bin/env node
// Windows port of experiments/openeuler/sweqa/prepare.mjs. Installs the pinned Pi CLI and the four arms, mirrors
// the SWE-QA repositories as LF snapshot tarballs, and freezes the sample, which must be byte-identical to the
// openEuler one (spec §2.1–§2.3). Idempotent; never replaces an existing sample.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, MODEL, PACKAGES, SHARE_ARMS, ensureBenchmark, parseRepoCommits, sampleQuestions, sha256 } from "../../openeuler/sweqa/matrix.mjs";

// The Pi CLI of the openEuler runs (spec §2.2), and the sample every run draws from.
export const PI_VERSION = "0.87.0";
export const SAMPLE_SHA256 = "f8087a3beb03993bdb6d5758c528def2f762f1a97f94c51522eae1fb652a9316";
// The model definition the openEuler arms were installed with; the undeclared limits get the frozen values.
export const CATALOG_MODEL = { api: "openai-completions",
	model: { id: MODEL.id, name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], maxTokens: MODEL.maxTokens, contextWindow: MODEL.contextWindow } };

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const opt = (flag, fallback) => (argv.includes(flag) ? path.resolve(argv[argv.indexOf(flag) + 1]) : fallback);
const out = opt("--out", path.join(repo, "experiments/data/sweqa-windows"));
const sweqa = opt("--sweqa", path.join(repo, "experiments/data/swe-qa"));
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed: ${r.stderr || r.error || r.stdout}`);
	return r.stdout.trim();
}

// npm is a .cmd script, which Node only starts through a shell.
function installPi() {
	const prefix = path.join(out, "pi");
	const cli = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	const current = fs.existsSync(cli) ? run(process.execPath, [cli, "--version"]) : null;
	if (current !== PI_VERSION) {
		fs.mkdirSync(prefix, { recursive: true });
		run("npm", ["install", "--prefix", `"${prefix}"`, "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${PI_VERSION}`], { shell: true, timeout: 600_000 });
	}
	const version = run(process.execPath, [cli, "--version"]);
	if (version !== PI_VERSION) throw new Error(`pinned Pi ${PI_VERSION} expected, found ${version}`);
	console.log(`pi: ${version} ${cli}`);
	return cli;
}

function installArms(piCli) {
	for (const arm of ARMS) {
		const agentDir = path.join(out, "agent", arm);
		fs.mkdirSync(agentDir, { recursive: true });
		const packageSource = SHARE_ARMS.includes(arm) ? repo : PACKAGES[arm];
		run(process.execPath, [piCli, "install", packageSource], { cwd: repo, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 300_000 });
		// Only the model definition is written, never credentials; run.mjs points it at the recorder per attempt.
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: {
			api: CATALOG_MODEL.api, baseUrl: MODEL.baseUrl, models: [CATALOG_MODEL.model] } } }, null, 2));
		// Pi's grep and find tools look for rg and fd in <agentDir>/bin first; --offline forbids downloading them.
		const tools = {};
		for (const bin of ["rg.exe", "fd.exe"]) {
			const from = path.join(os.homedir(), ".pi", "agent", "bin", bin), to = path.join(agentDir, "bin", bin);
			if (!fs.existsSync(from)) throw new Error(`${from} missing: run Pi once online so it fetches ${bin}`);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
			tools[bin] = sha256(to);
		}
		const packageDir = SHARE_ARMS.includes(arm) ? repo : path.join(agentDir, "npm", "node_modules", arm === "nico" ? "pi-subagents" : "@tintinweb/pi-subagents");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
		const entry = manifest.pi?.extensions?.[0];
		if (!entry) throw new Error(`${arm} package has no Pi extension entry`);
		const lockFile = path.join(agentDir, "npm", "package-lock.json");
		const info = { arm, packageSource, packageDir, entry: path.resolve(packageDir, entry), version: manifest.version,
			commit: SHARE_ARMS.includes(arm) ? run("git", ["rev-parse", "HEAD"], { cwd: repo }) : null,
			packageLockSha256: fs.existsSync(lockFile) ? sha256(lockFile) : null, tools };
		fs.writeFileSync(path.join(agentDir, "installed.json"), JSON.stringify(info, null, 2));
		console.log(`${arm}: ${manifest.name}@${manifest.version} ${info.commit ?? "npm package"}`);
	}
}

// A blobless bare mirror; the pinned tree is checked out once with LF line endings (this machine may set
// core.autocrlf, which would change every byte count) and kept as a tarball without .git.
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
		run("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.longpaths=true", `--git-dir=${mirror}`,
			"worktree", "add", "--quiet", "--detach", tree, commit]);
		try {
			fs.mkdirSync(path.dirname(tar), { recursive: true });
			run(TAR, ["-C", tree, "--exclude=./.git", "--exclude=.git", "-cf", `${tar}.partial`, "."]);
			fs.renameSync(`${tar}.partial`, tar);
		} finally {
			run("git", [`--git-dir=${mirror}`, "worktree", "remove", "--force", tree]);
		}
	}
	console.log(`${entry.name}: ${commit}`);
	return { name: entry.name, commit, tar: path.relative(out, tar), tarSha256: sha256(tar) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	fs.mkdirSync(out, { recursive: true });
	installArms(installPi());
	ensureBenchmark(sweqa, (args) => run("git", ["-c", "core.autocrlf=false", ...args]));
	const repos = parseRepoCommits(fs.readFileSync(path.join(sweqa, "repo_commit.txt"), "utf8"));
	const snapshots = repos.map(snapshot);
	fs.writeFileSync(path.join(out, "snapshots.json"), JSON.stringify(snapshots, null, 2));
	const sampleFile = path.join(out, "sample.jsonl");
	if (!fs.existsSync(sampleFile)) {
		const commits = new Map(snapshots.map((s) => [s.name, s.commit]));
		const rows = sampleQuestions(path.join(sweqa, "Benchmark"), repos, (r) => commits.get(r.name));
		fs.writeFileSync(sampleFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	}
	const digest = sha256(sampleFile);
	if (digest !== SAMPLE_SHA256) throw new Error(`sample ${digest} differs from the openEuler sample ${SAMPLE_SHA256}`);
	console.log(`sample: ${sampleFile} ${digest} (identical to openEuler)`);
}

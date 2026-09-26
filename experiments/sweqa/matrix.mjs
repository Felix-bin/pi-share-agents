import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// share-pipeline is the same package as share, driven by its own role-pipeline prompt template (spec §2.1).
export const ARMS = ["share", "share-pipeline", "nico", "tintinweb"];
export const SHARE_ARMS = ["share", "share-pipeline"];
export const PACKAGES = { share: ".", "share-pipeline": ".", nico: "npm:pi-subagents@0.71.0", tintinweb: "npm:@tintinweb/pi-subagents@0.19.0" };
// Every arm launches its installed package (extensions, skills, prompts); the parent holds only the package's
// delegation tool, and the package does the rest (spec §2.2). tintinweb has no `subagent`: its tool is `Agent`.
export const PARENT_TOOLS = { share: ["subagent"], "share-pipeline": ["subagent"], nico: ["subagent"], tintinweb: ["Agent"] };
// maxTokens is set because the catalog leaves it undeclared (E1 revision 16).
export const MODEL = { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash", thinking: "high",
	baseUrl: "https://api.commandcode.ai/provider/v1", maxTokens: 32768, contextWindow: 1048576 };
export const PER_REPO = 4;
export const SEED = 20260926;

// Tool results are classified by name (spec §3.4). Work tools touch the repository. Spawn tools start
// children; their results are uplink when they did, control (catalogs, guides, status) when they did not.
// Fetch tools return children's results or requests to the caller (uplink). Pull tools fetch shared memory,
// handles or supervisor replies. A tool outside every list is reported as unclassified, never dropped.
export const WORK_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
export const SPAWN_TOOLS = ["subagent", "Agent", "SubagentWorkflow"];
export const FETCH_TOOLS = ["get_subagent_result", "bg_wait", "subagent_supervisor"];
export const PULL_TOOLS = ["synapse_read", "synapse_write", "contact_supervisor", "steer_subagent"];

// "flask#16" → "flask-16": the question id as a directory name.
export const evidenceName = (id) => id.replace(/[^\w.-]/g, "-");

export function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function fnv1a32(text) {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	return hash;
}

export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffledIndices(count, seed) {
	const rng = mulberry32(seed), order = [...Array(count).keys()];
	for (let i = count - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
}

export function parseRepoCommits(text) {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
		const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\s+([0-9a-f]{7,40})$/.exec(line);
		if (!match) throw new Error(`unrecognized repo_commit line: ${line}`);
		return { repoUrl: `https://github.com/${match[1]}/${match[2]}`, owner: match[1], name: match[2], shortCommit: match[3] };
	});
}

// Stratified by repository: each repository's seed depends only on its name (spec §2.3).
export function sampleQuestions(benchmarkDir, repos, resolveCommit, perRepo = PER_REPO) {
	const rows = [];
	for (const repo of repos) {
		const file = path.join(benchmarkDir, `${repo.name}.jsonl`);
		const questions = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
		if (questions.length < perRepo) throw new Error(`${file} has ${questions.length} questions`);
		const commit = resolveCommit(repo);
		if (!/^[0-9a-f]{40}$/.test(commit) || !commit.startsWith(repo.shortCommit)) throw new Error(`bad commit for ${repo.name}: ${commit}`);
		for (const sourceIndex of shuffledIndices(questions.length, (SEED ^ fnv1a32(repo.name)) >>> 0).slice(0, perRepo)) {
			const { question, answer } = questions[sourceIndex];
			if (typeof question !== "string" || !question.trim() || typeof answer !== "string" || !answer.trim()) {
				throw new Error(`${file}:${sourceIndex + 1} lacks question or answer`);
			}
			rows.push({ id: `${repo.name}#${sourceIndex}`, repo: `${repo.owner}/${repo.name}`, name: repo.name, repoUrl: repo.repoUrl,
				commit, shortCommit: repo.shortCommit, sourceIndex, question, referenceAnswer: answer });
		}
	}
	return rows;
}

export function loadSample(file, selected = []) {
	const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
		let row;
		try { row = JSON.parse(line); } catch { throw new Error(`invalid JSON at ${file}:${index + 1}`); }
		for (const key of ["id", "repo", "name", "commit", "shortCommit", "question", "referenceAnswer"]) {
			if (typeof row[key] !== "string" || !row[key].trim()) throw new Error(`missing ${key} at ${file}:${index + 1}`);
		}
		if (!/^[\w.-]+\/[\w.-]+$/.test(row.repo) || row.repo.split("/")[1] !== row.name) throw new Error(`unsafe repo at ${file}:${index + 1}`);
		if (!/^[0-9a-f]{40}$/.test(row.commit)) throw new Error(`invalid commit at ${file}:${index + 1}`);
		return row;
	});
	const ids = new Set();
	for (const row of rows) {
		if (ids.has(row.id)) throw new Error(`duplicate id: ${row.id}`);
		ids.add(row.id);
	}
	if (!selected.length) return rows;
	for (const id of selected) if (!ids.has(id)) throw new Error(`question not in sample: ${id}`);
	return rows.filter((row) => selected.includes(row.id));
}

// The SWE-QA question verbatim and the R-group note (spec §2.4). The reference answer never reaches the prompt.
export function questionText(item) {
	return `${item.question}\n\nThe code is the ${item.repo} repository at commit ${item.shortCommit}, in the ${item.name}/ directory of this worktree. Answer from the code, citing the files and functions involved.`;
}

// share-pipeline invokes the package's own template, which Pi expands; the other arms get the delegation
// condition without being told which tool or pattern to use.
export function taskPrompt(item, arm) {
	if (arm === "share-pipeline") return `/role-pipeline ${questionText(item)}`;
	return `${questionText(item)}\n\nUse the installed subagent extension to delegate the investigation of the repository to child agents. Wait until all of their results are back before you answer, and do not leave background work running. Reply with the complete answer in your final message.`;
}

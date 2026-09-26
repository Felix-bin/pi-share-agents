import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ARMS = ["share", "nico", "tintinweb"];
export const PACKAGES = { share: ".", nico: "npm:pi-subagents@0.71.0", tintinweb: "npm:@tintinweb/pi-subagents@0.19.0" };
// The parent session holds only the extension's delegation tool (spec §2.2).
export const PARENT_TOOLS = { share: ["subagent"], nico: ["subagent"], tintinweb: ["Agent"] };
export const MODEL = { provider: "deepseek", id: "deepseek-flash", thinking: "high" };
export const PER_REPO = 4;
export const SEED = 20260926;

// Tool results are classified by name (spec §3.4). Work tools touch the repository; delegation tools
// return another agent's result to the caller (uplink); pull tools fetch shared memory, handles or
// supervisor replies. A tool outside all three lists is reported as unclassified, never dropped.
export const WORK_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
export const DELEGATION_TOOLS = ["subagent", "Agent", "SubagentWorkflow", "get_subagent_result"];
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

// The SWE-QA question verbatim, the R-group note, then the delegation condition (spec §2.4).
// The reference answer never reaches the prompt.
export function taskPrompt(item) {
	return `${item.question}\n\nThe code is the ${item.repo} repository at commit ${item.shortCommit}, in the ${item.name}/ directory of this worktree. Answer from the code, citing the files and functions involved.\n\nYou can act only through the delegation tool of the installed subagent extension. Delegate the investigation of the repository to child agents and wait for their results in the foreground (blocking); do not leave background work running. When the results are in, reply with the complete answer in your final message.`;
}

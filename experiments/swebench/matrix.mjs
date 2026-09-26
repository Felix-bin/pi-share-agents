import { createHash } from "node:crypto";
import fs from "node:fs";

export const ARMS = ["share", "nico", "tintinweb"];
export const DELEGATION_TOOLS = { share: "subagent", nico: "subagent", tintinweb: "Agent" };
export const PACKAGES = { share: ".", nico: "npm:pi-subagents@0.71.0", tintinweb: "npm:@tintinweb/pi-subagents@0.19.0" };

export function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function loadInstances(file, selected = []) {
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
	const seen = new Set();
	const instances = lines.map((line, index) => {
		let row;
		try { row = JSON.parse(line); } catch { throw new Error(`invalid JSON at ${file}:${index + 1}`); }
		for (const key of ["instance_id", "repo", "base_commit", "problem_statement"]) {
			if (typeof row[key] !== "string" || !row[key].trim()) throw new Error(`missing ${key} at ${file}:${index + 1}`);
		}
		if (!/^[\w.-]+\/[\w.-]+$/.test(row.repo)) throw new Error(`unsafe repo slug at ${file}:${index + 1}: ${row.repo}`);
		if (!/^[a-f0-9]{40}$/.test(row.base_commit)) throw new Error(`invalid base_commit at ${file}:${index + 1}`);
		if (seen.has(row.instance_id)) throw new Error(`duplicate instance_id: ${row.instance_id}`);
		seen.add(row.instance_id);
		return { instance_id: row.instance_id, repo: row.repo, base_commit: row.base_commit, problem_statement: row.problem_statement };
	});
	if (!selected.length) return instances;
	for (const id of selected) if (!seen.has(id)) throw new Error(`instance not in dataset: ${id}`);
	return instances.filter((row) => selected.includes(row.instance_id));
}

export function taskPrompt(instance) {
	return `You are solving SWE-bench instance ${instance.instance_id} in the checked-out repository.\n\nIssue:\n${instance.problem_statement}\n\nBefore using repository tools yourself, use the installed subagent extension to delegate one concrete investigation to a child agent. Wait for its result with foreground/blocking execution. Do not leave background work running. Choose the delegation tool and agent type offered by this extension. After that, edit the repository to solve the issue and run relevant tests when feasible. Do not read benchmark answer files or hidden test patches. Your final reply should briefly state the changes and tests. The grader uses the git diff, not your reply.`;
}

export function validPatch(patch) {
	return typeof patch === "string" && patch.startsWith("diff --git ") && !patch.includes("\0");
}

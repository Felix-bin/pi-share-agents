#!/usr/bin/env node
// Offline metering from the recorder log (spec §3): sessions, dispatch, tokens, communication, audit.
// The same code measures every arm; no extension ledger is read.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, DELEGATION_TOOLS, MODEL, PULL_TOOLS, WORK_TOOLS, evidenceName } from "./matrix.mjs";

const SPAWN_TOOLS = DELEGATION_TOOLS.filter((name) => name !== "get_subagent_result");
const FETCH_TOOLS = DELEGATION_TOOLS.filter((name) => !SPAWN_TOOLS.includes(name));
const usageKeys = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];
const utf8 = (text) => Buffer.byteLength(text ?? "", "utf8");

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

const flat = (text) => text.replace(/\s+/g, " ").trim();
const firstUserText = (messages) => textOf(messages.find((m) => m.role === "user")?.content);
const systemText = (messages) => messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
const hasHistory = (messages) => messages.some((m) => m.role === "assistant" || m.role === "tool");
// Reasoning is left out of the key: it is echoed back optionally and never changes which turn a message is.
const keyOf = (m) => JSON.stringify([m.role, textOf(m.content), (m.tool_calls ?? []).map((c) => [c.id, c.function?.name, c.function?.arguments]), m.tool_call_id ?? null]);
const messageBytes = (m) => utf8(textOf(m.content)) + utf8(m.reasoning_content)
	+ (m.tool_calls ?? []).reduce((n, c) => n + utf8(c.function?.name) + utf8(c.function?.arguments), 0);

function parseArgs(raw) {
	try { return JSON.parse(raw ?? "{}"); } catch { return {}; }
}

// Delegated task texts with their agent names, wherever the extension nests them (task/prompt keys).
function delegatedTasks(args) {
	const out = [];
	const walk = (node, agent) => {
		if (Array.isArray(node)) { for (const item of node) walk(item, agent); return; }
		if (!node || typeof node !== "object") return;
		const own = [node.agent, node.subagent_type, node.agentType].find((x) => typeof x === "string") ?? agent;
		for (const key of ["task", "prompt"]) {
			if (typeof node[key] === "string" && flat(node[key]).length >= 20) out.push({ agent: own ?? null, task: flat(node[key]) });
		}
		for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, own);
	};
	walk(args, null);
	return out;
}

// The parent is the session the attempt's first call opens: no child can start before the parent's first
// response. (share-pipeline's prompt is a template Pi expands, so the prompt text cannot identify it.)
export function attributeSessions(calls) {
	const sessions = [], unattributed = [];
	for (const c of [...calls].sort((a, b) => a.seq - b.seq)) {
		const messages = c.request?.messages ?? [];
		const keys = messages.map(keyOf);
		let best = null;
		for (const s of sessions) {
			const last = s.lastKeys;
			if (last.length < keys.length && last.every((k, i) => k === keys[i]) && (!best || last.length > best.lastKeys.length)) best = s;
		}
		if (best) { best.calls.push(c.seq); best.lastKeys = keys; continue; }
		const system = systemText(messages);
		const inherited = hasHistory(messages);
		if (inherited && sessions.some((s) => s.system === system)) { unattributed.push(c.seq); continue; }
		sessions.push({ index: sessions.length, calls: [c.seq], lastKeys: keys, system, inheritedHistory: inherited,
			firstUser: flat(messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n")),
			parent: false });
	}
	const parent = sessions[0] && !sessions[0].inheritedHistory ? sessions[0] : null;
	if (parent) parent.parent = true;
	const restarts = parent ? sessions.filter((s) => s !== parent && !s.inheritedHistory && s.firstUser === parent.firstUser).length : 0;
	for (const s of sessions) delete s.lastKeys;
	return { sessions, unattributed, parentFound: Boolean(parent), restarts };
}

function sumUsage(list) {
	const out = Object.fromEntries(usageKeys.map((k) => [k, 0]));
	let missing = 0;
	for (const u of list) {
		if (!u || u === "unavailable") { missing++; continue; }
		for (const k of usageKeys) out[k] += u[k] ?? 0;
	}
	const prompt = out.input + out.cacheRead + out.cacheWrite;
	return { ...out, prompt, total: prompt + out.output, missing };
}

const promptTokens = (u) => u.input + u.cacheRead + u.cacheWrite;
const absolutePaths = (text) => [...text.matchAll(/(?:^|[\s"'=:(`])(\/[^\s"'`<>|;&)]*)/g)].map((m) => m[1]);
// Only where a tool is told where to look or act: a shell command, or a path argument. File contents are not paths.
const pathFields = (name, args) => (name === "bash" ? [args.command] : [args.path, args.file_path, args.cwd]).filter((x) => typeof x === "string");
const insideAny = (p, roots) => roots.some((root) => root && (p === root || p.startsWith(`${root}/`)));

export function analyzeAttempt({ calls: allCalls, arm, workRoot, repoRoot, placeholders = [], ownDirs = [] }) {
	const calls = allCalls.filter((c) => c.path === "/chat/completions" && c.request);
	const bySeq = new Map(calls.map((c) => [c.seq, c]));
	const { sessions, unattributed, parentFound, restarts } = attributeSessions(calls);
	const sessionOf = new Map();
	for (const s of sessions) for (const q of s.calls) sessionOf.set(q, s);
	const problems = [];
	if (!parentFound) problems.push("no parent session");
	if (restarts) problems.push(`parent restarted ${restarts} time(s)`);
	if (unattributed.length) problems.push(`unattributed calls: ${unattributed.join(",")}`);
	const foreign = [...new Set(calls.map((c) => c.request.model).filter((m) => m !== MODEL.id))];
	if (foreign.length) problems.push(`foreign model: ${foreign.join(",")}`);

	// Spawning calls and their execution windows (response seq .. the caller's next call).
	const spawns = [];
	for (const s of sessions) s.calls.forEach((q, i) => {
		for (const tcall of bySeq.get(q).response?.tool_calls ?? []) {
			const name = tcall.function?.name;
			if (!SPAWN_TOOLS.includes(name)) continue;
			spawns.push({ id: tcall.id, name, session: s.index, from: q, to: s.calls[i + 1] ?? Infinity,
				tasks: delegatedTasks(parseArgs(tcall.function?.arguments)), children: 0 });
		}
	});
	for (const s of sessions) {
		s.agentType = s.parent ? "parent" : "unmatched";
		s.agentTypeSource = s.parent ? "parent" : "none";
		s.spawnedBy = null;
		if (s.parent) continue;
		const start = s.calls[0];
		const matched = spawns.filter((sp) => sp.from < start && sp.session !== s.index)
			.flatMap((sp) => sp.tasks.filter((t) => s.firstUser.includes(t.task)).map((t) => ({ sp, t }))).at(-1);
		const windowed = spawns.filter((sp) => sp.from < start && start < sp.to && sp.session !== s.index).at(-1);
		const owner = matched?.sp ?? windowed;
		// Pi marks every child prompt with the agent it runs; the delegation arguments are the fallback.
		const declared = /<active_agent name="([^"]+)"\s*\/>/.exec(s.system)?.[1];
		if (declared) [s.agentType, s.agentTypeSource] = [declared, "system"];
		else if (matched?.t.agent) [s.agentType, s.agentTypeSource] = [matched.t.agent, "task"];
		else if (owner && new Set(owner.tasks.map((t) => t.agent)).size === 1 && owner.tasks[0]?.agent) [s.agentType, s.agentTypeSource] = [owner.tasks[0].agent, "task"];
		if (owner) { s.spawnedBy = owner.session; owner.children++; }
	}
	const depthOf = (s) => (s.spawnedBy === null ? (s.parent ? 0 : 1) : 1 + depthOf(sessions[s.spawnedBy]));
	const spawnedCall = new Map(spawns.map((sp) => [sp.id, sp.children > 0]));

	const comm = { downlink: { task: 0, injected: 0, system: 0 }, uplink: { results: 0, injected: 0 }, pull: 0, control: 0, work: 0, unclassified: {}, partial: false };
	const audit = { leaks: [], outOfBounds: 0, outOfBoundsPaths: [], projectInstructions: 0 };
	const inside = [workRoot, ...ownDirs];
	const leakPattern = new RegExp(`${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/experiments|swe-qa|sample\\.jsonl|llm-as-a-judge`, "i");
	for (const s of sessions) {
		const own = s.calls.map((q) => bySeq.get(q));
		s.usage = sumUsage(own.map((c) => c.usage));
		s.depth = depthOf(s);
		if (s.system.includes("<project_instructions")) audit.projectInstructions++;
		const first = own[0].request.messages;
		if (!s.parent) comm.downlink.task += first.filter((m) => m.role !== "system").reduce((n, m) => n + utf8(textOf(m.content)), 0);
		s.pairs = [];
		for (let i = 1; i < own.length; i++) {
			const prev = own[i - 1].request.messages, cur = own[i].request.messages, added = cur.slice(prev.length);
			const names = new Map(cur.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function?.name])));
			for (const m of added) {
				const size = utf8(textOf(m.content));
				if (m.role === "user" || m.role === "system") {
					if (s.parent) comm.uplink.injected += size; else comm.downlink.injected += size;
				} else if (m.role === "tool") {
					const name = names.get(m.tool_call_id);
					if (SPAWN_TOOLS.includes(name)) { if (spawnedCall.get(m.tool_call_id)) comm.uplink.results += size; else comm.control += size; }
					else if (FETCH_TOOLS.includes(name)) comm.uplink.results += size;
					else if (PULL_TOOLS.includes(name)) comm.pull += size;
					else if (WORK_TOOLS.includes(name)) comm.work += size;
					else comm.unclassified[name ?? "?"] = (comm.unclassified[name ?? "?"] ?? 0) + size;
				}
			}
			const [u0, u1] = [own[i - 1].usage, own[i].usage];
			if (u0 && u1 && u0 !== "unavailable" && u1 !== "unavailable") {
				const tokens = promptTokens(u1) - promptTokens(u0), size = added.reduce((n, m) => n + messageBytes(m), 0);
				if (tokens > 0 && size > 0) s.pairs.push({ bytes: size, tokens });
			}
		}
		for (const c of own) for (const tcall of c.response?.tool_calls ?? []) {
			if (!WORK_TOOLS.includes(tcall.function?.name)) continue;
			const args = tcall.function?.arguments ?? "";
			const masked = inside.reduce((text, root) => (root ? text.split(root).join("<own>") : text), args);
			if (leakPattern.test(masked)) audit.leaks.push({ seq: c.seq, tool: tcall.function.name, args: args.slice(0, 300) });
			for (const p of pathFields(tcall.function.name, parseArgs(args)).flatMap(absolutePaths)) {
				if (insideAny(p, inside) || p.startsWith("/dev/")) continue;
				audit.outOfBounds++;
				if (audit.outOfBoundsPaths.length < 20 && !audit.outOfBoundsPaths.includes(p)) audit.outOfBoundsPaths.push(p);
			}
		}
		// Per-attempt strings become placeholders so that the static part of a prompt is comparable across attempts.
		let normalized = s.system;
		for (const [value, mark] of [[workRoot, "<work>"], ...placeholders]) if (value) normalized = normalized.split(value).join(mark);
		s.systemNormalized = normalized.replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, "<date>")
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\bcall_\d+_[A-Za-z0-9]+/g, "<call>");
		s.groupKey = `${arm}|${s.agentType !== "unmatched" ? s.agentType : `head:${createHash("sha256").update(s.systemNormalized.slice(0, 200)).digest("hex").slice(0, 12)}`}`;
		delete s.system;
	}
	const children = sessions.filter((s) => !s.parent);
	const missing = sessions.reduce((n, s) => n + s.usage.missing, 0);
	if (missing) problems.push(`missing usage: ${missing} call(s)`);
	if (parentFound && children.length === 0) problems.push("no child session");
	if (audit.leaks.length) problems.push("possible answer leak");
	const byAgent = {}, tokensByAgent = {};
	for (const s of children) {
		byAgent[s.agentType] = (byAgent[s.agentType] ?? 0) + 1;
		(tokensByAgent[s.agentType] ??= []).push(...s.calls.map((q) => bySeq.get(q).usage));
	}
	const parentSession = sessions.find((s) => s.parent);
	const parentCalls = parentSession ? parentSession.calls.map((q) => bySeq.get(q)) : [];
	return {
		arm, problems, sessions, unattributed,
		dispatch: { children: children.length, byAgent, maxDepth: Math.max(0, ...children.map((s) => s.depth)),
			delegationCalls: spawns.filter((sp) => sp.session === parentSession?.index).length,
			spawningCalls: spawns.filter((sp) => sp.session === parentSession?.index && sp.children > 0).length },
		tokens: { parent: sumUsage(parentCalls.map((c) => c.usage)), children: sumUsage(children.flatMap((s) => s.calls.map((q) => bySeq.get(q).usage))),
			byAgent: Object.fromEntries(Object.entries(tokensByAgent).map(([k, v]) => [k, sumUsage(v)])),
			total: sumUsage(calls.map((c) => c.usage)).total },
		comm, audit,
		answer: textOf(parentCalls.at(-1)?.response?.content),
	};
}

export function commonAffixes(texts) {
	if (!texts.length) return { prefix: "", suffix: "" };
	let prefix = texts[0];
	for (const t of texts) { let i = 0; while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++; prefix = prefix.slice(0, i); }
	const room = Math.min(...texts.map((t) => t.length - prefix.length));
	let n = 0;
	while (n < room && texts.every((t) => t[t.length - 1 - n] === texts[0][texts[0].length - 1 - n])) n++;
	return { prefix, suffix: n ? texts[0].slice(-n) : "" };
}

function quantile(sorted, q) {
	const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function calibrate(attempts) {
	const ratios = attempts.flatMap((a) => a.sessions.flatMap((s) => s.pairs.map((p) => p.bytes / p.tokens))).sort((x, y) => x - y);
	if (!ratios.length) return { median: null, q1: null, q3: null, pairs: 0 };
	const round = (x) => Math.round(x * 1000) / 1000;
	return { median: round(quantile(ratios, 0.5)), q1: round(quantile(ratios, 0.25)), q3: round(quantile(ratios, 0.75)), pairs: ratios.length };
}

// Run-level pass: static system-prompt affixes per (arm, agent type), then the pooled byte/token ratio.
export function finalizeRun(attempts) {
	const groups = new Map();
	for (const a of attempts) for (const s of a.sessions) if (!s.parent) {
		if (!groups.has(s.groupKey)) groups.set(s.groupKey, []);
		groups.get(s.groupKey).push(s);
	}
	const summary = {};
	for (const [key, list] of groups) {
		if (list.length < 2) { for (const s of list) s.systemVariable = null; summary[key] = { sessions: 1, staticBytes: null }; continue; }
		const { prefix, suffix } = commonAffixes(list.map((s) => s.systemNormalized));
		for (const s of list) s.systemVariable = utf8(s.systemNormalized) - utf8(prefix) - utf8(suffix);
		summary[key] = { sessions: list.length, staticBytes: utf8(prefix) + utf8(suffix) };
	}
	const ratio = calibrate(attempts);
	for (const a of attempts) {
		const children = a.sessions.filter((s) => !s.parent);
		a.comm.partial = children.some((s) => s.systemVariable === null);
		a.comm.downlink.system = a.comm.partial ? null : children.reduce((n, s) => n + s.systemVariable, 0);
		const down = a.comm.downlink.task + a.comm.downlink.injected + (a.comm.downlink.system ?? 0);
		const up = a.comm.uplink.results + a.comm.uplink.injected;
		a.comm.bytes = { downlink: down, uplink: up, pull: a.comm.pull, total: down + up + a.comm.pull };
		a.comm.tokens = ratio.median ? Object.fromEntries(Object.entries(a.comm.bytes).map(([k, v]) => [k, Math.round(v / ratio.median)])) : null;
		for (const s of a.sessions) { delete s.systemNormalized; }
	}
	return { ratio, systemGroups: summary };
}

function readJsonl(file) {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function main(runDir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
	const attempts = [];
	for (const id of manifest.instances) for (const arm of ARMS) {
		const evidence = path.join(runDir, "evidence", evidenceName(id), arm);
		const resultFile = path.join(evidence, "result.json");
		if (!fs.existsSync(resultFile)) continue;
		const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
		const m = analyzeAttempt({ calls: readJsonl(path.join(evidence, "llm-calls.jsonl")), arm, workRoot: result.workRoot ?? "", repoRoot: manifest.repoRoot, ownDirs: [result.storageRoot, result.tmpDir].filter(Boolean),
			placeholders: [[result.storageRoot, "<storage>"], [result.tmpDir, "<tmp>"], [result.attemptKey, "<attempt>"]] });
		const answer = fs.existsSync(path.join(evidence, "answer.md")) ? fs.readFileSync(path.join(evidence, "answer.md"), "utf8") : "";
		m.problems = [...(result.problem ? [result.problem] : []), ...(answer.trim() ? [] : ["empty answer"]), ...m.problems];
		attempts.push({ id, arm, evidence, wallMs: result.wallMs ?? null, metrics: m });
	}
	const run = finalizeRun(attempts.map((a) => a.metrics));
	for (const a of attempts) {
		a.metrics.valid = a.metrics.problems.length === 0;
		fs.writeFileSync(path.join(a.evidence, "metrics.json"), JSON.stringify({ id: a.id, arm: a.arm, wallMs: a.wallMs, ...a.metrics }, null, 2));
	}
	const out = { runId: manifest.id, attempts: attempts.length, ratio: run.ratio, systemGroups: run.systemGroups };
	fs.writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(out, null, 2));
	console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) { console.error("usage: node analyze.mjs <run-directory>"); process.exit(2); }
	main(path.resolve(process.argv[2]));
}

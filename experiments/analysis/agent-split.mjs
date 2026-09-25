#!/usr/bin/env node
/**
 * Splits every agent's tokens into hand-over and own work.
 *
 *   node experiments/analysis/agent-split.mjs <benchExpDir> [bytesPerToken]
 *
 * For each agent of each valid round (parent and the four roles), the tokens it
 * processed — prompt input plus cacheRead plus output — are split in two:
 *
 *   hand-over  what it read from other agents, weighted by the calls it stayed
 *              in context for (task message, state steer, redeemed memory,
 *              synapse_read pulls; for the parent, the subagent results), plus
 *              what it wrote for them (a child's final output; the parent's
 *              subagent task text);
 *   own work   the rest: fixed overhead (system prompt and tool definitions,
 *              from the first call), tool results and own history, and
 *              reasoning and tool calls.
 *
 * External-framework arms (CREWAI, AUTOGEN) have no parent; each role's calls
 * come from the proxy's llm-calls.jsonl and what it read from others from
 * handoffs.jsonl. Both frameworks deliver an agent's hand-over before its first
 * call, so it stays in context for all of that agent's calls.
 *
 * Pieces of text are converted to tokens at a bytes-per-token ratio; 3.26 was
 * calibrated on smoke5-stage (343 consecutive-call deltas, median 3.12, IQR
 * 2.76–3.48), so every figure carries roughly ±15%. API usage itself gives only
 * per-call totals, which is why the split has to be estimated at all.
 */
import fs from "node:fs";
import path from "node:path";

const D = process.argv[2];
const RATIO = Number(process.argv[3] ?? 3.26);
const B = (t) => Buffer.byteLength(t, "utf-8");
const T = (bytes) => bytes / RATIO;
const textOf = (c) => (Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : typeof c === "string" ? c : "");
const jsonl = (f) => fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l.slice(l.indexOf("{")))]; } catch { return []; } });
const rounds = jsonl(path.join(D, "rounds.jsonl")).filter((r) => r.valid);
const ROLES = ["parent", "planner", "retriever", "executor", "summarizer"];
const agg = {};
const bump = (arm, role, v) => {
	const a = ((agg[arm] ??= { n: 0 })[role] ??= { recv: 0, sent: 0, ctx: 0, prompt: 0, billed: 0, calls: 0, output: 0, fixed: 0 });
	for (const k of Object.keys(v)) a[k] += v[k];
};

function external(r, ev) {
	const handoffs = jsonl(path.join(ev, "handoffs.jsonl"));
	const allCalls = jsonl(path.join(ev, "llm-calls.jsonl")).filter((c) => c.path === "/chat/completions" && c.usage && typeof c.usage === "object");
	for (const role of ROLES.slice(1)) {
		const calls = allCalls.filter((c) => c.role === role);
		const recv = handoffs.filter((h) => h.to === role).reduce((s, h) => s + B(h.text), 0);
		const prompt = calls.reduce((s, c) => s + c.usage.input + c.usage.cacheRead, 0);
		const output = calls.reduce((s, c) => s + c.usage.output, 0);
		const lastText = [...calls].reverse().map((c) => (typeof c.response?.content === "string" ? c.response.content : "")).find((t) => t.length > 0) ?? "";
		const first = calls[0] ? calls[0].usage.input + calls[0].usage.cacheRead : 0;
		bump(r.arm, role, { recv: T(recv), sent: Math.min(T(B(lastText)), output), ctx: T(recv) * calls.length, prompt, billed: calls.reduce((s, c) => s + c.usage.input + c.usage.output, 0), calls: calls.length, output, fixed: Math.max(0, first - T(recv)) * calls.length });
	}
}

for (const r of rounds) {
	(agg[r.arm] ??= { n: 0 }).n += 1;
	const art = path.join(D, "tmp", `${r.arm}-${r.group}-${r.round}-${r.attempt}`, "artifacts");
	const ev = path.join(D, "evidence", r.arm, r.group, `round-${String(r.round).padStart(2, "0")}`, `attempt-${r.attempt}`);
	if (r.external) {
		external(r, ev);
		continue;
	}
	const redeemed = {};
	const mdir = path.join(ev, "metering");
	if (fs.existsSync(mdir)) for (const f of fs.readdirSync(mdir)) for (const e of jsonl(path.join(mdir, f))) if (e.kind === "memory-redeem") redeemed[e.agent] = (redeemed[e.agent] ?? 0) + e.bytes;
	for (const f of fs.readdirSync(art).filter((x) => x.endsWith("_transcript.jsonl"))) {
		const role = f.split("_")[1];
		const msgs = jsonl(path.join(art, f)).filter((e) => e.recordType === "message").map((e) => e.message);
		const pullIds = new Set(jsonl(path.join(art, f)).filter((e) => e.recordType === "tool_start" && e.toolName === "synapse_read").map((e) => e.toolCallId));
		const calls = msgs.filter((m) => m.role === "assistant" && m.usage);
		let recv = redeemed[role] ?? 0, ctx = T(redeemed[role] ?? 0) * calls.length, seenCalls = 0;
		let lastText = "";
		for (const m of msgs) {
			if (m.role === "assistant" && m.usage) { seenCalls += 1; lastText = textOf(m.content) || lastText; continue; }
			const t = textOf(m.content);
			const isHandoff = (m.role === "user" && !t.startsWith("[prompt redacted]")) || (m.role === "toolResult" && (m.toolName === "synapse_read" || pullIds.has(m.toolCallId)));
			if (!isHandoff) continue;
			recv += B(t);
			ctx += T(B(t)) * (calls.length - seenCalls); // stays in context for every later call
		}
		const prompt = calls.reduce((s, c) => s + (c.usage.input ?? 0) + (c.usage.cacheRead ?? 0), 0);
		const billed = calls.reduce((s, c) => s + (c.usage.input ?? 0) + (c.usage.output ?? 0), 0);
		const output = calls.reduce((s, c) => s + (c.usage.output ?? 0), 0);
		// Fixed overhead: what the first call carried besides the hand-over it was given.
		let firstHandoff = redeemed[role] ?? 0;
		for (const m of msgs) {
			if (m.role === "assistant") break;
			const t = textOf(m.content);
			if (m.role === "user" && !t.startsWith("[prompt redacted]")) firstHandoff += B(t);
		}
		const first = calls[0] ? (calls[0].usage.input ?? 0) + (calls[0].usage.cacheRead ?? 0) : 0;
		const fixed = Math.max(0, first - T(firstHandoff)) * calls.length;
		const sent = Math.min(T(B(lastText)), output);
		bump(r.arm, role, { recv: T(recv), sent, ctx, prompt, billed, calls: calls.length, output, fixed });
	}
	// Parent: subagent results it received, subagent task text it wrote.
	const events = jsonl(path.join(ev, "pi-rpc.log"));
	const pcalls = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message.usage);
	let recv = 0, sent = 0, ctx = 0, seen = 0;
	for (const e of events) {
		if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
			seen += 1;
			for (const c of e.message.content ?? []) if (c.type === "toolCall" && c.name === "subagent") sent += B(JSON.stringify(c.arguments ?? {}));
		}
		if (e.type === "tool_execution_end" && e.toolName === "subagent") {
			const b = B(textOf(e.result?.content));
			recv += b;
			ctx += T(b) * (pcalls.length - seen);
		}
	}
	const pOutput = pcalls.reduce((s, c) => s + (c.message.usage.output ?? 0), 0);
	const pFirst = pcalls[0] ? (pcalls[0].message.usage.input ?? 0) + (pcalls[0].message.usage.cacheRead ?? 0) : 0;
	bump(r.arm, "parent", { recv: T(recv), sent: Math.min(T(sent), pOutput), ctx, prompt: pcalls.reduce((s, c) => s + (c.message.usage.input ?? 0) + (c.message.usage.cacheRead ?? 0), 0), billed: pcalls.reduce((s, c) => s + (c.message.usage.input ?? 0) + (c.message.usage.output ?? 0), 0), calls: pcalls.length, output: pOutput, fixed: pFirst * pcalls.length });
}

const k = (n) => `${(n / 1000).toFixed(1)}k`;
const pct = (a, b) => `${((100 * a) / b).toFixed(0)}%`;
console.log(`bytes/token = ${RATIO}; all figures are processed tokens per round (prompt input + cacheRead, plus output)\n`);
const summary = {};
for (const [arm, a] of Object.entries(agg)) {
	console.log(`### ${arm} (n=${a.n}, per round)`);
	console.log("| agent | 总处理量 | **交接** | 其中：读交接 / 写交接 | **自己干活** | 其中：固定开销 / 工具结果与自身历史 / 推理与工具调用 | 交接占比 |");
	console.log("|---|---|---|---|---|---|---|");
	const tot = { total: 0, handoff: 0, own: 0 };
	for (const role of ROLES) {
		const x = a[role];
		if (!x) continue;
		const total = x.prompt + x.output;
		const handoff = x.ctx + x.sent;
		const own = total - handoff;
		const fixed = Math.min(x.fixed, x.prompt - x.ctx);
		const toolsHistory = x.prompt - x.ctx - fixed;
		const reasoning = x.output - x.sent;
		tot.total += total; tot.handoff += handoff; tot.own += own;
		console.log(`| ${role} | ${k(total / a.n)} | **${k(handoff / a.n)}** | ${k(x.ctx / a.n)} / ${k(x.sent / a.n)} | **${k(own / a.n)}** | ${k(fixed / a.n)} / ${k(toolsHistory / a.n)} / ${k(reasoning / a.n)} | ${pct(handoff, total)} |`);
	}
	console.log(`| **合计** | ${k(tot.total / a.n)} | **${k(tot.handoff / a.n)}** | | **${k(tot.own / a.n)}** | | ${pct(tot.handoff, tot.total)} |\n`);
	summary[arm] = { handoff: tot.handoff / a.n, own: tot.own / a.n, total: tot.total / a.n };
}
console.log("| 臂 | 总处理量 | 交接 | 自己干活 | 交接占比 |\n|---|---|---|---|---|");
for (const [arm, x] of Object.entries(summary)) console.log(`| ${arm} | ${k(x.total)} | ${k(x.handoff)} | ${k(x.own)} | ${pct(x.handoff, x.total)} |`);

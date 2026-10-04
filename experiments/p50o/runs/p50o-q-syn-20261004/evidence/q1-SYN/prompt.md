---
description: Run the four-role pipeline with truncated handovers (each stage still runs; upstream blocks pass on truncated)
---

Run the four-role collaboration pipeline on the task below with exactly one `subagent` call. The workflow is fixed: all four stages run; what changes is that downstream stages receive truncated upstream blocks — the full text stays behind the handle, and a stage that needs the details can redeem them. Do not list agents, read guides, validate, or write a script of your own. Call `subagent` with `async: false`, `args: { "task": <the task text below, verbatim> }` and this `workflowScript`, unchanged:

```js
const task = args.task;
const query = "State query: " + task.split("\n")[0];
const trunc = (s, keep = 10, tail = 4) => {
	const ls = String(s ?? "").split("\n");
	if (ls.length <= keep + tail + 2) return String(s ?? "");
	return [...ls.slice(0, keep), `…(${ls.length - keep - tail} lines truncated; full text stays behind the handle)…`, ...ls.slice(-tail)].join("\n");
};
const launch = (key, agent, lines) => runs.run(key, { agent, acceptance: false, output: false, completionGuard: false, task: lines.join("\n") });
const stage = (agent, lines) => launch(agent, agent, lines).catch(() => launch(agent + "-retry", agent, lines));
const plan = await stage("planner", [task]);
const planBlock = trunc(plan.output, 12, 2);
const evidence = await stage("retriever", [query, "", "Plan:", planBlock]);
const results = await stage("executor", ["Plan:", planBlock, "", "Evidence:", trunc(evidence.output, 20, 4)]);
const summary = await stage("summarizer", ["Task:", task, "", "Evidence:", trunc(evidence.output, 14, 3), "", "Executed results:", trunc(results.output, 10, 3)]);
return summary.output;
```

A stage that fails is re-run once in a fresh child. Each stage is a fresh child: the planner sees only the task, the retriever the state query (embedded by the host) and the truncated plan, the executor the truncated plan and the full evidence, the summarizer the task plus truncated evidence and results. When shared memory is in `synapse` mode a stage's output is a `[SYNAPSE result]` block with a handle: truncation keeps the block head and tail (the handle) and drops only middle lines, so a stage that needs the details can still redeem them by handle.

When the call returns, reply with the summarizer's answer to the task in the form the task asks for (keep any required final line exactly as the summarizer wrote it, as plain text with no markdown around it), then at most three short lines on what the stages could not establish. Do not re-run a stage or read handles yourself.

Task:

When did the city where the Yongle emperor greeted the person to whom the edict was addressed become the Chinese national capital?

Answer using only the documents in the musique/ directory of this worktree (each file holds one source paragraph). Put your final answer on the last line as `ANSWER: <short answer only — the entity, number or phrase itself, no explanation>`.

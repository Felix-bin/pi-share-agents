---
description: Ablation arm — four-role pipeline identical to opt-pipeline except handovers pass full text (no truncation; compression removed)
---

Run the four-role collaboration pipeline on the task below with exactly one `subagent` call. The workflow is fixed: all four stages run; downstream stages receive the full text of upstream blocks (this is the no-compression ablation of the truncated-handover pipeline). Do not list agents, read guides, validate, or write a script of your own. Call `subagent` with `async: false`, `args: { "task": <the task text below, verbatim> }` and this `workflowScript`, unchanged:

```js
const task = args.task;
const query = "State query: " + task.split("\n")[0];
const trunc = (s) => String(s ?? ""); // ablation: identity — no truncation between stages
const launch = (key, agent, lines) => runs.run(key, { agent, acceptance: false, output: false, completionGuard: false, task: lines.join("\n") });
const stage = (agent, lines) => launch(agent, agent, lines).catch(() => launch(agent + "-retry", agent, lines));
const plan = await stage("planner", [task]);
const planBlock = trunc(plan.output, 12, 2);
const evidence = await stage("retriever", [query, "", "Plan:", planBlock]);
const results = await stage("executor", ["Plan:", planBlock, "", "Evidence:", trunc(evidence.output, 100, 6)]);
const summary = await stage("summarizer", ["Task:", task, "", "Evidence:", trunc(evidence.output, 80, 5), "", "Executed results:", trunc(results.output, 60, 5)]);
return summary.output;
```

A stage that fails is re-run once in a fresh child. Each stage is a fresh child: the planner sees only the task, the retriever the state query (embedded by the host) and the full plan, the executor the full plan and the full evidence, the summarizer the task plus the full evidence and results. Stage outputs are `[SYNAPSE result]` blocks with handles as in the production pipeline; only the between-stage compression is removed.

When the call returns, reply with the summarizer's answer to the task in the form the task asks for (keep any required final line exactly as the summarizer wrote it, as plain text with no markdown around it), then at most three short lines on what the stages could not establish. Do not re-run a stage or read handles yourself.

Task:

What is the relationship between the ASCII-only encoding control parameter in the framework's JSON serialization provider and Unicode character representation in serialized output?

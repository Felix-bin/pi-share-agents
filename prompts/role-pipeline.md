---
description: Run the planner → retriever → executor → summarizer pipeline
---

Run the four-role collaboration pipeline on the task below with exactly one `subagent` call. The workflow is fixed; do not list agents, read guides, validate, or write a script of your own. Call `subagent` with `async: false`, `args: { "task": <the task text below, verbatim> }` and this `workflowScript`, unchanged:

```js
const task = args.task;
const query = "State query: " + task.split("\n")[0];
const launch = (key, agent, lines) => runs.run(key, { agent, acceptance: false, output: false, task: lines.join("\n") });
const stage = (agent, lines) => launch(agent, agent, lines).catch(() => launch(agent + "-retry", agent, lines));
const plan = await stage("planner", [task]);
const evidence = await stage("retriever", [query, "", "Plan:", plan.output]);
const results = await stage("executor", ["Plan:", plan.output, "", "Evidence:", evidence.output]);
const summary = await stage("summarizer", ["Task:", task, "", "Plan:", plan.output, "", "Evidence:", evidence.output, "", "Executed results:", results.output]);
return summary.output;
```

A stage that fails is re-run once in a fresh child. Each stage is a fresh child: the planner sees only the task, the retriever the plan (and the state query the host embeds for it), the executor the plan and the evidence, the summarizer everything. When shared memory is in `synapse` mode a stage's output is a `[SYNAPSE result]` block with a handle, so the script passes blocks on as they are: the host hands the executor and the summarizer the full text behind them, and the retriever reads the plan by its handle only if it needs it.

When the call returns, reply with the summarizer's answer to the task in the form the task asks for (keep any required final line exactly as the summarizer wrote it, as plain text with no markdown around it), then at most three short lines on what the stages could not establish. Do not re-run a stage or read handles yourself.

Task:

$@

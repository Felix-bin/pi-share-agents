---
description: Run the naive four-role pipeline with full-text handovers (pure-text baseline, plain roles)
---

Run the four-role collaboration pipeline on the task below with exactly one `subagent` call. The workflow is fixed; do not list agents, read guides, validate, or write a script of your own. Call `subagent` with `async: false`, `args: { "task": <the task text below, verbatim> }` and this `workflowScript`, unchanged:

```js
const task = args.task;
const launch = (key, agent, lines) => runs.run(key, { agent, acceptance: false, output: false, completionGuard: false, task: lines.join("\n") });
const stage = (agent, lines) => launch(agent, agent, lines).catch(() => launch(agent + "-retry", agent, lines));
const plan = await stage("naive-planner", [task]);
const evidence = await stage("naive-retriever", ["Task:", task, "", "Plan:", plan.output]);
const results = await stage("naive-executor", ["Task:", task, "", "Plan:", plan.output, "", "Evidence:", evidence.output, "", "Evidence (verbatim copy for verification):", evidence.output]);
const summary = await stage("naive-summarizer", ["Task:", task, "", "Plan:", plan.output, "", "Evidence:", evidence.output, "", "Executed results:", results.output, "", "Evidence (as handed over above, verbatim):", evidence.output]);
return summary.output;
```

A stage that fails is re-run once in a fresh child. Each stage is a fresh child, and every stage receives the full text of everything before it, passed through verbatim on every handoff — the summarizer additionally receives the evidence a second time, the way a plain-text collaboration without references, handles or deduplication re-sends its material at each step.

When the call returns, reply with the summarizer's answer to the task in the form the task asks for (keep any required final line exactly as the summarizer wrote it, as plain text with no markdown around it), then at most three short lines on what the stages could not establish. Do not re-run a stage yourself.

Task:

What does the method that enables the test helper class representing pathlib.Path objects return when invoked by the standard library path conversion function?

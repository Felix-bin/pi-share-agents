---
description: Run the naive four-role pipeline over a paragraph-pool worktree (pure-text baseline, plain roles, full-pool reading)
---

Run the four-role collaboration pipeline on the task below with exactly one `subagent` call. The workflow is fixed; do not list agents, read guides, validate, or write a script of your own. Call `subagent` with `async: false`, `args: { "task": <the task text below, verbatim> }` and this `workflowScript`, unchanged:

```js
const task = args.task;
const poolNote = "The worktree is a paragraph pool: to gather evidence, list every file in the pool and read each one in full before you conclude — a multi-hop question may rest on any of them.";
const launch = (key, agent, lines) => runs.run(key, { agent, acceptance: false, output: false, completionGuard: false, task: lines.join("\n") });
const stage = (agent, lines) => launch(agent, agent, lines).catch(() => launch(agent + "-retry", agent, lines));
const plan = await stage("naive-planner", [task]);
const evidence = await stage("naive-retriever", ["Task:", task, "", poolNote, "", "Plan:", plan.output]);
const results = await stage("naive-executor", ["Task:", task, "", "Plan:", plan.output, "", "Evidence:", evidence.output]);
const summary = await stage("naive-summarizer", ["Task:", task, "", "Plan:", plan.output, "", "Evidence:", evidence.output, "", "Executed results:", results.output, "", "Evidence (as handed over above, verbatim):", evidence.output]);
return summary.output;
```

A stage that fails is re-run once in a fresh child. Each stage is a fresh child, and every stage receives the full text of everything before it, passed through verbatim on every handoff — the way a plain-text collaboration without references, handles or deduplication re-sends its material at each step.

When the call returns, reply with the summarizer's answer to the task in the form the task asks for (keep any required final line exactly as the summarizer wrote it, as plain text with no markdown around it), then at most three short lines on what the stages could not establish. Do not re-run a stage yourself.

Task:

What was the overwhelming ethnic majority in the city where the Yongle emperor greeted the person to whom the edict was addressed?

Answer using only the documents in the musique/ directory of this worktree (each file holds one source paragraph). Put your final answer on the last line as `ANSWER: <short answer only — the entity, number or phrase itself, no explanation>`.

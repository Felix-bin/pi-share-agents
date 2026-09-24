---
description: Run the planner → retriever → executor → summarizer pipeline
---

Run the four-role collaboration pipeline on the task below. Each stage is a separate subagent with its own context; the stages are ordered because each one consumes what the previous one produced.

1. `planner` — decompose the task into 3 to 6 checkable steps, naming the role that should run each. Pass it the task and nothing else: its job is to decide the shape of the work, not to inherit your conclusions.
2. `retriever` — gather the evidence the plan calls for, from the worktree and from shared memory. Pass it the plan and the specific paths or symbols the plan named. When shared memory is in `synapse` mode, start its task with one line `State query: <the task's own sentence, verbatim>`: the host embeds that line, not the whole plan, as the retrieval state it hands the retriever.
3. `executor` — run the commands the plan calls for and report what actually happened. Pass it the plan and the evidence, not the raw task, so it runs the step rather than reinventing it.
4. `summarizer` — answer the task from what the evidence and results add up to, keeping the uncertainty they carry. Pass it the task, the plan, the evidence and the results: it is the one stage whose output is the deliverable, so it must see what was asked.

Rules for the pipeline:

- Stages run in order, each in a fresh child session. Do not collapse two stages into one agent, and do not skip a stage because you believe you already know its answer — the comparison between the stages is the point.
- Hand over artefacts, not conversation. A stage receives the previous stage's output; it does not receive your reasoning about it.
- If a stage reports that it could not establish something, carry that forward verbatim. A later stage must not quietly upgrade "not established" to "established".
- If shared memory is enabled (`/synapse-setup` reports a mode other than `off`), each child is handed the memory the host recalled for its task automatically, and can record new findings itself. Do not paste memory contents between stages by hand; that is what the store is for.
- Stop the pipeline and report if a stage escalates a decision that blocks the next stage. An unapproved product, architecture or scope decision belongs to me. An ambiguity in how to read the task is not such a decision: the stage picks the reading the worktree supports best, says so, and the pipeline continues. Do not add escalation instructions of your own to a stage's task.
- Keep every stage on the task's goal. Checking a claim serves the answer; it does not replace it — an "introduce" task still ends in an introduction, not an audit.

After the summarizer returns, reply in this order:

1. The answer to the task itself, in the form the task asks for, taken from the summarizer's output and written into your reply — not a path to a file that holds it. Mark what is not established inline, where it bears on the answer.
2. Then, briefly: the plan that was executed, what each stage established, what remains open, and — when shared memory is on — which recalled memories were actually used.

If the pipeline stopped on an escalation, still give the answer as far as the finished stages support it, then state the decision you need from me.

Task:

$@

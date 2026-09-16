---
description: Run the planner → retriever → executor → summarizer pipeline
---

Run the four-role collaboration pipeline on the task below. Each stage is a separate subagent with its own context; the stages are ordered because each one consumes what the previous one produced.

1. `planner` — decompose the task into 3 to 6 checkable steps, naming the role that should run each. Pass it the task and nothing else: its job is to decide the shape of the work, not to inherit your conclusions.
2. `retriever` — gather the evidence the plan calls for, from the worktree and from shared memory. Pass it the plan and the specific paths or symbols the plan named.
3. `executor` — run the commands the plan calls for and report what actually happened. Pass it the plan and the evidence, not the raw task, so it runs the step rather than reinventing it.
4. `summarizer` — state what the evidence and results add up to, keeping the uncertainty they carry. Pass it the plan, the evidence and the results.

Rules for the pipeline:

- Stages run in order, each in a fresh child session. Do not collapse two stages into one agent, and do not skip a stage because you believe you already know its answer — the comparison between the stages is the point.
- Hand over artefacts, not conversation. A stage receives the previous stage's output; it does not receive your reasoning about it.
- If a stage reports that it could not establish something, carry that forward verbatim. A later stage must not quietly upgrade "not established" to "established".
- If shared memory is enabled (`/synapse-setup` reports a mode other than `off`), each child is handed the memory the host recalled for its task automatically, and can record new findings itself. Do not paste memory contents between stages by hand; that is what the store is for.
- Stop the pipeline and report if a stage escalates a decision. An unapproved product, architecture or scope decision belongs to me.

After the summarizer returns, report: the plan that was executed, what each stage established, what remains open, and — when shared memory is on — which recalled memories were actually used.

Task:

$@

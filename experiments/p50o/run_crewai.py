"""p50o CrewAI arm (repo-relative, r/q families): four roles in CrewAI's native
sequential shape (upstream task outputs aggregate into later contexts), product
four-role prompts, max_iter bounded. 2026-10-04.

  python run_crewai.py --exp <dir> --tasks 5 [--family r|q] [--only 1,2]
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from framework_common import API_BASE, MAX_TOKENS, MODEL_ID, WorktreeTools, family_arg, load_key, load_questions, write_answer, write_record

AGENTS_DIR = Path(__file__).resolve().parents[2] / "agents"
ROLES = ("planner", "retriever", "executor", "summarizer")
MAX_ITER = 6


def product_prompt(role: str) -> str:
    text = (AGENTS_DIR / f"{role}.md").read_text(encoding="utf-8")
    if text.startswith("---"):
        text = re.split(r"^---\s*$", text, maxsplit=2, flags=re.M)[2]
    return text.strip()


def run_round(task_text: str, family: str) -> dict:
    import os as _os

    _os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
    _os.environ.setdefault("OTEL_SDK_DISABLED", "true")

    from crewai import Agent, Crew, LLM, Process, Task
    from crewai.tools import tool

    tools_impl = WorktreeTools(family)

    @tool("grep_worktree")
    def _grep(pattern: str) -> str:
        """Substring search over the shared worktree; returns path:line hits."""
        return tools_impl.grep(pattern)

    @tool("read_file")
    def _read(rel: str, start_line: int = 1, end_line: int | None = None) -> str:
        """Read a worktree file with an optional 1-based line range."""
        return tools_impl.read(rel, start_line, end_line)

    @tool("list_worktree")
    def _list(rel: str = ".") -> str:
        """List a directory inside the shared worktree."""
        return tools_impl.listdir(rel)

    @tool("run_python")
    def _run(code: str) -> str:
        """Run a short python snippet (print-based) in the worktree to check behaviour."""
        return tools_impl.run_python(code)

    key = load_key()
    llm = LLM(model=f"openai/{MODEL_ID}", base_url=API_BASE, api_key=key, temperature=0.2, max_tokens=MAX_TOKENS)

    read_tools = [_grep, _read, _list]
    exec_tools = [_grep, _read, _list, _run]
    agents = {}
    for role in ROLES:
        agents[role] = Agent(role=role, goal=f"Serve the {role} duty of the collaboration.", backstory=product_prompt(role), llm=llm, tools=exec_tools if role == "executor" else read_tools, verbose=False, max_iter=MAX_ITER)

    t_plan = Task(description=task_text, expected_output="The ordered plan.", agent=agents["planner"])
    t_evidence = Task(description="Collect the worktree evidence for the plan above.", expected_output="The evidence list.", agent=agents["retriever"])
    t_results = Task(description="Run the checks the plan asks for and report what happened.", expected_output="The commands and their outputs.", agent=agents["executor"])
    t_answer = Task(description="Answer the original task from everything above.", expected_output="The final answer.", agent=agents["summarizer"])

    crew = Crew(agents=[agents[r] for r in ROLES], tasks=[t_plan, t_evidence, t_results, t_answer], process=Process.sequential, verbose=False)
    started = time.perf_counter()
    out = crew.kickoff()
    wall_ms = int((time.perf_counter() - started) * 1000)
    usage = dict(out.usage_metrics or {})
    return {
        "answer": str(out),
        "input": int(usage.get("prompt_tokens", 0) or 0),
        "output": int(usage.get("completion_tokens", 0) or 0),
        "wallMs": wall_ms,
    }


def main() -> None:
    args = family_arg().parse_args()
    exp_dir = Path(args.exp)
    only = {int(x) for x in args.only.split(",") if x.strip()}
    for index, question in enumerate(load_questions(args.tasks, args.family)):
        if only and index + 1 not in only:
            continue
        t0 = time.perf_counter()
        try:
            r = run_round(question, args.family)
            write_answer(exp_dir, "crewai", index, r["answer"])
            write_record(exp_dir, "CREWAI", index, {"arm": "CREWAI", "framework": f"crewai-sequential-4role-product-prompts-maxiter{MAX_ITER}", "family": args.family, "index": index, "input": r["input"], "output": r["output"], "totalIn": r["input"], "totalOut": r["output"], "unit": "p50o-b", "valid": r["answer"].strip() != "" and (r["input"] > 0), "wallMs": r["wallMs"], "question": question})
            print(f"[crewai] q{index + 1}: token={r['input']}/{r['output']} wall={r['wallMs'] // 1000}s")
        except Exception as exc:  # noqa: BLE001
            write_record(exp_dir, "CREWAI", index, {"arm": "CREWAI", "family": args.family, "index": index, "error": str(exc)[:500], "unit": "p50o-b", "valid": False, "wallMs": int((time.perf_counter() - t0) * 1000), "question": question})
            print(f"[crewai] q{index + 1}: FAILED {str(exc)[:200]}")


if __name__ == "__main__":
    main()

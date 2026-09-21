"""P50-B CrewAI harness: the frozen 30-task family over a CrewAI crew.

Topology mirrors the measured system honestly: a retriever agent with the
worktree tools, a summarizer agent, sequential process — CrewAI's native
multi-agent text handoff (no shared memory, no non-text state).

Token accounting: CrewOutput.usage_metrics, which CrewAI aggregates from the
underlying LLM call responses — the API usage layer, per preregistration §7.

  uv run python run_crewai.py --exp <dir> [--pairs 1-30] [--mock]
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from p50b_common import (
    API_BASE,
    MODEL_ID,
    grep_worktree,
    list_worktree,
    load_key,
    load_tasks,
    read_file,
    write_answer,
    write_manifest,
    write_record,
)


def run_round(task_text: str, mock: bool) -> dict:
    import os as _os

    # CrewAI's interactive trace-sharing prompt would block for 20 s per round in
    # a non-interactive run; telemetry is off by default upstream and this only
    # silences the prompt (no capability change).
    _os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
    _os.environ.setdefault("OTEL_SDK_DISABLED", "true")

    from crewai import Agent, Crew, LLM, Process, Task
    from crewai.tools import tool

    @tool("grep_worktree")
    def _grep(pattern: str) -> str:
        """Case-sensitive substring search over the shared worktree; returns path:line hits."""
        return grep_worktree(pattern)

    @tool("read_file")
    def _read(rel: str, start_line: int = 1, end_line: int | None = None) -> str:
        """Read a worktree file with an optional 1-based line range."""
        return read_file(rel, start_line, end_line)

    @tool("list_worktree")
    def _list(rel: str = ".") -> str:
        """List a directory inside the shared worktree."""
        return list_worktree(rel)

    llm = LLM(
        model=f"openai/{MODEL_ID}",
        base_url=API_BASE,
        api_key="mock-key" if mock else load_key(),
        temperature=0.0,
        timeout=180,
    )

    retriever = Agent(
        role="retriever",
        goal="Answer the delegated task by reading the shared worktree; report concrete facts with file:line evidence.",
        backstory="The retrieval specialist of a four-role team.",
        tools=[_grep, _read, _list],
        llm=llm,
        max_iter=12,
        verbose=False,
    )
    summarizer = Agent(
        role="summarizer",
        goal="Turn the retriever's findings into a compact final answer with file:line anchors.",
        backstory="The summarizer of a four-role team.",
        llm=llm,
        max_iter=4,
        verbose=False,
    )
    t1 = Task(description=task_text, expected_output="Concrete facts with file:line evidence.", agent=retriever)
    t2 = Task(description="Summarize the retriever's findings into the final answer.", expected_output="A compact final answer.", agent=summarizer)
    crew = Crew(agents=[retriever, summarizer], tasks=[t1, t2], process=Process.sequential, verbose=False)

    t0 = time.perf_counter()
    if mock:
        # Offline self-test: skip the real LLM entirely; exercise the plumbing only.
        return {"wallMs": int((time.perf_counter() - t0) * 1000), "usage": {"input": 0, "output": 0}, "answer": "mock answer (plumbing self-test)", "usageRaw": {}}
    result = crew.kickoff()
    wall_ms = int((time.perf_counter() - t0) * 1000)
    usage = getattr(result, "usage_metrics", None) or {}
    answer = str(getattr(result, "raw", "") or "")
    return {
        "wallMs": wall_ms,
        "usage": {
            "input": int(getattr(usage, "prompt_tokens", 0) or (usage.get("prompt_tokens") if isinstance(usage, dict) else 0) or 0),
            "output": int(getattr(usage, "completion_tokens", 0) or (usage.get("completion_tokens") if isinstance(usage, dict) else 0) or 0),
        },
        "answer": answer,
        "usageRaw": usage if isinstance(usage, dict) else getattr(usage, "__dict__", {}),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", required=True)
    ap.add_argument("--pairs", default="1-30")
    ap.add_argument("--mock", action="store_true")
    args = ap.parse_args()
    exp_dir = Path(args.exp)
    lo, hi = (int(x) for x in args.pairs.split("-"))
    tasks = load_tasks()
    if exp_dir.joinpath("manifest.json").exists():
        raise SystemExit(f"manifest already exists — a started experiment is never restarted in place: {exp_dir}")
    write_manifest(
        exp_dir,
        arm="CREWAI",
        framework="crewai sequential crew",
        extra={"pairs": [lo, hi], "mock": bool(args.mock), "topology": "retriever(tools) -> summarizer, max_iter 12/4"},
    )
    for round_no in range(lo, hi + 1):
        record = {"arm": "CREWAI", "round": round_no, "valid": False, "problems": []}
        try:
            outcome = run_round(tasks[round_no - 1], args.mock)
            record.update(
                wallMs=outcome["wallMs"],
                usage=outcome["usage"],
                answerBytes=len(outcome["answer"].encode("utf-8")),
            )
            if not outcome["answer"]:
                record["problems"].append("empty final answer")
            if outcome["usage"]["input"] + outcome["usage"]["output"] == 0 and not args.mock:
                record["problems"].append("zero token usage recorded")
            write_answer(exp_dir, round_no, outcome["answer"])
            record["valid"] = len(record["problems"]) == 0
        except Exception as exc:  # noqa: BLE001 — a failed round is data, recorded honestly
            record["problems"].append(f"harness error: {exc}")
        write_record(exp_dir, record)
        print(f"[crewai] round {round_no}: {'VALID' if record['valid'] else 'invalid (' + ';'.join(record['problems']) + ')'}", flush=True)


if __name__ == "__main__":
    main()

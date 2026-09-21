"""P50-B AutoGen (AG2) harness: the frozen 30-task family over an AG2 team.

Topology mirrors the measured system honestly: one assistant does the retrieval
work with the worktree tools, a second assistant verifies and answers — the
framework's native multi-agent handoff (pure text between agents, no shared
memory, no non-text state). That text handoff is exactly what the comparison
measures against (preregistration §7: the architecture difference IS the
measured difference).

Token accounting: OpenAIChatCompletionClient total_usage(), which the client
computes from API response usage fields — the API usage layer, per §7.

  uv run python run_autogen.py --exp <dir> [--pairs 1-30] [--mock]
"""
from __future__ import annotations

import argparse
import asyncio
import json
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


async def run_round(task: str, mock: bool) -> dict:
    from autogen_agentchat.agents import AssistantAgent
    from autogen_agentchat.conditions import MaxMessageTermination, TextMentionTermination
    from autogen_agentchat.teams import RoundRobinGroupChat
    from autogen_ext.models.openai import OpenAIChatCompletionClient

    if mock:
        from autogen_ext.models.replay import ReplayChatCompletionClient

        client = ReplayChatCompletionClient(
            [
                "I will search the worktree. TERMINATE",
                "Final answer: the mock answer records the plumbing, not a fact. TERMINATE",
            ],
            model_info={
                "function_calling": True,
                "vision": False,
                "json_output": False,
                "structured_output": False,
                "family": "unknown",
            },
        )
    else:
        client = OpenAIChatCompletionClient(
            model=MODEL_ID,
            base_url=API_BASE,
            api_key=load_key(),
            temperature=0.0,
            timeout=180.0,
        )

    worker = AssistantAgent(
        "retriever",
        model_client=client,
        tools=[grep_worktree, read_file, list_worktree],
        system_message=(
            "You are the retriever agent of a four-role team. Answer the delegated task "
            "by reading the shared worktree with your tools; report concrete facts with "
            "file:line evidence. When the answer is complete, hand it to the summarizer."
        ),
    )
    summarizer = AssistantAgent(
        "summarizer",
        model_client=client,
        system_message=(
            "You are the summarizer agent. Turn the retriever's findings into a compact "
            "final answer (facts with file:line anchors). End with the word TERMINATE."
        ),
    )
    termination = TextMentionTermination("TERMINATE") | MaxMessageTermination(30)
    team = RoundRobinGroupChat([worker, summarizer], termination_condition=termination)

    t0 = time.perf_counter()
    result = await team.run(task=task)
    wall_ms = int((time.perf_counter() - t0) * 1000)

    usage = client.total_usage()  # aggregated from API response usage fields
    answer = ""
    for msg in reversed(result.messages):
        content = getattr(msg, "content", "")
        if isinstance(content, str) and content.strip():
            answer = content.replace("TERMINATE", "").strip()
            break
    await client.close()
    return {
        "wallMs": wall_ms,
        "usage": {
            "input": int(getattr(usage, "prompt_tokens", 0) or 0),
            "output": int(getattr(usage, "completion_tokens", 0) or 0),
        },
        "answer": answer,
        "messages": len(result.messages),
        "stopReason": str(result.stop_reason),
    }


async def main() -> None:
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
        arm="AUTOGEN",
        framework="autogen-agentchat (AG2) RoundRobinGroupChat",
        extra={"pairs": [lo, hi], "mock": bool(args.mock), "topology": "retriever(tools) + summarizer, max 30 messages"},
    )
    for round_no in range(lo, hi + 1):
        record = {"arm": "AUTOGEN", "round": round_no, "valid": False, "problems": []}
        try:
            outcome = await run_round(tasks[round_no - 1], args.mock)
            record.update(
                wallMs=outcome["wallMs"],
                usage=outcome["usage"],
                answerBytes=len(outcome["answer"].encode("utf-8")),
                messages=outcome["messages"],
                stopReason=outcome["stopReason"],
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
        print(f"[autogen] round {round_no}: {'VALID' if record['valid'] else 'invalid (' + ';'.join(record['problems']) + ')'}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())

"""p50o AutoGen arm (repo-relative, r/q families): four AssistantAgents in a
RoundRobinGroupChat (AutoGen's default broadcast shape), reflect_on_tool_use=False
(thinking-mode models emit empty reflect text and abort otherwise). 2026-10-04.

  python run_autogen.py --exp <dir> --tasks 5 [--family r|q] [--only 1,2]
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from framework_common import API_BASE, MAX_TOKENS, MODEL_ID, WorktreeTools, family_arg, load_key, load_questions, write_answer, write_record

MAX_TOOL_ITERATIONS = 25
ROLES = ("planner", "retriever", "executor", "summarizer")


async def run_round(task_text: str, family: str) -> dict:
    from autogen_agentchat.agents import AssistantAgent
    from autogen_agentchat.conditions import MaxMessageTermination
    from autogen_agentchat.teams import RoundRobinGroupChat
    from autogen_core import CancellationToken
    from autogen_core.tools import BaseTool
    from autogen_ext.models.openai import OpenAIChatCompletionClient
    from pydantic import BaseModel

    tools_impl = WorktreeTools(family)

    class GrepArgs(BaseModel):
        pattern: str

    class ReadArgs(BaseModel):
        rel: str
        start_line: int = 1
        end_line: int | None = None

    class ListArgs(BaseModel):
        rel: str = "."

    class RunArgs(BaseModel):
        code: str

    class GrepTool(BaseTool):
        def __init__(self) -> None:
            super().__init__(args_type=GrepArgs, return_type=str, name="grep_worktree", description="Substring search over the shared worktree; returns path:line hits.")

        async def run(self, args: GrepArgs, cancellation_token: CancellationToken) -> str:  # noqa: ARG002
            return tools_impl.grep(args.pattern)

    class ReadTool(BaseTool):
        def __init__(self) -> None:
            super().__init__(args_type=ReadArgs, return_type=str, name="read_file", description="Read a worktree file with an optional 1-based line range.")

        async def run(self, args: ReadArgs, cancellation_token: CancellationToken) -> str:  # noqa: ARG002
            return tools_impl.read(args.rel, args.start_line, args.end_line)

    class ListTool(BaseTool):
        def __init__(self) -> None:
            super().__init__(args_type=ListArgs, return_type=str, name="list_worktree", description="List a directory inside the shared worktree.")

        async def run(self, args: ListArgs, cancellation_token: CancellationToken) -> str:  # noqa: ARG002
            return tools_impl.listdir(args.rel)

    class RunTool(BaseTool):
        def __init__(self) -> None:
            super().__init__(args_type=RunArgs, return_type=str, name="run_python", description="Run a short python snippet (print-based) in the worktree to check behaviour.")

        async def run(self, args: RunArgs, cancellation_token: CancellationToken) -> str:  # noqa: ARG002
            return tools_impl.run_python(args.code)

    client = OpenAIChatCompletionClient(model=MODEL_ID, base_url=API_BASE, api_key=load_key(), model_info={"vision": False, "function_calling": True, "json_output": False, "family": "unknown"}, max_tokens=MAX_TOKENS)

    read_tools = [GrepTool(), ReadTool(), ListTool()]
    exec_tools = [GrepTool(), ReadTool(), ListTool(), RunTool()]
    prompts = {
        "planner": "You are the planner. Decompose the task into ordered steps for retriever/executor/summarizer.",
        "retriever": "You are the retriever. Gather the worktree evidence for the task and quote it with file paths.",
        "executor": "You are the executor. Run the checks the plan asks for and report what happened.",
        "summarizer": "You are the summarizer. Answer the original task from everything in the chat above.",
    }
    agents = [AssistantAgent(name=r, system_message=prompts[r], model_client=client, tools=exec_tools if r == "executor" else read_tools, reflect_on_tool_use=False, max_tool_iterations=MAX_TOOL_ITERATIONS) for r in ROLES]
    team = RoundRobinGroupChat(agents, termination_condition=MaxMessageTermination(len(agents) + 1))
    started = time.perf_counter()
    try:
        result = await team.run(task=task_text)
        wall_ms = int((time.perf_counter() - started) * 1000)
        from autogen_agentchat.messages import TextMessage

        texts = [m.content for m in result.messages if isinstance(m, TextMessage) and m.source == "summarizer"]
        answer = texts[-1] if texts else ""
        usage = None
        try:
            usage = client.total_usage()
        except TypeError:
            usage = await client.total_usage()
        u = usage or {}
        return {"answer": answer, "input": int(getattr(u, "prompt_tokens", 0) or 0), "output": int(getattr(u, "completion_tokens", 0) or 0), "wallMs": wall_ms}
    finally:
        await client.close()


def main() -> None:
    args = family_arg().parse_args()
    exp_dir = Path(args.exp)
    only = {int(x) for x in args.only.split(",") if x.strip()}
    for index, question in enumerate(load_questions(args.tasks, args.family)):
        if only and index + 1 not in only:
            continue
        t0 = time.perf_counter()
        try:
            r = asyncio.run(run_round(question, args.family))
            write_answer(exp_dir, "autogen", index, r["answer"])
            write_record(exp_dir, "AUTOGEN", index, {"arm": "AUTOGEN", "framework": "autogen-roundrobin-4role-broadcast-reflect-off", "family": args.family, "index": index, "input": r["input"], "output": r["output"], "totalIn": r["input"], "totalOut": r["output"], "unit": "p50o-b", "valid": r["answer"].strip() != "" and (r["input"] > 0), "wallMs": r["wallMs"], "question": question})
            print(f"[autogen] q{index + 1}: token={r['input']}/{r['output']} wall={r['wallMs'] // 1000}s")
        except Exception as exc:  # noqa: BLE001
            write_record(exp_dir, "AUTOGEN", index, {"arm": "AUTOGEN", "family": args.family, "index": index, "error": str(exc)[:500], "unit": "p50o-b", "valid": False, "wallMs": int((time.perf_counter() - t0) * 1000), "question": question})
            print(f"[autogen] q{index + 1}: FAILED {str(exc)[:200]}")


if __name__ == "__main__":
    main()

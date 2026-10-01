"""CrewAI arm: the four roles as a sequential crew, CrewAI's own way (spec
2026-09-25-synapse-external-framework-arms §6.2).

One Agent and one Task per role, in pipeline order. Every Task's description is
the round's task text verbatim and its expected_output is the role's own
one-line description (a required field). No `context=` is set, so what reaches
a downstream task is CrewAI's default; in 1.15.22 a synchronous sequential task
gets the aggregated raw outputs of all earlier tasks (crew.py _get_context).
The harness only observes it: TaskStartedEvent carries the context string each
task was actually given, and that string is what handoffs.jsonl records.

  python run_crewai.py <round-spec.json>
"""
from __future__ import annotations

import os
import sys
import time

# Before crewai is imported: no telemetry, no trace upload, no interactive prompt.
os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")

from pydantic import BaseModel, PrivateAttr  # noqa: E402

import crewai  # noqa: E402
from crewai import LLM, Agent, Crew, Process, Task  # noqa: E402
from crewai.events import TaskStartedEvent, crewai_event_bus  # noqa: E402
from crewai.tools import BaseTool  # noqa: E402

from common import Recorder, ToolServer, args_model, load_spec, log  # noqa: E402


class PiTool(BaseTool):
    """A pi tool, executed by the tool server."""

    name: str
    description: str
    args_schema: type[BaseModel]
    _server: ToolServer = PrivateAttr()

    def bind(self, server: ToolServer) -> "PiTool":
        self._server = server
        return self

    def _run(self, **kwargs) -> str:
        return self._server.call(self.name, kwargs)


def main(spec_path: str) -> int:
    spec = load_spec(spec_path)
    recorder = Recorder(spec["outDir"])
    server = ToolServer(spec["toolServer"])

    agents: dict[str, Agent] = {}
    tasks: list[Task] = []
    for role in spec["roles"]:
        tools = []
        for tool_name in role["tools"]:
            schema = server.schemas[tool_name]
            tools.append(PiTool(name=schema["name"], description=schema["description"], args_schema=args_model(schema["name"], schema["parameters"])).bind(server))
        llm = LLM(model=f"openai/{spec['model']}", base_url=spec["endpoints"][role["name"]], api_key="dummy-key-the-proxy-holds-the-real-one")
        agent = Agent(role=role["name"], goal=role["description"], backstory=role["prompt"], tools=tools, llm=llm, verbose=False)
        agents[role["name"]] = agent
        tasks.append(Task(description=spec["task"], expected_output=role["description"], agent=agent))

    @crewai_event_bus.on(TaskStartedEvent)
    def _on_task_started(_source, event):  # noqa: ANN001
        target = event.task.agent.role if event.task is not None and event.task.agent is not None else "unknown"
        recorder.handoff("user", target, "task", event.task.description if event.task is not None else "")
        if event.context:
            upstream = [task.agent.role for task in tasks if task.output is not None and task.agent is not None]
            recorder.handoff(",".join(upstream) or "unknown", target, "context", event.context)

    crew = Crew(agents=list(agents.values()), tasks=tasks, process=Process.sequential, verbose=False)
    started = time.perf_counter()
    result = crew.kickoff()
    wall_ms = int((time.perf_counter() - started) * 1000)
    ran = [output.agent for output in result.tasks_output]
    recorder.answer(str(result.raw or ""))
    recorder.meta({"framework": "crewai", "version": crewai.__version__, "process": "sequential", "wallMs": wall_ms, "tasksRun": ran})
    log(f"crewai done in {wall_ms} ms; tasks run: {ran}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

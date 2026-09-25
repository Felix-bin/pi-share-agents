"""AutoGen arm: the four roles as a RoundRobinGroupChat, AutoGen's own way (spec
2026-09-25-synapse-external-framework-arms §6.2).

The task text verbatim is the group's first message; the four AssistantAgents
speak once each in pipeline order and the chat ends after five messages (the
task and four replies; MaxMessageTermination counts chat messages, not agent
events). Only the loop bounds are set: max_tool_iterations=25 (the default of 1
ends an agent's turn after its first tool call) and reflect_on_tool_use=True so
a turn ends in text. What each agent sees is the group chat's default
broadcast; handoffs.jsonl records, per agent, the chat messages delivered to it
before its turn, rebuilt from the run's own message stream.

  python run_autogen.py <round-spec.json>
"""
from __future__ import annotations

import asyncio
import sys
import time

import autogen_agentchat
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination
from autogen_agentchat.messages import BaseChatMessage, TextMessage
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_core import CancellationToken
from autogen_core.tools import BaseTool
from autogen_ext.models.openai import OpenAIChatCompletionClient
from pydantic import BaseModel

from common import Recorder, ToolServer, args_model, load_spec, log

MAX_TOOL_ITERATIONS = 25
# Non-OpenAI model names need an explicit capability card; tools are how the agents work.
MODEL_INFO = {"vision": False, "function_calling": True, "json_output": False, "structured_output": False, "family": "unknown"}


class PiTool(BaseTool[BaseModel, str]):
    """A pi tool, executed by the tool server."""

    def __init__(self, schema: dict, server: ToolServer):
        super().__init__(args_model(schema["name"], schema["parameters"]), str, schema["name"], schema["description"])
        self._server = server

    async def run(self, args: BaseModel, cancellation_token: CancellationToken) -> str:
        return await asyncio.to_thread(self._server.call, self.name, args.model_dump())


def deliveries(chat: list[BaseChatMessage]) -> list[tuple[str, str, str]]:
    """(source, target, text) for every chat message that reached an agent's context before its turn."""
    out = []
    seen_upto: dict[str, int] = {}
    for index, message in enumerate(chat):
        speaker = message.source
        if speaker == "user":
            continue
        for earlier in chat[seen_upto.get(speaker, 0):index]:
            if earlier.source != speaker:
                out.append((earlier.source, speaker, earlier.to_model_text()))
        seen_upto[speaker] = index + 1
    return out


async def run(spec: dict) -> int:
    recorder = Recorder(spec["outDir"])
    server = ToolServer(spec["toolServer"])
    clients = []
    agents = []
    for role in spec["roles"]:
        client = OpenAIChatCompletionClient(model=spec["model"], base_url=spec["endpoints"][role["name"]], api_key="dummy-key-the-proxy-holds-the-real-one", model_info=MODEL_INFO)
        clients.append(client)
        tools = [PiTool(server.schemas[name], server) for name in role["tools"]]
        agents.append(
            AssistantAgent(
                name=role["name"],
                description=role["description"],
                system_message=role["prompt"],
                model_client=client,
                tools=tools,
                reflect_on_tool_use=True,
                max_tool_iterations=MAX_TOOL_ITERATIONS,
            )
        )
    team = RoundRobinGroupChat(agents, termination_condition=MaxMessageTermination(len(agents) + 1))
    started = time.perf_counter()
    try:
        result = await team.run(task=spec["task"])
    finally:
        for client in clients:
            await client.close()
    wall_ms = int((time.perf_counter() - started) * 1000)
    chat = [message for message in result.messages if isinstance(message, BaseChatMessage)]
    for source, target, text in deliveries(chat):
        recorder.handoff(source, target, "task" if source == "user" else "broadcast", text)
    last = next((message for message in reversed(chat) if message.source == spec["roles"][-1]["name"]), None)
    answer = "" if last is None else (last.content if isinstance(last, TextMessage) else last.to_model_text())
    recorder.answer(answer)
    speakers = [message.source for message in chat if message.source != "user"]
    recorder.meta({"framework": "autogen-agentchat", "version": autogen_agentchat.__version__, "team": "RoundRobinGroupChat", "wallMs": wall_ms, "speakers": speakers, "stopReason": str(result.stop_reason)})
    log(f"autogen done in {wall_ms} ms; speakers: {speakers}; stop: {result.stop_reason}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run(load_spec(sys.argv[1]))))

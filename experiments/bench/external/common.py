"""Shared plumbing for the external-framework harnesses (spec
2026-09-25-synapse-external-framework-arms §6).

A harness gets one round-spec JSON from external-arm.mjs and runs one round:
four agents, the task text verbatim, the framework's own orchestration. What is
shared here is only what has to be identical across frameworks:

- the tools, which call the per-attempt tool server, i.e. pi's own tool
  implementations (the harness never runs a tool itself);
- the per-role model endpoint, `<proxy>/<role>/v1`, so the recording proxy can
  attribute every call and add the parameters pi would send;
- the output files: answer.md (the summarizer's final text) and handoffs.jsonl
  (every delivery into an agent's context the framework actually made).
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field, create_model

# Loopback only: never route the proxy or the tool server through an HTTP proxy.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_JSON_TYPES: dict[str, Any] = {"string": str, "number": float, "integer": int, "boolean": bool}


def load_spec(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _request(url: str, payload: Optional[dict] = None) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="GET" if data is None else "POST")
    with _OPENER.open(req, timeout=3600) as response:
        return json.loads(response.read().decode("utf-8"))


class ToolServer:
    """Client of tool-server.mjs: pi's schemas, and execution returning pi's text."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.schemas = {tool["name"]: tool for tool in _request(f"{self.base_url}/tools")}

    def call(self, name: str, arguments: dict) -> str:
        # pi's optional parameters are absent, not null.
        clean = {key: value for key, value in arguments.items() if value is not None}
        return _request(f"{self.base_url}/tools/{name}", {"arguments": clean})["text"]


def args_model(name: str, parameters: dict) -> type[BaseModel]:
    """A pydantic model with pi's parameter names, types, descriptions and required set."""
    required = set(parameters.get("required", []))
    fields: dict[str, Any] = {}
    for key, prop in parameters.get("properties", {}).items():
        py_type = _JSON_TYPES.get(prop.get("type"), str)
        description = prop.get("description", "")
        if key in required:
            fields[key] = (py_type, Field(..., description=description))
        else:
            fields[key] = (Optional[py_type], Field(None, description=description))
    return create_model(f"{name.capitalize()}Args", **fields)


class Recorder:
    """Writes handoffs.jsonl and answer.md into the attempt's output directory."""

    def __init__(self, out_dir: str):
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.handoffs = self.out / "handoffs.jsonl"
        self.handoffs.write_text("", encoding="utf-8")

    def handoff(self, source: str, target: str, kind: str, text: str) -> None:
        entry = {"from": source, "to": target, "kind": kind, "bytes": len(text.encode("utf-8")), "text": text}
        with self.handoffs.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def answer(self, text: str) -> None:
        (self.out / "answer.md").write_text(text + "\n", encoding="utf-8")

    def meta(self, value: dict) -> None:
        (self.out / "harness-meta.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def log(message: str) -> None:
    print(f"[harness] {message}", file=sys.stderr, flush=True)

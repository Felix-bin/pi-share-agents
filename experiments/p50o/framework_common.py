"""p50o framework-arm shared plumbing (repo-relative, r/q families) — 2026-10-04.

Public questions verbatim, worktree tools whose behaviour matches the pi built-in
tools (windowed reads, capped grep), API-usage-layer accounting only.
Families: r = SWE-QA Flask (code QA, .py worktree); q = MuSiQue (multi-hop QA, .md worktree).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENV_FALLBACK = Path(os.environ.get("P50O_ENV_FILE", "")) if os.environ.get("P50O_ENV_FILE") else None
FLASK_JSONL = REPO / "experiments" / "data" / "swe-qa" / "Benchmark" / "flask.jsonl"
MUSIQUE_FAMILY = REPO / "experiments" / "bench" / "families" / "q-musique.json"
API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL_ID = "deepseek-v4.1-flash"
MAX_TOKENS = 32768

FAMILY_DIRS = {"r": REPO / "experiments" / "data" / "flask-src", "q": REPO / "experiments" / "data" / "worktree" / "musique"}
FAMILY_SUFFIX = {"r": ".py", "q": ".md"}


def load_questions(n: int, family: str) -> list[str]:
    if family == "r":
        lines = FLASK_JSONL.read_text(encoding="utf-8").strip().splitlines()
        return [json.loads(line)["question"] for line in lines[:n]]
    tasks = json.loads(MUSIQUE_FAMILY.read_text(encoding="utf-8"))["tasks"]
    return [t["task"] for t in tasks[:n]]


def load_key() -> str:
    env = os.environ.get("DASHSCOPE_API_KEY")
    if env:
        return env
    if ENV_FALLBACK and ENV_FALLBACK.is_file():
        for line in ENV_FALLBACK.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("DASHSCOPE_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("set DASHSCOPE_API_KEY (or P50O_ENV_FILE pointing at a .env holding it)")


class WorktreeTools:
    """Family-aware worktree tools, behaviour aligned with the pi built-in tools."""

    def __init__(self, family: str) -> None:
        self.root = FAMILY_DIRS[family].resolve()
        self.suffix = FAMILY_SUFFIX[family]

    def grep(self, pattern: str) -> str:
        hits: list[str] = []
        for path in self.root.rglob(f"*{self.suffix}"):
            rel = path.relative_to(self.root).as_posix()
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if pattern in line:
                    hits.append(f"{rel}:{i}: {line.strip()}")
                    if len(hits) >= 30:
                        return "\n".join(hits) + "\n(matches capped at 30 — refine the pattern to see more)"
        return "\n".join(hits) if hits else "(no hits)"

    def read(self, rel: str, start_line: int = 1, end_line: int | None = None) -> str:
        path = (self.root / rel).resolve()
        if not str(path).startswith(str(self.root)) or not path.is_file():
            return f"(no such file: {rel})"
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if end_line is None:
            end_line = min(start_line + 99, len(lines))
        chunk = lines[start_line - 1 : end_line]
        shown = "\n".join(f"{i}: {l}" for i, l in enumerate(chunk, start_line))
        if end_line < len(lines):
            shown += f"\n(file has {len(lines)} lines; showing {start_line}-{end_line} — pass start_line/end_line to read further)"
        return shown

    def listdir(self, rel: str = ".") -> str:
        path = (self.root / rel).resolve()
        if not str(path).startswith(str(self.root)) or not path.is_dir():
            return f"(no such dir: {rel})"
        entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
        return "\n".join((("/" if e.is_dir() else e.name) if rel == "." else e.name + ("/" if e.is_dir() else "")) for e in entries[:200])

    def run_python(self, code: str) -> str:
        try:
            proc = subprocess.run(["python", "-c", code], cwd=str(self.root), capture_output=True, text=True, timeout=120)
            out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
            lines = out.splitlines()
            if len(lines) > 200:
                out = "\n".join(lines[:150]) + f"\n…({len(lines) - 200} middle lines truncated)…\n" + "\n".join(lines[-50:])
            return f"(exit {proc.returncode})\n{out[:20000]}"
        except subprocess.TimeoutExpired:
            return "(timeout 120s)"


def write_record(exp_dir: Path, framework: str, index: int, record: dict) -> None:
    exp_dir.mkdir(parents=True, exist_ok=True)
    with (exp_dir / f"{framework}-partial.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_answer(exp_dir: Path, framework: str, index: int, answer: str) -> None:
    ev = exp_dir / "evidence" / f"q{index + 1}-{framework.upper()}"
    ev.mkdir(parents=True, exist_ok=True)
    (ev / "answer.md").write_text(answer, encoding="utf-8")


def family_arg() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", required=True)
    ap.add_argument("--tasks", type=int, default=5)
    ap.add_argument("--only", default="")
    ap.add_argument("--family", default="r", choices=["r", "q"])
    return ap

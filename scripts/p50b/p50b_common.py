"""P50-B shared plumbing: task loading, worktree tools, record writing, mock client.

Preregistration §7 (frozen): same 30-task family as P50, same model+API channel,
task text fed verbatim, no prompt tuning, ALL system LLM tokens counted from the
API usage layer (response usage fields), never framework self-reports. The mock
mode exists for the offline self-test only and is never mixed with real runs.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FAMILY_FILE = REPO / "scripts" / "p50-family.mjs"
ENV_FILE = Path("D:/操作系统开源大赛/synapse/.env")
WORK_DIR = Path("D:/操作系统开源大赛/synapse/_state/p45-runs/work")
API_BASE = "https://llmapi.paratera.com/v1"
MODEL_ID = "DeepSeek-V4-Flash"


def load_tasks() -> list[str]:
    """Extract the 30 task strings from the frozen p50-family.mjs (single source of truth)."""
    text = FAMILY_FILE.read_text(encoding="utf-8")
    array_region = text.split("export const TASKS = [", 1)[1].split("];", 1)[0]
    tasks = re.findall(r'"((?:[^"\\]|\\.)*)"', array_region)
    tasks = [t.replace('\\"', '"').replace("\\\\", "\\") for t in tasks]
    if len(tasks) != 30:
        raise RuntimeError(f"expected 30 tasks in {FAMILY_FILE}, parsed {len(tasks)}")
    return tasks


def load_key() -> str:
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("PARATERA_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"PARATERA_API_KEY not present in {ENV_FILE}")


# ---------------- worktree tools (identical across frameworks) ----------------

def _safe_rel(rel: str) -> Path:
    p = (WORK_DIR / rel).resolve()
    if not str(p).startswith(str(WORK_DIR.resolve())):
        raise ValueError(f"path escapes worktree: {rel}")
    return p


def list_worktree(rel: str = ".") -> str:
    """List a directory inside the shared worktree (relative path)."""
    p = _safe_rel(rel)
    if not p.is_dir():
        return f"not a directory: {rel}"
    entries = sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir())
    return "\n".join(entries[:200])


def read_file(rel: str, start_line: int = 1, end_line: int | None = None) -> str:
    """Read a file inside the shared worktree with an optional 1-based line range."""
    p = _safe_rel(rel)
    if not p.is_file():
        return f"not a file: {rel}"
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    end = end_line if end_line is not None else min(len(lines), start_line + 199)
    body = "\n".join(f"{i + 1}: {lines[i]}" for i in range(start_line - 1, min(end, len(lines))))
    return body[:12000]


def grep_worktree(pattern: str, glob: str = "*.py", max_hits: int = 40) -> str:
    """Case-sensitive substring search over the shared worktree, one line per hit."""
    hits: list[str] = []
    roots = [WORK_DIR / "源代码及readme文档", WORK_DIR / "docs", WORK_DIR / "README.md"]
    files: list[Path] = []
    for root in roots:
        if root.is_dir():
            files.extend(sorted(root.rglob(glob)))
        elif root.is_file():
            files.append(root)
    for f in files:
        if "__pycache__" in str(f):
            continue
        try:
            for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern in line:
                    hits.append(f"{f.relative_to(WORK_DIR)}:{n}: {line.strip()[:160]}")
                    if len(hits) >= max_hits:
                        return "\n".join(hits)
        except OSError:
            continue
    return "\n".join(hits) if hits else f"no hits for {pattern!r}"


# ---------------- run records ----------------

def write_record(exp_dir: Path, record: dict) -> None:
    exp_dir.mkdir(parents=True, exist_ok=True)
    with (exp_dir / "rounds.jsonl").open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_answer(exp_dir: Path, round_no: int, answer: str) -> None:
    d = exp_dir / "evidence" / f"round-{round_no:02d}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "answer.md").write_text(answer + "\n", encoding="utf-8")


def write_manifest(exp_dir: Path, arm: str, framework: str, extra: dict) -> None:
    exp_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "experimentId": exp_dir.name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "preregistration": "P50-token-ab-preregistration-20260921.md §7 (P50-B framework baseline)",
        "arm": arm,
        "framework": framework,
        "model": f"paratera/{MODEL_ID}",
        "apiBase": API_BASE,
        "temperature": 0.0,
        "familyFile": str(FAMILY_FILE).replace("\\", "/"),
        "worktreePath": str(WORK_DIR).replace("\\", "/"),
        "tokenSource": "API response usage fields, aggregated by the harness wrapper (never framework self-reports)",
        **extra,
    }
    (exp_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

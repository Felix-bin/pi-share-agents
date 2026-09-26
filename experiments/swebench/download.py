#!/usr/bin/env python3
"""Freeze SWE-bench Lite test inputs; omit gold patches and test patches."""
import json
import sys
from pathlib import Path

from datasets import load_dataset


def main() -> None:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/data/swebench/lite-test.jsonl")
    if target.exists():
        raise SystemExit(f"refusing to replace frozen dataset: {target}")
    rows = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    if len(rows) != 300:
        raise SystemExit(f"expected 300 SWE-bench Lite test instances, got {len(rows)}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as output:
        for row in rows:
            item = {key: row[key] for key in ("instance_id", "repo", "base_commit", "problem_statement")}
            output.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} instances to {target}")


if __name__ == "__main__":
    main()

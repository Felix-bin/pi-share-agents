#!/usr/bin/env bash
# Prepares everything the public-benchmark groups (Q: MuSiQue, R: SWE-QA Flask) need,
# under experiments/data/ (git-ignored):
#   musique_ans_v1.0_dev.jsonl   MuSiQue-Ans dev, from HuggingFace dgslibisey/MuSiQue
#   swe-qa/                      peng-weihan/SWE-QA-Bench (questions, pinned commits, judge prompt)
#   flask-src/                   pallets/flask clone, checked out at SWE-QA's pinned commit
#   worktree/{musique,flask}/    what the agents read (built by build-public-families.mjs)
#   venv/                        Python with Flask installed from worktree/flask and pytest<9,
#                                so the executor can run the repository's own tests
#   frameworks-venv/             CrewAI and AutoGen for the external-framework arms, installed
#                                from external/requirements.lock (exact versions)
# Idempotent: downloads are skipped when present; families and worktree are rebuilt.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${1:-$HERE/../data}"
mkdir -p "$DATA"
DATA="$(cd "$DATA" && pwd)"

if [ ! -s "$DATA/musique_ans_v1.0_dev.jsonl" ]; then
	curl -fsSL -o "$DATA/musique_ans_v1.0_dev.jsonl" "https://huggingface.co/datasets/dgslibisey/MuSiQue/resolve/main/musique_ans_v1.0_dev.jsonl"
fi
if [ ! -d "$DATA/swe-qa/.git" ]; then
	git clone -q --depth 1 https://github.com/peng-weihan/SWE-QA-Bench.git "$DATA/swe-qa"
fi

node "$HERE/build-public-families.mjs" --data "$DATA"

if [ ! -x "$DATA/venv/bin/python" ]; then
	python3 -m venv "$DATA/venv"
fi
# pytest 9 removed monkeypatch.notset, which Flask's conftest at the pinned commit uses.
"$DATA/venv/bin/pip" install -q --disable-pip-version-check -e "$DATA/worktree/flask" "pytest<9"
"$DATA/venv/bin/pip" freeze > "$DATA/venv-freeze.txt"
(cd "$DATA/worktree/flask" && "$DATA/venv/bin/python" -m pytest -q tests/test_json_tag.py >/dev/null) && echo "venv ok: Flask tests run"
if [ ! -x "$DATA/frameworks-venv/bin/python" ]; then
	python3 -m venv "$DATA/frameworks-venv"
fi
"$DATA/frameworks-venv/bin/pip" install -q --disable-pip-version-check -r "$HERE/external/requirements.lock"
"$DATA/frameworks-venv/bin/python" -c "import crewai, autogen_agentchat; print('frameworks ok: crewai', crewai.__version__, '/ autogen-agentchat', autogen_agentchat.__version__)"
echo "data ready in $DATA"

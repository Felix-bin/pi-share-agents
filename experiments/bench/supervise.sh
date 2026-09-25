#!/usr/bin/env bash
# Runs a synapse-bench experiment and falls back to a second provider when the
# first runs out: runner.mjs exits 75 on a provider quota or credential error,
# and this script resumes the same experiment (--resume) on the fallback.
#
#   experiments/bench/supervise.sh <experimentId> <runner args...>
#
# The primary and fallback provider/model come from the environment:
#   PRIMARY_PROVIDER / PRIMARY_MODEL     (default commandcode / deepseek/deepseek-v4.1-flash)
#   FALLBACK_PROVIDER / FALLBACK_MODEL   (default deepseek / deepseek-flash)
# Status lines go to stdout and to <out>/<experimentId>.supervise.log.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ID="$1"
shift
OUT="${SYNBENCH_OUT:-$HOME/.pi/agent/synapse/experiments}"
PRIMARY_PROVIDER="${PRIMARY_PROVIDER:-commandcode}"
PRIMARY_MODEL="${PRIMARY_MODEL:-deepseek/deepseek-v4.1-flash}"
FALLBACK_PROVIDER="${FALLBACK_PROVIDER:-deepseek}"
FALLBACK_MODEL="${FALLBACK_MODEL:-deepseek-flash}"
STATUS="$OUT/$ID.supervise.log"
mkdir -p "$OUT"
say() { echo "[supervise $(date '+%F %T')] $*" | tee -a "$STATUS"; }

cd "$REPO" || exit 1
run() {
	NODE_USE_ENV_PROXY=1 node --experimental-strip-types experiments/bench/runner.mjs --id "$ID" --out "$OUT" "$@"
}

if [ -f "$OUT/$ID/manifest.json" ]; then
	say "resume $ID on $PRIMARY_PROVIDER/$PRIMARY_MODEL"
	run --resume --provider "$PRIMARY_PROVIDER" --model "$PRIMARY_MODEL" "$@"
else
	say "start $ID on $PRIMARY_PROVIDER/$PRIMARY_MODEL"
	run --provider "$PRIMARY_PROVIDER" --model "$PRIMARY_MODEL" "$@"
fi
code=$?
if [ "$code" -eq 75 ]; then
	say "$PRIMARY_PROVIDER exhausted (exit 75); resuming on $FALLBACK_PROVIDER/$FALLBACK_MODEL"
	run --resume --provider "$FALLBACK_PROVIDER" --model "$FALLBACK_MODEL" "$@"
	code=$?
fi
say "done, runner exit code $code"
exit "$code"

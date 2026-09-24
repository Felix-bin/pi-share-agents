#!/usr/bin/env bash
# SYNAPSE S1 → S2 → S3 real-machine acceptance, one command (plan A4).
#
#   sudo -E bash scripts/synapse/acceptance-all.sh [--out <dir>] [--store <storageRoot>] \
#        [--only s1,s2,s3] [--s3-runs 3] [--bpftrace <path>] [--timeout <seconds>]
#
# Runs the three collectors in order, each writing its JSON report to
#   <agentDir>/synapse/acceptance/{s1,s2,s3}-<ISO>.json
# (agentDir = PI_CODING_AGENT_DIR, else ~/.pi/agent of the invoking user — under
# sudo that is SUDO_USER's home, not /root), then judges every report with
# judge-s{1,2,3}-report.ts and prints one summary table. Logs and judge output
# go to <dir>/logs/. A stage that fails or cannot run does not stop the next
# one; a missing precondition shows up as `unavailable` inside the report (the
# collectors' own discipline), never as an invented pass or zero.
#
# Prerequisites (what each stage needs to produce more than `unavailable`):
#   S1  iSulad daemon running:   sudo isulad &      (or: sudo systemctl start isulad)
#       plus the image pi-subagent-s1:acceptance buildable/present (s1-image/).
#       Docker/podman are accepted too; the engine is probed isula → docker → podman.
#   S2  the S1 image (S1 builds it), node on PATH, and — for the tmpfs claim —
#       <storageRoot>/objects mounted as tmpfs (a mount, NOT a symlink):
#           sudo sh scripts/synapse/mount-objects-tmpfs.sh <storageRoot>
#       then pass the same root with --store <storageRoot>. strace for check 2.
#   S3  root (bpftrace needs it) and a BTF kernel (/sys/kernel/btf/vmlinux).
#       Without root the report records root:false, runs:[] and judges incomplete.
#
# Exit status: 0 when every judged stage passed, 1 when any failed, 2 otherwise
# (incomplete / unavailable / no report). The S1 runbook explains why its best
# possible result is `incomplete` (s3-fd-premise is always unavailable).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

OUT=""
STORE=""
ONLY="s1,s2,s3"
S3_RUNS=3
BPFTRACE=""
STAGE_TIMEOUT=900
while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT=${2:?--out needs a directory}; shift 2 ;;
	--store) STORE=${2:?--store needs a storageRoot}; shift 2 ;;
	--only) ONLY=${2:?--only needs a list such as s1,s3}; shift 2 ;;
	--s3-runs) S3_RUNS=${2:?--s3-runs needs a number}; shift 2 ;;
	--bpftrace) BPFTRACE=${2:?--bpftrace needs a path}; shift 2 ;;
	--timeout) STAGE_TIMEOUT=${2:?--timeout needs seconds}; shift 2 ;;
	-h | --help) sed -n '2,31p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 64 ;;
	esac
done

# ---- who we are, and whose agent dir this is --------------------------------
EUID_NOW=$(id -u)
REAL_USER=$(id -un)
if [ "$EUID_NOW" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
	REAL_USER=$SUDO_USER
fi
REAL_HOME=$(getent passwd "$REAL_USER" 2>/dev/null | cut -d: -f6)
[ -n "$REAL_HOME" ] || REAL_HOME=$HOME
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
	case "$PI_CODING_AGENT_DIR" in
	"~/"*) AGENT_DIR="$REAL_HOME/${PI_CODING_AGENT_DIR#\~/}" ;;
	*) AGENT_DIR=$PI_CODING_AGENT_DIR ;;
	esac
else
	AGENT_DIR="$REAL_HOME/.pi/agent"
fi
[ -n "$OUT" ] || OUT="$AGENT_DIR/synapse/acceptance"
LOGS="$OUT/logs"
mkdir -p "$LOGS" || { echo "cannot create $LOGS" >&2; exit 2; }

# Filename-safe ISO-8601 (UTC, basic format): 20260924T101500Z.
TS=$(date -u +%Y%m%dT%H%M%SZ)

# ---- node: sudo's secure_path often drops the user's node --------------------
NODE_BIN=${NODE:-}
[ -n "$NODE_BIN" ] || NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_BIN" ] && [ "$EUID_NOW" -eq 0 ] && [ "$REAL_USER" != "root" ]; then
	NODE_BIN=$(su - "$REAL_USER" -c 'command -v node' 2>/dev/null || true)
fi
# The collectors call `node` from PATH themselves; make the resolved one visible.
if [ -n "$NODE_BIN" ]; then PATH="$(dirname "$NODE_BIN"):$PATH"; export PATH; fi

have_timeout=""
command -v timeout >/dev/null 2>&1 && have_timeout=yes
run_bounded() { # run_bounded <cmd...>
	if [ -n "$have_timeout" ]; then timeout --kill-after=30 "$STAGE_TIMEOUT" "$@"; else "$@"; fi
}

wants() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ---- preflight facts (printed, not judged) -----------------------------------
os_pretty=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)
engine_state="none on PATH"
for candidate in isula docker podman; do
	if command -v "$candidate" >/dev/null 2>&1; then
		if run_bounded "$candidate" info >/dev/null 2>&1; then engine_state="$candidate (daemon reachable)"; else engine_state="$candidate (daemon NOT reachable — start it: sudo isulad & / systemctl start isulad)"; fi
		break
	fi
done
bpf_state="absent"
BPF_BIN=${BPFTRACE:-$(command -v bpftrace 2>/dev/null || true)}
[ -n "$BPF_BIN" ] && bpf_state="$("$BPF_BIN" --version 2>/dev/null | head -n 1 || echo present)"
btf_state="absent"; [ -e /sys/kernel/btf/vmlinux ] && btf_state="present"
echo "SYNAPSE acceptance ${TS}"
echo "  os:        ${os_pretty:-unknown} / $(uname -sr)"
echo "  user:      $(id -un) (euid ${EUID_NOW}); outputs for ${REAL_USER}"
echo "  out:       ${OUT}"
echo "  node:      ${NODE_BIN:-absent}"
echo "  engine:    ${engine_state}"
echo "  bpftrace:  ${bpf_state}; BTF ${btf_state}; root $([ "$EUID_NOW" -eq 0 ] && echo yes || echo no)"
echo

# ---- stages ----------------------------------------------------------------
declare -A COLLECT_RC REPORT_PATH JUDGE_RC JUDGE_LINE
STAGES=()

collect() { # collect <stage> <cmd...>
	local stage=$1; shift
	local report="$OUT/${stage}-${TS}.json"
	local logfile="$LOGS/${stage}-${TS}.log"
	STAGES+=("$stage")
	REPORT_PATH[$stage]=$report
	echo "== ${stage}: collecting → ${report}"
	run_bounded "$@" --report "$report" >"$logfile" 2>&1
	COLLECT_RC[$stage]=$?
	if [ ! -s "$report" ]; then
		echo "   ${stage}: collector exited ${COLLECT_RC[$stage]} without a report (log: ${logfile})"
		rm -f "$report"
	else
		echo "   ${stage}: collector exited ${COLLECT_RC[$stage]}"
	fi
}

judge() { # judge <stage>
	local stage=$1
	local report=${REPORT_PATH[$stage]}
	local judgefile="$LOGS/${stage}-${TS}.judge.txt"
	if [ ! -s "$report" ]; then
		JUDGE_RC[$stage]=3
		JUDGE_LINE[$stage]="no report written"
		return
	fi
	if [ -z "$NODE_BIN" ]; then
		JUDGE_RC[$stage]=3
		JUDGE_LINE[$stage]="node not found; judge could not run"
		return
	fi
	"$NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/judge-${stage}-report.ts" "$report" >"$judgefile" 2>&1
	JUDGE_RC[$stage]=$?
	JUDGE_LINE[$stage]=$(grep -E '^(verdict|failed|not run):' "$judgefile" | tr -s ' ' | paste -sd ';' - | cut -c1-160)
	[ -n "${JUDGE_LINE[$stage]}" ] || JUDGE_LINE[$stage]=$(tail -n 1 "$judgefile" | cut -c1-160)
}

if wants s1; then
	collect s1 sh "$SCRIPT_DIR/s1-acceptance.sh" --repo "$REPO"
fi
if wants s2; then
	if [ -n "$STORE" ]; then
		collect s2 sh "$SCRIPT_DIR/s2-acceptance.sh" --repo "$REPO" --store "$STORE"
	else
		collect s2 sh "$SCRIPT_DIR/s2-acceptance.sh" --repo "$REPO"
	fi
fi
if wants s3; then
	if [ -z "$NODE_BIN" ]; then
		STAGES+=("s3"); REPORT_PATH[s3]="$OUT/s3-${TS}.json"; COLLECT_RC[s3]=127
		echo "== s3: node not found; not run"
	else
		s3_args=("$NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/s3-acceptance.ts" --runs "$S3_RUNS")
		[ -n "$BPF_BIN" ] && s3_args+=(--bpftrace "$BPF_BIN")
		collect s3 "${s3_args[@]}"
	fi
fi

for stage in "${STAGES[@]}"; do judge "$stage"; done

# ---- summary ----------------------------------------------------------------
verdict_of() {
	case "$1" in
	0) echo pass ;;
	1) echo fail ;;
	2) echo incomplete ;;
	3) echo unavailable ;;
	*) echo "unavailable(rc=$1)" ;;
	esac
}
echo
printf '%-5s %-9s %-12s %s\n' STAGE COLLECT VERDICT DETAIL
printf '%-5s %-9s %-12s %s\n' ----- ------- ------- ------
any_fail=""
all_pass=yes
summary_json="$LOGS/summary-${TS}.json"
entries=""
for stage in "${STAGES[@]}"; do
	v=$(verdict_of "${JUDGE_RC[$stage]}")
	[ "$v" = fail ] && any_fail=yes
	[ "$v" = pass ] || all_pass=""
	printf '%-5s %-9s %-12s %s\n' "$stage" "${COLLECT_RC[$stage]}" "$v" "${JUDGE_LINE[$stage]}"
	detail=${JUDGE_LINE[$stage]//\\/\\\\}
	detail=${detail//\"/\\\"}
	report=null
	[ -s "${REPORT_PATH[$stage]}" ] && report="\"${REPORT_PATH[$stage]}\""
	entries="${entries}${entries:+,}
    {\"stage\": \"$stage\", \"collectExit\": ${COLLECT_RC[$stage]}, \"judgeExit\": ${JUDGE_RC[$stage]}, \"verdict\": \"$v\", \"report\": $report, \"detail\": \"$detail\"}"
done
printf '{\n  "generatedAt": "%s",\n  "timestamp": "%s",\n  "user": "%s",\n  "stages": [%s\n  ]\n}\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TS" "$REAL_USER" "$entries" >"$summary_json"
echo
echo "reports:  $OUT/{s1,s2,s3}-${TS}.json"
echo "logs:     $LOGS/"
echo "summary:  $summary_json"

if [ -n "$any_fail" ]; then overall=1; elif [ -n "$all_pass" ] && [ "${#STAGES[@]}" -gt 0 ]; then overall=0; else overall=2; fi

# ---- hand the outputs back to the invoking user ------------------------------
if [ "$EUID_NOW" -eq 0 ] && [ "$REAL_USER" != "root" ]; then
	REAL_GROUP=$(id -gn "$REAL_USER" 2>/dev/null || echo "$REAL_USER")
	# Only the acceptance dir, plus parents we may have created under the agent dir.
	chown -R "$REAL_USER:$REAL_GROUP" "$OUT" 2>/dev/null || echo "warning: could not chown $OUT to $REAL_USER" >&2
	for parent in "$AGENT_DIR/synapse" "$AGENT_DIR"; do
		[ -d "$parent" ] && [ "$(stat -c %u "$parent")" -eq 0 ] && chown "$REAL_USER:$REAL_GROUP" "$parent" 2>/dev/null
	done
fi
exit "$overall"

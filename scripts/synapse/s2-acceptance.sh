#!/bin/sh
# S2 real-machine acceptance collection (design §6.2).
#
# Collects facts and prints one JSON report on stdout. It makes no judgement:
# whether the report means S2 passed is decided by
# src/runs/shared/s2-acceptance-report.ts, which is unit-tested on a machine with
# no container engine, no tmpfs mount and no AF_UNIX at all. A shell script that
# also graded itself would put the grading on the one host nobody can test.
#
# Self-contained apart from the repository it measures: scp this file together
# with scripts/synapse/s2-uds-probe.ts and scripts/synapse/mount-objects-tmpfs.sh.
#
#   ./s2-acceptance.sh --repo <path-to-pi-share-agents> [--store <storageRoot>] [--report <file>]
#
# Every check reports one of three outcomes. `unavailable` means the check did
# not run — a missing engine, a missing tool, a mount that was never made.
# `fail` means it ran and the property did not hold. They are never merged: one
# sends you to the machine, the other to the code.
#
# ORDER MATTERS. The strace observation runs BEFORE the reconciliation, because
# its output is what decides which events S3 must add (§4.1), and reconciling
# against a collector that is not yet watching the right syscalls produces a
# difference that means nothing. On this first run the kernel side is expected
# to be absent for exactly that reason, and the judge will call the
# reconciliation `unavailable` rather than inventing a zero for it.

set -eu

REPO=""
REPORT=""
STORE=""
while [ $# -gt 0 ]; do
	case "$1" in
	--repo) REPO=${2:?--repo needs a path}; shift 2 ;;
	--report) REPORT=${2:?--report needs a path}; shift 2 ;;
	--store) STORE=${2:?--store needs a path}; shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 64 ;;
	esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN_ID="s2-$(date +%s)-$$"
IMAGE="pi-subagent-s1:acceptance"

CHECKS=""
PREFLIGHT_STATE="refused"
PREFLIGHT_AVAIL="null"
PREFLIGHT_DETAIL="preflight did not run"

json_escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

add_check() { # add_check <id> <outcome> <detail>
	CHECKS="${CHECKS}${CHECKS:+,}
    {\"id\":\"$1\",\"outcome\":\"$2\",\"detail\":\"$(json_escape "$3")\"}"
}

add_reconciliation() { # add_reconciliation <outcome> <applicationBytes|null> <kernelBytes|null> <detail>
	CHECKS="${CHECKS}${CHECKS:+,}
    {\"id\":\"transport-bytes-reconciliation\",\"outcome\":\"$1\",\"reconciliation\":{\"applicationBytes\":$2,\"kernelBytes\":$3},\"detail\":\"$(json_escape "$4")\"}"
}

emit() {
	_report="{
  \"schemaVersion\": 1,
  \"engine\": {\"id\": \"$(json_escape "${ENGINE_ID:-none}")\", \"version\": \"$(json_escape "${ENGINE_VERSION:-unavailable}")\"},
  \"kernel\": \"$(json_escape "$(uname -sr 2>/dev/null || echo unknown)")\",
  \"preflight\": {\"availableBytes\": ${PREFLIGHT_AVAIL}, \"detail\": \"$(json_escape "$PREFLIGHT_DETAIL")\", \"sharedMemory\": \"${PREFLIGHT_STATE}\"},
  \"checks\": [${CHECKS}
  ]
}"
	if [ -n "$REPORT" ]; then printf '%s\n' "$_report" >"$REPORT"; fi
	printf '%s\n' "$_report"
}

# Emits a complete, parseable report in which nothing ran. Used whenever a
# precondition is missing: a report that is absent teaches nobody anything,
# while a report of four `unavailable` names exactly what the host lacked.
all_unavailable() {
	add_check cross-container-visibility unavailable "$1"
	add_check socket-syscall-trace unavailable "$1"
	add_reconciliation unavailable null null "$1"
	add_check single-round-gear-comparison unavailable "$1"
	emit
	exit 0
}

# ---- preflight: is <storageRoot>/objects really a tmpfs? -------------------
# Runs first and never short-circuits the report: a refused tmpfs does not stop
# the checks, it marks the artifact so that a reader can tell the numbers
# describe an ordinary disk (spec §5, first row).
NODE_BIN=$(command -v node 2>/dev/null || true)
STORE=${STORE:-"${TMPDIR:-/tmp}/$RUN_ID"}
OBJECTS="$STORE/objects"
mkdir -p "$OBJECTS" 2>/dev/null || true

WORK=$(mktemp -d 2>/dev/null) || all_unavailable "could not create a working directory"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -n "$REPO" ] && [ -n "$NODE_BIN" ]; then
	# pathToFileURL rather than a hand-built file:// string: a bare concatenation
	# is correct for an absolute POSIX path and wrong for every other shape, which
	# makes this line unverifiable anywhere but the target host.
	if PREFLIGHT_JSON=$(SYNAPSE_REPO="$REPO" SYNAPSE_OBJECTS="$OBJECTS" "$NODE_BIN" --experimental-strip-types -e "
		const { pathToFileURL } = require('node:url');
		import(pathToFileURL(process.env.SYNAPSE_REPO + '/src/synapse/tmpfs-preflight.ts').href).then(async (m) => {
			const fs = await import('node:fs');
			const probe = m.createTmpfsProbe({
				lstatSync: (p) => fs.lstatSync(p),
				platform: process.platform,
				readFileSync: (p, e) => fs.readFileSync(p, e),
				statfsSync: (p) => fs.statfsSync(p),
			});
			process.stdout.write(JSON.stringify(m.tmpfsPreflightMarker(m.preflightObjectsTmpfs(process.env.SYNAPSE_OBJECTS, probe))));
		}).catch((e) => { process.stderr.write(String(e)); process.exit(1); });
	" 2>"$WORK/preflight.err"); then
		PREFLIGHT_STATE=$(printf '%s' "$PREFLIGHT_JSON" | sed -n 's/.*"sharedMemory":"\([a-z]*\)".*/\1/p')
		PREFLIGHT_AVAIL=$(printf '%s' "$PREFLIGHT_JSON" | sed -n 's/.*"availableBytes":\([0-9]*\|null\).*/\1/p')
		PREFLIGHT_DETAIL=$(printf '%s' "$PREFLIGHT_JSON" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')
		[ -n "$PREFLIGHT_STATE" ] || PREFLIGHT_STATE="refused"
		[ -n "$PREFLIGHT_AVAIL" ] || PREFLIGHT_AVAIL="null"
		[ -n "$PREFLIGHT_DETAIL" ] || PREFLIGHT_DETAIL="preflight produced no detail"
	else
		PREFLIGHT_DETAIL="preflight could not run against $OBJECTS: $(head -c 200 "$WORK/preflight.err" 2>/dev/null | tr '\n' ' ')"
	fi
else
	PREFLIGHT_DETAIL="needs --repo and node on PATH to run the tmpfs preflight"
fi

# ---- preconditions --------------------------------------------------------
[ -n "$REPO" ] || all_unavailable "no --repo given, so nothing in S2 could be exercised"
[ -n "$NODE_BIN" ] || all_unavailable "node is not on PATH"

PROBE="$SCRIPT_DIR/s2-uds-probe.ts"
[ -f "$PROBE" ] || all_unavailable "s2-uds-probe.ts is not next to this script; scp it too"

run_probe() { # run_probe <gear> <runId> -> JSON on stdout, or non-zero
	"$NODE_BIN" --experimental-strip-types "$PROBE" \
		--gear "$1" --store "$STORE" --worktree "$WORK/worktree" --run "$2"
}

json_field() { # json_field <json> <key>  (numbers and bare strings only)
	printf '%s' "$1" | sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p"
}

# ---- 1. cross-container visibility (§6.2.1) --------------------------------
# The cause of a failure here is the bind mount, not an IPC namespace (§3.3):
# <storageRoot> is mounted into every container path by path, so objects/ is the
# same host directory in each of them. The negative control is a container that
# did NOT get the mount — without it, a pass would prove only that two
# containers agreed, not that the mount is why.
ENGINE_ID=""
for candidate in isula docker podman; do
	if command -v "$candidate" >/dev/null 2>&1; then ENGINE_ID=$candidate; break; fi
done
ENGINE_READY=""
if [ -n "$ENGINE_ID" ]; then
	ENGINE_VERSION=$("$ENGINE_ID" --version 2>/dev/null | head -n 1 || echo unavailable)
	# On PATH is not the same as reachable. A stopped daemon and an image that was
	# never built are both missing preconditions — `unavailable` — while `fail`
	# is reserved for containers that ran and disagreed. Without this split, every
	# developer machine with a docker binary and no daemon reports a failed S2.
	if ! "$ENGINE_ID" info >"$WORK/engine.err" 2>&1; then
		# The tail, not the head: `info` prints a long client block before it reports
		# that it could not reach the daemon, so the head is all boilerplate.
		add_check cross-container-visibility unavailable "the $ENGINE_ID engine is on PATH but not reachable: $(tail -n 3 "$WORK/engine.err" 2>/dev/null | tr '\n' ' ' | head -c 160)"
	elif ! "$ENGINE_ID" image inspect "$IMAGE" >/dev/null 2>&1; then
		add_check cross-container-visibility unavailable "image $IMAGE is not built on this host; run scripts/synapse/s1-acceptance.sh first, which builds it"
	else
		ENGINE_READY=yes
	fi
fi
if [ -z "$ENGINE_ID" ]; then
	add_check cross-container-visibility unavailable "no container engine (isula, docker, podman) is on PATH"
elif [ -n "$ENGINE_READY" ]; then
	OBJECT="$OBJECTS/${RUN_ID}.probe"
	if "$ENGINE_ID" run --rm --name "${RUN_ID}-a" -v "$STORE:$STORE" "$IMAGE" \
			/bin/sh -c "dd if=/dev/urandom of=$OBJECT bs=4096 count=1 status=none && sha256sum $OBJECT | cut -d' ' -f1" >"$WORK/a.sum" 2>"$WORK/a.err" \
		&& "$ENGINE_ID" run --rm --name "${RUN_ID}-b" -v "$STORE:$STORE" "$IMAGE" \
			/bin/sh -c "sha256sum $OBJECT | cut -d' ' -f1" >"$WORK/b.sum" 2>"$WORK/b.err"; then
		if "$ENGINE_ID" run --rm --name "${RUN_ID}-c" "$IMAGE" /bin/sh -c "test -f $OBJECT" >/dev/null 2>&1; then
			add_check cross-container-visibility fail "control failed: a container WITHOUT the storage-root mount also saw the object, so this check cannot tell the mount from something else"
		elif [ -s "$WORK/a.sum" ] && [ "$(cat "$WORK/a.sum")" = "$(cat "$WORK/b.sum")" ]; then
			add_check cross-container-visibility pass "B read A's object with an identical digest and an unmounted container could not see it; objects/ preflight says: $PREFLIGHT_STATE"
		else
			add_check cross-container-visibility fail "digests differ: A=$(cat "$WORK/a.sum" 2>/dev/null) B=$(cat "$WORK/b.sum" 2>/dev/null)"
		fi
	else
		add_check cross-container-visibility fail "a probe container did not run: $(head -c 200 "$WORK/a.err" "$WORK/b.err" 2>/dev/null | tr '\n' ' ')"
	fi
fi

# ---- 2. socket syscall observation (§6.2.2) -------------------------------
# Runs before the reconciliation, and is the whole reason this script exists
# before S3's wire protocol is touched: §4.1's expectation (writev plus the
# socket-establishment calls) is an inference, and this turns it into a fact or
# refutes it. The check's subject is whether a sequence was observed at all.
if ! command -v strace >/dev/null 2>&1; then
	add_check socket-syscall-trace unavailable "strace is not on PATH, so the syscall sequence on the AF_UNIX stream was not observed"
elif ! strace -V >"$WORK/strace-v.txt" 2>&1 || ! grep -qi strace "$WORK/strace-v.txt"; then
	# A `strace` on PATH that is not Linux strace — a MinGW shim, a wrapper — takes
	# different flags and fails for reasons that have nothing to do with S2. That
	# is a missing tool, not a failed observation.
	add_check socket-syscall-trace unavailable "the strace on PATH is not Linux strace: $(head -c 120 "$WORK/strace-v.txt" 2>/dev/null | tr '\n' ' ')"
elif strace -f -e trace=network,writev,write,sendmsg,sendto -o "$WORK/strace.txt" \
	"$NODE_BIN" --experimental-strip-types "$PROBE" --gear uds --store "$STORE" --worktree "$WORK/worktree" --run "${RUN_ID}-tr" >"$WORK/trace-probe.json" 2>"$WORK/trace.err"; then
	SEQ=$(grep -oE '\b(socket|socketpair|connect|accept4|accept|bind|listen|writev|write|sendmsg|sendto|recvmsg|readv|read)\(' "$WORK/strace.txt" 2>/dev/null | tr -d '(' | sort -u | tr '\n' ' ' || true)
	if [ -n "$SEQ" ]; then
		add_check socket-syscall-trace pass "observed while the uds gear delivered: ${SEQ}; full trace in strace.txt on the host. This list, not §4.1's inference, is what S3 must learn to collect."
	else
		# strace ran, the probe ran, and no socket or write call appeared. That is a
		# real refutation: the gear did not reach a socket, or the filter is wrong.
		add_check socket-syscall-trace fail "strace ran the probe to completion and no socket or write syscall appeared at all"
	fi
else
	# The probe itself did not complete. Nothing about the syscall sequence was
	# established either way, so this is not-run with a loud detail rather than a
	# refutation of §4.1's expectation.
	add_check socket-syscall-trace unavailable "the traced probe did not complete, so no sequence was observed: $(head -c 200 "$WORK/trace.err" 2>/dev/null | tr '\n' ' ')"
fi

# ---- 3. transportBytes reconciliation (§6.2.3) ----------------------------
# The single criterion for whether S2 met its goal. Two numbers, and the check
# is their difference.
#
# The kernel side is EXPECTED to be absent on this first run: S3's collector
# does not emit socket events yet, and §4.1 forbids changing its wire protocol
# before check 2 above has said which events to add. Reporting `null` is the
# point — a zero here would read as "the kernel saw nothing", which is a
# measurement, and the judge would grade a failure that never happened.
APP_BYTES="null"
if UDS_JSON=$(run_probe uds "${RUN_ID}-u" 2>"$WORK/uds.err"); then
	CANDIDATE=$(json_field "$UDS_JSON" transportBytes)
	case "$CANDIDATE" in
	''|*[!0-9]*) APP_BYTES="null" ;;
	*) APP_BYTES="$CANDIDATE" ;;
	esac
fi
KERNEL_BYTES="null"
RECON_DETAIL="S3's collector emits no socket events yet, so the kernel side was not observed; check 2's syscall list is what it must learn first"
if [ "$APP_BYTES" = "null" ]; then
	RECON_DETAIL="the application reported no transport bytes either: $(head -c 200 "$WORK/uds.err" 2>/dev/null | tr '\n' ' ') — and ${RECON_DETAIL}"
fi
add_reconciliation unavailable "$APP_BYTES" "$KERNEL_BYTES" "$RECON_DETAIL"

# ---- 4. one round of file versus uds (§6.2.4, scoped to S2) ---------------
# One round, recorded, not judged for stability. "Same task, same model, same
# seed" is condition control that belongs to S4's experiment framework; a pass
# here means both gears ran once and each reported its numbers, and asserts
# nothing whatever about reproducibility.
FILE_JSON=$(run_probe file "${RUN_ID}-f" 2>"$WORK/file.err" || true)
UDS_JSON2=$(run_probe uds "${RUN_ID}-u2" 2>"$WORK/uds2.err" || true)
SUMMARY="file: envelopeBytes=$(json_field "$FILE_JSON" envelopeBytes) transportBytes=$(json_field "$FILE_JSON" transportBytes) elapsedMs=$(json_field "$FILE_JSON" elapsedMs) receipt=$(json_field "$FILE_JSON" receiptStatus) | uds: envelopeBytes=$(json_field "$UDS_JSON2" envelopeBytes) transportBytes=$(json_field "$UDS_JSON2" transportBytes) elapsedMs=$(json_field "$UDS_JSON2" elapsedMs) receipt=$(json_field "$UDS_JSON2" receiptStatus)"
# Both rounds must have DELIVERED, not merely exited. A uds round whose envelope
# never arrived produces a receipt of `absent` and `transportBytes` of "N/A", and
# calling that a completed comparison would record a pass for a measurement that
# did not happen — with the file round's numbers sitting beside it looking like
# a contrast.
if [ "$(json_field "$FILE_JSON" receiptStatus)" = "ready" ] && [ "$(json_field "$UDS_JSON2" receiptStatus)" = "ready" ]; then
	add_check single-round-gear-comparison pass "$SUMMARY. One round only; reproducibility is S4's."
elif [ -n "$FILE_JSON" ] || [ -n "$UDS_JSON2" ]; then
	add_check single-round-gear-comparison unavailable "a gear ran but did not deliver, so there is no round to compare — $SUMMARY"
else
	add_check single-round-gear-comparison unavailable "neither gear completed a round: file=$(head -c 120 "$WORK/file.err" 2>/dev/null | tr '\n' ' ') / uds=$(head -c 120 "$WORK/uds2.err" 2>/dev/null | tr '\n' ' ')"
fi

emit

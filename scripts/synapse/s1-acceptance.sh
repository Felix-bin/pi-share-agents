#!/bin/sh
# S1 real-machine acceptance collection (design §6).
#
# Collects facts and prints one JSON report on stdout. It makes no judgement:
# whether the report means S1 passed is decided by
# src/runs/shared/s1-acceptance-report.ts, which is unit-tested on a machine that
# has no container engine at all. A shell script that also graded itself would
# put the grading on the one host nobody can test.
#
# Self-contained: scp this file and scripts/synapse/anchor.sh to the openEuler
# host, run it, and bring the JSON back.
#
#   ./s1-acceptance.sh [--repo <path-to-pi-share-agents>] [--report <file>]
#
# Every check reports one of three outcomes. `unavailable` means the check did
# not run — a missing engine, a missing tool, a missing repository. `fail` means
# it ran and the property did not hold. They are never merged: one sends you to
# the machine, the other to the code.

set -eu

REPO=""
REPORT=""
while [ $# -gt 0 ]; do
	case "$1" in
	--repo) REPO=${2:?--repo needs a path}; shift 2 ;;
	--report) REPORT=${2:?--report needs a path}; shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 64 ;;
	esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN_ID="s1-$(date +%s)-$$"
ANCHOR_NAME="${RUN_ID}-anchor"
IMAGE="pi-subagent-s1:acceptance"

CHECKS=""
json_escape() {
	# Escapes the subset that appears here: backslash, quote, and control chars.
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}
add_check() {
	# add_check <id> <outcome> <bytes> <paths-comma-separated> <detail>
	_paths=""
	if [ -n "$4" ]; then
		_old_ifs=$IFS
		IFS=,
		for _p in $4; do
			_paths="${_paths}${_paths:+,}\"$(json_escape "$_p")\""
		done
		IFS=$_old_ifs
	fi
	CHECKS="${CHECKS}${CHECKS:+,}
    {\"id\":\"$1\",\"outcome\":\"$2\",\"evidence\":{\"bytes\":$3,\"paths\":[${_paths}]},\"detail\":\"$(json_escape "$5")\"}"
}

emit() {
	_report="{
  \"schemaVersion\": 1,
  \"engine\": {\"id\": \"$(json_escape "${ENGINE_ID:-none}")\", \"version\": \"$(json_escape "${ENGINE_VERSION:-unavailable}")\"},
  \"kernel\": \"$(json_escape "$(uname -sr 2>/dev/null || echo unknown)")\",
  \"checks\": [${CHECKS}
  ]
}"
	if [ -n "$REPORT" ]; then printf '%s\n' "$_report" >"$REPORT"; fi
	printf '%s\n' "$_report"
}

all_unavailable() {
	for id in ipc-sharing path-alignment degradation-visible lifecycle-no-leak s3-fd-premise; do
		add_check "$id" unavailable 0 "" "$1"
	done
	emit
	exit 0
}

# ---- engine detection, before anything else needs a tool -------------------
# This short-circuit is what lets the no-engine path be verified on a developer
# machine: it uses only shell builtins, so a stripped PATH still reaches it.
ENGINE_ID=""
for candidate in isula docker podman; do
	if command -v "$candidate" >/dev/null 2>&1; then ENGINE_ID=$candidate; break; fi
done
[ -n "$ENGINE_ID" ] || all_unavailable "no container engine (isula, docker, podman) is on PATH"
ENGINE_VERSION=$("$ENGINE_ID" --version 2>/dev/null | head -n 1 || echo unavailable)

for tool in sha256sum dd mktemp; do
	command -v "$tool" >/dev/null 2>&1 || all_unavailable "required tool '$tool' is not on PATH"
done

WORK=$(mktemp -d) || all_unavailable "could not create a working directory"
STORAGE_ROOT="$WORK/storage"
mkdir -p "$STORAGE_ROOT"
cleanup() {
	sh "$SCRIPT_DIR/anchor.sh" stop "$ENGINE_ID" "$ANCHOR_NAME" 2>/dev/null || true
	rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# NOTE: deliberately no `-v /dev/shm:/dev/shm`. A bind mount there would override
# the tmpfs the shared IPC namespace supplies, and both probe containers would then
# read the same *host* file whether or not `--ipc container:<anchor>` did anything.
# The one check S1 exists to pass would become incapable of failing.
run_in() { # run_in <name> <ipc-arg> <command...>
	_name=$1; _ipc=$2; shift 2
	"$ENGINE_ID" run --rm --name "$_name" --ipc "$_ipc" \
		-v "$STORAGE_ROOT:$STORAGE_ROOT" \
		"$IMAGE" /bin/sh -c "$*"
}

# ---- image ----------------------------------------------------------------
if ! "$ENGINE_ID" image inspect "$IMAGE" >/dev/null 2>&1; then
	if ! "$ENGINE_ID" build -t "$IMAGE" \
		--build-arg "WORKTREE_ROOT=$WORK" --build-arg "STORAGE_ROOT=$STORAGE_ROOT" \
		--build-arg "TEMP_ROOT=$WORK" --build-arg "PI_INSTALL_ROOT=$WORK" --build-arg "NODE_BIN_ROOT=$WORK" \
		"$SCRIPT_DIR/s1-image" >"$WORK/build.log" 2>&1; then
		all_unavailable "container image build failed; see build.log on the host"
	fi
fi

# ---- anchor ---------------------------------------------------------------
ANCHOR_ID=$(sh "$SCRIPT_DIR/anchor.sh" start "$ENGINE_ID" "$IMAGE" "$ANCHOR_NAME" 2>"$WORK/anchor.err") || ANCHOR_ID=""
if [ -z "$ANCHOR_ID" ]; then
	all_unavailable "anchor container would not start: $(head -c 200 "$WORK/anchor.err" 2>/dev/null || echo unknown)"
fi

# ---- 1. cross-container IPC sharing ---------------------------------------
# The one S2 cannot start without: an object A creates in the shared /dev/shm
# must be readable, byte for byte, by B.
PROBE="/dev/shm/${RUN_ID}.probe"
if run_in "${RUN_ID}-a" "container:$ANCHOR_ID" "dd if=/dev/urandom of=$PROBE bs=4096 count=1 status=none && sha256sum $PROBE | cut -d' ' -f1" >"$WORK/a.sum" 2>"$WORK/a.err" \
	&& run_in "${RUN_ID}-b" "container:$ANCHOR_ID" "sha256sum $PROBE | cut -d' ' -f1" >"$WORK/b.sum" 2>"$WORK/b.err"; then
	# Negative control. A container with a private IPC namespace gets its own
	# /dev/shm and must NOT see the object. Without this, a check that passes proves
	# only that two containers agreed — not that the shared namespace is why.
	if run_in "${RUN_ID}-c" "private" "test -f $PROBE" >/dev/null 2>"$WORK/c.err"; then
		add_check ipc-sharing fail 4096 "$PROBE" "control failed: a container with a PRIVATE ipc namespace also saw the object, so this check cannot distinguish sharing from a bind mount"
	elif [ -s "$WORK/a.sum" ] && [ "$(cat "$WORK/a.sum")" = "$(cat "$WORK/b.sum")" ]; then
		add_check ipc-sharing pass 4096 "$PROBE" "B read A's shared-memory object with an identical digest, and a private-namespace container could not see it"
	else
		add_check ipc-sharing fail 4096 "$PROBE" "digests differ: A=$(cat "$WORK/a.sum" 2>/dev/null) B=$(cat "$WORK/b.sum" 2>/dev/null)"
	fi
else
	add_check ipc-sharing fail 0 "$PROBE" "a probe container did not run: $(head -c 200 "$WORK/a.err" "$WORK/b.err" 2>/dev/null | tr '\n' ' ')"
fi

# ---- 2. path alignment ----------------------------------------------------
# Small and large together, because a partial alignment is the hidden case: with
# 100 B inside the root and 10,000,000 B outside it, the books once read clean.
SMALL="$STORAGE_ROOT/small.bin"
LARGE="$STORAGE_ROOT/large.bin"
if run_in "${RUN_ID}-w" "container:$ANCHOR_ID" \
	"dd if=/dev/zero of=$SMALL bs=100 count=1 status=none && dd if=/dev/zero of=$LARGE bs=1000000 count=10 status=none" >/dev/null 2>"$WORK/w.err"; then
	SMALL_BYTES=$(wc -c <"$SMALL" 2>/dev/null || echo 0)
	LARGE_BYTES=$(wc -c <"$LARGE" 2>/dev/null || echo 0)
	TOTAL=$((SMALL_BYTES + LARGE_BYTES))
	if [ "$SMALL_BYTES" -eq 100 ] && [ "$LARGE_BYTES" -eq 10000000 ]; then
		add_check path-alignment pass "$TOTAL" "$SMALL,$LARGE" "host reads both files at the same absolute paths the container wrote; nothing landed outside the storage root"
	else
		add_check path-alignment fail "$TOTAL" "$SMALL,$LARGE" "host sees $SMALL_BYTES and $LARGE_BYTES bytes, expected 100 and 10000000"
	fi
else
	add_check path-alignment fail 0 "$SMALL,$LARGE" "writer container did not run: $(head -c 200 "$WORK/w.err" 2>/dev/null)"
fi

# ---- 3. degradation is visible -------------------------------------------
# Exercises the real seam with every engine hidden, and asserts the run says so.
NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -n "$REPO" ] && [ -n "$NODE_BIN" ]; then
	# The absolute path matters: `PATH=/nonexistent node …` makes the shell look for
	# `node` under /nonexistent too, so the check would fail on every host where it
	# actually runs — and record `fail` for a degradation path that worked.
	if PATH=/nonexistent "$NODE_BIN" --experimental-strip-types -e "
		import('file://$REPO/src/runs/shared/container-launch.ts').then((m) => {
			const r = m.resolveSubagentLaunch({
				launch: { command: '/opt/pi/bin/node', args: [], cwd: '/srv/pi/worktree' },
				env: { PI_SUBAGENT_CONTAINER_TOPOLOGY: 'container', PI_SUBAGENT_CONTAINER_IMAGE: 'x', PI_SUBAGENT_CONTAINER_ANCHOR: 'y', PI_SUBAGENT_CONTAINER_MOUNTS: '/srv,/opt', PI_SUBAGENT_CONTAINER_STORAGE_ROOT: '/srv/pi/synapse' },
				tempRoot: '/srv/pi/temp', piInstallRoot: '/opt/pi',
			});
			if (r.topology !== 'process' || !r.env.PI_SUBAGENT_LAUNCH_DEGRADED_REASON) process.exit(1);
			process.stdout.write(r.env.PI_SUBAGENT_LAUNCH_DEGRADED_REASON);
		}).catch(() => process.exit(2));
	" >"$WORK/degraded.txt" 2>"$WORK/degraded.err"; then
		add_check degradation-visible pass 0 "" "with no engine on PATH the run reports process topology and a reason: $(head -c 160 "$WORK/degraded.txt")"
	else
		add_check degradation-visible fail 0 "" "seam did not report a visible degradation: $(head -c 200 "$WORK/degraded.err" 2>/dev/null)"
	fi
else
	add_check degradation-visible unavailable 0 "" "needs --repo and node on PATH to exercise the launch seam"
fi

# ---- 4. lifecycle leaves nothing behind -----------------------------------
sh "$SCRIPT_DIR/anchor.sh" stop "$ENGINE_ID" "$ANCHOR_NAME" >/dev/null 2>&1 || true
# Ask first whether we can look at all. `ps` failing and `ps` returning nothing are
# different facts, and a discarded stderr turns the first into a clean bill of health.
if "$ENGINE_ID" ps -a --format '{{.Names}}' >"$WORK/ps.txt" 2>"$WORK/ps.err"; then
	LEAKED=$(grep -c "^${RUN_ID}" "$WORK/ps.txt" || true)
	if [ "${LEAKED:-0}" -eq 0 ]; then
		add_check lifecycle-no-leak pass 0 "" "no container named ${RUN_ID}* survived the anchor teardown"
	else
		add_check lifecycle-no-leak fail 0 "" "$LEAKED container(s) named ${RUN_ID}* are still present after teardown"
	fi
else
	add_check lifecycle-no-leak unavailable 0 "" "could not list containers, so nothing was checked: $(head -c 200 "$WORK/ps.err" 2>/dev/null)"
fi

# ---- 5. S3's inherited-fd premise -----------------------------------------
# S1 changes how logs are captured: the parent can no longer hand a file descriptor
# across a container boundary, and S3 assumed writes on an inherited fd always exist.
#
# This check measures ONE thing and claims nothing else: whether a descriptor the
# parent opened is still reachable inside the container. It cannot observe S3's
# `unknownDescriptor` composition — that needs S3's collector running — so the
# outcome is `unavailable` with the measurement in the detail, not `pass`. A `pass`
# would feed an overall verdict and assert more than was looked at.
MARKER="$STORAGE_ROOT/fd-marker.txt"
echo "written by the parent" >"$MARKER"
exec 9>>"$MARKER"
if "$ENGINE_ID" run --rm --name "${RUN_ID}-fd" -v "$STORAGE_ROOT:$STORAGE_ROOT" "$IMAGE" \
	/bin/sh -c 'if [ -e /proc/self/fd/9 ]; then echo inherited; else echo not-inherited; fi' >"$WORK/fd.txt" 2>"$WORK/fd.err"; then
	FD_STATE=$(tr -d '[:space:]' <"$WORK/fd.txt" || echo unknown)
	add_check s3-fd-premise unavailable 0 "$MARKER" "parent-opened fd 9 is '${FD_STATE:-unknown}' inside the container; S3's unknownDescriptor composition must be re-verified with S3's collector running, which this script cannot do"
else
	add_check s3-fd-premise unavailable 0 "$MARKER" "could not inspect descriptors inside a container: $(head -c 200 "$WORK/fd.err" 2>/dev/null)"
fi
exec 9>&-

emit

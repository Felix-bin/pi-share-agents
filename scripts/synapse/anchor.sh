#!/bin/sh
# Creates and destroys the anchor container that holds the shared IPC namespace
# (S1 design §3.2). Agent containers join it with `--ipc container:<id>`.
#
# The anchor must outlive every agent container. This script only starts and stops
# it; whether a *given* agent may launch, and whether the anchor may be destroyed
# yet, are decided by `resolveAnchorGate` / `resolveAnchorTeardown` in
# src/runs/shared/container-anchor.ts, which are unit-tested. Keeping the decisions
# there and the side effects here is what lets the decisions be proven on a machine
# that has no container engine at all.
#
# Usage:
#   anchor.sh start <engine> <image> <name>   -> prints the anchor container id
#   anchor.sh stop  <engine> <name>
#   anchor.sh state <engine> <name>           -> absent | starting | running | stopping

set -eu

action=${1:?usage: anchor.sh <start|stop|state> ...}
engine=${2:?missing engine (isula|docker|podman)}

case "$action" in
start)
	image=${3:?missing image}
	name=${4:?missing anchor name}
	# `sleep infinity` is the whole job: the anchor owns a namespace, it does no
	# work. It must not exit before the agents do, and a process that cannot fail
	# on its own is the simplest way to guarantee that.
	"$engine" run -d --name "$name" --ipc shareable "$image" /bin/sh -c 'sleep infinity' >/dev/null
	"$engine" inspect -f '{{.Id}}' "$name"
	;;
stop)
	name=${3:?missing anchor name}
	"$engine" rm -f "$name" >/dev/null 2>&1 || true
	;;
state)
	name=${3:?missing anchor name}
	if ! "$engine" inspect -f '{{.State.Status}}' "$name" >/dev/null 2>&1; then
		echo absent
		exit 0
	fi
	status=$("$engine" inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo absent)
	case "$status" in
	running) echo running ;;
	created | restarting) echo starting ;;
	removing | paused | exited | dead) echo stopping ;;
	*) echo absent ;;
	esac
	;;
*)
	echo "unknown action: $action" >&2
	exit 64
	;;
esac

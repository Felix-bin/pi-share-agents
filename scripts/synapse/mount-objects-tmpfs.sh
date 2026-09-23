#!/usr/bin/env bash
# Mounts a tmpfs at <storageRoot>/objects, which is what the S2 shared-memory
# data plane means by "shared memory" (design §3.2).
#
#   sudo ./mount-objects-tmpfs.sh <storageRoot> [size]
#   sudo ./mount-objects-tmpfs.sh <storageRoot> --undo
#
# Self-contained: scp this one file to the openEuler host and run it.
#
# WHY A MOUNT AND NOT A SYMLINK
# -----------------------------
# The obvious shortcut is `ln -s /dev/shm/synapse-objects <storageRoot>/objects`.
# It appears to work, and it silently destroys the measurement the whole plane
# exists to produce.
#
# S3's collector records the path the *kernel* resolved. Under a symlink that
# path is /dev/shm/..., which is outside the storage root, so every content byte
# is classified `outside-root` — a bucket `trace-classify.ts` deliberately
# refuses to report on, because an account whose bytes all fell outside its own
# root is not an account. Under `mount --bind` the resolved path is still
# <storageRoot>/objects/..., unchanged, and attribution keeps working.
#
# Nothing warns you. The run completes, the numbers look like numbers, and they
# are numbers about the wrong filesystem. `preflightObjectsTmpfs` refuses a
# symlinked objects directory for exactly this reason.
set -euo pipefail

storage_root="${1:-}"
size="${2:-}"

if [ -z "$storage_root" ]; then
	echo "usage: $0 <storageRoot> [size|--undo]" >&2
	exit 64
fi

objects="$storage_root/objects"

if [ "$size" = "--undo" ]; then
	if mountpoint -q "$objects"; then
		umount "$objects"
		echo "unmounted $objects"
	else
		echo "$objects is not a mount point; nothing to undo"
	fi
	exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
	echo "This host is not Linux; a tmpfs bind mount is a Linux operation." >&2
	exit 1
fi

if [ "$(id -u)" != "0" ]; then
	echo "Mounting needs root. Re-run with sudo." >&2
	exit 1
fi

# The directory has to exist first, and it has to be a real directory: mounting
# onto a symlink mounts onto its target, which is the failure this script exists
# to prevent.
if [ -L "$objects" ]; then
	echo "REFUSING: $objects is a symbolic link." >&2
	echo "Remove it and let this script create a real directory; see the header of this file for why." >&2
	exit 1
fi
mkdir -p "$objects"

if mountpoint -q "$objects"; then
	echo "$objects is already a mount point:"
	findmnt --noheadings --output SOURCE,FSTYPE,SIZE,AVAIL,TARGET "$objects"
	exit 0
fi

# Existing content would be hidden, not deleted, by the mount — and would come
# back on unmount, which is confusing enough to be worth refusing over.
if [ -n "$(ls -A "$objects" 2>/dev/null)" ]; then
	echo "REFUSING: $objects is not empty. A mount would hide its contents rather than move them." >&2
	exit 1
fi

mount_options="mode=0700"
if [ -n "$size" ]; then
	mount_options="size=$size,$mount_options"
fi
# tmpfs directly at the target, not a bind of /dev/shm: one filesystem, one
# path, nothing to resolve elsewhere. A bind of a separate tmpfs directory works
# equally well for attribution; this is simply the shorter way to get there.
mount -t tmpfs -o "$mount_options" synapse-objects "$objects"

echo "mounted tmpfs at $objects"
findmnt --noheadings --output SOURCE,FSTYPE,SIZE,AVAIL,TARGET "$objects"
echo
echo "This is per-boot and volatile (design §4.4): every object is gone after a reboot,"
echo "and every memoryId then resolves to object-unavailable. That is the accepted"
echo "behaviour, not a defect — run an experiment within one boot."
echo
echo "To make it survive reboots, add to /etc/fstab (the mount, never a symlink):"
echo "  synapse-objects  $objects  tmpfs  ${mount_options}  0 0"

# S1 agent container image.
#
# Deliberately almost empty. Everything the subagent executes — Node, the Pi
# install, the worktree, the SYNAPSE storage root, the temp root — is bind-mounted
# from the host at its own absolute path (design §4.1). Baking copies of them into
# the image would put a *second* copy at the same path and make "the container saw
# the same bytes as the host" untestable: the accounting would line up by
# coincidence of layout rather than by identity.
#
# This also settles design §7's open question about Node 24 on
# openEuler 24.03-LTS-SP3: the image does not install Node at all. It runs the
# host's Node, which is necessarily Node 24 already, because the parent Pi session
# is running on it. The base image matches the host distribution so that a host
# binary is dynamically linkable inside the container.
#
# If a deployment ever needs Node *inside* the image instead — a host whose Node
# is too old, or a read-only host mount — the replacement is the official
# nodejs.org linux-x64 tarball rather than a distro package: it is glibc-based and
# needs only glibc >= 2.28, which openEuler 24.03 (glibc 2.38) satisfies. Install
# it at the same absolute path the host uses and drop that path from the mount list.

ARG OPENEULER_TAG=24.03-lts
FROM openeuler/openeuler:${OPENEULER_TAG}

# The mount points must exist before `-v <path>:<path>` binds onto them for
# engines that do not create them; creating them here keeps the launch command
# free of engine-specific flags.
ARG WORKTREE_ROOT
ARG STORAGE_ROOT
ARG TEMP_ROOT
ARG PI_INSTALL_ROOT
ARG NODE_BIN_ROOT

RUN set -eu; \
	for dir in "$WORKTREE_ROOT" "$STORAGE_ROOT" "$TEMP_ROOT" "$PI_INSTALL_ROOT" "$NODE_BIN_ROOT"; do \
		[ -n "$dir" ] && mkdir -p "$dir"; \
	done; \
	mkdir -p /dev/shm

# No ENTRYPOINT: `resolveContainerLaunch` appends the host's own command and argv
# after the image name, unchanged. An entrypoint here would silently prefix it.
CMD ["/bin/sh", "-c", "echo 'S1 agent image: launched with no command' >&2; exit 64"]

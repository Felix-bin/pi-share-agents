import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createTmpfsProbe,
	fstypeForPath,
	preflightObjectsTmpfs,
	sharedMemoryClaimPermitted,
	tmpfsPreflightMarker,
	TMPFS_MAGIC,
	type PathEntryKind,
	type TmpfsProbe,
} from "../../src/synapse/tmpfs-preflight.ts";

/**
 * Whether `<storageRoot>/objects` is really a tmpfs.
 *
 * The check exists because the mount is an operations action and can simply not
 * have happened, in which case the run measures an ordinary disk and says
 * nothing about it. Everything here is therefore about refusing to answer
 * rather than about answering: the three outcomes stay three, and the one
 * arrangement that looks right and is wrong — a symlink — is refused even
 * though it points at a real tmpfs.
 */

const OBJECTS = "/srv/synapse/ns/objects";

function probe(overrides: Partial<TmpfsProbe> = {}): TmpfsProbe {
	return {
		entry: overrides.entry ?? ((): PathEntryKind => "directory"),
		procMounts: overrides.procMounts ?? (() => null),
		statfs: overrides.statfs ?? (() => null),
	};
}

describe("the tmpfs decision", () => {
	it("passes a tmpfs and carries its free capacity", () => {
		// Capacity is on the record so that "the run started failing to write" has
		// a cause somebody can look up afterwards (spec §7).
		const result = preflightObjectsTmpfs(OBJECTS, probe({ statfs: () => ({ availableBytes: 2 * 1024 ** 3, type: TMPFS_MAGIC }) }));
		assert.equal(result.status, "tmpfs");
		if (result.status !== "tmpfs") return;
		assert.equal(result.availableBytes, 2 * 1024 ** 3);
		assert.equal(result.evidence, "statfs");
		assert.equal(sharedMemoryClaimPermitted(result), true);
	});

	it("refuses an ordinary filesystem and marks the refusal in the artifact", () => {
		const result = preflightObjectsTmpfs(OBJECTS, probe({ statfs: () => ({ availableBytes: 10 ** 12, type: 0xef53 }) }));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.cause, "not-tmpfs");
		assert.equal(sharedMemoryClaimPermitted(result), false);
		// The marker is the point: a refusal has to travel with the numbers, not
		// be lost with the console output that produced it (spec §5).
		const marker = tmpfsPreflightMarker(result);
		assert.equal(marker.sharedMemory, "refused");
		assert.equal(marker.availableBytes, null);
		assert.match(marker.detail, /not-tmpfs/);
		assert.match(marker.detail, /ef53/);
	});

	it("says 'cannot tell' on a host with no f_type and no /proc, which is not the same as 'not a tmpfs'", () => {
		// A Windows development machine. Reporting this as `not-tmpfs` would read
		// like a finding about the deployment when it is a fact about the laptop.
		const result = preflightObjectsTmpfs(OBJECTS, probe());
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.cause, "undetermined");
		assert.notEqual(result.cause, "not-tmpfs");
		assert.equal(sharedMemoryClaimPermitted(result), false);
		assert.match(tmpfsPreflightMarker(result).detail, /undetermined/);
	});

	it("keeps the two refusals apart in the artifact, not only in the return value", () => {
		const cannotTell = tmpfsPreflightMarker(preflightObjectsTmpfs(OBJECTS, probe()));
		const isNotTmpfs = tmpfsPreflightMarker(preflightObjectsTmpfs(OBJECTS, probe({ statfs: () => ({ availableBytes: 1, type: 0xef53 }) })));
		// Both withhold the claim, and a reader of the report can still tell which
		// happened. Collapsing them would make an unrun check indistinguishable
		// from a failed one — the same three-state discipline S1 established.
		assert.equal(cannotTell.sharedMemory, "refused");
		assert.equal(isNotTmpfs.sharedMemory, "refused");
		assert.notEqual(cannotTell.detail, isNotTmpfs.detail);
	});

	it("refuses a symlink even when it points at a real tmpfs", () => {
		// The `statfs` here reports a genuine tmpfs, because a symlink to /dev/shm
		// does. The refusal is not about the filesystem: the kernel resolves the
		// path elsewhere, so every content byte lands outside the storage root and
		// `trace-classify.ts` will not report on it. It has to be mount --bind.
		const result = preflightObjectsTmpfs(OBJECTS, probe({
			entry: () => "symlink",
			statfs: () => ({ availableBytes: 10 ** 9, type: TMPFS_MAGIC }),
		}));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.cause, "symlinked");
		assert.match(result.reason, /mount --bind, not ln -s/);
	});

	it("refuses a missing or non-directory objects path before asking any filesystem question", () => {
		const missing = preflightObjectsTmpfs(OBJECTS, probe({ entry: () => "missing", statfs: () => ({ availableBytes: 1, type: TMPFS_MAGIC }) }));
		assert.equal(missing.status === "refused" && missing.cause, "not-tmpfs");
		const file = preflightObjectsTmpfs(OBJECTS, probe({ entry: () => "other", statfs: () => ({ availableBytes: 1, type: TMPFS_MAGIC }) }));
		assert.equal(file.status === "refused" && file.cause, "not-tmpfs");
	});

	it("never reports an unmeasured capacity as zero", () => {
		// /proc/mounts names the filesystem but not its free space. Zero would read
		// as a measurement, and "zero bytes free" is a real and very different
		// state — the same distinction `transportBytes` draws with "N/A".
		const result = preflightObjectsTmpfs(OBJECTS, probe({ procMounts: () => `tmpfs ${OBJECTS} tmpfs rw,mode=700 0 0\n` }));
		assert.equal(result.status, "tmpfs");
		if (result.status !== "tmpfs") return;
		assert.equal(result.availableBytes, null);
		assert.notEqual(result.availableBytes, 0);
		assert.equal(result.evidence, "proc-mounts");
	});
});

describe("reading /proc/mounts", () => {
	const MOUNTS = [
		"/dev/root / ext4 rw,relatime 0 0",
		"tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0",
		"/dev/sda1 /srv ext4 rw,relatime 0 0",
		`tmpfs ${OBJECTS} tmpfs rw,mode=700 0 0`,
		"",
	].join("\n");

	it("answers with the deepest mount covering the path, not the first one that matches", () => {
		// `/` covers everything. A scan that stopped at the first match would
		// report ext4 for every path on the host and never see a bind mount.
		assert.equal(fstypeForPath(MOUNTS, OBJECTS), "tmpfs");
		assert.equal(fstypeForPath(MOUNTS, `${OBJECTS}/ab/cdef`), "tmpfs");
		assert.equal(fstypeForPath(MOUNTS, "/srv/synapse/ns/memory"), "ext4");
		assert.equal(fstypeForPath(MOUNTS, "/home/felix"), "ext4");
	});

	it("matches whole path segments, so a sibling directory is not mistaken for the mount", () => {
		// `/srv/synapse/ns/objects-backup` is not under `/srv/synapse/ns/objects`.
		assert.equal(fstypeForPath(MOUNTS, `${OBJECTS}-backup`), "ext4");
	});

	it("decodes the octal escapes the kernel writes for a mount point containing a space", () => {
		const mounts = "tmpfs /srv/my\\040store/objects tmpfs rw 0 0\n/dev/root / ext4 rw 0 0\n";
		assert.equal(fstypeForPath(mounts, "/srv/my store/objects/ab"), "tmpfs");
		assert.equal(fstypeForPath(mounts, "/srv/my\\040store/objects/ab"), "ext4", "the raw escaped text names no real path");
	});

	it("reports no covering mount rather than guessing", () => {
		assert.equal(fstypeForPath("garbage\n\n", OBJECTS), null);
		const result = preflightObjectsTmpfs(OBJECTS, probe({ procMounts: () => "garbage\n" }));
		assert.equal(result.status === "refused" && result.cause, "undetermined");
	});

	it("falls through to /proc/mounts only when statfs could not answer", () => {
		// statfs is authoritative where it exists; /proc/mounts is the fallback for
		// a kernel that answers one and not the other.
		const result = preflightObjectsTmpfs(OBJECTS, probe({
			procMounts: () => `tmpfs ${OBJECTS} tmpfs rw 0 0\n`,
			statfs: () => ({ availableBytes: 1, type: 0xef53 }),
		}));
		assert.equal(result.status === "refused" && result.cause, "not-tmpfs", "a definite statfs answer is not second-guessed");
	});
});

describe("the real probe", () => {
	function stubs(platform: string) {
		const calls: string[] = [];
		const probeUnderTest = createTmpfsProbe({
			lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
			platform,
			readFileSync: (path) => {
				calls.push(`read:${path}`);
				return "tmpfs / tmpfs rw 0 0\n";
			},
			statfsSync: () => {
				calls.push("statfs");
				return { bavail: 4, bsize: 1024, type: TMPFS_MAGIC };
			},
		});
		return { calls, probeUnderTest };
	}

	it("uses both POSIX sources on Linux", () => {
		const { calls, probeUnderTest } = stubs("linux");
		assert.deepEqual(probeUnderTest.statfs(OBJECTS), { availableBytes: 4096, type: TMPFS_MAGIC });
		assert.equal(probeUnderTest.procMounts(), "tmpfs / tmpfs rw 0 0\n");
		assert.deepEqual(calls, ["statfs", "read:/proc/mounts"]);
	});

	it("refuses to interpret f_type off Linux, rather than comparing numbers from another namespace", () => {
		// Node answers statfsSync on Windows, with a filesystem code that is not
		// comparable against TMPFS_MAGIC. Comparing them would yield "not a tmpfs"
		// on every host, indistinguishable from a deployment whose mount failed.
		const { calls, probeUnderTest } = stubs("win32");
		assert.equal(probeUnderTest.statfs(OBJECTS), null);
		assert.equal(probeUnderTest.procMounts(), null);
		assert.deepEqual(calls, [], "neither POSIX source is even consulted");
		assert.equal(preflightObjectsTmpfs(OBJECTS, probeUnderTest).status, "refused");
	});

	it("reports a missing path as missing rather than throwing", () => {
		const probeUnderTest = createTmpfsProbe({
			lstatSync: () => {
				throw new Error("ENOENT");
			},
			platform: "linux",
			readFileSync: () => "",
			statfsSync: () => ({ bavail: 0, bsize: 0, type: 0 }),
		});
		assert.equal(probeUnderTest.entry(OBJECTS), "missing");
	});

	it("names a symlink as one, without following it", () => {
		const probeUnderTest = createTmpfsProbe({
			lstatSync: () => ({ isDirectory: () => false, isSymbolicLink: () => true }),
			platform: "linux",
			readFileSync: () => "",
			statfsSync: () => ({ bavail: 0, bsize: 0, type: TMPFS_MAGIC }),
		});
		assert.equal(probeUnderTest.entry(OBJECTS), "symlink");
	});
});

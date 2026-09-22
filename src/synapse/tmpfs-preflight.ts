/**
 * Is `<storageRoot>/objects` really on a tmpfs?
 *
 * Design §3.2 does not move the storage root onto `/dev/shm`; it bind mounts a
 * tmpfs *onto* `<storageRoot>/objects`, so that the path a process opens and
 * the path the kernel resolves stay the same string and S3's attribution keeps
 * working. The cost of that choice is that enabling shared memory becomes an
 * operations action rather than a code path — and an operations action can
 * simply not have happened.
 *
 * Without this check that failure is silent and expensive: the run completes,
 * the numbers look like numbers, and what was actually measured is an ordinary
 * disk. So the rule (spec §5, first row) is that an unproven tmpfs refuses the
 * shared-memory claim and is **marked in the artifact**, rather than being
 * assumed.
 *
 * **Three conclusions, not two.** "This is not a tmpfs" and "this host cannot
 * tell me" are different facts and are never merged. A Windows development
 * machine has no `f_type` and no `/proc`; reporting that as "not a tmpfs" would
 * read like a finding about the deployment when it is a statement about the
 * laptop the test ran on. Only `tmpfs` permits the claim; both refusals
 * withhold it, and they say which one they are.
 *
 * **A symlink is refused even when it points at a tmpfs.** This is the one
 * mistake §3.2 calls out as easy to make and silent in its consequences:
 * `ln -s /dev/shm/objects <storageRoot>/objects` passes every test a human
 * would think to run, and then the kernel resolves every open to `/dev/shm/...`,
 * which lands outside the storage root — exactly the case `trace-classify.ts`
 * refuses to report on. It has to be `mount --bind`, and this is the check that
 * can tell the difference.
 *
 * Pure: every probe is injected. `createTmpfsProbe` builds the real one.
 */

/** `TMPFS_MAGIC` from the Linux headers. The value is the whole point of `statfs` here. */
export const TMPFS_MAGIC = 0x01021994;

export type PathEntryKind = "directory" | "missing" | "other" | "symlink";

export type TmpfsProbe = {
	/** What the last path component itself is, without following it. */
	entry: (path: string) => PathEntryKind;
	/** `/proc/mounts` as text, or `null` where there is no `/proc`. */
	procMounts: () => string | null;
	/**
	 * `statfs` for a path, or `null` where `f_type` carries no POSIX meaning.
	 * Windows answers `statfs` calls, but with a number that is not comparable
	 * against `TMPFS_MAGIC`; treating it as one would turn "cannot tell" into a
	 * confident wrong answer.
	 */
	statfs: (path: string) => { availableBytes: number; type: number } | null;
};

export type TmpfsPreflight =
	| {
		/**
		 * Free bytes on the tmpfs, or `null` when the evidence that proved it was a
		 * tmpfs cannot also measure it. tmpfs is capped globally, usually at half of
		 * RAM, and spec §7 wants that number on the record so that "the run started
		 * failing to write" has a cause somebody can look up. `null` rather than `0`,
		 * for the same reason `transportBytes` reports `"N/A"`: an unmeasured
		 * quantity written as zero reads as a measurement, and zero free bytes is a
		 * genuine and very different state.
		 */
		availableBytes: number | null;
		/** How the answer was reached, so a report can be read without rerunning it. */
		evidence: "proc-mounts" | "statfs";
		status: "tmpfs";
	}
	| {
		cause: "not-tmpfs" | "symlinked" | "undetermined";
		reason: string;
		status: "refused";
	};

/** Whether a run may claim it measured shared memory. Only a proven tmpfs may. */
export function sharedMemoryClaimPermitted(preflight: TmpfsPreflight): boolean {
	return preflight.status === "tmpfs";
}

/**
 * The line a report carries so that a refusal travels with the numbers instead
 * of being lost with the console output that produced them (spec §5).
 */
export function tmpfsPreflightMarker(preflight: TmpfsPreflight): {
	availableBytes: number | null;
	detail: string;
	sharedMemory: "refused" | "tmpfs";
} {
	if (preflight.status === "tmpfs") {
		return { availableBytes: preflight.availableBytes, detail: `tmpfs confirmed via ${preflight.evidence}`, sharedMemory: "tmpfs" };
	}
	return { availableBytes: null, detail: `${preflight.cause}: ${preflight.reason}`, sharedMemory: "refused" };
}

/**
 * Splits a `/proc/mounts` line, undoing the octal escapes the kernel writes for
 * the four characters that would otherwise break the field separator. A mount
 * point containing a space is unusual and entirely legal; decoding it wrongly
 * would silently pick the wrong mount for the path being judged.
 */
function unescapeMountField(field: string): string {
	return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** True when `mountPoint` is `path` or one of its ancestors, comparing whole path segments. */
function covers(mountPoint: string, path: string): boolean {
	if (mountPoint === path) return true;
	const prefix = mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`;
	return path.startsWith(prefix);
}

/**
 * The filesystem type mounted at the deepest mount point covering `path`.
 *
 * Deepest, not first: `/` covers everything, so a scan that stopped at the
 * first match would report the root filesystem for every path on the host and
 * never see a bind mount at all.
 */
export function fstypeForPath(procMounts: string, path: string): string | null {
	let best: { fstype: string; length: number } | null = null;
	for (const line of procMounts.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 3) continue;
		const mountPoint = unescapeMountField(fields[1] ?? "");
		const fstype = fields[2] ?? "";
		if (mountPoint.length === 0 || !covers(mountPoint, path)) continue;
		if (best === null || mountPoint.length > best.length) best = { fstype, length: mountPoint.length };
	}
	return best === null ? null : best.fstype;
}

export function preflightObjectsTmpfs(objectsPath: string, probe: TmpfsProbe): TmpfsPreflight {
	// Checked before anything else, and never folded into the tmpfs question: a
	// symlink to a tmpfs would satisfy `statfs` while breaking the one property
	// the bind mount exists to preserve.
	const entry = probe.entry(objectsPath);
	if (entry === "symlink") {
		return {
			cause: "symlinked",
			reason: `${objectsPath} is a symbolic link; the kernel resolves it elsewhere and every content byte lands outside the storage root. Use mount --bind, not ln -s`,
			status: "refused",
		};
	}
	if (entry === "missing") {
		return { cause: "not-tmpfs", reason: `${objectsPath} does not exist, so no tmpfs is mounted there`, status: "refused" };
	}
	if (entry === "other") {
		return { cause: "not-tmpfs", reason: `${objectsPath} is not a directory, so nothing can be mounted at it`, status: "refused" };
	}

	const statfs = probe.statfs(objectsPath);
	if (statfs !== null) {
		if (statfs.type === TMPFS_MAGIC) return { availableBytes: statfs.availableBytes, evidence: "statfs", status: "tmpfs" };
		return {
			cause: "not-tmpfs",
			reason: `${objectsPath} reports f_type 0x${statfs.type.toString(16)}, not TMPFS_MAGIC (0x${TMPFS_MAGIC.toString(16)})`,
			status: "refused",
		};
	}

	const mounts = probe.procMounts();
	if (mounts === null) {
		return {
			cause: "undetermined",
			reason: `this host offers neither a POSIX f_type nor /proc/mounts, so whether ${objectsPath} is a tmpfs cannot be established here`,
			status: "refused",
		};
	}
	const fstype = fstypeForPath(mounts, objectsPath);
	if (fstype === null) {
		return { cause: "undetermined", reason: `no mount point in /proc/mounts covers ${objectsPath}`, status: "refused" };
	}
	if (fstype !== "tmpfs") {
		return { cause: "not-tmpfs", reason: `${objectsPath} is on a ${fstype} filesystem`, status: "refused" };
	}
	// `/proc/mounts` names the filesystem but not its free space.
	return { availableBytes: null, evidence: "proc-mounts", status: "tmpfs" };
}

/**
 * The real probe.
 *
 * Both POSIX sources are switched off anywhere but Linux, which is what makes a
 * Windows run report `undetermined` instead of a confident falsehood: Node
 * answers `statfsSync` on Windows, but with a filesystem code from a different
 * namespace than `TMPFS_MAGIC`, and comparing the two would produce
 * "not a tmpfs" every time, on every host, with no way to tell that apart from
 * a real deployment whose mount failed.
 */
export function createTmpfsProbe(deps: {
	lstatSync: (path: string) => { isDirectory: () => boolean; isSymbolicLink: () => boolean };
	platform: string;
	readFileSync: (path: string, encoding: "utf-8") => string;
	statfsSync: (path: string) => { bavail: number; bsize: number; type: number };
}): TmpfsProbe {
	const posix = deps.platform === "linux";
	return {
		entry(path) {
			try {
				const stat = deps.lstatSync(path);
				if (stat.isSymbolicLink()) return "symlink";
				return stat.isDirectory() ? "directory" : "other";
			} catch {
				return "missing";
			}
		},
		procMounts() {
			if (!posix) return null;
			try {
				return deps.readFileSync("/proc/mounts", "utf-8");
			} catch {
				return null;
			}
		},
		statfs(path) {
			if (!posix) return null;
			try {
				const stat = deps.statfsSync(path);
				return { availableBytes: stat.bavail * stat.bsize, type: stat.type };
			} catch {
				return null;
			}
		},
	};
}

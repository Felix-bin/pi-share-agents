import * as path from "node:path";

/**
 * S1 design §3.3. The engines differ only in their binary name and in the shape
 * of the version string their preflight accepts; every flag this module builds
 * (`--ipc container:<id>`, `-v <host>:<container>`, `-w`, `--rm`) means the same
 * thing in all three. Keeping them in a table is what lets an unverified target
 * environment stop being an assumption baked into a function signature.
 */
export const CONTAINER_ENGINE_IDS = ["isula", "docker", "podman"] as const;

export type ContainerEngineId = (typeof CONTAINER_ENGINE_IDS)[number];

export interface ContainerEngineSpec {
	id: ContainerEngineId;
	binary: string;
}

export function containerEngineSpec(id: ContainerEngineId): ContainerEngineSpec {
	return { id, binary: id };
}

/**
 * The four absolute path roots that must mean the same thing inside and outside
 * the container (S1 design §4.1). They are named rather than collected into a
 * list so that a misalignment can say *which* root is wrong: the failure this
 * guards against is a partial alignment, where a run looks accounted-for because
 * the bytes that escaped the storage root were the ones nobody checked.
 */
export interface RequiredPathRoots {
	/** The subagent's working directory. */
	worktree: string;
	/** The SYNAPSE storage root the kernel-side collector classifies against. */
	storageRoot: string;
	/** `TEMP_ROOT_DIR` — holds the runner config, asyncDir, and logs. */
	tempRoot: string;
	/** Where the Pi host or npm package lives; its path travels in the child's argv. */
	piInstallRoot: string;
}

export type LaunchTopology = "process" | "container";

export interface ContainerLaunchInput {
	topology: LaunchTopology;
	engine: ContainerEngineSpec;
	anchorContainerId: string;
	image: string;
	requiredPathRoots: RequiredPathRoots;
	/** Absolute paths that will be bind-mounted at their own path inside the container. */
	identicalPathRoots: readonly string[];
	launch: { command: string; args: readonly string[]; cwd: string };
}

export interface ResolvedContainerLaunch {
	command: string;
	args: string[];
	topology: LaunchTopology;
	/** Present only when a container was asked for and declined. Never empty when present. */
	degradedReason?: string;
}

/**
 * Container paths are Linux paths whatever the host is, so containment is judged
 * with the POSIX rules rather than the running platform's. On Windows,
 * `path.resolve` would turn `/srv/pi` into a drive-qualified path and every
 * comparison below would answer a question nobody asked.
 */
function normalizeRoot(root: string): string {
	const normalized = path.posix.normalize(root);
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isCoveredBy(root: string, mountPoint: string): boolean {
	return root === mountPoint || root.startsWith(`${mountPoint}/`);
}

function unalignedRoots(
	required: RequiredPathRoots,
	identicalPathRoots: readonly string[],
): string[] {
	const mountPoints = identicalPathRoots.map(normalizeRoot);
	const unaligned: string[] = [];
	for (const [name, rawRoot] of Object.entries(required)) {
		const root = normalizeRoot(rawRoot);
		if (!mountPoints.some((mountPoint) => isCoveredBy(root, mountPoint))) {
			unaligned.push(`${name} (${rawRoot})`);
		}
	}
	return unaligned;
}

/**
 * Rewrites a subagent launch as a container launch, or explains why it did not.
 *
 * Declining is a first-class outcome: a container whose paths do not line up
 * still runs the agent correctly, it only poisons the byte accounting — silently.
 * So a misalignment degrades to the process model *with a reason*, rather than
 * launching a container that would make S3's storage-root classification lie.
 * Failures that would instead break S2's premise — an anchor that never came up,
 * an IPC namespace that could not be joined — are not this function's to soften;
 * they refuse the agent outright, upstream of here (design §5).
 */
export function resolveContainerLaunch(input: ContainerLaunchInput): ResolvedContainerLaunch {
	const asProcess = {
		command: input.launch.command,
		args: [...input.launch.args],
		topology: "process" as const,
	};
	if (input.topology === "process") return asProcess;

	const unaligned = unalignedRoots(input.requiredPathRoots, input.identicalPathRoots);
	if (unaligned.length > 0) {
		return {
			...asProcess,
			degradedReason: `Container topology declined: ${unaligned.length === 1 ? "this path root is" : "these path roots are"} not bind-mounted at an identical absolute path: ${unaligned.join(", ")}.`,
		};
	}

	const mounts = [...new Set(input.identicalPathRoots)];
	return {
		command: input.engine.binary,
		args: [
			"run",
			"--rm",
			"--ipc", `container:${input.anchorContainerId}`,
			"-w", input.launch.cwd,
			...mounts.flatMap((mount) => ["-v", `${mount}:${mount}`]),
			input.image,
			input.launch.command,
			...input.launch.args,
		],
		topology: "container",
	};
}

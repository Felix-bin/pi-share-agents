import { spawnSync } from "node:child_process";
import * as path from "node:path";

const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024;
const MAX_REPORTED_VERSION_LENGTH = 120;

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

/**
 * What a probe found when it asked an engine binary for its version. The two
 * outcomes are kept apart all the way into the reason string: "iSulad is not
 * installed" and "iSulad is installed but answered something we do not accept"
 * send whoever reads the run artifact to different places.
 */
export type ContainerEngineProbe =
	| { outcome: "absent"; detail: string }
	| { outcome: "present"; version: string };

export type ContainerEngineSelection =
	| { selected: true; engine: ContainerEngineSpec; version: string }
	| { selected: false; unavailableReason: string };

/**
 * Deliberately permissive: it accepts any answer carrying a `<major>.<minor>`,
 * which is enough to tell a working engine from a missing one or from a shell
 * error captured as output. The exact strings `isula --version` prints on
 * openEuler cannot be verified from the development machine, so tightening this
 * per engine waits for the real-machine report (design §6, acceptance run).
 * A pattern invented here without that output would be a guess wearing a regex.
 */
function isVersionAccepted(version: string): boolean {
	return /\d+\.\d+/.test(version);
}

/** Runs the engine's `--version`. The only impure part of engine selection. */
export function probeContainerEngineBinary(engine: ContainerEngineSpec): ContainerEngineProbe {
	const result = spawnSync(engine.binary, ["--version"], {
		encoding: "utf-8",
		timeout: PROBE_TIMEOUT_MS,
		maxBuffer: MAX_PROBE_OUTPUT_BYTES,
		windowsHide: true,
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		return { outcome: "absent", detail: code === "ENOENT" ? "not found on PATH" : result.error.message };
	}
	if (result.status !== 0) {
		return { outcome: "absent", detail: `'${engine.binary} --version' exited with code ${result.status}` };
	}
	return { outcome: "present", version: `${result.stdout ?? ""}`.trim().split("\n")[0] ?? "" };
}

/**
 * Picks the first engine in the table that is installed and answers a version we
 * accept (design §3.3). Returning a reason rather than throwing is the point:
 * "no container engine here" is a legitimate environment, and the run degrades to
 * the process model — visibly, naming every engine it tried and what each said.
 */
export function selectContainerEngine(input: {
	probe?: (engine: ContainerEngineSpec) => ContainerEngineProbe;
	ids?: readonly ContainerEngineId[];
}): ContainerEngineSelection {
	const probe = input.probe ?? probeContainerEngineBinary;
	const rejections: string[] = [];
	for (const id of input.ids ?? CONTAINER_ENGINE_IDS) {
		const engine = containerEngineSpec(id);
		const probed = probe(engine);
		if (probed.outcome === "absent") {
			rejections.push(`${id} (${probed.detail})`);
			continue;
		}
		if (!isVersionAccepted(probed.version)) {
			rejections.push(`${id} (version not accepted: ${JSON.stringify(probed.version.slice(0, MAX_REPORTED_VERSION_LENGTH))})`);
			continue;
		}
		return { selected: true, engine, version: probed.version };
	}
	return {
		selected: false,
		unavailableReason: `No container engine is usable: ${rejections.join(", ")}.`,
	};
}

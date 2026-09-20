import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { LAUNCH_DEGRADED_REASON_ENV, LAUNCH_TOPOLOGY_ENV, type LaunchTopology } from "../../shared/launch-topology.ts";

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
	/**
	 * The directory holding the binary the container will actually exec.
	 *
	 * The design names four roots, but `async-execution.ts` launches
	 * `binaryHost ?? nodeExecutable` — so on the npm-package path the thing being
	 * exec'd is Node itself, at a host path that none of the four cover. A
	 * container that cannot exec its own command fails at startup with a message
	 * about a missing file, which is a long way from "a path root was not aligned".
	 */
	launchCommand: string;
}

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

/** Opt in to the container topology. Anything but `container` keeps today's process model. */
export const CONTAINER_TOPOLOGY_ENV = "PI_SUBAGENT_CONTAINER_TOPOLOGY";
export const CONTAINER_IMAGE_ENV = "PI_SUBAGENT_CONTAINER_IMAGE";
export const CONTAINER_ANCHOR_ENV = "PI_SUBAGENT_CONTAINER_ANCHOR";
/** Comma-separated absolute paths bind-mounted at their own path inside the container. */
export const CONTAINER_MOUNTS_ENV = "PI_SUBAGENT_CONTAINER_MOUNTS";
export const CONTAINER_STORAGE_ROOT_ENV = "PI_SUBAGENT_CONTAINER_STORAGE_ROOT";

export { LAUNCH_DEGRADED_REASON_ENV, LAUNCH_TOPOLOGY_ENV, type LaunchTopology };

export interface ResolvedSubagentLaunch extends ResolvedContainerLaunch {
	/** Merged into the child's environment by the caller. */
	env: Record<string, string | undefined>;
}

function splitMounts(raw: string | undefined): string[] {
	return (raw ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * The whole of S1's launch-path decision, as one pure function: read the
 * configuration, pick an engine, check the path roots, and either rewrite the
 * launch or say why it stayed a process. `async-execution.ts` calls this and
 * passes the result to `spawn` — it holds none of the branching itself, which is
 * the constraint design §3.1 puts on that file.
 */
export function resolveSubagentLaunch(input: {
	launch: { command: string; args: readonly string[]; cwd: string };
	env: NodeJS.ProcessEnv;
	tempRoot: string;
	piInstallRoot: string;
	selectEngine?: () => ContainerEngineSelection;
}): ResolvedSubagentLaunch {
	const asProcess = (degradedReason?: string): ResolvedSubagentLaunch => ({
		command: input.launch.command,
		args: [...input.launch.args],
		topology: "process",
		...(degradedReason ? { degradedReason } : {}),
		env: {
			[LAUNCH_TOPOLOGY_ENV]: "process",
			[LAUNCH_DEGRADED_REASON_ENV]: degradedReason,
		},
	});

	if (input.env[CONTAINER_TOPOLOGY_ENV] !== "container") return asProcess();

	const image = input.env[CONTAINER_IMAGE_ENV]?.trim();
	const anchorContainerId = input.env[CONTAINER_ANCHOR_ENV]?.trim();
	const storageRoot = input.env[CONTAINER_STORAGE_ROOT_ENV]?.trim();
	const identicalPathRoots = splitMounts(input.env[CONTAINER_MOUNTS_ENV]);
	const missing = [
		[CONTAINER_IMAGE_ENV, image],
		[CONTAINER_ANCHOR_ENV, anchorContainerId],
		[CONTAINER_STORAGE_ROOT_ENV, storageRoot],
		[CONTAINER_MOUNTS_ENV, identicalPathRoots.length > 0 ? "set" : undefined],
	].filter(([, value]) => !value).map(([name]) => name);
	if (missing.length > 0) {
		return asProcess(`Container topology declined: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`);
	}

	const selection = (input.selectEngine ?? (() => selectContainerEngine({})))();
	if (!selection.selected) return asProcess(selection.unavailableReason);

	const resolved = resolveContainerLaunch({
		topology: "container",
		engine: selection.engine,
		anchorContainerId: anchorContainerId!,
		image: image!,
		requiredPathRoots: {
			worktree: input.launch.cwd,
			storageRoot: storageRoot!,
			tempRoot: input.tempRoot,
			piInstallRoot: input.piInstallRoot,
			launchCommand: path.posix.dirname(input.launch.command),
		},
		identicalPathRoots,
		launch: input.launch,
	});
	if (resolved.topology === "process") return asProcess(resolved.degradedReason);

	return { ...resolved, env: { [LAUNCH_TOPOLOGY_ENV]: "container", [LAUNCH_DEGRADED_REASON_ENV]: undefined } };
}

/**
 * Which directory must hold Pi at the same absolute path inside the container.
 *
 * The child's argv carries host paths — the runner source, the bootstrap, the
 * config — so whichever install the parent launched from has to be reachable at
 * that same path on the other side. Knowing neither yields an empty root, which
 * fails the alignment check in `resolveSubagentLaunch` and degrades visibly:
 * that is the point, because a container launched without Pi where its argv says
 * Pi is would fail in a way nobody could attribute.
 *
 * It lives here rather than at the call site so that `async-execution.ts` holds
 * no conditional of its own (design §3.1).
 */
export function subagentPiInstallRoot(binaryHost: string | undefined, piPackageRoot: string | undefined): string {
	if (binaryHost) return path.dirname(binaryHost);
	return piPackageRoot ?? "";
}

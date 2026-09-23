import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTAINER_ENGINE_IDS,
	containerEngineSpec,
	resolveContainerLaunch,
	selectContainerEngine,
	resolveSubagentLaunch,
	subagentPiInstallRoot,
	CONTAINER_TOPOLOGY_ENV,
	CONTAINER_IMAGE_ENV,
	CONTAINER_ANCHOR_ENV,
	CONTAINER_MOUNTS_ENV,
	CONTAINER_STORAGE_ROOT_ENV,
	LAUNCH_TOPOLOGY_ENV,
	LAUNCH_DEGRADED_REASON_ENV,
	LAUNCH_STORAGE_ROOT_ENV,
	type ContainerEngineId,
	type ContainerEngineProbe,
} from "../../src/runs/shared/container-launch.ts";

const roots = {
	worktree: "/srv/pi/worktree",
	storageRoot: "/srv/pi/synapse",
	tempRoot: "/srv/pi/temp",
	piInstallRoot: "/opt/pi",
};

const launch = {
	command: "/opt/pi/bin/node",
	args: ["--experimental-strip-types", "/opt/pi/runner.ts", "/srv/pi/temp/cfg.json"],
	cwd: "/srv/pi/worktree",
};

function containerInput(overrides: Record<string, unknown> = {}) {
	return {
		topology: "container" as const,
		engine: containerEngineSpec("isula"),
		anchorContainerId: "anchor-7",
		image: "pi-subagent:node24",
		requiredPathRoots: roots,
		identicalPathRoots: Object.values(roots),
		launch,
		...overrides,
	};
}

describe("container launch construction", () => {
	it("returns the process launch untouched when the topology is process", () => {
		const resolved = resolveContainerLaunch(containerInput({ topology: "process" }));

		assert.equal(resolved.topology, "process");
		assert.equal(resolved.command, launch.command);
		assert.deepEqual(resolved.args, launch.args);
		assert.equal(resolved.degradedReason, undefined);
	});

	it("joins the anchor's IPC namespace and bind-mounts every root at its own path", () => {
		const resolved = resolveContainerLaunch(containerInput());

		assert.equal(resolved.topology, "container");
		assert.equal(resolved.command, "isula");

		const ipcAt = resolved.args.indexOf("--ipc");
		assert.notEqual(ipcAt, -1);
		assert.equal(resolved.args[ipcAt + 1], "container:anchor-7");

		for (const root of Object.values(roots)) {
			const mountAt = resolved.args.indexOf(`${root}:${root}`);
			assert.notEqual(mountAt, -1, `no identical-path bind mount for ${root}`);
			assert.equal(resolved.args[mountAt - 1], "-v");
		}

		// The original command survives intact, after the image.
		const imageAt = resolved.args.indexOf("pi-subagent:node24");
		assert.notEqual(imageAt, -1);
		assert.deepEqual(resolved.args.slice(imageAt + 1), [launch.command, ...launch.args]);
	});

	it("runs the container in the same working directory the process model would have used", () => {
		const resolved = resolveContainerLaunch(containerInput());

		const cwdAt = resolved.args.indexOf("-w");
		assert.notEqual(cwdAt, -1);
		assert.equal(resolved.args[cwdAt + 1], launch.cwd);
	});

	it("names which root is unaligned rather than reporting a generic failure", () => {
		const resolved = resolveContainerLaunch(containerInput({
			identicalPathRoots: [roots.worktree, roots.tempRoot, roots.piInstallRoot],
		}));

		assert.equal(resolved.topology, "process");
		assert.equal(resolved.command, launch.command);
		assert.deepEqual(resolved.args, launch.args);
		assert.match(resolved.degradedReason ?? "", /storageRoot/);
		assert.match(resolved.degradedReason ?? "", /\/srv\/pi\/synapse/);
	});

	it("names every unaligned root, not only the first one found", () => {
		const resolved = resolveContainerLaunch(containerInput({
			identicalPathRoots: [roots.worktree],
		}));

		assert.equal(resolved.topology, "process");
		for (const name of ["storageRoot", "tempRoot", "piInstallRoot"]) {
			assert.match(resolved.degradedReason ?? "", new RegExp(name));
		}
		assert.doesNotMatch(resolved.degradedReason ?? "", /worktree/);
	});

	it("accepts a root nested under an aligned mount point", () => {
		const resolved = resolveContainerLaunch(containerInput({
			requiredPathRoots: { ...roots, storageRoot: "/srv/pi/worktree/.synapse" },
			identicalPathRoots: [roots.worktree, roots.tempRoot, roots.piInstallRoot],
		}));

		assert.equal(resolved.topology, "container", resolved.degradedReason);
	});

	it("does not mistake a sibling directory for a nested one", () => {
		const resolved = resolveContainerLaunch(containerInput({
			requiredPathRoots: { ...roots, storageRoot: "/srv/pi/worktree-backup" },
			identicalPathRoots: [roots.worktree, roots.tempRoot, roots.piInstallRoot],
		}));

		assert.equal(resolved.topology, "process");
		assert.match(resolved.degradedReason ?? "", /storageRoot/);
	});

	it("builds the same argument shape for every engine, differing only in the binary", () => {
		const shapes = CONTAINER_ENGINE_IDS.map((id) => {
			const resolved = resolveContainerLaunch(containerInput({ engine: containerEngineSpec(id) }));
			return { id, command: resolved.command, args: resolved.args };
		});

		assert.deepEqual(shapes.map((shape) => shape.id), ["isula", "docker", "podman"]);
		assert.deepEqual(shapes.map((shape) => shape.command), ["isula", "docker", "podman"]);
		for (const shape of shapes) {
			assert.deepEqual(shape.args, shapes[0].args);
		}
	});
});

function probeTable(
	table: Partial<Record<ContainerEngineId, ContainerEngineProbe>>,
): (engine: { id: ContainerEngineId }) => ContainerEngineProbe {
	return (engine) => table[engine.id] ?? { outcome: "absent", detail: "not found on PATH" };
}

describe("container engine selection", () => {
	it("selects the first engine in the table when it is usable", () => {
		const selection = selectContainerEngine({
			probe: probeTable({
				isula: { outcome: "present", version: "Version 2.1.5" },
				docker: { outcome: "present", version: "Docker version 24.0.5" },
			}),
		});

		assert.equal(selection.selected, true);
		assert.equal(selection.selected && selection.engine.id, "isula");
	});

	it("falls back to the next engine when the preferred one is absent", () => {
		const selection = selectContainerEngine({
			probe: probeTable({ docker: { outcome: "present", version: "Docker version 24.0.5" } }),
		});

		assert.equal(selection.selected, true);
		assert.equal(selection.selected && selection.engine.id, "docker");
		assert.equal(selection.selected && selection.engine.binary, "docker");
	});

	it("skips an engine whose binary exists but whose version is not accepted", () => {
		const selection = selectContainerEngine({
			probe: probeTable({
				isula: { outcome: "present", version: "not a version at all" },
				podman: { outcome: "present", version: "podman version 4.6.1" },
			}),
		});

		assert.equal(selection.selected, true);
		assert.equal(selection.selected && selection.engine.id, "podman");
	});

	it("distinguishes an absent binary from a rejected version when nothing is usable", () => {
		const selection = selectContainerEngine({
			probe: probeTable({
				isula: { outcome: "absent", detail: "not found on PATH" },
				docker: { outcome: "present", version: "garbage" },
			}),
		});

		assert.equal(selection.selected, false);
		const reason = selection.selected ? "" : selection.unavailableReason;

		// Every engine in the table is accounted for by name.
		for (const id of CONTAINER_ENGINE_IDS) assert.match(reason, new RegExp(id));

		// The two kinds of failure do not collapse into one word.
		const absentAt = reason.indexOf("isula");
		const rejectedAt = reason.indexOf("docker");
		assert.match(reason.slice(absentAt, rejectedAt), /not found/i);
		assert.match(reason.slice(rejectedAt), /version/i);
		assert.match(reason.slice(rejectedAt), /garbage/);
	});

	it("probes each engine at most once", () => {
		const probed: ContainerEngineId[] = [];
		selectContainerEngine({
			probe: (engine) => {
				probed.push(engine.id);
				return { outcome: "absent", detail: "not found on PATH" };
			},
		});

		assert.deepEqual(probed, [...CONTAINER_ENGINE_IDS]);
	});
})
;

const subagentLaunch = {
	command: "/opt/pi/bin/node",
	args: ["--experimental-strip-types", "/opt/pi/runner.ts", "/srv/pi/temp/cfg.json"],
	cwd: "/srv/pi/worktree",
};

const containerEnv = {
	[CONTAINER_TOPOLOGY_ENV]: "container",
	[CONTAINER_IMAGE_ENV]: "pi-subagent:node24",
	[CONTAINER_ANCHOR_ENV]: "anchor-7",
	[CONTAINER_MOUNTS_ENV]: "/srv/pi,/opt/pi",
	[CONTAINER_STORAGE_ROOT_ENV]: "/srv/pi/synapse",
};

function subagentInput(env: NodeJS.ProcessEnv) {
	return {
		launch: subagentLaunch,
		env,
		tempRoot: "/srv/pi/temp",
		piInstallRoot: "/opt/pi",
		selectEngine: () => ({
			selected: true as const,
			engine: containerEngineSpec("isula"),
			version: "Version 2.1.5",
		}),
	};
}

describe("subagent launch topology", () => {
	it("leaves the launch byte-identical when containerisation is not switched on", () => {
		const resolved = resolveSubagentLaunch(subagentInput({}));

		assert.equal(resolved.topology, "process");
		assert.equal(resolved.command, subagentLaunch.command);
		assert.deepEqual(resolved.args, subagentLaunch.args);
		assert.equal(resolved.degradedReason, undefined);
	});

	it("tells the child which topology it was launched under, even in the default case", () => {
		const resolved = resolveSubagentLaunch(subagentInput({}));

		assert.equal(resolved.env[LAUNCH_TOPOLOGY_ENV], "process");
		assert.equal(resolved.env[LAUNCH_DEGRADED_REASON_ENV], undefined);
	});

	it("wraps the launch when containerisation is switched on and everything lines up", () => {
		const resolved = resolveSubagentLaunch(subagentInput(containerEnv));

		assert.equal(resolved.topology, "container", resolved.degradedReason);
		assert.equal(resolved.command, "isula");
		assert.ok(resolved.args.includes("container:anchor-7"));
		// The topology marker crosses the boundary as an argument, not in the engine
		// client's own environment — the client's env never reaches the container.
		assert.ok(resolved.args.includes(`${LAUNCH_TOPOLOGY_ENV}=container`));
	});

	it("degrades visibly when no container engine is usable", () => {
		const resolved = resolveSubagentLaunch({
			...subagentInput(containerEnv),
			selectEngine: () => ({ selected: false as const, unavailableReason: "No container engine is usable: isula (not found on PATH)." }),
		});

		assert.equal(resolved.topology, "process");
		assert.deepEqual(resolved.args, subagentLaunch.args);
		assert.equal(resolved.env[LAUNCH_TOPOLOGY_ENV], "process");
		assert.match(resolved.env[LAUNCH_DEGRADED_REASON_ENV] ?? "", /not found on PATH/);
	});

	it("degrades visibly, naming the setting, when a required container setting is missing", () => {
		const { [CONTAINER_IMAGE_ENV]: _image, ...withoutImage } = containerEnv;
		const resolved = resolveSubagentLaunch(subagentInput(withoutImage));

		assert.equal(resolved.topology, "process");
		assert.match(resolved.degradedReason ?? "", new RegExp(CONTAINER_IMAGE_ENV));
	});

	it("degrades visibly when a path root is not covered by the declared mounts", () => {
		const resolved = resolveSubagentLaunch(subagentInput({
			...containerEnv,
			[CONTAINER_MOUNTS_ENV]: "/srv/pi",
		}));

		assert.equal(resolved.topology, "process");
		assert.match(resolved.degradedReason ?? "", /piInstallRoot/);
		assert.match(resolved.env[LAUNCH_DEGRADED_REASON_ENV] ?? "", /piInstallRoot/);
	});

	it("never reports a container topology together with a degraded reason", () => {
		for (const env of [{}, containerEnv, { ...containerEnv, [CONTAINER_MOUNTS_ENV]: "/srv/pi" }]) {
			const resolved = resolveSubagentLaunch(subagentInput(env));
			if (resolved.topology === "container") assert.equal(resolved.degradedReason, undefined);
			else if (env !== containerEnv && Object.keys(env).length > 0) assert.ok(resolved.degradedReason);
		}
	});
});

describe("pi install root resolution", () => {
	it("uses the directory holding the compiled host when one is in play", () => {
		assert.equal(subagentPiInstallRoot("/opt/pi/bin/pi", "/usr/lib/node_modules/pi"), "/opt/pi/bin");
	});

	it("falls back to the npm package root when there is no compiled host", () => {
		assert.equal(subagentPiInstallRoot(undefined, "/usr/lib/node_modules/pi"), "/usr/lib/node_modules/pi");
	});

	it("returns an empty root when neither is known, so alignment fails visibly", () => {
		const root = subagentPiInstallRoot(undefined, undefined);
		assert.equal(root, "");

		const resolved = resolveSubagentLaunch({ ...subagentInput(containerEnv), piInstallRoot: root });
		assert.equal(resolved.topology, "process");
		assert.match(resolved.degradedReason ?? "", /piInstallRoot/);
	});
});

describe("the executable the container must actually exec", () => {
	it("refuses when the launch command itself is not reachable at the same path", () => {
		// The npm-package path launches node itself, whose host path is covered by
		// none of the four roots the design names.
		const resolved = resolveSubagentLaunch({
			...subagentInput(containerEnv),
			launch: { ...subagentLaunch, command: "/usr/local/bin/node" },
		});

		assert.equal(resolved.topology, "process");
		assert.match(resolved.degradedReason ?? "", /launchCommand/);
		assert.match(resolved.degradedReason ?? "", /\/usr\/local\/bin/);
	});

	it("accepts a launch command that lives under a declared mount", () => {
		const resolved = resolveSubagentLaunch({
			...subagentInput({ ...containerEnv, [CONTAINER_MOUNTS_ENV]: "/srv/pi,/opt/pi,/usr/local/bin" }),
			launch: { ...subagentLaunch, command: "/usr/local/bin/node" },
		});

		assert.equal(resolved.topology, "container", resolved.degradedReason);
	});
});

describe("what crosses the container boundary", () => {
	const childEnv = {
		PI_SUBAGENT_RUNNER_CONFIG: "/srv/pi/temp/cfg.json",
		PI_PACKAGE_DIR: "/opt/pi",
		ANTHROPIC_API_KEY: "sk-test",
		UNSET_ONE: undefined,
	};

	it("passes the child's environment into the container, not to the engine client", () => {
		const resolved = resolveSubagentLaunch({ ...subagentInput(containerEnv), childEnv });

		assert.equal(resolved.topology, "container", resolved.degradedReason);
		// The engine CLI does not forward its own environment into the container, so
		// anything the child needs has to be an explicit -e on the command line.
		for (const [key, value] of Object.entries(childEnv)) {
			if (value === undefined) continue;
			const at = resolved.args.indexOf(`${key}=${value}`);
			assert.notEqual(at, -1, `child env ${key} never reached the container`);
			assert.equal(resolved.args[at - 1], "-e");
		}
	});

	it("tells the containerised child it is containerised", () => {
		const resolved = resolveSubagentLaunch({ ...subagentInput(containerEnv), childEnv });

		// Without this the child records topology "process" — byte-identical to a
		// genuine process run, which is exactly the mixing §4.3 exists to prevent.
		assert.ok(resolved.args.includes(`${LAUNCH_TOPOLOGY_ENV}=container`));
	});

	it("does not forward host-specific variables that must come from the image", () => {
		const resolved = resolveSubagentLaunch({
			...subagentInput(containerEnv),
			childEnv: { ...childEnv, PATH: "C:\Windows\System32", PWD: "/somewhere/else" },
		});

		assert.ok(!resolved.args.some((arg) => arg.startsWith("PATH=")));
		assert.ok(!resolved.args.some((arg) => arg.startsWith("PWD=")));
	});

	it("omits undefined values rather than passing the string 'undefined'", () => {
		const resolved = resolveSubagentLaunch({ ...subagentInput(containerEnv), childEnv });

		assert.ok(!resolved.args.some((arg) => arg.startsWith("UNSET_ONE")));
	});

	it("gives the container a name, so something can still address it after launch", () => {
		const resolved = resolveSubagentLaunch({
			...subagentInput(containerEnv),
			childEnv,
			containerName: "pi-agent-run-42",
		});

		const at = resolved.args.indexOf("pi-agent-run-42");
		assert.notEqual(at, -1);
		assert.equal(resolved.args[at - 1], "--name");
	});

	it("still hands the process path a plain environment object to spawn with", () => {
		const resolved = resolveSubagentLaunch({ ...subagentInput({}), childEnv });

		assert.equal(resolved.topology, "process");
		assert.equal(resolved.env.PI_SUBAGENT_RUNNER_CONFIG, "/srv/pi/temp/cfg.json");
		assert.equal(resolved.env[LAUNCH_TOPOLOGY_ENV], "process");
	});

	it("records the storage root it was told to align, so a wrong one is auditable", () => {
		const resolved = resolveSubagentLaunch({ ...subagentInput(containerEnv), childEnv });

		assert.ok(resolved.args.includes(`${LAUNCH_STORAGE_ROOT_ENV}=/srv/pi/synapse`));
	});
});

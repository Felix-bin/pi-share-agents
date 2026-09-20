import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTAINER_ENGINE_IDS,
	containerEngineSpec,
	resolveContainerLaunch,
	selectContainerEngine,
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

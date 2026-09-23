/**
 * The anchor container holds the IPC namespace every agent container joins
 * (S1 design §3.2). Its whole reason to exist is that `/dev/shm` and the POSIX
 * shared-memory objects S2 will put there are only shared by containers that
 * joined the *same* namespace — so an agent that quietly got its own namespace
 * would run fine, read nothing from its peers, and report no error at all.
 *
 * That is why the decisions below never degrade: a failed or vanishing anchor
 * refuses the agent outright. Contrast with `container-launch.ts`, where a path
 * root that does not line up degrades visibly to the process model — there the
 * agent still works and only the accounting suffers; here the agent would look
 * like it worked while S2's premise was silently false.
 */

export type AnchorState =
	| { phase: "absent" }
	| { phase: "starting" }
	| { phase: "running"; containerId: string }
	| { phase: "failed"; reason: string }
	| { phase: "stopping" };

export type AnchorGate =
	| { decision: "launch"; anchorContainerId: string }
	| { decision: "wait"; reason: string }
	| { decision: "refuse"; reason: string };

/** May this agent container start now, and which namespace should it join? */
export function resolveAnchorGate(input: { anchor: AnchorState }): AnchorGate {
	switch (input.anchor.phase) {
		case "running":
			return { decision: "launch", anchorContainerId: input.anchor.containerId };
		case "absent":
			return { decision: "wait", reason: "The anchor container has not been created yet." };
		case "starting":
			return { decision: "wait", reason: "The anchor container is still starting." };
		case "failed":
			return { decision: "refuse", reason: `The anchor container failed, so there is no shared IPC namespace to join: ${input.anchor.reason}` };
		case "stopping":
			// Joining a namespace that is about to disappear buys an agent a container
			// whose peers are already gone — the isolated case, arrived at late.
			return { decision: "refuse", reason: "The anchor container is shutting down; a new agent must not join a namespace that is about to disappear." };
	}
}

export type AnchorTeardown = { decision: "destroy" | "hold"; reason: string };

/**
 * The anchor outlives every agent container (design §3.2). Destroying it while
 * one is still running takes the shared namespace out from under a live agent.
 */
export function resolveAnchorTeardown(input: { activeAgentContainers: number }): AnchorTeardown {
	if (input.activeAgentContainers === 0) {
		return { decision: "destroy", reason: "No agent container is still using the shared IPC namespace." };
	}
	// A negative count means the bookkeeping is wrong, not that nothing is running.
	// Holding leaks an anchor; destroying pulls the namespace out from under a live
	// agent and makes S2 read empty. The leak is the recoverable one.
	if (input.activeAgentContainers < 0) {
		return { decision: "hold", reason: `Agent container count is ${input.activeAgentContainers}, which cannot be true; refusing to destroy the anchor on a count that is already wrong.` };
	}
	return { decision: "hold", reason: `${input.activeAgentContainers} agent container(s) are still using the shared IPC namespace.` };
}

export type AgentContainerStart =
	| { outcome: "started" }
	| { outcome: "refuse-agent"; reason: string };

const IPC_JOIN_FAILURE = /ipc namespace|--ipc|ipc mode/i;

/**
 * Classifies what a `run` invocation did. There is deliberately no
 * `degrade-to-process` outcome: by the time this is called the agent's container
 * was already attempted, and an IPC join failure is exactly the case design §5
 * says must refuse rather than fall back.
 */
export function classifyAgentContainerStart(input: { exitCode: number; stderr: string }): AgentContainerStart {
	if (input.exitCode === 0) return { outcome: "started" };
	const stderr = input.stderr.trim();
	if (IPC_JOIN_FAILURE.test(stderr)) {
		return { outcome: "refuse-agent", reason: `The agent container could not join the anchor's IPC namespace, so S2's shared memory would read empty: ${stderr}` };
	}
	return { outcome: "refuse-agent", reason: `The agent container did not start (exit code ${input.exitCode}): ${stderr}` };
}

/**
 * The launch topology a subagent process actually got, and how the parent tells
 * it. Two layers need these names — `src/runs/shared/container-launch.ts` sets
 * them when it launches the child, `src/synapse/metering.ts` reads them when the
 * child records its process identity — and neither may import the other:
 * `src/runs` depends on `src/synapse`, not the reverse. So the names live here,
 * in the layer both already depend on.
 *
 * S1 design §4.3. The value is what happened, not what was configured: a run
 * that asked for a container and fell back to the process model reports
 * `process` *and* a reason, so an S2 experiment cannot average the two topologies
 * together without anyone noticing.
 */
export const LAUNCH_TOPOLOGY_ENV = "PI_SUBAGENT_LAUNCH_TOPOLOGY";

/** Set only when a container was asked for and declined. Never empty when set. */
export const LAUNCH_DEGRADED_REASON_ENV = "PI_SUBAGENT_LAUNCH_DEGRADED_REASON";

export type LaunchTopology = "process" | "container";

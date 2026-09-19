import { OBSERVATION_CATEGORIES, type ObservationCategory } from "./protocol.ts";
import type { ObservationCategoryViews, ObservationRunView } from "./aggregate.ts";

/**
 * FleetView's projection of kernel file I/O.
 *
 * This renders what is already in memory. It opens no file, runs no command and
 * reads no kernel map, because FleetView's refresh is a hot path and an
 * observability panel that slows the status loop has cost more than it showed.
 *
 * Two display rules carry the honesty of the whole feature:
 *   - A quantity that was not measured prints as `—`, never as `0`.
 *   - Kernel bytes are labelled as kernel bytes and are never added to the
 *     logical envelope bytes SYNAPSE reports. They measure different things;
 *     one total covering both would be a number with no definition.
 */

const CATEGORY_LABELS = {
	content: "content",
	envelope: "envelope",
	memoryIndex: "memory",
	unclassified: "unclassified",
} satisfies Record<ObservationCategory, string>;

const COVERAGE_LABELS = {
	active: "active",
	disabled: "disabled",
	partial: "partial",
	stale: "stale",
	unavailable: "unavailable",
} satisfies Record<ObservationRunView["coverage"], string>;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? "KB"}`;
}

export function formatNanoseconds(ns: number | null): string {
	if (ns === null) return "—";
	if (ns < 1000) return `${ns}ns`;
	if (ns < 1_000_000) return `${(ns / 1000).toFixed(1)}µs`;
	if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
	return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

function directionLine(label: string, bytes: number, operations: number, meanNs: number | null, approxP95Ns: number | null): string {
	// "≤" because the percentile comes from a log2 histogram: the true value sits
	// inside the bucket, and printing the bound is the claim we can defend.
	const p95 = approxP95Ns === null ? "—" : `≤${formatNanoseconds(approxP95Ns)}`;
	return `${label} ${formatBytes(bytes)} in ${operations} ops · avg ${formatNanoseconds(meanNs)} · p95 ${p95}`;
}

function categoryLine(categories: ObservationCategoryViews): string {
	const parts = OBSERVATION_CATEGORIES.filter((category) => {
		const view = categories[category];
		return view.readOps > 0 || view.writeOps > 0 || view.failedOps > 0;
	}).map((category) => {
		const view = categories[category];
		return `${CATEGORY_LABELS[category]} r ${formatBytes(view.readBytes)} / w ${formatBytes(view.writeBytes)}`;
	});
	return parts.length === 0 ? "no file I/O observed under the storage root" : parts.join(" · ");
}

export type ObservationRenderOptions = {
	/** Foreground children share the host process, so their I/O is summarised once. */
	scope: "background" | "foreground";
	/** Detail adds the category breakdown, the gaps and the coverage caveats. */
	verbose: boolean;
};

/**
 * Renders the view as display lines. Returns an empty array only when the
 * feature is disabled: an enabled-but-unmeasured run still says so, because a
 * panel that vanishes looks like a run with no I/O.
 */
export function renderObservation(view: ObservationRunView, options: ObservationRenderOptions): string[] {
	if (view.coverage === "disabled") return [];
	if (!view.measured) {
		return [`Kernel file I/O  ${COVERAGE_LABELS[view.coverage]} — ${view.detail}`];
	}

	const scope =
		options.scope === "foreground"
			? "foreground session process, counted once for all its children"
			: view.attribution === "shared"
				? `shared process summary across ${view.processes} registration${view.processes === 1 ? "" : "s"}`
				: `${view.processes} background process${view.processes === 1 ? "" : "es"}`;

	const lines = [
		`Kernel file I/O  ${COVERAGE_LABELS[view.coverage]} · ${scope}`,
		`  ${directionLine("read ", view.totals.readBytes, view.totals.readOps, view.totals.readLatency.meanNs, view.totals.readLatency.approxP95Ns)}`,
		`  ${directionLine("write", view.totals.writeBytes, view.totals.writeOps, view.totals.writeLatency.meanNs, view.totals.writeLatency.approxP95Ns)}`,
	];
	if (view.totals.failedOps > 0) {
		lines.push(`  ${view.totals.failedOps} failed operation${view.totals.failedOps === 1 ? "" : "s"}`);
	}
	if (!options.verbose) return lines;

	lines.push(`  ${categoryLine(view.categories)}`);
	for (const reason of view.incompleteReasons) {
		lines.push(`  ! ${reason}`);
	}
	for (const gap of view.gaps) {
		const span = gap.toMs === null ? "ongoing" : `${gap.toMs - gap.fromMs}ms`;
		lines.push(`  ! observation gap (${gap.reason}, ${span})`);
	}
	lines.push("  kernel file bytes are not the same measurement as logical envelope bytes and are not added to them");
	return lines;
}

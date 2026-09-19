import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { safeComponent } from "../synapse/envelope-inbox.ts";
import { OBSERVATION_CATEGORIES, type ObservationCategory } from "./protocol.ts";
import type { ObservationRunView } from "./aggregate.ts";

/**
 * The run's durable record of what the kernel saw.
 *
 * It sits next to the metering log and follows the same retention, because the
 * two are read together: the metering log says what the application believes it
 * moved, and this says what the kernel observed while it did. A report that
 * quotes one without the other is back to self-certification.
 *
 * The artifact always carries its own coverage boundary. A file that says
 * "read 4.2 MB" without saying which call paths were watched and which were not
 * is a number nobody can check, and this project does not publish those.
 */

export const OBSERVATION_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Kept out of the measurement itself: the classifier excludes this directory.
 * The run id is reduced by the same rule the envelope inbox uses, so a run
 * cannot address two different files depending on which writer built the path.
 */
export function observationArtifactPath(storageRoot: string, runId: string): string {
	return path.join(storageRoot, "observation", `${safeComponent(runId)}.json`);
}

type ArtifactDirection = {
	approxP95Ns: number | "unavailable";
	bytes: number;
	meanNs: number | "unavailable";
	operations: number;
};

type ArtifactCategory = {
	failedOperations: number;
	read: ArtifactDirection;
	write: ArtifactDirection;
};

/** Spelled out so a new category cannot be added without updating the artifact. */
type ArtifactCategories = {
	content: ArtifactCategory;
	envelope: ArtifactCategory;
	memoryIndex: ArtifactCategory;
	unclassified: ArtifactCategory;
};

export type ObservationArtifact = {
	attribution: "exclusive" | "shared" | "unavailable";
	categories: ArtifactCategories | "unavailable";
	coverage: ObservationRunView["coverage"];
	coverageBoundary: { excluded: readonly string[]; watched: readonly string[] };
	incompleteReasons: readonly string[];
	measured: boolean;
	note: string;
	observedFromMs: number | "unavailable";
	processes: number | "unavailable";
	runId: string;
	schemaVersion: number;
	totals: ArtifactCategory | "unavailable";
	writtenAtMs: number;
};

export type ObservationArtifactInput = {
	excluded: readonly string[];
	nowMs: number;
	runId: string;
	view: ObservationRunView;
	watched: readonly string[];
};

const NOTE =
	"Kernel file I/O measured on the listed VFS entry points for registered processes only. "
	+ "These bytes are not physical disk traffic and are not end-to-end message latency. "
	+ "They are reported separately from SYNAPSE logical envelope bytes and must not be summed with them.";

function direction(bytes: number, operations: number, meanNs: number | null, approxP95Ns: number | null): ArtifactDirection {
	return {
		approxP95Ns: approxP95Ns ?? "unavailable",
		bytes,
		meanNs: meanNs ?? "unavailable",
		operations,
	};
}

export function buildObservationArtifact(input: ObservationArtifactInput): ObservationArtifact {
	const boundary = { excluded: input.excluded, watched: input.watched };
	const view = input.view;
	if (!view.measured) {
		// An unmeasured run still gets an artifact. Omitting it would leave a
		// reader unable to tell "nothing happened" from "nothing was watched".
		return {
			attribution: "unavailable",
			categories: "unavailable",
			coverage: view.coverage,
			coverageBoundary: boundary,
			incompleteReasons: [view.detail],
			measured: false,
			note: NOTE,
			observedFromMs: "unavailable",
			processes: "unavailable",
			runId: input.runId,
			schemaVersion: OBSERVATION_ARTIFACT_SCHEMA_VERSION,
			totals: "unavailable",
			writtenAtMs: input.nowMs,
		};
	}

	const categories: ArtifactCategories = {
		content: categoryOf(view, "content"),
		envelope: categoryOf(view, "envelope"),
		memoryIndex: categoryOf(view, "memoryIndex"),
		unclassified: categoryOf(view, "unclassified"),
	};

	return {
		attribution: view.attribution,
		categories,
		coverage: view.coverage,
		coverageBoundary: boundary,
		incompleteReasons: view.incompleteReasons,
		measured: true,
		note: NOTE,
		observedFromMs: view.observedFromMs,
		processes: view.processes,
		runId: input.runId,
		schemaVersion: OBSERVATION_ARTIFACT_SCHEMA_VERSION,
		totals: {
			failedOperations: view.totals.failedOps,
			read: direction(view.totals.readBytes, view.totals.readOps, view.totals.readLatency.meanNs, view.totals.readLatency.approxP95Ns),
			write: direction(view.totals.writeBytes, view.totals.writeOps, view.totals.writeLatency.meanNs, view.totals.writeLatency.approxP95Ns),
		},
		writtenAtMs: input.nowMs,
	};
}

function categoryOf(view: Extract<ObservationRunView, { measured: true }>, category: ObservationCategory): ArtifactCategory {
	const entry = view.categories[category];
	return {
		failedOperations: entry.failedOps,
		read: direction(entry.readBytes, entry.readOps, entry.readLatency.meanNs, entry.readLatency.approxP95Ns),
		write: direction(entry.writeBytes, entry.writeOps, entry.writeLatency.meanNs, entry.writeLatency.approxP95Ns),
	};
}

/** Named so the set of categories stays in step with the protocol's. */
export const OBSERVATION_ARTIFACT_CATEGORIES = OBSERVATION_CATEGORIES;

export function writeObservationArtifact(storageRoot: string, artifact: ObservationArtifact): string {
	const target = observationArtifactPath(storageRoot, artifact.runId);
	writeAtomicJson(target, artifact);
	return target;
}

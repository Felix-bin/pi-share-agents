import { tmpfsPreflightMarker, type TmpfsPreflight } from "../../synapse/tmpfs-preflight.ts";

/**
 * The shape of the report `scripts/synapse/s2-acceptance.sh` brings back from the
 * openEuler machine, and the judgement over it.
 *
 * Same split as S1, deliberately: the script collects facts on a host this
 * repository's CI will never run on, and every decision about what those facts
 * mean lives here, where Windows can prove it. A shell script that also decided
 * pass/fail would put the judgement on the one machine nobody can test.
 *
 * What S2 adds to that pattern is the reconciliation entry. S2's whole claim is
 * that the bytes the application says it put on a socket are the bytes the
 * kernel saw on that socket, so the check's subject is neither number on its
 * own: **it is the difference**. A judge that graded either side alone would
 * pass a run in which one collector reported nothing at all.
 */

/** The only report shape this judge understands. */
export const S2_ACCEPTANCE_SCHEMA_VERSION = 1;

/**
 * The real-machine checks of design §6.2, in the order the script runs them.
 *
 * `socket-syscall-trace` comes **before** `transport-bytes-reconciliation` and
 * not after: its strace output is what decides which events S3 must add, and
 * reconciling against a collector that is not yet watching the right syscalls
 * would produce a difference that means nothing.
 *
 * `single-round-gear-comparison` is the one round of `file` versus `uds` that
 * S2 runs. Its `pass` means only that both gears ran once and each reported its
 * bytes and latency. It does **not** assert reproducibility: "same task, same
 * model, same seed" is condition control that belongs to S4's experiment
 * framework, and S2 has no way to establish it.
 */
export const S2_ACCEPTANCE_CHECK_IDS = [
	"cross-container-visibility",
	"socket-syscall-trace",
	"transport-bytes-reconciliation",
	"single-round-gear-comparison",
] as const;

export type S2AcceptanceCheckId = (typeof S2_ACCEPTANCE_CHECK_IDS)[number];

/**
 * `unavailable` is not a soft `fail`. A check that never ran and a check that
 * ran and failed send a reader to different places — one to the machine, one to
 * the code — and collapsing them is how a report full of holes comes to read as
 * a clean run. Same discipline as S1 and S3.
 */
export type S2AcceptanceOutcome = "pass" | "fail" | "unavailable";

/**
 * The two sides of the reconciliation, each `null` when that side reported
 * nothing.
 *
 * `null` rather than `0`, and the judge refuses to substitute: zero-filling the
 * missing side would turn "one collector was not running" into a difference of
 * exactly the other side's value, which reads as a *failed* reconciliation
 * rather than an absent one — two conclusions that send a reader to completely
 * different places.
 *
 * The difference is not a field. It is derived on demand, so a stored value can
 * never disagree with the two it was computed from.
 */
export interface ReconciliationEvidence {
	/** Bytes the application counted onto the socket, from `control.transportBytes`. */
	applicationBytes: number | null;
	/** Bytes S3's collector observed on that socket. */
	kernelBytes: number | null;
}

export interface S2AcceptanceCheck {
	detail?: string;
	id: S2AcceptanceCheckId;
	outcome: S2AcceptanceOutcome;
	/** Present only on `transport-bytes-reconciliation`, where the check's subject is the difference. */
	reconciliation?: ReconciliationEvidence;
}

export interface S2AcceptanceReport {
	checks: S2AcceptanceCheck[];
	engine: { id: string; version: string };
	kernel: string;
	/**
	 * Whether `<storageRoot>/objects` was proven to be a tmpfs, as the artifact
	 * marker spec §5 requires. It travels with the numbers rather than being left
	 * in the console output that produced them.
	 */
	preflight: { availableBytes: number | null; detail: string; sharedMemory: "refused" | "tmpfs" };
	schemaVersion: number;
}

export type S2AcceptanceParse =
	| { error: string; ok: false }
	| { ok: true; report: S2AcceptanceReport };

/**
 * How far apart the two byte counts may be and still reconcile.
 *
 * Zero, and deliberately so. Any tolerance picked before a single real
 * observation would be a number invented to make the check pass, and it would
 * absorb precisely the discrepancy the check exists to find. If the real
 * machine shows a systematic delta, that is a finding for Task 8 to explain and
 * for S3 to fix — not a constant to widen in advance.
 */
export const S2_RECONCILIATION_TOLERANCE_BYTES = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** The gap the reconciliation is judged on, or `null` when one side never reported. */
export function reconciliationDifference(evidence: ReconciliationEvidence): number | null {
	if (evidence.applicationBytes === null || evidence.kernelBytes === null) return null;
	return Math.abs(evidence.applicationBytes - evidence.kernelBytes);
}

/**
 * Parses and validates. A malformed report is rejected, never coerced: the
 * failure this guards against is a report that lost a field on its way back from
 * the server and is then read as "that check did not report anything wrong".
 */
export function parseS2AcceptanceReport(raw: string): S2AcceptanceParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { error: `Report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, ok: false };
	}
	if (!isRecord(parsed)) return { error: "Report is not a JSON object.", ok: false };
	if (typeof parsed.schemaVersion !== "number") return { error: "Report has no numeric schemaVersion.", ok: false };
	// Checking only the type would give the field none of its value. A later
	// revision of the script could narrow what `pass` means on a check; grading
	// that report under v1 rules would print a confident verdict computed from
	// the wrong ones.
	if (parsed.schemaVersion !== S2_ACCEPTANCE_SCHEMA_VERSION) {
		return { error: `Report schemaVersion is ${parsed.schemaVersion}; this judge reads ${S2_ACCEPTANCE_SCHEMA_VERSION}.`, ok: false };
	}
	if (!isRecord(parsed.engine) || typeof parsed.engine.id !== "string" || typeof parsed.engine.version !== "string") {
		return { error: "Report has no engine { id, version }.", ok: false };
	}
	if (typeof parsed.kernel !== "string") return { error: "Report has no kernel string.", ok: false };
	if (!isRecord(parsed.preflight)) return { error: "Report has no preflight marker; an unproven tmpfs must be visible in the artifact.", ok: false };
	const sharedMemory = parsed.preflight.sharedMemory;
	if (sharedMemory !== "tmpfs" && sharedMemory !== "refused") {
		return { error: `Report preflight.sharedMemory is ${JSON.stringify(sharedMemory)}.`, ok: false };
	}
	const availableBytes = parsed.preflight.availableBytes;
	if (availableBytes !== null && !isByteCount(availableBytes)) {
		return { error: `Report preflight.availableBytes is ${JSON.stringify(availableBytes)}, which is neither a byte count nor null.`, ok: false };
	}
	if (typeof parsed.preflight.detail !== "string") return { error: "Report preflight has no detail string.", ok: false };
	if (!Array.isArray(parsed.checks)) return { error: "Report has no checks array.", ok: false };

	const checks: S2AcceptanceCheck[] = [];
	const seen = new Set<string>();
	for (const entry of parsed.checks) {
		if (!isRecord(entry)) return { error: "A check entry is not an object.", ok: false };
		const id = entry.id;
		if (typeof id !== "string" || !(S2_ACCEPTANCE_CHECK_IDS as readonly string[]).includes(id)) {
			return { error: `Unknown check id: ${JSON.stringify(id)}.`, ok: false };
		}
		if (seen.has(id)) return { error: `Check ${id} appears more than once.`, ok: false };
		seen.add(id);
		const outcome = entry.outcome;
		if (outcome !== "pass" && outcome !== "fail" && outcome !== "unavailable") {
			return { error: `Check ${id} has an unknown outcome: ${JSON.stringify(outcome)}.`, ok: false };
		}
		let reconciliation: ReconciliationEvidence | undefined;
		if (id === "transport-bytes-reconciliation") {
			if (!isRecord(entry.reconciliation)) {
				return { error: "Check transport-bytes-reconciliation carries no reconciliation evidence, so there is no difference to judge.", ok: false };
			}
			const application = entry.reconciliation.applicationBytes;
			const kernel = entry.reconciliation.kernelBytes;
			if (application !== null && !isByteCount(application)) {
				return { error: `Reconciliation applicationBytes is ${JSON.stringify(application)}, which is neither a byte count nor null.`, ok: false };
			}
			if (kernel !== null && !isByteCount(kernel)) {
				return { error: `Reconciliation kernelBytes is ${JSON.stringify(kernel)}, which is neither a byte count nor null.`, ok: false };
			}
			reconciliation = { applicationBytes: application, kernelBytes: kernel };
		} else if (entry.reconciliation !== undefined) {
			return { error: `Check ${id} carries reconciliation evidence, which only transport-bytes-reconciliation has.`, ok: false };
		}
		checks.push({
			id: id as S2AcceptanceCheckId,
			outcome,
			...(reconciliation === undefined ? {} : { reconciliation }),
			...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
		});
	}

	const missing = S2_ACCEPTANCE_CHECK_IDS.filter((id) => !seen.has(id));
	if (missing.length > 0) {
		return { error: `Report omits ${missing.join(", ")}; a check that is absent has not been judged.`, ok: false };
	}

	return {
		ok: true,
		report: {
			checks,
			engine: { id: parsed.engine.id, version: parsed.engine.version },
			kernel: parsed.kernel,
			preflight: { availableBytes, detail: parsed.preflight.detail, sharedMemory },
			schemaVersion: parsed.schemaVersion,
		},
	};
}

export interface S2AcceptanceVerdict {
	/** True when the reconciliation did not pass: S4 would be comparing numbers nobody has proven. */
	blocksS4: boolean;
	failed: S2AcceptanceCheckId[];
	notRun: S2AcceptanceCheckId[];
	/** The gap the reconciliation was judged on, or `null` when one side never reported. */
	reconciliationDifference: number | null;
	verdict: "fail" | "incomplete" | "pass";
}

/**
 * Judges the report. Two rules here are not in S1's version, and both exist to
 * stop a run being credited with a measurement it did not make:
 *
 *  - **The reconciliation is regraded from its own evidence.** The script
 *    reports an outcome, but the outcome that counts is computed here from the
 *    two byte counts. A collecting script — or a later edit to one — that
 *    claimed `pass` while reporting only one side would otherwise be believed,
 *    and one-sided is exactly the shape a broken collector produces.
 *  - **A one-sided reconciliation is `unavailable`, never `fail`.** Nothing was
 *    reconciled and nothing was contradicted; the missing number is a fact about
 *    the collector, not about S2.
 *
 * Three verdicts, not two. `incomplete` is what a report with holes earns: it is
 * neither evidence that S2 works nor evidence that it does not. A real failure
 * outranks a missing run — a check that never happened cannot excuse one that
 * happened and failed.
 */
export function judgeS2AcceptanceReport(report: S2AcceptanceReport): S2AcceptanceVerdict {
	const reconciliationCheck = report.checks.find((check) => check.id === "transport-bytes-reconciliation");
	const evidence = reconciliationCheck?.reconciliation ?? { applicationBytes: null, kernelBytes: null };
	const difference = reconciliationDifference(evidence);
	const reconciliationOutcome: S2AcceptanceOutcome =
		difference === null
			? "unavailable"
			: difference <= S2_RECONCILIATION_TOLERANCE_BYTES && reconciliationCheck?.outcome !== "fail"
				? "pass"
				: "fail";

	const graded = report.checks.map((check) =>
		check.id === "transport-bytes-reconciliation" ? { ...check, outcome: reconciliationOutcome } : check,
	);
	const failed = graded.filter((check) => check.outcome === "fail").map((check) => check.id);
	const notRun = graded.filter((check) => check.outcome === "unavailable").map((check) => check.id);
	return {
		blocksS4: reconciliationOutcome !== "pass",
		failed,
		notRun,
		reconciliationDifference: difference,
		verdict: failed.length > 0 ? "fail" : notRun.length > 0 ? "incomplete" : "pass",
	};
}

/**
 * The preflight marker a report carries. A thin alias rather than a second
 * implementation: two functions building the same marker would eventually build
 * two different ones, and the one that ends up in the artifact is whichever the
 * script happened to import.
 */
export function preflightMarkerFor(preflight: TmpfsPreflight): S2AcceptanceReport["preflight"] {
	return tmpfsPreflightMarker(preflight);
}

/**
 * Distinct exit codes, because a caller that cannot tell "S2 failed" from "S2
 * was never measured" will eventually treat the second as the first — or, worse,
 * as a pass with a warning. An unparseable report gets its own code too: it is a
 * problem with the report, not with S2.
 */
export function s2AcceptanceExitCode(result: { ok: false } | { ok: true; verdict: S2AcceptanceVerdict["verdict"] }): number {
	if (!result.ok) return 3;
	return result.verdict === "pass" ? 0 : result.verdict === "fail" ? 1 : 2;
}

/**
 * The shape of the report `scripts/synapse/s1-acceptance.sh` brings back from the
 * openEuler machine, and the judgement over it.
 *
 * The split is the point: the script collects facts on a host this repository's
 * CI will never run on, and every decision about what those facts mean lives
 * here, where Windows can prove it. A shell script that also decided pass/fail
 * would put the judgement on the one machine nobody can test.
 */

/**
 * The five checks of design §6, in the order the script runs them. `ipc-sharing`
 * is first because it is the one S2 cannot start without.
 */
export const S1_ACCEPTANCE_CHECK_IDS = [
	"ipc-sharing",
	"path-alignment",
	"degradation-visible",
	"lifecycle-no-leak",
	"s3-fd-premise",
] as const;

export type S1AcceptanceCheckId = (typeof S1_ACCEPTANCE_CHECK_IDS)[number];

/**
 * `unavailable` is not a soft `fail`. A check that never ran and a check that ran
 * and failed send a reader to different places — one to the machine, one to the
 * code — and collapsing them is how a report full of holes comes to read as a
 * clean run. Same discipline as S3's `unavailable` / `"N/A"`.
 */
export type S1AcceptanceOutcome = "pass" | "fail" | "unavailable";

export interface S1AcceptanceCheck {
	id: S1AcceptanceCheckId;
	outcome: S1AcceptanceOutcome;
	evidence: { bytes: number; paths: string[] };
	detail?: string;
}

export interface S1AcceptanceReport {
	schemaVersion: number;
	engine: { id: string; version: string };
	kernel: string;
	checks: S1AcceptanceCheck[];
}

export type S1AcceptanceParse =
	| { ok: true; report: S1AcceptanceReport }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates. A malformed report is rejected, never coerced: the
 * failure this guards against is a report that lost a field on its way back from
 * the server and is then read as "that check did not report anything wrong".
 */
export function parseS1AcceptanceReport(raw: string): S1AcceptanceParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: `Report is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed)) return { ok: false, error: "Report is not a JSON object." };
	if (typeof parsed.schemaVersion !== "number") return { ok: false, error: "Report has no numeric schemaVersion." };
	if (!isRecord(parsed.engine) || typeof parsed.engine.id !== "string" || typeof parsed.engine.version !== "string") {
		return { ok: false, error: "Report has no engine { id, version }." };
	}
	if (typeof parsed.kernel !== "string") return { ok: false, error: "Report has no kernel string." };
	if (!Array.isArray(parsed.checks)) return { ok: false, error: "Report has no checks array." };

	const checks: S1AcceptanceCheck[] = [];
	const seen = new Set<string>();
	for (const entry of parsed.checks) {
		if (!isRecord(entry)) return { ok: false, error: "A check entry is not an object." };
		const id = entry.id;
		if (typeof id !== "string" || !(S1_ACCEPTANCE_CHECK_IDS as readonly string[]).includes(id)) {
			return { ok: false, error: `Unknown check id: ${JSON.stringify(id)}.` };
		}
		if (seen.has(id)) return { ok: false, error: `Check ${id} appears more than once.` };
		seen.add(id);
		const outcome = entry.outcome;
		if (outcome !== "pass" && outcome !== "fail" && outcome !== "unavailable") {
			return { ok: false, error: `Check ${id} has an unknown outcome: ${JSON.stringify(outcome)}.` };
		}
		if (!isRecord(entry.evidence)) return { ok: false, error: `Check ${id} has no evidence object.` };
		const bytes = entry.evidence.bytes;
		if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
			return { ok: false, error: `Check ${id} reports ${JSON.stringify(bytes)} bytes, which is not a byte count.` };
		}
		const paths = entry.evidence.paths;
		if (!Array.isArray(paths) || paths.some((entryPath) => typeof entryPath !== "string")) {
			return { ok: false, error: `Check ${id} has no string paths array.` };
		}
		checks.push({
			id: id as S1AcceptanceCheckId,
			outcome,
			evidence: { bytes, paths: paths as string[] },
			...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
		});
	}

	const missing = S1_ACCEPTANCE_CHECK_IDS.filter((id) => !seen.has(id));
	if (missing.length > 0) {
		return { ok: false, error: `Report omits ${missing.join(", ")}; a check that is absent has not been judged.` };
	}

	return {
		ok: true,
		report: {
			schemaVersion: parsed.schemaVersion,
			engine: { id: parsed.engine.id, version: parsed.engine.version },
			kernel: parsed.kernel,
			checks,
		},
	};
}

export interface S1AcceptanceVerdict {
	verdict: "pass" | "fail" | "incomplete";
	failed: S1AcceptanceCheckId[];
	notRun: S1AcceptanceCheckId[];
	/** True when the check S2 cannot start without did not pass. */
	blocksS2: boolean;
}

/**
 * Three verdicts, not two. `incomplete` is what a report with holes earns: it is
 * neither evidence that S1 works nor evidence that it does not, and calling it
 * either would be a claim the run did not make.
 *
 * A real failure outranks a missing run — a check that never happened cannot
 * excuse one that happened and failed.
 */
export function judgeS1AcceptanceReport(report: S1AcceptanceReport): S1AcceptanceVerdict {
	const failed = report.checks.filter((check) => check.outcome === "fail").map((check) => check.id);
	const notRun = report.checks.filter((check) => check.outcome === "unavailable").map((check) => check.id);
	const sharedMemory = report.checks.find((check) => check.id === "ipc-sharing");
	return {
		verdict: failed.length > 0 ? "fail" : notRun.length > 0 ? "incomplete" : "pass",
		failed,
		notRun,
		blocksS2: sharedMemory?.outcome !== "pass",
	};
}

/**
 * Distinct exit codes, because a caller that cannot tell "S1 failed" from "S1 was
 * never measured" will eventually treat the second as the first — or, worse, as a
 * pass with a warning. An unparseable report gets its own code too: it is a
 * problem with the report, not with S1.
 */
export function s1AcceptanceExitCode(result: { ok: true; verdict: S1AcceptanceVerdict["verdict"] } | { ok: false }): number {
	if (!result.ok) return 3;
	return result.verdict === "pass" ? 0 : result.verdict === "fail" ? 1 : 2;
}

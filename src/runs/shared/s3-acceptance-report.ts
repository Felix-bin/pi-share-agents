/**
 * The shape of the report `scripts/synapse/s3-acceptance.ts` produces on a Linux
 * host, and the judgement over it (S3 design §7.3, plan Tasks 1 and 8).
 *
 * Same split as S1 and S2: the script runs as root on the one host that can load
 * eBPF, records what it measured, and decides nothing. Every decision about
 * what those measurements mean lives here, where CI can prove it.
 *
 * The three acceptance points of design §7.3 are each a falsifiable prediction,
 * not a plausibility check:
 *
 *  - self-consistency: on the `file` gear an envelope is written once by the
 *    parent and read once by the receiver, so the kernel's envelope bytes must
 *    be exactly the envelope file's size in each direction. Anything else means
 *    attribution or classification is wrong;
 *  - repeatability: the same delegation run three times moves the same bytes;
 *  - honesty: a collector forced to drop events must turn the account into a
 *    refusal, never a smaller number.
 *
 * Two environment checks come first because the others depend on them: the
 * collector must start (BTF present, probes attached), and the start time the
 * kernel half reads must be the one `/proc/<pid>/stat` reports, or the joiner's
 * `(pid, startTicks)` key matches nothing (design §8.1).
 */

export const S3_ACCEPTANCE_SCHEMA_VERSION = 1;

export const S3_ACCEPTANCE_CHECK_IDS = ["collector-start", "start-ticks-agree", "self-consistency", "repeatability", "honesty"] as const;
export type S3AcceptanceCheckId = (typeof S3_ACCEPTANCE_CHECK_IDS)[number];
export type S3AcceptanceOutcome = "pass" | "fail" | "unavailable";

export type S3ByteColumn = { readBytes: number; writeBytes: number };

/** What the kernel account said about one run, flattened from `KernelIoAccount`. */
export type S3KernelAccount =
	| { kind: "not-collected" }
	| { kind: "refused"; losses: number; reasons: string[] }
	| {
			byCategory: { content: S3ByteColumn; envelope: S3ByteColumn; "memory-index": S3ByteColumn };
			kind: "reported-no-gap-found" | "reported-with-gaps";
			losses: number;
			pathlessBytes: number;
			unclassified: S3ByteColumn;
	  };

export type S3RunFacts = {
	/** Application-side envelope bytes, from the metering log. */
	envelopeBytes: number;
	/** The envelope file's size on disk: what the kernel is predicted to move each way. */
	envelopeFileBytes: number;
	/** `process-identity` events of the run: the keys the joiner attributes by. */
	identities: Array<{ pid: number; startTicks: number }>;
	kernel: S3KernelAccount;
	/** Whether the receiver accepted the envelope; a run that did not deliver measures nothing. */
	receiptStatus: string;
	runId: string;
	/** Distinct startTicks the trace carried for each identity pid, as the kernel half read them. */
	traceStartTicks: Record<string, number[]>;
};

export type S3AcceptanceReport = {
	environment: {
		bpftraceVersion: string;
		btf: boolean;
		kernel: string;
		nodeVersion: string;
		osRelease: string;
		root: boolean;
	};
	/** Why the collector could not start, when it could not; null when it did. */
	collectorStartError: string | null;
	/** The deliberately overflowed run; null when it was not attempted. */
	honesty: (S3RunFacts & { ringBufferPages: number }) | null;
	/** The ordinary runs, in order; the first is the self-consistency run. */
	runs: S3RunFacts[];
	schemaVersion: number;
};

export type S3CheckResult = { detail: string; id: S3AcceptanceCheckId; outcome: S3AcceptanceOutcome };

export type S3Verdict = {
	checks: S3CheckResult[];
	verdict: "pass" | "fail" | "incomplete";
};

function delivered(run: S3RunFacts): boolean {
	return run.receiptStatus === "ready";
}

function reported(kernel: S3KernelAccount): kernel is Extract<S3KernelAccount, { byCategory: unknown }> {
	return kernel.kind === "reported-no-gap-found" || kernel.kind === "reported-with-gaps";
}

function describeAccount(kernel: S3KernelAccount): string {
	if (kernel.kind === "not-collected") return "no kernel account (nothing collected)";
	if (kernel.kind === "refused") return `account refused: ${kernel.reasons.join(", ")}${kernel.losses > 0 ? ` (${kernel.losses} events lost)` : ""}`;
	const envelope = kernel.byCategory.envelope;
	return `${kernel.kind}: envelope write ${envelope.writeBytes} B / read ${envelope.readBytes} B`;
}

function collectorStart(report: S3AcceptanceReport): S3CheckResult {
	const id = "collector-start";
	if (!report.environment.root) return { detail: "not run as root, so no eBPF program could be loaded", id, outcome: "unavailable" };
	if (!report.environment.btf) return { detail: "/sys/kernel/btf/vmlinux is missing: the kernel has no BTF", id, outcome: "fail" };
	if (report.collectorStartError !== null) return { detail: `the collector did not start: ${report.collectorStartError}`, id, outcome: "fail" };
	if (report.runs.length === 0) return { detail: "the collector started but no run was recorded", id, outcome: "unavailable" };
	return { detail: `bpftrace ${report.environment.bpftraceVersion} attached on ${report.environment.kernel}`, id, outcome: "pass" };
}

function startTicksAgree(report: S3AcceptanceReport): S3CheckResult {
	const id = "start-ticks-agree";
	const run = report.runs[0];
	if (run === undefined) return { detail: "no run to compare", id, outcome: "unavailable" };
	if (run.identities.length === 0) return { detail: "the run recorded no process-identity event, so there is nothing to compare against", id, outcome: "unavailable" };
	const disagreements: string[] = [];
	const unseen: number[] = [];
	for (const identity of run.identities) {
		const seen = run.traceStartTicks[String(identity.pid)];
		if (seen === undefined || seen.length === 0) {
			unseen.push(identity.pid);
			continue;
		}
		if (seen.length !== 1 || seen[0] !== identity.startTicks) disagreements.push(`pid ${identity.pid}: /proc says ${identity.startTicks}, the kernel half read ${seen.join("/")}`);
	}
	if (disagreements.length > 0) return { detail: disagreements.join("; "), id, outcome: "fail" };
	if (unseen.length === run.identities.length) return { detail: `no trace record carried any identity pid (${unseen.join(", ")})`, id, outcome: "fail" };
	return {
		detail: `${run.identities.length - unseen.length} process(es) agree exactly${unseen.length > 0 ? `; ${unseen.length} identity pid(s) made no traced call` : ""}: the (pid, startTicks) key is decidable, design §8.1's open risk resolves to the primary design`,
		id,
		outcome: "pass",
	};
}

function selfConsistency(report: S3AcceptanceReport): S3CheckResult {
	const id = "self-consistency";
	const run = report.runs[0];
	if (run === undefined) return { detail: "no run was recorded", id, outcome: "unavailable" };
	if (!delivered(run)) return { detail: `the receiver did not accept the envelope (${run.receiptStatus}), so no delivery was measured`, id, outcome: "unavailable" };
	if (!reported(run.kernel)) return { detail: describeAccount(run.kernel), id, outcome: run.kernel.kind === "not-collected" ? "unavailable" : "fail" };
	const envelope = run.kernel.byCategory.envelope;
	const predicted = run.envelopeFileBytes;
	const relation = `kernel ${envelope.writeBytes + envelope.readBytes} B = ${((envelope.writeBytes + envelope.readBytes) / run.envelopeBytes).toFixed(3)} × envelopeBytes (${run.envelopeBytes} B application-side, ${predicted} B on disk)`;
	if (envelope.writeBytes === predicted && envelope.readBytes === predicted) {
		return { detail: `envelope written ${predicted} B once and read ${predicted} B once, exactly the file's size each way; ${relation}`, id, outcome: "pass" };
	}
	return { detail: `predicted ${predicted} B written and ${predicted} B read, measured write ${envelope.writeBytes} B / read ${envelope.readBytes} B; ${relation}`, id, outcome: "fail" };
}

function repeatability(report: S3AcceptanceReport): S3CheckResult {
	const id = "repeatability";
	const usable = report.runs.filter((run) => delivered(run) && reported(run.kernel));
	if (report.runs.length < 3) return { detail: `${report.runs.length} run(s) recorded; three are needed`, id, outcome: "unavailable" };
	if (usable.length < report.runs.length) return { detail: `${report.runs.length - usable.length} of ${report.runs.length} runs produced no usable account: ${report.runs.map((run) => describeAccount(run.kernel)).join(" | ")}`, id, outcome: "fail" };
	const signature = (run: S3RunFacts): string => {
		const kernel = run.kernel as Extract<S3KernelAccount, { byCategory: unknown }>;
		return JSON.stringify(kernel.byCategory);
	};
	const first = signature(usable[0]!);
	const differing = usable.filter((run) => signature(run) !== first);
	if (differing.length > 0) return { detail: `bytes by category differ across runs: ${usable.map((run) => `${run.runId}=${signature(run)}`).join(" | ")}`, id, outcome: "fail" };
	return { detail: `${usable.length} runs moved identical bytes in every category: ${first}`, id, outcome: "pass" };
}

function honesty(report: S3AcceptanceReport): S3CheckResult {
	const id = "honesty";
	const run = report.honesty;
	if (run === null) return { detail: "the overflow run was not attempted", id, outcome: "unavailable" };
	const losses = run.kernel.kind === "not-collected" ? 0 : run.kernel.losses;
	if (losses === 0) return { detail: `a ${run.ringBufferPages}-page ring buffer lost no events, so the refusal path was not exercised`, id, outcome: "unavailable" };
	if (run.kernel.kind === "refused" && run.kernel.reasons.includes("collector-reported-loss")) {
		return { detail: `${losses} events lost with a ${run.ringBufferPages}-page buffer, and the account was refused (${run.kernel.reasons.join(", ")}) rather than reported smaller`, id, outcome: "pass" };
	}
	return { detail: `${losses} events were lost but the account was not refused for it: ${describeAccount(run.kernel)}`, id, outcome: "fail" };
}

export function judgeS3AcceptanceReport(report: S3AcceptanceReport): S3Verdict {
	const checks = [collectorStart(report), startTicksAgree(report), selfConsistency(report), repeatability(report), honesty(report)];
	const verdict = checks.some((check) => check.outcome === "fail") ? "fail" : checks.every((check) => check.outcome === "pass") ? "pass" : "incomplete";
	return { checks, verdict };
}

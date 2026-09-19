import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import type { CanonicalValue } from "./canonical-json.ts";
import { freezeSnapshot, parseEnvelope, type Envelope, type EnvelopeWire } from "./envelope.ts";
import type { LaunchContract } from "./lifecycle.ts";

/**
 * Delivery of the structured envelope to the agent it was addressed to.
 *
 * The envelope is built by the parent and, until it is written here, never left
 * that process: the child received text and had no way to tell a task frozen
 * against a snapshot from any other string. This module is the other half of
 * that handover. The parent publishes the wire form into the receiver's inbox;
 * the receiver reads it, parses it against the contract schema, and refuses to
 * run when the envelope does not describe the launch it is actually running
 * under.
 *
 * Delivery is a file because a background child is a separate process that
 * receives no live objects. The inbox is addressed by node rather than by
 * request id: the receiver knows which node it is before it starts, but the
 * request id is minted by the parent after the child session already exists.
 *
 * An absent envelope is not a failure. The parent skips delegation whenever
 * negotiation refuses it or the meter cannot be opened, and in that case the
 * child must run exactly the task upstream would have sent. Only an envelope
 * that is present and wrong stops a run.
 */

const ENVELOPES_DIR = "envelopes";
const ENVELOPE_SUFFIX = ".json";
const STATE_ENVELOPE_SUFFIX = ".state.json";
const UNATTRIBUTED = "unattributed";

/** Keeps a run id or child index usable as a single path component. */
export function safeComponent(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned.length > 0 ? cleaned : UNATTRIBUTED;
}

/**
 * The address of one receiver within a run. Both sides derive it here so the
 * metered node id and the inbox path cannot drift apart: a child index the
 * parent left undefined resolves to the same component on the receiving side.
 */
export function nodeIdFor(runId: string, childIndex: number | undefined): string {
	return `${runId}/${childIndex === undefined ? UNATTRIBUTED : childIndex}`;
}

function inboxPathFor(storageRoot: string, runId: string, childIndex: number | undefined, suffix: string): string {
	const receiver = childIndex === undefined ? UNATTRIBUTED : String(childIndex);
	return path.join(storageRoot, ENVELOPES_DIR, safeComponent(runId), `${safeComponent(receiver)}${suffix}`);
}

export function envelopeInboxPath(storageRoot: string, runId: string, childIndex: number | undefined): string {
	return inboxPathFor(storageRoot, runId, childIndex, ENVELOPE_SUFFIX);
}

/**
 * Where the state-plane envelope for one node lands — a sibling of the
 * delegation inbox rather than the same file.
 *
 * The delegation inbox holds one envelope per node and nothing else: the
 * receiving side reads that exact path to decide whether its launch was
 * delegated at all, and the delivery it belongs to is already metered with the
 * prompt's text bytes. Writing a state envelope over it would either erase a
 * delivery that was counted or make a counted delivery unreadable, so the two
 * planes address the same node through two names instead.
 */
export function stateEnvelopePath(storageRoot: string, runId: string, childIndex: number | undefined): string {
	return inboxPathFor(storageRoot, runId, childIndex, STATE_ENVELOPE_SUFFIX);
}

function writeEnvelopeTo(target: string, envelope: Envelope): string {
	writeAtomicJson(target, envelope.wire);
	return target;
}

/**
 * Publishes the wire form into the receiver's inbox and returns where it landed.
 *
 * One node holds one envelope. A re-delegation to the same node replaces it,
 * which matches how the seam counts deliveries: one pass is one delivery, and a
 * retry builds a new child session rather than a second copy of the first.
 */
export function publishEnvelope(storageRoot: string, runId: string, childIndex: number | undefined, envelope: Envelope): string {
	return writeEnvelopeTo(envelopeInboxPath(storageRoot, runId, childIndex), envelope);
}

/** The state-plane counterpart of {@link publishEnvelope}; the two never share a path. */
export function publishStateEnvelope(storageRoot: string, runId: string, childIndex: number | undefined, envelope: Envelope): string {
	return writeEnvelopeTo(stateEnvelopePath(storageRoot, runId, childIndex), envelope);
}

/**
 * Removes any state envelope left for this node. A delivery that carries no
 * state must not leave a previous delivery's state envelope behind: the
 * receiving side reads by path, not by request, so a stale file would be
 * consumed as though this delivery had published it.
 */
export function clearStateEnvelope(storageRoot: string, runId: string, childIndex: number | undefined): void {
	fs.rmSync(stateEnvelopePath(storageRoot, runId, childIndex), { force: true });
}

export type DeliveredEnvelope =
	| { status: "absent" }
	| { status: "ready"; wire: EnvelopeWire }
	| { reason: string; status: "rejected" };

/**
 * Reads and parses one delivered envelope.
 *
 * Only a missing file counts as absent. An unreadable one is not the same fact:
 * treating a permission or I/O error as "no envelope" would skip verification
 * exactly when something is wrong with the store.
 */
export function readDeliveredEnvelope(inboxPath: string): DeliveredEnvelope {
	let raw = "";
	try {
		raw = fs.readFileSync(inboxPath, "utf-8");
	} catch (error) {
		// SAFETY: readFileSync only throws fs errors, whose `code` field is the errno string this compares.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
		return { reason: `envelope at ${inboxPath} could not be read: ${error instanceof Error ? error.message : String(error)}`, status: "rejected" };
	}
	let parsed: CanonicalValue;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { reason: `envelope at ${inboxPath} is not valid JSON`, status: "rejected" };
	}
	try {
		return { status: "ready", wire: parseEnvelope(parsed) };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error), status: "rejected" };
	}
}

export type EnvelopeVerificationInput = {
	contract: LaunchContract;
	wire: EnvelopeWire;
};

/**
 * Checks that the envelope describes the launch this receiver is running under.
 * Returns the reason it does not, or null when every check holds.
 *
 * Each check recomputes a value both sides derive independently rather than
 * comparing something only one side could know. The snapshot is the strongest:
 * refreezing it from the envelope's own memory refs and the receiver's contract
 * proves in one step that the envelope is internally consistent and that it was
 * frozen against this contract.
 *
 * `receiverSessionId` is deliberately not checked. The parent records the child
 * session's id, while the receiver resolves its own identity from the session
 * file path when one exists, so the two are not reliably the same string and an
 * equality check would refuse correct runs.
 */
export function verifyEnvelopeAgainstContract(input: EnvelopeVerificationInput): string | null {
	const { contract, wire } = input;
	if (wire.namespaceId !== contract.namespaceId) {
		return `envelope belongs to namespace ${wire.namespaceId}, but this agent runs in ${contract.namespaceId}`;
	}
	if (wire.capabilityId !== contract.capabilityId) {
		return `envelope was negotiated for capability ${wire.capabilityId}, but this agent was launched with ${contract.capabilityId}`;
	}
	const refrozen = freezeSnapshot({
		capabilityId: contract.capabilityId,
		corpusSnapshotId: contract.corpusSnapshotId,
		memoryRefs: wire.memoryRefs,
		namespaceId: contract.namespaceId,
		permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
		representationId: contract.representationId,
	});
	if (refrozen.snapshotId !== wire.snapshotId) {
		return `envelope names snapshot ${wire.snapshotId}, but its contents and this agent's contract freeze to ${refrozen.snapshotId}`;
	}
	return null;
}

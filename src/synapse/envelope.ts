import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { canonicalDigest, canonicalJson, type CanonicalValue } from "./canonical-json.ts";
import type { SynapseAction, SynapseEncoding } from "./capability.ts";

/**
 * The host-generated envelope and the frozen snapshot it names.
 *
 * The envelope is built by the host, never by a model: it binds the request,
 * run, attempt and both session identities, and carries only references to
 * material the host has already authorised. A field the parser does not know is
 * rejected rather than ignored, because an ignored field is a contract that has
 * silently changed.
 *
 * `stateRef` already carries `encoding` and `baseMemoryId`. Residual coding
 * therefore needs no new protocol version and no change to the storage layer:
 * only the algorithm that fills these fields is still missing.
 */

export const SYNAPSE_PROTOCOL_VERSION = 2;
export const SYNAPSE_MAX_MEMORY_REFS = 32;

/**
 * Memory ids and content ids are both 64 hex characters, which is why naming
 * them apart matters: `memoryRefs` names records in the memory store, while
 * `payloadId` and `sha256` name bytes in the content store. One pattern serving
 * both let a field be validated as the wrong kind of id without failing.
 */
const MEMORY_ID_PATTERN = "^[0-9a-f]{64}$";
const CONTENT_ID_PATTERN = "^[0-9a-f]{64}$";
const FLOAT32_BYTES = 4;

export type PermissionProjection = {
	pathPrefixes: readonly string[];
	write: boolean;
};

export type SnapshotInput = {
	capabilityId: string;
	corpusSnapshotId: string;
	memoryRefs: readonly string[];
	namespaceId: string;
	permissionProjection: PermissionProjection;
	representationId: string;
};

export type FrozenSnapshot = {
	capabilityId: string;
	corpusSnapshotId: string;
	memoryRefs: string[];
	namespaceId: string;
	permissionProjection: PermissionProjection;
	representationId: string;
	snapshotId: string;
};

export type StateRef = {
	/** The prediction base a delta was computed against; null for a full vector. A memory id. */
	baseMemoryId: string | null;
	byteLength: number;
	dim: number;
	encoding: Exclude<SynapseEncoding, "text">;
	payloadId: string;
	representationId: string;
	sha256: string;
};

export type EnvelopeInput = {
	action: SynapseAction;
	attempt: number;
	inputParams: CanonicalValue;
	nodeId: string;
	ownerRunId: string;
	receiverSessionId: string;
	requestId: string;
	runId: string;
	senderSessionId: string;
	snapshot: FrozenSnapshot;
	stateRef?: StateRef;
};

export type EnvelopeWire = {
	action: SynapseAction;
	attempt: number;
	capabilityId: string;
	corpusSnapshotId: string;
	/**
	 * Input parameters as canonical JSON text. Text rather than a nested object
	 * so the envelope has exactly one byte representation: the same params always
	 * produce the same wire bytes, the same digest and the same measured cost.
	 */
	inputParamsJson: string;
	/** Ids of the shared-memory records handed over, not of their bodies. */
	memoryRefs: string[];
	namespaceId: string;
	nodeId: string;
	ownerRunId: string;
	protocolVersion: number;
	receiverSessionId: string;
	requestId: string;
	runId: string;
	senderSessionId: string;
	snapshotId: string;
	stateRef: StateRef | null;
};

export type Envelope = EnvelopeWire & {
	/** UTF-8 bytes of the wire form, so control cost is never accounted as free. */
	envelopeBytes: number;
	/** The params the host passed in, kept decoded for local use. */
	inputParams: CanonicalValue;
	wire: EnvelopeWire;
};

const StateRefSchema = Type.Object(
	{
		baseMemoryId: Type.Union([Type.String({ pattern: MEMORY_ID_PATTERN }), Type.Null()]),
		// Zero is allowed: a residual whose base already meets the encoder's stop
		// condition has no components to carry, and that empty payload decodes to the
		// base. A positive minimum would let the sender produce a message the receiver
		// then refuses to parse — the best case of the mechanism failing on the wire.
		byteLength: Type.Integer({ minimum: 0 }),
		dim: Type.Integer({ maximum: 8192, minimum: 1 }),
		encoding: Type.Union([Type.Literal("float32-vector"), Type.Literal("delta")]),
		payloadId: Type.String({ pattern: CONTENT_ID_PATTERN }),
		representationId: Type.String({ minLength: 1 }),
		sha256: Type.String({ pattern: CONTENT_ID_PATTERN }),
	},
	{ additionalProperties: false },
);

const EnvelopeSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("delegate"), Type.Literal("retrieve")]),
		attempt: Type.Integer({ minimum: 1 }),
		capabilityId: Type.String({ pattern: CONTENT_ID_PATTERN }),
		corpusSnapshotId: Type.String({ minLength: 1 }),
		inputParamsJson: Type.String(),
		memoryRefs: Type.Array(Type.String({ pattern: MEMORY_ID_PATTERN }), { maxItems: SYNAPSE_MAX_MEMORY_REFS }),
		namespaceId: Type.String({ pattern: "^[0-9a-f]{16}$" }),
		nodeId: Type.String({ minLength: 1 }),
		ownerRunId: Type.String({ minLength: 1 }),
		protocolVersion: Type.Literal(SYNAPSE_PROTOCOL_VERSION),
		receiverSessionId: Type.String({ minLength: 1 }),
		requestId: Type.String({ minLength: 1 }),
		runId: Type.String({ minLength: 1 }),
		senderSessionId: Type.String({ minLength: 1 }),
		snapshotId: Type.String({ pattern: CONTENT_ID_PATTERN }),
		stateRef: Type.Union([StateRefSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

const envelopeValidator = Compile(EnvelopeSchema);

function assertStateRef(stateRef: StateRef): void {
	const fullLength = stateRef.dim * FLOAT32_BYTES;
	if (stateRef.encoding === "float32-vector" && stateRef.byteLength !== fullLength) {
		throw new Error(`stateRef byteLength ${stateRef.byteLength} does not match dim ${stateRef.dim} (expected ${fullLength})`);
	}
	if (stateRef.encoding === "delta") {
		// The lower bound is zero by design, not by omission: see the schema note on
		// why an empty residual is a real message rather than a malformed one.
		// A residual longer than the vector it replaces would have no reason to exist.
		if (stateRef.byteLength > fullLength) {
			throw new Error(`stateRef byteLength ${stateRef.byteLength} exceeds the full vector it replaces (${fullLength})`);
		}
		if (stateRef.baseMemoryId === null) {
			throw new Error("stateRef baseMemoryId is required for a delta: a residual without its base cannot be decoded");
		}
	}
}

export function freezeSnapshot(input: SnapshotInput): FrozenSnapshot {
	const memoryRefs = [...new Set(input.memoryRefs)].sort();
	if (memoryRefs.length > SYNAPSE_MAX_MEMORY_REFS) {
		throw new Error(`memoryRefs: ${memoryRefs.length} exceeds the limit of ${SYNAPSE_MAX_MEMORY_REFS}`);
	}
	const idPattern = new RegExp(MEMORY_ID_PATTERN);
	for (const ref of memoryRefs) {
		// A model may propose references; only memory ids ever reach the host's
		// store, so anything else is rejected before it is frozen.
		if (!idPattern.test(ref)) throw new Error(`memoryRefs: ${JSON.stringify(ref)} is not a memory id`);
	}
	const permissionProjection: PermissionProjection = {
		pathPrefixes: [...new Set(input.permissionProjection.pathPrefixes)].sort(),
		write: input.permissionProjection.write,
	};
	return {
		capabilityId: input.capabilityId,
		corpusSnapshotId: input.corpusSnapshotId,
		memoryRefs,
		namespaceId: input.namespaceId,
		permissionProjection,
		representationId: input.representationId,
		snapshotId: canonicalDigest({
			capabilityId: input.capabilityId,
			corpusSnapshotId: input.corpusSnapshotId,
			memoryRefs,
			namespaceId: input.namespaceId,
			permissionProjection: { pathPrefixes: [...permissionProjection.pathPrefixes], write: permissionProjection.write },
			representationId: input.representationId,
		}),
	};
}

export function buildEnvelope(input: EnvelopeInput): Envelope {
	if (input.stateRef !== undefined) assertStateRef(input.stateRef);
	const wire: EnvelopeWire = {
		action: input.action,
		attempt: input.attempt,
		capabilityId: input.snapshot.capabilityId,
		corpusSnapshotId: input.snapshot.corpusSnapshotId,
		inputParamsJson: canonicalJson(input.inputParams),
		memoryRefs: [...input.snapshot.memoryRefs],
		namespaceId: input.snapshot.namespaceId,
		nodeId: input.nodeId,
		ownerRunId: input.ownerRunId,
		protocolVersion: SYNAPSE_PROTOCOL_VERSION,
		receiverSessionId: input.receiverSessionId,
		requestId: input.requestId,
		runId: input.runId,
		senderSessionId: input.senderSessionId,
		snapshotId: input.snapshot.snapshotId,
		stateRef: input.stateRef ?? null,
	};
	return { ...wire, envelopeBytes: Buffer.byteLength(JSON.stringify(wire), "utf-8"), inputParams: input.inputParams, wire };
}

export function parseEnvelope(wire: CanonicalValue): EnvelopeWire {
	if (!envelopeValidator.Check(wire)) {
		const [first] = [...envelopeValidator.Errors(wire)];
		throw new Error(`envelope rejected: ${first?.schemaPath ?? "unknown"} ${first?.message ?? "does not match the contract"}`);
	}
	if (wire.stateRef !== null) assertStateRef(wire.stateRef);
	return wire;
}

/** The decoded input parameters of a parsed envelope. */
export function envelopeParams(wire: EnvelopeWire): CanonicalValue {
	const decoded: CanonicalValue = JSON.parse(wire.inputParamsJson);
	return decoded;
}

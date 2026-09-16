import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { writeAtomicJson } from "../shared/atomic-json.ts";

/**
 * Content-addressed store for SYNAPSE evidence bodies.
 *
 * Objects are immutable and keyed by the SHA-256 of their exact bytes. Writes
 * land in a temp file inside the same shard directory and are published by
 * rename, so a reader never observes a partially written body; readers ignore
 * temp files entirely. Every read re-verifies the digest, because a body that
 * no longer hashes to its id is corruption, not evidence.
 */

export const SYNAPSE_DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024;

const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_SUFFIX = ".bin";
const META_SUFFIX = ".meta.json";

export type ContentStoreLimits = {
	maxObjectBytes?: number;
};

export type ContentTextRange = {
	text: string;
	nextOffsetBytes: number;
	totalBytes: number;
};

export type ContentStore = {
	put: (bytes: Uint8Array, mediaType: string) => string;
	has: (contentId: string) => boolean;
	read: (contentId: string) => Uint8Array;
	readTextRange: (contentId: string, offsetBytes: number, limitBytes: number) => ContentTextRange;
	mediaTypeOf: (contentId: string) => string;
	objectPath: (contentId: string) => string;
	list: () => string[];
};

type ObjectMeta = {
	contentId: string;
	byteLength: number;
	mediaType: string;
};

function assertContentId(contentId: string): void {
	if (!CONTENT_ID_PATTERN.test(contentId)) {
		throw new Error(`invalid content id: ${JSON.stringify(contentId)}`);
	}
}

function isContinuationByte(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}

function digestOf(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const ObjectMetaSchema = Type.Object(
	{
		byteLength: Type.Integer({ minimum: 0 }),
		contentId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		mediaType: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const objectMetaValidator = Compile(ObjectMetaSchema);

function decodeMeta(raw: string, contentId: string): ObjectMeta {
	const parsed = JSON.parse(raw);
	if (!objectMetaValidator.Check(parsed)) {
		throw new Error(`integrity: malformed metadata for ${contentId}`);
	}
	if (parsed.contentId !== contentId) {
		throw new Error(`integrity: metadata for ${contentId} claims ${parsed.contentId}`);
	}
	return parsed;
}

export function createContentStore(rootDir: string, limits: ContentStoreLimits = {}): ContentStore {
	const maxObjectBytes = limits.maxObjectBytes ?? SYNAPSE_DEFAULT_MAX_OBJECT_BYTES;
	const objectsDir = path.join(rootDir, "objects");

	function shardDir(contentId: string): string {
		return path.join(objectsDir, contentId.slice(0, 2));
	}

	function objectPath(contentId: string): string {
		assertContentId(contentId);
		return path.join(shardDir(contentId), `${contentId}${OBJECT_SUFFIX}`);
	}

	function metaPath(contentId: string): string {
		return path.join(shardDir(contentId), `${contentId}${META_SUFFIX}`);
	}

	function readMeta(contentId: string): ObjectMeta {
		let raw = "";
		try {
			raw = fs.readFileSync(metaPath(contentId), "utf-8");
		} catch {
			throw new Error(`object-unavailable: ${contentId}`);
		}
		return decodeMeta(raw, contentId);
	}

	function readVerified(contentId: string): Uint8Array {
		const filePath = objectPath(contentId);
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(filePath);
		} catch {
			throw new Error(`object-unavailable: ${contentId}`);
		}
		if (digestOf(bytes) !== contentId) {
			throw new Error(`integrity: object ${contentId} no longer matches its digest`);
		}
		return new Uint8Array(bytes);
	}

	return {
		has(contentId: string): boolean {
			assertContentId(contentId);
			return fs.existsSync(objectPath(contentId)) && fs.existsSync(metaPath(contentId));
		},

		list(): string[] {
			let shards: string[] = [];
			try {
				shards = fs.readdirSync(objectsDir);
			} catch {
				return [];
			}
			const ids: string[] = [];
			for (const shard of shards) {
				let entries: string[] = [];
				try {
					entries = fs.readdirSync(path.join(objectsDir, shard));
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (!entry.endsWith(OBJECT_SUFFIX)) continue;
					const candidate = entry.slice(0, -OBJECT_SUFFIX.length);
					// Temp files are dot-prefixed and never match a bare content id.
					if (CONTENT_ID_PATTERN.test(candidate)) ids.push(candidate);
				}
			}
			return ids.sort();
		},

		mediaTypeOf(contentId: string): string {
			assertContentId(contentId);
			return readMeta(contentId).mediaType;
		},

		objectPath,

		put(bytes: Uint8Array, mediaType: string): string {
			if (bytes.byteLength > maxObjectBytes) {
				throw new Error(`maxObjectBytes exceeded: ${bytes.byteLength} > ${maxObjectBytes}`);
			}
			const contentId = digestOf(bytes);
			const target = objectPath(contentId);
			if (fs.existsSync(target) && fs.existsSync(metaPath(contentId))) {
				const existing = readMeta(contentId);
				if (existing.mediaType !== mediaType) {
					throw new Error(`integrity: object ${contentId} already stored as ${existing.mediaType}, refusing ${mediaType}`);
				}
				return contentId;
			}
			const dir = shardDir(contentId);
			fs.mkdirSync(dir, { recursive: true });
			const tempPath = path.join(dir, `.${contentId}.${process.pid}.${Date.now()}.tmp`);
			try {
				fs.writeFileSync(tempPath, bytes);
				fs.renameSync(tempPath, target);
			} finally {
				fs.rmSync(tempPath, { force: true });
			}
			// The body is published before its metadata so a reader can never find
			// metadata pointing at an object that does not exist yet.
			writeAtomicJson(metaPath(contentId), { byteLength: bytes.byteLength, contentId, mediaType } satisfies ObjectMeta);
			return contentId;
		},

		read(contentId: string): Uint8Array {
			assertContentId(contentId);
			return readVerified(contentId);
		},

		readTextRange(contentId: string, offsetBytes: number, limitBytes: number): ContentTextRange {
			assertContentId(contentId);
			const bytes = readVerified(contentId);
			const requestedStart = Math.max(0, Math.min(offsetBytes, bytes.byteLength));
			const requestedEnd = Math.max(requestedStart, Math.min(requestedStart + limitBytes, bytes.byteLength));
			// Snap both edges to character boundaries. A UTF-8 continuation byte is
			// 0b10xxxxxx, so a range that begins or ends on one would otherwise hand
			// the caller a truncated character that decodes to U+FFFD.
			let start = requestedStart;
			while (start < bytes.byteLength && isContinuationByte(bytes[start] ?? 0)) start += 1;
			let end = requestedEnd;
			while (end > start && end < bytes.byteLength && isContinuationByte(bytes[end] ?? 0)) end -= 1;
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
			return { nextOffsetBytes: end, text, totalBytes: bytes.byteLength };
		},
	};
}

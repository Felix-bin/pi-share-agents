/**
 * The shared-memory plane's binding layer (design v1 §4.1, P6-1).
 *
 * SYNAPSE's default hot path is and stays the file path: `state-retrieval.ts`
 * reads `vectors.f32` + `chunks.json` from disk on every state consumption.
 * This module is the additive second path — a POSIX named shared-memory
 * segment (`shm_open` + `mmap`) whose bytes a reader can view as a zero-copy
 * `ArrayBuffer`. Nothing in this file changes the default path; the segment is
 * only consulted when config turns it on (`synapse.shm.enabled`, which must
 * never default to true, same rule as the `uds` delivery gear).
 *
 * Node's standard library has no `mmap` (proposal nodejs/node#41069 was closed
 * as *not planned*), so the real implementation loads `koffi` at runtime. koffi
 * is an optional, prebuilt dependency; when it is absent, or the platform has
 * no POSIX shm, `createPosixShmBindings` returns `null` and every caller falls
 * back to the file path silently — degradation is a return value, not an
 * exception, mirroring `resolveEffectiveDeliveryGear`.
 *
 * Everything splits into a pure half and an injectable-I/O half, so the
 * hard-to-get-wrong parts are provable without a segment. `shmSegmentName` and
 * `classifyShmAttachFailure` touch nothing. `ShmBindings` is the seam; the
 * in-memory fake (`createInMemoryShmBindings`) stands in for a real segment in
 * unit tests on every platform, exactly the way `synapse-envelope-uds.test.ts`
 * injects a fake socket pair.
 *
 * koffi 3.3.2 facts baked into the real implementation (probe 2026-09-30,
 * openEuler 24.03-SP3 WSL2, observed rather than assumed):
 *   - every `void *` return value is a BigInt address, including `mmap`;
 *   - `koffi.view(ptr, len)` returns a zero-copy **ArrayBuffer** (not a Node
 *     Buffer — `.buffer` is undefined on it), which is exactly the
 *     external-ArrayBuffer surface this module wants;
 *   - MAP_FAILED arrives as -1n, not as an exception.
 *
 * SIGBUS discipline (design §4.2, PostgreSQL dsm_impl.c's warning): a tmpfs
 * segment whose tail was never written raises SIGBUS on access *after*
 * `/dev/shm` fills, which no try/catch survives. `createSegment` therefore
 * ftruncate-preallocates and then touches every page through its own mapping
 * before returning, so a segment this module created has no holes by
 * construction.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";

/** Design §4.2: the superblock is two 4 KiB copies; the index follows at 8 KiB. */
export const SHM_SUPERBLOCK_BYTES = 4096;
export const SHM_SUPERBLOCK_SPAN_BYTES = 8192;

/** Everything this module names lives under this prefix; orphan reaping scans only this prefix (never all of /dev/shm). */
export const SHM_NAME_PREFIX = "synapse-";

/** The NAME_MAX budget POSIX gives a shm name; our names are far below it. */
export const SHM_NAME_MAX = 255;

/**
 * Segment name for a namespace generation: `/synapse-<ns16>-g<gen>`.
 * `<ns16>` is the 16-hex namespace id (`namespace.ts`), `<gen>` a decimal
 * generation. Pure: no I/O, no allocation.
 */
export function shmSegmentName(namespaceId16: string, generation: number): string {
	if (!/^[0-9a-f]{16}$/.test(namespaceId16)) throw new Error(`shm: namespace id must be 16 hex chars, got ${JSON.stringify(namespaceId16)}`);
	if (!Number.isSafeInteger(generation) || generation < 0 || generation > 0xffffffff) throw new Error(`shm: generation out of range: ${generation}`);
	const name = `/${SHM_NAME_PREFIX}${namespaceId16}-g${generation}`;
	if (name.length + 1 > SHM_NAME_MAX) throw new Error(`shm: segment name exceeds NAME_MAX budget: ${name.length + 1}`);
	return name;
}

/** Inverse of {@link shmSegmentName} for a name this module produced. Used by orphan reaping to keep only its own. */
export function parseShmSegmentName(name: string): { generation: number; namespaceId16: string } | null {
	const match = new RegExp(`^/(?:${SHM_NAME_PREFIX})([0-9a-f]{16})-g(\\d+)$`).exec(name);
	if (match === null) return null;
	return { namespaceId16: match[1] ?? "", generation: Number(match[2]) };
}

/** Why an attach failed. `missing` is the normal cold start (nothing published yet), never an error. */
export type ShmAttachFailureKind = "capacity" | "missing" | "permission" | "unsupported";

export function classifyShmAttachFailure(message: string): ShmAttachFailureKind {
	const lower = message.toLowerCase();
	if (lower.includes("enoent") || lower.includes("no such file")) return "missing";
	if (lower.includes("enospc") || lower.includes("no space")) return "capacity";
	if (lower.includes("eacces") || lower.includes("eperm") || lower.includes("permission")) return "permission";
	return "unsupported";
}

/** One mapping of the segment into this process. `buffer` is zero-copy; `detach` unmaps. */
export type ShmMapping = {
	buffer: ArrayBuffer;
	detach(): void;
};

/** The seam. Real POSIX implementation below; the in-memory fake beside it. */
export type ShmBindings = {
	/** "linux-shm" carries the real path; "memory" is the fake (tests, and hosts without POSIX shm). */
	readonly kind: "linux-shm" | "memory";
	/** Create the segment (ftruncate-preallocated, hole-free) or open it when it already exists. */
	createSegment(name: string, bytes: number): ShmMapping;
	/** Open an existing segment read-only, or `null` when it does not exist (a cold start, not a failure). */
	openSegment(name: string): ShmMapping | null;
	/** Remove a segment name. Returns whether the name existed. */
	unlink(name: string): boolean;
	/** Names of this tool's segments that exist right now, unsorted. Scan scope: our prefix only. */
	listOwnSegments(): string[];
	/**
	 * Free bytes on the shm filesystem, or `null` where the host cannot tell
	 * (three conclusions, not two — same rule as `tmpfs-preflight.ts`). The
	 * memory fake reports `null` rather than pretending.
	 */
	capacityBytes(): number | null;
};

/**
 * The in-memory fake. Segments live in a shared registry keyed by name, so two
 * `createInMemoryShmBindings()` instances (a writer and a reader in the same
 * process) see the same bytes — the property the real bindings get from the
 * kernel. `buffer` is shared, not copied: a writer's edit is immediately
 * visible to a reader, which is what the segment layout's publish protocol is
 * tested against.
 */
export function createInMemoryShmBindings(): ShmBindings {
	const registry = inMemorySegmentRegistry();
	return {
		kind: "memory",
		createSegment(name, bytes) {
			let buffer = registry.get(name);
			if (buffer === undefined) {
				// A new segment is zero-filled by construction (a fresh ArrayBuffer),
				// matching the real path's ftruncate-preallocated, hole-free segment.
				buffer = new ArrayBuffer(bytes);
				registry.set(name, buffer);
				return { buffer, detach() {} };
			}
			if (buffer.byteLength !== bytes) {
				throw new Error(`shm(memory): segment ${name} exists with ${buffer.byteLength} bytes, refusing to resize to ${bytes}`);
			}
			// Existing segment: O_CREAT-open semantics — bytes are preserved, because
			// a writer reattach (same namespace+generation) must keep published state.
			// Clearing here would have made every reattach silently drop the segment.
			return { buffer, detach() {} };
		},
		openSegment(name) {
			const buffer = registry.get(name);
			if (buffer === undefined) return null;
			return { buffer, detach() {} };
		},
		unlink(name) {
			return registry.delete(name);
		},
		listOwnSegments() {
			return [...registry.keys()].filter((name) => name.startsWith(`/${SHM_NAME_PREFIX}`));
		},
		capacityBytes() {
			return null;
		},
	};
}

function inMemorySegmentRegistry(): Map<string, ArrayBuffer> {
	// On globalThis so every instance shares one registry and a test reset is heard everywhere.
	const holder = globalThis as { __synapseInMemoryShmSegments?: Map<string, ArrayBuffer> };
	if (holder.__synapseInMemoryShmSegments === undefined) holder.__synapseInMemoryShmSegments = new Map();
	return holder.__synapseInMemoryShmSegments;
}

/** Test hook: drop every in-memory segment. Never call from production code. */
export function resetInMemoryShmSegments(): void {
	const holder = globalThis as { __synapseInMemoryShmSegments?: Map<string, ArrayBuffer> };
	holder.__synapseInMemoryShmSegments = new Map();
}

/**
 * Minimal structural types for the koffi surface this module uses. koffi ships
 * no bundled types and stays an optional dependency; typecheck must not depend
 * on it being installed.
 */
type KoffiFunction = (...args: unknown[]) => unknown;
type KoffiLibrary = { func: (signature: string) => KoffiFunction };
type KoffiModule = {
	errno?: () => number;
	load: (name: string) => KoffiLibrary;
	view: (pointer: bigint, length: number) => ArrayBuffer;
};

/**
 * The real POSIX bindings via koffi. Returns `null` — never throws — when
 * koffi is not installed, or the platform is not Linux: degradation, not
 * failure. Call once and reuse.
 */
export function createPosixShmBindings(deps: { platform?: string } = {}): ShmBindings | null {
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") return null;
	let koffi: KoffiModule;
	try {
		// createRequire keeps koffi a runtime-optional dependency: koffi-less
		// installs and bundlers must still be able to load this module.
		const nodeRequire = createRequire(import.meta.url);
		koffi = nodeRequire("koffi") as KoffiModule;
	} catch {
		return null;
	}
	try {
		return buildKoffiBindings(koffi);
	} catch {
		return null;
	}
}

function buildKoffiBindings(koffi: KoffiModule): ShmBindings {
	const lib = koffi.load("libc.so.6");
	const shm_open = lib.func("int shm_open(const char *name, int oflag, int mode)") as (name: string, oflag: number, mode: number) => number;
	const shm_unlink = lib.func("int shm_unlink(const char *name)") as (name: string) => number;
	const ftruncate = lib.func("int ftruncate(int fd, long length)") as (fd: number, length: number) => number;
	const mmap = lib.func("void *mmap(void *addr, unsigned long length, int prot, int flags, int fd, long offset)") as (
		addr: null,
		length: number,
		prot: number,
		flags: number,
		fd: number,
		offset: number,
	) => bigint;
	const munmap = lib.func("int munmap(void *addr, unsigned long length)") as (addr: bigint, length: number) => number;
	const close = lib.func("int close(int fd)") as (fd: number) => number;
	const fstat = lib.func("int fstat(int fd, void *buf)") as (fd: number, buf: Uint8Array) => number;
	const statfs = lib.func("int statfs(const char *path, void *buf)") as (path: string, buf: Uint8Array) => number;

	const O_CREAT = 64;
	const O_RDWR = 2;
	const O_RDONLY = 0;
	const PROT_READ = 1;
	const PROT_WRITE = 2;
	const MAP_SHARED = 1;
	const PAGE = 4096;

	const fail = (what: string, ret: number): never => {
		const errno = koffi.errno?.();
		throw new Error(`shm: ${what} failed (ret ${ret}, errno ${errno ?? "unknown"})`);
	};

	const mapSegment = (fd: number, bytes: number, writable: boolean): ShmMapping => {
		const ptr = mmap(null, bytes, writable ? PROT_READ | PROT_WRITE : PROT_READ, MAP_SHARED, fd, 0);
		if (typeof ptr !== "bigint" || ptr === 0n || ptr === -1n) throw new Error(`shm: mmap failed (${String(ptr)})`);
		const buffer = koffi.view(ptr, bytes);
		let detached = false;
		return {
			buffer,
			detach() {
				if (detached) return;
				detached = true;
				munmap(ptr, bytes);
			},
		};
	};

	return {
		kind: "linux-shm",
		createSegment(name, bytes) {
			const fd = shm_open(name, O_CREAT | O_RDWR, 0o600);
			if (fd < 0) fail("shm_open(O_CREAT)", fd);
			try {
				if (ftruncate(fd, bytes) !== 0) fail("ftruncate", -1);
				const mapping = mapSegment(fd, bytes, true);
				// Touch every page once through our own mapping so the segment has no
				// holes by construction: a later reader can never SIGBUS on an
				// untouched tail — the failure mode is uncatchable, so prevent it.
				const view = new Uint8Array(mapping.buffer);
				for (let offset = 0; offset < view.length; offset += PAGE) {
					const zero = view[offset] ?? 0;
					view[offset] = zero;
				}
				return mapping;
			} finally {
				close(fd);
			}
		},
		openSegment(name) {
			const fd = shm_open(name, O_RDONLY, 0);
			if (fd < 0) return null; // ENOENT: cold start, the caller falls back to files
			try {
				// Size comes from the segment itself (the writer's ftruncate), not from
				// the caller's expectation: a reader must map exactly what exists.
				const stat = new Uint8Array(144); // struct stat, x86-64 glibc
				if (fstat(fd, stat) !== 0) return null;
				const size = Number(new DataView(stat.buffer).getBigUint64(48, true)); // st_size, x86-64 glibc layout
				if (size <= 0) return null;
				return mapSegment(fd, size, false);
			} finally {
				close(fd);
			}
		},
		unlink(name) {
			return shm_unlink(name) === 0;
		},
		listOwnSegments() {
			// POSIX names the shm filesystem /dev/shm; our prefix is the scan scope.
			try {
				return fs
					.readdirSync("/dev/shm")
					.filter((entry) => entry.startsWith(SHM_NAME_PREFIX))
					.map((entry) => `/${entry}`);
			} catch {
				return [];
			}
		},
		capacityBytes() {
			// struct statfs (x86-64): f_type@0, f_bsize@8, f_blocks@16, f_bfree@24, f_bavail@32 — all 8 bytes.
			const buf = new Uint8Array(120);
			if (statfs("/dev/shm", buf) !== 0) return null;
			const view = new DataView(buf.buffer);
			const bsize = Number(view.getBigUint64(8, true));
			const bavail = Number(view.getBigUint64(32, true));
			return bsize * bavail;
		},
	};
}

/**
 * Resolve the bindings to use: real POSIX when available, in-memory fake only
 * when explicitly asked (tests), `null` otherwise. Production callers get
 * `null` and stay on the file path — the fake is never a silent production
 * fallback, because "shared memory" claims must mean kernel shm (same rule
 * that makes `tmpfs-preflight` refuse an unproven tmpfs).
 */
export function resolveShmBindings(options: { allowInMemory?: boolean } = {}): ShmBindings | null {
	const real = createPosixShmBindings();
	if (real !== null) return real;
	if (options.allowInMemory === true) return createInMemoryShmBindings();
	return null;
}

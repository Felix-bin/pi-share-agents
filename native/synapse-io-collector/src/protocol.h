/*
 * Shared kernel/user-space layout for the SYNAPSE file I/O collector.
 *
 * Included by both the BPF object and the loader, so it must not pull in libc:
 * the BPF side sees these types through vmlinux.h.
 *
 * Nothing here carries file contents. The kernel side only ever records a
 * category, a byte count, a duration and a return code — never a buffer.
 */

#ifndef SYNAPSE_IO_PROTOCOL_H
#define SYNAPSE_IO_PROTOCOL_H

/*
 * Bumped whenever a map layout below changes. The loader refuses an object
 * whose version does not match its own, because a silently reinterpreted
 * struct would produce plausible numbers that mean something else.
 */
#define SYNAPSE_IO_ABI_VERSION 1

/* The line protocol version announced on the socket. Independent of the ABI. */
#define SYNAPSE_IO_WIRE_PROTOCOL "synapse-io/1"

/* Latency is bucketed by log2(nanoseconds); 32 buckets reach ~2^31 ns (~2.1 s). */
#define SYNAPSE_IO_HIST_BUCKETS 32

/* Fixed capacities. Every map is bounded: overflow is counted, never queued. */
#define SYNAPSE_IO_MAX_PROCESSES 1024
#define SYNAPSE_IO_MAX_STATS (SYNAPSE_IO_MAX_PROCESSES * 8)
#define SYNAPSE_IO_MAX_TRACKED_FILES 16384
#define SYNAPSE_IO_MAX_INFLIGHT 4096

/*
 * A task's start time is compared in USER_HZ units (100 Hz on Linux), because
 * /proc/<pid>/stat field 22 is the only form user space can read and it is
 * already reduced to those units. Both sides divide, so both sides truncate the
 * same way.
 */
#define SYNAPSE_IO_NS_PER_USER_TICK 10000000ULL

/* Longest storage-root prefix the classifier compares. Longer roots are refused
 * by the loader rather than silently truncated into a prefix that matches too much. */
#define SYNAPSE_IO_MAX_ROOT_LEN 256
/* Path buffer handed to bpf_d_path(). A path that does not fit is unclassified. */
#define SYNAPSE_IO_PATH_BUF_LEN 512

enum synapse_io_category {
	/* Observation's own files: metering logs and observation artifacts. Skipped
	 * entirely so that writing the measurement cannot inflate the measurement. */
	SYNAPSE_IO_CAT_EXCLUDED = 0,
	SYNAPSE_IO_CAT_ENVELOPE = 1,
	SYNAPSE_IO_CAT_CONTENT = 2,
	SYNAPSE_IO_CAT_MEMORY_INDEX = 3,
	/* Inside the storage root but not resolvable to one of the above: a truncated
	 * path, a failed d_path, or a directory layout this build does not know. */
	SYNAPSE_IO_CAT_UNCLASSIFIED = 4,
	SYNAPSE_IO_CAT__COUNT = 5,
};

/* Indices into the global counter array map. */
enum synapse_io_counter {
	/* An open whose path could not be resolved or did not fit the buffer. */
	SYNAPSE_IO_COUNTER_CLASSIFY_INCOMPLETE = 0,
	/* A tracked-file, stats or in-flight insert that hit a map capacity limit. */
	SYNAPSE_IO_COUNTER_MAP_OVERFLOW = 1,
	/* A vfs return seen without its matching entry (probe attached mid-call). */
	SYNAPSE_IO_COUNTER_UNPAIRED_RETURN = 2,
	SYNAPSE_IO_COUNTER__COUNT = 3,
};

struct synapse_io_file_key {
	__u64 ino;
	__u32 dev;
	__u32 pad;
};

struct synapse_io_stats_key {
	__u32 tgid;
	__u32 category;
};

/*
 * Cumulative since the process was registered. Bytes count only what the kernel
 * actually returned, so a short read contributes what it moved, not what it was
 * asked for; a negative return contributes to failed_ops and no bytes.
 */
struct synapse_io_stats {
	__u64 read_bytes;
	__u64 write_bytes;
	__u64 read_ops;
	__u64 write_ops;
	__u64 failed_ops;
	__u64 read_ns;
	__u64 write_ns;
	__u64 read_hist[SYNAPSE_IO_HIST_BUCKETS];
	__u64 write_hist[SYNAPSE_IO_HIST_BUCKETS];
};

/*
 * One registered process. `start_ticks` is the kernel's own start time for the
 * task; the loader compares it against the value the client reported so a
 * recycled pid cannot inherit another run's attribution.
 */
struct synapse_io_process {
	__u64 start_ticks;
	__u64 registered_at_ns;
	__u8 root[SYNAPSE_IO_MAX_ROOT_LEN];
	__u32 root_len;
	__u32 pad;
};

/* Per-thread entry state. `depth` makes nested vfs calls on one thread count once. */
struct synapse_io_inflight {
	__u64 started_ns;
	__u32 depth;
	__u32 pad;
};

#endif /* SYNAPSE_IO_PROTOCOL_H */

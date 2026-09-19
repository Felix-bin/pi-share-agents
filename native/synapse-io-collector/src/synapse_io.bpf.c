/*
 * SYNAPSE file I/O collector, kernel side.
 *
 * What this program does: for processes a privileged loader has explicitly
 * registered, it counts the bytes, operations and durations of VFS reads and
 * writes against files under that process's SYNAPSE storage root, bucketed by
 * what the file is for.
 *
 * What it deliberately does not do:
 *   - It never reads file contents, buffers, prompts or credentials. The only
 *     values it touches are an inode identity, a byte count and a timestamp.
 *   - It never blocks or fails an operation. Every map has a fixed capacity and
 *     every capacity failure increments a counter the user space side reports as
 *     degraded coverage. An overflowing collector must lose measurements, never
 *     slow down the work it is measuring.
 *   - It never guesses a category. A path that could not be resolved is
 *     UNCLASSIFIED and is reported as such.
 *
 * Coverage boundary: synchronous vfs_read / vfs_write / vfs_readv / vfs_writev.
 * That covers read, write, pread, pwrite, readv, writev, preadv and pwritev.
 * It does not cover mmap stores, io_uring, or splice. Callers must not describe
 * the result as total file I/O.
 */

#include "vmlinux.h"

#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#include "protocol.h"

char LICENSE[] SEC("license") = "GPL";

const volatile __u32 abi_version = SYNAPSE_IO_ABI_VERSION;

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, SYNAPSE_IO_MAX_PROCESSES);
	__type(key, __u32);
	__type(value, struct synapse_io_process);
} registered SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, SYNAPSE_IO_MAX_STATS);
	__type(key, struct synapse_io_stats_key);
	__type(value, struct synapse_io_stats);
} stats SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, SYNAPSE_IO_MAX_TRACKED_FILES);
	__type(key, struct synapse_io_file_key);
	__type(value, __u32);
} tracked_files SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, SYNAPSE_IO_MAX_INFLIGHT);
	__type(key, __u64);
	__type(value, struct synapse_io_inflight);
} inflight SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, SYNAPSE_IO_COUNTER__COUNT);
	__type(key, __u32);
	__type(value, __u64);
} counters SEC(".maps");

/* One scratch page per CPU: a 512 byte path buffer does not fit the 512 byte
 * BPF stack, and a per-CPU array is the cheapest place to borrow one. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, char[SYNAPSE_IO_PATH_BUF_LEN]);
} path_scratch SEC(".maps");

static __always_inline void bump(__u32 index)
{
	__u64 *slot = bpf_map_lookup_elem(&counters, &index);
	if (slot)
		__sync_fetch_and_add(slot, 1);
}

/*
 * Compares a literal against the buffer at `off`. Bounded by the longest
 * segment name we look for so the verifier can see the loop terminate.
 */
static __always_inline int segment_is(const char *buf, __u32 off, const char *lit, __u32 lit_len)
{
	for (__u32 i = 0; i < 16; i++) {
		if (i >= lit_len)
			return 1;
		__u32 idx = (off + i) & (SYNAPSE_IO_PATH_BUF_LEN - 1);
		if (buf[idx] != lit[i])
			return 0;
	}
	return 1;
}

/*
 * Maps a resolved absolute path to a category, given the registered storage
 * root. Returns -1 when the path is not under the root at all, which is the
 * common case: an agent reads far more source files than SYNAPSE objects, and
 * those must not enter the measurement.
 */
static __always_inline int classify(const char *buf, __u32 path_len, const struct synapse_io_process *proc)
{
	__u32 root_len = proc->root_len;
	if (root_len == 0 || root_len >= SYNAPSE_IO_MAX_ROOT_LEN)
		return -1;
	if (path_len <= root_len)
		return -1;

	for (__u32 i = 0; i < SYNAPSE_IO_MAX_ROOT_LEN; i++) {
		if (i >= root_len)
			break;
		__u32 idx = i & (SYNAPSE_IO_PATH_BUF_LEN - 1);
		if (buf[idx] != (char)proc->root[i])
			return -1;
	}

	__u32 rest = root_len & (SYNAPSE_IO_PATH_BUF_LEN - 1);
	if (buf[rest] != '/')
		return -1;
	rest = (rest + 1) & (SYNAPSE_IO_PATH_BUF_LEN - 1);

	/* Observation's own output is excluded before anything else, so that the
	 * act of recording a measurement can never appear inside it. */
	if (segment_is(buf, rest, "metering/", 9))
		return SYNAPSE_IO_CAT_EXCLUDED;
	if (segment_is(buf, rest, "observation/", 12))
		return SYNAPSE_IO_CAT_EXCLUDED;
	if (segment_is(buf, rest, "envelopes/", 10))
		return SYNAPSE_IO_CAT_ENVELOPE;
	if (segment_is(buf, rest, "objects/", 8))
		return SYNAPSE_IO_CAT_CONTENT;
	if (segment_is(buf, rest, "memory/", 7))
		return SYNAPSE_IO_CAT_MEMORY_INDEX;
	if (segment_is(buf, rest, "supersessions/", 14))
		return SYNAPSE_IO_CAT_MEMORY_INDEX;
	if (segment_is(buf, rest, "namespace.json", 14))
		return SYNAPSE_IO_CAT_MEMORY_INDEX;
	return SYNAPSE_IO_CAT_UNCLASSIFIED;
}

/*
 * Resolves the registration for the current task, refusing a pid that no longer
 * belongs to the registered process. Without the start-time check a recycled pid
 * would silently inherit another run's attribution, which is worse than a gap.
 */
static __always_inline struct synapse_io_process *current_registration(__u32 tgid)
{
	struct synapse_io_process *proc = bpf_map_lookup_elem(&registered, &tgid);
	if (!proc)
		return 0;
	struct task_struct *task = bpf_get_current_task_btf();
	if (!task)
		return 0;
	/* Reduced to USER_HZ units so it compares equal to field 22 of
	 * /proc/<pid>/stat, which is the only form user space can read back. */
	__u64 start = BPF_CORE_READ(task, group_leader, start_boottime) / SYNAPSE_IO_NS_PER_USER_TICK;
	if (start != proc->start_ticks)
		return 0;
	return proc;
}

static __always_inline void note_open(struct file *file)
{
	__u32 tgid = bpf_get_current_pid_tgid() >> 32;
	struct synapse_io_process *proc = current_registration(tgid);
	if (!proc)
		return;

	__u32 zero = 0;
	char *buf = bpf_map_lookup_elem(&path_scratch, &zero);
	if (!buf)
		return;

	long len = bpf_d_path(&file->f_path, buf, SYNAPSE_IO_PATH_BUF_LEN);
	if (len <= 0) {
		/* A path that did not resolve or did not fit must not be guessed at.
		 * The file stays untracked and the incompleteness is reported. */
		bump(SYNAPSE_IO_COUNTER_CLASSIFY_INCOMPLETE);
		return;
	}

	int category = classify(buf, (__u32)len, proc);
	if (category < 0)
		return;

	struct synapse_io_file_key key = {};
	key.ino = BPF_CORE_READ(file, f_inode, i_ino);
	key.dev = BPF_CORE_READ(file, f_inode, i_sb, s_dev);
	__u32 value = (__u32)category;
	if (bpf_map_update_elem(&tracked_files, &key, &value, BPF_ANY) != 0)
		bump(SYNAPSE_IO_COUNTER_MAP_OVERFLOW);
}

SEC("fentry/security_file_open")
int BPF_PROG(synapse_file_open, struct file *file)
{
	note_open(file);
	return 0;
}

/*
 * Entry side. Only the outermost VFS call on a thread is timed: vfs_readv and
 * vfs_read are separate probes, and a nested call would otherwise be counted as
 * a second operation over the same bytes.
 */
static __always_inline void io_enter(void)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 tgid = (__u32)(tid >> 32);
	/* Cheapest possible rejection for the overwhelming majority of calls: every
	 * read and write on the machine passes through here, and an unregistered
	 * process must cost one hash lookup and nothing else. The full start-time
	 * check belongs on the exit path, where a measurement is about to be kept. */
	if (!bpf_map_lookup_elem(&registered, &tgid))
		return;

	struct synapse_io_inflight *existing = bpf_map_lookup_elem(&inflight, &tid);
	if (existing) {
		__sync_fetch_and_add(&existing->depth, 1);
		return;
	}
	struct synapse_io_inflight entry = {};
	entry.started_ns = bpf_ktime_get_ns();
	entry.depth = 0;
	if (bpf_map_update_elem(&inflight, &tid, &entry, BPF_NOEXIST) != 0)
		bump(SYNAPSE_IO_COUNTER_MAP_OVERFLOW);
}

static __always_inline __u32 latency_bucket(__u64 delta_ns)
{
	if (delta_ns == 0)
		return 0;
	__u32 bucket = 63 - __builtin_clzll(delta_ns);
	return bucket >= SYNAPSE_IO_HIST_BUCKETS ? SYNAPSE_IO_HIST_BUCKETS - 1 : bucket;
}

static __always_inline void io_exit(struct file *file, long ret, int is_write)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 tgid = (__u32)(tid >> 32);
	struct synapse_io_inflight *entry = bpf_map_lookup_elem(&inflight, &tid);
	if (!entry) {
		/* Only a registered process should have had an entry; for anyone else
		 * this return simply belongs to a call we never watched. */
		if (bpf_map_lookup_elem(&registered, &tgid))
			bump(SYNAPSE_IO_COUNTER_UNPAIRED_RETURN);
		return;
	}
	if (entry->depth > 0) {
		__sync_fetch_and_add(&entry->depth, -1);
		return;
	}
	__u64 started = entry->started_ns;
	bpf_map_delete_elem(&inflight, &tid);

	struct synapse_io_process *proc = current_registration(tgid);
	if (!proc)
		return;

	struct synapse_io_file_key key = {};
	key.ino = BPF_CORE_READ(file, f_inode, i_ino);
	key.dev = BPF_CORE_READ(file, f_inode, i_sb, s_dev);
	__u32 *category = bpf_map_lookup_elem(&tracked_files, &key);
	/* Not a file we saw opened under the storage root: out of scope, not a gap. */
	if (!category || *category == SYNAPSE_IO_CAT_EXCLUDED)
		return;

	struct synapse_io_stats_key stats_key = {};
	stats_key.tgid = tgid;
	stats_key.category = *category;
	struct synapse_io_stats *slot = bpf_map_lookup_elem(&stats, &stats_key);
	if (!slot) {
		struct synapse_io_stats fresh = {};
		if (bpf_map_update_elem(&stats, &stats_key, &fresh, BPF_NOEXIST) != 0) {
			bump(SYNAPSE_IO_COUNTER_MAP_OVERFLOW);
			return;
		}
		slot = bpf_map_lookup_elem(&stats, &stats_key);
		if (!slot)
			return;
	}

	__u64 now = bpf_ktime_get_ns();
	__u64 delta = now > started ? now - started : 0;
	__u32 bucket = latency_bucket(delta);

	if (ret < 0) {
		/* A failed operation moved no bytes but did cost time; counting its
		 * bytes as zero rather than dropping it keeps op counts honest. */
		__sync_fetch_and_add(&slot->failed_ops, 1);
		return;
	}

	if (is_write) {
		__sync_fetch_and_add(&slot->write_bytes, (__u64)ret);
		__sync_fetch_and_add(&slot->write_ops, 1);
		__sync_fetch_and_add(&slot->write_ns, delta);
		__sync_fetch_and_add(&slot->write_hist[bucket & (SYNAPSE_IO_HIST_BUCKETS - 1)], 1);
	} else {
		__sync_fetch_and_add(&slot->read_bytes, (__u64)ret);
		__sync_fetch_and_add(&slot->read_ops, 1);
		__sync_fetch_and_add(&slot->read_ns, delta);
		__sync_fetch_and_add(&slot->read_hist[bucket & (SYNAPSE_IO_HIST_BUCKETS - 1)], 1);
	}
}

SEC("fentry/vfs_read")
int BPF_PROG(synapse_vfs_read_enter, struct file *file)
{
	io_enter();
	return 0;
}

SEC("fexit/vfs_read")
int BPF_PROG(synapse_vfs_read_exit, struct file *file, char *buf, size_t count, loff_t *pos, ssize_t ret)
{
	io_exit(file, ret, 0);
	return 0;
}

SEC("fentry/vfs_write")
int BPF_PROG(synapse_vfs_write_enter, struct file *file)
{
	io_enter();
	return 0;
}

SEC("fexit/vfs_write")
int BPF_PROG(synapse_vfs_write_exit, struct file *file, const char *buf, size_t count, loff_t *pos, ssize_t ret)
{
	io_exit(file, ret, 1);
	return 0;
}

SEC("fentry/vfs_readv")
int BPF_PROG(synapse_vfs_readv_enter, struct file *file)
{
	io_enter();
	return 0;
}

SEC("fexit/vfs_readv")
int BPF_PROG(synapse_vfs_readv_exit, struct file *file, const struct iovec *vec, unsigned long vlen, loff_t *pos, rwf_t flags, ssize_t ret)
{
	io_exit(file, ret, 0);
	return 0;
}

SEC("fentry/vfs_writev")
int BPF_PROG(synapse_vfs_writev_enter, struct file *file)
{
	io_enter();
	return 0;
}

SEC("fexit/vfs_writev")
int BPF_PROG(synapse_vfs_writev_exit, struct file *file, const struct iovec *vec, unsigned long vlen, loff_t *pos, rwf_t flags, ssize_t ret)
{
	io_exit(file, ret, 1);
	return 0;
}

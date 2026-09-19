/*
 * Deterministic I/O workload for stage-one reconciliation.
 *
 * It performs a known number of bytes of file I/O against a SYNAPSE-shaped
 * directory tree and prints, as JSON, exactly what it did. Comparing that
 * ledger with the collector's snapshot is the only way to know the kernel
 * numbers mean what the documentation claims.
 *
 * The cases here are the ones that break naive accounting:
 *   - a short read at end of file, which returns fewer bytes than requested;
 *   - a read on a write-only descriptor, which returns an error and no bytes;
 *   - the same file read twice, which must count twice;
 *   - an atomic write through a temporary file and rename, where the rename
 *     itself must add no bytes;
 *   - writev, which the syscall-level probes must see as one operation;
 *   - two threads writing concurrently, which must sum rather than race.
 *
 * Usage: io-workload <storage-root>
 * The process prints its own pid and start ticks first, then waits for a line
 * on stdin, so the operator can register it with the collector before any I/O
 * happens. That wait is what makes the run's coverage complete rather than partial.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

#define CHUNK 4096

static char root[512];
static uint64_t expected_write_bytes;
static uint64_t expected_read_bytes;
static uint64_t expected_write_ops;
static uint64_t expected_read_ops;
static uint64_t expected_failed_ops;

static void die(const char *what)
{
	fprintf(stderr, "io-workload: %s: %s\n", what, strerror(errno));
	exit(1);
}

static void make_dir(const char *relative)
{
	char path[640];
	snprintf(path, sizeof(path), "%s/%s", root, relative);
	if (mkdir(path, 0700) != 0 && errno != EEXIST)
		die(path);
}

static void path_in(char *out, size_t out_len, const char *relative)
{
	snprintf(out, out_len, "%s/%s", root, relative);
}

static uint64_t read_start_ticks(void)
{
	FILE *file = fopen("/proc/self/stat", "r");
	if (!file)
		die("/proc/self/stat");
	char line[4096];
	if (!fgets(line, sizeof(line), file))
		die("/proc/self/stat");
	fclose(file);
	char *cursor = strrchr(line, ')');
	if (!cursor)
		die("/proc/self/stat");
	cursor++;
	for (int field = 3; field <= 22; field++) {
		while (*cursor == ' ')
			cursor++;
		if (field == 22)
			return strtoull(cursor, NULL, 10);
		while (*cursor && *cursor != ' ')
			cursor++;
	}
	die("/proc/self/stat");
	return 0;
}

/* Writes exactly `bytes`, counting one operation per write() that returns. */
static void write_exact(const char *relative, size_t bytes)
{
	char path[640];
	path_in(path, sizeof(path), relative);
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
		die(path);
	char buffer[CHUNK];
	memset(buffer, 'x', sizeof(buffer));
	size_t remaining = bytes;
	while (remaining > 0) {
		size_t want = remaining > CHUNK ? CHUNK : remaining;
		ssize_t wrote = write(fd, buffer, want);
		if (wrote <= 0)
			die(path);
		expected_write_bytes += (uint64_t)wrote;
		expected_write_ops++;
		remaining -= (size_t)wrote;
	}
	close(fd);
}

/* Reads to end of file; the final read is short and must be counted as short. */
static void read_all(const char *relative)
{
	char path[640];
	path_in(path, sizeof(path), relative);
	int fd = open(path, O_RDONLY);
	if (fd < 0)
		die(path);
	char buffer[CHUNK];
	for (;;) {
		ssize_t got = read(fd, buffer, sizeof(buffer));
		if (got < 0)
			die(path);
		if (got == 0)
			break; /* end of file returns zero: an operation that moved nothing */
		expected_read_bytes += (uint64_t)got;
		expected_read_ops++;
	}
	/* The zero-length final read is still a completed read operation. */
	expected_read_ops++;
	close(fd);
}

static void read_on_write_only(const char *relative)
{
	char path[640];
	path_in(path, sizeof(path), relative);
	int fd = open(path, O_WRONLY);
	if (fd < 0)
		die(path);
	char buffer[16];
	ssize_t got = read(fd, buffer, sizeof(buffer));
	if (got >= 0) {
		fprintf(stderr, "io-workload: expected a failed read, got %zd\n", got);
		exit(1);
	}
	expected_failed_ops++;
	close(fd);
}

static void atomic_write(const char *final_relative, const char *temp_relative, size_t bytes)
{
	char temp_path[640];
	char final_path[640];
	path_in(temp_path, sizeof(temp_path), temp_relative);
	path_in(final_path, sizeof(final_path), final_relative);
	write_exact(temp_relative, bytes);
	/* The rename moves no bytes. If the collector counts anything here, its
	 * accounting is following names rather than operations. */
	if (rename(temp_path, final_path) != 0)
		die(final_path);
}

static void write_vectored(const char *relative)
{
	char path[640];
	path_in(path, sizeof(path), relative);
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
		die(path);
	char first[100];
	char second[200];
	memset(first, 'a', sizeof(first));
	memset(second, 'b', sizeof(second));
	struct iovec vectors[2] = { { first, sizeof(first) }, { second, sizeof(second) } };
	ssize_t wrote = writev(fd, vectors, 2);
	if (wrote < 0)
		die(path);
	expected_write_bytes += (uint64_t)wrote;
	/* One vectored write is one operation, not one per vector. */
	expected_write_ops++;
	close(fd);
}

static pthread_mutex_t ledger_lock = PTHREAD_MUTEX_INITIALIZER;

static void *thread_writer(void *argument)
{
	const char *relative = (const char *)argument;
	char path[640];
	path_in(path, sizeof(path), relative);
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
		die(path);
	char buffer[512];
	memset(buffer, 'z', sizeof(buffer));
	for (int i = 0; i < 20; i++) {
		ssize_t wrote = write(fd, buffer, sizeof(buffer));
		if (wrote <= 0)
			die(path);
		pthread_mutex_lock(&ledger_lock);
		expected_write_bytes += (uint64_t)wrote;
		expected_write_ops++;
		pthread_mutex_unlock(&ledger_lock);
	}
	close(fd);
	return NULL;
}

int main(int argc, char **argv)
{
	if (argc != 2) {
		fprintf(stderr, "usage: io-workload <storage-root>\n");
		return 2;
	}
	snprintf(root, sizeof(root), "%s", argv[1]);
	if (mkdir(root, 0700) != 0 && errno != EEXIST)
		die(root);
	make_dir("envelopes");
	make_dir("envelopes/run-1");
	make_dir("objects");
	make_dir("memory");
	make_dir("metering");

	printf("{\"type\":\"ready\",\"pid\":%d,\"startTicks\":%" PRIu64 ",\"storageRoot\":\"%s\"}\n", (int)getpid(), read_start_ticks(), root);
	fflush(stdout);

	/* Registration must be in place before the first byte moves, otherwise the
	 * comparison below is measuring a partially observed run. */
	char go[64];
	if (!fgets(go, sizeof(go), stdin))
		return 1;

	write_exact("envelopes/run-1/child.json", 10000);
	read_all("envelopes/run-1/child.json");
	/* Twice: a repeated read is the pattern this whole collector exists to expose. */
	read_all("envelopes/run-1/child.json");
	read_on_write_only("envelopes/run-1/child.json");

	atomic_write("objects/blob.bin", "objects/blob.bin.tmp", 65536);
	read_all("objects/blob.bin");
	write_vectored("memory/index.json");

	/* Excluded by category: these bytes must not appear in any total. */
	write_exact("metering/run-1.jsonl", 4096);

	pthread_t first;
	pthread_t second;
	pthread_create(&first, NULL, thread_writer, (void *)"objects/thread-a.bin");
	pthread_create(&second, NULL, thread_writer, (void *)"objects/thread-b.bin");
	pthread_join(first, NULL);
	pthread_join(second, NULL);

	/* Subtract what the excluded write added to the local ledger: the ledger
	 * must describe what the collector is expected to report, not what the
	 * process happened to do. */
	expected_write_bytes -= 4096;
	expected_write_ops -= 1;

	printf("{\"type\":\"ledger\",\"expected\":{\"readBytes\":%" PRIu64 ",\"readOps\":%" PRIu64 ",\"writeBytes\":%" PRIu64 ",\"writeOps\":%" PRIu64 ",\"failedOps\":%" PRIu64 "}}\n",
		expected_read_bytes, expected_read_ops, expected_write_bytes, expected_write_ops, expected_failed_ops);
	fflush(stdout);
	return 0;
}

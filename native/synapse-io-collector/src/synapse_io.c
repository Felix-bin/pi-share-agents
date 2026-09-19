/*
 * SYNAPSE file I/O collector, user space side.
 *
 * Responsibilities, in order of importance:
 *   1. Refuse to start rather than start half-working. A missing BTF, an
 *      unattachable probe or an unsupported architecture produces a specific
 *      reason on stderr and a non-zero exit, never a silent zero-metric run.
 *   2. Serve a local Unix socket whose peers are authenticated by kernel
 *      credentials, not by anything the peer tells us.
 *   3. Push a cumulative snapshot on a fixed interval. Cumulative plus a
 *      sequence number is what lets a client that missed snapshots recover
 *      without double counting.
 *
 * This process is started and stopped by an administrator. It never spawns,
 * signals or waits on the agent processes it observes.
 */

#define _GNU_SOURCE

#include <bpf/libbpf.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/timerfd.h>
#include <sys/un.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#include "protocol.h"
#include "synapse_io.skel.h"

#define MAX_LINE (64 * 1024)
#define MAX_CLIENTS 64
#define MAX_REGISTRATIONS SYNAPSE_IO_MAX_PROCESSES
#define MAX_ALLOWED_UIDS 16
#define DEFAULT_INTERVAL_MS 1000

static volatile sig_atomic_t stop_requested = 0;

static const char *const CATEGORY_NAMES[SYNAPSE_IO_CAT__COUNT] = {
	"excluded", "envelope", "content", "memoryIndex", "unclassified",
};

struct client {
	int fd;
	uid_t uid;
	pid_t pid;
	int greeted;
	size_t pending;
	char buffer[MAX_LINE];
};

struct registration {
	int in_use;
	int client_index;
	char id[40];
	char run_id[128];
	char node_id[128];
	pid_t pid;
	uint64_t start_ticks;
	uint64_t observed_from_ms;
	char root[SYNAPSE_IO_MAX_ROOT_LEN];
};

struct collector {
	struct synapse_io_bpf *skel;
	int listen_fd;
	int timer_fd;
	int epoll_fd;
	uint64_t sequence;
	char instance[40];
	struct client clients[MAX_CLIENTS];
	struct registration registrations[MAX_REGISTRATIONS];
};

static void on_signal(int signo)
{
	(void)signo;
	stop_requested = 1;
}

static uint64_t now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
}

static void fail(const char *fmt, ...)
{
	va_list args;
	va_start(args, fmt);
	fprintf(stderr, "synapse-io-collector: ");
	vfprintf(stderr, fmt, args);
	fprintf(stderr, "\n");
	va_end(args);
}

/* ------------------------------------------------------------------ JSON */

/*
 * A deliberately small reader for the flat, single-line messages the client
 * sends. Client messages have no nested objects and no escape sequences by
 * contract; anything else is rejected at this boundary instead of being
 * partially understood.
 */
static int json_find(const char *line, const char *key, const char **out)
{
	char needle[64];
	int written = snprintf(needle, sizeof(needle), "\"%s\":", key);
	if (written <= 0 || (size_t)written >= sizeof(needle))
		return -1;
	const char *found = strstr(line, needle);
	if (!found)
		return -1;
	found += written;
	while (*found == ' ')
		found++;
	*out = found;
	return 0;
}

static int json_string(const char *line, const char *key, char *out, size_t out_len)
{
	const char *cursor = NULL;
	if (json_find(line, key, &cursor) != 0 || *cursor != '"')
		return -1;
	cursor++;
	size_t i = 0;
	while (*cursor && *cursor != '"') {
		/* Escapes are not part of the contract: a backslash means the sender is
		 * speaking a dialect we did not agree on. */
		if (*cursor == '\\')
			return -1;
		if (i + 1 >= out_len)
			return -1;
		out[i++] = *cursor++;
	}
	if (*cursor != '"')
		return -1;
	out[i] = '\0';
	return 0;
}

static int json_u64(const char *line, const char *key, uint64_t *out)
{
	const char *cursor = NULL;
	if (json_find(line, key, &cursor) != 0)
		return -1;
	if (!isdigit((unsigned char)*cursor))
		return -1;
	errno = 0;
	char *end = NULL;
	unsigned long long value = strtoull(cursor, &end, 10);
	if (errno != 0 || end == cursor)
		return -1;
	*out = (uint64_t)value;
	return 0;
}

/* Escapes only what a path or identifier can legitimately contain. */
static void json_write_string(FILE *out, const char *value)
{
	fputc('"', out);
	for (const char *cursor = value; *cursor; cursor++) {
		unsigned char ch = (unsigned char)*cursor;
		if (ch == '"' || ch == '\\')
			fprintf(out, "\\%c", ch);
		else if (ch < 0x20)
			fprintf(out, "\\u%04x", ch);
		else
			fputc(ch, out);
	}
	fputc('"', out);
}

/* --------------------------------------------------------------- /proc */

/* Field 22 of /proc/<pid>/stat, in USER_HZ units. The comm field can contain
 * spaces and parentheses, so parsing restarts after the final ')'. */
static int read_start_ticks(pid_t pid, uint64_t *out)
{
	char path[64];
	snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
	FILE *file = fopen(path, "r");
	if (!file)
		return -1;
	char line[4096];
	if (!fgets(line, sizeof(line), file)) {
		fclose(file);
		return -1;
	}
	fclose(file);
	char *cursor = strrchr(line, ')');
	if (!cursor)
		return -1;
	cursor++;
	for (int field = 3; field <= 22; field++) {
		while (*cursor == ' ')
			cursor++;
		if (*cursor == '\0')
			return -1;
		if (field == 22) {
			*out = strtoull(cursor, NULL, 10);
			return 0;
		}
		while (*cursor && *cursor != ' ')
			cursor++;
	}
	return -1;
}

static int read_process_uid(pid_t pid, uid_t *out)
{
	char path[64];
	snprintf(path, sizeof(path), "/proc/%d/status", (int)pid);
	FILE *file = fopen(path, "r");
	if (!file)
		return -1;
	char line[512];
	int found = -1;
	while (fgets(line, sizeof(line), file)) {
		if (strncmp(line, "Uid:", 4) != 0)
			continue;
		unsigned int real = 0;
		if (sscanf(line + 4, "%u", &real) == 1) {
			*out = (uid_t)real;
			found = 0;
		}
		break;
	}
	fclose(file);
	return found;
}

static int process_alive(pid_t pid, uint64_t expected_ticks)
{
	uint64_t ticks = 0;
	if (read_start_ticks(pid, &ticks) != 0)
		return 0;
	return ticks == expected_ticks;
}

/* ------------------------------------------------------- capability check */

struct capability_report {
	int arch_supported;
	int btf_present;
	char kernel[128];
	char machine[64];
};

static void probe_capabilities(struct capability_report *report)
{
	memset(report, 0, sizeof(*report));
	struct utsname info;
	if (uname(&info) == 0) {
		snprintf(report->kernel, sizeof(report->kernel), "%s", info.release);
		snprintf(report->machine, sizeof(report->machine), "%s", info.machine);
		report->arch_supported = strcmp(info.machine, "x86_64") == 0;
	}
	report->btf_present = access("/sys/kernel/btf/vmlinux", R_OK) == 0;
}

static void print_capabilities(const struct capability_report *report, const char *load_error)
{
	printf("{\"type\":\"capabilities\",\"protocol\":\"%s\",\"abiVersion\":%d,", SYNAPSE_IO_WIRE_PROTOCOL, SYNAPSE_IO_ABI_VERSION);
	printf("\"kernel\":");
	json_write_string(stdout, report->kernel);
	printf(",\"machine\":");
	json_write_string(stdout, report->machine);
	printf(",\"archSupported\":%s,\"btfPresent\":%s,", report->arch_supported ? "true" : "false", report->btf_present ? "true" : "false");
	printf("\"probesLoadable\":%s", load_error == NULL ? "true" : "false");
	if (load_error) {
		printf(",\"reason\":");
		json_write_string(stdout, load_error);
	}
	printf("}\n");
}

/* ------------------------------------------------------------- BPF maps */

static int register_in_kernel(struct collector *collector, const struct registration *reg)
{
	struct synapse_io_process value;
	memset(&value, 0, sizeof(value));
	value.start_ticks = reg->start_ticks;
	value.registered_at_ns = 0;
	size_t root_len = strlen(reg->root);
	if (root_len >= SYNAPSE_IO_MAX_ROOT_LEN)
		return -1;
	memcpy(value.root, reg->root, root_len);
	value.root_len = (uint32_t)root_len;
	uint32_t key = (uint32_t)reg->pid;
	return bpf_map__update_elem(collector->skel->maps.registered, &key, sizeof(key), &value, sizeof(value), BPF_ANY);
}

static void unregister_in_kernel(struct collector *collector, pid_t pid)
{
	uint32_t key = (uint32_t)pid;
	bpf_map__delete_elem(collector->skel->maps.registered, &key, sizeof(key), 0);
	for (uint32_t category = 0; category < SYNAPSE_IO_CAT__COUNT; category++) {
		struct synapse_io_stats_key stats_key = { .tgid = key, .category = category };
		bpf_map__delete_elem(collector->skel->maps.stats, &stats_key, sizeof(stats_key), 0);
	}
}

static void read_counters(struct collector *collector, uint64_t out[SYNAPSE_IO_COUNTER__COUNT])
{
	for (uint32_t i = 0; i < SYNAPSE_IO_COUNTER__COUNT; i++) {
		uint64_t value = 0;
		if (bpf_map__lookup_elem(collector->skel->maps.counters, &i, sizeof(i), &value, sizeof(value), 0) != 0)
			value = 0;
		out[i] = value;
	}
}

/* ------------------------------------------------------------- snapshot */

static void write_histogram(FILE *out, const char *name, const uint64_t *buckets)
{
	/* Sparse pairs: a snapshot carrying 64 mostly-zero numbers per category per
	 * process would dominate the line for no information. */
	fprintf(out, "\"%s\":[", name);
	int first = 1;
	for (uint32_t i = 0; i < SYNAPSE_IO_HIST_BUCKETS; i++) {
		if (buckets[i] == 0)
			continue;
		fprintf(out, "%s[%u,%" PRIu64 "]", first ? "" : ",", i, buckets[i]);
		first = 0;
	}
	fprintf(out, "]");
}

static void write_category(FILE *out, const char *name, const struct synapse_io_stats *stats)
{
	fprintf(out, "\"%s\":{", name);
	fprintf(out, "\"failedOps\":%" PRIu64 ",", stats->failed_ops);
	fprintf(out, "\"readBytes\":%" PRIu64 ",", stats->read_bytes);
	fprintf(out, "\"readNs\":%" PRIu64 ",", stats->read_ns);
	fprintf(out, "\"readOps\":%" PRIu64 ",", stats->read_ops);
	fprintf(out, "\"writeBytes\":%" PRIu64 ",", stats->write_bytes);
	fprintf(out, "\"writeNs\":%" PRIu64 ",", stats->write_ns);
	fprintf(out, "\"writeOps\":%" PRIu64 ",", stats->write_ops);
	write_histogram(out, "readHist", stats->read_hist);
	fprintf(out, ",");
	write_histogram(out, "writeHist", stats->write_hist);
	fprintf(out, "}");
}

static int count_registrations_for_pid(const struct collector *collector, pid_t pid)
{
	int count = 0;
	for (int i = 0; i < MAX_REGISTRATIONS; i++) {
		if (collector->registrations[i].in_use && collector->registrations[i].pid == pid)
			count++;
	}
	return count;
}

static int send_line(struct collector *collector, int client_index, const char *line, size_t length);

static void emit_snapshot(struct collector *collector)
{
	char *body = NULL;
	size_t body_len = 0;
	FILE *out = open_memstream(&body, &body_len);
	if (!out)
		return;

	uint64_t counters[SYNAPSE_IO_COUNTER__COUNT];
	read_counters(collector, counters);
	collector->sequence++;

	fprintf(out, "{\"type\":\"snapshot\",\"protocol\":\"%s\",", SYNAPSE_IO_WIRE_PROTOCOL);
	fprintf(out, "\"collectorInstance\":");
	json_write_string(out, collector->instance);
	fprintf(out, ",\"sequence\":%" PRIu64 ",\"emittedAtMs\":%" PRIu64 ",", collector->sequence, now_ms());
	fprintf(out, "\"quality\":{\"classifyIncomplete\":%" PRIu64 ",\"mapOverflows\":%" PRIu64 ",\"unpairedReturns\":%" PRIu64 "},",
		counters[SYNAPSE_IO_COUNTER_CLASSIFY_INCOMPLETE], counters[SYNAPSE_IO_COUNTER_MAP_OVERFLOW], counters[SYNAPSE_IO_COUNTER_UNPAIRED_RETURN]);
	fprintf(out, "\"processes\":[");

	int first = 1;
	for (int i = 0; i < MAX_REGISTRATIONS; i++) {
		struct registration *reg = &collector->registrations[i];
		if (!reg->in_use)
			continue;
		int alive = process_alive(reg->pid, reg->start_ticks);
		int shared = count_registrations_for_pid(collector, reg->pid) > 1;

		fprintf(out, "%s{", first ? "" : ",");
		first = 0;
		fprintf(out, "\"registrationId\":");
		json_write_string(out, reg->id);
		fprintf(out, ",\"runId\":");
		json_write_string(out, reg->run_id);
		fprintf(out, ",\"nodeId\":");
		json_write_string(out, reg->node_id);
		fprintf(out, ",\"pid\":%d,\"startTicks\":%" PRIu64 ",", (int)reg->pid, reg->start_ticks);
		fprintf(out, "\"observedFromMs\":%" PRIu64 ",", reg->observed_from_ms);
		fprintf(out, "\"exited\":%s,", alive ? "false" : "true");
		/* A pid several runs registered cannot be split between them, so it is
		 * reported once as shared rather than divided by a guess. */
		fprintf(out, "\"attribution\":\"%s\",", shared ? "shared" : "exclusive");
		fprintf(out, "\"categories\":{");
		for (uint32_t category = SYNAPSE_IO_CAT_ENVELOPE; category < SYNAPSE_IO_CAT__COUNT; category++) {
			struct synapse_io_stats stats;
			memset(&stats, 0, sizeof(stats));
			struct synapse_io_stats_key key = { .tgid = (uint32_t)reg->pid, .category = category };
			if (bpf_map__lookup_elem(collector->skel->maps.stats, &key, sizeof(key), &stats, sizeof(stats), 0) != 0)
				memset(&stats, 0, sizeof(stats));
			if (category != SYNAPSE_IO_CAT_ENVELOPE)
				fprintf(out, ",");
			write_category(out, CATEGORY_NAMES[category], &stats);
		}
		fprintf(out, "}}");
	}
	fprintf(out, "]}\n");
	fclose(out);

	for (int i = 0; i < MAX_CLIENTS; i++) {
		if (collector->clients[i].fd >= 0 && collector->clients[i].greeted)
			send_line(collector, i, body, body_len);
	}
	free(body);
}

/* --------------------------------------------------------------- socket */

static int send_line(struct collector *collector, int client_index, const char *line, size_t length)
{
	struct client *client = &collector->clients[client_index];
	size_t sent = 0;
	while (sent < length) {
		ssize_t written = send(client->fd, line + sent, length - sent, MSG_NOSIGNAL | MSG_DONTWAIT);
		if (written > 0) {
			sent += (size_t)written;
			continue;
		}
		if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
			/* A client that cannot keep up is disconnected rather than allowed
			 * to make this process grow a queue. It will reconnect and resync
			 * from the cumulative counters. */
			return -1;
		}
		if (written < 0 && errno == EINTR)
			continue;
		return -1;
	}
	return 0;
}

static void send_error(struct collector *collector, int client_index, const char *request_id, const char *code, const char *message)
{
	char line[1024];
	int length = snprintf(line, sizeof(line), "{\"type\":\"error\",\"requestId\":\"%s\",\"code\":\"%s\",\"message\":\"%s\"}\n", request_id, code, message);
	if (length > 0 && (size_t)length < sizeof(line))
		send_line(collector, client_index, line, (size_t)length);
}

static void drop_client(struct collector *collector, int client_index)
{
	struct client *client = &collector->clients[client_index];
	if (client->fd < 0)
		return;
	for (int i = 0; i < MAX_REGISTRATIONS; i++) {
		struct registration *reg = &collector->registrations[i];
		if (!reg->in_use || reg->client_index != client_index)
			continue;
		unregister_in_kernel(collector, reg->pid);
		memset(reg, 0, sizeof(*reg));
	}
	epoll_ctl(collector->epoll_fd, EPOLL_CTL_DEL, client->fd, NULL);
	close(client->fd);
	client->fd = -1;
	client->pending = 0;
	client->greeted = 0;
}

static void handle_hello(struct collector *collector, int client_index, const char *line)
{
	char protocol[64] = "";
	if (json_string(line, "protocol", protocol, sizeof(protocol)) != 0 || strcmp(protocol, SYNAPSE_IO_WIRE_PROTOCOL) != 0) {
		send_error(collector, client_index, "", "protocol-mismatch", "unsupported protocol version");
		drop_client(collector, client_index);
		return;
	}
	collector->clients[client_index].greeted = 1;

	char reply[512];
	int length = snprintf(reply, sizeof(reply),
		"{\"type\":\"welcome\",\"protocol\":\"%s\",\"abiVersion\":%d,\"collectorInstance\":\"%s\",\"snapshotIntervalMs\":%d,"
		"\"coverage\":[\"vfs_read\",\"vfs_write\",\"vfs_readv\",\"vfs_writev\"],\"excluded\":[\"mmap\",\"io_uring\",\"splice\"]}\n",
		SYNAPSE_IO_WIRE_PROTOCOL, SYNAPSE_IO_ABI_VERSION, collector->instance, DEFAULT_INTERVAL_MS);
	if (length > 0 && (size_t)length < sizeof(reply))
		send_line(collector, client_index, reply, (size_t)length);
}

static void handle_register(struct collector *collector, int client_index, const char *line)
{
	struct client *client = &collector->clients[client_index];
	char request_id[64] = "";
	json_string(line, "requestId", request_id, sizeof(request_id));

	uint64_t pid_value = 0;
	if (json_u64(line, "pid", &pid_value) != 0 || pid_value == 0 || pid_value > 0x7fffffffull) {
		send_error(collector, client_index, request_id, "bad-request", "pid is required");
		return;
	}
	pid_t pid = (pid_t)pid_value;

	uid_t owner = 0;
	if (read_process_uid(pid, &owner) != 0) {
		send_error(collector, client_index, request_id, "no-such-process", "process not found");
		return;
	}
	/* The peer may only register processes it owns. Kernel credentials decide
	 * this, not anything in the message. */
	if (owner != client->uid) {
		send_error(collector, client_index, request_id, "forbidden", "process belongs to another user");
		return;
	}

	uint64_t start_ticks = 0;
	if (read_start_ticks(pid, &start_ticks) != 0) {
		send_error(collector, client_index, request_id, "no-such-process", "process start time unreadable");
		return;
	}
	uint64_t claimed = 0;
	if (json_u64(line, "startTicks", &claimed) == 0 && claimed != start_ticks) {
		/* The client is describing a process that has already been replaced. */
		send_error(collector, client_index, request_id, "stale-identity", "process start time does not match");
		return;
	}

	struct registration candidate;
	memset(&candidate, 0, sizeof(candidate));
	if (json_string(line, "storageRoot", candidate.root, sizeof(candidate.root)) != 0 || candidate.root[0] != '/') {
		send_error(collector, client_index, request_id, "bad-request", "storageRoot must be an absolute path");
		return;
	}
	size_t root_len = strlen(candidate.root);
	while (root_len > 1 && candidate.root[root_len - 1] == '/')
		candidate.root[--root_len] = '\0';

	if (json_string(line, "runId", candidate.run_id, sizeof(candidate.run_id)) != 0
		|| json_string(line, "nodeId", candidate.node_id, sizeof(candidate.node_id)) != 0) {
		send_error(collector, client_index, request_id, "bad-request", "runId and nodeId are required");
		return;
	}

	int slot = -1;
	for (int i = 0; i < MAX_REGISTRATIONS; i++) {
		if (!collector->registrations[i].in_use) {
			slot = i;
			break;
		}
	}
	if (slot < 0) {
		send_error(collector, client_index, request_id, "capacity", "registration table is full");
		return;
	}

	candidate.in_use = 1;
	candidate.client_index = client_index;
	candidate.pid = pid;
	candidate.start_ticks = start_ticks;
	candidate.observed_from_ms = now_ms();
	snprintf(candidate.id, sizeof(candidate.id), "%s-%d-%" PRIu64, collector->instance, (int)pid, start_ticks);
	collector->registrations[slot] = candidate;

	if (register_in_kernel(collector, &candidate) != 0) {
		memset(&collector->registrations[slot], 0, sizeof(struct registration));
		send_error(collector, client_index, request_id, "capacity", "kernel registration table is full");
		return;
	}

	char reply[512];
	int length = snprintf(reply, sizeof(reply),
		"{\"type\":\"registered\",\"requestId\":\"%s\",\"registrationId\":\"%s\",\"observedFromMs\":%" PRIu64 ",\"collectorInstance\":\"%s\"}\n",
		request_id, candidate.id, candidate.observed_from_ms, collector->instance);
	if (length > 0 && (size_t)length < sizeof(reply))
		send_line(collector, client_index, reply, (size_t)length);
}

static void handle_unregister(struct collector *collector, int client_index, const char *line)
{
	char request_id[64] = "";
	char registration_id[40] = "";
	json_string(line, "requestId", request_id, sizeof(request_id));
	if (json_string(line, "registrationId", registration_id, sizeof(registration_id)) != 0) {
		send_error(collector, client_index, request_id, "bad-request", "registrationId is required");
		return;
	}
	for (int i = 0; i < MAX_REGISTRATIONS; i++) {
		struct registration *reg = &collector->registrations[i];
		if (!reg->in_use || reg->client_index != client_index || strcmp(reg->id, registration_id) != 0)
			continue;
		/* Only the last holder of a shared pid removes it from the kernel. */
		if (count_registrations_for_pid(collector, reg->pid) == 1)
			unregister_in_kernel(collector, reg->pid);
		memset(reg, 0, sizeof(*reg));
		break;
	}
	char reply[256];
	int length = snprintf(reply, sizeof(reply), "{\"type\":\"unregistered\",\"requestId\":\"%s\",\"registrationId\":\"%s\"}\n", request_id, registration_id);
	if (length > 0 && (size_t)length < sizeof(reply))
		send_line(collector, client_index, reply, (size_t)length);
}

static void handle_line(struct collector *collector, int client_index, char *line)
{
	char type[32] = "";
	if (json_string(line, "type", type, sizeof(type)) != 0) {
		send_error(collector, client_index, "", "bad-request", "type is required");
		return;
	}
	if (strcmp(type, "hello") == 0) {
		handle_hello(collector, client_index, line);
		return;
	}
	if (!collector->clients[client_index].greeted) {
		send_error(collector, client_index, "", "not-greeted", "send hello first");
		return;
	}
	if (strcmp(type, "register") == 0)
		handle_register(collector, client_index, line);
	else if (strcmp(type, "unregister") == 0)
		handle_unregister(collector, client_index, line);
	else
		send_error(collector, client_index, "", "bad-request", "unknown message type");
}

static void read_client(struct collector *collector, int client_index)
{
	struct client *client = &collector->clients[client_index];
	for (;;) {
		ssize_t got = recv(client->fd, client->buffer + client->pending, sizeof(client->buffer) - client->pending, MSG_DONTWAIT);
		if (got == 0) {
			drop_client(collector, client_index);
			return;
		}
		if (got < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				return;
			drop_client(collector, client_index);
			return;
		}
		client->pending += (size_t)got;

		for (;;) {
			char *newline = memchr(client->buffer, '\n', client->pending);
			if (!newline)
				break;
			*newline = '\0';
			handle_line(collector, client_index, client->buffer);
			if (client->fd < 0)
				return;
			size_t consumed = (size_t)(newline - client->buffer) + 1;
			memmove(client->buffer, client->buffer + consumed, client->pending - consumed);
			client->pending -= consumed;
		}
		if (client->pending == sizeof(client->buffer)) {
			/* A line longer than the cap is a protocol violation, not a large
			 * legitimate message: every defined message fits in a few hundred bytes. */
			send_error(collector, client_index, "", "line-too-long", "message exceeds the line limit");
			drop_client(collector, client_index);
			return;
		}
	}
}

static void accept_client(struct collector *collector, const uid_t *allowed, int allowed_count)
{
	for (;;) {
		int fd = accept4(collector->listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
		if (fd < 0)
			return;

		struct ucred credentials;
		socklen_t length = sizeof(credentials);
		if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
			close(fd);
			continue;
		}
		int permitted = 0;
		for (int i = 0; i < allowed_count; i++) {
			if (allowed[i] == credentials.uid)
				permitted = 1;
		}
		if (!permitted) {
			close(fd);
			continue;
		}

		int slot = -1;
		for (int i = 0; i < MAX_CLIENTS; i++) {
			if (collector->clients[i].fd < 0) {
				slot = i;
				break;
			}
		}
		if (slot < 0) {
			close(fd);
			continue;
		}
		collector->clients[slot].fd = fd;
		collector->clients[slot].uid = credentials.uid;
		collector->clients[slot].pid = credentials.pid;
		collector->clients[slot].greeted = 0;
		collector->clients[slot].pending = 0;

		struct epoll_event event = { .events = EPOLLIN, .data = { .u32 = (uint32_t)(1000 + slot) } };
		if (epoll_ctl(collector->epoll_fd, EPOLL_CTL_ADD, fd, &event) != 0) {
			close(fd);
			collector->clients[slot].fd = -1;
		}
	}
}

static int listen_on(const char *socket_path)
{
	struct sockaddr_un address;
	if (strlen(socket_path) >= sizeof(address.sun_path)) {
		fail("socket path is too long: %s", socket_path);
		return -1;
	}
	unlink(socket_path);

	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (fd < 0) {
		fail("socket: %s", strerror(errno));
		return -1;
	}
	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;
	snprintf(address.sun_path, sizeof(address.sun_path), "%s", socket_path);

	/* Created with no group or world access, then relaxed to the owning user
	 * only. Directory permissions are the administrator's job and are checked
	 * in the install instructions, not assumed here. */
	mode_t previous = umask(0177);
	int bound = bind(fd, (struct sockaddr *)&address, sizeof(address));
	umask(previous);
	if (bound != 0) {
		fail("bind %s: %s", socket_path, strerror(errno));
		close(fd);
		return -1;
	}
	if (listen(fd, 16) != 0) {
		fail("listen: %s", strerror(errno));
		close(fd);
		return -1;
	}
	return fd;
}

/* ------------------------------------------------------------------ main */

static void usage(void)
{
	fprintf(stderr,
		"usage: synapse-io-collector --socket PATH [--allow-uid UID]... [--interval-ms N]\n"
		"       synapse-io-collector --check\n");
}

static int libbpf_quiet(enum libbpf_print_level level, const char *format, va_list args)
{
	if (level == LIBBPF_PRINT_DEBUG)
		return 0;
	return vfprintf(stderr, format, args);
}

int main(int argc, char **argv)
{
	const char *socket_path = NULL;
	uid_t allowed[MAX_ALLOWED_UIDS];
	int allowed_count = 0;
	int interval_ms = DEFAULT_INTERVAL_MS;
	int check_only = 0;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--check") == 0) {
			check_only = 1;
		} else if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) {
			socket_path = argv[++i];
		} else if (strcmp(argv[i], "--allow-uid") == 0 && i + 1 < argc) {
			if (allowed_count >= MAX_ALLOWED_UIDS) {
				fail("too many --allow-uid values");
				return 2;
			}
			allowed[allowed_count++] = (uid_t)strtoul(argv[++i], NULL, 10);
		} else if (strcmp(argv[i], "--interval-ms") == 0 && i + 1 < argc) {
			interval_ms = atoi(argv[++i]);
			if (interval_ms < 100 || interval_ms > 10000) {
				fail("--interval-ms must be between 100 and 10000");
				return 2;
			}
		} else {
			usage();
			return 2;
		}
	}

	struct capability_report report;
	probe_capabilities(&report);

	if (!check_only && (socket_path == NULL || allowed_count == 0)) {
		usage();
		return 2;
	}

	libbpf_set_print(libbpf_quiet);

	if (!report.btf_present) {
		const char *reason = "/sys/kernel/btf/vmlinux is missing: this kernel was built without BTF, so CO-RE relocation cannot run";
		if (check_only) {
			print_capabilities(&report, reason);
			return 0;
		}
		fail("%s", reason);
		return 3;
	}
	if (!report.arch_supported) {
		char reason[256];
		snprintf(reason, sizeof(reason), "fentry/fexit probes need a BPF trampoline; %s is not a validated target for this build", report.machine);
		if (check_only) {
			print_capabilities(&report, reason);
			return 0;
		}
		fail("%s", reason);
		return 3;
	}

	struct synapse_io_bpf *skel = synapse_io_bpf__open_and_load();
	if (!skel) {
		char reason[256];
		snprintf(reason, sizeof(reason), "loading the BPF object failed (%s); check CAP_BPF/CAP_PERFMON and that vfs_read/vfs_write are traceable", strerror(errno));
		if (check_only) {
			print_capabilities(&report, reason);
			return 0;
		}
		fail("%s", reason);
		return 3;
	}
	if (synapse_io_bpf__attach(skel) != 0) {
		char reason[256];
		snprintf(reason, sizeof(reason), "attaching probes failed (%s); security_file_open must be an attachable fentry target", strerror(errno));
		synapse_io_bpf__destroy(skel);
		if (check_only) {
			print_capabilities(&report, reason);
			return 0;
		}
		fail("%s", reason);
		return 3;
	}

	if (check_only) {
		print_capabilities(&report, NULL);
		synapse_io_bpf__destroy(skel);
		return 0;
	}

	struct collector *collector = calloc(1, sizeof(*collector));
	if (!collector) {
		synapse_io_bpf__destroy(skel);
		fail("out of memory");
		return 1;
	}
	collector->skel = skel;
	for (int i = 0; i < MAX_CLIENTS; i++)
		collector->clients[i].fd = -1;
	snprintf(collector->instance, sizeof(collector->instance), "%d-%" PRIu64, (int)getpid(), now_ms());

	collector->listen_fd = listen_on(socket_path);
	if (collector->listen_fd < 0) {
		synapse_io_bpf__destroy(skel);
		free(collector);
		return 4;
	}

	collector->epoll_fd = epoll_create1(EPOLL_CLOEXEC);
	collector->timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	struct itimerspec interval = {
		.it_interval = { .tv_sec = interval_ms / 1000, .tv_nsec = (long)(interval_ms % 1000) * 1000000L },
		.it_value = { .tv_sec = interval_ms / 1000, .tv_nsec = (long)(interval_ms % 1000) * 1000000L },
	};
	timerfd_settime(collector->timer_fd, 0, &interval, NULL);

	struct epoll_event listen_event = { .events = EPOLLIN, .data = { .u32 = 1 } };
	struct epoll_event timer_event = { .events = EPOLLIN, .data = { .u32 = 2 } };
	epoll_ctl(collector->epoll_fd, EPOLL_CTL_ADD, collector->listen_fd, &listen_event);
	epoll_ctl(collector->epoll_fd, EPOLL_CTL_ADD, collector->timer_fd, &timer_event);

	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	signal(SIGPIPE, SIG_IGN);

	fprintf(stderr, "synapse-io-collector: listening on %s (instance %s)\n", socket_path, collector->instance);

	while (!stop_requested) {
		struct epoll_event events[MAX_CLIENTS + 2];
		int ready = epoll_wait(collector->epoll_fd, events, MAX_CLIENTS + 2, 1000);
		if (ready < 0) {
			if (errno == EINTR)
				continue;
			break;
		}
		for (int i = 0; i < ready; i++) {
			uint32_t tag = events[i].data.u32;
			if (tag == 1) {
				accept_client(collector, allowed, allowed_count);
			} else if (tag == 2) {
				uint64_t ticks = 0;
				if (read(collector->timer_fd, &ticks, sizeof(ticks)) == sizeof(ticks))
					emit_snapshot(collector);
			} else if (tag >= 1000) {
				read_client(collector, (int)(tag - 1000));
			}
		}
	}

	for (int i = 0; i < MAX_CLIENTS; i++)
		drop_client(collector, i);
	close(collector->timer_fd);
	close(collector->epoll_fd);
	close(collector->listen_fd);
	unlink(socket_path);
	synapse_io_bpf__destroy(skel);
	free(collector);
	return 0;
}

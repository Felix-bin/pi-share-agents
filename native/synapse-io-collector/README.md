# synapse-io-collector

An eBPF CO-RE collector that measures the file I/O SYNAPSE agents perform against their
shared storage root, and publishes it over a local socket.

**Status: unverified.** The code here has not been compiled or run on a real kernel yet.
Until `make check` and the stage-one reconciliation in
[`../../docs/system-observation-plan.md`](../../docs/system-observation-plan.md) pass on
x86_64 Linux 6.6, treat every number it produces as unproven.

## Why it is a separate binary

`npm install` for the extension must never compile native code, and the extension itself
must never hold `CAP_BPF`. So the collector is built and installed by an administrator,
runs as its own process, and the Pi session is an unprivileged client that can only ask
for measurements about processes it already owns.

Killing the collector does not affect any agent. Nothing in the agent path waits on it.

## Requirements

- x86_64 Linux with BTF (`/sys/kernel/btf/vmlinux` present). Kernel 6.6 is the validated target.
- `clang` 12+, `bpftool`, `libbpf` development headers, `libelf`, `zlib`.
- `CAP_BPF` and `CAP_PERFMON` (or root) to load and attach.

`fentry`/`fexit` probes need a BPF trampoline, which is why the build refuses
architectures it has not been validated on rather than attaching something different and
reporting the result under the same name.

## Build and check

```sh
make                 # builds build/synapse-io-collector
make check           # prints a JSON capability report and exits
make workload        # builds the deterministic reconciliation program
```

`make check` never stays resident. It answers one question — can this machine run the
collector, and if not, exactly why — so that a missing kernel feature produces a specific
message instead of a run full of zeros.

## Run

```sh
sudo install -d -m 0700 -o "$USER" /run/synapse-io
sudo ./build/synapse-io-collector --socket /run/synapse-io/collector.sock --allow-uid "$(id -u)"
```

- `--allow-uid` may be repeated. Only those uids may connect, and a client may only
  register processes it owns; both checks use kernel credentials (`SO_PEERCRED`,
  `/proc/<pid>/status`), never anything the client claims.
- `--interval-ms` sets the snapshot cadence (default 1000, range 100–10000).
- The socket is created with mode 0600. The containing directory's permissions are the
  administrator's responsibility.

Then point the extension at it:

```json
{ "systemObservation": { "enabled": true, "socketPath": "/run/synapse-io/collector.sock" } }
```

## What it measures

Per registered process, per category, cumulative since registration:

| Quantity | Definition |
|---|---|
| read/write bytes | what the VFS call actually returned, so a short read contributes what it moved |
| operations | completed `vfs_read` / `vfs_write` / `vfs_readv` / `vfs_writev` calls |
| failed operations | calls that returned a negative value; they contribute no bytes |
| duration | entry to return of the outermost VFS call on the thread |
| latency histogram | 32 log2 nanosecond buckets, from which the client derives a bounded P95 |

Categories come from the path at open time, relative to the registered storage root:
`envelopes/` → envelope, `objects/` → content, `memory/` and `supersessions/` and
`namespace.json` → memory index, anything else under the root → unclassified.
`metering/` and `observation/` are excluded outright, so recording a measurement can
never appear inside the measurement.

## What it does not measure

- `mmap` stores, `io_uring` and `splice`. These are real file I/O and are not counted.
  Any report must say so rather than describing the total as all file I/O.
- Files opened before the process was registered. They are not tracked, so their reads
  and writes are out of scope; the client reports the late start as partial coverage.
- Physical disk traffic. These are VFS-level bytes and may be served entirely from cache.
- Anything about file contents. The program reads an inode identity, a byte count and a
  timestamp. It never touches a buffer.

## Failure behaviour

Every map has a fixed capacity. When one is full the measurement is dropped and a counter
is incremented; the operation being measured is never delayed or failed. Those counters
ride along in every snapshot, and a client that sees a non-zero one downgrades the run's
coverage to partial instead of presenting the totals as complete.

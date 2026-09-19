# SYNAPSE file I/O collector.
#
# Built and installed separately from the npm package on purpose: `npm install`
# must never compile native code, and this binary needs privileges the extension
# does not have and must not acquire.

CLANG ?= clang
BPFTOOL ?= bpftool
CC ?= cc
ARCH := $(shell uname -m | sed 's/x86_64/x86/; s/aarch64/arm64/')

BUILD := build
SRC := src

CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter
BPF_CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_$(ARCH) -I$(BUILD) -I$(SRC) -Wall -Werror

.PHONY: all clean check workload

all: $(BUILD)/synapse-io-collector

# vmlinux.h comes from the running kernel's own BTF. Vendoring it would pin the
# build to whichever kernel the vendored copy came from, which is the opposite of
# what CO-RE is for.
$(BUILD)/vmlinux.h:
	@mkdir -p $(BUILD)
	@test -r /sys/kernel/btf/vmlinux || { echo "error: /sys/kernel/btf/vmlinux is missing; this kernel has no BTF"; exit 1; }
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

$(BUILD)/synapse_io.bpf.o: $(SRC)/synapse_io.bpf.c $(SRC)/protocol.h $(BUILD)/vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

$(BUILD)/synapse_io.skel.h: $(BUILD)/synapse_io.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

$(BUILD)/synapse-io-collector: $(SRC)/synapse_io.c $(SRC)/protocol.h $(BUILD)/synapse_io.skel.h
	$(CC) $(CFLAGS) -I$(BUILD) -I$(SRC) $< -o $@ -lbpf -lelf -lz

workload: $(BUILD)/io-workload

$(BUILD)/io-workload: tests/io_workload.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -pthread $< -o $@

# Reports what this machine can and cannot do, as JSON, without staying resident.
check: $(BUILD)/synapse-io-collector
	./$(BUILD)/synapse-io-collector --check

clean:
	rm -rf $(BUILD)

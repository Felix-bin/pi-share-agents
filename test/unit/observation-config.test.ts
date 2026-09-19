import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OBSERVATION_DEFAULT_SOCKET_PATH,
	resolveObservationSocketPath,
	resolveObservationStartup,
	resolveSystemObservationConfig,
} from "../../src/observation/config.ts";

describe("system observation configuration", () => {
	it("is off by default and names a default socket without enabling anything", () => {
		const config = resolveSystemObservationConfig(undefined);
		assert.equal(config.enabled, false);
		assert.equal(config.socketPath, OBSERVATION_DEFAULT_SOCKET_PATH);
	});

	it("rejects an unknown key rather than dropping it", () => {
		assert.throws(() => resolveSystemObservationConfig({ enabled: true, sockedPath: "/tmp/x.sock" }), /systemObservation.sockedPath is not a known setting/);
	});

	it("rejects a wrongly typed value with the setting name", () => {
		assert.throws(() => resolveSystemObservationConfig({ enabled: "yes" }), /systemObservation.enabled/);
	});

	it("expands a home-relative socket path and refuses a relative one", () => {
		assert.equal(resolveObservationSocketPath("~/run/c.sock", "/home/pi").split("\\").join("/"), "/home/pi/run/c.sock");
		assert.throws(() => resolveObservationSocketPath("run/c.sock", "/home/pi"), /must be an absolute path/);
	});
});

describe("observation startup decision", () => {
	it("refuses to start when the feature is off, regardless of platform", () => {
		const startup = resolveObservationStartup({ enabled: false, socketPath: "/run/c.sock" }, "linux");
		assert.equal(startup.start, false);
		assert.equal(startup.start === false ? startup.reason : "", "disabled");
	});

	it("refuses to start on a platform with no kernel observation, and says which", () => {
		const startup = resolveObservationStartup({ enabled: true, socketPath: "/run/c.sock" }, "win32");
		assert.equal(startup.start, false);
		assert.ok(startup.start === false && startup.reason === "unsupported-platform" && startup.detail.includes("win32"));
	});

	it("starts only when enabled on Linux", () => {
		const startup = resolveObservationStartup({ enabled: true, socketPath: "/run/c.sock" }, "linux");
		assert.equal(startup.start, true);
		assert.equal(startup.start === true ? startup.socketPath : "", "/run/c.sock");
	});
});

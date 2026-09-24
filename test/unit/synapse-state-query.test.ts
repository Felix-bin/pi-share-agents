import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stateQueryOf, SYNAPSE_STATE_QUERY_MAX_BYTES } from "../../src/synapse/state-query.ts";

describe("synapse state query", () => {
	it("prefers the sender's explicit query line over the rest of the message", () => {
		const message = "Task: plan below\n\nState query: 介绍该项目：定位、架构\n\n1. read README.md\n2. read VISION.md";
		assert.deepEqual(stateQueryOf(message), { source: "explicit", text: "介绍该项目：定位、架构" });
		assert.deepEqual(stateQueryOf("前言\n状态查询：openEuler 相关工作\n步骤"), { source: "explicit", text: "openEuler 相关工作" });
	});

	it("falls back to the head of the message without the host's Task: prefix", () => {
		assert.deepEqual(stateQueryOf("Task: explain the auth flow"), { source: "head", text: "explain the auth flow" });
	});

	it("keeps whole lines within the byte bound instead of embedding a whole plan", () => {
		const line = "x".repeat(300);
		const query = stateQueryOf(`Task: title\n${[line, line, line, line, line].join("\n")}`);
		assert.equal(query.source, "head");
		assert.ok(Buffer.byteLength(query.text, "utf-8") <= SYNAPSE_STATE_QUERY_MAX_BYTES);
		assert.deepEqual(query.text.split("\n"), ["title", line, line, line], "only whole lines that fit");
	});

	it("cuts an over-long first line at a character, never inside a UTF-8 sequence", () => {
		const query = stateQueryOf("状".repeat(1000));
		assert.equal(query.text, "状".repeat(Math.floor(SYNAPSE_STATE_QUERY_MAX_BYTES / 3)));
		const explicit = stateQueryOf(`State query: ${"态".repeat(1000)}`);
		assert.equal(explicit.source, "explicit");
		assert.ok(Buffer.byteLength(explicit.text, "utf-8") <= SYNAPSE_STATE_QUERY_MAX_BYTES);
		assert.ok(!explicit.text.includes("�"));
	});
});

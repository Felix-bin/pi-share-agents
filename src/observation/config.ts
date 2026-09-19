import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { UnvalidatedJson } from "../synapse/config.ts";

/**
 * Configuration for the optional kernel-side file I/O observation.
 *
 * Off by default and never inferred from anything else. The collector is a
 * separate privileged process an administrator installs and starts; this
 * setting only says whether a session is allowed to talk to it, and where.
 *
 * Unknown keys are rejected rather than ignored, for the same reason the
 * SYNAPSE config rejects them: a dropped key in an experiment config produces a
 * run whose conditions do not match its report.
 */

export const OBSERVATION_DEFAULT_SOCKET_PATH = "/run/synapse-io/collector.sock";

export type SystemObservationConfig = {
	enabled: boolean;
	socketPath: string;
};

const RawConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		socketPath: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const rawConfigValidator = Compile(RawConfigSchema);
const recordProbe = Compile(Type.Record(Type.String(), Type.Unknown()));

const KNOWN_KEYS = new Set(Object.keys(RawConfigSchema.properties));

function reportInvalid(value: UnvalidatedJson): never {
	const strays = recordProbe.Check(value) ? Object.keys(value).filter((key) => !KNOWN_KEYS.has(key)) : [];
	if (strays.length > 0) {
		throw new Error(`${strays.map((key) => `systemObservation.${key}`).join(", ")} is not a known setting`);
	}
	const [first] = [...rawConfigValidator.Errors(value)];
	if (first === undefined) throw new Error("systemObservation config is invalid");
	const field = first.schemaPath.split("/").filter((part) => part !== "#" && part !== "properties");
	throw new Error(`systemObservation.${field.join(".")} ${first.message}`);
}

/** Accepts an absolute path or a `~/`-prefixed one, matching the host's own convention. */
export function resolveObservationSocketPath(value: string, homeDir: string = os.homedir()): string {
	const expanded = value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
	if (!path.isAbsolute(expanded)) {
		throw new Error(`systemObservation.socketPath must be an absolute path or "~/...", got ${JSON.stringify(value)}`);
	}
	return path.normalize(expanded);
}

export function resolveSystemObservationConfig(value: UnvalidatedJson, homeDir: string = os.homedir()): SystemObservationConfig {
	const raw = value ?? {};
	if (!rawConfigValidator.Check(raw)) reportInvalid(raw);
	return {
		enabled: raw.enabled ?? false,
		socketPath: raw.socketPath === undefined ? OBSERVATION_DEFAULT_SOCKET_PATH : resolveObservationSocketPath(raw.socketPath, homeDir),
	};
}

export type ObservationStartup =
	| { reason: "disabled"; start: false }
	| { detail: string; reason: "unsupported-platform"; start: false }
	| { socketPath: string; start: true };

/**
 * Decides whether a session may open the collector socket at all.
 *
 * Kept separate from the client so the "off" path can be proven to allocate no
 * socket, no timer and no watcher: with the feature disabled this function
 * returns before anything is constructed.
 */
export function resolveObservationStartup(config: SystemObservationConfig, platform: string = process.platform): ObservationStartup {
	if (!config.enabled) return { reason: "disabled", start: false };
	if (platform !== "linux") {
		return { detail: `kernel file I/O observation needs Linux; this host reports ${platform}`, reason: "unsupported-platform", start: false };
	}
	return { socketPath: config.socketPath, start: true };
}

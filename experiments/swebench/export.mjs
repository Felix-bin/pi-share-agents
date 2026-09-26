#!/usr/bin/env node
// Convert each arm's retained patch, including failures as empty predictions, to official JSONL.
import fs from "node:fs";
import path from "node:path";
import { ARMS } from "./matrix.mjs";

const runDir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node export.mjs <run-directory>");
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
const predictions = path.join(runDir, "predictions");
fs.mkdirSync(predictions, { recursive: true });
for (const arm of ARMS) {
	const rows = manifest.instances.map((id) => {
		const folder = path.join(runDir, "evidence", id, arm);
		const patchFile = path.join(folder, "patch.diff");
		return { instance_id: id, model_name_or_path: `deepseek-flash-pi-${arm}`,
			model_patch: fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "" };
	});
	const file = path.join(predictions, `${arm}.jsonl`);
	fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	console.log(`${arm}: ${rows.length} predictions, ${rows.filter((row) => row.model_patch).length} nonempty patches: ${file}`);
}

#!/usr/bin/env node

/**
 * pi-share-agents installer
 *
 * Installs from the repository copy this script lives in: the whole tree is
 * copied to ~/.pi/agent/extensions/subagent (which is also where the extension
 * reads its config.json), minus .git and node_modules, then runtime
 * dependencies are installed there.
 *
 * Usage:
 *   npx pi-subagents          # Install to ~/.pi/agent/extensions/subagent
 *   npx pi-subagents --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".");
const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-share-agents - Pi extension for delegating tasks to subagents over a shared memory

Usage:
  npx pi-subagents          Install the extension from this repository copy
  npx pi-subagents --remove Remove the extension
  npx pi-subagents --help   Show this help

Source directory: ${REPO_ROOT}
Installation directory: ${EXTENSION_DIR}
`);
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("pi-share-agents removed");
	} else {
		console.log("pi-share-agents is not installed");
	}
	process.exit(0);
}

// Install
console.log("Installing pi-share-agents...\n");

const parentDir = path.dirname(EXTENSION_DIR);
if (!fs.existsSync(parentDir)) {
	fs.mkdirSync(parentDir, { recursive: true });
}

// Runtime dependencies live in package.json; a bare copy cannot load the extension without them.
function installDependencies() {
	console.log("\nInstalling runtime dependencies...");
	try {
		execSync("npm install --omit=dev", { cwd: EXTENSION_DIR, stdio: "inherit" });
	} catch (err) {
		console.error("Failed to install dependencies. Run this and retry:");
		console.error(`  cd "${EXTENSION_DIR}" && npm install --omit=dev`);
		process.exit(1);
	}
}

if (fs.existsSync(EXTENSION_DIR)) {
	console.log(`Directory already exists: ${EXTENSION_DIR}`);
	console.log("Remove it first with: npx pi-subagents --remove");
	process.exit(1);
}

console.log(`Copying ${REPO_ROOT} -> ${EXTENSION_DIR}...`);
fs.cpSync(REPO_ROOT, EXTENSION_DIR, {
	dot: true,
	filter: (source) => {
		const relative = path.relative(REPO_ROOT, source);
		return relative === "" || !(relative === ".git" || relative.startsWith(`.git${path.sep}`) || relative === "node_modules" || relative.startsWith(`node_modules${path.sep}`));
	},
});
installDependencies();
console.log("\npi-share-agents installed");

console.log(`
The extension is now available in pi. Tools added:
  • subagent - Delegate tasks to agents and inspect run status
  • bg_wait - Wait for background/provider/detached work without native completion notifications
  • synapse_read / synapse_write - Shared memory, after enabling it with /synapse-setup synapse

Documentation: ${EXTENSION_DIR}/README.md
`);

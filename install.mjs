#!/usr/bin/env node

/**
 * pi-share-agents installer (legacy path)
 *
 * Prefer `pi install git:github.com/Felix-bin/pi-share-agents`, which manages the
 * clone under ~/.pi/agent/git and records the source in settings.json. This script
 * keeps the upstream layout: a clone at ~/.pi/agent/extensions/subagent, which is
 * also where the extension reads its config.json.
 *
 * Usage:
 *   npx pi-subagents          # Install to ~/.pi/agent/extensions/subagent
 *   npx pi-subagents --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");
const REPO_URL = "https://github.com/Felix-bin/pi-share-agents.git";

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-share-agents - Pi extension for delegating tasks to subagents over a shared memory

Recommended install:
  pi install git:github.com/Felix-bin/pi-share-agents

Usage:
  npx pi-subagents          Install the extension
  npx pi-subagents --remove Remove the extension
  npx pi-subagents --help   Show this help

Repository: ${REPO_URL}
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

// Ensure parent directory exists
const parentDir = path.dirname(EXTENSION_DIR);
if (!fs.existsSync(parentDir)) {
	fs.mkdirSync(parentDir, { recursive: true });
}

// Runtime dependencies live in package.json; a bare clone cannot load the extension without them.
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

// Check if already installed
if (fs.existsSync(EXTENSION_DIR)) {
	const isGitRepo = fs.existsSync(path.join(EXTENSION_DIR, ".git"));
	if (isGitRepo) {
		// A clone left behind by the upstream installer points at a different remote; pulling
		// there would update upstream in place instead of switching to this fork.
		let originUrl = "";
		try {
			originUrl = execSync("git remote get-url origin", { cwd: EXTENSION_DIR, encoding: "utf8" }).trim();
		} catch {
			originUrl = "";
		}
		if (originUrl && originUrl.replace(/\.git$/, "") !== REPO_URL.replace(/\.git$/, "")) {
			console.log(`Existing installation points at a different repository: ${originUrl}`);
			console.log("Remove it first with: npx pi-subagents --remove");
			process.exit(1);
		}
		console.log("Updating existing installation...");
		try {
			execSync("git pull", { cwd: EXTENSION_DIR, stdio: "inherit" });
		} catch (err) {
			console.error("Failed to update. Try removing and reinstalling:");
			console.error("  npx pi-subagents --remove && npx pi-subagents");
			process.exit(1);
		}
		installDependencies();
		console.log("\npi-share-agents updated");
	} else {
		console.log(`Directory exists but is not a git repo: ${EXTENSION_DIR}`);
		console.log("Remove it first with: npx pi-subagents --remove");
		process.exit(1);
	}
} else {
	// Fresh install
	console.log(`Cloning to ${EXTENSION_DIR}...`);
	try {
		execSync(`git clone ${REPO_URL} "${EXTENSION_DIR}"`, { stdio: "inherit" });
	} catch (err) {
		console.error("Failed to clone repository");
		process.exit(1);
	}
	installDependencies();
	console.log("\npi-share-agents installed");
}

console.log(`
The extension is now available in pi. Tools added:
  • subagent - Delegate tasks to agents and inspect run status
  • bg_wait - Wait for background/provider/detached work without native completion notifications
  • synapse_read / synapse_write - Shared memory, after enabling it with /synapse-setup synapse

Documentation: ${EXTENSION_DIR}/README.md
`);

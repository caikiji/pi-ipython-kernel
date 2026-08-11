#!/usr/bin/env node
/**
 * One-command MCP registration for the kernel server.
 *
 * New-user friendly: instead of hand-editing a JSON config with absolute
 * paths, run this script and it locates the server and the client config
 * itself:
 *
 *   git clone https://github.com/caikiji/pi-ipython-kernel
 *   cd pi-ipython-kernel
 *   node mcp/install.mjs
 *   # then fully quit and restart Claude Desktop
 *
 * Options:
 *   --cwd <path>      Workspace the kernel should use (default: the
 *                     directory you run this from). This is where the
 *                     .kernel/ store and kernel_init.py live.
 *   --name <name>     Client-side server name (default: "kernel").
 *   --config <path>   Write to a custom config file instead of the
 *                     default Claude Desktop location (testing/other
 *                     clients).
 *   --uninstall       Remove the entry again.
 *
 * Pure Node, no dependencies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, "mcp", "server.ts");

// ------------------------------------------------------------- CLI args

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const cwd = resolve(opt("--cwd", process.cwd()));
const name = opt("--name", "kernel");
const configPath = resolve(opt("--config", defaultConfigPath()));
const uninstall = args.includes("--uninstall");

function defaultConfigPath() {
	switch (process.platform) {
		case "win32":
			return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
		case "darwin":
			return resolve(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
		default:
			return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "Claude", "claude_desktop_config.json");
	}
}

// ---------------------------------------------------------------- main

function readConfig() {
	if (!existsSync(configPath)) return {};
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (err) {
		console.error(`Cannot parse ${configPath}: ${err instanceof Error ? err.message : err}`);
		console.error("Fix or remove the file, then rerun this script.");
		process.exit(1);
	}
}

function writeConfig(cfg) {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
	console.error(`This server needs Node >= 22.18 (you have ${process.versions.node}).`);
	process.exit(1);
}
// Node 23.6+ strips types by default; 22.18-23.x needs the flag.
// Node 23.6+ strips types by default; 22.18-23.5 needs the flag.
const flag = nodeMajor >= 24 || (nodeMajor === 23 && Number(process.versions.node.split(".")[1]) >= 6) ? null : "--experimental-strip-types";

const cfg = readConfig();
const mcpServers = (cfg.mcpServers ??= {});
const entry = {
	command: process.execPath,
	args: flag ? [flag, serverPath] : [serverPath],
	cwd,
	env: { PI_KERNEL_PYTHON: process.env.PI_KERNEL_PYTHON },
};
if (process.env.PI_KERNEL_PYTHON === undefined) delete entry.env;

if (uninstall) {
	delete mcpServers[name];
	writeConfig(cfg);
	console.log(`Removed "${name}" from ${configPath}`);
	console.log("Quit and restart Claude Desktop to apply.");
	process.exit(0);
}

const prev = mcpServers[name];
mcpServers[name] = entry;
writeConfig(cfg);

console.log(`Registered MCP server "${name}":`);
console.log(`  command : ${entry.command}`);
console.log(`  args    : ${entry.args.join(" ")}`);
console.log(`  cwd     : ${cwd}   (the kernel workspace)`);
if (prev) console.log(`(replaced a previous "${name}" entry)`);
console.log(`config   : ${configPath}`);
console.log("");
console.log("Next steps:");
console.log("  1. Fully quit Claude Desktop (not just close the window)");
console.log("  2. Relaunch it — the kernel tools (kernel_run / kernel_ls /");
console.log("     kernel_get / kernel_publish / kernel_delete) appear in the");
console.log("     tools list.");
console.log("  3. First tool call bootstraps the managed Python runtime");
console.log("     (a few minutes, cached afterwards). Set PI_KERNEL_PYTHON");
console.log("     before running this script to reuse a local Python instead.");
console.log("");
console.log(`To undo: node ${resolve(root, "mcp", "install.mjs")} --uninstall`);

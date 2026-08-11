#!/usr/bin/env node
/**
 * One-command MCP registration for the kernel server, project-scoped.
 *
 * Writes a standard .mcp.json into the project root — the shared,
 * project-level MCP config convention that pi (via pi-mcp-adapter),
 * Cursor, VS Code Copilot and other MCP clients pick up automatically.
 * No absolute paths to type by hand, nothing global to configure:
 *
 *   git clone https://github.com/caikiji/pi-ipython-kernel
 *   cd /path/to/your/project
 *   node /path/to/pi-ipython-kernel/mcp/install.mjs
 *
 * This creates <project>/.mcp.json with a "kernel" server whose cwd is
 * the project itself — the kernel workspace (its .kernel/ store and
 * kernel_init.py live there). Restart pi (or run /reload; pi's /mcp
 * command lists the server) and the kernel tools are available.
 *
 * Options:
 *   --cwd <path>      Project to write .mcp.json into (default: the
 *                     directory you run this from).
 *   --name <name>     Server name in the config (default: "kernel").
 *   --config <path>   Write to a custom config file (testing/other
 *                     clients) instead of <project>/.mcp.json.
 *   --uninstall       Remove the entry again.
 *
 * Pure Node, no dependencies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const project = resolve(opt("--cwd", process.cwd()));
const name = opt("--name", "kernel");
const configPath = resolve(opt("--config", resolve(project, ".mcp.json")));
const uninstall = args.includes("--uninstall");

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
// Node 23.6+ strips types by default; 22.18-23.5 needs the flag.
const flag = nodeMajor >= 24 || (nodeMajor === 23 && Number(process.versions.node.split(".")[1]) >= 6) ? null : "--experimental-strip-types";

const cfg = readConfig();
const mcpServers = (cfg.mcpServers ??= {});
const entry = {
	command: process.execPath,
	args: flag ? [flag, serverPath] : [serverPath],
	cwd: project,
};
if (process.env.PI_KERNEL_PYTHON) {
	entry.env = { PI_KERNEL_PYTHON: process.env.PI_KERNEL_PYTHON };
}

if (uninstall) {
	delete mcpServers[name];
	writeConfig(cfg);
	console.log(`Removed "${name}" from ${configPath}`);
	process.exit(0);
}

const prev = mcpServers[name];
mcpServers[name] = entry;
writeConfig(cfg);

console.log(`Registered MCP server "${name}" in ${configPath}`);
console.log(`  command : ${entry.command}`);
console.log(`  args    : ${entry.args.join(" ")}`);
console.log(`  cwd     : ${project}   (the kernel workspace)`);
if (prev) console.log(`(replaced a previous "${name}" entry)`);
console.log("");
console.log("Next steps:");
console.log("  - pi: restart the session (or /reload). The kernel tools");
console.log("    (kernel_run / kernel_ls / kernel_get / kernel_publish /");
console.log("    kernel_delete) become available; /mcp lists the server.");
console.log("  - Cursor / VS Code Copilot / Claude Code: the project");
console.log("    .mcp.json is picked up automatically (reload as needed).");
console.log("  - First tool call bootstraps the managed Python runtime");
console.log("    (a few minutes, cached afterwards). Set PI_KERNEL_PYTHON");
console.log("    before running this script to reuse a local Python instead.");
console.log("");
console.log(`To undo: node ${resolve(root, "mcp", "install.mjs")} --uninstall`);

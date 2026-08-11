#!/usr/bin/env node
/**
 * One-command MCP registration for the kernel server, project-scoped and
 * cross-platform (Windows / macOS / Linux).
 *
 * Writes a standard .mcp.json into the project root — the shared,
 * project-level MCP config convention that pi (via pi-mcp-adapter),
 * Cursor, VS Code Copilot and other MCP clients pick up automatically.
 *
 * The generated entry is deliberately portable:
 *   - "command": "node"          (resolved via PATH, no C:\... hardcoding)
 *   - relative server path when the repo lives inside the project, so the
 *     .mcp.json can be committed and works for every teammate on any OS
 *   - no "cwd" field: the client's default working directory (the project
 *     root, for pi) becomes the kernel workspace
 *
 * Recommended layout (fully portable, committable):
 *
 *   cd /path/to/your/project
 *   git clone https://github.com/caikiji/pi-ipython-kernel vendor/pi-ipython-kernel
 *   node vendor/pi-ipython-kernel/mcp/install.mjs
 *
 * If the repo is elsewhere on disk, an absolute path with forward slashes
 * is used instead (works on Windows and macOS alike) and the entry stays
 * machine-local.
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
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

// Portable server spec. `node` is resolved via PATH on every OS. The
// --experimental-strip-types flag is accepted on all Node 22.18+ (a no-op
// where stripping is default-on), so one entry works everywhere.
function serverSpec() {
	const serverFile = resolve(root, "mcp", "server.ts");
	// Repo inside the project? Use a relative path so the config is
	// committable and portable (args resolve against the client's
	// default cwd = project root). Otherwise an absolute forward-slash
	// path, which both Windows and macOS understand.
	const rel = relative(project, serverFile);
	const path = rel && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) ? rel.split(sep).join("/") : serverFile.split(sep).join("/");
	return { command: "node", args: ["--experimental-strip-types", path] };
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
	console.error(`This server needs Node >= 22.18 (you have ${process.versions.node}).`);
	process.exit(1);
}

const cfg = readConfig();
const mcpServers = (cfg.mcpServers ??= {});
const entry = serverSpec();
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

const portable = !entry.args[1].includes(":") && !entry.args[1].startsWith("/") && !entry.args[1].startsWith("\\\\");
console.log(`Registered MCP server "${name}" in ${configPath}`);
console.log(`  command : ${entry.command}`);
console.log(`  args    : ${entry.args.join(" ")}`);
console.log(`  workspace: the project directory (client default cwd)`);
console.log(portable ? "  layout  : relative path — this .mcp.json is committable and works for teammates on any OS" : "  layout  : absolute path (repo is outside the project)");
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

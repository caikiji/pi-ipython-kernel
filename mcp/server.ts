#!/usr/bin/env node
/**
 * pi-ipython-kernel as an MCP server (stdio transport).
 *
 * Same kernel as the pi extension — same managed runtime bootstrap, same
 * persistent IPython process, same workspace .kernel/ store — exposed as
 * MCP tools so any MCP-capable harness (Claude Desktop, Cursor, ...) can
 * use it. The workspace is the server process's cwd: launch the server
 * from (or with cwd set to) the workspace whose .kernel/ store and init
 * scripts should be used.
 *
 * Run:  node mcp/server.ts            (Node >= 23.6, or 22.18+ with
 *        node --experimental-strip-types mcp/server.ts)
 *
 * Client registration (Claude Desktop claude_desktop_config.json):
 *   "mcpServers": { "kernel": { "command": "node", "args": ["<install>/mcp/server.ts"], "cwd": "<workspace>" } }
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelSession } from "../src/kernelSession.ts";
import { McpProtocol, runStdio } from "../src/mcp.ts";
import {
	formatDelete,
	formatExecuteResult,
	formatGet,
	formatLs,
	formatPublish,
	formatRegistrySummary,
	type GetResult,
	type LsEntry,
	type RegistryEntry,
} from "../src/format.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, "python/server.py");
const manifestPath = resolve(root, "python/runtime.json");
const workspace = process.cwd();

// One kernel process for this server's workspace, lazily spawned on first
// tool call, shut down when the client disconnects. Tool calls may arrive
// concurrently; KernelSession.get() is race-free and execute() serializes
// cells, exactly like the pi extension.
const session = new KernelSession({ serverPath, manifestPath });

function stageText(stage: string): string {
	// Bootstrap stages are folded into the tool result text (MCP progress
	// notifications would need a client capability negotiation; the text
	// form works everywhere and the agent sees it either way).
	return `[kernel runtime] ${stage}`;
}

async function kernel(): Promise<{ proc: import("../src/kernelProcess.ts").KernelProcess; stages: string[] }> {
	const stages: string[] = [];
	const proc = await session.get(workspace, (s) => stages.push(s));
	return { proc, stages };
}

function text(s: string): { type: "text"; text: string }[] {
	return [{ type: "text", text: s }];
}

// ---------------------------------------------------------------- tools

const tools = [
	{
		name: "kernel_run",
		description:
			"Run Python in a full IPython environment that persists across calls: variables, imports and data stay alive. Rich output for DataFrames/arrays, magics (%timeit, ?), and a namespace diff. A trailing bare expression (e.g. `df`) prints like a REPL. Exceptions return as an error result with a traceback; the namespace is preserved. A timeout interrupts the running cell (on Windows the kernel is killed and respawns fresh, losing session state).",
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string", description: "Python code to execute in the kernel." },
				timeout: { type: "number", description: "Execution timeout in seconds (default 30, min 1, max 300)." },
			},
			required: ["code"],
		},
		async handler(args: Record<string, unknown>) {
			const code = String(args.code ?? "");
			const timeoutSec = Math.min(Math.max(Number(args.timeout ?? 30) || 30, 1), 300);
			const { proc, stages } = await kernel();
			const { timedOut, result } = await proc.execute(code, timeoutSec * 1000);
			if (!result) {
				if (timedOut) {
					// Windows timeout path: the kernel was killed (SIGINT
					// cannot be caught there) and will respawn on the next
					// call. Report TIMEOUT semantics, not an error.
					return {
						content: text(session.warningText() + "TIMEOUT: the code did not finish within the timeout; the kernel process was killed and will respawn fresh on the next call (session state is lost)."),
					};
				}
				throw new Error("kernel returned no result");
			}
			const prefix = stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "";
			return { content: text(prefix + session.warningText() + formatExecuteResult(result, timedOut)) };
		},
	},
	{
		name: "kernel_ls",
		description:
			"Inventory the kernel: REGISTERED project callables/data (from the workspace init script), SESSION variables, and the GLOBAL layer (published objects). Registered entries show signature and description; global entries include version, size and staleness status.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["all", "session", "global"], description: "Which sections to show (default all)." },
				pattern: { type: "string", description: "fnmatch pattern on object names (e.g. 'df*')." },
				detail: { type: "boolean", description: "Show description/created/source for global objects (default false)." },
			},
		},
		async handler(args: Record<string, unknown>) {
			const { proc, stages } = await kernel();
			const res = (await proc.call("ls", {
				scope: String(args.scope ?? "all"),
				pattern: args.pattern ?? null,
			})) as { session: LsEntry[]; registered: RegistryEntry[]; global: LsEntry[] };
			const prefix = stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "";
			return {
				content: text(prefix + session.warningText() + formatLs(res.session ?? [], res.global ?? [], res.registered ?? [], args.detail === true)),
			};
		},
	},
	{
		name: "kernel_get",
		description:
			"Load an object into the current session: a session variable, or a published global object (deserialized and injected into the namespace). Returns a structure-aware summary by default; summarize=false returns the full value. Stale (INVALID) global objects are refused unless force=true.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Object name (session variable or global object)." },
				summarize: { type: "boolean", description: "Return a compact summary (default true); false returns the full value." },
				scope: { type: "string", enum: ["auto", "session", "global"], description: "Where to look (default auto: session first)." },
				force: { type: "boolean", description: "Retrieve a stale global object anyway (default false)." },
			},
			required: ["name"],
		},
		async handler(args: Record<string, unknown>) {
			const { proc, stages } = await kernel();
			const res = (await proc.call("get", {
				name: String(args.name ?? ""),
				summarize: args.summarize !== false,
				scope: String(args.scope ?? "auto"),
				force: args.force === true,
			})) as GetResult;
			const prefix = stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "";
			return { content: text(prefix + session.warningText() + formatGet(res)) };
		},
	},
	{
		name: "kernel_publish",
		description:
			"Hand off a session object to the workspace-global layer so later sessions/harnesses in the same workspace can pick it up with kernel_get. Requires a description; optionally records a source file for staleness checks; supports optimistic locking via expected_version.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Object name (must match a session variable)." },
				description: { type: "string", description: "Required: what this object is and how it was produced." },
				source: { type: "string", description: "Source file path the object was derived from (enables staleness checks)." },
				expected_version: { type: "number", description: "Require this version to be the current one (optimistic lock)." },
			},
			required: ["name", "description"],
		},
		async handler(args: Record<string, unknown>) {
			const { proc, stages } = await kernel();
			const res = (await proc.call("publish", {
				name: String(args.name ?? ""),
				description: String(args.description ?? ""),
				source: args.source ?? null,
				expected_version: args.expected_version ?? null,
			})) as { name: string; version: number; overwritten: boolean };
			const prefix = stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "";
			return { content: text(prefix + session.warningText() + formatPublish(res)) };
		},
	},
	{
		name: "kernel_delete",
		description:
			"Remove a published object from the workspace-global layer. Idempotent: deleting a missing object reports 'nothing to delete'. Session variables are unaffected (remove those with kernel_run: del name).",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Object name to delete from the global layer." },
				expected_version: { type: "number", description: "Require this version to be the one deleted (optimistic lock)." },
			},
			required: ["name"],
		},
		async handler(args: Record<string, unknown>) {
			const { proc, stages } = await kernel();
			const res = (await proc.call("delete", {
				name: String(args.name ?? ""),
				expected_version: args.expected_version ?? null,
			})) as { name: string; deleted: boolean; version: number | null };
			const prefix = stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "";
			return { content: text(prefix + session.warningText() + formatDelete(res)) };
		},
	},
];

// ------------------------------------------------------------- resources

// The pi extension injects the registry summary into the conversation via
// before_agent_start; MCP has no such hook, so the same summary is exposed
// as a resource the agent can read on demand.
const resources = [
	{
		uri: "kernel://registry",
		name: "Kernel registry summary",
		description: "Registered project callables/data from the workspace init script (signature + description).",
		mimeType: "text/plain",
		async read(): Promise<string> {
			const { proc, stages } = await kernel();
			const res = (await proc.call("ls", { scope: "session" })) as { registered?: RegistryEntry[] };
			return (stages.length > 0 ? stages.map(stageText).join("\n") + "\n\n" : "") + formatRegistrySummary(res.registered ?? []);
		},
	},
];

// ------------------------------------------------------------------ main

const protocol = new McpProtocol({
	tools,
	resources,
	serverInfo: { name: "pi-ipython-kernel", version: "0.1.0" },
});

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	try {
		await session.shutdown();
	} finally {
		process.exit(0);
	}
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

runStdio(protocol, shutdown).catch((err) => {
	console.error(`mcp server error: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});

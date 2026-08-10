/**
 * pi-ipython-kernel: persistent IPython kernel as agent tools.
 *
 * Registers kernel_run (M1); kernel_ls / kernel_get / kernel_publish
 * follow in later milestones. One kernel process per pi session,
 * lazily spawned on first use, shut down on session_shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatExecuteResult, formatDelete, formatGet, formatLs, formatPublish, type GetResult, type LsEntry } from "../src/format.ts";
export default function kernelExtension(pi: ExtensionAPI) {
	// python/server.py and runtime.json sit next to the package, one level
	// above extensions/.
	const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../python/server.py");
	const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../python/runtime.json");

	// One kernel process per extension instance (= per pi session), per
	// workspace. Rebuilt if the session's cwd changes (different workspace).
	// get() is race-free: concurrent tool calls resolve to one process.
	const session = new KernelSession({ serverPath, manifestPath });

	function stage(onUpdate?: AgentToolUpdateCallback): (s: string) => void {
		return (s) => onUpdate?.({ content: [{ type: "text", text: `[kernel runtime] ${s}` }], details: { stage: s } });
	}

	pi.registerTool({
		name: "kernel_run",
		label: "Kernel Run",
		description:
			"Execute Python code in a persistent per-workspace kernel. State (variables, imports, loaded data) survives across kernel_run calls and across sessions in the same workspace. Returns stdout/stderr output plus a namespace diff (new/changed/removed top-level names).",
		promptSnippet: "Execute Python code in the persistent kernel; state persists between calls",
		promptGuidelines: [
			"Use kernel_run for data analysis, file processing, and any computation where intermediate state (variables, imported modules, data) should survive across tool calls.",
			"The kernel namespace persists between kernel_run calls: define a variable or load data once, reference it in later calls. The response reports new/changed/removed top-level names so you know what the code produced.",
			"A trailing bare expression (e.g. `df` or `1 + 1`) is printed like in a REPL, so you can inspect objects without print().",
			"Top-level names starting with `_` are treated as private and excluded from the diff.",
			"If execution exceeds the timeout, the kernel is interrupted (KeyboardInterrupt semantics) and keeps serving; the response reports INTERRUPTED/TIMEOUT.",
			"Python exceptions are returned in the response as ERROR with a traceback for debugging; the kernel state is preserved. Kernel-side errors do not fail the tool call itself.",
			"Use bash for shell/OS operations (installing packages, git, process management); kernel_run is for Python computation.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute in the kernel." }),
			timeout: Type.Optional(
				Type.Number({ description: "Execution timeout in seconds (default 30, min 1, max 300)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const code = params.code as string;
			const timeoutSec = Math.min(Math.max((params.timeout as number | undefined) ?? 30, 1), 300);
			const proc = await session.get(ctx.cwd, stage(_onUpdate));
			try {
				const { timedOut, result } = await proc.execute(code, timeoutSec * 1000);
				if (!result) {
					throw new Error("kernel returned no result");
				}
				return {
					content: [{ type: "text", text: session.warningText() + formatExecuteResult(result, timedOut) }],
					details: { tool: "kernel_run", timedOut },
				};
			} catch (err) {
				// Infrastructure failures (process died, RPC broken) are real
				// tool errors; the next call auto-respawns the kernel.
				throw new Error(`kernel_run failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ------------------------------------------------------------ kernel_ls

	pi.registerTool({
		name: "kernel_ls",
		label: "Kernel List",
		description:
			"List objects in the kernel: the session namespace (variables defined via kernel_run) and the workspace-global layer (objects published with kernel_publish). Global entries include version, size and staleness status.",
		promptSnippet: "List kernel session variables and published global objects",
		promptGuidelines: [
			"Use kernel_ls when starting work in a workspace or after a session switch: it shows what session variables exist (from kernel_run) and what objects were published globally (from kernel_publish) by previous sessions.",
			"Global objects with [INVALID] are stale snapshots (their source file changed); rebuild and re-publish rather than using them.",
		],
		parameters: Type.Object({
			scope: Type.Optional(StringEnum(["all", "session", "global"] as const)),
			pattern: Type.Optional(Type.String({ description: "fnmatch pattern on object names (e.g. 'df*')." })),
			detail: Type.Optional(Type.Boolean({ description: "Show description/created/source for global objects (default false)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proc = await session.get(ctx.cwd, stage(_onUpdate));
			const res = (await proc.call("ls", {
				scope: (params.scope as string | undefined) ?? "all",
				pattern: params.pattern,
			})) as { session: LsEntry[]; global: LsEntry[] };
			return {
				content: [{ type: "text", text: session.warningText() + formatLs(res.session ?? [], res.global ?? [], params.detail === true) }],
				details: { tool: "kernel_ls", counts: { session: res.session?.length ?? 0, global: res.global?.length ?? 0 } },
			};
		},
	});

	// ------------------------------------------------------------ kernel_get

	pi.registerTool({
		name: "kernel_get",
		label: "Kernel Get",
		description:
			"Retrieve an object: a session variable or a published global object. Global objects are deserialized and injected into the session namespace (usable by later kernel_run calls). Returns a structure-aware summary by default; pass summarize=false for the full value.",
		promptSnippet: "Get a kernel object: summary, or load a global object into the session",
		promptGuidelines: [
			"Use kernel_get to inspect an object from kernel_ls: it returns a type-aware summary (DataFrame shape/columns/dtypes, dict keys, list length...) instead of dumping full contents.",
			"Retrieving a global object loads it into the session namespace, so you can use it directly in later kernel_run code.",
			"If the session already has a variable with the same name, it shadows the global one; delete it first (kernel_run: del name) or pass scope=session to inspect the session copy.",
			"Stale (INVALID) global objects are not returned by default; pass force=true to retrieve them explicitly, or re-publish from the current source.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Object name (session variable or global object)." }),
			summarize: Type.Optional(Type.Boolean({ description: "Return a compact summary (default true); false returns the full value." })),
			scope: Type.Optional(StringEnum(["auto", "session", "global"] as const)),
			force: Type.Optional(Type.Boolean({ description: "Retrieve a stale global object anyway (default false)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proc = await session.get(ctx.cwd, stage(_onUpdate));
			const res = (await proc.call("get", {
				name: params.name,
				summarize: params.summarize !== false,
				scope: (params.scope as string | undefined) ?? "auto",
				force: params.force === true,
			})) as GetResult;
			return {
				content: [{ type: "text", text: session.warningText() + formatGet(res) }],
				details: { tool: "kernel_get", name: params.name },
			};
		},
	});

	// ------------------------------------------------------------ kernel_publish

	pi.registerTool({
		name: "kernel_publish",
		label: "Kernel Publish",
		description:
			"Publish a session object to the workspace-global layer so other sessions in the same workspace can load it with kernel_get. Requires a description; optionally records a source file for staleness checks and supports optimistic locking via expected_version.",
		promptSnippet: "Publish a kernel object to the workspace-global layer",
		promptGuidelines: [
			"Use kernel_publish to hand off results (cleaned data, computed config, analysis output) to later sessions in the same workspace.",
			"A non-empty description is required; include what the object is and how it was produced.",
			"Pass source=<path> when the object was derived from a file; the source hash is recorded and the snapshot is flagged INVALID if the file changes later.",
			"Publishing a name that already exists overwrites it (last-write-wins) and reports the overwrite; pass expected_version to require that a specific version is being replaced.",
			"Only safe-to-serialize types can be published (plain data, numpy, pandas/polars frames); other objects must be exported to files.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Object name (must match a session variable)." }),
			description: Type.String({ description: "Required: what this object is and how it was produced." }),
			source: Type.Optional(Type.String({ description: "Source file path the object was derived from (enables staleness checks)." })),
			expected_version: Type.Optional(Type.Number({ description: "Require this version to be the current one (optimistic lock)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proc = await session.get(ctx.cwd, stage(_onUpdate));
			const res = (await proc.call("publish", {
				name: params.name,
				description: params.description,
				source: params.source ?? null,
				expected_version: params.expected_version ?? null,
			})) as { name: string; version: number; overwritten: boolean };
			return {
				content: [{ type: "text", text: session.warningText() + formatPublish(res) }],
				details: { tool: "kernel_publish", name: params.name, version: res.version, overwritten: res.overwritten },
			};
		},
	});

	// ------------------------------------------------------------ kernel_delete

	pi.registerTool({
		name: "kernel_delete",
		label: "Kernel Delete",
		description:
			"Delete a published object from the workspace-global layer so other sessions can no longer load it with kernel_get. Idempotent: deleting a missing object reports 'nothing to delete' instead of failing. Pass expected_version to require that a specific version is deleted (optimistic lock). Session variables are not affected; remove those with kernel_run (del name).",
		promptSnippet: "Delete a published global kernel object",
		promptGuidelines: [
			"Use kernel_delete to clean up the global layer: remove stale snapshots, accidental publishes, or test leftovers so kernel_ls stays small and current.",
			"Deleting is idempotent and safe to retry: deleting an object that does not exist reports 'nothing to delete', not an error.",
			"Pass expected_version to delete only a specific version (e.g. when another session may have updated the object); a mismatch reports a conflict instead of deleting.",
			"kernel_delete only affects the global layer. To remove a session variable, use kernel_run (del name).",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Object name to delete from the global layer." }),
			expected_version: Type.Optional(Type.Number({ description: "Require this version to be the one deleted (optimistic lock)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proc = await session.get(ctx.cwd, stage(_onUpdate));
			const res = (await proc.call("delete", {
				name: params.name,
				expected_version: params.expected_version ?? null,
			})) as { name: string; deleted: boolean; version: number | null };
			return {
				content: [{ type: "text", text: session.warningText() + formatDelete(res) }],
				details: { tool: "kernel_delete", name: params.name, deleted: res.deleted, version: res.version ?? null },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		await session.shutdown();
	});
}

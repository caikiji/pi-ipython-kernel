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
import { KernelSession } from "../src/kernelSession.ts";
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
			"Run Python in a full IPython environment that persists across calls and across sessions: variables, imports and data stay alive between calls and are shared with later sessions in the same workspace. Handles any Python task — data analysis, computation, ETL, file processing — with rich output for DataFrames/arrays, magics (%timeit, ?), and step-by-step iteration. Returns output plus a namespace diff (new/changed/removed top-level names).",
		promptSnippet: "Run Python in the persistent IPython kernel for data work and computation",
		promptGuidelines: [
			"Python tasks — data analysis, ETL, computation, file processing, scraping — are this tool's job. Prefer it over bash one-liners when the work is iterative or stateful: define or load data once, reference it in later calls.",
			"The engine is IPython: magics like %timeit/%%timeit, `?` for introspection, and rich repr of DataFrames/arrays. pandas and numpy are available in the managed runtime.",
			"A trailing bare expression (e.g. `df` or `1 + 1`) prints like a REPL, so you can inspect objects without print(). Keep big objects in the kernel and inspect with .head()/.describe()/summaries instead of dumping full contents into the conversation.",
			"Exceptions return as ERROR with a traceback and the namespace is preserved; kernel-side errors do not fail the tool call. Timeout interrupts the call (KeyboardInterrupt semantics) and the kernel keeps serving.",
			"System operations (installing packages, git, process management) belong in bash; kernel_run is for Python work.",
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
			"Inventory what you already have before starting work: session variables (defined via kernel_run) and the workspace-global layer (objects published with kernel_publish). Global entries include version, size and staleness status.",
		promptSnippet: "Inventory kernel session variables and published global objects",
		promptGuidelines: [
			"Run this at the start of work in a workspace, or after a session switch: it shows reusable objects (loaded data, computed results) so you do not redo work.",
			"Global objects flagged [INVALID] are stale snapshots (their source file changed); rebuild and re-publish rather than using them.",
			"Session-layer variables are ephemeral — they die with the session; publish to the global layer to keep them across sessions.",
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
			"Load an object into the current session: a session variable, or a published global object (deserialized and injected into the namespace, usable by later kernel_run calls). Returns a structure-aware summary by default; pass summarize=false for the full value.",
		promptSnippet: "Load a kernel object into the session (summary or full value)",
		promptGuidelines: [
			"Pick objects from kernel_ls output; the summary (DataFrame shape/columns/dtypes, dict keys, list length...) is enough for most decisions — pass summarize=false only when you need the full value.",
			"Loading a global object injects it into the session namespace: it becomes usable in later kernel_run code without re-reading.",
			"A same-name session variable shadows the global one; pass scope=global to load the published copy (it replaces the session value). Stale (INVALID) objects are refused by default; force=true retrieves them explicitly.",
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
			"Hand off a session object to the workspace-global layer so later sessions in the same workspace can pick it up with kernel_get — the persistence step of the workflow: analyze (kernel_run) -> publish -> retrieve later (kernel_get). Requires a description; optionally records a source file for staleness checks; supports optimistic locking via expected_version.",
		promptSnippet: "Publish a kernel object to the shared global layer for later sessions",
		promptGuidelines: [
			"Publish task outputs worth keeping: cleaned data, computed configs, analysis results. Later sessions load them with kernel_get instead of recomputing.",
			"The description is required: state what the object is and how it was produced.",
			"Pass source=<path> when the object was derived from a file; the source hash is recorded and the snapshot is flagged INVALID if the file changes later.",
			"Same-name publish overwrites (last-write-wins) and reports the overwrite; pass expected_version to require that a specific version is being replaced.",
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
			"Remove a published object from the workspace-global layer so other sessions can no longer load it with kernel_get — the cleanup step for stale, wrong, or test artifacts. Idempotent: deleting a missing object reports 'nothing to delete' instead of failing. Session variables are unaffected (remove those with kernel_run: del name).",
		promptSnippet: "Delete a published global kernel object",
		promptGuidelines: [
			"Clean up the global layer when objects are stale, wrong, or no longer needed, so kernel_ls stays small and current.",
			"Deleting is idempotent and safe to retry: deleting an object that does not exist reports 'nothing to delete', not an error.",
			"Pass expected_version to delete only a specific version (e.g. when another session may have updated the object); a mismatch reports a conflict instead of deleting.",
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

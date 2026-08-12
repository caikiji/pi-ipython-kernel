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
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelSession } from "../src/kernelSession.ts";
import {
	formatExecuteResult,
	formatDelete,
	formatGet,
	formatLs,
	formatPublish,
	formatReload,
	formatRegistrySummary,
	type GetResult,
	type LsEntry,
	type RegistryEntry,
	type ReloadReport,
} from "../src/format.ts";
import { checkInitHashes, formatInitChanges, rememberInitHashes } from "../src/initHashes.ts";
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

/** Init-script hot reload summary, prepended to tool output when a reload
 * fired as part of the call. */
function reloadText(res: { reload?: ReloadReport }): string {
	return res.reload ? formatReload(res.reload) + "\n\n" : "";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));

/** Init-script hot reload summary, prepended to tool output when a reload
 * fired as part of the call. */

	pi.registerTool({
		name: "kernel_run",
		label: "Kernel Run",
		description:
			"Run Python in a full IPython environment that persists across calls and across sessions: variables, imports and data stay alive between calls and are shared with later sessions in the same workspace. Handles any Python task you'd otherwise write a throwaway script for — data analysis, code generation, task orchestration, algorithm prototyping, batch refactoring, document/report generation, file processing, small local services — anything needing programming logic plus step-by-step iteration. Rich output for DataFrames/arrays, magics (%timeit, ?), and a namespace diff (new/changed/removed top-level names).",
		promptSnippet: "Run Python in the persistent IPython kernel for any programming task",
		promptGuidelines: [
			"The kernel is a persistent, stateful Python environment — the go-to place for any task that needs programming logic, multi-step state, or iterative exploration (analysis, code generation, orchestration, prototyping, batch edits). Prefer it over bash one-liners when the work is iterative or stateful; prefer bash for one-shot commands.",
			"The engine is IPython: magics like %timeit/%%timeit, `?` for introspection, and rich repr of DataFrames/arrays. pandas and numpy are available in the managed runtime.",
			"A trailing bare expression (e.g. `df` or `1 + 1`) prints like a REPL, so you can inspect objects without print(). Keep big objects in the kernel and inspect with .head()/.describe()/summaries instead of dumping full contents into the conversation.",
			"Exceptions return as ERROR with a traceback and the namespace is preserved; kernel-side errors do not fail the tool call. A timeout interrupts the running cell (KeyboardInterrupt on POSIX; on Windows the kernel is killed and respawns fresh on the next call, so session state is lost — the result says TIMEOUT either way). Cancelling the tool call interrupts the cell the same way.",
			"System operations (installing packages, git, process management) belong in bash; kernel_run is for Python work.",
			"Missing a package? Install it into the managed venv with the managed uv (from bash, never the system Python): `<cache>/uv/uv pip install --python <cache>/venv/bin/python <pkg>`, where cache is `$PI_KERNEL_CACHE` or `~/.cache/pi-ipython-kernel`. It becomes importable in the kernel immediately, no restart.",
			"Project-level reusable code belongs in the workspace init script (`.kernel/init.py` machine-local / `kernel_init.py` committable) — it replays into the kernel on every session start. Items registered there show under REGISTERED in kernel_ls with signature + description; call them directly with kernel_run instead of rewriting them.",
			"To register an item, edit the init script and use the DSL: `register(\"name\", obj, \"description\")` (explicit) or `@register(\"name\", \"description\")` (decorator; a bare string in obj position is the description, which falls back to the docstring's first line). Register string data explicitly as `register(\"name\", obj=\"...\", description=\"...\")`. Any object works — functions, callables, data (DataFrame/dict/constants). Use snake_case names; describe in English what it does, its key parameters and defaults (signatures and data summaries are extracted automatically). Re-registering a name overwrites (last-write-wins) and appends a notice to the run output; `unregister(\"name\")` (idempotent) drops an entry for the current session.",
			"Init-script changes hot-reload: after you save the script, the next kernel call re-executes it in the session and reports a summary (`[init] reloaded ...: +1 registered ...`); a failed reload rolls back and leaves the session untouched. Stale registrations and script vars dropped from the script are cleaned up; agent-side register()/unregister() calls are session-only and never touched by a reload. The init script remains the only cross-session path — treat it as executable project code: it auto-executes, so review changes and only pull from trusted sources.",
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
				const { timedOut, result } = await proc.execute(code, timeoutSec * 1000, _signal);
				if (_signal?.aborted) {
					// The harness cancelled the tool call mid-flight; the
					// running cell was interrupted (SIGINT) or, on Windows,
					// the kernel was killed (respawns on the next call).
					return {
						content: [{ type: "text", text: "kernel_run cancelled: the call was aborted; the running cell was interrupted." }],
						details: { tool: "kernel_run", cancelled: true },
					};
				}
				if (!result) {
					if (timedOut) {
						// Windows timeout path: SIGINT cannot be caught there, so
						// the kernel was killed (session state is lost) and the
						// next call respawns a fresh one. Report the TIMEOUT
						// semantics instead of an infrastructure error.
						return {
							content: [
								{
									type: "text",
									text: session.warningText() + "TIMEOUT: the code did not finish within the timeout; the kernel process was killed and will respawn fresh on the next call (session state is lost).",
								},
							],
							details: { tool: "kernel_run", timedOut: true },
						};
					}
					throw new Error("kernel returned no result");
				}
				return {
					content: [{ type: "text", text: session.warningText() + reloadText(result) + formatExecuteResult(result, timedOut) }],
					details: { tool: "kernel_run", timedOut },
				};
			} catch (err) {
				if (_signal?.aborted) {
					// Windows abort path: the kernel was killed (SIGINT cannot
					// be caught there) and respawns on the next call.
					return {
						content: [{ type: "text", text: "kernel_run cancelled: the call was aborted; the kernel process was killed and will respawn fresh on the next call (session state is lost)." }],
						details: { tool: "kernel_run", cancelled: true },
					};
				}
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
			"Inventory what you already have before starting work: REGISTERED project callables/data (replayed from the workspace init script), SESSION variables (defined via kernel_run), and the GLOBAL layer (objects published with kernel_publish). Registered entries show their signature and description; global entries include version, size and staleness status.",
		promptSnippet: "Inventory kernel registered items, session variables, and global objects",
		promptGuidelines: [
			"Run this at the start of work in a workspace, or after a session switch: it shows reusable project functions/data (REGISTERED), loaded data (SESSION) and published results (GLOBAL) so you do not redo work.",
			"REGISTERED entries are the project's reusable functions and data (from the init script, replayed every session). Read their signature and description, then call them directly with kernel_run — do not re-implement them.",
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
			})) as { session: LsEntry[]; registered: RegistryEntry[]; global: LsEntry[]; reload?: ReloadReport };
			return {
				content: [
					{
						type: "text",
						text: session.warningText() + reloadText(res) + formatLs(res.session ?? [], res.global ?? [], res.registered ?? [], params.detail === true),
					},
				],
				details: {
					tool: "kernel_ls",
					counts: { session: res.session?.length ?? 0, registered: res.registered?.length ?? 0, global: res.global?.length ?? 0 },
				},
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
			"Pick objects from kernel_ls output; the summary (dict keys, list length, DataFrame shape/columns/dtypes, ...) is enough for most decisions — pass summarize=false only when you need the full value.",
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
			})) as GetResult & { reload?: ReloadReport };
			return {
				content: [{ type: "text", text: session.warningText() + reloadText(res) + formatGet(res) }],
				details: { tool: "kernel_get", name: params.name },
			};
		},
	});

	// ------------------------------------------------------------ kernel_publish

	pi.registerTool({
		name: "kernel_publish",
		label: "Kernel Publish",
		description:
			"Hand off a session object to the workspace-global layer so later sessions in the same workspace can pick it up with kernel_get — the persistence step of the workflow: compute/explore/build in kernel_run -> publish -> reuse later via kernel_get. Requires a description; optionally records a source file for staleness checks; supports optimistic locking via expected_version.",
		promptSnippet: "Publish a kernel object to the shared global layer for later sessions",
		promptGuidelines: [
			"Publish task outputs worth keeping: results, computed configs, intermediate state. Later sessions load them with kernel_get instead of recomputing.",
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
			})) as { name: string; version: number; overwritten: boolean; reload?: ReloadReport };
			return {
				content: [{ type: "text", text: session.warningText() + reloadText(res) + formatPublish(res) }],
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
			})) as { name: string; deleted: boolean; version: number | null; reload?: ReloadReport };
			return {
				content: [{ type: "text", text: session.warningText() + reloadText(res) + formatDelete(res) }],
				details: { tool: "kernel_delete", name: params.name, deleted: res.deleted, version: res.version ?? null },
			};
		},
	});

	// ----------------------------------------------------- agent-start context
	//
	// On the first agent turn (and again whenever the registry or an init
	// script changes), inject a compact summary of the workspace kernel
	// state into the conversation, so the agent knows what is available
	// without having to call kernel_ls first. Re-injection is gated by a
	// content hash: identical state is never re-injected.
	const lastInjected = new Map<string, string>();

	pi.on("before_agent_start", async (event) => {
		const cwd = event.systemPromptOptions?.cwd;
		if (!cwd) return;
		const parts: string[] = [];
		// Best-effort, never blocks the conversation: pi awaits this hook
		// before starting the agent turn. On first use the kernel spawn
		// triggers the managed-runtime bootstrap (downloads + pip install),
		// which can take minutes on a slow link — so race the probe
		// against a short budget and skip the summary when the kernel is
		// not ready yet. The bootstrap keeps running in the background and
		// the first real kernel tool call waits on it (with visible stage
		// output in the tool UI).
		const probe = session.get(cwd).catch(() => undefined);
		const proc = await Promise.race([probe, sleep(3_000).then(() => undefined)]);
		if (proc) {
			try {
				const res = (await proc.call("ls", { scope: "session" })) as { registered?: RegistryEntry[]; reload?: ReloadReport };
				const entries = res.registered ?? [];
				// This ls probe can be the first RPC after the agent edited
				// the init script, in which case the reload report rides on
				// it; surface it instead of swallowing it (kernel_ls /
				// kernel_run show it otherwise).
				if (res.reload) {
					parts.push(formatReload(res.reload));
				}
				const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
				if (hash !== lastInjected.get(cwd)) {
					const summary = formatRegistrySummary(entries);
					if (summary) parts.push(summary);
					lastInjected.set(cwd, hash);
				}
			} catch {
				// Kernel not ready (e.g. bootstrap failed); skip the summary.
			}
		}
		const changes = checkInitHashes(cwd);
		if (changes.length > 0) {
			parts.push(formatInitChanges(changes));
			rememberInitHashes(cwd);
		}
		const content = parts.filter(Boolean).join("\n\n");
		if (!content) return;
		return {
			message: {
				customType: "kernel-registry",
				content,
				display: true,
			},
		};
	});

	pi.on("session_shutdown", async () => {
		await session.shutdown();
	});
}

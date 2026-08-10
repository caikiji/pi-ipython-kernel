/**
 * pi-ipython-kernel: persistent IPython kernel as agent tools.
 *
 * Registers kernel_run (M1); kernel_ls / kernel_get / kernel_publish
 * follow in later milestones. One kernel process per pi session,
 * lazily spawned on first use, shut down on session_shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelProcess } from "../src/kernelProcess.ts";
import { formatExecuteResult } from "../src/format.ts";

export default function kernelExtension(pi: ExtensionAPI) {
	// python/server.py sits next to the package, one level above extensions/.
	const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../python/server.py");

	// One process per extension instance (= per pi session). Rebuilt if the
	// session's cwd changes (different workspace).
	let kernel: KernelProcess | undefined;
	let kernelCwd: string | undefined;

	function getKernel(cwd: string): KernelProcess {
		if (!kernel || kernelCwd !== cwd) {
			void kernel?.killSync();
			kernel = new KernelProcess({ serverPath, cwd });
			kernelCwd = cwd;
		}
		return kernel;
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
			const proc = getKernel(ctx.cwd);
			try {
				const { timedOut, result } = await proc.execute(code, timeoutSec * 1000);
				if (!result) {
					throw new Error("kernel returned no result");
				}
				return {
					content: [{ type: "text", text: formatExecuteResult(result, timedOut) }],
					details: { tool: "kernel_run", timedOut },
				};
			} catch (err) {
				// Infrastructure failures (process died, RPC broken) are real
				// tool errors; the next call auto-respawns the kernel.
				throw new Error(`kernel_run failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await kernel?.shutdown();
		kernel = undefined;
		kernelCwd = undefined;
	});
}

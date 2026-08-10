/**
 * Session-scoped kernel management: one kernel process per workspace (cwd),
 * lazily spawned on first use, rebuilt when the cwd changes, shut down with
 * the session. Owns managed-runtime resolution and one-time warnings.
 * Pure Node: no pi imports, testable directly.
 *
 * Concurrency contract: get() is safe to call from parallel tool calls in
 * the same message. Without serialization, two concurrent first calls would
 * both pass the `!kernel` check while the first awaits runtime resolution
 * (an async gap), each spawn its own Python process, and the loser's
 * variables would be lost forever (orphan process, never shut down).
 */
import { KernelProcess } from "./kernelProcess.ts";
import { RuntimeManager } from "./runtime.ts";

export interface KernelSessionOptions {
	/** Absolute path to python/server.py. */
	serverPath: string;
	/** Absolute path to the runtime manifest (python/runtime.json). */
	manifestPath: string;
	/** Stage callback for the managed runtime bootstrap. */
	onStage?: (s: string) => void;
}

export class KernelSession {
	private opts: KernelSessionOptions;
	private kernel?: KernelProcess;
	private kernelCwd?: string;
	/** In-flight spawn/rebuild; concurrent get() calls await it instead of
	 * building their own process. */
	private starting?: Promise<void>;
	/** Managed python resolved once per session; undefined = system python3. */
	private runtimePython?: string;
	private runtimeFailure?: string;
	private fallbackNotified = false;
	private initNotified = false;

	constructor(opts: KernelSessionOptions) {
		this.opts = opts;
	}

	/** Get the kernel process for a workspace. Lazy spawn on first use;
	 * rebuild (killing the old process) when the cwd changes. Concurrent
	 * callers all resolve to the same KernelProcess. */
	async get(cwd: string, onStage?: (s: string) => void): Promise<KernelProcess> {
		for (;;) {
			if (this.kernel && this.kernelCwd === cwd) return this.kernel;
			const pending = this.starting;
			if (pending) {
				await pending;
				continue; // re-check: the cwd may have changed while waiting
			}
			this.starting = this.build(cwd, onStage);
			try {
				await this.starting;
			} finally {
				this.starting = undefined;
			}
			// loop re-checks so a waiter with a different cwd can rebuild
		}
	}

	/** One-time warnings prepended to tool output: managed-runtime fallback
	 * and the init script report. Empty once both have been shown. */
	warningText(): string {
		let text = "";
		if (this.runtimeFailure && !this.fallbackNotified) {
			this.fallbackNotified = true;
			text += `[runtime] managed python bootstrap failed; using system python3. ${this.runtimeFailure}\n\n`;
		}
		const init = this.kernel?.initReport;
		if (init?.path && !this.initNotified) {
			this.initNotified = true;
			if (init.error) {
				text += `[init] ${init.path} failed on startup: ${init.error}\n\n`;
			} else {
				text += `[init] executed ${init.path} (registered: ${init.registered.join(", ") || "no new names"})\n\n`;
			}
		}
		return text;
	}

	/** Graceful shutdown; also waits for an in-flight spawn. Idempotent. */
	async shutdown(): Promise<void> {
		if (this.starting) await this.starting;
		await this.kernel?.shutdown();
		this.kernel = undefined;
		this.kernelCwd = undefined;
	}

	private async build(cwd: string, onStage?: (s: string) => void): Promise<void> {
		// cwd changed: drop the old workspace kernel before spawning.
		void this.kernel?.killSync();
		let pythonCmd: string | undefined;
		if (this.runtimePython === undefined && !this.runtimeFailure) {
			try {
				const manager = new RuntimeManager({ manifestPath: this.opts.manifestPath, onStage: onStage ?? this.opts.onStage });
				this.runtimePython = await manager.ensure();
				pythonCmd = this.runtimePython;
			} catch (err) {
				this.runtimeFailure = err instanceof Error ? err.message : String(err);
			}
		}
		this.kernel = new KernelProcess({ serverPath: this.opts.serverPath, cwd, pythonCmd });
		this.kernelCwd = cwd;
	}
}

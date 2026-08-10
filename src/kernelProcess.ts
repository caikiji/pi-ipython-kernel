/**
 * Kernel process lifecycle: lazy spawn per workspace, reuse while alive,
 * auto-respawn after crash, interrupt-on-timeout semantics.
 * Pure Node: no pi imports, testable directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ReloadReport } from "./format.ts";
import { JsonRpcClient, TimeoutError, type CallOptions } from "./rpc.ts";

export interface KernelProcessOptions {
	/** Absolute path to python/server.py. */
	serverPath: string;
	/** Workspace directory; becomes the kernel process cwd. */
	cwd: string;
	/** Python interpreter; defaults to env PI_KERNEL_PYTHON or "python3". */
	pythonCmd?: string;
	/** Initial hello handshake timeout. Default 8000. */
	spawnTimeoutMs?: number;
}

export interface ExecuteResult {
	output: string;
	output_truncated?: boolean;
	error: string;
	incomplete: boolean;
	interrupted: boolean;
	new: Array<{ name: string; type: string }>;
	changed: string[];
	removed: string[];
	/** Init-script hot reload report, when a reload fired on this call. */
	reload?: ReloadReport;
}

export class KernelProcess {
	private proc?: ChildProcess;
	private client?: JsonRpcClient;
	private starting?: Promise<void>;
	private opts: KernelProcessOptions;
	private helloInit: { path?: string; error?: string; registered: string[] } | null = null;
	private executeQueue: Promise<unknown> = Promise.resolve();

	constructor(opts: KernelProcessOptions) {
		this.opts = opts;
	}

	/** Init script report from the process hello (null until started, or no script). */
	get initReport(): { path?: string; error?: string; registered: string[] } | null {
		return this.helloInit;
	}
	get running(): boolean {
		return this.proc !== undefined && this.proc.exitCode === null;
	}

	async ensureStarted(): Promise<void> {
		if (this.running) return;
		if (this.starting) return this.starting;
		this.starting = this.start();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async start(): Promise<void> {
		const cmd = this.opts.pythonCmd ?? process.env.PI_KERNEL_PYTHON ?? "python3";
		const child = spawn(cmd, [this.opts.serverPath], {
			cwd: this.opts.cwd,
			stdio: ["pipe", "pipe", "inherit"],
		});
		this.proc = child;
		const client = new JsonRpcClient(child);
		this.client = client;
		child.on("exit", () => {
			if (this.proc === child) {
				this.proc = undefined;
				this.client = undefined;
			}
		});
		// Handshake: the process is ready once it answers hello. A spawn
		// failure (missing interpreter) surfaces here as well.
		// Cold start is slow (managed runtime imports ipython/pandas first
		// time); give the handshake a wide window instead of failing fast.
		const hello = await client.call("hello", {}, {
			timeoutMs: this.opts.spawnTimeoutMs ?? 30_000,
			graceMs: 15_000,
		});
		const init = (hello.result as { init?: { path?: string; error?: string; new?: Array<{ name: string }>; registered?: string[] } } | undefined)?.init;
		this.helloInit = init?.path
			? { path: init.path, error: init.error, registered: init.registered ?? (init.new ?? []).map((n) => n.name) }
			: null;
	}

	/** Execute code with interrupt-on-timeout semantics. Concurrent calls
	 * are serialized: the kernel executes one cell at a time, and the
	 * timeout clock starts when execution actually begins. */
	async execute(code: string, timeoutMs = 30_000): Promise<{ timedOut: boolean; result?: ExecuteResult }> {
		// Register on the queue synchronously (call order = execution order);
		// ensureStarted runs inside the slot, so spawn waits are serialized
		// too and the timeout clock starts when the cell actually begins.
		const run = this.executeQueue.then(async () => {
			await this.ensureStarted();
			const onTimeout = () => {
				// SIGINT raises KeyboardInterrupt inside exec on POSIX; on
				// Windows it cannot be caught, so fall back to kill + respawn.
				if (process.platform === "win32") {
					this.killSync();
				} else {
					this.proc?.kill("SIGINT");
				}
			};
			try {
				const res = (await this.client!.call("execute", { code }, { timeoutMs, onTimeout } satisfies CallOptions)) as {
					timedOut: boolean;
					result?: ExecuteResult;
				};
				return res;
			} catch (err) {
				if (err instanceof TimeoutError && process.platform === "win32") {
					// killed above; next call respawns via ensureStarted
				}
				throw err;
			}
		});
		// A failed cell must not poison the queue for later calls.
		this.executeQueue = run.catch(() => undefined);
		return run;
	}

	/** Generic RPC call (ls/get/publish). Errors surface as RpcError. */
	async call<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
		await this.ensureStarted();
		const res = await this.client!.call(method, params, { timeoutMs });
		return res.result as T;
	}

	/** Graceful shutdown; falls back to SIGKILL. */
	async shutdown(): Promise<void> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) return;
		try {
			await this.client!.call("shutdown", {}, { timeoutMs: 2_000, graceMs: 0 });
		} catch {
			this.killSync();
		}
	}

	killSync(): void {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) return;
		proc.kill("SIGKILL");
		// Clear immediately: the exit event is async, and a call right after
		// killSync() must not reuse the dead process (it would hang or throw
		// ProcessKilledError on the stale client).
		this.proc = undefined;
		this.client = undefined;
	}
}

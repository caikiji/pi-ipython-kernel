/**
 * Kernel process lifecycle: lazy spawn per workspace, reuse while alive,
 * auto-respawn after crash, interrupt-on-timeout semantics.
 * Pure Node: no pi imports, testable directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ReloadReport } from "./format.ts";
import { JsonRpcClient, ProcessKilledError, TimeoutError, type CallOptions } from "./rpc.ts";

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

/** Minimal structural type for AbortSignal (no @types/node dependency). */
export interface Abortable {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, opts?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

export class KernelProcess {
	private proc?: ChildProcess;
	private client?: JsonRpcClient;
	private starting?: Promise<void>;
	private opts: KernelProcessOptions;
	private helloInit: { path?: string; error?: string; registered: string[] } | null = null;
	private executeQueue: Promise<unknown> = Promise.resolve();
	/** Consecutive timeouts that ended with no response at all (kernel
	 * wedged, SIGINT ineffective). Drives the SIGINT -> kill escalation. */
	private consecutiveTimeouts = 0;
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
		// Windows has no `python3` launcher (only python / py); pick the
		// platform default when nothing more specific was configured.
		const cmd = this.opts.pythonCmd ?? process.env.PI_KERNEL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
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
	 * timeout clock starts when execution actually begins.
	 *
	 * When `signal` aborts (e.g. the harness cancelled the tool call), the
	 * running cell is interrupted exactly like a timeout: SIGINT on POSIX,
	 * kill + respawn on Windows. */
	async execute(code: string, timeoutMs = 30_000, signal?: Abortable): Promise<{ timedOut: boolean; result?: ExecuteResult }> {
		// Register on the queue synchronously (call order = execution order);
		// ensureStarted runs inside the slot, so spawn waits are serialized
		// too and the timeout clock starts when the cell actually begins.
		const run = this.executeQueue.then(async () => {
			await this.ensureStarted();
			if (signal?.aborted) return { timedOut: false, result: undefined };
			// Set when the timeout fired: distinguishes "killed because the
			// cell did not finish in time" from a plain crash below (both
			// reject the call, but only the former is a TIMEOUT outcome).
			let timedOutArmed = false;
			const interrupt = () => {
				// SIGINT raises KeyboardInterrupt inside exec on POSIX; on
				// Windows it cannot be caught, so fall back to kill + respawn.
				// A cell that ignores SIGINT (C extensions, masked signals)
				// escalates to the same kill after one unresponsive timeout,
				// so a wedged kernel can never stall every later call forever.
				if (process.platform === "win32" || this.consecutiveTimeouts > 0) {
					this.killSync();
				} else {
					this.proc?.kill("SIGINT");
				}
			};
			const onTimeout = () => {
				timedOutArmed = true;
				interrupt();
			};
			const onAbort = () => interrupt();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const res = (await this.client!.call("execute", { code }, { timeoutMs, onTimeout } satisfies CallOptions)) as {
					timedOut: boolean;
					result?: ExecuteResult;
				};
				// A response that arrived (even an interrupted one) proves
				// the kernel is healthy: reset the escalation counter. Only
				// timeouts with no response at all keep it.
				if (res.timedOut && !res.result) {
					this.consecutiveTimeouts++;
				} else {
					this.consecutiveTimeouts = 0;
				}
				return res;
			} catch (err) {
				// On Windows onTimeout kills the process (SIGINT cannot be
				// caught there), so the pending call rejects with
				// ProcessKilledError (exit event) or TimeoutError (grace
				// expired) instead of an interrupted result. Both mean "the
				// cell did not finish in time" — surface TIMEOUT semantics
				// rather than an infrastructure error so the agent can act
				// on it. The next call respawns via ensureStarted.
				if (timedOutArmed && (err instanceof TimeoutError || err instanceof ProcessKilledError)) {
					this.consecutiveTimeouts++;
					return { timedOut: true, result: undefined };
				}
				// Any other failure (spawn error, plain crash) means a fresh
				// kernel is coming: start the escalation count from zero.
				this.consecutiveTimeouts = 0;
				throw err;
			} finally {
				signal?.removeEventListener("abort", onAbort);
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

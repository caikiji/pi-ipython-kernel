/**
 * Kernel process lifecycle: lazy spawn per workspace, reuse while alive,
 * auto-respawn after crash, interrupt-on-timeout semantics.
 * Pure Node: no pi imports, testable directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
	error: string;
	incomplete: boolean;
	interrupted: boolean;
	new: Array<{ name: string; type: string }>;
	changed: string[];
	removed: string[];
}

export class KernelProcess {
	private proc?: ChildProcess;
	private client?: JsonRpcClient;
	private starting?: Promise<void>;
	private opts: KernelProcessOptions;

	constructor(opts: KernelProcessOptions) {
		this.opts = opts;
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
		await client.call("hello", {}, { timeoutMs: this.opts.spawnTimeoutMs ?? 8_000 });
	}

	/** Generic RPC call (ls/get/publish). Errors surface as RpcError. */
	async call<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
		await this.ensureStarted();
		const res = await this.client!.call(method, params, { timeoutMs });
		return res.result as T;
	}

	/** Execute code with interrupt-on-timeout semantics. */
	async execute(code: string, timeoutMs = 30_000): Promise<{ timedOut: boolean; result?: ExecuteResult }> {
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

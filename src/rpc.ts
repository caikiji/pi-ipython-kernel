/**
 * Minimal newline-delimited JSON-RPC client over a child process stdio.
 * Pure Node: no pi imports, testable directly.
 *
 * Timeout semantics: when `timeoutMs` elapses, `onTimeout` fires (the
 * caller typically sends SIGINT to interrupt execution server-side) and
 * the client keeps waiting for the response for up to `graceMs`. If the
 * response arrives in time it resolves with `{ timedOut: true, result }`
 * (e.g. an interrupted cell); otherwise it rejects with TimeoutError.
 */

import { type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export class RpcError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

export class TimeoutError extends Error {
	constructor(message = "kernel call timed out") {
		super(message);
		this.name = "TimeoutError";
	}
}

export class ProcessKilledError extends Error {
	constructor(message = "kernel process exited") {
		super(message);
		this.name = "ProcessKilledError";
	}
}

export interface CallOptions {
	/** Response deadline in ms. 0 disables. Default 30000. */
	timeoutMs?: number;
	/** Extra time after timeout to keep waiting for the late response. Default 3000. */
	graceMs?: number;
	/** Invoked when timeoutMs elapses (e.g. to send SIGINT). */
	onTimeout?: () => void;
}

interface Pending {
	resolve: (value: { timedOut: boolean; result?: unknown }) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
	graceTimer?: NodeJS.Timeout;
	expired?: boolean;
}

export class JsonRpcClient {
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private rl: Interface;
	private dead = false;
	private proc: ChildProcess;

	constructor(proc: ChildProcess) {
		this.proc = proc;
		this.rl = createInterface({ input: proc.stdout! });
		this.rl.on("line", (line) => this.onLine(line));
		proc.on("exit", () => this.failAll(new ProcessKilledError()));
		proc.on("error", (err) => this.failAll(new ProcessKilledError(`kernel process error: ${err.message}`)));
	}

	call(method: string, params: unknown, opts: CallOptions = {}): Promise<{ timedOut: boolean; result?: unknown }> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			if (this.dead) {
				reject(new ProcessKilledError());
				return;
			}
			const pending: Pending = { resolve, reject };
			const timeoutMs = opts.timeoutMs ?? 30_000;
			const graceMs = opts.graceMs ?? 3_000;
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					pending.expired = true;
					opts.onTimeout?.();
					if (graceMs > 0) {
						pending.graceTimer = setTimeout(() => {
							if (this.pending.delete(id)) {
								reject(new TimeoutError(`${method} did not respond after ${timeoutMs}ms (+${graceMs}ms grace)`));
							}
						}, graceMs);
					} else {
						this.pending.delete(id);
						reject(new TimeoutError(`${method} did not respond after ${timeoutMs}ms`));
					}
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			this.proc.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	private onLine(line: string): void {
		let msg: { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof msg.id !== "number") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (p.timer) clearTimeout(p.timer);
		if (p.graceTimer) clearTimeout(p.graceTimer);
		if (msg.error) {
			p.reject(new RpcError(msg.error.code ?? "rpc", msg.error.message ?? String(msg.error)));
		} else {
			p.resolve({ timedOut: p.expired === true, result: msg.result });
		}
	}

	private failAll(err: Error): void {
		this.dead = true;
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			if (p.graceTimer) clearTimeout(p.graceTimer);
			p.reject(err);
		}
		this.pending.clear();
	}
}

/**
 * Init-script change detection (safety hint, see RULES.md).
 *
 * Init scripts (.kernel/init.py, kernel_init.py) auto-execute into the
 * session namespace on every kernel start. To keep that automatic, the
 * host remembers the content hash of each script across sessions and
 * surfaces a one-time notice when a script is new or changed (e.g. after
 * a git pull), so the user can review it before relying on it.
 *
 * State is persisted as a small JSON file in the kernel cache directory
 * ($PI_KERNEL_CACHE or ~/.cache/pi-ipython-kernel) — never inside the
 * workspace and never in .kernel/ (SQLite is the only writer there).
 * Pure Node: no pi imports, testable directly.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Candidate init scripts, in execution order (server.py). */
export const INIT_CANDIDATES = [".kernel/init.py", "kernel_init.py"] as const;

export interface InitChange {
	/** Path relative to the workspace, e.g. "kernel_init.py". */
	path: string;
	/** Absolute path. */
	absPath: string;
	/** Current content hash (hex, truncated for display). */
	hash: string;
	/** Hash recorded in a previous session, if any. */
	previousHash?: string;
	/** True when the script was never seen before. */
	firstSeen: boolean;
}

export function defaultStatePath(): string {
	const cache = process.env.PI_KERNEL_CACHE ?? join(homedir(), ".cache", "pi-ipython-kernel");
	return join(cache, "init-hashes.json");
}

type HashState = Record<string, string>;

function readState(path: string): HashState {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as HashState;
	} catch {
		return {};
	}
}

function writeState(path: string, state: HashState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function hashFile(absPath: string): string {
	return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/** Check each existing init script against the remembered hashes.
 * Does not modify state. */
export function checkInitHashes(cwd: string, statePath?: string): InitChange[] {
	const state = readState(statePath ?? defaultStatePath());
	const changes: InitChange[] = [];
	for (const rel of INIT_CANDIDATES) {
		const abs = join(cwd, rel);
		if (!existsSync(abs)) continue;
		const hash = hashFile(abs);
		const previous = state[abs];
		if (previous === undefined) {
			changes.push({ path: rel, absPath: abs, hash, firstSeen: true });
		} else if (previous !== hash) {
			changes.push({ path: rel, absPath: abs, hash, previousHash: previous, firstSeen: false });
		}
	}
	return changes;
}

/** Remember the current content hashes, so the next session can detect
 * changes. Idempotent; safe to call after every check. */
export function rememberInitHashes(cwd: string, statePath?: string): void {
	const path = statePath ?? defaultStatePath();
	const state = readState(path);
	for (const rel of INIT_CANDIDATES) {
		const abs = join(cwd, rel);
		if (!existsSync(abs)) continue;
		state[abs] = hashFile(abs);
	}
	writeState(path, state);
}

/** Human-readable one-liner for each change, e.g.
 * `[kernel] init script CHANGED since last session: kernel_init.py (a1b2c3d4 -> e5f6a7b8). It hot-reloads on the next kernel call — review the diff before relying on it.` */
export function formatInitChanges(changes: InitChange[]): string {
	return changes
		.map((c) =>
			c.firstSeen
				? `[kernel] init script will auto-execute on every session start: ${c.path}`
				: `[kernel] init script CHANGED since last session: ${c.path} (${(c.previousHash ?? "?").slice(0, 8)} -> ${c.hash.slice(0, 8)}). It hot-reloads on the next kernel call — review the diff before relying on it.`,
		)
		.join("\n");
}

/**
 * Kernel runtime bootstrap: managed Python via uv (python-build-standalone).
 * Pure Node: no pi imports, testable directly.
 *
 * Flow (first use only; everything is cached afterwards):
 *   1. check <cache>/state.json against the manifest (uv version, python
 *      version, dependency hash) - if valid, reuse the existing venv
 *   2. download the pinned uv binary + verify against its official
 *      .sha256 file, extract into the cache
 *   3. uv python install <version> (into UV_PYTHON_INSTALL_DIR=<cache>/python)
 *   4. uv venv <cache>/venv + uv pip install <deps>
 *   5. write state.json (atomic rename)
 *
 * Concurrent first-use from several sessions: downloads go to a private
 * temp dir; the winner renames into place and writes state.json; losers
 * poll for state.json and reuse the winner's runtime.
 *
 * Cache location: $PI_KERNEL_CACHE or ~/.cache/pi-ipython-kernel.
 * If bootstrap fails, callers may fall back to a system python3.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class RuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeError";
	}
}

export interface UvAsset {
	url: string;
	archive: "tar.gz" | "zip";
}

export interface RuntimeManifest {
	uv: {
		version: string;
		base: string;
		assets: Record<string, UvAsset>;
	};
	python: {
		version: string;
		deps: string[];
	};
}

export interface RuntimeState {
	uvVersion: string;
	pythonVersion: string;
	depsHash: string;
}

export type StageCallback = (stage: string) => void;
export type Downloader = (url: string, dest: string, verifyUrl: string) => Promise<void>;

/** node platform/arch -> manifest asset key. */
export function platformKey(platform = process.platform, arch = process.arch): string | null {
	if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
	if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
	return null;
}

export function loadManifest(manifestPath: string): RuntimeManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (err) {
		throw new RuntimeError(`cannot read runtime manifest ${manifestPath}: ${err instanceof Error ? err.message : err}`);
	}
	const m = raw as RuntimeManifest;
	if (!m?.uv?.version || !m?.uv?.assets || !m?.python?.version || !Array.isArray(m.python.deps)) {
		throw new RuntimeError(`runtime manifest ${manifestPath} is malformed`);
	}
	return m;
}

export function depsHash(deps: string[]): string {
	return createHash("sha256").update(deps.join("|")).digest("hex").slice(0, 16);
}

export function stateMatches(state: RuntimeState | undefined, manifest: RuntimeManifest): boolean {
	if (!state) return false;
	return (
		state.uvVersion === manifest.uv.version &&
		state.pythonVersion === manifest.python.version &&
		state.depsHash === depsHash(manifest.python.deps)
	);
}

export interface RuntimeOptions {
	manifestPath: string;
	cacheDir?: string;
	onStage?: StageCallback;
	/** Replaceable for tests (default: HTTPS download + official .sha256 check). */
	download?: Downloader;
	/** Replaceable for tests (default: execFile). */
	run?: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
	/** Poll timeout for a concurrent bootstrap in progress. */
	concurrentTimeoutMs?: number;
}

export class RuntimeManager {
	private cacheDir: string;
	private manifest: RuntimeManifest;
	private onStage: StageCallback;
	private download: Downloader;
	private run: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
	private concurrentTimeoutMs: number;

	constructor(opts: RuntimeOptions) {
		this.manifest = loadManifest(opts.manifestPath);
		this.cacheDir = opts.cacheDir ?? join(process.env.PI_KERNEL_CACHE ?? join(homedir(), ".cache"), "pi-ipython-kernel");
		this.onStage = opts.onStage ?? (() => {});
		this.download = opts.download ?? downloadWithSha256;
		this.run = opts.run ?? ((cmd, args, env) => execFileP(cmd, args, { env: { ...process.env, ...env } }).then(() => undefined));
		this.concurrentTimeoutMs = opts.concurrentTimeoutMs ?? 5 * 60_000;
	}

	get manifestVersion(): string {
		return this.manifest.uv.version;
	}

	/** Absolute path of the managed venv python; throws RuntimeError on failure. */
	async ensure(): Promise<string> {
		const statePath = join(this.cacheDir, "state.json");
		const state = readState(statePath);
		if (stateMatches(state, this.manifest)) {
			const python = venvPython(this.cacheDir);
			if (existsSync(python)) {
				this.onStage("runtime ready (cached)");
				return python;
			}
		}

		// A concurrent bootstrap may be in progress (its temp dir exists).
		const deadline = Date.now() + this.concurrentTimeoutMs;
		while (hasBootstrapTemp(this.cacheDir)) {
			if (Date.now() > deadline) {
				throw new RuntimeError("another bootstrap appears stuck; remove the temp dir and retry");
			}
			// A temp dir whose owner died mid-bootstrap (SIGKILL, crash)
			// would block every later caller for the whole poll window;
			// reap it and bootstrap ourselves instead of waiting on a
			// process that can never finish.
			if (reapStaleBootstrapTemp(this.cacheDir)) {
				this.onStage("reaped orphaned bootstrap temp dir");
				break;
			}
			const winner = readState(statePath);
			if (stateMatches(winner, this.manifest) && existsSync(venvPython(this.cacheDir))) {
				this.onStage("runtime ready (concurrent bootstrap finished)");
				return venvPython(this.cacheDir);
			}
			await sleep(1_000);
		}

		// The temp dir may have just disappeared because a concurrent
		// bootstrap finished; re-check before bootstrapping ourselves.
		if (stateMatches(readState(statePath), this.manifest) && existsSync(venvPython(this.cacheDir))) {
			this.onStage("runtime ready (concurrent bootstrap finished)");
			return venvPython(this.cacheDir);
		}

		await this.bootstrap(statePath);
		return venvPython(this.cacheDir);
	}

	private async bootstrap(statePath: string): Promise<void> {
		const key = platformKey();
		if (!key) {
			throw new RuntimeError(`no runtime asset for platform ${process.platform}/${process.arch}`);
		}
		const asset = this.manifest.uv.assets[key];
		// Re-bootstrap (e.g. deps changed): clear stale artifacts first;
		// uv venv refuses to overwrite an existing venv.
		rmSync(join(this.cacheDir, "uv"), { recursive: true, force: true });
		rmSync(join(this.cacheDir, "venv"), { recursive: true, force: true });
		rmSync(join(this.cacheDir, "python"), { recursive: true, force: true });
		const tmp = join(this.cacheDir, `.tmp-${process.pid}`);
		mkdirSync(tmp, { recursive: true });
		try {
			// 1. uv binary
			this.onStage(`downloading uv ${this.manifest.uv.version}...`);
			const archive = join(tmp, `uv-${key}.${asset.archive === "zip" ? "zip" : "tar.gz"}`);
			await this.download(asset.url, archive, asset.url + ".sha256");
			this.onStage("extracting uv...");
			await extractArchive(archive, tmp, key, asset.archive);
			const uvBin = join(tmp, `uv-${key}`, process.platform === "win32" ? "uv.exe" : "uv");
			if (!existsSync(uvBin)) {
				throw new RuntimeError(`uv binary missing after extraction: ${uvBin}`);
			}

			// 2. python + venv + deps
			const env: Record<string, string> = {
				UV_PYTHON_INSTALL_DIR: join(this.cacheDir, "python"),
			};
			this.onStage(`installing python ${this.manifest.python.version}...`);
			await this.run(uvBin, ["python", "install", this.manifest.python.version], env);
			this.onStage("creating venv...");
			await this.run(uvBin, ["venv", "--python", this.manifest.python.version, join(this.cacheDir, "venv")], env);
			this.onStage(`installing kernel deps (${this.manifest.python.deps.join(", ")})...`);
			await this.run(uvBin, ["pip", "install", "--python", venvPython(this.cacheDir), ...this.manifest.python.deps], env);

			// 3. publish state atomically
			const finalUv = join(this.cacheDir, "uv");
			renameSync(join(tmp, `uv-${key}`), finalUv);
			writeState(statePath, {
				uvVersion: this.manifest.uv.version,
				pythonVersion: this.manifest.python.version,
				depsHash: depsHash(this.manifest.python.deps),
			});
			this.onStage("runtime ready");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------
// helpers

function venvPython(cacheDir: string): string {
	return process.platform === "win32"
		? join(cacheDir, "venv", "Scripts", "python.exe")
		: join(cacheDir, "venv", "bin", "python");
}

function readState(path: string): RuntimeState | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RuntimeState;
	} catch {
		return undefined;
	}
}

function writeState(path: string, state: RuntimeState): void {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(state, null, 2));
	renameSync(tmpPath, path);
}

function hasBootstrapTemp(cacheDir: string): boolean {
	if (!existsSync(cacheDir)) return false;
	try {
		return readdirSync(cacheDir).some((e) => e.startsWith(".tmp-"));
	} catch {
		return false;
	}
}

/** Remove bootstrap temp dirs whose owner process no longer exists.
 * Returns true when at least one was removed. Live owners are kept so
 * genuine concurrent bootstraps are still waited on (see ensure()). */
function reapStaleBootstrapTemp(cacheDir: string): boolean {
	if (!existsSync(cacheDir)) return false;
	let names: string[];
	try {
		names = readdirSync(cacheDir).filter((e) => e.startsWith(".tmp-"));
	} catch {
		return false;
	}
	let reaped = false;
	for (const name of names) {
		const pid = Number.parseInt(name.slice(".tmp-".length), 10);
		if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
			continue; // live owner: genuine concurrent bootstrap
		}
		try {
			rmSync(join(cacheDir, name), { recursive: true, force: true });
			reaped = true;
		} catch {
			// best effort; the poll loop re-checks next second
		}
	}
	return reaped;
}

function isProcessAlive(pid: number): boolean {
	// process.kill(pid, 0) probes existence without delivering a signal.
	// Works on Windows too (OpenProcess-based): a dead pid raises ESRCH.
	// Previously the win32 branch returned true unconditionally, which
	// left orphaned bootstrap temp dirs (owner killed mid-bootstrap) in
	// place forever — every later ensure() then stalled the full
	// concurrent-wait window before giving up.
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no such process (orphan). EPERM: exists but owned by
		// another user (still alive). Anything else: conservative "alive".
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function extractArchive(archive: string, dest: string, key: string, kind: "tar.gz" | "zip"): Promise<void> {
	if (process.platform === "win32" && kind === "zip") {
		// Two Windows bsdtar (tar.exe) problems: it rejects absolute
		// drive-letter paths (C:\... is read as a remote host) and it
		// cannot read the uv release zips (zip64/data-descriptor entries).
		// PowerShell Expand-Archive handles both. Unlike the mac/linux
		// tar.gz (top-level uv-<key>/ dir), the Windows zip has its
		// executables at the archive root — extract into uv-<key>/ so the
		// binary path below is uniform across platforms.
		const q = (p: string) => p.replaceAll("'", "''");
		await execFileP("powershell", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -LiteralPath '${q(archive)}' -DestinationPath '${q(join(dest, `uv-${key}`))}' -Force`,
		]);
		return;
	}
	// macOS/Linux ship tar (handles .tar.gz); run it with cwd=dest and the
	// archive by basename (relative) so drive-letter paths never appear.
	mkdirSync(dest, { recursive: true });
	await execFileP("tar", ["-xzf", basename(archive)], { cwd: dest });
	if (kind === "zip") {
		// bsdtar understands zip; on systems without it, fall back to unzip
		if (!existsSync(join(dest, `uv-${key}`))) {
			await execFileP("unzip", ["-q", basename(archive), "-d", dest]);
		}
	}
}

// A stalled download must not hang the bootstrap (and with it the first
// agent turn) forever: bound each attempt and retry a couple of times.
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_RETRIES = 2;

/** Download url to dest, then verify dest against the sha256 published at verifyUrl. */
export async function downloadWithSha256(url: string, dest: string, verifyUrl: string): Promise<void> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
		if (attempt > 0) await sleep(2_000 * attempt);
		try {
			await downloadOnce(url, dest, verifyUrl);
			return;
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw new RuntimeError(`download failed after ${DOWNLOAD_RETRIES + 1} attempts: ${url} -> ${lastErr.message}`);
}

async function downloadOnce(url: string, dest: string, verifyUrl: string): Promise<void> {
	const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!res.ok) {
		throw new RuntimeError(`download failed: ${url} -> HTTP ${res.status}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	const sum = createHash("sha256").update(buf).digest("hex");
	const check = await fetch(verifyUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!check.ok) {
		throw new RuntimeError(`cannot fetch checksum ${verifyUrl} -> HTTP ${check.status}`);
	}
	const expected = (await check.text()).trim().split(/\s+/)[0];
	if (expected.toLowerCase() !== sum) {
		throw new RuntimeError(`sha256 mismatch for ${url}: got ${sum}, expected ${expected}`);
	}
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, buf);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve_) => setTimeout(resolve_, ms));
}

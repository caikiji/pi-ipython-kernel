/**
 * Runtime bootstrap tests: manifest parsing, platform mapping, state
 * matching, and the full bootstrap sequence with a fake uv + fake
 * downloader (no network).
 */

import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "python/runtime.json");

const { RuntimeManager, RuntimeError, loadManifest, platformKey, depsHash, stateMatches } = await import("../src/runtime.ts");

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (err) {
		console.error(`FAIL - ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

// ------------------------------------------------------------- pure logic

await test("manifest: loads and validates", () => {
	const m = loadManifest(manifestPath);
	assert.equal(m.uv.version, "0.9.28");
	assert.ok(m.uv.assets["aarch64-apple-darwin"]);
	assert.ok(m.python.deps.includes("ipython"));
});

await test("manifest: malformed file rejected", () => {
	assert.throws(() => loadManifest("/nonexistent.json"), RuntimeError);
	const bad = join(mkdtempSync(join(tmpdir(), "rt-bad-")), "bad.json");
	writeFileSync(bad, "{}");
	assert.throws(() => loadManifest(bad), RuntimeError);
});

await test("platformKey: maps node platform/arch", () => {
	assert.equal(platformKey("darwin", "arm64"), "aarch64-apple-darwin");
	assert.equal(platformKey("darwin", "x64"), "x86_64-apple-darwin");
	assert.equal(platformKey("linux", "x64"), "x86_64-unknown-linux-gnu");
	assert.equal(platformKey("win32", "x64"), "x86_64-pc-windows-msvc");
	assert.equal(platformKey("freebsd", "x64"), null);
});

await test("stateMatches: version and deps hash", () => {
	const m = loadManifest(manifestPath);
	assert.equal(stateMatches(undefined, m), false);
	assert.equal(
		stateMatches({ uvVersion: "0.9.28", pythonVersion: "3.13", depsHash: depsHash(m.python.deps) }, m),
		true,
	);
	assert.equal(stateMatches({ uvVersion: "0.8.0", pythonVersion: "3.13", depsHash: depsHash(m.python.deps) }, m), false);
	assert.equal(
		stateMatches({ uvVersion: "0.9.28", pythonVersion: "3.13", depsHash: depsHash(["x"]) }, m),
		false,
	);
});

// ------------------------------------------------------------ bootstrap

function fakeWorkspace() {
	const wd = mkdtempSync(join(tmpdir(), "rt-ws-"));
	const key = platformKey() ?? "aarch64-apple-darwin";
	const uvDir = join(wd, `uv-${key}`);
	mkdirSync(uvDir, { recursive: true });
	const uv = join(uvDir, "uv");
	writeFileSync(uv, "#!/bin/sh\necho fake-uv \"$@\"\n");
	chmodSync(uv, 0o755);
	return { wd, key, uvDir, uv };
}

/** Create a manager whose downloader installs a fake uv tarball and whose
 * run() emulates uv's python/venv/pip commands. */
function makeManager(cacheDir, { onRun, downloader } = {}) {
	const calls = [];
	const ws = fakeWorkspace();
	return {
		calls,
		manager: new RuntimeManager({
			manifestPath,
			cacheDir,
			onStage: () => {},
			download: async (_url, dest) => {
				// copy the pre-built fake tarball into place
				const { execFileSync } = await import("node:child_process");
				execFileSync("tar", ["-czf", dest, "-C", ws.wd, `uv-${ws.key}`], { stdio: "ignore" });
			},
			run: async (cmd, args) => {
				calls.push([cmd, args]);
				if (args[0] === "python" && args[1] === "install") {
					mkdirSync(join(cacheDir, "python"), { recursive: true });
				} else if (args[0] === "venv") {
					const venvDir = join(cacheDir, "venv", "bin");
					mkdirSync(venvDir, { recursive: true });
					writeFileSync(join(venvDir, "python"), "#!/bin/sh\necho fake-python\n");
					chmodSync(join(venvDir, "python"), 0o755);
				} else if (args[0] === "pip") {
					// no-op
				}
				onRun?.(args);
			},
		}),
	};
}

await test("bootstrap: full sequence produces venv python + state.json", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "rt-cache-"));
	const { calls, manager } = makeManager(cacheDir);
	try {
		const python = await manager.ensure();
		assert.ok(python.endsWith(join("venv", "bin", "python")));
		assert.equal(existsSync(python), true);
		// sequence: python install -> venv -> pip install
		assert.deepEqual(calls.map(([c, a]) => a[0]), ["python", "venv", "pip"]);
		const pipArgs = calls[2][1];
		assert.deepEqual(pipArgs.slice(0, 3), ["pip", "install", "--python"]);
		assert.ok(pipArgs.includes("ipython"));
		// state recorded
		const state = JSON.parse(readFileSync(join(cacheDir, "state.json"), "utf-8"));
		assert.equal(state.uvVersion, "0.9.28");
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

await test("bootstrap: cached runtime is reused without rerunning uv", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "rt-cache-"));
	const { calls, manager } = makeManager(cacheDir);
	try {
		await manager.ensure();
		calls.length = 0;
		const python = await manager.ensure();
		assert.equal(calls.length, 0, "no uv calls on cached path");
		assert.ok(python.endsWith(join("venv", "bin", "python")));
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

await test("bootstrap: dependency change invalidates cache and reboots", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "rt-cache-"));
	const { manager } = makeManager(cacheDir);
	try {
		await manager.ensure();
		// tamper with the state to simulate a manifest change
		const statePath = join(cacheDir, "state.json");
		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		state.depsHash = "tampered";
		writeFileSync(statePath, JSON.stringify(state));
		const { calls, manager: m2 } = makeManager(cacheDir);
		await m2.ensure();
		assert.ok(calls.length > 0, "rebooted after dep change");
		const fresh = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(fresh.depsHash, depsHash(loadManifest(manifestPath).python.deps));
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

await test("bootstrap: concurrent temp dir is waited on, then reused", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "rt-cache-"));
	const { calls, manager } = makeManager(cacheDir);
	try {
		// Simulate another process mid-bootstrap: its temp dir exists. The
		// owner pid is this test process (alive), so it is a genuine
		// concurrent bootstrap, not an orphan.
		mkdirSync(join(cacheDir, `.tmp-${process.pid}`), { recursive: true });
		// While we poll, the "winner" finishes: artifacts + state.json appear.
		setTimeout(() => {
			const venvBin = join(cacheDir, "venv", "bin");
			mkdirSync(venvBin, { recursive: true });
			writeFileSync(join(venvBin, "python"), "#!/bin/sh\n");
			chmodSync(join(venvBin, "python"), 0o755);
			writeFileSync(
				join(cacheDir, "state.json"),
				JSON.stringify({
					uvVersion: "0.9.28",
					pythonVersion: "3.13",
					depsHash: depsHash(loadManifest(manifestPath).python.deps),
				}),
			);
			rmSync(join(cacheDir, `.tmp-${process.pid}`), { recursive: true, force: true });
		}, 1_500);
		const python = await manager.ensure();
		assert.ok(python.endsWith(join("venv", "bin", "python")));
		assert.equal(calls.length, 0, "reused the concurrent winner's runtime, no uv calls");
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

await test("bootstrap: orphaned temp dir is reaped, not waited on", async () => {
	// Windows cannot probe process liveness; the reaping path is POSIX-only.
	if (process.platform === "win32") {
		console.log("skip - orphan reaping is POSIX-only");
		return;
	}
	const cacheDir = mkdtempSync(join(tmpdir(), "rt-cache-"));
	const { calls, manager } = makeManager(cacheDir);
	try {
		// A bootstrap killed mid-run (SIGKILL/crash) leaves its temp dir
		// behind; the owner pid no longer exists. ensure() must reap the
		// orphan and bootstrap itself instead of polling for the full
		// 5-minute wait window. 2147483647 exceeds any real pid space.
		mkdirSync(join(cacheDir, ".tmp-2147483647"), { recursive: true });
		const python = await manager.ensure();
		assert.ok(python.endsWith(join("venv", "bin", "python")));
		assert.ok(calls.length > 0, "bootstrapped after reaping the orphan");
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

console.log(`\n${passed} tests passed`);

/**
 * Node integration tests for the TS layer: rpc client, kernel process
 * lifecycle (spawn/respawn/interrupt/shutdown), and output formatting.
 * Uses Node >=22.18 native type stripping to import .ts directly.
 *
 * Run: node tests/kernel.test.mjs   (or via tests/run-all.mjs)
 */

import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, "python/server.py");

const { JsonRpcClient } = await import("../src/rpc.ts");
const { KernelProcess } = await import("../src/kernelProcess.ts");
const { formatExecuteResult, truncate } = await import("../src/format.ts");

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

function workspace() {
	return mkdtempSync(resolve(tmpdir(), "kernel-test-"));
}

// ---------------------------------------------------------------- format

await test("format: plain output + diff", () => {
	const text = formatExecuteResult(
		{ output: "hi\n", error: "", incomplete: false, interrupted: false, new: [{ name: "x", type: "int" }], changed: ["y"], removed: [] },
		false,
	);
	assert.match(text, /OUTPUT:\nhi/);
	assert.match(text, /NAMESPACE new: x \(int\) \| changed: y/);
});

await test("format: error and truncation", () => {
	const text = formatExecuteResult(
		{ output: "a".repeat(50_000), error: "ZeroDivisionError", incomplete: false, interrupted: false, new: [], changed: [], removed: [] },
		false,
	);
	assert.match(text, /ERROR:\nZeroDivisionError/);
	assert.match(text, /truncated/);
});

await test("format: empty result", () => {
	const text = formatExecuteResult(
		{ output: "", error: "", incomplete: false, interrupted: false, new: [], changed: [], removed: [] },
		false,
	);
	assert.match(text, /OK: executed with no output/);
});

await test("truncate: short passthrough", () => {
	assert.equal(truncate("abc", 10), "abc");
	assert.ok(truncate("abcdef", 3).endsWith("... [truncated 3 chars]"));
});

// ------------------------------------------------------------ rpc client

await test("rpc: call roundtrip against real server", async () => {
	const { spawn } = await import("node:child_process");
	const proc = spawn("python3", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
	const client = new JsonRpcClient(proc);
	try {
		const hello = await client.call("hello", {}, { timeoutMs: 5_000 });
		assert.equal(hello.result.engine, "exec");
		const exec1 = await client.call("execute", { code: "v = 7" }, { timeoutMs: 5_000 });
		assert.deepEqual(exec1.result.new, [{ name: "v", type: "int" }]);
		const exec2 = await client.call("execute", { code: "v" }, { timeoutMs: 5_000 });
		assert.match(exec2.result.output, /7/);
	} finally {
		proc.kill("SIGKILL");
	}
});

await test("rpc: timeout fires onTimeout and late response resolves", async () => {
	const { spawn } = await import("node:child_process");
	const proc = spawn("python3", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
	const client = new JsonRpcClient(proc);
	let interrupted = false;
	try {
		await client.call("hello", {}, { timeoutMs: 5_000 });
		const call = client.call("execute", { code: "import time; time.sleep(5)" }, {
			timeoutMs: 300,
			graceMs: 4_000,
			onTimeout: () => {
				interrupted = true;
				proc.kill("SIGINT");
			},
		});
		const res = await call;
		assert.equal(interrupted, true, "onTimeout should have fired");
		assert.equal(res.timedOut, true);
		assert.equal(res.result.interrupted, true);
		// kernel still alive and serving
		const again = await client.call("execute", { code: "1 + 1" }, { timeoutMs: 5_000 });
		assert.match(again.result.output, /2/);
	} finally {
		proc.kill("SIGKILL");
	}
});

// ---------------------------------------------------------- kernel process

await test("kernel: lazy spawn, state persistence, respawn after kill", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		assert.equal(k.running, false, "lazy: not running before first use");
		let r = await k.execute("x = 41");
		assert.deepEqual(r.result.new, [{ name: "x", type: "int" }]);
		r = await k.execute("x += 1\nx");
		assert.match(r.result.output, /42/);
		assert.deepEqual(r.result.changed, ["x"], "x += 1 rebinds an int: new object, so changed")
		// kill the process: next call must auto-respawn with fresh state
		k.killSync();
		r = await k.execute("x"); // fresh kernel: NameError expected
		assert.match(r.result.error, /NameError/);
		assert.equal(r.result.new.length, 0);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: timeout interrupts (SIGINT) and kernel keeps serving", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		const r = await k.execute("import time\ntime.sleep(30)", 700);
		assert.equal(r.timedOut, true);
		assert.equal(r.result.interrupted, true);
		// still serving with state intact
		const again = await k.execute("x = 5");
		assert.deepEqual(again.result.new, [{ name: "x", type: "int" }]);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: crash of user code does not kill process", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		const r = await k.execute("raise ValueError('boom')");
		assert.match(r.result.error, /ValueError: boom/);
		assert.equal(r.result.interrupted, false);
		const again = await k.execute("ok = True");
		assert.deepEqual(again.result.new, [{ name: "ok", type: "bool" }]);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: graceful shutdown", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	await k.execute("x = 1");
	await k.shutdown();
	assert.equal(k.running, false);
	await k.shutdown(); // idempotent
	rmSync(wd, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed`);

/**
 * Node integration tests for the TS layer: rpc client, kernel process
 * lifecycle (spawn/respawn/interrupt/shutdown), and output formatting.
 * Uses Node >=22.18 native type stripping to import .ts directly.
 *
 * Run: node tests/kernel.test.mjs   (or via tests/run-all.mjs)
 */

import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, "python/server.py");
// Windows has no `python3` launcher; PI_KERNEL_PYTHON overrides either way.
const PY = process.env.PI_KERNEL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const { JsonRpcClient } = await import("../src/rpc.ts");
const { KernelProcess } = await import("../src/kernelProcess.ts");
const { formatExecuteResult, truncate, formatLs, formatGet, formatPublish, formatDelete, registryLine, formatRegistrySummary, formatReload } = await import("../src/format.ts");
const { checkInitHashes, rememberInitHashes, formatInitChanges } = await import("../src/initHashes.ts");
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

await test("format: ls with invalid flag", () => {
	const text = formatLs(
		[{ name: "x", type: "int" }],
		[{ name: "df", type: "DataFrame", version: 2, size: 1024, valid: false, invalid_reason: "source changed" }],
		[],
		false,
	);
	assert.match(text, /SESSION \(1\):/);
	assert.match(text, /x \(int\)/);
	assert.match(text, /df \(DataFrame\) v2, 1.0 KB/);
	assert.match(text, /INVALID: source changed/);
});

await test("format: ls with registered section", () => {
	const text = formatLs(
		[],
		[],
		[
			{ name: "load_sales", kind: "function", description: "Load sales data.", detail: "(path='sales.csv')", doc: "Load the sales CSV." },
			{ name: "raw_df", kind: "data", description: "Raw sales data.", detail: "DataFrame shape=(1200, 8)", doc: "" },
			{ name: "adder", kind: "callable", description: "Adds two numbers.", detail: "(a, b)", doc: "" },
		],
		false,
	);
	assert.match(text, /REGISTERED \(3\):/);
	assert.match(text, /\[fn\] load_sales\(path='sales\.csv'\) — Load sales data\./);
	assert.match(text, /\[data\] raw_df DataFrame shape=\(1200, 8\) — Raw sales data\./);
	assert.match(text, /\[call\] adder\(a, b\) — Adds two numbers\./);
});

await test("format: registered line falls back to doc", () => {
	assert.equal(
		registryLine({ name: "clean", kind: "function", description: "", detail: "(x)", doc: "Cleans input." }),
		"  [fn] clean(x) — Cleans input.",
	);
	assert.equal(registryLine({ name: "cfg", kind: "data", description: "", detail: "dict len=1", doc: "" }), "  [data] cfg dict len=1");
});

await test("format: registry summary", () => {
	const text = formatRegistrySummary([
		{ name: "load_sales", kind: "function", description: "Load sales data.", detail: "(path='sales.csv')", doc: "" },
	]);
	assert.match(text, /\[kernel\] Workspace kernel is ready/);
	assert.match(text, /load_sales\(path='sales\.csv'\) — Load sales data\./);
	assert.equal(formatRegistrySummary([]), "");
});

await test("format: reload report", () => {
	assert.equal(
		formatReload({ path: ".kernel/init.py", registered_added: ["b"], registered_removed: ["a"], vars_added: [], vars_removed: ["GONE"], vars_updated: ["VAR"] }),
		"[init] reloaded .kernel/init.py: +1 registered (b), -1 registered (a), -1 vars (GONE), 1 vars updated",
	);
	assert.equal(
		formatReload({ path: ".kernel/init.py", error: "Traceback (most recent call last):\nValueError: boom", registered_added: [], registered_removed: [], vars_added: [], vars_removed: [], vars_updated: [] }),
		"[init] reload FAILED .kernel/init.py: Traceback (most recent call last): — session untouched",
	);
	assert.equal(
		formatReload({ path: null, registered_added: [], registered_removed: ["a"], vars_added: [], vars_removed: [], vars_updated: [] }),
		"[init] reloaded (init script removed): -1 registered (a)",
	);
	assert.equal(
		formatReload({ path: ".kernel/init.py", registered_added: [], registered_removed: [], vars_added: [], vars_removed: [], vars_updated: [] }),
		"[init] reloaded .kernel/init.py: no changes",
	);
});

await test("initHashes: first-seen and change detection", () => {
	const dir = workspace();
	const statePath = join(dir, "hashes.json");
	mkdirSync(join(dir, ".kernel"));
	const init = join(dir, ".kernel", "init.py");
	writeFileSync(init, "def a():\n    return 1\n");
	// first session: firstSeen
	let changes = checkInitHashes(dir, statePath);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].firstSeen, true);
	assert.equal(changes[0].path, ".kernel/init.py");
	rememberInitHashes(dir, statePath);
	// unchanged: no notice
	assert.equal(checkInitHashes(dir, statePath).length, 0);
	// changed: notice with old -> new hashes
	writeFileSync(init, "def a():\n    return 2\n");
	changes = checkInitHashes(dir, statePath);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].firstSeen, false);
	assert.match(changes[0].previousHash ?? "", /^[0-9a-f]{64}$/);
	assert.match(formatInitChanges(changes), /CHANGED since last session: \.kernel\/init\.py \(/);
	rememberInitHashes(dir, statePath);
	assert.equal(checkInitHashes(dir, statePath).length, 0);
	// removed script: no longer tracked
	rmSync(init);
	assert.equal(checkInitHashes(dir, statePath).length, 0);
});

await test("format: get global loaded", () => {
	const text = formatGet({ name: "df", scope: "global", version: 3, loaded: true, summary: "DataFrame shape=(2,2)" });
	assert.match(text, /df \(global v3, loaded into session\)/);
	assert.match(text, /DataFrame shape=\(2,2\)/);
});

await test("format: get invalid suggests rebuild", () => {
	const text = formatGet({ name: "df", scope: "global", invalid: true, invalid_reason: "source file changed" });
	assert.match(text, /INVALID: df is stale/);
	assert.match(text, /force=true/);
});

await test("format: get full is truncated", () => {
	const text = formatGet({ name: "big", scope: "global", version: 1, full: "y".repeat(100_000) });
	assert.match(text, /truncated/);
});

await test("format: truncated output flagged", () => {
	const text = formatExecuteResult(
		{ output: "lots", error: "", incomplete: false, interrupted: false, output_truncated: true, new: [], changed: [], removed: [] },
		false,
	);
	assert.match(text, /output was truncated/);
});

await test("format: publish result", () => {
	assert.equal(formatPublish({ name: "cfg", version: 2, overwritten: true }), "OK: published cfg as v2 (overwrote a previous version)");
});

await test("format: delete result", () => {
	assert.equal(formatDelete({ name: "cfg", deleted: true, version: 2 }), "OK: deleted cfg (was v2)");
	assert.equal(formatDelete({ name: "cfg", deleted: false, version: null }), "OK: cfg is not in the global layer (nothing to delete)");
});

// ------------------------------------------------------------ rpc client

await test("rpc: call roundtrip against real server", async () => {
	const { spawn } = await import("node:child_process");
	const proc = spawn(PY, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
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
	const proc = spawn(PY, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
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
		if (process.platform === "win32") {
			// SIGINT cannot be delivered to a child process on Windows: the
			// process is terminated and the pending call is rejected
			// (see kernelProcess.ts: win32 timeout strategy is kill).
			await assert.rejects(call);
		} else {
			const res = await call;
			assert.equal(res.timedOut, true);
			assert.equal(res.result.interrupted, true);
			// kernel still alive and serving
			const again = await client.call("execute", { code: "1 + 1" }, { timeoutMs: 5_000 });
			assert.match(again.result.output, /2/);
		}
		assert.equal(interrupted, true, "onTimeout should have fired");
	} finally {
		proc.kill("SIGKILL");
	}
});

await test("rpc: dead process stdin write does not crash the host", async () => {
	const { spawn } = await import("node:child_process");
	const proc = spawn(PY, ["-c", "import sys; sys.exit(0)"], { stdio: ["pipe", "pipe", "inherit"] });
	const client = new JsonRpcClient(proc);
	// Wait for the child to die, then keep writing large payloads: without
	// the stdin 'error' listener this used to raise an unhandled EPIPE/EOF
	// 'error' event and crash the whole host process.
	await new Promise((res) => proc.on("exit", res));
	await assert.rejects(client.call("hello", {}, { timeoutMs: 1_000 }), (err) => err.name === "ProcessKilledError");
	for (let i = 0; i < 5; i++) {
		proc.stdin.write(JSON.stringify({ id: i, method: "execute", params: { code: "x".repeat(200_000) } }) + "\n");
	}
	// Surviving to this point is the assertion (an unhandled error would
	// have killed this test process).
	await new Promise((res) => setTimeout(res, 300));
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

await test("kernel: timeout reports TIMEOUT semantics on every platform", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		const r = await k.execute("import time\ntime.sleep(30)", 700);
		assert.equal(r.timedOut, true, "timed-out call must report timedOut, not throw");
		if (process.platform === "win32") {
			// SIGINT is not catchable on Windows: the timeout strategy is
			// kill + auto-respawn (see kernelProcess.ts), so the call has
			// no result and the next call respawns a fresh kernel.
			assert.equal(r.result, undefined);
		} else {
			// SIGINT interrupts the cell; the kernel keeps serving.
			assert.equal(r.result.interrupted, true);
		}
		// still serving (respawned on Windows) with state intact
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

// ---------------------------------------------------- global layer (M2)

await test("kernel: publish, ls, get full roundtrip", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("import pandas as pd\ndf = pd.DataFrame({'a': [1, 2], 'b': ['x', 'y']})");
		const pub = await k.call("publish", { name: "df", description: "demo frame" });
		assert.equal(pub.version, 1);
		assert.equal(pub.overwritten, false);
		const ls = await k.call("ls", { scope: "global" });
		assert.equal(ls.global.length, 1);
		assert.equal(ls.global[0].name, "df");
		assert.equal(ls.global[0].valid, true);
		// session has same-name df: explicit global get covers it
		const got = await k.call("get", { name: "df", scope: "global", summarize: true });
		assert.equal(got.scope, "global");
		assert.equal(got.loaded, true);
		assert.equal(got.covered_session, true);
		assert.match(got.summary, /DataFrame shape=\(2, 2\)/);
		// loaded object usable in the session
		const run = await k.execute("df.shape");
		assert.match(run.result.output, /\(2, 2\)/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: shadow semantics (session wins on auto)", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("v = {'session': 1}");
		await k.call("publish", { name: "v", description: "global copy" });
		const got = await k.call("get", { name: "v" });
		assert.equal(got.scope, "session");
		assert.equal(got.shadowed, true);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: stale source flags INVALID and blocks get", async () => {
	const wd = workspace();
	const src = resolve(wd, "data.csv");
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		writeFileSync(src, "a,b\n1,2\n");
		await k.execute(`rows = open(${JSON.stringify(src)}).read()`);
		await k.call("publish", { name: "rows", description: "raw csv text", source: src });
		writeFileSync(src, "a,b\n1,3\n");
		const ls = await k.call("ls", { scope: "global" });
		assert.equal(ls.global[0].valid, false);
		const got = await k.call("get", { name: "rows", scope: "global" });
		assert.equal(got.invalid, true);
		const forced = await k.call("get", { name: "rows", scope: "global", force: true });
		assert.equal(forced.invalid, undefined);
		assert.match(forced.summary, /a,b/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: publish rejects unsafe types and bad versions", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("f = lambda: 1");
		let err = await k.call("publish", { name: "f", description: "lambda" }).catch((e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /not publishable/);
		await k.execute("v = 1");
		await k.call("publish", { name: "v", description: "one" });
		err = await k.call("publish", { name: "v", description: "two", expected_version: 99 }).catch((e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /version conflict/);
		// missing description
		err = await k.call("publish", { name: "v", description: "" }).catch((e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /description is required/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: concurrent executes are serialized", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		// Fire two executes concurrently: the second must run after the
		// first (mutex queue), so it sees variables the first created.
		const [slow, fast] = await Promise.all([
			k.execute("import time\ntime.sleep(0.5)\nshared = 1"),
			k.execute("shared"),
		]);
		assert.equal(slow.result.error, "");
		assert.match(fast.result.output, /1/, "second call ran after the first and sees its variable");
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: failed execute does not poison the queue", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		const [bad, good] = await Promise.all([
			k.execute("raise ValueError('boom')"),
			k.execute("1 + 1"),
		]);
		assert.match(bad.result.error, /ValueError/);
		assert.match(good.result.output, /2/, "second call unaffected by the failed one");
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: init script registers names and reports", async () => {
	const wd = workspace();
	mkdirSync(join(wd, ".kernel"), { recursive: true });
	writeFileSync(
		join(wd, ".kernel", "init.py"),
		"@register('helper', description='Doubles x.')\ndef helper(x):\n    return x * 2\nregister('CONST', 42, 'The answer.')\n",
	);
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		const r = await k.execute("helper(CONST)");
		assert.match(r.result.output, /84/);
		assert.equal(k.initReport?.path, ".kernel/init.py");
		assert.ok(k.initReport?.registered.includes("helper"));
		assert.ok(k.initReport?.registered.includes("CONST"));
		assert.equal(k.initReport?.error, "");
		const ls = await k.call("ls", { scope: "session" });
		// registered names are usable and listed under REGISTERED, not SESSION
		assert.ok(ls.session.every((o) => o.name !== "helper"));
		assert.ok(ls.registered.some((e) => e.name === "helper" && e.kind === "function" && e.detail === "(x)"));
		assert.ok(ls.registered.some((e) => e.name === "CONST" && e.kind === "data"));
		const exec = await k.execute("helper(21)");
		assert.match(exec.result.output, /42/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: init script hot reloads on change without restart", async () => {
	const wd = workspace();
	mkdirSync(join(wd, ".kernel"), { recursive: true });
	const initPath = join(wd, ".kernel", "init.py");
	writeFileSync(initPath, "@register('helper', description='Doubles x.')\ndef helper(x):\n    return x * 2\nV = 10\n");
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		let r = await k.execute("helper(21) + V");
		assert.match(r.result.output, /52/);
		// rewrite the script: swap registration, update var
		writeFileSync(initPath, "@register('triple', description='Triples x.')\ndef triple(x):\n    return x * 3\nV = 20\n");
		const ls = await k.call("ls", { scope: "session" });
		assert.ok(ls.reload, "ls response carries the reload report");
		assert.equal(ls.reload.registered_added[0], "triple");
		assert.equal(ls.reload.registered_removed[0], "helper");
		assert.ok(ls.registered.some((e) => e.name === "triple" && e.kind === "function"));
		assert.ok(!ls.registered.some((e) => e.name === "helper"), "dropped registration is gone");
		// new code is live in the same process
		r = await k.execute("triple(V)");
		assert.match(r.result.output, /60/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: init script failure reported on hello", async () => {
	const wd = workspace();
	writeFileSync(join(wd, "kernel_init.py"), "raise ValueError('bad')");
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("1 + 1");
		assert.equal(k.initReport?.path, "kernel_init.py");
		assert.match(k.initReport?.error ?? "", /ValueError/);
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: two processes share the global layer (SQLite lock)", async () => {
	const wd = workspace();
	const k1 = new KernelProcess({ serverPath, cwd: wd });
	const k2 = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k1.execute("v = 1");
		await k1.call("publish", { name: "v", description: "from k1" });
		// k2 sees it (fresh read, WAL)
		const ls2 = await k2.call("ls", { scope: "global" });
		assert.equal(ls2.global.length, 1);
		assert.equal(ls2.global[0].name, "v");
		// k2 loads it into its own session
		const got2 = await k2.call("get", { name: "v", scope: "global" });
		assert.equal(got2.summary, "1");
		// k1 publishes again: version bumps, k2 sees it
		await k1.execute("v = 2");
		const pub2 = await k1.call("publish", { name: "v", description: "from k1 again" });
		assert.equal(pub2.version, 2);
		assert.equal(pub2.overwritten, true);
		const meta2 = await k2.call("ls", { scope: "global" });
		assert.equal(meta2.global[0].version, 2);
	} finally {
		await k1.shutdown();
		await k2.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: delete removes global object, idempotent, version resets", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("v = 1");
		await k.call("publish", { name: "v", description: "one" });
		await k.execute("v = 2");
		await k.call("publish", { name: "v", description: "two" });
		const del = await k.call("delete", { name: "v" });
		assert.equal(del.deleted, true);
		assert.equal(del.version, 2);
		const ls = await k.call("ls", { scope: "global" });
		assert.equal(ls.global.length, 0, "object gone from the global layer");
		// idempotent: second delete is not an error
		const del2 = await k.call("delete", { name: "v" });
		assert.equal(del2.deleted, false);
		assert.equal(del2.version, null);
		// re-publish starts at version 1
		const pub = await k.call("publish", { name: "v", description: "three" });
		assert.equal(pub.version, 1);
		assert.equal(pub.overwritten, false);
		// optimistic lock: mismatch refuses to delete
		const err = await k.call("delete", { name: "v", expected_version: 99 }).catch((e) => e);
		assert.ok(err instanceof Error);
		assert.match(err.message, /version conflict/);
		const ls2 = await k.call("ls", { scope: "global" });
		assert.equal(ls2.global.length, 1, "conflict must not delete");
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel: delete does not touch same-name session variable", async () => {
	const wd = workspace();
	const k = new KernelProcess({ serverPath, cwd: wd });
	try {
		await k.execute("v = 1");
		await k.call("publish", { name: "v", description: "global" });
		await k.call("delete", { name: "v" });
		const r = await k.execute("v");
		assert.match(r.result.output, /1/, "session variable survives global delete");
	} finally {
		await k.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});
// ---------------------------------------------------------- kernel session

const { KernelSession } = await import("../src/kernelSession.ts");

await test("kernel session: concurrent first calls share one process", async () => {
	const wd = workspace();
	// Missing manifest: runtime bootstrap fails fast, session falls back
	// to the system python3 (hermetic, no downloads).
	const session = new KernelSession({ serverPath, manifestPath: resolve(wd, "no-manifest.json") });
	try {
		// First use from parallel callers (one message, several tool calls):
		// all must resolve to the SAME process. The pre-fix getKernel had a
		// check-then-act race across the async runtime resolution, spawning
		// one process per caller and losing all but the last one's state.
		const [k1, k2, k3] = await Promise.all([session.get(wd), session.get(wd), session.get(wd)]);
		assert.ok(k1 === k2 && k2 === k3, "all parallel callers share one KernelProcess");
		// State created through one caller is visible through the others.
		const created = await k1.execute("shared = 'visible'");
		assert.equal(created.result.error, "");
		const read = await k2.execute("shared");
		assert.match(read.result.output, /visible/, "state set via one caller is visible via another");
		const again = await session.get(wd);
		assert.ok(again === k1, "subsequent calls keep the same process");
	} finally {
		await session.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

await test("kernel session: cwd change rebuilds and kills the old kernel", async () => {
	const wd1 = workspace();
	const wd2 = workspace();
	const session = new KernelSession({ serverPath, manifestPath: resolve(wd1, "no-manifest.json") });
	try {
		const k1 = await session.get(wd1);
		await k1.execute("x = 1");
		const k2 = await session.get(wd2);
		assert.notEqual(k2, k1, "different cwd -> different process");
		assert.equal(k1.running, false, "old workspace kernel is killed on rebuild");
		const r = await k2.execute("x"); // fresh process, no x
		assert.match(r.result.error, /NameError/);
	} finally {
		await session.shutdown();
		rmSync(wd1, { recursive: true, force: true });
		rmSync(wd2, { recursive: true, force: true });
	}
});

await test("kernel session: fallback warning reported once", async () => {
	const wd = workspace();
	const session = new KernelSession({ serverPath, manifestPath: resolve(wd, "no-manifest.json") });
	try {
		await session.get(wd);
		assert.match(session.warningText(), /managed python bootstrap failed/);
		assert.equal(session.warningText(), "", "warning is shown exactly once");
	} finally {
		await session.shutdown();
		rmSync(wd, { recursive: true, force: true });
	}
});

console.log(`\n${passed} tests passed`);

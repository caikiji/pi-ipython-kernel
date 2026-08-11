/**
 * Test runner: Python (unittest) + Node (type-stripped .ts imports).
 * Run: npm test   (i.e. node tests/run-all.mjs)
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Windows has no `python3` launcher; PI_KERNEL_PYTHON overrides either way.
const py = process.env.PI_KERNEL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const r = spawnSync(py, ["-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"], {
	cwd: root,
	stdio: "inherit",
});
if (r.status !== 0) process.exit(1);
console.log("\n=== Python tests passed ===\n");

await import("./kernel.test.mjs");
await import("./runtime.test.mjs");

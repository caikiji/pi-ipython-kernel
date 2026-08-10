/**
 * Test runner: Python (unittest) + Node (type-stripped .ts imports).
 * Run: npm test   (i.e. node tests/run-all.mjs)
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
	execSync("python3 -m unittest discover -s tests/python -p 'test_*.py'", {
		cwd: root,
		stdio: "inherit",
	});
	console.log("\n=== Python tests passed ===\n");
} catch {
	process.exit(1);
}

await import("./kernel.test.mjs");
await import("./runtime.test.mjs");

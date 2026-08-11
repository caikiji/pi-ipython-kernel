/**
 * MCP layer tests: framing unit tests + a full end-to-end run of
 * mcp/server.ts over real stdio (hermetic: system python via
 * PI_KERNEL_PYTHON, temp workspace, no downloads).
 *
 * Run: node tests/mcp.test.mjs   (or via tests/run-all.mjs)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { FrameParser, McpProtocol, encodeFrame } = await import("../src/mcp.ts");

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

// ------------------------------------------------------------ framing

await test("mcp: frame encode/decode roundtrip", () => {
	const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };
	const frame = encodeFrame(msg);
	const header = frame.subarray(0, frame.indexOf("\r\n\r\n") + 4).toString("ascii");
	assert.match(header, /^Content-Length: \d+\r\n\r\n$/);
	assert.deepEqual(new FrameParser().push(frame), [msg]);
});

await test("mcp: parser handles split chunks and multiple frames", () => {
	const a = encodeFrame({ jsonrpc: "2.0", id: 1, result: 1 });
	const b = encodeFrame({ jsonrpc: "2.0", id: 2, result: 2 });
	const parser = new FrameParser();
	// header split across chunks, body split, both frames in one chunk
	const all = Buffer.concat([a, b]);
	assert.deepEqual(parser.push(all.subarray(0, 10)), []);
	assert.deepEqual(parser.push(all.subarray(10, 40)), []);
	assert.deepEqual(parser.push(all.subarray(40)), [JSON.parse(a.subarray(a.indexOf("\r\n\r\n") + 4).toString()), JSON.parse(b.subarray(b.indexOf("\r\n\r\n") + 4).toString())]);
});

await test("mcp: parser rejects bad headers and oversized bodies", () => {
	assert.throws(() => new FrameParser().push(Buffer.from("Nope: 1\r\n\r\n{}")), /invalid MCP frame header/);
	assert.throws(() => new FrameParser().push(Buffer.from(`Content-Length: ${300 * 1024 * 1024}\r\n\r\n`)), /too large/);
});

// ------------------------------------------------------------ protocol

const makeProtocol = () =>
	new McpProtocol({
		tools: [
			{
				name: "echo",
				inputSchema: { type: "object", properties: { s: { type: "string" } } },
				handler: async (args) => ({ content: [{ type: "text", text: String(args.s ?? "") }] }),
			},
			{
				name: "boom",
				inputSchema: {},
				handler: async () => {
					throw new Error("kaboom");
				},
			},
		],
		resources: [
			{
				uri: "kernel://registry",
				name: "registry",
				read: async () => "REGISTERED: none",
			},
		],
		serverInfo: { name: "test", version: "0.0.0" },
	});

await test("mcp: initialize negotiates protocol version", async () => {
	const p = makeProtocol();
	const init = await p.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {} } });
	assert.equal(init.result.protocolVersion, "2025-03-26");
	assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });
	// unknown client version falls back to the baseline
	const p2 = makeProtocol();
	const init2 = await p2.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-99-99" } });
	assert.equal(init2.result.protocolVersion, "2024-11-05");
});

await test("mcp: requests before initialize are rejected (ping exempt)", async () => {
	const p = makeProtocol();
	const r = await p.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	assert.equal(r.error.code, -32600);
	const ping = await p.handle({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
	assert.deepEqual(ping.result, {});
});

await test("mcp: tools/list and tools/call", async () => {
	const p = makeProtocol();
	await p.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
	const list = await p.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	assert.deepEqual(list.result.tools.map((t) => t.name), ["echo", "boom"]);
	const call = await p.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { s: "hi" } } });
	assert.equal(call.result.content[0].text, "hi");
	assert.equal(call.result.isError, undefined);
	// unknown tool -> method not found; throwing handler -> isError result
	const unknown = await p.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
	assert.equal(unknown.error.code, -32601);
	const boom = await p.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } });
	assert.equal(boom.result.isError, true);
	assert.match(boom.result.content[0].text, /kaboom/);
});

await test("mcp: resources list/read and notifications", async () => {
	const p = makeProtocol();
	await p.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
	const list = await p.handle({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} });
	assert.equal(list.result.resources[0].uri, "kernel://registry");
	const read = await p.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "kernel://registry" } });
	assert.match(read.result.contents[0].text, /REGISTERED/);
	// notifications produce no response
	const note = await p.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
	assert.equal(note, undefined);
});

// ------------------------------------------------------------ end-to-end

await test("mcp: full server roundtrip over stdio", async () => {
	const wd = mkdtempSync(join(tmpdir(), "mcp-ws-"));
	writeFileSync(join(wd, "kernel_init.py"), "register('add', lambda a, b: a + b, 'add two numbers')\n");
	// Hermetic: system python (PI_KERNEL_PYTHON), no managed downloads.
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", resolve(root, "mcp/server.ts")],
		{ cwd: wd, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PI_KERNEL_PYTHON: process.platform === "win32" ? "python" : "python3" } },
	);
	const parser = new FrameParser();
	const pending = new Map();
	let nextId = 1;
	child.stdout.on("data", (chunk) => {
		for (const msg of parser.push(chunk)) {
			const p = pending.get(msg.id);
			if (p) {
				pending.delete(msg.id);
				p(msg);
			}
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve_) => {
			const id = nextId++;
			pending.set(id, resolve_);
			child.stdin.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
		});
	const notify = (method, params = {}) => {
		child.stdin.write(encodeFrame({ jsonrpc: "2.0", method, params }));
	};
	try {
		const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
		assert.equal(init.result.serverInfo.name, "pi-ipython-kernel");
		notify("notifications/initialized", {});

		const list = await send("tools/list", {});
		assert.deepEqual(list.result.tools.map((t) => t.name), ["kernel_run", "kernel_ls", "kernel_get", "kernel_publish", "kernel_delete"]);

		const run = await send("tools/call", { name: "kernel_run", arguments: { code: "x = 42\nimport sys\n'hello mcp on ' + sys.version.split()[0]" } });
		assert.match(run.result.content[0].text, /hello mcp on/);

		// init script registered via kernel_init.py in the workspace cwd
		const ls = await send("tools/call", { name: "kernel_ls", arguments: { scope: "session" } });
		assert.match(ls.result.content[0].text, /add/);

		const pub = await send("tools/call", { name: "kernel_publish", arguments: { name: "x", description: "test object" } });
		assert.match(pub.result.content[0].text, /published x as v1/);

		const res = await send("resources/read", { uri: "kernel://registry" });
		assert.match(res.result.contents[0].text, /add two numbers/);

		// concurrent calls are safe (session.get is race-free)
		const [r1, r2] = await Promise.all([
			send("tools/call", { name: "kernel_run", arguments: { code: "y = 1" } }),
			send("tools/call", { name: "kernel_run", arguments: { code: "y + 1" } }),
		]);
		assert.match(r2.result.content[0].text, /2/);
	} finally {
		child.stdin.end();
		await new Promise((resolve_) => child.on("exit", resolve_));
	}
	rmSync(wd, { recursive: true, force: true });
});

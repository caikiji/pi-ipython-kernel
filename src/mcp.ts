/**
 * Minimal Model Context Protocol server layer (2024-11-05 / 2025-03-26
 * compatible subset), hand-rolled on purpose: the repo runs zero-dependency
 * (tests import .ts directly, no npm install), and the surface we need is
 * small — framing + initialize + tools/list + tools/call + resources +
 * ping. The kernel itself already speaks newline-delimited JSON-RPC on
 * stdio, so this layer only adapts the MCP envelope around the same
 * KernelSession the pi extension uses.
 *
 * Pure Node: no pi imports, testable directly.
 */

export interface McpContent {
	type: "text";
	text: string;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	handler: (args: Record<string, unknown>) => Promise<{ content: McpContent[]; isError?: boolean }>;
}

export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	read: () => Promise<string>;
}

export interface McpServerOptions {
	tools: McpTool[];
	resources?: McpResource[];
	serverInfo: { name: string; version: string };
}

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26"]);

// ---------------------------------------------------------------------------
// stdio framing (LSP-style Content-Length headers, UTF-8 JSON bodies)

/** Encode one message into an MCP stdio frame. */
export function encodeFrame(msg: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(msg), "utf-8");
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
		body,
	]);
}

/** Incremental frame parser: feed chunks, get complete messages out. */
export class FrameParser {
	private buf = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
		const out: unknown[] = [];
		for (;;) {
			const headerEnd = this.buf.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				// Headers not complete yet; guard against a runaway header.
				if (this.buf.length > 64 * 1024) throw new Error("MCP frame header too large");
				return out;
			}
			const header = this.buf.subarray(0, headerEnd).toString("ascii");
			const m = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
			if (!m) throw new Error(`invalid MCP frame header: ${header}`);
			const length = Number.parseInt(m[1], 10);
			if (length > 256 * 1024 * 1024) throw new Error(`MCP frame body too large: ${length}`);
			if (this.buf.length < headerEnd + 4 + length) return out; // wait for the rest
			const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + length);
			this.buf = this.buf.subarray(headerEnd + 4 + length);
			try {
				out.push(JSON.parse(body.toString("utf-8")));
			} catch (err) {
				throw new Error(`invalid MCP frame JSON: ${err instanceof Error ? err.message : err}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatch over the MCP method surface

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;

export class McpProtocol {
	private tools: Map<string, McpTool>;
	private resources: McpResource[];
	private serverInfo: { name: string; version: string };
	private negotiatedVersion = "2024-11-05";
	private initialized = false;

	constructor(opts: McpServerOptions) {
		this.tools = new Map(opts.tools.map((t) => [t.name, t]));
		this.resources = opts.resources ?? [];
		this.serverInfo = opts.serverInfo;
	}

	/**
	 * Handle one decoded message. Returns the response object to encode and
	 * send, or undefined for notifications (no response expected).
	 */
	async handle(msg: unknown): Promise<unknown | undefined> {
		if (typeof msg !== "object" || msg === null) {
			return errorResponse(undefined, ERR_INVALID_REQUEST, "invalid request");
		}
		const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
		if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
			return errorResponse(req.id, ERR_INVALID_REQUEST, "invalid request");
		}
		const isNotification = req.id === undefined;
		const method = req.method;
		const params = (req.params ?? {}) as Record<string, unknown>;

		if (!isNotification && method !== "initialize" && !this.initialized) {
			// The spec requires initialize to be the first request; be
			// lenient about a couple of well-known probes, reject the rest.
			if (method !== "ping") {
				return errorResponse(req.id, ERR_INVALID_REQUEST, "server not initialized");
			}
		}

		try {
			switch (method) {
				case "initialize":
					return this.initialize(req, params);
				case "notifications/initialized":
					this.initialized = true;
					return undefined;
				case "ping":
					return isNotification ? undefined : successResponse(req.id, {});
				case "tools/list":
					if (isNotification) return undefined;
					return successResponse(req.id, {
						tools: [...this.tools.values()].map((t) => ({
							name: t.name,
							description: t.description,
							inputSchema: t.inputSchema,
						})),
					});
				case "tools/call": {
					if (isNotification) return undefined;
					const name = String(params.name ?? "");
					const tool = this.tools.get(name);
					if (!tool) {
						return errorResponse(req.id, ERR_METHOD_NOT_FOUND, `unknown tool: ${name}`);
					}
					const args = (params.arguments ?? {}) as Record<string, unknown>;
					if (typeof args !== "object" || args === null) {
						return errorResponse(req.id, ERR_INVALID_REQUEST, "tool arguments must be an object");
					}
					try {
						const result = await tool.handler(args);
						return successResponse(req.id, result);
					} catch (err) {
						return successResponse(req.id, {
							content: [{ type: "text", text: `tool error: ${err instanceof Error ? err.message : String(err)}` }],
							isError: true,
						});
					}
				}
				case "resources/list":
					if (isNotification) return undefined;
					return successResponse(req.id, {
						resources: this.resources.map((r) => ({
							uri: r.uri,
							name: r.name,
							description: r.description,
							mimeType: r.mimeType,
						})),
					});
				case "resources/read": {
					if (isNotification) return undefined;
					const uri = String(params.uri ?? "");
					const res = this.resources.find((r) => r.uri === uri);
					if (!res) {
						return errorResponse(req.id, ERR_INTERNAL, `unknown resource: ${uri}`);
					}
					const text = await res.read();
					return successResponse(req.id, {
						contents: [{ uri, mimeType: res.mimeType ?? "text/plain", text }],
					});
				}
				default:
					return errorResponse(req.id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
			}
		} catch (err) {
			return errorResponse(req.id, ERR_INTERNAL, err instanceof Error ? err.message : String(err));
		}
	}

	private initialize(req: { id?: unknown }, params: Record<string, unknown>): unknown {
		const requested = String(params.protocolVersion ?? "");
		// Echo the client's version when we know it, else our baseline.
		this.negotiatedVersion = PROTOCOL_VERSIONS.has(requested) ? requested : "2024-11-05";
		this.initialized = true;
		return successResponse(req.id, {
			protocolVersion: this.negotiatedVersion,
			capabilities: { tools: {}, resources: {} },
			serverInfo: this.serverInfo,
		});
	}
}

function successResponse(id: unknown, result: unknown): unknown {
	return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: unknown, code: number, message: string): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// stdio loop: wire raw stdin -> parser -> protocol -> stdout.

/**
 * Run the protocol over raw stdio with incremental frame parsing. The
 * MCP frame format is header-delimited (Content-Length), not line-based,
 * so we read raw chunks and parse frames ourselves. Resolves when stdin
 * closes (client gone); onClose then runs (kernel shutdown).
 */
export async function runStdio(protocol: McpProtocol, onClose?: () => Promise<void> | void): Promise<void> {
	// A client that disconnects mid-write fails stdout with EPIPE; without
	// a listener that is an unhandled 'error' event and crashes the server.
	process.stdout.on("error", () => {});
	const parser = new FrameParser();
	const done = new Promise<void>((resolve_) => {
		process.stdin.on("end", resolve_);
		process.stdin.on("close", resolve_);
	});
	for await (const chunk of process.stdin) {
		let messages: unknown[];
		try {
			messages = parser.push(chunk as Buffer);
		} catch (err) {
			process.stdout.write(encodeFrame({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } }));
			break;
		}
		for (const msg of messages) {
			const resp = await protocol.handle(msg);
			if (resp !== undefined) {
				process.stdout.write(encodeFrame(resp));
			}
		}
	}
	await done;
	await onClose?.();
}

/**
 * Formatting of kernel execution results for the LLM-facing tool output.
 * Pure Node: no pi imports, testable directly.
 */

import type { ExecuteResult } from "./kernelProcess.ts";

/** Max characters of captured stdout/stderr included in the response. */
export const MAX_OUTPUT = 40_000;

export interface RunSummary {
	output: string;
	error: string;
	incomplete: boolean;
	interrupted: boolean;
	timedOut: boolean;
	new: Array<{ name: string; type: string }>;
	changed: string[];
	removed: string[];
}

export function formatExecuteResult(result: ExecuteResult, timedOut: boolean): string {
	const parts: string[] = [];

	if (result.error) {
		parts.push("ERROR:\n" + truncate(result.error.trimEnd(), MAX_OUTPUT));
	}
	if (result.incomplete) {
		parts.push("INCOMPLETE: the code is syntactically incomplete (e.g. an unterminated block).");
	}
	if (result.interrupted) {
		parts.push("INTERRUPTED: execution was interrupted (KeyboardInterrupt).");
	}
	if (timedOut && !result.interrupted) {
		parts.push("TIMEOUT: the code did not finish within the timeout and the kernel was interrupted.");
	}
	if (result.output_truncated) {
		parts.push("NOTE: output was truncated because it exceeded the size limit.");
	}
	if (result.output) {
		parts.push("OUTPUT:\n" + truncate(result.output.trimEnd(), MAX_OUTPUT));
	}

	const diff: string[] = [];
	if (result.new.length > 0) {
		diff.push("new: " + result.new.map((n) => `${n.name} (${n.type})`).join(", "));
	}
	if (result.changed.length > 0) {
		diff.push("changed: " + result.changed.join(", "));
	}
	if (result.removed.length > 0) {
		diff.push("removed: " + result.removed.join(", "));
	}
	if (diff.length > 0) {
		parts.push("NAMESPACE " + diff.join(" | "));
	}

	if (parts.length === 0) {
		parts.push("OK: executed with no output and no namespace changes.");
	}
	return parts.join("\n\n");
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}

// ------------------------------------------------------------ ls / get / publish

export interface LsEntry {
	name: string;
	type: string;
	size?: number;
	version?: number;
	description?: string;
	created_at?: string;
	valid?: boolean;
	invalid_reason?: string | null;
	"source_path"?: string | null;
}

export interface RegistryEntry {
	name: string;
	kind: "function" | "callable" | "data";
	description: string;
	detail: string;
	doc: string;
}

export function formatLs(session: LsEntry[], global: LsEntry[], registered: RegistryEntry[], detail: boolean): string {
	const parts: string[] = [];
	if (session.length === 0 && global.length === 0 && registered.length === 0) {
		return "No objects. Define some with kernel_run, or load with kernel_get.";
	}
	if (session.length > 0) {
		parts.push(`SESSION (${session.length}):` + lines(session.map((o) => lsLine(o, detail, "session"))));
	}
	if (registered.length > 0) {
		parts.push(`REGISTERED (${registered.length}):` + lines(registered.map(registryLine)));
	}
	if (global.length > 0) {
		parts.push(`GLOBAL (${global.length}):` + lines(global.map((o) => lsLine(o, detail, "global"))));
	}
	return parts.join("\n\n");
}

/** One line per registered entry, e.g.
 * `  [fn]   load_sales(path='sales.csv') — Load sales data as DataFrame.` */
export function registryLine(e: RegistryEntry): string {
	const kind = e.kind === "function" ? "fn" : e.kind === "callable" ? "call" : "data";
	// Signatures start with "(" and read naturally glued to the name
	// (load_sales(path=...)); structural summaries need a separator.
	const sep = e.detail.startsWith("(") ? "" : " ";
	const head = `  [${kind}] ${e.name}${e.detail ? sep + e.detail : ""}`;
	const note = e.description || e.doc;
	return note ? `${head} — ${note}` : head;
}

/** Compact summary of the registry for agent-start injection. */
export function formatRegistrySummary(registered: RegistryEntry[]): string {
	if (registered.length === 0) return "";
	return (
		"[kernel] Workspace kernel is ready. Registered callables/data (replayed from the init script on every session start; call them directly with kernel_run):\n" +
		registered.map(registryLine).join("\n")
	);
}

function lsLine(o: LsEntry, detail: boolean, scope: string): string {
	let line = `  ${o.name} (${o.type})`;
	if (scope === "global" && o.version !== undefined) {
		line += ` v${o.version}${o.size !== undefined ? `, ${fmtSize(o.size)}` : ""}`;
	}
	if (o.valid === false) {
		line += `  [INVALID: ${o.invalid_reason ?? "stale"}]`;
	}
	if (detail) {
		if (o.description) line += `\n      desc: ${o.description}`;
		if (o.created_at) line += `\n      created: ${o.created_at}`;
		if (o["source_path"]) line += `\n      source: ${o["source_path"]}`;
	}
	return line;
}

export interface GetResult {
	name: string;
	scope: "session" | "global";
	type?: string;
	version?: number;
	summary?: string;
	full?: string;
	loaded?: boolean;
	shadowed?: boolean;
	invalid?: boolean;
	invalid_reason?: string | null;
	valid?: boolean;
}

export function formatGet(r: GetResult): string {
	if (r.invalid) {
		return `INVALID: ${r.name} is stale (${r.invalid_reason}). Rebuild it from its source and re-publish with kernel_publish, or pass force=true to retrieve the old data explicitly.`;
	}
	const head = r.scope === "session" ? `${r.name} (session, ${r.type ?? "?"}` : `${r.name} (global v${r.version ?? "?"}`;
	const flags: string[] = [];
	if (r.scope === "global" && r.loaded) flags.push("loaded into session");
	if (r.shadowed) flags.push("shadows a global object with the same name");
	const parts = [`${head}${flags.length > 0 ? ", " + flags.join(", ") : ""})`];
	if (r.summary) parts.push(r.summary);
	if (r.full) parts.push(`FULL:\n${truncate(r.full, MAX_OUTPUT)}`);
	return parts.join("\n\n");
}

export function formatPublish(r: { name: string; version: number; overwritten: boolean }): string {
	return `OK: published ${r.name} as v${r.version}${r.overwritten ? " (overwrote a previous version)" : ""}`;
}

export interface DeleteResult {
	name: string;
	deleted: boolean;
	version?: number | null;
}

export function formatDelete(r: DeleteResult): string {
	if (!r.deleted) {
		return `OK: ${r.name} is not in the global layer (nothing to delete)`;
	}
	return `OK: deleted ${r.name} (was v${r.version ?? "?"})`;
}

function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function lines(items: string[]): string {
	return "\n" + items.join("\n");
}

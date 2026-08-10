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

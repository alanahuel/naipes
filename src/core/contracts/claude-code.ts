/**
 * Claude Code subscription connection (local, personal use). Naipes
 * never sees Claude credentials: it drives the user's own installed
 * `claude` CLI, which owns sign-in. See src/agent/claude-code-stream.ts.
 */
export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_LABEL = "Claude Code";
/** Current family only (owner decision, 2026-11-01). */
export const CLAUDE_CODE_MODEL_IDS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export interface ClaudeCodeStatus {
	/** The `claude` executable was found. */
	installed: boolean;
	/** `claude auth status` reports a claude.ai (subscription) sign-in. */
	connected: boolean;
	email: string | null;
	/** e.g. "max", "pro". */
	plan: string | null;
	allowBackgroundUse: boolean;
	error: string | null;
}

export type ClaudeCodeAction = "refresh" | "login" | "logout" | "consent";

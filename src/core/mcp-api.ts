/**
 * THE MCP WRITE API CONTRACT (owner, 2026-11-08) — pure, shared by the
 * listener inside the Naipes server (src/server/mcp-api.ts) and the MCP
 * stdio server's client (src/mcp/api.ts).
 *
 * The listener binds 127.0.0.1:<port> while Settings → «Conexión MCP» is
 * on (off by default). Every request carries `Authorization: Bearer
 * <token>`; the token lives in the keys file (outside data/) and reaches
 * the MCP client through its configuration's environment (MCP_TOKEN_ENV).
 * Browsers are refused outright (any Origin header → 403).
 */

import type { McpSettings } from "./settings.ts";

export const MCP_API_DEFAULT_PORT = 47801;
export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;

/** The MCP client's environment variable carrying the token. */
export const MCP_TOKEN_ENV = "NAIPES_MCP_TOKEN";
/** The keys-file (auth.json) entry holding the token. Not a catalog key:
 *  never shown in the Keys page, never reflected into process.env. */
export const MCP_TOKEN_AUTH_VAR = "NAIPES_MCP_TOKEN";

/** Request bodies above this are refused (a material file rides base64). */
export const MCP_API_MAX_BODY_BYTES = 90 * 1024 * 1024;

export const isMcpPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MCP_PORT_MIN && v <= MCP_PORT_MAX;

export function mcpApiEnabled(settings: McpSettings | undefined): boolean {
	return settings?.enabled === true;
}

export function mcpApiPort(settings: McpSettings | undefined): number {
	return isMcpPort(settings?.port) ? settings.port : MCP_API_DEFAULT_PORT;
}

export type ExamAgent = "map" | "classify" | "research" | "guide" | "contrast";
export const EXAM_AGENTS: readonly ExamAgent[] = ["map", "classify", "research", "guide", "contrast"];

/** A session the MCP created: it opens with `opening` the first time the
 *  learner opens it in the app (persisted as ChatRecord.pendingOpening). */
export interface McpCreatedSession {
	id: string;
	title: string;
}

/** An exam's computed plan, compacted for a model (GET /v1/exams/:id). */
export interface McpExamPlan {
	daysLeft: number;
	coverage: number | null;
	reachedPreset: string | null;
	meetsStandard: boolean;
	infeasible: { shortfall: number; extraPerDay: number; bestPreset: string | null } | null;
	todayMinutes: number;
	startedToday: boolean;
	today: Array<{ kind: string; minutes: number; pointId: string | null; ideas: number; short: boolean }>;
	upcoming: Array<{ day: string; minutes: number }>;
	minutesStillNeeded: { placement: number; teach: number; practice: number; review: number; total: number } | null;
	weeklyMinutes: number[];
}

/** One inbox note (GET /v1/inbox), the app's live view. */
export interface McpInboxItem {
	path: string;
	status: string;
	suggestion: { folder: string; ideas: number } | null;
	alternatives: Array<{ folder: string; ideas: number }>;
}

// ─── deletions (phase 3): requested by the MCP, confirmed in the app ────────

/** How long a deletion request waits for the learner's answer. */
export const MCP_DELETION_TIMEOUT_MS = 120_000;

export type McpDeletionKind = "session" | "exam" | "proposition";
export const MCP_DELETION_KINDS: readonly McpDeletionKind[] = ["session", "exam", "proposition"];

/** One pending request, as the app's confirmation dialog shows it. */
export interface McpDeletionView {
	id: string;
	kind: McpDeletionKind;
	targetId: string;
	/** The session/exam title or the proposition's name. */
	label: string;
	/** The MCP client's name («claude-code»…), as it introduced itself. */
	client: string;
	/** Sessions: the model's suggestion for «also remove its graph traces»
	 *  — the dialog's checkbox starts there; the learner decides. */
	suggestTraces: boolean;
	expiresAt: number;
}

export type McpDeletionOutcome =
	| { outcome: "deleted"; removedGraphTraces?: boolean }
	| { outcome: "rejected" }
	| { outcome: "timeout" };

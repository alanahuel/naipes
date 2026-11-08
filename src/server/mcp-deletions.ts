/**
 * Deletions an MCP client REQUESTS and the learner CONFIRMS in the app
 * (owner, 2026-11-08 — MCP phase 3). The MCP's call (POST /v1/deletions on
 * the local API, src/server/mcp-api.ts) waits here until the learner deletes
 * or rejects in the confirmation dialog (components/mcp-deletion-host.tsx),
 * or MCP_DELETION_TIMEOUT_MS passes. Nothing is deleted without that click:
 * the decision route lives on the app's own API (/api/mcp/deletions/:id),
 * never on the MCP listener.
 *
 * Each new request is announced on the event bus (`mcp-deletion`, the open
 * window's dialog) and to the desktop shell over the server's IPC channel
 * (`np:mcp`), which raises a system notification when no Naipes window has
 * the focus. Pending requests are in memory: a restart drops them, and the
 * waiting MCP call then fails as unreachable — never as deleted.
 */
import { randomUUID } from "node:crypto";
import { emit } from "../core/events.ts";
import { formatMessage, type Locale } from "../core/i18n.ts";
import { MCP_DELETION_TIMEOUT_MS, type McpDeletionKind, type McpDeletionOutcome, type McpDeletionView } from "../core/mcp-api.ts";
import { MESSAGES, type MessageKey } from "../core/messages/index.ts";
import { readExam } from "../store/exams.ts";
import { deleteChatSession } from "./chats.ts";
import { deleteExam } from "./exams.ts";
import { deleteGraphNode } from "./graph.ts";
import { effectiveSettings, stores } from "./stores.ts";

interface Pending extends McpDeletionView {
	settle: (outcome: McpDeletionOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as typeof globalThis & { __npMcpDeletions?: Map<string, Pending> };
const pending = (): Map<string, Pending> => (g.__npMcpDeletions ??= new Map());

function labelOf(kind: McpDeletionKind, targetId: string): string | null {
	if (kind === "session") return stores.chatStore.getChat(targetId)?.title ?? null;
	if (kind === "exam") return readExam(targetId)?.title ?? null;
	const lines = stores.graphStore.readNodes().filter((n) => n.id === targetId);
	return lines[0]?.name ?? null;
}

const text = (locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}) => formatMessage(MESSAGES[locale][key], vars, locale);

/** The desktop shell's notification (electron/main.cjs, channel np:mcp).
 *  Browser-only mode has no shell: the open window's dialog suffices. */
function notifyDesktop(view: McpDeletionView): void {
	if (process.env.NP_DESKTOP_SERVER !== "1" || typeof process.send !== "function" || !process.connected) return;
	const locale = effectiveSettings().general.language;
	try {
		process.send({
			channel: "np:mcp",
			op: "deletion-requested",
			title: text(locale, "mcp.deletion.notice.title", { client: view.client }),
			body: text(locale, "mcp.deletion.notice.body", { what: text(locale, `mcp.deletion.what.${view.kind}` as MessageKey), label: view.label }),
		});
	} catch {
		/* the shell went away: the dialog still shows when a window opens */
	}
}

let timeoutMs = MCP_DELETION_TIMEOUT_MS;
/** Test seam (the phone listener's precedent): a short wait. */
export function setMcpDeletionTimeoutForTests(ms: number): void {
	timeoutMs = ms;
}

const viewOf = ({ settle: _s, timer: _t, ...view }: Pending): McpDeletionView => view;

export function listMcpDeletions(): McpDeletionView[] {
	return [...pending().values()].map(viewOf).sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Register a request and wait for the learner. null = no such target. */
export function requestMcpDeletion(input: { kind: McpDeletionKind; targetId: string; client: string; suggestTraces: boolean }, now = Date.now()): Promise<McpDeletionOutcome> | null {
	const label = labelOf(input.kind, input.targetId);
	if (label === null) return null;
	return new Promise<McpDeletionOutcome>((resolve) => {
		const id = randomUUID();
		const entry: Pending = {
			id,
			kind: input.kind,
			targetId: input.targetId,
			label,
			client: input.client.trim().slice(0, 80) || "MCP",
			suggestTraces: input.kind === "session" && input.suggestTraces,
			expiresAt: now + timeoutMs,
			settle: (outcome) => {
				clearTimeout(entry.timer);
				if (!pending().delete(id)) return;
				emit("mcp-deletion", {});
				resolve(outcome);
			},
			timer: setTimeout(() => entry.settle({ outcome: "timeout" }), timeoutMs),
		};
		entry.timer.unref?.();
		pending().set(id, entry);
		emit("mcp-deletion", {});
		notifyDesktop(viewOf(entry));
	});
}

export type McpDeletionDecision = { ok: true } | { ok: false; status: number; error: string };

/** The learner's answer from the dialog. A failed deletion (a turn still
 *  running, an extraction in flight…) keeps the request pending: the
 *  dialog shows the reason and the learner may try again or reject. */
export async function decideMcpDeletion(id: string, decision: "delete" | "reject", removeGraphTraces = false): Promise<McpDeletionDecision> {
	const entry = pending().get(id);
	if (!entry) return { ok: false, status: 404, error: "This request is no longer pending." };
	if (decision === "reject") {
		entry.settle({ outcome: "rejected" });
		return { ok: true };
	}
	if (entry.kind === "session") {
		const r = await deleteChatSession(entry.targetId, removeGraphTraces ? "delete-nodes" : "preserve-graph");
		if (!r.ok) return { ok: false, status: r.status, error: r.error };
		entry.settle({ outcome: "deleted", removedGraphTraces: removeGraphTraces });
		return { ok: true };
	}
	if (entry.kind === "exam") {
		if (!deleteExam(entry.targetId)) return { ok: false, status: 404, error: "The exam no longer exists." };
		entry.settle({ outcome: "deleted" });
		return { ok: true };
	}
	const r = deleteGraphNode(entry.targetId);
	if (!r.ok) return { ok: false, status: r.status, error: r.error };
	entry.settle({ outcome: "deleted" });
	return { ok: true };
}

/**
 * THE NOTIFICATION CHANNEL ROUTE (push-architecture slice 1, 2026-10-02):
 * one SSE connection per open window over the core event bus — the
 * endpoint every future consumer (chat view, sidebar, activity dock)
 * subscribes to as the polls retire. The response plumbing lives in the
 * server seam (events-stream.ts); the framework route stays a thin
 * wrapper (the import law; tests drive the seam directly).
 */
import { eventsResponse, startVaultSync } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	// Every app window opens this stream on load — the Obsidian connection
	// starts here, once per server process (idempotent; a no-op until
	// Settings → Obsidian turns it on). Not instrumentation.ts: that entry's
	// file trace ignores outputFileTracingExcludes and would ship data/.
	try {
		startVaultSync();
	} catch (err) {
		console.error("[vault] startup failed:", err);
	}
	return eventsResponse();
}

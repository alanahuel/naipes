/**
 * The knowledge-folder inbox (phase 3, owner 2026-11-05): notes dropped in
 * the inbox folder and where the graph suggests they belong.
 *
 *   GET  → InboxOverview { enabled, inbox, items: [{ path, status,
 *          suggestion?, alternatives }], destinations }
 *   POST { path, action: "move", folder } → { ok: true, path } (the new path)
 *   POST { path, action: "dismiss" }      → { ok: true }
 *        400 bad body / folder not allowed, 404 not in the inbox,
 *        409 suggestions off / nothing to dismiss.
 */
import { dismissInboxSuggestion, inboxOverview, moveInboxNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return Response.json(inboxOverview());
}

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { path?: unknown; action?: unknown; folder?: unknown } | null;
	if (!body || typeof body.path !== "string") return Response.json({ error: "Body must carry a path" }, { status: 400 });
	const result =
		body.action === "move" && typeof body.folder === "string"
			? moveInboxNote(body.path, body.folder)
			: body.action === "dismiss"
				? dismissInboxSuggestion(body.path)
				: null;
	if (!result) return Response.json({ error: 'action must be "move" (with folder) or "dismiss"' }, { status: 400 });
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}

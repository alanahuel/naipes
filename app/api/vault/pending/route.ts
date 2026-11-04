/**
 * Knowledge-folder documents waiting for confirmation (phase 2, owner
 * 2026-11-04): files whose estimated extraction runs exceed
 * `obsidian.confirmAboveRuns`.
 *
 *   GET  → { pending: [{ path, hash, runs, pages?, deferred? }] }
 *   POST { path, decision: "read" | "later" } → { ok: true }
 *        «Leer» extracts it now; «Ahora no» parks it until the file changes.
 *        404 when the path is not waiting.
 */
import { decidePendingDocument, pendingDocuments } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return Response.json({ pending: pendingDocuments() });
}

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { path?: unknown; decision?: unknown } | null;
	if (!body || typeof body.path !== "string" || (body.decision !== "read" && body.decision !== "later")) {
		return Response.json({ error: 'Body must be { path: string, decision: "read" | "later" }' }, { status: 400 });
	}
	if (!decidePendingDocument(body.path, body.decision)) {
		return Response.json({ error: "That file is not waiting for confirmation." }, { status: 404 });
	}
	return Response.json({ ok: true });
}

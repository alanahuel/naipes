/**
 * Knowledge-folder notes PARKED after the model never submitted findings
 * for them (owner, 2026-11-09): not retried while their content stays the
 * same, until «Reintentar».
 *
 *   GET  → { failed: [{ path, hash, at, error }] }
 *   POST { path } → { ok: true } — forget the failure and extract it again.
 *        404 when the path is not parked.
 */
import { failedNotes, retryFailedNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return Response.json({ failed: failedNotes() });
}

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
	if (!body || typeof body.path !== "string") {
		return Response.json({ error: "Body must be { path: string }" }, { status: 400 });
	}
	if (!retryFailedNote(body.path)) {
		return Response.json({ error: "That note is not parked." }, { status: 404 });
	}
	return Response.json({ ok: true });
}

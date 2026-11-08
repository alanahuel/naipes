/**
 * POST /api/mcp/deletions/:id { decision: "delete" | "reject", removeGraphTraces? }
 * — the learner's answer to an MCP client's deletion request (owner,
 * 2026-11-08). Only the app's own API carries this route: the MCP listener
 * can request, never confirm. A failed deletion keeps the request pending.
 */
import { decideMcpDeletion } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { decision?: unknown; removeGraphTraces?: unknown } | null;
	if (body?.decision !== "delete" && body?.decision !== "reject") return Response.json({ error: 'decision must be "delete" or "reject"' }, { status: 400 });
	const r = await decideMcpDeletion(id, body.decision, body.removeGraphTraces === true);
	return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}

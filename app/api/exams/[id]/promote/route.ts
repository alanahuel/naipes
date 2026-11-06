/**
 * POST /api/exams/[id]/promote { pointId, ideaId } — «Ascender a punto
 * extra» (owner 2026-11-06): an ampliación idea becomes a counted point.
 */
import { promoteExamIdea } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { pointId?: unknown; ideaId?: unknown } | null;
	if (typeof body?.pointId !== "string" || typeof body?.ideaId !== "string") return Response.json({ error: "pointId and ideaId required" }, { status: 400 });
	const result = promoteExamIdea(id, body.pointId, body.ideaId);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ ok: true });
}

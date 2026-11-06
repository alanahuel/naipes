/**
 * POST /api/exams/[id]/kind — change a block's or a point's type (owner
 * 2026-11-06): { blockId, pointId?: string | null, kind: "syllabus" |
 * "rules" | "tutor" }. Changed points are only marked pending; they are
 * researched with «Investigar cambios» (research { mode: "pending" }).
 */
import { setExamPointKind } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => ({}))) as { blockId?: unknown; pointId?: unknown; kind?: unknown };
	if (typeof body.blockId !== "string" || (body.pointId !== undefined && body.pointId !== null && typeof body.pointId !== "string")) {
		return Response.json({ error: "blockId (and an optional pointId) required" }, { status: 400 });
	}
	if (body.kind !== "syllabus" && body.kind !== "rules" && body.kind !== "tutor") return Response.json({ error: "kind must be syllabus, rules or tutor" }, { status: 400 });
	const started = setExamPointKind(id, { blockId: body.blockId, pointId: typeof body.pointId === "string" ? body.pointId : null, kind: body.kind });
	if (!started.ok) return Response.json({ error: started.error, ...(started.status === 503 ? { code: "models_not_configured" } : {}) }, { status: started.status });
	return Response.json({ ok: true });
}

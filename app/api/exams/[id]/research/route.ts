/**
 * POST /api/exams/[id]/research — (re)run the exam research (owner
 * 2026-11-06): {} or { mode: "missing" } resumes the blocks without target
 * ideas («Reintentar»); { mode: "all" } redoes everything; { pointId }
 * redoes one point. 202, then `mapping` moves researching → done | error.
 */
import { startExamResearch } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => ({}))) as { mode?: unknown; pointId?: unknown };
	const scope =
		typeof body.pointId === "string" ? { mode: "point" as const, pointId: body.pointId } : body.mode === "all" ? { mode: "all" as const } : { mode: "missing" as const };
	const started = startExamResearch(id, scope);
	if (!started.ok) return Response.json({ error: started.error, ...(started.status === 503 ? { code: "models_not_configured" } : {}) }, { status: started.status });
	return Response.json({ ok: true }, { status: 202 });
}

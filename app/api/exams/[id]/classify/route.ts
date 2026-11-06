/**
 * POST /api/exams/[id]/classify — «Clasificar temario» (owner 2026-11-06):
 * the model gives each block and point its type; the points that changed
 * are researched again. 202, then `mapping` moves running → researching →
 * done | error.
 */
import { classifyExam } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const started = classifyExam(id);
	if (!started.ok) return Response.json({ error: started.error, ...(started.status === 503 ? { code: "models_not_configured" } : {}) }, { status: started.status });
	return Response.json({ ok: true }, { status: 202 });
}

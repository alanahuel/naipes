/**
 * POST /api/exams/[id]/map — start mapping the syllabus onto the graph
 * (one strong-slot call, fire-and-forget): 202, then the record's
 * `mapping` moves running → done | error, announced by `exams-changed`.
 * 409 while running; 503 models_not_configured without a strong model.
 */
import { startExamMapping } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const started = startExamMapping(id);
	if (!started.ok) return Response.json({ error: started.error, ...(started.status === 503 ? { code: "models_not_configured" } : {}) }, { status: started.status });
	return Response.json({ ok: true }, { status: 202 });
}

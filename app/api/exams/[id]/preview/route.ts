/**
 * POST /api/exams/[id]/preview — the wizard's forecast: { standard?,
 * weeklyMinutes? } → { bestPreset, shortfall, extraPerDay, feasible } for
 * this exam as if it were active (nothing is written).
 */
import { parsePreview, previewExamPlan } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const parsed = parsePreview(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const preview = previewExamPlan(id, parsed.value);
	if (!preview) return Response.json({ error: "the exam has no mapped syllabus or its date passed" }, { status: 409 });
	return Response.json(preview);
}

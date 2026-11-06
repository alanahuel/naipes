/**
 * «Exámenes» (owner 2026-11-05).
 *   GET    /api/exams/[id] — the exam, its derived status and plan.
 *   PUT    /api/exams/[id] — edit (title, examDate, standard, blocks,
 *          priorityBlocks, status active|archived, realGrade).
 *   DELETE /api/exams/[id] — remove the exam (its sessions stay).
 */
import { deleteExam, examDetailView, parseExamPatch, updateExam } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
	const { id } = await params;
	const view = examDetailView(id);
	if (!view) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(view);
}

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const parsed = parseExamPatch(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const result = updateExam(id, parsed.value);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
	return Response.json({ exam: result.value });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!deleteExam(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

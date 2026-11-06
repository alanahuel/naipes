/**
 * «Exámenes» (owner 2026-11-05).
 *   GET  /api/exams — every exam's summary (live plan numbers derived on
 *        read). The folder tree: /api/exams/folders.
 *   POST /api/exams — create a draft { title, examDate, standard?,
 *        syllabus: { text, fileName?, folders, directFolders }, context? } → 201 { exam }.
 */
import { createExam, listExamViews, parseExamCreate } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ exams: listExamViews() });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	const parsed = parseExamCreate(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return Response.json({ exam: createExam(parsed.value) }, { status: 201 });
}

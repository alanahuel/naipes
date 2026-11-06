/**
 * POST /api/exams/syllabus-file — a syllabus file (multipart field "file":
 * .md .txt .pdf .docx .epub) → { fileName, text }. The text only seeds the
 * exam's syllabus; the file never enters the graph (owner, 2026-11-05).
 */
import { documentText, isDocumentFile, joinedText, MAX_SYLLABUS_CHARS } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 40 * 1024 * 1024;

export async function POST(request: Request) {
	const form = await request.formData().catch(() => null);
	const file = form?.get("file");
	if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
	if (file.size > MAX_BYTES) return Response.json({ error: "file too large" }, { status: 413 });
	const name = file.name;
	const lower = name.toLowerCase();
	if (!lower.endsWith(".md") && !isDocumentFile(name)) return Response.json({ error: "unsupported format" }, { status: 415 });
	try {
		const text = lower.endsWith(".md") ? await file.text() : joinedText(await documentText(name, new Uint8Array(await file.arrayBuffer())));
		return Response.json({ fileName: name, text: text.slice(0, MAX_SYLLABUS_CHARS), truncated: text.length > MAX_SYLLABUS_CHARS });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
	}
}

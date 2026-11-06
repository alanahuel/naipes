/**
 * An exam's research materials (owner 2026-11-06) — sources only: never
 * syllabus text, never the graph.
 *   POST   multipart "file" (pdf, docx, epub, md, txt, images) → 201 { material }
 *   POST   JSON { url, name? } → 201 { material } (a web link)
 *   DELETE ?material=<id> → 200
 */
import { addExamMaterial, removeExamMaterial } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 60 * 1024 * 1024;
const EXT_RE = /\.(pdf|docx|epub|md|txt|png|jpe?g|webp|heic)$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const type = request.headers.get("content-type") ?? "";
	let result;
	if (type.includes("multipart/form-data")) {
		const form = await request.formData().catch(() => null);
		const file = form?.get("file");
		if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
		if (file.size > MAX_BYTES) return Response.json({ error: "file too large" }, { status: 413 });
		if (!EXT_RE.test(file.name)) return Response.json({ error: "unsupported format" }, { status: 415 });
		result = addExamMaterial(id, { kind: "file", name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
	} else {
		const body = (await request.json().catch(() => null)) as { url?: unknown; name?: unknown } | null;
		if (typeof body?.url !== "string") return Response.json({ error: "url required" }, { status: 400 });
		result = addExamMaterial(id, { kind: "link", url: body.url.trim(), ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}) });
	}
	if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
	return Response.json({ material: result.value }, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const material = new URL(request.url).searchParams.get("material") ?? "";
	return removeExamMaterial(id, material) ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
}

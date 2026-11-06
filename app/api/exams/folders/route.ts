/**
 * The exam wizard's folder tree (owner 2026-11-06).
 *   GET  /api/exams/folders — every knowledge-folder folder holding notes,
 *        read or not: { folders: [{ path, ideas, notes, unread, direct,
 *        directUnread }], watched: [paths] }.
 *   POST /api/exams/folders — { folders, directFolders } → { add: [{ path,
 *        unread }] }: what «Leer y mapear» will add to Settings → Knowledge.
 */
import { sanitizeScope } from "@/src/core";
import { listExamFolders, readingPlan } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(listExamFolders());
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { folders?: unknown; directFolders?: unknown } | null;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 1024) : []);
	return Response.json({ add: readingPlan(sanitizeScope(list(body?.folders), list(body?.directFolders))) });
}

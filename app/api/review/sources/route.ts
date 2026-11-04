/**
 * PUT /api/review/sources — replace the activated areas and/or pause lists
 * (each list given replaces that list; absent lists stay). Body:
 * { areas?: string[], paused?: { sessions?: string[], areas?: string[], nodes?: string[] } }
 */
import { parseReviewSourcesPatch, updateReviewSources } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const parsed = parseReviewSourcesPatch(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	try {
		return Response.json({ sources: updateReviewSources(parsed.patch) });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
	}
}

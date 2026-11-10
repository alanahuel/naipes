/**
 * «Calendario»: PUT /api/calendar/series { seriesKey, examId?|null,
 * consumes?, kind?, planned? } — what the learner sets on an imported
 * series (all its occurrences).
 */
import { setSeriesMeta } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const result = setSeriesMeta(await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ meta: result.value });
}

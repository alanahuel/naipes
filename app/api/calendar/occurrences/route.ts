/**
 * «Calendario»: PUT /api/calendar/occurrences — one occurrence's state
 * { key, cancelled?, moved?: {day,start}|null, planned?, confirmed?, done? }.
 */
import { updateOccurrence } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const result = updateOccurrence(await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ state: result.value });
}

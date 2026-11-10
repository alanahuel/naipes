/**
 * «Calendario»: POST /api/calendar/events — create a hand-made event
 * { title, kind, day, start, minutes, until?, examId?, consumes, planned? } → 201.
 */
import { createCalendarEvent } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const result = createCalendarEvent(await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ event: result.value }, { status: 201 });
}

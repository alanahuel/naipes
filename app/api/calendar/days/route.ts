/**
 * «Calendario»: PUT /api/calendar/days — a date's study minutes
 * { day, minutes: 0–720 | null (back to the weekday's) }.
 */
import { setDayMinutes } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const result = setDayMinutes(await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result.value);
}

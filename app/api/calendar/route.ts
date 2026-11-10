/**
 * «Calendario» (owner 2026-11-10).
 *   GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — the days (at most
 *       62; default: the next 7), late sittings, classes to confirm, the
 *       live exams' points, events, subscriptions, settings.
 */
import { calendarView, parseRange } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const range = parseRange(new URL(request.url));
	if (!range.ok) return Response.json({ error: range.error }, { status: range.status });
	return Response.json(calendarView(range.value));
}

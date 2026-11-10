/**
 * «Calendario»: POST /api/calendar/sessions/start { key } — start the
 * session behind a card (or continue its conversation) → { chatId,
 * title?, opening?, resumed }.
 */
import { startCalendarSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
	if (!body || typeof body.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
	const result = startCalendarSession(body.key);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result.value, { status: result.value.resumed ? 200 : 201 });
}

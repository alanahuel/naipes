/**
 * «Calendario»: PUT /api/calendar/events/[id] — edit (null clears until,
 * examId, planned); DELETE — remove the event and its occurrence states.
 */
import { deleteCalendarEvent, updateCalendarEvent } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const result = updateCalendarEvent(id, await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ event: result.value });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!deleteCalendarEvent(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

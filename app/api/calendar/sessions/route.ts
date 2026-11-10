/**
 * «Calendario»: POST /api/calendar/sessions — the learner touches a card
 * (it is anchored): { action: move {day, start|null} · resize {minutes} ·
 * split {minutes, day?} · merge · release, key }.
 */
import { applySessionAction, parseSessionAction } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const parsed = parseSessionAction(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
	const result = applySessionAction(parsed.value);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result.value);
}

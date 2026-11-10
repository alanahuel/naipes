/**
 * POST /api/review/notify?kind=digest|evening|calendar|all — asked by the desktop
 * shell on its minute clock (kind=all, perf 2026-11-10: the three kinds in
 * that order over ONE exams-state computation → { answers: [...] }). The server applies the owner's rules (time window,
 * once a day, something due, no review started for the evening one),
 * records the notice, tells the bell, and returns the localized text:
 * { notify: false } or { notify: true, title, body, count, path? } — path
 * names the page a click opens (an exam's; absent = /review).
 */
import { calendarDeskNotice, getExamsState } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const kind = new URL(request.url).searchParams.get("kind");
	if (kind !== "digest" && kind !== "evening" && kind !== "calendar" && kind !== "all") return Response.json({ error: "kind must be digest, evening, calendar or all" }, { status: 400 });
	try {
		if (kind === "all") {
			const now = Date.now();
			const state = getExamsState(now);
			return Response.json({ answers: (["digest", "evening", "calendar"] as const).map((k) => calendarDeskNotice(k, now, state)) });
		}
		// «Calendario» (owner 2026-11-10): the digest is the day's agenda
		// (Repaso and the exams are cards in it), the evening one says what
		// is left; "calendar" = alerts before fixed hours and «¿Qué se dio?».
		// The exams' one-off countdown notices still ride the digest slot.
		return Response.json(calendarDeskNotice(kind));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
	}
}

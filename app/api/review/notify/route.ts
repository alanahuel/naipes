/**
 * POST /api/review/notify?kind=digest|evening — asked by the desktop shell
 * on its minute clock. The server applies the owner's rules (time window,
 * once a day, something due, no review started for the evening one),
 * records the notice, tells the bell, and returns the localized text:
 * { notify: false } or { notify: true, title, body, count, path? } — path
 * names the page a click opens (an exam's; absent = /review).
 */
import { deskNotice } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const kind = new URL(request.url).searchParams.get("kind");
	if (kind !== "digest" && kind !== "evening") return Response.json({ error: "kind must be digest or evening" }, { status: 400 });
	try {
		// The exams fold in here («Exámenes», 2026-11-05): their digest lines,
		// the evening reminder and the one-off countdown notices.
		return Response.json(deskNotice(kind));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
	}
}

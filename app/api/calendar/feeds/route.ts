/**
 * «Calendario»: POST /api/calendar/feeds { url, name? } — subscribe to an
 * .ics address (read-only) and fetch it now → 201 { feed } (feed.error
 * says why a fetch failed; it is retried every 6 h).
 */
import { addFeed } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const result = await addFeed(await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ feed: result.value }, { status: 201 });
}

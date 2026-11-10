/**
 * «Calendario» subscriptions:
 *   POST   /api/calendar/feeds/[id] — refresh now.
 *   PUT    /api/calendar/feeds/[id] { name } — rename.
 *   DELETE /api/calendar/feeds/[id] — unsubscribe (its assignments go).
 */
import { refreshFeed, removeFeed, renameFeed } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
	const { id } = await params;
	const feed = await refreshFeed(id);
	if (!feed) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ feed });
}

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const result = renameFeed(id, await request.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ feed: result.value });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!removeFeed(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

// GET    /api/chats/[id]/attachments/[attId] — the stored JPEG (thumbnails,
//        the lightbox). Immutable: an id never names different bytes.
// DELETE /api/chats/[id]/attachments/[attId] — drop an UNSENT attachment
//        (the tray's ×). A sent image belongs to the record: 409 — it goes
//        with the session (owner, 2026-11-06).
import { getChat, referencedAttachmentIds, stores } from "@/src/server";

type Ctx = { params: Promise<{ id: string; attId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
	const { id, attId } = await ctx.params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "unknown attachment" }, { status: 404 });
	const bytes = stores.attachmentStore.read(id, attId);
	if (!bytes) return Response.json({ error: "unknown attachment" }, { status: 404 });
	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": "image/jpeg",
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": "private, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
	const { id, attId } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "unknown chat" }, { status: 404 });
	if (referencedAttachmentIds(record.messages).has(attId)) {
		return Response.json({ error: "attachment already sent" }, { status: 409 });
	}
	if (!stores.attachmentStore.removeOne(id, attId)) return Response.json({ error: "unknown attachment" }, { status: 404 });
	return Response.json({ ok: true });
}

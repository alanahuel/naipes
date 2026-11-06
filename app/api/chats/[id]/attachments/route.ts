// POST /api/chats/[id]/attachments — upload one image attachment (owner,
// 2026-11-06). The body is the raw JPEG the client already resized
// (≤ 2000 px, core/attachments.ts); the store re-reads its header, so a
// non-JPEG body is a 415. Returns the ref the input event will name by id.
import { ATTACHMENT_MAX_BYTES } from "@/src/core";
import { getChat, stores } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > ATTACHMENT_MAX_BYTES) return Response.json({ error: "image too large" }, { status: 413 });
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return Response.json({ error: "image too large" }, { status: 413 });
	const ref = stores.attachmentStore.save(id, bytes);
	if (!ref) return Response.json({ error: "attachments must be JPEG images" }, { status: 415 });
	return Response.json({ attachment: ref }, { status: 201 });
}

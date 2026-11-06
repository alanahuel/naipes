// POST   /api/chats/[id]/phone — open a «Enviar desde el móvil» QR session
//        (owner, 2026-11-06): { trayId, capacity } → PhoneSessionInfo, with
//        one QR per reachable network (Wi-Fi first, then Tailscale).
// DELETE /api/chats/[id]/phone?token=… — close it (the panel's Cerrar, or
//        unmount); the last open session closes the port.
import os from "node:os";
import QRCode from "qrcode";
import { MAX_ATTACHMENTS, PHONE_PORT, phoneAddresses, phoneUrl, type PhoneLink, type PhoneNetwork, type PhoneSessionInfo } from "@/src/core";
import { closePhoneSession, effectiveSettings, getChat, openPhoneSession, PhoneListenError, phonePort, stores } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	if (stores.settingsStore.readSettings()?.phone?.enabled !== true) {
		return Response.json({ error: "sending from the phone is off", code: "disabled" }, { status: 403 });
	}
	let body: { trayId?: unknown; capacity?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const trayId = typeof body.trayId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.trayId) ? body.trayId : null;
	const capacity = typeof body.capacity === "number" && Number.isInteger(body.capacity) ? body.capacity : -1;
	if (!trayId || capacity < 1 || capacity > MAX_ATTACHMENTS) {
		return Response.json({ error: "trayId and a capacity of 1–4 are required" }, { status: 400 });
	}
	const addresses = phoneAddresses(os.networkInterfaces());
	const order: PhoneNetwork[] = ["wifi", "tailscale"];
	if (!order.some((n) => addresses[n])) return Response.json({ error: "no network", code: "no_network" }, { status: 503 });
	let session;
	try {
		session = await openPhoneSession({ chatId: id, trayId, capacity, locale: effectiveSettings().general.language });
	} catch (err) {
		if (err instanceof PhoneListenError) {
			return Response.json({ error: `port ${PHONE_PORT} unavailable (${err.code})`, code: "port_busy", port: PHONE_PORT }, { status: 503 });
		}
		throw err;
	}
	const links: PhoneLink[] = [];
	for (const network of order) {
		const address = addresses[network];
		if (!address) continue;
		const url = phoneUrl(address, session.token, phonePort());
		links.push({ network, url, svg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) });
	}
	const info: PhoneSessionInfo = { token: session.token, expiresAt: session.expiresAt, capacity: session.remaining, links };
	return Response.json(info, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	await ctx.params;
	const token = new URL(request.url).searchParams.get("token") ?? "";
	closePhoneSession(token);
	return Response.json({ ok: true });
}

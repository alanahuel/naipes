/** «Enviar desde el móvil» (owner, 2026-11-06 — image attachments phase 2):
 *  address choice, the token registry, the listener opening/closing with
 *  the QR sessions, the three phone routes (and the 404 for everything
 *  else), uploads into the tray's chat + the bus event, and the app route
 *  gate. Isolated temporary data dir; the listener binds an ephemeral port
 *  on this machine; synthetic JPEG headers only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-phone-"));
process.env.NP_DATA_DIR = DIR;

const { phoneAddresses, phoneUrl, PHONE_PORT, PHONE_SESSION_MS, subscribe, CURRENT_SETTINGS_VERSION } = await import("../src/core/index.ts");
const phone = await import("../src/server/phone.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { attachmentStore } = await import("../src/store/attachments.ts");
const route = await import("../app/api/chats/[id]/phone/route.ts");
const { parsePhoneSettingsBody } = await import("../src/server/settings-body.ts");

phone.setPhonePortForTests(0);
after(() => {
	for (const s of [...((globalThis as { __npPhone?: { sessions: Map<string, unknown> } }).__npPhone?.sessions.keys() ?? [])]) phone.closePhoneSession(s);
	fs.rmSync(DIR, { recursive: true, force: true });
});

function fakeJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
	const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
	const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const base = () => `http://127.0.0.1:${phone.phonePort()}`;

describe("phoneAddresses — Wi-Fi first, Tailscale apart, virtual bridges never", () => {
	it("picks the LAN and Tailscale IPv4s and skips loopback, docker and IPv6", () => {
		const picked = phoneAddresses({
			lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
			docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
			wlan0: [
				{ address: "fe80::1", family: "IPv6", internal: false },
				{ address: "192.168.1.174", family: "IPv4", internal: false },
			],
			tailscale0: [{ address: "100.114.224.36", family: "IPv4", internal: false }],
		});
		assert.deepEqual(picked, { wifi: "192.168.1.174", tailscale: "100.114.224.36" });
	});
	it("recognizes Tailscale by its 100.64/10 range under any interface name; public IPs are no LAN", () => {
		assert.deepEqual(phoneAddresses({ utun4: [{ address: "100.70.1.2", family: 4, internal: false }] }), { tailscale: "100.70.1.2" });
		assert.deepEqual(phoneAddresses({ eth0: [{ address: "8.8.8.8", family: "IPv4", internal: false }] }), {});
	});
	it("builds the phone URL on the fixed port", () => {
		assert.equal(PHONE_PORT, 47800);
		assert.equal(phoneUrl("192.168.1.174", "tok"), "http://192.168.1.174:47800/m/tok");
	});
});

describe("the listener lives only while a QR is open", () => {
	const chat = chatStore.createChat("Matemáticas");

	it("opens with the first session and closes with the last", async () => {
		assert.equal(phone.phoneListening(), false);
		const a = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_a", capacity: 2, locale: "es" });
		const b = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_b", capacity: 1, locale: "es" });
		assert.equal(phone.phoneListening(), true);
		assert.match(a.token, /^[A-Za-z0-9_-]{43}$/, "256-bit base64url token");
		assert.ok(a.expiresAt - Date.now() <= PHONE_SESSION_MS && a.expiresAt - Date.now() > PHONE_SESSION_MS - 5_000);
		phone.closePhoneSession(a.token);
		assert.equal(phone.phoneListening(), true, "one session still open");
		phone.closePhoneSession(b.token);
		assert.equal(phone.phoneListening(), false);
	});

	it("serves the page, the status and photos — and 404s everything else", async () => {
		const s = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_x", capacity: 2, locale: "es" });
		const page = await fetch(`${base()}/m/${s.token}`);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.equal(page.headers.get("cache-control"), "no-store");
		const html = await page.text();
		assert.match(html, /Hacer foto/);
		assert.match(html, /Elegir de la galería/);
		assert.match(html, /capture="environment"/);

		assert.deepEqual(await (await fetch(`${base()}/m/${s.token}/status`)).json(), { remaining: 2, expiresAt: s.expiresAt });

		for (const url of [`/m/${"x".repeat(43)}`, "/", "/api/chats", `/m/${s.token}/other`, `/m/${s.token}/../../api/chats`]) {
			assert.equal((await fetch(base() + url)).status, 404, url);
		}
		assert.equal((await fetch(`${base()}/m/${s.token}`, { method: "POST" })).status, 404, "wrong method");
		phone.closePhoneSession(s.token);
	});

	it("an upload lands in the chat's folder and goes to the tray that opened the QR; capacity is enforced", async () => {
		const s = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_up", capacity: 1, locale: "en" });
		const events: unknown[] = [];
		const off = subscribe((e) => {
			if (e.type === "phone-attachments") events.push(e);
		});
		const post = (body: Uint8Array<ArrayBuffer>) => fetch(`${base()}/m/${s.token}/photos`, { method: "POST", body, headers: { "Content-Type": "image/jpeg" } });

		assert.equal((await post(new Uint8Array([1, 2, 3, 4]))).status, 415, "non-JPEG");
		const ok = await post(fakeJpeg(2000, 1500));
		assert.equal(ok.status, 201);
		assert.deepEqual(await ok.json(), { remaining: 0 });
		assert.equal(events.length, 1);
		const event = events[0] as { chatId: string; trayId: string; token: string; refs: { id: string; width: number }[] };
		assert.equal(event.chatId, chat.id);
		assert.equal(event.trayId, "tray_up");
		assert.equal(event.token, s.token);
		assert.equal(event.refs[0]!.width, 2000);
		assert.ok(attachmentStore.read(chat.id, event.refs[0]!.id), "stored in the chat's attachment folder");

		assert.equal((await post(fakeJpeg(10, 10))).status, 409, "the tray's room is spent");
		off();
		phone.closePhoneSession(s.token);
		assert.equal((await fetch(`${base()}/m/${s.token}`).catch(() => ({ status: 0 }))).status, 0, "port closed with the last session");
	});

	it("an expired token is a 404 and its session closes", async () => {
		const keep = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_keep", capacity: 1, locale: "es" });
		const s = await phone.openPhoneSession({ chatId: chat.id, trayId: "tray_old", capacity: 1, locale: "es" });
		s.expiresAt = Date.now() - 1;
		assert.equal((await fetch(`${base()}/m/${s.token}/status`)).status, 404);
		assert.equal(phone.closePhoneSession(s.token), false, "already closed by the expiry check");
		phone.closePhoneSession(keep.token);
	});

	it("deleting a chat closes its QR sessions", async () => {
		const doomed = chatStore.createChat("Borrar");
		await phone.openPhoneSession({ chatId: doomed.id, trayId: "tray_d", capacity: 1, locale: "es" });
		phone.closePhoneSessionsForChat(doomed.id);
		assert.equal(phone.phoneListening(), false);
	});
});

describe("the app route and the setting", () => {
	const chat = chatStore.createChat("Ruta");
	const open = (body: unknown) =>
		route.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {
			params: Promise.resolve({ id: chat.id }),
		});

	it("the setting parses strictly", () => {
		assert.deepEqual(parsePhoneSettingsBody({ enabled: true }), { ok: true, settings: { enabled: true } });
		assert.equal(parsePhoneSettingsBody({ enabled: "yes" }).ok, false);
	});
	it("is off by default (403) and validates the tray and capacity", async () => {
		assert.equal((await open({ trayId: "tray_r", capacity: 2 })).status, 403);
		settingsStore.writeSettings({ version: CURRENT_SETTINGS_VERSION, phone: { enabled: true } });
		assert.equal((await open({ trayId: "tray_r", capacity: 0 })).status, 400);
		assert.equal((await open({ trayId: "../x", capacity: 2 })).status, 400);
	});
	it("opens a session with one QR per reachable network (or says there is none)", async () => {
		const res = await open({ trayId: "tray_r", capacity: 3 });
		if (res.status === 503) {
			assert.equal(((await res.json()) as { code: string }).code, "no_network");
			return;
		}
		assert.equal(res.status, 201);
		const info = (await res.json()) as { token: string; capacity: number; links: { network: string; url: string; svg: string }[] };
		assert.equal(info.capacity, 3);
		assert.ok(info.links.length >= 1);
		assert.match(info.links[0]!.url, new RegExp(`/m/${info.token}$`));
		assert.match(info.links[0]!.svg, /^<svg/);
		const del = await route.DELETE(new Request(`http://x?token=${info.token}`, { method: "DELETE" }), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(del.status, 200);
		assert.equal(phone.phoneListening(), false);
	});
});

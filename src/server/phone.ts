/**
 * «Enviar desde el móvil», server side (owner, 2026-11-06 — image
 * attachments phase 2). A second, tiny HTTP listener on 0.0.0.0:PHONE_PORT
 * inside the Naipes server process — open ONLY while at least one QR
 * session is live, closed when the last one expires or is closed.
 *
 * It answers exactly three routes, all behind a 256-bit token:
 *   GET  /m/<token>         the phone page (self-contained HTML)
 *   POST /m/<token>/photos  one JPEG per request (the fase-1 store gate)
 *   GET  /m/<token>/status  { remaining, expiresAt }
 * Anything else — an unknown/expired token, another path, another method —
 * is a bare 404. The main API is never reachable from here.
 *
 * Every accepted photo lands in the chat's attachment folder and goes out
 * on the event bus as `phone-attachments`, addressed to the tray that
 * opened the QR; the desktop adds it there and the learner decides when
 * to send. State lives on globalThis (one registry per process, however
 * many Next module copies load this file).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_JPEG_QUALITY, ATTACHMENT_MAX_SIDE } from "../core/attachments.ts";
import { emit } from "../core/events.ts";
import { formatMessage, type Locale } from "../core/i18n.ts";
import { MESSAGES, type MessageKey } from "../core/messages/index.ts";
import { PHONE_PORT, PHONE_SESSION_MS } from "../core/phone.ts";
import { stores } from "./stores.ts";

export interface PhoneSession {
	token: string;
	chatId: string;
	trayId: string;
	expiresAt: number;
	/** Photos still accepted (decremented per upload). */
	remaining: number;
	locale: Locale;
}

interface PhoneRegistry {
	sessions: Map<string, PhoneSession>;
	server: http.Server | null;
	listening: Promise<void> | null;
	timers: Map<string, ReturnType<typeof setTimeout>>;
	port: number;
}

const g = globalThis as typeof globalThis & { __npPhone?: PhoneRegistry };
function registry(): PhoneRegistry {
	return (g.__npPhone ??= { sessions: new Map(), server: null, listening: null, timers: new Map(), port: PHONE_PORT });
}

/** The listener could not bind (another program owns the port). */
export class PhoneListenError extends Error {
	constructor(readonly code: string) {
		super(`phone listener: ${code}`);
	}
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Open a QR session (and the listener, if it is closed). */
export async function openPhoneSession(init: { chatId: string; trayId: string; capacity: number; locale: Locale }): Promise<PhoneSession> {
	const reg = registry();
	await ensureListening(reg);
	const token = randomBytes(32).toString("base64url");
	const session: PhoneSession = {
		token,
		chatId: init.chatId,
		trayId: init.trayId,
		expiresAt: Date.now() + PHONE_SESSION_MS,
		remaining: Math.max(0, Math.floor(init.capacity)),
		locale: init.locale,
	};
	reg.sessions.set(token, session);
	const timer = setTimeout(() => closePhoneSession(token), PHONE_SESSION_MS);
	timer.unref?.();
	reg.timers.set(token, timer);
	return session;
}

/** Close a QR session; the last one closes the listener. Idempotent. */
export function closePhoneSession(token: string): boolean {
	const reg = registry();
	const existed = reg.sessions.delete(token);
	const timer = reg.timers.get(token);
	if (timer) clearTimeout(timer);
	reg.timers.delete(token);
	if (reg.sessions.size === 0) closeListener(reg);
	return existed;
}

/** Close every session of a chat (session deletion). */
export function closePhoneSessionsForChat(chatId: string): void {
	for (const s of [...registry().sessions.values()]) if (s.chatId === chatId) closePhoneSession(s.token);
}

/** Is the listener bound right now? (tests, diagnostics) */
export function phoneListening(): boolean {
	return registry().server?.listening === true;
}

/** Test seam: a different port (0 = any free one); returns the bound port. */
export function setPhonePortForTests(port: number): void {
	registry().port = port;
}
export function phonePort(): number {
	const address = registry().server?.address();
	return address && typeof address === "object" ? address.port : registry().port;
}

function liveSession(token: string): PhoneSession | null {
	if (!TOKEN_RE.test(token)) return null;
	const session = registry().sessions.get(token);
	if (!session) return null;
	if (session.expiresAt <= Date.now()) {
		closePhoneSession(token);
		return null;
	}
	return session;
}

function ensureListening(reg: PhoneRegistry): Promise<void> {
	if (reg.server && reg.listening) return reg.listening;
	const server = http.createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) notFound(res);
			else res.destroy();
		});
	});
	server.requestTimeout = 60_000;
	server.headersTimeout = 15_000;
	reg.server = server;
	reg.listening = new Promise<void>((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			reg.server = null;
			reg.listening = null;
			reject(new PhoneListenError(err.code ?? "ERROR"));
		};
		server.once("error", onError);
		server.listen(reg.port, "0.0.0.0", () => {
			server.off("error", onError);
			resolve();
		});
	});
	return reg.listening;
}

function closeListener(reg: PhoneRegistry): void {
	const server = reg.server;
	reg.server = null;
	reg.listening = null;
	if (!server) return;
	server.close();
	server.closeAllConnections?.();
}

// ─── the three routes ────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
};

function notFound(res: http.ServerResponse): void {
	res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
	res.end("Not found");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const match = /^\/m\/([^/?#]+)(\/photos|\/status)?$/.exec((req.url ?? "").split("?")[0]!);
	const session = match ? liveSession(match[1]!) : null;
	if (!match || !session) return notFound(res);
	const route = match[2] ?? "";
	if (route === "" && req.method === "GET") return page(res, session);
	if (route === "/status" && req.method === "GET") return json(res, 200, { remaining: session.remaining, expiresAt: session.expiresAt });
	if (route === "/photos" && req.method === "POST") return upload(req, res, session);
	return notFound(res);
}

async function upload(req: http.IncomingMessage, res: http.ServerResponse, session: PhoneSession): Promise<void> {
	if (session.remaining <= 0) {
		req.resume();
		return json(res, 409, { error: "full", remaining: 0 });
	}
	const declared = Number(req.headers["content-length"] ?? "0");
	if (declared > ATTACHMENT_MAX_BYTES) {
		req.resume();
		return json(res, 413, { error: "too large" });
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > ATTACHMENT_MAX_BYTES) return json(res, 413, { error: "too large" });
		chunks.push(chunk as Buffer);
	}
	// The session may have closed (or filled) while the body streamed.
	if (!liveSession(session.token)) return notFound(res);
	if (session.remaining <= 0) return json(res, 409, { error: "full", remaining: 0 });
	if (!stores.chatStore.getChat(session.chatId)) return notFound(res);
	const ref = stores.attachmentStore.save(session.chatId, new Uint8Array(Buffer.concat(chunks)));
	if (!ref) return json(res, 415, { error: "not a JPEG" });
	session.remaining -= 1;
	emit("phone-attachments", { chatId: session.chatId, trayId: session.trayId, token: session.token, refs: [ref] });
	return json(res, 201, { remaining: session.remaining });
}

// ─── the phone page ──────────────────────────────────────────────────────────

const PAGE_KEYS = [
	"phone.page.title",
	"phone.page.camera",
	"phone.page.gallery",
	"phone.page.send",
	"phone.page.sending",
	"phone.page.sent",
	"phone.page.remove",
	"phone.page.left",
	"phone.page.none",
	"phone.page.expired",
	"phone.page.error",
] as const satisfies readonly MessageKey[];

/** The page's strings for a locale ({n} stays a placeholder for the script). */
export function phonePageStrings(locale: Locale): Record<(typeof PAGE_KEYS)[number], string> {
	const out = {} as Record<(typeof PAGE_KEYS)[number], string>;
	for (const key of PAGE_KEYS) out[key] = formatMessage(MESSAGES[locale][key], { n: "{n}" }, locale);
	return out;
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function phonePageHtml(session: Pick<PhoneSession, "token" | "remaining" | "locale">, nonce: string): string {
	const s = phonePageStrings(session.locale);
	const config = { strings: s, remaining: session.remaining, maxSide: ATTACHMENT_MAX_SIDE, quality: ATTACHMENT_JPEG_QUALITY };
	return `<!doctype html>
<html lang="${session.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(s["phone.page.title"])}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --bg: #faf9f7; --fg: #1d1c1a; --muted: #6f6b66; --card: #ffffff; --border: #e3e0db; --primary: #1d1c1a; --on-primary: #ffffff; --warn: #b4531f; --ok: #2f7d4f; }
@media (prefers-color-scheme: dark) { :root { --bg: #161514; --fg: #ecebe8; --muted: #a29d97; --card: #201f1d; --border: #34322f; --primary: #ecebe8; --on-primary: #161514; --warn: #e08a5a; --ok: #6cc08f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 32rem; margin: 0 auto; padding: max(1.25rem, env(safe-area-inset-top)) 1rem max(1.5rem, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
.row { display: flex; gap: .75rem; }
.btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; min-height: 3rem; border-radius: .75rem; border: 1px solid var(--border); background: var(--card); color: var(--fg); font: inherit; font-weight: 600; padding: .5rem 1rem; }
.btn.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
.btn:disabled { opacity: .45; }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: .75rem; }
.thumb { position: relative; aspect-ratio: 3 / 4; border-radius: .75rem; overflow: hidden; border: 1px solid var(--border); background: var(--card); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb button { position: absolute; top: .4rem; right: .4rem; border: 0; border-radius: 999px; padding: .3rem .65rem; background: rgba(0,0,0,.65); color: #fff; font: inherit; font-size: .85rem; }
.note { color: var(--muted); font-size: .95rem; margin: 0; }
.note.warn { color: var(--warn); }
.note.ok { color: var(--ok); font-weight: 600; }
input[type=file] { display: none; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(s["phone.page.title"])}</h1>
<div class="row">
<label class="btn" id="cameraBtn"><input id="camera" type="file" accept="image/*" capture="environment">${escapeHtml(s["phone.page.camera"])}</label>
<label class="btn" id="galleryBtn"><input id="gallery" type="file" accept="image/*" multiple>${escapeHtml(s["phone.page.gallery"])}</label>
</div>
<div class="grid" id="grid"></div>
<p class="note" id="note" role="status"></p>
<button class="btn primary" id="send" type="button" disabled>${escapeHtml(s["phone.page.send"])}</button>
</main>
<script nonce="${nonce}">
"use strict";
(() => {
const C = ${scriptJson(config)};
const S = C.strings;
const base = location.pathname.replace(/\\/$/, "");
let remaining = C.remaining;
let picked = [];
let busy = false;
let dead = false;
const $ = (id) => document.getElementById(id);
const note = (text, kind) => { const n = $("note"); n.textContent = text; n.className = "note" + (kind ? " " + kind : ""); };
const left = () => remaining - picked.length;
function render() {
	const grid = $("grid");
	grid.replaceChildren(...picked.map((p, i) => {
		const box = document.createElement("div");
		box.className = "thumb";
		const img = document.createElement("img");
		img.src = p.url;
		img.alt = "";
		const rm = document.createElement("button");
		rm.type = "button";
		rm.textContent = S["phone.page.remove"];
		rm.disabled = busy;
		rm.onclick = () => { URL.revokeObjectURL(p.url); picked.splice(i, 1); render(); };
		box.append(img, rm);
		return box;
	}));
	const full = left() <= 0;
	for (const id of ["camera", "gallery"]) $(id).disabled = full || busy || dead;
	$("cameraBtn").style.opacity = $("galleryBtn").style.opacity = full || busy || dead ? ".45" : "";
	$("send").disabled = picked.length === 0 || busy || dead;
	$("send").textContent = busy ? S["phone.page.sending"] : S["phone.page.send"];
	if (dead) return;
	if (!busy && remaining <= 0) note(S["phone.page.none"]);
}
async function toJpeg(file) {
	let source;
	try { source = await createImageBitmap(file, { imageOrientation: "from-image" }); }
	catch {
		source = await new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}
	const w = source.width, h = source.height;
	const scale = Math.min(1, C.maxSide / Math.max(w, h));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(w * scale));
	canvas.height = Math.max(1, Math.round(h * scale));
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
	if (source.close) source.close();
	return await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("encode")), "image/jpeg", C.quality));
}
async function add(files) {
	for (const file of files) {
		if (left() <= 0) break;
		try {
			const blob = await toJpeg(file);
			picked.push({ blob, url: URL.createObjectURL(blob) });
		} catch { note(S["phone.page.error"], "warn"); }
	}
	render();
	if (picked.length > 0) note(S["phone.page.left"].replace("{n}", String(left())));
}
for (const id of ["camera", "gallery"]) $(id).addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; void add(files); });
$("send").addEventListener("click", async () => {
	busy = true; render();
	try {
		while (picked.length > 0) {
			const p = picked[0];
			const res = await fetch(base + "/photos", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: p.blob });
			if (res.status === 404) { dead = true; note(S["phone.page.expired"], "warn"); break; }
			if (res.status === 409) { remaining = 0; break; }
			if (!res.ok) throw new Error(String(res.status));
			remaining = (await res.json()).remaining;
			URL.revokeObjectURL(p.url);
			picked.shift();
		}
		if (!dead && picked.length === 0) note(S["phone.page.sent"], "ok");
	} catch { note(S["phone.page.error"], "warn"); }
	busy = false; render();
});
fetch(base + "/status").then((r) => {
	if (r.status === 404) { dead = true; note(S["phone.page.expired"], "warn"); render(); return; }
	return r.json().then((s) => { remaining = s.remaining; render(); if (remaining > 0) note(S["phone.page.left"].replace("{n}", String(remaining))); });
}).catch(() => {});
render();
})();
</script>
</body>
</html>`;
}

function page(res: http.ServerResponse, session: PhoneSession): void {
	const nonce = randomBytes(16).toString("base64");
	res.writeHead(200, {
		...SECURITY_HEADERS,
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	});
	res.end(phonePageHtml(session, nonce));
}

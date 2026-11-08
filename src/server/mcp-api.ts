/**
 * «Conexión MCP», the app side (owner, 2026-11-08): the local WRITE API an
 * MCP client reaches through the MCP stdio server (src/mcp/api.ts). A second
 * HTTP listener inside the Naipes server process, on 127.0.0.1:<port> only
 * (never the LAN), up while Settings → «Conexión MCP» is on — off by default.
 *
 * Every request needs `Authorization: Bearer <token>` (the keys file entry
 * MCP_TOKEN_AUTH_VAR, read fresh per request: «Regenerar» takes effect at
 * once). Browsers are refused (any Origin header → 403) and so is any Host
 * but the loopback one (DNS rebinding). Routes delegate to the same services
 * the app's own routes call — the single-writer law holds.
 *
 *   GET  /v1/status
 *   GET  /v1/inbox                         the live inbox (suggestions)
 *   POST /v1/inbox/notes                   { title, content }
 *   POST /v1/sessions                      { goal, kind?, propositionIds? }
 *   POST /v1/review/start
 *   POST /v1/exams                         the app's create body
 *   GET  /v1/exams/:id                     the computed plan
 *   PUT  /v1/exams/:id                     the app's edit body
 *   POST /v1/exams/:id/materials           { url, name? } | { text, name } | { fileName, base64 }
 *   POST /v1/exams/:id/agents/:agent       map | classify | research | guide | contrast
 *   POST /v1/exams/:id/sessions            { kind, pointId? }
 *
 * Sessions created here are NOT opened: their opening waits on the record
 * (ChatRecord.pendingOpening) and is sent when the learner opens them.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { EXAM_AGENTS, MCP_API_MAX_BODY_BYTES, MCP_TOKEN_AUTH_VAR, mcpApiEnabled, mcpApiPort, type ExamAgent, type McpExamPlan, type McpInboxItem } from "../core/mcp-api.ts";
import { EXAM_MATERIAL_MAX_BYTES, isExamMaterialFileName } from "../core/exams.ts";
import { authStore } from "../store/auth.ts";
import { readExam } from "../store/exams.ts";
import { createPendingSession, setPendingOpening } from "./chats.ts";
import {
	addExamMaterial,
	classifyExam,
	createExam,
	examDetailView,
	parseExamCreate,
	parseExamPatch,
	parseSessionStart,
	resolveMissingGuide,
	startExamContrast,
	startExamMapping,
	startExamResearch,
	startExamSession,
	updateExam,
	type ResearchScope,
} from "./exams.ts";
import { startReviewSession } from "./review.ts";
import { stores } from "./stores.ts";
import { addInboxNote, inboxOverview, startVaultSync } from "./vault.ts";

// ─── token ──────────────────────────────────────────────────────────────────

export function mcpToken(): string | null {
	const token = authStore.authVars()[MCP_TOKEN_AUTH_VAR];
	return token && token.length >= 32 ? token : null;
}

export function regenerateMcpToken(): string {
	const token = randomBytes(32).toString("base64url");
	authStore.setAuthVar(MCP_TOKEN_AUTH_VAR, token);
	return token;
}

function authorized(header: string | undefined): boolean {
	const token = mcpToken();
	if (!token || !header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice(7));
	const wanted = Buffer.from(token);
	return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

// ─── routes ─────────────────────────────────────────────────────────────────

export interface McpApiRequest {
	method: string;
	path: string;
	body: unknown;
}
export interface McpApiResponse {
	status: number;
	body: unknown;
}

const reply = (status: number, body: unknown): McpApiResponse => ({ status, body });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => reply(status, { error, ...extra });
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isAgent = (v: string): v is ExamAgent => (EXAM_AGENTS as readonly string[]).includes(v);

/** A started background job, or the service's refusal (503 = no model). */
const started = (r: { ok: true } | { ok: false; status: number; error: string }) =>
	r.ok ? reply(202, { ok: true }) : err(r.status, r.error, r.status === 503 ? { code: "models_not_configured" } : {});

function examPlan(id: string): McpApiResponse {
	const view = examDetailView(id);
	if (!view) return err(404, "not_found");
	const plan: McpExamPlan = {
		daysLeft: view.daysLeft,
		coverage: view.coverage,
		reachedPreset: view.reachedPreset,
		meetsStandard: view.meetsStandard,
		infeasible: view.infeasible,
		todayMinutes: view.todayMinutes,
		startedToday: view.startedToday,
		today: view.blocks.map((b) => ({ kind: b.kind, minutes: b.minutes, pointId: b.pointId ?? null, ideas: b.nodeIds.length, short: Boolean(b.short) })),
		upcoming: view.days.slice(0, 14).map((day, i) => ({ day, minutes: view.allocation[i] ?? 0 })),
		minutesStillNeeded: view.work,
		weeklyMinutes: view.weeklyMinutes,
	};
	return reply(200, plan);
}

function inbox(): McpApiResponse {
	startVaultSync(); // idempotent: a tray-only launch has not started it yet
	const overview = inboxOverview();
	const items: McpInboxItem[] = overview.items.map((i) => ({
		path: i.path,
		status: i.status,
		suggestion: i.suggestion ? { folder: i.suggestion.folder, ideas: i.suggestion.count } : null,
		alternatives: i.alternatives.map((a) => ({ folder: a.folder, ideas: a.count })),
	}));
	return reply(200, { enabled: overview.enabled, inbox: overview.inbox, items });
}

function material(id: string, body: Record<string, unknown>): McpApiResponse {
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
	let input: Parameters<typeof addExamMaterial>[1];
	if (typeof body.base64 === "string" && typeof body.fileName === "string") {
		if (!isExamMaterialFileName(body.fileName)) return err(415, "unsupported format (pdf, docx, epub, md, txt, png, jpg, webp, heic)");
		const bytes = Buffer.from(body.base64, "base64");
		if (bytes.length > EXAM_MATERIAL_MAX_BYTES) return err(413, "file too large");
		input = { kind: "file", name: body.fileName, bytes: new Uint8Array(bytes) };
	} else if (typeof body.text === "string" && body.text.trim()) {
		const bytes = new TextEncoder().encode(body.text);
		if (bytes.length > EXAM_MATERIAL_MAX_BYTES) return err(413, "text too large");
		input = { kind: "file", name: name ?? "texto", bytes, storeAs: "pasted.txt" };
	} else if (typeof body.url === "string" && body.url.trim()) {
		input = { kind: "link", url: body.url.trim(), ...(name ? { name } : {}) };
	} else return err(400, "send url, text or a file");
	const result = addExamMaterial(id, input);
	return result.ok ? reply(201, { material: result.value }) : err(result.error === "not_found" ? 404 : 400, result.error);
}

function agent(id: string, which: ExamAgent, body: Record<string, unknown>): McpApiResponse {
	switch (which) {
		case "map":
			return started(startExamMapping(id));
		case "classify":
			return started(classifyExam(id));
		case "contrast":
			return started(startExamContrast(id));
		case "guide":
			if (body.action !== "retry" && body.action !== "skip") return err(400, "action must be retry or skip");
			return started(resolveMissingGuide(id, body.action));
		case "research": {
			const scope: ResearchScope =
				typeof body.pointId === "string" ? { mode: "points", pointIds: [body.pointId] } : body.mode === "all" ? { mode: "all" } : body.mode === "pending" ? { mode: "pending" } : { mode: "missing" };
			return started(startExamResearch(id, scope));
		}
	}
}

/** One API request, already authenticated (the http adapter's core;
 *  tests drive it directly). */
export function handleMcpApi(req: McpApiRequest): McpApiResponse {
	const { method } = req;
	const parts = req.path.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts[0] !== "v1") return err(404, "not found");
	const [, a, b, c, d] = parts;
	const body = asObject(req.body) ?? {};

	if (method === "GET" && a === "status" && !b) return reply(200, { ok: true });
	if (a === "inbox") {
		if (method === "GET" && !b) return inbox();
		if (method === "POST" && b === "notes" && !c) {
			if (typeof body.title !== "string" || !body.title.trim()) return err(400, "title required");
			if (typeof body.content !== "string") return err(400, "content required");
			const r = addInboxNote(body.title, body.content);
			return r.ok ? reply(201, { path: r.path }) : err(r.status, r.error);
		}
	}
	if (a === "sessions" && method === "POST" && !b) {
		if (typeof body.goal !== "string") return err(400, "goal required");
		if (body.kind !== undefined && body.kind !== "teach" && body.kind !== "practice") return err(400, "kind must be teach or practice");
		if (body.propositionIds !== undefined && !(Array.isArray(body.propositionIds) && body.propositionIds.every((x) => typeof x === "string"))) return err(400, "propositionIds must be a list of ids");
		const r = createPendingSession({ goal: body.goal, ...(body.kind === "practice" ? { kind: "practice" as const } : {}), propositionIds: body.propositionIds as string[] | undefined });
		return r.ok ? reply(201, { id: r.id, title: r.title }) : err(400, r.error);
	}
	if (a === "review" && b === "start" && method === "POST" && !c) {
		const s = startReviewSession();
		if (!s) return err(409, "nothing due for review now", { code: "nothing_due" });
		setPendingOpening(s.id, s.opening);
		return reply(201, { id: s.id, title: s.title, ideas: s.nodeIds.length });
	}
	if (a === "exams") {
		if (!b) {
			if (method !== "POST") return err(405, "method not allowed");
			const parsed = parseExamCreate(body);
			if (!parsed.ok) return err(400, parsed.error);
			const exam = createExam(parsed.value);
			return reply(201, { id: exam.id, title: exam.title, status: exam.status });
		}
		if (!c) {
			if (method === "GET") return examPlan(b);
			if (method === "PUT") {
				const parsed = parseExamPatch(body);
				if (!parsed.ok) return err(400, parsed.error);
				const r = updateExam(b, parsed.value);
				return r.ok ? reply(200, { id: r.value.id, status: r.value.status }) : err(r.error === "not_found" ? 404 : 409, r.error);
			}
		}
		if (c === "materials" && method === "POST" && !d) return material(b, body);
		if (c === "agents" && method === "POST" && d && isAgent(d) && parts.length === 5) return agent(b, d, body);
		if (c === "sessions" && method === "POST" && !d) {
			const parsed = parseSessionStart(body);
			if (!parsed.ok) return err(400, parsed.error);
			const r = startExamSession(b, parsed.value.kind, parsed.value.pointId);
			// A draft has no plan yet (the service reads it as absent).
			if (!r.ok && r.status === 404 && readExam(b)?.status === "draft") return err(409, "the exam is not active yet: map its syllabus, then set status active");
			if (!r.ok) return err(r.status, r.error);
			setPendingOpening(r.session.id, r.session.opening);
			return reply(201, { id: r.session.id, title: r.session.title, kind: r.session.kind });
		}
	}
	return err(404, "not found");
}

// ─── the listener ───────────────────────────────────────────────────────────

interface McpApiRegistry {
	server: http.Server | null;
	port: number | null;
	error: string | null;
	/** Serializes reconfigurations (settings writes may race the boot). */
	chain: Promise<void>;
}
const g = globalThis as typeof globalThis & { __npMcpApi?: McpApiRegistry };
const registry = (): McpApiRegistry => (g.__npMcpApi ??= { server: null, port: null, error: null, chain: Promise.resolve() });

function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MCP_API_MAX_BODY_BYTES) {
				reject(new Error("too_large"));
				req.destroy();
			} else chunks.push(chunk);
		});
		req.on("end", () => {
			if (size === 0) return resolve(null);
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
			} catch {
				reject(new Error("bad_json"));
			}
		});
		req.on("error", reject);
	});
}

function send(res: http.ServerResponse, r: McpApiResponse): void {
	const text = JSON.stringify(r.body);
	res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

function createListener(port: number): http.Server {
	return http.createServer((req, res) => {
		void (async () => {
			const host = req.headers.host ?? "";
			if (req.headers.origin !== undefined) return send(res, err(403, "browsers are not allowed"));
			if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, err(403, "bad host"));
			if (!authorized(req.headers.authorization)) return send(res, err(401, "unauthorized"));
			let body: unknown;
			try {
				body = req.method === "GET" ? null : await readBody(req);
			} catch (e) {
				return send(res, (e as Error).message === "too_large" ? err(413, "body too large") : err(400, "invalid JSON body"));
			}
			try {
				send(res, handleMcpApi({ method: req.method ?? "GET", path: req.url ?? "/", body }));
			} catch (e) {
				console.error("[mcp-api]", e);
				send(res, err(500, e instanceof Error ? e.message : String(e)));
			}
		})();
	});
}

function close(reg: McpApiRegistry): Promise<void> {
	const server = reg.server;
	reg.server = null;
	reg.port = null;
	if (!server) return Promise.resolve();
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections?.();
	});
}

async function apply(): Promise<void> {
	const reg = registry();
	const settings = stores.settingsStore.readSettings()?.mcp;
	const port = mcpApiPort(settings);
	if (!mcpApiEnabled(settings)) {
		reg.error = null;
		await close(reg);
		return;
	}
	if (!mcpToken()) regenerateMcpToken();
	if (reg.server && reg.port === port) return;
	await close(reg);
	const server = createListener(port);
	await new Promise<void>((resolve) => {
		server.once("error", (e: NodeJS.ErrnoException) => {
			reg.error = e.code === "EADDRINUSE" ? "port_in_use" : (e.code ?? e.message);
			console.error(`[mcp-api] cannot listen on 127.0.0.1:${port}: ${reg.error}`);
			resolve();
		});
		server.listen(port, "127.0.0.1", () => {
			reg.server = server;
			reg.port = port;
			reg.error = null;
			resolve();
		});
	});
}

/** Bring the listener in line with the settings (boot — below — and every
 *  «Conexión MCP» settings write). Idempotent, serialized. */
export function reconfigureMcpApi(): Promise<void> {
	const reg = registry();
	reg.chain = reg.chain.then(apply, apply);
	return reg.chain;
}

export interface McpApiStatus {
	enabled: boolean;
	port: number;
	listening: boolean;
	/** "port_in_use" or another bind error while enabled. */
	error: string | null;
	token: string | null;
}

/** The Settings block's state (GET /api/mcp). */
export async function mcpApiStatus(): Promise<McpApiStatus> {
	await registry().chain;
	const settings = stores.settingsStore.readSettings()?.mcp;
	const reg = registry();
	return { enabled: mcpApiEnabled(settings), port: mcpApiPort(settings), listening: reg.server !== null, error: reg.error, token: mcpToken() };
}

// Boot (the keys.ts initAuthEnv precedent): the first import of the server
// surface brings the listener in line with the settings — the desktop shell's
// boot probe loads the home page, so a tray-only launch is covered. Not an
// instrumentation hook: Next copies that entry's trace WITHOUT the
// outputFileTracingExcludes, which would ship the repo's data/. Never during
// `next build` page-data collection, never in tests (they call it).
if (process.env.NEXT_PHASE !== "phase-production-build" && process.env.NODE_ENV !== "test") void reconfigureMcpApi();

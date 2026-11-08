/**
 * The MCP server's WRITE side (owner, 2026-11-08): a client of the running
 * app's local API (src/server/mcp-api.ts) — the app stays the single writer
 * of every store. The port comes from the settings record (the data folder
 * this process already reads); the token from this process's environment
 * (MCP_TOKEN_ENV — the client configuration Settings shows).
 *
 * Every failure becomes a plain sentence a model can relay to the learner.
 */

import { MCP_TOKEN_ENV, mcpApiPort } from "../core/mcp-api.ts";
import { readSettings } from "../store/settings.ts";

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number | null; error: string; code?: string };

const SETUP = "In Naipes: Settings → Connections → «Conexión MCP», turn it on, then re-add this MCP server with the configuration shown there.";

export function apiConfigured(): boolean {
	return Boolean(process.env[MCP_TOKEN_ENV]);
}

export async function callApi<T = Record<string, unknown>>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<ApiResult<T>> {
	const token = process.env[MCP_TOKEN_ENV];
	if (!token) return { ok: false, status: null, error: `This MCP server has no write access to Naipes yet. ${SETUP}` };
	const port = mcpApiPort(readSettings()?.mcp);
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(60_000),
		});
	} catch {
		return { ok: false, status: null, error: `Naipes is not reachable on port ${port}: open the Naipes app (and check that «Conexión MCP» is on in Settings → Connections).` };
	}
	const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (res.ok) return { ok: true, status: res.status, body: parsed as T };
	if (res.status === 401) return { ok: false, status: 401, error: `Naipes rejected this MCP server's token (it was regenerated or never matched). ${SETUP}` };
	const code = typeof parsed.code === "string" ? parsed.code : undefined;
	const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
	const hint = code === "models_not_configured" ? " Naipes has no model configured for this: the learner must pick one in Settings → AI." : "";
	return { ok: false, status: res.status, error: `${error}${hint}`, ...(code ? { code } : {}) };
}

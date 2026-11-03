/**
 * GET/POST /api/claude-code — the Claude Code subscription card's controls.
 * Never exposes credentials: Claude Code owns them; we only read its status.
 * Same-origin header discipline as /api/subscriptions (subscriptionRequestOrigin).
 */
import { claudeCodeLogout, claudeCodeStatus, openClaudeCodeLogin, refreshClaudeCodeStatus, setClaudeCodeBackgroundUse } from "../agent/claude-code-bridge.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-subscriptions") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}
const fail = (error: string, status: number) => Response.json({ error }, { status, headers: HEADERS });

export async function claudeCodeControlsResponse(request: Request): Promise<Response> {
	if (!authorized(request)) return fail("Claude Code controls require a same-origin LearnHarness request.", 403);
	if (request.method === "GET") return Response.json(await refreshClaudeCodeStatus(true), { headers: HEADERS });
	if (request.method !== "POST") return fail("Unsupported method.", 405);
	let command: { action?: unknown; enabled?: unknown };
	try { command = JSON.parse((await request.text()).slice(0, 4096)); } catch { return fail("Expected JSON.", 400); }
	switch (command.action) {
		case "refresh": break;
		case "login":
			if (!(await openClaudeCodeLogin())) return fail("Could not open a terminal for `claude auth login`. Run it yourself in a terminal, then check again.", 500);
			break;
		case "logout": await claudeCodeLogout(); break;
		case "consent":
			if (typeof command.enabled !== "boolean") return fail("Expected enabled: boolean.", 400);
			setClaudeCodeBackgroundUse(command.enabled);
			break;
		default: return fail("Unsupported action.", 400);
	}
	await refreshClaudeCodeStatus(true);
	return Response.json(claudeCodeStatus(), { headers: HEADERS });
}

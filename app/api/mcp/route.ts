/**
 * Settings → «Conexión MCP» (owner, 2026-11-08).
 *   GET  /api/mcp → { enabled, port, listening, error, token }
 *   POST /api/mcp { action: "regenerate" } → the same, with a new token
 *        (MCP clients configured with the old one stop writing until
 *        re-added with the new configuration).
 * The on/off switch and the port are the `mcp` settings section.
 */
import { mcpApiStatus, reconfigureMcpApi, regenerateMcpToken } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await mcpApiStatus());
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "regenerate") return Response.json({ error: 'action must be "regenerate"' }, { status: 400 });
	regenerateMcpToken();
	await reconfigureMcpApi();
	return Response.json(await mcpApiStatus());
}

/**
 * GET /api/mcp/deletions — the deletions MCP clients are waiting on (owner,
 * 2026-11-08 — MCP phase 3): the app's confirmation dialog lists them.
 */
import { listMcpDeletions } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ requests: listMcpDeletions() });
}

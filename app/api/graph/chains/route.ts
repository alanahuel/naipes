import { cachedJson, graphChainsBody } from "@/src/server";

/**
 * GET /api/graph/chains — the stored world the chain table and the new-
 * session picker read: full proposition records + merged reasoning chains
 * (GraphChainsView). Split off GET /api/graph so the canvas payload stays
 * slim (perf, owner 2026-11-10); same cache and ETag discipline.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return cachedJson(request, graphChainsBody());
}

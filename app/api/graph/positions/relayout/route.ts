/**
 * POST /api/graph/positions/relayout — the «Reorganizar» action: the
 * resting layout is recomputed from scratch (no anchors, seeded per
 * folder area) and the positions ledger replaced. See
 * src/server/commit-positions.ts (relayoutGraph).
 *
 *   POST → 200 {nodes: <positions written>}
 */
import { relayoutGraph } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(await relayoutGraph());
}

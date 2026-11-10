import { cachedJson, graphCanvasBody } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns the canvas
 * view (GraphCanvasSnapshot: nodes, edges, clusters, areas, positions,
 * session provenance). Cached server-side per graph revision and served
 * with an ETag: an unchanged graph answers 304 (perf, owner 2026-11-10).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return cachedJson(request, graphCanvasBody());
}

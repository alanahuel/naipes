/**
 * POST /api/review/start — create the next review practice session: up to
 * batchSize due ideas, most forgotten first, alternating topics. 200 with
 * { id, title, opening, nodeIds } — the client stashes `opening` as the
 * learner's first message and opens the session; 409 when nothing is due.
 */
import { startReviewSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const started = startReviewSession();
	if (!started) return Response.json({ error: "nothing due", code: "nothing_due" }, { status: 409 });
	return Response.json(started);
}

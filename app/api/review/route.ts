/**
 * GET /api/review — the spaced-review screen's data («Repaso», owner
 * 2026-11-04): today's summary (due by group, retention, forecasts), every
 * enrolled idea (no event log), the activatable Obsidian areas and the
 * current sources (pauses). Computing it also releases today's intake.
 */
import { effectiveSettings, getReviewState, reviewItemViews, summarizeReview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const now = Date.now();
	const locale = effectiveSettings().general.language;
	try {
		const state = getReviewState(now);
		return Response.json({
			summary: summarizeReview(state, now, locale),
			items: reviewItemViews(state, locale),
			areas: state.areas,
			sources: state.sources,
			settings: { targetRetention: effectiveSettings().review.targetRetention, newPerDay: effectiveSettings().review.newPerDay },
		});
	} catch (err) {
		// A newer-version sources.json refuses instead of being rewritten.
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
	}
}

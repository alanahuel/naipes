/**
 * Spaced review service («Repaso», owner 2026-11-04): feeds the pure model
 * (src/core/review.ts) the chat records, the merged graph and the review
 * files, persists today's intake releases, and caches the result.
 *
 * Cache key: graph revision + chats revision + review files + review
 * settings + a 10-minute time bucket (recall probabilities drift slowly;
 * the day boundary is inside the bucket math, so «today» never goes stale
 * by more than ten minutes). Stage 1: no API yet (stage 2 adds it).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { getGraph } from "../core/graph.ts";
import {
	computeReview,
	dueToday,
	emptyReviewSources,
	forecast,
	groupItems,
	meanRetention,
	type ReviewChat,
	type ReviewItem,
	type ReviewModel,
	type ReviewSources,
} from "../core/review.ts";
import { appendIntake, readIntake, readReviewSources, reviewFilesRevision, writeReviewSources } from "../store/review.ts";
import { graphRevision } from "./graph.ts";
import { effectiveSettings, stores } from "./stores.ts";

const BUCKET_MS = 10 * 60_000;

/** Max mtime over the chat files (moves on any chat write). */
function chatsRevision(): number {
	let revision = 0;
	try {
		for (const f of fs.readdirSync(PATHS.chats)) {
			if (!f.endsWith(".json")) continue;
			try {
				revision = Math.max(revision, fs.statSync(path.join(PATHS.chats, f)).mtimeMs);
			} catch {
				/* deleted mid-scan */
			}
		}
	} catch {
		/* no chats dir yet */
	}
	return revision;
}

function readAllChats(): ReviewChat[] {
	const out: ReviewChat[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		if (record) out.push({ id: record.id, kind: record.kind, createdAt: record.createdAt, messages: record.messages });
	}
	return out;
}

/** The sources record, created (activation = now) on first use. */
export function ensureReviewSources(now = Date.now()): ReviewSources {
	const existing = readReviewSources();
	if (existing) return existing;
	const fresh = emptyReviewSources(now);
	writeReviewSources(fresh);
	return fresh;
}

let cache: { key: string; model: ReviewModel } | null = null;

/** The current review model; persists today's intake as a side effect. */
export function getReviewModel(now = Date.now()): ReviewModel {
	const settings = effectiveSettings().review;
	const sources = ensureReviewSources(now);
	const key = [
		graphRevision(),
		chatsRevision(),
		reviewFilesRevision(),
		JSON.stringify(settings),
		Math.floor(now / BUCKET_MS),
	].join("|");
	if (cache?.key === key) return cache.model;

	const sourcePaths: Record<string, string> = {};
	for (const s of stores.graphStore.readSources()) sourcePaths[s.id] = s.filePath;
	const model = computeReview({
		now,
		nodes: getGraph(stores.graphStore).nodes,
		chats: readAllChats(),
		sourcePaths,
		sources,
		intake: readIntake(),
		settings,
	});
	if (model.newIntake.length > 0) appendIntake(model.newIntake);
	// The append moved the review files' mtime: re-key so the next read
	// hits the cache instead of recomputing the same day.
	cache = {
		key: [graphRevision(), chatsRevision(), reviewFilesRevision(), JSON.stringify(settings), Math.floor(now / BUCKET_MS)].join("|"),
		model: { ...model, newIntake: [] },
	};
	return model;
}

/** What the review screen and the notifier read (stage 2 exposes it). */
export interface ReviewSummary {
	today: string;
	due: Array<{ group: ReviewItem["group"]; nodeIds: string[] }>;
	dueCount: number;
	retention: { overall: number | null; byGroup: Array<{ group: ReviewItem["group"]; retention: number | null; count: number }> };
	forecast7: number[];
	forecast30: number[];
	enrolled: number;
	waitingIntake: number;
}

export function summarizeReview(model: ReviewModel, now = Date.now()): ReviewSummary {
	const due = dueToday(model.items, now);
	return {
		today: model.today,
		due: groupItems(due).map((g) => ({ group: g.group, nodeIds: g.items.map((i) => i.nodeId) })),
		dueCount: due.length,
		retention: {
			overall: meanRetention(model.items),
			byGroup: groupItems(model.items).map((g) => ({ group: g.group, retention: meanRetention(g.items), count: g.items.length })),
		},
		forecast7: forecast(model.items, now, 7),
		forecast30: forecast(model.items, now, 30),
		enrolled: model.items.filter((i) => !i.paused).length,
		waitingIntake: model.items.filter((i) => !i.paused && !i.released).length,
	};
}

/** Test seam: forget the cached model. */
export function resetReviewCache(): void {
	cache = null;
}

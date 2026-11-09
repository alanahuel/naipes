/**
 * The learner's MEMORY of each idea (owner, 2026-11-09 — «memoria en el
 * sondeo»): what the probe reads before measuring, so a strand held from
 * earlier sessions starts where the learner left it instead of from zero.
 *
 * Pure: derived from the review state the app already computes — the FSRS
 * card (recall today, last review, lapses) and the reached mode replayed
 * from the same events (`ideaLevel`, the exams' ladder). Every exam's
 * placement chats count as placement (the ladder's placement rule).
 *
 * An idea with no review item has no memory yet (never graded, not
 * enrolled): absent from the map, not zero.
 */

import { ideaLevel, type ModeLevel } from "./exams.ts";
import type { ReviewState } from "./review-state.ts";

export interface IdeaMemory {
	/** Probability of recall right now, 0–1 (null while never graded). */
	retrievability: number | null;
	/** The reached mode: 0 none · 1 recall · 2 discrimination · 3 composition. */
	level: ModeLevel;
	/** Marked to be taught again (two misses at recall or below). */
	toTeach: boolean;
	/** Epoch ms of the last graded or seen event, null when none. */
	lastReview: number | null;
	lapses: number;
}

/** node id → memory, for every idea the review state holds. */
export function ideaMemories(state: Pick<ReviewState, "model" | "chats">): Map<string, IdeaMemory> {
	const placementChats = new Set(state.chats.filter((c) => c.exam?.kind === "placement").map((c) => c.id));
	const out = new Map<string, IdeaMemory>();
	for (const item of state.model.items) {
		const { level, toTeach } = ideaLevel(item.events, placementChats);
		out.set(item.nodeId, {
			retrievability: item.retrievability,
			level,
			toTeach,
			lastReview: item.lastReview,
			lapses: item.lapses,
		});
	}
	return out;
}

const LEVEL_NAME: Record<ModeLevel, string> = { 0: "none", 1: "recall", 2: "discrimination", 3: "composition" };

/** Local "YYYY-MM-DD". */
function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The agent-facing memory line (English, like every agent text):
 *  «recall 82% · reached discrimination · last 2026-10-30 · lapses 1», or
 *  «no memory yet». */
export function memoryLine(memory: IdeaMemory | undefined): string {
	if (!memory || (memory.retrievability === null && memory.lastReview === null)) return "no memory yet";
	const parts: string[] = [];
	parts.push(memory.retrievability === null ? "recall unknown" : `recall ${Math.round(memory.retrievability * 100)}%`);
	parts.push(`reached ${LEVEL_NAME[memory.level]}`);
	if (memory.lastReview !== null) parts.push(`last ${localDay(memory.lastReview)}`);
	parts.push(`lapses ${memory.lapses}`);
	if (memory.toTeach) parts.push("to teach");
	return parts.join(" · ");
}

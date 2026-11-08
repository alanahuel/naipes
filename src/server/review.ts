/**
 * Spaced review service («Repaso», owner 2026-11-04): feeds the pure model
 * (src/core/review.ts) the chat records, the merged graph and the review
 * files, persists today's intake releases, and caches the result. Stage 2
 * adds what the API and the desktop shell need: group labels, the
 * activatable areas, review sessions, notice decisions and sources edits.
 *
 * Cache key: graph revision + chats revision + review files + review
 * settings + a 10-minute time bucket (recall probabilities drift slowly;
 * «today» never goes stale by more than ten minutes).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { getGraph } from "../core/graph.ts";
import type { Locale } from "../core/i18n.ts";
import {
	dueToday,
	emptyReviewSources,
	reviewDay,
	selectBatch,
	shouldSendNotice,
	type ReviewModel,
	type ReviewNoticeKind,
	type ReviewSources,
	type ReviewSummary,
} from "../core/review.ts";
import { assembleReviewState, reviewText, summarizeReview, type LoadedChat, type ReviewState } from "../core/review-state.ts";
import {
	appendIntake,
	appendReviewNotice,
	readIntake,
	readReviewNotices,
	readReviewSources,
	reviewFilesRevision,
	writeReviewSources,
} from "../store/review.ts";
import { createChat, seedGraphContext, stampStrongModel } from "./chats.ts";
import { examsRevision, listExams } from "../store/exams.ts";
import type { ChatExamLink } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
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

function readAllChats(): LoadedChat[] {
	const out: LoadedChat[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		if (record) {
			out.push({ id: record.id, kind: record.kind, createdAt: record.createdAt, messages: record.messages, title: record.title, review: record.review, exam: record.exam });
		}
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


export type { LoadedChat, ReviewState } from "../core/review-state.ts";
export { summarizeReview, reviewItemViews } from "../core/review-state.ts";

let cache: { key: string; state: ReviewState } | null = null;

const cacheKey = (settingsJson: string, now: number) =>
	[graphRevision(), chatsRevision(), reviewFilesRevision(), examsRevision(), settingsJson, Math.floor(now / BUCKET_MS)].join("|");

/** The current review state; persists today's intake as a side effect
 *  (the pure assembly: src/core/review-state.ts). */
export function getReviewState(now = Date.now()): ReviewState {
	const effective = effectiveSettings();
	const settings = effective.review;
	const finalWindowDays = effective.exams.finalWindowDays;
	const sources = ensureReviewSources(now);
	const settingsJson = JSON.stringify([settings, finalWindowDays]);
	const key = cacheKey(settingsJson, now);
	if (cache?.key === key) return cache.state;

	const sourcePaths: Record<string, string> = {};
	for (const s of stores.graphStore.readSources()) sourcePaths[s.id] = s.filePath;
	const state = assembleReviewState({
		now,
		nodes: getGraph(stores.graphStore).nodes,
		chats: readAllChats(),
		sourcePaths,
		sources,
		intake: readIntake(),
		exams: listExams(),
		settings,
		finalWindowDays,
	});
	const { model } = state;
	if (model.newIntake.length > 0) appendIntake(model.newIntake);
	// The intake append moved the review files' mtime: re-key so the next
	// read hits the cache instead of recomputing the same day.
	cache = { key: cacheKey(settingsJson, now), state: { ...state, model: { ...model, newIntake: [] } } };
	return state;
}

/** Back-compat for stage 1 callers/tests: the model alone. */
export function getReviewModel(now = Date.now()): ReviewModel {
	return getReviewState(now).model;
}

// ─── i18n (server-side text for notifications and session titles) ───────────

const t = reviewText;

const interfaceLocale = (): Locale => effectiveSettings().general.language;

// ─── review sessions (POST /api/review/start) ───────────────────────────────

export interface StartedReview {
	id: string;
	title: string;
	/** The learner's opening message (the client sends it). */
	opening: string;
	nodeIds: string[];
}

/** Create the next review practice session, or null when nothing is due. */
export function startReviewSession(now = Date.now(), scope?: { nodeIds: ReadonlySet<string>; exam: ChatExamLink; title: string }): StartedReview | null {
	const state = getReviewState(now);
	const due = dueToday(state.model.items, now).filter((i) => !scope || scope.nodeIds.has(i.nodeId));
	const batch = selectBatch(due, effectiveSettings().review.batchSize);
	if (batch.length === 0) return null;
	const locale = interfaceLocale();
	const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(now));
	const title = scope?.title ?? t(locale, "review.sessionTitle", { date });
	const chat = createChat(title, "practice", { review: { day: state.model.today }, ...(scope ? { exam: scope.exam } : {}) });
	stampStrongModel(chat.id);
	seedGraphContext(
		chat.id,
		batch.map((i) => ({ id: i.nodeId, name: i.name, statement: state.statements.get(i.nodeId) ?? i.name })),
	);
	return { id: chat.id, title: chat.title, opening: t(locale, "review.opening"), nodeIds: batch.map((i) => i.nodeId) };
}

// ─── notices (POST /api/review/notify — asked by the desktop shell) ─────────

export interface ReviewNotice {
	notify: boolean;
	title?: string;
	body?: string;
	/** Ideas due right now (the tray counter reads it on every tick). */
	count: number;
}

/** "Estoicismo (6), FÍSICA (4) y 1 tema más." */
export function groupsSentence(groups: ReviewSummary["due"], locale: Locale): string {
	const part = (g: ReviewSummary["due"][number]) => t(locale, "review.notice.group", { label: g.label, count: g.nodeIds.length });
	const sorted = [...groups].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
	if (sorted.length === 1) return t(locale, "review.notice.groupsOne", { a: part(sorted[0]!) });
	if (sorted.length === 2) return t(locale, "review.notice.groupsTwo", { a: part(sorted[0]!), b: part(sorted[1]!) });
	return t(locale, "review.notice.groupsMore", { a: part(sorted[0]!), b: part(sorted[1]!), n: sorted.length - 2 });
}

/** Decide (owner rules), record and word one review notice. */
export function reviewNotice(kind: ReviewNoticeKind, now = Date.now()): ReviewNotice {
	const state = getReviewState(now);
	const locale = interfaceLocale();
	const summary = summarizeReview(state, now, locale);
	const settings = effectiveSettings().review;
	const send = shouldSendNotice({
		kind,
		now,
		digestTime: settings.digestTime,
		eveningTime: settings.eveningTime,
		dueCount: summary.dueCount,
		sent: readReviewNotices(),
		reviewStartedToday: summary.reviewedToday,
	});
	if (!send) return { notify: false, count: summary.dueCount };
	appendReviewNotice({ day: reviewDay(now), kind, at: new Date(now).toISOString(), count: summary.dueCount });
	emit("review-notice", { kind, count: summary.dueCount });
	const n = summary.dueCount;
	return kind === "digest"
		? { notify: true, count: n, title: t(locale, "review.notice.digestTitle", { n }), body: t(locale, "review.notice.digestBody", { groups: groupsSentence(summary.due, locale) }) }
		: { notify: true, count: n, title: t(locale, "review.notice.eveningTitle", { n }), body: t(locale, "review.notice.eveningBody", { n }) };
}

// ─── sources (PUT /api/review/sources) ──────────────────────────────────────

export interface ReviewSourcesPatch {
	areas?: string[];
	paused?: Partial<ReviewSources["paused"]>;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10_000 && v.every((x) => typeof x === "string" && x.length > 0 && x.length < 1024);

/** Strict body parse for PUT /api/review/sources (400 on any bad shape). */
export function parseReviewSourcesPatch(body: unknown): { ok: true; patch: ReviewSourcesPatch } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	const patch: ReviewSourcesPatch = {};
	if (raw.areas !== undefined) {
		if (!isStringList(raw.areas)) return { ok: false, error: "areas must be a list of area ids" };
		patch.areas = raw.areas;
	}
	if (raw.paused !== undefined) {
		if (!raw.paused || typeof raw.paused !== "object" || Array.isArray(raw.paused)) return { ok: false, error: "paused must be an object" };
		const paused = raw.paused as Record<string, unknown>;
		patch.paused = {};
		for (const field of ["sessions", "areas", "nodes"] as const) {
			if (paused[field] === undefined) continue;
			if (!isStringList(paused[field])) return { ok: false, error: `paused.${field} must be a list of ids` };
			patch.paused[field] = paused[field];
		}
	}
	return { ok: true, patch };
}

/** Replace the given lists (absent = unchanged). Activation time stays. */
export function updateReviewSources(patch: ReviewSourcesPatch, now = Date.now()): ReviewSources {
	const current = ensureReviewSources(now);
	const next: ReviewSources = {
		...current,
		areas: patch.areas ? [...new Set(patch.areas)] : current.areas,
		paused: {
			sessions: patch.paused?.sessions ? [...new Set(patch.paused.sessions)] : current.paused.sessions,
			areas: patch.paused?.areas ? [...new Set(patch.paused.areas)] : current.paused.areas,
			nodes: patch.paused?.nodes ? [...new Set(patch.paused.nodes)] : current.paused.nodes,
		},
	};
	writeReviewSources(next);
	cache = null;
	return next;
}

/** Test seam: forget the cached state. */
export function resetReviewCache(): void {
	cache = null;
}

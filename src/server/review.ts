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
import { areaOfPath, SESSIONS_AREA_ID } from "../core/areas.ts";
import { getGraph } from "../core/graph.ts";
import { formatMessage, type Locale, type MessageVars } from "../core/i18n.ts";
import { MESSAGES, type MessageKey } from "../core/messages/index.ts";
import {
	computeReview,
	dueToday,
	emptyReviewSources,
	forecast,
	groupItems,
	meanRetention,
	reviewDay,
	selectBatch,
	shouldSendNotice,
	type ReviewChat,
	type ReviewGroup,
	type ReviewItem,
	type ReviewModel,
	type ReviewNoticeKind,
	type ReviewSources,
	type ReviewArea,
	type ReviewItemView,
	type ReviewSummary,
} from "../core/review.ts";
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
import { deadlineDue, examNodeIds, isLiveExam, type ExamDeadline, type ExamRecord } from "../core/exams.ts";
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

export interface LoadedChat extends ReviewChat {
	title: string;
	review?: { day: string };
	exam?: ChatExamLink;
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


export interface ReviewState {
	model: ReviewModel;
	/** "session:<id>" / "area:<id>" → display label. */
	labels: Record<string, string>;
	areas: ReviewArea[];
	sources: ReviewSources;
	/** Review sessions created per review day. */
	reviewDays: string[];
	/** Graph propositions by id — statements for review picks. */
	statements: Map<string, string>;
	/** Graph proposition names by id. */
	names: Map<string, string>;
	/** Every chat record (the exam service reads them). */
	chats: LoadedChat[];
	/** chat id → propositions with provenance in it. */
	nodesBornIn: Map<string, string[]>;
	/** The live exams this state was computed with. */
	exams: ExamRecord[];
}

const groupKey = (g: ReviewGroup) => `${g.kind}:${g.id}`;

let cache: { key: string; state: ReviewState } | null = null;

const cacheKey = (settingsJson: string, now: number) =>
	[graphRevision(), chatsRevision(), reviewFilesRevision(), examsRevision(), settingsJson, Math.floor(now / BUCKET_MS)].join("|");

/** The current review state; persists today's intake as a side effect. */
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
	const nodes = getGraph(stores.graphStore).nodes;
	const chats = readAllChats();
	const nodesBornIn = new Map<string, string[]>();
	for (const node of nodes) {
		for (const p of node.provenance) {
			const list = nodesBornIn.get(p.chatId);
			if (!list) nodesBornIn.set(p.chatId, [node.id]);
			else if (list[list.length - 1] !== node.id) list.push(node.id);
		}
	}
	// Live exams («Exámenes», owner 2026-11-05): their ideas join Repaso
	// with a deadline-aware due (src/core/exams.ts deadlineDue).
	const today = reviewDay(now);
	const exams = listExams().filter((e) => isLiveExam(e, today));
	const deadlinesOf = new Map<string, ExamDeadline[]>();
	for (const exam of exams) {
		const deadline: ExamDeadline = { examId: exam.id, nodeIds: examNodeIds(exam, chats, nodesBornIn), examDate: exam.examDate, recall: exam.standard.recall, finalWindowDays };
		for (const id of deadline.nodeIds) deadlinesOf.set(id, [...(deadlinesOf.get(id) ?? []), deadline]);
	}
	const examInput = deadlinesOf.size
		? {
				nodeIds: new Set(deadlinesOf.keys()),
				due: (nodeId: string, card: { due: number; stability: number; lastReview: number }) =>
					Math.min(...(deadlinesOf.get(nodeId) ?? []).map((deadline) => deadlineDue({ ...card, targetRetention: settings.targetRetention, deadline })), card.due),
			}
		: undefined;
	const model = computeReview({ now, nodes, chats, sourcePaths, sources, intake: readIntake(), settings, exams: examInput });
	if (model.newIntake.length > 0) appendIntake(model.newIntake);

	const labels: Record<string, string> = {};
	for (const chat of chats) labels[`session:${chat.id}`] = chat.title;
	const areaCounts = new Map<string, { label: string; count: number }>();
	for (const node of nodes) {
		const birth = node.provenance[0]?.chatId;
		const filePath = birth ? sourcePaths[birth] : undefined;
		if (filePath === undefined) continue;
		const area = areaOfPath(filePath);
		const entry = areaCounts.get(area.id) ?? { label: area.label, count: 0 };
		entry.count++;
		areaCounts.set(area.id, entry);
		labels[`area:${area.id}`] = area.label;
	}
	const active = new Set(sources.areas);
	const pausedAreas = new Set(sources.paused.areas);
	const areas: ReviewArea[] = [...areaCounts]
		.map(([id, { label, count }]) => ({ id, label, count, active: active.has(id), paused: pausedAreas.has(id) }))
		.filter((a) => a.id !== SESSIONS_AREA_ID)
		.sort((a, b) => a.label.localeCompare(b.label));

	const state: ReviewState = {
		model: { ...model, newIntake: [] },
		labels,
		areas,
		sources,
		reviewDays: chats.filter((c) => c.review?.day).map((c) => c.review!.day),
		statements: new Map(nodes.map((n) => [n.id, n.statement])),
		names: new Map(nodes.map((n) => [n.id, n.name])),
		chats,
		nodesBornIn,
		exams,
	};
	// The intake append moved the review files' mtime: re-key so the next
	// read hits the cache instead of recomputing the same day.
	cache = { key: cacheKey(settingsJson, now), state };
	return { ...state, model };
}

/** Back-compat for stage 1 callers/tests: the model alone. */
export function getReviewModel(now = Date.now()): ReviewModel {
	return getReviewState(now).model;
}

// ─── summary (GET /api/review, the tray count, notices) ─────────────────────


function labelOf(labels: Record<string, string>, group: ReviewGroup, locale: Locale): string {
	if (group.kind === "area" && group.id === SESSIONS_AREA_ID) return t(locale, "review.group.sessions");
	return labels[groupKey(group)] ?? group.id;
}

export function summarizeReview(state: Pick<ReviewState, "model" | "labels" | "reviewDays">, now = Date.now(), locale: Locale = "es"): ReviewSummary {
	const { model, labels } = state;
	const due = dueToday(model.items, now);
	return {
		today: model.today,
		due: groupItems(due).map((g) => ({ group: g.group, label: labelOf(labels, g.group, locale), nodeIds: g.items.map((i) => i.nodeId) })),
		dueCount: due.length,
		retention: {
			overall: meanRetention(model.items),
			byGroup: groupItems(model.items).map((g) => ({
				group: g.group,
				label: labelOf(labels, g.group, locale),
				retention: meanRetention(g.items),
				count: g.items.length,
			})),
		},
		forecast7: forecast(model.items, now, 7),
		forecast30: forecast(model.items, now, 30),
		enrolled: model.items.filter((i) => !i.paused).length,
		waitingIntake: model.items.filter((i) => !i.paused && !i.released).length,
		reviewedToday: state.reviewDays.includes(model.today),
	};
}


export function reviewItemViews(state: ReviewState, locale: Locale = "es"): ReviewItemView[] {
	return state.model.items.map(({ events: _events, ...item }) => ({ ...item, label: labelOf(state.labels, item.group, locale) }));
}

// ─── i18n (server-side text for notifications and session titles) ───────────

function t(locale: Locale, key: MessageKey, vars: MessageVars = {}): string {
	return formatMessage(MESSAGES[locale][key], vars, locale);
}

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

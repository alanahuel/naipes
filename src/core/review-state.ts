/**
 * The review STATE assembly («Repaso», owner 2026-11-04), pure: raw records
 * in (graph nodes, chat records, review files, live exams, settings) →
 * the model plus its presentation context (labels, areas, statements).
 *
 * Split out of src/server/review.ts for the MCP server (owner, 2026-11-08):
 * the app's service persists today's intake releases (`model.newIntake`)
 * after calling this; the MCP read side calls it and persists NOTHING — a
 * read-only preview of exactly what the app would show at `now`.
 */

import { areaOfPath, SESSIONS_AREA_ID } from "./areas.ts";
import type { ChatExamLink, GraphNode } from "./contracts.ts";
import { deadlineDue, examNodeIds, isLiveExam, sharePrerequisiteIdeas, type ExamDeadline, type ExamRecord } from "./exams.ts";
import { formatMessage, type Locale, type MessageVars } from "./i18n.ts";
import { MESSAGES, type MessageKey } from "./messages/index.ts";
import {
	computeReview,
	dueToday,
	forecast,
	groupItems,
	meanRetention,
	reviewDay,
	type IntakeLine,
	type ReviewArea,
	type ReviewChat,
	type ReviewGroup,
	type ReviewItemView,
	type ReviewModel,
	type ReviewSources,
	type ReviewSummary,
} from "./review.ts";

export interface LoadedChat extends ReviewChat {
	title: string;
	review?: { day: string };
	exam?: ChatExamLink;
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

export interface ReviewStateInput {
	now: number;
	nodes: readonly GraphNode[];
	chats: LoadedChat[];
	/** Notes source id ("src_…") → knowledge-folder-relative file path. */
	sourcePaths: Readonly<Record<string, string>>;
	sources: ReviewSources;
	intake: readonly IntakeLine[];
	/** Every exam record; the live ones are selected here. */
	exams: readonly ExamRecord[];
	settings: { targetRetention: number; newPerDay: number; confidenceThreshold: number };
	finalWindowDays: number;
}

const groupKey = (g: ReviewGroup) => `${g.kind}:${g.id}`;

/** The review state at `input.now`. `model.newIntake` carries today's
 *  releases for the caller to persist (or not). */
export function assembleReviewState(input: ReviewStateInput): ReviewState {
	const { now, nodes, chats, sourcePaths, sources, settings, finalWindowDays } = input;
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
	// Same-key «conocimientos previos» share their ideas (owner 2026-11-09).
	const exams = sharePrerequisiteIdeas(input.exams.filter((e) => isLiveExam(e, today)), chats, nodesBornIn);
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
	const model = computeReview({ now, nodes, chats, sourcePaths, sources, intake: input.intake, settings, exams: examInput });

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

	return {
		model,
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
}

// ─── presentation (GET /api/review, the tray count, notices, MCP) ───────────

export function reviewText(locale: Locale, key: MessageKey, vars: MessageVars = {}): string {
	return formatMessage(MESSAGES[locale][key], vars, locale);
}

function labelOf(labels: Record<string, string>, group: ReviewGroup, locale: Locale): string {
	if (group.kind === "area" && group.id === SESSIONS_AREA_ID) return reviewText(locale, "review.group.sessions");
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

export function reviewItemViews(state: Pick<ReviewState, "model" | "labels">, locale: Locale = "es"): ReviewItemView[] {
	return state.model.items.map(({ events: _events, ...item }) => ({ ...item, label: labelOf(state.labels, item.group, locale) }));
}

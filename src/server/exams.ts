/**
 * Exam service («Exámenes», owner 2026-11-05): feeds the pure model
 * (src/core/exams.ts) the review state, the chat records and the graph;
 * owns the exam records' lifecycle (create → map → confirm → active →
 * archived), the syllabus mapping job, the exam sessions and the exam
 * notices. Nothing derived is stored.
 */

import { areaOfPath } from "../core/areas.ts";
import type { ChatExamLink, ChatRecord, ExamSessionKind } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import {
	allPoints,
	computeExamStatus,
	effectiveDurations,
	EXAM_PRESETS,
	examNodeIds,
	examWork,
	infeasibility,
	isExamDate,
	isLiveExam,
	measureDurations,
	MODE_LEVEL,
	numberBlocks,
	planBudget,
	PRESET_ORDER,
	presetStandard,
	sanitizeBlocks,
	sanitizeStandard,
	syllabusCandidates,
	todayBlocks,
	type Durations,
	type ExamBlock,
	type ExamPreset,
	type ExamRecord,
	type ExamStandard,
	type ExamStatusModel,
	type Infeasibility,
	type WorkBreakdown,
} from "../core/exams.ts";
import { formatMessage, type Locale, type MessageVars } from "../core/i18n.ts";
import { MESSAGES, type MessageKey } from "../core/messages/index.ts";
import { daysBetween, reviewDay, reviewDayEnd, type ReviewItem } from "../core/review.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { isWeeklyMinutes } from "../core/settings.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { examAppendix } from "../agent/prompt-segments.ts";
import { runSyllabusMapper } from "../agent/subagents/syllabus-mapper.ts";
import { appendExamNotice, deleteExam as removeExamFile, isExamId, listExams, newExamId, readExam, readExamNotices, writeExam, type ExamNoticeKind } from "../store/exams.ts";
import { createChat, seedGraphContext, stampStrongModel } from "./chats.ts";
import { getReviewState, groupsSentence, resetReviewCache, startReviewSession, summarizeReview, type ReviewState } from "./review.ts";
import { appendReviewNotice, readReviewNotices } from "../store/review.ts";
import { DAY_ROLLOVER_HOUR, shouldSendNotice, type ReviewNoticeKind } from "../core/review.ts";
import { effectiveSettings, stores } from "./stores.ts";

// ─── i18n ───────────────────────────────────────────────────────────────────

function t(locale: Locale, key: MessageKey, vars: MessageVars = {}): string {
	return formatMessage(MESSAGES[locale][key], vars, locale);
}
const interfaceLocale = (): Locale => effectiveSettings().general.language;

export function standardLabel(standard: ExamStandard, locale: Locale): string {
	return t(locale, standard.preset ? `exams.preset.${standard.preset}` : "exams.preset.custom");
}

// ─── the computed state ─────────────────────────────────────────────────────

export interface ExamComputed {
	record: ExamRecord;
	status: ExamStatusModel | null;
	live: boolean;
	work: WorkBreakdown | null;
	presetWork: Record<ExamPreset, number> | null;
	/** Minutes per day from today (live exams), the plan's allocation. */
	allocation: number[];
	todayMinutes: number;
	blocks: ExamBlock[];
	infeasible: Infeasibility | null;
	/** An exam session was created for it today. */
	startedToday: boolean;
}

export interface ExamsState {
	now: number;
	today: string;
	exams: ExamComputed[];
	durations: Durations;
	days: string[];
	review: ReviewState;
}

/** Finished (or interrupted) mappings this process is not running. */
const RUNNING_KEY = "__npExamMappings";
const running = (): Set<string> => {
	const g = globalThis as unknown as Record<string, Set<string> | undefined>;
	return (g[RUNNING_KEY] ??= new Set<string>());
};

function touch(exam: ExamRecord, now = Date.now()): ExamRecord {
	return { ...exam, updatedAt: new Date(now).toISOString() };
}

function save(exam: ExamRecord): void {
	writeExam(exam);
	resetReviewCache();
	emit("exams-changed", { examId: exam.id });
}

function statusFor(record: ExamRecord, review: ReviewState, now: number): ExamStatusModel | null {
	if (record.blocks.length === 0) return null;
	const items = new Map<string, ReviewItem>(review.model.items.map((i) => [i.nodeId, i]));
	return computeExamStatus({
		exam: record,
		now,
		items,
		names: review.names,
		chats: review.chats,
		nodesBornIn: review.nodesBornIn,
		confidenceThreshold: effectiveSettings().review.confidenceThreshold,
		dueEnd: reviewDayEnd(now),
	});
}

/** Everything the API and the notices read. Archives exams whose date
 *  passed (owner: freeze the final predicted level). */
/** A what-if for the wizard's last step: this exam as if active, with
 *  this standard and weekly budget. */
export interface ExamsWhatIf {
	examId: string;
	standard?: ExamStandard;
	weeklyMinutes?: number[];
}

export function getExamsState(now = Date.now(), whatIf?: ExamsWhatIf): ExamsState {
	const today = reviewDay(now);
	let review = getReviewState(now);
	let records = listExams();
	// Past exams archive themselves with their final standing.
	let archived = false;
	for (const record of records) {
		if (record.status !== "active" || record.examDate >= today) continue;
		const status = statusFor(record, review, now);
		const final = { coverage: status?.coverage ?? 0, preset: status?.reachedPreset ?? null };
		writeExam({ ...touch(record, now), status: "archived", archivedAt: new Date(now).toISOString(), final });
		archived = true;
	}
	// Interrupted mappings (the process restarted mid-call) say so.
	for (const record of records) {
		if (record.mapping.state === "running" && !running().has(record.id)) {
			writeExam({ ...touch(record, now), mapping: { state: "error", error: "interrupted", at: new Date(now).toISOString() } });
			archived = true;
		}
	}
	if (archived) {
		resetReviewCache();
		review = getReviewState(now);
		records = listExams();
	}

	const settings = effectiveSettings().exams;
	const durations = effectiveDurations(
		{ teach: settings.teachMinutes, consolidate: settings.consolidateMinutes, problem: settings.problemMinutes, review: settings.reviewMinutes },
		measureDurations(review.chats),
	);
	const items = new Map<string, ReviewItem>(review.model.items.map((i) => [i.nodeId, i]));

	const computed: ExamComputed[] = records.map((stored) => {
		const record: ExamRecord =
			whatIf?.examId === stored.id ? { ...stored, status: "active", ...(whatIf.standard ? { standard: whatIf.standard } : {}) } : stored;
		const status = statusFor(record, review, now);
		const live = isLiveExam(record, today) && status !== null;
		const base = { status, durations, examDate: record.examDate, now, finalWindowDays: settings.finalWindowDays, priorityBlocks: record.priorityBlocks, items };
		const work = live ? examWork({ ...base, status: status!, standard: record.standard }) : null;
		const presetWork = live
			? (Object.fromEntries(PRESET_ORDER.map((p) => [p, examWork({ ...base, status: status!, standard: EXAM_PRESETS[p] }).total])) as Record<ExamPreset, number>)
			: null;
		const startedToday = review.chats.some((c) => c.exam?.id === record.id && reviewDay(Date.parse(c.createdAt)) === today);
		return { record, status, live, work, presetWork, allocation: [], todayMinutes: 0, blocks: [], infeasible: null, startedToday };
	});

	const plan = planBudget({
		today,
		weeklyMinutes: whatIf?.weeklyMinutes ?? settings.weeklyMinutes,
		exams: computed.filter((c) => c.live).map((c) => ({ examId: c.record.id, examDate: c.record.examDate, work: c.work!.total })),
	});
	for (const c of computed) {
		if (!c.live) continue;
		c.allocation = plan.allocations[c.record.id] ?? [];
		c.todayMinutes = c.allocation[0] ?? 0;
		c.blocks = todayBlocks({ status: c.status!, standard: c.record.standard, minutes: c.todayMinutes, durations, priorityBlocks: c.record.priorityBlocks });
		const allocated = c.allocation.reduce((s, x) => s + x, 0);
		c.infeasible = infeasibility({ shortfall: plan.shortfall[c.record.id] ?? 0, daysLeft: plan.studyDays[c.record.id] ?? 0, allocated, presetWork: c.presetWork! });
	}
	return { now, today, exams: computed, durations, days: plan.days, review };
}

// ─── API views ──────────────────────────────────────────────────────────────

export interface ExamSummaryView {
	id: string;
	title: string;
	examDate: string;
	status: ExamRecord["status"];
	daysLeft: number;
	standard: ExamStandard;
	mapping: ExamRecord["mapping"];
	coverage: number | null;
	reachedPreset: ExamPreset | null;
	meetsStandard: boolean;
	todayMinutes: number;
	infeasible: Infeasibility | null;
	final?: ExamRecord["final"];
	realGrade?: string;
}

export interface ExamDetailView extends ExamSummaryView {
	record: ExamRecord;
	model: ExamStatusModel | null;
	blocks: ExamBlock[];
	/** Planned minutes for the next days (index 0 = today). */
	allocation: number[];
	days: string[];
	work: WorkBreakdown | null;
	presetWork: Record<ExamPreset, number> | null;
	durations: Durations;
	weeklyMinutes: number[];
	startedToday: boolean;
}

function summaryOf(c: ExamComputed, today: string): ExamSummaryView {
	return {
		id: c.record.id,
		title: c.record.title,
		examDate: c.record.examDate,
		status: c.record.status,
		daysLeft: daysBetween(today, c.record.examDate),
		standard: c.record.standard,
		mapping: c.record.mapping,
		coverage: c.status?.coverage ?? null,
		reachedPreset: c.status?.reachedPreset ?? null,
		meetsStandard: c.status?.meetsStandard ?? false,
		todayMinutes: c.blocks.reduce((s, b) => s + b.minutes, 0),
		infeasible: c.infeasible,
		...(c.record.final ? { final: c.record.final } : {}),
		...(c.record.realGrade ? { realGrade: c.record.realGrade } : {}),
	};
}

export function listExamViews(now = Date.now()): ExamSummaryView[] {
	const state = getExamsState(now);
	return state.exams.map((c) => summaryOf(c, state.today));
}

export function examDetailView(id: string, now = Date.now()): ExamDetailView | null {
	const state = getExamsState(now);
	const c = state.exams.find((e) => e.record.id === id);
	if (!c) return null;
	return {
		...summaryOf(c, state.today),
		record: c.record,
		model: c.status,
		blocks: c.blocks,
		allocation: c.allocation,
		days: state.days,
		work: c.work,
		presetWork: c.presetWork,
		durations: state.durations,
		weeklyMinutes: effectiveSettings().exams.weeklyMinutes,
		startedToday: c.startedToday,
	};
}

/** The wizard's forecast: the highest preset this exam reaches with the
 *  given standard and budget, and the shortfall against that standard. */
export function previewExamPlan(id: string, whatIf: Omit<ExamsWhatIf, "examId">, now = Date.now()): { bestPreset: ExamPreset | null; shortfall: number; extraPerDay: number; feasible: boolean } | null {
	const state = getExamsState(now, { examId: id, ...whatIf });
	const c = state.exams.find((e) => e.record.id === id);
	if (!c || !c.live || !c.presetWork) return null;
	const allocated = c.allocation.reduce((s, x) => s + x, 0);
	let bestPreset: ExamPreset | null = null;
	for (const p of PRESET_ORDER) if (c.presetWork[p] <= allocated + 1e-9) bestPreset = p;
	return { bestPreset, shortfall: c.infeasible?.shortfall ?? 0, extraPerDay: c.infeasible?.extraPerDay ?? 0, feasible: !c.infeasible };
}

/** Strict parse for POST /api/exams/[id]/preview. */
export function parsePreview(body: unknown): ParseResult<Omit<ExamsWhatIf, "examId">> {
	const raw = asObject(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const out: Omit<ExamsWhatIf, "examId"> = {};
	if (raw.standard !== undefined) {
		const standard = sanitizeStandard(raw.standard);
		if (!standard) return { ok: false, error: "standard must be { preset, recall, mode, coverage }" };
		out.standard = standard;
	}
	if (raw.weeklyMinutes !== undefined) {
		if (!isWeeklyMinutes(raw.weeklyMinutes)) return { ok: false, error: "weeklyMinutes must be 7 integers between 0 and 720" };
		out.weeklyMinutes = [...raw.weeklyMinutes];
	}
	return { ok: true, value: out };
}

// ─── create / edit ──────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const asObject = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export const MAX_SYLLABUS_CHARS = 200_000;

export interface ExamCreateBody {
	title: string;
	examDate: string;
	standard: ExamStandard;
	syllabus: ExamRecord["syllabus"];
}

/** Strict parse for POST /api/exams. */
export function parseExamCreate(body: unknown): ParseResult<ExamCreateBody> {
	const raw = asObject(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	if (!title || title.length > 300) return { ok: false, error: "title must be 1–300 characters" };
	if (!isExamDate(raw.examDate)) return { ok: false, error: "examDate must be YYYY-MM-DD" };
	const standard = raw.standard === undefined ? presetStandard("pass") : sanitizeStandard(raw.standard);
	if (!standard) return { ok: false, error: "standard must be { preset, recall, mode, coverage }" };
	const syllabus = asObject(raw.syllabus) ?? {};
	const text = typeof syllabus.text === "string" ? syllabus.text : "";
	if (text.length > MAX_SYLLABUS_CHARS) return { ok: false, error: `syllabus text over ${MAX_SYLLABUS_CHARS} characters` };
	const areas = Array.isArray(syllabus.areas) ? syllabus.areas.filter((a): a is string => typeof a === "string" && a.length > 0 && a.length < 1024) : [];
	const fileName = typeof syllabus.fileName === "string" && syllabus.fileName.length <= 500 ? syllabus.fileName : null;
	if (!text.trim() && areas.length === 0) return { ok: false, error: "the syllabus needs text, a file or areas" };
	return { ok: true, value: { title, examDate: raw.examDate, standard, syllabus: { text, fileName, areas: [...new Set(areas)] } } };
}

export function createExam(body: ExamCreateBody, now = Date.now()): ExamRecord {
	const at = new Date(now).toISOString();
	const exam: ExamRecord = {
		version: 1,
		id: newExamId(),
		title: body.title,
		examDate: body.examDate,
		createdAt: at,
		updatedAt: at,
		status: "draft",
		standard: body.standard,
		syllabus: body.syllabus,
		blocks: [],
		mapping: { state: "none" },
		priorityBlocks: [],
	};
	save(exam);
	return exam;
}

export interface ExamPatch {
	title?: string;
	examDate?: string;
	standard?: ExamStandard;
	blocks?: ExamRecord["blocks"];
	priorityBlocks?: string[];
	/** draft → active once the mapping is confirmed; active ↔ archived. */
	status?: ExamRecord["status"];
	realGrade?: string | null;
}

/** Strict parse for PUT /api/exams/[id] (absent = unchanged). */
export function parseExamPatch(body: unknown): ParseResult<ExamPatch> {
	const raw = asObject(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const patch: ExamPatch = {};
	if (raw.title !== undefined) {
		if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 300) return { ok: false, error: "title must be 1–300 characters" };
		patch.title = raw.title.trim();
	}
	if (raw.examDate !== undefined) {
		if (!isExamDate(raw.examDate)) return { ok: false, error: "examDate must be YYYY-MM-DD" };
		patch.examDate = raw.examDate;
	}
	if (raw.standard !== undefined) {
		const standard = sanitizeStandard(raw.standard);
		if (!standard) return { ok: false, error: "standard must be { preset, recall, mode, coverage }" };
		patch.standard = standard;
	}
	if (raw.blocks !== undefined) {
		if (!Array.isArray(raw.blocks)) return { ok: false, error: "blocks must be a list" };
		const blocks = sanitizeBlocks(raw.blocks);
		if (blocks.length !== raw.blocks.length) return { ok: false, error: "every block needs a unique id, a title and valid points" };
		patch.blocks = blocks;
	}
	if (raw.priorityBlocks !== undefined) {
		if (!Array.isArray(raw.priorityBlocks) || !raw.priorityBlocks.every((b) => typeof b === "string")) return { ok: false, error: "priorityBlocks must be a list of block ids" };
		patch.priorityBlocks = [...new Set(raw.priorityBlocks as string[])];
	}
	if (raw.status !== undefined) {
		if (raw.status !== "active" && raw.status !== "archived") return { ok: false, error: "status must be active or archived" };
		patch.status = raw.status;
	}
	if (raw.realGrade !== undefined) {
		if (raw.realGrade !== null && (typeof raw.realGrade !== "string" || raw.realGrade.length > 100)) return { ok: false, error: "realGrade must be a short text or null" };
		patch.realGrade = raw.realGrade === null ? null : raw.realGrade.trim();
	}
	return { ok: true, value: patch };
}

export function updateExam(id: string, patch: ExamPatch, now = Date.now()): ParseResult<ExamRecord> {
	const exam = readExam(id);
	if (!exam) return { ok: false, error: "not_found" };
	const next: ExamRecord = { ...touch(exam, now) };
	if (patch.title !== undefined) next.title = patch.title;
	if (patch.examDate !== undefined) next.examDate = patch.examDate;
	if (patch.standard !== undefined) next.standard = patch.standard;
	if (patch.blocks !== undefined) next.blocks = patch.blocks;
	if (patch.priorityBlocks !== undefined) {
		const ids = new Set(next.blocks.map((b) => b.id));
		next.priorityBlocks = patch.priorityBlocks.filter((b) => ids.has(b));
	}
	if (patch.status === "active") {
		if (next.blocks.length === 0 || allPoints(next).length === 0) return { ok: false, error: "the syllabus has no points yet — map it first" };
		if (next.examDate < reviewDay(now)) return { ok: false, error: "the exam date is in the past" };
		next.status = "active";
		delete next.archivedAt;
	} else if (patch.status === "archived") {
		next.status = "archived";
		next.archivedAt = new Date(now).toISOString();
	}
	if (patch.realGrade !== undefined) {
		if (patch.realGrade) next.realGrade = patch.realGrade;
		else delete next.realGrade;
	}
	save(next);
	return { ok: true, value: next };
}

export function deleteExam(id: string): boolean {
	const removed = removeExamFile(id);
	if (removed) {
		resetReviewCache();
		emit("exams-changed", { examId: id });
	}
	return removed;
}

// ─── the syllabus mapping job ───────────────────────────────────────────────

export type MappingStart = { ok: true } | { ok: false; status: 404 | 409 | 503; error: string };

/** Start mapping (fire-and-forget); the record's `mapping` tells the
 *  outcome, and `exams-changed` announces every transition. */
export function startExamMapping(id: string, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id)) return { ok: false, status: 409, error: "mapping already running" };
	const spec = resolveRoleSpec("syllabusMapper", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, error: "models_not_configured" };
	running().add(id);
	save({ ...touch(exam, now), mapping: { state: "running", at: new Date(now).toISOString() } });
	void runMapping(exam, piEngineForSpec(spec)).finally(() => running().delete(id));
	return { ok: true };
}

async function runMapping(exam: ExamRecord, engine: ReturnType<typeof piEngineForSpec>): Promise<void> {
	try {
		const nodes = stores.graphStore.readNodes();
		const sourcePaths: Record<string, string> = {};
		for (const s of stores.graphStore.readSources()) sourcePaths[s.id] = s.filePath;
		const areas = new Set(exam.syllabus.areas);
		const areaNodeIds = new Set<string>();
		for (const node of nodes) {
			const birth = node.provenance[0]?.chatId;
			const filePath = birth ? sourcePaths[birth] : undefined;
			if (filePath !== undefined && areas.has(areaOfPath(filePath).id)) areaNodeIds.add(node.id);
		}
		const ids = syllabusCandidates({ text: exam.syllabus.text, nodes, areaNodeIds });
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const candidates = ids.map((id) => byId.get(id)!).map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
		// An areas-only syllabus: the area ideas' names stand in for the text.
		const syllabus = exam.syllabus.text.trim() || candidates.map((c) => `- ${c.name}`).join("\n");
		const mapped = await runSyllabusMapper({ engine, syllabus, candidates });
		const current = readExam(exam.id);
		if (!current) return; // deleted meanwhile
		save({ ...touch(current), blocks: numberBlocks(mapped), mapping: { state: "done", at: new Date().toISOString() } });
	} catch (err) {
		const current = readExam(exam.id);
		if (!current) return;
		save({ ...touch(current), mapping: { state: "error", error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() } });
	}
}

// ─── exam sessions (owner: blocks in order, each its own session) ───────────

export interface StartedExamSession {
	id: string;
	title: string;
	/** The learner's opening message (the client sends it). */
	opening: string;
	kind: ExamSessionKind;
}

export type ExamSessionStart = { ok: true; session: StartedExamSession } | { ok: false; status: 404 | 409; error: string };

export const MOCK_PROBLEMS = 10;

const isSessionKind = (v: unknown): v is ExamSessionKind => v === "placement" || v === "practice" || v === "review" || v === "teach" || v === "mock";

export function parseSessionStart(body: unknown): ParseResult<{ kind: ExamSessionKind; pointId?: string }> {
	const raw = asObject(body);
	if (!raw || !isSessionKind(raw.kind)) return { ok: false, error: "kind must be placement, practice, review, teach or mock" };
	if (raw.pointId !== undefined && typeof raw.pointId !== "string") return { ok: false, error: "pointId must be a string" };
	return { ok: true, value: { kind: raw.kind, ...(typeof raw.pointId === "string" ? { pointId: raw.pointId } : {}) } };
}

/** Round-robin across points so a batch spans the syllabus. */
function spread(ids: readonly string[], status: ExamStatusModel, size: number): string[] {
	const wanted = new Set(ids);
	const queues = status.points.map((p) => p.nodeIds.filter((id) => wanted.has(id)));
	const out: string[] = [];
	const seen = new Set<string>();
	while (out.length < size && queues.some((q) => q.length > 0)) {
		for (const q of queues) {
			if (out.length >= size) break;
			let next = q.shift();
			while (next !== undefined && seen.has(next)) next = q.shift();
			if (next !== undefined) {
				seen.add(next);
				out.push(next);
			}
		}
	}
	return out;
}

export function startExamSession(id: string, kind: ExamSessionKind, pointId: string | undefined, now = Date.now()): ExamSessionStart {
	const state = getExamsState(now);
	const c = state.exams.find((e) => e.record.id === id);
	if (!c || !c.status) return { ok: false, status: 404, error: "not_found" };
	if (!c.live) return { ok: false, status: 409, error: "the exam is not active" };
	const { record, status } = c;
	const locale = interfaceLocale();
	const exam = record.title;
	const statements = state.review.statements;
	const names = state.review.names;
	const picksOf = (nodeIds: readonly string[]) => nodeIds.map((n) => ({ id: n, name: names.get(n) ?? n, statement: statements.get(n) ?? names.get(n) ?? n }));

	const practiceChat = (title: string, link: ChatExamLink, nodeIds: readonly string[]): ChatRecord => {
		const chat = createChat(title, "practice", { exam: link });
		stampStrongModel(chat.id);
		seedGraphContext(chat.id, picksOf(nodeIds));
		return chat;
	};

	switch (kind) {
		case "placement": {
			const size = effectiveSettings().exams.placementBatch;
			const ideas = spread(status.placement.pendingIdeas, status, size);
			const points = status.placement.pendingPoints.slice(0, Math.max(0, size - ideas.length));
			if (ideas.length === 0 && points.length === 0) return { ok: false, status: 409, error: "the placement test is complete" };
			const chat = practiceChat(t(locale, "exams.session.placementTitle", { exam }), { id, kind: "placement", ...(points.length ? { pointIds: points } : {}) }, ideas);
			return { ok: true, session: { id: chat.id, title: chat.title, opening: t(locale, "exams.session.placementOpening"), kind } };
		}
		case "practice": {
			const target = MODE_LEVEL[record.standard.mode];
			const climbing = status.ideas.filter((i) => !i.toTeach && i.level < target).sort((a, b) => a.level - b.level || (a.nodeId < b.nodeId ? -1 : 1));
			const ids = spread(climbing.map((i) => i.nodeId), status, effectiveSettings().review.batchSize);
			if (ids.length === 0) return { ok: false, status: 409, error: "nothing to practice" };
			const levels = Object.fromEntries(ids.map((n) => [n, status.ideas.find((i) => i.nodeId === n)!.level]));
			const chat = practiceChat(t(locale, "exams.session.practiceTitle", { exam }), { id, kind: "practice", levels }, ids);
			return { ok: true, session: { id: chat.id, title: chat.title, opening: t(locale, "exams.session.practiceOpening"), kind } };
		}
		case "review": {
			const nodeIds = new Set(status.ideas.map((i) => i.nodeId));
			const started = startReviewSession(now, { nodeIds, exam: { id, kind: "review" }, title: t(locale, "exams.session.reviewTitle", { exam }) });
			if (!started) return { ok: false, status: 409, error: "nothing due" };
			emit("exams-changed", { examId: id });
			return { ok: true, session: { id: started.id, title: started.title, opening: t(locale, "exams.session.reviewOpening"), kind } };
		}
		case "teach": {
			const point = pointId
				? status.points.find((p) => p.id === pointId)
				: c.blocks.find((b) => b.kind === "teach")?.pointId
					? status.points.find((p) => p.id === c.blocks.find((b) => b.kind === "teach")!.pointId)
					: status.points.find((p) => p.need === "teach" || p.need === "consolidate");
			if (!point) return { ok: false, status: 409, error: "no point to teach" };
			const short = point.need === "consolidate";
			const title = t(locale, "exams.session.teachTitle", { point: point.text.length > 60 ? `${point.text.slice(0, 57)}…` : point.text, exam });
			const chat = createChat(title, undefined, { exam: { id, kind: "teach", pointId: point.id, ...(short ? { short: true } : {}) } });
			stampStrongModel(chat.id);
			const toTeach = point.nodeIds.filter((n) => status.ideas.find((i) => i.nodeId === n)?.toTeach);
			if (toTeach.length) seedGraphContext(chat.id, picksOf(toTeach));
			const opening = t(locale, short ? "exams.session.consolidateOpening" : "exams.session.teachOpening", { exam, point: point.text });
			return { ok: true, session: { id: chat.id, title: chat.title, opening, kind } };
		}
		case "mock": {
			const ids = spread(status.ideas.map((i) => i.nodeId), status, MOCK_PROBLEMS);
			if (ids.length === 0) return { ok: false, status: 409, error: "the syllabus has no ideas yet" };
			const chat = practiceChat(t(locale, "exams.session.mockTitle", { exam }), { id, kind: "mock" }, ids);
			return { ok: true, session: { id: chat.id, title: chat.title, opening: t(locale, "exams.session.mockOpening"), kind } };
		}
	}
}

// ─── the agents' appendix (chat-handler, per turn) ──────────────────────────

const MODE_WORD: Record<number, string> = { 0: "none yet", 1: "recall", 2: "discrimination", 3: "composition" };

/** The exam appendix for a session record, or undefined (not an exam
 *  session, a review block — the review appendix covers it — or the exam
 *  is gone). Built from the record's frozen link: a stable prompt. */
export function examSessionAppendix(record: Pick<ChatRecord, "exam">): string | undefined {
	const link = record.exam;
	if (!link || link.kind === "review" || !isExamId(link.id)) return undefined;
	const exam = readExam(link.id);
	if (!exam) return undefined;
	const base = { title: exam.title, date: exam.examDate, mode: exam.standard.mode };
	const pointText = new Map(allPoints(exam).map((p) => [p.id, p.text]));
	switch (link.kind) {
		case "placement": {
			const ids = (link.pointIds ?? []).filter((p) => pointText.has(p));
			const points = ids.length ? `${examAppendix("placement-points", { points: ids.map((p) => `  - [${p}] ${pointText.get(p)}`).join("\n") })}\n` : "";
			return examAppendix("placement", { ...base, threshold: effectiveSettings().review.confidenceThreshold, points, andPoints: ids.length ? " and point" : "" });
		}
		case "practice": {
			const ideas = Object.entries(link.levels ?? {}).map(([id, level]) => `- [${id}] reached: ${MODE_WORD[level] ?? "none yet"}`).join("\n");
			return examAppendix("practice", { ...base, ideas });
		}
		case "teach": {
			const point = (link.pointId && pointText.get(link.pointId)) || "";
			return link.short
				? examAppendix("consolidate", { ...base, point, minutes: effectiveSettings().exams.consolidateMinutes })
				: examAppendix("teach", { ...base, point });
		}
		case "mock":
			return examAppendix("mock", { ...base, n: MOCK_PROBLEMS });
	}
}

// ─── notices (folded into the review digest/evening; owner-approved texts) ──

/** One line per live exam with minutes planned today. */
export function examDigestLines(state: ExamsState): Array<{ examId: string; exam: string; minutes: number; started: boolean }> {
	return state.exams
		.filter((c) => c.live)
		.map((c) => ({ examId: c.record.id, exam: c.record.title, minutes: Math.round(c.blocks.reduce((s, b) => s + b.minutes, 0)), started: c.startedToday }))
		.filter((l) => l.minutes > 0);
}

export interface ExamNotice {
	examId: string;
	kind: ExamNoticeKind;
	title: string;
	body: string;
}

/** The next one-off exam notice due now (below target / 7 days / 1 day),
 *  recorded as sent. Owner rules: «below» once, again only after the plan
 *  was back on track; the countdowns once each. */
export function nextExamNotice(state: ExamsState, locale: Locale): ExamNotice | null {
	const sent = readExamNotices();
	for (const c of state.exams) {
		if (!c.live || !c.status) continue;
		const id = c.record.id;
		const exam = c.record.title;
		const mine = sent.filter((l) => l.examId === id);
		const daysLeft = daysBetween(state.today, c.record.examDate);
		const level = standardLabel(c.record.standard, locale);
		const candidates: Array<{ kind: ExamNoticeKind; title: string; body: string }> = [];
		if (daysLeft === 1 && !mine.some((l) => l.kind === "eve")) {
			candidates.push({ kind: "eve", title: t(locale, "exams.notice.eveTitle", { exam }), body: t(locale, "exams.notice.eveBody") });
		}
		if (daysLeft === 7 && !mine.some((l) => l.kind === "week")) {
			candidates.push({ kind: "week", title: t(locale, "exams.notice.weekTitle", { exam }), body: t(locale, "exams.notice.weekBody", { n: Math.round(c.status.coverage * 100), level }) });
		}
		const lastBelow = mine.filter((l) => l.kind === "below").at(-1);
		if (c.infeasible && !belowAlreadyTold(id, lastBelow)) {
			const best = c.infeasible.bestPreset;
			candidates.push({
				kind: "below",
				title: t(locale, "exams.notice.belowTitle", { exam }),
				body: best ? t(locale, "exams.notice.belowBody", { level: t(locale, `exams.preset.${best}`) }) : t(locale, "exams.notice.belowNoneBody"),
			});
		}
		const pick = candidates[0];
		if (pick) {
			appendExamNotice({ examId: id, kind: pick.kind, day: state.today, at: new Date(state.now).toISOString() });
			emit("exam-notice", { examId: id, kind: pick.kind, title: pick.title, body: pick.body });
			return { examId: id, ...pick };
		}
	}
	return null;
}

/** «below» repeats only after the plan was seen back on track since the
 *  last one (this process's observations; after a restart it waits for a
 *  fresh on-track sighting). */
function belowAlreadyTold(examId: string, lastBelow: { at: string } | undefined): boolean {
	if (!lastBelow) return false;
	const lastOnTrack = onTrackSeen.get(examId);
	return !(lastOnTrack !== undefined && lastOnTrack > Date.parse(lastBelow.at));
}

const onTrackSeen = new Map<string, number>();

/** Remember when each live exam was seen feasible (the «below» re-arm). */
export function noteOnTrack(state: ExamsState): void {
	for (const c of state.exams) if (c.live && !c.infeasible) onTrackSeen.set(c.record.id, state.now);
}

// ─── the desktop clock (POST /api/review/notify) ────────────────────────────

export interface DeskNotice {
	notify: boolean;
	title?: string;
	body?: string;
	/** Ideas due right now (the tray counter reads it on every tick). */
	count: number;
	/** Where a click opens (allow-listed by the shell); absent = /review. */
	path?: string;
}

const clockMinutes = (hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(Number);
	return h! * 60 + m!;
};

/**
 * The review notices with the exams folded in (owner-approved 2026-11-06):
 *   digest  — the review digest gains one «{exam}: ~{min} min hoy.» line
 *             per exam with work today; with nothing due in Repaso it
 *             becomes «Hoy toca estudiar para {exam}».
 *   evening — the review rule, or an exam whose plan wasn't started today
 *             («Te queda el plan de hoy para {exam}»).
 * When no digest goes out, the one-off exam notices (below target, 7
 * days, 1 day) take the digest slot, during the digest window.
 */
export function deskNotice(kind: ReviewNoticeKind, now = Date.now()): DeskNotice {
	const state = getExamsState(now);
	const locale = interfaceLocale();
	const summary = summarizeReview(state.review, now, locale);
	const settings = effectiveSettings().review;
	const lines = examDigestLines(state);
	const reviewPending = summary.dueCount > 0 && (kind === "digest" || !summary.reviewedToday);
	const examPending = kind === "digest" ? lines : lines.filter((l) => !l.started);
	const send = shouldSendNotice({
		kind,
		now,
		digestTime: settings.digestTime,
		eveningTime: settings.eveningTime,
		dueCount: (reviewPending ? summary.dueCount : 0) + examPending.length,
		sent: readReviewNotices(),
		reviewStartedToday: false,
	});
	const n = summary.dueCount;
	if (send) {
		appendReviewNotice({ day: reviewDay(now), kind, at: new Date(now).toISOString(), count: n });
		emit("review-notice", { kind, count: n });
		const lineKey = kind === "digest" ? "exams.notice.digestLine" : "exams.notice.eveningLine";
		const examText = examPending.map((l) => t(locale, lineKey, { exam: l.exam, min: l.minutes })).join(" ");
		if (reviewPending) {
			const title = kind === "digest" ? t(locale, "review.notice.digestTitle", { n }) : t(locale, "review.notice.eveningTitle", { n });
			const body = kind === "digest" ? t(locale, "review.notice.digestBody", { groups: groupsSentence(summary.due, locale) }) : t(locale, "review.notice.eveningBody", { n });
			return { notify: true, count: n, title, body: examText ? `${body} ${examText}` : body };
		}
		const exam = examPending.map((l) => l.exam).join(", ");
		const min = examPending.reduce((s, l) => s + l.minutes, 0);
		const path = examPending.length === 1 ? `/exams/${examPending[0]!.examId}` : "/exams";
		return kind === "digest"
			? { notify: true, count: n, path, title: t(locale, "exams.notice.studyTitle", { exam }), body: t(locale, "exams.notice.studyBody", { min }) }
			: { notify: true, count: n, path, title: t(locale, "exams.notice.eveningTitle", { exam }), body: t(locale, "exams.notice.eveningBody", { min }) };
	}
	// The one-off exam notices ride the digest slot, inside its window.
	if (kind === "digest") {
		const d = new Date(now);
		const minutes = d.getHours() * 60 + d.getMinutes();
		noteOnTrack(state);
		if (d.getHours() >= DAY_ROLLOVER_HOUR && minutes >= clockMinutes(settings.digestTime)) {
			const notice = nextExamNotice(state, locale);
			if (notice) return { notify: true, count: n, title: notice.title, body: notice.body, path: `/exams/${notice.examId}` };
		}
	}
	return { notify: false, count: n };
}

export { type ExamRecord };

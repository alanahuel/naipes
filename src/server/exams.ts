/**
 * Exam service («Exámenes», owner 2026-11-05): feeds the pure model
 * (src/core/exams.ts) the review state, the chat records and the graph;
 * owns the exam records' lifecycle (create → map → confirm → active →
 * archived), the syllabus mapping job, the exam sessions and the exam
 * notices. Nothing derived is stored.
 */

import type { ChatExamLink, ChatRecord, ExamSessionKind } from "../core/contracts.ts";
import { emit, subscribe } from "../core/events.ts";
import {
	allPoints,
	applyClassification,
	instructionPoints,
	pointKind,
	setPointKind,
	studyPoints,
	type PointKind,
	computeExamStatus,
	effectiveDurations,
	EXAM_PRESETS,
	examNodeIds,
	examWork,
	infeasibility,
	isExamDate,
	EMPTY_EXAM_CONTEXT,
	foldersToRead,
	inExamScope,
	isLiveExam,
	knowledgeFolders,
	MAX_EXAM_MATERIALS,
	sanitizeContext,
	sanitizeScope,
	CURRENT_EXAM_VERSION,
	type ExamMaterial,
	type VaultFolderInfo,
	measureDurations,
	MODE_LEVEL,
	numberBlocks,
	planBudget,
	PRESET_ORDER,
	presetStandard,
	pendingSorts,
	applySort,
	researchDepth,
	syncPointLinks,
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
	type ExamSummaryView,
	type ExamDetailView,
} from "../core/exams.ts";
import { formatMessage, type Locale, type MessageVars } from "../core/i18n.ts";
import { MESSAGES, type MessageKey } from "../core/messages/index.ts";
import { daysBetween, reviewDay, reviewDayEnd, type ReviewItem } from "../core/review.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { isWeeklyMinutes } from "../core/settings.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { refreshClaudeCodeStatus } from "../agent/claude-code-bridge.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { examAppendix } from "../agent/prompt-segments.ts";
import { runExamClassifier } from "../agent/subagents/exam-classifier.ts";
import { runSyllabusMapper } from "../agent/subagents/syllabus-mapper.ts";
import { examResearchInstructions, runExamResearcher } from "../agent/subagents/exam-researcher.ts";
import { runExamSorter } from "../agent/subagents/exam-sorter.ts";
import { examSearchProvider, readMaterialPart } from "./exam-research-io.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendExamNotice, deleteExam as removeExamFile, isExamId, listExams, newExamId, readExam, readExamNotices, writeExam, type ExamNoticeKind } from "../store/exams.ts";
import { createChat, seedGraphContext, stampStrongModel } from "./chats.ts";
import { getReviewState, groupsSentence, resetReviewCache, startReviewSession, summarizeReview, type ReviewState } from "./review.ts";
import { appendReviewNotice, readReviewNotices } from "../store/review.ts";
import { DAY_ROLLOVER_HOUR, shouldSendNotice, type ReviewNoticeKind } from "../core/review.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { decidePendingDocument, onVaultNoteSettled, reconfigureVault, vaultFolderTree, vaultNoteState, vaultNotesUnder } from "./vault.ts";
import { materialPath, removeMaterialFile, writeMaterialFile } from "../store/exams.ts";

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
	ensureExamReadingHook();
	ensureExamSortHook();
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
		if ((record.mapping.state === "running" || record.mapping.state === "researching") && !running().has(record.id)) {
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
		exams: computed.filter((c) => c.live).map((c) => ({ examId: c.record.id, examDate: c.record.examDate, work: c.work!.total, spread: c.work!.review })),
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
		reading: readingProgress(c.record),
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
	context: ExamRecord["context"];
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
	for (const key of ["folders", "directFolders"] as const) {
		if (syllabus[key] !== undefined && !Array.isArray(syllabus[key])) return { ok: false, error: `${key} must be a list of folder paths` };
	}
	const paths = (v: unknown) => (Array.isArray(v) ? v : []).filter((f): f is string => typeof f === "string" && f.length > 0 && f.length < 1024);
	const scope = sanitizeScope(paths(syllabus.folders), paths(syllabus.directFolders));
	const fileName = typeof syllabus.fileName === "string" && syllabus.fileName.length <= 500 ? syllabus.fileName : null;
	if (!text.trim() && scope.folders.length === 0 && scope.directFolders.length === 0) return { ok: false, error: "the syllabus needs text, a file or folders" };
	if (raw.context !== undefined && (raw.context === null || typeof raw.context !== "object")) return { ok: false, error: "context must be an object" };
	return { ok: true, value: { title, examDate: raw.examDate, standard, context: sanitizeContext(raw.context), syllabus: { text, fileName, ...scope } } };
}

export function createExam(body: ExamCreateBody, now = Date.now()): ExamRecord {
	const at = new Date(now).toISOString();
	const exam: ExamRecord = {
		version: CURRENT_EXAM_VERSION,
		id: newExamId(),
		title: body.title,
		examDate: body.examDate,
		createdAt: at,
		updatedAt: at,
		status: "draft",
		standard: body.standard,
		syllabus: body.syllabus,
		context: body.context ?? { ...EMPTY_EXAM_CONTEXT },
		materials: [],
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
	if (patch.blocks !== undefined) next.blocks = syncPointLinks(patch.blocks);
	if (patch.priorityBlocks !== undefined) {
		const ids = new Set(next.blocks.map((b) => b.id));
		next.priorityBlocks = patch.priorityBlocks.filter((b) => ids.has(b));
	}
	if (patch.status === "active") {
		if (next.blocks.length === 0 || studyPoints(next).length === 0) return { ok: false, error: "the syllabus has no points yet — map it first" };
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

// ─── knowledge folders (the wizard's tree, owner 2026-11-06) ────────────────

/** The wizard's tree (owner 2026-11-06): every knowledge-folder folder
 *  holding notes — read or not — with recursive idea counts (per idea, by
 *  its birth note's path) and note counts. Without a knowledge folder,
 *  the folders the graph's ideas came from. */
export function listExamFolders(): { folders: VaultFolderInfo[]; watched: string[] } {
	const sourcePaths: Record<string, string> = {};
	for (const s of stores.graphStore.readSources()) sourcePaths[s.id] = s.filePath;
	const paths: string[] = [];
	for (const node of stores.graphStore.readNodes()) {
		const birth = node.provenance[0]?.chatId;
		const filePath = birth ? sourcePaths[birth] : undefined;
		if (filePath !== undefined) paths.push(filePath);
	}
	const ideas = new Map(knowledgeFolders(paths).map((f) => [f.path, f.count]));
	const tree = vaultFolderTree();
	if (!tree) {
		return { folders: [...ideas].map(([path, count]) => ({ path, ideas: count, notes: 0, unread: 0, direct: 0, directUnread: 0 })), watched: [] };
	}
	return { folders: tree.folders.map((f) => ({ ...f, ideas: ideas.get(f.path) ?? 0 })), watched: tree.watched };
}

// ─── reading unread folders before the mapping (owner 2026-11-06) ──────────

/** Add folders to Settings → Knowledge (the connection reads whole
 *  folders) and restart the connection so it reads them. */
function addKnowledgeFolders(added: readonly string[]): void {
	if (added.length === 0) return;
	const record = stores.settingsStore.readSettings() ?? { version: 1 };
	const current = record.obsidian?.folders ?? effectiveSettings().obsidian.folders;
	const folders = [...current];
	for (const f of added) if (!folders.some((w) => f === w || f.startsWith(`${w}/`))) folders.push(f);
	stores.settingsStore.writeSettings({ ...record, obsidian: { ...(record.obsidian ?? {}), enabled: true, folders } });
	reconfigureVault();
}

/** What «Leer y mapear» will add (the wizard's notice): folders + their
 *  unread note counts. Pure over the current tree. */
export function readingPlan(scope: { folders: readonly string[]; directFolders: readonly string[] }): Array<{ path: string; unread: number }> {
	const tree = listExamFolders();
	const byPath = new Map(tree.folders.map((f) => [f.path, f]));
	return foldersToRead(scope, tree.folders, tree.watched).map((path) => ({ path, unread: byPath.get(path)?.unread ?? 0 }));
}

/** The notes of the exam scope that the graph doesn't have yet. */
function scopeNotesToRead(exam: ExamRecord): string[] {
	const roots = [...exam.syllabus.folders, ...exam.syllabus.directFolders];
	return vaultNotesUnder(roots)
		.filter((rel) => inExamScope(rel, exam.syllabus))
		.filter((rel) => vaultNoteState(rel).state !== "done");
}

export interface ReadingProgress {
	total: number;
	done: number;
	failed: Array<{ path: string; error: string }>;
}

export function readingProgress(exam: ExamRecord): ReadingProgress | null {
	if (!exam.reading) return null;
	let done = 0;
	const failed: Array<{ path: string; error: string }> = [];
	for (const rel of exam.reading.paths) {
		const st = vaultNoteState(rel);
		if (st.state === "done") done++;
		else if (st.state === "failed") failed.push({ path: rel, error: st.error ?? "" });
	}
	return { total: exam.reading.paths.length, done, failed };
}

/** A reading exam whose notes all settled moves on to the mapping; a
 *  big document waiting for «Leer» in its scope is confirmed (the
 *  learner already said «Leer y mapear»). */
function advanceReading(id: string): void {
	const exam = readExam(id);
	if (!exam || exam.mapping.state !== "reading" || !exam.reading) return;
	let open = 0;
	for (const rel of exam.reading.paths) {
		const st = vaultNoteState(rel).state;
		if (st === "waiting") decidePendingDocument(rel, "read");
		if (st === "waiting" || st === "pending") open++;
	}
	if (open > 0) return;
	const progress = readingProgress(exam)!;
	save({ ...touch(exam), reading: { ...exam.reading, failed: progress.failed } });
	beginMapping(id);
}

const READ_HOOK_KEY = "__npExamReadHook";
/** One vault listener per process: every settled note re-checks the
 *  exams that are reading. */
export function ensureExamReadingHook(): void {
	const g = globalThis as unknown as Record<string, boolean | undefined>;
	if (g[READ_HOOK_KEY]) return;
	g[READ_HOOK_KEY] = true;
	onVaultNoteSettled(() => {
		for (const exam of listExams()) if (exam.mapping.state === "reading") advanceReading(exam.id);
	});
	// Exams left reading by a previous run continue (the connection
	// re-queues their notes at boot).
	for (const exam of listExams()) if (exam.mapping.state === "reading") advanceReading(exam.id);
}

// ─── sorting ideas born in exam sessions (owner-approved 2026-11-06) ────────

const SORT_KEY = "__npExamSort";
interface SortState {
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	again: boolean;
}
const sortState = (): SortState => {
	const g = globalThis as unknown as Record<string, SortState | undefined>;
	return (g[SORT_KEY] ??= { timer: null, running: false, again: false });
};

/** Sort every exam's unsorted born ideas: «Profundizar» ones straight to
 *  ampliación; teach/consolidation ones through the sorter (cheap slot).
 *  Single-flight; a failure leaves them unsorted for the next pass. */
export async function sortExamIdeas(): Promise<void> {
	const st = sortState();
	if (st.running) {
		st.again = true;
		return;
	}
	st.running = true;
	try {
		const review = getReviewState();
		const nodes = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		for (const exam of listExams()) {
			if (exam.status === "archived") continue;
			for (const pending of pendingSorts(exam, review.chats, review.nodesBornIn)) {
				const point = allPoints(exam).find((p) => p.id === pending.pointId);
				if (!point?.targets) continue;
				const sorted = new Map<string, string>(pending.deepen.map((id) => [id, "extension"]));
				const teach = pending.teach.filter((id) => nodes.has(id));
				if (teach.length > 0) {
					const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
					if (!spec) continue;
					if (spec.provider === CLAUDE_CODE_PROVIDER) await refreshClaudeCodeStatus().catch(() => null);
					try {
						const result = await runExamSorter({
							engine: piEngineForSpec(spec),
							input: {
								point: point.text,
								targets: point.targets.map((x) => ({ id: x.id, statement: x.statement })),
								ideas: teach.map((id) => ({ id, name: nodes.get(id)!.name, statement: nodes.get(id)!.statement })),
							},
						});
						for (const [id, where] of result) sorted.set(id, where);
					} catch (err) {
						console.error(`[exams] sorting ideas for ${exam.id}/${point.id} failed:`, err);
					}
				}
				if (sorted.size === 0) continue;
				const current = readExam(exam.id);
				if (current) save({ ...touch(current), blocks: applySort(current.blocks, point.id, sorted) });
			}
		}
	} finally {
		st.running = false;
		if (st.again) {
			st.again = false;
			scheduleExamSort();
		}
	}
}

function scheduleExamSort(): void {
	const st = sortState();
	if (st.timer) clearTimeout(st.timer);
	st.timer = setTimeout(() => {
		st.timer = null;
		void sortExamIdeas().catch((err) => console.error("[exams] sort failed:", err));
	}, 3000);
}

const SORT_HOOK_KEY = "__npExamSortHook";
/** Extraction phases end with activity-changed: re-check then. */
export function ensureExamSortHook(): void {
	if (process.env.NODE_ENV === "test") return;
	const g = globalThis as unknown as Record<string, boolean | undefined>;
	if (g[SORT_HOOK_KEY]) return;
	g[SORT_HOOK_KEY] = true;
	subscribe((event) => {
		if (event.type === "activity-changed") scheduleExamSort();
	});
	scheduleExamSort();
}

// ─── materials (owner 2026-11-06) ───────────────────────────────────────────

export function addExamMaterial(id: string, input: { kind: "file"; name: string; bytes: Uint8Array } | { kind: "link"; url: string; name?: string }, now = Date.now()): ParseResult<ExamMaterial> {
	const exam = readExam(id);
	if (!exam) return { ok: false, error: "not_found" };
	if (exam.materials.length >= MAX_EXAM_MATERIALS) return { ok: false, error: `at most ${MAX_EXAM_MATERIALS} materials` };
	const base = { id: `mat_${now.toString(36)}_${crypto.randomUUID().slice(0, 6)}`, addedAt: new Date(now).toISOString() };
	let material: ExamMaterial;
	if (input.kind === "file") {
		const name = input.name.slice(0, 500) || "material";
		material = { ...base, kind: "file", name, file: writeMaterialFile(id, name, input.bytes) };
	} else {
		if (!/^https?:\/\//i.test(input.url) || input.url.length > 2000) return { ok: false, error: "url must be http(s)" };
		material = { ...base, kind: "link", name: (input.name ?? input.url).slice(0, 500), url: input.url };
	}
	save({ ...touch(exam, now), materials: [...exam.materials, material] });
	return { ok: true, value: material };
}

export function removeExamMaterial(id: string, materialId: string): boolean {
	const exam = readExam(id);
	const material = exam?.materials.find((m) => m.id === materialId);
	if (!exam || !material) return false;
	if (material.file) removeMaterialFile(id, material.file);
	save({ ...touch(exam), materials: exam.materials.filter((m) => m.id !== materialId) });
	return true;
}

export { materialPath };

// ─── the syllabus mapping job ───────────────────────────────────────────────

export type MappingStart = { ok: true } | { ok: false; status: 404 | 409 | 503; error: string };

/** Start mapping (fire-and-forget); the record's `mapping` tells the
 *  outcome, and `exams-changed` announces every transition. When the
 *  scope holds unread folders they are added to the knowledge folders and
 *  read first (state «reading»); the mapping then starts on its own. */
export function startExamMapping(id: string, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id) || exam.mapping.state === "reading") return { ok: false, status: 409, error: "mapping already running" };
	const spec = resolveRoleSpec("syllabusMapper", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, error: "models_not_configured" };
	const added = readingPlan(exam.syllabus).map((f) => f.path);
	addKnowledgeFolders(added);
	const paths = scopeNotesToRead(exam);
	if (paths.length > 0) {
		ensureExamReadingHook();
		save({ ...touch(exam, now), mapping: { state: "reading", at: new Date(now).toISOString() }, reading: { added, paths, failed: [] } });
		advanceReading(id);
		return { ok: true };
	}
	return beginMapping(id, now);
}

function beginMapping(id: string, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id)) return { ok: false, status: 409, error: "mapping already running" };
	const spec = resolveRoleSpec("syllabusMapper", stores.settingsStore.readSettings());
	if (!spec) {
		save({ ...touch(exam, now), mapping: { state: "error", error: "models_not_configured", at: new Date(now).toISOString() } });
		return { ok: false, status: 503, error: "models_not_configured" };
	}
	running().add(id);
	save({ ...touch(exam, now), mapping: { state: "running", at: new Date(now).toISOString() } });
	void withEngine(id, spec, (engine) => runMapping(readExam(id)!, engine));
	return { ok: true };
}

/** Build the strong-slot engine inside the background job (a Claude Code
 *  slot needs its status checked first — a fresh process may not have
 *  done it yet) and run `job`; an engine that can't be built ends the
 *  job as an error instead of leaving it «running». */
async function withEngine(id: string, spec: NonNullable<ReturnType<typeof resolveRoleSpec>>, job: (engine: ReturnType<typeof piEngineForSpec>) => Promise<void>): Promise<void> {
	try {
		if (spec.provider === CLAUDE_CODE_PROVIDER) await refreshClaudeCodeStatus().catch(() => null);
		await job(piEngineForSpec(spec));
	} catch (err) {
		const current = readExam(id);
		if (current) save({ ...touch(current), mapping: { state: "error", error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() } });
	} finally {
		running().delete(id);
	}
}

/** The exam scope's graph ideas (by their birth note's path). */
function scopeNodeIds(exam: ExamRecord, nodes: ReturnType<typeof stores.graphStore.readNodes>): Set<string> {
	const sourcePaths: Record<string, string> = {};
	for (const s of stores.graphStore.readSources()) sourcePaths[s.id] = s.filePath;
	const out = new Set<string>();
	for (const node of nodes) {
		const birth = node.provenance[0]?.chatId;
		const filePath = birth ? sourcePaths[birth] : undefined;
		if (filePath !== undefined && inExamScope(filePath, exam.syllabus)) out.add(node.id);
	}
	return out;
}

async function runMapping(exam: ExamRecord, engine: ReturnType<typeof piEngineForSpec>): Promise<void> {
	try {
		const nodes = stores.graphStore.readNodes();
		const folderNodeIds = scopeNodeIds(exam, nodes);
		const ids = syllabusCandidates({ text: exam.syllabus.text, nodes, folderNodeIds });
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const candidates = ids.map((id) => byId.get(id)!).map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
		// A folders-only syllabus: the folder ideas' names stand in for the text.
		const syllabus = exam.syllabus.text.trim() || candidates.map((c) => `- ${c.name}`).join("\n");
		const mapped = await runSyllabusMapper({ engine, syllabus, candidates });
		const current = readExam(exam.id);
		if (!current) return; // deleted meanwhile
		const blocks = numberBlocks(mapped);
		save({
			...touch(current),
			blocks,
			classified: true,
			mapping: { state: "researching", at: new Date().toISOString() },
			research: { done: 0, total: blocks.length, web: (await examSearchProvider()) !== null },
		});
		await runResearch(exam.id, engine, { mode: "missing" });
	} catch (err) {
		const current = readExam(exam.id);
		if (!current) return;
		save({ ...touch(current), mapping: { state: "error", error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() } });
	}
}

// ─── the research (owner-approved 2026-11-06) ───────────────────────────────

const CONTEXT_LABELS: Array<[keyof ExamRecord["context"], string]> = [
	["kind", "Type"],
	["name", "Exam / subject"],
	["institution", "School or body"],
	["location", "Location"],
	["sitting", "Sitting / year"],
	["goal", "Goal"],
];

export function contextLines(context: ExamRecord["context"]): string[] {
	return CONTEXT_LABELS.filter(([k]) => context[k]).map(([k, label]) => `${label}: ${context[k]}`);
}

/** Candidates for one block: the outline's links for its points + the
 *  ideas sharing words with the block (scope ideas first). */
const BLOCK_CANDIDATES = 150;

export type ResearchScope = { mode: "missing" } | { mode: "all" } | { mode: "points"; pointIds: string[] };

/** Research the exam's blocks in order, saving after each (progress is
 *  visible; a failure keeps what was done and a retry resumes). */
async function runResearch(id: string, engine: ReturnType<typeof piEngineForSpec>, scope: ResearchScope): Promise<void> {
	const first = readExam(id);
	if (!first) return;
	const todo = first.blocks
		.map((b) => ({
			...b,
			points: b.points
				.filter((p) => (scope.mode === "all" ? true : scope.mode === "points" ? scope.pointIds.includes(p.id) : p.targets === undefined))
				.map((p) => ({ ...p, kind: pointKind(b, p) })),
		}))
		.filter((b) => b.points.length > 0);
	const search = await examSearchProvider();
	const nodes = stores.graphStore.readNodes();
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const folderNodeIds = scopeNodeIds(first, nodes);
	const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-exam-research-"));
	const total = first.blocks.length;
	let done = scope.mode === "missing" ? total - todo.length : 0;
	const progress = (patch: Partial<NonNullable<ExamRecord["research"]>>) => {
		const current = readExam(id);
		if (!current) return null;
		const research = { done, total: scope.mode === "missing" ? total : todo.length, web: search !== null, ...patch };
		save({ ...touch(current), research });
		return current;
	};
	try {
		for (const [i, block] of todo.entries()) {
			if (!progress({ current: block.title })) return;
			const exam = readExam(id)!;
			const study = block.points.filter((p) => p.kind === "syllabus");
			const outline = new Set(study.flatMap((p) => p.nodeIds));
			// Instruction-only blocks link nothing: no candidates.
			const text = study.length ? [block.title, ...study.map((p) => p.text)].join("\n") : "";
			const overlap = syllabusCandidates({ text, nodes, folderNodeIds: new Set(), cap: BLOCK_CANDIDATES });
			const inScope = overlap.filter((n) => folderNodeIds.has(n));
			const ids = [...new Set([...outline, ...inScope, ...overlap])].slice(0, BLOCK_CANDIDATES).filter((n) => byId.has(n));
			const result = await runExamResearcher({
				engine,
				instructions: examResearchInstructions({ today: reviewDay(Date.now()), examDate: exam.examDate, sitting: exam.context.sitting, depth: researchDepth(exam.standard) }),
				task: {
					exam: { title: exam.title, examDate: exam.examDate },
					context: contextLines(exam.context),
					materials: exam.materials.map((m) => ({ id: m.id, name: m.name, kind: m.kind, ...(m.url ? { url: m.url } : {}) })),
					block: { index: scope.mode === "missing" ? exam.blocks.findIndex((b) => b.id === block.id) + 1 : i + 1, total: scope.mode === "missing" ? total : todo.length, title: block.title, points: block.points.map((p) => ({ id: p.id, text: p.text, kind: p.kind })) },
					candidates: ids.map((n) => ({ id: n, name: byId.get(n)!.name, statement: byId.get(n)!.statement })),
				},
				search: () => search,
				readMaterial: (materialId, offset) => readMaterialPart(id, exam.materials, materialId, offset),
				pdfDir,
			});
			const current = readExam(id);
			if (!current) return;
			const blocks = current.blocks.map((b) => ({
				...b,
				points: b.points.map((p) => {
					const targets = result.get(p.id);
					if (!targets || !block.points.some((q) => q.id === p.id)) return p;
					const withIds = targets.map((t, n) => ({ id: `t_${p.id}_${Date.now().toString(36)}${n}`, statement: t.statement, source: t.source, nodeIds: t.nodeIds }));
					return { ...p, targets: withIds, nodeIds: [...new Set(withIds.flatMap((t) => t.nodeIds))] };
				}),
			}));
			done++;
			save({ ...touch(current), blocks, research: { done, total: scope.mode === "missing" ? total : todo.length, web: search !== null } });
		}
		const current = readExam(id);
		if (current) save({ ...touch(current), mapping: { state: "done", at: new Date().toISOString() }, research: { done, total: scope.mode === "missing" ? total : todo.length, web: search !== null } });
	} catch (err) {
		const current = readExam(id);
		if (!current) return;
		const message = err instanceof Error ? err.message : String(err);
		save({
			...touch(current),
			mapping: { state: "error", error: "research", at: new Date().toISOString() },
			research: { done, total: scope.mode === "missing" ? total : todo.length, web: search !== null, error: { block: current.research?.current ?? "", message } },
		});
	} finally {
		fs.rmSync(pdfDir, { recursive: true, force: true });
	}
}

/** (Re)start the research: «Reintentar» resumes the blocks without
 *  targets; «Volver a investigar todo» redoes every block; a point id
 *  redoes that point. */
export function startExamResearch(id: string, scope: ResearchScope, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id) || exam.mapping.state === "reading") return { ok: false, status: 409, error: "mapping already running" };
	if (exam.blocks.length === 0) return startExamMapping(id, now);
	if (scope.mode === "points" && !scope.pointIds.every((pid) => allPoints(exam).some((p) => p.id === pid))) return { ok: false, status: 404, error: "no such point" };
	const spec = resolveRoleSpec("syllabusMapper", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, error: "models_not_configured" };
	running().add(id);
	save({ ...touch(exam, now), mapping: { state: "researching", at: new Date(now).toISOString() } });
	void withEngine(id, spec, (engine) => runResearch(id, engine, scope));
	return { ok: true };
}

// ─── point types (owner-approved 2026-11-06) ────────────────────────────────

/** Change a block's or a point's type; the points whose type changed are
 *  researched again for it at once (their old targets/rules dropped). */
export function setExamPointKind(id: string, input: { blockId: string; pointId: string | null; kind: PointKind }, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id) || exam.mapping.state === "reading") return { ok: false, status: 409, error: "mapping already running" };
	const block = exam.blocks.find((b) => b.id === input.blockId);
	if (!block || (input.pointId !== null && !block.points.some((p) => p.id === input.pointId))) return { ok: false, status: 404, error: "no such point" };
	const { blocks, changed } = setPointKind(exam.blocks, input.blockId, input.pointId, input.kind);
	save({ ...touch(exam, now), blocks });
	if (changed.length === 0) return { ok: true };
	return startExamResearch(id, { mode: "points", pointIds: changed }, now);
}

/** «Clasificar temario» (exams made before point types): the model
 *  proposes every block's and point's type; the points that changed are
 *  researched again for it. */
export function classifyExam(id: string, now = Date.now()): MappingStart {
	const exam = readExam(id);
	if (!exam) return { ok: false, status: 404, error: "not_found" };
	if (running().has(id) || exam.mapping.state === "reading") return { ok: false, status: 409, error: "mapping already running" };
	if (exam.blocks.length === 0) return { ok: false, status: 409, error: "the syllabus has no points yet — map it first" };
	const spec = resolveRoleSpec("syllabusMapper", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, error: "models_not_configured" };
	running().add(id);
	save({ ...touch(exam, now), mapping: { state: "running", at: new Date(now).toISOString() } });
	void withEngine(id, spec, async (engine) => {
		const kinds = await runExamClassifier({ engine, blocks: exam.blocks.map((b) => ({ id: b.id, title: b.title, points: b.points.map((p) => ({ id: p.id, text: p.text })) })) });
		const current = readExam(id);
		if (!current) return;
		const { blocks, changed } = applyClassification(current.blocks, kinds);
		const done = new Date().toISOString();
		if (changed.length === 0) {
			save({ ...touch(current), blocks, classified: true, mapping: { state: "done", at: done } });
			return;
		}
		save({ ...touch(current), blocks, classified: true, mapping: { state: "researching", at: done }, research: { done: 0, total: 1, web: (await examSearchProvider()) !== null } });
		await runResearch(id, engine, { mode: "points", pointIds: changed });
	});
	return { ok: true };
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

const isSessionKind = (v: unknown): v is ExamSessionKind => v === "placement" || v === "practice" || v === "review" || v === "teach" || v === "mock" || v === "deepen";

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
			// Researched: the unlinked targets it establishes (consolidate:
			// the ones the placement showed known), frozen in the link.
			const targetIds = point.targets
				? point.targets.filter((x) => x.nodeIds.length === 0 && (short ? x.state === "consolidate" : true)).map((x) => x.id)
				: undefined;
			const chat = createChat(title, undefined, { exam: { id, kind: "teach", pointId: point.id, ...(short ? { short: true } : {}), ...(targetIds?.length ? { targetIds } : {}) } });
			stampStrongModel(chat.id);
			const toTeach = point.nodeIds.filter((n) => status.ideas.find((i) => i.nodeId === n)?.toTeach);
			if (toTeach.length) seedGraphContext(chat.id, picksOf(toTeach));
			const opening = t(locale, short ? "exams.session.consolidateOpening" : "exams.session.teachOpening", { exam, point: point.text });
			return { ok: true, session: { id: chat.id, title: chat.title, opening, kind } };
		}
		case "deepen": {
			// «Profundizar» (owner 2026-11-06): on demand, outside the plan,
			// from a point that already has ideas; what is born here is
			// «ampliación».
			const point = pointId ? status.points.find((p) => p.id === pointId) : undefined;
			if (!point || (point.nodeIds.length === 0 && !point.taughtSession)) return { ok: false, status: 409, error: "nothing to deepen yet" };
			const short = point.text.length > 60 ? `${point.text.slice(0, 57)}…` : point.text;
			const chat = createChat(t(locale, "exams.session.deepenTitle", { point: short }), undefined, { exam: { id, kind: "deepen", pointId: point.id } });
			stampStrongModel(chat.id);
			seedGraphContext(chat.id, picksOf(point.nodeIds));
			return { ok: true, session: { id: chat.id, title: chat.title, opening: t(locale, "exams.session.deepenOpening", { point: point.text }), kind } };
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
/** The rules and tutor instructions block (owner-approved text D), in
 *  every exam session; a part with nothing in it is left out. A point
 *  not researched yet stands in with its own text. */
export function examInstructions(exam: Pick<ExamRecord, "blocks">): string | undefined {
	const lines = (kind: "rules" | "tutor") =>
		instructionPoints(exam, kind)
			.flatMap((p) => (p.targets?.length ? p.targets.map((t) => t.statement) : [p.text]))
			.map((x) => `- ${x}`)
			.join("\n");
	const rules = lines("rules");
	const tutor = lines("tutor");
	if (!rules && !tutor) return undefined;
	const sections = [
		rules ? `The exam's own rules — what is allowed, what scores, how it is sat:\n${rules}` : "",
		tutor ? `Instructions for you as tutor, from the learner's syllabus:\n${tutor}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	return examAppendix("instructions", { sections });
}

export function examSessionAppendix(record: Pick<ChatRecord, "exam">): string | undefined {
	const main = kindAppendix(record);
	const exam = main !== undefined && record.exam ? readExam(record.exam.id) : null;
	const extra = exam ? examInstructions(exam) : undefined;
	return main !== undefined && extra ? `${main}\n\n${extra}` : main;
}

function kindAppendix(record: Pick<ChatRecord, "exam">): string | undefined {
	const link = record.exam;
	if (!link || link.kind === "review" || !isExamId(link.id)) return undefined;
	const exam = readExam(link.id);
	if (!exam) return undefined;
	const base = { title: exam.title, date: exam.examDate, mode: exam.standard.mode };
	const pointText = new Map(allPoints(exam).map((p) => [p.id, p.text]));
	const targetText = new Map(allPoints(exam).flatMap((p) => (p.targets ?? []).map((x) => [x.id, x.statement] as const)));
	const targetList = (ids: readonly string[]) => ids.filter((x) => targetText.has(x)).map((x) => `- ${targetText.get(x)}`).join("\n");
	switch (link.kind) {
		case "placement": {
			const ids = (link.pointIds ?? []).filter((p) => pointText.has(p));
			const tids = (link.pointIds ?? []).filter((p) => targetText.has(p));
			const points =
				(ids.length ? `${examAppendix("placement-points", { points: ids.map((p) => `  - [${p}] ${pointText.get(p)}`).join("\n") })}\n` : "") +
				(tids.length ? `${examAppendix("placement-targets", { targets: tids.map((p) => `  - [${p}] ${targetText.get(p)}`).join("\n") })}\n` : "");
			return examAppendix("placement", { ...base, threshold: effectiveSettings().review.confidenceThreshold, points, andPoints: ids.length || tids.length ? " and point" : "" });
		}
		case "practice": {
			const ideas = Object.entries(link.levels ?? {}).map(([id, level]) => `- [${id}] reached: ${MODE_WORD[level] ?? "none yet"}`).join("\n");
			return examAppendix("practice", { ...base, ideas });
		}
		case "teach": {
			const point = (link.pointId && pointText.get(link.pointId)) || "";
			const list = targetList(link.targetIds ?? []);
			const targets = list ? `\nThe target ideas to establish:\n${list}\n` : "";
			return link.short
				? examAppendix("consolidate", { ...base, point, minutes: effectiveSettings().exams.consolidateMinutes, targets })
				: examAppendix("teach", { ...base, point, targets });
		}
		case "deepen": {
			const point = (link.pointId && pointText.get(link.pointId)) || "";
			return examAppendix("deepen", { ...base, point });
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
			emit("exam-notice", { examId: id, exam, kind: pick.kind });
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
		if (reviewPending) emit("review-notice", { kind, count: n });
		else for (const l of examPending) emit("exam-notice", { examId: l.examId, exam: l.exam, kind: kind === "digest" ? "study" : "pending", minutes: l.minutes });
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

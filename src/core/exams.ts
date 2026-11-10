/**
 * EXAMS WITH A DEADLINE — the pure model («Exámenes», owner 2026-11-05).
 *
 * Supersedes architecture.md §7's "strengthening, not assessment" for
 * exam ideas: an exam has a syllabus, a date and a STANDARD, and the app
 * plans study toward it. Everything here is pure (browser-safe, no fs);
 * src/server/exams.ts feeds it the review model, the chat records and the
 * graph. Store events, derive state: levels, recall, coverage and plans are
 * NEVER stored — only the exam record itself (src/store/exams.ts).
 *
 * THE STANDARD (owner): two axes per idea —
 *   recall  FSRS probability of recall ON the exam day (no further study)
 *   mode    the demand mode solved without hints, confidently
 *           (Recordar → Discriminar → Componer)
 * An idea MEETS the standard when both hold (and it is not «por enseñar»).
 * COVERAGE is counted PER SYLLABUS POINT (owner): each point weighs the
 * same; its score is the share of its ideas that meet; a point with no
 * ideas yet (not taught) scores 0. Presets: Aprobado / Notable /
 * Sobresaliente, editable through «Personalizar».
 *
 * THE REACHED MODE (owner adaptation rules), replayed from graded events:
 *   up    (clean, no hints, confidence ≥ threshold) → max(level, mode)
 *   stay  (low confidence, light hints R1–R2)       → unchanged
 *   miss  (heavy hints R3–R5, surrendered, wrong)   → down one mode;
 *         two misses in a row at Recordar or below  → «por enseñar»;
 *         in the placement test, a miss with no level yet → «por enseñar».
 *   Teach checks act at Recordar (owner). A later teach event (the idea
 *   taught again) clears «por enseñar».
 */

import { forgetting_curve, FSRS6_DEFAULT_DECAY } from "ts-fsrs";
import type { CalendarItem } from "./calendar.ts";
import {
	DAY_ROLLOVER_HOUR,
	daysBetween,
	reviewDay,
	stepFromConclude,
	type DemandMode,
	type ReviewEvent,
	type ReviewItem,
} from "./review.ts";
import type { NpMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, problemCallForConclude } from "./native-messages.ts";
import { problemConfidence } from "./review.ts";
import type { ChatExamLink } from "./contracts/chat.ts";

// ─── the standard ───────────────────────────────────────────────────────────

export type ExamPreset = "pass" | "merit" | "distinction";

export interface ExamStandard {
	/** The preset it came from; null = «Personalizar». */
	preset: ExamPreset | null;
	/** Recall on the exam day, 0.5–0.99. */
	recall: number;
	mode: DemandMode;
	/** Share of the syllabus (per point) that must meet, 0.05–1. */
	coverage: number;
}

export const PRESET_ORDER: readonly ExamPreset[] = ["pass", "merit", "distinction"];

/** Owner-approved presets (2026-11-05). */
export const EXAM_PRESETS: Record<ExamPreset, Omit<ExamStandard, "preset">> = {
	pass: { recall: 0.8, mode: "recall", coverage: 0.7 },
	merit: { recall: 0.9, mode: "discrimination", coverage: 0.85 },
	distinction: { recall: 0.95, mode: "composition", coverage: 0.95 },
};

export const presetStandard = (preset: ExamPreset): ExamStandard => ({ preset, ...EXAM_PRESETS[preset] });

export type ModeLevel = 0 | 1 | 2 | 3;

export const MODE_LEVEL: Record<DemandMode, 1 | 2 | 3> = { recall: 1, discrimination: 2, composition: 3 };

export const EXAM_RECALL_MIN = 0.5;
export const EXAM_RECALL_MAX = 0.99;
export const EXAM_COVERAGE_MIN = 0.05;

// ─── the record ─────────────────────────────────────────────────────────────

export interface SyllabusPoint {
	id: string;
	text: string;
	/** Graph propositions the mapping linked (empty = «falta»). With
	 *  research done: the union of its targets' links. */
	nodeIds: string[];
	/** The research's target ideas (owner 2026-11-06); absent = the point
	 *  was not researched (a v1 exam, or research pending). */
	targets?: TargetIdea[];
	/** «Ampliación» (owner 2026-11-06): ideas formed while studying the
	 *  point that go beyond its targets — dated review, not counted. */
	extension?: string[];
	/** The point's own type when it differs from its block's (owner
	 *  2026-11-06). For an instruction point `targets` holds its RULES. */
	kind?: PointKind;
	/** Its type changed and it waits for «Investigar cambios» (owner
	 *  2026-11-06): the type its targets/rules were made for. */
	pendingFrom?: PointKind;
	/** Where the point comes from (owner 2026-11-06, «guía oficial
	 *  primero»): the official guide, the learner's guidelines, the model's
	 *  proposal, or an ampliación idea promoted to «punto extra». Absent on
	 *  points made before. */
	origin?: PointOrigin;
}

export type PointOrigin = "official" | "user" | "model" | "extra";

const isPointOrigin = (v: unknown): v is PointOrigin => v === "official" || v === "user" || v === "model" || v === "extra";

/** Owner 2026-11-06: a syllabus point is something to learn; «rules» are
 *  the subject's instructions (how the exam runs: allowed, scored,
 *  timing, format); «tutor» are instructions for the LLM tutor. Only
 *  «syllabus» points are studied (coverage, placement, plan, sorter). */
export type PointKind = "syllabus" | "rules" | "tutor";

export const POINT_KINDS: readonly PointKind[] = ["syllabus", "rules", "tutor"];

const isPointKind = (v: unknown): v is PointKind => v === "syllabus" || v === "rules" || v === "tutor";

/** A point's effective type: its own, else its block's, else syllabus. */
export const pointKind = (block: Pick<SyllabusBlock, "kind">, point: Pick<SyllabusPoint, "kind">): PointKind => point.kind ?? block.kind ?? "syllabus";

/** Where a target idea comes from (owner 2026-11-06). */
export interface TargetSource {
	/** user = added by hand in the review; notes = an ampliación idea
	 *  promoted to «punto extra» («De tus notas»). */
	kind: "material" | "web" | "model" | "user" | "notes";
	/** Material name, page title, or "" for the model's knowledge. */
	title: string;
	/** Material id or URL. */
	ref?: string;
	year?: string;
	/** Older than a syllabus change («puede estar desactualizado»). */
	outdated?: boolean;
}

/** One idea a point requires (owner 2026-11-06): lives in the exam, not
 *  the graph — it enters the graph only when taught. */
export interface TargetIdea {
	id: string;
	statement: string;
	source: TargetSource;
	/** Graph ideas that express it (from the learner's notes, or born
	 *  while studying it). Empty = not in the graph yet. */
	nodeIds: string[];
}

export const MAX_TARGETS_PER_POINT = 12;

/** «Conocimientos previos» (owner 2026-11-09): knowledge the syllabus
 *  takes for granted. Not counted in the coverage; each one BLOCKS the
 *  points (or the shallower prerequisites) that rest on it until it is
 *  taught and solved at least at Recordar. Its own bar is Componer with
 *  the exam's recall, whatever the preset — a deep foundation. */
export interface ExamPrerequisite {
	id: string;
	statement: string;
	source: TargetSource;
	/** Graph ideas that express it (empty = not in the graph yet). */
	nodeIds: string[];
	/** What rests on it: syllabus point ids and/or prerequisite ids. */
	blocks: string[];
	origin: PrerequisiteOrigin;
	/** 1 = right under the syllabus … MAX_PREREQUISITE_DEPTH. */
	depth: number;
	/** The same prerequisite across exams (owner: shared through the
	 *  graph — taught once, reviewed once); defaults to its id. */
	key: string;
}

/** One proposed prerequisite of «Detectar conocimientos previos». */
export interface PrerequisiteProposalItem {
	id: string;
	/** An EXISTING id it reuses (this exam's or another exam's). */
	reuse?: string;
	statement: string;
	/** Points resting on it. */
	points: string[];
	nodeIds: string[];
	/** The placement problems that suggest it («Lo sugiere: “…”»). */
	evidence: string[];
}

export interface PrerequisiteSearch {
	state: "running" | "ready" | "error";
	/** draft = results go in directly; review = a proposal. */
	mode: "draft" | "review";
	at: string;
	done: number;
	total: number;
	error?: string;
	items?: PrerequisiteProposalItem[];
}

/** research = the reconnaissance research; diagnosis = found by the
 *  placement test after a miss; user = added by hand. */
export type PrerequisiteOrigin = "research" | "diagnosis" | "user";

const isPrerequisiteOrigin = (v: unknown): v is PrerequisiteOrigin => v === "research" || v === "diagnosis" || v === "user";

/** Owner 2026-11-09: the drill-down stops three levels under the syllabus. */
export const MAX_PREREQUISITE_DEPTH = 3;
/** A prerequisite's bar: Componer, whatever the preset. */
export const PREREQUISITE_LEVEL: ModeLevel = 3;

/** A researched point's links are its targets' links (kept in sync on
 *  every write). */
export function syncPointLinks(blocks: SyllabusBlock[]): SyllabusBlock[] {
	return blocks.map((b) => ({
		...b,
		points: b.points.map((p) => (p.targets ? { ...p, nodeIds: [...new Set(p.targets.flatMap((t) => t.nodeIds))] } : p)),
	}));
}

/** The research's progress and outcome (owner 2026-11-06). */
export interface ExamResearch {
	/** Blocks researched / to research. */
	done: number;
	total: number;
	/** The block being researched now. */
	current?: string;
	/** A search engine was available (else: «Sin búsqueda web»). */
	web: boolean;
	error?: { block: string; message: string };
}

export interface SyllabusBlock {
	id: string;
	title: string;
	points: SyllabusPoint[];
	/** The block's type, inherited by its points (absent = syllabus). */
	kind?: PointKind;
	/** Not in this sitting (owner 2026-11-06): the guide leaves it out of
	 *  the test on the exam date. Kept, not studied; «Entra en esta prueba»
	 *  brings it back. */
	excluded?: boolean;
}

/** Set a block's type (its points follow it, own types cleared) or one
 *  point's. Nothing is researched here (owner 2026-11-06): a point whose
 *  effective type changed is marked PENDING (`pendingFrom` = the type its
 *  content was made for) and keeps that content hidden until «Investigar
 *  cambios»; setting the old type back cancels the change. */
export function setPointKind(blocks: readonly SyllabusBlock[], blockId: string, pointId: string | null, kind: PointKind): { blocks: SyllabusBlock[]; changed: string[] } {
	const changed: string[] = [];
	const mark = (p: SyllabusPoint, before: PointKind, after: PointKind): SyllabusPoint => {
		if (before === after) return p;
		changed.push(p.id);
		const from = p.pendingFrom ?? before;
		const { pendingFrom: _f, ...rest } = p;
		return from === after ? rest : { ...rest, pendingFrom: from };
	};
	const next = blocks.map((b) => {
		if (b.id !== blockId) return b;
		if (pointId === null) {
			const block: SyllabusBlock = { ...b, kind };
			if (kind === "syllabus") delete block.kind;
			block.points = b.points.map((p) => {
				const { kind: _k, ...own } = p;
				return mark(own, pointKind(b, p), kind);
			});
			return block;
		}
		return {
			...b,
			points: b.points.map((p) => {
				if (p.id !== pointId) return p;
				const { kind: _k, ...own } = p;
				const withKind: SyllabusPoint = kind === (b.kind ?? "syllabus") ? own : { ...own, kind };
				return mark(withKind, pointKind(b, p), kind);
			}),
		};
	});
	return { blocks: next, changed };
}

/** Points with a type change waiting for «Investigar cambios». */
export const pendingKindPoints = (exam: Pick<ExamRecord, "blocks">): string[] => exam.blocks.flatMap((b) => b.points.filter((p) => p.pendingFrom).map((p) => p.id));

/** A pending point's content belongs to its old type: hidden until it is
 *  researched again. */
export function withoutStaleContent<P extends SyllabusPoint>(p: P): P {
	if (!p.pendingFrom) return p;
	const { targets: _t, extension: _e, ...rest } = p;
	return { ...rest, nodeIds: [] } as unknown as P;
}

/** Apply «Clasificar temario»'s answer: each block's kind, then the
 *  points that differ. `changed` = points whose type changed. */
export function applyClassification(
	blocks: readonly SyllabusBlock[],
	kinds: { blocks: ReadonlyMap<string, PointKind>; points: ReadonlyMap<string, PointKind> },
): { blocks: SyllabusBlock[]; changed: string[] } {
	const changed: string[] = [];
	const next = blocks.map((b) => {
		const blockKind = kinds.blocks.get(b.id) ?? b.kind ?? "syllabus";
		const points = b.points.map((p) => {
			const kind = kinds.points.get(p.id) ?? blockKind;
			const { kind: _k, ...own } = p;
			const point: SyllabusPoint = kind === blockKind ? own : { ...own, kind };
			if (kind === pointKind(b, p)) return point;
			changed.push(p.id);
			const { targets: _t, extension: _e, ...rest } = point;
			return { ...rest, nodeIds: [] };
		});
		const block: SyllabusBlock = { ...b, points, kind: blockKind };
		if (blockKind === "syllabus") delete block.kind;
		return block;
	});
	return { blocks: next, changed };
}


/** draft = created, mapping not yet confirmed; active = planned;
 *  archived = after the date (or by hand). */
export type ExamStatus = "draft" | "active" | "archived";

/** reading = the chosen unread folders are being read into the graph
 *  first (owner 2026-11-06); the mapping starts on its own after. */
export type MappingState = "none" | "reading" | "guide" | "needs_guide" | "running" | "researching" | "prerequisites" | "done" | "error";

/** The official guide behind the syllabus (owner 2026-11-06, «guía oficial
 *  primero»). found = the guide finder found it; missing = it didn't (the
 *  mapping waits: paste/attach/link, search again, or go on without);
 *  none = the learner went on without one; skipped = a Personal exam or an
 *  empty context — no search. */
export interface ExamGuide {
	state: "found" | "missing" | "none" | "skipped";
	title?: string;
	/** URL, or the material id. */
	ref?: string;
	sourceKind?: "material" | "web";
	year?: string;
	/** «Entra en febrero: temas 1–6» — the learner's language. */
	scopeNote?: string;
	/** Why it was not found (state missing). */
	reason?: string;
	/** The guide's own outline (kept for «Contrastar con la guía»). */
	outline?: GuideBlock[];
	/** Where the learner's guidelines contradict the guide. */
	conflicts?: string[];
}

export interface GuideBlock {
	title: string;
	inSitting: boolean;
	points: Array<{ text: string; fromGuide: boolean }>;
}

/** «Contrastar con la guía» (owner 2026-11-06): what differs between the
 *  exam's syllabus and the official one — nothing changes until applied. */
export interface ExamContrast {
	state: "running" | "ready" | "error";
	at: string;
	error?: string;
	/** Official points no current point covers. */
	missing?: Array<{ id: string; blockTitle: string; text: string; inSitting: boolean }>;
	/** Current points that cover no official point, with the official point
	 *  (its text) they are closest to, or null. */
	extras?: Array<{ pointId: string; closest: string | null }>;
}

/** The exam's context (owner 2026-11-06, all optional): it steers the
 *  research toward the right official guide / school / sitting. */
export type ExamContextKind = "official" | "school" | "certification" | "public" | "personal";

export const EXAM_CONTEXT_KINDS: readonly ExamContextKind[] = ["official", "school", "certification", "public", "personal"];

export interface ExamContext {
	kind: ExamContextKind | null;
	/** Exam or subject name («PAU +25 — Matemáticas»). */
	name: string;
	/** School or organizing body. */
	institution: string;
	/** Country / region / city. */
	location: string;
	/** Sitting / year («2027»); the wizard prefills the exam date's year. */
	sitting: string;
	/** Free text: what the learner is after. */
	goal: string;
}

export const EMPTY_EXAM_CONTEXT: ExamContext = { kind: null, name: "", institution: "", location: "", sitting: "", goal: "" };

/** Search the official guide? (owner 2026-11-06): every exam type but
 *  Personal, unless the context is empty. */
export function guideWanted(context: ExamContext): boolean {
	if (context.kind === "personal") return false;
	return context.kind !== null || context.name.trim() !== "" || context.institution.trim() !== "";
}

/** A research source the learner gave (owner 2026-11-06): a file stored
 *  with the exam (data/exams/<id>/materials/<file>) or a web link. Never
 *  syllabus text, never the graph. */
export interface ExamMaterial {
	id: string;
	kind: "file" | "link";
	/** Display name (the original file name, or the link's URL/label). */
	name: string;
	/** kind file: the stored file name inside the materials folder. */
	file?: string;
	/** kind link: the URL. */
	url?: string;
	addedAt: string;
}

/** The unread-folder read that runs before the mapping (owner
 *  2026-11-06): the notes in the exam's scope that were not in the graph
 *  when it started, and those that failed. */
export interface ExamReading {
	/** Folders added to Settings → Knowledge for this exam. */
	added: string[];
	paths: string[];
	failed: Array<{ path: string; error: string }>;
}

export interface ExamRecord {
	version: 1 | 2;
	id: string;
	title: string;
	/** The exam day, "YYYY-MM-DD" (local). */
	examDate: string;
	createdAt: string;
	updatedAt: string;
	status: ExamStatus;
	standard: ExamStandard;
	syllabus: {
		/** Pasted/typed text, plus the extracted text of an attached file. */
		text: string;
		/** The attached file's name (its text is in `text`), or null. */
		fileName: string | null;
		/** Knowledge-folder folders (relative paths, "/"-joined) whose
		 *  notes — subfolders included — are part of the syllabus (owner
		 *  2026-11-06: any folder, any depth, recursive). Older drafts
		 *  stored 2nd-level area ids ("area:X/Y"); they read back as "X/Y". */
		folders: string[];
		/** Folders left PARTIAL in the tree (owner 2026-11-06): only their
		 *  own loose notes count — their subfolders count through
		 *  `folders`. */
		directFolders: string[];
	};
	context: ExamContext;
	materials: ExamMaterial[];
	blocks: SyllabusBlock[];
	/** «Conocimientos previos» (owner 2026-11-09); absent = none found yet. */
	prerequisites?: ExamPrerequisite[];
	/** The prerequisite finder's run (owner 2026-11-09): a draft's results
	 *  go straight in (reviewed in Revisar); an active exam's wait here as
	 *  a proposal until «Aplicar» / «Descartar». */
	prerequisiteSearch?: PrerequisiteSearch;
	mapping: { state: MappingState; error?: string; at?: string };
	reading?: ExamReading;
	research?: ExamResearch;
	guide?: ExamGuide;
	contrast?: ExamContrast;
	/** The syllabus's points carry types (owner 2026-11-06): set by the
	 *  outline of new exams or by «Clasificar temario»; older exams lack it. */
	classified?: boolean;
	/** Blocks the learner chose to prioritize when time is short. */
	priorityBlocks: string[];
	archivedAt?: string;
	/** The learner's real grade, free text («7,5», «Apto»…). */
	realGrade?: string;
	/** Frozen at archive time: the coverage and preset reached. */
	final?: { coverage: number; preset: ExamPreset | null };
}

export const CURRENT_EXAM_VERSION = 2 as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isExamDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T12:00:00`));

const str = (v: unknown, max = 100_000): string | null => (typeof v === "string" && v.length <= max ? v : null);
const strList = (v: unknown): string[] =>
	Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 1024))] : [];
/** A folder path normalized: "\\" → "/", no empty/edge segments. */
export const normalizeFolderPath = (path: string): string => path.split(/[\\/]+/).filter(Boolean).join("/");

/** `folders`, or a legacy `areas` list ("area:X/Y" → "X/Y"; the old
 *  root area "area:/" has no folder and is dropped). */
function syllabusFolders(syllabus: Record<string, unknown>): string[] {
	if (Array.isArray(syllabus.folders)) return reduceFolders(strList(syllabus.folders).map(normalizeFolderPath));
	return reduceFolders(strList(syllabus.areas).map((a) => normalizeFolderPath(a.startsWith("area:") ? a.slice(5) : a)));
}

/** True when `filePath` (a note) lies inside `folder` at any depth. */
export const isInFolder = (filePath: string, folder: string): boolean => {
	const file = normalizeFolderPath(filePath);
	return folder.length > 0 && file.startsWith(`${folder}/`);
};

/** Drop empties, duplicates and folders already covered by a selected
 *  ancestor (selection is recursive); keeps the input order. */
export function reduceFolders(folders: readonly string[]): string[] {
	const clean = [...new Set(folders.map(normalizeFolderPath).filter(Boolean))];
	return clean.filter((f) => !clean.some((other) => other !== f && f.startsWith(`${other}/`)));
}

/** `folders` reduced; `directFolders` minus any covered by a recursive
 *  folder (its loose notes are already in). */
export function sanitizeScope(folders: readonly string[], directFolders: readonly string[]): { folders: string[]; directFolders: string[] } {
	const recursive = reduceFolders(folders);
	const direct = [...new Set(directFolders.map(normalizeFolderPath).filter(Boolean))].filter(
		(d) => !recursive.some((f) => d === f || d.startsWith(`${f}/`)),
	);
	return { folders: recursive, directFolders: direct };
}

const parentFolder = (path: string): string => {
	const segs = normalizeFolderPath(path).split("/");
	return segs.slice(0, -1).join("/");
};

/** Is a note (vault-relative path) inside the exam's folder scope? */
export function inExamScope(notePath: string, scope: { folders: readonly string[]; directFolders: readonly string[] }): boolean {
	if (scope.folders.some((f) => isInFolder(notePath, f))) return true;
	const parent = parentFolder(notePath);
	return parent.length > 0 && scope.directFolders.includes(parent);
}

// ─── the folder tree's selection (owner 2026-11-06) ─────────────────────────
//
// Each folder carries its own flag = «its loose notes are in». Clicking a
// folder that is fully on clears its whole subtree; any other click sets
// the whole subtree. A folder is «on» when it and every descendant are
// flagged, «partial» when anything in its subtree is flagged, else «off».

export type FolderCheck = "on" | "partial" | "off";

/** Every folder path in `all` strictly below `path`. */
const descendantsOf = (path: string, all: readonly string[]) => all.filter((p) => p.startsWith(`${path}/`));

export function folderCheck(path: string, flagged: ReadonlySet<string>, all: readonly string[]): FolderCheck {
	const below = descendantsOf(path, all);
	const own = flagged.has(path);
	if (own && below.every((d) => flagged.has(d))) return "on";
	if (own || below.some((d) => flagged.has(d))) return "partial";
	return "off";
}

export function toggleFolder(path: string, flagged: ReadonlySet<string>, all: readonly string[]): Set<string> {
	const next = new Set(flagged);
	const subtree = [path, ...descendantsOf(path, all)];
	if (folderCheck(path, flagged, all) === "on") for (const p of subtree) next.delete(p);
	else for (const p of subtree) next.add(p);
	return next;
}

/** The flags as the exam stores them: the highest fully-on folders
 *  (recursive — later subfolders join) + the flagged rest (loose notes). */
export function selectionScope(flagged: ReadonlySet<string>, all: readonly string[]): { folders: string[]; directFolders: string[] } {
	const on = [...flagged].filter((p) => folderCheck(p, flagged, all) === "on");
	return sanitizeScope(on, [...flagged]);
}

/** One folder of the knowledge folder for the wizard's tree (owner
 *  2026-11-06: every folder holding notes, read or not). Counts are
 *  recursive. */
export interface VaultFolderInfo {
	path: string;
	/** Graph ideas born from notes in it or below. */
	ideas: number;
	/** Note files in it or below. */
	notes: number;
	/** Of those, notes the knowledge connection does not read. */
	unread: number;
	/** Note files directly in it (not in subfolders). */
	direct: number;
	/** Of those, unread. */
	directUnread: number;
}

/**
 * The folders to add to Settings → Knowledge so the exam's scope gets
 * read (owner 2026-11-06): each recursive folder, and each partial folder
 * with loose notes (added WHOLE — the connection reads whole folders),
 * when it holds unread notes and no watched folder covers it already.
 */
export function foldersToRead(scope: { folders: readonly string[]; directFolders: readonly string[] }, infos: readonly VaultFolderInfo[], watched: readonly string[]): string[] {
	const byPath = new Map(infos.map((i) => [i.path, i]));
	const covered = (p: string) => watched.some((w) => p === w || p.startsWith(`${w}/`));
	const out: string[] = [];
	for (const f of scope.folders) if ((byPath.get(f)?.unread ?? 0) > 0 && !covered(f)) out.push(f);
	for (const d of scope.directFolders) if ((byPath.get(d)?.directUnread ?? 0) > 0 && !covered(d)) out.push(d);
	return reduceFolders(out);
}

/** One folder of the wizard's tree: its path and how many ideas live in
 *  it or below it. */
export interface KnowledgeFolder {
	path: string;
	count: number;
}

/** Every folder holding ideas (at any depth below it), with recursive
 *  counts, from each idea's note path. Notes at the root (no folder) are
 *  not counted — there is no folder to pick. Sorted by path. */
export function knowledgeFolders(notePaths: Iterable<string>): KnowledgeFolder[] {
	const counts = new Map<string, number>();
	for (const filePath of notePaths) {
		const segs = normalizeFolderPath(filePath).split("/").slice(0, -1);
		for (let i = 1; i <= segs.length; i++) {
			const key = segs.slice(0, i).join("/");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function sanitizeStandard(raw: unknown): ExamStandard | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const preset = (PRESET_ORDER as readonly unknown[]).includes(r.preset) ? (r.preset as ExamPreset) : null;
	if (typeof r.recall !== "number" || !Number.isFinite(r.recall)) return null;
	if (typeof r.coverage !== "number" || !Number.isFinite(r.coverage)) return null;
	if (r.mode !== "recall" && r.mode !== "discrimination" && r.mode !== "composition") return null;
	return {
		preset,
		recall: clamp(r.recall, EXAM_RECALL_MIN, EXAM_RECALL_MAX),
		mode: r.mode,
		coverage: clamp(r.coverage, EXAM_COVERAGE_MIN, 1),
	};
}

const shortText = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function sanitizeContext(raw: unknown): ExamContext {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_EXAM_CONTEXT };
	const r = raw as Record<string, unknown>;
	return {
		kind: (EXAM_CONTEXT_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as ExamContextKind) : null,
		name: shortText(r.name, 300),
		institution: shortText(r.institution, 300),
		location: shortText(r.location, 300),
		sitting: shortText(r.sitting, 100),
		goal: shortText(r.goal, 2000),
	};
}

export const MAX_EXAM_MATERIALS = 40;
/** An uploaded material's size cap and accepted formats (the materials
 *  route and the MCP API share them). */
export const EXAM_MATERIAL_MAX_BYTES = 60 * 1024 * 1024;
const EXAM_MATERIAL_EXT_RE = /\.(pdf|docx|epub|md|txt|png|jpe?g|webp|heic)$/i;
export const isExamMaterialFileName = (name: string): boolean => EXAM_MATERIAL_EXT_RE.test(name);

/** Depth line for the research prompt (owner-approved 2026-11-06): by
 *  preset; «Personalizar» follows its mode. */
export function researchDepth(standard: Pick<ExamStandard, "preset" | "mode">): ExamPreset {
	if (standard.preset) return standard.preset;
	return standard.mode === "composition" ? "distinction" : standard.mode === "discrimination" ? "merit" : "pass";
}

export function sanitizeMaterials(raw: unknown): ExamMaterial[] {
	if (!Array.isArray(raw)) return [];
	const out: ExamMaterial[] = [];
	const seen = new Set<string>();
	for (const m of raw) {
		if (out.length >= MAX_EXAM_MATERIALS) break;
		if (m === null || typeof m !== "object") continue;
		const r = m as Record<string, unknown>;
		const id = str(r.id, 64);
		const name = str(r.name, 500);
		if (!id || !name || seen.has(id) || typeof r.addedAt !== "string") continue;
		if (r.kind === "file" && typeof r.file === "string" && /^[\w.-]{1,200}$/.test(r.file)) {
			out.push({ id, kind: "file", name, file: r.file, addedAt: r.addedAt });
		} else if (r.kind === "link" && typeof r.url === "string" && /^https?:\/\//i.test(r.url) && r.url.length <= 2000) {
			out.push({ id, kind: "link", name, url: r.url, addedAt: r.addedAt });
		} else continue;
		seen.add(id);
	}
	return out;
}

function sanitizeResearch(raw: unknown): ExamResearch | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
	const e = r.error !== null && typeof r.error === "object" ? (r.error as Record<string, unknown>) : null;
	return {
		done: n(r.done),
		total: n(r.total),
		...(typeof r.current === "string" ? { current: r.current.slice(0, 500) } : {}),
		web: r.web === true,
		...(e ? { error: { block: shortText(e.block, 500), message: shortText(e.message, 1000) } } : {}),
	};
}

export function sanitizeTargets(raw: unknown): TargetIdea[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: TargetIdea[] = [];
	const seen = new Set<string>();
	for (const t of raw) {
		if (t === null || typeof t !== "object") continue;
		const r = t as Record<string, unknown>;
		const id = str(r.id, 64);
		const statement = shortText(r.statement, 2000);
		if (!id || !statement || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, statement, source: sanitizeSource(r.source), nodeIds: strList(r.nodeIds) });
	}
	return out;
}

function sanitizeSource(raw: unknown): TargetSource {
	const src = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const kind = src.kind === "material" || src.kind === "web" || src.kind === "user" || src.kind === "notes" ? src.kind : "model";
	const ref = shortText(src.ref, 2000);
	const year = shortText(src.year, 20);
	return { kind, title: shortText(src.title, 500), ...(ref ? { ref } : {}), ...(year ? { year } : {}), ...(src.outdated === true ? { outdated: true } : {}) };
}

export function sanitizePrerequisites(raw: unknown): ExamPrerequisite[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: ExamPrerequisite[] = [];
	const seen = new Set<string>();
	for (const x of raw) {
		if (x === null || typeof x !== "object") continue;
		const r = x as Record<string, unknown>;
		const id = str(r.id, 64);
		const statement = shortText(r.statement, 2000);
		if (!id || !statement || seen.has(id)) continue;
		seen.add(id);
		const depth = typeof r.depth === "number" && Number.isFinite(r.depth) ? clamp(Math.round(r.depth), 1, MAX_PREREQUISITE_DEPTH) : 1;
		out.push({
			id,
			statement,
			source: sanitizeSource(r.source),
			nodeIds: strList(r.nodeIds),
			blocks: strList(r.blocks).filter((b) => b !== id),
			origin: isPrerequisiteOrigin(r.origin) ? r.origin : "research",
			depth,
			key: str(r.key, 200) || id,
		});
	}
	return out;
}

function sanitizePrerequisiteSearch(raw: unknown): PrerequisiteSearch | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if ((r.state !== "running" && r.state !== "ready" && r.state !== "error") || typeof r.at !== "string") return null;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
	const out: PrerequisiteSearch = { state: r.state, mode: r.mode === "draft" ? "draft" : "review", at: r.at, done: n(r.done), total: n(r.total) };
	if (typeof r.error === "string") out.error = r.error.slice(0, 1000);
	if (Array.isArray(r.items))
		out.items = r.items
			.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
			.map((x) => ({
				id: shortText(x.id, 64),
				...(typeof x.reuse === "string" ? { reuse: x.reuse.slice(0, 64) } : {}),
				statement: shortText(x.statement, 2000),
				points: strList(x.points),
				nodeIds: strList(x.nodeIds),
				evidence: strList(x.evidence).map((e) => e.slice(0, 1500)),
			}))
			.filter((x) => x.id && x.statement);
	return out;
}

function sanitizeReading(raw: unknown): ExamReading | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const failed = Array.isArray(r.failed)
		? r.failed
				.filter((f): f is Record<string, unknown> => f !== null && typeof f === "object")
				.filter((f) => typeof f.path === "string")
				.map((f) => ({ path: f.path as string, error: typeof f.error === "string" ? f.error.slice(0, 500) : "" }))
		: [];
	return { added: strList(r.added), paths: strList(r.paths), failed };
}

export function sanitizeGuideOutline(raw: unknown): GuideBlock[] {
	if (!Array.isArray(raw)) return [];
	const out: GuideBlock[] = [];
	for (const b of raw) {
		if (b === null || typeof b !== "object") continue;
		const r = b as Record<string, unknown>;
		const title = shortText(r.title, 500);
		if (!title) continue;
		const points = (Array.isArray(r.points) ? r.points : [])
			.filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
			.map((p) => ({ text: shortText(p.text, 2000), fromGuide: p.fromGuide !== false }))
			.filter((p) => p.text);
		out.push({ title, inSitting: r.inSitting !== false, points });
	}
	return out;
}

function sanitizeGuide(raw: unknown): ExamGuide | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.state !== "found" && r.state !== "missing" && r.state !== "none" && r.state !== "skipped") return null;
	const text = (v: unknown, max: number) => {
		const s = shortText(v, max);
		return s ? s : undefined;
	};
	const outline = sanitizeGuideOutline(r.outline);
	const conflicts = strList(r.conflicts).map((c) => c.slice(0, 1000));
	const g: ExamGuide = { state: r.state };
	const title = text(r.title, 500);
	const ref = text(r.ref, 2000);
	const year = text(r.year, 20);
	const scopeNote = text(r.scopeNote, 500);
	const reason = text(r.reason, 1000);
	if (title) g.title = title;
	if (ref) g.ref = ref;
	if (r.sourceKind === "material" || r.sourceKind === "web") g.sourceKind = r.sourceKind;
	if (year) g.year = year;
	if (scopeNote) g.scopeNote = scopeNote;
	if (reason) g.reason = reason;
	if (outline.length) g.outline = outline;
	if (conflicts.length) g.conflicts = conflicts;
	return g;
}

function sanitizeContrast(raw: unknown): ExamContrast | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if ((r.state !== "running" && r.state !== "ready" && r.state !== "error") || typeof r.at !== "string") return null;
	const c: ExamContrast = { state: r.state, at: r.at };
	if (typeof r.error === "string") c.error = r.error.slice(0, 1000);
	if (Array.isArray(r.missing))
		c.missing = r.missing
			.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
			.map((m) => ({ id: shortText(m.id, 64), blockTitle: shortText(m.blockTitle, 500), text: shortText(m.text, 2000), inSitting: m.inSitting !== false }))
			.filter((m) => m.id && m.text);
	if (Array.isArray(r.extras))
		c.extras = r.extras
			.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object" && typeof m.pointId === "string")
			.map((m) => ({ pointId: m.pointId as string, closest: typeof m.closest === "string" ? m.closest.slice(0, 2000) : null }));
	return c;
}

export function sanitizeBlocks(raw: unknown): SyllabusBlock[] {
	if (!Array.isArray(raw)) return [];
	const out: SyllabusBlock[] = [];
	const seen = new Set<string>();
	for (const b of raw) {
		if (b === null || typeof b !== "object") continue;
		const block = b as Record<string, unknown>;
		const id = str(block.id, 64);
		const title = str(block.title, 500);
		if (!id || title === null || seen.has(id)) continue;
		seen.add(id);
		const points: SyllabusPoint[] = [];
		for (const p of Array.isArray(block.points) ? block.points : []) {
			if (p === null || typeof p !== "object") continue;
			const point = p as Record<string, unknown>;
			const pid = str(point.id, 64);
			const text = str(point.text, 2000);
			if (!pid || !text || seen.has(pid)) continue;
			seen.add(pid);
			const targets = sanitizeTargets(point.targets);
			const extension = strList(point.extension);
			points.push({
				id: pid,
				text,
				nodeIds: strList(point.nodeIds),
				...(targets ? { targets } : {}),
				...(extension.length ? { extension } : {}),
				...(isPointKind(point.kind) ? { kind: point.kind } : {}),
				...(isPointKind(point.pendingFrom) ? { pendingFrom: point.pendingFrom } : {}),
				...(isPointOrigin(point.origin) ? { origin: point.origin } : {}),
			});
		}
		out.push({ id, title, points, ...(isPointKind(block.kind) && block.kind !== "syllabus" ? { kind: block.kind } : {}), ...(block.excluded === true ? { excluded: true } : {}) });
	}
	return out;
}

/** Coerce an exam file. null = unusable; throws on a NEWER version (the
 *  chat-record law: never rewrite what this build doesn't understand). */
export function sanitizeExamRecord(raw: unknown): ExamRecord | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.version === "number" && r.version > CURRENT_EXAM_VERSION) {
		throw new Error(`exam stamped with version ${r.version} > ${CURRENT_EXAM_VERSION} — this app build is older`);
	}
	const id = str(r.id, 64);
	const title = str(r.title, 300);
	const standard = sanitizeStandard(r.standard);
	if (!id || !title || !isExamDate(r.examDate) || !standard) return null;
	if (typeof r.createdAt !== "string" || typeof r.updatedAt !== "string") return null;
	const status: ExamStatus = r.status === "active" || r.status === "archived" ? r.status : "draft";
	const syllabus = (r.syllabus !== null && typeof r.syllabus === "object" ? r.syllabus : {}) as Record<string, unknown>;
	const mapping = (r.mapping !== null && typeof r.mapping === "object" ? r.mapping : {}) as Record<string, unknown>;
	const mappingState: MappingState =
		mapping.state === "reading" || mapping.state === "guide" || mapping.state === "needs_guide" || mapping.state === "running" || mapping.state === "researching" || mapping.state === "prerequisites" || mapping.state === "done" || mapping.state === "error"
			? mapping.state
			: "none";
	const final = r.final !== null && typeof r.final === "object" ? (r.final as Record<string, unknown>) : null;
	const reading = sanitizeReading(r.reading);
	const research = sanitizeResearch(r.research);
	const guide = sanitizeGuide(r.guide);
	const contrast = sanitizeContrast(r.contrast);
	const prerequisites = sanitizePrerequisites(r.prerequisites);
	const prerequisiteSearch = sanitizePrerequisiteSearch(r.prerequisiteSearch);
	return {
		version: CURRENT_EXAM_VERSION,
		id,
		title,
		examDate: r.examDate,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		status,
		standard,
		syllabus: { text: str(syllabus.text) ?? "", fileName: str(syllabus.fileName, 500), ...sanitizeScope(syllabusFolders(syllabus), strList(syllabus.directFolders)) },
		context: sanitizeContext(r.context),
		materials: sanitizeMaterials(r.materials),
		blocks: sanitizeBlocks(r.blocks),
		...(prerequisites ? { prerequisites } : {}),
		...(prerequisiteSearch ? { prerequisiteSearch } : {}),
		mapping: {
			state: mappingState,
			...(typeof mapping.error === "string" ? { error: mapping.error } : {}),
			...(typeof mapping.at === "string" ? { at: mapping.at } : {}),
		},
		...(reading ? { reading } : {}),
		...(research ? { research } : {}),
		...(guide ? { guide } : {}),
		...(contrast ? { contrast } : {}),
		...(r.classified === true ? { classified: true } : {}),
		priorityBlocks: strList(r.priorityBlocks),
		...(typeof r.archivedAt === "string" ? { archivedAt: r.archivedAt } : {}),
		...(typeof r.realGrade === "string" && r.realGrade.length <= 100 ? { realGrade: r.realGrade } : {}),
		...(final && typeof final.coverage === "number"
			? { final: { coverage: clamp(final.coverage, 0, 1), preset: (PRESET_ORDER as readonly unknown[]).includes(final.preset) ? (final.preset as ExamPreset) : null } }
			: {}),
	};
}

export const allPoints = (exam: Pick<ExamRecord, "blocks">): Array<SyllabusPoint & { blockId: string }> =>
	exam.blocks.flatMap((b) => b.points.map((p) => ({ ...p, blockId: b.id })));

/** The points to STUDY (type syllabus, in this sitting): coverage,
 *  placement, plan, sort. */
export const studyPoints = (exam: Pick<ExamRecord, "blocks">): Array<SyllabusPoint & { blockId: string }> =>
	exam.blocks.filter((b) => !b.excluded).flatMap((b) => b.points.filter((p) => pointKind(b, p) === "syllabus").map((p) => ({ ...withoutStaleContent(p), blockId: b.id })));

/** The instruction points of one type, with their block. */
export const instructionPoints = (exam: Pick<ExamRecord, "blocks">, kind: Exclude<PointKind, "syllabus">): Array<SyllabusPoint & { blockId: string; blockTitle: string }> =>
	exam.blocks.filter((b) => !b.excluded).flatMap((b) => b.points.filter((p) => pointKind(b, p) === kind).map((p) => ({ ...withoutStaleContent(p), blockId: b.id, blockTitle: b.title })));

// ─── days ───────────────────────────────────────────────────────────────────

/** The moment recall is predicted for: 09:00 local on the exam day. */
export function examMoment(examDate: string): number {
	const [y, m, d] = examDate.split("-").map(Number);
	return new Date(y!, m! - 1, d!, 9, 0, 0, 0).getTime();
}

/** The start (04:00 rollover) of a review day "YYYY-MM-DD". */
export function dayStart(day: string): number {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y!, m! - 1, d!, DAY_ROLLOVER_HOUR, 0, 0, 0).getTime();
}

/** "YYYY-MM-DD" shifted by whole days. */
export function addDays(day: string, n: number): string {
	const [y, m, d] = day.split("-").map(Number);
	const t = new Date(y!, m! - 1, d! + n, 12);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/** Monday-first weekday index (0 = Monday … 6 = Sunday) of a day string. */
export function weekdayIndex(day: string): number {
	const [y, m, d] = day.split("-").map(Number);
	return (new Date(y!, m! - 1, d!, 12).getDay() + 6) % 7;
}

// ─── recall ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Probability of recall at `at` for an idea last reviewed at
 *  `lastReview` with FSRS stability `stability` (FSRS-6 curve). */
export function recallAt(stability: number, lastReview: number, at: number): number {
	const elapsed = Math.max(0, (at - lastReview) / DAY_MS);
	return forgetting_curve(FSRS6_DEFAULT_DECAY, elapsed, stability);
}

/** Days after a review until recall falls to `r` (inverse of the curve,
 *  by bisection — monotone, so 50 steps are plenty). */
export function intervalDays(stability: number, r: number): number {
	let lo = 0;
	let hi = 36_500;
	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		if (forgetting_curve(FSRS6_DEFAULT_DECAY, mid, stability) > r) lo = mid;
		else hi = mid;
	}
	return lo;
}

// ─── deadline-aware review (owner: one Repaso, with a date) ─────────────────

/** What computeReview needs to know about one active exam. */
export interface ExamDeadline {
	examId: string;
	nodeIds: readonly string[];
	examDate: string;
	recall: number;
	finalWindowDays: number;
}

/**
 * An exam idea's due time (owner): pulled EARLIER when the normal interval
 * would reach the exam day below the target recall — the due becomes the
 * moment recall falls to max(normal target, exam target) — and there is
 * ALWAYS a final review inside the last `finalWindowDays` days. After the
 * exam the normal rhythm returns (the caller stops passing the deadline).
 * Pure; `due` is the normal FSRS due.
 */
export function deadlineDue(input: {
	due: number;
	stability: number;
	lastReview: number;
	targetRetention: number;
	deadline: Pick<ExamDeadline, "examDate" | "recall" | "finalWindowDays">;
}): number {
	const { deadline } = input;
	const moment = examMoment(deadline.examDate);
	if (input.lastReview >= moment) return input.due;
	const r = Math.max(input.targetRetention, deadline.recall);
	let due = Math.min(input.due, input.lastReview + intervalDays(input.stability, r) * DAY_MS);
	const windowStart = dayStart(addDays(deadline.examDate, -deadline.finalWindowDays));
	if (input.lastReview < windowStart) due = Math.min(due, Math.max(windowStart, input.lastReview + DAY_MS));
	return due;
}

/** An exam's ideas: the mapped ones ∪ those born in its own teach
 *  sessions (a taught «falta» point joins the exam through them). */
export function examNodeIds(exam: Pick<ExamRecord, "id" | "blocks" | "prerequisites">, chats: ReadonlyArray<Pick<ExamChat, "id" | "exam">>, nodesBornIn: ReadonlyMap<string, readonly string[]>): string[] {
	const out = new Set<string>();
	// «Conocimientos previos» (owner 2026-11-09): their ideas, and the
	// ones born in their own teach sessions, are the exam's too.
	const prereqIds = new Set((exam.prerequisites ?? []).map((p) => p.id));
	for (const p of exam.prerequisites ?? []) for (const id of p.nodeIds) out.add(id);
	for (const chat of chats) {
		if (chat.exam?.id !== exam.id || chat.exam.kind !== "teach" || !chat.exam.prerequisiteId || !prereqIds.has(chat.exam.prerequisiteId)) continue;
		for (const id of nodesBornIn.get(chat.id) ?? []) out.add(id);
	}
	const researched = new Set<string>();
	for (const p of studyPoints(exam)) {
		for (const id of p.nodeIds) out.add(id);
		for (const id of p.extension ?? []) out.add(id);
		if (p.targets) researched.add(p.id);
	}
	// Researched points gain born ideas through the sort (targets or
	// ampliación); unresearched ones the old way, every born idea.
	for (const chat of chats) {
		if (chat.exam?.id !== exam.id || chat.exam.kind !== "teach" || chat.exam.prerequisiteId || (chat.exam.pointId && researched.has(chat.exam.pointId))) continue;
		for (const id of nodesBornIn.get(chat.id) ?? []) out.add(id);
	}
	return [...out];
}

/** An exam counts (plans, review dues) while active and not yet past. */
export const isLiveExam = (exam: Pick<ExamRecord, "status" | "examDate">, today: string): boolean =>
	exam.status === "active" && exam.examDate >= today;

// ─── the reached mode ───────────────────────────────────────────────────────

export interface IdeaLevel {
	level: ModeLevel;
	/** Any event moved (or confirmed) the level. */
	tested: boolean;
	/** The placement test reached this idea. */
	placed: boolean;
	toTeach: boolean;
}

/** Replay an idea's events (owner adaptation rules, module doc). */
export function ideaLevel(events: readonly ReviewEvent[], placementChats: ReadonlySet<string>): IdeaLevel {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	let level: ModeLevel = 0;
	let tested = false;
	let placed = false;
	let toTeach = false;
	let lastMiss = false;
	for (const e of sorted) {
		const isTeach = e.kind === "teach-check" || e.kind === "teach-seen";
		if (isTeach && toTeach) {
			toTeach = false;
			lastMiss = false;
		}
		if (!e.step || !e.mode) continue;
		tested = true;
		const inPlacement = placementChats.has(e.chatId);
		if (inPlacement) placed = true;
		if (e.step === "up") {
			level = Math.max(level, MODE_LEVEL[e.mode]) as ModeLevel;
			lastMiss = false;
			toTeach = false;
		} else if (e.step === "stay") {
			lastMiss = false;
		} else {
			if (inPlacement && level === 0) {
				toTeach = true;
			} else if (lastMiss && level <= 1) {
				toTeach = true;
				level = 0;
			} else {
				level = Math.max(0, level - 1) as ModeLevel;
			}
			lastMiss = true;
		}
	}
	return { level, tested, placed, toTeach };
}

// ─── the exam's chats ───────────────────────────────────────────────────────

export interface ExamChat {
	id: string;
	kind?: "teach" | "practice";
	createdAt: string;
	messages: readonly NpMessage[];
	exam?: ChatExamLink;
	review?: { day: string };
}

export type PointProbe = "known" | "unknown";

const roleOf = (m: NpMessage): string => (m as { role?: string }).role ?? "";

/** «Falta» points probed in this exam's placement sessions (owner): the
 *  LAST clean conclude of a problem posed with `syllabusPoint` decides —
 *  up → known (a short «afianzado» session), stay/miss → unknown (full
 *  teaching). */
export function pointProbes(chats: readonly ExamChat[], examId: string, confidenceThreshold: number): Map<string, PointProbe> {
	const out = new Map<string, { probe: PointProbe; at: number }>();
	for (const chat of chats) {
		if (chat.exam?.id !== examId || chat.exam.kind !== "placement") continue;
		const clean = new Set<string>();
		const time = new Map<string, number>();
		for (const m of chat.messages) {
			if (roleOf(m) === "toolResult") {
				const r = m as unknown as { toolCallId: string; isError?: boolean; timestamp: number };
				if (!r.isError) clean.add(r.toolCallId);
				time.set(r.toolCallId, r.timestamp);
			}
		}
		for (const m of chat.messages) {
			if (roleOf(m) !== "assistant") continue;
			for (const block of (m as unknown as { content: Array<{ type: string; id: string; name: string; arguments?: Record<string, unknown> }> }).content) {
				if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(block.id)) continue;
				const posed = problemCallForConclude(chat.messages, block.id);
				const point = posed?.input?.syllabusPoint;
				if (typeof point !== "string" || !posed) continue;
				const step = stepFromConclude(block.arguments?.outcome, block.arguments?.rung, problemConfidence(chat.messages, posed.id), confidenceThreshold);
				if (!step) continue;
				const at = time.get(block.id) ?? 0;
				const prev = out.get(point);
				if (!prev || at >= prev.at) out.set(point, { probe: step === "up" ? "known" : "unknown", at });
			}
		}
	}
	return new Map([...out].map(([k, v]) => [k, v.probe]));
}

// ─── «conocimientos previos»: found, proposed, merged (owner 2026-11-09) ────

/** A prerequisite the finder returned, before it enters an exam. */
export interface FoundPrerequisiteInput {
	/** An EXISTING id: this exam's prerequisite or another exam's. */
	reuse?: string;
	statement: string;
	/** Points (or prerequisites, for a diagnosis) resting on it. */
	points: string[];
	nodeIds: string[];
}

/**
 * Merge found prerequisites into an exam's (pure). Reusing this exam's
 * adds the points to what rests on it; reusing another exam's brings it
 * in with the same key (shared through the graph); a new one gets a
 * fresh id, its key = its id.
 */
export function mergePrerequisites(
	current: readonly ExamPrerequisite[],
	found: readonly FoundPrerequisiteInput[],
	others: ReadonlyMap<string, ExamPrerequisite>,
	opts: { origin: PrerequisiteOrigin; depth?: number; newId: () => string },
): ExamPrerequisite[] {
	const out = current.map((p) => ({ ...p, blocks: [...p.blocks], nodeIds: [...p.nodeIds] }));
	const union = (a: string[], b: readonly string[]) => [...new Set([...a, ...b])];
	for (const f of found) {
		const own = f.reuse ? out.find((p) => p.id === f.reuse) : undefined;
		const other = f.reuse && !own ? others.get(f.reuse) : undefined;
		const sameKey = other ? out.find((p) => p.key === other.key) : undefined;
		const target = own ?? sameKey;
		if (target) {
			target.blocks = union(target.blocks, f.points).filter((b) => b !== target.id);
			target.nodeIds = union(target.nodeIds, f.nodeIds);
			continue;
		}
		const id = opts.newId();
		out.push({
			id,
			statement: other?.statement ?? f.statement,
			source: other?.source ?? { kind: "model", title: "" },
			nodeIds: union([...(other?.nodeIds ?? [])], f.nodeIds),
			blocks: f.points.filter((b) => b !== id),
			origin: opts.origin,
			depth: clamp(opts.depth ?? 1, 1, MAX_PREREQUISITE_DEPTH),
			key: other?.key ?? id,
		});
	}
	return out;
}

/**
 * Share prerequisites across exams through the graph (owner 2026-11-09:
 * taught once, reviewed once): each prerequisite also carries the ideas of
 * every same-key prerequisite in the other exams, and the ideas born in
 * their teach sessions. Pure; returns the exams with widened nodeIds.
 */
export function sharePrerequisiteIdeas<E extends Pick<ExamRecord, "id" | "prerequisites">>(
	exams: readonly E[],
	chats: ReadonlyArray<Pick<ExamChat, "id" | "exam">>,
	nodesBornIn: ReadonlyMap<string, readonly string[]>,
): E[] {
	const byKey = new Map<string, Set<string>>();
	const keyOf = new Map<string, string>();
	for (const e of exams) for (const p of e.prerequisites ?? []) {
		keyOf.set(`${e.id}\u0000${p.id}`, p.key);
		const set = byKey.get(p.key) ?? new Set<string>();
		for (const n of p.nodeIds) set.add(n);
		byKey.set(p.key, set);
	}
	for (const c of chats) {
		if (c.exam?.kind !== "teach" || !c.exam.prerequisiteId) continue;
		const key = keyOf.get(`${c.exam.id}\u0000${c.exam.prerequisiteId}`);
		if (!key) continue;
		for (const n of nodesBornIn.get(c.id) ?? []) byKey.get(key)!.add(n);
	}
	return exams.map((e) =>
		e.prerequisites?.length ? { ...e, prerequisites: e.prerequisites.map((p) => ({ ...p, nodeIds: [...new Set([...p.nodeIds, ...(byKey.get(p.key) ?? [])])] })) } : e,
	);
}

/** One wrong or «no lo sé» answer of a placement test (the retroactive
 *  «Detectar conocimientos previos» reads them). */
export interface PlacementMiss {
	id: string;
	/** What it was about: targets' ids or the syllabusPoint id. */
	target: string[];
	syllabusPoint?: string;
	problem: string;
	answer: string;
	verdict: string;
}

/** The placement test's misses (step stay/miss, or a surrender), oldest
 *  first, at most `limit`. */
export function placementMisses(chats: readonly ExamChat[], examId: string, confidenceThreshold: number, limit = 40): PlacementMiss[] {
	const out: PlacementMiss[] = [];
	for (const chat of chats) {
		if (chat.exam?.id !== examId || chat.exam.kind !== "placement") continue;
		const clean = new Set<string>();
		for (const m of chat.messages) if (roleOf(m) === "toolResult" && !(m as unknown as { isError?: boolean }).isError) clean.add((m as unknown as { toolCallId: string }).toolCallId);
		for (const m of chat.messages) {
			if (roleOf(m) !== "assistant") continue;
			for (const block of (m as unknown as { content: Array<{ type: string; id: string; name: string; arguments?: Record<string, unknown> }> }).content) {
				if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(block.id)) continue;
				const posed = problemCallForConclude(chat.messages, block.id);
				if (!posed) continue;
				const step = stepFromConclude(block.arguments?.outcome, block.arguments?.rung, problemConfidence(chat.messages, posed.id), confidenceThreshold);
				if (step === "up") continue;
				const input = posed.input as { statement?: unknown; target?: unknown; syllabusPoint?: unknown } | undefined;
				let answer = "";
				for (const t of chat.messages) {
					if (roleOf(t) !== "custom" || (t as { customType?: string }).customType !== "practice-thinking") continue;
					const d = (t as { details?: { problemCallId?: unknown; text?: unknown } }).details;
					if (d?.problemCallId === posed.id && typeof d.text === "string") answer = d.text;
				}
				out.push({
					id: `m${out.length + 1}`,
					target: Array.isArray(input?.target) ? input.target.filter((x): x is string => typeof x === "string") : [],
					...(typeof input?.syllabusPoint === "string" ? { syllabusPoint: input.syllabusPoint } : {}),
					problem: typeof input?.statement === "string" ? input.statement.slice(0, 1500) : "",
					answer: answer.slice(0, 1500),
					verdict: typeof block.arguments?.verdict === "string" ? block.arguments.verdict.slice(0, 600) : "",
				});
			}
		}
	}
	return out.slice(0, limit);
}

// ─── status ─────────────────────────────────────────────────────────────────

export interface IdeaStatus extends IdeaLevel {
	nodeId: string;
	name: string;
	pointIds: string[];
	/** The «conocimientos previos» it expresses (owner 2026-11-09). */
	prerequisiteIds: string[];
	/** The mode level it climbs to: the standard's, or Componer for a
	 *  prerequisite's idea. */
	goal: ModeLevel;
	/** Recall on the exam day with no further study (null = never graded). */
	recallAtExam: number | null;
	/** Meets its own bar (`goal` + the exam's recall). */
	meets: boolean;
	/** Every point it belongs to is blocked by a prerequisite (owner
	 *  2026-11-09): no mode practice meanwhile — dated review goes on. */
	blocked: boolean;
	/** Due in Repaso before today's end. */
	dueToday: boolean;
}

/** What a point needs next, in plan order. */
export type PointNeed = "placement" | "teach" | "consolidate" | "practice" | "done";

/** One target idea's standing (owner 2026-11-06). */
export interface TargetStatus {
	id: string;
	statement: string;
	nodeIds: string[];
	probe: PointProbe | null;
	/** All its linked ideas meet the standard. */
	mastered: boolean;
	/** mastered / linked (has ideas, not all meeting) / placement (not in
	 *  the graph, not probed yet) / consolidate (probed known) / teach. */
	state: "mastered" | "linked" | "placement" | "consolidate" | "teach";
}

export interface PointStatus {
	id: string;
	blockId: string;
	text: string;
	/** Mapped ideas ∪ ideas born in this point's exam teach sessions. */
	nodeIds: string[];
	/** «Falta» in the mapping (no linked ideas). */
	gap: boolean;
	probe: PointProbe | null;
	/** An exam teach session for this point exists. */
	taughtSession: boolean;
	/** Share of its ideas (researched: of its targets) meeting the
	 *  standard (0 with none). */
	score: number;
	need: PointNeed;
	/** Researched points: their targets' standing; null otherwise. */
	targets: TargetStatus[] | null;
	/** «Ampliación» ideas (not counted). */
	extension: string[];
	/** Prerequisites resting under it that are not unlocked yet — the
	 *  plan does not teach it meanwhile (owner 2026-11-09). */
	blockedBy: string[];
	/** A class (or own study) confirmed it was taught («Calendario», owner
	 *  2026-11-10): a short afianzado instead of a full teach. */
	classCovered?: boolean;
}

/** One «conocimiento previo»'s standing (owner 2026-11-09). */
export interface PrerequisiteStatus {
	id: string;
	key: string;
	statement: string;
	depth: number;
	origin: PrerequisiteOrigin;
	/** What rests on it directly (points and prerequisites). */
	blocks: string[];
	/** Syllabus points resting on it, directly or through shallower
	 *  prerequisites. */
	pointIds: string[];
	/** Its ideas in the graph (linked ∪ born in its teach sessions). */
	nodeIds: string[];
	probe: PointProbe | null;
	taughtSession: boolean;
	/** Taught (or shown known) and solved at least at Recordar: what
	 *  rests on it may be taught. */
	unlocked: boolean;
	/** Every idea at Componer with the exam's recall. */
	mastered: boolean;
	/** placement = not evaluated yet; consolidate = shown known, or its
	 *  ideas failed (short session); teach = unknown; taught = taught,
	 *  its ideas not extracted yet; linked = climbing; mastered. */
	state: "mastered" | "linked" | "placement" | "consolidate" | "teach" | "taught";
	/** Deeper prerequisites under it not unlocked yet. */
	blockedBy: string[];
}

export interface ExamStatusModel {
	examId: string;
	today: string;
	daysLeft: number;
	coverage: number;
	meetsStandard: boolean;
	/** The highest preset the CURRENT state meets (null = none). */
	reachedPreset: ExamPreset | null;
	points: PointStatus[];
	ideas: IdeaStatus[];
	/** «Conocimientos previos», deepest first. */
	prerequisites: PrerequisiteStatus[];
	/** pendingPoints also holds unlinked targets and prerequisites (all
	 *  probed by id through `syllabusPoint`) — prerequisites first. */
	placement: { pendingIdeas: string[]; pendingPoints: string[]; done: boolean };
}

export interface ExamStatusInput {
	exam: Pick<ExamRecord, "id" | "examDate" | "standard" | "blocks" | "prerequisites">;
	now: number;
	/** The review model's items (events included), by node id. */
	items: ReadonlyMap<string, ReviewItem>;
	/** Graph names for ideas the review model doesn't list. */
	names: ReadonlyMap<string, string>;
	chats: readonly ExamChat[];
	/** chatId → node ids with provenance in it (for exam teach sessions). */
	nodesBornIn: ReadonlyMap<string, readonly string[]>;
	confidenceThreshold: number;
	dueEnd: number;
	/** Points a class confirmed as taught («Calendario», owner 2026-11-10). */
	classCovered?: ReadonlySet<string>;
}

const meetsLevel = (idea: Pick<IdeaStatus, "toTeach" | "level" | "recallAtExam">, level: ModeLevel, recall: number) =>
	!idea.toTeach && idea.level >= level && idea.recallAtExam !== null && idea.recallAtExam >= recall;

const meetsWith = (idea: Pick<IdeaStatus, "toTeach" | "level" | "recallAtExam">, standard: Pick<ExamStandard, "mode" | "recall">) =>
	meetsLevel(idea, MODE_LEVEL[standard.mode], standard.recall);

/** The units a point's score counts: its targets' linked ideas (a target
 *  counts only when ALL of them meet — owner 2026-11-06; an unlinked
 *  target never), else each of its ideas alone. */
const unitsOf = (p: { nodeIds: readonly string[]; targets?: ReadonlyArray<{ nodeIds: readonly string[] }> | null }): Array<readonly string[]> =>
	p.targets ? p.targets.map((t) => t.nodeIds) : p.nodeIds.map((n) => [n]);

/** Per-point coverage (owner): mean of the points' meeting shares. */
export function coverageWith(
	points: ReadonlyArray<{ nodeIds: readonly string[]; targets?: ReadonlyArray<{ nodeIds: readonly string[] }> | null }>,
	ideas: ReadonlyMap<string, Pick<IdeaStatus, "toTeach" | "level" | "recallAtExam">>,
	standard: Pick<ExamStandard, "mode" | "recall">,
): number {
	if (points.length === 0) return 0;
	let sum = 0;
	for (const p of points) {
		const units = unitsOf(p);
		if (units.length === 0) continue;
		let met = 0;
		for (const unit of units) {
			if (unit.length > 0 && unit.every((id) => { const idea = ideas.get(id); return !!idea && meetsWith(idea, standard); })) met++;
		}
		sum += met / units.length;
	}
	return sum / points.length;
}

export function computeExamStatus(input: ExamStatusInput): ExamStatusModel {
	const { exam, now } = input;
	const today = reviewDay(now);
	const moment = examMoment(exam.examDate);
	const examChats = input.chats.filter((c) => c.exam?.id === exam.id);
	const placementChats = new Set(examChats.filter((c) => c.exam!.kind === "placement").map((c) => c.id));
	const probes = pointProbes(input.chats, exam.id, input.confidenceThreshold);

	const pointNodes = new Map<string, string[]>();
	const taughtSession = new Set<string>();
	// Ideas born in this exam's own teach sessions start from those checks —
	// the placement test is for what the learner brought in.
	const examTaught = new Set<string>();
	const recordPoints = new Map(studyPoints(exam).map((p) => [p.id, p]));
	for (const p of recordPoints.values()) pointNodes.set(p.id, [...p.nodeIds]);
	for (const chat of examChats) {
		if (chat.exam!.kind !== "teach" || !chat.exam!.pointId || !pointNodes.has(chat.exam!.pointId)) continue;
		taughtSession.add(chat.exam!.pointId);
		const researched = !!recordPoints.get(chat.exam!.pointId)!.targets;
		const list = pointNodes.get(chat.exam!.pointId)!;
		for (const id of input.nodesBornIn.get(chat.id) ?? []) {
			examTaught.add(id);
			if (!researched && !list.includes(id)) list.push(id);
		}
	}

	// «Conocimientos previos» (owner 2026-11-09): linked ideas ∪ ideas born
	// in their own teach sessions here.
	const prereqs = exam.prerequisites ?? [];
	const prereqNodes = new Map(prereqs.map((p) => [p.id, [...p.nodeIds]]));
	const prereqTaught = new Set<string>();
	for (const chat of examChats) {
		const pid = chat.exam!.prerequisiteId;
		if (chat.exam!.kind !== "teach" || !pid || !prereqNodes.has(pid)) continue;
		prereqTaught.add(pid);
		const list = prereqNodes.get(pid)!;
		for (const id of input.nodesBornIn.get(chat.id) ?? []) {
			examTaught.add(id);
			if (!list.includes(id)) list.push(id);
		}
	}

	const pointsOf = new Map<string, string[]>();
	for (const [pid, ids] of pointNodes) for (const id of ids) pointsOf.set(id, [...(pointsOf.get(id) ?? []), pid]);
	for (const p of recordPoints.values()) for (const id of p.extension ?? []) if (!(pointsOf.get(id) ?? []).includes(p.id)) pointsOf.set(id, [...(pointsOf.get(id) ?? []), p.id]);
	const prereqsOf = new Map<string, string[]>();
	for (const [pid, ids] of prereqNodes) for (const id of ids) prereqsOf.set(id, [...(prereqsOf.get(id) ?? []), pid]);

	const standardLevel = MODE_LEVEL[exam.standard.mode];
	const ideas: IdeaStatus[] = [];
	const ideaById = new Map<string, IdeaStatus>();
	for (const nodeId of new Set([...prereqsOf.keys(), ...pointsOf.keys()])) {
		const item = input.items.get(nodeId);
		const level = ideaLevel(item?.events ?? [], placementChats);
		const recallAtExam = item && item.stability !== null && item.lastReview !== null ? recallAt(item.stability, item.lastReview, moment) : null;
		const prerequisiteIds = prereqsOf.get(nodeId) ?? [];
		const goal: ModeLevel = prerequisiteIds.length > 0 ? PREREQUISITE_LEVEL : standardLevel;
		const status: IdeaStatus = {
			nodeId,
			name: item?.name ?? input.names.get(nodeId) ?? nodeId,
			pointIds: pointsOf.get(nodeId) ?? [],
			prerequisiteIds,
			goal,
			...level,
			recallAtExam,
			meets: false,
			blocked: false,
			dueToday: !!item && !item.paused && item.released && item.due !== null && item.due < input.dueEnd,
		};
		status.meets = meetsLevel(status, goal, exam.standard.recall);
		ideas.push(status);
		ideaById.set(nodeId, status);
	}
	const meetsStandard = (i: IdeaStatus) => meetsWith(i, exam.standard);

	const ideaNeed = (members: IdeaStatus[]): PointNeed => {
		if (members.some((i) => !i.placed && !examTaught.has(i.nodeId))) return "placement";
		if (members.some((i) => i.toTeach)) return "consolidate";
		if (members.some((i) => i.level < i.goal)) return "practice";
		return "done";
	};

	const prerequisites = prerequisiteStatuses({
		prereqs,
		prereqNodes,
		prereqTaught,
		ideaById,
		probes,
		examTaught,
		recall: exam.standard.recall,
		pointIds: new Set(recordPoints.keys()),
	});
	const lockedUnder = (id: string) => prerequisites.filter((q) => !q.unlocked && q.blocks.includes(id)).map((q) => q.id);
	const points: PointStatus[] = studyPoints(exam).map((p) => {
		const nodeIds = pointNodes.get(p.id) ?? [];
		const probe = probes.get(p.id) ?? null;
		const members = nodeIds.map((id) => ideaById.get(id)!).filter(Boolean);
		const extension = (p.extension ?? []).filter((id) => ideaById.has(id));
		const covered = !!input.classCovered?.has(p.id) && !taughtSession.has(p.id);
		const base = {
			id: p.id,
			blockId: p.blockId,
			text: p.text,
			nodeIds,
			probe,
			taughtSession: taughtSession.has(p.id),
			extension,
			blockedBy: lockedUnder(p.id),
			...(covered ? { classCovered: true } : {}),
		};
		if (p.targets) {
			// Researched (owner 2026-11-06): targets decide. An unlinked
			// target is probed first; known → a short consolidation, else
			// taught. A taught point's targets wait for the sort to link them.
			const targets: TargetStatus[] = p.targets.map((tg) => {
				const linked = tg.nodeIds.map((id) => ideaById.get(id)).filter((i): i is IdeaStatus => !!i);
				const tProbe = probes.get(tg.id) ?? null;
				const mastered = linked.length > 0 && linked.every(meetsStandard);
				// Taught in class (owner 2026-11-10): an unlinked target is
				// consolidated, never probed nor taught again.
				const state: TargetStatus["state"] = mastered
					? "mastered"
					: linked.length > 0
						? "linked"
						: covered
							? "consolidate"
							: tProbe === null && !taughtSession.has(p.id)
								? "placement"
								: tProbe === "known"
									? "consolidate"
									: "teach";
				return { id: tg.id, statement: tg.statement, nodeIds: linked.map((i) => i.nodeId), probe: tProbe, mastered, state };
			});
			const score = targets.length ? targets.filter((x) => x.mastered).length / targets.length : 0;
			const states = new Set(targets.map((x) => x.state));
			const need: PointNeed = states.has("placement") ? "placement" : states.has("teach") ? "teach" : states.has("consolidate") ? "consolidate" : ideaNeed(members);
			return { ...base, gap: targets.some((x) => x.nodeIds.length === 0), score, need, targets };
		}
		const gap = p.nodeIds.length === 0;
		const score = members.length ? members.filter(meetsStandard).length / members.length : 0;
		const need: PointNeed =
			gap && !taughtSession.has(p.id) ? (covered ? "consolidate" : probe === null ? "placement" : probe === "known" ? "consolidate" : "teach") : ideaNeed(members);
		return { ...base, gap, score, need, targets: null };
	});

	const blockedPoints = new Set(points.filter((p) => p.blockedBy.length > 0).map((p) => p.id));
	for (const i of ideas) i.blocked = i.prerequisiteIds.length === 0 && i.pointIds.length > 0 && i.pointIds.every((pid) => blockedPoints.has(pid));

	const coverage = coverageWith(points, ideaById, exam.standard);
	let reachedPreset: ExamPreset | null = null;
	for (const preset of PRESET_ORDER) {
		const s = EXAM_PRESETS[preset];
		if (coverageWith(points, ideaById, s) >= s.coverage) reachedPreset = preset;
	}
	// Placement is exhaustive (owner): every syllabus idea the placement
	// test hasn't reached, and every «falta» point not yet probed.
	// Extension ideas are not placed (they were formed in exam sessions).
	// Prerequisites first (owner 2026-11-09: every one is evaluated at the
	// start of the test).
	const counted = new Set(points.flatMap((p) => p.nodeIds));
	const unplaced = (i: IdeaStatus) => !i.placed && !examTaught.has(i.nodeId);
	const pendingIdeas = [
		// A prerequisite's idea tested anywhere (another exam's test, practice,
		// teaching) is already known to the memory — shared through the graph.
		...ideas.filter((i) => i.prerequisiteIds.length > 0 && unplaced(i) && !i.tested),
		...ideas.filter((i) => i.prerequisiteIds.length === 0 && counted.has(i.nodeId) && unplaced(i)),
	].map((i) => i.nodeId);
	// Unlinked prerequisites, «falta» points (unresearched) and unlinked
	// targets not probed yet — all probed by id through `syllabusPoint`.
	const pendingPoints = [
		...prerequisites.filter((q) => q.state === "placement" && q.nodeIds.length === 0).map((q) => q.id),
		...points.flatMap((p) =>
			p.targets ? p.targets.filter((x) => x.state === "placement").map((x) => x.id) : p.gap && !p.taughtSession && !p.classCovered && p.probe === null ? [p.id] : [],
		),
	];
	return {
		examId: exam.id,
		today,
		daysLeft: daysBetween(today, exam.examDate),
		coverage,
		meetsStandard: coverage >= exam.standard.coverage,
		reachedPreset,
		points,
		ideas,
		prerequisites,
		placement: { pendingIdeas, pendingPoints, done: pendingIdeas.length === 0 && pendingPoints.length === 0 },
	};
}

/** Each prerequisite's standing, deepest first (owner 2026-11-09). */
function prerequisiteStatuses(input: {
	prereqs: readonly ExamPrerequisite[];
	prereqNodes: ReadonlyMap<string, readonly string[]>;
	prereqTaught: ReadonlySet<string>;
	ideaById: ReadonlyMap<string, IdeaStatus>;
	probes: ReadonlyMap<string, PointProbe>;
	examTaught: ReadonlySet<string>;
	recall: number;
	pointIds: ReadonlySet<string>;
}): PrerequisiteStatus[] {
	const byId = new Map(input.prereqs.map((p) => [p.id, p]));
	// Points resting on it, through shallower prerequisites too.
	const pointsUnder = (id: string, seen = new Set<string>()): string[] => {
		if (seen.has(id)) return [];
		seen.add(id);
		const out = new Set<string>();
		for (const b of byId.get(id)?.blocks ?? []) {
			if (input.pointIds.has(b)) out.add(b);
			else if (byId.has(b)) for (const x of pointsUnder(b, seen)) out.add(x);
		}
		return [...out];
	};
	const base = input.prereqs.map((p) => {
		const linked = (input.prereqNodes.get(p.id) ?? []).map((id) => input.ideaById.get(id)).filter((i): i is IdeaStatus => !!i);
		const probe = input.probes.get(p.id) ?? null;
		const taughtSession = input.prereqTaught.has(p.id);
		const mastered = linked.length > 0 && linked.every((i) => meetsLevel(i, PREREQUISITE_LEVEL, input.recall));
		let state: PrerequisiteStatus["state"];
		if (linked.length > 0) {
			state = mastered
				? "mastered"
				: linked.some((i) => !i.placed && !i.tested && !input.examTaught.has(i.nodeId))
					? "placement"
					: linked.some((i) => i.toTeach)
						? "consolidate"
						: "linked";
		} else state = taughtSession ? "taught" : probe === null ? "placement" : probe === "known" ? "consolidate" : "teach";
		// Owner: a dependent unlocks once the base is taught (or shown
		// known) and solved at least at Recordar.
		const unlocked = linked.length > 0 ? linked.every((i) => !i.toTeach && i.level >= 1) : probe === "known";
		return {
			id: p.id,
			key: p.key,
			statement: p.statement,
			depth: p.depth,
			origin: p.origin,
			blocks: p.blocks.filter((b) => input.pointIds.has(b) || byId.has(b)),
			pointIds: pointsUnder(p.id),
			nodeIds: linked.map((i) => i.nodeId),
			probe,
			taughtSession,
			unlocked,
			mastered,
			state,
			blockedBy: [] as string[],
		};
	});
	for (const q of base) q.blockedBy = base.filter((d) => !d.unlocked && d.blocks.includes(q.id)).map((d) => d.id);
	return base.sort((a, b) => b.depth - a.depth || b.pointIds.length - a.pointIds.length || (a.id < b.id ? -1 : 1));
}

// ─── durations (owner: defaults, then the learner's measured averages) ──────

export interface Durations {
	teach: number;
	consolidate: number;
	problem: number;
	review: number;
}

/** A gap between two messages longer than this is a pause, not work. */
export const ACTIVE_GAP_CAP_MS = 5 * 60_000;
/** Measured averages replace a default from this many samples on. */
export const MIN_DURATION_SAMPLES = 3;
const MAX_SAMPLES = 30;

const stampOf = (m: NpMessage): number | null => {
	const t = (m as { timestamp?: unknown }).timestamp;
	return typeof t === "number" && Number.isFinite(t) ? t : null;
};

/** Active minutes over a message run: gaps summed, each capped. */
export function activeMinutes(messages: readonly NpMessage[]): number {
	let total = 0;
	let prev: number | null = null;
	for (const m of messages) {
		const t = stampOf(m);
		if (t === null) continue;
		if (prev !== null && t > prev) total += Math.min(t - prev, ACTIVE_GAP_CAP_MS);
		prev = t;
	}
	return total / 60_000;
}

const mean = (xs: number[]): number | null => (xs.length >= MIN_DURATION_SAMPLES ? xs.slice(-MAX_SAMPLES).reduce((s, x) => s + x, 0) / Math.min(xs.length, MAX_SAMPLES) : null);

/** The learner's measured averages (null where too few samples). */
export function measureDurations(chats: readonly ExamChat[]): { [K in keyof Durations]: number | null } {
	const sorted = [...chats].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	const teach: number[] = [];
	const consolidate: number[] = [];
	const problem: number[] = [];
	const review: number[] = [];
	for (const chat of sorted) {
		if (chat.exam?.kind === "teach") {
			const minutes = activeMinutes(chat.messages);
			if (minutes > 0) (chat.exam.short ? consolidate : teach).push(minutes);
			continue;
		}
		if (chat.kind !== "practice") continue;
		// Problem spans: from the pose's message to its conclude's message.
		let poseIndex: number | null = null;
		let concluded = 0;
		chat.messages.forEach((m, i) => {
			if (roleOf(m) !== "assistant") return;
			for (const block of (m as unknown as { content: Array<{ type: string; name?: string }> }).content) {
				if (block.type !== "toolCall") continue;
				if (block.name === "problem") poseIndex = i;
				else if (block.name === PRACTICE_CONCLUDE_TOOL && poseIndex !== null) {
					const minutes = activeMinutes(chat.messages.slice(poseIndex, i + 1));
					if (minutes > 0 && !chat.review) problem.push(minutes);
					concluded++;
					poseIndex = null;
				}
			}
		});
		if (chat.review && concluded > 0) {
			const minutes = activeMinutes(chat.messages);
			if (minutes > 0) review.push(minutes / concluded);
		}
	}
	return { teach: mean(teach), consolidate: mean(consolidate), problem: mean(problem), review: mean(review) };
}

export function effectiveDurations(defaults: Durations, measured: { [K in keyof Durations]: number | null }): Durations {
	return {
		teach: measured.teach ?? defaults.teach,
		consolidate: measured.consolidate ?? defaults.consolidate,
		problem: measured.problem ?? defaults.problem,
		review: measured.review ?? defaults.review,
	};
}

// ─── work estimates ─────────────────────────────────────────────────────────

/** Ideas a «falta» point is expected to yield once taught. */
export const DEFAULT_IDEAS_PER_POINT = 4;
/** Stability assumed for an idea graded for the first time. */
const FIRST_STABILITY = 3;
/** Rough FSRS stability growth per Good review (estimate only). */
const STABILITY_GROWTH = 2.5;

/** Reviews an idea needs from `now` to the exam (planned, Good grades,
 *  plus the final-window review) — an ESTIMATE for budgeting. */
export function reviewsUntilExam(input: { stability: number | null; lastReview: number | null; now: number; examDate: string; recall: number; finalWindowDays: number }): number {
	const moment = examMoment(input.examDate);
	if (input.now >= moment) return 0;
	let s = input.stability ?? FIRST_STABILITY;
	let t = input.lastReview ?? input.now;
	const windowStart = dayStart(addDays(input.examDate, -input.finalWindowDays));
	let count = 0;
	let inWindow = t >= windowStart;
	for (let guard = 0; guard < 60; guard++) {
		const next = Math.max(input.now, t + Math.max(1, intervalDays(s, input.recall)) * DAY_MS);
		if (next >= windowStart) break;
		count++;
		t = next;
		s *= STABILITY_GROWTH;
	}
	if (!inWindow) {
		count++;
		inWindow = true;
	}
	return count;
}

export interface WorkBreakdown {
	placement: number;
	teach: number;
	practice: number;
	review: number;
	total: number;
}

const ZERO_WORK: WorkBreakdown = { placement: 0, teach: 0, practice: 0, review: 0, total: 0 };

/**
 * Minutes still needed to reach `standard` (owner: only the COVERAGE share
 * has to meet). Placement is exhaustive and always counted. Points are
 * chosen to reach the coverage: already meeting first (free), then the
 * prioritized blocks, then the cheapest.
 */
export function examWork(input: {
	status: Pick<ExamStatusModel, "points" | "ideas" | "placement"> & { prerequisites?: readonly PrerequisiteStatus[] };
	standard: Pick<ExamStandard, "mode" | "recall" | "coverage">;
	examDate: string;
	now: number;
	durations: Durations;
	finalWindowDays: number;
	priorityBlocks: readonly string[];
	items: ReadonlyMap<string, Pick<ReviewItem, "stability" | "lastReview">>;
}): WorkBreakdown {
	const { status, standard, durations } = input;
	if (examMoment(input.examDate) <= input.now) return { ...ZERO_WORK };
	const target = MODE_LEVEL[standard.mode];
	const ideaById = new Map(status.ideas.map((i) => [i.nodeId, i]));
	const mapped = status.points.filter((p) => p.nodeIds.length > 0);
	const ideasPerPoint = mapped.length ? Math.max(1, Math.round(mapped.reduce((s, p) => s + p.nodeIds.length, 0) / mapped.length)) : DEFAULT_IDEAS_PER_POINT;

	// Placement (exhaustive): climbs to the standard's mode for untested
	// ideas; one problem per unprobed «falta» point.
	// Prerequisites' ideas climb to Componer (owner 2026-11-09).
	const placement =
		(status.placement.pendingIdeas.reduce((sum, id) => sum + (ideaById.get(id)?.goal ?? target), 0) + status.placement.pendingPoints.length) * durations.problem;

	const reviewsFor = (nodeId: string | null) => {
		const item = nodeId ? input.items.get(nodeId) : undefined;
		return reviewsUntilExam({
			stability: item?.stability ?? null,
			lastReview: item?.lastReview ?? null,
			now: input.now,
			examDate: input.examDate,
			recall: standard.recall,
			finalWindowDays: input.finalWindowDays,
		});
	};

	interface Cost { id: string; teach: number; practice: number; review: number; met: boolean; priority: boolean }
	const priority = new Set(input.priorityBlocks);
	const costs: Cost[] = status.points.map((p) => {
		let teach = 0;
		let practice = 0;
		let review = 0;
		let met = false;
		if (p.targets) {
			// Researched: unlinked targets are taught (one session; a short
			// one when all of them are known), then climbed and reviewed;
			// linked ideas as below. Met = every target mastered.
			const open = p.targets.filter((x) => x.nodeIds.length === 0);
			if (open.some((x) => x.state === "teach" || x.state === "placement")) teach = durations.teach;
			else if (open.length > 0) teach = durations.consolidate;
			practice += open.length * target * durations.problem;
			review += open.length * reviewsFor(null) * durations.review;
			const members = p.nodeIds.map((id) => ideaById.get(id)).filter((i): i is IdeaStatus => !!i);
			if (members.some((i) => i.toTeach)) teach += durations.consolidate;
			for (const i of members) {
				const from = i.toTeach ? 0 : i.placed || i.tested ? i.level : target;
				practice += Math.max(0, target - from) * durations.problem;
				review += reviewsFor(i.nodeId) * durations.review;
			}
			met = p.targets.length > 0 && p.targets.every((x) => x.mastered);
		} else if (p.gap && !p.taughtSession) {
			teach = p.probe === "known" || p.classCovered ? durations.consolidate : durations.teach;
			practice = ideasPerPoint * target * durations.problem;
			review = ideasPerPoint * reviewsFor(null) * durations.review;
		} else {
			const members = p.nodeIds.map((id) => ideaById.get(id)).filter((i): i is IdeaStatus => !!i);
			met = members.length > 0 && members.every((i) => !i.toTeach && i.level >= target && i.recallAtExam !== null && i.recallAtExam >= standard.recall);
			if (members.some((i) => i.toTeach)) teach += durations.consolidate;
			for (const i of members) {
				const from = i.toTeach ? 0 : i.placed || i.tested ? i.level : target; // untested: placement climbs
				practice += Math.max(0, target - from) * durations.problem;
				review += reviewsFor(i.nodeId) * durations.review;
			}
		}
		return { id: p.id, teach, practice, review, met, priority: priority.has(p.blockId) };
	});

	const needed = Math.ceil(standard.coverage * status.points.length - 1e-9);
	const order = [...costs].sort(
		(a, b) =>
			Number(b.met) - Number(a.met) ||
			Number(b.priority) - Number(a.priority) ||
			a.teach + a.practice + a.review - (b.teach + b.practice + b.review),
	);
	let teach = 0;
	let practice = 0;
	let review = 0;
	const chosen = order.slice(0, needed);
	for (const c of chosen) {
		teach += c.teach;
		practice += c.practice;
		review += c.review;
	}
	// «Conocimientos previos» under the chosen points (owner 2026-11-09:
	// not counted in the coverage, but they take time first). A shared
	// one counts once — its cost is its own, not each point's.
	const chosenIds = new Set(chosen.map((c) => c.id));
	for (const q of status.prerequisites ?? []) {
		if (q.mastered || !q.pointIds.some((id) => chosenIds.has(id))) continue;
		const members = q.nodeIds.map((id) => ideaById.get(id)).filter((i): i is IdeaStatus => !!i);
		if (q.state === "teach") teach += durations.teach;
		else if (q.state === "consolidate") teach += durations.consolidate;
		if (members.length === 0) {
			practice += PREREQUISITE_LEVEL * durations.problem;
			review += reviewsFor(null) * durations.review;
		}
		for (const i of members) {
			const from = i.toTeach ? 0 : i.placed || i.tested ? i.level : PREREQUISITE_LEVEL;
			practice += Math.max(0, PREREQUISITE_LEVEL - from) * durations.problem;
			review += reviewsFor(i.nodeId) * durations.review;
		}
	}
	// Reviews of points already meeting still have to happen to KEEP them.
	return { placement, teach, practice, review, total: placement + teach + practice + review };
}

// ─── the plan (owner: one global budget, by urgency) ────────────────────────

export interface PlanExam {
	examId: string;
	examDate: string;
	/** Minutes still needed (examWork(...).total), spread included. */
	work: number;
	/** The part of `work` that happens over time (reviews): spread evenly
	 *  over the study days left instead of front-loaded. */
	spread?: number;
}

export interface PlanResult {
	/** Per exam: minutes allocated per day (index 0 = today). */
	allocations: Record<string, number[]>;
	/** Per exam: minutes the budget cannot cover before the date. */
	shortfall: Record<string, number>;
	/** Per exam: days with study budget left before the exam (incl. today). */
	studyDays: Record<string, number>;
	days: string[];
}

/**
 * Earliest-deadline-first over one daily budget (owner: the nearest exam
 * first; ties → the one furthest from its standard). Days run from today
 * to the day before the last exam. Pure.
 */
export function planBudget(input: {
	today: string;
	weeklyMinutes: readonly number[];
	exams: readonly PlanExam[];
	/** «Calendario» (owner 2026-11-10): a date's own budget — its override,
	 *  minus classes that consume time, pinned sessions and Repaso. Absent
	 *  → the weekday's minutes. */
	budgetFor?: (day: string) => number;
}): PlanResult {
	const exams = [...input.exams].filter((e) => daysBetween(input.today, e.examDate) > 0);
	const horizon = exams.reduce((h, e) => Math.max(h, daysBetween(input.today, e.examDate)), 0);
	const days = Array.from({ length: horizon }, (_, i) => addDays(input.today, i));
	const budgetOf = (day: string) => Math.max(0, input.budgetFor ? input.budgetFor(day) : (input.weeklyMinutes[weekdayIndex(day)] ?? 0));
	// Spread work (reviews) is owed a little every study day until the exam.
	const spreadLeft = new Map(exams.map((e) => [e.examId, Math.min(e.work, e.spread ?? 0)]));
	const fixedLeft = new Map(exams.map((e) => [e.examId, e.work - spreadLeft.get(e.examId)!]));
	const studyDaysAhead = (e: PlanExam, from: number) => days.slice(from).filter((d) => daysBetween(d, e.examDate) > 0 && budgetOf(d) > 0).length;
	const allocations: Record<string, number[]> = {};
	const studyDays: Record<string, number> = {};
	for (const e of input.exams) {
		allocations[e.examId] = new Array<number>(days.length).fill(0);
		studyDays[e.examId] = 0;
	}
	const urgency = (a: PlanExam, b: PlanExam) =>
		daysBetween(input.today, a.examDate) - daysBetween(input.today, b.examDate) || fixedLeft.get(b.examId)! - fixedLeft.get(a.examId)!;
	days.forEach((day, i) => {
		let budget = budgetOf(day);
		const open = exams.filter((e) => daysBetween(day, e.examDate) > 0).sort(urgency);
		for (const e of open) if (budget > 0) studyDays[e.examId]!++;
		const give = (e: PlanExam, minutes: number) => {
			allocations[e.examId]![i] = (allocations[e.examId]![i] ?? 0) + minutes;
			budget -= minutes;
		};
		// 1) today's share of the spread work, nearest exam first.
		for (const e of open) {
			if (budget <= 0) break;
			const left = spreadLeft.get(e.examId)!;
			if (left <= 0) continue;
			const share = Math.min(left, budget, left / Math.max(1, studyDaysAhead(e, i)));
			spreadLeft.set(e.examId, left - share);
			give(e, share);
		}
		// 2) the rest, earliest deadline first.
		for (const e of open) {
			if (budget <= 0) break;
			const left = fixedLeft.get(e.examId)!;
			if (left <= 0) continue;
			const minutes = Math.min(left, budget);
			fixedLeft.set(e.examId, left - minutes);
			give(e, minutes);
		}
	});
	const shortfall: Record<string, number> = {};
	for (const e of input.exams) shortfall[e.examId] = Math.max(0, (fixedLeft.get(e.examId) ?? e.work) + (spreadLeft.get(e.examId) ?? 0));
	return { allocations, shortfall, studyDays, days };
}

/** The «no llega» options (owner: warn and propose, never act). */
export interface Infeasibility {
	shortfall: number;
	/** Extra minutes per study day that would close the gap. */
	extraPerDay: number;
	/** The highest preset the allocated minutes reach (null = none). */
	bestPreset: ExamPreset | null;
}

export function infeasibility(input: { shortfall: number; daysLeft: number; allocated: number; presetWork: Record<ExamPreset, number> }): Infeasibility | null {
	if (input.shortfall <= 0) return null;
	let bestPreset: ExamPreset | null = null;
	for (const p of PRESET_ORDER) if (input.presetWork[p] <= input.allocated) bestPreset = p;
	return { shortfall: input.shortfall, extraPerDay: Math.ceil(input.shortfall / Math.max(1, input.daysLeft)), bestPreset };
}

// ─── today's blocks (owner: review → mode practice → teach, in order) ───────

export type ExamBlockKind = "review" | "placement" | "practice" | "teach";

export interface ExamBlock {
	kind: ExamBlockKind;
	minutes: number;
	/** Ideas (review/practice/placement) or the point to teach. */
	nodeIds: string[];
	pointId?: string;
	/** teach: a «conocimiento previo» instead of a point (owner 2026-11-09). */
	prerequisiteId?: string;
	/** teach: the short «afianzado» session. */
	short?: boolean;
}

/** The next prerequisite to teach (owner 2026-11-09: first priority —
 *  deepest first, then the one most points rest on), or undefined. */
export function nextPrerequisite(prerequisites: readonly PrerequisiteStatus[]): PrerequisiteStatus | undefined {
	return prerequisites.find((q) => (q.state === "teach" || q.state === "consolidate") && q.blockedBy.length === 0);
}

/** Split today's allocation into the ordered blocks. Pure. */
export function todayBlocks(input: {
	status: Pick<ExamStatusModel, "points" | "ideas" | "placement"> & { prerequisites?: readonly PrerequisiteStatus[] };
	standard: Pick<ExamStandard, "mode">;
	minutes: number;
	durations: Durations;
	priorityBlocks: readonly string[];
}): ExamBlock[] {
	const { status, durations } = input;
	const blocks: ExamBlock[] = [];
	let left = input.minutes;
	const target = MODE_LEVEL[input.standard.mode];
	const goal = (i: Pick<IdeaStatus, "goal">) => i.goal ?? target;
	// 1) dated review — always offered when something is due, even past
	//    the budget (forgetting doesn't wait for the plan).
	const due = status.ideas.filter((i) => i.dueToday);
	if (due.length > 0) {
		const minutes = due.length * durations.review;
		blocks.push({ kind: "review", minutes, nodeIds: due.map((i) => i.nodeId) });
		left -= minutes;
	}
	if (left <= 0) return blocks;
	// 2) mode practice — the placement test first while it is pending.
	if (!status.placement.done) {
		const ideas = status.placement.pendingIdeas;
		const byId = new Map(status.ideas.map((i) => [i.nodeId, i]));
		const climbs = ideas.reduce((sum, id) => sum + (byId.get(id)?.goal ?? target), 0);
		const minutes = Math.min(left, (climbs + status.placement.pendingPoints.length) * durations.problem);
		blocks.push({ kind: "placement", minutes, nodeIds: ideas });
		left -= minutes;
	} else {
		const climbing = status.ideas.filter((i) => !i.toTeach && !i.blocked && i.level < goal(i));
		if (climbing.length > 0) {
			const minutes = Math.min(left, climbing.reduce((s, i) => s + (goal(i) - i.level) * durations.problem, 0));
			blocks.push({ kind: "practice", minutes, nodeIds: climbing.map((i) => i.nodeId) });
			left -= minutes;
		}
	}
	if (left <= 0) return blocks;
	// 3) teach — a «conocimiento previo» first (owner 2026-11-09), else one
	//    point not blocked by one: prioritized blocks first, syllabus order.
	const prereq = nextPrerequisite(status.prerequisites ?? []);
	if (prereq) {
		const short = prereq.state === "consolidate";
		blocks.push({ kind: "teach", minutes: Math.min(left, short ? durations.consolidate : durations.teach), nodeIds: prereq.nodeIds, prerequisiteId: prereq.id, short });
		return blocks;
	}
	const priority = new Set(input.priorityBlocks);
	const teachable = status.points
		.filter((p) => (p.need === "teach" || p.need === "consolidate") && !(p.blockedBy ?? []).length)
		.sort((a, b) => Number(priority.has(b.blockId)) - Number(priority.has(a.blockId)));
	const next = teachable[0];
	if (next) {
		const short = next.need === "consolidate";
		blocks.push({ kind: "teach", minutes: Math.min(left, short ? durations.consolidate : durations.teach), nodeIds: next.nodeIds, pointId: next.id, short });
	}
	return blocks;
}

// ─── syllabus candidates (the mapper's input, owner-approved 2026-11-06) ────

/** Candidates handed to the mapper at most. */
export const MAX_SYLLABUS_CANDIDATES = 400;
/** Word-overlap hits kept per syllabus line. */
const HITS_PER_LINE = 8;

const normalizeWord = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOf = (text: string): Set<string> =>
	new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeWord).filter((w) => w.length >= 4));

/**
 * The propositions the mapper may link: every idea of the syllabus folders,
 * then — per syllabus line — the ideas sharing the most words with it
 * (≥ 1 word of 4+ letters, accents folded), capped. Pure, deterministic.
 */
export function syllabusCandidates(input: {
	text: string;
	nodes: ReadonlyArray<{ id: string; name: string; statement: string; aliases?: readonly string[] }>;
	folderNodeIds: ReadonlySet<string>;
	cap?: number;
}): string[] {
	const cap = input.cap ?? MAX_SYLLABUS_CANDIDATES;
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (id: string) => {
		if (out.length < cap && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	};
	for (const n of input.nodes) if (input.folderNodeIds.has(n.id)) push(n.id);
	const indexed = input.nodes.map((n) => ({ id: n.id, words: wordsOf([n.name, n.statement, ...(n.aliases ?? [])].join(" ")) }));
	for (const line of input.text.split("\n")) {
		if (out.length >= cap) break;
		const words = wordsOf(line);
		if (words.size === 0) continue;
		const scored: Array<{ id: string; score: number }> = [];
		for (const n of indexed) {
			let score = 0;
			for (const w of words) if (n.words.has(w)) score++;
			if (score > 0) scored.push({ id: n.id, score });
		}
		scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
		for (const hit of scored.slice(0, HITS_PER_LINE)) push(hit.id);
	}
	return out;
}

/** Give mapped blocks stable ids (b1…, p1…), in order. */
export function numberBlocks(
	blocks: ReadonlyArray<{
		title: string;
		kind?: PointKind;
		excluded?: boolean;
		points: ReadonlyArray<{ text: string; nodeIds: readonly string[]; kind?: PointKind; origin?: PointOrigin; extension?: readonly string[] }>;
	}>,
): SyllabusBlock[] {
	let p = 0;
	return blocks.map((b, i) => {
		const blockKind = b.kind ?? "syllabus";
		return {
			id: `b${i + 1}`,
			title: b.title,
			...(blockKind !== "syllabus" ? { kind: blockKind } : {}),
			...(b.excluded ? { excluded: true } : {}),
			points: b.points.map((pt) => {
				const kind = pt.kind ?? blockKind;
				// Instruction points hold rules, never graph links.
				const syllabus = kind === "syllabus";
				return {
					id: `p${++p}`,
					text: pt.text,
					nodeIds: syllabus ? [...pt.nodeIds] : [],
					...(kind !== blockKind ? { kind } : {}),
					...(pt.origin ? { origin: pt.origin } : {}),
					...(syllabus && pt.extension?.length ? { extension: [...pt.extension] } : {}),
				};
			}),
		};
	});
}

/** The guide's outline as the mapper/contrast read it: blocks and points
 *  with ids (o1…), out-of-sitting blocks and non-guide points marked. */
export function guideOutlineText(outline: readonly GuideBlock[]): { text: string; points: Array<{ id: string; blockTitle: string; text: string; inSitting: boolean }> } {
	const points: Array<{ id: string; blockTitle: string; text: string; inSitting: boolean }> = [];
	const lines: string[] = [];
	for (const b of outline) {
		lines.push(`## ${b.title}${b.inSitting ? "" : " [OUT OF THIS SITTING]"}`);
		for (const pt of b.points) {
			const id = `o${points.length + 1}`;
			points.push({ id, blockTitle: b.title, text: pt.text, inSitting: b.inSitting });
			lines.push(`- [${id}] ${pt.text}${pt.fromGuide ? "" : " [NOT FROM THE GUIDE]"}`);
		}
	}
	return { text: lines.join("\n"), points };
}

/** «Ascender a punto extra» (owner 2026-11-06): an ampliación idea becomes
 *  its own counted point, right after the point it hung from, with one
 *  target idea taken from the idea itself («De tus notas»). Pure. */
export function promoteExtension(blocks: readonly SyllabusBlock[], pointId: string, idea: { id: string; name: string; statement: string }, newIds: { point: string; target: string }): SyllabusBlock[] {
	return blocks.map((b) => {
		const at = b.points.findIndex((p) => p.id === pointId);
		if (at < 0) return b;
		const from = b.points[at]!;
		if (!(from.extension ?? []).includes(idea.id)) return b;
		const rest = (from.extension ?? []).filter((n) => n !== idea.id);
		const { extension: _e, ...base } = from;
		const updated: SyllabusPoint = rest.length ? { ...base, extension: rest } : base;
		const extra: SyllabusPoint = {
			id: newIds.point,
			text: idea.name,
			nodeIds: [idea.id],
			origin: "extra",
			targets: [{ id: newIds.target, statement: idea.statement || idea.name, source: { kind: "notes", title: "" }, nodeIds: [idea.id] }],
		};
		return { ...b, points: [...b.points.slice(0, at), updated, extra, ...b.points.slice(at + 1)] };
	});
}

/** Apply «Contrastar con la guía» (owner 2026-11-06): add the chosen
 *  missing official points (to the block of the same title, else a new
 *  block at the end; unresearched — the research runs after), and for each
 *  chosen extra either keep it as «punto extra» or move its ideas to the
 *  ampliación of the closest official point (by text) and drop it. Pure;
 *  `added` = the new points' ids. */
export function applyContrast(
	blocks: readonly SyllabusBlock[],
	input: {
		add: ReadonlyArray<{ blockTitle: string; text: string; inSitting: boolean }>;
		extras: ReadonlyArray<{ pointId: string; action: "extension" | "keep"; closest: string | null }>;
		newId: (prefix: "b" | "p") => string;
	},
): { blocks: SyllabusBlock[]; added: string[] } {
	let next: SyllabusBlock[] = blocks.map((b) => ({ ...b, points: [...b.points] }));
	const added: string[] = [];
	const norm = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
	for (const item of input.add) {
		const point: SyllabusPoint = { id: input.newId("p"), text: item.text, nodeIds: [], origin: "official" };
		added.push(point.id);
		const block = next.find((b) => norm(b.title) === norm(item.blockTitle));
		if (block) block.points.push(point);
		else next.push({ id: input.newId("b"), title: item.blockTitle, points: [point], ...(item.inSitting ? {} : { excluded: true }) });
	}
	for (const extra of input.extras) {
		if (extra.action === "keep") {
			next = next.map((b) => ({ ...b, points: b.points.map((p) => (p.id === extra.pointId ? { ...p, origin: "extra" as const } : p)) }));
			continue;
		}
		const source = next.flatMap((b) => b.points).find((p) => p.id === extra.pointId);
		if (!source) continue;
		const ideas = [...new Set([...source.nodeIds, ...(source.extension ?? [])])];
		next = next.map((b) => ({ ...b, points: b.points.filter((p) => p.id !== extra.pointId) }));
		const target = extra.closest ? next.flatMap((b) => b.points).find((p) => norm(p.text) === norm(extra.closest!)) : undefined;
		if (target && ideas.length) {
			next = next.map((b) => ({
				...b,
				points: b.points.map((p) => {
					if (p.id !== target.id) return p;
					const held = new Set([...p.nodeIds, ...(p.targets ?? []).flatMap((t) => t.nodeIds)]);
					const extension = [...new Set([...(p.extension ?? []), ...ideas.filter((n) => !held.has(n))])];
					return extension.length ? { ...p, extension } : p;
				}),
			}));
		}
	}
	return { blocks: next.filter((b) => b.points.length > 0), added };
}

// ─── API views (GET /api/exams, /api/exams/[id]; server and components) ─────

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
	/** While/after reading unread folders: notes settled and failed. */
	reading: { total: number; done: number; failed: Array<{ path: string; error: string }> } | null;
	/** «Calendario» (owner 2026-11-10): today's cards for this exam and
	 *  its planned minutes per day from today (the calendar's plan). */
	calendarToday: CalendarItem[];
	calendarMinutes: number[];
}

// ─── sorting ideas born in exam sessions (owner 2026-11-06) ─────────────────

/** What still has to be sorted: per researched point, the ideas born in
 *  its exam teach sessions (→ the sorter) and in its «Profundizar»
 *  sessions (→ ampliación, no model) that sit in none of its lists. */
export function pendingSorts(
	exam: Pick<ExamRecord, "id" | "blocks">,
	chats: ReadonlyArray<Pick<ExamChat, "id" | "exam">>,
	nodesBornIn: ReadonlyMap<string, readonly string[]>,
): Array<{ pointId: string; teach: string[]; deepen: string[] }> {
	const points = new Map(studyPoints(exam).filter((p) => p.targets).map((p) => [p.id, p]));
	const out = new Map<string, { pointId: string; teach: Set<string>; deepen: Set<string> }>();
	for (const chat of chats) {
		const link = chat.exam;
		if (link?.id !== exam.id || !link.pointId || (link.kind !== "teach" && link.kind !== "deepen")) continue;
		const point = points.get(link.pointId);
		if (!point) continue;
		const placed = new Set([...point.targets!.flatMap((t) => t.nodeIds), ...(point.extension ?? [])]);
		for (const id of nodesBornIn.get(chat.id) ?? []) {
			if (placed.has(id)) continue;
			const entry = out.get(point.id) ?? { pointId: point.id, teach: new Set<string>(), deepen: new Set<string>() };
			out.set(point.id, entry);
			(link.kind === "deepen" ? entry.deepen : entry.teach).add(id);
		}
	}
	return [...out.values()].map((e) => ({ pointId: e.pointId, teach: [...e.teach].filter((id) => !e.deepen.has(id)), deepen: [...e.deepen] }));
}

/** Put sorted ideas in place: a target id links the idea to that target,
 *  "extension" adds it to the point's ampliación. Pure. */
export function applySort(blocks: SyllabusBlock[], pointId: string, sorted: ReadonlyMap<string, string>): SyllabusBlock[] {
	return syncPointLinks(
		blocks.map((b) => ({
			...b,
			points: b.points.map((p) => {
				if (p.id !== pointId || !p.targets) return p;
				const extension = new Set(p.extension ?? []);
				const targets = p.targets.map((t) => ({ ...t, nodeIds: [...t.nodeIds] }));
				for (const [idea, where] of sorted) {
					const target = targets.find((t) => t.id === where);
					if (target) {
						if (!target.nodeIds.includes(idea)) target.nodeIds.push(idea);
						extension.delete(idea);
					} else if (where === "extension") extension.add(idea);
				}
				const { extension: _old, ...rest } = p;
				void _old;
				return { ...rest, targets, ...(extension.size ? { extension: [...extension] } : {}) };
			}),
		})),
	);
}

/** The learner's hand move (owner 2026-11-06): an idea of a researched
 *  point goes to ampliación, or to one of its targets. Wins over the
 *  sorter (the idea is then «placed» and never re-sorted). Pure. */
export function moveIdea(blocks: SyllabusBlock[], pointId: string, ideaId: string, where: "extension" | { target: string }): SyllabusBlock[] {
	const cleared = blocks.map((b) => ({
		...b,
		points: b.points.map((p) =>
			p.id !== pointId || !p.targets
				? p
				: { ...p, targets: p.targets.map((t) => ({ ...t, nodeIds: t.nodeIds.filter((n) => n !== ideaId) })), extension: (p.extension ?? []).filter((n) => n !== ideaId) },
		),
	}));
	return applySort(cleared, pointId, new Map([[ideaId, where === "extension" ? "extension" : where.target]]));
}

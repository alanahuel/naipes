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
}

/** Where a target idea comes from (owner 2026-11-06). */
export interface TargetSource {
	/** user = added by hand in the review. */
	kind: "material" | "web" | "model" | "user";
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
}

/** draft = created, mapping not yet confirmed; active = planned;
 *  archived = after the date (or by hand). */
export type ExamStatus = "draft" | "active" | "archived";

/** reading = the chosen unread folders are being read into the graph
 *  first (owner 2026-11-06); the mapping starts on its own after. */
export type MappingState = "none" | "reading" | "running" | "researching" | "done" | "error";

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
	mapping: { state: MappingState; error?: string; at?: string };
	reading?: ExamReading;
	research?: ExamResearch;
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
		const src = r.source !== null && typeof r.source === "object" ? (r.source as Record<string, unknown>) : {};
		const kind = src.kind === "material" || src.kind === "web" || src.kind === "user" ? src.kind : "model";
		const ref = shortText(src.ref, 2000);
		const year = shortText(src.year, 20);
		out.push({
			id,
			statement,
			source: { kind, title: shortText(src.title, 500), ...(ref ? { ref } : {}), ...(year ? { year } : {}), ...(src.outdated === true ? { outdated: true } : {}) },
			nodeIds: strList(r.nodeIds),
		});
	}
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
			points.push({ id: pid, text, nodeIds: strList(point.nodeIds), ...(targets ? { targets } : {}) });
		}
		out.push({ id, title, points });
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
		mapping.state === "reading" || mapping.state === "running" || mapping.state === "researching" || mapping.state === "done" || mapping.state === "error"
			? mapping.state
			: "none";
	const final = r.final !== null && typeof r.final === "object" ? (r.final as Record<string, unknown>) : null;
	const reading = sanitizeReading(r.reading);
	const research = sanitizeResearch(r.research);
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
		mapping: {
			state: mappingState,
			...(typeof mapping.error === "string" ? { error: mapping.error } : {}),
			...(typeof mapping.at === "string" ? { at: mapping.at } : {}),
		},
		...(reading ? { reading } : {}),
		...(research ? { research } : {}),
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
export function examNodeIds(exam: Pick<ExamRecord, "id" | "blocks">, chats: ReadonlyArray<Pick<ExamChat, "id" | "exam">>, nodesBornIn: ReadonlyMap<string, readonly string[]>): string[] {
	const out = new Set<string>();
	for (const p of allPoints(exam)) for (const id of p.nodeIds) out.add(id);
	for (const chat of chats) {
		if (chat.exam?.id !== exam.id || chat.exam.kind !== "teach") continue;
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

// ─── status ─────────────────────────────────────────────────────────────────

export interface IdeaStatus extends IdeaLevel {
	nodeId: string;
	name: string;
	pointIds: string[];
	/** Recall on the exam day with no further study (null = never graded). */
	recallAtExam: number | null;
	meets: boolean;
	/** Due in Repaso before today's end. */
	dueToday: boolean;
}

/** What a point needs next, in plan order. */
export type PointNeed = "placement" | "teach" | "consolidate" | "practice" | "done";

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
	/** Share of its ideas meeting the standard (0 with no ideas). */
	score: number;
	need: PointNeed;
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
	placement: { pendingIdeas: string[]; pendingPoints: string[]; done: boolean };
}

export interface ExamStatusInput {
	exam: Pick<ExamRecord, "id" | "examDate" | "standard" | "blocks">;
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
}

const meetsWith = (idea: Pick<IdeaStatus, "toTeach" | "level" | "recallAtExam">, standard: Pick<ExamStandard, "mode" | "recall">) =>
	!idea.toTeach && idea.level >= MODE_LEVEL[standard.mode] && idea.recallAtExam !== null && idea.recallAtExam >= standard.recall;

/** Per-point coverage (owner): mean of the points' meeting shares. */
export function coverageWith(points: ReadonlyArray<{ nodeIds: readonly string[] }>, ideas: ReadonlyMap<string, Pick<IdeaStatus, "toTeach" | "level" | "recallAtExam">>, standard: Pick<ExamStandard, "mode" | "recall">): number {
	if (points.length === 0) return 0;
	let sum = 0;
	for (const p of points) {
		if (p.nodeIds.length === 0) continue;
		let met = 0;
		for (const id of p.nodeIds) {
			const idea = ideas.get(id);
			if (idea && meetsWith(idea, standard)) met++;
		}
		sum += met / p.nodeIds.length;
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
	for (const p of allPoints(exam)) pointNodes.set(p.id, [...p.nodeIds]);
	for (const chat of examChats) {
		if (chat.exam!.kind !== "teach" || !chat.exam!.pointId || !pointNodes.has(chat.exam!.pointId)) continue;
		taughtSession.add(chat.exam!.pointId);
		const list = pointNodes.get(chat.exam!.pointId)!;
		for (const id of input.nodesBornIn.get(chat.id) ?? []) {
			examTaught.add(id);
			if (!list.includes(id)) list.push(id);
		}
	}

	const pointsOf = new Map<string, string[]>();
	for (const [pid, ids] of pointNodes) for (const id of ids) pointsOf.set(id, [...(pointsOf.get(id) ?? []), pid]);

	const ideas: IdeaStatus[] = [];
	const ideaById = new Map<string, IdeaStatus>();
	for (const [nodeId, pointIds] of pointsOf) {
		const item = input.items.get(nodeId);
		const level = ideaLevel(item?.events ?? [], placementChats);
		const recallAtExam = item && item.stability !== null && item.lastReview !== null ? recallAt(item.stability, item.lastReview, moment) : null;
		const status: IdeaStatus = {
			nodeId,
			name: item?.name ?? input.names.get(nodeId) ?? nodeId,
			pointIds,
			...level,
			recallAtExam,
			meets: false,
			dueToday: !!item && !item.paused && item.released && item.due !== null && item.due < input.dueEnd,
		};
		status.meets = meetsWith(status, exam.standard);
		ideas.push(status);
		ideaById.set(nodeId, status);
	}

	const target = MODE_LEVEL[exam.standard.mode];
	const points: PointStatus[] = allPoints(exam).map((p) => {
		const nodeIds = pointNodes.get(p.id) ?? [];
		const gap = p.nodeIds.length === 0;
		const probe = probes.get(p.id) ?? null;
		const members = nodeIds.map((id) => ideaById.get(id)!).filter(Boolean);
		const score = members.length ? members.filter((i) => i.meets).length / members.length : 0;
		let need: PointNeed;
		if (gap && !taughtSession.has(p.id)) need = probe === null ? "placement" : probe === "known" ? "consolidate" : "teach";
		else if (members.some((i) => !i.placed && !examTaught.has(i.nodeId))) need = "placement";
		else if (members.some((i) => i.toTeach)) need = "consolidate";
		else if (members.some((i) => i.level < target)) need = "practice";
		else need = "done";
		return { id: p.id, blockId: p.blockId, text: p.text, nodeIds, gap, probe, taughtSession: taughtSession.has(p.id), score, need };
	});

	const coverage = coverageWith(points, ideaById, exam.standard);
	let reachedPreset: ExamPreset | null = null;
	for (const preset of PRESET_ORDER) {
		const s = EXAM_PRESETS[preset];
		if (coverageWith(points, ideaById, s) >= s.coverage) reachedPreset = preset;
	}
	// Placement is exhaustive (owner): every syllabus idea the placement
	// test hasn't reached, and every «falta» point not yet probed.
	const pendingIdeas = ideas.filter((i) => !i.placed && !examTaught.has(i.nodeId)).map((i) => i.nodeId);
	const pendingPoints = points.filter((p) => p.gap && !p.taughtSession && p.probe === null).map((p) => p.id);
	return {
		examId: exam.id,
		today,
		daysLeft: daysBetween(today, exam.examDate),
		coverage,
		meetsStandard: coverage >= exam.standard.coverage,
		reachedPreset,
		points,
		ideas,
		placement: { pendingIdeas, pendingPoints, done: pendingIdeas.length === 0 && pendingPoints.length === 0 },
	};
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
	status: Pick<ExamStatusModel, "points" | "ideas" | "placement">;
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
	const placement =
		(status.placement.pendingIdeas.length * target + status.placement.pendingPoints.length) * durations.problem;

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

	interface Cost { teach: number; practice: number; review: number; met: boolean; priority: boolean }
	const priority = new Set(input.priorityBlocks);
	const costs: Cost[] = status.points.map((p) => {
		let teach = 0;
		let practice = 0;
		let review = 0;
		let met = false;
		if (p.gap && !p.taughtSession) {
			teach = p.probe === "known" ? durations.consolidate : durations.teach;
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
		return { teach, practice, review, met, priority: priority.has(p.blockId) };
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
	for (const c of order.slice(0, needed)) {
		teach += c.teach;
		practice += c.practice;
		review += c.review;
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
export function planBudget(input: { today: string; weeklyMinutes: readonly number[]; exams: readonly PlanExam[] }): PlanResult {
	const exams = [...input.exams].filter((e) => daysBetween(input.today, e.examDate) > 0);
	const horizon = exams.reduce((h, e) => Math.max(h, daysBetween(input.today, e.examDate)), 0);
	const days = Array.from({ length: horizon }, (_, i) => addDays(input.today, i));
	const budgetOf = (day: string) => input.weeklyMinutes[weekdayIndex(day)] ?? 0;
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
	/** teach: the short «afianzado» session. */
	short?: boolean;
}

/** Split today's allocation into the ordered blocks. Pure. */
export function todayBlocks(input: {
	status: Pick<ExamStatusModel, "points" | "ideas" | "placement">;
	standard: Pick<ExamStandard, "mode">;
	minutes: number;
	durations: Durations;
	priorityBlocks: readonly string[];
}): ExamBlock[] {
	const { status, durations } = input;
	const blocks: ExamBlock[] = [];
	let left = input.minutes;
	const target = MODE_LEVEL[input.standard.mode];
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
		const minutes = Math.min(left, (ideas.length * target + status.placement.pendingPoints.length) * durations.problem);
		blocks.push({ kind: "placement", minutes, nodeIds: ideas });
		left -= minutes;
	} else {
		const climbing = status.ideas.filter((i) => !i.toTeach && i.level < target);
		if (climbing.length > 0) {
			const minutes = Math.min(left, climbing.reduce((s, i) => s + (target - i.level) * durations.problem, 0));
			blocks.push({ kind: "practice", minutes, nodeIds: climbing.map((i) => i.nodeId) });
			left -= minutes;
		}
	}
	if (left <= 0) return blocks;
	// 3) teach one point — prioritized blocks first, syllabus order.
	const priority = new Set(input.priorityBlocks);
	const teachable = status.points
		.filter((p) => p.need === "teach" || p.need === "consolidate")
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
export function numberBlocks(blocks: ReadonlyArray<{ title: string; points: ReadonlyArray<{ text: string; nodeIds: readonly string[] }> }>): SyllabusBlock[] {
	let p = 0;
	return blocks.map((b, i) => ({ id: `b${i + 1}`, title: b.title, points: b.points.map((pt) => ({ id: `p${++p}`, text: pt.text, nodeIds: [...pt.nodeIds] })) }));
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
}

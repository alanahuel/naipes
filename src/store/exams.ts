/**
 * Exam persistence («Exámenes», owner 2026-11-05): data/exams/ (config.ts
 * EXAM_FILES). One read-modify-write JSON file per exam plus an
 * append-only notices log. Shapes + sanitizers: src/core/exams.ts. This
 * module only moves bytes; every read tolerates absence and torn lines.
 */

import fs from "node:fs";
import path from "node:path";
import { EXAM_FILES } from "../../config.ts";
import { sanitizeExamRecord, type ExamRecord } from "../core/exams.ts";

const ID_RE = /^exam_[a-z0-9_]{4,60}$/;

export const isExamId = (id: string): boolean => ID_RE.test(id);

const fileOf = (id: string) => path.join(EXAM_FILES.dir, `${id}.json`);

export function newExamId(): string {
	return `exam_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function readExam(id: string): ExamRecord | null {
	if (!isExamId(id)) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(fileOf(id), "utf-8");
	} catch {
		return null;
	}
	try {
		return sanitizeExamRecord(JSON.parse(raw));
	} catch (error) {
		// A newer-version record must not be silently treated as absent.
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

/** Every readable exam, newest first. */
export function listExams(): ExamRecord[] {
	let files: string[];
	try {
		files = fs.readdirSync(EXAM_FILES.dir);
	} catch {
		return [];
	}
	const out: ExamRecord[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const exam = readExam(f.slice(0, -5));
			if (exam) out.push(exam);
		} catch {
			/* a newer-version file: skipped in listings, refused on direct read */
		}
	}
	return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Atomic replace (write a sibling, rename over). */
export function writeExam(exam: ExamRecord): void {
	if (!isExamId(exam.id)) throw new Error(`invalid exam id: ${exam.id}`);
	fs.mkdirSync(EXAM_FILES.dir, { recursive: true });
	const target = fileOf(exam.id);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(exam, null, "\t"), "utf-8");
	fs.renameSync(tmp, target);
}

export function deleteExam(id: string): boolean {
	if (!isExamId(id)) return false;
	try {
		fs.unlinkSync(fileOf(id));
		return true;
	} catch {
		return false;
	}
}

/** Max mtime over the exam files (part of the server cache key). */
export function examsRevision(): number {
	let revision = 0;
	try {
		for (const f of fs.readdirSync(EXAM_FILES.dir)) {
			try {
				revision = Math.max(revision, fs.statSync(path.join(EXAM_FILES.dir, f)).mtimeMs);
			} catch {
				/* deleted mid-scan */
			}
		}
	} catch {
		/* no dir yet */
	}
	return revision;
}

// ─── notices.jsonl ──────────────────────────────────────────────────────────

export type ExamNoticeKind = "below" | "week" | "eve";

export interface ExamNoticeLine {
	examId: string;
	kind: ExamNoticeKind;
	/** The review day it was sent. */
	day: string;
	at: string;
}

export function isExamNoticeLine(v: unknown): v is ExamNoticeLine {
	if (v === null || typeof v !== "object") return false;
	const l = v as Record<string, unknown>;
	return typeof l.examId === "string" && (l.kind === "below" || l.kind === "week" || l.kind === "eve") && typeof l.day === "string" && typeof l.at === "string";
}

export function readExamNotices(): ExamNoticeLine[] {
	let raw: string;
	try {
		raw = fs.readFileSync(EXAM_FILES.notices, "utf-8");
	} catch {
		return [];
	}
	const out: ExamNoticeLine[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const v = JSON.parse(t);
			if (isExamNoticeLine(v)) out.push(v);
		} catch {
			/* torn append */
		}
	}
	return out;
}

export function appendExamNotice(line: ExamNoticeLine): void {
	fs.mkdirSync(EXAM_FILES.dir, { recursive: true });
	fs.appendFileSync(EXAM_FILES.notices, `${JSON.stringify(line)}\n`, "utf-8");
}

/**
 * Spaced-review persistence («Repaso», owner 2026-11-04): data/review/.
 * Only what cannot be derived from the chat records lives here (config.ts
 * REVIEW_FILES). Shapes + sanitizers: src/core/review.ts. This module only
 * moves bytes; every read tolerates absence and torn lines.
 */

import fs from "node:fs";
import path from "node:path";
import { REVIEW_FILES } from "../../config.ts";
import { isIntakeLine, sanitizeReviewSources, type IntakeLine, type ReviewSources } from "../core/review.ts";

/** sources.json, or null when absent/corrupt. Throws on a newer version. */
export function readReviewSources(): ReviewSources | null {
	let raw: string;
	try {
		raw = fs.readFileSync(REVIEW_FILES.sources, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return sanitizeReviewSources(parsed);
}

/** Atomic replace (write a sibling, rename over). */
export function writeReviewSources(sources: ReviewSources): void {
	fs.mkdirSync(path.dirname(REVIEW_FILES.sources), { recursive: true });
	const tmp = `${REVIEW_FILES.sources}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(sources, null, "\t"), "utf-8");
	fs.renameSync(tmp, REVIEW_FILES.sources);
}

function readLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			// A torn append never takes the review screen down.
		}
	}
	return out;
}

/** intake.jsonl — first line per idea wins (a release is never moved). */
export function readIntake(): IntakeLine[] {
	const seen = new Set<string>();
	const out: IntakeLine[] = [];
	for (const v of readLines(REVIEW_FILES.intake)) {
		if (!isIntakeLine(v) || seen.has(v.nodeId)) continue;
		seen.add(v.nodeId);
		out.push({ nodeId: v.nodeId, day: v.day, reason: v.reason });
	}
	return out;
}

export function appendIntake(lines: readonly IntakeLine[]): void {
	if (lines.length === 0) return;
	fs.mkdirSync(path.dirname(REVIEW_FILES.intake), { recursive: true });
	fs.appendFileSync(REVIEW_FILES.intake, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf-8");
}

/** The mtime stamp of the review files (part of the server cache key). */
export function reviewFilesRevision(): number {
	let revision = 0;
	for (const file of [REVIEW_FILES.sources, REVIEW_FILES.intake]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent */
		}
	}
	return revision;
}

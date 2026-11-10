/**
 * «Calendario» persistence (owner 2026-11-10): data/calendar/ (config.ts
 * CALENDAR_FILES). Shapes + sanitizers: src/core/calendar.ts. This module
 * only moves bytes; every read tolerates absence and torn files.
 */

import fs from "node:fs";
import path from "node:path";
import { CALENDAR_FILES } from "../../config.ts";
import { emptyCalendar, isClock, isDay, sanitizeCalendar, type CalendarData, type ImportedOccurrence } from "../core/calendar.ts";

function atomicWrite(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, "utf-8");
	fs.renameSync(tmp, file);
}

export function readCalendar(): CalendarData {
	try {
		return sanitizeCalendar(JSON.parse(fs.readFileSync(CALENDAR_FILES.data, "utf-8")));
	} catch {
		return emptyCalendar();
	}
}

export function writeCalendar(data: CalendarData): void {
	atomicWrite(CALENDAR_FILES.data, JSON.stringify(data, null, "\t"));
}

/** Read-modify-write in one step (synchronous: no interleaving). */
export function updateCalendar<T>(fn: (data: CalendarData) => T): T {
	const data = readCalendar();
	const out = fn(data);
	writeCalendar(data);
	return out;
}

const FEED_ID_RE = /^feed_[a-z0-9_]{4,60}$/;
export const isFeedId = (id: string): boolean => FEED_ID_RE.test(id);

export function newCalendarId(prefix: "ev" | "pin" | "feed"): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

const feedFile = (id: string) => path.join(CALENDAR_FILES.feeds, `${id}.json`);

export function readFeedOccurrences(id: string): ImportedOccurrence[] {
	if (!isFeedId(id)) return [];
	try {
		const raw = JSON.parse(fs.readFileSync(feedFile(id), "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(o): o is ImportedOccurrence =>
				!!o &&
				typeof o === "object" &&
				typeof (o as ImportedOccurrence).seriesKey === "string" &&
				typeof (o as ImportedOccurrence).title === "string" &&
				isDay((o as ImportedOccurrence).day) &&
				((o as ImportedOccurrence).start === undefined || isClock((o as ImportedOccurrence).start)) &&
				typeof (o as ImportedOccurrence).minutes === "number",
		);
	} catch {
		return [];
	}
}

export function writeFeedOccurrences(id: string, occurrences: readonly ImportedOccurrence[]): void {
	if (!isFeedId(id)) throw new Error(`invalid feed id: ${id}`);
	atomicWrite(feedFile(id), JSON.stringify(occurrences));
}

export function deleteFeedOccurrences(id: string): void {
	if (isFeedId(id)) fs.rmSync(feedFile(id), { force: true });
}

/** Max mtime over the calendar files (part of the server cache keys). */
export function calendarRevision(): number {
	let revision = 0;
	for (const f of [CALENDAR_FILES.data]) {
		try {
			revision = Math.max(revision, fs.statSync(f).mtimeMs);
		} catch {
			/* absent */
		}
	}
	try {
		for (const f of fs.readdirSync(CALENDAR_FILES.feeds)) {
			try {
				revision = Math.max(revision, fs.statSync(path.join(CALENDAR_FILES.feeds, f)).mtimeMs);
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

export interface CalendarNoticeLine {
	/** "alert" before a timed item; "confirm" after a class. */
	kind: "alert" | "confirm";
	/** The item / occurrence key. */
	key: string;
	day: string;
	at: string;
}

export function readCalendarNotices(): CalendarNoticeLine[] {
	let text: string;
	try {
		text = fs.readFileSync(CALENDAR_FILES.notices, "utf-8");
	} catch {
		return [];
	}
	const out: CalendarNoticeLine[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line) as CalendarNoticeLine;
			if ((v.kind === "alert" || v.kind === "confirm") && typeof v.key === "string" && typeof v.day === "string") out.push(v);
		} catch {
			/* torn line */
		}
	}
	return out;
}

export function appendCalendarNotice(line: CalendarNoticeLine): void {
	fs.mkdirSync(CALENDAR_FILES.dir, { recursive: true });
	fs.appendFileSync(CALENDAR_FILES.notices, `${JSON.stringify(line)}\n`, "utf-8");
}

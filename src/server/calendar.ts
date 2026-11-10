/**
 * «Calendario» service (owner design 2026-11-10, plan approved «tal
 * cual»): the calendar view over any range, hand-made events and their
 * occurrences, per-date minutes, the learner's edits to sessions (move,
 * hour, split, merge, resize, release — each anchors), starting a session
 * from a card, and the .ics subscriptions (read-only, refreshed every few
 * hours). The plan itself is computed once with the exam state
 * (calendar-context.ts); this module reads it.
 */

import {
	CONCRETE_DAYS,
	anchorFrom,
	baseMinutes,
	isClock,
	isDay,
	isEventKind,
	sanitizeEvent,
	splitPart,
	toConfirm,
	type CalendarConfirmView,
	type CalendarDay,
	type CalendarEvent,
	type CalendarExamView,
	type CalendarItem,
	type CalendarView,
	type EventKind,
	type IcsFeed,
	type ImportedMeta,
	type OccurrenceState,
	type PinnedSession,
} from "../core/calendar.ts";
import { emit } from "../core/events.ts";
import { addDays, studyPoints, type ExamRecord } from "../core/exams.ts";
import { expandIcs, parseIcs } from "../core/ics.ts";
import { reviewDay } from "../core/review.ts";
import { formatMessage, type Locale } from "../core/i18n.ts";
import { MESSAGES } from "../core/messages/index.ts";
import { deleteFeedOccurrences, isFeedId, newCalendarId, readCalendar, updateCalendar, writeFeedOccurrences } from "../store/calendar.ts";
import { readExam } from "../store/exams.ts";
import { getExamsState, startExamSession, startPrepareSession, type ExamsState } from "./exams.ts";
import { startReviewSession } from "./review.ts";
import { effectiveSettings } from "./stores.ts";

type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 502; error: string };

const changed = () => emit("calendar-changed", {});

// ─── the view ───────────────────────────────────────────────────────────────

/** At most this many days per view request (a month view + margins). */
export const MAX_VIEW_DAYS = 62;

const examView = (r: ExamRecord): CalendarExamView => {
	const titles = new Map(r.blocks.map((b) => [b.id, b.title]));
	return {
		id: r.id,
		title: r.title,
		examDate: r.examDate,
		points: studyPoints(r).map((p) => ({ id: p.id, text: p.text, blockTitle: titles.get(p.blockId) ?? "" })),
		prerequisites: (r.prerequisites ?? []).map((q) => ({ id: q.id, statement: q.statement })),
	};
};

/** The days [from, to]: planned days from the shared plan, past days with
 *  their events and pinned sittings, far days with events only. */
export function calendarView(range: { from: string; to: string }, now = Date.now()): CalendarView {
	void refreshDueFeeds(now);
	const state = getExamsState(now);
	const cal = state.calendar;
	const settings = effectiveSettings();
	const weekly = settings.exams.weeklyMinutes;
	const planned = new Map(cal.plan.days.map((d) => [d.day, d]));
	const days: CalendarDay[] = [];
	for (let d = range.from; d <= range.to && days.length < MAX_VIEW_DAYS; d = addDays(d, 1)) {
		const hit = planned.get(d);
		if (hit) {
			days.push(hit);
			continue;
		}
		const items: CalendarItem[] = cal.source.occurrences
			.filter((o) => o.day === d)
			.map((o) => ({
				key: o.key,
				type: "event" as const,
				kind: o.kind,
				day: d,
				...(o.start ? { start: o.start } : {}),
				minutes: o.minutes,
				hour: o.start ? ("fixed" as const) : ("none" as const),
				...(o.examId ? { examId: o.examId } : {}),
				occurrence: o.key,
				title: o.title,
				state: o.ended ? ("done" as const) : ("planned" as const),
				consumes: o.consumes,
				source: o.source,
				...(o.cancelled ? { cancelled: true } : {}),
			}));
		if (d < state.today) {
			for (const v of cal.pinned) {
				const part = v.session.parts[v.part]!;
				if (part.day !== d) continue;
				const late = cal.plan.late.find((l) => l.key === `${v.session.id}#${v.part}`);
				items.push(
					late ?? {
						key: `${v.session.id}#${v.part}`,
						type: "session",
						kind: v.session.kind,
						day: d,
						...(part.start ? { start: part.start } : {}),
						minutes: part.minutes,
						hour: part.start ? "fixed" : "none",
						...(v.session.examId ? { examId: v.session.examId } : {}),
						...(v.session.pointId ? { pointId: v.session.pointId } : {}),
						...(v.session.prerequisiteId ? { prerequisiteId: v.session.prerequisiteId } : {}),
						...(v.session.occurrence ? { occurrence: v.session.occurrence } : {}),
						pinned: { id: v.session.id, anchored: v.session.anchored, part: v.part, parts: v.session.parts.length, ...(v.session.chatId ? { chatId: v.session.chatId } : {}) },
						state: v.done ? "done" : "planned",
					},
				);
			}
		}
		days.push({ day: d, budget: baseMinutes(d, weekly, cal.source.data.dayMinutes), concrete: false, items, examMinutes: {}, repasoMinutes: 0, free: 0 });
	}
	const live = state.exams.filter((c) => c.live).map((c) => c.record);
	const liveIds = new Set(live.map((r) => r.id));
	const seriesTitles = new Map<string, string>();
	for (const o of cal.source.imported) if (!seriesTitles.has(o.seriesKey)) seriesTitles.set(o.seriesKey, o.title);
	return {
		now,
		today: state.today,
		days,
		late: cal.plan.late,
		toConfirm: toConfirm(cal.source.occurrences, addDays(state.today, -14))
			.filter((o) => liveIds.has(o.examId!))
			.map((o) => ({ key: o.key, title: o.title, kind: o.kind, day: o.day, ...(o.start ? { start: o.start } : {}), examId: o.examId!, planned: o.planned })),
		exams: live.map(examView),
		events: cal.source.data.events,
		feeds: cal.source.data.feeds,
		series: [...seriesTitles].map(([seriesKey, title]) => ({ seriesKey, feedId: seriesKey.split(":")[0]!, title, meta: cal.source.data.importedMeta[seriesKey] ?? {} })),
		dayMinutes: cal.source.data.dayMinutes,
		settings: { weeklyMinutes: [...weekly], slots: settings.calendar.slots, alertMinutes: settings.calendar.alertMinutes, prepareMinutes: settings.calendar.prepareMinutes },
	};
}

export function parseRange(url: URL, now = Date.now()): Result<{ from: string; to: string }> {
	const today = reviewDay(now);
	const from = url.searchParams.get("from") ?? today;
	const to = url.searchParams.get("to") ?? addDays(from, CONCRETE_DAYS - 1);
	if (!isDay(from) || !isDay(to) || to < from) return { ok: false, status: 400, error: "from/to must be YYYY-MM-DD with from ≤ to" };
	if (to > addDays(from, MAX_VIEW_DAYS - 1)) return { ok: false, status: 400, error: `at most ${MAX_VIEW_DAYS} days` };
	return { ok: true, value: { from, to } };
}

// ─── events ─────────────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** An exam the event may be assigned to (active) and its point ids. */
function examPointsOf(examId: string): Set<string> | null {
	const exam = readExam(examId);
	if (!exam || exam.status !== "active") return null;
	return new Set(studyPoints(exam).map((p) => p.id));
}

function checkAssignment(examId: unknown, planned: unknown): Result<{ examId?: string; planned?: string[] }> {
	if (examId === undefined || examId === null || examId === "") return { ok: true, value: {} };
	if (typeof examId !== "string") return { ok: false, status: 400, error: "examId must be a string" };
	const points = examPointsOf(examId);
	if (!points) return { ok: false, status: 400, error: "examId must be an active exam" };
	if (planned === undefined || planned === null) return { ok: true, value: { examId } };
	if (!Array.isArray(planned) || !planned.every((p) => typeof p === "string" && points.has(p))) return { ok: false, status: 400, error: "planned must list the exam's syllabus point ids" };
	return { ok: true, value: { examId, planned: [...new Set(planned as string[])] } };
}

export function createCalendarEvent(body: unknown, now = Date.now()): Result<CalendarEvent> {
	const raw = obj(body);
	if (!raw) return { ok: false, status: 400, error: "Invalid JSON body" };
	const assignment = checkAssignment(raw.examId, raw.planned);
	if (!assignment.ok) return assignment;
	const event = sanitizeEvent({ ...raw, ...assignment.value, id: newCalendarId("ev"), createdAt: new Date(now).toISOString() });
	if (!event) return { ok: false, status: 400, error: "title, kind (class|seminar|tutoring|selfStudy|other), day YYYY-MM-DD, start HH:MM, minutes 1–1440 required; until ≥ day" };
	updateCalendar((data) => {
		data.events.push(event);
	});
	changed();
	return { ok: true, value: event };
}

export function updateCalendarEvent(id: string, body: unknown): Result<CalendarEvent> {
	const raw = obj(body);
	if (!raw) return { ok: false, status: 400, error: "Invalid JSON body" };
	const current = readCalendar().events.find((e) => e.id === id);
	if (!current) return { ok: false, status: 404, error: "not_found" };
	const merged: Record<string, unknown> = { ...current, ...raw, id, createdAt: current.createdAt };
	for (const k of ["until", "examId", "planned"]) if (raw[k] === null) delete merged[k];
	if (merged.examId === undefined) delete merged.planned;
	const assignment = checkAssignment(merged.examId, merged.planned);
	if (!assignment.ok) return assignment;
	delete merged.examId;
	delete merged.planned;
	const event = sanitizeEvent({ ...merged, ...assignment.value });
	if (!event) return { ok: false, status: 400, error: "invalid event fields" };
	updateCalendar((data) => {
		data.events = data.events.map((e) => (e.id === id ? event : e));
	});
	changed();
	return { ok: true, value: event };
}

export function deleteCalendarEvent(id: string): boolean {
	const found = updateCalendar((data) => {
		const before = data.events.length;
		data.events = data.events.filter((e) => e.id !== id);
		if (data.events.length === before) return false;
		for (const key of Object.keys(data.occurrences)) if (key.startsWith(`${id}@`)) delete data.occurrences[key];
		data.pinned = data.pinned.filter((p) => !p.occurrence?.startsWith(`${id}@`) || !!p.chatId);
		return true;
	});
	if (found) changed();
	return found;
}

/** One occurrence's state: cancel, move, its planned / confirmed topics,
 *  own study done. `null` clears a field. */
export function updateOccurrence(body: unknown, now = Date.now()): Result<OccurrenceState> {
	const raw = obj(body);
	if (!raw || typeof raw.key !== "string") return { ok: false, status: 400, error: "key required" };
	const key = raw.key;
	const state = getExamsState(now);
	const occ = state.calendar.source.occurrences.find((o) => o.key === key);
	if (!occ) return { ok: false, status: 404, error: "not_found" };
	const points = occ.examId ? examPointsOf(occ.examId) : null;
	const topics = (v: unknown): string[] | null | "bad" => {
		if (v === null) return null;
		if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && points?.has(p))) return "bad";
		return [...new Set(v as string[])];
	};
	const next: OccurrenceState = { ...(state.calendar.source.data.occurrences[key] ?? {}) };
	if (raw.cancelled !== undefined) {
		if (raw.cancelled === true) next.cancelled = true;
		else delete next.cancelled;
	}
	if (raw.moved !== undefined) {
		const m = obj(raw.moved);
		if (raw.moved === null) delete next.moved;
		else if (m && isDay(m.day) && isClock(m.start)) next.moved = { day: m.day, start: m.start };
		else return { ok: false, status: 400, error: "moved must be { day, start } or null" };
	}
	for (const field of ["planned", "confirmed"] as const) {
		if (raw[field] === undefined) continue;
		if (!occ.examId) return { ok: false, status: 400, error: `${field}: the event has no exam` };
		const t = topics(raw[field]);
		if (t === "bad") return { ok: false, status: 400, error: `${field} must list the exam's syllabus point ids` };
		if (t === null) delete next[field];
		else next[field] = t;
	}
	if (raw.done !== undefined) {
		if (raw.done === null) delete next.done;
		else if (typeof raw.done === "boolean") next.done = raw.done;
		else return { ok: false, status: 400, error: "done must be a boolean or null" };
	}
	updateCalendar((data) => {
		if (Object.keys(next).length) data.occurrences[key] = next;
		else delete data.occurrences[key];
	});
	changed();
	return { ok: true, value: next };
}

/** A date's minutes (`null` = back to the weekday's). */
export function setDayMinutes(body: unknown): Result<{ day: string; minutes: number | null }> {
	const raw = obj(body);
	if (!raw || !isDay(raw.day)) return { ok: false, status: 400, error: "day YYYY-MM-DD required" };
	const day = raw.day;
	const minutes = raw.minutes;
	if (minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 720)) return { ok: false, status: 400, error: "minutes must be an integer 0–720 or null" };
	updateCalendar((data) => {
		if (minutes === null) delete data.dayMinutes[day];
		else data.dayMinutes[day] = minutes;
	});
	changed();
	return { ok: true, value: { day, minutes } };
}

// ─── sessions (owner: what the learner touches is anchored) ─────────────────

/** Every card the shared plan holds (concrete days + late). */
function findItem(state: ExamsState, key: string): CalendarItem | undefined {
	for (const d of state.calendar.plan.days) {
		const hit = d.items.find((i) => i.key === key && i.type === "session");
		if (hit) return hit;
	}
	return state.calendar.plan.late.find((i) => i.key === key);
}

const pinnedRef = (key: string): { id: string; part: number } | null => {
	const m = /^(pin_[a-z0-9_]+)#(\d+)$/.exec(key);
	return m ? { id: m[1]!, part: Number(m[2]) } : null;
};

export type SessionAction =
	| { action: "move"; key: string; day: string; start: string | null }
	| { action: "resize"; key: string; minutes: number }
	| { action: "split"; key: string; minutes: number; day?: string }
	| { action: "merge"; key: string }
	| { action: "release"; key: string };

export function parseSessionAction(body: unknown): Result<SessionAction> {
	const raw = obj(body);
	if (!raw || typeof raw.key !== "string") return { ok: false, status: 400, error: "key required" };
	const key = raw.key;
	const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
	switch (raw.action) {
		case "move":
			if (!isDay(raw.day) || !(raw.start === null || raw.start === undefined || isClock(raw.start))) return { ok: false, status: 400, error: "move needs day and start (HH:MM or null)" };
			return { ok: true, value: { action: "move", key, day: raw.day, start: (raw.start as string | null | undefined) ?? null } };
		case "resize":
			if (!int(raw.minutes, 1, 720)) return { ok: false, status: 400, error: "minutes 1–720" };
			return { ok: true, value: { action: "resize", key, minutes: raw.minutes as number } };
		case "split":
			if (!int(raw.minutes, 1, 720) || !(raw.day === undefined || isDay(raw.day))) return { ok: false, status: 400, error: "split needs minutes (the first sitting) and an optional day" };
			return { ok: true, value: { action: "split", key, minutes: raw.minutes as number, ...(isDay(raw.day) ? { day: raw.day } : {}) } };
		case "merge":
		case "release":
			return { ok: true, value: { action: raw.action, key } };
		default:
			return { ok: false, status: 400, error: "action must be move, resize, split, merge or release" };
	}
}

export function applySessionAction(input: SessionAction, now = Date.now()): Result<{ id: string | null }> {
	const ref = pinnedRef(input.key);
	const nowIso = new Date(now).toISOString();
	if (!ref) {
		// An automatic card: anchored by this touch (release has nothing to do).
		if (input.action === "release" || input.action === "merge") return { ok: true, value: { id: null } };
		const item = findItem(getExamsState(now), input.key);
		if (!item || item.pinned) return { ok: false, status: 404, error: "not_found" };
		const id = newCalendarId("pin");
		const first = { day: item.day, ...(item.hour === "fixed" && item.start ? { start: item.start } : {}), minutes: item.minutes };
		let parts = [first];
		if (input.action === "move") parts = [{ day: input.day, ...(input.start ? { start: input.start } : {}), minutes: item.minutes }];
		else if (input.action === "resize") parts = [{ ...first, minutes: input.minutes }];
		else {
			const split = splitPart(parts, 0, input.minutes, input.day);
			if (!split) return { ok: false, status: 400, error: "the first sitting must be shorter than the session" };
			parts = split;
		}
		const session = anchorFrom(item, id, parts, nowIso);
		updateCalendar((data) => {
			data.pinned.push(session);
		});
		changed();
		return { ok: true, value: { id } };
	}
	const result = updateCalendar((data): Result<{ id: string | null }> => {
		const s = data.pinned.find((p) => p.id === ref.id);
		const part = s?.parts[ref.part];
		if (!s || !part) return { ok: false, status: 404, error: "not_found" };
		switch (input.action) {
			case "move":
				s.parts[ref.part] = { day: input.day, ...(input.start ? { start: input.start } : {}), minutes: part.minutes };
				break;
			case "resize":
				s.parts[ref.part] = { ...part, minutes: input.minutes };
				break;
			case "split": {
				const split = splitPart(s.parts, ref.part, input.minutes, input.day);
				if (!split) return { ok: false, status: 400, error: "the first sitting must be shorter than the session" };
				s.parts = split;
				break;
			}
			case "merge": {
				const minutes = s.parts.reduce((x, p) => x + p.minutes, 0);
				s.parts = [{ ...s.parts[0]!, minutes }];
				break;
			}
			case "release":
				// Back to automatic: a started one keeps its conversation link
				// (it can still be continued) but no longer holds its place.
				if (s.chatId) s.anchored = false;
				else data.pinned = data.pinned.filter((p) => p.id !== s.id);
				return { ok: true, value: { id: null } };
		}
		s.anchored = true;
		return { ok: true, value: { id: s.id } };
	});
	if (result.ok) changed();
	return result;
}

export interface StartedCalendarSession {
	chatId: string;
	title?: string;
	/** The learner's opening message (new sessions only — a resumed
	 *  sitting continues the same conversation). */
	opening?: string;
	resumed: boolean;
}

const whenText = (day: string, start: string | undefined, locale: Locale) => {
	const [y, m, d] = day.split("-").map(Number);
	const [h, mi] = (start ?? "00:00").split(":").map(Number);
	const at = new Date(y!, m! - 1, d!, h!, mi!);
	return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", ...(start ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(at);
};

/** Start (or continue) the session behind a card. */
export function startCalendarSession(key: string, now = Date.now()): Result<StartedCalendarSession> {
	const state = getExamsState(now);
	const item = findItem(state, key);
	if (!item) return { ok: false, status: 404, error: "not_found" };
	if (item.pinned?.chatId) return { ok: true, value: { chatId: item.pinned.chatId, resumed: true } };
	let started: { id: string; title: string; opening: string } | null = null;
	if (item.kind === "repaso") {
		const s = startReviewSession(now);
		if (!s) return { ok: false, status: 409, error: "nothing due" };
		started = s;
	} else if (item.kind === "prepare") {
		const occ = state.calendar.source.occurrences.find((o) => o.key === item.occurrence);
		if (!occ || !item.examId) return { ok: false, status: 404, error: "the class is gone" };
		const locale = effectiveSettings().general.language;
		const r = startPrepareSession(item.examId, { occurrence: occ.key, pointIds: occ.planned, className: occ.title, classWhen: whenText(occ.day, occ.start, locale) });
		if (!r.ok) return r;
		started = r.session;
	} else if (item.examId) {
		const r = startExamSession(item.examId, item.kind as "review" | "placement" | "practice" | "teach", item.pointId ?? item.prerequisiteId, now);
		if (!r.ok) return r;
		started = r.session;
	}
	if (!started) return { ok: false, status: 409, error: "nothing to start" };
	const chatId = started.id;
	updateCalendar((data) => {
		if (item.pinned) {
			const s = data.pinned.find((p) => p.id === item.pinned!.id);
			if (s) s.chatId = chatId;
			return;
		}
		const session: PinnedSession = {
			id: newCalendarId("pin"),
			kind: item.kind as PinnedSession["kind"],
			...(item.examId ? { examId: item.examId } : {}),
			...(item.pointId ? { pointId: item.pointId } : {}),
			...(item.prerequisiteId ? { prerequisiteId: item.prerequisiteId } : {}),
			...(item.short ? { short: true } : {}),
			...(item.occurrence ? { occurrence: item.occurrence } : {}),
			...(item.kind === "repaso" || item.kind === "review" ? { forDay: item.day } : {}),
			parts: [{ day: item.day, ...(item.hour === "fixed" && item.start ? { start: item.start } : {}), minutes: item.minutes }],
			anchored: false,
			chatId,
			createdAt: new Date(now).toISOString(),
		};
		data.pinned.push(session);
	});
	changed();
	return { ok: true, value: { chatId, title: started.title, opening: started.opening, resumed: false } };
}

// ─── imported series ────────────────────────────────────────────────────────

export function setSeriesMeta(body: unknown): Result<ImportedMeta> {
	const raw = obj(body);
	if (!raw || typeof raw.seriesKey !== "string") return { ok: false, status: 400, error: "seriesKey required" };
	const seriesKey = raw.seriesKey;
	const data = readCalendar();
	const feedId = seriesKey.split(":")[0] ?? "";
	if (!data.feeds.some((f) => f.id === feedId)) return { ok: false, status: 404, error: "not_found" };
	const current = data.importedMeta[seriesKey] ?? {};
	const examId = raw.examId === undefined ? current.examId : raw.examId;
	const planned = raw.planned === undefined ? current.planned : raw.planned;
	const assignment = checkAssignment(examId, examId ? planned : undefined);
	if (!assignment.ok) return assignment;
	if (raw.consumes !== undefined && typeof raw.consumes !== "boolean") return { ok: false, status: 400, error: "consumes must be a boolean" };
	if (raw.kind !== undefined && !isEventKind(raw.kind)) return { ok: false, status: 400, error: "kind must be class|seminar|tutoring|selfStudy|other" };
	const meta: ImportedMeta = {
		...assignment.value,
		...((raw.consumes ?? current.consumes) !== undefined ? { consumes: (raw.consumes ?? current.consumes) as boolean } : {}),
		...((raw.kind ?? current.kind) ? { kind: (raw.kind ?? current.kind) as EventKind } : {}),
	};
	updateCalendar((d) => {
		if (Object.keys(meta).length) d.importedMeta[seriesKey] = meta;
		else delete d.importedMeta[seriesKey];
	});
	changed();
	return { ok: true, value: meta };
}

// ─── .ics subscriptions ─────────────────────────────────────────────────────

/** Subscriptions refresh at most this often (owner plan: every 6 h). */
export const FEED_REFRESH_MS = 6 * 3_600_000;
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const FEED_BACK_DAYS = 62;
const FEED_AHEAD_DAYS = 400;

export function normalizeFeedUrl(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim().replace(/^webcals?:\/\//i, "https://");
	try {
		const u = new URL(v);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return u.toString();
	} catch {
		return null;
	}
}

const localToday = (now: number) => {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Fetch one subscription and store its occurrences; the error (if any)
 *  is stored on the feed. */
export async function refreshFeed(id: string, now = Date.now()): Promise<IcsFeed | null> {
	const feed = readCalendar().feeds.find((f) => f.id === id);
	if (!feed) return null;
	let error: string | undefined;
	try {
		const res = await fetch(feed.url, { redirect: "follow", signal: AbortSignal.timeout(FEED_TIMEOUT_MS), headers: { Accept: "text/calendar, */*" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > FEED_MAX_BYTES) throw new Error("the calendar file is too large");
		if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not an iCalendar file");
		const today = localToday(now);
		const occurrences = expandIcs(parseIcs(text), id, addDays(today, -FEED_BACK_DAYS), addDays(today, FEED_AHEAD_DAYS));
		writeFeedOccurrences(id, occurrences);
	} catch (e) {
		error = e instanceof Error ? e.message.slice(0, 300) : "fetch failed";
	}
	let out: IcsFeed | null = null;
	updateCalendar((data) => {
		const f = data.feeds.find((x) => x.id === id);
		if (!f) return;
		f.lastFetch = new Date(now).toISOString();
		if (error) f.error = error;
		else delete f.error;
		out = { ...f };
	});
	changed();
	return out;
}

const REFRESHING_KEY = "__npCalendarFeedsRefreshing";

/** Refresh the subscriptions older than FEED_REFRESH_MS (one run at a time). */
export async function refreshDueFeeds(now = Date.now()): Promise<void> {
	const g = globalThis as unknown as Record<string, boolean | undefined>;
	if (g[REFRESHING_KEY]) return;
	const due = readCalendar().feeds.filter((f) => !f.lastFetch || now - Date.parse(f.lastFetch) >= FEED_REFRESH_MS);
	if (due.length === 0) return;
	g[REFRESHING_KEY] = true;
	try {
		for (const f of due) await refreshFeed(f.id, now);
	} finally {
		g[REFRESHING_KEY] = false;
	}
}

export async function addFeed(body: unknown, now = Date.now()): Promise<Result<IcsFeed>> {
	const raw = obj(body);
	const url = normalizeFeedUrl(raw?.url);
	if (!url) return { ok: false, status: 400, error: "url must be an http(s) or webcal address" };
	const data = readCalendar();
	if (data.feeds.some((f) => f.url === url)) return { ok: false, status: 409, error: "already subscribed" };
	const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : new URL(url).hostname;
	const feed: IcsFeed = { id: newCalendarId("feed"), name, url, addedAt: new Date(now).toISOString() };
	updateCalendar((d) => {
		d.feeds.push(feed);
	});
	const fetched = await refreshFeed(feed.id, now);
	return { ok: true, value: fetched ?? feed };
}

export function renameFeed(id: string, body: unknown): Result<IcsFeed> {
	const raw = obj(body);
	if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, status: 400, error: "name required" };
	const name = raw.name.trim().slice(0, 120);
	const out = updateCalendar((data) => {
		const f = data.feeds.find((x) => x.id === id);
		if (f) f.name = name;
		return f ? { ...f } : null;
	});
	if (!out) return { ok: false, status: 404, error: "not_found" };
	changed();
	return { ok: true, value: out };
}

export function removeFeed(id: string): boolean {
	if (!isFeedId(id)) return false;
	const found = updateCalendar((data) => {
		const before = data.feeds.length;
		data.feeds = data.feeds.filter((f) => f.id !== id);
		for (const key of Object.keys(data.importedMeta)) if (key.startsWith(`${id}:`)) delete data.importedMeta[key];
		for (const key of Object.keys(data.occurrences)) if (key.startsWith(`${id}:`)) delete data.occurrences[key];
		return data.feeds.length !== before;
	});
	if (found) {
		deleteFeedOccurrences(id);
		changed();
	}
	return found;
}

// ─── text helpers for the notices (phase 4) ─────────────────────────────────

export const calendarText = (locale: Locale, key: keyof (typeof MESSAGES)["es"], vars: Record<string, string | number> = {}) => formatMessage(MESSAGES[locale][key], vars, locale);

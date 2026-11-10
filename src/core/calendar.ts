/**
 * «Calendario» (owner design, 2026-11-10 — decisions asked one by one,
 * plan approved «tal cual»). One calendar shared by the exams and Repaso:
 *
 * - Availability: the minutes per weekday the exams already use, optional
 *   usual time slots («franjas») where sessions get a suggested hour, and
 *   per-date overrides («el jueves 12, 0 min»).
 * - Events: class · seminar · tutoring · own study · other — single or
 *   weekly until a date, an occurrence can be cancelled or moved; each
 *   may be assigned to an exam, carry planned topics, and «consume my
 *   study time» (a per-event switch). Imported (.ics) events occupy their
 *   time slots; they subtract minutes only when marked.
 * - A class's topics: planned beforehand AND confirmed afterwards; a
 *   confirmed topic turns «enseñar» into a short afianzado; a planned one
 *   gets a short «preparar clase» session the same day. A class with no
 *   topics is statistics only.
 * - Concrete sessions for the next 7 days; beyond, minutes per exam/day.
 * - Sessions the learner touched (moved, split, hour set) are ANCHORED:
 *   the rest is laid out around them; a missed anchored one stays «late»
 *   and offers to be rescheduled. Automatic ones relocate on their own.
 * - Splitting = the same conversation in several sittings.
 * - Done by content, whatever the day.
 *
 * Pure: no I/O, no clock — the server passes `now` and the derived
 * standing of each exam and of Repaso.
 */
import { addDays, weekdayIndex, type Durations } from "./exams";
import { daysBetween } from "./review";

// ─── data ───────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ["class", "seminar", "tutoring", "selfStudy", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A hand-made event. Weekly events repeat on `day`'s weekday until
 *  `until` (inclusive). */
export interface CalendarEvent {
	id: string;
	title: string;
	kind: EventKind;
	/** First (or only) date, "YYYY-MM-DD". */
	day: string;
	/** Local start "HH:MM". */
	start: string;
	minutes: number;
	until?: string;
	examId?: string;
	/** «Consume mi tiempo de estudio». */
	consumes: boolean;
	/** Topics (syllabus point ids) planned for every occurrence, unless
	 *  an occurrence carries its own. */
	planned?: string[];
	createdAt: string;
}

/** One occurrence's own state, keyed by `occurrenceKey`. */
export interface OccurrenceState {
	cancelled?: boolean;
	moved?: { day: string; start: string };
	/** Planned topics of this occurrence (replaces the event's). */
	planned?: string[];
	/** Confirmed after the class: what was taught ([] = «Nada del
	 *  temario»). Absent = not confirmed yet. */
	confirmed?: string[];
	/** Own study: marked done / not done. */
	done?: boolean;
}

/** A subscribed .ics address (read-only; refreshed every few hours). */
export interface IcsFeed {
	id: string;
	name: string;
	url: string;
	addedAt: string;
	lastFetch?: string;
	error?: string;
}

/** An imported occurrence (expanded from the feed, local time). */
export interface ImportedOccurrence {
	/** `${feedId}:${uid}` — what the assignment hangs on. */
	seriesKey: string;
	title: string;
	day: string;
	/** Absent = all-day (shown, never occupies hours). */
	start?: string;
	minutes: number;
}

/** What the learner set on an imported series (all its occurrences). */
export interface ImportedMeta {
	examId?: string;
	consumes?: boolean;
	kind?: EventKind;
	planned?: string[];
}

export type CalendarSessionKind = "repaso" | "review" | "placement" | "practice" | "teach" | "prepare";

/** One sitting of a session. */
export interface SessionPart {
	day: string;
	/** Fixed local start "HH:MM"; absent = no hour (or suggested). */
	start?: string;
	minutes: number;
}

/**
 * A materialized session: one the learner touched (`anchored`) or one
 * started from the calendar (`chatId`, not anchored). Anchored ones stay
 * where they are; a started one that is left half-done on a past day is
 * released (owner: «lo que falte se recalcula»).
 */
export interface PinnedSession {
	id: string;
	kind: CalendarSessionKind;
	examId?: string;
	pointId?: string;
	prerequisiteId?: string;
	short?: boolean;
	/** prepare: the class occurrence it prepares. */
	occurrence?: string;
	/** repaso / exam review: the day whose due ideas it serves (that
	 *  day's automatic one is not planned again). */
	forDay?: string;
	parts: SessionPart[];
	anchored: boolean;
	chatId?: string;
	createdAt: string;
	/** Done (derived by the server from the content, then stored so it
	 *  survives the content moving on). */
	doneAt?: string;
}

export interface CalendarData {
	version: 1;
	/** Per-date minute overrides. */
	dayMinutes: Record<string, number>;
	events: CalendarEvent[];
	occurrences: Record<string, OccurrenceState>;
	feeds: IcsFeed[];
	importedMeta: Record<string, ImportedMeta>;
	pinned: PinnedSession[];
}

export const emptyCalendar = (): CalendarData => ({ version: 1, dayMinutes: {}, events: [], occurrences: {}, feeds: [], importedMeta: {}, pinned: [] });

/** A usual study slot (Monday-first weekday). */
export interface TimeSlot {
	weekday: number;
	start: string;
	end: string;
}

/** Days with concrete sessions (owner: the next 7). */
export const CONCRETE_DAYS = 7;
/** Sessions shorter than this are not worth a card. */
export const MIN_SESSION_MINUTES = 3;

// ─── clock strings ──────────────────────────────────────────────────────────

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isClock = (v: unknown): v is string => typeof v === "string" && CLOCK.test(v);
export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

export function clockToMinutes(clock: string): number {
	const [h, m] = clock.split(":").map(Number);
	return h! * 60 + m!;
}

export function minutesToClock(minutes: number): string {
	const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ─── sanitizing (the store's read side) ─────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120))] : undefined);
const minutesOf = (v: unknown, max = 24 * 60): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);

export const isEventKind = (v: unknown): v is EventKind => typeof v === "string" && (EVENT_KINDS as readonly string[]).includes(v);
const isSessionKind = (v: unknown): v is CalendarSessionKind =>
	v === "repaso" || v === "review" || v === "placement" || v === "practice" || v === "teach" || v === "prepare";

export function sanitizeEvent(raw: unknown): CalendarEvent | null {
	const r = obj(raw);
	if (!r) return null;
	const id = str(r.id, 80);
	const title = str(r.title);
	const minutes = minutesOf(r.minutes);
	if (!id || !title || !isEventKind(r.kind) || !isDay(r.day) || !isClock(r.start) || !minutes) return null;
	const until = isDay(r.until) && r.until >= r.day ? r.until : undefined;
	return {
		id,
		title,
		kind: r.kind,
		day: r.day,
		start: r.start,
		minutes,
		...(until ? { until } : {}),
		...(str(r.examId, 80) ? { examId: str(r.examId, 80)! } : {}),
		consumes: r.consumes === true,
		...(strings(r.planned)?.length ? { planned: strings(r.planned)! } : {}),
		createdAt: str(r.createdAt, 40) ?? new Date(0).toISOString(),
	};
}

export function sanitizePart(raw: unknown): SessionPart | null {
	const r = obj(raw);
	const minutes = minutesOf(r?.minutes, 12 * 60);
	if (!r || !isDay(r.day) || !minutes) return null;
	return { day: r.day, ...(isClock(r.start) ? { start: r.start } : {}), minutes };
}

function sanitizePinned(raw: unknown): PinnedSession | null {
	const r = obj(raw);
	if (!r || !str(r.id, 80) || !isSessionKind(r.kind) || !Array.isArray(r.parts)) return null;
	const parts = r.parts.map(sanitizePart).filter((p): p is SessionPart => !!p);
	if (parts.length === 0) return null;
	return {
		id: str(r.id, 80)!,
		kind: r.kind,
		...(str(r.examId, 80) ? { examId: str(r.examId, 80)! } : {}),
		...(str(r.pointId, 120) ? { pointId: str(r.pointId, 120)! } : {}),
		...(str(r.prerequisiteId, 120) ? { prerequisiteId: str(r.prerequisiteId, 120)! } : {}),
		...(r.short === true ? { short: true } : {}),
		...(str(r.occurrence, 200) ? { occurrence: str(r.occurrence, 200)! } : {}),
		...(isDay(r.forDay) ? { forDay: r.forDay } : {}),
		parts,
		anchored: r.anchored === true,
		...(str(r.chatId, 120) ? { chatId: str(r.chatId, 120)! } : {}),
		createdAt: str(r.createdAt, 40) ?? new Date(0).toISOString(),
		...(str(r.doneAt, 40) ? { doneAt: str(r.doneAt, 40)! } : {}),
	};
}

function sanitizeOccurrence(raw: unknown): OccurrenceState | null {
	const r = obj(raw);
	if (!r) return null;
	const moved = obj(r.moved);
	const out: OccurrenceState = {
		...(r.cancelled === true ? { cancelled: true } : {}),
		...(moved && isDay(moved.day) && isClock(moved.start) ? { moved: { day: moved.day, start: moved.start } } : {}),
		...(strings(r.planned) ? { planned: strings(r.planned)! } : {}),
		...(strings(r.confirmed) ? { confirmed: strings(r.confirmed)! } : {}),
		...(typeof r.done === "boolean" ? { done: r.done } : {}),
	};
	return Object.keys(out).length ? out : null;
}

export function sanitizeCalendar(raw: unknown): CalendarData {
	const r = obj(raw);
	const out = emptyCalendar();
	if (!r) return out;
	for (const [day, m] of Object.entries(obj(r.dayMinutes) ?? {})) {
		const minutes = minutesOf(m, 720);
		if (isDay(day) && minutes !== undefined) out.dayMinutes[day] = minutes;
	}
	out.events = (Array.isArray(r.events) ? r.events : []).map(sanitizeEvent).filter((e): e is CalendarEvent => !!e);
	for (const [key, v] of Object.entries(obj(r.occurrences) ?? {})) {
		const s = sanitizeOccurrence(v);
		if (s && key.length <= 300) out.occurrences[key] = s;
	}
	out.feeds = (Array.isArray(r.feeds) ? r.feeds : [])
		.map((f) => {
			const x = obj(f);
			const id = str(x?.id, 80);
			const url = str(x?.url, 2000);
			if (!x || !id || !url) return null;
			return {
				id,
				name: str(x.name) ?? url,
				url,
				addedAt: str(x.addedAt, 40) ?? new Date(0).toISOString(),
				...(str(x.lastFetch, 40) ? { lastFetch: str(x.lastFetch, 40)! } : {}),
				...(str(x.error, 300) ? { error: str(x.error, 300)! } : {}),
			};
		})
		.filter((f): f is IcsFeed => !!f);
	for (const [key, v] of Object.entries(obj(r.importedMeta) ?? {})) {
		const x = obj(v);
		if (!x) continue;
		const meta: ImportedMeta = {
			...(str(x.examId, 80) ? { examId: str(x.examId, 80)! } : {}),
			...(typeof x.consumes === "boolean" ? { consumes: x.consumes } : {}),
			...(isEventKind(x.kind) ? { kind: x.kind } : {}),
			...(strings(x.planned) ? { planned: strings(x.planned)! } : {}),
		};
		if (Object.keys(meta).length) out.importedMeta[key] = meta;
	}
	out.pinned = (Array.isArray(r.pinned) ? r.pinned : []).map(sanitizePinned).filter((p): p is PinnedSession => !!p);
	return out;
}

// ─── occurrences ────────────────────────────────────────────────────────────

/** The key an occurrence's state hangs on: the series and its ORIGINAL
 *  date (a moved occurrence keeps its key). */
export const occurrenceKey = (series: string, day: string) => `${series}@${day}`;

export interface Occurrence {
	key: string;
	/** Manual: the event id; imported: `${feedId}:${uid}`. */
	series: string;
	source: "manual" | "feed";
	title: string;
	kind: EventKind;
	/** Where it happens (after a move). */
	day: string;
	start?: string;
	minutes: number;
	examId?: string;
	consumes: boolean;
	planned: string[];
	confirmed?: string[];
	cancelled: boolean;
	done?: boolean;
	/** The class has ended (topics may be confirmed). */
	ended: boolean;
}

/** Every occurrence of the hand-made events and the imported ones with
 *  a date (after moves) in [from, to]. Pure. */
export function expandOccurrences(input: {
	data: Pick<CalendarData, "events" | "occurrences" | "importedMeta">;
	imported: readonly ImportedOccurrence[];
	from: string;
	to: string;
	/** The current local "YYYY-MM-DD" + minutes since midnight (for `ended`). */
	nowDay: string;
	nowMinutes: number;
}): Occurrence[] {
	const out: Occurrence[] = [];
	const ended = (day: string, start: string | undefined, minutes: number) =>
		day < input.nowDay || (day === input.nowDay && (start ? clockToMinutes(start) + minutes : 24 * 60) <= input.nowMinutes);
	const push = (base: Omit<Occurrence, "day" | "start" | "cancelled" | "ended" | "planned" | "confirmed" | "done" | "key">, originalDay: string, start: string | undefined, planned: string[]) => {
		const key = occurrenceKey(base.series, originalDay);
		const state = input.data.occurrences[key] ?? {};
		const day = state.moved?.day ?? originalDay;
		const at = state.moved?.start ?? start;
		if (day < input.from || day > input.to) return;
		out.push({
			...base,
			key,
			day,
			...(at ? { start: at } : {}),
			planned: state.planned ?? planned,
			...(state.confirmed ? { confirmed: state.confirmed } : {}),
			cancelled: state.cancelled === true,
			...(state.done !== undefined ? { done: state.done } : {}),
			ended: ended(day, at, base.minutes),
		});
	};
	// A moved occurrence may land in the window from outside it: scan a
	// margin around the window (moves are bounded to a few weeks).
	const MARGIN = 60;
	const scanFrom = addDays(input.from, -MARGIN);
	const scanTo = addDays(input.to, MARGIN);
	for (const e of input.data.events) {
		const last = e.until ?? e.day;
		const base = { series: e.id, source: "manual" as const, title: e.title, kind: e.kind, minutes: e.minutes, ...(e.examId ? { examId: e.examId } : {}), consumes: e.consumes };
		if (!e.until) {
			push(base, e.day, e.start, e.planned ?? []);
			continue;
		}
		let day = e.day;
		if (day < scanFrom) day = addDays(day, Math.ceil(daysBetween(day, scanFrom) / 7) * 7);
		for (; day <= last && day <= scanTo; day = addDays(day, 7)) push(base, day, e.start, e.planned ?? []);
	}
	for (const o of input.imported) {
		const meta = input.data.importedMeta[o.seriesKey] ?? {};
		push(
			{
				series: o.seriesKey,
				source: "feed",
				title: o.title,
				kind: meta.kind ?? "other",
				minutes: o.minutes,
				...(meta.examId ? { examId: meta.examId } : {}),
				consumes: meta.consumes === true,
			},
			o.day,
			o.start,
			meta.planned ?? [],
		);
	}
	return out.sort((a, b) => a.day.localeCompare(b.day) || (a.start ?? "").localeCompare(b.start ?? ""));
}

/** Syllabus points a class confirmed as taught, per exam (owner: they
 *  become a short afianzado). Own study counts the same way. */
export function classCovered(occurrences: readonly Occurrence[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const o of occurrences) {
		if (!o.examId || o.cancelled || !o.confirmed?.length) continue;
		const set = out.get(o.examId) ?? new Set<string>();
		for (const p of o.confirmed) set.add(p);
		out.set(o.examId, set);
	}
	return out;
}

/** Points a FUTURE (not ended, not cancelled, unconfirmed) occurrence
 *  plans, per exam → the earliest such day. The plan does not teach them
 *  before that class (owner: «avance previo» first, afianzado after). */
export function classPlanned(occurrences: readonly Occurrence[]): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	for (const o of occurrences) {
		if (!o.examId || o.cancelled || o.ended || o.confirmed || o.planned.length === 0) continue;
		const map = out.get(o.examId) ?? new Map<string, string>();
		for (const p of o.planned) if (!map.has(p) || map.get(p)! > o.day) map.set(p, o.day);
		out.set(o.examId, map);
	}
	return out;
}

/** Ended occurrences assigned to an exam whose topics are still to be
 *  confirmed (owner: Naipes asks «¿Qué se dio en…?»). Own study asks
 *  «¿Lo hiciste?» instead (`done` unset). */
export function toConfirm(occurrences: readonly Occurrence[], sinceDay: string): Occurrence[] {
	return occurrences.filter(
		(o) => o.examId && o.ended && !o.cancelled && o.day >= sinceDay && (o.kind === "selfStudy" ? o.done === undefined : o.confirmed === undefined),
	);
}

// ─── budget ─────────────────────────────────────────────────────────────────

/** A date's study minutes: its override, else the weekday's. */
export function baseMinutes(day: string, weeklyMinutes: readonly number[], dayMinutes: Readonly<Record<string, number>>): number {
	return dayMinutes[day] ?? weeklyMinutes[weekdayIndex(day)] ?? 0;
}

/** The minutes an occurrence takes from its day's budget. Own study not
 *  done takes nothing once its day is over. */
export const consumedBy = (o: Occurrence): number => (o.consumes && !o.cancelled && !(o.kind === "selfStudy" && o.done === false) ? o.minutes : 0);

// ─── the plan ───────────────────────────────────────────────────────────────

/** One teach item an exam still owes, in plan order. */
export interface TeachItem {
	pointId?: string;
	prerequisiteId?: string;
	short: boolean;
	minutes: number;
	/** Mode practice it opens once taught (estimate). */
	practiceAfter: number;
}

/** What the server derived for one live exam (claims already removed). */
export interface CalendarExamInput {
	examId: string;
	examDate: string;
	/** Allocation per day from today (planBudget over the calendar's day
	 *  budgets), index 0 = today. */
	allocation: readonly number[];
	/** Dated exam review minutes per concrete day (0 = today, overdue in). */
	reviewDue: readonly number[];
	placement: number;
	practice: number;
	teach: readonly TeachItem[];
}

/** A card on the calendar. */
export interface CalendarItem {
	/** Stable within a computation: the pinned session id + part, the
	 *  occurrence key, or a derived key for an automatic session. */
	key: string;
	type: "session" | "event";
	kind: CalendarSessionKind | EventKind;
	day: string;
	start?: string;
	minutes: number;
	/** fixed = the learner's (or the event's) hour; suggested = placed in a
	 *  free slot by Naipes; none. */
	hour: "fixed" | "suggested" | "none";
	examId?: string;
	pointId?: string;
	prerequisiteId?: string;
	short?: boolean;
	/** prepare / events: the occurrence. */
	occurrence?: string;
	title?: string;
	/** Pinned sessions: their id and which sitting this is. */
	pinned?: { id: string; anchored: boolean; part: number; parts: number; chatId?: string };
	state: "planned" | "inProgress" | "done" | "late";
	/** Events: «consume mi tiempo»; imported or not. */
	consumes?: boolean;
	source?: "manual" | "feed";
	cancelled?: boolean;
}

export interface CalendarDay {
	day: string;
	/** Study minutes of the day (override or weekday). */
	budget: number;
	/** Concrete (within the 7 days) or an estimate per exam. */
	concrete: boolean;
	items: CalendarItem[];
	/** Minutes planned per exam (concrete days: from the items). */
	examMinutes: Record<string, number>;
	/** Repaso minutes planned that day. */
	repasoMinutes: number;
	/** Budget left after everything placed (never below 0). */
	free: number;
}

/** A pinned session's sitting as the planner sees it. */
export interface PinnedPartView {
	session: PinnedSession;
	part: number;
	/** Done (by content, or this sitting's share). */
	done: boolean;
	inProgress: boolean;
}

export interface PlanCalendarInput {
	today: string;
	/** Local minutes since midnight now (today's suggested hours start
	 *  after it). */
	nowMinutes: number;
	/** Days shown (today first). */
	days: readonly string[];
	weeklyMinutes: readonly number[];
	dayMinutes: Readonly<Record<string, number>>;
	slots: readonly TimeSlot[];
	occurrences: readonly Occurrence[];
	pinned: readonly PinnedPartView[];
	/** Repaso minutes per concrete day (0 = today). */
	repaso: readonly number[];
	exams: readonly CalendarExamInput[];
	/** prepare sessions owed (future classes with planned topics). */
	prepare: ReadonlyArray<{ occurrence: string; examId: string; day: string; minutes: number; pointIds: string[] }>;
	/** Study minutes already done today in sessions not on the calendar
	 *  (they used today's budget). */
	doneToday: number;
}

export interface CalendarPlan {
	days: CalendarDay[];
	/** Anchored sittings left on past days, not done (owner: «atrasada»). */
	late: CalendarItem[];
}

const sessionKey = (s: { day: string; kind: string; examId?: string; pointId?: string; prerequisiteId?: string; occurrence?: string }, n: number) =>
	["auto", s.day, s.kind, s.examId ?? "", s.pointId ?? s.prerequisiteId ?? s.occurrence ?? "", n].join(":");

/**
 * Lay the next days out: events, the pinned sittings where they are,
 * then — per concrete day — Repaso, the preparations, and each exam's
 * allocation turned into sessions (dated review → placement test or mode
 * practice → teach, like the exam page's «Hoy»). Days past the concrete
 * window keep their minutes per exam. Suggested hours fill the day's free
 * slots in that order. Pure.
 */
export function planCalendar(input: PlanCalendarInput): CalendarPlan {
	const pools = new Map(
		input.exams.map((e) => [e.examId, { placement: e.placement, practice: e.practice, teach: [...e.teach] }]),
	);
	const late: CalendarItem[] = [];
	const days: CalendarDay[] = input.days.map((day, index) => {
		const concrete = index < CONCRETE_DAYS;
		const budget = baseMinutes(day, input.weeklyMinutes, input.dayMinutes);
		const items: CalendarItem[] = [];
		let left = budget - (index === 0 ? input.doneToday : 0);
		// Events (cancelled ones stay visible, struck through).
		for (const o of input.occurrences) {
			if (o.day !== day) continue;
			items.push({
				key: o.key,
				type: "event",
				kind: o.kind,
				day,
				...(o.start ? { start: o.start } : {}),
				minutes: o.minutes,
				hour: o.start ? "fixed" : "none",
				...(o.examId ? { examId: o.examId } : {}),
				occurrence: o.key,
				title: o.title,
				state: o.cancelled ? "planned" : o.ended ? "done" : "planned",
				consumes: o.consumes,
				source: o.source,
				...(o.cancelled ? { cancelled: true } : {}),
			});
			left -= consumedBy(o);
		}
		const examMinutes: Record<string, number> = {};
		const addExam = (examId: string | undefined, minutes: number) => {
			if (examId) examMinutes[examId] = (examMinutes[examId] ?? 0) + minutes;
		};
		// Pinned sittings of this day.
		for (const view of input.pinned) {
			const part = view.session.parts[view.part]!;
			if (part.day !== day) continue;
			const item = pinnedItem(view);
			items.push(item);
			if (!view.done) {
				left -= part.minutes;
				addExam(view.session.examId, part.minutes);
			}
		}
		let repasoMinutes = 0;
		if (!concrete) {
			// Beyond the window: the exams' minutes only.
			for (const e of input.exams) {
				const m = e.allocation[index] ?? 0;
				if (m > 0) addExam(e.examId, m);
			}
			return { day, budget, concrete, items, examMinutes, repasoMinutes, free: Math.max(0, left - sum(Object.values(examMinutes))) };
		}
		const auto: CalendarItem[] = [];
		const counter = new Map<string, number>();
		const add = (s: Omit<CalendarItem, "key" | "type" | "hour" | "state" | "day">) => {
			const base = { ...s, day };
			const n = (counter.get(s.kind) ?? 0) + 1;
			counter.set(s.kind, n);
			auto.push({ ...base, key: sessionKey(base, n), type: "session", hour: "none", state: "planned" });
			left -= s.minutes;
			addExam(s.examId, s.minutes);
		};
		// 1) Repaso first (owner: forgetting doesn't wait — offered even
		//    past the budget).
		const repaso = Math.round(input.repaso[index] ?? 0);
		if (repaso >= 1) {
			add({ kind: "repaso", minutes: Math.max(MIN_SESSION_MINUTES, repaso) });
			repasoMinutes = Math.max(MIN_SESSION_MINUTES, repaso);
		}
		// 2) «Preparar clase» the day of the class.
		for (const p of input.prepare) if (p.day === day) add({ kind: "prepare", minutes: p.minutes, examId: p.examId, occurrence: p.occurrence });
		// 3) Each exam's share, nearest exam first (the allocation already
		//    orders the budget by urgency).
		const order = [...input.exams].sort((a, b) => a.examDate.localeCompare(b.examDate));
		// What today's teaching opens is practised from tomorrow on (its
		// ideas are extracted after the session).
		const opened = new Map<string, number>();
		for (const e of order) {
			const pool = pools.get(e.examId)!;
			let share = Math.min(Math.max(0, e.allocation[index] ?? 0), Math.max(0, left));
			const review = Math.round(e.reviewDue[index] ?? 0);
			if (review >= 1) {
				add({ kind: "review", minutes: review, examId: e.examId });
				share -= review;
			}
			for (let guard = 0; share >= MIN_SESSION_MINUTES && guard < 12; guard++) {
				if (pool.placement >= MIN_SESSION_MINUTES) {
					const m = Math.round(Math.min(share, pool.placement));
					pool.placement -= m;
					share -= m;
					add({ kind: "placement", minutes: m, examId: e.examId });
					continue;
				}
				if (pool.practice >= MIN_SESSION_MINUTES && !auto.some((a) => a.kind === "practice" && a.examId === e.examId)) {
					const m = Math.round(Math.min(share, pool.practice));
					pool.practice -= m;
					share -= m;
					add({ kind: "practice", minutes: m, examId: e.examId });
					continue;
				}
				const next = pool.teach.shift();
				if (!next) break;
				const m = Math.round(Math.min(share, next.minutes));
				share -= m;
				opened.set(e.examId, (opened.get(e.examId) ?? 0) + next.practiceAfter);
				add({
					kind: "teach",
					minutes: Math.max(MIN_SESSION_MINUTES, m),
					examId: e.examId,
					...(next.pointId ? { pointId: next.pointId } : {}),
					...(next.prerequisiteId ? { prerequisiteId: next.prerequisiteId } : {}),
					...(next.short ? { short: true } : {}),
				});
			}
		}
		for (const [examId, m] of opened) pools.get(examId)!.practice += m;
		const placed = assignHours({
			day,
			slots: input.slots.filter((s) => s.weekday === weekdayIndex(day)),
			busy: items.filter((i) => i.start && !i.cancelled && i.state !== "done").map((i) => ({ start: clockToMinutes(i.start!), end: clockToMinutes(i.start!) + i.minutes })),
			after: index === 0 ? input.nowMinutes : 0,
			sessions: auto,
		});
		items.push(...placed);
		return { day, budget, concrete, items: sortItems(items), examMinutes, repasoMinutes, free: Math.max(0, left) };
	});
	for (const view of input.pinned) {
		const part = view.session.parts[view.part]!;
		if (view.session.anchored && !view.done && part.day < input.today) late.push({ ...pinnedItem(view), state: "late" });
	}
	return { days, late };
}

function pinnedItem(view: PinnedPartView): CalendarItem {
	const s = view.session;
	const part = s.parts[view.part]!;
	return {
		key: `${s.id}#${view.part}`,
		type: "session",
		kind: s.kind,
		day: part.day,
		...(part.start ? { start: part.start } : {}),
		minutes: part.minutes,
		hour: part.start ? "fixed" : "none",
		...(s.examId ? { examId: s.examId } : {}),
		...(s.pointId ? { pointId: s.pointId } : {}),
		...(s.prerequisiteId ? { prerequisiteId: s.prerequisiteId } : {}),
		...(s.short ? { short: true } : {}),
		...(s.occurrence ? { occurrence: s.occurrence } : {}),
		pinned: { id: s.id, anchored: s.anchored, part: view.part, parts: s.parts.length, ...(s.chatId ? { chatId: s.chatId } : {}) },
		state: view.done ? "done" : view.inProgress ? "inProgress" : "planned",
	};
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** Timed items by hour, then the rest in plan order. */
function sortItems(items: CalendarItem[]): CalendarItem[] {
	const timed = items.filter((i) => i.start).sort((a, b) => a.start!.localeCompare(b.start!));
	const rest = items.filter((i) => !i.start);
	return [...timed, ...rest];
}

/**
 * Suggested hours (owner: Naipes places automatic sessions in the free
 * parts of the usual slots, never over a class or an occupying event;
 * no room → no hour). In order, first fit. Pure.
 */
export function assignHours(input: {
	day: string;
	slots: readonly TimeSlot[];
	busy: ReadonlyArray<{ start: number; end: number }>;
	/** Nothing before this minute (today: now). */
	after: number;
	sessions: readonly CalendarItem[];
}): CalendarItem[] {
	// Free intervals = slots minus busy.
	let free: Array<{ start: number; end: number }> = input.slots
		.map((s) => ({ start: Math.max(clockToMinutes(s.start), input.after), end: clockToMinutes(s.end) }))
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start);
	for (const b of input.busy) {
		free = free.flatMap((f) => {
			if (b.end <= f.start || b.start >= f.end) return [f];
			const out: Array<{ start: number; end: number }> = [];
			if (b.start > f.start) out.push({ start: f.start, end: b.start });
			if (b.end < f.end) out.push({ start: b.end, end: f.end });
			return out;
		});
	}
	return input.sessions.map((s) => {
		const fit = free.find((f) => f.end - f.start >= s.minutes);
		if (!fit) return s;
		const start = fit.start;
		fit.start += s.minutes;
		return { ...s, start: minutesToClock(start), hour: "suggested" as const };
	});
}

// ─── editing (the learner touches a session → it is anchored) ───────────────

/** Turn an automatic card into an anchored pinned session (moved, hour
 *  set, or split). */
export function anchorFrom(item: CalendarItem, id: string, parts: SessionPart[], nowIso: string): PinnedSession {
	return {
		id,
		kind: item.kind as CalendarSessionKind,
		...(item.examId ? { examId: item.examId } : {}),
		...(item.pointId ? { pointId: item.pointId } : {}),
		...(item.prerequisiteId ? { prerequisiteId: item.prerequisiteId } : {}),
		...(item.short ? { short: true } : {}),
		...(item.occurrence ? { occurrence: item.occurrence } : {}),
		...(item.kind === "repaso" || item.kind === "review" ? { forDay: item.day } : {}),
		parts,
		anchored: true,
		createdAt: nowIso,
	};
}

/** Split one sitting into two (owner: the same conversation in two
 *  sittings); the second goes to `day` (default: the same day). */
export function splitPart(parts: readonly SessionPart[], index: number, firstMinutes: number, day?: string): SessionPart[] | null {
	const p = parts[index];
	if (!p || firstMinutes < 1 || firstMinutes >= p.minutes) return null;
	const out = [...parts];
	out.splice(index, 1, { ...p, minutes: firstMinutes }, { day: day ?? p.day, minutes: p.minutes - firstMinutes });
	return out;
}

/** Which sitting of a session is done, by the content's progress
 *  (owner: a sitting is done once its share of the active minutes — or
 *  of the batch — is reached, or the whole session is done). `progress`
 *  is 0..1 for batch sessions (covered / picks) or the active minutes. */
export function partsDone(parts: readonly SessionPart[], whole: boolean, progress: { minutes: number } | { share: number } | null): boolean[] {
	if (whole) return parts.map(() => true);
	if (!progress) return parts.map(() => false);
	const total = sum(parts.map((p) => p.minutes));
	let acc = 0;
	return parts.map((p, i) => {
		acc += p.minutes;
		// The last sitting only by the whole (content) being done.
		if (i === parts.length - 1) return false;
		return "minutes" in progress ? progress.minutes >= acc : progress.share * total >= acc - 1e-9;
	});
}

// ─── exam-side helpers ──────────────────────────────────────────────────────

/** Minutes a pinned session still claims from its exam's work. */
export function claimedMinutes(view: readonly PinnedPartView[]): Map<string, { placement: number; practice: number; review: number; teach: Set<string> }> {
	const out = new Map<string, { placement: number; practice: number; review: number; teach: Set<string> }>();
	for (const v of view) {
		const s = v.session;
		if (!s.examId || v.done) continue;
		const c = out.get(s.examId) ?? { placement: 0, practice: 0, review: 0, teach: new Set<string>() };
		const m = s.parts[v.part]!.minutes;
		if (s.kind === "placement") c.placement += m;
		else if (s.kind === "practice") c.practice += m;
		else if (s.kind === "review") c.review += m;
		else if (s.kind === "teach") {
			const id = s.pointId ?? s.prerequisiteId;
			if (id) c.teach.add(id);
		}
		out.set(s.examId, c);
	}
	return out;
}

/** The teach item's minutes from the durations. */
export const teachMinutes = (short: boolean, d: Pick<Durations, "teach" | "consolidate">) => (short ? d.consolidate : d.teach);

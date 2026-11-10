/**
 * A small iCalendar (RFC 5545) reader for «Calendario» (owner 2026-11-10:
 * read calendars by their .ics address — Google, the university, Outlook —
 * with no account). Read-only: VEVENTs with DTSTART/DTEND/DURATION, RRULE
 * (DAILY · WEEKLY with BYDAY · MONTHLY by month day · YEARLY; INTERVAL,
 * COUNT, UNTIL), EXDATE, RECURRENCE-ID overrides and STATUS:CANCELLED.
 * Times with a TZID are read in that zone (Intl), UTC ones as UTC,
 * floating ones as local; everything comes out in the machine's local
 * time. Pure (Intl only).
 */
import type { ImportedOccurrence } from "./calendar";

interface Prop {
	name: string;
	params: Record<string, string>;
	value: string;
}

export interface IcsEvent {
	uid: string;
	summary: string;
	start: IcsTime;
	/** Minutes (0 for all-day events → shown as all-day). */
	minutes: number;
	rrule?: Record<string, string>;
	exdates: number[];
	/** RECURRENCE-ID (an override of one instance), epoch ms. */
	recurrenceId?: number;
	cancelled: boolean;
}

export interface IcsTime {
	/** Wall-clock parts in `zone` (or the date of an all-day event). */
	y: number;
	m: number;
	d: number;
	h: number;
	min: number;
	s: number;
	allDay: boolean;
	/** "UTC", an IANA zone, or undefined (floating = local). */
	zone?: string;
}

/** Unfolded content lines (RFC 5545 §3.1). */
function unfold(text: string): string[] {
	return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
	// NAME;PARAM=VALUE;PARAM="VALUE":value — the first ':' outside quotes.
	let inQuote = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') inQuote = !inQuote;
		else if (c === ":" && !inQuote) {
			colon = i;
			break;
		}
	}
	if (colon < 0) return null;
	const head = line.slice(0, colon).split(";");
	const params: Record<string, string> = {};
	for (const p of head.slice(1)) {
		const eq = p.indexOf("=");
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name: head[0]!.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

function knownZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

export function parseTime(value: string, params: Record<string, string>): IcsTime | null {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
	if (!m) return null;
	const allDay = params.VALUE === "DATE" || m[4] === undefined;
	const zone = m[7] ? "UTC" : params.TZID && knownZone(params.TZID) ? params.TZID : undefined;
	return {
		y: Number(m[1]),
		m: Number(m[2]),
		d: Number(m[3]),
		h: allDay ? 0 : Number(m[4]),
		min: allDay ? 0 : Number(m[5]),
		s: allDay ? 0 : Number(m[6] ?? 0),
		allDay,
		...(allDay ? {} : zone ? { zone } : {}),
	};
}

/** The offset (ms) of `zone` at the instant `utcMs`. */
function zoneOffset(zone: string, utcMs: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(utcMs));
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
	return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** Epoch ms of a wall time. */
export function toEpoch(t: Omit<IcsTime, "allDay"> & { allDay?: boolean }): number {
	if (t.zone === "UTC") return Date.UTC(t.y, t.m - 1, t.d, t.h, t.min, t.s);
	if (!t.zone) return new Date(t.y, t.m - 1, t.d, t.h, t.min, t.s).getTime();
	const guess = Date.UTC(t.y, t.m - 1, t.d, t.h, t.min, t.s);
	// Two passes settle DST edges.
	let at = guess - zoneOffset(t.zone, guess);
	at = guess - zoneOffset(t.zone, at);
	return at;
}

function parseDuration(v: string): number | null {
	const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
	if (!m) return null;
	const minutes = Number(m[2] ?? 0) * 7 * 1440 + Number(m[3] ?? 0) * 1440 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0) + Math.round(Number(m[6] ?? 0) / 60);
	return m[1] === "-" ? 0 : minutes;
}

/** The VEVENTs of a calendar file. Malformed events are skipped. */
export function parseIcs(text: string): IcsEvent[] {
	const out: IcsEvent[] = [];
	let props: Prop[] | null = null;
	let depth = 0;
	for (const line of unfold(text)) {
		const p = parseLine(line);
		if (!p) continue;
		if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") {
			props = [];
			depth = 0;
			continue;
		}
		if (!props) continue;
		if (p.name === "BEGIN") {
			depth++; // VALARM etc.
			continue;
		}
		if (p.name === "END" && depth > 0) {
			depth--;
			continue;
		}
		if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
			const e = eventOf(props);
			if (e) out.push(e);
			props = null;
			continue;
		}
		if (depth === 0) props.push(p);
	}
	return out;
}

function eventOf(props: Prop[]): IcsEvent | null {
	const get = (n: string) => props.find((p) => p.name === n);
	const dtstart = get("DTSTART");
	const start = dtstart ? parseTime(dtstart.value, dtstart.params) : null;
	if (!start) return null;
	const uid = get("UID")?.value.trim() || `${dtstart!.value}-${get("SUMMARY")?.value ?? ""}`;
	let minutes = 0;
	const dtend = get("DTEND");
	const duration = get("DURATION");
	if (!start.allDay) {
		const end = dtend ? parseTime(dtend.value, dtend.params) : null;
		if (end) minutes = Math.max(0, Math.round((toEpoch(end) - toEpoch(start)) / 60_000));
		else if (duration) minutes = parseDuration(duration.value) ?? 0;
	}
	let rrule: Record<string, string> | undefined;
	const rr = get("RRULE");
	if (rr) {
		rrule = {};
		for (const part of rr.value.split(";")) {
			const eq = part.indexOf("=");
			if (eq > 0) rrule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
		}
	}
	const exdates: number[] = [];
	for (const p of props.filter((x) => x.name === "EXDATE")) {
		for (const v of p.value.split(",")) {
			const t = parseTime(v, p.params);
			if (t) exdates.push(toEpoch(t.allDay ? { ...t, h: start.h, min: start.min, s: start.s, ...(start.zone ? { zone: start.zone } : {}) } : t));
		}
	}
	const rid = get("RECURRENCE-ID");
	const ridTime = rid ? parseTime(rid.value, rid.params) : null;
	return {
		uid,
		summary: unescape(get("SUMMARY")?.value ?? "") || "(sin título)",
		start,
		minutes,
		...(rrule ? { rrule } : {}),
		exdates,
		...(ridTime ? { recurrenceId: toEpoch(ridTime) } : {}),
		cancelled: (get("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED",
	};
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/** Occurrences expanded per series at most. */
const MAX_INSTANCES = 1500;

/** Wall-time instances (in the event's zone) of a series, ascending. */
function instances(e: IcsEvent, untilMs: number): Array<Omit<IcsTime, "allDay">> {
	const base = { h: e.start.h, min: e.start.min, s: e.start.s, ...(e.start.zone ? { zone: e.start.zone } : {}) };
	const first = { y: e.start.y, m: e.start.m, d: e.start.d, ...base };
	if (!e.rrule) return [first];
	const r = e.rrule;
	const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
	const count = r.COUNT ? Number(r.COUNT) : Infinity;
	let until = untilMs;
	if (r.UNTIL) {
		const u = parseTime(r.UNTIL, {});
		if (u) until = Math.min(until, u.allDay ? toEpoch({ ...u, h: 23, min: 59, s: 59, ...(e.start.zone ? { zone: e.start.zone } : {}) }) : toEpoch(u));
	}
	const out: Array<Omit<IcsTime, "allDay">> = [];
	const civil = (y: number, m: number, d: number) => {
		const t = new Date(Date.UTC(y, m - 1, d));
		return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
	};
	const emit = (c: { y: number; m: number; d: number }) => {
		const inst = { ...c, ...base };
		const at = toEpoch(inst);
		if (at < toEpoch(first)) return true;
		if (at > until || out.length >= count || out.length >= MAX_INSTANCES) return false;
		out.push(inst);
		return true;
	};
	const freq = r.FREQ;
	if (freq === "DAILY") {
		for (let i = 0; ; i += interval) if (!emit(civil(first.y, first.m, first.d + i))) break;
	} else if (freq === "WEEKLY") {
		const startWd = (new Date(Date.UTC(first.y, first.m - 1, first.d)).getUTCDay() + 6) % 7;
		const days = (r.BYDAY ? r.BYDAY.split(",").map((x) => WEEKDAYS.indexOf(x.slice(-2))).filter((x) => x >= 0) : [startWd]).sort((a, b) => a - b);
		const monday = civil(first.y, first.m, first.d - startWd);
		outer: for (let w = 0; ; w += interval) {
			for (const wd of days) if (!emit(civil(monday.y, monday.m, monday.d + w * 7 + wd))) break outer;
			if (w > MAX_INSTANCES * 7) break;
		}
	} else if (freq === "MONTHLY") {
		const day = r.BYMONTHDAY ? Number(r.BYMONTHDAY.split(",")[0]) : first.d;
		for (let i = 0; ; i += interval) {
			const y = first.y + Math.floor((first.m - 1 + i) / 12);
			const m = ((first.m - 1 + i) % 12) + 1;
			const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
			if (day > last) continue; // e.g. the 31st in a short month
			if (!emit({ y, m, d: day })) break;
			if (i > MAX_INSTANCES) break;
		}
	} else if (freq === "YEARLY") {
		for (let i = 0; ; i += interval) if (!emit({ y: first.y + i, m: first.m, d: first.d })) break;
	} else return [first];
	return out;
}

const localDay = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localClock = (ms: number) => {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The occurrences of a parsed calendar on local days [from, to], for the
 * feed `feedId`. Overrides (RECURRENCE-ID) replace their instance; a
 * cancelled one disappears. Pure.
 */
export function expandIcs(events: readonly IcsEvent[], feedId: string, from: string, to: string): ImportedOccurrence[] {
	const [ty, tm, td] = to.split("-").map(Number);
	const untilMs = new Date(ty!, tm! - 1, td! + 1).getTime();
	const masters = events.filter((e) => e.recurrenceId === undefined);
	const overrides = new Map<string, Map<number, IcsEvent>>();
	for (const e of events) {
		if (e.recurrenceId === undefined) continue;
		const map = overrides.get(e.uid) ?? new Map<number, IcsEvent>();
		map.set(e.recurrenceId, e);
		overrides.set(e.uid, map);
	}
	const out: ImportedOccurrence[] = [];
	const push = (e: IcsEvent, at: number, minutes: number, allDay: boolean) => {
		const day = allDay ? `${e.start.y}-${String(e.start.m).padStart(2, "0")}-${String(e.start.d).padStart(2, "0")}` : localDay(at);
		if (day < from || day > to) return;
		out.push({ seriesKey: `${feedId}:${e.uid}`, title: e.summary, day, ...(allDay ? {} : { start: localClock(at) }), minutes: allDay ? 0 : minutes });
	};
	for (const e of masters) {
		const own = overrides.get(e.uid);
		for (const inst of instances(e, untilMs)) {
			const at = toEpoch(inst);
			if (e.exdates.includes(at)) continue;
			const over = own?.get(at);
			if (over) {
				if (!over.cancelled) push({ ...over, uid: e.uid }, toEpoch(over.start), over.minutes, over.start.allDay);
				continue;
			}
			if (e.cancelled) continue;
			if (e.start.allDay) {
				const d = new Date(Date.UTC(inst.y, inst.m - 1, inst.d));
				push({ ...e, start: { ...e.start, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() } }, at, 0, true);
			} else push(e, at, e.minutes, false);
		}
	}
	// Overrides whose master is missing from the file.
	for (const [uid, map] of overrides) {
		if (masters.some((m) => m.uid === uid)) continue;
		for (const over of map.values()) if (!over.cancelled) push(over, toEpoch(over.start), over.minutes, over.start.allDay);
	}
	return out.sort((a, b) => a.day.localeCompare(b.day) || (a.start ?? "").localeCompare(b.start ?? ""));
}

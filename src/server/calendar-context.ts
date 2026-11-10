/**
 * «Calendario» inputs for the exam plan (owner 2026-11-10). The exam
 * service asks this module, while it computes its state, for: the class
 * topics (covered / still planned), each date's budget once classes,
 * pinned sittings, Repaso and preparations are taken out, and the pinned
 * sittings' claims on each exam's work. It then lays the calendar out
 * (planCalendar) and keeps it on its state, so the exam page, Inicio and
 * the calendar read ONE plan.
 */

import {
	CONCRETE_DAYS,
	baseMinutes,
	classCovered,
	classPlanned,
	consumedBy,
	expandOccurrences,
	partsDone,
	planCalendar,
	type CalendarData,
	type CalendarExamInput,
	type CalendarPlan,
	type ImportedOccurrence,
	type Occurrence,
	type PinnedPartView,
	type PinnedSession,
	type TeachItem,
} from "../core/calendar.ts";
import {
	activeMinutes,
	addDays,
	dayStart,
	DEFAULT_IDEAS_PER_POINT,
	MODE_LEVEL,
	PREREQUISITE_LEVEL,
	type Durations,
	type ExamChat,
	type ExamStandard,
	type ExamStatusModel,
	type WorkBreakdown,
} from "../core/exams.ts";
import { reviewBatchProgress, reviewDayEnd, type ReviewItem } from "../core/review.ts";
import type { NpMessage } from "../core/native-messages.ts";
import { readCalendar, readFeedOccurrences, updateCalendar } from "../store/calendar.ts";

/** Occurrences read around today (month views look back, the plan ahead). */
const LOOK_BACK_DAYS = 62;
const LOOK_AHEAD_DAYS = 400;

const localDay = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localMinutes = (ms: number) => {
	const d = new Date(ms);
	return d.getHours() * 60 + d.getMinutes();
};

/** Epoch ms of a local date + "HH:MM". */
export function clockMoment(day: string, clock: string): number {
	const [y, m, d] = day.split("-").map(Number);
	const [h, mi] = clock.split(":").map(Number);
	return new Date(y!, m! - 1, d!, h!, mi!, 0, 0).getTime();
}

export interface CalendarSource {
	data: CalendarData;
	imported: ImportedOccurrence[];
	occurrences: Occurrence[];
	/** Exam id → points a class confirmed. */
	covered: Map<string, Set<string>>;
	/** Exam id → points a future class plans → that class's day. */
	planned: Map<string, Map<string, string>>;
}

/** The calendar files and their occurrences around `now`. */
export function calendarSource(now: number, today: string): CalendarSource {
	const data = readCalendar();
	const imported = data.feeds.flatMap((f) => readFeedOccurrences(f.id));
	const occurrences = expandOccurrences({
		data,
		imported,
		from: addDays(today, -LOOK_BACK_DAYS),
		to: addDays(today, LOOK_AHEAD_DAYS),
		nowDay: localDay(now),
		nowMinutes: localMinutes(now),
	});
	return { data, imported, occurrences, covered: classCovered(occurrences), planned: classPlanned(occurrences) };
}

/** What the plan knows of one live exam. */
export interface CalendarExamState {
	examId: string;
	examDate: string;
	standard: ExamStandard;
	status: ExamStatusModel;
	work: WorkBreakdown;
	priorityBlocks: readonly string[];
}

export interface CalendarComputed {
	source: CalendarSource;
	plan: CalendarPlan;
	/** Pinned sittings with their done state. */
	pinned: PinnedPartView[];
	/** The days planned (today first). */
	days: string[];
	/** Per exam: the minutes still claimed by pinned sittings. */
	claims: Map<string, number>;
	/** The planBudget day budget (the exam service passes it on). */
	budgetFor: (day: string) => number;
	/** Study minutes done today outside pinned sittings in progress. */
	doneToday: number;
}

const isBatch = (kind: PinnedSession["kind"]) => kind === "review" || kind === "placement" || kind === "practice" || kind === "repaso";

const minutesOn = (messages: readonly NpMessage[], from: number, to: number) =>
	activeMinutes(
		messages.filter((m) => {
			const t = (m as { timestamp?: unknown }).timestamp;
			return typeof t === "number" && t >= from && t < to;
		}),
	);

/** Is a pinned session's content done (owner: by content, any day)? */
function contentDone(s: PinnedSession, chat: ExamChat | undefined, statusOf: (examId: string) => ExamStatusModel | undefined, source: CalendarSource, now: number): boolean {
	if (s.kind === "teach") {
		const status = s.examId ? statusOf(s.examId) : undefined;
		if (!status) return true; // the exam is gone or archived
		if (s.prerequisiteId) {
			const q = status.prerequisites.find((x) => x.id === s.prerequisiteId);
			return !q || !(q.state === "teach" || q.state === "consolidate" || q.state === "placement" || q.state === "taught");
		}
		const p = status.points.find((x) => x.id === s.pointId);
		return !p || (p.taughtSession && p.need !== "teach" && p.need !== "consolidate" && p.need !== "placement");
	}
	if (!chat) return false;
	if (s.kind === "prepare") {
		const total = s.parts.reduce((x, p) => x + p.minutes, 0);
		const occ = source.occurrences.find((o) => o.key === s.occurrence);
		const begun = !!occ && (occ.ended || (occ.start !== undefined && clockMoment(occ.day, occ.start) <= now));
		return begun || activeMinutes(chat.messages) >= total * 0.8;
	}
	return reviewBatchProgress(chat.messages, chat.exam?.pointIds ?? []).done;
}

/** Each pinned sitting with its state; started-only sessions left half
 *  done on a past day are released (owner: «lo que falte se recalcula»). */
export function pinnedViews(input: {
	pinned: readonly PinnedSession[];
	chats: ReadonlyMap<string, ExamChat>;
	statusOf: (examId: string) => ExamStatusModel | undefined;
	source: CalendarSource;
	today: string;
	now: number;
}): { views: PinnedPartView[]; released: string[] } {
	const views: PinnedPartView[] = [];
	const released: string[] = [];
	for (const s of input.pinned) {
		const chat = s.chatId ? input.chats.get(s.chatId) : undefined;
		const whole = contentDone(s, chat, input.statusOf, input.source, input.now);
		const last = s.parts[s.parts.length - 1]!;
		if (!s.anchored && !whole && last.day < input.today) {
			released.push(s.id);
			continue;
		}
		// Done long ago: nothing to show nor to claim.
		if (whole && last.day < addDays(input.today, -LOOK_BACK_DAYS)) continue;
		let progress: { minutes: number } | { share: number } | null = null;
		if (chat) {
			if (isBatch(s.kind)) {
				const p = reviewBatchProgress(chat.messages, chat.exam?.pointIds ?? []);
				progress = { share: p.picks.length ? p.covered.length / p.picks.length : 0 };
			} else progress = { minutes: activeMinutes(chat.messages) };
		}
		const done = partsDone(s.parts, whole, progress);
		s.parts.forEach((_, i) => views.push({ session: s, part: i, done: done[i]!, inProgress: !!chat && !done[i] }));
	}
	return { views, released };
}

/** Items due per day (index 0 = today, overdue in), counted when
 *  `wanted`. */
function duePerDay(items: readonly ReviewItem[], wanted: (nodeId: string) => boolean, days: readonly string[], now: number): number[] {
	const out = new Array<number>(days.length).fill(0);
	if (days.length === 0) return out;
	const todayEnd = reviewDayEnd(now);
	const starts = days.map((d) => dayStart(d));
	for (const i of items) {
		if (i.paused || !i.released || i.due === null || !wanted(i.nodeId)) continue;
		if (i.due < todayEnd) {
			out[0]!++;
			continue;
		}
		// Binary-free scan: days are few.
		for (let k = 1; k < days.length; k++) {
			const end = k + 1 < days.length ? starts[k + 1]! : starts[k]! + 86_400_000;
			if (i.due >= starts[k]! && i.due < end) {
				out[k]!++;
				break;
			}
		}
	}
	return out;
}

/** The teach items an exam owes, in plan order (prerequisites deepest
 *  first, then prioritized blocks, syllabus order), minus the claimed
 *  ones and the points a future class will give (owner: prepared, then
 *  consolidated after). */
function teachQueue(e: CalendarExamState, claimed: ReadonlySet<string>, plannedLater: ReadonlyMap<string, string> | undefined, d: Durations): TeachItem[] {
	const target = MODE_LEVEL[e.standard.mode];
	const out: TeachItem[] = [];
	for (const q of e.status.prerequisites) {
		if (!(q.state === "teach" || q.state === "consolidate") || q.blockedBy.length > 0 || claimed.has(q.id)) continue;
		const short = q.state === "consolidate";
		out.push({ prerequisiteId: q.id, short, minutes: short ? d.consolidate : d.teach, practiceAfter: Math.max(1, q.nodeIds.length) * PREREQUISITE_LEVEL * d.problem });
	}
	const priority = new Set(e.priorityBlocks);
	const points = e.status.points
		.filter((p) => (p.need === "teach" || p.need === "consolidate") && p.blockedBy.length === 0 && !claimed.has(p.id) && !plannedLater?.has(p.id))
		.sort((a, b) => Number(priority.has(b.blockId)) - Number(priority.has(a.blockId)));
	for (const p of points) {
		const short = p.need === "consolidate";
		const open = p.targets ? p.targets.filter((x) => x.nodeIds.length === 0).length : DEFAULT_IDEAS_PER_POINT;
		out.push({ pointId: p.id, short, minutes: short ? d.consolidate : d.teach, practiceAfter: Math.max(1, open) * target * d.problem });
	}
	return out;
}

/** Mode practice available now (the exam page's formula). */
function practiceNow(status: ExamStatusModel, d: Durations): number {
	if (!status.placement.done) return 0;
	return status.ideas.filter((i) => !i.toTeach && !i.blocked && i.level < i.goal).reduce((s, i) => s + (i.goal - i.level) * d.problem, 0);
}

/**
 * The calendar's part of the exam service's state. `allocate` is the
 * service's planBudget call (so the urgency rule stays in one place); it
 * gets each live exam's remaining work after the pinned claims and the
 * per-date budget, and returns the allocation per exam.
 */
export function computeCalendar(input: {
	now: number;
	today: string;
	source: CalendarSource;
	exams: readonly CalendarExamState[];
	items: readonly ReviewItem[];
	chats: readonly ExamChat[];
	durations: Durations;
	weeklyMinutes: readonly number[];
	slots: ReadonlyArray<{ weekday: number; start: string; end: string }>;
	prepareMinutes: number;
	/** Days planned at least (the exams' horizon may be longer). */
	horizon: number;
	allocate: (args: { budgetFor: (day: string) => number; work: Map<string, { work: number; spread: number }> }) => Record<string, number[]>;
}): CalendarComputed {
	const { now, today, source, durations } = input;
	const days = Array.from({ length: Math.max(CONCRETE_DAYS, input.horizon) }, (_, i) => addDays(today, i));
	const statusById = new Map(input.exams.map((e) => [e.examId, e.status]));
	const chatById = new Map(input.chats.map((c) => [c.id, c]));
	const { views, released } = pinnedViews({ pinned: source.data.pinned, chats: chatById, statusOf: (id) => statusById.get(id), source, today, now });
	if (released.length > 0) {
		const gone = new Set(released);
		updateCalendar((data) => {
			data.pinned = data.pinned.filter((p) => !gone.has(p.id));
		});
		source.data.pinned = source.data.pinned.filter((p) => !gone.has(p.id));
	}

	// Study done today (exam + review sessions) that no pinned sitting in
	// progress accounts for.
	const todayStart = dayStart(today);
	const todayEnd = reviewDayEnd(now);
	const openChats = new Set(views.filter((v) => !v.done && v.session.chatId && v.session.parts[v.part]!.day === today).map((v) => v.session.chatId!));
	const doneToday = Math.round(
		input.chats.filter((c) => (c.exam || c.review) && !openChats.has(c.id)).reduce((s, c) => s + minutesOn(c.messages, todayStart, todayEnd), 0),
	);

	// What pinned sittings claim (not done, any day — late ones included).
	const claims = new Map<string, number>();
	const claimedTeach = new Map<string, Set<string>>();
	const claimedKind = new Map<string, { placement: number; practice: number }>();
	const servedDays = new Set<string>(); // `${kind}:${examId}:${day}` for repaso / review
	const pinnedMinutesOn = new Map<string, number>();
	for (const v of views) {
		const s = v.session;
		const part = s.parts[v.part]!;
		if ((s.kind === "repaso" || s.kind === "review") && s.forDay && !(v.done && part.day < today)) servedDays.add(`${s.kind}:${s.examId ?? ""}:${s.forDay}`);
		if (v.done) continue;
		if (part.day >= today) pinnedMinutesOn.set(part.day, (pinnedMinutesOn.get(part.day) ?? 0) + part.minutes);
		if (!s.examId) continue;
		claims.set(s.examId, (claims.get(s.examId) ?? 0) + part.minutes);
		if (s.kind === "teach") {
			const set = claimedTeach.get(s.examId) ?? new Set<string>();
			set.add(s.pointId ?? s.prerequisiteId ?? "");
			claimedTeach.set(s.examId, set);
		}
		if (s.kind === "placement" || s.kind === "practice") {
			const c = claimedKind.get(s.examId) ?? { placement: 0, practice: 0 };
			c[s.kind] += part.minutes;
			claimedKind.set(s.examId, c);
		}
	}

	// Repaso (ideas of no live exam) and each exam's dated review, per day.
	const examNodes = new Map(input.exams.map((e) => [e.examId, new Set(e.status.ideas.map((i) => i.nodeId))]));
	const anyExam = (n: string) => [...examNodes.values()].some((set) => set.has(n));
	const repasoCounts = duePerDay(input.items, (n) => !anyExam(n), days, now);
	const repaso = repasoCounts.map((count, k) => (servedDays.has(`repaso::${days[k]}`) ? 0 : count * durations.review));
	const reviewDue = new Map(
		input.exams.map((e) => {
			const counts = duePerDay(input.items, (n) => examNodes.get(e.examId)!.has(n), days.slice(0, CONCRETE_DAYS), now);
			return [e.examId, counts.map((c, k) => (servedDays.has(`review:${e.examId}:${days[k]}`) ? 0 : c * durations.review))];
		}),
	);

	// «Preparar clase»: future classes with planned topics still to teach.
	const preparedFor = new Set(source.data.pinned.filter((p) => p.kind === "prepare" && p.occurrence).map((p) => p.occurrence!));
	const window = new Set(days.slice(0, CONCRETE_DAYS));
	const prepare = source.occurrences
		.filter((o) => o.examId && statusById.has(o.examId) && !o.cancelled && !o.ended && !o.confirmed && o.planned.length > 0 && window.has(o.day) && !preparedFor.has(o.key))
		.filter((o) => o.planned.some((pid) => statusById.get(o.examId!)!.points.some((p) => p.id === pid && !p.taughtSession && p.need !== "done" && p.need !== "practice")))
		.map((o) => ({ occurrence: o.key, examId: o.examId!, day: o.day, minutes: input.prepareMinutes, pointIds: o.planned }));

	const consumedOn = new Map<string, number>();
	for (const o of source.occurrences) consumedOn.set(o.day, (consumedOn.get(o.day) ?? 0) + consumedBy(o));
	const dayIndex = new Map(days.map((d, i) => [d, i]));
	const budgetFor = (day: string) => {
		const k = dayIndex.get(day);
		let b = baseMinutes(day, input.weeklyMinutes, source.data.dayMinutes) - (consumedOn.get(day) ?? 0) - (pinnedMinutesOn.get(day) ?? 0);
		if (k !== undefined) {
			b -= repaso[k] ?? 0;
			if (k === 0) b -= doneToday;
		}
		b -= prepare.filter((p) => p.day === day).reduce((s, p) => s + p.minutes, 0);
		return Math.max(0, b);
	};

	const work = new Map(
		input.exams.map((e) => {
			const w = Math.max(0, e.work.total - (claims.get(e.examId) ?? 0));
			return [e.examId, { work: w, spread: Math.min(w, e.work.review) }];
		}),
	);
	const allocations = input.allocate({ budgetFor, work });

	const examInputs: CalendarExamInput[] = input.exams.map((e) => {
		const kind = claimedKind.get(e.examId) ?? { placement: 0, practice: 0 };
		return {
			examId: e.examId,
			examDate: e.examDate,
			allocation: allocations[e.examId] ?? [],
			reviewDue: reviewDue.get(e.examId) ?? [],
			placement: Math.max(0, e.work.placement - kind.placement),
			practice: Math.max(0, practiceNow(e.status, durations) - kind.practice),
			teach: teachQueue(e, claimedTeach.get(e.examId) ?? new Set(), source.planned.get(e.examId), durations),
		};
	});

	const plan = planCalendar({
		today,
		nowMinutes: localMinutes(now),
		days,
		weeklyMinutes: input.weeklyMinutes,
		dayMinutes: source.data.dayMinutes,
		slots: input.slots,
		occurrences: source.occurrences.filter((o) => dayIndex.has(o.day)),
		pinned: views,
		repaso,
		exams: examInputs,
		prepare,
		doneToday,
	});
	return { source, plan, pinned: views, days, claims, budgetFor, doneToday };
}

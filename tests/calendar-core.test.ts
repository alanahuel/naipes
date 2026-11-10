/** «Calendario» — the pure model (owner design 2026-11-10): src/core/calendar.ts
 *  and src/core/ics.ts. Synthetic data only — no data dir, no network. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	anchorFrom,
	assignHours,
	classCovered,
	classPlanned,
	emptyCalendar,
	expandOccurrences,
	partsDone,
	planCalendar,
	sanitizeCalendar,
	splitPart,
	toConfirm,
	type CalendarEvent,
	type PlanCalendarInput,
} from "../src/core/calendar";
import { addDays, planBudget } from "../src/core/exams";
import { expandIcs, parseIcs } from "../src/core/ics";

const MON = "2026-11-09"; // a Monday

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	id: "ev1",
	title: "Clase de Química",
	kind: "class",
	day: "2026-11-10",
	start: "09:00",
	minutes: 60,
	consumes: true,
	createdAt: "2026-11-01T00:00:00.000Z",
	...over,
});

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

const baseInput = (over: Partial<PlanCalendarInput> = {}): PlanCalendarInput => ({
	today: MON,
	nowMinutes: 8 * 60,
	days: days(MON, 10),
	weeklyMinutes: [90, 90, 90, 90, 90, 0, 0],
	dayMinutes: {},
	slots: [],
	occurrences: [],
	pinned: [],
	repaso: [],
	exams: [],
	prepare: [],
	doneToday: 0,
	...over,
});

describe("occurrences", () => {
	it("expands a weekly event until its end, with moves and cancellations", () => {
		const data = {
			...emptyCalendar(),
			events: [event({ until: "2026-11-24" })],
			occurrences: { "ev1@2026-11-17": { cancelled: true }, "ev1@2026-11-24": { moved: { day: "2026-11-25", start: "16:00" } } },
		};
		const occ = expandOccurrences({ data, imported: [], from: MON, to: "2026-11-30", nowDay: MON, nowMinutes: 0 });
		assert.deepEqual(
			occ.map((o) => [o.day, o.start, o.cancelled]),
			[
				["2026-11-10", "09:00", false],
				["2026-11-17", "09:00", true],
				["2026-11-25", "16:00", false],
			],
		);
		assert.equal(occ[2]!.key, "ev1@2026-11-24", "a moved occurrence keeps its original key");
	});

	it("marks ended classes and asks to confirm their topics", () => {
		const data = { ...emptyCalendar(), events: [event({ examId: "ex1", planned: ["p1"] })] };
		const before = expandOccurrences({ data, imported: [], from: MON, to: "2026-11-15", nowDay: "2026-11-10", nowMinutes: 9 * 60 + 30 });
		assert.equal(before[0]!.ended, false);
		assert.deepEqual([...classPlanned(before).get("ex1")!.keys()], ["p1"]);
		const after = expandOccurrences({ data, imported: [], from: MON, to: "2026-11-15", nowDay: "2026-11-10", nowMinutes: 10 * 60 });
		assert.equal(after[0]!.ended, true);
		assert.equal(toConfirm(after, MON).length, 1);
		assert.equal(classPlanned(after).size, 0, "an ended class no longer holds its topics back");
		const confirmed = expandOccurrences({
			data: { ...data, occurrences: { "ev1@2026-11-10": { confirmed: ["p1", "p2"] } } },
			imported: [],
			from: MON,
			to: "2026-11-15",
			nowDay: "2026-11-11",
			nowMinutes: 0,
		});
		assert.equal(toConfirm(confirmed, MON).length, 0);
		assert.deepEqual([...classCovered(confirmed).get("ex1")!], ["p1", "p2"]);
	});

	it("imported series take their meta (exam, consume) from the learner", () => {
		const data = { ...emptyCalendar(), importedMeta: { "f1:abc": { examId: "ex1", consumes: true, kind: "seminar" as const } } };
		const occ = expandOccurrences({
			data,
			imported: [{ seriesKey: "f1:abc", title: "Seminario", day: "2026-11-11", start: "18:00", minutes: 90 }],
			from: MON,
			to: "2026-11-15",
			nowDay: MON,
			nowMinutes: 0,
		});
		assert.equal(occ[0]!.kind, "seminar");
		assert.equal(occ[0]!.examId, "ex1");
		assert.equal(occ[0]!.consumes, true);
	});
});

describe("planCalendar", () => {
	it("Repaso first, then the exam's review → placement → teach, within the day's minutes", () => {
		const plan = planCalendar(
			baseInput({
				repaso: [10],
				exams: [
					{
						examId: "ex1",
						examDate: "2026-12-01",
						allocation: [80, 80],
						reviewDue: [6, 0],
						placement: 30,
						practice: 0,
						teach: [{ pointId: "p1", short: false, minutes: 25, practiceAfter: 12 }],
					},
				],
			}),
		);
		const today = plan.days[0]!;
		assert.deepEqual(
			today.items.map((i) => [i.kind, i.minutes]),
			[
				["repaso", 10],
				["review", 6],
				["placement", 30],
				["teach", 25],
			],
		);
		assert.equal(today.repasoMinutes, 10);
		assert.equal(today.examMinutes.ex1, 61);
		// Day 2: the practice the taught point opened.
		assert.deepEqual(plan.days[1]!.items.map((i) => [i.kind, i.minutes]), [["practice", 12]]);
	});

	it("a class that consumes time takes it from the day; one that doesn't, only occupies its hours", () => {
		const occurrences = expandOccurrences({
			data: { ...emptyCalendar(), events: [event({ day: MON, start: "17:00", consumes: true }), event({ id: "ev2", day: MON, start: "19:00", consumes: false })] },
			imported: [],
			from: MON,
			to: addDays(MON, 9),
			nowDay: MON,
			nowMinutes: 0,
		});
		const plan = planCalendar(baseInput({ occurrences, slots: [{ weekday: 0, start: "16:00", end: "21:00" }] }));
		assert.equal(plan.days[0]!.free, 30);
		const timed = plan.days[0]!.items.filter((i) => i.type === "event").map((i) => i.start);
		assert.deepEqual(timed, ["17:00", "19:00"]);
	});

	it("days past the concrete window carry minutes per exam only", () => {
		const plan = planCalendar(
			baseInput({
				exams: [{ examId: "ex1", examDate: "2026-12-01", allocation: Array(10).fill(40), reviewDue: [], placement: 1000, practice: 0, teach: [] }],
			}),
		);
		assert.equal(plan.days[6]!.concrete, true);
		assert.equal(plan.days[7]!.concrete, false);
		assert.equal(plan.days[7]!.items.length, 0);
		assert.equal(plan.days[7]!.examMinutes.ex1, 40);
	});

	it("pinned sittings stay put and take their minutes; a missed anchored one is late", () => {
		const session = {
			id: "pin1",
			kind: "teach" as const,
			examId: "ex1",
			pointId: "p1",
			parts: [
				{ day: addDays(MON, -1), minutes: 15 },
				{ day: addDays(MON, 2), start: "18:00", minutes: 10 },
			],
			anchored: true,
			createdAt: "2026-11-01T00:00:00.000Z",
		};
		const plan = planCalendar(
			baseInput({
				pinned: [
					{ session, part: 0, done: false, inProgress: false },
					{ session, part: 1, done: false, inProgress: false },
				],
			}),
		);
		assert.equal(plan.late.length, 1);
		assert.equal(plan.late[0]!.state, "late");
		const wed = plan.days[2]!;
		assert.equal(wed.items[0]!.pinned?.part, 1);
		assert.equal(wed.items[0]!.hour, "fixed");
		assert.equal(wed.free, 80);
	});

	it("doneToday comes off today's budget", () => {
		const plan = planCalendar(baseInput({ doneToday: 50 }));
		assert.equal(plan.days[0]!.free, 40);
	});
});

describe("hours", () => {
	it("suggested hours fill free slots, around busy ones and after now", () => {
		const sessions = [
			{ key: "a", type: "session" as const, kind: "repaso" as const, day: MON, minutes: 20, hour: "none" as const, state: "planned" as const },
			{ key: "b", type: "session" as const, kind: "teach" as const, day: MON, minutes: 30, hour: "none" as const, state: "planned" as const },
			{ key: "c", type: "session" as const, kind: "practice" as const, day: MON, minutes: 120, hour: "none" as const, state: "planned" as const },
		];
		const out = assignHours({
			day: MON,
			slots: [{ weekday: 0, start: "17:00", end: "19:00" }],
			busy: [{ start: 17 * 60 + 30, end: 18 * 60 }],
			after: 17 * 60 + 5,
			sessions,
		});
		assert.deepEqual(
			out.map((s) => [s.key, s.start, s.hour]),
			[
				["a", "17:05", "suggested"],
				["b", "18:00", "suggested"],
				["c", undefined, "none"],
			],
		);
	});
});

describe("editing", () => {
	it("anchors an automatic card and splits a sitting", () => {
		const pinned = anchorFrom(
			{ key: "auto:x", type: "session", kind: "teach", day: MON, minutes: 25, hour: "none", examId: "ex1", pointId: "p3", state: "planned" },
			"pin9",
			[{ day: MON, minutes: 25 }],
			"2026-11-09T10:00:00.000Z",
		);
		assert.equal(pinned.anchored, true);
		assert.equal(pinned.pointId, "p3");
		const parts = splitPart(pinned.parts, 0, 15, addDays(MON, 1))!;
		assert.deepEqual(parts, [
			{ day: MON, minutes: 15 },
			{ day: addDays(MON, 1), minutes: 10 },
		]);
		assert.equal(splitPart(pinned.parts, 0, 25), null);
	});

	it("a sitting is done by its share; the last one only when the content is", () => {
		const parts = [
			{ day: MON, minutes: 15 },
			{ day: MON, minutes: 10 },
		];
		assert.deepEqual(partsDone(parts, false, { minutes: 16 }), [true, false]);
		assert.deepEqual(partsDone(parts, false, { share: 0.5 }), [false, false]);
		assert.deepEqual(partsDone(parts, false, { share: 0.6 }), [true, false]);
		assert.deepEqual(partsDone(parts, true, null), [true, true]);
	});

	it("sanitizes junk away", () => {
		const data = sanitizeCalendar({
			events: [event(), { id: "bad" }],
			pinned: [{ id: "p", kind: "teach", parts: [{ day: "nope", minutes: 3 }] }],
			dayMinutes: { "2026-11-12": 0, bad: 3 },
		});
		assert.equal(data.events.length, 1);
		assert.equal(data.pinned.length, 0);
		assert.deepEqual(data.dayMinutes, { "2026-11-12": 0 });
	});
});

describe("planBudget with day budgets", () => {
	it("uses the calendar's budget per date", () => {
		const plan = planBudget({
			today: MON,
			weeklyMinutes: [60, 60, 60, 60, 60, 60, 60],
			exams: [{ examId: "ex1", examDate: addDays(MON, 3), work: 100 }],
			budgetFor: (day) => (day === MON ? 0 : 60),
		});
		assert.deepEqual(plan.allocations.ex1, [0, 60, 40]);
	});
});

describe("ics", () => {
	const ics = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:clase-1",
		"SUMMARY:Química\\, grupo A",
		"DTSTART;TZID=Europe/Madrid:20261110T090000",
		"DTEND;TZID=Europe/Madrid:20261110T103000",
		"RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4",
		"EXDATE;TZID=Europe/Madrid:20261112T090000",
		"BEGIN:VALARM",
		"TRIGGER:-PT10M",
		"END:VALARM",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:clase-1",
		"RECURRENCE-ID;TZID=Europe/Madrid:20261117T090000",
		"SUMMARY:Química (aula 2)",
		"DTSTART;TZID=Europe/Madrid:20261117T110000",
		"DTEND;TZID=Europe/Madrid:20261117T120000",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:fiesta",
		"SUMMARY:Festivo",
		"DTSTART;VALUE=DATE:20261208",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	it("expands RRULE with EXDATE and overrides (local time = Europe/Madrid here)", () => {
		const events = parseIcs(ics);
		assert.equal(events.length, 3);
		const occ = expandIcs(events, "f1", "2026-11-01", "2026-12-31");
		const madrid = Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Madrid";
		assert.deepEqual(
			occ.map((o) => [o.day, madrid ? o.start : "-", o.minutes, o.title]),
			[
				["2026-11-10", madrid ? "09:00" : "-", 90, "Química, grupo A"],
				["2026-11-17", madrid ? "11:00" : "-", 60, "Química (aula 2)"],
				["2026-11-19", madrid ? "09:00" : "-", 90, "Química, grupo A"],
				["2026-12-08", madrid ? undefined : "-", 0, "Festivo"],
			],
		);
		assert.equal(occ[0]!.seriesKey, "f1:clase-1");
	});

	it("skips malformed events and unfolds long lines", () => {
		const events = parseIcs("BEGIN:VEVENT\r\nSUMMARY:Lar\r\n go\r\nDTSTART:20261110T100000Z\r\nDURATION:PT45M\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT");
		assert.equal(events.length, 1);
		assert.equal(events[0]!.summary, "Largo");
		assert.equal(events[0]!.minutes, 45);
	});
});

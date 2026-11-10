/** «Calendario» UI (owner 2026-11-10): the pure helpers of
 *  components/calendar.tsx and the settings section's static render. */
import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { beginCalendarSession, calendarTabFromParam, itemLabel, lanes, mondayOf, monthGrid, usedMinutes } from "../components/calendar.tsx";
import { CalendarSettingsSection } from "../components/settings/calendar-section.tsx";
import { translator } from "../components/i18n.tsx";
import type { CalendarExamView, CalendarItem } from "../src/core/index.ts";

const es = translator("es");
const exams: CalendarExamView[] = [
	{ id: "ex1", title: "Química", examDate: "2026-12-01", points: [{ id: "p1", text: "Enlace químico", blockTitle: "Tema 1" }], prerequisites: [{ id: "q1", statement: "Fracciones" }] },
];
const item = (over: Partial<CalendarItem>): CalendarItem => ({ key: "k", type: "session", kind: "teach", day: "2026-11-10", minutes: 25, hour: "none", state: "planned", ...over });

describe("calendar labels", () => {
	it("names each kind of card", () => {
		assert.equal(itemLabel(item({ kind: "repaso", count: 8 }), exams, es), "Repaso · 8 ideas");
		assert.equal(itemLabel(item({ kind: "repaso", count: 1 }), exams, es), "Repaso · 1 idea");
		assert.equal(itemLabel(item({ kind: "teach", examId: "ex1", pointId: "p1" }), exams, es), "Química · Enseñar «Enlace químico»");
		assert.equal(itemLabel(item({ kind: "teach", examId: "ex1", prerequisiteId: "q1", short: true }), exams, es), "Química · Afianzar «Fracciones»");
		assert.equal(itemLabel(item({ kind: "placement", examId: "ex1" }), exams, es), "Química · Prueba de nivel");
		assert.equal(itemLabel(item({ kind: "prepare", examId: "ex1" }), exams, es), "Preparar clase · Química");
		assert.equal(itemLabel(item({ type: "event", kind: "class", title: "Clase" }), exams, es), "Clase");
		assert.equal(
			itemLabel(item({ kind: "practice", examId: "ex1", pinned: { id: "pin_x", anchored: true, part: 0, parts: 2 } }), exams, es),
			"Química · Practicar (1/2)",
		);
	});

	it("counts the day's minutes: study cards and classes that consume time", () => {
		const day = {
			concrete: true,
			repasoMinutes: 0,
			examMinutes: {},
			items: [item({ minutes: 20 }), item({ type: "event", kind: "class", minutes: 60, consumes: true }), item({ type: "event", kind: "other", minutes: 30, consumes: false }), item({ type: "event", kind: "class", minutes: 60, consumes: true, cancelled: true })],
		};
		assert.equal(usedMinutes(day), 80);
		assert.equal(usedMinutes({ concrete: false, repasoMinutes: 10, examMinutes: { ex1: 40 }, items: [] }), 50);
	});
});

describe("calendar grids", () => {
	it("the month grid runs Monday to Sunday around the month", () => {
		const g = monthGrid("2026-11");
		assert.equal(g[0], "2026-10-26");
		assert.equal(g[g.length - 1], "2026-12-06");
		assert.equal(g.length % 7, 0);
		assert.equal(mondayOf("2026-11-15"), "2026-11-09");
	});

	it("overlapping cards share the column in lanes", () => {
		const l = lanes([
			{ key: "a", start: 600, end: 660 },
			{ key: "b", start: 630, end: 690 },
			{ key: "c", start: 700, end: 720 },
		]);
		assert.deepEqual(l.get("a"), { lane: 0, of: 2 });
		assert.deepEqual(l.get("b"), { lane: 1, of: 2 });
		assert.deepEqual(l.get("c"), { lane: 0, of: 1 });
	});

	it("tabs come from the URL, default Agenda", () => {
		assert.equal(calendarTabFromParam("week"), "week");
		assert.equal(calendarTabFromParam("nope"), "agenda");
		assert.equal(calendarTabFromParam(undefined), "agenda");
	});
});

describe("starting a card", () => {
	const fake = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
	it("stashes the opening of a new session; a resumed one has none", async () => {
		const stashed: string[] = [];
		assert.equal(await beginCalendarSession(fake(201, { chatId: "chat_1", opening: "Hola", resumed: false }), "k", (id, text) => (stashed.push(`${id}:${text}`), true)), "chat_1");
		assert.deepEqual(stashed, ["chat_1:Hola"]);
		assert.equal(await beginCalendarSession(fake(200, { chatId: "chat_2", resumed: true }), "k", () => false), "chat_2");
		assert.equal(await beginCalendarSession(fake(409, { error: "x" }), "k"), null);
		assert.equal(await beginCalendarSession(fake(200, { chatId: "../x" }), "k"), null);
	});
});

describe("Settings → Calendario", () => {
	it("renders the minutes per day, the slots per weekday and the knobs", () => {
		const html = renderToStaticMarkup(
			<CalendarSettingsSection calendar={{ slots: [{ weekday: 0, start: "17:00", end: "19:00" }] }} exams={{}} onCalendarChange={() => {}} onExamsChange={() => {}} />,
		);
		for (const id of ["exam-weekly", "calendar-slots-0", "calendar-slots-6", "calendar-alertMinutes", "calendar-prepareMinutes"]) assert.ok(html.includes(id), id);
		assert.ok(html.includes("17:00–19:00"));
	});
});

/** «Calendario» service end to end (owner 2026-11-10): an isolated
 *  temporary data dir (NP_DATA_DIR set before any import), synthetic
 *  graph, one active exam, a local .ics server. No real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-calendar-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const exams = await import("../src/server/exams.ts");
const cal = await import("../src/server/calendar.ts");
const { getChat } = await import("../src/server/chats.ts");
const { numberBlocks, addDays } = await import("../src/core/exams.ts");
const { reviewDay } = await import("../src/core/review.ts");

const now = new Date(2026, 10, 10, 8, 0).getTime(); // Tue 10 Nov 2026, 08:00
const today = reviewDay(now);
fs.mkdirSync(path.join(DIR, "chats"), { recursive: true });
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
fs.writeFileSync(path.join(DIR, "graph", "nodes.jsonl"), "");

const blocks = numberBlocks([{ title: "Química", points: [{ text: "Enlace químico", nodeIds: [] }, { text: "Estequiometría", nodeIds: [] }] }]);
const created = exams.parseExamCreate({ title: "Química", examDate: addDays(today, 20), syllabus: { text: "x" } });
assert.ok(created.ok);
const exam = exams.createExam(created.value, now);
const patch = exams.parseExamPatch({ blocks, status: "active" });
assert.ok(patch.ok);
const activated = exams.updateExam(exam.id, patch.value, now);
assert.ok(activated.ok, JSON.stringify(activated));

const sessionsOn = (view: ReturnType<typeof cal.calendarView>, day: string) => view.days.find((d) => d.day === day)!.items.filter((i) => i.type === "session");

describe("calendar service (isolated data dir)", () => {
	it("today plans the placement test of the active exam", () => {
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		assert.equal(view.days.length, 7);
		assert.equal(view.exams[0]!.id, exam.id);
		const s = sessionsOn(view, today);
		assert.ok(s.some((i) => i.kind === "placement" && i.examId === exam.id));
	});

	it("a class with a planned topic: preparation that day, the topic waits; confirmed → afianzado", () => {
		const bad = cal.createCalendarEvent({ title: "Clase", kind: "class", day: today, start: "9:00", minutes: 60, consumes: true });
		assert.equal(bad.ok, false);
		const created = cal.createCalendarEvent({ title: "Clase de Química", kind: "class", day: addDays(today, 1), start: "16:00", minutes: 60, consumes: true, examId: exam.id, planned: ["p1"], until: addDays(today, 15) }, now);
		assert.ok(created.ok);
		const ev = created.ok ? created.value : (null as never);
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const tomorrow = view.days[1]!;
		assert.ok(tomorrow.items.some((i) => i.type === "event" && i.title === "Clase de Química" && i.start === "16:00"));
		assert.ok(tomorrow.items.some((i) => i.kind === "prepare"));
		const anyTeachP1 = view.days.flatMap((d) => d.items).some((i) => i.kind === "teach" && i.pointId === "p1");
		assert.equal(anyTeachP1, false, "p1 is not taught before its class");
		// After the class: confirm what was taught.
		const later = new Date(2026, 10, 11, 18, 0).getTime();
		const v2 = cal.calendarView({ from: reviewDay(later), to: addDays(reviewDay(later), 6) }, later);
		assert.equal(v2.toConfirm.length, 1);
		const key = v2.toConfirm[0]!.key;
		assert.equal(key, `${ev.id}@${addDays(today, 1)}`);
		assert.equal(cal.updateOccurrence({ key, confirmed: ["nope"] }, later).ok, false);
		assert.ok(cal.updateOccurrence({ key, confirmed: ["p1"] }, later).ok);
		const detail = exams.examDetailView(exam.id, later)!;
		const p1 = detail.model!.points.find((p) => p.id === "p1")!;
		assert.equal(p1.classCovered, true);
		assert.equal(p1.need, "consolidate");
		assert.ok(!detail.model!.placement.pendingPoints.includes("p1"), "a topic given in class is not probed");
		// Clean up: the event goes.
		assert.ok(cal.deleteCalendarEvent(ev.id));
	});

	it("a date's minutes override the weekday", () => {
		const day = addDays(today, 2);
		assert.ok(cal.setDayMinutes({ day, minutes: 0 }).ok);
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const d = view.days.find((x) => x.day === day)!;
		assert.equal(d.budget, 0);
		assert.equal(sessionsOn(view, day).filter((i) => i.kind !== "repaso" && i.kind !== "review").length, 0);
		assert.ok(cal.setDayMinutes({ day, minutes: null }).ok);
	});

	it("moving an automatic card anchors it; splitting gives two sittings; release returns it", () => {
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const card = sessionsOn(view, today).find((i) => i.kind === "placement")!;
		const target = addDays(today, 3);
		const moved = cal.applySessionAction({ action: "move", key: card.key, day: target, start: "18:00" }, now);
		assert.ok(moved.ok);
		const id = moved.ok ? moved.value.id! : "";
		const v2 = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const pinned = sessionsOn(v2, target).find((i) => i.pinned?.id === id)!;
		assert.equal(pinned.start, "18:00");
		assert.equal(pinned.hour, "fixed");
		assert.equal(pinned.pinned!.anchored, true);
		const split = cal.applySessionAction({ action: "split", key: pinned.key, minutes: 5, day: addDays(today, 4) }, now);
		assert.ok(split.ok);
		const v3 = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const parts = v3.days.flatMap((d) => d.items).filter((i) => i.pinned?.id === id);
		assert.deepEqual(parts.map((p) => [p.day, p.minutes, p.pinned!.part]), [
			[target, 5, 0],
			[addDays(today, 4), pinned.minutes - 5, 1],
		]);
		assert.ok(cal.applySessionAction({ action: "release", key: parts[0]!.key }, now).ok);
		const v4 = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		assert.equal(v4.days.flatMap((d) => d.items).filter((i) => i.pinned?.id === id).length, 0);
	});

	it("a missed anchored sitting is late; it never moves alone", () => {
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const card = sessionsOn(view, today).find((i) => i.kind === "placement")!;
		const moved = cal.applySessionAction({ action: "move", key: card.key, day: today, start: "20:00" }, now);
		assert.ok(moved.ok);
		const later = new Date(2026, 10, 12, 9, 0).getTime();
		const v2 = cal.calendarView({ from: reviewDay(later), to: addDays(reviewDay(later), 6) }, later);
		assert.equal(v2.late.length, 1);
		assert.equal(v2.late[0]!.day, today);
		const resched = cal.applySessionAction({ action: "move", key: v2.late[0]!.key, day: reviewDay(later), start: null }, later);
		assert.ok(resched.ok);
		const v3 = cal.calendarView({ from: reviewDay(later), to: addDays(reviewDay(later), 6) }, later);
		assert.equal(v3.late.length, 0);
		assert.ok(cal.applySessionAction({ action: "release", key: `${moved.ok ? moved.value.id : ""}#0` }, later).ok);
	});

	it("starting a card creates the exam session and pins it; starting again continues it", () => {
		const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const card = sessionsOn(view, today).find((i) => i.kind === "placement")!;
		const started = cal.startCalendarSession(card.key, now);
		assert.ok(started.ok);
		const value = started.ok ? started.value : (null as never);
		assert.equal(value.resumed, false);
		assert.equal(value.opening, "Empecemos la prueba de nivel.");
		assert.equal(getChat(value.chatId)!.exam!.kind, "placement");
		const v2 = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
		const pinned = sessionsOn(v2, today).find((i) => i.pinned?.chatId === value.chatId)!;
		assert.ok(pinned, "the started card is pinned to its chat");
		assert.equal(pinned.pinned!.anchored, false);
		const again = cal.startCalendarSession(pinned.key, now);
		assert.ok(again.ok && again.value.resumed && again.value.chatId === value.chatId);
		// Left half-done: the next day it is released, its content back to automatic.
		const next = new Date(2026, 10, 11, 9, 0).getTime();
		const v3 = cal.calendarView({ from: reviewDay(next), to: addDays(reviewDay(next), 6) }, next);
		assert.equal(v3.days.flatMap((d) => d.items).filter((i) => i.pinned?.chatId === value.chatId).length, 0);
		assert.equal(v3.late.length, 0);
	});

	it("subscribes to an .ics address; imported events occupy hours and take exam assignments", async () => {
		const day = addDays(today, 1).replaceAll("-", "");
		const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:sem-1", "SUMMARY:Seminario", `DTSTART:${day}T170000`, `DTEND:${day}T183000`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/calendar" });
			res.end(ics);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			assert.equal((await cal.addFeed({ url: "ftp://x" }, now)).ok, false);
			const added = await cal.addFeed({ url: `http://127.0.0.1:${port}/cal.ics`, name: "Uni" }, now);
			assert.ok(added.ok);
			const feed = added.ok ? added.value : (null as never);
			assert.equal(feed.error, undefined);
			const view = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
			const ev = view.days[1]!.items.find((i) => i.type === "event" && i.title === "Seminario")!;
			assert.equal(ev.start, "17:00");
			assert.equal(ev.minutes, 90);
			assert.equal(ev.consumes, false);
			assert.equal(view.series.length, 1);
			const meta = cal.setSeriesMeta({ seriesKey: view.series[0]!.seriesKey, examId: exam.id, consumes: true, kind: "seminar" });
			assert.ok(meta.ok);
			const v2 = cal.calendarView({ from: today, to: addDays(today, 6) }, now);
			const ev2 = v2.days[1]!.items.find((i) => i.type === "event" && i.title === "Seminario")!;
			assert.equal(ev2.kind, "seminar");
			assert.equal(ev2.examId, exam.id);
			assert.equal(v2.days[1]!.free, Math.max(0, v2.days[1]!.free));
			assert.ok(cal.removeFeed(feed.id));
			assert.equal(cal.calendarView({ from: today, to: addDays(today, 6) }, now).series.length, 0);
		} finally {
			server.close();
		}
	});

	it("notices: alert before a fixed hour (once), none for suggested hours; «¿Qué se dio?» after the class; agenda digest and evening", () => {
		const day = addDays(today, 7);
		const ev = cal.createCalendarEvent({ title: "Tutoría", kind: "tutoring", day, start: "17:00", minutes: 30, consumes: false, examId: exam.id }, now);
		assert.ok(ev.ok);
		const at = (h: number, m: number) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)), h, m).getTime();
		assert.equal(cal.calendarDeskNotice("calendar", at(16, 40)).notify, false, "20 min before: outside the 10-min lead");
		const alert = cal.calendarDeskNotice("calendar", at(16, 52));
		assert.equal(alert.notify, true);
		assert.equal(alert.title, "Tutoría a las 17:00");
		assert.equal(alert.body, "Empieza en 8 min.");
		assert.equal(alert.path, "/calendar");
		// Suggested-hour sessions get no alert: the next tick finds nothing.
		assert.equal(cal.calendarDeskNotice("calendar", at(16, 53)).notify, false, "once per item; suggested hours never alert");
		const confirm = cal.calendarDeskNotice("calendar", at(17, 40));
		assert.equal(confirm.title, "¿Qué se dio en Tutoría?");
		assert.equal(confirm.body, "Márcalo y tu plan se ajusta.");
		assert.equal(cal.calendarDeskNotice("calendar", at(17, 41)).notify, false);
		const digest = cal.calendarDeskNotice("digest", at(9, 30));
		assert.equal(digest.notify, true);
		assert.match(digest.title!, /^Hoy: \d+ sesi(ón|ones) · ~\d+ min$/);
		assert.match(digest.body!, /17:00 Tutoría/);
		assert.equal(cal.calendarDeskNotice("digest", at(9, 31)).notify, false, "once a day");
		const evening = cal.calendarDeskNotice("evening", at(19, 30));
		assert.equal(evening.notify, true);
		assert.match(evening.title!, /^Te queda(n)? \d+ sesi(ón|ones) de hoy$/);
		assert.match(evening.body!, /Lo que no hagas se recoloca solo\.$/);
		assert.ok(cal.deleteCalendarEvent(ev.ok ? ev.value.id : ""));
	});

	it("validates ranges", () => {
		assert.equal(cal.parseRange(new URL("http://x/?from=2026-11-01&to=2026-10-01"), now).ok, false);
		assert.equal(cal.parseRange(new URL("http://x/?from=2026-11-01&to=2027-11-01"), now).ok, false);
		assert.ok(cal.parseRange(new URL("http://x/"), now).ok);
	});
});

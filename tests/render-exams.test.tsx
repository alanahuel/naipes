/** «Exámenes» stage 3: the tab's pure pieces and static renders (English —
 *  the i18n context default in tests). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	beginExamSession,
	blockLabel,
	blockScore,
	ExamCard,
	ExamMenu,
	FolderPicker,
	folderCountLabel,
	ContextFields,
	MaterialsZone,
	ideaLevelLabel,
	pointNeedLabel,
	raiseWeekly,
	StandardPicker,
	standardName,
	WeeklyMinutes,
} from "../components/exams.tsx";
import { ExamSettingsSection } from "../components/settings/exams-section.tsx";
import { cleanPrerequisites, PrerequisitesEditor, prerequisiteStateLabel } from "../components/exam-prerequisites.tsx";
import { ConfidenceSlider } from "../components/confidence-rail.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { examNotice } from "../components/notices.tsx";
import { TABS } from "../components/app-shell.tsx";
import { translator } from "../components/i18n.tsx";
import { presetStandard, type ExamSummaryView, type PointStatus } from "../src/core/index.ts";

const es = translator("es");
const en = translator("en");

const point = (over: Partial<PointStatus> = {}): PointStatus => ({ id: "p1", blockId: "b1", text: "Rozamiento", nodeIds: [], gap: true, probe: null, taughtSession: false, score: 0, need: "teach", targets: null, extension: [], blockedBy: [], ...over });

describe("exams: pure formatting", () => {
	it("raiseWeekly adds the extra to studied days only (all days when none)", () => {
		assert.deepEqual(raiseWeekly([45, 45, 0, 45, 45, 90, 0], 15), [60, 60, 0, 60, 60, 105, 0]);
		assert.deepEqual(raiseWeekly([0, 0, 0, 0, 0, 0, 0], 20), [20, 20, 20, 20, 20, 20, 20]);
		assert.equal(raiseWeekly([715, 0, 0, 0, 0, 0, 0], 30)[0], 720);
	});
	it("blockScore is the mean of its points", () => {
		assert.equal(blockScore([{ score: 1 }, { score: 0.5 }]), 0.75);
		assert.equal(blockScore([]), 0);
	});
	it("labels: idea level, point need, blocks, standards", () => {
		assert.equal(ideaLevelLabel({ level: 2, toTeach: false, placed: true, tested: true }, es), "Discriminar");
		assert.equal(ideaLevelLabel({ level: 3, toTeach: true, placed: true, tested: true }, es), "por enseñar");
		assert.equal(ideaLevelLabel({ level: 0, toTeach: false, placed: false, tested: false }, es), "sin probar");
		assert.equal(pointNeedLabel(point({ need: "placement" }), es), "falta · en la prueba de nivel");
		assert.equal(pointNeedLabel(point({ need: "consolidate" }), es), "por afianzar");
		assert.equal(blockLabel({ kind: "review", minutes: 24, nodeIds: ["a", "b"] }, [], es), "Repaso con fecha · 2 ideas");
		assert.equal(blockLabel({ kind: "teach", minutes: 10, nodeIds: [], pointId: "p1", short: true }, [point()], es), "Enseñar: Rozamiento (corto)");
		assert.equal(standardName(presetStandard("merit"), es), "Notable");
		assert.equal(standardName({ ...presetStandard("merit"), preset: null }, en), "Custom");
	});
	it("beginExamSession posts the block, stashes the opening and returns the id", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		const fake = (async (url: string, init?: RequestInit) => {
			calls.push({ url, body: String(init?.body) });
			return new Response(JSON.stringify({ id: "chat_x1", opening: "Empecemos la prueba de nivel." }), { status: 200 });
		}) as typeof fetch;
		const stashed: string[] = [];
		const id = await beginExamSession(fake, "exam_ab_12345678", "teach", "p3", (cid, text) => (stashed.push(`${cid}:${text}`), true));
		assert.equal(id, "chat_x1");
		assert.deepEqual(calls, [{ url: "/api/exams/exam_ab_12345678/sessions", body: JSON.stringify({ kind: "teach", pointId: "p3" }) }]);
		assert.deepEqual(stashed, ["chat_x1:Empecemos la prueba de nivel."]);
		const refused = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
		assert.equal(await beginExamSession(refused, "exam_ab_12345678", "review"), null);
	});
	it("the bell notice opens the exam", () => {
		const n = examNotice({ examId: "exam_ab_12345678", exam: "Física", kind: "below" }, new Date("2026-11-06T10:00:00Z"));
		assert.equal(n.href, "/exams/exam_ab_12345678");
		assert.equal(n.tone, "warn");
		assert.equal(es(n.message, n.vars), "Física: no llegas al objetivo");
		assert.equal(es(examNotice({ examId: "e", exam: "Física", kind: "study", minutes: 45 }).message, { exam: "Física", min: 45 }), "Hoy toca estudiar para Física (~45 min)");
	});
	it("the fifth tab is Exámenes, the sixth Calendario", () => {
		assert.deepEqual(TABS.map((t) => t.href), ["/", "/sessions", "/knowledge", "/review", "/exams", "/calendar"]);
		assert.ok(TABS[4]!.match("/exams/exam_x"));
	});
});

describe("exams: static renders", () => {
	it("StandardPicker shows the presets and the line", () => {
		const html = renderToStaticMarkup(<StandardPicker value={presetStandard("pass")} onChange={() => {}} />);
		for (const word of ["Pass", "Merit", "Distinction", "recall 80% · Recall · 70% of the syllabus"]) assert.ok(html.includes(word), word);
		assert.ok(html.includes('aria-checked="true"'));
	});
	it("WeeklyMinutes renders seven inputs, Monday first", () => {
		const html = renderToStaticMarkup(<WeeklyMinutes value={[45, 45, 45, 45, 45, 90, 0]} onChange={() => {}} />);
		assert.equal((html.match(/type="number"/g) ?? []).length, 7);
		assert.ok(html.indexOf('value="90"') > html.indexOf('value="45"'));
	});
	it("the settings section shows durations and plan; the time links to Calendario", () => {
		const html = renderToStaticMarkup(<ExamSettingsSection exams={{ teachMinutes: 30 }} onChange={() => {}} />);
		for (const id of ["exams-teachMinutes", "exams-problemMinutes", "exams-finalWindowDays", "exams-placementBatch", "exams-time-link"]) assert.ok(html.includes(id), id);
		assert.ok(!html.includes("exam-weekly"), "the minutes per day moved to Settings → Calendario");
		assert.ok(html.includes('value="30"'));
	});
	it("the confidence slider and the practice dock carry it", () => {
		const slider = renderToStaticMarkup(<ConfidenceSlider value={70} onChange={() => {}} label="Confidence" missingLabel="Pick" ariaLabel="a" valueText="70" />);
		assert.ok(slider.includes("70%"));
		const dock = renderToStaticMarkup(<PracticeDock problemCallId="p1" input={{ statement: "S" }} expanded onExpand={() => {}} onSubmit={() => {}} />);
		assert.ok(dock.includes('data-testid="practice-confidence"'));
		assert.ok(dock.includes(">—</span>"), "never pre-filled (owner 2026-11-09)");
	});
	it("a draft card carries the «···» menu; an active card does not (owner, 2026-11-06)", () => {
		const summary = (status: ExamSummaryView["status"]): ExamSummaryView => ({
			id: `exam_${status}`,
			title: "CPS",
			examDate: "2027-02-19",
			status,
			daysLeft: 105,
			standard: presetStandard("pass"),
			mapping: { state: "done" },
			coverage: 0.2,
			reachedPreset: null,
			meetsStandard: false,
			todayMinutes: 0,
			infeasible: null,
		});
		const draft = renderToStaticMarkup(<ul><ExamCard exam={summary("draft")} /></ul>);
		assert.ok(draft.includes('data-testid="exam-menu"'));
		// The menu sits outside the card's link (it must never open the draft).
		assert.ok(draft.indexOf('data-testid="exam-menu"') > draft.indexOf("</a>"));
		const active = renderToStaticMarkup(<ul><ExamCard exam={summary("active")} /></ul>);
		assert.ok(!active.includes('data-testid="exam-menu"'));
	});
	it("ExamMenu renders closed: only the trigger", () => {
		const html = renderToStaticMarkup(<ExamMenu exam={{ id: "exam_d", title: "CPS", status: "draft", examDate: "2027-02-19", standard: presetStandard("pass") }} />);
		assert.ok(html.includes('aria-haspopup="menu"'));
		assert.ok(!html.includes('role="menu"'));
	});

	it("FolderPicker starts collapsed, names as on disk, counts ideas / unread notes, tri-state", () => {
		const f = (path: string, ideas: number, unread = 0) => ({ path, ideas, notes: ideas + unread, unread, direct: 0, directUnread: 0 });
		const folders = [f("002 - ÁREAS", 5), f("002 - ÁREAS/011. INFORMÁTICA 💻", 4), f("002 - ÁREAS/011. INFORMÁTICA 💻/Redes", 1), f("INBOX", 0, 3), f("MIX", 2, 30)];
		const collapsed = renderToStaticMarkup(<FolderPicker folders={folders} flagged={new Set()} onChange={() => {}} />);
		assert.ok(collapsed.includes("002 - ÁREAS") && collapsed.includes("INBOX"));
		assert.ok(!collapsed.includes("Redes"), "only the first level shows");
		assert.ok(collapsed.includes("(5 ideas)"));
		assert.ok(collapsed.includes("(3 notes · not read)"));
		assert.ok(collapsed.includes("(2 ideas · 30 notes not read)"));
		assert.ok(!collapsed.includes("exam-folders-selected"));
		const all = folders.map((x) => x.path);
		const flags = new Set(all.filter((p) => p.startsWith("002") && !p.endsWith("Redes")));
		const partial = renderToStaticMarkup(<FolderPicker folders={folders} flagged={flags} onChange={() => {}} />);
		assert.ok(partial.includes('data-check="partial"'));
		assert.ok(partial.includes("exam-folders-selected"));
		assert.ok(partial.includes("002 - ÁREAS › 011. INFORMÁTICA 💻 (–)"));
	});
	it("folderCountLabel: Spanish texts", () => {
		assert.equal(folderCountLabel({ ideas: 42, unread: 0 }, es), "42 ideas");
		assert.equal(folderCountLabel({ ideas: 0, unread: 12 }, es), "12 notas · sin leer");
		assert.equal(folderCountLabel({ ideas: 2, unread: 30 }, es), "2 ideas · 30 notas sin leer");
	});
	it("ContextFields and MaterialsZone render their fields", () => {
		const ctx = renderToStaticMarkup(<ContextFields value={{ kind: "official", name: "PAU", institution: "", location: "", sitting: "2027", goal: "" }} onChange={() => {}} />);
		assert.ok(ctx.includes("Context (optional)") && ctx.includes("Sitting / year") && ctx.includes('value="2027"'));
		const mats = renderToStaticMarkup(<MaterialsZone value={[{ key: "k", kind: "link", url: "https://example.org/guia" }]} onChange={() => {}} />);
		assert.ok(mats.includes("https://example.org/guia") && mats.includes("Add files"));
	});
});

describe("«conocimientos previos» UI (owner 2026-11-09)", () => {
	it("labels: a prerequisite's state and its teach block", () => {
		const ideas = new Map([["n1", { level: 2 as const, recallAtExam: 0.82 }]]);
		assert.equal(prerequisiteStateLabel({ state: "linked", nodeIds: ["n1"] }, ideas, es), "Subiendo · Discriminar · 82 %");
		assert.equal(prerequisiteStateLabel({ state: "placement", nodeIds: [] }, ideas, es), "Por evaluar");
		assert.equal(prerequisiteStateLabel({ state: "mastered", nodeIds: ["n1"] }, ideas, es), "Dominado");
		const prereqs = [{ id: "q1", statement: "Potencias" }];
		assert.equal(blockLabel({ kind: "teach", minutes: 25, nodeIds: [], prerequisiteId: "q1" }, [], es, prereqs), "Enseñar conocimiento previo: Potencias");
		assert.equal(blockLabel({ kind: "teach", minutes: 10, nodeIds: [], prerequisiteId: "q1", short: true }, [], es, prereqs), "Enseñar conocimiento previo: Potencias (corto)");
	});
	it("the editor lists each one with the topics that need it; empty statements are not saved", () => {
		const html = renderToStaticMarkup(
			<PrerequisitesEditor
				value={[{ id: "q1", statement: "Potencias", source: { kind: "model", title: "" }, nodeIds: [], blocks: ["p1"], origin: "diagnosis", depth: 1, key: "q1" }]}
				points={[{ id: "p1", text: "Rozamiento" }]}
				onChange={() => {}}
			/>,
		);
		assert.ok(html.includes("Conocimientos previos") || html.includes("Prior knowledge"));
		assert.ok(html.includes("Rozamiento"));
		assert.ok(html.includes('data-testid="exam-prereq-add"'));
		assert.deepEqual(cleanPrerequisites([{ id: "a", statement: "  ", source: { kind: "user", title: "" }, nodeIds: [], blocks: [], origin: "user", depth: 1, key: "a" }]), []);
	});
});

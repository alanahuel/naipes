/** The exam page's tabs (owner 2026-11-09): src/core/exam-tabs.ts + the
 *  Tabs primitive's static render. Synthetic records only. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { addInstructionPoint, EMPTY_EXAM_CONTEXT, examPageFromParam, examPageHref, examPageParam, examTabAlerts, pageSlice, examTabFromParam, examTabHref, examTabParam, EXAM_TABS, presetStandard, type ExamRecord, type SyllabusBlock } from "../src/core/index.ts";
import { Tabs, TabPanel } from "../components/ui/tabs.tsx";
import { Pager } from "../components/ui/pager.tsx";

const researched = (id: string, text: string, over: Partial<SyllabusBlock["points"][number]> = {}) => ({ id, text, nodeIds: [], targets: [], ...over });

function record(over: Partial<ExamRecord> = {}): ExamRecord {
	return {
		version: 2,
		id: "exam_tabs_1",
		title: "Física",
		examDate: "2026-12-12",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
		status: "active",
		standard: presetStandard("merit"),
		syllabus: { text: "", fileName: null, folders: [], directFolders: [] },
		context: { ...EMPTY_EXAM_CONTEXT },
		materials: [],
		blocks: [{ id: "b1", title: "Cinemática", points: [researched("p1", "Velocidad"), researched("p2", "Aceleración")] }],
		mapping: { state: "done" },
		priorityBlocks: [],
		classified: true,
		...over,
	};
}

const view = (r: ExamRecord, infeasible: unknown = null) => ({ status: r.status, infeasible, record: r }) as Parameters<typeof examTabAlerts>[0];

describe("exam tabs: the URL", () => {
	it("round-trips every tab through its slug; unknown / absent = Resumen", () => {
		for (const tab of EXAM_TABS) assert.equal(examTabFromParam(examTabParam(tab)), tab);
		assert.equal(examTabFromParam(null), "summary");
		assert.equal(examTabFromParam("nope"), "summary");
		assert.deepEqual(EXAM_TABS.map(examTabParam), ["resumen", "temario", "previos", "asignatura", "tutor"]);
	});
	it("Resumen's href carries no ?tab", () => {
		assert.equal(examTabHref("e1", "summary"), "/exams/e1");
		assert.equal(examTabHref("e1", "rules"), "/exams/e1?tab=asignatura");
	});
});

describe("exam tabs: the dots", () => {
	it("a settled exam has none", () => {
		assert.deepEqual(examTabAlerts(view(record())), { summary: false, syllabus: false, prior: false, rules: false, tutor: false });
	});
	it("Resumen: the «no llega» warning", () => {
		assert.equal(examTabAlerts(view(record(), { extraPerDay: 10, bestPreset: "pass" })).summary, true);
	});
	it("Temario: unresearched points, a pending syllabus point, research or a contrast", () => {
		assert.equal(examTabAlerts(view(record({ blocks: [{ id: "b1", title: "T", points: [{ id: "p1", text: "x", nodeIds: [] }] }] }))).syllabus, true);
		assert.equal(examTabAlerts(view(record({ blocks: [{ id: "b1", title: "T", points: [researched("p1", "x", { kind: "syllabus", pendingFrom: "rules" })] }] }))).syllabus, true);
		assert.equal(examTabAlerts(view(record({ mapping: { state: "researching" } }))).syllabus, true);
		assert.equal(examTabAlerts(view(record({ contrast: { state: "ready", at: "2026-11-09T00:00:00.000Z" } }))).syllabus, true);
	});
	it("Asignatura / Tutor: their own pending points only", () => {
		const r = record({ blocks: [{ id: "b1", title: "T", points: [researched("p1", "x"), researched("p2", "Formato", { kind: "rules", pendingFrom: "syllabus" })] }] });
		const alerts = examTabAlerts(view(r));
		assert.equal(alerts.rules, true);
		assert.equal(alerts.tutor, false);
		assert.equal(alerts.syllabus, false);
	});
	it("Conocimientos previos: a search running or a proposal to review", () => {
		const search = { state: "running", mode: "review", at: "2026-11-09T00:00:00.000Z", done: 0, total: 3 } as const;
		assert.equal(examTabAlerts(view(record({ prerequisiteSearch: search }))).prior, true);
		assert.equal(examTabAlerts(view(record({ prerequisiteSearch: { ...search, state: "ready" } }))).prior, true);
		assert.equal(examTabAlerts(view(record({ prerequisiteSearch: { ...search, state: "ready", mode: "draft" } }))).prior, false);
	});
	it("an archived exam has none", () => {
		const r = record({ status: "archived", mapping: { state: "researching" } });
		assert.ok(Object.values(examTabAlerts(view(r, { extraPerDay: 5, bestPreset: null }))).every((v) => !v));
	});
});

describe("exam tabs: «Añadir apartado»", () => {
	it("creates the type's block when there is none", () => {
		const out = addInstructionPoint(record().blocks, "rules", "  Formato del examen ", { block: "bN", point: "pN" }, "Instrucciones de la asignatura");
		assert.equal(out.length, 2);
		assert.deepEqual(out[1], { id: "bN", title: "Instrucciones de la asignatura", kind: "rules", points: [{ id: "pN", text: "Formato del examen", nodeIds: [], targets: [], origin: "user" }] });
	});
	it("appends to the first live block of that type", () => {
		const blocks: SyllabusBlock[] = [...record().blocks, { id: "bx", title: "Viejo", kind: "tutor", excluded: true, points: [] }, { id: "bt", title: "Tutor", kind: "tutor", points: [researched("q1", "Tono")] }];
		const out = addInstructionPoint(blocks, "tutor", "Ritmo", { block: "bN", point: "pN" }, "x");
		assert.equal(out.length, 3);
		assert.deepEqual(out[2]!.points.map((p) => p.id), ["q1", "pN"]);
		assert.equal(out[1]!.points.length, 0);
	});
});

describe("exam tabs: the Tabs primitive", () => {
	it("renders a labelled tablist, the open panel and a dot with its sr-only text", () => {
		const html = renderToStaticMarkup(
			<Tabs value="a" onChange={() => {}} label="Secciones" alertLabel="hay algo pendiente" items={[{ value: "a", label: "Resumen" }, { value: "b", label: "Temario", alert: true }]}>
				<TabPanel value="a">uno</TabPanel>
				<TabPanel value="b">dos</TabPanel>
			</Tabs>,
		);
		assert.match(html, /role="tablist"[^>]*aria-label="Secciones"|aria-label="Secciones"[^>]*role="tablist"/);
		assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
		assert.match(html, /aria-selected="true"[^>]*>Resumen|Resumen/);
		assert.match(html, /uno/);
		assert.doesNotMatch(html, /dos/);
		assert.match(html, /hay algo pendiente/);
	});
});

describe("exam tabs: pages (owner 2026-11-09)", () => {
	it("switching tabs keeps every tab's page; page 1 drops its param", () => {
		assert.equal(examTabHref("e1", "prior", "?tab=temario&p-temario=3"), "/exams/e1?tab=previos&p-temario=3");
		assert.equal(examTabHref("e1", "summary", "?tab=temario&p-temario=3"), "/exams/e1?p-temario=3");
		assert.equal(examPageHref("e1", "syllabus", 2, "?tab=temario"), "/exams/e1?tab=temario&p-temario=2");
		assert.equal(examPageHref("e1", "syllabus", 1, "?tab=temario&p-temario=2"), "/exams/e1?tab=temario");
		assert.equal(examPageParam("rules"), "p-asignatura");
	});
	it("reads a page; junk = 1", () => {
		assert.equal(examPageFromParam("3"), 3);
		assert.equal(examPageFromParam(null), 1);
		assert.equal(examPageFromParam("0"), 1);
		assert.equal(examPageFromParam("x"), 1);
	});
	it("slices 10 per page and clamps to what exists", () => {
		assert.deepEqual(pageSlice(23, 1), { page: 1, pages: 3, start: 0, end: 10 });
		assert.deepEqual(pageSlice(23, 3), { page: 3, pages: 3, start: 20, end: 23 });
		assert.deepEqual(pageSlice(23, 9), { page: 3, pages: 3, start: 20, end: 23 });
		assert.deepEqual(pageSlice(10, 2), { page: 1, pages: 1, start: 0, end: 10 });
		assert.deepEqual(pageSlice(0, 1), { page: 1, pages: 1, start: 0, end: 0 });
		assert.equal(pageSlice(11, Number.MAX_SAFE_INTEGER).page, 2);
	});
	it("the pager: nothing for one page; status and disabled ends", () => {
		assert.equal(renderToStaticMarkup(<Pager page={1} pages={1} onPage={() => {}} />), "");
		const html = renderToStaticMarkup(<Pager page={1} pages={4} onPage={() => {}} />);
		assert.match(html, /1 of 4/);
		assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="pager-prev"/);
		assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="pager-next"/);
	});
});

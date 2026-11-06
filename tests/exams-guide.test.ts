/** «Guía oficial primero» (owner 2026-11-06): the guide finder, the
 *  contrast, the record's guide/origin/excluded fields, «Ascender a punto
 *  extra» and «Contrastar con la guía» applied. Isolated data dir, faux
 *  engines, synthetic graph — no network, no real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-exams-guide-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const exams = await import("../src/server/exams.ts");
const core = await import("../src/core/exams.ts");
const { runGuideFinder, guideFinderInstructions, guideFinderPrompt } = await import("../src/agent/subagents/exam-guide-finder.ts");
const { runExamContrast } = await import("../src/agent/subagents/exam-contrast.ts");
const { examResearchPrompt, examResearchInstructions } = await import("../src/agent/subagents/exam-researcher.ts");
const { writeExam, readExam } = await import("../src/store/exams.ts");

type Engine = import("../src/agent/models.ts").PiEngine;
function fauxEngine(steps: FauxResponseStep[]): Engine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const call = (name: string, input: unknown, id: string): FauxResponseStep => () => fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const now = new Date(2026, 10, 6, 10, 0).getTime();
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
const node = (id: string, name: string) => ({ id, name, statement: `${name}: enunciado`, aliases: [], createdAt: new Date(now).toISOString(), provenance: [{ chatId: "chat_x", messageId: "m" }] });
fs.writeFileSync(path.join(DIR, "graph", "nodes.jsonl"), [node("n_rom", "Romanticismo"), node("n_tilde", "Tilde diacrítica"), node("n_bec", "Rimas de Bécquer")].map((n) => JSON.stringify(n)).join("\n") + "\n");

describe("guide finder", () => {
	const task = { exam: { title: "Química +25", examDate: "2027-01-28" }, context: ["School or body: UNED"], materials: [{ id: "mat_1", name: "Guía.pdf", kind: "file" as const }] };
	it("the approved prompt: materials first, scope per sitting, subject matter only, never from memory", () => {
		const text = guideFinderInstructions({ today: "2026-11-06", examDate: "2027-01-28" });
		assert.ok(text.includes("Look first in the learner's MATERIALS (read_material), then on the web"));
		assert.ok(text.includes("«Entra en febrero: temas 1–6»"));
		assert.ok(text.includes("Leave out everything that is not subject matter"));
		assert.ok(text.includes("Never present a syllabus from memory or from unofficial pages as official."));
		assert.ok(guideFinderPrompt(task).includes("[mat_1] Guía.pdf (file — read_material)"));
	});
	it("found: the outline scoped to the sitting; a bad material ref and an all-out outline are retried", async () => {
		const outline = [
			{ title: "Tema 1. Leyes", inSitting: true, points: [{ text: "Ley de Lavoisier", fromGuide: true }] },
			{ title: "Tema 7. Cinética", inSitting: false, points: [{ text: "Velocidad de reacción", fromGuide: true }, { text: " ", fromGuide: false }] },
		];
		const engine = fauxEngine([
			call("submit_guide", { found: true, title: "Guía", sourceKind: "material", ref: "mat_9", blocks: outline }, "g1"),
			call("submit_guide", { found: true, title: "Guía", sourceKind: "web", ref: "https://x", blocks: outline.map((b) => ({ ...b, inSitting: false })) }, "g2"),
			call("submit_guide", { found: true, title: " Guía Química 2026/27 ", sourceKind: "material", ref: "mat_1", year: "2026/27", scopeNote: "Entra en febrero: temas 1–6", blocks: outline }, "g3"),
		]);
		const r = await runGuideFinder({ engine, task, instructions: "x", search: () => null, readMaterial: async () => "", pdfDir: DIR });
		assert.ok(r.found);
		assert.equal(r.found && r.title, "Guía Química 2026/27");
		assert.deepEqual(r.found && r.outline[1], { title: "Tema 7. Cinética", inSitting: false, points: [{ text: "Velocidad de reacción", fromGuide: true }] });
	});
	it("not found: needs a reason", async () => {
		const engine = fauxEngine([call("submit_guide", { found: false }, "g1"), call("submit_guide", { found: false, reason: "No hay guía publicada." }, "g2")]);
		assert.deepEqual(await runGuideFinder({ engine, task, instructions: "x", search: () => null, readMaterial: async () => "", pdfDir: DIR }), { found: false, reason: "No hay guía publicada." });
	});
	it("the research task names the guide", () => {
		const prompt = examResearchPrompt({ exam: { title: "Q", examDate: "2027-01-28" }, guide: { title: "Guía", year: "2026/27", ref: "https://x" }, context: [], materials: [], block: { index: 1, total: 1, title: "B", points: [] }, candidates: [] });
		assert.ok(prompt.includes("GUIDE: Guía (2026/27) https://x"));
		assert.ok(examResearchInstructions({ today: "2026-11-06", examDate: "2027-01-28", sitting: "", depth: "pass" }).includes("2. The OFFICIAL GUIDE in the task when given, then the web"));
	});
});

describe("contrast agent", () => {
	it("derives missing official points and extras (with their closest), retrying unknown ids", async () => {
		const engine = fauxEngine([
			call("submit_contrast", { covered: [{ official: "o9", current: ["p1"] }], uncovered: [] }, "c1"),
			call("submit_contrast", { covered: [{ official: "o1", current: ["p1"] }, { official: "o2", current: [] }], uncovered: [{ current: "p2", closest: "o1" }] }, "c2"),
		]);
		const r = await runExamContrast({ engine, official: { text: "x", ids: ["o1", "o2"] }, current: [{ id: "p1", blockTitle: "B", text: "Tilde" }, { id: "p2", blockTitle: "B", text: "Romanticismo" }] });
		assert.deepEqual(r, { missing: ["o2"], extras: [{ pointId: "p2", closest: "o1" }] });
	});
});

describe("record and pure helpers", () => {
	it("guide, origin and excluded survive the round trip; excluded blocks are not studied", () => {
		const blocks = core.numberBlocks([
			{ title: "Acentuación", points: [{ text: "Tilde diacrítica", nodeIds: ["n_tilde"], origin: "official", extension: ["n_rom"] }] },
			{ title: "Sintaxis", excluded: true, points: [{ text: "Oración compuesta", nodeIds: [], origin: "official" }] },
		]);
		const raw = {
			version: 2,
			id: "exam_rt",
			title: "Lengua",
			examDate: "2027-01-29",
			createdAt: "x",
			updatedAt: "x",
			standard: core.presetStandard("pass"),
			blocks,
			guide: { state: "found", title: "Guía", year: "2026/27", scopeNote: "Entra en febrero: temas 1–8", outline: [{ title: "Tema 2", inSitting: true, points: [{ text: "Tilde" }] }], bogus: 1 },
			contrast: { state: "ready", at: "x", missing: [{ id: "o1", blockTitle: "Tema 2", text: "Hiatos" }], extras: [{ pointId: "p1", closest: null }] },
		};
		const rec = core.sanitizeExamRecord(raw)!;
		assert.equal(rec.blocks[0]!.points[0]!.origin, "official");
		assert.deepEqual(rec.blocks[0]!.points[0]!.extension, ["n_rom"]);
		assert.equal(rec.blocks[1]!.excluded, true);
		assert.deepEqual(rec.guide, { state: "found", title: "Guía", year: "2026/27", scopeNote: "Entra en febrero: temas 1–8", outline: [{ title: "Tema 2", inSitting: true, points: [{ text: "Tilde", fromGuide: true }] }] });
		assert.deepEqual(rec.contrast?.missing, [{ id: "o1", blockTitle: "Tema 2", text: "Hiatos", inSitting: true }]);
		assert.deepEqual(core.studyPoints(rec).map((p) => p.text), ["Tilde diacrítica"]);
	});
	it("the guide outline text marks out-of-sitting blocks and non-guide points", () => {
		const { text, points } = core.guideOutlineText([
			{ title: "Tema 1", inSitting: true, points: [{ text: "A", fromGuide: true }] },
			{ title: "Tema 9", inSitting: false, points: [{ text: "B", fromGuide: false }] },
		]);
		assert.equal(text, "## Tema 1\n- [o1] A\n## Tema 9 [OUT OF THIS SITTING]\n- [o2] B [NOT FROM THE GUIDE]");
		assert.deepEqual(points.map((p) => p.id), ["o1", "o2"]);
	});
	it("guideWanted: every type but Personal, unless the context is empty", () => {
		const base = core.EMPTY_EXAM_CONTEXT;
		assert.equal(exams.guideWanted(base), false);
		assert.equal(exams.guideWanted({ ...base, kind: "personal", name: "Algo" }), false);
		assert.equal(exams.guideWanted({ ...base, name: "Química" }), true);
		assert.equal(exams.guideWanted({ ...base, kind: "official" }), true);
	});
});

describe("promote and contrast on a stored exam", () => {
	const blocks = core.numberBlocks([
		{ title: "Acentuación", points: [{ text: "Tilde diacrítica", nodeIds: ["n_tilde"], origin: "official", extension: ["n_bec"] }] },
		{ title: "Literatura", points: [{ text: "Romanticismo", nodeIds: ["n_rom"], origin: "user" }] },
	]);
	const exam = {
		...core.sanitizeExamRecord({ version: 2, id: "exam_guide1", title: "Lengua", examDate: "2027-01-29", createdAt: "x", updatedAt: "x", standard: core.presetStandard("pass"), blocks })!,
		contrast: {
			state: "ready" as const,
			at: "x",
			missing: [
				{ id: "o2", blockTitle: "Acentuación", text: "Hiatos", inSitting: true },
				{ id: "o3", blockTitle: "Puntuación", text: "La coma", inSitting: true },
			],
			extras: [{ pointId: "p2", closest: "Tilde diacrítica" }],
		},
	};
	it("«Ascender a punto extra» turns an ampliación idea into a counted point with a «De tus notas» target", () => {
		writeExam(exam);
		assert.equal(exams.promoteExamIdea(exam.id, "p1", "n_rom").ok, false, "only ideas in that point's ampliación");
		assert.deepEqual(exams.promoteExamIdea(exam.id, "p1", "n_bec", now), { ok: true });
		const after = readExam(exam.id)!;
		const [tilde, extra] = after.blocks[0]!.points;
		assert.equal(tilde!.extension, undefined);
		assert.equal(extra!.origin, "extra");
		assert.equal(extra!.text, "Rimas de Bécquer");
		assert.deepEqual(extra!.targets!.map((t) => [t.source.kind, t.nodeIds]), [["notes", ["n_bec"]]]);
		assert.equal(core.studyPoints(after).length, 3, "the extra point counts");
	});
	it("applying the contrast adds the chosen points and moves an extra's ideas to the closest point's ampliación", () => {
		// The added points are researched right after; without a model that can't start, and the changes are applied anyway.
		assert.deepEqual(exams.applyExamContrast(exam.id, { add: ["o2", "o3"], extras: [{ pointId: "p2", action: "extension" }] }, now), { ok: true });
		const after = readExam(exam.id)!;
		assert.equal(after.contrast, undefined);
		assert.deepEqual(after.blocks.map((b) => [b.title, b.points.map((p) => p.text)]), [
			["Acentuación", ["Tilde diacrítica", "Rimas de Bécquer", "Hiatos"]],
			["Puntuación", ["La coma"]],
		]);
		assert.deepEqual(after.blocks[0]!.points[0]!.extension, ["n_rom"]);
		assert.equal(after.blocks[0]!.points[2]!.origin, "official");
	});
	it("keep marks the point as extra; discard drops the contrast", () => {
		writeExam({ ...readExam(exam.id)!, contrast: { state: "ready", at: "x", missing: [], extras: [{ pointId: "p1", closest: null }] } });
		assert.deepEqual(exams.applyExamContrast(exam.id, { add: [], extras: [{ pointId: "p1", action: "keep" }] }, now), { ok: true });
		assert.equal(readExam(exam.id)!.blocks[0]!.points[0]!.origin, "extra");
		writeExam({ ...readExam(exam.id)!, contrast: { state: "error", at: "x", error: "no_guide:" } });
		assert.deepEqual(exams.applyExamContrast(exam.id, { discard: true }, now), { ok: true });
		assert.equal(readExam(exam.id)!.contrast, undefined);
	});
	it("the guide actions refuse honestly without a strong model", () => {
		assert.deepEqual(exams.resolveMissingGuide(exam.id, "skip", now), { ok: false, status: 503, error: "models_not_configured" });
		assert.equal(readExam(exam.id)!.guide?.state, "none", "«Seguir sin guía» is remembered");
		assert.deepEqual(exams.startExamContrast(exam.id, now), { ok: false, status: 409, error: "no official guide for a personal exam" }, "an empty context has no guide to compare with");
		writeExam({ ...readExam(exam.id)!, context: { ...core.EMPTY_EXAM_CONTEXT, kind: "official", name: "Lengua Castellana" } });
		assert.deepEqual(exams.startExamContrast(exam.id, now), { ok: false, status: 503, error: "models_not_configured" });
	});
});

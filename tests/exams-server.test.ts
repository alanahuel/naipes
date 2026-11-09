/** «Exámenes» service end to end (stage 2): an isolated temporary data dir
 *  (NP_DATA_DIR set before any import — each test file is its own
 *  process), synthetic chats and graph. No network, no real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-exams-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const exams = await import("../src/server/exams.ts");
const { getReviewState, resetReviewCache } = await import("../src/server/review.ts");
const { getChat } = await import("../src/server/chats.ts");
const { syllabusCandidates, numberBlocks } = await import("../src/core/exams.ts");
const storeMod = await import("../src/store/exams.ts");

const now = new Date(2026, 10, 4, 10, 0).getTime(); // Wed 4 Nov 2026
const t0 = now - 20 * 86_400_000;
fs.mkdirSync(path.join(DIR, "chats"), { recursive: true });
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
const quizAnswer = (at: number) => ({ kind: "quiz", questionType: "check", correct: true, confidence: 90, dontKnow: false, answers: [], questionText: "q", answeredAt: new Date(at).toISOString() });
const teach = {
	id: "chat_a",
	title: "Cinemática",
	createdAt: new Date(t0).toISOString(),
	updatedAt: new Date(t0).toISOString(),
	messages: [
		{ id: "chat_a_m1", role: "assistant", content: [{ type: "text", text: "x" }], timestamp: t0 },
		{ id: "chat_a_q1", role: "assistant", content: [{ type: "toolCall", id: "chat_a_k1", name: "quiz", arguments: { nodeId: "s1", type: "check" } }], timestamp: t0 + 1 },
		{ id: "chat_a_a1", role: "toolResult", toolCallId: "chat_a_k1", toolName: "quiz", content: [], isError: false, timestamp: t0 + 2, details: quizAnswer(t0 + 2) },
	],
};
fs.writeFileSync(path.join(DIR, "chats", "chat_a.json"), JSON.stringify(teach));
const nodes = ([
	["n_v", "Velocidad media", "chat_a", "chat_a_m1"],
	["n_a", "Aceleración constante", "chat_a", "chat_a_a1"],
	["n_src", "Fuerza neta", "src_1", "src_1"],
] as const).map(([id, name, chatId, messageId]) => ({ id, name, statement: `${name}: enunciado`, aliases: [], createdAt: new Date(t0).toISOString(), provenance: [{ chatId, messageId }] }));
fs.writeFileSync(path.join(DIR, "graph", "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
fs.writeFileSync(path.join(DIR, "graph", "sources.json"), JSON.stringify({ src_1: { id: "src_1", filePath: "Física/Dinámica/Nota.md", importedAt: new Date(t0).toISOString() } }));

const blocks = numberBlocks([
	{ title: "Cinemática", points: [{ text: "Velocidad y aceleración", nodeIds: ["n_v", "n_a"] }] },
	{ title: "Dinámica", points: [{ text: "Segunda ley", nodeIds: ["n_src"] }, { text: "Rozamiento", nodeIds: [] }] },
]);

let examId = "";

describe("exam lifecycle (isolated data dir)", () => {
	it("creates a draft; strict bodies", () => {
		assert.equal(exams.parseExamCreate({ title: "", examDate: "2026-12-01" }).ok, false);
		assert.equal(exams.parseExamCreate({ title: "Física", examDate: "1/12" }).ok, false);
		assert.equal(exams.parseExamCreate({ title: "Física", examDate: "2026-12-01", syllabus: { text: " " } }).ok, false);
		assert.equal(exams.parseExamCreate({ title: "Física", examDate: "2026-12-01", syllabus: { text: "", folders: "Física" } }).ok, false);
		const parsed = exams.parseExamCreate({ title: "Física", examDate: "2026-11-30", syllabus: { text: "Cinemática\nDinámica", folders: ["Física/Dinámica/Leyes", "Física/Dinámica"] } });
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.ok && parsed.value.syllabus.folders, ["Física/Dinámica"]);
		const exam = exams.createExam(parsed.ok ? parsed.value : (null as never), now);
		examId = exam.id;
		assert.equal(exam.status, "draft");
		assert.equal(exam.standard.preset, "pass");
		const [view] = exams.listExamViews(now);
		assert.equal(view!.coverage, null, "no mapping yet → no status");
	});

	it("mapping refuses honestly without a strong model; activation needs points", () => {
		assert.deepEqual(exams.startExamMapping(examId, now), { ok: false, status: 503, error: "models_not_configured" });
		const early = exams.updateExam(examId, { status: "active" }, now);
		assert.equal(early.ok, false);
	});

	it("confirmed mapping + activation → status, placement first, exam ideas held in Repaso", () => {
		const patch = exams.parseExamPatch({ blocks, status: "active", standard: { preset: "merit", recall: 0.9, mode: "discrimination", coverage: 0.85 } });
		assert.ok(patch.ok);
		assert.ok(exams.updateExam(examId, patch.ok ? patch.value : {}, now).ok);
		const detail = exams.examDetailView(examId, now)!;
		assert.equal(detail.status, "active");
		assert.equal(detail.model!.points.length, 3);
		assert.deepEqual(detail.model!.placement.pendingIdeas.sort(), ["n_a", "n_src", "n_v"]);
		assert.equal(detail.model!.points.find((p) => p.gap)!.need, "placement");
		assert.deepEqual(detail.blocks.map((b) => b.kind).slice(0, 2), ["review", "placement"], "graded ideas due first, then the placement test");
		assert.ok(detail.work!.placement > 0);
		const review = getReviewState(now);
		const src = review.model.items.find((i) => i.nodeId === "n_src")!;
		assert.equal(src.released, false, "ungraded exam idea waits for the placement test");
		assert.equal(review.model.newIntake.length, 0);
	});

	it("a placement session freezes its picks and «falta» points into the record and the prompt", () => {
		const started = exams.startExamSession(examId, "placement", undefined, now);
		assert.ok(started.ok);
		const session = started.ok ? started.session : (null as never);
		assert.equal(session.opening, "Empecemos la prueba de nivel.");
		assert.equal(session.title, "Prueba de nivel · Física");
		const record = getChat(session.id)!;
		assert.equal(record.kind, "practice");
		assert.equal(record.exam!.kind, "placement");
		assert.deepEqual(record.exam!.pointIds, ["p3"]);
		const marker = record.messages[0] as unknown as { customType: string; details: { propositions: Array<{ id: string }> } };
		assert.equal(marker.customType, "graph-context");
		assert.equal(marker.details.propositions.length, 3);
		const appendix = exams.examSessionAppendix(record)!;
		assert.match(appendix, /## Placement test/);
		assert.match(appendix, /\[p3\] Rozamiento/);
		assert.match(appendix, /up to discrimination/);
		assert.match(appendix, /every proposition and point/);
		assert.ok(!appendix.includes("{"), "every placeholder filled");
	});

	it("a teach session for a point carries the exam link and the teach appendix", () => {
		const started = exams.startExamSession(examId, "teach", "p3", now);
		assert.ok(started.ok);
		const session = started.ok ? started.session : (null as never);
		assert.equal(session.opening, "Quiero aprender esto para mi examen «Física»: Rozamiento");
		const record = getChat(session.id)!;
		assert.equal(record.kind, undefined, "teach");
		assert.deepEqual(record.exam, { id: examId, kind: "teach", pointId: "p3" });
		assert.match(exams.examSessionAppendix(record)!, /teaches one point of the syllabus.*Rozamiento/s);
		const review = exams.startExamSession(examId, "review", undefined, now);
		assert.ok(review.ok);
		const reviewRecord = getChat(review.ok ? review.session.id : "")!;
		assert.deepEqual(reviewRecord.exam, { id: examId, kind: "review" });
		assert.ok(reviewRecord.review, "an exam review block is a review session");
		assert.equal(exams.examSessionAppendix(reviewRecord), undefined, "the review appendix covers it");
	});

	it("the desk notice folds the exam into the digest", () => {
		resetReviewCache();
		const digest = exams.deskNotice("digest", new Date(2026, 10, 4, 9, 30).getTime());
		assert.equal(digest.notify, true);
		assert.match(digest.body!, /Física: ~\d+ min hoy\./);
		assert.equal(exams.deskNotice("digest", new Date(2026, 10, 4, 9, 31).getTime()).notify, false, "once a day");
	});

	it("an active exam whose date passed archives itself with its final standing", () => {
		const parsed = exams.parseExamCreate({ title: "Química", examDate: "2026-11-10", syllabus: { text: "x" } });
		const past = exams.createExam(parsed.ok ? parsed.value : (null as never), now);
		exams.updateExam(past.id, { blocks, status: "active" }, now);
		const later = new Date(2026, 10, 12, 10).getTime();
		const view = exams.listExamViews(later).find((e) => e.id === past.id)!;
		assert.equal(view.status, "archived");
		assert.equal(typeof view.final!.coverage, "number");
		const graded = exams.updateExam(past.id, { realGrade: "7,5" }, later);
		assert.ok(graded.ok && graded.value.realGrade === "7,5");
		assert.equal(exams.parseExamPatch({ status: "draft" }).ok, false);
		assert.ok(exams.deleteExam(past.id));
		assert.equal(exams.examDetailView(past.id, later), null);
	});
});

describe("syllabus candidates", () => {
	it("folder ideas first, then word-overlap hits per syllabus line (accents folded)", () => {
		const ids = syllabusCandidates({
			text: "Tema 1: aceleracion\nTema 2: nada",
			nodes: nodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
			folderNodeIds: new Set(["n_src"]),
		});
		assert.deepEqual(ids, ["n_src", "n_a"]);
	});
});

describe("«conocimientos previos» in the service (owner 2026-11-09)", () => {
	const { readExam, writeExam } = storeMod;

	it("a hand-edited list is saved; what rests on it must exist", () => {
		const patch = exams.parseExamPatch({
			prerequisites: [{ id: "q_pow", statement: "Propiedades de las potencias", blocks: ["p1", "nope"], origin: "user", depth: 1 }],
		});
		assert.ok(patch.ok);
		assert.ok(exams.updateExam(examId, patch.ok ? patch.value : {}, now).ok);
		assert.deepEqual(readExam(examId)!.prerequisites![0]!.blocks, ["p1"]);
		assert.equal(exams.parseExamPatch({ prerequisites: [{ id: "x" }] }).ok, false);
		const detail = exams.examDetailView(examId, now)!;
		assert.equal(detail.model!.prerequisites[0]!.state, "placement");
		assert.deepEqual(detail.model!.points.find((p) => p.id === "p1")!.blockedBy, ["q_pow"]);
	});

	it("the placement test asks the prerequisites first, with the diagnosis rule", () => {
		const started = exams.startExamSession(examId, "placement", undefined, now);
		assert.ok(started.ok);
		const record = getChat(started.ok ? started.session.id : "")!;
		assert.equal(record.exam!.pointIds![0], "q_pow");
		const appendix = exams.examSessionAppendix(record)!;
		assert.match(appendix, /Start with the prerequisites/);
		assert.match(appendix, /\[q_pow\] Propiedades de las potencias/);
		assert.match(appendix, /at most 3 levels under the syllabus/);
		assert.ok(!appendix.includes("{"), "every placeholder filled");
	});

	it("the diagnosis registers bases one level deeper, at most three; the same statement is reused", () => {
		const one = exams.noteDiagnosedPrerequisite(examId, { statement: "Multiplicar fracciones", under: "q_pow" }, now);
		assert.ok(one.ok);
		const two = exams.noteDiagnosedPrerequisite(examId, { statement: "Tablas de multiplicar", under: one.ok ? one.id : "" }, now);
		assert.ok(two.ok);
		const deep = exams.noteDiagnosedPrerequisite(examId, { statement: "Contar", under: two.ok ? two.id : "" }, now);
		assert.equal(deep.ok, false, "a fourth level is refused");
		const same = exams.noteDiagnosedPrerequisite(examId, { statement: "multiplicar  FRACCIONES", under: "p2" }, now);
		assert.ok(same.ok && one.ok && same.id === one.id);
		const list = readExam(examId)!.prerequisites!;
		const frac = list.find((q) => q.id === (one.ok ? one.id : ""))!;
		assert.equal(frac.depth, 2);
		assert.equal(frac.origin, "diagnosis");
		assert.deepEqual(frac.blocks.sort(), ["p2", "q_pow"].sort());
		assert.equal(exams.noteDiagnosedPrerequisite(examId, { statement: "x", under: "zzz" }, now).ok, false);
		assert.ok(exams.noteDiagnosedPrerequisite(examId, { statement: "Vectores", under: "n_v" }, now).ok, "a graph idea's point");
	});

	it("a prerequisite's teach session carries its id and the prior-knowledge appendix", () => {
		const started = exams.startExamSession(examId, "teach", "q_pow", now);
		assert.ok(started.ok);
		const record = getChat(started.ok ? started.session.id : "")!;
		assert.deepEqual(record.exam, { id: examId, kind: "teach", prerequisiteId: "q_pow" });
		const appendix = exams.examSessionAppendix(record)!;
		assert.match(appendix, /## Prior knowledge for an exam/);
		assert.match(appendix, /Propiedades de las potencias/);
		assert.match(appendix, /Needed for: .*Velocidad y aceleración/);
	});

	it("a proposal is applied (checked items only) or discarded; detection needs a model", () => {
		assert.deepEqual(exams.startPrerequisiteDetection(examId, now), { ok: false, status: 503, error: "models_not_configured" });
		const exam = readExam(examId)!;
		writeExam({
			...exam,
			prerequisiteSearch: {
				state: "ready",
				mode: "review",
				at: new Date(now).toISOString(),
				done: 1,
				total: 1,
				items: [
					{ id: "q_new", statement: "Despejar ecuaciones", points: ["p1"], nodeIds: [], evidence: ["Calcula v"] },
					{ id: "q_skip", statement: "Leer gráficas", points: ["p1"], nodeIds: [], evidence: [] },
					{ id: "q_reuse", reuse: "q_pow", statement: "Propiedades de las potencias", points: ["p2"], nodeIds: [], evidence: [] },
				],
			},
		});
		const applied = exams.applyPrerequisiteProposal(examId, { accept: ["q_new", "q_reuse"] }, now);
		assert.ok(applied.ok);
		assert.equal(applied.ok && applied.value.added, 1);
		const after = readExam(examId)!;
		assert.equal(after.prerequisiteSearch, undefined);
		assert.ok(after.prerequisites!.some((q) => q.id === "q_new"));
		assert.ok(!after.prerequisites!.some((q) => q.statement === "Leer gráficas"));
		assert.ok(after.prerequisites!.find((q) => q.id === "q_pow")!.blocks.includes("p2"));
		assert.equal(exams.applyPrerequisiteProposal(examId, { discard: true }, now).ok, false, "nothing left to apply");
	});
});

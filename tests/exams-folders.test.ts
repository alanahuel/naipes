/** Exam folder tree + read-before-mapping plan (owner 2026-11-06): an
 *  isolated data dir and a synthetic knowledge folder. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-exam-folders-"));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), "np-exam-vault-"));
process.env.NP_DATA_DIR = DIR;
after(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.rmSync(VAULT, { recursive: true, force: true });
});

const write = (rel: string, text = "# nota\n") => {
	fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
	fs.writeFileSync(path.join(VAULT, rel), text);
};
write("Leídas/Física/Dinámica.md");
write("Acceso/índice.md");
write("Acceso/Matemáticas/Tema 1.md");
write("Acceso/Matemáticas/Tema 2.md");
write("Acceso/Inglés/Unit 1.md");
write("Acceso/.space/oculta.md");
write("Salida/Conceptos/X.md");
write("raíz.md");
fs.writeFileSync(
	path.join(DIR, "settings.json"),
	JSON.stringify({ version: 1, obsidian: { enabled: true, vaultPath: VAULT, folders: ["Leídas"], outputFolder: "Salida" } }),
);
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
fs.writeFileSync(path.join(DIR, "graph", "nodes.jsonl"), JSON.stringify({ id: "n1", name: "Fuerza", statement: "F = m a", aliases: [], createdAt: "2026-11-01T00:00:00Z", provenance: [{ chatId: "src_1", messageId: "src_1" }] }) + "\n");
fs.writeFileSync(path.join(DIR, "graph", "sources.json"), JSON.stringify({ src_1: { id: "src_1", filePath: "Leídas/Física/Dinámica.md", importedAt: "2026-11-01T00:00:00Z" } }));

const exams = await import("../src/server/exams.ts");

describe("exam folder tree (whole knowledge folder)", () => {
	it("lists every folder with notes, read or not; hidden and output folders out; root notes skipped", () => {
		const { folders, watched } = exams.listExamFolders();
		assert.deepEqual(watched, ["Leídas"]);
		const by = new Map(folders.map((f) => [f.path, f]));
		assert.deepEqual([...by.keys()], ["Acceso", "Acceso/Inglés", "Acceso/Matemáticas", "Leídas", "Leídas/Física"]);
		assert.deepEqual(by.get("Acceso"), { path: "Acceso", ideas: 0, notes: 4, unread: 4, direct: 1, directUnread: 1 });
		assert.equal(by.get("Leídas/Física")!.ideas, 1);
		assert.equal(by.get("Leídas")!.unread, 0);
	});
	it("readingPlan: a partial folder with loose notes is added whole; read folders never", () => {
		assert.deepEqual(exams.readingPlan({ folders: ["Acceso/Matemáticas"], directFolders: ["Acceso"] }), [{ path: "Acceso", unread: 4 }]);
		assert.deepEqual(exams.readingPlan({ folders: ["Acceso/Matemáticas", "Leídas"], directFolders: [] }), [{ path: "Acceso/Matemáticas", unread: 2 }]);
		assert.deepEqual(exams.readingPlan({ folders: ["Leídas"], directFolders: [] }), []);
	});
	it("creating keeps the scope and the context; mapping without a strong model adds nothing", () => {
		const parsed = exams.parseExamCreate({
			title: "PAU +25",
			examDate: "2027-05-20",
			context: { kind: "official", name: "PAU mayores de 25", sitting: "2027" },
			syllabus: { text: "", folders: ["Acceso/Matemáticas"], directFolders: ["Acceso", "Acceso/Matemáticas"] },
		});
		assert.ok(parsed.ok);
		const exam = exams.createExam(parsed.ok ? parsed.value : (null as never));
		assert.deepEqual(exam.syllabus.directFolders, ["Acceso"], "a folder already recursive is not also loose");
		assert.equal(exam.context.kind, "official");
		assert.equal(exam.context.sitting, "2027");
		assert.deepEqual(exams.startExamMapping(exam.id), { ok: false, status: 503, error: "models_not_configured" });
		const settings = JSON.parse(fs.readFileSync(path.join(DIR, "settings.json"), "utf-8"));
		assert.deepEqual(settings.obsidian.folders, ["Leídas"]);
	});
	it("materials: files stored with the exam, links validated, removal deletes the copy", () => {
		const exam = exams.listExamViews()[0]!;
		const file = exams.addExamMaterial(exam.id, { kind: "file", name: "Guía 2027.pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
		assert.ok(file.ok);
		const stored = exams.materialPath(exam.id, file.ok ? file.value.file! : "")!;
		assert.ok(fs.existsSync(stored));
		assert.equal(exams.addExamMaterial(exam.id, { kind: "link", url: "ftp://x" }).ok, false);
		assert.ok(exams.addExamMaterial(exam.id, { kind: "link", url: "https://example.org/guia" }).ok);
		assert.ok(exams.removeExamMaterial(exam.id, file.ok ? file.value.id : ""));
		assert.ok(!fs.existsSync(stored));
		assert.ok(exams.deleteExam(exam.id));
	});
	it("session prompts: placement probes unlinked targets by id; teach lists its targets; deepen", () => {
		const parsed = exams.parseExamCreate({ title: "Física", examDate: "2027-05-20", syllabus: { text: "Dinámica" } });
		const exam = exams.createExam(parsed.ok ? parsed.value : (null as never));
		const tg = (id: string, statement: string) => ({ id, statement, source: { kind: "model", title: "" }, nodeIds: [] });
		const updated = exams.updateExam(exam.id, { blocks: [{ id: "b1", title: "Dinámica", points: [{ id: "p1", text: "Leyes de Newton", nodeIds: [], targets: [tg("t_a", "F = m·a"), tg("t_b", "Acción y reacción")] }] }] as never });
		assert.ok(updated.ok);
		const placement = exams.examSessionAppendix({ exam: { id: exam.id, kind: "placement", pointIds: ["t_a", "t_b"] } })!;
		assert.ok(placement.includes("These target ideas are not in the learner's map yet"));
		assert.ok(placement.includes("[t_a] F = m·a"));
		const teach = exams.examSessionAppendix({ exam: { id: exam.id, kind: "teach", pointId: "p1", targetIds: ["t_b"] } })!;
		assert.ok(teach.includes("The target ideas to establish:\n- Acción y reacción"));
		assert.ok(!teach.includes("F = m·a"));
		assert.ok(teach.includes("You may bring in closely related ideas"));
		const deepen = exams.examSessionAppendix({ exam: { id: exam.id, kind: "deepen", pointId: "p1" } })!;
		assert.ok(deepen.includes("## Going deeper") && deepen.includes("Leyes de Newton"));
	});
});

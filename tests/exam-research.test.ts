/** Exam research (owner-approved 2026-11-06): the researcher's submit
 *  contract with a scripted faux engine, the prompt pieces, and the
 *  Claude Code search result parser. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { examResearchInstructions, examResearchPrompt, runExamResearcher, type ResearchTask } from "../src/agent/subagents/exam-researcher.ts";
import { examClassifierPrompt, runExamClassifier } from "../src/agent/subagents/exam-classifier.ts";
import { SYLLABUS_MAPPER_INSTRUCTIONS } from "../src/agent/subagents/syllabus-mapper.ts";
import { parseClaudeSearchResult, searchResultFromStream } from "../src/server/exam-research-io.ts";
import { researchDepth, sanitizeTargets, syncPointLinks, presetStandard } from "../src/core/exams.ts";

const PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-research-test-"));
after(() => fs.rmSync(PDF_DIR, { recursive: true, force: true }));

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const call = (name: string, input: unknown, id: string) => () => fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const task: ResearchTask = {
	exam: { title: "PAU +25", examDate: "2027-05-20" },
	context: ["Type: official", "Sitting / year: 2027"],
	materials: [{ id: "mat_1", name: "Tema 1.pdf", kind: "file" }],
	block: { index: 1, total: 2, title: "Funciones", points: [{ id: "p1", text: "Límites", kind: "syllabus" }, { id: "p2", text: "Derivadas", kind: "syllabus" }] },
	candidates: [{ id: "n1", name: "Límite", statement: "El límite describe…" }],
};

describe("exam researcher", () => {
	it("the prompt carries context, materials, the block and the candidates; depth follows the standard", () => {
		const prompt = examResearchPrompt(task);
		assert.ok(prompt.includes("CONTEXT:\nType: official\nSitting / year: 2027"));
		assert.ok(prompt.includes("[mat_1] Tema 1.pdf (file — read_material)"));
		assert.ok(prompt.includes("BLOCK 1 of 2: Funciones"));
		assert.ok(prompt.includes("[p2] (KIND: syllabus) Derivadas"));
		assert.ok(prompt.includes("[n1] Límite — El límite describe…"));
		const sys = examResearchInstructions({ today: "2026-11-06", examDate: "2027-05-20", sitting: "2027", depth: researchDepth(presetStandard("merit")) });
		assert.ok(sys.includes("today is 2026-11-06; the exam is on 2027-05-20 (sitting 2027)"));
		assert.ok(sys.includes("Solid command"));
		assert.ok(sys.includes('For "rules" points, produce the exam\'s concrete rules instead'));
		assert.equal(researchDepth({ preset: null, mode: "composition" }), "distinction");
	});
	it("reads a material, then submits; a missing point or an unknown id is retried", async () => {
		const reads: string[] = [];
		const good = {
			points: [
				{ pointId: "p1", targets: [{ statement: "Un límite es…", source: { kind: "material", title: "Tema 1.pdf", ref: "mat_1" }, nodeIds: ["n1"] }] },
				{ pointId: "p2", targets: [{ statement: "La derivada es…", source: { kind: "web", title: "Guía 2026", ref: "https://x.org/g", year: "2026" }, nodeIds: [] }] },
			],
		};
		const engine = fauxEngine([
			call("read_material", { id: "mat_1" }, "r1"),
			call("submit_research", { points: [good.points[0]] }, "s1"),
			call("submit_research", { points: [{ ...good.points[0], targets: [{ ...good.points[0]!.targets[0], nodeIds: ["nope"] }] }, good.points[1]] }, "s2"),
			call("submit_research", good, "s3"),
		]);
		const result = await runExamResearcher({
			engine,
			task,
			instructions: "x",
			search: () => null,
			readMaterial: async (id) => {
				reads.push(id);
				return "texto del tema";
			},
			pdfDir: PDF_DIR,
		});
		assert.deepEqual(reads, ["mat_1"]);
		assert.equal(result.get("p1")![0]!.nodeIds[0], "n1");
		assert.equal(result.get("p2")![0]!.source.year, "2026");
	});
});

describe("targets in the record", () => {
	it("sanitize keeps the source, drops junk; a point's links follow its targets", () => {
		const targets = sanitizeTargets([
			{ id: "t1", statement: " A ", source: { kind: "web", title: "G", ref: "https://g", year: "2026", outdated: true }, nodeIds: ["n1", "n1"] },
			{ id: "t1", statement: "dup" },
			{ id: "t2", statement: "", source: {} },
			{ id: "t3", statement: "B", source: { kind: "weird" } },
		])!;
		assert.deepEqual(targets.map((t) => t.id), ["t1", "t3"]);
		assert.deepEqual(targets[0], { id: "t1", statement: "A", source: { kind: "web", title: "G", ref: "https://g", year: "2026", outdated: true }, nodeIds: ["n1"] });
		assert.equal(targets[1]!.source.kind, "model");
		const [block] = syncPointLinks([{ id: "b", title: "B", points: [{ id: "p", text: "P", nodeIds: ["old"], targets: [{ ...targets[0]!, nodeIds: ["n1", "n2"] }, { ...targets[1]!, nodeIds: ["n2"] }] }] }]);
		assert.deepEqual(block!.points[0]!.nodeIds, ["n1", "n2"]);
	});
});

describe("Claude Code search", () => {
	it("pulls the links out of WebSearch's tool result in the stream", () => {
		const result = 'Web search results for query: "pau 25"\n\nLinks: [{"title":"Convocatoria Mayores 25 2026","url":"https://example.es/m25"},{"title":"Guía [2026]","url":"https://example.es/guia"}]\n\nResumen de la convocatoria…';
		const stream = [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } }), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: result }] } }), JSON.stringify({ type: "result", subtype: "error_max_turns" })].join("\n");
		const text = searchResultFromStream(stream)!;
		const hits = parseClaudeSearchResult(text, 5);
		assert.deepEqual(hits.map((h) => h.url), ["https://example.es/m25", "https://example.es/guia"]);
		assert.equal(hits[1]!.title, "Guía [2026]");
		assert.ok(hits[0]!.snippet.startsWith("Resumen"));
		assert.deepEqual(parseClaudeSearchResult("nothing here", 5), []);
	});
});

describe("targets survive the record round-trip", () => {
	it("sanitizeBlocks keeps a point's targets", async () => {
		const { sanitizeBlocks } = await import("../src/core/exams.ts");
		const blocks = sanitizeBlocks([{ id: "b1", title: "A", points: [{ id: "p1", text: "x", nodeIds: [], targets: [{ id: "t1", statement: "S", source: { kind: "web", title: "G" }, nodeIds: [] }] }] }]);
		assert.equal(blocks[0]!.points[0]!.targets?.[0]?.statement, "S");
	});
});

describe("exam sorter", () => {
	it("sorts every idea to a target or extension; unknown ids are retried", async () => {
		const { runExamSorter, examSorterPrompt } = await import("../src/agent/subagents/exam-sorter.ts");
		const input = { point: "Límites", targets: [{ id: "t1", statement: "Definición de límite" }], ideas: [{ id: "n5", name: "Límite", statement: "…" }, { id: "n6", name: "Sucesiones", statement: "…" }] };
		assert.ok(examSorterPrompt(input).includes("TARGETS:\n[t1] Definición de límite"));
		const engine = fauxEngine([
			call("submit_sort", { ideas: [{ id: "n5", target: "t9" }, { id: "n6", target: "extension" }] }, "a"),
			call("submit_sort", { ideas: [{ id: "n5", target: "t1" }, { id: "n6", target: "extension" }] }, "b"),
		]);
		const sorted = await runExamSorter({ engine, input });
		assert.deepEqual([...sorted], [["n5", "t1"], ["n6", "extension"]]);
	});
});

describe("instruction points in the research (owner 2026-11-06)", () => {
	it("rules never link graph ideas, even when the model lists some", async () => {
		const rulesTask: ResearchTask = { ...task, block: { ...task.block, points: [{ id: "p1", text: "Límites", kind: "syllabus" }, { id: "p2", text: "Sin calculadora", kind: "rules" }] } };
		const engine = fauxEngine([
			call(
				"submit_research",
				{
					points: [
						{ pointId: "p1", targets: [{ statement: "Un límite es…", source: { kind: "model", title: "" }, nodeIds: ["n1"] }] },
						{ pointId: "p2", targets: [{ statement: "No se permite calculadora.", source: { kind: "web", title: "Guía", year: "2026" }, nodeIds: ["n1"] }] },
					],
				},
				"s1",
			),
		]);
		const result = await runExamResearcher({ engine, task: rulesTask, instructions: "x", search: () => null, readMaterial: async () => "", pdfDir: PDF_DIR });
		assert.deepEqual(result.get("p1")![0]!.nodeIds, ["n1"]);
		assert.deepEqual(result.get("p2")![0]!.nodeIds, []);
	});
	it("the classifier gives every block a kind; an unknown id is retried", async () => {
		const blocks = [
			{ id: "b1", title: "Funciones", points: [{ id: "p1", text: "Límites" }, { id: "p2", text: "Sin calculadora" }] },
			{ id: "b2", title: "Cómo enseñar", points: [{ id: "p3", text: "Comprueba cada paso" }] },
		];
		const engine = fauxEngine([
			call("submit_kinds", { blocks: [{ id: "b1", kind: "syllabus", points: [{ id: "px", kind: "rules" }] }, { id: "b2", kind: "tutor" }] }, "k1"),
			call("submit_kinds", { blocks: [{ id: "b1", kind: "syllabus", points: [{ id: "p2", kind: "rules" }] }, { id: "b2", kind: "tutor" }] }, "k2"),
		]);
		assert.ok(examClassifierPrompt(blocks).includes("[b2] Cómo enseñar\n  [p3] Comprueba cada paso"));
		const kinds = await runExamClassifier({ engine, blocks });
		assert.equal(kinds.blocks.get("b2"), "tutor");
		assert.equal(kinds.points.get("p2"), "rules");
	});
	it("the mapper (guía oficial primero) keeps only subject matter and never builds the syllabus from the graph", () => {
		assert.ok(SYLLABUS_MAPPER_INSTRUCTIONS.includes("Only subject matter: leave out exam rules and logistics"));
		assert.ok(SYLLABUS_MAPPER_INSTRUCTIONS.includes("Never turn candidate propositions into blocks or points."));
		assert.ok(!SYLLABUS_MAPPER_INSTRUCTIONS.includes("Give each block and point a kind"));
	});
});

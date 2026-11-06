/** The syllabus mapper («guía oficial primero», 2026-11-06): one submit
 *  call; ids outside the candidate list are a retryable error; an idea is
 *  linked or ampliación, once. Faux engine only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runSyllabusMapper, syllabusMapperPrompt } from "../src/agent/subagents/syllabus-mapper.ts";

function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (input: unknown, id: string): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("submit_syllabus", input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const candidates = [
	{ id: "n1", name: "Velocidad", statement: "v = d/t" },
	{ id: "n2", name: "Velocidad media en carreras", statement: "Ejemplo aplicado" },
	{ id: "n3", name: "Romanticismo", statement: "Movimiento literario" },
];

describe("syllabus mapper", () => {
	it("the prompt gives the official outline, the guidelines, the context and the candidates", () => {
		const prompt = syllabusMapperPrompt({ official: "## Tema 1\n- [o1] Velocidad", guidelines: "", context: ["Exam / subject: Física"], candidates });
		assert.match(prompt, /OFFICIAL SYLLABUS:\n## Tema 1\n- \[o1\] Velocidad/);
		assert.match(prompt, /LEARNER'S GUIDELINES:\n\(none\)/);
		assert.match(prompt, /CONTEXT:\nExam \/ subject: Física/);
		assert.match(prompt, /\[n1\] Velocidad — v = d\/t/);
	});
	it("retries an unknown id, then returns origins, links, ampliación (once, never linked) and conflicts", async () => {
		const bad = { blocks: [{ title: "Cinemática", points: [{ text: "Velocidad", origin: "official", nodeIds: ["n9"] }] }] };
		const good = {
			blocks: [
				{
					title: " Cinemática ",
					points: [
						{ text: "Velocidad", origin: "official", nodeIds: ["n1", "n1"], extension: ["n2", "n1"] },
						{ text: "Aceleración", origin: "user", nodeIds: [], extension: ["n2"] },
						{ text: " ", origin: "model", nodeIds: [] },
					],
				},
				{ title: "Dinámica", excluded: true, points: [{ text: "Leyes de Newton", origin: "official", nodeIds: [] }] },
			],
			conflicts: [" Tus directrices quitan el tema 2. "],
		};
		const mapped = await runSyllabusMapper({ engine: engine([submit(bad, "c1"), submit(good, "c2")]), official: "x", guidelines: "", context: [], candidates });
		assert.deepEqual(mapped, {
			blocks: [
				{
					title: "Cinemática",
					points: [
						{ text: "Velocidad", nodeIds: ["n1"], origin: "official", extension: ["n2"] },
						{ text: "Aceleración", nodeIds: [], origin: "user" },
					],
				},
				{ title: "Dinámica", excluded: true, points: [{ text: "Leyes de Newton", nodeIds: [], origin: "official" }] },
			],
			conflicts: ["Tus directrices quitan el tema 2."],
		});
	});
});

/** The syllabus mapper agent («Exámenes», 2026-11-06): one submit call; ids
 *  outside the candidate list are a retryable error. Faux engine only. */
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

const candidates = [{ id: "n1", name: "Velocidad", statement: "v = d/t" }];

describe("syllabus mapper", () => {
	it("the prompt lists the syllabus and the candidates", () => {
		const prompt = syllabusMapperPrompt("Tema 1", candidates);
		assert.match(prompt, /SYLLABUS:\nTema 1/);
		assert.match(prompt, /\[n1\] Velocidad — v = d\/t/);
	});
	it("retries an unknown id, then returns the cleaned blocks", async () => {
		const bad = { blocks: [{ title: "Cinemática", kind: "syllabus", points: [{ text: "Velocidad", nodeIds: ["n9"] }] }] };
		const good = {
			blocks: [
				{ title: " Cinemática ", kind: "syllabus", points: [{ text: "Velocidad", nodeIds: ["n1", "n1"] }, { text: "Rozamiento", nodeIds: [] }, { text: " ", nodeIds: [] }, { text: "Sin calculadora", kind: "rules", nodeIds: [] }] },
				{ title: "Cómo enseñar", kind: "tutor", points: [{ text: "Comprueba cada paso", nodeIds: [] }] },
			],
		};
		const blocks = await runSyllabusMapper({ engine: engine([submit(bad, "c1"), submit(good, "c2")]), syllabus: "Tema 1", candidates });
		assert.deepEqual(blocks, [
			{ title: "Cinemática", kind: "syllabus", points: [{ text: "Velocidad", nodeIds: ["n1"] }, { text: "Rozamiento", nodeIds: [] }, { text: "Sin calculadora", nodeIds: [], kind: "rules" }] },
			{ title: "Cómo enseñar", kind: "tutor", points: [{ text: "Comprueba cada paso", nodeIds: [] }] },
		]);
	});
});

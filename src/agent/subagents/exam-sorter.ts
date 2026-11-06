/**
 * The exam idea sorter (owner-approved prompt 2026-11-06): right after an
 * exam teach/consolidation session is extracted, the ideas the learner
 * just formed are sorted — each one links to the point's TARGET it
 * expresses, or is «ampliación» (extension: dated review, not counted).
 * One submit_sort call on the cheap slot (the extractor's role).
 */

import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const EXAM_SORTER_INSTRUCTIONS = `You sort the ideas a learner just formed in one study session for an exam point. For each IDEA, answer with the id of the TARGET it expresses, fully or in part, or "extension" when it goes beyond every target. Never stretch a weak match. Your whole deliverable is one submit_sort call.`;

const sortSchema = Type.Object({
	ideas: Type.Array(
		Type.Object({
			id: Type.String({ description: "The idea's id exactly as listed in IDEAS." }),
			target: Type.String({ description: 'The TARGET id it expresses, or "extension".' }),
		}),
	),
});

export interface SortInput {
	point: string;
	targets: ReadonlyArray<{ id: string; statement: string }>;
	ideas: ReadonlyArray<{ id: string; name: string; statement: string }>;
}

export function examSorterPrompt(input: SortInput): string {
	return [
		`POINT: ${input.point}`,
		`TARGETS:\n${input.targets.map((t) => `[${t.id}] ${t.statement}`).join("\n")}`,
		`IDEAS:\n${input.ideas.map((i) => `[${i.id}] ${i.name} — ${i.statement}`).join("\n")}`,
	].join("\n\n");
}

/** idea id → target id, or "extension". */
export async function runExamSorter(opts: { engine: PiEngine | undefined; input: SortInput; signal?: AbortSignal }): Promise<Map<string, string>> {
	const ideaIds = new Set(opts.input.ideas.map((i) => i.id));
	const targetIds = new Set(opts.input.targets.map((t) => t.id));
	return runSubmitAgent<Map<string, string>>({
		role: "extractor",
		toolName: "submit_sort",
		toolDescription: "Submit, for every listed idea, the target id it expresses or \"extension\".",
		parameters: sortSchema,
		fill: (input: { ideas: Array<{ id: string; target: string }> }) => new Map(input.ideas.map((i) => [i.id.trim(), i.target.trim()])),
		validate: (sorted) => {
			const missing = [...ideaIds].filter((id) => !sorted.has(id));
			if (missing.length) return `sort every idea — missing: ${missing.slice(0, 10).join(", ")}`;
			const bad = [...sorted].filter(([id, target]) => !ideaIds.has(id) || (target !== "extension" && !targetIds.has(target)));
			return bad.length ? `unknown ids: ${bad.slice(0, 10).map(([id, target]) => `${id}→${target}`).join(", ")} — use only listed ids or "extension"` : null;
		},
		systemPrompt: EXAM_SORTER_INSTRUCTIONS,
		prompt: examSorterPrompt(opts.input),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the exam sorter never submitted",
	});
}

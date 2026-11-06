/**
 * The syllabus classifier (owner-approved prompt 2026-11-06): «Clasificar
 * temario» on an exam made before point types gives each block and point
 * its kind — syllabus, the subject's rules, or tutor instructions. One
 * submit_kinds call on the strong slot (the mapper's role).
 */

import { Type } from "typebox";
import type { PointKind } from "../../core/exams.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { kindSchema } from "./syllabus-mapper.ts";

export const EXAM_CLASSIFIER_INSTRUCTIONS = `You classify the blocks and points of an exam syllabus. For each, answer "syllabus" (something to learn), "rules" (how the exam itself runs: what is allowed or forbidden, what scores, timing, format, conditions) or "tutor" (instructions on how the learner wants to be taught or checked). A point's kind defaults to its block's; give it its own only when it differs. Your whole deliverable is ONE submit_kinds call.`;

const kindsSchema = Type.Object({
	blocks: Type.Array(
		Type.Object({
			id: Type.String({ description: "The block's id exactly as listed." }),
			kind: kindSchema("The block's kind."),
			points: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "The point's id exactly as listed." }),
						kind: kindSchema("The point's kind, only when it differs from its block's."),
					}),
				),
			),
		}),
	),
});

export interface ClassifyBlock {
	id: string;
	title: string;
	points: ReadonlyArray<{ id: string; text: string }>;
}

export interface Classification {
	blocks: Map<string, PointKind>;
	/** Points whose kind differs from their block's. */
	points: Map<string, PointKind>;
}

export function examClassifierPrompt(blocks: readonly ClassifyBlock[]): string {
	return `SYLLABUS:\n${blocks.map((b) => [`[${b.id}] ${b.title}`, ...b.points.map((p) => `  [${p.id}] ${p.text}`)].join("\n")).join("\n")}`;
}

export async function runExamClassifier(opts: { engine: PiEngine | undefined; blocks: readonly ClassifyBlock[]; signal?: AbortSignal }): Promise<Classification> {
	const blockIds = new Set(opts.blocks.map((b) => b.id));
	const pointIds = new Set(opts.blocks.flatMap((b) => b.points.map((p) => p.id)));
	return runSubmitAgent<Classification>({
		role: "syllabusMapper",
		toolName: "submit_kinds",
		toolDescription: "Submit every block's kind, and the points whose kind differs from their block's.",
		parameters: kindsSchema,
		fill: (input: { blocks: Array<{ id: string; kind: PointKind; points?: Array<{ id: string; kind: PointKind }> }> }) => ({
			blocks: new Map(input.blocks.map((b) => [b.id.trim(), b.kind])),
			points: new Map(input.blocks.flatMap((b) => (b.points ?? []).map((p) => [p.id.trim(), p.kind] as const))),
		}),
		validate: (result) => {
			const missing = [...blockIds].filter((id) => !result.blocks.has(id));
			if (missing.length) return `give every block a kind — missing: ${missing.slice(0, 10).join(", ")}`;
			const unknown = [...[...result.blocks.keys()].filter((id) => !blockIds.has(id)), ...[...result.points.keys()].filter((id) => !pointIds.has(id))];
			return unknown.length ? `unknown ids: ${unknown.slice(0, 10).join(", ")} — use only listed ids` : null;
		},
		systemPrompt: EXAM_CLASSIFIER_INSTRUCTIONS,
		prompt: examClassifierPrompt(opts.blocks),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the syllabus classifier never submitted",
	});
}

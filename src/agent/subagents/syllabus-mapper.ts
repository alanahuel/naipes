/**
 * The syllabus mapper («Exámenes», owner-approved prompt 2026-11-06): ONE
 * submit call on the strong slot splits an exam syllabus into blocks and
 * points and links each point to candidate graph propositions; a point
 * with nothing matching stays empty («falta»). The candidates are chosen
 * by the server (the syllabus areas + word-overlap hits per syllabus
 * line, src/core/exams.ts syllabusCandidates); ids outside them are a
 * retryable submit error.
 */

import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const SYLLABUS_MAPPER_INSTRUCTIONS = `You map an exam syllabus onto the learner's knowledge graph.

Input: the syllabus (free text, possibly extracted from a document) and candidate propositions from the graph, each as [id] name — statement.

1. Split the syllabus into blocks (its own topics or chapters, in its order) and points (the individual things to know, one claim or skill each, short, in the syllabus's own words).
2. For each point, list the ids of the candidates that belong to it — the ones a learner must hold to know that point. A proposition may belong to several points. Only ids from the list.
3. A point with nothing matching gets an empty list — it is missing from the graph and will be taught. Never stretch a weak match to avoid an empty list.
4. Ignore administrative text (dates, grading rules, bibliography).

Write block titles and points in the syllabus's language. Your whole deliverable is ONE submit_syllabus call.`;

const syllabusSchema = Type.Object({
	blocks: Type.Array(
		Type.Object({
			title: Type.String({ description: "The block's title (a topic or chapter of the syllabus)." }),
			points: Type.Array(
				Type.Object({
					text: Type.String({ description: "One thing to know, short, in the syllabus's own words." }),
					nodeIds: Type.Array(Type.String(), { description: "Candidate proposition ids that belong to this point; [] when none matches." }),
				}),
			),
		}),
		{ minItems: 1 },
	),
});

export interface MappedBlock {
	title: string;
	points: Array<{ text: string; nodeIds: string[] }>;
}

export interface SyllabusCandidate {
	id: string;
	name: string;
	statement: string;
}

/** The mapper's user prompt: the syllabus, then the candidate list. */
export function syllabusMapperPrompt(syllabus: string, candidates: readonly SyllabusCandidate[]): string {
	const list = candidates.length
		? candidates.map((c) => `[${c.id}] ${c.name} — ${c.statement}`).join("\n")
		: "(no candidates — the graph has nothing related; every point is missing)";
	return `SYLLABUS:\n${syllabus}\n\nCANDIDATE PROPOSITIONS:\n${list}`;
}

export async function runSyllabusMapper(opts: {
	engine: PiEngine | undefined;
	syllabus: string;
	candidates: readonly SyllabusCandidate[];
	signal?: AbortSignal;
}): Promise<MappedBlock[]> {
	const known = new Set(opts.candidates.map((c) => c.id));
	return runSubmitAgent<MappedBlock[]>({
		role: "syllabusMapper",
		toolName: "submit_syllabus",
		toolDescription: "Submit the syllabus as blocks of points, each with its matching candidate proposition ids.",
		parameters: syllabusSchema,
		fill: (input: { blocks: MappedBlock[] }) =>
			input.blocks
				.map((b) => ({
					title: b.title.trim(),
					points: b.points.map((p) => ({ text: p.text.trim(), nodeIds: [...new Set(p.nodeIds)] })).filter((p) => p.text.length > 0),
				}))
				.filter((b) => b.title.length > 0 && b.points.length > 0),
		validate: (blocks) => {
			if (blocks.length === 0) return "submit at least one block with at least one point";
			const unknown = [...new Set(blocks.flatMap((b) => b.points.flatMap((p) => p.nodeIds)).filter((id) => !known.has(id)))];
			return unknown.length ? `these ids are not in the candidate list: ${unknown.slice(0, 10).join(", ")} — use only listed ids` : null;
		},
		systemPrompt: SYLLABUS_MAPPER_INSTRUCTIONS,
		prompt: syllabusMapperPrompt(opts.syllabus, opts.candidates),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the syllabus mapper never submitted a mapping",
	});
}

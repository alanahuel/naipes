/**
 * The syllabus mapper («guía oficial primero», owner-approved prompt
 * 2026-11-06): ONE submit call on the strong slot builds the exam's
 * blocks → points from the OFFICIAL outline (the guide finder's), adjusted
 * by the learner's guidelines (conflicts reported), or from the guidelines
 * / the model's proposal when there is no guide — never from the graph.
 * Each point carries its origin, links the candidate propositions that
 * express it, and gathers the closely related ones as ampliación; the
 * unrelated are left out. Candidates come from the server (scope folders
 * + word-overlap hits, src/core/exams.ts syllabusCandidates); ids outside
 * them are a retryable submit error. No rules/tutor kinds any more — only
 * subject matter (kindSchema stays for «Clasificar temario»).
 */

import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import type { PointKind, PointOrigin } from "../../core/exams.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const SYLLABUS_MAPPER_INSTRUCTIONS = `You build an exam's syllabus and map it onto the learner's knowledge graph.

Input: the OFFICIAL SYLLABUS (from the exam's guide, may be absent; blocks outside this sitting are marked), the LEARNER'S GUIDELINES (may be empty), the CONTEXT, and CANDIDATE PROPOSITIONS from the graph, each as [id] name — statement.

1. With an official syllabus, keep its blocks and points, in its order and words (origin "official"; points marked as not from the guide stay origin "model"). The guidelines only adjust it: they can restrict it, remove points, add points (origin "user"), or bring an out-of-sitting block in. When they contradict the guide, follow them and write the conflict as one short sentence in conflicts. Without an official syllabus, the guidelines are the syllabus (origin "user"); with neither, propose one from the CONTEXT with your own knowledge (origin "model"). Never turn candidate propositions into blocks or points.
2. Only subject matter: leave out exam rules and logistics (format, marking, dates, bibliography).
3. For each point, nodeIds = the candidates that express what the point requires, fully or in part. Never stretch a weak match.
4. extension = candidates that express no point but are closely related to one (they go deeper, apply or illustrate it): each candidate at most once, under its closest point. Candidates unrelated to every point are left out.
5. A block marked out of this sitting stays excluded: true unless the guidelines bring it in.

Write in the syllabus's language. Your whole deliverable is ONE submit_syllabus call.`;

export const kindSchema = (description: string) =>
	Type.Union([Type.Literal("syllabus"), Type.Literal("rules"), Type.Literal("tutor")], { description });

const originSchema = Type.Union([Type.Literal("official"), Type.Literal("user"), Type.Literal("model")], {
	description: "official = from the official syllabus; user = from the learner's guidelines; model = your own proposal (or a point not from the guide).",
});

const syllabusSchema = Type.Object({
	blocks: Type.Array(
		Type.Object({
			title: Type.String({ description: "The block's title (a topic or chapter of the syllabus)." }),
			excluded: Type.Optional(Type.Boolean({ description: "true when the block is out of this sitting." })),
			points: Type.Array(
				Type.Object({
					text: Type.String({ description: "One thing to know, short, in the syllabus's own words." }),
					origin: originSchema,
					nodeIds: Type.Array(Type.String(), { description: "Candidate ids that express this point; [] when none matches." }),
					extension: Type.Optional(Type.Array(Type.String(), { description: "Candidate ids closely related to this point that express no point." })),
				}),
			),
		}),
		{ minItems: 1 },
	),
	conflicts: Type.Optional(Type.Array(Type.String(), { description: "Where the guidelines contradict the official syllabus, one short sentence each." })),
});

export interface MappedBlock {
	title: string;
	kind?: PointKind;
	excluded?: boolean;
	points: Array<{ text: string; nodeIds: string[]; kind?: PointKind; origin?: PointOrigin; extension?: string[] }>;
}

export interface MappedSyllabus {
	blocks: MappedBlock[];
	conflicts: string[];
}

export interface SyllabusCandidate {
	id: string;
	name: string;
	statement: string;
}

/** The mapper's user prompt: official outline, guidelines, context, candidates. */
export function syllabusMapperPrompt(input: { official: string; guidelines: string; context: readonly string[]; candidates: readonly SyllabusCandidate[] }): string {
	const list = input.candidates.length
		? input.candidates.map((c) => `[${c.id}] ${c.name} — ${c.statement}`).join("\n")
		: "(no candidates — the graph has nothing related; every point is missing)";
	return [
		`OFFICIAL SYLLABUS:\n${input.official.trim() || "(none)"}`,
		`LEARNER'S GUIDELINES:\n${input.guidelines.trim() || "(none)"}`,
		`CONTEXT:\n${input.context.length ? input.context.join("\n") : "(none given)"}`,
		`CANDIDATE PROPOSITIONS:\n${list}`,
	].join("\n\n");
}

export async function runSyllabusMapper(opts: {
	engine: PiEngine | undefined;
	official: string;
	guidelines: string;
	context: readonly string[];
	candidates: readonly SyllabusCandidate[];
	signal?: AbortSignal;
}): Promise<MappedSyllabus> {
	const known = new Set(opts.candidates.map((c) => c.id));
	type Input = { blocks: Array<{ title: string; excluded?: boolean; points: Array<{ text: string; origin: PointOrigin; nodeIds: string[]; extension?: string[] }> }>; conflicts?: string[] };
	return runSubmitAgent<MappedSyllabus>({
		role: "syllabusMapper",
		toolName: "submit_syllabus",
		toolDescription: "Submit the syllabus as blocks of points, each with its origin, its matching candidate ids and its ampliación candidates.",
		parameters: syllabusSchema,
		fill: (input: Input): MappedSyllabus => {
			const used = new Set<string>();
			const blocks = input.blocks
				.map((b) => ({
					title: b.title.trim(),
					...(b.excluded ? { excluded: true } : {}),
					points: b.points
						.map((p) => {
							const nodeIds = [...new Set(p.nodeIds)];
							// An idea is linked or ampliación, once — never both.
							const extension = [...new Set(p.extension ?? [])].filter((id) => !nodeIds.includes(id) && !used.has(id));
							for (const id of extension) used.add(id);
							return { text: p.text.trim(), nodeIds, origin: p.origin, ...(extension.length ? { extension } : {}) };
						})
						.filter((p) => p.text.length > 0),
				}))
				.filter((b) => b.title.length > 0 && b.points.length > 0);
			const linked = new Set(blocks.flatMap((b) => b.points.flatMap((p) => p.nodeIds)));
			for (const b of blocks)
				for (const p of b.points) if ("extension" in p && p.extension) p.extension = p.extension.filter((id) => !linked.has(id));
			return { blocks, conflicts: (input.conflicts ?? []).map((c) => c.trim()).filter(Boolean) };
		},
		validate: (r) => {
			if (r.blocks.length === 0) return "submit at least one block with at least one point";
			const ids = r.blocks.flatMap((b) => b.points.flatMap((p) => [...p.nodeIds, ...(p.extension ?? [])]));
			const unknown = [...new Set(ids.filter((id) => !known.has(id)))];
			return unknown.length ? `these ids are not in the candidate list: ${unknown.slice(0, 10).join(", ")} — use only listed ids` : null;
		},
		systemPrompt: SYLLABUS_MAPPER_INSTRUCTIONS,
		prompt: syllabusMapperPrompt(opts),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the syllabus mapper never submitted a mapping",
	});
}

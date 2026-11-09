/**
 * The prerequisite finder («conocimientos previos», owner-approved prompt A
 * 2026-11-09): one run per syllabus block lists the knowledge the block's
 * points take for granted — earlier-stage foundations the syllabus does not
 * teach itself — each with the points resting on it, linked to the
 * learner's graph ideas it finds with search_ideas. EXISTING prerequisites
 * (this exam's and the learner's other exams') are reused by id. For an
 * active exam MISSES carries the placement test's wrong / «no lo sé»
 * answers, and a prerequisite cites the misses that suggest it. One
 * submit_prerequisites call is the deliverable.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fuzzyScore } from "../../core/fuzzy.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export function prerequisiteInstructions(withMisses: boolean): string {
	return `You find the prior knowledge an exam's syllabus takes for granted. You work inside a learning app; everything you need is in the task.

For the points of the block you receive, list their PREREQUISITES: knowledge from earlier stages (earlier courses, basic maths, language, general foundations) that a learner must already hold to study these points, and that this syllabus does not teach itself — never a point's own content, never something another point of this syllabus teaches.

- One prerequisite per piece of knowledge, stated as a self-contained sentence in the syllabus's language.
- Only what the points rest on directly — not the bases of those bases.
- A prerequisite several points need is listed ONCE, with every point that rests on it.
- EXISTING lists prerequisites already found for this exam or for the learner's other exams. When one is the same knowledge, reuse its id instead of writing it again.
- Search the learner's knowledge map with search_ideas and link each prerequisite to the ideas that express it, fully or in part; leave it unlinked when none does. Never stretch a weak match.
- Be selective: the foundations a learner at this exam's level could plausibly lack and that would block understanding — not everything ever learnt. Some points need none.
${withMisses ? "MISSES lists answers the learner got wrong or did not know in this exam's placement test. When a miss suggests a missing base, include that prerequisite and cite the miss ids in evidence.\n" : ""}
Your whole deliverable is ONE submit_prerequisites call.`;
}

export interface PrerequisiteExisting {
	id: string;
	statement: string;
	/** "this exam" or the other exam's title. */
	from: string;
}

export interface PrerequisiteMiss {
	id: string;
	/** What the missed item was about (point, target or idea text). */
	about: string;
	problem: string;
	answer: string;
	verdict: string;
}

export interface PrerequisiteTask {
	exam: { title: string; examDate: string };
	context: string[];
	block: { index: number; total: number; title: string; points: Array<{ id: string; text: string; targets: string[] }> };
	existing: PrerequisiteExisting[];
	misses?: PrerequisiteMiss[];
}

/** The task for one block (owner-approved shape A). */
export function prerequisitePrompt(task: PrerequisiteTask): string {
	const points = task.block.points
		.map((p) => `[${p.id}] ${p.text}${p.targets.length ? `\n${p.targets.map((x) => `    - ${x}`).join("\n")}` : ""}`)
		.join("\n");
	const existing = task.existing.length ? task.existing.map((e) => `[${e.id}] (${e.from}) ${e.statement}`).join("\n") : "(none)";
	return [
		`EXAM: ${task.exam.title} — ${task.exam.examDate}`,
		`CONTEXT:\n${task.context.length ? task.context.join("\n") : "(none given)"}`,
		`BLOCK ${task.block.index} of ${task.block.total}: ${task.block.title}`,
		`POINTS:\n${points}`,
		`EXISTING:\n${existing}`,
		...(task.misses
			? [
					`MISSES:\n${
						task.misses.length
							? task.misses.map((m) => `[${m.id}] about: ${m.about}\n    problem: ${m.problem}\n    answer: ${m.answer || "(no lo sé)"}\n    verdict: ${m.verdict}`).join("\n")
							: "(none)"
					}`,
				]
			: []),
	].join("\n\n");
}

export interface GraphIdea {
	id: string;
	name: string;
	statement: string;
	aliases: readonly string[];
}

const SEARCH_LIMIT = 15;

const searchInput = Type.Object({
	query: Type.String({ description: "Words to look for in the learner's ideas (names, statements, aliases)." }),
});

export function searchIdeasTool(ideas: () => readonly GraphIdea[]): AgentTool<typeof searchInput> {
	return {
		name: "search_ideas",
		label: "search_ideas",
		description: `Search the learner's knowledge map for ideas about a topic. Best matches first (at most ${SEARCH_LIMIT}): id, name and statement.`,
		parameters: searchInput,
		execute: serverExecute("search_ideas", searchInput, async ({ query }): Promise<string> => {
			const hits: Array<{ idea: GraphIdea; score: number }> = [];
			for (const idea of ideas()) {
				const score = fuzzyScore(query, idea.name, idea.statement, ...idea.aliases);
				if (score !== null) hits.push({ idea, score });
			}
			if (hits.length === 0) return `No idea matches "${query}". Try other words or synonyms.`;
			hits.sort((a, b) => b.score - a.score);
			return hits
				.slice(0, SEARCH_LIMIT)
				.map((h) => `[${h.idea.id}] ${h.idea.name} — ${h.idea.statement}`)
				.join("\n");
		}),
	};
}

const prerequisiteSchema = Type.Object({
	prerequisites: Type.Array(
		Type.Object({
			reuse: Type.Optional(Type.String({ description: "The id of an EXISTING prerequisite that is the same knowledge; omit for a new one." })),
			statement: Type.String({ description: "The prerequisite, one self-contained sentence in the syllabus's language (for a reused one, its statement)." }),
			points: Type.Array(Type.String(), { minItems: 1, description: "The ids of the POINTS that rest on it." }),
			nodeIds: Type.Array(Type.String(), { description: "Ids from search_ideas results that express it; [] when none." }),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "MISSES ids that suggest it." })),
		}),
	),
});

export interface FoundPrerequisite {
	reuse?: string;
	statement: string;
	points: string[];
	nodeIds: string[];
	evidence: string[];
}

export async function runPrerequisiteFinder(opts: {
	engine: PiEngine | undefined;
	task: PrerequisiteTask;
	ideas: () => readonly GraphIdea[];
	signal?: AbortSignal;
}): Promise<FoundPrerequisite[]> {
	const pointIds = new Set(opts.task.block.points.map((p) => p.id));
	const existingIds = new Set(opts.task.existing.map((e) => e.id));
	const missIds = new Set((opts.task.misses ?? []).map((m) => m.id));
	type Raw = { reuse?: string; statement: string; points: string[]; nodeIds: string[]; evidence?: string[] };
	return runSubmitAgent<{ found: FoundPrerequisite[]; problems: string[] }>({
		role: "syllabusMapper",
		toolName: "submit_prerequisites",
		toolDescription: "Submit the block's prerequisites, each with the points resting on it, the learner's ideas that express it and, when given, the misses that suggest it.",
		parameters: prerequisiteSchema,
		fill: (input: { prerequisites: Raw[] }) => {
			const known = new Set(opts.ideas().map((i) => i.id));
			const problems: string[] = [];
			const found: FoundPrerequisite[] = [];
			for (const raw of input.prerequisites) {
				const statement = raw.statement.trim();
				if (!statement) continue;
				if (raw.reuse !== undefined && !existingIds.has(raw.reuse)) problems.push(`reuse ${raw.reuse} is not in EXISTING`);
				const badPoints = raw.points.filter((p) => !pointIds.has(p));
				if (badPoints.length) problems.push(`these points are not in POINTS: ${badPoints.join(", ")}`);
				const badNodes = raw.nodeIds.filter((n) => !known.has(n));
				if (badNodes.length) problems.push(`these ids are not ideas from search_ideas: ${badNodes.slice(0, 10).join(", ")}`);
				found.push({
					...(raw.reuse !== undefined && existingIds.has(raw.reuse) ? { reuse: raw.reuse } : {}),
					statement,
					points: [...new Set(raw.points.filter((p) => pointIds.has(p)))],
					nodeIds: [...new Set(raw.nodeIds.filter((n) => known.has(n)))],
					evidence: [...new Set((raw.evidence ?? []).filter((m) => missIds.has(m)))],
				});
			}
			return { found: found.filter((f) => f.points.length > 0), problems };
		},
		validate: (r) => (r.problems.length ? `${[...new Set(r.problems)].join("; ")} — use only listed ids` : null),
		extraTools: { search_ideas: searchIdeasTool(opts.ideas) },
		maxTurns: 30,
		systemPrompt: prerequisiteInstructions(opts.task.misses !== undefined),
		prompt: prerequisitePrompt(opts.task),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the prerequisite finder never submitted",
	}).then((r) => r.found);
}

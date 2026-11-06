/**
 * «Contrastar con la guía» (owner-approved prompt 2026-11-06): compares an
 * existing exam's syllabus with the official outline the guide finder
 * found. The model only says which current points cover each official
 * point, and the closest official point of each current point that covers
 * none; the code derives what is missing and what is extra. Nothing changes
 * until the learner applies it.
 */

import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const CONTRAST_INSTRUCTIONS = `You compare an exam's current syllabus with its official one. For each official point, list the current points that cover it (same content, any wording). For each current point that covers none, give the official point it is closest to, or none. Your whole deliverable is ONE submit_contrast call.`;

export function contrastPrompt(input: { official: string; current: ReadonlyArray<{ id: string; blockTitle: string; text: string }> }): string {
	const current = input.current.map((p) => `- [${p.id}] (${p.blockTitle}) ${p.text}`).join("\n");
	return `OFFICIAL SYLLABUS:\n${input.official}\n\nCURRENT SYLLABUS:\n${current || "(empty)"}`;
}

const contrastSchema = Type.Object({
	covered: Type.Array(
		Type.Object({
			official: Type.String({ description: "An official point id (o…)." }),
			current: Type.Array(Type.String(), { description: "The current point ids that cover it; [] when none." }),
		}),
	),
	uncovered: Type.Array(
		Type.Object({
			current: Type.String({ description: "A current point id that covers no official point." }),
			closest: Type.Union([Type.String(), Type.Null()], { description: "The official point id it is closest to, or null." }),
		}),
	),
});

export interface ContrastResult {
	/** Official point ids nobody covers. */
	missing: string[];
	/** Current point ids covering nothing, with their closest official id. */
	extras: Array<{ pointId: string; closest: string | null }>;
}

export async function runExamContrast(opts: {
	engine: PiEngine | undefined;
	official: { text: string; ids: readonly string[] };
	current: ReadonlyArray<{ id: string; blockTitle: string; text: string }>;
	signal?: AbortSignal;
}): Promise<ContrastResult> {
	const officialIds = new Set(opts.official.ids);
	const currentIds = new Set(opts.current.map((p) => p.id));
	type Input = { covered: Array<{ official: string; current: string[] }>; uncovered: Array<{ current: string; closest: string | null }> };
	return runSubmitAgent<ContrastResult & { unknown: string[] }>({
		role: "syllabusMapper",
		toolName: "submit_contrast",
		toolDescription: "Submit which current points cover each official point, and the closest official point of each current point that covers none.",
		parameters: contrastSchema,
		fill: (input: Input) => {
			const unknown = [
				...input.covered.flatMap((c) => [c.official, ...c.current]),
				...input.uncovered.flatMap((u) => [u.current, ...(u.closest ? [u.closest] : [])]),
			].filter((id) => !officialIds.has(id) && !currentIds.has(id));
			const coveredOfficial = new Set(input.covered.filter((c) => c.current.some((id) => currentIds.has(id))).map((c) => c.official));
			const covering = new Set(input.covered.flatMap((c) => c.current));
			const closest = new Map(input.uncovered.map((u) => [u.current, u.closest && officialIds.has(u.closest) ? u.closest : null]));
			return {
				unknown,
				missing: opts.official.ids.filter((id) => !coveredOfficial.has(id)),
				extras: opts.current.filter((p) => !covering.has(p.id)).map((p) => ({ pointId: p.id, closest: closest.get(p.id) ?? null })),
			};
		},
		validate: (r) => (r.unknown.length ? `these ids are not in either list: ${[...new Set(r.unknown)].slice(0, 10).join(", ")} — use only listed ids` : null),
		systemPrompt: CONTRAST_INSTRUCTIONS,
		prompt: contrastPrompt({ official: opts.official.text, current: opts.current }),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the contrast never submitted",
	}).then(({ missing, extras }) => ({ missing, extras }));
}

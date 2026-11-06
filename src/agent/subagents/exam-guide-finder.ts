/**
 * The guide finder («guía oficial primero», owner-approved prompt
 * 2026-11-06): before any outline, it looks for the OFFICIAL guide of the
 * exam and sitting — the learner's materials first, then the web — and
 * copies its contents (blocks → points, in its own words), scoped to the
 * test on the exam date. Subject matter only. Not found → found: false
 * with a reason; it never presents a syllabus from memory as official.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SearchProvider } from "../../core/search.ts";
import type { GuideBlock } from "../../core/exams.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { createWebTools } from "../tools/web.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import type { ResearchMaterial } from "./exam-researcher.ts";

export function guideFinderInstructions(input: { today: string; examDate: string }): string {
	return `You find the OFFICIAL syllabus of one exam and copy its contents. You work inside a learning app; everything you need is in the task.

1. Find the official guide or syllabus for this exam and sitting (see CONTEXT and the dates). Look first in the learner's MATERIALS (read_material), then on the web (web_search, then web_fetch / web_fetch_pdf), preferring the exam's own body (its website, its official guide), then education authorities. Today is ${input.today}; the exam is on ${input.examDate}. Take the guide for that sitting; if it is not published yet, the most recent one.
2. Copy its contents in its own order and words: blocks = its topics, units or chapters; points = the items it lists under each. When a block lists no items, split it into the points a standard course on that topic covers and mark those points fromGuide: false.
3. Scope: if the guide says which part enters which test (a February partial, a first part, units 1–4…) or excludes something («not examinable, except…»), mark each block inSitting for the test on the exam date, keep only the points that enter in a block that is partly included, and write one short scopeNote in the learner's language («Entra en febrero: temas 1–6»). Without such information every block is inSitting and scopeNote is empty.
4. Leave out everything that is not subject matter: exam format, marking, penalties, dates, bibliography, tutoring, methodology.
5. If you can't find an official guide for this exam, submit found: false with a one-sentence reason. Never present a syllabus from memory or from unofficial pages as official.

Your whole deliverable is ONE submit_guide call.`;
}

export interface GuideTask {
	exam: { title: string; examDate: string };
	context: string[];
	materials: ResearchMaterial[];
}

export function guideFinderPrompt(task: GuideTask): string {
	const materials = task.materials.length
		? task.materials.map((m) => `[${m.id}] ${m.name}${m.kind === "link" ? ` (link: ${m.url})` : " (file — read_material)"}`).join("\n")
		: "(none)";
	return [`EXAM: ${task.exam.title} — ${task.exam.examDate}`, `CONTEXT:\n${task.context.length ? task.context.join("\n") : "(none given)"}`, `MATERIALS:\n${materials}`].join("\n\n");
}

const guideSchema = Type.Object({
	found: Type.Boolean({ description: "true when you found the official guide or syllabus." }),
	reason: Type.Optional(Type.String({ description: "found: false — one sentence on why, in the learner's language." })),
	title: Type.Optional(Type.String({ description: "The guide's title." })),
	sourceKind: Type.Optional(Type.Union([Type.Literal("material"), Type.Literal("web")])),
	ref: Type.Optional(Type.String({ description: "The material id or the URL." })),
	year: Type.Optional(Type.String({ description: "The guide's year or academic year." })),
	scopeNote: Type.Optional(Type.String({ description: "What enters the test on the exam date, short, in the learner's language; empty when the guide says nothing." })),
	blocks: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "The guide's topic / unit / chapter." }),
				inSitting: Type.Boolean({ description: "true when it enters the test on the exam date." }),
				points: Type.Array(
					Type.Object({
						text: Type.String({ description: "One item, in the guide's own words." }),
						fromGuide: Type.Boolean({ description: "false when the guide lists nothing under the block and you split it yourself." }),
					}),
					{ minItems: 1 },
				),
			}),
		),
	),
});

export type GuideResult =
	| { found: true; title: string; sourceKind: "material" | "web"; ref: string; year: string; scopeNote: string; outline: GuideBlock[] }
	| { found: false; reason: string };

export async function runGuideFinder(opts: {
	engine: PiEngine | undefined;
	task: GuideTask;
	instructions: string;
	search: () => SearchProvider | null;
	readMaterial: (id: string, offset: number) => Promise<string>;
	pdfDir: string;
	signal?: AbortSignal;
}): Promise<GuideResult> {
	const materialIds = new Set(opts.task.materials.map((m) => m.id));
	const readInput = Type.Object({
		id: Type.String({ description: "The material id from MATERIALS." }),
		offset: Type.Optional(Type.Number({ description: "Character offset to continue a long material from (default 0)." })),
	});
	const extraTools: Record<string, AgentTool<any>> = {
		...createWebTools(opts.search),
		...createPdfReadTools(opts.pdfDir),
		read_material: {
			name: "read_material",
			label: "read_material",
			description: "Read one of the learner's material files (its text; long ones in parts — continue with offset).",
			parameters: readInput,
			execute: serverExecute("read_material", readInput, async ({ id, offset }): Promise<string> => {
				if (!materialIds.has(id)) return `read_material: unknown material id ${id}`;
				return opts.readMaterial(id, Math.max(0, Math.floor(offset ?? 0)));
			}),
		},
	};
	type Input = {
		found: boolean;
		reason?: string;
		title?: string;
		sourceKind?: "material" | "web";
		ref?: string;
		year?: string;
		scopeNote?: string;
		blocks?: Array<{ title: string; inSitting: boolean; points: Array<{ text: string; fromGuide: boolean }> }>;
	};
	return runSubmitAgent<GuideResult>({
		role: "syllabusMapper",
		toolName: "submit_guide",
		toolDescription: "Submit the official guide's contents (blocks → points, scoped to the sitting), or found: false with a reason.",
		parameters: guideSchema,
		fill: (input: Input): GuideResult => {
			if (!input.found) return { found: false, reason: (input.reason ?? "").trim() };
			const outline = (input.blocks ?? [])
				.map((b) => ({
					title: b.title.trim(),
					inSitting: b.inSitting !== false,
					points: b.points.map((p) => ({ text: p.text.trim(), fromGuide: p.fromGuide !== false })).filter((p) => p.text),
				}))
				.filter((b) => b.title && b.points.length > 0);
			return {
				found: true,
				title: (input.title ?? "").trim(),
				sourceKind: input.sourceKind === "material" ? "material" : "web",
				ref: (input.ref ?? "").trim(),
				year: (input.year ?? "").trim(),
				scopeNote: (input.scopeNote ?? "").trim(),
				outline,
			};
		},
		validate: (r) => {
			if (!r.found) return r.reason ? null : "found: false needs a one-sentence reason";
			if (r.outline.length === 0) return "found: true needs the guide's blocks, each with at least one point";
			if (!r.outline.some((b) => b.inSitting)) return "at least one block must enter the test on the exam date (inSitting: true)";
			if (!r.title) return "give the guide's title";
			if (r.sourceKind === "material" && !materialIds.has(r.ref)) return `ref must be a material id from MATERIALS when sourceKind is material`;
			return null;
		},
		extraTools,
		maxTurns: 40,
		systemPrompt: opts.instructions,
		prompt: guideFinderPrompt(opts.task),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the guide finder never submitted",
	});
}

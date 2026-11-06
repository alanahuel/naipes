/**
 * The exam researcher («Exámenes» v2, owner-approved prompt 2026-11-06):
 * one run per syllabus block produces each point's TARGET IDEAS — what a
 * learner must hold to master it at the standard's depth — from the
 * learner's materials, the web and the model's knowledge, and links each
 * target to the candidate graph ideas that already express it. One
 * submit_research call is the deliverable; the web/PDF/material tools let
 * it read first. Search comes from the injected seam (the exam research
 * uses Claude Code's own WebSearch when connected, else Tavily/Brave).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SearchProvider } from "../../core/search.ts";
import type { ExamPreset } from "../../core/exams.ts";
import { MAX_TARGETS_PER_POINT } from "../../core/exams.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { createWebTools } from "../tools/web.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const DEPTH_LINES: Record<ExamPreset, string> = {
	pass: "Pass level — the essentials: core definitions, main facts and procedures.",
	merit: "Solid command — the essentials plus the distinctions, conditions and typical cases examiners test.",
	distinction: "Full mastery — fine-grained: exceptions, edge cases, links between points, and what top answers include.",
};

export function examResearchInstructions(input: { today: string; examDate: string; sitting: string; depth: ExamPreset }): string {
	return `You research what a learner must know to pass one exam, block by block of its syllabus. You work inside a learning app; everything you need is in the task.

For each point of the block you receive, produce its TARGET IDEAS: the propositions a learner has to hold to master that point at the requested depth — one claim, definition, procedure or distinction each, stated as a self-contained sentence in the syllabus's language.

Sources, in this order:
1. The learner's materials (read_material) — when they cover a point, they decide its content and wording.
2. The web — first the official syllabus or guide for this exam and sitting (see CONTEXT), then recent past papers and official marking criteria; prefer the exam's own body, then universities and education authorities, then reputable textbooks. Use web_search, then web_fetch / web_fetch_pdf on the best results.
3. Your own knowledge — for what the sources leave out.

Dates: today is ${input.today}; the exam is on ${input.examDate} (sitting ${input.sitting || "not given"}). Prefer the guide for that sitting; if it is not published yet, use the most recent one. Mark material from before a syllabus change as outdated. Give each source its year when known.

Depth: ${DEPTH_LINES[input.depth]} At most ${MAX_TARGETS_PER_POINT} target ideas per point. Cover the point fully at that depth; no padding, nothing that belongs to another point.

Linking: the CANDIDATES are ideas the learner already holds. Link a target to the candidate ids that express it, fully or in part; leave it unlinked when none does. Never stretch a weak match.

If a tool says search is unavailable, don't retry it: work from the materials, pages whose URL you know, and your own knowledge.

Your whole deliverable is ONE submit_research call.`;
}

export interface ResearchMaterial {
	id: string;
	name: string;
	kind: "file" | "link";
	url?: string;
}

export interface ResearchCandidate {
	id: string;
	name: string;
	statement: string;
}

export interface ResearchTask {
	exam: { title: string; examDate: string };
	/** Context lines already labelled («Type: Official»…), empty ones out. */
	context: string[];
	materials: ResearchMaterial[];
	block: { index: number; total: number; title: string; points: Array<{ id: string; text: string }> };
	candidates: ResearchCandidate[];
}

/** The task for one block (owner-approved shape B). */
export function examResearchPrompt(task: ResearchTask): string {
	const materials = task.materials.length
		? task.materials.map((m) => `[${m.id}] ${m.name}${m.kind === "link" ? ` (link: ${m.url})` : " (file — read_material)"}`).join("\n")
		: "(none)";
	const candidates = task.candidates.length ? task.candidates.map((c) => `[${c.id}] ${c.name} — ${c.statement}`).join("\n") : "(none — the learner's graph has nothing related)";
	return [
		`EXAM: ${task.exam.title} — ${task.exam.examDate}`,
		`CONTEXT:\n${task.context.length ? task.context.join("\n") : "(none given)"}`,
		`MATERIALS:\n${materials}`,
		`BLOCK ${task.block.index} of ${task.block.total}: ${task.block.title}`,
		`POINTS:\n${task.block.points.map((p) => `[${p.id}] ${p.text}`).join("\n")}`,
		`CANDIDATES:\n${candidates}`,
	].join("\n\n");
}

const sourceSchema = Type.Object({
	kind: Type.Union([Type.Literal("material"), Type.Literal("web"), Type.Literal("model")], { description: "material = the learner's materials; web = a page or document found online; model = your own knowledge." }),
	title: Type.String({ description: "The material's name or the page/document title; empty for model." }),
	ref: Type.Optional(Type.String({ description: "The material id or the URL." })),
	year: Type.Optional(Type.String({ description: "The source's year, when known." })),
	outdated: Type.Optional(Type.Boolean({ description: "true when the source predates a syllabus change." })),
});

const researchSchema = Type.Object({
	points: Type.Array(
		Type.Object({
			pointId: Type.String({ description: "The point's id exactly as given in POINTS." }),
			targets: Type.Array(
				Type.Object({
					statement: Type.String({ description: "One self-contained target idea, in the syllabus's language." }),
					source: sourceSchema,
					nodeIds: Type.Array(Type.String(), { description: "Candidate ids that express this target; [] when none." }),
				}),
				{ minItems: 1, maxItems: MAX_TARGETS_PER_POINT },
			),
		}),
		{ minItems: 1 },
	),
});

export interface ResearchedTarget {
	statement: string;
	source: { kind: "material" | "web" | "model"; title: string; ref?: string; year?: string; outdated?: boolean };
	nodeIds: string[];
}

export type ResearchResult = Map<string, ResearchedTarget[]>;

export async function runExamResearcher(opts: {
	engine: PiEngine | undefined;
	task: ResearchTask;
	instructions: string;
	search: () => SearchProvider | null;
	readMaterial: (id: string, offset: number) => Promise<string>;
	pdfDir: string;
	signal?: AbortSignal;
}): Promise<ResearchResult> {
	const known = new Set(opts.task.candidates.map((c) => c.id));
	const pointIds = opts.task.block.points.map((p) => p.id);
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
	return runSubmitAgent<ResearchResult>({
		role: "syllabusMapper",
		toolName: "submit_research",
		toolDescription: "Submit every point's target ideas, each with its source and the candidate ids that express it.",
		parameters: researchSchema,
		fill: (input: { points: Array<{ pointId: string; targets: ResearchedTarget[] }> }) => {
			const out: ResearchResult = new Map();
			for (const p of input.points) {
				const targets = p.targets
					.map((t) => ({ ...t, statement: t.statement.trim(), nodeIds: [...new Set(t.nodeIds)] }))
					.filter((t) => t.statement.length > 0)
					.slice(0, MAX_TARGETS_PER_POINT);
				out.set(p.pointId, [...(out.get(p.pointId) ?? []), ...targets].slice(0, MAX_TARGETS_PER_POINT));
			}
			return out;
		},
		validate: (result) => {
			const missing = pointIds.filter((id) => !(result.get(id)?.length));
			if (missing.length) return `every point needs at least one target idea — missing: ${missing.join(", ")}`;
			const unknownPoints = [...result.keys()].filter((id) => !pointIds.includes(id));
			if (unknownPoints.length) return `these pointIds are not in POINTS: ${unknownPoints.join(", ")}`;
			const unknown = [...new Set([...result.values()].flat().flatMap((t) => t.nodeIds).filter((id) => !known.has(id)))];
			if (unknown.length) return `these ids are not in CANDIDATES: ${unknown.slice(0, 10).join(", ")} — use only listed ids`;
			return null;
		},
		extraTools,
		maxTurns: 40,
		systemPrompt: opts.instructions,
		prompt: examResearchPrompt(opts.task),
		engine: opts.engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "the exam researcher never submitted its research",
	});
}

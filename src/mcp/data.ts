/**
 * The MCP server's READ side (owner, 2026-11-08): the learner's records
 * straight from the data folder, so reads work while the app is closed.
 *
 * READ-ONLY BY CONSTRUCTION: only the stores' pure readers and pure core
 * derivations are called here — never a writer, never the server layer
 * (whose services persist as they compute). Today's review intake is
 * previewed, not released; the app releases it when it computes.
 */

import * as fs from "node:fs";
import { PATHS } from "../../config.ts";
import type { ChatRecord, ChatSummary, GraphChain, GraphNode } from "../core/contracts.ts";
import { allPoints, type ExamRecord } from "../core/exams.ts";
import { fuzzyScore } from "../core/fuzzy.ts";
import { getGraph, graphSessionIndex, type GraphSessionEntry } from "../core/graph.ts";
import { dueToday, emptyReviewSources } from "../core/review.ts";
import { assembleReviewState, reviewItemViews, summarizeReview, type LoadedChat } from "../core/review-state.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { chatStore } from "../store/chats.ts";
import { listExams, readExam } from "../store/exams.ts";
import { graphStore } from "../store/graph.ts";
import { readIntake, readReviewSources } from "../store/review.ts";
import { readSettings } from "../store/settings.ts";
import { scanNoteFiles } from "../store/vault-scan.ts";
import { inboxFolderOf } from "../core/vault-notes.ts";
import * as path from "node:path";

const settings = (): EffectiveSettings => resolveSettings(readSettings());

// ─── sessions ───────────────────────────────────────────────────────────────

/** Every session summary, newest activity first. The store's lister
 *  creates the chats folder when missing — never call it then. */
export function sessionSummaries(): ChatSummary[] {
	if (!fs.existsSync(PATHS.chats)) return [];
	return chatStore.listChats();
}

export function sessionRecord(id: string): ChatRecord | null {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
	return chatStore.getChat(id);
}

/** One session as Markdown (the app's own export engine). */
export function sessionText(record: ChatRecord): string {
	return sessionMarkdown(record.messages, { title: record.title, anchors: false });
}

// ─── graph ──────────────────────────────────────────────────────────────────

export function graph(): { nodes: GraphNode[]; chains: GraphChain[] } {
	return getGraph(graphStore);
}

/** Names, statements and aliases, best fuzzy matches first. */
export function searchPropositions(query: string, limit: number): Array<GraphNode & { score: number }> {
	const hits: Array<GraphNode & { score: number }> = [];
	for (const node of graph().nodes) {
		const score = fuzzyScore(query, node.name, node.statement, ...node.aliases);
		if (score !== null) hits.push({ ...node, score });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The graph's birth sources: teaching sessions and imported notes files. */
export function graphSources(): GraphSessionEntry[] {
	return graphSessionIndex({ chatStore: { ...chatStore, listChats: sessionSummaries }, graphStore });
}

// ─── review ─────────────────────────────────────────────────────────────────

function loadedChats(): LoadedChat[] {
	const out: LoadedChat[] = [];
	for (const summary of sessionSummaries()) {
		const record = chatStore.getChat(summary.id);
		if (record) out.push({ id: record.id, kind: record.kind, createdAt: record.createdAt, messages: record.messages, title: record.title, review: record.review, exam: record.exam });
	}
	return out;
}

/** The review screen's data at `now` — computed, never persisted. */
export function reviewStatus(now = Date.now()) {
	const effective = settings();
	const sourcePaths: Record<string, string> = {};
	for (const s of graphStore.readSources()) sourcePaths[s.id] = s.filePath;
	const state = assembleReviewState({
		now,
		nodes: graph().nodes,
		chats: loadedChats(),
		sourcePaths,
		sources: readReviewSources() ?? emptyReviewSources(now),
		intake: readIntake(),
		exams: listExams(),
		settings: effective.review,
		finalWindowDays: effective.exams.finalWindowDays,
	});
	const locale = effective.general.language;
	const dueIds = new Set(dueToday(state.model.items, now).map((i) => i.nodeId));
	return {
		summary: summarizeReview(state, now, locale),
		items: reviewItemViews(state, locale),
		dueIds,
		statements: state.statements,
	};
}

// ─── exams ──────────────────────────────────────────────────────────────────

export function exams(): ExamRecord[] {
	return listExams();
}

export function exam(id: string): ExamRecord | null {
	return readExam(id);
}

export { allPoints };

// ─── inbox (app closed: the file list only) ─────────────────────────────────

/** The knowledge folder's inbox notes straight from disk; null when the
 *  folder or its inbox is off. Suggestions need the running app. */
export function inboxFiles(): { inbox: string; files: string[] } | null {
	const { obsidian } = settings();
	if (!obsidian.enabled || !obsidian.vaultPath) return null;
	const inbox = inboxFolderOf(obsidian);
	if (!inbox) return null;
	const root = path.resolve(obsidian.vaultPath);
	if (!fs.existsSync(root)) return null;
	return { inbox, files: scanNoteFiles(root, inbox, obsidian.outputFolder).sort((a, b) => a.localeCompare(b)) };
}

export const fuzzyMatches = (query: string, ...fields: string[]): boolean => fuzzyScore(query, ...fields) !== null;

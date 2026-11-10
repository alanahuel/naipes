import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, PATHS, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import type { GraphCanvasSnapshot, GraphChainsView } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { callCost } from "./pricing.ts";

/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 */
/** A serialized response body + its validator. */
export interface CachedBody {
	etag: string;
	body: string;
}

/** One snapshot build serves both wire views until something it reads
 *  changes (perf, owner 2026-11-10): the graph ledgers + positions
 *  (graphRevision), the notes sources (labels, areas), and the chat files
 *  (session titles). Rebuilding it per request cost 30–700 ms of blocked
 *  server and ~7 MB of JSON for every visit to Inicio. */
let viewCache: { key: string; canvas: CachedBody; chains: CachedBody } | null = null;

function mtimeOf(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function chatsSignature(): string {
	let names: string[];
	try {
		names = fs.readdirSync(PATHS.chats).filter((f) => f.endsWith(".json"));
	} catch {
		return "none";
	}
	let latest = 0;
	for (const name of names) latest = Math.max(latest, mtimeOf(path.join(PATHS.chats, name)));
	return `${names.length}:${latest}`;
}

function views(): { canvas: CachedBody; chains: CachedBody } {
	const key = `${graphRevision()}|${mtimeOf(SOURCES_FILE)}|${chatsSignature()}`;
	if (viewCache?.key === key) return viewCache;
	const { propositions, chains, nodes, ...rest } = graphSnapshot(stores);
	const canvas: GraphCanvasSnapshot = {
		...rest,
		nodes: nodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement, provenance: n.provenance })),
		counts: { propositions: propositions.length, chains: chains.length },
	};
	const world: GraphChainsView = { propositions, chains, sessions: rest.sessions, fileSources: rest.fileSources };
	const tag = Buffer.from(key).toString("base64url");
	viewCache = {
		key,
		canvas: { etag: `"c-${tag}"`, body: JSON.stringify(canvas) },
		chains: { etag: `"w-${tag}"`, body: JSON.stringify(world) },
	};
	return viewCache;
}

/** GET /api/graph — the canvas view (GraphCanvasSnapshot), cached. */
export function graphCanvasBody(): CachedBody {
	return views().canvas;
}

/** GET /api/graph/chains — the chain table's world (GraphChainsView). */
export function graphChainsBody(): CachedBody {
	return views().chains;
}

/** The graph view's cost surface (GET /api/graph/costs — the 2026-09 cost
 *  pill): fold every usage channel into stage totals + recent runs. A pure
 *  read over the chat records (chat-front-door runs), the notes sources
 *  (notes-front-door runs), and the naming ledger (graph-global runs);
 *  dollars are inferred by the pure core fold (core/cost-summary.ts +
 *  prices.ts) — nothing here stores or caches money. */
export function graphCosts(): GraphCostSummary {
	const chats = stores.chatStore
		.listChats()
		.flatMap((summary) => {
			const record = stores.chatStore.getChat(summary.id);
			return record?.extractions?.length
				? [{ title: record.title ?? summary.id, extractions: record.extractions }]
				: [];
		});
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** The graph's version stamp (session-deletion wave 6): the max mtime
 * across every graph data file — ledgers, positions. Moves on ANY
 * graph write (merge append, settle, or a deletion's atomic rewrite),
 * never moves on reads, and needs no bookkeeping of its own: the fs
 * IS the counter. Consumers poll it (the activity feed
 *  carries it; the DELETE response returns it) to know clusters/layout
 *  must refetch — the "graph changed underneath me" signal. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). The guard family is deliberately NOT the chat
 * one, and the reasoning is worth writing down:
 *
 *   - No turn/jobs gates. Turns and background jobs never write the
 *     graph ledgers; a turn's follow-up extraction registers as a run,
 *     and every code path here is synchronous — nothing can register
 *     or merge between the gate and the ledger rewrite (the event loop
 *     never yields inside this function).
 *   - THE EXTRACTION GATE — 409 while ANY pipeline run is registered,
 *     anywhere. A mid-flight run holds findings extracted from
 *     transcripts that predate the deletion; its merges could re-add
 *     aliases, provenance, or events to the dying node (the
 *     re-reference risk the dispatch flags). Unlike chat deletion we
 *     do NOT abort the run: it belongs to some session, and killing
 *     that session's spend is outside this deletion's blast radius —
 *     the UI retries once the dock drains. A run that starts AFTER
 *     the deletion is legitimate re-learning: it reads post-deletion
 *     ledgers, mints a fresh node for a re-taught topic, and
 *     mergeFindings ignores linkTo ids that no longer exist (the
 *     existingIds guard) — no dangling edges, no resurrection.
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the
	// rewrite are one atomic stretch of the event loop.
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}


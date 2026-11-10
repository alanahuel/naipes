import type { GraphChain, GraphNode, Position } from "./contracts.ts";
import { drainSteps, incrementalLayoutSteps } from "./layout.ts";
import { emit } from "./events.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
import { deriveView, getGraph } from "./graph.ts";
import { buildAreas } from "./areas.ts";

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Synchronous — it must
 * finish before the next /api/graph fetch reflects the change.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the settle lays out the DERIVED
 * view — propositions AND the derived implication nodes (one per chain,
 * arg_ ids) over the derived untyped arrows — so positions exist for
 * every node the canvas renders. Implication nodes participate in the
 * physics as regular nodes (rendering specialization comes later).
 *
 * SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the
 * browser barrel, and the settle needs the cluster partition for the
 * cluster centroid pull — this module must not ship in the client bundle.
 * Server code imports it DIRECTLY; it is never re-exported through
 * src/core/index.ts.
 */
/** Ticks for a from-scratch relayout. The area-seeded start is already
 *  close to its islands, so d3's default anneal (300) is enough — and
 *  each tick costs ~35ms of Barnes-Hut on a 4k-node graph (measured
 *  2026-11-03), so 600 would block the server for ~20s. */
const FRESH_TICKS = 300;

type SettleGraphStore = {
	readNodes(): GraphNode[];
	readChains(): GraphChain[];
	readSources(): ReadonlyArray<{ id: string; filePath: string }>;
	readPositions(): Record<string, Position>;
	writePositions(positions: Record<string, Position>): void;
};

/** One settle as a step generator (yields between simulation ticks).
 *  Returns whether the ledger was rewritten. */
function* settleSteps(graphStore: SettleGraphStore, options: { fresh?: boolean }): Generator<void, boolean, void> {
	const graph = getGraph(graphStore);
	if (graph.nodes.length === 0) return false;
	const view = deriveView(graph);
	// FRESH (the «Reorganizar» action, owner 2026-11-03): no anchors at
	// all — the layout is recomputed from scratch, seeded per area.
	const previous = options.fresh
		? new Map<string, Position>()
		: new Map(Object.entries(graphStore.readPositions()));
	// LOCAL (perf, 2026-11-10): an incremental settle only lays out the
	// nodes the ledger lacks (+ their patch). Nothing new → nothing moves;
	// the ledger is only pruned of ids that left the view.
	const missing = new Set(view.nodes.filter((n) => !previous.has(n.id)).map((n) => n.id));
	const positioned = view.nodes.length - missing.size;
	const local = !options.fresh && positioned > 0;
	let next: Map<string, Position>;
	if (local && missing.size === 0) {
		next = new Map();
		for (const n of view.nodes) next.set(n.id, previous.get(n.id)!);
	} else {
		// The cluster partition for the centroid pull: the SAME birth-session
		// partition the snapshot renders (derived from provenance on read —
		// core/session-clusters.ts, wave 7) — one cluster concept everywhere.
		// PROPOSITIONS ONLY (owner, 2026-09-30): implication nodes never
		// partition; the stored world clusters, its image follows.
		const communities = birthSessionPartition(graph.nodes);
		// The SAME imp-node assignment the snapshot renders (majority among
		// premises' births — core/session-clusters.ts): the resting ledger and
		// the live sim must agree on where bundles belong, or the first live
		// tick would fight the settle. Unfiltered here (settle pulls every
		// community, hulls are a canvas-only concern).
		attachImpToCommunities(communities, graph.nodes, graph.chains);
		// The pull follows the AREA (owner, 2026-11-03): the same partition
		// the snapshot serves (core/areas.ts), so the live sim agrees.
		const fileSources: Record<string, string> = {};
		for (const s of graphStore.readSources()) fileSources[s.id] = s.filePath;
		const { areas } = buildAreas(communities, fileSources);
		next = yield* incrementalLayoutSteps(view.nodes, view.edges, previous, {
			clusters: areas,
			...(options.fresh ? { seedGroups: true, ticks: FRESH_TICKS } : {}),
			...(local ? { localTo: missing } : {}),
			logicalEdges: view.logicalEdges,
			impLinks: view.impLinks,
		});
	}
	// WRITE-BACK MERGE: the run may have spanned many event-loop turns. A
	// node this run moved (or placed) takes the run's position; any other
	// node keeps what the ledger holds NOW (a drag commit that landed
	// mid-run wins); ids that left the view meanwhile drop; nodes that
	// arrived meanwhile wait for the follow-up run their merge requested.
	const current = graphStore.readPositions();
	const live = deriveView(getGraph(graphStore)).nodes;
	const merged: Record<string, Position> = {};
	for (const { id } of live) {
		const ours = next.get(id);
		const before = previous.get(id);
		const movedByUs = ours !== undefined && (options.fresh || !before || before.x !== ours.x || before.y !== ours.y);
		const pos = movedByUs ? ours : (current[id] ?? ours);
		if (pos) merged[id] = pos;
	}
	if (samePositions(current, merged)) return false;
	graphStore.writePositions(merged);
	return true;
}

function samePositions(a: Record<string, Position>, b: Record<string, Position>): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const k of ka) {
		const p = a[k]!;
		const q = b[k];
		if (!q || p.x !== q.x || p.y !== q.y) return false;
	}
	return true;
}

/** The settle, synchronously (tests and one-shot tools). Production
 *  code uses requestGraphSettle / relayoutGraphFresh. */
export function settleGraphLayout(graphStore: SettleGraphStore, options: { fresh?: boolean } = {}): void {
	if (drainSteps(settleSteps(graphStore, options))) emit("graph-layout-changed", {});
}

// ─── the sliced, coalescing scheduler ────────────────────────────────────────

/** Longest stretch a settle may hold the event loop before yielding. A
 *  full-graph tick alone costs ~25 ms on 4k nodes, so a fresh relayout
 *  yields every tick; a local patch fits many ticks per slice. */
const SLICE_MS = 10;

interface SettleQueue {
	store: SettleGraphStore | null;
	dirty: boolean;
	fresh: boolean;
	running: Promise<void> | null;
}

/** globalThis-backed for the same reason as the event bus (core/events.ts):
 *  Next dev gives each route its own module instance; one queue must
 *  serialize every settle in the process. */
function queue(): SettleQueue {
	const g = globalThis as typeof globalThis & { __npGraphSettle?: SettleQueue };
	return (g.__npGraphSettle ??= { store: null, dirty: false, fresh: false, running: null });
}

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function runSliced<T>(steps: Generator<void, T, void>): Promise<T> {
	let sliceStart = performance.now();
	for (;;) {
		const r = steps.next();
		if (r.done) return r.value;
		if (performance.now() - sliceStart >= SLICE_MS) {
			await yieldTurn();
			sliceStart = performance.now();
		}
	}
}

async function pump(q: SettleQueue): Promise<void> {
	// Let the caller's synchronous work (the rest of a merge, the HTTP
	// response) finish first.
	await yieldTurn();
	while (q.dirty && q.store) {
		const fresh = q.fresh;
		q.dirty = false;
		q.fresh = false;
		try {
			const started = performance.now();
			const wrote = await runSliced(settleSteps(q.store, { fresh }));
			if (wrote) {
				console.info(`[layout] ${fresh ? "fresh relayout" : "settle"} done in ${Math.round(performance.now() - started)} ms`);
				emit("graph-layout-changed", {});
			}
		} catch (err) {
			console.error("[layout] settle failed:", err);
		}
	}
	q.running = null;
}

function kick(q: SettleQueue): Promise<void> {
	q.running ??= pump(q);
	return q.running;
}

/** Ask for an incremental settle (after a merge, or a drag commit that
 *  missed nodes). Returns at once; a burst of requests coalesces into
 *  one run (or one more, if a run is already under way). */
export function requestGraphSettle(graphStore: SettleGraphStore): void {
	const q = queue();
	q.store = graphStore;
	q.dirty = true;
	void kick(q);
}

/** «Reorganizar»: a from-scratch relayout, sliced like every settle.
 *  Resolves once the queue has drained (the fresh run included). */
export function relayoutGraphFresh(graphStore: SettleGraphStore): Promise<void> {
	const q = queue();
	q.store = graphStore;
	q.dirty = true;
	q.fresh = true;
	return kick(q);
}

/** Resolves when no settle is queued or running (tests, shutdown). */
export function graphSettleIdle(): Promise<void> {
	return queue().running ?? Promise.resolve();
}

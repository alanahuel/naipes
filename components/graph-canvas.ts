"use client";

/**
 * The hand-rolled single-canvas graph renderer (decided 2026-09-13 after
 * the research pass — docs/research/graph-rendering.md, Option B).
 *
 * Replaces sigma.js. Why: sigma gave us WebGL node/edge rendering,
 * picking, and a camera, but our cluster regions had to live on foreign
 * canvases injected next to its private DOM stack, drawn from a separate
 * event loop — so hulls lagged behind nodes during pan, raced sigma's
 * canvas sizing on renderer rebuilds, and every camera event re-rasterized
 * the full hull canvas (GPU spikes + audible coil whine). At our scale
 * (338 → low thousands of nodes) one Canvas 2D is comfortably inside
 * 60fps territory, and a single loop makes the desync class of bugs
 * structurally impossible.
 *
 * Architecture (the canonical pattern — browser.engineering, MDN
 * "Optimizing canvas", web.dev canvas performance):
 *   - The renderer is a DUMB DRAW FUNCTION over plain data: nodes with
 *     world-space positions, edges, clusters, colors, settings. Layout
 *     (forceAtlas2) and filtering happen OUTSIDE, in the React component;
 *     this module never computes a position.
 *   - ONE canvas, ONE requestAnimationFrame loop with a dirty flag. Input
 *     and DOM events only mutate state and mark dirty; the loop draws at
 *     most once per frame with every layer under the same camera —
 *     hull fills → hull strokes → edges → nodes → region labels → node
 *     labels → hover. Nothing can ever lag anything else.
 *   - Camera: d3-zoom supplies the verified pan / zoom-to-cursor / pinch
 *     math (screen = world·k + [x,y]). The camera lives in the renderer
 *     instance, so data refetches and settings changes never move it.
 *   - Picking: nearest-node distance check (µs at our scale), with a
 *     PICKING_PAD so the whole hover halo is hit-testable.
 *
 * Zoom-gated labels (the Obsidian text-fade feel): sigma's camera "ratio"
 * convention is kept for the settings' persisted semantics — ratio 1 =
 * fit zoom, SMALLER = zoomed in (ratio = kFit / k). Node labels are
 * fully visible at ratio ≤ labelZoom and fade out across a span
 * proportional to the gate (LABELS_FADE_RATIO)
 * of ratio; cluster labels fade in over the exact same span (sums to 1)
 * so the two never coexist. All labels gate together — no per-node
 * popping.
 *
 * The hover glow is unchanged in look: a soft halo in the node's own
 * color at a constant radius, opacity cross-faded over ~180ms, with the
 * name brightening on the SAME factor. Only opacity animates; the only
 * per-frame work when idle is a dirty-flag check (no rAF is scheduled at
 * all until something changes).
 *
 * Unit tests cover the pure helpers (tests/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { Simulation, SimulationLinkDatum } from "d3-force";
import { clusterHue, type Pt } from "./cluster-geometry.ts";
import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	createGraphSimulation,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	type PhysicsTuning,
	type RegionTuning,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
	type GraphRenderSettings,
	type LayoutNode,
	type Position,
} from "@/src/core";

export type { GraphRenderSettings };

// ─── Public data contract ──────────────────────────────────────────────────

/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
}

/** One directed edge of the DERIVED view (chains-primary, 2026-09-30):
 *  premise → implication node → conclusion, UNTYPED, all PLAIN
 *  single-shaft arrows — there is no double-shaft glyph anywhere
 *  (the 2026-09-14 ruling died with typed edges). An argument renders
 *  as its geometry: co-premise lines converge HEADLESS onto the
 *  implication point, one arrowed line leaves it; a single-premise
 *  argument is one ordinary arrow (see deriveView). */
export interface CanvasEdge {
	from: string;
	to: string;
}

/** Implication-node ids (the mint law: newGraphChainId in core/graph.ts).
 *  On the canvas an imp node is PURE GEOMETRY (owner, rendering arc
 *  2026-09-30): invisible — no disc, no label — and UNPICKABLE,
 *  excluded from every hit-test path. Exported for the test pin. */
export const isImpNodeId = (id: string): boolean => id.startsWith("arg_");

/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
	/** The folder area this note belongs to (core/areas.ts). */
	areaId?: string;
}

/** One folder AREA (owner, 2026-11-03): the zoomed-out label level, the
 *  region color, and the live sim's centroid-pull group. */
export interface CanvasArea {
	id: string;
	/** Display label, already localized by the caller. */
	label: string;
	members: string[];
}

/** Theme colors, resolved to #rrggbb by the caller (canvas wants hex,
 *  and the renderer must not read CSS itself). */
export interface CanvasColors {
	node: string;
	edge: string;
	label: string;
	hoverText: string;
	/** The sheet is dark (design pass 2026-11-06): area/region labels pick
	 *  a light tint on dark sheets and a deep one on light sheets — the old
	 *  fixed 78–82% lightness vanished on white. Absent = dark (legacy). */
	darkSheet?: boolean;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	/** The LOGICAL arrows (proposition→conclusion, imp contracted) the
	 *  depth force consumes — absent = the sim derives depth from the
	 *  drawn edges (legacy). Optional so non-graph callers of the
	 *  renderer stay simple. */
	logicalEdges?: CanvasEdge[];
	/** The imp chain linkage — the depth pass anchors each junction at
	 *  the premises/conclusion midpoint (owner, 2026-09-30). */
	impLinks?: ReadonlyArray<{ id: string; premises: ReadonlyArray<string>; conclusion: string }>;
	clusters: CanvasCluster[];
	/** Folder areas (absent = per-cluster coloring/pull, legacy). */
	areas?: CanvasArea[];
	colors: CanvasColors;
	/** Body font family (labels must match the app typography). */
	fontFamily: string;
}

export interface RendererCallbacks {
	/** A node was clicked (screen position included for card anchoring). */
	onSelect: (nodeId: string, screenPos: Pt) => void;
	/** Right-click: the picked node (canvas-relative screen position) or
	 *  null when the pointer hit empty stage — the caller opens/closes
	 *  its context menu accordingly. (node interlude, wave 7) */
	onContext: (nodeId: string | null, screenPos: Pt) => void;
	/** The empty stage was clicked. */
	onStageClick: () => void;
	/** Any camera move (pan/zoom) — the caller dismisses anchored UI and
	 *  persists the camera (view state). */
	onCameraMove: (transform: { k: number; x: number; y: number }) => void;
	/** The live sim settled after a drag: commit the new rest state
	 *  (the caller PUTs it to the positions ledger). */
	onCommit: (positions: Record<string, Position>) => void;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

const LABEL_SIZE = 12; // the reference label size the wrap-width ratio is taken against
const LABEL_WEIGHT = "500";

/** Region (cluster) labels — wave 7's session names made the labels
 *  LONG: imported-file paths and renamed chat titles. They wrap at a
 *  screen-fixed width (the labels are viewer-relative — this px value
 *  is exact on screen at any zoom), capped at a line count with an
 *  ellipsis on the last line (owner, 2026-09-23: wrap, cap 2–3 lines,
 *  ellipsize — a bounded footprint that keeps most of the path
 *  visible). */
const REGION_LABEL_MAX_WIDTH = 220; // screen px
const REGION_LABEL_MAX_LINES = 3;
const REGION_LABEL_LINE_HEIGHT = 1.3;

/** Wrap one region label: word-wise first (session names), then
 *  char-wise for words alone wider than the max (long file paths — the
 *  node-label discipline), capped at maxLines. Overflow folds into the
 *  last line, ellipsized to fit. measure is the canvas measureText (or a
 *  fake in tests) — pure otherwise. */
export function wrapRegionLabel(
	text: string,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): string[] {
	if (maxLines < 1) return [text];
	if (measure(text) <= maxWidth) return [text];
	const lines: string[] = [];
	const pending: string[] = text.split(/\s+/).filter(Boolean);
	// Fill up to maxLines-1 lines; the remainder becomes the last line.
	while (pending.length > 0 && lines.length < maxLines - 1) {
		let line = "";
		while (pending.length > 0) {
			let word = pending[0]!;
			const candidate = line ? `${line} ${word}` : word;
			if (measure(candidate) <= maxWidth) {
				line = candidate;
				pending.shift();
				continue;
			}
			if (!line) {
				// The word alone overflows: char-split it, the remainder stays
				// pending for the next line (paths have no spaces to help).
				let chunk = "";
				while (word.length > 0 && measure(chunk + word[0]) <= maxWidth) {
					chunk += word[0];
					word = word.slice(1);
				}
				if (chunk) {
					lines.push(chunk);
					pending[0] = word;
				} else {
					// Degenerate: one char exceeds the width — keep it whole so
					// the label can never vanish entirely.
					lines.push(word);
					pending.shift();
				}
				line = "";
			}
			break;
		}
		if (line) lines.push(line);
		if (!line && lines.length > 0 && pending.length > 0) continue;
		if (!line && lines.length === 0) break;
	}
	// The remainder rides as the last line: plain if it fits, ellipsized
	// down to the width if not.
	let rest = pending.join(" ");
	if (!rest) return lines;
	if (measure(rest) <= maxWidth) {
		lines.push(rest);
		return lines;
	}
	let tail = rest;
	while (tail.length > 1 && measure(`${tail}…`) > maxWidth) tail = tail.slice(0, -1);
	lines.push(`${tail}…`);
	return lines;
}

/** Label-only cluster patch (rename-shuffle fix, 2026-09-23): apply a set
 *  of live label updates to the data-side cluster records AND the built
 *  region meta (re-wrapping the changed entries with the provided
 *  measure — the same wrap a geometry build would produce). The
 *  hull-silence guard travels here: a cluster whose CURRENT label is
 *  null is a gone record — no rename can reach it. Pure, in-place on the
 *  provided arrays; returns whether anything changed (the caller only
 *  redraws when it did). Exported for tests. */
export function applyClusterLabels(
	clusters: { id: string; label: string | null }[],
	regionMeta: { id: string; label: string | null; lines: string[] | null }[],
	labels: ReadonlyMap<string, string | null>,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): boolean {
	let changed = false;
	for (const cluster of clusters) {
		if (!labels.has(cluster.id)) continue;
		if (cluster.label == null) continue; // hull silence: gone records stay silent
		const label = labels.get(cluster.id) ?? null;
		if (label === cluster.label) continue;
		cluster.label = label;
		changed = true;
	}
	if (!changed) return false;
	for (const rm of regionMeta) {
		if (!labels.has(rm.id)) continue;
		if (rm.label == null) continue;
		const label = labels.get(rm.id) ?? null;
		rm.label = label;
		rm.lines = label
			? wrapRegionLabel(label, maxWidth, maxLines, measure)
			: null;
	}
	return true;
}
const LABEL_MAX_WIDTH = 170; // wrap width at the reference label size, world units
const LABEL_GAP = 2.9; // world units between node edge and first label line (the 2px-at-fit reference ÷ 0.69)
const LABEL_LINE_HEIGHT = 1.3;
/** The node→cluster label cross-fade spans gate × this (camera-ratio
 *  units) — PROPORTIONAL since 2026-09-17. The old absolute span (0.5
 *  ratio) read as a 100% relative change at the old 0.5 gate but a bare
 *  12% sliver at the tuned 8x gate (ratio 4): "lower zoom levels naturally
 *  produce a longer transitionary period while higher ones are more
 *  abrupt" — the user's exact observation. Proportional keeps ONE
 *  transitionary feel at any gate; at the 8x default the handoff fades
 *  across a full stop (8x → 12x). */
export const LABELS_FADE_RATIO = 0.5;

const GLOW_SCALE = 1.7; // halo outer radius = node radius x this (proportional, like blurring a copy of the disc)
const GLOW_ALPHA = 0.3; // halo opacity at the disc edge, fading outward
const HOVER_FADE_MS = 180; // hover halo opacity fade length
const ZOOM_EASE_MS = 45; // wheel-zoom glide: exponential-ease time constant (~250ms per notch)

/** Extra pickable radius (px) beyond the disc — the whole halo is
 *  hit-testable (the old flicker fix, minus the picking shader). */
const PICKING_PAD = 10;

/** Click vs drag threshold: pointer travel under this many px is a click. */
const CLICK_SLOP = 4;
/** Live-sim tuning — see the class doc comment. */
const LIVE_ALPHA_DECAY = 0.05; // snappier anneal than the settle's 0.0228
const DRAG_ALPHA_TARGET = 0.3; // d3-drag's own reheat constant
const SIM_SETTLE_ALPHA = 0.005; // below this, the sim counts as settled
const COMMIT_DEBOUNCE_MS = 250; // settle → ledger PUT delay (new drags cancel)

/** Cluster region styling — a low-res world-space SPLAT bitmap (the
 *  density-field technique, Canvas-2D edition): every member node paints
 *  a soft radial-gradient disc and every intra-cluster edge a round-cap
 *  stroke; upscaling the bitmap with bilinear smoothing IS the blur.
 *  Replaces the convex-hull fills + borders: concave cluster shapes are
 *  finally correct (the hull bridged every gap with straight lines —
 *  the jagged close-up look), there is no border to lag behind, and a
 *  live-physics frame pays one tiny blit instead of 32 clusters × 4
 *  offset polygons re-rasterized at DPR 2 (the old GPU coil-whine). */
/** Live-sim region rebuild throttle (ms): the CPU blur is the heaviest
 *  step on a big graph, so a moving graph re-rasterizes at most this
 *  often and blits the last bitmap in between (owner, 2026-11-03 — was
 *  every 3rd frame, i.e. ~20 blurs/s). */
const REGION_MIN_INTERVAL_MS = 200;
/** Local physics radius (owner, 2026-11-03): 2 logical hops. */
const LOCAL_SIM_HOPS = 2;
/** Area labels: bigger + bolder than note labels (screen px factor). */
const AREA_LABEL_SCALE = 1.5;
const AREA_LABEL_WEIGHT = "600";
const AREA_LABEL_MAX_LINES = 2;
/** Screen gap kept between two placed region labels (px). */
const LABEL_PLACE_PAD = 4;



/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA
 *  (Float32, stride 4, length w*h*4). Premultiplying first is what keeps
 *  the blur halo-free: blurring non-premultiplied RGB over varying alpha
 *  bleeds solid color into transparent space. Pure: DOM-free, tested. */
export function boxBlurRound(
	src: Float32Array,
	tmp: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	radius: number,
): void {
	if (radius <= 0) {
		dst.set(src);
		return;
	}
	const div = radius * 2 + 1;
	// Horizontal: src → tmp (clamped window, running sum).
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let x = -radius; x <= radius; x++) {
			const i = row + Math.min(Math.max(x, 0), w - 1) * 4;
			sum0 += src[i]!;
			sum1 += src[i + 1]!;
			sum2 += src[i + 2]!;
			sum3 += src[i + 3]!;
		}
		for (let x = 0; x < w; x++) {
			const o = row + x * 4;
			tmp[o] = sum0 / div;
			tmp[o + 1] = sum1 / div;
			tmp[o + 2] = sum2 / div;
			tmp[o + 3] = sum3 / div;
			const addI = row + Math.min(x + radius + 1, w - 1) * 4;
			const subI = row + Math.max(x - radius, 0) * 4;
			sum0 += src[addI]! - src[subI]!;
			sum1 += src[addI + 1]! - src[subI + 1]!;
			sum2 += src[addI + 2]! - src[subI + 2]!;
			sum3 += src[addI + 3]! - src[subI + 3]!;
		}
	}
	// Vertical: tmp → dst.
	for (let x = 0; x < w; x++) {
		const col = x * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let y = -radius; y <= radius; y++) {
			const i = col + Math.min(Math.max(y, 0), h - 1) * w * 4;
			sum0 += tmp[i]!;
			sum1 += tmp[i + 1]!;
			sum2 += tmp[i + 2]!;
			sum3 += tmp[i + 3]!;
		}
		for (let y = 0; y < h; y++) {
			const o = col + y * w * 4;
			dst[o] = sum0 / div;
			dst[o + 1] = sum1 / div;
			dst[o + 2] = sum2 / div;
			dst[o + 3] = sum3 / div;
			const addI = col + Math.min(y + radius + 1, h - 1) * w * 4;
			const subI = col + Math.max(y - radius, 0) * w * 4;
			sum0 += tmp[addI]! - tmp[subI]!;
			sum1 += tmp[addI + 1]! - tmp[subI + 1]!;
			sum2 += tmp[addI + 2]! - tmp[subI + 2]!;
			sum3 += tmp[addI + 3]! - tmp[subI + 3]!;
		}
	}
}

/** Geometry constants are WORLD UNITS (the 2026-09-15 pivot): node/
 *  label/arrowhead sizes come from the settings directly — the same law
 *  as linkDistance — so the world scale is canonical and never depends on
 *  the graph's extent or the viewport. Camera zoom scales them with the
 *  graph (Obsidian-style); edge widths and hull borders stay
 *  viewer-relative hairlines (÷ k); cluster labels stay screen-fixed
 *  (px at any zoom). kFit survives ONLY as the label-gate's "1×"
 *  reference (zoomRatioOf) — a pure LOD threshold, no geometry reads it. */

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across a span of labelZoom x LABELS_FADE_RATIO
 * (see there). Cluster labels use `1 - this` over the same span — the
 * two cross-fade and never coexist at full opacity.
 */
export function labelAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const k = Math.min((w - 2 * padding) / bw, (h - 2 * padding) / bh);
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	return { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
}

/** The arrowhead geometry for a directed edge a→b: shaft endpoints
 *  (clear of both node discs) and the head triangle (tip on the target
 *  disc edge, wideness = 0.8 × head length — the sigma arrow shape). */
/** One complete arrow glyph: shaft + head triangle. */
export interface ArrowGeom {
	shaftFrom: Pt;
	shaftTo: Pt;
	tip: Pt;
	left: Pt;
	right: Pt;
}

export function arrowGeometry(
	a: Pt,
	b: Pt,
	fromRadius: number,
	toRadius: number,
	headLength: number,
): ArrowGeom | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null; // degenerate (coincident) — skip
	const ux = dx / len;
	const uy = dy / len;
	const tip = { x: b.x - ux * toRadius, y: b.y - uy * toRadius };
	const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
	const halfW = 0.4 * headLength;
	return {
		shaftFrom: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		shaftTo: base,
		tip,
		left: { x: base.x - uy * halfW, y: base.y + ux * halfW },
		right: { x: base.x + uy * halfW, y: base.y - ux * halfW },
	};
}


/** Nearest node within maxDist of a screen point (linear scan — µs at
 *  our scale; a spatial grid only earns its keep past ~10k nodes). */
export function pickNearest<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist * maxDist; // compare squared distances
	for (const n of nodes) {
		const d = (n.x - px) ** 2 + (n.y - py) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

/** Axis-aligned rect (any consistent space — screen px or world units). */
export interface LabelRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** GREEDY NON-OVERLAPPING LABEL PLACEMENT (owner, 2026-11-03): walk the
 *  candidates IN PRIORITY ORDER (the caller sorts — biggest cluster /
 *  best-connected node first) and accept each one whose rect hits no
 *  already-accepted rect. A uniform grid hash keeps it ~O(n): each rect
 *  is tested only against the accepted rects sharing its cells. Rects
 *  outside `view` (when given) are skipped without being accepted — the
 *  culling and the collision pass are one walk. Returns the accepted
 *  candidate indices, in input order. Pure — unit-tested. */
export function placeLabels(rects: ReadonlyArray<LabelRect>, cell: number, view?: LabelRect): number[] {
	const grid = new Map<string, number[]>();
	const accepted: number[] = [];
	const size = cell > 0 ? cell : 1;
	for (let i = 0; i < rects.length; i++) {
		const r = rects[i]!;
		if (view && (r.x1 < view.x0 || r.x0 > view.x1 || r.y1 < view.y0 || r.y0 > view.y1)) continue;
		const cx0 = Math.floor(r.x0 / size);
		const cx1 = Math.floor(r.x1 / size);
		const cy0 = Math.floor(r.y0 / size);
		const cy1 = Math.floor(r.y1 / size);
		let hit = false;
		for (let gx = cx0; gx <= cx1 && !hit; gx++) {
			for (let gy = cy0; gy <= cy1 && !hit; gy++) {
				const bucket = grid.get(`${gx},${gy}`);
				if (!bucket) continue;
				for (const j of bucket) {
					const o = rects[j]!;
					if (r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) {
						hit = true;
						break;
					}
				}
			}
		}
		if (hit) continue;
		accepted.push(i);
		for (let gx = cx0; gx <= cx1; gx++) {
			for (let gy = cy0; gy <= cy1; gy++) {
				const key = `${gx},${gy}`;
				const bucket = grid.get(key);
				if (bucket) bucket.push(i);
				else grid.set(key, [i]);
			}
		}
	}
	return accepted;
}

/** The LOCAL-PHYSICS neighborhood (owner, 2026-11-03: 2 hops): every
 *  node within `hops` steps of `start` over the undirected adjacency.
 *  Implication nodes are TRANSPARENT — stepping onto one costs no hop
 *  (premise → imp → conclusion is ONE logical step), so "2 hops" means
 *  two arguments away, not one. Pure — unit-tested. */
export function neighborhood(
	adjacency: ReadonlyMap<string, ReadonlyArray<string>>,
	start: string,
	hops: number,
	isFree: (id: string) => boolean = isImpNodeId,
): Set<string> {
	const best = new Map<string, number>([[start, 0]]);
	// 0-1 BFS: free steps go to the FRONT of the deque.
	const deque: string[] = [start];
	while (deque.length > 0) {
		const id = deque.shift()!;
		const d = best.get(id)!;
		for (const next of adjacency.get(id) ?? []) {
			const cost = isFree(next) ? 0 : 1;
			const nd = d + cost;
			if (nd > hops) continue;
			const prev = best.get(next);
			if (prev !== undefined && prev <= nd) continue;
			best.set(next, nd);
			if (cost === 0) deque.unshift(next);
			else deque.push(next);
		}
	}
	return new Set(best.keys());
}

/** THE THREE LABEL BANDS (owner, 2026-11-03): areas far out → notes in
 *  the middle → node names up close. `labelZoom` gates node names (the
 *  existing control), `noteZoom` gates notes (ratio units, larger =
 *  farther out). Each handoff cross-fades across the proportional span
 *  (LABELS_FADE_RATIO) and the three opacities always sum to 1. */
export function labelBands(
	ratio: number,
	labelZoom: number,
	noteZoom: number,
): { node: number; note: number; area: number } {
	const node = labelAlpha(ratio, labelZoom);
	const noteIn = labelAlpha(ratio, noteZoom);
	const note = Math.max(0, noteIn - node);
	return { node, note, area: Math.max(0, 1 - node - note) };
}

/** Area hues, evenly spread (owner, 2026-11-03: color by area): the
 *  golden angle over the area ids in sorted order — ~26 areas land
 *  well apart on the wheel (a string hash collided visibly), and the
 *  assignment is stable while the area set is. Pure — unit-tested. */
export function areaHues(areaIds: ReadonlyArray<string>): Map<string, number> {
	const sorted = [...new Set(areaIds)].sort();
	return new Map(sorted.map((id, i) => [id, Math.round((i * 137.508) % 360)]));
}

// ─── Canvas text helpers (ported verbatim) ─────────────────────────────────

/** "#rrggbb" + alpha → "rgba(...)". */
function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Word-wrap for canvas text. Never truncates: overlong single words are
 *  hard-broken by character so no line ever exceeds maxWidth. */
function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null) {
			const joined = `${last} ${word}`;
			if (context.measureText(joined).width <= maxWidth) {
				lines[lines.length - 1] = joined;
				continue;
			}
		}
		let chunk = "";
		for (const char of word) {
			if (chunk && context.measureText(`${chunk}${char}`).width > maxWidth) {
				lines.push(chunk);
				chunk = char;
			} else {
				chunk += char;
			}
		}
		if (chunk) lines.push(chunk);
	}
	return lines;
}

/** World-unit sizes for the label pass, derived once per geometry build. */
interface WorldSizes {
	nodeR: number; // node disc radius, world units
	glowOuter: number; // hover halo outer radius, world units
	labelSize: number; // node label font, world units
	labelGap: number; // node edge → first label line, world units
}

/** The pre-wrapped node name, centered below the node in WORLD units —
 *  identical geometry at rest and on hover, so hover only changes the
 *  color, nothing jumps. Lines are wrapped once per geometry build, never
 *  per frame. */
function drawNameLines(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	lines: string[],
	world: WorldSizes,
	color: string,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + world.nodeR + world.labelGap;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * world.labelSize * LABEL_LINE_HEIGHT);
	}
}

/** A screen-fixed region label (note or area): world anchor, hue,
 *  pre-wrapped lines, measured block width (px), priority (members). */
interface RegionLabel {
	id: string;
	label: string | null;
	lines: string[] | null;
	cx: number;
	cy: number;
	hue: number;
	w?: number;
	size?: number;
}

// ─── The renderer ───────────────────────────────────────────────────────────

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** Last-synced CSS size — the resize anchor computes the world point
	 *  under the PRE-resize viewport center from these (ResizeObserver
	 *  callbacks already see the NEW size in clientWidth/Height). */
	private viewW = 0;
	private viewH = 0;
	/** The k that frames the whole graph — the label-gate's "1×". */
	private kFit = 1;
	/** World-space bounds of the current nodes — fit() and the resize-time
	 *  kFit refresh share it (computed once per setData, not per resize). */
	private worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

	private data: CanvasData | null = null;
	/** id -> node for the current data (avoids O(n^2) scans). */
	private nodeById = new Map<string, CanvasNode>();
	private settings: GraphRenderSettings | null = null;
	private visible: ReadonlySet<string> | null = null;

	// ── Live physics ──
	// One d3-force sim shared with the server settle (createGraphSimulation
	// in @/src/core): dragging pins fx/fy and reheats (alphaTarget), release
	// un-pins and the sim anneals; once alpha drops below SIM_SETTLE_ALPHA
	// the new rest state is debounced-committed via onCommit. The sim mutates
	// data.nodes IN PLACE (they ARE the sim nodes — zero copying), so every
	// tick just bumps geoVersion and the draw loop rebuilds geometry.
	private sim: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
	private simById = new Map<string, LayoutNode>();
	private simActive = false;
	/** LOCAL PHYSICS (owner, 2026-11-03): a drag simulates only the
	 *  dragged node's 2-hop neighborhood (`localSim`, over the SAME node
	 *  objects) with its outer rim pinned — the rest of the graph stays
	 *  put and costs nothing. The full `sim` survives only for the
	 *  explicit re-anneal (physics tuning change). */
	private localSim: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
	/** Rim nodes the local sim pinned (fx/fy) — released at settle. */
	private localPinned: LayoutNode[] = [];
	/** Nodes that may move right now (local sim or light-mode drag):
	 *  geometry outside it is cached in the STATIC paths and only the
	 *  moving part is rebuilt per frame. null = everything may move. */
	private movingSet: Set<string> | null = null;
	/** Undirected adjacency over the drawn edges (rebuilt per setData). */
	private adjacency = new Map<string, string[]>();
	/** "from\u0000to" → the stored edges (moving-part rebuilds). */
	private edgeIndex = new Map<string, CanvasEdge[]>();
	/** Area id → hue, and node id → area id (for colors). */
	private areaHue = new Map<string, number>();
	private dragId: string | null = null;
	/** A light-mode drag is under way (past the click slop). */
	private lightDragged = false;
	private dragOrigin: Pt | null = null;
	private simMoved = false; // any real movement since the last commit
	private commitTimer: ReturnType<typeof setTimeout> | null = null;

	private frameId: number | null = null;
	private dirty = true;
	/** True while tick() runs: markDirty inside the loop (d3's zoom event
	 *  fires from advanceZoom) must NOT schedule — the loop schedules
	 *  itself below. Un-guarded, each glide frame leaked an extra queued
	 *  tick and draws multiplied per displayed frame (20fps zoom bug). */
	private inTick = false;

	// Hover transition: fade 0 = resting, 1 = fully hovered; the animating
	// flag keeps the loop scheduled until the fade settles (then rAF stops).
	private hoverId: string | null = null;
	/** The node the glow is drawn on. OUTLIVES hoverId on hover-out so the
	 *  fade has something to draw (hoverId nulls instantly; without this
	 *  the glow popped off in one frame instead of fading). Cleared when
	 *  the outgoing fade completes. */
	private hoverNode: CanvasNode | null = null;
	private hoverFade = 0;
	private hoverFrom = 0;
	private hoverTarget = 0;
	private hoverStart = 0;
	// Smooth wheel zoom: wheel events accumulate a target scale (cursor-
	// anchored); each tick eases the camera toward it instead of jumping.
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	/** Clock for frame-rate-independent easing (updated every tick). */
	private lastTickAt = 0;
	private animating = false;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	// ── Cached world geometry ─────────────────────────────────────────────
	// Everything above is drawn per frame; everything below is derived from
	// data+visibility+settings+kFit and rebuilt ONLY when one of those
	// changes (geoVersion). Camera moves just re-rasterize the same paths.
	private geoVersion = 0; // bump = geometry inputs changed
	private builtVersion = -1; // version the cache was built at
	private nodesPath: Path2D | null = null;
	private shaftsPath: Path2D = new Path2D();
	private headsPath: Path2D = new Path2D();
	/** The MOVING part's paths (see movingSet); empty at rest. */
	private dynNodesPath: Path2D = new Path2D();
	private dynShaftsPath: Path2D = new Path2D();
	private dynHeadsPath: Path2D = new Path2D();
	/** The movingSet the static paths were built for (identity). */
	private staticFor: Set<string> | null | undefined = undefined;
	/** Inputs (other than positions) the static paths depend on. */
	private staticInputs = -1;
	private inputsVersion = 0; // data/visibility/settings changes only
	private regionCanvas: HTMLCanvasElement | null = null;
	/** World rect the bitmap covers (drawImage target coords). */
	private regionRect: { minX: number; minY: number; w: number; h: number } | null = null;
	/** Region labels: cluster centroid + hue, computed at splat build. */
	private regionMeta: RegionLabel[] = [];
	/** Area labels (the zoomed-out band), same shape as regionMeta. */
	private areaMeta: RegionLabel[] = [];
	private labelMetaVersion = -1;
	private lastRegionAt = 0;
	private regionTuning: RegionTuning = DEFAULT_REGION_TUNING;
	private physicsTuning: PhysicsTuning = DEFAULT_PHYSICS_TUNING;
	/** Gravity center for the live sim (graph bbox centroid at setData). */
	private simCenter: Pt = { x: 0, y: 0 };
	private regionBuiltVersion = -1;
	private frameCount = 0; // draw counter for the live-sim splat throttle
	private labelLines = new Map<string, string[]>();
	/** Wrap cache: id → {text, lines, width}; reused while the font/wrap
	 *  width and the label text are unchanged (a moving graph never
	 *  re-measures text). */
	private labelWrap = new Map<string, { text: string; lines: string[]; w: number }>();
	private labelWrapKey = "";
	/** Node labels that survived the overlap pass (best-connected first),
	 *  with their world rects — recomputed at rest only. */
	private placedNodeLabels: { id: string; rect: LabelRect }[] = [];
	private placedAt = -1;
	private worldLabelFont = "";
	private world: WorldSizes = { nodeR: 0, glowOuter: 0, labelSize: 0, labelGap: 0 };

	constructor(
		canvas: HTMLCanvasElement,
		callbacks: RendererCallbacks,
		/** The caller's persisted camera (view state — localStorage): when
		 *  present it REPLACES the first-open fit; the graph opens exactly
		 *  where the user left it (2026-09-15: a default zoom exists only
		 *  on first open, ever). Invalid shapes fall back to fit. */
		initialCamera?: { k: number; x: number; y: number } | null,
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		// d3-zoom owns pan / wheel zoom-to-cursor / touch pinch; every
		// transform change just marks dirty (draws happen in OUR loop).
		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.02, 40])
			.on("zoom", ({ transform }) => {
				this.transform = transform;
				this.markDirty();
				// The transform doubles as the persistence payload (view state).
				this.callbacks.onCameraMove(transform);
			});
		select(canvas)
			.call(this.zoomBehavior)
			// No surprise dblclick-zoom (sigma had none).
			.on("dblclick.zoom", null)
			// Wheel is OURS now: d3's instant per-notch jump felt janky; the
			// eased glide below replaces it (pan and pinch stay d3's).
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		// Right-click → the caller's context menu (node interlude). Always
		// preventDefault: the native menu on a full-bleed custom canvas is
		// never useful; the caller decides what (if anything) opens.
		canvas.addEventListener("contextmenu", this.onContextMenu);

		// The persisted camera: replace the default with wherever the user
		// left the graph. Applied through the zoom behavior so d3's internal
		// state and ours agree (the same path fit() uses); hasFit so neither
		// the ResizeObserver nor setData re-fits over it.
		if (
			initialCamera &&
			typeof initialCamera.k === "number" && Number.isFinite(initialCamera.k) && initialCamera.k > 0 &&
			typeof initialCamera.x === "number" && Number.isFinite(initialCamera.x) &&
			typeof initialCamera.y === "number" && Number.isFinite(initialCamera.y)
		) {
			this.hasFit = true;
			select(canvas).call(
				this.zoomBehavior.transform,
				zoomIdentity.translate(initialCamera.x, initialCamera.y).scale(initialCamera.k),
			);
		}

		this.resizeObserver = new ResizeObserver(() => {
			// The world point under the pre-resize viewport center — the
			// visual anchor the new transform must preserve. Capture it
			// BEFORE syncSize (which updates viewW/H to the new size).
			const prevW = this.viewW;
			const prevH = this.viewH;
			const { x: tx, y: ty, k } = this.transform;
			const wx = (prevW / 2 - tx) / k;
			const wy = (prevH / 2 - ty) / k;
			this.syncSize();
			if (!this.hasFit) this.fit(); // first real size → fit once
			else {
				this.refreshFitZoom(); // the gate's "1×" is viewport-bound
				// Center-anchor (2026-09-17, owner): same world point under
				// the NEW center. Applied through the zoom behavior like every
				// camera move (d3 state, persistence, card-dismiss all agree).
				if (prevW > 0 && prevH > 0 && this.viewW > 0 && this.viewH > 0) {
					select(canvas).call(
						this.zoomBehavior.transform,
						zoomIdentity.translate(this.viewW / 2 - wx * k, this.viewH / 2 - wy * k).scale(k),
					);
				}
			}
			// Redraw SYNCHRONOUSLY: syncSize may have reallocated the backing
			// store (which clears the canvas), and during live window resizes
			// rAF is starved by relayout — a deferred draw would leave the
			// canvas blank for the whole drag (the resize-blanking bug).
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		this.worldBBox = { minX, maxX, minY, maxY };
		if (!this.hasFit && data.nodes.length > 0) this.fit();
		// The camera may be user-restored (constructor initialCamera) — the
		// gate's "1×" reference still needs the fresh bbox's fit zoom.
		else this.refreshFitZoom();
		// Rebuild the live sim around the fresh nodes. New data means the
		// server spoke (merge or refetch); any pending commit is moot and
		// the graph is at rest until the next drag.
		if (this.commitTimer) {
			clearTimeout(this.commitTimer);
			this.commitTimer = null;
		}
		this.simActive = false;
		this.dragId = null;
		this.simMoved = false;
		this.endLocalSim();
		this.movingSet = null;
		this.simCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
		// Undirected adjacency (local physics neighborhoods).
		const adjacency = new Map<string, string[]>();
		const link = (a: string, b: string) => {
			let list = adjacency.get(a);
			if (!list) adjacency.set(a, (list = []));
			list.push(b);
		};
		for (const e of data.edges) {
			if (e.from === e.to) continue;
			link(e.from, e.to);
			link(e.to, e.from);
		}
		this.adjacency = adjacency;
		const edgeIndex = new Map<string, CanvasEdge[]>();
		for (const e of data.edges) {
			const key = `${e.from}\u0000${e.to}`;
			const list = edgeIndex.get(key);
			if (list) list.push(e);
			else edgeIndex.set(key, [e]);
		}
		this.edgeIndex = edgeIndex;
		this.areaHue = areaHues((data.areas ?? []).map((a) => a.id));
		this.buildSim();
		this.inputsVersion++;
		this.geoVersion++; // new data → rebuild world geometry
		this.markDirty();
	}

	setSettings(settings: GraphRenderSettings): void {
		const prevLight = this.settings?.lightMode ?? false;
		this.settings = settings;
		if (settings.lightMode !== prevLight) {
			// Light mode flips the backing-store resolution and the
			// region compute — resize + force a region rebuild/drop.
			this.syncSize();
			this.regionBuiltVersion = -2;
			if (settings.lightMode) {
				this.regionCanvas = null;
				this.regionRect = null;
				// No live physics in light mode: stop whatever is moving.
				this.endLocalSim();
				this.simActive = false;
				this.movingSet = null;
			}
		}
		this.inputsVersion++;
		this.geoVersion++; // sizes/wrap width changed → rebuild geometry
		this.markDirty();
	}

	/** Dev tuning for region rendering (session-only, never persisted):
	 *  invalid numbers fall back to defaults — the number inputs can be
	 *  emptied while typing. Forces a region bitmap rebuild. */
	setRegionTuning(input: Partial<RegionTuning>): void {
		this.regionTuning = sanitizeRegionTuning(input);
		this.regionBuiltVersion = -2; // never equals geoVersion → rebuild
		// Off switch turning off: drop the bitmap immediately so the
		// blit stops on the next frame — the rebuild itself skips all
		// compute (buildRegions).
		if (!this.regionTuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
		}
		this.markDirty();
	}

	/** Live-sim physics controls: rebuilds the sim from the CURRENT
	 *  node positions (same node objects — x/y and any drag pin fx/fy
	 *  survive; velocities restart clean, which reads as "re-relax with
	 *  the new feel"). A mid-settle change re-anneals, which is the
	 *  honest response to new physics. */
	setPhysicsTuning(input: Partial<PhysicsTuning>): void {
		const next = sanitizePhysicsTuning(input);
		// Same values (e.g. the settings load echoing what we already run):
		// no rebuild, no whole-graph re-anneal — on a 4k-node graph that
		// reheat was a multi-second stall at every app start.
		if (JSON.stringify(next) === JSON.stringify(this.physicsTuning)) return;
		this.physicsTuning = next;
		this.buildSim();
		// Light mode has no live physics: keep the new tuning for the
		// next settle, never re-anneal on screen.
		if (this.settings?.lightMode) {
			this.markDirty();
			return;
		}
		this.endLocalSim();
		this.movingSet = null;
		// Reheat: a tuning change re-anneals the layout from its current
		// state, so mode toggles (off/vertical/radial) visibly RE-FORM the
		// graph instead of waiting for the next drag. Mid-drag is safe —
		// buildSim preserved the pinned node's fx/fy.
		if (this.sim) {
			this.sim.alpha(1);
			this.simActive = true;
		}
		this.markDirty();
	}

	/** Label-only channel (rename-shuffle fix, 2026-09-23): live
	 *  cluster-label updates with NO setData. The rename path used to
	 *  build a fresh snapshot object, which flowed setData → geometry
	 *  rebuild — and the rebuild treats the last-fetched ledger as
	 *  authoritative and cancels any pending drag commit, so a rename
	 *  visibly rewound the whole graph whenever display had drifted
	 *  (recent drag, mid-anneal, physics re-anneal). This channel touches
	 *  ONLY label text: the region meta the draw pass reads plus the
	 *  data-side cluster record (so the next geometry rebuild —
	 *  visibility/settings/size — keeps the fresh label). Nodes, the
	 *  sim, positions, and the pending commit are never touched. */
	setClusterLabels(labels: ReadonlyMap<string, string | null>): void {
		const data = this.data;
		if (!data) return;
		const settings = this.settings;
		// No settings yet → nothing is drawn; patch the data side only and
		// let the next build derive the wrap (same guard the build uses).
		if (!settings) {
			applyClusterLabels(data.clusters, [], labels, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, () => 0);
			return;
		}
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
		const changed = applyClusterLabels(
			data.clusters,
			this.regionMeta,
			labels,
			REGION_LABEL_MAX_WIDTH,
			REGION_LABEL_MAX_LINES,
			(s) => ctx.measureText(s).width,
		);
		if (changed) {
			for (const rm of this.regionMeta) rm.w = rm.lines ? Math.max(0, ...rm.lines.map((l) => ctx.measureText(l).width)) : 0;
			this.markDirty();
		}
		ctx.font = prevFont;
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.visible = visible;
		this.inputsVersion++;
		this.geoVersion++; // member visibility changes hulls + paths
		this.markDirty();
	}

	/** Frame the whole graph (padding included). Keeps the camera on later
	 *  setData calls — call fit() only for an explicit re-frame (the
	 *  first-ever open; afterwards the caller-persisted camera wins). */
	fit(): void {
		if (!this.data || this.data.nodes.length === 0 || !this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // layout not ready yet; the ResizeObserver retries
		const t = fitTransform(this.worldBBox, w, h, 40);
		this.kFit = t.k;
		this.hasFit = true;
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(t.x, t.y).scale(t.k),
		);
	}

	/** Refresh the label-gate's "1×" reference from the current bbox +
	 *  viewport. kFit feeds ONLY zoomRatioOf now (the 2026-09-15 pivot
	 *  removed it from geometry) — so this never touches geoVersion. */
	private refreshFitZoom(): void {
		if (!this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w >= 10 && h >= 10) this.kFit = fitTransform(this.worldBBox, w, h, 40).k;
	}

	destroy(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.sim = null;
		this.simActive = false;
		this.dragId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.canvas.style.cursor = "";
	}

	// ── Event handlers (state mutation only — never draw) ──

	/** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
	 *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		// Must stay inside the zoomBehavior's scaleExtent [0.02, 40].
		const k = Math.min(Math.max(current * Math.exp(delta), 0.02), 40);
		this.zoomTarget = { k, x, y };
		// Fresh easing clock so the glide starts gentle, never half-done.
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		const pos = this.eventPos(e);
		if (this.dragId) {
			const n = this.simById.get(this.dragId);
			if (n) {
				const moved =
					this.dragOrigin !== null &&
					Math.hypot(pos.x - this.dragOrigin.x, pos.y - this.dragOrigin.y) > CLICK_SLOP;
				const { x: tx, y: ty, k } = this.transform;
				const wx = (pos.x - tx) / k;
				const wy = (pos.y - ty) / k;
				if (moved) {
					if (this.commitTimer) {
						clearTimeout(this.commitTimer);
						this.commitTimer = null;
					}
					this.dragOrigin = null; // past the slop for good
					if (this.settings?.lightMode) {
						// Light mode: no physics — the node alone follows.
						this.movingSet = new Set([this.dragId]);
						this.lightDragged = true;
					} else if (!this.localSim) {
						// First real movement: local sim over the 2-hop
						// neighborhood, reheated, node glued to the cursor.
						this.startLocalSim(this.dragId);
					}
				}
				if (this.settings?.lightMode) {
					if (this.lightDragged) {
						n.x = wx;
						n.y = wy;
						this.simMoved = true;
						this.geoVersion++;
						this.markDirty();
					}
				} else {
					n.fx = wx;
					n.fy = wy;
				}
			}
			return;
		}
		const node = this.pickAt(pos.x, pos.y);
		if ((node?.id ?? null) !== this.hoverId) this.setHover(node?.id ?? null);
		this.canvas.style.cursor = node ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		// Primary button only (owner, polish round): a right-press must not
		// pin the node — right-click belongs to the context menu alone, and
		// the right-pointerup must never read as a click (the detail card
		// used to open under the menu).
		if (e.button !== 0) return;
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		if (node && this.simById.has(node.id)) {
			// Node press: pin the node (at ITS OWN position — the cursor
			// may be inside the pick pad, off-center). preventDefault kills
			// the compatibility mousedown, so d3-zoom never starts a pan.
			// Physics only reheats once the pointer exceeds CLICK_SLOP —
			// a plain click stays perfectly still.
			e.preventDefault();
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				/* capture is best-effort */
			}
			this.dragId = node.id;
			this.dragOrigin = pos;
			const n = this.simById.get(node.id);
			if (n) {
				n.fx = n.x;
				n.fy = n.y;
			}
			this.canvas.style.cursor = "grabbing";
			this.markDirty();
			return;
		}
		this.downPos = pos;
		this.zoomTarget = null; // a pan takes over — cancel any zoom glide
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.button !== 0) return; // right-click is context-menu territory
		// Node press ending: click (no slop) → select; drag → release-and-relax.
		if (this.dragId) {
			const id = this.dragId;
			this.dragId = null;
			this.dragOrigin = null;
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* already released */
			}
			this.canvas.style.cursor = "";
			const n = this.simById.get(id);
			if (n) {
				n.fx = null;
				n.fy = null;
			}
			if (this.lightDragged) {
				// Light-mode drag ends where the pointer let go: commit.
				this.lightDragged = false;
				this.movingSet = null;
				this.geoVersion++;
				this.markDirty();
				this.scheduleCommit();
			} else if (this.simActive) {
				// Real drag: the sim anneals to the new rest state; advanceSim
				// detects the settle and schedules the commit.
				(this.localSim ?? this.sim)?.alphaTarget(0);
				this.markDirty();
			} else {
				// Never heated: a plain click on the node.
				this.callbacks.onSelect(id, this.eventPos(e));
			}
			return;
		}
		if (!this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else this.callbacks.onStageClick();
	};

	/** Right-click: pick the node under the pointer, hand the position to
	 *  the caller (empty stage = null — the caller closes any open menu). */
	private onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		this.callbacks.onContext(node?.id ?? null, pos);
	};

	private onPointerLeave = () => {
		if (this.dragId) return; // pointer capture keeps the drag alive
		this.downPos = null;
		this.setHover(null);
	};

	// ── Internals ──

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pickAt(px: number, py: number): CanvasNode | null {
		if (!this.data || !this.settings) return null;
		// Screen positions, filtered to visible nodes.
		const { x: tx, y: ty, k } = this.transform;
		// Discs scale with the camera now: their screen radius is
		// nodeSize × k/kFit; the halo pad stays a constant screen pad.
		// nodeSize is world units now (2026-09-15): the on-screen hit radius
		// is the disc's world radius × the camera zoom, plus the constant
		// screen pad — the whole halo stays hit-testable.
		const maxDist = this.settings.nodeSize * k + PICKING_PAD;
		// Allocation-free scan (pickNearest's rule — nearest strictly
		// within maxDist, first wins ties): pointermove fires per mouse
		// event, and a projected copy of 4k nodes each time was garbage.
		let best: CanvasNode | null = null;
		let bestD = maxDist * maxDist;
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			if (isImpNodeId(n.id)) continue; // pure geometry — never picked
			const dx = n.x * k + tx - px;
			const dy = n.y * k + ty - py;
			const d = dx * dx + dy * dy;
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
		return best;
	}

	private setHover(nodeId: string | null): void {
		if (nodeId === this.hoverId && this.hoverTarget === (nodeId ? 1 : 0)) return;
		this.hoverId = nodeId;
		// Hover-out deliberately KEEPS hoverNode: the glow must fade out
		// from the last hovered node, not vanish with the id.
		if (nodeId) this.hoverNode = this.nodeById.get(nodeId) ?? null;
		// Rebase the animation from the CURRENT fade: rapid hover toggles
		// glide instead of snapping (ported from the sigma-era behavior).
		this.hoverFrom = this.hoverFade;
		this.hoverTarget = nodeId ? 1 : 0;
		this.hoverStart = performance.now();
		this.animating = true;
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		this.inTick = true;
		try {
			const now = performance.now();
			// Clamp the dt: a long idle gap must not teleport the ease forward.
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			this.lastTickAt = now;
			const hoverAnim = this.advanceHover();
			const zoomAnim = this.advanceZoom(dt);
			const simAnim = this.advanceSim();
			this.draw();
			// Keep frames coming ONLY while an animation is in motion (hover
			// fade, zoom glide, or live physics); an idle graph schedules no
			// rAF at all.
			this.animating = hoverAnim || zoomAnim || simAnim;
		} finally {
			this.inTick = false;
		}
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** One live-sim step; returns true while physics is still in motion.
	 *  Runs only while simActive (drag reheat or post-release anneal). */
	private advanceSim(): boolean {
		const sim = this.localSim ?? this.sim;
		if (!sim || !this.simActive) return false;
		sim.tick();
		// Movement check: did any node actually move (a click-pin that
		// never reheated leaves everything exactly at rest)?
		for (const n of sim.nodes()) {
			if (n.vx || n.vy) {
				this.simMoved = true;
				break;
			}
		}
		this.geoVersion++; // positions changed → geometry rebuild in draw()
		// Settled (drag released long ago, alpha annealed away)?
		if (!this.dragId && sim.alpha() < SIM_SETTLE_ALPHA) {
			this.simActive = false;
			this.endLocalSim();
			this.movingSet = null;
			this.scheduleCommit();
			return false;
		}
		return true;
	}

	/** LOCAL PHYSICS (owner, 2026-11-03): simulate only the dragged
	 *  node's 2-hop neighborhood. Its outer rim (the next ring of
	 *  neighbors) joins the sim PINNED, so the springs tie the moving
	 *  patch to the still graph instead of letting it float off. Gravity,
	 *  the centroid pull and the depth anchor are GLOBAL forces (their
	 *  targets depend on the whole graph) and are left out; springs +
	 *  repulsion + friction come from the live tuning. */
	private startLocalSim(dragId: string): void {
		const data = this.data;
		if (!data) return;
		this.endLocalSim();
		const moving = neighborhood(this.adjacency, dragId, LOCAL_SIM_HOPS);
		const members = new Set(moving);
		const pinned: LayoutNode[] = [];
		for (const id of moving) {
			for (const nb of this.adjacency.get(id) ?? []) {
				if (members.has(nb)) continue;
				members.add(nb);
				const n = this.simById.get(nb);
				if (n) {
					n.fx = n.x;
					n.fy = n.y;
					pinned.push(n);
				}
			}
		}
		const nodes: LayoutNode[] = [];
		for (const id of members) {
			const n = this.simById.get(id);
			if (n) nodes.push(n);
		}
		const edges = data.edges.filter((e) => members.has(e.from) && members.has(e.to));
		const t = this.physicsTuning;
		this.localSim = createGraphSimulation(nodes, edges, {
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
		});
		this.localSim.alpha(SIM_SETTLE_ALPHA).alphaTarget(DRAG_ALPHA_TARGET);
		this.localPinned = pinned;
		this.movingSet = moving;
		this.simActive = true;
		this.markDirty();
	}

	/** Drop the local sim and release the rim pins it placed. */
	private endLocalSim(): void {
		if (!this.localSim) return;
		this.localSim.stop();
		for (const n of this.localPinned) {
			n.fx = null;
			n.fy = null;
		}
		this.localPinned = [];
		this.localSim = null;
		// Velocities left by the local run must not leak into a later
		// full re-anneal.
		for (const n of this.simById.values()) {
			n.vx = 0;
			n.vy = 0;
		}
		// d3 re-indexed the shared node objects for the local array;
		// restore the full sim's indices (its per-node force arrays are
		// read by node.index).
		this.sim?.nodes().forEach((n, i) => {
			n.index = i;
		});
	}

	/** Debounced rest-state commit. A new drag or setData cancels it. */
	private scheduleCommit(): void {
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.commitTimer = setTimeout(() => {
			this.commitTimer = null;
			if (!this.data || !this.simMoved) return;
			this.simMoved = false;
			const positions: Record<string, Position> = {};
			for (const n of this.data.nodes) positions[n.id] = { x: n.x, y: n.y };
			this.callbacks.onCommit(positions);
		}, COMMIT_DEBOUNCE_MS);
	}

	/** Hover fade step; returns true while still moving. */
	private advanceHover(): boolean {
		if (this.hoverFade === this.hoverTarget) return false;
		const t = Math.min((performance.now() - this.hoverStart) / HOVER_FADE_MS, 1);
		this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * t;
		// Outgoing fade finished — release the glow node.
		if (this.hoverTarget === 0 && this.hoverFade === 0) this.hoverNode = null;
		return t < 1;
	}

	/** Zoom glide step: ease k toward the wheel target, keeping the world
	 *  point under the cursor pinned. Frame-rate independent (exponential
	 *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.002) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		const x = target.x - (target.x - t.x) * scale;
		const y = target.y - (target.y - t.y) * scale;
		if (done) this.zoomTarget = null;
		// Applied through d3-zoom so constraints + the zoom event (markDirty,
		// onCameraMove) fire exactly as with any other camera change.
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(x, y).scale(k),
		);
		return !done;
	}

	/** Backing-store scale: the screen's devicePixelRatio, capped at 1 in
	 *  light mode (a 4K panel at DPR 2 is 4x the pixels to fill). */
	private dpr(): number {
		return this.settings?.lightMode ? 1 : window.devicePixelRatio || 1;
	}

	/** Resize the backing store to the CSS box × devicePixelRatio; all
	 *  drawing then happens in CSS pixels through the DPR transform. */
	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = this.dpr();
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = w;
		this.viewH = h;
	}

	/** Derive ALL world geometry from data + visibility + settings.
	 *  Runs only when geoVersion moves — never per frame, never per camera
	 *  change. Zoom/pan pay zero geometry math, only rasterization. Sizes
	 *  are WORLD UNITS straight from the settings (the 2026-09-15 pivot —
	 *  no ÷kFit: the world scale is canonical, viewport-independent). */
	private buildGeometry(): void {
		this.builtVersion = this.geoVersion;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;

		const nodeR = settings.nodeSize;
		this.worldLabelFont = `${LABEL_WEIGHT} ${settings.labelSize}px ${data.fontFamily}`;
		this.world = {
			nodeR,
			glowOuter: nodeR * GLOW_SCALE,
			labelSize: settings.labelSize,
			labelGap: LABEL_GAP,
		};
		const visible = this.visible;
		const isVisible = (id: string) => !visible || visible.has(id);

		// STATIC / MOVING split (owner, 2026-11-03): while a local sim or a
		// light-mode drag runs, only `movingSet` nodes change position. The
		// static paths (everything not touching it) are built ONCE per
		// drag; each frame rebuilds just the moving nodes and the edges
		// incident to them — dozens of segments instead of thousands.
		const moving = this.movingSet;
		const rebuildStatic = this.staticFor !== moving || this.staticInputs !== this.inputsVersion || !moving;
		const isMoving = (id: string) => moving !== null && moving.has(id);
		const arrowLen = settings.arrowLength;
		const addNode = (path: Path2D, n: CanvasNode) => {
			path.moveTo(n.x + nodeR, n.y);
			path.arc(n.x, n.y, nodeR, 0, Math.PI * 2);
		};
		// Edge shafts + arrowheads (rendering arc, owner 2026-09-30): all
		// arrows are PLAIN single shafts. Lines INTO an implication node
		// are HEADLESS and run to its CENTER (co-premise lines converge to
		// a point); the line OUT of it starts at the center and its head
		// lands on the conclusion's disc edge.
		const addEdge = (shafts: Path2D, heads: Path2D, e: CanvasEdge) => {
			const a = this.nodeById.get(e.from);
			const b = this.nodeById.get(e.to);
			if (!a || !b) return;
			const intoImp = isImpNodeId(e.to);
			const outOfImp = isImpNodeId(e.from);
			const g = arrowGeometry(a, b, outOfImp ? 0 : nodeR, intoImp ? 0 : nodeR, arrowLen);
			if (!g) return;
			shafts.moveTo(g.shaftFrom.x, g.shaftFrom.y);
			if (intoImp) {
				shafts.lineTo(g.tip.x, g.tip.y);
			} else {
				shafts.lineTo(g.shaftTo.x, g.shaftTo.y);
				heads.moveTo(g.tip.x, g.tip.y);
				heads.lineTo(g.left.x, g.left.y);
				heads.lineTo(g.right.x, g.right.y);
				heads.closePath();
			}
		};

		const dynNodes = new Path2D();
		const dynShafts = new Path2D();
		const dynHeads = new Path2D();
		const nodesPath = rebuildStatic ? new Path2D() : null;
		const shafts = rebuildStatic ? new Path2D() : null;
		const heads = rebuildStatic ? new Path2D() : null;
		// Implication nodes are pure geometry — never a disc.
		if (rebuildStatic) {
			for (const n of data.nodes) {
				if (!isVisible(n.id) || isImpNodeId(n.id)) continue;
				addNode(isMoving(n.id) ? dynNodes : nodesPath!, n);
			}
			for (const e of data.edges) {
				if (!isVisible(e.from) || !isVisible(e.to)) continue;
				if (isMoving(e.from) || isMoving(e.to)) addEdge(dynShafts, dynHeads, e);
				else addEdge(shafts!, heads!, e);
			}
			this.nodesPath = nodesPath;
			this.shaftsPath = shafts!;
			this.headsPath = heads!;
			this.staticFor = moving;
			this.staticInputs = this.inputsVersion;
		} else {
			const done = new Set<string>();
			for (const id of moving!) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				// Implication nodes: no disc, but their edges still move.
				if (n && !isImpNodeId(id)) addNode(dynNodes, n);
				for (const nb of this.adjacency.get(id) ?? []) {
					if (!isVisible(nb)) continue;
					const key = id < nb ? `${id}\u0000${nb}` : `${nb}\u0000${id}`;
					if (done.has(key)) continue;
					done.add(key);
					for (const e of this.edgesOf(id, nb)) addEdge(dynShafts, dynHeads, e);
				}
			}
		}
		this.dynNodesPath = dynNodes;
		this.dynShaftsPath = dynShafts;
		this.dynHeadsPath = dynHeads;

		// Cluster regions are NOT built here: they rasterize into their own
		// low-res bitmap (see buildRegions), on their own throttle.

		// Label wrapping, CACHED (owner, 2026-11-03): measureText only when
		// the font/wrap width or a label's text changes — never because a
		// node moved. Wrap width keeps the bigger-label/bigger-wrap rule.
		const maxW = LABEL_MAX_WIDTH * (settings.labelSize / LABEL_SIZE);
		const wrapKey = `${this.worldLabelFont}|${maxW}`;
		if (wrapKey !== this.labelWrapKey) {
			this.labelWrap = new Map();
			this.labelWrapKey = wrapKey;
		}
		this.labelLines = new Map();
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = this.worldLabelFont;
		for (const n of data.nodes) {
			if (!isVisible(n.id) || isImpNodeId(n.id)) continue;
			let entry = this.labelWrap.get(n.id);
			if (!entry || entry.text !== n.label) {
				const lines = wrapLabel(ctx, n.label, maxW);
				let w = 0;
				for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
				entry = { text: n.label, lines, w };
				this.labelWrap.set(n.id, entry);
			}
			this.labelLines.set(n.id, entry.lines);
		}
		ctx.font = prevFont;
	}

	/** The stored edges between two adjacent nodes (either direction). */
	private edgesOf(a: string, b: string): CanvasEdge[] {
		const out: CanvasEdge[] = [];
		const byPair = this.edgeIndex;
		for (const e of byPair.get(`${a}\u0000${b}`) ?? []) out.push(e);
		for (const e of byPair.get(`${b}\u0000${a}`) ?? []) out.push(e);
		return out;
	}

	/** (Re)create the live sim from data.nodes at their current
	 *  positions + the current physics tuning. Called by setData and
	 *  setPhysicsTuning. */
	private buildSim(): void {
		const data = this.data;
		if (!data || data.nodes.length === 0) {
			this.sim = null;
			this.simById = new Map();
			return;
		}
		const t = this.physicsTuning;
		this.sim = createGraphSimulation(data.nodes, data.edges, {
			logicalEdges: data.logicalEdges,
			impLinks: data.impLinks,
			gravity: { x: this.simCenter.x, y: this.simCenter.y, strength: t.gravity },
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
			clusterPull:
				// The pull follows the AREA (owner, 2026-11-03) — the same
				// partition the server settle uses.
				data.areas && data.areas.length > 0
					? { clusters: data.areas, strength: t.clusterPull }
					: data.clusters.length > 0
						? { clusters: data.clusters, strength: t.clusterPull }
						: undefined,
			depthAnchor:
				t.depthMode === "off"
					? undefined
					: {
							mode: t.depthMode,
							strength: t.depthStrength,
							spacing: t.depthSpacing,
							baseRadius: t.depthBaseRadius,
							center: this.simCenter,
						},
		});
		this.simById = new Map(data.nodes.map((n) => [n.id, n as LayoutNode]));
		// Hygiene (2026-09-23 fix wave): a fresh sim starts at alpha 1 and
		// never decays while stopped — so the first post-rebuild drag would
		// re-anneal the whole graph at full strength (alphaTarget(0.3)
		// glides DOWN from 1 instead of gently up from rest). Initialize at
		// the settle floor so first-drag behavior matches steady-state
		// drags. setPhysicsTuning still rehearses its explicit alpha(1)
		// when a full re-anneal IS the point.
		this.sim.alpha(SIM_SETTLE_ALPHA);
	}

	/** A color group's hue: the area's spread hue, else the id hash. */
	private hueOf(groupId: string): number {
		return this.areaHue.get(groupId) ?? clusterHue(groupId);
	}

	/** Note + area label anchors (centroids over VISIBLE members), hues,
	 *  and wraps. Runs at rest when geometry moved — a local drag's few
	 *  moved nodes shift a centroid imperceptibly, so it is skipped
	 *  mid-motion. Cheap otherwise: a centroid pass + ~450 wraps. */
	private buildLabelMeta(): void {
		this.labelMetaVersion = this.geoVersion;
		const data = this.data;
		const settings = this.settings;
		this.regionMeta = [];
		this.areaMeta = [];
		if (!data || !settings) return;
		const visible = this.visible;
		const isVisible = (id: string): boolean => !visible || visible.has(id);
		const centroid = (members: ReadonlyArray<string>) => {
			let count = 0;
			let sx = 0;
			let sy = 0;
			for (const id of members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				count++;
				sx += n.x;
				sy += n.y;
			}
			return count > 0 ? { cx: sx / count, cy: sy / count, count } : null;
		};
		for (const cluster of data.clusters) {
			const c = centroid(cluster.members);
			if (!c) continue;
			this.regionMeta.push({
				id: cluster.id,
				label: cluster.label || null,
				cx: c.cx,
				cy: c.cy,
				hue: cluster.areaId ? this.hueOf(cluster.areaId) : clusterHue(cluster.id),
				lines: null,
				size: c.count,
			});
		}
		for (const area of data.areas ?? []) {
			const c = centroid(area.members);
			if (!c) continue;
			this.areaMeta.push({
				id: area.id,
				label: area.label,
				cx: c.cx,
				cy: c.cy,
				hue: this.hueOf(area.id),
				lines: null,
				size: c.count,
			});
		}
		// Placement priority: biggest first (ties by id — deterministic).
		const bySize = (a: RegionLabel, b: RegionLabel) => (b.size ?? 0) - (a.size ?? 0) || (a.id < b.id ? -1 : 1);
		this.regionMeta.sort(bySize);
		this.areaMeta.sort(bySize);
		// Wrap ONCE per build at the SCREEN-fixed size (viewer-relative
		// labels — this px size is what lands on screen at any zoom).
		const ctx = this.ctx;
		const prevFont = ctx.font;
		const wrapAll = (list: RegionLabel[], font: string, maxW: number, maxLines: number) => {
			ctx.font = font;
			for (const rm of list) {
				rm.lines = rm.label ? wrapRegionLabel(rm.label, maxW, maxLines, (t) => ctx.measureText(t).width) : null;
				rm.w = rm.lines ? Math.max(0, ...rm.lines.map((l) => ctx.measureText(l).width)) : 0;
			}
		};
		wrapAll(this.regionMeta, this.noteFont(settings, data), REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES);
		wrapAll(this.areaMeta, this.areaFont(settings, data, 1), REGION_LABEL_MAX_WIDTH * AREA_LABEL_SCALE, AREA_LABEL_MAX_LINES);
		ctx.font = prevFont;
	}

	private noteFont(settings: GraphRenderSettings, data: CanvasData, k = 1): string {
		return `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${data.fontFamily}`;
	}

	private areaFont(settings: GraphRenderSettings, data: CanvasData, k: number): string {
		return `${AREA_LABEL_WEIGHT} ${(settings.clusterLabelSize * AREA_LABEL_SCALE) / k}px ${data.fontFamily}`;
	}

	/** Rasterize cluster regions into the low-res world-space bitmap.
	 *  Runs on data/visibility/settings changes at rest, and every
	 *  REGION_EVERY-th frame while the live sim moves nodes (the in-between
	 *  frames blit the previous bitmap — one sim step of staleness at
	 *  120fps is invisible). Positions come straight from data.nodes. */
	private buildRegions(): void {
		const data = this.data;
		// Color groups (owner, 2026-11-03: color by AREA): one stroke
		// pass per area when the snapshot carries areas, else per cluster
		// (legacy data).
		const groups: ReadonlyArray<{ id: string; members: ReadonlyArray<string> }> =
			data?.areas && data.areas.length > 0 ? data.areas : (data?.clusters ?? []);
		if (!data || groups.length === 0 || this.settings?.lightMode) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}
		const visible = this.visible;
		const isVisible = (id: string): boolean => !visible || visible.has(id);

		const tuning = this.regionTuning;
		// Dilation is WORLD units (the 2026-09-15 pivot) — the region stroke
		// half-width comes straight from the setting, no kFit.

		// World rect over VISIBLE group members (regions cover members
		// and their intra-group edges — nothing else).
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const c of groups) {
			for (const id of c.members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				if (n.x < minX) minX = n.x;
				if (n.x > maxX) maxX = n.x;
				if (n.y < minY) minY = n.y;
				if (n.y > maxY) maxY = n.y;
			}
		}
		if (minX > maxX) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// Which group is a node in (for intra-group edges)?
		const clusterOf = new Map<string, number>();
		groups.forEach((c, i) => {
			for (const id of c.members) clusterOf.set(id, i);
		});

		// THE off switch (user 2026-09-15): compute is skipped, not just
		// paint hidden — no splat, no blur, no readback, no bitmap, no
		// blit. Everything below this return is the bitmap path.
		if (!tuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// Bitmap sizing: longest world span maps to `bitmap` px. The rect
		// is padded by the stroke half-width (dilation) plus the blur
		// reach so nothing clips at the bitmap edge.
		//
		// The blur reach is WORLD units (the 2026-09-15 pivot's last step):
		// tuning.blur IS the world reach, canonical like dilation — it no
		// longer scales with the graph's span (the old blurW = blur ×
		// span/bitmap read 6× softer on a 338-node graph than on a
		// 13-node one). This also makes the 2026-09-14 search-collapse fix
		// structural: a world-unit blur cannot be coupled to any cell, so
		// the old `cellRef` anchor is gone.
		const dilationW = tuning.dilation;
		const blurW = tuning.blur;
		const padWorld = dilationW + blurW * 2;
		// Cell floor: a single visible node (span 0) zeroed the cell and
		// blew the bitmap dims to Infinity (getImageData TypeError). The
		// floor is the padded rect's own reach, so dims stay finite (long
		// side ≤ bitmap · (1 + span/2·pad)) however tight the search.
		const spanNow = Math.max(maxX - minX, maxY - minY);
		const cell = Math.max(spanNow, padWorld * 2) / tuning.bitmap;
		minX -= padWorld;
		minY -= padWorld;
		maxX += padWorld;
		maxY += padWorld;
		const spanX = maxX - minX;
		const spanY = maxY - minY;
		const bw = Math.max(1, Math.ceil(spanX / cell));
		const bh = Math.max(1, Math.ceil(spanY / cell));
		let rc = this.regionCanvas;
		if (!rc) {
			rc = document.createElement("canvas");
			this.regionCanvas = rc;
		}
		if (rc.width !== bw || rc.height !== bh) {
			rc.width = bw;
			rc.height = bh; // also clears
		}
		// willReadFrequently: the blur step getImageData/putImageData every
		// rebuild — Chrome keeps this canvas on the CPU instead of GPU-
		// shuttling it.
		const rctx = rc.getContext("2d", { willReadFrequently: true });
		if (!rctx) return;
		rctx.clearRect(0, 0, bw, bh);
		rctx.lineCap = "round";
		rctx.lineWidth = (dilationW * 2) / cell;

		// The region IS the dilated skeleton: intra-cluster edges as
		// round-cap strokes (Minkowski dilation). NO blanket per-node discs
		// — they double-counted where nodes sit on edges (user-identified
		// hot spots, when clusters were edge-based).
		groups.forEach((cluster, ci) => {
			const hue = this.hueOf(cluster.id);
			// Full-opacity strokes: alpha is applied ONCE at the very end
			// (dilate at 1 → blur → scale by edgeAlpha). Baking per-stroke
			// alpha in here made source-over stacking ACCUMULATE it — an
			// orphan disc overlapping anything read as a darker double-
			// counted spot (user report 2026-09-14). At alpha 1 the alpha
			// channel is a pure coverage indicator: overlaps of any count
			// contribute exactly 1.0.
			rctx.strokeStyle = `hsla(${hue}, 65%, 60%, 1)`;
			rctx.beginPath();
			// Endpoints actually covered by a stroke's round caps.
			const touched = new Set<string>();
			for (const e of data.edges) {
				if (clusterOf.get(e.from) !== ci) continue;
				if (clusterOf.get(e.to) !== ci) continue;
				// Search filter: stroke only fully-visible edges. Invisible-node
				// segments still stroked into the (visible-only) bitmap cut
				// diagonal hue streaks across other clusters' regions (user-
				// reported 2026-09-14) — rect, discs, and anchors already filter.
				if (!isVisible(e.from) || !isVisible(e.to)) continue;
				const a = this.nodeById.get(e.from);
				const b = this.nodeById.get(e.to);
				if (!a || !b) continue;
				rctx.moveTo((a.x - minX) / cell, (a.y - minY) / cell);
				rctx.lineTo((b.x - minX) / cell, (b.y - minY) / cell);
				touched.add(e.from);
				touched.add(e.to);
			}
			rctx.stroke();

			// Member discs for the SEMANTIC era (DECIDED 2026-09-13): clusters
			// are now topics by meaning, and many members (orphans, isolated
			// micro-topics) share NO intra-cluster edge with anyone — edge
			// strokes alone left them completely uncolored. A disc (same
			// radius as a round cap = dilation) covers exactly the members no
			// stroke reached: every member is painted by its edges' caps OR
			// one disc, never both — the no-double-counting rule survives.
			rctx.fillStyle = `hsla(${hue}, 65%, 60%, 1)`;
			const discR = dilationW / cell;
			for (const id of cluster.members) {
				if (touched.has(id) || !isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				rctx.beginPath();
				rctx.arc((n.x - minX) / cell, (n.y - minY) / cell, discR, 0, Math.PI * 2);
				rctx.fill();
			}
		});

		// THE blur + alpha (in that order, by design — user-decided
		// 2026-09-14): 3 box-blur rounds on the premultiplied bitmap,
		// THEN scale the whole field by edgeAlpha once. Bilinear
		// upscaling alone is no blur at all (tent ramps — the JPEG look);
		// this makes the field genuinely smooth before the blit. The
		// radius is the world reach ÷ cell, rounded to an integer
		// (boxBlurRound indexes with the loop counter) with a 1px floor —
		// a graph whose cell exceeds the blur reach still gets one pixel
		// of softening rather than aliasing to zero. Radius 0 (blur off)
		// still runs this path — boxBlurRound
		// copies — so the end-alpha applies uniformly with or without
		// blur.
		{
			const blurPx = tuning.blur > 0 ? Math.max(1, Math.round(blurW / cell)) : 0;
			const img = rctx.getImageData(0, 0, bw, bh);
			const n = bw * bh * 4;
			const a = new Float32Array(n);
			for (let i = 0; i < n; i += 4) {
				const alpha = img.data[i + 3]! / 255;
				a[i] = img.data[i]! * alpha;
				a[i + 1] = img.data[i + 1]! * alpha;
				a[i + 2] = img.data[i + 2]! * alpha;
				a[i + 3] = img.data[i + 3]!;
			}
			const b = new Float32Array(n);
			const tmp = new Float32Array(n); // scratch inside each round only
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b
			boxBlurRound(b, tmp, a, bw, bh, blurPx); // b → a
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b (result)
			// Unpremultiply back into pixels; scale the alpha by edgeAlpha
			// HERE — the one, final application. Result: constant interior
			// alpha everywhere covered, tapering only across the blur edges.
			for (let i = 0; i < n; i += 4) {
				const alpha = b[i + 3]!;
				if (alpha <= 0) {
					img.data[i] = 0;
					img.data[i + 1] = 0;
					img.data[i + 2] = 0;
					img.data[i + 3] = 0;
				} else {
					// Un-premultiply: pm = c * a/255, so c = pm / a * 255.
					img.data[i] = Math.round((b[i]! / alpha) * 255);
					img.data[i + 1] = Math.round((b[i + 1]! / alpha) * 255);
					img.data[i + 2] = Math.round((b[i + 2]! / alpha) * 255);
					img.data[i + 3] = Math.round(alpha * tuning.edgeAlpha);
				}
			}
			rctx.putImageData(img, 0, 0);
		}
		this.regionRect = { minX, minY, w: spanX, h: spanY };
	}

	/** THE draw function: every layer, one frame, one camera. All drawing
	 *  happens in WORLD coordinates under the camera transform; nothing is
	 *  recomputed per frame except layer styling. */
	private draw(): void {
		this.dirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = this.dpr();
		const ctx = this.ctx;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		this.frameCount++;
		// Regions: rebuild on stale geometry at rest; while something moves,
		// at most every REGION_MIN_INTERVAL_MS (the blur is CPU work — the
		// in-between frames blit the last bitmap).
		const now = performance.now();
		const moving = this.simActive || this.lightDragged;
		if (
			this.regionBuiltVersion !== this.geoVersion &&
			(!moving || now - this.lastRegionAt >= REGION_MIN_INTERVAL_MS)
		) {
			this.buildRegions();
			this.regionBuiltVersion = this.geoVersion;
			this.lastRegionAt = now;
		}
		if (this.builtVersion !== this.geoVersion) this.buildGeometry();
		if (!this.nodesPath) return;
		// Label anchors: at rest (or never built yet).
		if (this.labelMetaVersion !== this.geoVersion && (!moving || this.labelMetaVersion < 0)) this.buildLabelMeta();

		const { x: tx, y: ty, k } = this.transform;
		// THE camera: one transform, then everything is world coordinates.
		ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

		const ratio = zoomRatioOf(this.kFit, k);
		// THE THREE BANDS (owner, 2026-11-03): areas → notes → node names.
		const bands = labelBands(ratio, settings.labelZoom, settings.noteZoom);
		const { nodeR, glowOuter } = this.world;
		// The viewport in world units (label culling).
		const view: LabelRect = { x0: -tx / k, y0: -ty / k, x1: (w - tx) / k, y1: (h - ty) / k };

		// 1. Cluster regions: one tiny world-space bitmap blit.
		if (this.regionCanvas && this.regionRect) {
			const { minX, minY, w: rw, h: rh } = this.regionRect;
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(this.regionCanvas, minX, minY, rw, rh);
		}

		// 3. Edges: static + moving paths; width constant on screen (÷ k).
		if (settings.edgeWidth > 0) {
			ctx.strokeStyle = data.colors.edge;
			ctx.fillStyle = data.colors.edge;
			ctx.lineWidth = settings.edgeWidth / k;
			ctx.lineCap = "round";
			ctx.stroke(this.shaftsPath);
			ctx.fill(this.headsPath);
			ctx.stroke(this.dynShaftsPath);
			ctx.fill(this.dynHeadsPath);
		}

		// 4. Nodes: cached Path2Ds, one fill each.
		ctx.fillStyle = data.colors.node;
		ctx.fill(this.nodesPath);
		ctx.fill(this.dynNodesPath);

		// 6. Node labels — one global gate, faded together, world-scaled.
		// Only the OVERLAP-FREE set (best-connected first, recomputed at
		// rest) and only what lies in the viewport is drawn.
		if (bands.node > 0.01) {
			if (!moving && this.placedAt !== this.geoVersion) this.placeNodeLabels();
			ctx.save();
			ctx.globalAlpha = bands.node;
			ctx.font = this.worldLabelFont;
			for (const { id, rect } of this.placedNodeLabels) {
				if (rect.x1 < view.x0 || rect.x0 > view.x1 || rect.y1 < view.y0 || rect.y0 > view.y1) continue;
				const n = this.nodeById.get(id);
				const lines = this.labelLines.get(id);
				if (!n || !lines) continue;
				drawNameLines(ctx, n.x, n.y, lines, this.world, data.colors.label);
			}
			ctx.restore();
		}

		// 7. Hover glow (topmost): halo in the node's color + the brightened
		// name, both on the SAME fade factor. Shows even when labels are
		// zoomed out (hover is its own affordance, not a label).
		if (this.hoverNode && this.hoverFade > 0.02) {
			const n = this.visible && !this.visible.has(this.hoverNode.id)
				? null // filtered out by search — no glow on hidden nodes
				: this.hoverNode;
			if (n) {
				const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, glowOuter);
				glow.addColorStop(0, rgbaFromHex(data.colors.node, GLOW_ALPHA * this.hoverFade));
				glow.addColorStop(1, rgbaFromHex(data.colors.node, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(n.x, n.y, glowOuter, 0, Math.PI * 2);
				ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
				ctx.fill("evenodd");
				ctx.save();
				ctx.globalAlpha = this.hoverFade;
				ctx.font = this.worldLabelFont;
				drawNameLines(ctx, n.x, n.y, this.labelLines.get(n.id) ?? [], this.world, data.colors.hoverText);
				ctx.restore();
			}
		}

		// 8. Region labels — THE TOPMOST layer (user 2026-09-16: never
		// occluded by content). Viewer-relative: a constant size on
		// screen at any zoom (font px ÷ k). Two bands: NOTES (middle) and
		// AREAS (far out), each placed overlap-free in SCREEN space,
		// biggest first, off-screen ones skipped.
		// Both bands share ONE overlap pass (areas first): during the
		// cross-fade an area name and a note name never pile up.
		if (settings.clusterLabels && (bands.note > 0.01 || bands.area > 0.01)) {
			const areaSize = settings.clusterLabelSize * AREA_LABEL_SCALE;
			const bandsToDraw = [
				...(bands.area > 0.01
					? [{ list: this.areaMeta, alpha: bands.area, size: areaSize, font: this.areaFont(settings, data, k), light: data.colors.darkSheet === false ? 34 : 82, a: 0.95 }]
					: []),
				...(bands.note > 0.01
					? [{ list: this.regionMeta, alpha: bands.note, size: settings.clusterLabelSize, font: this.noteFont(settings, data, k), light: data.colors.darkSheet === false ? 40 : 78, a: 0.85 }]
					: []),
			];
			this.drawRegionLabels(bandsToDraw, w, h);
		}
	}

	/** Screen-fixed region labels for one or more bands: project, cull,
	 *  place overlap-free across ALL bands (band order, then list order
	 *  = priority), draw each with its band's opacity/style. */
	private drawRegionLabels(
		bands: ReadonlyArray<{ list: ReadonlyArray<RegionLabel>; alpha: number; size: number; font: string; light: number; a: number }>,
		viewW: number,
		viewH: number,
	): void {
		const ctx = this.ctx;
		const { x: tx, y: ty, k } = this.transform;
		const items: { rm: RegionLabel; band: number }[] = [];
		const rects: LabelRect[] = [];
		bands.forEach((band, b) => {
			const lineH = band.size * REGION_LABEL_LINE_HEIGHT;
			for (const rm of band.list) {
				if (!rm.lines || rm.lines.length === 0) continue;
				const sx = rm.cx * k + tx;
				const sy = rm.cy * k + ty;
				const halfW = (rm.w ?? 0) / 2 + LABEL_PLACE_PAD;
				const halfH = (rm.lines.length * lineH) / 2 + LABEL_PLACE_PAD;
				items.push({ rm, band: b });
				rects.push({ x0: sx - halfW, y0: sy - halfH, x1: sx + halfW, y1: sy + halfH });
			}
		});
		const placed = placeLabels(rects, 96, { x0: 0, y0: 0, x1: viewW, y1: viewH });
		if (placed.length === 0) return;
		ctx.save();
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		let current = -1;
		for (const i of placed) {
			const { rm, band: b } = items[i]!;
			const band = bands[b]!;
			if (b !== current) {
				ctx.globalAlpha = band.alpha;
				ctx.font = band.font;
				current = b;
			}
			const lines = rm.lines!;
			const lineW = (band.size * REGION_LABEL_LINE_HEIGHT) / k; // constant on-screen pitch
			ctx.fillStyle = `hsla(${rm.hue}, 55%, ${band.light}%, ${band.a})`;
			const firstOffset = (-(lines.length - 1) / 2) * lineW;
			for (let l = 0; l < lines.length; l++) ctx.fillText(lines[l]!, rm.cx, rm.cy + firstOffset + l * lineW);
		}
		ctx.restore();
	}

	/** Overlap-free node labels in WORLD space (node labels scale with
	 *  the camera, so overlap is zoom-invariant and this runs only when
	 *  positions/settings change at rest). Priority: most connections
	 *  first, ties by id. */
	private placeNodeLabels(): void {
		this.placedAt = this.geoVersion;
		const world = this.world;
		const lineH = world.labelSize * LABEL_LINE_HEIGHT;
		const pad = world.labelSize * 0.25;
		const ids = [...this.labelLines.keys()];
		const degree = (id: string) => this.adjacency.get(id)?.length ?? 0;
		ids.sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1));
		const rects: LabelRect[] = [];
		const kept: string[] = [];
		for (const id of ids) {
			const n = this.nodeById.get(id);
			const wrap = this.labelWrap.get(id);
			const lines = this.labelLines.get(id);
			if (!n || !wrap || !lines || lines.length === 0) continue;
			const top = n.y + world.nodeR + world.labelGap;
			kept.push(id);
			rects.push({
				x0: n.x - wrap.w / 2 - pad,
				y0: top - pad,
				x1: n.x + wrap.w / 2 + pad,
				y1: top + lines.length * lineH + pad,
			});
		}
		const accepted = placeLabels(rects, world.labelSize * 12);
		this.placedNodeLabels = accepted.map((i) => ({ id: kept[i]!, rect: rects[i]! }));
	}
}

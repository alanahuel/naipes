/**
 * «Grafo legible y ligero» (owner-approved plan, 2026-11-03): folder
 * AREAS above birth-session clusters, the three zoom label bands,
 * overlap-free label placement, the 2-hop local-physics neighborhood,
 * area hues, cold-start group seeding, and the two new render settings.
 * All pure — the DOM-bound renderer class is verified live.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	areaOfPath,
	buildAreas,
	cleanFolderName,
	noteDisplayName,
	SESSIONS_AREA_ID,
} from "../src/core/areas.ts";
import { areaHues, labelBands, neighborhood, placeLabels } from "../components/graph-canvas.ts";
import { incrementalLayout, seedGroupDiscs } from "../src/core/layout.ts";
import { DEFAULT_RENDER_SETTINGS, LABEL_ZOOM_LADDER, sanitizeRenderSettings } from "../src/core/render-settings.ts";

describe("areas (core/areas.ts)", () => {
	it("cleans numbering and emoji off folder names", () => {
		assert.equal(cleanFolderName("011. INFORMÁTICA"), "INFORMÁTICA");
		assert.equal(cleanFolderName("014. INVERSIÓN 📈"), "INVERSIÓN");
		assert.equal(cleanFolderName("005 - VIDEOS 🎬"), "VIDEOS");
		assert.equal(cleanFolderName("🧠 ZETTELKASTEN"), "ZETTELKASTEN");
		assert.equal(cleanFolderName("🗂️ ÍNDICES"), "ÍNDICES");
		assert.equal(cleanFolderName("013. MNEMOS — Canal de YouTube"), "MNEMOS — Canal de YouTube");
		assert.equal(cleanFolderName("007"), "007", "a pure number survives rather than vanishing");
	});

	it("takes the area at the 2nd folder level", () => {
		assert.deepEqual(areaOfPath("002 - 🌍 ÁREAS/001. PSICOLOGÍA/001. CONCEPTOS/EFECTO FOCO.md"), {
			id: "area:002 - 🌍 ÁREAS/001. PSICOLOGÍA",
			label: "PSICOLOGÍA",
		});
		assert.deepEqual(areaOfPath("003 - 📋 RECURSOS/005 - VIDEOS 🎬/x.md"), {
			id: "area:003 - 📋 RECURSOS/005 - VIDEOS 🎬",
			label: "VIDEOS",
		});
		assert.equal(areaOfPath("PROYECTO/nota.md").label, "PROYECTO", "one folder → that folder");
		assert.equal(areaOfPath("suelta.md").id, "area:/", "no folder → the root area");
	});

	it("names a note by its basename without extension", () => {
		assert.equal(noteDisplayName("002 - 🌍 ÁREAS/001. PSICOLOGÍA/EFECTO FOCO.md"), "EFECTO FOCO");
		assert.equal(noteDisplayName("a/b/notas.v2.md"), "notas.v2");
		assert.equal(noteDisplayName("README"), "README");
	});

	it("groups clusters by folder area; chats share the sessions area", () => {
		const { areas, areaOfCluster } = buildAreas(
			[
				{ id: "src_a", members: ["n1", "n2"] },
				{ id: "src_b", members: ["n3"] },
				{ id: "src_c", members: ["n4"] },
				{ id: "chat_1", members: ["n5"] },
				{ id: "chat_2", members: ["n6", "n7"] },
			],
			{
				src_a: "002/011. INFORMÁTICA/x/a.md",
				src_b: "002/011. INFORMÁTICA/b.md",
				src_c: "002/001. PSICOLOGÍA/c.md",
			},
		);
		assert.deepEqual(
			areas.map((a) => [a.id, a.kind, a.label, a.members, a.clusters]),
			[
				["area:002/011. INFORMÁTICA", "folder", "INFORMÁTICA", ["n1", "n2", "n3"], ["src_a", "src_b"]],
				[SESSIONS_AREA_ID, "sessions", null, ["n5", "n6", "n7"], ["chat_1", "chat_2"]],
				["area:002/001. PSICOLOGÍA", "folder", "PSICOLOGÍA", ["n4"], ["src_c"]],
			],
		);
		assert.equal(areaOfCluster.get("chat_2"), SESSIONS_AREA_ID);
	});
});

describe("label bands", () => {
	it("areas far out, notes in the middle, node names up close — always summing to 1", () => {
		const far = labelBands(4, 0.5, 0.75);
		assert.deepEqual(far, { node: 0, note: 0, area: 1 });
		const middle = labelBands(0.7, 0.5, 0.75);
		assert.equal(middle.area, 0);
		assert.ok(middle.note > 0.5 && middle.node < 0.5);
		const close = labelBands(0.3, 0.5, 0.75);
		assert.deepEqual(close, { node: 1, note: 0, area: 0 });
		for (const r of [0.2, 0.5, 0.6, 0.75, 0.9, 1.2, 3]) {
			const b = labelBands(r, 0.5, 0.75);
			assert.ok(Math.abs(b.node + b.note + b.area - 1) < 1e-9, `sum at ratio ${r}`);
		}
	});
});

describe("placeLabels", () => {
	const r = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
	it("keeps the first of two overlapping labels (priority = input order)", () => {
		assert.deepEqual(placeLabels([r(0, 0, 10, 10), r(5, 5, 15, 15), r(20, 0, 30, 10)], 8), [0, 2]);
	});
	it("touching edges do not count as overlap", () => {
		assert.deepEqual(placeLabels([r(0, 0, 10, 10), r(10, 0, 20, 10)], 8), [0, 1]);
	});
	it("culls labels outside the view without letting them block others", () => {
		const view = r(0, 0, 100, 100);
		assert.deepEqual(placeLabels([r(-50, -50, -40, -40), r(10, 10, 20, 20)], 16, view), [1]);
	});
	it("matches a brute-force greedy pass on random rects", () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		const rects = Array.from({ length: 300 }, () => {
			const x = rand() * 500;
			const y = rand() * 500;
			return r(x, y, x + 5 + rand() * 60, y + 5 + rand() * 20);
		});
		const brute: number[] = [];
		for (let i = 0; i < rects.length; i++) {
			const a = rects[i]!;
			if (brute.every((j) => { const b = rects[j]!; return !(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0); })) brute.push(i);
		}
		assert.deepEqual(placeLabels(rects, 32), brute);
	});
});

describe("neighborhood (local physics)", () => {
	const adj = (pairs: [string, string][]) => {
		const m = new Map<string, string[]>();
		for (const [a, b] of pairs) {
			m.set(a, [...(m.get(a) ?? []), b]);
			m.set(b, [...(m.get(b) ?? []), a]);
		}
		return m;
	};
	it("collects nodes within 2 hops", () => {
		const g = adj([["a", "b"], ["b", "c"], ["c", "d"], ["x", "a"]]);
		assert.deepEqual([...neighborhood(g, "a", 2)].sort(), ["a", "b", "c", "x"]);
	});
	it("implication nodes are free steps: two arguments away, not one", () => {
		// a → arg_1 → b → arg_2 → c → d
		const g = adj([["a", "arg_1"], ["arg_1", "b"], ["b", "arg_2"], ["arg_2", "c"], ["c", "d"]]);
		assert.deepEqual([...neighborhood(g, "a", 2)].sort(), ["a", "arg_1", "arg_2", "b", "c"]);
	});
});

describe("areaHues", () => {
	it("spreads hues by sorted id, stably", () => {
		const hues = areaHues(["b", "a", "c"]);
		assert.equal(hues.get("a"), 0);
		assert.equal(hues.get("b"), 138);
		assert.equal(hues.get("c"), 275);
		assert.deepEqual(areaHues(["c", "a", "b"]), hues);
	});
});

describe("cold-start group seeding", () => {
	it("lays group discs on a spiral without overlap", () => {
		const discs = seedGroupDiscs([90, 30, 30, 10, 5, 1]);
		for (let i = 0; i < discs.length; i++) {
			for (let j = i + 1; j < discs.length; j++) {
				const a = discs[i]!;
				const b = discs[j]!;
				assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1e-6, `discs ${i}/${j} overlap`);
			}
		}
	});
	it("a fresh layout keeps groups apart (islands)", () => {
		const groups = [0, 1, 2].map((g) => ({ members: Array.from({ length: 20 }, (_, i) => `g${g}_${i}`) }));
		const nodes = groups.flatMap((g) => g.members.map((id) => ({ id })));
		const edges = groups.flatMap((g) => g.members.slice(1).map((id, i) => ({ from: g.members[i]!, to: id })));
		const pos = incrementalLayout(nodes, edges, new Map(), { clusters: groups, seedGroups: true, ticks: 300 });
		const centroid = (ids: string[]) => {
			const ps = ids.map((id) => pos.get(id)!);
			return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
		};
		const spread = (ids: string[]) => {
			const c = centroid(ids);
			return Math.max(...ids.map((id) => Math.hypot(pos.get(id)!.x - c.x, pos.get(id)!.y - c.y)));
		};
		const cs = groups.map((g) => centroid(g.members));
		const minGap = Math.min(
			Math.hypot(cs[0]!.x - cs[1]!.x, cs[0]!.y - cs[1]!.y),
			Math.hypot(cs[0]!.x - cs[2]!.x, cs[0]!.y - cs[2]!.y),
			Math.hypot(cs[1]!.x - cs[2]!.x, cs[1]!.y - cs[2]!.y),
		);
		assert.ok(minGap > Math.max(...groups.map((g) => spread(g.members))) * 0.5, "group centroids stay apart");
	});
});

describe("render settings: noteZoom + lightMode", () => {
	it("defaults: notes band above the node-label gate; light mode off", () => {
		assert.ok(DEFAULT_RENDER_SETTINGS.noteZoom > DEFAULT_RENDER_SETTINGS.labelZoom);
		assert.equal(DEFAULT_RENDER_SETTINGS.lightMode, false);
		const s = sanitizeRenderSettings({ sizeUnits: "world" });
		assert.equal(s.noteZoom, DEFAULT_RENDER_SETTINGS.noteZoom);
		assert.equal(s.lightMode, false);
	});
	it("snaps noteZoom to the label-zoom ladder and keeps a boolean lightMode", () => {
		const s = sanitizeRenderSettings({ sizeUnits: "world", noteZoom: 0.8, lightMode: true });
		assert.ok((LABEL_ZOOM_LADDER as readonly number[]).includes(s.noteZoom));
		assert.equal(s.noteZoom, 0.75);
		assert.equal(s.lightMode, true);
		assert.equal(sanitizeRenderSettings({ lightMode: "yes" }).lightMode, false);
	});
});

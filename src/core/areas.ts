/**
 * GRAPH AREAS (owner-approved 2026-11-03, plan «grafo legible y ligero»):
 * the coarse level ABOVE birth-session clusters. An imported note's area
 * is its vault folder at the SECOND level ("002 - 🌍 ÁREAS/011.
 * INFORMÁTICA/…" → "INFORMÁTICA"); every chat-born cluster shares ONE
 * area, «Sesiones». ~26 areas instead of ~420 per-note clusters: the
 * zoomed-out view labels areas, the middle band labels notes, the close
 * band labels nodes; region colors and the layout's centroid pull both
 * follow the area.
 *
 * Owner rulings (2026-11-03):
 *  - Level: the 2nd folder level (a path with only one folder uses it).
 *  - Label: CLEAN — leading numbering ("011. ", "005 - ") and emoji are
 *    stripped ("014. INVERSIÓN 📈" → "INVERSIÓN").
 *  - Chats: one shared area; its label is localized by the view (the
 *    core carries `label: null` + kind "sessions").
 *
 * Pure and browser-safe (re-exported through the core barrel): the
 * snapshot builds areas server-side, the settle reuses the same function
 * for the centroid pull, and the canvas uses noteDisplayName.
 */

/** The shared area id every chat-born (or unlabeled) cluster joins. */
export const SESSIONS_AREA_ID = "area:sessions";

/** One area: a folder (or the shared chat area) + its members. */
export interface GraphArea {
	/** "area:<raw folder key>" or SESSIONS_AREA_ID. */
	id: string;
	kind: "folder" | "sessions";
	/** Clean folder label; null for the sessions area (the view
	 *  localizes it). */
	label: string | null;
	/** Node ids (propositions + attached imp nodes), sorted. */
	members: string[];
	/** Birth-session cluster ids in this area, sorted. */
	clusters: string[];
}

// Emoji: pictographs + their modifiers/joiners/variation selectors/keycaps.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍︎️⃣]/gu;
// Leading numbering: "011. ", "005 - ", "3) ", "12 — " …
const NUMBERING_RE = /^\s*\d+\s*(?:[.)\-–—:]\s*)+/u;

/** "014. INVERSIÓN 📈" → "INVERSIÓN"; "🧠 ZETTELKASTEN" → "ZETTELKASTEN".
 *  Falls back to the emoji-free raw name when stripping would leave
 *  nothing (a folder called "007" stays "007"). */
export function cleanFolderName(name: string): string {
	const noEmoji = name.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
	const clean = noEmoji.replace(NUMBERING_RE, "").trim();
	return clean || noEmoji || name.trim();
}

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);

/** A note's display name: the file's basename without its extension. */
export function noteDisplayName(path: string): string {
	const segs = segmentsOf(path);
	const base = segs[segs.length - 1] ?? path;
	const dot = base.lastIndexOf(".");
	return (dot > 0 ? base.slice(0, dot) : base).trim() || base;
}

/** The area a note path belongs to: its folders up to the 2nd level.
 *  A file with no folder at all lands in the root area (label = the
 *  file-less root, «/»). */
export function areaOfPath(path: string): { id: string; label: string } {
	const folders = segmentsOf(path).slice(0, -1);
	const key = folders.slice(0, 2);
	if (key.length === 0) return { id: "area:/", label: "/" };
	return { id: `area:${key.join("/")}`, label: cleanFolderName(key[key.length - 1]!) };
}

/**
 * Group birth-session clusters into areas. `fileSources` maps a cluster
 * id (a notes source id) to its file path; any cluster absent from it
 * (a chat, or a deleted session) joins the sessions area. Output is
 * deterministic: areas size-desc (ties by id), members/clusters sorted.
 */
export function buildAreas(
	clusters: ReadonlyArray<{ id: string; members: ReadonlyArray<string> }>,
	fileSources: Readonly<Record<string, string>>,
): { areas: GraphArea[]; areaOfCluster: Map<string, string> } {
	const byId = new Map<string, GraphArea>();
	const areaOfCluster = new Map<string, string>();
	for (const cluster of clusters) {
		const path = fileSources[cluster.id];
		const head =
			path === undefined
				? { id: SESSIONS_AREA_ID, kind: "sessions" as const, label: null }
				: { ...areaOfPath(path), kind: "folder" as const };
		let area = byId.get(head.id);
		if (!area) {
			area = { id: head.id, kind: head.kind, label: head.label, members: [], clusters: [] };
			byId.set(head.id, area);
		}
		for (const m of cluster.members) area.members.push(m);
		area.clusters.push(cluster.id);
		areaOfCluster.set(cluster.id, head.id);
	}
	const areas = [...byId.values()];
	for (const a of areas) {
		a.members = [...new Set(a.members)].sort();
		a.clusters.sort();
	}
	areas.sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
	return { areas, areaOfCluster };
}

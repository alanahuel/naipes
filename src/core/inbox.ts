/**
 * INBOX FOLDER SUGGESTIONS (knowledge folder phase 3, owner 2026-11-05) —
 * pure, graph-only, no model call.
 *
 * A note dropped in the inbox is extracted like any note; its ideas then
 * CONNECT to folders of the knowledge folder:
 *   (a) the same idea also has provenance from a note in folder F, or
 *   (b) a reasoning chain joins the idea to an idea of a note in F.
 * Only folder notes count (`sourceFolder` maps their source ids to their
 * folder); sessions, manual imports and the note itself never do, and a
 * folder only counts when `isDestination` accepts it (read, not the inbox,
 * not the output folder).
 *
 * The rule: count DISTINCT connecting ideas per folder; the top folder is
 * suggested when it has ≥ 2 ideas AND more than half of the per-folder sum,
 * and no other folder ties it. The next folders are alternatives.
 */

export interface InboxGraphNode {
	id: string;
	provenance: ReadonlyArray<{ chatId: string }>;
}

export interface InboxGraphChain {
	premises: readonly string[];
	conclusion: string;
}

export interface FolderCount {
	folder: string;
	/** Distinct ideas of the note that connect to this folder. */
	count: number;
}

export interface FolderRanking {
	/** The suggested folder, or null ("sin sugerencia aún"). */
	suggestion: FolderCount | null;
	/** Sum of the per-folder counts (the majority's denominator). */
	total: number;
	/** The best other candidates (up to 2), for «Elegir otra…». */
	alternatives: FolderCount[];
}

/** Ideas a suggestion needs at least. */
export const SUGGEST_MIN_IDEAS = 2;
/** How many alternatives «Elegir otra…» lists first. */
export const SUGGEST_ALTERNATIVES = 2;

/** The folder of a folder-relative path ("" for a root-level file). */
export function folderOf(relPath: string): string {
	const at = relPath.lastIndexOf("/");
	return at === -1 ? "" : relPath.slice(0, at);
}

export function rankFolders(
	noteSourceId: string,
	graph: { nodes: readonly InboxGraphNode[]; chains: readonly InboxGraphChain[] },
	sourceFolder: ReadonlyMap<string, string>,
	isDestination: (folder: string) => boolean,
): FolderRanking {
	// Which folders each idea belongs to (through its folder-note sources).
	const foldersOfNode = new Map<string, Set<string>>();
	const ours: string[] = [];
	for (const node of graph.nodes) {
		const folders = new Set<string>();
		let mine = false;
		for (const point of node.provenance) {
			if (point.chatId === noteSourceId) {
				mine = true;
				continue;
			}
			const folder = sourceFolder.get(point.chatId);
			if (folder !== undefined && isDestination(folder)) folders.add(folder);
		}
		foldersOfNode.set(node.id, folders);
		if (mine) ours.push(node.id);
	}

	// Chain neighbours: every member of a chain touches every other member.
	const neighbours = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		if (a === b) return;
		let set = neighbours.get(a);
		if (!set) neighbours.set(a, (set = new Set()));
		set.add(b);
	};
	for (const chain of graph.chains) {
		const members = [...chain.premises, chain.conclusion];
		for (const a of members) for (const b of members) link(a, b);
	}

	const counts = new Map<string, number>();
	for (const id of new Set(ours)) {
		const reached = new Set(foldersOfNode.get(id) ?? []);
		for (const other of neighbours.get(id) ?? []) for (const folder of foldersOfNode.get(other) ?? []) reached.add(folder);
		for (const folder of reached) counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}

	const ranked = [...counts.entries()]
		.map(([folder, count]) => ({ folder, count }))
		.sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
	const total = ranked.reduce((sum, f) => sum + f.count, 0);
	const top = ranked[0];
	const tied = top !== undefined && ranked[1]?.count === top.count;
	const suggestion = top && !tied && top.count >= SUGGEST_MIN_IDEAS && top.count * 2 > total ? top : null;
	const alternatives = ranked.filter((f) => f !== suggestion).slice(0, SUGGEST_ALTERNATIVES);
	return { suggestion, total, alternatives };
}

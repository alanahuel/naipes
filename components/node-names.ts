/* NODE NAMES (owner round 17, 2026-10-06): targets are normalized to
 * opaque node ids at the record seam (owner round 9 — the mastery trace
 * groups on them), so cards resolve names at render time. One lazy
 * module-cached fetch of the graph view (the id → name map is a few KB);
 * failures degrade to raw ids — observability never breaks the card.
 * Shared by the practice drawer and the probe's «Repaso» line. */
let nodeNameMapPromise: Promise<Record<string, string>> | null = null;

export function nodeNameMap(): Promise<Record<string, string>> {
	nodeNameMapPromise ??= fetch("/api/graph")
		.then((r) => (r.ok ? r.json() : { nodes: [] }))
		.then((g: { nodes?: Array<{ id?: unknown; name?: unknown }> }) =>
			Object.fromEntries(
				(g.nodes ?? [])
					.filter((n) => typeof n.id === "string")
					.map((n) => [n.id as string, typeof n.name === "string" ? (n.name as string) : (n.id as string)]),
			),
		)
		.catch(() => ({}));
	return nodeNameMapPromise;
}

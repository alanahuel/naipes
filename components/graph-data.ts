/**
 * THE GRAPH DATA CACHE (perf, owner 2026-11-10): one module-level copy of
 * each graph view, shared by every component and surviving navigation —
 * Inicio used to refetch and re-parse ~7 MB on every visit, and four other
 * surfaces fetched the same snapshot for themselves.
 *
 *   - GET /api/graph        → GraphCanvasSnapshot (the canvas, the counts)
 *   - GET /api/graph/chains → GraphChainsView (the chain table's world)
 *
 * Every load revalidates with If-None-Match: an unchanged graph answers
 * 304 and the load resolves to the SAME object (no re-parse, and React
 * sees no change). Concurrent loads share one request; a load asked for
 * while one is in flight runs once more after it, so a refresh triggered
 * by a server event never settles on data fetched before the change.
 */
import type { GraphCanvasSnapshot, GraphChainsView } from "@/src/core";

interface Resource<T> {
	/** The last loaded value (null before the first load). */
	peek(): T | null;
	/** Revalidate and resolve to the current value. */
	load(): Promise<T>;
}

function resource<T>(url: string): Resource<T> {
	let data: T | null = null;
	let etag: string | null = null;
	let inflight: Promise<T> | null = null;
	let again = false;
	const fetchOnce = async (): Promise<T> => {
		const res = await fetch(url, { cache: "no-store", headers: etag && data ? { "If-None-Match": etag } : {} });
		if (res.status === 304 && data) return data;
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		const next = (await res.json()) as T;
		data = next;
		etag = res.headers.get("ETag");
		return next;
	};
	const run = (): Promise<T> =>
		fetchOnce().finally(() => {
			inflight = null;
			if (again) {
				again = false;
				inflight = run();
			}
		});
	return {
		peek: () => data,
		load: () => {
			if (inflight) {
				again = true;
				// Resolve with the follow-up run (started when this one ends).
				return inflight.then(() => inflight ?? Promise.resolve(data as T));
			}
			inflight = run();
			return inflight;
		},
	};
}

export const graphCanvas = resource<GraphCanvasSnapshot>("/api/graph");
export const graphChains = resource<GraphChainsView>("/api/graph/chains");

/**
 * SHARED, COALESCED JSON RESOURCES (perf, owner 2026-11-10).
 *
 * The exam and calendar views each owned a private fetch that re-ran on
 * every window focus and on every matching server event, with no debounce
 * and no dedupe — and a calendar tab mounts two or three of them, the exam
 * page an exam + a calendar. One settled turn in ANY chat (or alt-tabbing
 * back) fanned out into 3–5 parallel `getExamsState()` recomputes on the
 * server's single thread.
 *
 * Here one module-level entry per URL holds the data for every component
 * that reads it (and keeps it across navigation, so a revisited page draws
 * at once and revalidates). Refresh triggers — server events, focus, the
 * channel's resync — coalesce per URL into ONE trailing fetch
 * (REFRESH_DEBOUNCE_MS); a refresh asked for mid-flight runs once more
 * after it, so nobody settles on pre-change data. Explicit `reload()`
 * (after the user's own write) fetches without the debounce.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ServerEventType } from "@/src/core";
import { useNotifyHub } from "./server-events";

/** Trailing window that merges a burst of triggers into one fetch. */
const REFRESH_DEBOUNCE_MS = 250;

interface Entry {
	/** undefined = never answered; null = the first fetch failed. */
	data: unknown;
	listeners: Set<() => void>;
	inflight: boolean;
	again: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

function entryOf(url: string): Entry {
	let e = entries.get(url);
	if (!e) entries.set(url, (e = { data: undefined, listeners: new Set(), inflight: false, again: false, timer: null }));
	return e;
}

function fetchNow(url: string): void {
	const e = entryOf(url);
	if (e.inflight) {
		e.again = true;
		return;
	}
	e.inflight = true;
	fetch(url)
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
		.then((data: unknown) => {
			e.data = data;
		})
		.catch(() => {
			// A failed refresh keeps what we had; only a failed FIRST load
			// reports null (the views' "couldn't load" state).
			if (e.data === undefined) e.data = null;
		})
		.finally(() => {
			e.inflight = false;
			for (const l of [...e.listeners]) l();
			if (e.again) {
				e.again = false;
				fetchNow(url);
			}
		});
}

function scheduleRefresh(url: string): void {
	const e = entryOf(url);
	if (e.timer) clearTimeout(e.timer);
	e.timer = setTimeout(() => {
		e.timer = null;
		fetchNow(url);
	}, REFRESH_DEBOUNCE_MS);
}

/**
 * Read `url` as a shared resource. `events` = the server events that make
 * it stale (a stable list per call site). `url === null` = nothing to ask
 * yet (data stays undefined).
 */
export function useSharedFetch<T>(url: string | null, events: readonly ServerEventType[]): { data: T | null | undefined; reload: () => void } {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!url) return () => {};
			const e = entryOf(url);
			e.listeners.add(onChange);
			return () => {
				e.listeners.delete(onChange);
			};
		},
		[url],
	);
	const data = useSyncExternalStore(
		subscribe,
		() => (url ? entryOf(url).data : undefined) as T | null | undefined,
		() => undefined,
	);

	// First reader loads at once; later readers (a remount, a sibling)
	// see the shared copy and only schedule a coalesced revalidation.
	useEffect(() => {
		if (!url) return;
		if (entryOf(url).data === undefined) fetchNow(url);
		else scheduleRefresh(url);
		const onFocus = () => scheduleRefresh(url);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [url]);

	const hub = useNotifyHub();
	const eventsKey = events.join(",");
	useEffect(() => {
		if (!url || !hub) return;
		const offs = eventsKey.split(",").map((type) => hub.subscribe(type as ServerEventType, () => scheduleRefresh(url)));
		offs.push(hub.onResync(() => scheduleRefresh(url)));
		return () => {
			for (const off of offs) off();
		};
	}, [hub, url, eventsKey]);

	const reload = useCallback(() => {
		if (url) fetchNow(url);
	}, [url]);
	return { data, reload };
}

"use client";
/**
 * AVISOS (Naipes interface, stage 5 — 2026-11-03; Clonify's bell): a short
 * history of what finished while you were elsewhere, behind a bell in the
 * top bar with an unread count.
 *
 *   - your tutor finished a turn in a session you don't have open
 *     (turn-settled for another chat);
 *   - a background task ended (it left the activity feed): research, demo,
 *     visual or PDF — or it failed (read back from /api/jobs);
 *   - ideas went into your graph (an extraction run ended). Many at once
 *     (a vault sync) coalesce into one notice;
 *   - spaced review: the daily digest or the evening reminder went out
 *     (server event "review-notice"; opens Repaso);
 *   - a newer Naipes release exists (LOCAL builds only — they never update
 *     themselves; owner 2026-11-04). Once per version; opens the release
 *     page in the browser.
 *
 * Notices are stored on this device (localStorage, newest first, 50 max)
 * as message KEYS + vars, so they re-render in the current language.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BellIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useActivity, type ActivityFeed } from "@/components/activity-dock";
import { useServerEvent } from "@/components/server-events";
import { timeAgo } from "@/components/sessions";
import { useT } from "@/components/i18n";
import { useUpdateState, type UpdateState } from "@/components/settings/update-settings.tsx";
import type { JobKind, JobRecord, MessageKey, MessageVars } from "@/src/core";

// ─── the model (pure, tested) ───────────────────────────────────────────────

export interface Notice {
	id: string;
	/** ISO time it happened. */
	at: string;
	message: MessageKey;
	vars: MessageVars;
	/** Where clicking it goes (a session), when there is one. */
	href?: string;
	tone: "ok" | "warn";
	read: boolean;
}

export const NOTICES_KEY = "np:notices";
export const MAX_NOTICES = 50;
/** Extractions ending within this window coalesce into one notice. */
export const EXTRACTION_COALESCE_MS = 4000;

/** Newest first, capped. Pure. */
export function addNotices(list: readonly Notice[], incoming: readonly Notice[]): Notice[] {
	return [...incoming, ...list].slice(0, MAX_NOTICES);
}

/** The last release version announced in the bell (this device). */
export const UPDATE_ANNOUNCED_KEY = "np:update-announced";

/** The bell notice for a newer release seen by a local build — null unless
 *  the state is "available" with a version + https url not yet announced. Pure. */
export function updateNotice(state: UpdateState | null, announced: string | null, now = new Date()): Notice | null {
	if (state?.status !== "available" || !state.version || !state.url?.startsWith("https://")) return null;
	if (state.version === announced) return null;
	return {
		id: `update:${state.version}`,
		at: now.toISOString(),
		message: "notices.updateAvailable",
		vars: { version: state.version },
		href: state.url,
		tone: "ok",
		read: false,
	};
}

/** The bell notice for a review notice the server sent. Pure. */
export function reviewNotice(event: { kind: "digest" | "evening"; count: number }, now = new Date()): Notice {
	return {
		id: `review:${event.kind}:${now.toISOString().slice(0, 10)}`,
		at: now.toISOString(),
		message: event.kind === "digest" ? "notices.reviewDigest" : "notices.reviewEvening",
		vars: { n: event.count },
		href: "/review",
		tone: "ok",
		read: false,
	};
}

/** External notices (https) open in the browser; the rest are app routes. */
export function isExternalHref(href: string): boolean {
	return href.startsWith("https://");
}

export function unreadCount(list: readonly Notice[]): number {
	return list.filter((n) => !n.read).length;
}

/** What left the feed between two snapshots: ended jobs (by id) and ended
 *  extraction SOURCES (chunk rows of one source end together). Pure. */
export function endedSince(prev: ActivityFeed, next: ActivityFeed): {
	jobs: Array<{ id: string; chatId: string; kind: JobKind; title: string }>;
	extractions: Array<{ source: string; title: string }>;
} {
	const nextJobs = new Set(next.jobs.map((j) => j.id));
	const jobs = prev.jobs.filter((j) => !nextJobs.has(j.id)).map((j) => ({ id: j.id, chatId: j.chatId, kind: j.kind, title: j.title }));
	const nextSources = new Set(next.extractions.map((e) => e.chatId));
	const seen = new Set<string>();
	const extractions: Array<{ source: string; title: string }> = [];
	for (const e of prev.extractions) {
		if (nextSources.has(e.chatId) || seen.has(e.chatId)) continue;
		seen.add(e.chatId);
		extractions.push({ source: e.chatId, title: e.title });
	}
	return { jobs, extractions };
}

/** One notice for a finished job (its stored record decides ok/failed). */
export function jobNotice(job: { id: string; chatId: string; kind: JobKind; title: string }, record: Pick<JobRecord, "status"> | undefined, now = new Date()): Notice {
	const failed = record?.status === "error";
	return {
		id: `job:${job.id}`,
		at: now.toISOString(),
		message: failed ? "notices.jobFailed" : (`notices.job.${job.kind}` as MessageKey),
		vars: { title: job.title },
		href: `/chat/${job.chatId}`,
		tone: failed ? "warn" : "ok",
		read: false,
	};
}

/** One notice for a batch of ended extractions (one title, or a count). */
export function extractionNotice(batch: ReadonlyArray<{ source: string; title: string }>, now = new Date()): Notice {
	const one = batch.length === 1 ? batch[0]! : null;
	return {
		id: `extraction:${now.getTime()}:${batch.map((b) => b.source).join(",").slice(0, 80)}`,
		at: now.toISOString(),
		message: one ? "notices.extractedOne" : "notices.extractedMany",
		vars: one ? { title: one.title } : { n: batch.length },
		href: one && one.source.startsWith("chat_") ? `/chat/${one.source}` : "/knowledge",
		tone: "ok",
		read: false,
	};
}

function loadNotices(): Notice[] {
	try {
		const raw = localStorage.getItem(NOTICES_KEY);
		const parsed = raw ? (JSON.parse(raw) as Notice[]) : [];
		return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTICES) : [];
	} catch {
		return [];
	}
}

// ─── the provider ───────────────────────────────────────────────────────────

const NoticesContext = createContext<{ notices: Notice[]; markAllRead: () => void; markRead: (id: string) => void }>({
	notices: [],
	markAllRead: () => {},
	markRead: () => {},
});

export function useNotices() {
	return useContext(NoticesContext);
}

export function NoticesProvider({ children }: { children: React.ReactNode }) {
	const [notices, setNotices] = useState<Notice[]>([]);
	// Read once after mount (SSR has no storage); write only once the read
	// list is in state — a ref here let StrictMode's double effect run write
	// the empty initial list over the stored one before it was read.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => {
		setNotices(loadNotices());
		setHydrated(true);
	}, []);
	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(NOTICES_KEY, JSON.stringify(notices));
		} catch {
			// Storage blocked: notices live for this window only.
		}
	}, [notices, hydrated]);
	const push = useCallback((incoming: Notice[]) => {
		if (incoming.length > 0) setNotices((list) => addNotices(list, incoming));
	}, []);

	// Your tutor finished a turn in a session you don't have open.
	const pathname = usePathname();
	const pathRef = useRef(pathname);
	pathRef.current = pathname;
	useServerEvent("turn-settled", ({ chatId }) => {
		if (!chatId || pathRef.current === `/chat/${chatId}`) return;
		void fetch(`/api/chats/${chatId}`)
			.then((r) => (r.ok ? (r.json() as Promise<{ title?: string }>) : null))
			.then((chat) => {
				if (!chat?.title) return;
				push([
					{
						id: `turn:${chatId}:${Date.now()}`,
						at: new Date().toISOString(),
						message: "notices.turnDone",
						vars: { title: chat.title },
						href: `/chat/${chatId}`,
						tone: "ok",
						read: false,
					},
				]);
			})
			.catch(() => {});
	});

	// Background tasks and extractions that left the activity feed.
	const { feed } = useActivity();
	const prevFeed = useRef<ActivityFeed | null>(null);
	const pendingExtractions = useRef<Array<{ source: string; title: string }>>([]);
	const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		const prev = prevFeed.current;
		prevFeed.current = feed;
		if (!prev) return;
		const ended = endedSince(prev, feed);
		for (const job of ended.jobs) {
			void fetch(`/api/jobs?chatId=${encodeURIComponent(job.chatId)}`)
				.then((r) => (r.ok ? (r.json() as Promise<{ jobs?: JobRecord[] }>) : null))
				.then((body) => push([jobNotice(job, body?.jobs?.find((j) => j.id === job.id))]))
				.catch(() => push([jobNotice(job, undefined)]));
		}
		if (ended.extractions.length > 0) {
			pendingExtractions.current.push(...ended.extractions);
			if (flushTimer.current) clearTimeout(flushTimer.current);
			flushTimer.current = setTimeout(() => {
				const batch = pendingExtractions.current;
				pendingExtractions.current = [];
				if (batch.length > 0) push([extractionNotice(batch)]);
			}, EXTRACTION_COALESCE_MS);
		}
	}, [feed, push]);
	useEffect(() => () => {
		if (flushTimer.current) clearTimeout(flushTimer.current);
	}, []);

	// Spaced review: the digest / evening reminder went out.
	useServerEvent("review-notice", (event) => {
		push([reviewNotice({ kind: event.kind, count: event.count })]);
	});

	// A newer release, seen by a local build (once per version).
	const { state: updateState } = useUpdateState();
	useEffect(() => {
		if (!hydrated) return;
		let announced: string | null = null;
		try {
			announced = localStorage.getItem(UPDATE_ANNOUNCED_KEY);
		} catch {
			// Storage blocked: may repeat once per window — harmless.
		}
		const notice = updateNotice(updateState, announced);
		if (!notice) return;
		push([notice]);
		try {
			localStorage.setItem(UPDATE_ANNOUNCED_KEY, notice.vars.version as string);
		} catch {
			// see above
		}
	}, [updateState, hydrated, push]);

	const markAllRead = useCallback(() => setNotices((list) => list.map((n) => (n.read ? n : { ...n, read: true }))), []);
	const markRead = useCallback((id: string) => setNotices((list) => list.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n))), []);
	const value = useMemo(() => ({ notices, markAllRead, markRead }), [notices, markAllRead, markRead]);
	return <NoticesContext.Provider value={value}>{children}</NoticesContext.Provider>;
}

// ─── the bell ───────────────────────────────────────────────────────────────

export function NoticesBell() {
	const t = useT();
	const router = useRouter();
	const { notices, markAllRead, markRead } = useNotices();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const unread = unreadCount(notices);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				data-testid="notices-bell"
				aria-label={unread > 0 ? t("notices.open", { n: unread }) : t("notices.openNone")}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<BellIcon className="size-5" />
				{unread > 0 && (
					<span
						data-testid="notices-unread"
						className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
					>
						{unread > 9 ? "9+" : unread}
					</span>
				)}
			</button>
			{open && (
				<div role="dialog" aria-label={t("notices.title")} data-testid="notices-panel" className="absolute right-0 top-11 z-50 w-80 rounded-[14px] border bg-popover p-1.5 shadow-float">
					<div className="flex items-center justify-between px-3 py-2">
						<span className="text-sm font-semibold">{t("notices.title")}</span>
						{unread > 0 && (
							<button type="button" data-testid="notices-mark-read" onClick={markAllRead} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
								{t("notices.markRead")}
							</button>
						)}
					</div>
					{notices.length === 0 ? (
						<p className="px-3 pb-3 pt-1 text-sm text-muted-foreground" data-testid="notices-empty">
							{t("notices.empty")}
						</p>
					) : (
						<ul className="max-h-96 overflow-y-auto">
							{notices.map((n) => (
								<li key={n.id}>
									<button
										type="button"
										data-testid="notice"
										onClick={() => {
											markRead(n.id);
											setOpen(false);
											if (n.href && isExternalHref(n.href)) window.open(n.href, "_blank", "noopener,noreferrer");
											else if (n.href) router.push(n.href);
										}}
										className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
									>
										<span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : n.tone === "warn" ? "bg-warn" : "bg-primary")} aria-hidden />
										<span className="min-w-0 flex-1">
											<span className={cn("block text-sm", n.tone === "warn" && "text-warn")}>{t(n.message, n.vars)}</span>
											<span className="block text-xs text-muted-foreground">{timeAgo(n.at, new Date(), t)}</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

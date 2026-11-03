"use client";
/**
 * SESSIONS (Naipes interface, stage 3 — 2026-11-03): the session list left
 * the sidebar for its own tab, «Mis sesiones», and the same live list
 * feeds «Seguir con» on Inicio. Everything the sidebar knew carries over:
 * push-driven freshness (chats-changed / turn-started / turn-settled /
 * compaction-changed, 250ms debounce, immediate resync), the same-tab
 * instants (np:turn-state, np:chat-renamed), fuzzy search that owns the
 * keyboard walk (↑/↓, Enter opens the walked or first match), the
 * teach/practice/all filter, and the right-click menu (rename, export,
 * summarize to Obsidian, delete, extraction coverage).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DumbbellIcon, PlusIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Hint } from "@/components/ui/hint";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { translator, useT, type Translate } from "@/components/i18n";
import { fuzzyScore, getStoredItem, type ChatDeleteMode, type ChatListItem, type MessageKey } from "@/src/core";

const english = translator("en");

// ─── pure helpers ─────────────────────────────────────────────────────────────

/** Compact "how long ago" ("ahora mismo", "hace 5 min", "hace 3 horas",
 *  "hace 2 días"), then an ISO date beyond a week (unambiguous in any
 *  locale, and it sorts). English by default (tests); callers pass `t`. */
export function timeAgo(iso: string, now = new Date(), t: Translate = english): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return t("time.justNow");
	const min = Math.floor(ms / 60_000);
	if (min < 60) return t("time.minutesAgo", { n: min });
	const h = Math.floor(min / 60);
	if (h < 24) return t("time.hoursAgo", { n: h });
	const d = Math.floor(h / 24);
	if (d < 7) return t("time.daysAgo", { n: d });
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: how long ago (the state is its own label). */
export function sessionMeta(chat: ChatListItem, t: Translate = english, now = new Date()): string {
	return timeAgo(chat.updatedAt, now, t);
}

/** A session's state as a named, toned label (Clonify's etiquetas: a fixed
 *  tone per state). null = at rest (no label — the absence is the state).
 *  Priority: compacting > working > your turn > problem waiting. Pure. */
export type SessionStateTone = "neutral" | "attention";
export function sessionState(chat: ChatListItem): { label: MessageKey; tone: SessionStateTone } | null {
	if (chat.compacting) return { label: "sessions.state.compacting", tone: "neutral" };
	if (chat.busy) return { label: "sessions.state.working", tone: "neutral" };
	if (chat.pendingQuestion) return { label: "sessions.state.yourTurn", tone: "attention" };
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) return { label: "sessions.state.problemWaiting", tone: "attention" };
	return null;
}

/** Activas / Archivadas. */
export type SessionStatusFilter = "active" | "archived";

/** Teach / practice / all — persisted client-side. */
export type SessionKindFilter = "teach" | "all" | "practice";
const KIND_FILTER_KEY = "np:session-kind-filter";

/** Fuzzy filter + kind filter over the live list (prefix > word-boundary >
 *  scattered; empty query keeps the natural order). Pure — tested. */
export function filterSessions(
	chats: readonly ChatListItem[],
	query: string,
	kind: SessionKindFilter,
	status: SessionStatusFilter = "active",
): ChatListItem[] {
	let list = chats.filter((c) => (status === "archived") === (c.archivedAt !== undefined));
	if (kind !== "all") list = list.filter((c) => (c.kind ?? "teach") === kind);
	const q = query.trim();
	if (!q) return list;
	list = list
		.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
		.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.c);
	return list;
}

// ─── the live list ───────────────────────────────────────────────────────────

/** The session list, kept fresh by server push (no polling). */
export function useChatList() {
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const inFlight = useRef(false);
	const refresh = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const body = (await res.json()) as { chats: ChatListItem[] };
			setChats(body.chats);
		} catch {
			setChats((prev) => prev ?? []); // a transient failure keeps the last snapshot
		} finally {
			inFlight.current = false;
		}
	}, []);

	// Same-tab instants: the header rename and the open session's turn flips.
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh();
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh();
		};
		window.addEventListener("np:chat-renamed", onRenamed);
		window.addEventListener("np:turn-state", onTurnState);
		return () => {
			window.removeEventListener("np:chat-renamed", onRenamed);
			window.removeEventListener("np:turn-state", onTurnState);
		};
	}, [refresh]);

	// Push: list-shape writes and every chat's turn lifecycle, debounced.
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", schedule);
	useServerEvent("turn-started", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("compaction-changed", schedule);
	useServerResync(() => void refreshRef.current());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);

	return { chats, setChats, refresh };
}

// ─── rows ───────────────────────────────────────────────────────────────────

/** A state label: 24px, small radius, soft fill + strong text of one tone. */
export function StateLabel({ label, tone }: { label: string; tone: SessionStateTone }) {
	return (
		<span
			data-testid="session-state"
			data-tone={tone}
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-sm px-2 text-[13px] font-medium",
				tone === "attention" ? "bg-attention-soft text-attention" : "bg-muted text-muted-foreground",
			)}
		>
			{label}
		</span>
	);
}

/** The archive circle (Clonify's: a checkbox-like ring, no menu). Empty
 *  ring = active (click archives); filled = archived (click restores). */
function ArchiveCircle({ archived, title, onToggle }: { archived: boolean; title: string; onToggle: () => void }) {
	const t = useT();
	return (
		<button
			type="button"
			data-testid="session-archive"
			aria-pressed={archived}
			aria-label={archived ? t("sessions.restore", { title }) : t("sessions.archive", { title })}
			onClick={onToggle}
			className="group/circle flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent"
		>
			<span
				className={cn(
					"flex size-[18px] items-center justify-center rounded-full border-[1.5px] transition-colors",
					archived ? "border-muted-foreground bg-muted-foreground" : "border-input group-hover/circle:border-muted-foreground",
				)}
			>
				<svg viewBox="0 0 12 12" className={cn("size-2.5", archived ? "text-background" : "text-transparent group-hover/circle:text-muted-foreground")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
					<path d="M2.5 6.2 5 8.5l4.5-5" />
				</svg>
			</span>
		</button>
	);
}

/** One session row: the archive circle (when managed), title + how long
 *  ago, the state label, the practice mark. The open button carries
 *  data-session-open (the keyboard walk targets it). */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
	onArchiveToggle,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	kbdSelected?: boolean;
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** Shows the archive circle (Mis sesiones); absent on «Seguir con». */
	onArchiveToggle?: () => void;
}) {
	const t = useT();
	const state = sessionState(chat);
	return (
		<div
			className={cn(
				"relative flex min-h-[72px] w-full items-center gap-2 border-t pr-4 transition-colors first:border-t-0 hover:bg-accent",
				onArchiveToggle ? "pl-2" : "pl-4",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			{onArchiveToggle && <ArchiveCircle archived={chat.archivedAt !== undefined} title={chat.title} onToggle={onArchiveToggle} />}
			<button
				type="button"
				onClick={onOpen}
				onContextMenu={onContextMenu}
				data-session-open
				data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
				className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-3 text-left"
			>
				{(chat.busy || chat.compacting) && <BrailleSpinner />}
				<span className="min-w-0 flex-1">
					<span className="block truncate font-prose text-(length:--np-prose-size)">{chat.title}</span>
					<span className="block text-sm text-muted-foreground">{sessionMeta(chat, t)}</span>
				</span>
				{state && <StateLabel label={t(state.label)} tone={state.tone} />}
				{(chat.kind ?? "teach") === "practice" && (
					<DumbbellIcon className="size-4 shrink-0 text-muted-foreground/70" aria-label={t("sessions.practiceSession")} />
				)}
			</button>
		</div>
	);
}

/** The inline-rename row: same geometry, the title becomes an input
 *  (select-all on entry; Enter/blur commits; Esc discards). */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const t = useT();
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	return (
		<div data-testid="session-rename-row" className="relative flex min-h-[72px] w-full items-center border-t bg-accent px-4 py-3 first:border-t-0">
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation();
							onCancel();
						}
					}}
					aria-label={t("sessions.renameLabel")}
					data-testid="session-rename-input"
					className="np-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				<span className="block truncate text-sm text-muted-foreground">{sessionMeta(chat, t)}</span>
			</span>
		</div>
	);
}

// ─── the page ───────────────────────────────────────────────────────────────

/** «Mis sesiones». */
export function SessionsPage() {
	const t = useT();
	const router = useRouter();
	const pathname = usePathname();
	const { chats, setChats } = useChatList();
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<SessionKindFilter>("all");
	useEffect(() => {
		const stored = getStoredItem(window.localStorage, KIND_FILTER_KEY);
		if (stored === "teach" || stored === "all" || stored === "practice") setKindFilter(stored);
	}, []);
	const setFilter = useCallback((f: SessionKindFilter) => {
		setKindFilter(f);
		window.localStorage.setItem(KIND_FILTER_KEY, f);
	}, []);
	const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("active");
	const shown = useMemo(() => (chats ? filterSessions(chats, query, kindFilter, statusFilter) : null), [chats, query, kindFilter, statusFilter]);
	const hasArchived = useMemo(() => chats?.some((c) => c.archivedAt !== undefined) ?? false, [chats]);

	// Archive / restore: optimistic patch, PUT, a short notice with Undo.
	const [notice, setNotice] = useState<{ text: string; undo?: () => void; error?: boolean } | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const showNotice = useCallback((next: { text: string; undo?: () => void; error?: boolean }) => {
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		setNotice(next);
		noticeTimer.current = setTimeout(() => setNotice(null), 5000);
	}, []);
	useEffect(() => () => {
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
	}, []);
	const setArchived = useCallback(
		async (chat: ChatListItem, archived: boolean, withUndo = true) => {
			const patch = (value: boolean) =>
				setChats((prev) =>
					prev
						? prev.map((c) => {
								if (c.id !== chat.id) return c;
								const { archivedAt: _drop, ...rest } = c;
								return value ? { ...rest, archivedAt: new Date().toISOString() } : rest;
							})
						: prev,
				);
			patch(archived);
			try {
				const res = await fetch(`/api/chats/${chat.id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ archived }),
				});
				if (!res.ok) throw new Error(String(res.status));
				showNotice({
					text: archived ? t("sessions.archivedNotice") : t("sessions.restoredNotice"),
					undo: withUndo ? () => void setArchived(chat, !archived, false) : undefined,
				});
			} catch {
				patch(!archived);
				showNotice({ text: t("sessions.archiveFailed"), error: true });
			}
		},
		[setChats, showNotice, t],
	);

	// The search owns the keyboard walk (⌘⇧F lands here and focuses it).
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const focus = () => requestAnimationFrame(() => searchRef.current?.focus());
		if (window.location.search.includes("search=1")) focus();
		window.addEventListener("np:kbd-sessions-search", focus);
		return () => window.removeEventListener("np:kbd-sessions-search", focus);
	}, []);
	useEffect(() => {
		if (kbdIndex === null) return;
		listRef.current?.querySelectorAll("[data-session-open]")[kbdIndex]?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex]);

	// Context menu, inline rename, delete, summarize-to-vault.
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);
	const [vaultNotice, setVaultNotice] = useState<{ text: string; error?: boolean } | null>(null);
	const summarizeToVault = useCallback(
		async (chatId: string) => {
			setVaultNotice({ text: t("sessions.summarizing") });
			try {
				const res = await fetch(`/api/chats/${chatId}/vault-summary`, { method: "POST" });
				const body = (await res.json().catch(() => ({}))) as { file?: string; error?: string };
				setVaultNotice(
					res.ok
						? { text: t("sessions.summarySaved", { file: body.file?.split("/").pop() ?? "Obsidian" }) }
						: { text: body.error ?? t("sessions.summaryFailed", { status: res.status }), error: true },
				);
			} catch (err) {
				setVaultNotice({ text: err instanceof Error ? err.message : String(err), error: true });
			}
			setTimeout(() => setVaultNotice(null), 8000);
		},
		[t],
	);
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-np-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxChatId(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxChatId]);
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const title = next.trim();
		if (title === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("np:chat-renamed", { detail: { id, title } }));
		} catch (err) {
			console.error("rename failed:", err);
		}
	}, []);
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			window.dispatchEvent(new CustomEvent("np:graph-revision", { detail: { revision: graphRevision } }));
		},
		[setChats],
	);
	const menuItem = "flex min-h-9 items-center rounded-lg px-3 text-left text-sm text-foreground transition-colors hover:bg-accent";

	return (
		<div className="h-full overflow-y-auto" data-testid="sessions-page">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 pb-16 pt-10">
				<div className="flex items-center gap-3">
					<h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("sessions.title")}</h1>
					<Link
						href="/chat/new?mode=practice"
						data-testid="new-session-practice"
						className="flex h-10 items-center gap-2 rounded-lg border px-4 text-sm transition-colors hover:bg-accent"
					>
						<DumbbellIcon className="size-4" />
						{t("sessions.filter.practice")}
					</Link>
					<Link
						href="/chat/new"
						data-testid="new-session"
						className="flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
					>
						<PlusIcon className="size-4" />
						{t("sessions.new")}
					</Link>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-1 rounded-full border p-1" data-testid="session-status-filter">
						{(["active", "archived"] as const).map((f) => (
							<button
								key={f}
								type="button"
								data-testid={`status-filter-${f}`}
								aria-pressed={statusFilter === f}
								onClick={() => {
									setStatusFilter(f);
									setKbdIndex(null);
								}}
								className={cn(
									"h-8 rounded-full px-3 text-sm transition-colors",
									statusFilter === f ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{t(`sessions.status.${f}`)}
							</button>
						))}
					</div>
					<div className="flex items-center gap-1 rounded-full border p-1" data-testid="session-kind-filter">
						{(["all", "teach", "practice"] as const).map((f) => (
							<button
								key={f}
								type="button"
								data-testid={`kind-filter-${f}`}
								aria-pressed={kindFilter === f}
								onClick={() => setFilter(f)}
								className={cn(
									"h-8 rounded-full px-3 text-sm transition-colors",
									kindFilter === f ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{t(`sessions.filter.${f}`)}
							</button>
						))}
					</div>
					<Hint label={t("sessions.search")} action="sessions-search" side="bottom">
						<span className="relative ml-auto min-w-56 flex-1 sm:max-w-72">
							<input
								ref={searchRef}
								data-testid="session-search"
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setKbdIndex(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.stopPropagation();
										e.currentTarget.blur();
										return;
									}
									if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
									const n = shown?.length ?? 0;
									if (n === 0) return;
									if (e.key === "ArrowDown" || e.key === "ArrowUp") {
										e.preventDefault();
										const dir = e.key === "ArrowDown" ? 1 : -1;
										setKbdIndex((i) => (i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n));
										return;
									}
									if (e.key === "Enter") {
										const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
										if (!target) return;
										e.preventDefault();
										router.push(`/chat/${target.id}`);
									}
								}}
								placeholder={t("sessions.search")}
								aria-label={t("sessions.search")}
								className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
							/>
							<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						</span>
					</Hint>
				</div>

				<div ref={listRef} className="overflow-hidden rounded-xl border">
					{shown === null ? (
						<p className="px-4 py-6 text-sm text-muted-foreground">{t("common.loading")}</p>
					) : shown.length === 0 ? (
						<p className="px-4 py-6 text-sm text-muted-foreground" data-testid="sessions-empty">
							{query.trim()
								? t("sessions.noMatch")
								: statusFilter === "archived"
									? t("sessions.archivedEmpty")
									: hasArchived
										? t("sessions.allArchived")
										: t("sessions.empty")}
						</p>
					) : (
						shown.map((c, i) =>
							renamingId === c.id ? (
								<RenameRow key={c.id} chat={c} onCommit={(next) => void commitRename(c.id, next)} onCancel={() => setRenamingId(null)} />
							) : (
								<SessionRow
									key={c.id}
									chat={c}
									active={pathname === `/chat/${c.id}`}
									kbdSelected={i === kbdIndex}
									onOpen={() => router.push(`/chat/${c.id}`)}
									onArchiveToggle={() => void setArchived(c, c.archivedAt === undefined)}
									onContextMenu={(e) => {
										e.preventDefault();
										ctxAnchorRef.current = e.currentTarget;
										setCtxChatId(c.id);
									}}
								/>
							),
						)
					)}
				</div>

				{notice && (
					<div
						role="status"
						data-testid="sessions-notice"
						className={cn(
							"fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover px-4 py-2.5 text-sm shadow-float",
							notice.error && "border-warn/40 text-warn",
						)}
					>
						<span>{notice.text}</span>
						{notice.undo && (
							<button
								type="button"
								data-testid="sessions-undo"
								onClick={() => {
									const undo = notice.undo;
									setNotice(null);
									undo?.();
								}}
								className="font-medium text-primary hover:underline"
							>
								{t("sessions.undo")}
							</button>
						)}
					</div>
				)}
				{vaultNotice && (
					<p
						role="status"
						data-testid="vault-notice"
						className={cn("rounded-lg border px-3 py-2 text-sm", vaultNotice.error ? "border-warn/40 text-warn" : "text-muted-foreground")}
					>
						{vaultNotice.text}
					</p>
				)}
			</div>

			{ctxChatId !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="session-context-menu"
					preferredSide="down"
					menuClass="flex w-60 flex-col gap-0.5 rounded-[14px] border bg-popover p-1.5 shadow-float"
				>
					<button
						type="button"
						data-testid="ctx-rename"
						onClick={() => {
							setRenamingId(ctxChatId);
							setCtxChatId(null);
						}}
						className={menuItem}
					>
						{t("sessions.rename")}
					</button>
					<button
						type="button"
						data-testid="ctx-export-md"
						onClick={() => {
							const chatId = ctxChatId;
							setCtxChatId(null);
							const a = document.createElement("a");
							a.href = `/api/chats/${chatId}/markdown`;
							a.download = "";
							document.body.appendChild(a);
							a.click();
							a.remove();
						}}
						className={menuItem}
					>
						{t("sessions.exportMarkdown")}
					</button>
					<button
						type="button"
						data-testid="ctx-vault-summary"
						onClick={() => {
							const chatId = ctxChatId;
							setCtxChatId(null);
							void summarizeToVault(chatId);
						}}
						className={menuItem}
					>
						{t("sessions.summarize")}
					</button>
					<button
						type="button"
						data-testid="ctx-delete"
						onClick={() => {
							const target = chats?.find((c) => c.id === ctxChatId);
							if (target) setDeleting(target);
							setCtxChatId(null);
						}}
						className={cn(menuItem, "text-destructive")}
					>
						{t("common.delete")}
					</button>
					<div className="my-0.5 border-t" aria-hidden="true" />
					<CoverageMenuBlock chatId={ctxChatId} />
				</MenuShell>
			)}
			<DeleteSessionDialog chat={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} />
		</div>
	);
}

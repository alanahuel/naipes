"use client";
/**
 * THE APP SHELL (Naipes interface, stage 3 — 2026-11-03; inspired by
 * Clonify Studio): a FRAME (--frame) with a top bar — brand, three tabs
 * (Inicio · Mis sesiones · Conocimiento), the profile menu — and ONE SHEET
 * (--background, rounded, hairline border) holding the page. No sidebar:
 * sessions live in their own tab, settings are pages opened from the
 * profile menu.
 *
 * The top bar is the window's drag band in Electron (.np-drag; native
 * interactive children carve out automatically — app/globals.css). It
 * keeps the macOS traffic-light gutter (.np-lights-gutter) and the
 * Windows/Linux controls-overlay gutter (.np-wco-gutter).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleUserRoundIcon, FolderOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NpMark } from "@/components/np-mark";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { NoticesBell, NoticesProvider } from "@/components/notices";
import { SettingsDialogProvider } from "@/components/settings/settings-dialog.tsx";
import { APP_VERSION } from "@/components/settings/update-settings.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useT } from "@/components/i18n";
import type { MessageKey } from "@/src/core";
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";
import type { UpdateState } from "@/components/settings/update-settings.tsx";

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		np?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			/** External Next desktop-dev uses the server's web connections. */
			subscriptionTransport?: "desktop" | "web";
			openSubscriptionBrowser?: (action: string) => Promise<void>;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			expandWindow: () => void;
			/** The zoom truth (owner round 7): subscribes to "np:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			/** Native folder picker (Settings → Knowledge folder); null = cancelled. */
			pickFolder?: (defaultPath?: string) => Promise<string | null>;
			/** Opens a knowledge-folder file (folder-relative) with the system
			 *  viewer; false when it is not a file inside the folder. */
			openSource?: (relPath: string) => Promise<boolean>;
			/** Opens the app's data folder in the system file manager. */
			openDataFolder?: () => void;
			/** Repaints the native window chrome for the effective theme. */
			setTheme?: (theme: "light" | "dark") => void;
			/** Observational update events and a snapshot for late subscribers. */
			onUpdateStatus?: (cb: (status: UpdateState) => void) => () => void;
			getUpdateState?: () => Promise<UpdateState>;
			/** Explicit manual check also downloads and stages available updates. */
			checkForUpdates?: () => Promise<void>;
			installUpdate?: () => void;
			onOpenSettings?: (cb: (section: string) => void) => () => void;
			/** The shell asks to show a page (review notification, tray). */
			onNavigate?: (cb: (pathname: string) => void) => () => void;
		};
	}
}

/** Root-lifetime desktop wiring (formerly the sidebar provider's): the
 *  Electron class + platform for the chrome CSS, the zoom variable the
 *  traffic-light gutter divides by, and the ChatGPT bridge → settings
 *  signal. */
export function ShellProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.np?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys"); // cover changes missed before this root-lifetime subscription
		return off;
	}, []);
	useEffect(() => {
		if (IS_ELECTRON) {
			document.documentElement.classList.add("np-electron");
			document.documentElement.dataset.npPlatform = window.np?.platform ?? "";
		}
		const setZoomVar = (factor: number) => document.documentElement.style.setProperty("--np-zoom", String(factor));
		const off = window.np?.onZoom?.(setZoomVar);
		void window.np?.getZoom?.().then(setZoomVar);
		return () => off?.();
	}, []);
	return <>{children}</>;
}

/** The five tabs, in order. `match` decides the active tab for a path. */
export const TABS: ReadonlyArray<{ href: string; label: MessageKey; testid: string; match: (path: string) => boolean }> = [
	{ href: "/", label: "shell.tabs.home", testid: "tab-home", match: (p) => p === "/" },
	{ href: "/sessions", label: "shell.tabs.sessions", testid: "tab-sessions", match: (p) => p.startsWith("/sessions") || p.startsWith("/chat") },
	{ href: "/knowledge", label: "shell.tabs.knowledge", testid: "tab-knowledge", match: (p) => p.startsWith("/knowledge") },
	{ href: "/review", label: "shell.tabs.review", testid: "tab-review", match: (p) => p.startsWith("/review") },
	{ href: "/exams", label: "shell.tabs.exams", testid: "tab-exams", match: (p) => p.startsWith("/exams") },
];

/** The settings pages the profile menu opens (route segment → copy). */
export const SETTINGS_PAGES: ReadonlyArray<{ id: string; label: MessageKey; hint?: MessageKey }> = [
	{ id: "ai", label: "shell.profile.ai", hint: "shell.profile.aiHint" },
	{ id: "connections", label: "shell.profile.connections", hint: "shell.profile.connectionsHint" },
	{ id: "review", label: "shell.profile.review", hint: "shell.profile.reviewHint" },
	{ id: "exams", label: "shell.profile.exams", hint: "shell.profile.examsHint" },
	{ id: "appearance", label: "shell.profile.appearance", hint: "shell.profile.appearanceHint" },
	{ id: "shortcuts", label: "shell.profile.shortcuts" },
	{ id: "advanced", label: "shell.profile.advanced", hint: "shell.profile.advancedHint" },
];

export function TopNav({ pathname }: { pathname: string }) {
	const t = useT();
	return (
		<header className="np-drag np-lights-gutter np-wco-gutter flex h-15 shrink-0 select-none items-center gap-2 px-3" data-testid="top-nav">
			<Link
				href="/"
				aria-label={t("shell.home")}
				className="flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent"
			>
				<NpMark className="size-6" />
			</Link>
			{/* Narrow windows (owner 2026-11-06, below 720px): the current
			    section + a menu instead of the five tabs, which overflowed. */}
			<NarrowNav pathname={pathname} />
			<nav aria-label={t("shell.tabs.label")} className="hidden items-center gap-1 min-[720px]:flex">
				{TABS.map((tab) => {
					const active = tab.match(pathname);
					return (
						<Link
							key={tab.href}
							href={tab.href}
							data-testid={tab.testid}
							aria-current={active ? "page" : undefined}
							className={cn(
								"flex h-9 items-center rounded-lg px-3 text-sm transition-colors",
								active ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							{t(tab.label)}
						</Link>
					);
				})}
			</nav>
			<div className="ml-auto flex items-center gap-1">
				<NoticesBell />
				<ProfileMenu />
			</div>
		</header>
	);
}

/** The tabs as a dropdown for narrow windows: the trigger names the
 *  current section; the menu lists all five (Esc / outside click close). */
export function NarrowNav({ pathname }: { pathname: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => setOpen(false), [pathname]);
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
	const current = TABS.find((tab) => tab.match(pathname));
	return (
		<div ref={rootRef} className="relative min-w-0 min-[720px]:hidden" data-testid="narrow-nav">
			<button
				type="button"
				aria-label={t("shell.tabs.label")}
				aria-haspopup="menu"
				aria-expanded={open}
				data-testid="narrow-nav-button"
				onClick={() => setOpen((v) => !v)}
				className="flex h-9 min-w-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
			>
				<span className="truncate">{current ? t(current.label) : t("shell.tabs.label")}</span>
				<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
			</button>
			{open && (
				<nav aria-label={t("shell.tabs.label")} data-testid="narrow-nav-menu" className="absolute left-0 top-11 z-50 flex w-60 flex-col rounded-xl border bg-popover p-1.5 shadow-float">
					{TABS.map((tab) => {
						const active = tab === current;
						return (
							<Link
								key={tab.href}
								href={tab.href}
								aria-current={active ? "page" : undefined}
								onClick={() => setOpen(false)}
								className={cn("flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 text-sm transition-colors hover:bg-accent", active ? "font-semibold text-foreground" : "text-muted-foreground")}
							>
								{t(tab.label)}
								{active && <CheckIcon aria-hidden className="size-4" />}
							</Link>
						);
					})}
				</nav>
			)}
		</div>
	);
}

/** The profile menu: the secondary surfaces (settings pages, data folder,
 *  language) and the version line — what Clonify keeps out of the bar. */
export function ProfileMenu({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(initiallyOpen);
	const rootRef = useRef<HTMLDivElement>(null);
	const [canOpenData, setCanOpenData] = useState(false);
	useEffect(() => setCanOpenData(!!window.np?.openDataFolder), []);
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
	const item = "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-foreground transition-colors hover:bg-accent";
	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				aria-label={t("shell.profile.open")}
				aria-haspopup="menu"
				aria-expanded={open}
				data-testid="profile-menu-button"
				onClick={() => setOpen((v) => !v)}
				className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<CircleUserRoundIcon className="size-5" />
			</button>
			{open && (
				<div
					role="menu"
					data-testid="profile-menu"
					className="absolute right-0 top-11 z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-popover p-1.5 shadow-float"
				>
					{SETTINGS_PAGES.map((page) => (
						<Link
							key={page.id}
							role="menuitem"
							href={`/settings/${page.id}`}
							data-testid={`profile-${page.id}`}
							onClick={() => setOpen(false)}
							className={item}
						>
							<span className="flex min-w-0 flex-1 flex-col py-1.5">
								<span>{t(page.label)}</span>
								{page.hint && <span className="text-xs text-muted-foreground">{t(page.hint)}</span>}
							</span>
							<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
						</Link>
					))}
					<div className="my-1 border-t" />
					{canOpenData && (
						<button
							type="button"
							role="menuitem"
							data-testid="profile-data-folder"
							onClick={() => {
								window.np?.openDataFolder?.();
								setOpen(false);
							}}
							className={item}
						>
							<FolderOpenIcon className="size-4 text-muted-foreground" />
							{t("shell.profile.dataFolder")}
						</button>
					)}
					<Link role="menuitem" href="/settings/language" data-testid="profile-language" onClick={() => setOpen(false)} className={item}>
						<span className="flex-1">{t("shell.profile.language")}</span>
						<ChevronRightIcon className="size-4 text-muted-foreground" />
					</Link>
					{APP_VERSION && (
						<p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground" data-testid="profile-version">
							{t("shell.profile.version", { version: APP_VERSION })}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/** The app frame: top bar on the frame, the page on one sheet. */
export function AppShell({ children }: { children: React.ReactNode }) {
	const pathname = usePathname() ?? "/";
	return (
		<SettingsDialogProvider>
			<NoticesProvider>
			<div className="flex h-dvh flex-col bg-frame">
				<TopNav pathname={pathname} />
				<main className="relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-xl border bg-background" data-testid="app-sheet">
					{children}
				</main>
			</div>
			</NoticesProvider>
			{/* The single document-level keydown listener (keyboard wave A). */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}

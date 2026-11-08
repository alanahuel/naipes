"use client";
/**
 * SETTINGS AS PAGES (Naipes interface, stage 3 — 2026-11-03; Clonify's
 * pattern): no settings dialog. The profile menu opens pages that each
 * answer one question:
 *
 *   /settings/ai           Tu IA        — model keys, subscriptions, models, tools
 *   /settings/connections  Conexiones   — knowledge folder, dictation, search
 *   /settings/review       Repaso       — recall target, notices, tray (2026-11-04)
 *   /settings/exams        Exámenes     — study time, durations, plan (2026-11-06)
 *   /settings/appearance   Apariencia
 *   /settings/shortcuts    Atajos
 *   /settings/advanced     Avanzado     — graph, context/compaction, prompts, updates
 *   /settings/language     Idioma
 *
 * The record + the single `write` seam (formerly the dialog's) live in
 * useSettingsRecord: one fetch per page, sections write through it, the
 * stored (server-clamped) value is what renders after a write.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	PHONE_PORT,
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type MessageKey,
	type ModelsSettings,
	type ObsidianSettings,
	type DesktopSettings,
	type ReviewSettings,
	type ExamSettings,
	type UserSettings,
} from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useT } from "@/components/i18n";
import { useAppearance } from "./appearance.tsx";
import { AgentSection } from "./agent-section.tsx";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { KeysSection } from "./keys-section.tsx";
import { LanguageSetting } from "./language-setting.tsx";
import { McpSection } from "./mcp-section";
import { ObsidianSection } from "./obsidian-section.tsx";
import { ReviewSettingsSection } from "./review-section.tsx";
import { ExamSettingsSection } from "./exams-section.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { SettingsRow, Toggle } from "./controls.tsx";
import type { SettingsPageId } from "./pages.ts";

export { SETTINGS_PAGE_IDS, isSettingsPage, pageForSection, type SettingsPageId } from "./pages.ts";

type WritableSection = "general" | "agent" | "models" | "appearance" | "graph" | "compaction" | "obsidian" | "review" | "exams" | "desktop" | "phone";

/** The settings record + its one writer. */
export function useSettingsRecord() {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(undefined);
	const [error, setError] = useState<{ section: string; detail: string } | null>(null);
	useEffect(() => {
		fetch("/api/settings")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: { settings: UserSettings | null }) => setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }))
			.catch(() => setRecord(null));
	}, []);
	const write = useCallback(
		async (section: WritableSection, body: object) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as { error?: string };
				setError({ section, detail: detail.error ?? String(res.status) });
				return;
			}
			const stored = ((await res.json().catch(() => null)) as { settings?: UserSettings } | null)?.settings;
			setRecord((prev) => stored ?? ({ ...(prev ?? {}), [section]: body } as UserSettings));
			notifySettingsSaved(section);
			if (section === "appearance") onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);
	return { record, error, write };
}

const PAGE_COPY: Record<SettingsPageId, { title: MessageKey; subtitle: MessageKey }> = {
	ai: { title: "settings.page.ai.title", subtitle: "settings.page.ai.subtitle" },
	connections: { title: "settings.page.connections.title", subtitle: "settings.page.connections.subtitle" },
	review: { title: "settings.page.review.title", subtitle: "settings.page.review.subtitle" },
	exams: { title: "settings.page.exams.title", subtitle: "settings.page.exams.subtitle" },
	appearance: { title: "settings.page.appearance.title", subtitle: "settings.page.appearance.subtitle" },
	shortcuts: { title: "settings.page.shortcuts.title", subtitle: "settings.page.shortcuts.subtitle" },
	advanced: { title: "settings.page.advanced.title", subtitle: "settings.page.advanced.subtitle" },
	language: { title: "settings.page.language.title", subtitle: "settings.page.language.subtitle" },
};

/** A block on a settings page: a quiet heading + its rows. */
function Block({ title, testid, children }: { title?: string; testid?: string; children: React.ReactNode }) {
	return (
		<section data-testid={testid} className="flex flex-col gap-3">
			{title && <h2 className="text-lg font-semibold">{title}</h2>}
			<div className="flex flex-col gap-3">{children}</div>
		</section>
	);
}

export function SettingsPage({ page, initialRow }: { page: SettingsPageId; initialRow?: string }) {
	const t = useT();
	const { record, error, write } = useSettingsRecord();
	const copy = PAGE_COPY[page];

	// No scrolling with a dropdown open (MenuShell announces open/close).
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [openMenus, setOpenMenus] = useState(0);
	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	return (
		<div ref={scrollRef} className="h-full overflow-y-auto" data-testid={`settings-page-${page}`}>
			<div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-8 pb-16 pt-10">
				<header className="flex flex-col gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">{t(copy.title)}</h1>
					<p className="text-sm text-muted-foreground">{t(copy.subtitle)}</p>
				</header>
				{error && (
					<p role="alert" data-testid="settings-error" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
						{t("settings.page.saveFailed", { section: error.section, detail: error.detail, error: error.detail })}
					</p>
				)}
				{page === "shortcuts" ? (
					<KeyboardSection />
				) : page === "language" ? (
					<LanguageSetting onLanguageChange={(language) => write("general", { ...(record?.general ?? {}), language })} />
				) : record === undefined ? (
					<p className="text-sm text-muted-foreground">{t("settings.page.loading")}</p>
				) : record === null ? (
					<p className="text-sm text-muted-foreground">{t("settings.page.loadFailed")}</p>
				) : page === "ai" ? (
					<>
						<Block testid="section-keys">
							<KeysSection initialRow={initialRow} groups={["modelKeys", "subscriptions"]} />
						</Block>
						<Block testid="section-agent">
							<AgentSection
								groups={["models", "tools"]}
								agent={record.agent}
								models={record.models}
								graph={record.graph}
								compaction={record.compaction}
								onModelsChange={(next: ModelsSettings) => void write("models", next)}
								onSectionChange={(next: AgentSettings) => void write("agent", next)}
								onCompactionChange={(next: CompactionSettings) => void write("compaction", next)}
							/>
						</Block>
					</>
				) : page === "connections" ? (
					<>
						<Block title={t("settings.obsidian.title")} testid="section-obsidian">
							<ObsidianSection obsidian={record.obsidian} onSectionChange={(next: ObsidianSettings) => write("obsidian", next)} />
						</Block>
						<Block testid="section-keys">
							<KeysSection initialRow={initialRow} groups={["dictation", "search"]} />
						</Block>
						<Block title={t("settings.mcp.title")} testid="section-mcp">
							<McpSection />
						</Block>
					</>
				) : page === "review" ? (
					<ReviewSettingsSection
						review={record.review}
						desktop={record.desktop}
						onReviewChange={(next: ReviewSettings) => void write("review", next)}
						onDesktopChange={(next: DesktopSettings) => void write("desktop", next)}
					/>
				) : page === "exams" ? (
					<ExamSettingsSection exams={record.exams} onChange={(next: ExamSettings) => void write("exams", next)} />
				) : page === "appearance" ? (
					<Block testid="section-appearance">
						<AppearanceSection appearance={record.appearance} onSectionChange={(next: AppearanceSettings) => void write("appearance", next)} />
					</Block>
				) : (
					<>
						<Block testid="section-graph">
							<GraphSection graph={record.graph} onSectionChange={(next: GraphSettings) => void write("graph", next)} />
						</Block>
						<Block testid="section-agent">
							<AgentSection
								groups={["context", "prompts"]}
								agent={record.agent}
								models={record.models}
								graph={record.graph}
								compaction={record.compaction}
								onModelsChange={(next: ModelsSettings) => void write("models", next)}
								onSectionChange={(next: AgentSettings) => void write("agent", next)}
								onCompactionChange={(next: CompactionSettings) => void write("compaction", next)}
							/>
						</Block>
						{/* «Enviar desde el móvil» (owner, 2026-11-06): off by default. */}
						<Block title={t("settings.phone.title")} testid="section-phone">
							<SettingsRow label={t("settings.phone.enabled")} hint={t("settings.phone.hint", { port: PHONE_PORT })}>
								<Toggle
									checked={record.phone?.enabled === true}
									label={t("settings.phone.enabled")}
									testid="phone-enabled"
									onChange={(on) => void write("phone", { enabled: on })}
								/>
							</SettingsRow>
						</Block>
						<Block title={t("settings.page.updates")} testid="section-general">
							<UpdateSettings
								autoUpdate={record.general?.autoUpdate ?? true}
								onAutoUpdateChange={(on) => void write("general", { ...record.general, autoUpdate: on })}
							/>
						</Block>
					</>
				)}
			</div>
		</div>
	);
}

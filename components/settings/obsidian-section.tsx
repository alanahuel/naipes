"use client";

/**
 * Settings → Knowledge folder (owner, 2026-11-01 as "Obsidian"; generalized
 * 2026-11-04): the folder connection. One switch turns both directions on;
 * the folder path (native picker on desktop); the Obsidian-format switch
 * (wikilinks vs standard Markdown links); the
 * folders to read as a checkbox tree with note counts — every new or
 * changed note costs one extraction run, so folders start unchecked and
 * the selection's note total is always visible.
 */

import { useCallback, useEffect, useState } from "react";
import { CONFIRM_ABOVE_RUNS_MIN, FACTORY_SETTINGS, resolveObsidianFormat, type ObsidianSettings } from "@/src/core";
import { useT } from "@/components/i18n";
import { CommitInput, SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

interface VaultFolder {
	path: string;
	notes: number;
	children: VaultFolder[];
}

interface VaultOverview {
	root: string;
	exists: boolean;
	folders: VaultFolder[];
	outputFolder: string;
	status: { enabled: boolean; watching: boolean; queued: number; running: number; synced: number; lastError: string | null };
	/** Documents waiting for «Leer» (phase 2). */
	pending?: Array<{ path: string; runs: number; pages?: number; deferred?: boolean }>;
}

const nameOf = (folder: string) => folder.split("/").pop() ?? folder;

/** Is `folder` covered by a selected ancestor (or itself)? */
const coveredBy = (folder: string, selected: readonly string[]) =>
	selected.find((s) => folder === s || folder.startsWith(`${s}/`));

function countSelected(folders: VaultFolder[], selected: readonly string[]): number {
	let total = 0;
	for (const folder of folders) {
		if (selected.includes(folder.path)) total += folder.notes;
		else total += countSelected(folder.children, selected);
	}
	return total;
}

export function ObsidianSection({
	obsidian,
	onSectionChange,
}: {
	obsidian: ObsidianSettings | undefined;
	onSectionChange: (next: ObsidianSettings) => Promise<void> | void;
}) {
	const t = useT();
	const [overview, setOverview] = useState<VaultOverview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// The native picker exists only in the desktop window (SSR-safe probe).
	const [canPick, setCanPick] = useState(false);
	useEffect(() => setCanPick(typeof window !== "undefined" && !!window.np?.pickFolder), []);
	const enabled = obsidian?.enabled ?? false;
	const folders = obsidian?.folders ?? [];
	const vaultPath = obsidian?.vaultPath ?? "";
	const obsidianFormat = resolveObsidianFormat(obsidian);
	const confirmAboveRuns = obsidian?.confirmAboveRuns ?? FACTORY_SETTINGS.obsidian.confirmAboveRuns;
	const suggestFolders = obsidian?.suggestFolders ?? FACTORY_SETTINGS.obsidian.suggestFolders;
	const inboxFolder = obsidian?.inboxFolder ?? FACTORY_SETTINGS.obsidian.inboxFolder;

	const refresh = useCallback(async () => {
		try {
			const query = vaultPath ? `?root=${encodeURIComponent(vaultPath)}` : "";
			const res = await fetch(`/api/vault${query}`);
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
			setOverview((await res.json()) as VaultOverview);
			setLoadError(null);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		}
	}, [vaultPath]);

	useEffect(() => {
		void refresh();
	}, [refresh, enabled, folders.length]);

	const write = async (next: ObsidianSettings) => {
		await onSectionChange(next);
		void refresh();
	};

	const toggleFolder = (folder: string, on: boolean) => {
		// Selecting a folder subsumes its descendants (one entry, recursive).
		const rest = folders.filter((f) => f !== folder && !f.startsWith(`${folder}/`));
		void write({ ...obsidian, folders: on ? [...rest, folder] : rest });
	};

	const pick = async () => {
		const chosen = await window.np?.pickFolder?.(overview?.root || vaultPath);
		if (chosen) void write({ ...obsidian, vaultPath: chosen, folders: [] });
	};

	const decide = async (file: string, decision: "read" | "later") => {
		await fetch("/api/vault/pending", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: file, decision }),
		}).catch(() => null);
		void refresh();
	};

	const selectedNotes = overview ? countSelected(overview.folders, folders) : 0;
	const status = overview?.status;

	const renderFolder = (folder: VaultFolder, depth: number) => {
		const ancestor = coveredBy(folder.path, folders);
		const checked = ancestor !== undefined;
		const inherited = checked && ancestor !== folder.path;
		return (
			<div key={folder.path}>
				<label
					className="flex cursor-pointer items-center gap-2 py-0.5 font-ui text-xs text-foreground"
					style={{ paddingLeft: `${depth * 16}px` }}
				>
					<input
						type="checkbox"
						checked={checked}
						disabled={inherited}
						data-testid={`vault-folder-${folder.path}`}
						onChange={(e) => toggleFolder(folder.path, e.target.checked)}
					/>
					<span className="min-w-0 flex-1 truncate">{nameOf(folder.path)}</span>
					<span className="shrink-0 text-muted-foreground">{folder.notes}</span>
				</label>
				{folder.children.map((child) => renderFolder(child, depth + 1))}
			</div>
		);
	};

	return (
		<>
			<SettingsRow label={t("settings.obsidian.connection")} hint={t("settings.obsidian.connectionHint")} testid="obsidian-row-enabled">
				<Toggle checked={enabled} label={t("settings.obsidian.connectionToggle")} testid="toggle-obsidian-connection" onChange={(on) => void write({ ...obsidian, enabled: on })} />
			</SettingsRow>
			<SettingsRow label={t("settings.obsidian.vault")} hint={!overview ? undefined : overview.root === "" ? t("settings.obsidian.chooseVault") : !overview.exists ? t("settings.obsidian.folderNotFound") : overview.root} testid="obsidian-row-vault">
				<span className="flex items-center gap-2">
					<CommitInput
						value={vaultPath}
						placeholder={overview?.root || t("settings.obsidian.pathPlaceholder")}
						ariaLabel={t("settings.obsidian.pathAria")}
						testid="input-vault-path"
						onCommit={(v) => void write({ ...obsidian, vaultPath: v.trim(), folders: v.trim() === vaultPath ? folders : [] })}
					/>
					{canPick && (
						<button
							type="button"
							className="h-7 shrink-0 rounded-sm border border-border px-2 font-ui text-xs text-foreground hover:border-muted-foreground/50"
							onClick={() => void pick()}
						>
							{t("settings.obsidian.choose")}
						</button>
					)}
				</span>
			</SettingsRow>
			<SettingsRow label={t("settings.obsidian.outputFolder")} hint={t("settings.obsidian.outputFolderHint")} testid="obsidian-row-output">
				<CommitInput
					value={obsidian?.outputFolder ?? ""}
					placeholder={overview?.outputFolder || "Naipes"}
					ariaLabel={t("settings.obsidian.outputFolderAria")}
					testid="input-vault-output-folder"
					onCommit={(v) => {
						const next = v.trim();
						if (next) void write({ ...obsidian, outputFolder: next });
					}}
				/>
			</SettingsRow>
			<SettingsRow label={t("settings.obsidian.format")} hint={t("settings.obsidian.formatHint")} testid="obsidian-row-format">
				<Toggle checked={obsidianFormat} label={t("settings.obsidian.formatToggle")} testid="toggle-obsidian-format" onChange={(on) => void write({ ...obsidian, obsidianFormat: on })} />
			</SettingsRow>
			<SettingsRow label={t("settings.obsidian.confirmAbove")} hint={t("settings.obsidian.confirmAboveHint")} testid="obsidian-row-confirm">
				<CommitInput
					type="number"
					value={String(confirmAboveRuns)}
					ariaLabel={t("settings.obsidian.confirmAbove")}
					testid="input-vault-confirm-above"
					onCommit={(raw) => {
						const n = Number(raw.trim());
						if (Number.isInteger(n) && n >= CONFIRM_ABOVE_RUNS_MIN) void write({ ...obsidian, confirmAboveRuns: n });
					}}
				/>
			</SettingsRow>
			<SettingsRow label={t("settings.obsidian.suggest")} hint={t("settings.obsidian.suggestHint", { folder: inboxFolder })} testid="obsidian-row-suggest">
				<Toggle checked={suggestFolders} label={t("settings.obsidian.suggestToggle")} testid="toggle-suggest-folders" onChange={(on) => void write({ ...obsidian, suggestFolders: on })} />
			</SettingsRow>
			{suggestFolders && (
				<SettingsRow label={t("settings.obsidian.inbox")} hint={t("settings.obsidian.inboxHint")} testid="obsidian-row-inbox">
					<CommitInput
						value={obsidian?.inboxFolder ?? ""}
						placeholder={FACTORY_SETTINGS.obsidian.inboxFolder}
						ariaLabel={t("settings.obsidian.inbox")}
						testid="input-vault-inbox"
						onCommit={(v) => {
							const next = v.trim();
							if (next) void write({ ...obsidian, inboxFolder: next });
						}}
					/>
				</SettingsRow>
			)}
			{status && enabled && (
				<p className="text-xs text-muted-foreground" data-testid="obsidian-status">
					{status.watching ? t("settings.obsidian.watching") : t("settings.obsidian.notWatching")} · {t("settings.obsidian.synced", { n: status.synced })}
					{status.running + status.queued > 0 ? ` · ${t("settings.obsidian.queue", { running: status.running, queued: status.queued })}` : ""}
					{status.lastError ? ` · ${t("settings.obsidian.lastError", { error: status.lastError })}` : ""}
				</p>
			)}
			{loadError && <p className="text-xs text-warn">{t("settings.obsidian.readError", { error: loadError })}</p>}

			{overview?.pending && overview.pending.length > 0 && (
				<SettingsGroup label={t("settings.obsidian.pending")} testid="obsidian-pending">
					{overview.pending.map((doc) => (
						<div key={doc.path} className="flex flex-wrap items-center gap-2 py-0.5 font-ui text-xs text-foreground" data-testid={`vault-pending-${doc.path}`}>
							<span className="min-w-0 flex-1 truncate" title={doc.path}>
								{doc.pages !== undefined
									? t("settings.obsidian.pendingPages", { file: doc.path, pages: doc.pages, runs: doc.runs })
									: t("settings.obsidian.pendingRuns", { file: doc.path, runs: doc.runs })}
								{doc.deferred ? ` · ${t("settings.obsidian.deferred")}` : ""}
							</span>
							<button type="button" className="rounded-sm border border-border px-2 py-0.5 hover:border-muted-foreground/50" onClick={() => void decide(doc.path, "read")}>
								{t("settings.obsidian.read")}
							</button>
							{!doc.deferred && (
								<button type="button" className="rounded-sm px-2 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => void decide(doc.path, "later")}>
									{t("settings.obsidian.notNow")}
								</button>
							)}
						</div>
					))}
				</SettingsGroup>
			)}

			<SettingsGroup label={t("settings.obsidian.folders")} testid="obsidian-folders">
				<p className="text-xs text-muted-foreground">
					{t("settings.obsidian.selected", { n: selectedNotes })}
				</p>
				<div className="max-h-72 overflow-y-auto rounded-sm border border-border p-2">
					{overview?.folders.length ? overview.folders.map((folder) => renderFolder(folder, 0)) : (
						<p className="text-xs text-muted-foreground">{t("settings.obsidian.noFolders")}</p>
					)}
				</div>
				{overview && (
					<p className="text-xs text-muted-foreground">
						{t("settings.obsidian.writesTo", { folder: overview.outputFolder })}
					</p>
				)}
			</SettingsGroup>
		</>
	);
}

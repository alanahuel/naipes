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
import { resolveObsidianFormat, type ObsidianSettings } from "@/src/core";
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
			{status && enabled && (
				<p className="text-xs text-muted-foreground" data-testid="obsidian-status">
					{status.watching ? t("settings.obsidian.watching") : t("settings.obsidian.notWatching")} · {t("settings.obsidian.synced", { n: status.synced })}
					{status.running + status.queued > 0 ? ` · ${t("settings.obsidian.queue", { running: status.running, queued: status.queued })}` : ""}
					{status.lastError ? ` · ${t("settings.obsidian.lastError", { error: status.lastError })}` : ""}
				</p>
			)}
			{loadError && <p className="text-xs text-warn">{t("settings.obsidian.readError", { error: loadError })}</p>}

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

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { translator, useT, type Translate } from "@/components/i18n";
import { SettingsRow, Toggle } from "./controls.tsx";

const en = translator("en");

/** Observational snapshot from electron/main.cjs; never updater permission. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
};

export const APP_VERSION = process.env.NP_VERSION ?? "";
const HOMEPAGE = process.env.NP_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = en("settings.update.manualHint");
export const AUTO_UPDATE_HINT = en("settings.update.autoHint");

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 * cross; a revision prevents an older reply from hiding a newer event.
 * The banner shares this read-only observer so late loads recover too. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const np = window.np;
		if (!np) return;
		let live = true;
		let revision = -1;
		const accept = (next: UpdateState) => {
			if (!live || next.revision < revision) return;
			revision = next.revision;
			setState(next);
			setFailed(false);
		};
		const off = np.onUpdateStatus?.(accept);
		void np.getUpdateState?.().then(accept).catch(() => {
			if (live && revision === -1) setFailed(true);
		});
		return () => { live = false; off?.(); };
	}, []);
	return { state, failed };
}

export function updateStatusText(state: UpdateState | null, t: Translate = en): string | null {
	switch (state?.status) {
		case "checking": return t("settings.update.checking");
		case "downloading": return state.version ? t("settings.update.downloadingVersion", { version: state.version }) : t("settings.update.downloading");
		case "up-to-date": return t("settings.update.upToDate");
		case "downloaded": return state.version ? t("settings.update.readyVersion", { version: state.version }) : t("settings.update.ready");
		case "error": return t("settings.update.error");
		default: return null;
	}
}

/** Version information is useful everywhere; update controls only belong
 * to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	const t = useT();
	const { state, failed } = useUpdateState();
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" ? updateStatusText(state, t)
		: failed || checkFailed ? t("settings.update.error") : updateStatusText(state, t);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;
	const check = () => {
		setCheckFailed(false);
		void window.np?.checkForUpdates?.().catch(() => setCheckFailed(true));
	};

	return (
		<>
			<SettingsRow
				label={t("settings.update.version", { version: version || t("settings.update.unknownVersion") })}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{t("settings.update.manualHint")}</span>}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">{t("settings.update.releaseNotes")}</a>}
					</>
				}
			>
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.np?.installUpdate?.()}>{t("settings.update.restart")}</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? t("settings.update.spinnerDownloading") : t("settings.update.spinnerChecking")} />}
						{t("settings.update.check")}
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label={t("settings.update.auto")} hint={t("settings.update.autoHint")} testid="row-auto-update">
					<Toggle checked={autoUpdate} label={t("settings.update.autoToggle")} testid="toggle-auto-update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}

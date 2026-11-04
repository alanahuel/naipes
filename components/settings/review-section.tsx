"use client";
/**
 * Settings → Repaso (owner-approved mockup, 2026-11-04): Memoria (recall
 * target, new ideas a day, ideas per batch, confidence for «Bien»),
 * Avisos (digest + evening times), Escritorio (tray, autostart — only in
 * the desktop app). Each control commits its whole section (the house
 * replace-whole PUT); the stored, server-validated value is what renders.
 */

import { useEffect, useState } from "react";
import { FACTORY_SETTINGS, REVIEW_RETENTION_MAX, REVIEW_RETENTION_MIN, type DesktopSettings, type ReviewSettings } from "@/src/core";
import { useT } from "@/components/i18n";
import { CommitInput, SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

/** Parse a committed integer field; null = reject (keep the stored value). */
export function parseIntField(raw: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(raw.trim())) return null;
	const n = Number(raw);
	return n >= min && n <= max ? n : null;
}

export function ReviewSettingsSection({
	review,
	desktop,
	onReviewChange,
	onDesktopChange,
}: {
	review: ReviewSettings | undefined;
	desktop: DesktopSettings | undefined;
	onReviewChange: (next: ReviewSettings) => void;
	onDesktopChange: (next: DesktopSettings) => void;
}) {
	const t = useT();
	const r = { ...FACTORY_SETTINGS.review, ...review };
	const d = { ...FACTORY_SETTINGS.desktop, ...desktop };
	const set = (patch: ReviewSettings) => onReviewChange({ ...review, ...patch });

	// The slider moves locally while dragging; it commits on release.
	const stored = Math.round(r.targetRetention * 100);
	const [retention, setRetention] = useState(stored);
	useEffect(() => setRetention(stored), [stored]);
	const commitRetention = () => {
		if (retention !== stored) set({ targetRetention: retention / 100 });
	};

	// Desktop rows only make sense inside the desktop app.
	const [isDesktop, setIsDesktop] = useState(false);
	useEffect(() => setIsDesktop(Boolean(window.np)), []);

	const intRow = (field: "newPerDay" | "batchSize" | "confidenceThreshold", min: number, max: number) => (
		<CommitInput
			type="number"
			value={String(r[field])}
			ariaLabel={t(field === "newPerDay" ? "settings.review.newPerDay" : field === "batchSize" ? "settings.review.batch" : "settings.review.confidence")}
			testid={`review-${field}`}
			onCommit={(raw) => {
				const n = parseIntField(raw, min, max);
				if (n !== null) set({ [field]: n });
			}}
		/>
	);

	return (
		<div className="flex flex-col" data-testid="section-review">
			<SettingsGroup label={t("settings.review.memory")}>
				<SettingsRow label={t("settings.review.retention")} hint={t("settings.review.retentionHint")}>
					<span className="flex items-center gap-3">
						<input
							type="range"
							min={Math.round(REVIEW_RETENTION_MIN * 100)}
							max={Math.round(REVIEW_RETENTION_MAX * 100)}
							step={1}
							value={retention}
							aria-label={t("settings.review.retention")}
							aria-valuetext={`${retention}%`}
							data-testid="review-retention"
							onChange={(e) => setRetention(Number(e.target.value))}
							onPointerUp={commitRetention}
							onKeyUp={commitRetention}
							onBlur={commitRetention}
							className="h-1.5 w-40 accent-primary"
						/>
						<span className="w-10 text-right font-ui text-xs tabular-nums">{retention}%</span>
					</span>
				</SettingsRow>
				<SettingsRow label={t("settings.review.newPerDay")} hint={t("settings.review.newPerDayHint")}>
					{intRow("newPerDay", 0, 500)}
				</SettingsRow>
				<SettingsRow label={t("settings.review.batch")}>{intRow("batchSize", 1, 50)}</SettingsRow>
				<SettingsRow label={t("settings.review.confidence")} hint={t("settings.review.confidenceHint")}>
					{intRow("confidenceThreshold", 0, 100)}
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label={t("settings.review.notices")}>
				<SettingsRow label={t("settings.review.digest")}>
					<CommitInput type="time" value={r.digestTime} ariaLabel={t("settings.review.digest")} testid="review-digestTime" onCommit={(v) => v && set({ digestTime: v })} />
				</SettingsRow>
				<SettingsRow label={t("settings.review.evening")}>
					<CommitInput type="time" value={r.eveningTime} ariaLabel={t("settings.review.evening")} testid="review-eveningTime" onCommit={(v) => v && set({ eveningTime: v })} />
				</SettingsRow>
			</SettingsGroup>
			{isDesktop && (
				<SettingsGroup label={t("settings.review.desktop")}>
					<SettingsRow label={t("settings.review.tray")}>
						<Toggle checked={d.tray} label={t("settings.review.tray")} testid="review-tray" onChange={(on) => onDesktopChange({ ...desktop, tray: on })} />
					</SettingsRow>
					<SettingsRow label={t("settings.review.autostart")}>
						<Toggle checked={d.autostart} label={t("settings.review.autostart")} testid="review-autostart" onChange={(on) => onDesktopChange({ ...desktop, autostart: on })} />
					</SettingsRow>
				</SettingsGroup>
			)}
		</div>
	);
}

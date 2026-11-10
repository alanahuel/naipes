"use client";
/**
 * Settings → Exámenes («Exámenes», owner 2026-11-05): the global study
 * budget (minutes per weekday), the starting durations the plan uses until
 * the learner's own pace is measured, and the plan's knobs (final review
 * window, ideas per placement session). Each control commits the whole
 * section (the house replace-whole PUT).
 */

import { FACTORY_SETTINGS, type ExamSettings, type MessageKey } from "@/src/core";
import { useT } from "@/components/i18n";
import Link from "next/link";
import { CommitInput, SettingsGroup, SettingsRow } from "./controls.tsx";
import { parseIntField } from "./review-section.tsx";

type IntField = "teachMinutes" | "consolidateMinutes" | "problemMinutes" | "reviewMinutes" | "finalWindowDays" | "placementBatch";

const FIELDS: Array<{ field: IntField; label: MessageKey; min: number; max: number }> = [
	{ field: "teachMinutes", label: "settings.exams.teach", min: 1, max: 240 },
	{ field: "consolidateMinutes", label: "settings.exams.consolidate", min: 1, max: 240 },
	{ field: "problemMinutes", label: "settings.exams.problem", min: 1, max: 120 },
	{ field: "reviewMinutes", label: "settings.exams.review", min: 1, max: 60 },
];

const PLAN_FIELDS: Array<{ field: IntField; label: MessageKey; min: number; max: number }> = [
	{ field: "finalWindowDays", label: "settings.exams.finalWindow", min: 1, max: 14 },
	{ field: "placementBatch", label: "settings.exams.placementBatch", min: 1, max: 50 },
];

export function ExamSettingsSection({ exams, onChange }: { exams: ExamSettings | undefined; onChange: (next: ExamSettings) => void }) {
	const t = useT();
	const e = { ...FACTORY_SETTINGS.exams, ...exams };
	const set = (patch: ExamSettings) => onChange({ ...e, ...patch });
	const row = ({ field, label, min, max }: (typeof FIELDS)[number]) => (
		<SettingsRow key={field} label={t(label)}>
			<CommitInput
				type="number"
				value={String(e[field])}
				ariaLabel={t(label)}
				testid={`exams-${field}`}
				onCommit={(raw) => {
					const n = parseIntField(raw, min, max);
					if (n !== null) set({ [field]: n });
				}}
			/>
		</SettingsRow>
	);
	return (
		<div className="flex flex-col" data-testid="section-exams">
			<SettingsGroup label={t("settings.exams.time")}>
				{/* «Calendario» (owner 2026-11-10): the minutes per day moved there. */}
				<p className="px-1 pb-2 text-sm text-muted-foreground">
					{t("settings.exams.timeMoved")}{" "}
					<Link href="/settings/calendar" className="text-foreground underline-offset-2 hover:underline" data-testid="exams-time-link">
						{t("settings.exams.timeLink")}
					</Link>
				</p>
			</SettingsGroup>
			<SettingsGroup label={t("settings.exams.durations")}>
				<p className="px-1 pb-2 text-sm text-muted-foreground">{t("settings.exams.durationsHint")}</p>
				{FIELDS.map(row)}
			</SettingsGroup>
			<SettingsGroup label={t("settings.exams.plan")}>{PLAN_FIELDS.map(row)}</SettingsGroup>
		</div>
	);
}

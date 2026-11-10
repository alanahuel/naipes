"use client";
/**
 * Settings → Calendario («Calendario», owner 2026-11-10; mockup 8/8
 * approved): the study minutes per weekday (moved here from Exámenes —
 * still stored in `exams.weeklyMinutes`), the usual slots per weekday,
 * the alert lead time and the «preparar clase» length.
 */

import { useState } from "react";
import { XIcon } from "lucide-react";
import { FACTORY_SETTINGS, type CalendarSettings, type ExamSettings } from "@/src/core";
import { useLocale, useT } from "@/components/i18n";
import { WeeklyMinutes } from "@/components/exams";
import { buttonVariants } from "@/components/ui/button";
import { CommitInput, SettingsGroup, SettingsRow } from "./controls.tsx";
import { parseIntField } from "./review-section.tsx";

type Slot = { weekday: number; start: string; end: string };

const fieldInput = "h-8 rounded-md border bg-background px-2 text-sm outline-none focus:border-primary/50";

function weekdayName(i: number, locale: string): string {
	const d = new Date(2026, 10, 9 + i, 12); // 9 Nov 2026 is a Monday
	const s = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d);
	return s[0]!.toLocaleUpperCase() + s.slice(1);
}

function SlotAdder({ weekday, onAdd }: { weekday: number; onAdd: (s: Slot) => void }) {
	const t = useT();
	const [start, setStart] = useState("17:00");
	const [end, setEnd] = useState("19:00");
	return (
		<span className="flex items-center gap-1">
			<input type="time" step={900} aria-label={t("settings.calendar.slotFrom")} value={start} onChange={(e) => setStart(e.target.value)} className={fieldInput} />
			<span aria-hidden="true">–</span>
			<input type="time" step={900} aria-label={t("settings.calendar.slotTo")} value={end} onChange={(e) => setEnd(e.target.value)} className={fieldInput} />
			<button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={!(start < end)} onClick={() => onAdd({ weekday, start, end })} data-testid={`calendar-slot-add-${weekday}`}>
				{t("settings.calendar.addSlot")}
			</button>
		</span>
	);
}

export function CalendarSettingsSection({
	calendar,
	exams,
	onCalendarChange,
	onExamsChange,
}: {
	calendar: CalendarSettings | undefined;
	exams: ExamSettings | undefined;
	onCalendarChange: (next: CalendarSettings) => void;
	onExamsChange: (next: ExamSettings) => void;
}) {
	const t = useT();
	const { locale } = useLocale();
	const c = { ...FACTORY_SETTINGS.calendar, ...calendar };
	const e = { ...FACTORY_SETTINGS.exams, ...exams };
	const set = (patch: CalendarSettings) => onCalendarChange({ ...c, ...patch });
	const slots = [...c.slots].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
	return (
		<div className="flex flex-col" data-testid="section-calendar">
			<SettingsGroup label={t("settings.calendar.time")}>
				<p className="px-1 pb-2 text-sm text-muted-foreground">{t("settings.calendar.timeHint")}</p>
				<WeeklyMinutes value={e.weeklyMinutes} onChange={(weeklyMinutes) => onExamsChange({ ...e, weeklyMinutes })} />
			</SettingsGroup>
			<SettingsGroup label={t("settings.calendar.slots")}>
				<p className="px-1 pb-2 text-sm text-muted-foreground">{t("settings.calendar.slotsHint")}</p>
				{Array.from({ length: 7 }, (_, wd) => (
					<SettingsRow key={wd} label={weekdayName(wd, locale)}>
						<span className="flex flex-wrap items-center justify-end gap-2" data-testid={`calendar-slots-${wd}`}>
							{slots
								.filter((s) => s.weekday === wd)
								.map((s) => (
									<span key={`${s.start}-${s.end}`} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm tabular-nums">
										{s.start}–{s.end}
										<button
											type="button"
											aria-label={t("settings.calendar.removeSlot", { from: s.start, to: s.end })}
											className="text-muted-foreground hover:text-foreground"
											onClick={() => set({ slots: c.slots.filter((x) => !(x.weekday === s.weekday && x.start === s.start && x.end === s.end)) })}
										>
											<XIcon className="size-3.5" />
										</button>
									</span>
								))}
							<SlotAdder weekday={wd} onAdd={(s) => set({ slots: [...c.slots, s] })} />
						</span>
					</SettingsRow>
				))}
			</SettingsGroup>
			<SettingsGroup label={t("settings.calendar.alerts")}>
				<SettingsRow label={t("settings.calendar.alertMinutes")}>
					<CommitInput type="number" value={String(c.alertMinutes)} ariaLabel={t("settings.calendar.alertMinutes")} testid="calendar-alertMinutes" onCommit={(raw) => { const n = parseIntField(raw, 0, 120); if (n !== null) set({ alertMinutes: n }); }} />
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label={t("settings.calendar.prepare")}>
				<SettingsRow label={t("settings.calendar.prepareMinutes")}>
					<CommitInput type="number" value={String(c.prepareMinutes)} ariaLabel={t("settings.calendar.prepareMinutes")} testid="calendar-prepareMinutes" onCommit={(raw) => { const n = parseIntField(raw, 5, 60); if (n !== null) set({ prepareMinutes: n }); }} />
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}

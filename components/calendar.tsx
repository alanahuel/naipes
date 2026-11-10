"use client";
/**
 * CALENDARIO (owner design 2026-11-10; the eight mockups approved «Así»):
 * one calendar shared by the exams and Repaso, in a 6th tab with four
 * views — Agenda (default), Semana (hour grid: drag = move + anchor,
 * bottom edge = length), Mes (load per day, exam dates), Eventos (your
 * events + .ics subscriptions). Plus the Inicio card «Hoy» (it replaces
 * «Para repasar hoy» and «Hoy para tu examen») and the dialogs: move,
 * split, a date's minutes, planned / confirmed topics, own study, event.
 *
 * Data: GET /api/calendar (the server lays the plan out — this file only
 * shows it and sends the learner's edits), refetched on calendar-changed,
 * exams-changed, turn-settled, chats-changed and focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon, PencilIcon, PinIcon, RefreshCwIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useServerEvent } from "@/components/server-events";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { useLocale, useT, type Translate } from "@/components/i18n";
import { buttonVariants } from "@/components/ui/button";
import { Page, PageHeader, Section, SectionTitle } from "@/components/ui/page";
import { ListCard } from "@/components/ui/list";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { MenuShell } from "@/components/menu-shell";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	EVENT_KINDS,
	addDays,
	clockToMinutes,
	minutesToClock,
	weekdayIndex,
	type CalendarDay,
	type CalendarEvent,
	type CalendarExamView,
	type CalendarItem,
	type CalendarView,
	type EventKind,
	type MessageKey,
} from "@/src/core";

// ─── data ───────────────────────────────────────────────────────────────────

/** `null` = the default range (today + 6); "wait" = nothing to ask yet. */
export function useCalendar(range: { from: string; to: string } | null | "wait") {
	const [data, setData] = useState<CalendarView | null | undefined>(undefined);
	const url = range === "wait" ? null : range ? `/api/calendar?from=${range.from}&to=${range.to}` : "/api/calendar";
	const reload = useCallback(() => {
		if (!url) return;
		fetch(url)
			.then((r) => (r.ok ? (r.json() as Promise<CalendarView>) : Promise.reject(new Error(String(r.status)))))
			.then(setData)
			.catch(() => setData((prev) => (prev === undefined ? null : prev)));
	}, [url]);
	useEffect(() => {
		reload();
		const onFocus = () => reload();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);
	useServerEvent("calendar-changed", reload);
	useServerEvent("exams-changed", reload);
	useServerEvent("turn-settled", reload);
	useServerEvent("chats-changed", reload);
	useServerEvent("review-notice", reload);
	return { data, reload };
}

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
	try {
		const res = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { ok: res.ok, body: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
	} catch {
		return { ok: false, body: {} };
	}
}

const sessionAction = (body: Record<string, unknown>) => send("/api/calendar/sessions", "POST", body);
const occurrenceUpdate = (body: Record<string, unknown>) => send("/api/calendar/occurrences", "PUT", body);

/** POST /api/calendar/sessions/start → (stash the opening) → the chat id.
 *  Pure seam (tested). */
export async function beginCalendarSession(fetchLike: typeof fetch, key: string, stash: (id: string, text: string) => boolean = stashOpeningPrompt): Promise<string | null> {
	const res = await fetchLike("/api/calendar/sessions/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
	if (!res.ok) return null;
	const body = (await res.json()) as { chatId?: unknown; opening?: unknown; resumed?: unknown };
	if (typeof body.chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.chatId)) return null;
	if (typeof body.opening === "string" && !stash(body.chatId, body.opening)) return null;
	return body.chatId;
}

export function useStartCalendar() {
	const router = useRouter();
	const [starting, setStarting] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const start = useCallback(
		async (key: string) => {
			setStarting(key);
			setFailed(false);
			const id = await beginCalendarSession(fetch, key).catch(() => null);
			if (!id) {
				setStarting(null);
				setFailed(true);
				return;
			}
			router.push(`/chat/${id}`);
		},
		[router],
	);
	return { starting, failed, start };
}

// ─── pure formatting (tested) ───────────────────────────────────────────────

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A card's label: «Química · Enseñar «Enlace»», «Repaso · 8 ideas»… */
export function itemLabel(item: CalendarItem, exams: readonly CalendarExamView[], t: Translate): string {
	if (item.type === "event") return item.title ?? "";
	const exam = exams.find((e) => e.id === item.examId);
	const name = exam?.title ?? "";
	let label: string;
	switch (item.kind) {
		case "repaso":
			label = item.count ? t("calendar.item.repaso", { n: item.count }) : t("calendar.item.repasoPlain");
			break;
		case "review":
			label = t("calendar.item.review", { exam: name });
			break;
		case "placement":
			label = t("calendar.item.placement", { exam: name });
			break;
		case "practice":
			label = t("calendar.item.practice", { exam: name });
			break;
		case "prepare":
			label = t("calendar.item.prepare", { exam: name });
			break;
		case "teach": {
			const point = item.pointId ? exam?.points.find((p) => p.id === item.pointId)?.text : exam?.prerequisites.find((q) => q.id === item.prerequisiteId)?.statement;
			label = t(item.short ? "calendar.item.consolidate" : "calendar.item.teach", { exam: name, point: short(point ?? "") });
			break;
		}
		default:
			label = item.title ?? "";
	}
	return item.pinned && item.pinned.parts > 1 ? t("calendar.item.part", { label, part: item.pinned.part + 1, parts: item.pinned.parts }) : label;
}

/** «45 de 90 min»: what the day holds against its minutes — study cards
 *  (done ones included) and classes that consume time; past the concrete
 *  window, the estimate per exam. */
export function usedMinutes(day: Pick<CalendarDay, "items" | "examMinutes" | "concrete" | "repasoMinutes"> & { unscheduled?: Record<string, number> }): number {
	if (!day.concrete) return Math.round(Object.values(day.examMinutes).reduce((s, m) => s + m, 0) + day.repasoMinutes);
	let used = Object.values(day.unscheduled ?? {}).reduce((s, m) => s + m, 0);
	for (const i of day.items) {
		if (i.type === "session") used += i.minutes;
		else if (i.consumes && !i.cancelled) used += i.minutes;
	}
	return Math.round(used);
}

export function fmtDay(day: string, locale: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric" }): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Intl.DateTimeFormat(locale, opts).format(new Date(y!, m! - 1, d!, 12));
}

const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s);

export function dayTitle(day: string, today: string, locale: string, t: Translate): string {
	const name = fmtDay(day, locale);
	return day === today ? t("calendar.day.today", { date: name }) : capitalize(name);
}

/** The Monday of a day's week. */
export function mondayOf(day: string): string {
	return addDays(day, -weekdayIndex(day));
}

const KIND_KEY: Record<EventKind, MessageKey> = {
	class: "calendar.kind.class",
	seminar: "calendar.kind.seminar",
	tutoring: "calendar.kind.tutoring",
	selfStudy: "calendar.kind.selfStudy",
	other: "calendar.kind.other",
};

const primaryBtn = buttonVariants({ variant: "default", size: "sm" });
const quietBtn = buttonVariants({ variant: "outline", size: "sm" });
const fieldInput = "h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-primary/50";
const menuItem = "flex min-h-9 w-full items-center rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent";

// ─── dialogs ────────────────────────────────────────────────────────────────

export type CalendarDialog =
	| { type: "move"; item: CalendarItem; hourOnly?: boolean }
	| { type: "moveOne"; item: CalendarItem }
	| { type: "split"; item: CalendarItem }
	| { type: "dayMinutes"; day: CalendarDay }
	| { type: "topics"; occurrence: string; title: string; examId: string; planned: string[]; mode: "planned" | "confirm"; when?: string }
	| { type: "self"; occurrence: string; title: string; examId: string; planned: string[]; when?: string }
	| { type: "event"; event: CalendarEvent | null };

function Dialog({ title, onClose, children, footer, testid }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; testid?: string }) {
	const dismiss = useBackdropDismiss(onClose);
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" {...dismiss}>
			<div role="dialog" aria-modal="true" aria-label={title} data-testid={testid} className="flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-hidden rounded-xl border bg-popover p-5 shadow-float">
				<h2 className="text-base font-semibold">{title}</h2>
				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto">{children}</div>
				<div className="flex flex-wrap justify-end gap-2">{footer}</div>
			</div>
		</div>,
		document.body,
	);
}

function Failure({ show }: { show: boolean }) {
	const t = useT();
	return show ? (
		<p role="alert" className="text-xs text-warn">
			{t("calendar.actionFailed")}
		</p>
	) : null;
}

function MoveDialog({ item, hourOnly, view, onClose, one }: { item: CalendarItem; hourOnly?: boolean; view: CalendarView; onClose: () => void; one?: boolean }) {
	const t = useT();
	const label = itemLabel(item, view.exams, t);
	const [day, setDay] = useState(item.day < view.today ? view.today : item.day);
	const [hour, setHour] = useState(item.start ?? (one ? "09:00" : ""));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const save = async () => {
		setBusy(true);
		const res = one ? await occurrenceUpdate({ key: item.occurrence, moved: { day, start: hour } }) : await sessionAction({ action: "move", key: item.key, day, start: hour || null });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	return (
		<Dialog
			title={t(one ? "calendar.move.titleOne" : "calendar.move.title", { title: label })}
			onClose={onClose}
			testid="calendar-move-dialog"
			footer={
				<>
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy || !day || (one && !hour)} onClick={() => void save()} data-testid="calendar-move-save">
						{t("calendar.move.save")}
					</button>
				</>
			}
		>
			{!hourOnly && (
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">{t("calendar.move.day")}</span>
					<input type="date" value={day} min={view.today} onChange={(e) => setDay(e.target.value)} className={fieldInput} data-testid="calendar-move-day" />
				</label>
			)}
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">{t("calendar.move.hour")}</span>
				<input type="time" value={hour} step={300} onChange={(e) => setHour(e.target.value)} className={fieldInput} data-testid="calendar-move-hour" />
			</label>
			{!one && hour && (
				<button type="button" className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setHour("")}>
					{t("calendar.move.noHour")}
				</button>
			)}
			<Failure show={failed} />
		</Dialog>
	);
}

function SplitDialog({ item, view, onClose }: { item: CalendarItem; view: CalendarView; onClose: () => void }) {
	const t = useT();
	const { locale } = useLocale();
	const [first, setFirst] = useState(Math.max(1, Math.round(item.minutes / 2)));
	const [day, setDay] = useState(item.day < view.today ? view.today : item.day);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const days = Array.from({ length: 14 }, (_, i) => addDays(view.today, i));
	const save = async () => {
		setBusy(true);
		const res = await sessionAction({ action: "split", key: item.key, minutes: first, day });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	return (
		<Dialog
			title={t("calendar.split.title", { title: itemLabel(item, view.exams, t), n: item.minutes })}
			onClose={onClose}
			testid="calendar-split-dialog"
			footer={
				<>
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy || item.minutes < 2} onClick={() => void save()} data-testid="calendar-split-save">
						{t("calendar.split.do")}
					</button>
				</>
			}
		>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">{t("calendar.split.first", { n: first })}</span>
				<input type="range" min={1} max={Math.max(1, item.minutes - 1)} value={first} onChange={(e) => setFirst(Number(e.target.value))} data-testid="calendar-split-minutes" />
			</label>
			<label className="flex flex-wrap items-center gap-2 text-sm">
				<span className="text-muted-foreground">{t("calendar.split.second", { n: item.minutes - first })}</span>
				<select value={day} onChange={(e) => setDay(e.target.value)} className={fieldInput} data-testid="calendar-split-day">
					{days.map((d) => (
						<option key={d} value={d}>
							{fmtDay(d, locale, { weekday: "short", day: "numeric", month: "short" })}
						</option>
					))}
				</select>
			</label>
			<p className="text-xs text-muted-foreground">{t("calendar.split.note")}</p>
			<Failure show={failed} />
		</Dialog>
	);
}

function DayMinutesDialog({ day, view, onClose }: { day: CalendarDay; view: CalendarView; onClose: () => void }) {
	const t = useT();
	const { locale } = useLocale();
	const usual = view.settings.weeklyMinutes[weekdayIndex(day.day)] ?? 0;
	const [value, setValue] = useState(String(day.budget));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const save = async (minutes: number | null) => {
		setBusy(true);
		const res = await send("/api/calendar/days", "PUT", { day: day.day, minutes });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	const n = Number(value);
	const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 720;
	return (
		<Dialog
			title={t("calendar.dayMinutes.title", { date: fmtDay(day.day, locale, { weekday: "long", day: "numeric", month: "long" }) })}
			onClose={onClose}
			testid="calendar-day-dialog"
			footer={
				<>
					{day.day in view.dayMinutes && (
						<button type="button" className={quietBtn} disabled={busy} onClick={() => void save(null)}>
							{t("calendar.dayMinutes.reset", { n: usual })}
						</button>
					)}
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy || !valid} onClick={() => void save(n)} data-testid="calendar-day-save">
						{t("calendar.save")}
					</button>
				</>
			}
		>
			<input type="number" min={0} max={720} value={value} onChange={(e) => setValue(e.target.value)} className={fieldInput} aria-label={t("calendar.dayMinutes.title", { date: day.day })} data-testid="calendar-day-minutes" />
			<p className="text-xs text-muted-foreground">{t("calendar.dayMinutes.hint", { n: usual })}</p>
			<Failure show={failed} />
		</Dialog>
	);
}

/** The exam's syllabus points by block, as checkboxes. */
function PointChecks({ exam, value, onChange, planned = [] }: { exam: CalendarExamView | undefined; value: ReadonlySet<string>; onChange: (next: Set<string>) => void; planned?: readonly string[] }) {
	const t = useT();
	if (!exam) return null;
	const blocks: Array<{ title: string; points: CalendarExamView["points"] }> = [];
	for (const p of exam.points) {
		const last = blocks[blocks.length - 1];
		if (last && last.title === p.blockTitle) last.points.push(p);
		else blocks.push({ title: p.blockTitle, points: [p] });
	}
	return (
		<div className="flex flex-col gap-3" data-testid="calendar-point-checks">
			{blocks.map((b, i) => (
				<fieldset key={`${b.title}:${i}`} className="flex flex-col gap-1">
					<legend className="pb-1 text-xs font-medium text-muted-foreground">{b.title}</legend>
					{b.points.map((p) => (
						<label key={p.id} className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								className="mt-1"
								checked={value.has(p.id)}
								onChange={(e) => {
									const next = new Set(value);
									if (e.target.checked) next.add(p.id);
									else next.delete(p.id);
									onChange(next);
								}}
							/>
							<span>
								{p.text}
								{planned.includes(p.id) && <span className="ml-1 text-xs text-muted-foreground">{t("calendar.topics.planned")}</span>}
							</span>
						</label>
					))}
				</fieldset>
			))}
		</div>
	);
}

function TopicsDialog({ dialog, view, onClose }: { dialog: Extract<CalendarDialog, { type: "topics" }>; view: CalendarView; onClose: () => void }) {
	const t = useT();
	const exam = view.exams.find((e) => e.id === dialog.examId);
	const [checked, setChecked] = useState<Set<string>>(new Set(dialog.planned));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const save = async (topics: string[]) => {
		setBusy(true);
		const res = await occurrenceUpdate({ key: dialog.occurrence, [dialog.mode === "planned" ? "planned" : "confirmed"]: topics });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	const confirm = dialog.mode === "confirm";
	return (
		<Dialog
			title={confirm ? t("calendar.topics.confirmTitle", { title: dialog.title, when: dialog.when ?? "" }) : t("calendar.topics.plannedTitle", { title: dialog.title })}
			onClose={onClose}
			testid="calendar-topics-dialog"
			footer={
				<>
					{confirm && (
						<button type="button" className={cn(quietBtn, "mr-auto")} disabled={busy} onClick={() => void save([])} data-testid="calendar-topics-none">
							{t("calendar.topics.none")}
						</button>
					)}
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy} onClick={() => void save([...checked])} data-testid="calendar-topics-save">
						{confirm ? t("calendar.topics.confirm") : t("calendar.save")}
					</button>
				</>
			}
		>
			<p className="text-xs text-muted-foreground">{confirm ? t("calendar.topics.confirmHint") : t("calendar.topics.plannedHint")}</p>
			<PointChecks exam={exam} value={checked} onChange={setChecked} planned={confirm ? dialog.planned : []} />
			<Failure show={failed} />
		</Dialog>
	);
}

function SelfStudyDialog({ dialog, view, onClose }: { dialog: Extract<CalendarDialog, { type: "self" }>; view: CalendarView; onClose: () => void }) {
	const t = useT();
	const exam = view.exams.find((e) => e.id === dialog.examId);
	const [checked, setChecked] = useState<Set<string>>(new Set(dialog.planned));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const answer = async (done: boolean) => {
		setBusy(true);
		const res = await occurrenceUpdate({ key: dialog.occurrence, done, confirmed: done ? [...checked] : [] });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	return (
		<Dialog
			title={t("calendar.self.title", { title: dialog.title, when: dialog.when ?? "" })}
			onClose={onClose}
			testid="calendar-self-dialog"
			footer={
				<>
					<button type="button" className={cn(quietBtn, "mr-auto")} disabled={busy} onClick={() => void answer(false)} data-testid="calendar-self-no">
						{t("calendar.self.no")}
					</button>
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy} onClick={() => void answer(true)} data-testid="calendar-self-yes">
						{t("calendar.self.yes")}
					</button>
				</>
			}
		>
			<p className="text-xs text-muted-foreground">{t("calendar.topics.confirmHint")}</p>
			<PointChecks exam={exam} value={checked} onChange={setChecked} planned={dialog.planned} />
			<Failure show={failed} />
		</Dialog>
	);
}

function EventDialog({ event, view, onClose }: { event: CalendarEvent | null; view: CalendarView; onClose: () => void }) {
	const t = useT();
	const [title, setTitle] = useState(event?.title ?? "");
	const [kind, setKind] = useState<EventKind>(event?.kind ?? "class");
	const [day, setDay] = useState(event?.day ?? view.today);
	const [start, setStart] = useState(event?.start ?? "09:00");
	const [minutes, setMinutes] = useState(String(event?.minutes ?? 60));
	const [weekly, setWeekly] = useState(!!event?.until);
	const [until, setUntil] = useState(event?.until ?? addDays(view.today, 7 * 8));
	const [examId, setExamId] = useState(event?.examId ?? "");
	const [consumes, setConsumes] = useState(event?.consumes ?? true);
	const [planned, setPlanned] = useState<Set<string>>(new Set(event?.planned ?? []));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const exam = view.exams.find((e) => e.id === examId);
	const save = async () => {
		setBusy(true);
		const body = {
			title,
			kind,
			day,
			start,
			minutes: Number(minutes),
			until: weekly ? until : null,
			examId: examId || null,
			consumes,
			planned: examId ? [...planned].filter((p) => exam?.points.some((x) => x.id === p)) : null,
		};
		const res = event ? await send(`/api/calendar/events/${event.id}`, "PUT", body) : await send("/api/calendar/events", "POST", { ...body, until: weekly ? until : undefined, examId: examId || undefined, planned: body.planned ?? undefined });
		setBusy(false);
		if (res.ok) onClose();
		else setFailed(true);
	};
	const label = "flex flex-col gap-1 text-sm";
	return (
		<Dialog
			title={t(event ? "calendar.form.edit" : "calendar.form.add")}
			onClose={onClose}
			testid="calendar-event-dialog"
			footer={
				<>
					<button type="button" className={quietBtn} onClick={onClose}>
						{t("calendar.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy || !title.trim()} onClick={() => void save()} data-testid="calendar-event-save">
						{t("calendar.save")}
					</button>
				</>
			}
		>
			<label className={label}>
				<span className="text-muted-foreground">{t("calendar.form.name")}</span>
				<input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldInput} data-testid="calendar-event-title" />
			</label>
			<label className={label}>
				<span className="text-muted-foreground">{t("calendar.form.kind")}</span>
				<select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} className={fieldInput} data-testid="calendar-event-kind">
					{EVENT_KINDS.map((k) => (
						<option key={k} value={k}>
							{t(KIND_KEY[k])}
						</option>
					))}
				</select>
			</label>
			<div className="grid grid-cols-3 gap-2">
				<label className={label}>
					<span className="text-muted-foreground">{t("calendar.form.day")}</span>
					<input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={fieldInput} data-testid="calendar-event-day" />
				</label>
				<label className={label}>
					<span className="text-muted-foreground">{t("calendar.form.hour")}</span>
					<input type="time" value={start} step={300} onChange={(e) => setStart(e.target.value)} className={fieldInput} data-testid="calendar-event-start" />
				</label>
				<label className={label}>
					<span className="text-muted-foreground">{t("calendar.form.minutes")}</span>
					<input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={fieldInput} data-testid="calendar-event-minutes" />
				</label>
			</div>
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} data-testid="calendar-event-weekly" />
					{t("calendar.form.repeat")}
				</label>
				{weekly && (
					<label className="flex items-center gap-2">
						<span className="text-muted-foreground">{t("calendar.form.until")}</span>
						<input type="date" value={until} min={day} onChange={(e) => setUntil(e.target.value)} className={fieldInput} />
					</label>
				)}
			</div>
			<label className={label}>
				<span className="text-muted-foreground">{t("calendar.form.exam")}</span>
				<select value={examId} onChange={(e) => setExamId(e.target.value)} className={fieldInput} data-testid="calendar-event-exam">
					<option value="">{t("calendar.form.noExam")}</option>
					{view.exams.map((e) => (
						<option key={e.id} value={e.id}>
							{e.title}
						</option>
					))}
				</select>
			</label>
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" checked={consumes} onChange={(e) => setConsumes(e.target.checked)} data-testid="calendar-event-consumes" />
				{t("calendar.form.consumes")}
			</label>
			{exam && (
				<div className="flex flex-col gap-2">
					<span className="text-sm text-muted-foreground">{t("calendar.form.planned")}</span>
					<PointChecks exam={exam} value={planned} onChange={setPlanned} />
				</div>
			)}
			{failed && (
				<p role="alert" className="text-xs text-warn">
					{t("calendar.form.error")}
				</p>
			)}
		</Dialog>
	);
}

export function DialogHost({ dialog, view, onClose }: { dialog: CalendarDialog | null; view: CalendarView; onClose: () => void }) {
	if (!dialog) return null;
	switch (dialog.type) {
		case "move":
			return <MoveDialog item={dialog.item} hourOnly={dialog.hourOnly} view={view} onClose={onClose} />;
		case "moveOne":
			return <MoveDialog item={dialog.item} view={view} onClose={onClose} one />;
		case "split":
			return <SplitDialog item={dialog.item} view={view} onClose={onClose} />;
		case "dayMinutes":
			return <DayMinutesDialog day={dialog.day} view={view} onClose={onClose} />;
		case "topics":
			return <TopicsDialog dialog={dialog} view={view} onClose={onClose} />;
		case "self":
			return <SelfStudyDialog dialog={dialog} view={view} onClose={onClose} />;
		case "event":
			return <EventDialog event={dialog.event} view={view} onClose={onClose} />;
	}
}

// ─── a card's ⋯ menu ────────────────────────────────────────────────────────

/** The occurrence's day and hour, for dialog titles. */
function whenOf(day: string, start: string | undefined, locale: string): string {
	const d = fmtDay(day, locale, { weekday: "short", day: "numeric" });
	return start ? `${d}, ${start}` : d;
}

/** What the confirm/topics entries open for an event card. */
export function eventDialogFor(item: CalendarItem, view: CalendarView, mode: "planned" | "confirm", locale: string): CalendarDialog | null {
	if (!item.examId || !item.occurrence) return null;
	const pending = view.toConfirm.find((c) => c.key === item.occurrence);
	const series = item.occurrence.split("@")[0]!;
	const ev = view.events.find((e) => e.id === series);
	const planned = pending?.planned ?? ev?.planned ?? view.series.find((s) => s.seriesKey === series)?.meta.planned ?? [];
	const base = { occurrence: item.occurrence, title: item.title ?? "", examId: item.examId, planned, when: whenOf(item.day, item.start, locale) };
	if (mode === "confirm" && item.kind === "selfStudy") return { type: "self", ...base };
	return { type: "topics", ...base, mode };
}

function ItemMenu({
	item,
	view,
	anchorRef,
	onClose,
	openDialog,
}: {
	item: CalendarItem;
	view: CalendarView;
	anchorRef: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	openDialog: (d: CalendarDialog) => void;
}) {
	const t = useT();
	const { locale } = useLocale();
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-np-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [anchorRef, onClose]);
	const act = (fn: () => void) => () => {
		onClose();
		fn();
	};
	const entries: Array<{ label: string; run: () => void; testid: string }> = [];
	if (item.type === "session") {
		if (item.state !== "done") {
			entries.push({ label: t("calendar.menu.move"), run: () => openDialog({ type: "move", item }), testid: "calendar-menu-move" });
			if (item.hour === "fixed") entries.push({ label: t("calendar.menu.clearHour"), run: () => void sessionAction({ action: "move", key: item.key, day: item.day < view.today ? view.today : item.day, start: null }), testid: "calendar-menu-clear-hour" });
			else entries.push({ label: t("calendar.menu.setHour"), run: () => openDialog({ type: "move", item, hourOnly: true }), testid: "calendar-menu-set-hour" });
			if (item.minutes >= 2) entries.push({ label: t("calendar.menu.split"), run: () => openDialog({ type: "split", item }), testid: "calendar-menu-split" });
		}
		if (item.pinned && item.pinned.parts > 1) entries.push({ label: t("calendar.menu.merge"), run: () => void sessionAction({ action: "merge", key: item.key }), testid: "calendar-menu-merge" });
		if (item.pinned?.anchored) entries.push({ label: t("calendar.menu.release"), run: () => void sessionAction({ action: "release", key: item.key }), testid: "calendar-menu-release" });
	} else if (item.occurrence) {
		const ended = item.state === "done";
		if (item.examId && !ended && item.kind !== "selfStudy") {
			const d = eventDialogFor(item, view, "planned", locale);
			if (d) entries.push({ label: t("calendar.menu.topics"), run: () => openDialog(d), testid: "calendar-menu-topics" });
		}
		if (item.examId && ended) {
			const d = eventDialogFor(item, view, "confirm", locale);
			if (d) entries.push({ label: t("calendar.menu.confirmTopics"), run: () => openDialog(d), testid: "calendar-menu-confirm" });
		}
		if (item.start) entries.push({ label: t("calendar.menu.moveOne"), run: () => openDialog({ type: "moveOne", item }), testid: "calendar-menu-move-one" });
		entries.push(
			item.cancelled
				? { label: t("calendar.menu.restore"), run: () => void occurrenceUpdate({ key: item.occurrence, cancelled: false }), testid: "calendar-menu-restore" }
				: { label: t("calendar.menu.cancelOne"), run: () => void occurrenceUpdate({ key: item.occurrence, cancelled: true }), testid: "calendar-menu-cancel" },
		);
		const ev = item.source === "manual" ? view.events.find((e) => e.id === item.occurrence!.split("@")[0]) : undefined;
		if (ev) entries.push({ label: t("calendar.menu.editEvent"), run: () => openDialog({ type: "event", event: ev }), testid: "calendar-menu-edit" });
	}
	if (entries.length === 0) return null;
	return (
		<MenuShell anchorRef={anchorRef} testid="calendar-item-menu" preferredSide="down" menuClass="w-56 rounded-xl border bg-popover p-1.5 shadow-float">
			<div role="menu">
				{entries.map((e) => (
					<button key={e.testid} type="button" role="menuitem" className={menuItem} onClick={act(e.run)} data-testid={e.testid}>
						{e.label}
					</button>
				))}
			</div>
		</MenuShell>
	);
}

function MenuButton({ item, view, openDialog }: { item: CalendarItem; view: CalendarView; openDialog: (d: CalendarDialog) => void }) {
	const t = useT();
	const ref = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	return (
		<>
			<button
				ref={ref}
				type="button"
				aria-label={t("calendar.menu.label", { title: itemLabel(item, view.exams, t) })}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				data-testid="calendar-item-menu-button"
			>
				<MoreHorizontalIcon className="size-4" />
			</button>
			{open && <ItemMenu item={item} view={view} anchorRef={ref} onClose={close} openDialog={openDialog} />}
		</>
	);
}

// ─── a card row (Agenda, Inicio, exam page) ─────────────────────────────────

export function ItemRow({
	item,
	view,
	start,
	openDialog,
	showDay,
	menu = true,
}: {
	item: CalendarItem;
	view: CalendarView;
	start: ReturnType<typeof useStartCalendar>;
	openDialog: (d: CalendarDialog) => void;
	showDay?: boolean;
	menu?: boolean;
}) {
	const t = useT();
	const { locale } = useLocale();
	const label = itemLabel(item, view.exams, t);
	const done = item.state === "done";
	const isEvent = item.type === "event";
	const meta: string[] = [t("calendar.item.minutes", { n: Math.round(item.minutes) })];
	if (showDay) meta.unshift(fmtDay(item.day, locale, { weekday: "short", day: "numeric" }));
	if (isEvent && item.consumes && !item.cancelled) meta.push(t("calendar.item.counts"));
	if (isEvent && item.source === "feed") meta.push(t("calendar.item.imported"));
	if (item.cancelled) meta.push(t("calendar.item.cancelled"));
	if (done && !isEvent) meta.push(t("calendar.item.done"));
	return (
		<li className={cn("flex min-h-14 items-center gap-3 border-b px-4 py-2.5 last:border-b-0", done && "text-muted-foreground")} data-testid="calendar-item" data-kind={item.kind} data-state={item.state}>
			<span
				className={cn("w-12 shrink-0 text-sm tabular-nums", item.hour === "suggested" && "text-muted-foreground")}
				title={item.hour === "suggested" ? t("calendar.item.suggested") : undefined}
			>
				{done && !isEvent ? <CheckIcon className="size-4 text-ok" aria-hidden="true" /> : item.start ? (item.hour === "suggested" ? `·${item.start}·` : item.start) : null}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium", item.cancelled && "line-through")} title={label}>
					{item.pinned?.anchored && <PinIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("calendar.item.anchored")} />}
					{isEvent && <span aria-hidden="true" className="size-2 shrink-0 rounded-sm bg-muted-foreground/60" />}
					<span className="truncate">{label}</span>
				</span>
				<span className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</span>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{!isEvent && !done && (
					<button type="button" className={quietBtn} disabled={start.starting !== null} onClick={() => void start.start(item.key)} data-testid="calendar-start">
						{start.starting === item.key ? t("calendar.starting") : item.state === "inProgress" || item.pinned?.chatId ? t("calendar.continue") : t("calendar.start")}
					</button>
				)}
				{menu && <MenuButton item={item} view={view} openDialog={openDialog} />}
			</div>
		</li>
	);
}

/** «Atrasadas» and «¿Qué se dio?» (Agenda and Inicio, first when any). */
function Pending({ view, openDialog, start }: { view: CalendarView; openDialog: (d: CalendarDialog) => void; start: ReturnType<typeof useStartCalendar> }) {
	const t = useT();
	const { locale } = useLocale();
	if (view.late.length === 0 && view.toConfirm.length === 0) return null;
	return (
		<div className="flex flex-col gap-3" data-testid="calendar-pending">
			{view.late.length > 0 && (
				<Section title={t("calendar.late.title", { n: view.late.length })} testid="calendar-late">
					<ListCard>
						{view.late.map((item) => (
							<li key={item.key} className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex items-center gap-1.5 truncate text-sm font-medium">
										<PinIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
										{itemLabel(item, view.exams, t)}
									</span>
									<span className="text-xs text-muted-foreground">
										{t("calendar.item.minutes", { n: item.minutes })} · {fmtDay(item.day, locale, { weekday: "short", day: "numeric" })}
									</span>
								</div>
								<div className="flex shrink-0 gap-2">
									<button type="button" className={quietBtn} onClick={() => openDialog({ type: "move", item })} data-testid="calendar-late-reschedule">
										{t("calendar.late.reschedule")}
									</button>
									<button type="button" className={quietBtn} onClick={() => void sessionAction({ action: "release", key: item.key })} data-testid="calendar-late-discard">
										{t("calendar.late.discard")}
									</button>
								</div>
							</li>
						))}
					</ListCard>
					{start.failed && <p role="alert" className="px-1 text-xs text-warn">{t("calendar.startFailed")}</p>}
				</Section>
			)}
			{view.toConfirm.length > 0 && (
				<ListCard testid="calendar-to-confirm">
					{view.toConfirm.map((c) => {
						const self = c.kind === "selfStudy";
						const base = { occurrence: c.key, title: c.title, examId: c.examId, planned: c.planned, when: whenOf(c.day, c.start, locale) };
						return (
							<li key={c.key} className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
								<span className="min-w-0 flex-1 truncate text-sm font-medium">
									{self ? t("calendar.confirm.askSelf", { title: c.title }) : t("calendar.confirm.ask", { title: c.title })}
									<span className="ml-1 text-xs font-normal text-muted-foreground">({base.when})</span>
								</span>
								<button
									type="button"
									className={quietBtn}
									onClick={() => openDialog(self ? { type: "self", ...base } : { type: "topics", ...base, mode: "confirm" })}
									data-testid="calendar-confirm-open"
								>
									{self ? t("calendar.confirm.answer") : t("calendar.confirm.mark")}
								</button>
							</li>
						);
					})}
				</ListCard>
			)}
		</div>
	);
}

// ─── Agenda ─────────────────────────────────────────────────────────────────

function EstimateRow({ label }: { label: string }) {
	const t = useT();
	return (
		<li className="flex min-h-12 items-center gap-3 border-b px-4 py-2 text-sm text-muted-foreground last:border-b-0" data-testid="calendar-estimate">
			<span className="w-12 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="shrink-0 text-xs">{t("calendar.day.estimate")}</span>
		</li>
	);
}

function DayBlock({ day, view, openDialog, start }: { day: CalendarDay; view: CalendarView; openDialog: (d: CalendarDialog) => void; start: ReturnType<typeof useStartCalendar> }) {
	const t = useT();
	const { locale } = useLocale();
	const used = usedMinutes(day);
	const sessions = day.items.filter((i) => i.state !== "done" || i.type === "event");
	const done = day.items.filter((i) => i.state === "done" && i.type === "session");
	const ordered = [...sessions, ...done];
	// Minutes the plan holds for an exam whose sessions are not known yet
	// (they depend on the placement test).
	const estimates = Object.entries(day.unscheduled ?? {}).filter(([, m]) => m >= 1);
	return (
		<section className="flex flex-col gap-2" data-testid="calendar-day" data-day={day.day}>
			<SectionTitle
				right={
					<span className="flex items-center gap-1 text-sm text-muted-foreground">
						<span className="tabular-nums">{t("calendar.day.budget", { used, budget: day.budget })}</span>
						{day.day >= view.today && (
							<button
								type="button"
								aria-label={t("calendar.day.edit", { date: fmtDay(day.day, locale, { weekday: "long", day: "numeric" }) })}
								onClick={() => openDialog({ type: "dayMinutes", day })}
								className="flex size-8 items-center justify-center rounded-lg hover:bg-accent hover:text-foreground"
								data-testid="calendar-day-edit"
							>
								<PencilIcon className="size-3.5" />
							</button>
						)}
					</span>
				}
			>
				{dayTitle(day.day, view.today, locale, t)}
			</SectionTitle>
			{!day.concrete ? (
				<ListCard>
					{Object.entries(day.examMinutes).filter(([, m]) => m >= 1).length === 0 && day.items.length === 0 ? (
						<li className="px-4 py-3 text-sm text-muted-foreground">{t("calendar.day.empty")}</li>
					) : (
						<>
							{day.items.map((item) => (
								<ItemRow key={item.key} item={item} view={view} start={start} openDialog={openDialog} />
							))}
							{Object.entries(day.examMinutes)
								.filter(([, m]) => m >= 1)
								.map(([examId, m]) => (
									<EstimateRow key={examId} label={t("calendar.estimate", { exam: view.exams.find((e) => e.id === examId)?.title ?? "", min: Math.round(m) })} />
								))}
						</>
					)}
				</ListCard>
			) : ordered.length === 0 && estimates.length === 0 ? (
				<p className="px-1 text-sm text-muted-foreground">{t("calendar.day.empty")}</p>
			) : (
				<ListCard>
					{ordered.map((item) => (
						<ItemRow key={item.key} item={item} view={view} start={start} openDialog={openDialog} />
					))}
					{estimates.map(([examId, m]) => (
						<EstimateRow key={examId} label={t("calendar.estimate", { exam: view.exams.find((e) => e.id === examId)?.title ?? "", min: Math.round(m) })} />
					))}
				</ListCard>
			)}
		</section>
	);
}

function AgendaTab({ from, openDialog }: { from: string | null; openDialog: (d: CalendarDialog, view: CalendarView) => void }) {
	const t = useT();
	const [extra, setExtra] = useState(0);
	useEffect(() => setExtra(0), [from]);
	// No chosen day: the default range (today + 6) tells today; «Ver más
	// días» then grows the window from it.
	const { data: base } = useCalendar(null);
	const origin = from ?? base?.today ?? null;
	const { data: ranged } = useCalendar(origin && (from || extra > 0) ? { from: origin, to: addDays(origin, 6 + extra) } : "wait");
	const start = useStartCalendar();
	const view = from || extra > 0 ? (ranged ?? (extra > 0 ? base : undefined)) : base;
	if (view === undefined) return <p className="px-1 text-sm text-muted-foreground">{t("calendar.loading")}</p>;
	if (view === null) return <p className="px-1 text-sm text-warn">{t("calendar.loadFailed")}</p>;
	const open = (d: CalendarDialog) => openDialog(d, view);
	return (
		<div className="flex flex-col gap-8" data-testid="calendar-agenda">
			<Pending view={view} openDialog={open} start={start} />
			{view.days.map((day) => (
				<DayBlock key={day.day} day={day} view={view} openDialog={open} start={start} />
			))}
			{start.failed && <p role="alert" className="px-1 text-xs text-warn">{t("calendar.startFailed")}</p>}
			{6 + extra < 55 && (
				<button type="button" className={cn(quietBtn, "self-center")} onClick={() => setExtra((x) => x + 7)} data-testid="calendar-more">
					{t("calendar.more")}
				</button>
			)}
		</div>
	);
}

// ─── Semana (hour grid) ─────────────────────────────────────────────────────

const GRID_FROM = 7 * 60;
const GRID_TO = 23 * 60;
const HOUR_PX = 48;
const SNAP = 15;
const px = (minutes: number) => (minutes * HOUR_PX) / 60;

function useNarrow(): boolean {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 640px)");
		const on = () => setNarrow(mq.matches);
		on();
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return narrow;
}

/** Side-by-side lanes for overlapping timed cards in one column. Pure. */
export function lanes(items: ReadonlyArray<{ key: string; start: number; end: number }>): Map<string, { lane: number; of: number }> {
	const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
	const out = new Map<string, { lane: number; of: number }>();
	let group: Array<{ key: string; end: number; lane: number }> = [];
	let groupEnd = -1;
	const flush = () => {
		const of = group.reduce((m, g) => Math.max(m, g.lane + 1), 0);
		for (const g of group) out.set(g.key, { lane: g.lane, of });
		group = [];
	};
	for (const it of sorted) {
		if (it.start >= groupEnd && group.length) flush();
		const used = new Set(group.filter((g) => g.end > it.start).map((g) => g.lane));
		let lane = 0;
		while (used.has(lane)) lane++;
		group.push({ key: it.key, end: it.end, lane });
		groupEnd = Math.max(groupEnd, it.end);
	}
	if (group.length) flush();
	return out;
}

interface Drag {
	item: CalendarItem;
	mode: "move" | "resize";
	x0: number;
	y0: number;
	moved: boolean;
	day: string;
	start: number;
	minutes: number;
}

function WeekTab({ openDialog }: { openDialog: (d: CalendarDialog, view: CalendarView) => void }) {
	const t = useT();
	const { locale } = useLocale();
	const narrow = useNarrow();
	const [anchor, setAnchor] = useState<string | null>(null);
	const { data: first } = useCalendar(null);
	const today = first?.today ?? null;
	const from = anchor ?? (today ? (narrow ? today : mondayOf(today)) : null);
	const span = narrow ? 3 : 7;
	const { data } = useCalendar(from ? { from, to: addDays(from, span - 1) } : "wait");
	const view = data ?? undefined;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [menu, setMenu] = useState<{ item: CalendarItem; el: HTMLElement } | null>(null);
	const menuRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = px(16 * 60 - GRID_FROM) - 40;
	}, [view?.today]);
	if (!from || view === undefined) return <p className="px-1 text-sm text-muted-foreground">{t("calendar.loading")}</p>;
	const days = view.days.slice(0, span);
	const open = (d: CalendarDialog) => openDialog(d, view);
	const colAt = (clientX: number): number => {
		const rect = gridRef.current!.getBoundingClientRect();
		const w = rect.width / days.length;
		return Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / w)));
	};
	const minuteAt = (clientY: number): number => {
		const rect = gridRef.current!.getBoundingClientRect();
		const m = GRID_FROM + ((clientY - rect.top) * 60) / HOUR_PX;
		return Math.max(GRID_FROM, Math.min(GRID_TO - SNAP, Math.round(m / SNAP) * SNAP));
	};
	const onDown = (e: React.PointerEvent<HTMLElement>, item: CalendarItem, mode: "move" | "resize") => {
		if (item.type !== "session" || item.state === "done") {
			if (mode === "move" && e.button === 0) {
				menuRef.current = e.currentTarget;
				setMenu({ item, el: e.currentTarget });
			}
			return;
		}
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		setDrag({ item, mode, x0: e.clientX, y0: e.clientY, moved: false, day: item.day, start: item.start ? clockToMinutes(item.start) : GRID_FROM, minutes: item.minutes });
	};
	const onMove = (e: React.PointerEvent) => {
		if (!drag || !gridRef.current) return;
		const moved = drag.moved || Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4;
		if (!moved) return;
		if (drag.mode === "resize") {
			const end = minuteAt(e.clientY);
			setDrag({ ...drag, moved, minutes: Math.max(5, end - drag.start) });
		} else setDrag({ ...drag, moved, day: days[colAt(e.clientX)]!.day, start: minuteAt(e.clientY - px(Math.min(drag.minutes, 60)) / 2) });
	};
	const onUp = (e: React.PointerEvent<HTMLElement>) => {
		if (!drag) return;
		const d = drag;
		setDrag(null);
		if (!d.moved) {
			menuRef.current = e.currentTarget;
			setMenu({ item: d.item, el: e.currentTarget });
			return;
		}
		if (d.mode === "resize") void sessionAction({ action: "resize", key: d.item.key, minutes: d.minutes });
		else if (d.day >= view.today) void sessionAction({ action: "move", key: d.item.key, day: d.day, start: minutesToClock(d.start) });
	};
	const hours = Array.from({ length: (GRID_TO - GRID_FROM) / 60 }, (_, i) => GRID_FROM / 60 + i);
	return (
		<div className="flex flex-col gap-3" data-testid="calendar-week">
			<div className="flex flex-wrap items-center gap-2 px-1">
				<button type="button" aria-label={t("calendar.week.prev")} className={cn(quietBtn, "px-2")} onClick={() => setAnchor(addDays(from, -span))}>
					<ChevronLeftIcon className="size-4" />
				</button>
				<span className="min-w-40 text-center text-sm font-medium">
					{fmtDay(days[0]!.day, locale, { day: "numeric", month: "short" })} – {fmtDay(days[days.length - 1]!.day, locale, { day: "numeric", month: "short", year: "numeric" })}
				</span>
				<button type="button" aria-label={t("calendar.week.next")} className={cn(quietBtn, "px-2")} onClick={() => setAnchor(addDays(from, span))}>
					<ChevronRightIcon className="size-4" />
				</button>
				<button type="button" className={quietBtn} onClick={() => setAnchor(null)}>
					{t("calendar.week.today")}
				</button>
			</div>
			<div className="overflow-hidden rounded-xl border">
				{/* Day heads + the «sin hora» row. */}
				<div className="grid border-b" style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}>
					<div className="px-1 py-2 text-[10px] text-muted-foreground">{t("calendar.week.noHour")}</div>
					{days.map((d) => (
						<div key={d.day} className={cn("flex min-w-0 flex-col gap-1 border-l px-1 py-2", d.day === view.today && "bg-accent/40")}>
							<span className="truncate text-xs font-medium">{capitalize(fmtDay(d.day, locale, { weekday: "short", day: "numeric" }))}</span>
							{d.items
								.filter((i) => !i.start)
								.map((i) => (
									<button
										key={i.key}
										type="button"
										onPointerDown={(e) => onDown(e, i, "move")}
										onPointerMove={onMove}
										onPointerUp={onUp}
										className={cn("touch-none truncate rounded-md border px-1.5 py-0.5 text-left text-[11px]", i.state === "done" ? "text-muted-foreground line-through" : "bg-background")}
										title={itemLabel(i, view.exams, t)}
										data-testid="calendar-week-chip"
									>
										{itemLabel(i, view.exams, t)} · {Math.round(i.minutes)}m
									</button>
								))}
						</div>
					))}
				</div>
				<div ref={scrollRef} className="max-h-[60vh] overflow-y-auto">
					<div className="grid" style={{ gridTemplateColumns: `3rem minmax(0, 1fr)` }}>
						<div className="relative" style={{ height: px(GRID_TO - GRID_FROM) }}>
							{hours.map((h) => (
								<span key={h} className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: px(h * 60 - GRID_FROM) }}>
									{h > GRID_FROM / 60 ? `${String(h).padStart(2, "0")}:00` : ""}
								</span>
							))}
						</div>
						<div ref={gridRef} className="relative grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, height: px(GRID_TO - GRID_FROM) }}>
							{days.map((d) => {
								const slots = view.settings.slots.filter((s) => s.weekday === weekdayIndex(d.day));
								const timed = d.items.filter((i) => i.start);
								const lane = lanes(timed.map((i) => ({ key: i.key, start: clockToMinutes(i.start!), end: clockToMinutes(i.start!) + Math.max(15, i.minutes) })));
								return (
									<div key={d.day} className={cn("relative border-l", d.day === view.today && "bg-accent/20")}>
										{hours.map((h) => (
											<div key={h} className="absolute inset-x-0 border-t border-border/50" style={{ top: px(h * 60 - GRID_FROM) }} />
										))}
										{slots.map((s, k) => (
											<div key={k} className="absolute inset-x-0 bg-primary/5" style={{ top: px(clockToMinutes(s.start) - GRID_FROM), height: px(clockToMinutes(s.end) - clockToMinutes(s.start)) }} />
										))}
										{timed.map((i) => {
											const m = clockToMinutes(i.start!);
											const l = lane.get(i.key) ?? { lane: 0, of: 1 };
											const event = i.type === "event";
											const label = itemLabel(i, view.exams, t);
											return (
												<div
													key={i.key}
													role="button"
													tabIndex={0}
													aria-label={`${i.start} ${label}`}
													onPointerDown={(e) => onDown(e, i, "move")}
													onPointerMove={onMove}
													onPointerUp={onUp}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															menuRef.current = e.currentTarget;
															setMenu({ item: i, el: e.currentTarget });
														}
													}}
													className={cn(
														"absolute touch-none select-none overflow-hidden rounded-md px-1.5 py-0.5 text-[11px] leading-tight",
														event
															? i.source === "feed"
																? "bg-muted text-muted-foreground"
																: "bg-foreground/80 text-background"
															: i.hour === "suggested"
																? "border border-dashed border-primary/60 bg-background"
																: "border border-primary/60 bg-primary/10",
														i.cancelled && "line-through opacity-60",
														i.state === "done" && !event && "opacity-60",
														drag?.item.key === i.key && drag.moved && "opacity-30",
													)}
													style={{ top: px(m - GRID_FROM), height: Math.max(18, px(i.minutes)), left: `${(l.lane / l.of) * 100}%`, width: `${100 / l.of}%` }}
													data-testid="calendar-week-card"
													data-kind={i.kind}
												>
													<span className="flex items-center gap-1 truncate font-medium">
														{i.pinned?.anchored && <PinIcon className="size-3 shrink-0" aria-hidden="true" />}
														{label}
													</span>
													<span className="block truncate opacity-80">{Math.round(i.minutes)}m</span>
													{!event && i.state !== "done" && (
														<span
															aria-label={t("calendar.week.resize", { title: label })}
															onPointerDown={(e) => onDown(e, i, "resize")}
															onPointerMove={onMove}
															onPointerUp={onUp}
															className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
														/>
													)}
												</div>
											);
										})}
										{drag?.moved && drag.day === d.day && (
											<div className="pointer-events-none absolute inset-x-0 rounded-md border-2 border-primary bg-primary/10" style={{ top: px(drag.start - GRID_FROM), height: Math.max(18, px(drag.minutes)) }}>
												<span className="px-1 text-[11px] font-medium">{minutesToClock(drag.start)}</span>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</div>
			</div>
			{menu && (
				<ItemMenu
					item={menu.item}
					view={view}
					anchorRef={menuRef}
					onClose={() => setMenu(null)}
					openDialog={open}
				/>
			)}
		</div>
	);
}

// ─── Mes ────────────────────────────────────────────────────────────────────

/** The month grid's days: Monday on/before the 1st → Sunday on/after
 *  the last. Pure. */
export function monthGrid(month: string): string[] {
	const [y, m] = month.split("-").map(Number);
	const first = `${y}-${String(m).padStart(2, "0")}-01`;
	const lastDate = new Date(y!, m!, 0).getDate();
	const last = `${y}-${String(m).padStart(2, "0")}-${String(lastDate).padStart(2, "0")}`;
	const from = mondayOf(first);
	const to = addDays(last, 6 - weekdayIndex(last));
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

function MonthTab({ onOpenDay }: { onOpenDay: (day: string) => void }) {
	const t = useT();
	const { locale } = useLocale();
	const { data: first } = useCalendar(null);
	const [month, setMonth] = useState<string | null>(null);
	const current = month ?? first?.today.slice(0, 7) ?? null;
	const grid = useMemo(() => (current ? monthGrid(current) : []), [current]);
	const { data } = useCalendar(grid.length ? { from: grid[0]!, to: grid[grid.length - 1]! } : "wait");
	if (!current || !data) return <p className="px-1 text-sm text-muted-foreground">{t("calendar.loading")}</p>;
	const shift = (n: number) => {
		const [y, m] = current.split("-").map(Number);
		const d = new Date(y!, m! - 1 + n, 1);
		setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
	};
	const byDay = new Map(data.days.map((d) => [d.day, d]));
	const examsOn = (day: string) => data.exams.filter((e) => e.examDate === day);
	const heads = grid.slice(0, 7).map((d) => capitalize(fmtDay(d, locale, { weekday: "short" })));
	return (
		<div className="flex flex-col gap-3" data-testid="calendar-month">
			<div className="flex items-center gap-2 px-1">
				<button type="button" aria-label={t("calendar.month.prev")} className={cn(quietBtn, "px-2")} onClick={() => shift(-1)}>
					<ChevronLeftIcon className="size-4" />
				</button>
				<span className="min-w-40 text-center text-sm font-medium">{capitalize(new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(`${current}-15T12:00:00`)))}</span>
				<button type="button" aria-label={t("calendar.month.next")} className={cn(quietBtn, "px-2")} onClick={() => shift(1)}>
					<ChevronRightIcon className="size-4" />
				</button>
			</div>
			<div className="grid grid-cols-7 overflow-hidden rounded-xl border">
				{heads.map((h, i) => (
					<div key={i} className="border-b px-1.5 py-1 text-xs text-muted-foreground">
						{h}
					</div>
				))}
				{grid.map((d) => {
					const day = byDay.get(d);
					const inMonth = d.startsWith(current);
					const used = day ? usedMinutes(day) : 0;
					const budget = day?.budget ?? 0;
					const events = day?.items.filter((i) => i.type === "event" && !i.cancelled).length ?? 0;
					const exams = examsOn(d);
					return (
						<button
							key={d}
							type="button"
							onClick={() => onOpenDay(d)}
							aria-label={t("calendar.month.open", { date: fmtDay(d, locale, { weekday: "long", day: "numeric", month: "long" }) })}
							className={cn("flex min-h-20 min-w-0 flex-col gap-1 border-b border-l p-1.5 text-left transition-colors hover:bg-accent/50", !inMonth && "opacity-40", d === data.today && "bg-accent/40")}
							data-testid="calendar-month-day"
						>
							<span className="text-xs font-medium tabular-nums">{Number(d.slice(8))}</span>
							{budget > 0 || used > 0 ? (
								<>
									<span className="text-[10px] tabular-nums text-muted-foreground">{t("calendar.month.load", { planned: used, budget })}</span>
									<span className="h-1 w-full overflow-hidden rounded-full bg-muted">
										<span className={cn("block h-full rounded-full", used > budget ? "bg-warn" : "bg-[var(--np-data)]")} style={{ width: `${budget ? Math.min(100, (used / budget) * 100) : 100}%` }} />
									</span>
								</>
							) : null}
							{events > 0 && <span className="text-[10px] text-muted-foreground">{"•".repeat(Math.min(events, 4))}</span>}
							{exams.map((e) => (
								<span key={e.id} className="truncate text-[10px] font-medium text-primary">
									{t("calendar.month.exam", { exam: e.title })}
								</span>
							))}
						</button>
					);
				})}
			</div>
		</div>
	);
}

// ─── Eventos ────────────────────────────────────────────────────────────────

function EventsTab({ openDialog }: { openDialog: (d: CalendarDialog, view: CalendarView) => void }) {
	const t = useT();
	const { locale } = useLocale();
	const { data: view, reload } = useCalendar(null);
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [adding, setAdding] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	if (!view) return <p className="px-1 text-sm text-muted-foreground">{view === null ? t("calendar.loadFailed") : t("calendar.loading")}</p>;
	const subscribe = async () => {
		setAdding(true);
		setAddError(null);
		const res = await send("/api/calendar/feeds", "POST", { url, ...(name.trim() ? { name } : {}) });
		setAdding(false);
		if (!res.ok) setAddError(String(res.body.error ?? ""));
		else {
			setUrl("");
			setName("");
			reload();
		}
	};
	const examTitle = (id?: string) => view.exams.find((e) => e.id === id)?.title;
	return (
		<div className="flex flex-col gap-8" data-testid="calendar-events">
			<Section
				title={t("calendar.events.title")}
				right={
					<button type="button" className={primaryBtn} onClick={() => openDialog({ type: "event", event: null }, view)} data-testid="calendar-event-add">
						{t("calendar.events.add")}
					</button>
				}
			>
				{view.events.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">{t("calendar.events.empty")}</p>
				) : (
					<ListCard>
						{view.events.map((e) => (
							<li key={e.id} className="flex min-h-14 items-center gap-3 border-b px-4 py-2.5 last:border-b-0" data-testid="calendar-event-row">
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="truncate text-sm font-medium">{e.title}</span>
									<span className="truncate text-xs text-muted-foreground">
										{[
											t(KIND_KEY[e.kind]),
											`${fmtDay(e.day, locale, { weekday: "short", day: "numeric", month: "short" })} ${e.start}`,
											t("calendar.item.minutes", { n: e.minutes }),
											e.until ? t("calendar.events.weekly", { date: fmtDay(e.until, locale, { day: "numeric", month: "short" }) }) : null,
											examTitle(e.examId),
											e.consumes ? t("calendar.item.counts") : null,
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</div>
								<button type="button" aria-label={t("calendar.events.edit", { title: e.title })} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => openDialog({ type: "event", event: e }, view)}>
									<PencilIcon className="size-4" />
								</button>
								<button type="button" aria-label={t("calendar.events.delete", { title: e.title })} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-warn" onClick={() => void send(`/api/calendar/events/${e.id}`, "DELETE")} data-testid="calendar-event-delete">
									<Trash2Icon className="size-4" />
								</button>
							</li>
						))}
					</ListCard>
				)}
			</Section>
			<Section title={t("calendar.feeds.title")} testid="calendar-feeds">
				<p className="px-1 text-sm text-muted-foreground">{t("calendar.feeds.hint")}</p>
				<div className="flex flex-wrap items-end gap-2 px-1">
					<label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("calendar.feeds.url")}</span>
						<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/basic.ics" className={fieldInput} data-testid="calendar-feed-url" />
					</label>
					<label className="flex w-40 flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("calendar.feeds.name")}</span>
						<input value={name} onChange={(e) => setName(e.target.value)} className={fieldInput} />
					</label>
					<button type="button" className={primaryBtn} disabled={adding || !url.trim()} onClick={() => void subscribe()} data-testid="calendar-feed-add">
						{t("calendar.feeds.add")}
					</button>
				</div>
				{addError !== null && (
					<p role="alert" className="px-1 text-xs text-warn">
						{t("calendar.feeds.addFailed", { error: addError })}
					</p>
				)}
				{view.feeds.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">{t("calendar.feeds.empty")}</p>
				) : (
					<ListCard>
						{view.feeds.map((f) => (
							<li key={f.id} className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0" data-testid="calendar-feed-row">
								<div className="flex items-center gap-3">
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="truncate text-sm font-medium">{f.name}</span>
										<span className={cn("truncate text-xs", f.error ? "text-warn" : "text-muted-foreground")}>
											{f.error
												? t("calendar.feeds.error", { error: f.error })
												: f.lastFetch
													? t("calendar.feeds.updated", { when: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(f.lastFetch)) })
													: t("calendar.feeds.never")}
										</span>
									</div>
									<button type="button" className={cn(quietBtn, "gap-1")} onClick={() => void send(`/api/calendar/feeds/${f.id}`, "POST")}>
										<RefreshCwIcon className="size-3.5" />
										{t("calendar.feeds.refresh")}
									</button>
									<button type="button" className={quietBtn} onClick={() => void send(`/api/calendar/feeds/${f.id}`, "DELETE")}>
										{t("calendar.feeds.remove")}
									</button>
								</div>
								{view.series
									.filter((s) => s.feedId === f.id)
									.map((s) => (
										<div key={s.seriesKey} className="flex flex-wrap items-center gap-2 pl-3 text-xs" data-testid="calendar-series-row">
											<span className="min-w-0 flex-1 truncate">{t("calendar.feeds.series", { title: s.title })}</span>
											<select
												aria-label={t("calendar.form.exam")}
												value={s.meta.examId ?? ""}
												onChange={(e) => void send("/api/calendar/series", "PUT", { seriesKey: s.seriesKey, examId: e.target.value || null })}
												className={cn(fieldInput, "h-8 text-xs")}
											>
												<option value="">{t("calendar.form.noExam")}</option>
												{view.exams.map((e) => (
													<option key={e.id} value={e.id}>
														{e.title}
													</option>
												))}
											</select>
											<select
												aria-label={t("calendar.form.kind")}
												value={s.meta.kind ?? "other"}
												onChange={(e) => void send("/api/calendar/series", "PUT", { seriesKey: s.seriesKey, kind: e.target.value })}
												className={cn(fieldInput, "h-8 text-xs")}
											>
												{EVENT_KINDS.map((k) => (
													<option key={k} value={k}>
														{t(KIND_KEY[k])}
													</option>
												))}
											</select>
											<label className="flex items-center gap-1">
												<input type="checkbox" checked={s.meta.consumes === true} onChange={(e) => void send("/api/calendar/series", "PUT", { seriesKey: s.seriesKey, consumes: e.target.checked })} />
												{t("calendar.item.counts")}
											</label>
										</div>
									))}
							</li>
						))}
					</ListCard>
				)}
			</Section>
		</div>
	);
}

// ─── the page ───────────────────────────────────────────────────────────────

export const CALENDAR_TABS = ["agenda", "week", "month", "events"] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number];
export const calendarTabFromParam = (v: string | null | undefined): CalendarTab => ((CALENDAR_TABS as readonly string[]).includes(v ?? "") ? (v as CalendarTab) : "agenda");

export function CalendarPage({ initialTab, initialDay }: { initialTab?: string; initialDay?: string }) {
	const t = useT();
	const [tab, setTab] = useState<CalendarTab>(calendarTabFromParam(initialTab));
	const [day, setDay] = useState<string | null>(initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay) ? initialDay : null);
	const [dialog, setDialog] = useState<{ d: CalendarDialog; view: CalendarView } | null>(null);
	const change = (next: CalendarTab, nextDay: string | null = null) => {
		setTab(next);
		setDay(nextDay);
		const params = new URLSearchParams();
		if (next !== "agenda") params.set("tab", next);
		if (nextDay) params.set("day", nextDay);
		const q = params.toString();
		window.history.replaceState(null, "", q ? `/calendar?${q}` : "/calendar");
	};
	const openDialog = useCallback((d: CalendarDialog, view: CalendarView) => setDialog({ d, view }), []);
	const { data: pending } = useCalendar(null);
	const alerts = !!pending && (pending.late.length > 0 || pending.toConfirm.length > 0);
	return (
		<Page testid="calendar-page">
			<PageHeader
				title={t("calendar.title")}
				actions={
					<Link href="/settings/calendar" aria-label={t("calendar.settings")} className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" data-testid="calendar-settings-link">
						<SettingsIcon className="size-5" />
					</Link>
				}
			/>
			<Tabs
				value={tab}
				onChange={(v) => change(v)}
				label={t("calendar.tabs.label")}
				alertLabel={t("calendar.tabs.alert")}
				items={[
					{ value: "agenda", label: t("calendar.tabs.agenda"), alert: alerts && tab !== "agenda", testid: "calendar-tab-agenda" },
					{ value: "week", label: t("calendar.tabs.week"), testid: "calendar-tab-week" },
					{ value: "month", label: t("calendar.tabs.month"), testid: "calendar-tab-month" },
					{ value: "events", label: t("calendar.tabs.events"), testid: "calendar-tab-events" },
				]}
			>
				<TabPanel value="agenda">{tab === "agenda" && <AgendaTab from={day} openDialog={openDialog} />}</TabPanel>
				<TabPanel value="week">{tab === "week" && <WeekTab openDialog={openDialog} />}</TabPanel>
				<TabPanel value="month">{tab === "month" && <MonthTab onOpenDay={(d) => change("agenda", d)} />}</TabPanel>
				<TabPanel value="events">{tab === "events" && <EventsTab openDialog={openDialog} />}</TabPanel>
			</Tabs>
			{dialog && <DialogHost dialog={dialog.d} view={dialog.view} onClose={() => setDialog(null)} />}
		</Page>
	);
}

// ─── Inicio «Hoy» (owner: replaces «Para repasar hoy» + «Hoy para tu examen»)

export function CalendarTodayCard() {
	const t = useT();
	const { data: view } = useCalendar(null);
	const start = useStartCalendar();
	const [dialog, setDialog] = useState<CalendarDialog | null>(null);
	if (!view) return null;
	const today = view.days[0];
	if (!today) return null;
	const items = [...today.items.filter((i) => i.state !== "done" || i.type === "event"), ...today.items.filter((i) => i.state === "done" && i.type === "session")];
	if (items.length === 0 && view.late.length === 0 && view.toConfirm.length === 0) return null;
	return (
		<section className="flex flex-col gap-3" data-testid="calendar-home">
			<SectionTitle
				right={
					<Link href="/calendar" className="text-sm text-muted-foreground transition-colors hover:text-foreground" data-testid="calendar-home-see">
						{t("calendar.home.see")}
					</Link>
				}
			>
				{t("calendar.home.title", { used: usedMinutes(today), budget: today.budget })}
			</SectionTitle>
			<Pending view={view} openDialog={setDialog} start={start} />
			{items.length > 0 && (
				<ListCard>
					{items.map((item) => (
						<ItemRow key={item.key} item={item} view={view} start={start} openDialog={setDialog} menu={false} />
					))}
				</ListCard>
			)}
			{start.failed && <p role="alert" className="px-1 text-xs text-warn">{t("calendar.startFailed")}</p>}
			<DialogHost dialog={dialog} view={view} onClose={() => setDialog(null)} />
		</section>
	);
}

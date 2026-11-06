"use client";
/**
 * REPASO (owner design, 2026-11-04 — stage 3): the forgetting-curve tab.
 * One page, four sections (owner-approved mockup):
 *
 *   Hoy          — today's count by topic + «Empezar repaso»
 *   Tu memoria   — average recall vs the target, recall per topic (meters)
 *   Próximos días — reviews due per day, 7 or 30 days (columns)
 *   Fuentes      — sessions and Obsidian areas, each with its switch; a
 *                  row expands into its ideas (recall, next review, switch)
 *
 * Plus the Inicio card («Para repasar hoy») and the review starter shared
 * with the session's «Siguiente tanda». Data: GET /api/review, refetched
 * on server events that can change it and on window focus.
 *
 * Charts follow the dataviz method: one data hue (--np-data, validated in
 * both themes), single series → no legend, thin marks with rounded data
 * ends, selective labels, hover/focus tooltips that never gate (every
 * value is also in the sr-only tables).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/settings/controls.tsx";
import { useServerEvent } from "@/components/server-events";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { useLocale, useT, type Translate } from "@/components/i18n";
import { buttonVariants } from "@/components/ui/button";
import { Page, PageHeader, SectionTitle } from "@/components/ui/page";
import { ListCard, ListRow } from "@/components/ui/list";
import { ProgressBar } from "@/components/ui/progress-bar";
import { BarChart } from "@/components/ui/bar-chart";
import type { ReviewApiResponse, ReviewArea, ReviewItemView, ReviewSources, ReviewSummary } from "@/src/core";

// ─── data ───────────────────────────────────────────────────────────────────

/** GET /api/review, kept fresh: server events that can move it, focus. */
export function useReview() {
	const [data, setData] = useState<ReviewApiResponse | null | undefined>(undefined);
	const reload = useCallback(() => {
		fetch("/api/review")
			.then((r) => (r.ok ? (r.json() as Promise<ReviewApiResponse>) : Promise.reject(new Error(String(r.status)))))
			.then(setData)
			.catch(() => setData((prev) => (prev === undefined ? null : prev)));
	}, []);
	useEffect(() => {
		reload();
		const onFocus = () => reload();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);
	useServerEvent("turn-settled", reload);
	useServerEvent("chats-changed", reload);
	useServerEvent("review-notice", reload);
	return { data, reload, setData };
}

/** POST /api/review/start → stash the opening message → the session id.
 *  null when nothing is due or storage refused the hand-over. Pure seam. */
export async function beginReview(
	fetchLike: typeof fetch,
	stash: (id: string, text: string) => boolean = stashOpeningPrompt,
): Promise<string | null> {
	const res = await fetchLike("/api/review/start", { method: "POST" });
	if (!res.ok) return null;
	const body = (await res.json()) as { id?: unknown; opening?: unknown };
	if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id) || typeof body.opening !== "string") return null;
	return stash(body.id, body.opening) ? body.id : null;
}

/** The start button's behavior (Repaso, Inicio, «Siguiente tanda»). */
export function useStartReview() {
	const router = useRouter();
	const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
	const start = useCallback(async () => {
		setState("starting");
		const id = await beginReview(fetch).catch(() => null);
		if (!id) {
			setState("failed");
			return;
		}
		router.push(`/chat/${id}`);
	}, [router]);
	return { state, start };
}

// ─── pure formatting (tested) ───────────────────────────────────────────────

/** "Estoicismo, FÍSICA y 1 más" — topics by size, two named at most. */
export function topicsLine(due: ReviewSummary["due"], t: Translate): string {
	const sorted = [...due].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
	if (sorted.length === 0) return "";
	if (sorted.length === 1) return t("review.home.topicsOne", { a: sorted[0]!.label });
	if (sorted.length === 2) return t("review.home.topicsTwo", { a: sorted[0]!.label, b: sorted[1]!.label });
	return t("review.home.topicsMore", { a: sorted[0]!.label, b: sorted[1]!.label, n: sorted.length - 2 });
}

const DAY_MS = 86_400_000;

/** When an idea comes up next: hoy / mañana / en N días / nueva / en espera. */
export function ideaWhen(item: Pick<ReviewItemView, "due" | "state" | "released">, now: number, t: Translate): string {
	if (!item.released) return t("review.idea.waiting");
	if (item.state === "new") return t("review.idea.new");
	if (item.due === null) return t("review.idea.noRecall");
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const dueDay = new Date(item.due);
	dueDay.setHours(0, 0, 0, 0);
	const days = Math.round((dueDay.getTime() - startOfToday.getTime()) / DAY_MS);
	if (days <= 0) return t("review.idea.today");
	if (days === 1) return t("review.idea.tomorrow");
	return t("review.idea.inDays", { n: days });
}

const pct = (r: number | null) => (r === null ? null : Math.round(r * 100));

// ─── sections ───────────────────────────────────────────────────────────────

function StartButton({ disabled }: { disabled?: boolean }) {
	const t = useT();
	const { state, start } = useStartReview();
	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				data-testid="review-start"
				disabled={disabled || state === "starting"}
				onClick={() => void start()}
				className={buttonVariants({ variant: "default", className: "min-w-28" })}
			>
				{state === "starting" ? t("review.today.starting") : t("review.today.start")}
			</button>
			{state === "failed" && (
				<p role="alert" className="text-xs text-warn">
					{t("review.today.startFailed")}
				</p>
			)}
		</div>
	);
}

function TodaySection({ summary }: { summary: ReviewSummary }) {
	const t = useT();
	const groups = [...summary.due].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
	return (
		<section className="flex flex-col gap-3" data-testid="review-today">
			<SectionTitle right={summary.dueCount > 0 ? <StartButton /> : undefined}>
				{summary.dueCount > 0 ? t("review.today.title", { n: summary.dueCount }) : t("review.today.empty")}
			</SectionTitle>
			{groups.length > 0 && (
				<ul className="overflow-hidden rounded-xl border">
					{groups.map((g) => (
						<li key={`${g.group.kind}:${g.group.id}`} className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0">
							<span className="min-w-0 truncate">{g.label}</span>
							<span className="tabular-nums text-muted-foreground">{g.nodeIds.length}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** One recall meter: track = lighter step of the data hue, fill = recall,
 *  a hairline tick at the target. Text stays in text tokens. */
function RecallMeter({ label, value, target }: { label: string; value: number; target: number }) {
	const t = useT();
	return (
		<li
			className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 py-1.5 text-sm"
			aria-label={t("review.memory.bar", { label, n: value })}
		>
			<span className="truncate text-foreground">{label}</span>
			<ProgressBar value={value} target={target} />
			<span className="text-right tabular-nums text-muted-foreground">{value}%</span>
		</li>
	);
}

const MEMORY_ROWS = 6;

export function MemorySection({ summary, target }: { summary: ReviewSummary; target: number }) {
	const t = useT();
	const [all, setAll] = useState(false);
	const rows = summary.retention.byGroup
		.filter((g) => g.retention !== null)
		.map((g) => ({ key: `${g.group.kind}:${g.group.id}`, label: g.label, value: pct(g.retention)! }))
		.sort((a, b) => a.value - b.value); // weakest first — what needs you
	const shown = all ? rows : rows.slice(0, MEMORY_ROWS);
	const mean = pct(summary.retention.overall);
	const targetPct = Math.round(target * 100);
	return (
		<section className="flex flex-col gap-3" data-testid="review-memory">
			<SectionTitle>{t("review.memory.title")}</SectionTitle>
			{mean === null ? (
				<p className="px-1 text-sm text-muted-foreground">{t("review.memory.none")}</p>
			) : (
				<>
					<div className="flex items-baseline gap-3 px-1">
						<span className="text-5xl font-semibold tracking-tight" data-testid="review-mean">{mean}%</span>
						<span className="text-sm text-muted-foreground">
							{t("review.memory.mean")} · {t("review.memory.target", { n: targetPct })}
						</span>
					</div>
					<ul className="px-1">
						{shown.map((r) => (
							<RecallMeter key={r.key} label={r.label} value={r.value} target={targetPct} />
						))}
					</ul>
					{rows.length > MEMORY_ROWS && (
						<button type="button" onClick={() => setAll((v) => !v)} className="self-start px-1 text-sm text-muted-foreground hover:text-foreground">
							{all ? t("review.memory.showLess") : t("review.memory.showAll", { n: rows.length })}
						</button>
					)}
					<table className="sr-only">
						<caption>{t("review.memory.title")}</caption>
						<tbody>
							{rows.map((r) => (
								<tr key={r.key}>
									<th scope="row">{r.label}</th>
									<td>{r.value}%</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</section>
	);
}

/** Reviews due per day (the shared BarChart — owner 2026-11-06: values
 *  on hover/focus/tap only, «Hoy» emphasized on the axis). */
export function ForecastChart({ counts, now }: { counts: number[]; now: number }) {
	const t = useT();
	const { locale } = useLocale();
	const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }), [locale]);
	const short = useMemo(() => new Intl.DateTimeFormat(locale, counts.length <= 7 ? { weekday: "narrow" } : { day: "numeric" }), [locale, counts.length]);
	const dayAt = (i: number) => new Date(now + i * DAY_MS);
	const dateLabel = (i: number) => (i === 0 ? t("review.forecast.today") : fmt.format(dayAt(i)));
	return (
		<BarChart
			testid="review-forecast"
			height="h-40"
			values={counts}
			caption={t("review.forecast.caption")}
			axisLabel={(i) => (counts.length <= 7 || i % 5 === 0 ? (i === 0 ? t("review.forecast.today") : short.format(dayAt(i))) : "")}
			barLabel={(i) => t("review.forecast.bar", { date: dateLabel(i), n: counts[i]! })}
		/>
	);
}

function ForecastSection({ summary, now }: { summary: ReviewSummary; now: number }) {
	const t = useT();
	const [range, setRange] = useState<7 | 30>(7);
	const counts = range === 7 ? summary.forecast7 : summary.forecast30;
	return (
		<section className="flex flex-col gap-3" data-testid="review-forecast-section">
			<SectionTitle
				right={
					<div role="radiogroup" aria-label={t("review.forecast.range")} className="flex rounded-lg border p-0.5 text-xs">
						{([7, 30] as const).map((r) => (
							<button
								key={r}
								type="button"
								role="radio"
								aria-checked={range === r}
								onClick={() => setRange(r)}
								className={cn("rounded-md px-2.5 py-1 transition-colors", range === r ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
							>
								{r === 7 ? t("review.forecast.days7") : t("review.forecast.days30")}
							</button>
						))}
					</div>
				}
			>
				{t("review.forecast.title")}
			</SectionTitle>
			<ForecastChart counts={counts} now={now} />
		</section>
	);
}

// ─── sources ────────────────────────────────────────────────────────────────

function IdeaRow({ item, now, onToggle }: { item: ReviewItemView; now: number; onToggle: (on: boolean) => void }) {
	const t = useT();
	const recall = pct(item.retrievability);
	return (
		<li className={cn("flex items-center justify-between gap-3 py-1.5 pl-9 pr-4 text-sm", item.paused && "text-muted-foreground")}>
			<span className="min-w-0 truncate">{item.name}</span>
			<span className="flex shrink-0 items-center gap-3">
				<span className="w-28 text-right tabular-nums text-muted-foreground">
					{recall === null ? t("review.idea.noRecall") : t("review.idea.recall", { n: recall })} · {ideaWhen(item, now, t)}
				</span>
				<Toggle checked={!item.paused} label={t("review.sources.toggleIdea", { name: item.name })} testid={`review-idea-${item.nodeId}`} onChange={onToggle} />
			</span>
		</li>
	);
}

function SourceRow({
	id,
	label,
	toggleLabel,
	detail,
	checked,
	items,
	now,
	onToggle,
	onToggleIdea,
}: {
	id: string;
	label: string;
	toggleLabel: string;
	detail: string;
	checked: boolean;
	items: ReviewItemView[];
	now: number;
	onToggle: (on: boolean) => void;
	onToggleIdea: (nodeId: string, on: boolean) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const expandable = items.length > 0;
	return (
		<li className="border-b last:border-b-0">
			<div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
				<button
					type="button"
					disabled={!expandable}
					aria-expanded={expandable ? open : undefined}
					aria-label={t("review.sources.expand", { label })}
					onClick={() => setOpen((v) => !v)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
				>
					<ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !expandable && "opacity-0")} />
					<span className="min-w-0 truncate">{label}</span>
				</button>
				<span className="flex shrink-0 items-center gap-3">
					<span className="text-right tabular-nums text-muted-foreground">{detail}</span>
					<Toggle checked={checked} label={toggleLabel} testid={`review-source-${id}`} onChange={onToggle} />
				</span>
			</div>
			{open && expandable && (
				<ul className="pb-2">
					{items.map((item) => (
						<IdeaRow key={item.nodeId} item={item} now={now} onToggle={(on) => onToggleIdea(item.nodeId, on)} />
					))}
				</ul>
			)}
		</li>
	);
}

const toggled = (list: readonly string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

export function SourcesSection({
	data,
	now,
	onSources,
}: {
	data: ReviewApiResponse;
	now: number;
	onSources: (patch: { areas?: string[]; paused?: Partial<ReviewSources["paused"]> }) => void;
}) {
	const t = useT();
	const { sources, items, areas } = data;
	const byGroup = useMemo(() => {
		const map = new Map<string, ReviewItemView[]>();
		for (const item of items) {
			const key = `${item.group.kind}:${item.group.id}`;
			map.set(key, [...(map.get(key) ?? []), item]);
		}
		return map;
	}, [items]);
	const sessions = [...byGroup.entries()]
		.filter(([key]) => key.startsWith("session:"))
		.map(([key, list]) => ({ id: key.slice("session:".length), label: list[0]!.label, items: list }))
		.sort((a, b) => a.label.localeCompare(b.label));
	const meanOf = (list: ReviewItemView[]) => {
		const rs = list.filter((i) => !i.paused && i.retrievability !== null).map((i) => i.retrievability!);
		return rs.length ? Math.round((rs.reduce((s, r) => s + r, 0) / rs.length) * 100) : null;
	};
	const detail = (list: ReviewItemView[], count = list.length) => {
		const mean = meanOf(list);
		const ideas = t("review.sources.ideas", { n: count });
		return mean === null ? ideas : `${mean}% · ${ideas}`;
	};
	const toggleIdea = (nodeId: string, on: boolean) => onSources({ paused: { nodes: toggled(sources.paused.nodes, nodeId, !on) } });
	return (
		<section className="flex flex-col gap-4" data-testid="review-sources">
			<SectionTitle>{t("review.sources.title")}</SectionTitle>
			{sessions.length > 0 && (
				<div className="flex flex-col gap-2">
					<h3 className="px-1 text-sm font-medium text-muted-foreground">{t("review.sources.sessions")}</h3>
					<ul className="overflow-hidden rounded-xl border">
						{sessions.map((s) => (
							<SourceRow
								key={s.id}
								id={s.id}
								label={s.label}
								toggleLabel={t("review.sources.toggleSession", { label: s.label })}
								detail={detail(s.items)}
								checked={!sources.paused.sessions.includes(s.id)}
								items={s.items}
								now={now}
								onToggle={(on) => onSources({ paused: { sessions: toggled(sources.paused.sessions, s.id, !on) } })}
								onToggleIdea={toggleIdea}
							/>
						))}
					</ul>
				</div>
			)}
			<div className="flex flex-col gap-2">
				<h3 className="px-1 text-sm font-medium text-muted-foreground">{t("review.sources.areas")}</h3>
				{areas.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">{t("review.sources.noAreas")}</p>
				) : (
					<ul className="overflow-hidden rounded-xl border">
						{areas.map((a: ReviewArea) => {
							const list = a.active ? (byGroup.get(`area:${a.id}`) ?? []) : [];
							return (
								<SourceRow
									key={a.id}
									id={a.id}
									label={a.label}
									toggleLabel={t("review.sources.toggleArea", { label: a.label })}
									detail={a.active ? detail(list, a.count) : `${t("review.sources.inactive")} · ${t("review.sources.ideas", { n: a.count })}`}
									checked={a.active}
									items={list}
									now={now}
									onToggle={(on) => onSources({ areas: toggled(sources.areas, a.id, on) })}
									onToggleIdea={toggleIdea}
								/>
							);
						})}
					</ul>
				)}
			</div>
			<p className="px-1 text-sm text-muted-foreground" data-testid="review-intake">
				{t("review.sources.intake", { perDay: data.settings.newPerDay, n: data.summary.waitingIntake })}
			</p>
		</section>
	);
}

// ─── the page ───────────────────────────────────────────────────────────────

export function ReviewPage() {
	const t = useT();
	const { data, setData, reload } = useReview();
	const [now] = useState(() => Date.now());
	const updateSources = useCallback(
		async (patch: { areas?: string[]; paused?: Partial<ReviewSources["paused"]> }) => {
			// Optimistic: the switch moves at once; the refetch brings truth.
			setData((prev) =>
				prev
					? {
							...prev,
							sources: {
								...prev.sources,
								areas: patch.areas ?? prev.sources.areas,
								paused: { ...prev.sources.paused, ...patch.paused },
							},
						}
					: prev,
			);
			await fetch("/api/review/sources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => {});
			reload();
		},
		[reload, setData],
	);
	return (
		<Page testid="review-page">
				<PageHeader
					title={t("review.page.title")}
					actions={
						<Link href="/settings/review" className={buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground" })}>
							<SettingsIcon />
							{t("review.page.settings")}
						</Link>
					}
				/>
				{data === undefined ? (
					<p className="px-1 text-sm text-muted-foreground">{t("review.loading")}</p>
				) : data === null ? (
					<p role="alert" className="px-1 text-sm text-warn">{t("review.loadFailed")}</p>
				) : (
					<>
						<TodaySection summary={data.summary} />
						<MemorySection summary={data.summary} target={data.settings.targetRetention} />
						<ForecastSection summary={data.summary} now={now} />
						<SourcesSection data={data} now={now} onSources={(p) => void updateSources(p)} />
					</>
				)}
		</Page>
	);
}

// ─── Inicio: «Para repasar hoy» ─────────────────────────────────────────────

export function ReviewTodayCard() {
	const t = useT();
	const { data } = useReview();
	if (!data || data.summary.dueCount === 0) return null;
	return (
		<section className="flex flex-col gap-3" data-testid="review-home">
			<SectionTitle>{t("review.home.title")}</SectionTitle>
			{/* Two lines, like «Hoy para tu examen» (owner 2026-11-06). */}
			<ListCard>
				<ListRow href="/review" title={topicsLine(data.summary.due, t)} meta={t("graph.home.ideas", { n: data.summary.dueCount })} action={<StartButton />} />
			</ListCard>
		</section>
	);
}

// ─── the review session's batch end («Siguiente tanda» / «Parar») ───────────

/** Mounted by the chat only when every picked idea had its problem:
 *  «Parar» goes back to Repaso; «Siguiente tanda (N)» opens a new review
 *  session with the next due ideas; nothing left → «Volver a Repaso». */
export function ReviewBatchActions() {
	const t = useT();
	const router = useRouter();
	const { state, start } = useStartReview();
	const [remaining, setRemaining] = useState<number | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/api/review")
			.then((r) => (r.ok ? (r.json() as Promise<ReviewApiResponse>) : null))
			.then((b) => live && setRemaining(b?.summary.dueCount ?? 0))
			.catch(() => live && setRemaining(0));
		return () => {
			live = false;
		};
	}, []);
	const quiet = "flex h-10 shrink-0 items-center justify-center rounded-[10px] px-4 font-ui text-xs font-medium transition-colors";
	if (remaining === 0) {
		return (
			<button type="button" data-testid="review-batch-back" onClick={() => router.push("/review")} className={cn(quiet, "bg-ok text-background hover:opacity-90")}>
				{t("review.batch.back")}
			</button>
		);
	}
	return (
		<span className="flex shrink-0 gap-1.5">
			<button type="button" data-testid="review-batch-stop" onClick={() => router.push("/review")} className={cn(quiet, "bg-secondary text-foreground hover:bg-accent")}>
				{t("review.batch.stop")}
			</button>
			<button
				type="button"
				data-testid="review-batch-next"
				disabled={remaining === null || state === "starting"}
				onClick={() => void start()}
				className={cn(quiet, "gap-1.5 bg-ok text-background hover:opacity-90 disabled:opacity-50")}
			>
				{t("review.batch.next", { n: remaining ?? 0 })}
				<ChevronRightIcon className="size-4" />
			</button>
		</span>
	);
}

"use client";
/**
 * EXÁMENES (owner design, 2026-11-05 — stage 3, mockups approved
 * 2026-11-06): the 5th tab.
 *
 *   /exams        the list (countdown, level vs target, today's minutes)
 *   /exams/new    the wizard: 1 Temario → 2 Revisar el mapeo → 3 Estándar
 *                 → 4 Tiempo (a draft resumes at its step on /exams/[id])
 *   /exams/[id]   one exam: Hoy (ordered blocks, each its own session),
 *                 Tu nivel (coverage vs target, «no llega» options), Plan
 *                 (minutes for the next 14 days), Temario (per block, with
 *                 priorities), Simulacro (the last days)
 *
 * Plus the Inicio card «Hoy para tu examen» and the exam sessions' batch
 * end. Data: GET /api/exams[/id], refetched on the server events that can
 * move it and on window focus. Everything derived lives on the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon, StarIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import { buttonVariants } from "@/components/ui/button";
import { Page, PageHeader, SectionTitle } from "@/components/ui/page";
import { ListCard, ListRow } from "@/components/ui/list";
import { ProgressBar } from "@/components/ui/progress-bar";
import { BarChart } from "@/components/ui/bar-chart";
import { Select } from "@/components/ui/select";
import { useServerEvent } from "@/components/server-events";
import { cleanPrerequisites, PrerequisitesEditor, PrerequisitesSection } from "@/components/exam-prerequisites";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { useLocale, useT, type Translate } from "@/components/i18n";
import {
	EXAM_PRESETS,
	MODE_LEVEL,
	PRESET_ORDER,
	presetStandard,
	type DemandMode,
	type ExamBlock,
	type ExamDetailView,
	type ExamPreset,
	type ExamSessionKind,
	type ExamStandard,
	type ExamSummaryView,
	type IdeaStatus,
	type VaultFolderInfo,
	type FolderCheck,
	type ExamContext,
	type ExamContextKind,
	EMPTY_EXAM_CONTEXT,
	guideWanted,
	EXAM_CONTEXT_KINDS,
	folderCheck,
	toggleFolder,
	selectionScope,
	type MessageKey,
	type PointStatus,
	type SyllabusBlock,
	type SyllabusPoint,
	type TargetIdea,
	type TargetStatus,
	moveIdea,
	pointKind,
	pendingKindPoints,
	setPointKind,
	instructionPoints,
	POINT_KINDS,
	type PointKind,
	type PointOrigin,
	type ExamMaterial,
	type ExamRecord,
	type ExamPrerequisite,
	type PrerequisiteStatus,
} from "@/src/core";

// ─── data ───────────────────────────────────────────────────────────────────

interface ExamsListResponse {
	exams: ExamSummaryView[];
}

function useFresh<T>(url: string | null) {
	const [data, setData] = useState<T | null | undefined>(undefined);
	const reload = useCallback(() => {
		if (!url) return;
		fetch(url)
			.then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
			.then(setData)
			.catch(() => setData((prev) => (prev === undefined ? null : prev)));
	}, [url]);
	useEffect(() => {
		reload();
		const onFocus = () => reload();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);
	useServerEvent("exams-changed", reload);
	useServerEvent("turn-settled", reload);
	useServerEvent("chats-changed", reload);
	return { data, reload, setData };
}

export const useExams = () => useFresh<ExamsListResponse>("/api/exams");
export const useExam = (id: string) => useFresh<ExamDetailView>(`/api/exams/${encodeURIComponent(id)}`);

async function sendJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
	try {
		const res = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { ok: res.ok, body: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
	} catch {
		return { ok: false, body: {} };
	}
}

/** POST /api/exams/[id]/sessions → stash the opening → the session id.
 *  null when the block has nothing to do or storage refused. Pure seam. */
export async function beginExamSession(
	fetchLike: typeof fetch,
	examId: string,
	kind: ExamSessionKind,
	pointId?: string,
	stash: (id: string, text: string) => boolean = stashOpeningPrompt,
): Promise<string | null> {
	const res = await fetchLike(`/api/exams/${encodeURIComponent(examId)}/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind, ...(pointId ? { pointId } : {}) }),
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { id?: unknown; opening?: unknown };
	if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id) || typeof body.opening !== "string") return null;
	return stash(body.id, body.opening) ? body.id : null;
}

export function useStartExamSession(examId: string) {
	const router = useRouter();
	const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
	const start = useCallback(
		async (kind: ExamSessionKind, pointId?: string) => {
			setState("starting");
			const id = await beginExamSession(fetch, examId, kind, pointId).catch(() => null);
			if (!id) {
				setState("failed");
				return;
			}
			router.push(`/chat/${id}`);
		},
		[examId, router],
	);
	return { state, start };
}

// ─── pure formatting (tested) ───────────────────────────────────────────────

export const pct = (r: number | null | undefined) => (r === null || r === undefined ? null : Math.round(r * 100));

export function presetLabel(preset: ExamPreset | null, t: Translate): string {
	return t(preset ? (`exams.preset.${preset}` as MessageKey) : "exams.preset.custom");
}

export function standardName(standard: ExamStandard, t: Translate): string {
	return standard.preset ? presetLabel(standard.preset, t) : t("exams.standard.custom");
}

export function modeLabel(mode: DemandMode, t: Translate): string {
	return t(`exams.mode.${mode}` as MessageKey);
}

const LEVEL_MODE: Record<number, DemandMode | null> = { 0: null, 1: "recall", 2: "discrimination", 3: "composition" };

/** «Discriminar» / «sin nivel» / «por enseñar» for one idea. */
export function ideaLevelLabel(idea: Pick<IdeaStatus, "level" | "toTeach" | "placed" | "tested">, t: Translate): string {
	if (idea.toTeach) return t("exams.idea.toTeach");
	const mode = LEVEL_MODE[idea.level];
	if (mode) return modeLabel(mode, t);
	return idea.placed || idea.tested ? t("exams.idea.noLevel") : t("exams.idea.untested");
}

/** «falta · por enseñar», «prueba de nivel», … — what a point needs. */
export function pointNeedLabel(point: Pick<PointStatus, "need" | "gap" | "probe">, t: Translate): string {
	switch (point.need) {
		case "placement":
			return point.gap ? t("exams.point.gapUntested") : t("exams.point.placement");
		case "teach":
			return t("exams.point.teach");
		case "consolidate":
			return t("exams.point.consolidate");
		case "practice":
			return t("exams.point.practice");
		case "done":
			return t("exams.point.done");
	}
}

/** A block's score: the mean of its points' scores. */
export function blockScore(points: readonly Pick<PointStatus, "score">[]): number {
	return points.length ? points.reduce((s, p) => s + p.score, 0) / points.length : 0;
}

/** «Subir N min/día»: the extra minutes go to the weekdays already
 *  studied (all days when none is). Pure. */
export function raiseWeekly(weekly: readonly number[], extra: number): number[] {
	const studied = weekly.some((m) => m > 0);
	return weekly.map((m) => (!studied || m > 0 ? Math.min(720, m + extra) : m));
}

export function blockLabel(block: ExamBlock, points: readonly PointStatus[], t: Translate, prerequisites: readonly Pick<PrerequisiteStatus, "id" | "statement">[] = []): string {
	switch (block.kind) {
		case "review":
			return t("exams.block.review", { n: block.nodeIds.length });
		case "placement":
			return t("exams.block.placement", { n: block.nodeIds.length });
		case "practice":
			return t("exams.block.practice", { n: block.nodeIds.length });
		case "teach": {
			if (block.prerequisiteId) {
				const q = prerequisites.find((x) => x.id === block.prerequisiteId);
				return t(block.short ? "exams.block.consolidatePrereq" : "exams.block.teachPrereq", { x: q?.statement ?? "" });
			}
			const point = points.find((p) => p.id === block.pointId);
			return t(block.short ? "exams.block.consolidate" : "exams.block.teach", { point: point?.text ?? "" });
		}
	}
}

const MOCK_SHOW_DAYS = 7;

export function dateLabel(day: string, locale: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Intl.DateTimeFormat(locale, opts).format(new Date(y!, m! - 1, d!, 12));
}

// ─── small pieces ───────────────────────────────────────────────────────────

/** The shared buttons (design pass 2026-11-06): one height, one radius,
 *  never wrapping — links and buttons alike. */
const primaryBtn = buttonVariants({ variant: "default" });
const quietBtn = buttonVariants({ variant: "outline", size: "sm" });

/** Coverage vs target (the shared ProgressBar; detail views label the tick). */
function CoverageBar({ value, target, label, labelled = false }: { value: number; target: number; label: string; labelled?: boolean }) {
	return <ProgressBar value={value} target={target} label={label} showTargetLabel={labelled} />;
}

// ─── the list ───────────────────────────────────────────────────────────────

export function ExamCard({ exam }: { exam: ExamSummaryView }) {
	const t = useT();
	const { locale } = useLocale();
	const coverage = pct(exam.coverage);
	const target = Math.round(exam.standard.coverage * 100);
	const days = exam.daysLeft;
	return (
		<li className="flex items-center border-b transition-colors last:border-b-0 hover:bg-accent/50">
			<Link href={`/exams/${exam.id}`} className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3" data-testid={`exam-card-${exam.id}`}>
				<span className="flex items-baseline justify-between gap-3">
					<span className="min-w-0 truncate font-medium" title={exam.title}>{exam.title}</span>
					<span className="shrink-0 text-sm text-muted-foreground">
						{dateLabel(exam.examDate, locale)} · {exam.status === "archived" ? t("exams.list.past") : days === 0 ? t("exams.days.today") : t("exams.days.left", { n: days })}
					</span>
				</span>
				{exam.status === "draft" ? (
					<span className="text-sm text-muted-foreground">{t("exams.list.draft")}</span>
				) : exam.status === "archived" ? (
					<span className="text-sm text-muted-foreground">
						{t("exams.list.final", { n: pct(exam.final?.coverage) ?? 0, level: presetLabel(exam.final?.preset ?? null, t) })}
						{exam.realGrade ? ` · ${t("exams.list.realGrade", { grade: exam.realGrade })}` : ""}
					</span>
				) : (
					<>
						<CoverageBar value={coverage ?? 0} target={target} label={t("exams.level.bar", { n: coverage ?? 0, target })} />
						<span className="flex items-center gap-2 text-sm text-muted-foreground">
							{exam.infeasible && <AlertTriangleIcon className="size-4 text-warn" aria-label={t("exams.level.behind")} />}
							{t("exams.list.summary", { n: coverage ?? 0, level: standardName(exam.standard, t), target })}
							{exam.todayMinutes > 0 && ` · ${t("exams.list.today", { min: Math.round(exam.todayMinutes) })}`}
						</span>
					</>
				)}
			</Link>
			{/* Drafts only (owner, 2026-11-06): delete without finishing the
			    wizard. Outside the Link so the menu never opens the draft. */}
			{exam.status === "draft" && (
				<span className="shrink-0 pr-2">
					<ExamMenu exam={exam} />
				</span>
			)}
		</li>
	);
}

export function ExamsPage() {
	const t = useT();
	const { data } = useExams();
	const groups = useMemo(() => {
		const list = data?.exams ?? [];
		return {
			active: list.filter((e) => e.status === "active").sort((a, b) => a.examDate.localeCompare(b.examDate)),
			drafts: list.filter((e) => e.status === "draft"),
			past: list.filter((e) => e.status === "archived").sort((a, b) => b.examDate.localeCompare(a.examDate)),
		};
	}, [data]);
	return (
		<Page testid="exams-page">
				<PageHeader
					title={t("exams.page.title")}
					actions={
						<>
							<Link href="/settings/exams" className={buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground" })}>
								<SettingsIcon />
								{t("exams.page.settings")}
							</Link>
							<Link href="/exams/new" className={primaryBtn} data-testid="exams-new">
								<PlusIcon />
								{t("exams.page.new")}
							</Link>
						</>
					}
				/>
				{data === undefined ? (
					<p className="px-1 text-sm text-muted-foreground">{t("exams.loading")}</p>
				) : data === null ? (
					<p role="alert" className="px-1 text-sm text-warn">{t("exams.loadFailed")}</p>
				) : data.exams.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground" data-testid="exams-empty">{t("exams.list.empty")}</p>
				) : (
					(["active", "drafts", "past"] as const).map((key) =>
						groups[key].length === 0 ? null : (
							<section key={key} className="flex flex-col gap-3">
								<SectionTitle>{t(`exams.list.${key}` as MessageKey)}</SectionTitle>
								<ListCard>
									{groups[key].map((e) => (
										<ExamCard key={e.id} exam={e} />
									))}
								</ListCard>
							</section>
						),
					)
				)}
		</Page>
	);
}

// ─── the wizard ─────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4 | 5;

function StepHeader({ step }: { step: WizardStep }) {
	const t = useT();
	return (
		<PageHeader
			title={t("exams.wizard.title")}
			actions={
				<ol className="flex gap-1.5 text-sm" aria-label={t("exams.wizard.steps")}>
					{[1, 2, 3, 4, 5].map((n) => (
						<li key={n} aria-current={n === step ? "step" : undefined} className={cn("flex size-7 items-center justify-center rounded-full border tabular-nums", n === step ? "border-primary bg-primary text-primary-foreground" : n < step ? "border-foreground/30 text-foreground" : "text-muted-foreground")}>
							{n}
						</li>
					))}
				</ol>
			}
		/>
	);
}

const foldText = (v: string) => v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** «… › INFORMÁTICA › Redes»: the last two segments of a selected folder. */
const shortFolder = (path: string) => {
	const segs = path.split("/");
	return (segs.length > 2 ? ["…", ...segs.slice(-2)] : segs).join(" › ");
};

/** «(42 ideas)» · «(12 notas · sin leer)» · «(2 ideas · 30 notas sin leer)». */
export function folderCountLabel(f: Pick<VaultFolderInfo, "ideas" | "unread">, t: Translate): string {
	if (f.unread > 0 && f.ideas > 0) return t("exams.folders.mixed", { ideas: f.ideas, unread: f.unread });
	if (f.unread > 0) return t("exams.folders.unread", { n: f.unread });
	return t("exams.folders.ideas", { n: f.ideas });
}

/** A checkbox that can show «–» (indeterminate is a DOM property). */
function TriCheckbox({ state, onChange, label }: { state: FolderCheck; onChange: () => void; label?: string }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = state === "partial";
	}, [state]);
	return <input ref={ref} type="checkbox" checked={state === "on"} aria-checked={state === "partial" ? "mixed" : state === "on"} aria-label={label} onChange={onChange} className="accent-primary" />;
}

/**
 * The wizard's folder tree (owner 2026-11-06): every knowledge-folder
 * folder holding notes, read or not, collapsed to the first level, names
 * as on disk, recursive counts. A click sets a folder's whole subtree (or
 * clears it when it is fully on); any descendant can then be unchecked
 * at any depth — the folder shows «–» and its loose notes stay in. The
 * search filters by name (accents folded): matches stay with their
 * ancestors, which open on their own; clearing it restores the
 * hand-opened state. Below, the chosen folders with a × each.
 */
export function FolderPicker({ folders, flagged, onChange }: { folders: VaultFolderInfo[]; flagged: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
	const t = useT();
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const all = useMemo(() => folders.map((f) => f.path), [folders]);
	const children = useMemo(() => {
		const map = new Map<string, VaultFolderInfo[]>();
		for (const f of folders) {
			const parent = parentOf(f.path);
			map.set(parent, [...(map.get(parent) ?? []), f]);
		}
		for (const list of map.values()) list.sort((a, b) => folderName(a.path).localeCompare(folderName(b.path)));
		return map;
	}, [folders]);
	const q = foldText(query.trim());
	const filter = useMemo(() => {
		if (!q) return null;
		const matches = new Set(folders.filter((f) => foldText(folderName(f.path)).includes(q)).map((f) => f.path));
		const ancestors = new Set<string>();
		for (const m of matches) for (let p = parentOf(m); p; p = parentOf(p)) ancestors.add(p);
		return { matches, ancestors };
	}, [folders, q]);
	const toggleOpen = (path: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	const scope = useMemo(() => selectionScope(flagged, all), [flagged, all]);
	const chips = [...scope.folders.map((path) => ({ path, partial: false })), ...scope.directFolders.map((path) => ({ path, partial: true }))].sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	const clear = (path: string) => {
		const next = new Set(flagged);
		next.delete(path);
		for (const p of all) if (p.startsWith(`${path}/`)) next.delete(p);
		onChange(next);
	};

	const renderLevel = (parent: string, depth: number, insideMatch: boolean): React.ReactNode[] =>
		(children.get(parent) ?? []).flatMap((f) => {
			const isMatch = filter?.matches.has(f.path) ?? false;
			if (filter && !insideMatch && !isMatch && !filter.ancestors.has(f.path)) return [];
			const kids = children.has(f.path);
			const forced = filter !== null && filter.ancestors.has(f.path);
			const expanded = kids && (forced || open.has(f.path));
			const name = folderName(f.path);
			const check = folderCheck(f.path, flagged, all);
			return [
				<li key={f.path} data-testid="exam-folder" data-path={f.path} data-check={check}>
					<div className="flex items-center gap-1.5 rounded-md py-0.5 pr-2 hover:bg-accent/60" style={{ paddingLeft: `${depth * 1.25}rem` }}>
						{kids ? (
							<button
								type="button"
								aria-expanded={expanded}
								aria-label={t("exams.wizard.folderToggle", { name })}
								disabled={forced}
								onClick={() => toggleOpen(f.path)}
								className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-60"
							>
								<ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
							</button>
						) : (
							<span className="size-5 shrink-0" />
						)}
						<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
							<TriCheckbox state={check} onChange={() => onChange(toggleFolder(f.path, flagged, all))} />
							<span className="truncate" title={f.path}>
								{name}
							</span>
							<span className={cn("shrink-0", f.ideas === 0 && f.unread > 0 ? "text-muted-foreground/70" : "text-muted-foreground")}>({folderCountLabel(f, t)})</span>
						</label>
					</div>
					{expanded && <ul>{renderLevel(f.path, depth + 1, insideMatch || isMatch)}</ul>}
				</li>,
			];
		});

	const rows = renderLevel("", 0, false);
	return (
		<fieldset className="flex flex-col gap-2 px-1" data-testid="exam-folders">
			<legend className="mb-2 text-sm text-muted-foreground">{t("exams.wizard.folders")}</legend>
			<input
				type="search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder={t("exams.wizard.folderSearch")}
				data-testid="exam-folder-search"
				className="rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/50"
			/>
			<div className="max-h-80 overflow-y-auto rounded-md border px-1 py-1.5">
				{rows.length > 0 ? <ul>{rows}</ul> : <p className="px-2 py-1 text-sm text-muted-foreground">{t("exams.wizard.folderNoMatch")}</p>}
			</div>
			{chips.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 text-sm" data-testid="exam-folders-selected">
					<span className="text-muted-foreground">{t("exams.wizard.foldersSelected")}</span>
					{chips.map(({ path, partial }) => (
						<span key={path} title={path} className={cn("inline-flex items-center gap-1 rounded-full border py-0.5 pl-3 pr-1", partial ? "border-primary/50 bg-primary/5" : "border-primary bg-primary/10")}>
							{partial ? `${shortFolder(path)} (–)` : shortFolder(path)}
							<button type="button" aria-label={t("exams.wizard.folderRemove", { name: folderName(path) })} onClick={() => clear(path)} className="grid size-5 place-items-center rounded-full hover:bg-accent">
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}
		</fieldset>
	);
}

const fieldInput = "h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-primary/50";

/** «Contexto (opcional)» (owner 2026-11-06): steers the research. */
export function ContextFields({ value, onChange }: { value: ExamContext; onChange: (next: ExamContext) => void }) {
	const t = useT();
	const set = (k: keyof ExamContext) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
		onChange({ ...value, [k]: k === "kind" ? ((e.target.value || null) as ExamContextKind | null) : e.target.value });
	const field = (k: "name" | "institution" | "location" | "sitting", maxLength: number) => (
		<label className="flex flex-col gap-1 text-sm">
			<span className="text-muted-foreground">{t(`exams.context.${k}`)}</span>
			<input value={value[k]} onChange={set(k)} maxLength={maxLength} data-testid={`exam-context-${k}`} className={fieldInput} />
		</label>
	);
	return (
		<fieldset className="flex flex-col gap-3 px-1" data-testid="exam-context">
			<legend className="mb-1 text-sm text-muted-foreground">{t("exams.context.title")}</legend>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">{t("exams.context.kind")}</span>
					<Select
						value={value.kind ?? "none"}
						ariaLabel={t("exams.context.kind")}
						testid="exam-context-kind"
						options={[{ value: "none", label: "—" }, ...EXAM_CONTEXT_KINDS.map((k) => ({ value: k, label: t(`exams.context.kind.${k}`) }))]}
						onChange={(k) => onChange({ ...value, kind: k === "none" ? null : (k as ExamContextKind) })}
					/>
				</div>
				{field("name", 300)}
				{field("institution", 300)}
				{field("location", 300)}
				{field("sitting", 100)}
			</div>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">{t("exams.context.goal")}</span>
				<textarea value={value.goal} onChange={set("goal")} maxLength={2000} rows={2} data-testid="exam-context-goal" className={fieldInput} />
			</label>
		</fieldset>
	);
}

/** A material chosen in step 1, uploaded once the exam exists. */
export type DraftMaterial = { key: string; kind: "file"; file: File } | { key: string; kind: "link"; url: string };

const MATERIAL_ACCEPT = ".pdf,.docx,.epub,.md,.txt,.png,.jpg,.jpeg,.webp,.heic";

/** «Materiales» (owner 2026-11-06): research sources, not syllabus. */
export function MaterialsZone({ value, onChange }: { value: DraftMaterial[]; onChange: (next: DraftMaterial[]) => void }) {
	const t = useT();
	const ref = useRef<HTMLInputElement>(null);
	const [link, setLink] = useState("");
	const validLink = /^https?:\/\/\S+$/i.test(link.trim());
	const addLink = () => {
		if (!validLink) return;
		onChange([...value, { key: localId("l_"), kind: "link", url: link.trim() }]);
		setLink("");
	};
	return (
		<fieldset className="flex flex-col gap-2 px-1" data-testid="exam-materials">
			<legend className="mb-1 text-sm text-muted-foreground">{t("exams.materials.title")}</legend>
			<p className="text-sm text-muted-foreground">{t("exams.materials.hint")}</p>
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<input
					ref={ref}
					type="file"
					multiple
					accept={MATERIAL_ACCEPT}
					className="hidden"
					data-testid="exam-materials-input"
					onChange={(e) => {
						const files = [...(e.target.files ?? [])];
						if (files.length) onChange([...value, ...files.map((file) => ({ key: localId("f_"), kind: "file" as const, file }))]);
						e.target.value = "";
					}}
				/>
				<button type="button" className={quietBtn} onClick={() => ref.current?.click()}>
					{t("exams.materials.addFiles")}
				</button>
				<span className="text-muted-foreground">{t("exams.materials.formats")}</span>
			</div>
			<div className="flex gap-2">
				<input
					value={link}
					onChange={(e) => setLink(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLink())}
					placeholder={t("exams.materials.linkPlaceholder")}
					data-testid="exam-materials-link"
					className={cn(fieldInput, "min-w-0 flex-1")}
				/>
				<button type="button" className={quietBtn} disabled={!validLink} onClick={addLink}>
					{t("exams.materials.addLink")}
				</button>
			</div>
			{value.length > 0 && (
				<ul className="flex flex-col gap-1 text-sm" data-testid="exam-materials-list">
					{value.map((m) => {
						const name = m.kind === "file" ? m.file.name : m.url;
						return (
							<li key={m.key} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
								<span className="min-w-0 truncate" title={name}>
									{name}
								</span>
								<button type="button" aria-label={t("exams.materials.remove", { name })} onClick={() => onChange(value.filter((x) => x.key !== m.key))} className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
									<XIcon className="size-3" />
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</fieldset>
	);
}

/** Upload step 1's materials to the created exam (best effort: a failed
 *  one is reported, the rest still go). */
async function uploadMaterials(examId: string, materials: DraftMaterial[]): Promise<string[]> {
	const failed: string[] = [];
	for (const m of materials) {
		let ok = false;
		if (m.kind === "file") {
			const form = new FormData();
			form.append("file", m.file);
			ok = (await fetch(`/api/exams/${examId}/materials`, { method: "POST", body: form }).catch(() => null))?.ok ?? false;
		} else {
			ok = (await sendJson(`/api/exams/${examId}/materials`, "POST", { url: m.url })).ok;
		}
		if (!ok) failed.push(m.kind === "file" ? m.file.name : m.url);
	}
	return failed;
}

/** Step 1 — name, date, syllabus text / file, materials, folders, context
 *  → create the draft. */
export function NewExamWizard() {
	const t = useT();
	const router = useRouter();
	const { data: tree } = useFresh<{ folders: VaultFolderInfo[]; watched: string[] }>("/api/exams/folders");
	const [title, setTitle] = useState("");
	const [date, setDate] = useState("");
	const [text, setText] = useState("");
	const [fileName, setFileName] = useState<string | null>(null);
	const [flagged, setFlagged] = useState<Set<string>>(() => new Set());
	const [context, setContext] = useState<ExamContext>({ ...EMPTY_EXAM_CONTEXT });
	const [materials, setMaterials] = useState<DraftMaterial[]>([]);
	const [state, setState] = useState<"idle" | "reading" | "creating" | "error">("idle");
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const all = useMemo(() => (tree?.folders ?? []).map((f) => f.path), [tree]);
	const scope = useMemo(() => selectionScope(flagged, all), [flagged, all]);

	// The sitting defaults to the exam date's year until the learner types one.
	const onDate = (value: string) => {
		const year = /^\d{4}/.exec(value)?.[0] ?? "";
		setContext((c) => (c.sitting === "" || c.sitting === /^\d{4}/.exec(date)?.[0] ? { ...c, sitting: year } : c));
		setDate(value);
	};

	const onFile = async (file: File) => {
		setState("reading");
		setError(null);
		const form = new FormData();
		form.append("file", file);
		const res = await fetch("/api/exams/syllabus-file", { method: "POST", body: form }).catch(() => null);
		const body = res ? ((await res.json().catch(() => ({}))) as { text?: string; fileName?: string; error?: string }) : {};
		if (!res?.ok || typeof body.text !== "string") {
			setState("error");
			setError(t("exams.wizard.fileFailed"));
			return;
		}
		setText((prev) => (prev.trim() ? `${prev.trim()}\n\n${body.text}` : body.text!));
		setFileName(body.fileName ?? file.name);
		setState("idle");
	};

	const hasScope = scope.folders.length > 0 || scope.directFolders.length > 0;
	const ready = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && (text.trim().length > 0 || hasScope);

	/** «Siguiente»: create the draft (+ its materials) and go on to the
	 *  standard; the research starts from there. */
	const submit = async () => {
		if (!ready) return;
		setState("creating");
		setError(null);
		const created = await sendJson("/api/exams", "POST", { title: title.trim(), examDate: date, context, syllabus: { text, fileName, ...scope } });
		const id = (created.body.exam as { id?: string } | undefined)?.id;
		if (!created.ok || !id) {
			setState("error");
			setError(typeof created.body.error === "string" ? created.body.error : t("exams.wizard.createFailed"));
			return;
		}
		await uploadMaterials(id, materials);
		router.push(`/exams/${id}`);
	};

	return (
		<div className="h-full overflow-y-auto" data-testid="exam-wizard">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-8 px-4 pb-16 pt-10">
				<StepHeader step={1} />
				<section className="flex flex-col gap-4">
					<SectionTitle>{t("exams.wizard.syllabus")}</SectionTitle>
					<div className="grid gap-3 px-1 sm:grid-cols-[1fr_12rem]">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{t("exams.wizard.name")}</span>
							<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-testid="exam-title" className={fieldInput} />
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{t("exams.wizard.date")}</span>
							<input type="date" value={date} onChange={(e) => onDate(e.target.value)} data-testid="exam-date" className={fieldInput} />
						</label>
					</div>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={t("exams.wizard.textPlaceholder")}
						rows={10}
						data-testid="exam-text"
						className="mx-1 rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
					/>
					<div className="flex flex-wrap items-center gap-3 px-1 text-sm">
						<input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx,.epub" className="hidden" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
						<button type="button" className={quietBtn} disabled={state === "reading"} onClick={() => fileRef.current?.click()} data-testid="exam-file">
							{state === "reading" ? t("exams.wizard.reading") : t("exams.wizard.attach")}
						</button>
						<span className="text-muted-foreground">{fileName ?? t("exams.wizard.formats")}</span>
					</div>
					<MaterialsZone value={materials} onChange={setMaterials} />
					{(tree?.folders.length ?? 0) > 0 && <FolderPicker folders={tree!.folders} flagged={flagged} onChange={setFlagged} />}
					<ContextFields value={context} onChange={setContext} />
					{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
					<div className="flex justify-end px-1">
						<button type="button" className={primaryBtn} disabled={!ready || state === "creating" || state === "reading"} onClick={() => void submit()} data-testid="exam-next">
							{state === "creating" ? t("exams.wizard.creating") : t("exams.wizard.next")}
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}

let localSeq = 0;
const localId = (prefix: string) => `${prefix}${Date.now().toString(36)}${++localSeq}`;

/** Step 3 — the read → outline → research progress, or its failure with
 *  a retry (a failed research resumes the blocks still without targets). */
function ResearchProgress({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const [error, setError] = useState<string | null>(null);
	const mapping = exam.record.mapping;
	const research = exam.record.research;
	const retry = async () => {
		setError(null);
		const res = mapping.error === "research" ? await sendJson(`/api/exams/${exam.id}/research`, "POST", { mode: "missing" }) : await sendJson(`/api/exams/${exam.id}/map`, "POST");
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	let line: string;
	if (mapping.state === "reading") line = t("exams.wizard.readingFolders", { done: exam.reading?.done ?? 0, total: exam.reading?.total ?? 0 });
	else if (mapping.state === "guide") line = t("exams.guide.searching");
	else if (mapping.state === "running") line = t("exams.wizard.outlining");
	else if (mapping.state === "researching") line = t("exams.wizard.researching", { i: Math.min((research?.done ?? 0) + 1, research?.total ?? 1), n: research?.total ?? 1, title: research?.current ?? "" });
	else if (mapping.state === "prerequisites") {
		const search = exam.record.prerequisiteSearch;
		line = t("exams.wizard.prerequisites", { i: Math.min((search?.done ?? 0) + 1, Math.max(1, search?.total ?? 1)), n: Math.max(1, search?.total ?? 1) });
	} else line = "";
	const failure =
		mapping.state === "error"
			? mapping.error === "research"
				? t("exams.wizard.researchFailed", { block: research?.error?.block ?? "", error: research?.error?.message ?? "" })
				: mapping.error === "interrupted"
					? t("exams.wizard.mapInterrupted")
					: mapping.error === "models_not_configured"
						? t("exams.wizard.noModel")
						: t("exams.wizard.mapFailed", { error: mapping.error ?? "" })
			: null;
	return (
		<section className="flex flex-col gap-4" data-testid="exam-research">
			<SectionTitle>{t("exams.wizard.research")}</SectionTitle>
			{line && (
				<p className="px-1 text-sm text-muted-foreground" aria-live="polite" data-testid="exam-research-progress">
					{line}
				</p>
			)}
			{mapping.state === "needs_guide" && <GuideRequest exam={exam} />}
			{research && !research.web && mapping.state !== "reading" && mapping.state !== "needs_guide" && <p className="px-1 text-sm text-warn" data-testid="exam-no-web">{t("exams.wizard.noWeb")}</p>}
			{(failure || error) && (
				<div className="flex flex-col gap-3 px-1">
					<p role="alert" className="text-sm text-warn">
						{error ?? failure}
					</p>
					<button type="button" className={cn(primaryBtn, "self-start")} onClick={() => void retry()} data-testid="exam-research-retry">
						{t("exams.wizard.retry")}
					</button>
				</div>
			)}
		</section>
	);
}

/** The guide was not found (owner 2026-11-06): paste it (→ material
 *  «Guía (pegada)»), attach it, link it, search again, or go on without. */
function GuideRequest({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const [mode, setMode] = useState<"paste" | "link" | null>(null);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const reason = exam.record.guide?.reason;
	const act = async (action: "retry" | "skip") => {
		setBusy(true);
		setError(null);
		const res = await sendJson(`/api/exams/${exam.id}/guide`, "POST", { action });
		setBusy(false);
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	/** Save what the learner gave as a material, then search again. */
	const addAndRetry = async (send: () => Promise<boolean>) => {
		setBusy(true);
		setError(null);
		const ok = await send();
		setBusy(false);
		if (!ok) {
			setError(t("exams.wizard.saveFailed"));
			return;
		}
		setMode(null);
		setValue("");
		await act("retry");
	};
	const saveTyped = () =>
		addAndRetry(async () => {
			const body = mode === "paste" ? { text: value, name: t("exams.guide.pastedName") } : { url: value.trim() };
			return (await sendJson(`/api/exams/${exam.id}/materials`, "POST", body)).ok;
		});
	const onFile = (file: File) =>
		addAndRetry(async () => {
			const form = new FormData();
			form.append("file", file);
			const res = await fetch(`/api/exams/${exam.id}/materials`, { method: "POST", body: form }).catch(() => null);
			return !!res?.ok;
		});
	return (
		<div className="flex flex-col gap-3 px-1" data-testid="exam-guide-missing">
			<p role="alert" className="text-sm text-warn">
				{reason ? t("exams.guide.missing", { reason: reason.replace(/[.\s]+$/, "") }) : t("exams.guide.missingNoReason")}
			</p>
			{mode && (
				<div className="flex flex-col gap-2">
					{mode === "paste" ? (
						<textarea value={value} onChange={(e) => setValue(e.target.value)} rows={8} placeholder={t("exams.guide.pastePlaceholder")} className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50" data-testid="exam-guide-paste" />
					) : (
						<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50" data-testid="exam-guide-link" />
					)}
					<button type="button" className={cn(primaryBtn, "self-start")} disabled={busy || !value.trim() || (mode === "link" && !/^https?:\/\//i.test(value.trim()))} onClick={() => void saveTyped()}>
						{t("exams.guide.save")}
					</button>
				</div>
			)}
			<input ref={fileRef} type="file" accept={MATERIAL_ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
			<div className="flex flex-wrap gap-2">
				<button type="button" className={quietBtn} disabled={busy} onClick={() => setMode(mode === "paste" ? null : "paste")}>
					{t("exams.guide.paste")}
				</button>
				<button type="button" className={quietBtn} disabled={busy} onClick={() => fileRef.current?.click()}>
					{t("exams.guide.attach")}
				</button>
				<button type="button" className={quietBtn} disabled={busy} onClick={() => setMode(mode === "link" ? null : "link")}>
					{t("exams.guide.link")}
				</button>
				<button type="button" className={quietBtn} disabled={busy} onClick={() => void act("retry")} data-testid="exam-guide-retry">
					{t("exams.guide.retry")}
				</button>
				<button type="button" className={quietBtn} disabled={busy} onClick={() => void act("skip")} data-testid="exam-guide-skip">
					{t("exams.guide.skip")}
				</button>
			</div>
			{error && <p role="alert" className="text-sm text-warn">{error}</p>}
		</div>
	);
}

/** The guide line of Revisar and the exam page (owner 2026-11-06). */
function GuideHeader({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const guide = exam.record.guide;
	if (!guide || guide.state === "missing") return null;
	const label =
		guide.state === "found" && guide.title ? (guide.year ? t("exams.guide.foundYear", { title: guide.title, year: guide.year }) : t("exams.guide.found", { title: guide.title })) : t("exams.guide.none");
	const link = guide.state === "found" && guide.sourceKind === "web" && guide.ref && /^https?:\/\//i.test(guide.ref) ? guide.ref : null;
	return (
		<div className="flex flex-col gap-1 px-1 text-sm" data-testid="exam-guide">
			{link ? (
				<a href={link} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
					{label}
				</a>
			) : (
				<span className={cn("font-medium", guide.state !== "found" && "text-warn")}>{label}</span>
			)}
			{guide.scopeNote && <span className="text-muted-foreground">{guide.scopeNote}</span>}
			{(guide.conflicts?.length ?? 0) > 0 && (
				<div className="text-warn" data-testid="exam-guide-conflicts">
					<span>{t("exams.guide.conflicts")}</span>
					<ul className="list-disc pl-5">
						{guide.conflicts!.map((c) => (
							<li key={c}>{c}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** A point's origin badge (owner 2026-11-06). */
function OriginBadge({ origin }: { origin?: PointOrigin }) {
	const t = useT();
	if (!origin) return null;
	return <span className={cn("shrink-0 rounded-full border px-2 text-xs", origin === "official" ? "text-muted-foreground" : origin === "extra" ? "text-primary" : "text-warn")}>{t(`exams.origin.${origin}` as MessageKey)}</span>;
}

/** A target's source line (owner-approved texts). */
export function targetSourceLabel(target: TargetIdea, materials: readonly ExamMaterial[], t: Translate): string {
	const { source } = target;
	if (source.kind === "user") return "";
	if (source.kind === "model") return t("exams.targets.model");
	if (source.kind === "notes") return t("exams.targets.notes");
	if (source.kind === "material") return t("exams.targets.material", { name: materials.find((m) => m.id === source.ref)?.name ?? source.title });
	return source.year ? t("exams.targets.webYear", { title: source.title, year: source.year }) : t("exams.targets.web", { title: source.title });
}

/** A block's or a point's type (owner 2026-11-06): Temario ·
 *  Instrucciones de la asignatura · Instrucciones para el tutor. */
function KindSelect({ value, label, disabled, onChange }: { value: PointKind; label: string; disabled?: boolean; onChange: (kind: PointKind) => void }) {
	const t = useT();
	return (
		<Select
			value={value}
			disabled={disabled}
			ariaLabel={label}
			size="sm"
			onChange={onChange}
			className="max-w-60 shrink-0 text-muted-foreground"
			testid="exam-kind"
			options={POINT_KINDS.map((k) => ({ value: k, label: t(`exams.kind.${k}` as MessageKey) }))}
		/>
	);
}

/** POST a type change; the changed points are researched again. */
async function changeKind(examId: string, blockId: string, pointId: string | null, kind: PointKind): Promise<string | null> {
	const res = await sendJson(`/api/exams/${examId}/kind`, "POST", { blockId, pointId, kind });
	if (res.ok) return null;
	return res.body.code === "models_not_configured" ? "models_not_configured" : String(res.body.error ?? "");
}

/** Revisar's «Ampliación (N)» of a point, each idea with «Ascender a
 *  punto extra» (owner 2026-11-06). */
function ReviewExtension({ ids, names, onPromote }: { ids: readonly string[]; names: ReadonlyMap<string, string>; onPromote: (ideaId: string) => void }) {
	const t = useT();
	const [openList, setOpenList] = useState(false);
	return (
		<div className="mt-1 pl-4" data-testid="exam-review-extension">
			<button type="button" aria-expanded={openList} onClick={() => setOpenList((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className={cn("size-3.5 transition-transform", openList && "rotate-90")} />
				{t("exams.extension.title", { n: ids.length })}
			</button>
			{openList && (
				<ul className="mt-0.5 flex flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
					{ids.map((n) => (
						<li key={n} className="flex items-center justify-between gap-2">
							<span className="min-w-0 truncate">{names.get(n) ?? n}</span>
							<button type="button" onClick={() => onPromote(n)} className="shrink-0 underline-offset-2 hover:text-foreground hover:underline" data-testid="exam-promote">
								{t("exams.extension.promote")}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Step 4 — review: blocks → points → target ideas with their source and
 *  links; edit, remove, add; re-research a point or everything. */
function MappingStep({ exam, onDone }: { exam: ExamDetailView; onDone: () => void }) {
	const t = useT();
	const [blocks, setBlocks] = useState<SyllabusBlock[]>(exam.record.blocks);
	const [prereqs, setPrereqs] = useState<ExamPrerequisite[]>(exam.record.prerequisites ?? []);
	const [open, setOpen] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setBlocks(exam.record.blocks), [exam.record.blocks]);
	useEffect(() => setPrereqs(exam.record.prerequisites ?? []), [exam.record.prerequisites]);
	const studied = useMemo(
		() => blocks.filter((b) => !b.excluded).flatMap((b) => b.points.filter((p) => pointKind(b, p) === "syllabus" && p.text.trim()).map((p) => ({ id: p.id, text: p.text }))),
		[blocks],
	);
	const prereqSearch = exam.record.prerequisiteSearch;
	const retryPrereqs = async () => {
		setError(null);
		if (!(await persist())) return;
		const res = await sendJson(`/api/exams/${exam.id}/prerequisites`, "POST", {});
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.prereq.failed", { error: String(res.body.error ?? "") }));
	};
	const names = useMemo(() => new Map((exam.model?.ideas ?? []).map((i) => [i.nodeId, i.name])), [exam.model]);
	const materials = exam.record.materials;

	const edit = (blockId: string, f: (b: SyllabusBlock) => SyllabusBlock | null) =>
		setBlocks((list) => list.map((b) => (b.id === blockId ? f(b) : b)).filter((b): b is SyllabusBlock => b !== null));
	const editPoint = (blockId: string, pointId: string, f: (p: SyllabusPoint) => SyllabusPoint) =>
		edit(blockId, (b) => ({ ...b, points: b.points.map((p) => (p.id === pointId ? f(p) : p)) }));

	const cleaned = () =>
		blocks
			.map((b) => ({
				...b,
				title: b.title.trim(),
				points: b.points
					.map((p) => ({ ...p, text: p.text.trim(), ...(p.targets ? { targets: p.targets.map((x) => ({ ...x, statement: x.statement.trim() })).filter((x) => x.statement) } : {}) }))
					.filter((p) => p.text),
			}))
			.filter((b) => b.title && b.points.length > 0);
	const persist = async () => {
		const res = await sendJson(`/api/exams/${exam.id}`, "PUT", { blocks: cleaned(), prerequisites: cleanPrerequisites(prereqs) });
		if (!res.ok) setError(typeof res.body.error === "string" ? res.body.error : t("exams.wizard.saveFailed"));
		return res.ok;
	};
	const confirm = async () => {
		setSaving(true);
		setError(null);
		const ok = pending > 0 ? await researchPending() : await persist();
		setSaving(false);
		if (ok) onDone();
	};
	// Owner 2026-11-06: a type change only marks the point pending.
	const setKind = (blockId: string, pointId: string | null, kind: PointKind) => setBlocks((list) => setPointKind(list, blockId, pointId, kind).blocks);
	const pending = pendingKindPoints({ blocks }).length;
	const researchPending = async () => {
		setError(null);
		if (!(await persist())) return false;
		const res = await sendJson(`/api/exams/${exam.id}/research`, "POST", { mode: "pending" });
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
		return res.ok;
	};
	/** «Ascender a punto extra»: save the edits first, then promote. */
	const promote = async (pointId: string, ideaId: string) => {
		setError(null);
		if (!(await persist())) return;
		const res = await sendJson(`/api/exams/${exam.id}/promote`, "POST", { pointId, ideaId });
		if (!res.ok) setError(t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	const rerun = async (body: { pointId: string } | { mode: "all" }) => {
		setError(null);
		if (!(await persist())) return;
		const res = await sendJson(`/api/exams/${exam.id}/research`, "POST", body);
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};

	const input = "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 outline-none hover:border-border focus:border-primary/50";
	const smallBtn = "shrink-0 text-xs text-muted-foreground hover:text-foreground";
	return (
		<section className="flex flex-col gap-4" data-testid="exam-mapping">
			<SectionTitle>{t("exams.wizard.review")}</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.wizard.reviewHint")}</p>
			{(exam.reading?.failed.length ?? 0) > 0 && (
				<p role="status" className="px-1 text-sm text-warn" data-testid="exam-read-failed">
					{t("exams.wizard.readFailed", { list: exam.reading!.failed.map((f) => folderName(f.path)).join(", ") })}
				</p>
			)}
			{exam.record.research && !exam.record.research.web && <p className="px-1 text-sm text-warn">{t("exams.wizard.noWeb")}</p>}
			<GuideHeader exam={exam} />
			{blocks.map((b) => (
				<div key={b.id} className={cn("overflow-hidden rounded-xl border", b.excluded && "opacity-60")} data-testid="exam-review-block">
					<div className="flex items-center gap-2 border-b bg-accent/30 px-2 py-1.5">
						<input value={b.title} onChange={(e) => edit(b.id, (x) => ({ ...x, title: e.target.value }))} aria-label={t("exams.wizard.blockTitle")} className={cn(input, "font-medium")} />
						<label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
							<input
								type="checkbox"
								checked={!b.excluded}
								onChange={(e) =>
									edit(b.id, (x) => {
										const { excluded: _e, ...rest } = x;
										return e.target.checked ? rest : { ...rest, excluded: true };
									})
								}
								data-testid="exam-in-sitting"
							/>
							{t("exams.guide.inSitting")}
						</label>
						<KindSelect value={b.kind ?? "syllabus"} label={t("exams.kind.label", { text: b.title })} onChange={(k) => setKind(b.id, null, k)} />
						<button type="button" aria-label={t("exams.wizard.removeBlock", { title: b.title })} onClick={() => edit(b.id, () => null)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
							<XIcon className="size-4" />
						</button>
					</div>
					<ul>
						{b.points.map((p) => {
							const kind = pointKind(b, p);
							const isRule = kind !== "syllabus";
							return (
							<li key={p.id} className="border-b px-2 py-1.5 text-sm last:border-b-0" data-testid="exam-review-point">
								<div className="flex items-center gap-2">
									<input value={p.text} onChange={(e) => editPoint(b.id, p.id, (y) => ({ ...y, text: e.target.value }))} aria-label={t("exams.wizard.pointText")} className={input} />
									<OriginBadge origin={p.origin} />
									<KindSelect value={kind} label={t("exams.kind.label", { text: p.text })} onChange={(k) => setKind(b.id, p.id, k)} />
									{p.pendingFrom ? (
										<span className="shrink-0 text-warn" data-testid="exam-kind-pending">{t("exams.kind.pending")}</span>
									) : p.targets ? (
										<button type="button" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)} className="shrink-0 text-muted-foreground hover:text-foreground">
											{t(isRule ? "exams.rules.title" : "exams.targets.title", { n: p.targets.length })}
										</button>
									) : isRule ? (
										<button type="button" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)} className="shrink-0 text-muted-foreground hover:text-foreground">
											{t("exams.rules.title", { n: 0 })}
										</button>
									) : p.nodeIds.length === 0 ? (
										<span className="shrink-0 text-muted-foreground">{t("exams.point.gap")}</span>
									) : (
										<button type="button" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)} className="shrink-0 text-muted-foreground hover:text-foreground">
											{t("exams.wizard.ideas", { n: p.nodeIds.length })}
										</button>
									)}
									<button type="button" aria-label={t("exams.wizard.removePoint", { text: p.text })} onClick={() => edit(b.id, (x) => ({ ...x, points: x.points.filter((y) => y.id !== p.id) }))} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
										<XIcon className="size-4" />
									</button>
								</div>
								{open === p.id && !p.pendingFrom && (p.targets || isRule) && (
									<div className="mt-1 flex flex-col gap-2 pl-4" data-testid="exam-targets">
										<ul className="flex flex-col gap-2">
											{(p.targets ?? []).map((target) => {
												const label = targetSourceLabel(target, materials, t);
												return (
													<li key={target.id} className="rounded-md border px-2 py-1.5" data-testid="exam-target">
														<div className="flex items-start gap-2">
															<textarea
																value={target.statement}
																rows={2}
																aria-label={t(isRule ? "exams.rules.statement" : "exams.targets.statement")}
																onChange={(e) => editPoint(b.id, p.id, (y) => ({ ...y, targets: (y.targets ?? []).map((z) => (z.id === target.id ? { ...z, statement: e.target.value } : z)) }))}
																className={cn(input, "resize-y")}
															/>
															<button type="button" aria-label={t(isRule ? "exams.rules.remove" : "exams.targets.remove")} onClick={() => editPoint(b.id, p.id, (y) => ({ ...y, targets: (y.targets ?? []).filter((z) => z.id !== target.id) }))} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
																<XIcon className="size-4" />
															</button>
														</div>
														<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
															{label && (target.source.kind === "web" && target.source.ref ? (
																<a href={target.source.ref} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
																	{label}
																</a>
															) : (
																<span>{label}</span>
															))}
															{target.source.outdated && <span className="text-warn">{t("exams.targets.outdated")}</span>}
															{isRule ? null : target.nodeIds.length === 0 ? (
																<span>{t("exams.targets.unlinked")}</span>
															) : (
																<span className="flex flex-wrap items-center gap-1">
																	{t("exams.targets.have", { names: "" })}
																	{target.nodeIds.map((n) => (
																		<span key={n} className="inline-flex items-center gap-1 rounded-full border px-2">
																			{names.get(n) ?? n}
																			<button type="button" onClick={() => editPoint(b.id, p.id, (y) => ({ ...y, targets: (y.targets ?? []).map((z) => (z.id === target.id ? { ...z, nodeIds: z.nodeIds.filter((q) => q !== n) } : z)) }))} className="hover:text-foreground">
																				{t("exams.wizard.unlink")}
																			</button>
																		</span>
																	))}
																</span>
															)}
														</div>
													</li>
												);
											})}
										</ul>
										<div className="flex flex-wrap gap-3">
											<button type="button" className={smallBtn} onClick={() => editPoint(b.id, p.id, (y) => ({ ...y, targets: [...(y.targets ?? []), { id: localId("t_"), statement: "", source: { kind: "user", title: "" }, nodeIds: [] }] }))}>
												+ {t(isRule ? "exams.rules.add" : "exams.targets.add")}
											</button>
											<button type="button" className={smallBtn} onClick={() => void rerun({ pointId: p.id })} data-testid="exam-rerun-point">
												{t("exams.targets.rerunPoint")}
											</button>
										</div>
									</div>
								)}
								{(p.extension?.length ?? 0) > 0 && !p.pendingFrom && (
									<ReviewExtension ids={p.extension!} names={names} onPromote={(ideaId) => void promote(p.id, ideaId)} />
								)}
								{open === p.id && !p.pendingFrom && !p.targets && !isRule && (
									<ul className="mt-1 flex flex-col gap-1 pl-4">
										{p.nodeIds.map((n) => (
											<li key={n} className="flex items-center justify-between gap-2 text-muted-foreground">
												<span className="min-w-0 truncate">{names.get(n) ?? n}</span>
												<button type="button" onClick={() => editPoint(b.id, p.id, (y) => ({ ...y, nodeIds: y.nodeIds.filter((z) => z !== n) }))} className="shrink-0 text-xs hover:text-foreground">
													{t("exams.wizard.unlink")}
												</button>
											</li>
										))}
									</ul>
								)}
							</li>
							);
						})}
					</ul>
					<button type="button" onClick={() => edit(b.id, (x) => ({ ...x, points: [...x.points, { id: localId("p_"), text: "", nodeIds: [] }] }))} className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground">
						<PlusIcon className="size-4" />
						{t("exams.wizard.addPoint")}
					</button>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<button type="button" onClick={() => setBlocks((list) => [...list, { id: localId("b_"), title: t("exams.wizard.newBlock"), points: [] }])} className={quietBtn}>
					{t("exams.wizard.addBlock")}
				</button>
				{pending > 0 && (
					<button type="button" onClick={() => void researchPending()} className={quietBtn} data-testid="exam-research-pending">
						{t("exams.kind.researchPending", { n: pending })}
					</button>
				)}
				<button type="button" onClick={() => void rerun({ mode: "all" })} className={quietBtn} data-testid="exam-rerun-all">
					{t("exams.targets.rerunAll")}
				</button>
			</div>
			{prereqSearch?.state === "running" ? (
				<p className="px-1 text-sm text-muted-foreground" aria-live="polite">{t("exams.prereq.running")}</p>
			) : prereqSearch?.state === "error" ? (
				<div className="flex flex-wrap items-center gap-3 px-1">
					<p role="alert" className="text-sm text-warn">{t("exams.prereq.failed", { error: prereqSearch.error ?? "" })}</p>
					<button type="button" className={quietBtn} onClick={() => void retryPrereqs()} data-testid="exam-prereq-retry">
						{t("exams.prereq.retry")}
					</button>
				</div>
			) : null}
			<PrerequisitesEditor value={prereqs} points={studied} onChange={setPrereqs} />
			{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
			<div className="flex justify-end px-1">
				<button type="button" className={primaryBtn} disabled={saving} onClick={() => void confirm()} data-testid="exam-confirm-mapping">
					{t("exams.wizard.confirm")}
				</button>
			</div>
		</section>
	);
}

/** Presets + «Personalizar» (recall, mode, coverage). */
export function StandardPicker({ value, onChange }: { value: ExamStandard; onChange: (next: ExamStandard) => void }) {
	const t = useT();
	const [custom, setCustom] = useState(value.preset === null);
	return (
		<div className="flex flex-col gap-3 px-1" data-testid="exam-standard">
			<div role="radiogroup" aria-label={t("exams.wizard.standard")} className="flex flex-wrap gap-2">
				{PRESET_ORDER.map((p) => (
					<button
						key={p}
						type="button"
						role="radio"
						aria-checked={value.preset === p}
						onClick={() => {
							setCustom(false);
							onChange(presetStandard(p));
						}}
						className={cn("rounded-md border px-4 py-2 text-sm transition-colors", value.preset === p ? "border-primary bg-primary/10" : "hover:bg-accent")}
					>
						{presetLabel(p, t)}
					</button>
				))}
			</div>
			<p className="text-sm text-muted-foreground">
				{t("exams.standard.line", { recall: Math.round(value.recall * 100), mode: modeLabel(value.mode, t), coverage: Math.round(value.coverage * 100) })}
			</p>
			<button type="button" aria-expanded={custom} onClick={() => setCustom((v) => !v)} className="self-start text-sm text-muted-foreground hover:text-foreground">
				{t("exams.standard.customize")} {custom ? "▴" : "▾"}
			</button>
			{custom && (
				<div className="grid gap-3 sm:grid-cols-3">
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.standard.recall")}</span>
						<input type="number" min={50} max={99} value={Math.round(value.recall * 100)} onChange={(e) => onChange({ ...value, preset: null, recall: Math.min(99, Math.max(50, Number(e.target.value) || 50)) / 100 })} className={fieldInput} />
					</label>
					<div className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.standard.mode")}</span>
						<Select
							value={value.mode}
							ariaLabel={t("exams.standard.mode")}
							onChange={(mode) => onChange({ ...value, preset: null, mode })}
							options={(Object.keys(MODE_LEVEL) as DemandMode[]).map((m) => ({ value: m, label: modeLabel(m, t) }))}
						/>
					</div>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.standard.coverage")}</span>
						<input type="number" min={5} max={100} value={Math.round(value.coverage * 100)} onChange={(e) => onChange({ ...value, preset: null, coverage: Math.min(100, Math.max(5, Number(e.target.value) || 5)) / 100 })} className={fieldInput} />
					</label>
				</div>
			)}
		</div>
	);
}

const WEEKDAY_KEYS: MessageKey[] = ["exams.weekday.mon", "exams.weekday.tue", "exams.weekday.wed", "exams.weekday.thu", "exams.weekday.fri", "exams.weekday.sat", "exams.weekday.sun"];

export function WeeklyMinutes({ value, onChange }: { value: readonly number[]; onChange: (next: number[]) => void }) {
	const t = useT();
	return (
		<div className="grid grid-cols-7 gap-2 px-1" data-testid="exam-weekly">
			{value.map((m, i) => (
				<label key={i} className="flex flex-col items-center gap-1 text-sm">
					<span className="text-muted-foreground">{t(WEEKDAY_KEYS[i]!)}</span>
					<input
						type="number"
						min={0}
						max={720}
						value={m}
						aria-label={t("exams.weekly.aria", { day: t(WEEKDAY_KEYS[i]!) })}
						onChange={(e) => onChange(value.map((x, j) => (j === i ? Math.min(720, Math.max(0, Math.round(Number(e.target.value) || 0))) : x)))}
						className="w-full rounded-md border bg-background px-1 py-2 text-center tabular-nums"
					/>
				</label>
			))}
		</div>
	);
}

/** Step 2 — the standard (the research's depth follows it), then
 *  «Investigar»: unread folders in the scope get the notice first. */
function StandardStep({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const [standard, setStandard] = useState<ExamStandard>(exam.standard);
	const [toRead, setToRead] = useState<Array<{ path: string; unread: number }> | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const start = async () => {
		setBusy(true);
		setError(null);
		const res = await sendJson(`/api/exams/${exam.id}/map`, "POST");
		setBusy(false);
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	const investigate = async () => {
		setBusy(true);
		setError(null);
		const saved = await sendJson(`/api/exams/${exam.id}`, "PUT", { standard });
		if (!saved.ok) {
			setBusy(false);
			setError(t("exams.wizard.saveFailed"));
			return;
		}
		const { folders, directFolders } = exam.record.syllabus;
		if (folders.length > 0 || directFolders.length > 0) {
			const plan = await sendJson("/api/exams/folders", "POST", { folders, directFolders });
			const add = (plan.body.add as Array<{ path: string; unread: number }> | undefined) ?? [];
			if (add.length > 0) {
				setBusy(false);
				setToRead(add);
				return;
			}
		}
		await start();
	};
	return (
		<section className="flex flex-col gap-4">
			<SectionTitle>{t("exams.wizard.standard")}</SectionTitle>
			<StandardPicker value={standard} onChange={setStandard} />
			{toRead && (
				<div role="dialog" aria-labelledby="exam-read-title" className="mx-1 flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm" data-testid="exam-read-notice">
					<p id="exam-read-title" className="font-medium">
						{t("exams.read.notice")}
					</p>
					<ul className="list-disc pl-5">
						{toRead.map((f) => (
							<li key={f.path} title={f.path}>
								{t("exams.read.item", { path: shortFolder(f.path), n: f.unread })}
							</li>
						))}
					</ul>
					<p className="text-muted-foreground">{t("exams.read.after")}</p>
					<div className="flex justify-end gap-2">
						<button type="button" className={quietBtn} onClick={() => setToRead(null)}>
							{t("exams.read.cancel")}
						</button>
						<button type="button" className={primaryBtn} disabled={busy} onClick={() => void start()} data-testid="exam-read-confirm">
							{t("exams.read.confirm")}
						</button>
					</div>
				</div>
			)}
			{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
			{!toRead && (
				<div className="flex justify-end px-1">
					<button type="button" className={primaryBtn} disabled={busy} onClick={() => void investigate()} data-testid="exam-investigate">
						{t("exams.wizard.investigate")}
					</button>
				</div>
			)}
		</section>
	);
}

/** Step 5 — the global weekly budget + forecast → «Crear plan». */
function TimeStep({ exam, back }: { exam: ExamDetailView; back: () => void }) {
	const t = useT();
	const { locale } = useLocale();
	const [weekly, setWeekly] = useState<number[]>(exam.weeklyMinutes);
	const [preview, setPreview] = useState<{ bestPreset: ExamPreset | null; feasible: boolean; extraPerDay: number } | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const standard = exam.standard;

	useEffect(() => {
		let live = true;
		const timer = setTimeout(() => {
			void sendJson(`/api/exams/${exam.id}/preview`, "POST", { standard, weeklyMinutes: weekly }).then((r) => {
				if (live && r.ok) setPreview(r.body as unknown as { bestPreset: ExamPreset | null; feasible: boolean; extraPerDay: number });
			});
		}, 300);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [exam.id, standard, weekly]);

	const create = async () => {
		setSaving(true);
		setError(null);
		const settings = (await fetch("/api/settings").then((r) => r.json()).catch(() => ({}))) as { settings?: { exams?: object } };
		const savedWeekly = await sendJson("/api/settings/exams", "PUT", { ...(settings.settings?.exams ?? {}), weeklyMinutes: weekly });
		const activated = savedWeekly.ok ? await sendJson(`/api/exams/${exam.id}`, "PUT", { standard, status: "active" }) : savedWeekly;
		setSaving(false);
		if (!activated.ok) setError(typeof activated.body.error === "string" ? activated.body.error : t("exams.wizard.saveFailed"));
	};

	return (
		<section className="flex flex-col gap-4">
			<SectionTitle>{t("exams.wizard.time")}</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.wizard.timeHint")}</p>
			<WeeklyMinutes value={weekly} onChange={setWeekly} />
			<p className="px-1 text-sm" data-testid="exam-preview" aria-live="polite">
				{preview === null
					? t("exams.wizard.previewing")
					: preview.bestPreset
						? t("exams.wizard.preview", { level: presetLabel(preview.bestPreset, t), date: dateLabel(exam.examDate, locale) })
						: t("exams.wizard.previewNone", { date: dateLabel(exam.examDate, locale) })}
			</p>
			{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
			<div className="flex justify-between px-1">
				<button type="button" className={quietBtn} onClick={back}>
					{t("exams.wizard.back")}
				</button>
				<button type="button" className={primaryBtn} disabled={saving} onClick={() => void create()} data-testid="exam-create-plan">
					{t("exams.wizard.create")}
				</button>
			</div>
		</section>
	);
}

/** A draft resumes at its step: 2 standard (nothing started), 3 while the
 *  read → outline → research runs or failed, 4 review, 5 time. */
export function draftStep(mapping: ExamRecord["mapping"]["state"]): 2 | 3 | 4 {
	if (mapping === "none") return 2;
	if (mapping === "done") return 4;
	return 3;
}

function DraftWizard({ exam, reload }: { exam: ExamDetailView; reload: () => void }) {
	const router = useRouter();
	const auto = draftStep(exam.record.mapping.state);
	const [confirmed, setConfirmed] = useState(false);
	// «Confirmar» with pending type changes researches them first: step 3
	// until they are settled, then straight on to 5.
	const waiting = confirmed && auto === 4 && pendingKindPoints(exam.record).length > 0;
	const step: WizardStep = waiting ? 3 : auto === 4 && confirmed ? 5 : auto;
	return (
		<div className="h-full overflow-y-auto" data-testid="exam-wizard">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-8 px-4 pb-16 pt-10">
				<StepHeader step={step} />
				<div className="flex items-center justify-between gap-3 px-1">
					<p className="min-w-0 truncate font-medium">{exam.title}</p>
					<ExamMenu exam={exam} onDeleted={() => router.push("/exams")} />
				</div>
				{step === 2 && <StandardStep exam={exam} />}
				{step === 3 && <ResearchProgress exam={exam} />}
				{step === 4 && (
					<MappingStep
						exam={exam}
						onDone={() => {
							reload();
							setConfirmed(true);
						}}
					/>
				)}
				{step === 5 && <TimeStep exam={exam} back={() => setConfirmed(false)} />}
			</div>
		</div>
	);
}

// ─── one exam ───────────────────────────────────────────────────────────────

function TodaySection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const { state, start } = useStartExamSession(exam.id);
	const points = exam.model?.points ?? [];
	const prereqs = exam.model?.prerequisites ?? [];
	const total = Math.round(exam.blocks.reduce((s, b) => s + b.minutes, 0));
	const first = exam.blocks[0];
	return (
		<section className="flex flex-col gap-3" data-testid="exam-today">
			<SectionTitle
				right={
					first ? (
						<button type="button" className={primaryBtn} disabled={state === "starting"} onClick={() => void start(first.kind, first.prerequisiteId ?? first.pointId)} data-testid="exam-start">
							{state === "starting" ? t("exams.today.starting") : t("exams.today.start")}
						</button>
					) : undefined
				}
			>
				{first ? t("exams.today.title", { min: total }) : t("exams.today.empty")}
			</SectionTitle>
			{exam.blocks.length > 0 && (
				<ol className="overflow-hidden rounded-xl border">
					{exam.blocks.map((b, i) => (
						<li key={`${b.kind}:${b.prerequisiteId ?? b.pointId ?? i}`} className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0">
							<span className="flex min-w-0 items-center gap-3">
								<span className="tabular-nums text-muted-foreground">{i + 1}</span>
								<span className="min-w-0 truncate">{blockLabel(b, points, t, prereqs)}</span>
							</span>
							<span className="flex shrink-0 items-center gap-3">
								<span className="tabular-nums text-muted-foreground">~{Math.round(b.minutes)} min</span>
								<button type="button" className="text-muted-foreground hover:text-foreground" disabled={state === "starting"} aria-label={t("exams.today.startBlock", { block: blockLabel(b, points, t, prereqs) })} onClick={() => void start(b.kind, b.prerequisiteId ?? b.pointId)}>
									<ChevronRightIcon className="size-4" />
								</button>
							</span>
						</li>
					))}
				</ol>
			)}
			{state === "failed" && <p role="alert" className="px-1 text-xs text-warn">{t("exams.today.startFailed")}</p>}
		</section>
	);
}

function LevelSection({ exam, onPrioritize }: { exam: ExamDetailView; onPrioritize: () => void }) {
	const t = useT();
	const coverage = pct(exam.coverage) ?? 0;
	const target = Math.round(exam.standard.coverage * 100);
	const [busy, setBusy] = useState(false);
	const raise = async (extra: number) => {
		setBusy(true);
		const settings = (await fetch("/api/settings").then((r) => r.json()).catch(() => ({}))) as { settings?: { exams?: object } };
		await sendJson("/api/settings/exams", "PUT", { ...(settings.settings?.exams ?? {}), weeklyMinutes: raiseWeekly(exam.weeklyMinutes, extra) });
		setBusy(false);
	};
	const lower = async (preset: ExamPreset) => {
		setBusy(true);
		await sendJson(`/api/exams/${exam.id}`, "PUT", { standard: presetStandard(preset) });
		setBusy(false);
	};
	const best = exam.infeasible?.bestPreset ?? null;
	return (
		<section className="flex flex-col gap-3" data-testid="exam-level">
			<SectionTitle>{t("exams.level.title")}</SectionTitle>
			<div className="flex items-baseline gap-3 px-1">
				<span className="text-5xl font-semibold tracking-tight" data-testid="exam-coverage">{coverage}%</span>
				<span className="text-sm text-muted-foreground">{t("exams.level.target", { level: standardName(exam.standard, t), n: target })}</span>
			</div>
			<div className="px-1">
				<CoverageBar labelled value={coverage} target={target} label={t("exams.level.bar", { n: coverage, target })} />
			</div>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.level.now", { level: exam.reachedPreset ? presetLabel(exam.reachedPreset, t) : t("exams.level.none") })}</p>
			{exam.infeasible && (
				<div className="flex flex-col gap-3 rounded-xl border border-warn/40 px-4 py-3" role="status" data-testid="exam-behind">
					<p className="flex items-start gap-2 text-sm">
						<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warn" />
						{best && best !== exam.standard.preset
							? t("exams.level.reaches", { best: presetLabel(best, t), target: standardName(exam.standard, t) })
							: t("exams.level.reachesNone", { target: standardName(exam.standard, t) })}
					</p>
					<div className="flex flex-wrap gap-2">
						<button type="button" className={quietBtn} disabled={busy} onClick={() => void raise(exam.infeasible!.extraPerDay)} data-testid="exam-raise">
							{t("exams.level.raise", { n: exam.infeasible.extraPerDay })}
						</button>
						{best && best !== exam.standard.preset && PRESET_ORDER.indexOf(best) < PRESET_ORDER.indexOf(exam.standard.preset ?? "distinction") && (
							<button type="button" className={quietBtn} disabled={busy} onClick={() => void lower(best)} data-testid="exam-lower">
								{t("exams.level.lower", { level: presetLabel(best, t) })}
							</button>
						)}
						<button type="button" className={quietBtn} onClick={onPrioritize} data-testid="exam-prioritize">
							{t("exams.level.prioritize")}
						</button>
					</div>
				</div>
			)}
		</section>
	);
}

/** Planned minutes per day, the next 14 days (the shared BarChart:
 *  values on hover/focus/tap, the sr-only table holds them all). */
function PlanSection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const { locale } = useLocale();
	const counts = exam.allocation.slice(0, 14);
	const days = exam.days.slice(0, counts.length);
	if (counts.length === 0) return null;
	const label = (i: number) => (i === 0 ? t("exams.plan.today") : dateLabel(days[i]!, locale, { weekday: "short", day: "numeric" }));
	return (
		<section className="flex flex-col gap-3" data-testid="exam-plan">
			<SectionTitle>{t("exams.plan.title")}</SectionTitle>
			<BarChart
				values={counts}
				caption={t("exams.plan.title")}
				axisLabel={(i) => (i === 0 ? t("exams.plan.today") : dateLabel(days[i]!, locale, { weekday: "narrow" }))}
				barLabel={(i) => t("exams.plan.bar", { date: label(i), n: Math.round(counts[i]!) })}
			/>
		</section>
	);
}

/** A target idea's status line (owner-approved texts). */
export function targetStateLabel(target: Pick<TargetStatus, "state" | "nodeIds">, ideas: ReadonlyMap<string, IdeaStatus>, t: Translate): string {
	switch (target.state) {
		case "mastered":
			return t("exams.target.mastered");
		case "linked": {
			const linked = target.nodeIds.map((n) => ideas.get(n)).filter((i): i is IdeaStatus => !!i);
			const weakest = [...linked].sort((a, b) => a.level - b.level)[0];
			const recalls = linked.map((i) => i.recallAtExam).filter((r): r is number => r !== null);
			const recall = recalls.length ? Math.round(Math.min(...recalls) * 100) : null;
			return weakest ? `${ideaLevelLabel(weakest, t)}${recall !== null ? ` · ${recall}%` : ""}` : t("exams.target.toLearn");
		}
		case "placement":
			return t("exams.target.placement");
		case "consolidate":
			return t("exams.target.known");
		case "teach":
			return t("exams.target.toLearn");
	}
}

/** «Bloqueado por: …» under a point a prerequisite holds back (owner
 *  2026-11-09). */
function BlockedBy({ exam, point }: { exam: ExamDetailView; point: Pick<PointStatus, "blockedBy"> }) {
	const t = useT();
	if (!point.blockedBy?.length) return null;
	const text = new Map((exam.model?.prerequisites ?? []).map((q) => [q.id, q.statement]));
	return (
		<p className="mt-0.5 text-xs text-warn" data-testid="exam-point-blocked">
			{t("exams.point.blockedBy", { list: point.blockedBy.map((id) => text.get(id) ?? id).join("; ") })}
		</p>
	);
}

function IdeaRow({ idea, action }: { idea: IdeaStatus; action?: React.ReactNode }) {
	const t = useT();
	const recall = pct(idea.recallAtExam);
	return (
		<li className="flex items-center justify-between gap-3 text-muted-foreground">
			<span className="min-w-0 truncate">{idea.name}</span>
			<span className="flex shrink-0 items-center gap-1.5 tabular-nums">
				{ideaLevelLabel(idea, t)}
				{recall !== null && ` · ${recall}%`}
				{idea.meets && <CheckIcon className="size-3.5 text-ok" aria-label={t("exams.idea.meets")} />}
				{action}
			</span>
		</li>
	);
}

/** One researched point on the exam page: its targets with their status,
 *  the ideas linked to each («Pasar a ampliación»), the «Ampliación (N)»
 *  list («Pasar al punto» → which target), and «Profundizar». */
function ResearchedPoint({ exam, point, ideas, onDeepen, kindSelect }: { exam: ExamDetailView; point: PointStatus; ideas: ReadonlyMap<string, IdeaStatus>; onDeepen: () => void; kindSelect: React.ReactNode }) {
	const t = useT();
	const [extOpen, setExtOpen] = useState(false);
	const [picking, setPicking] = useState<string | null>(null);
	const targets = point.targets ?? [];
	const mastered = targets.filter((x) => x.mastered).length;
	const move = (ideaId: string, where: "extension" | { target: string }) => {
		setPicking(null);
		void sendJson(`/api/exams/${exam.id}`, "PUT", { blocks: moveIdea(exam.record.blocks, point.id, ideaId, where) });
	};
	const canDeepen = point.nodeIds.length > 0 || point.taughtSession;
	const smallBtn = "text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
	return (
		<li className="px-4 py-1.5 pl-10 text-sm" data-testid="exam-point">
			<div className="flex items-center justify-between gap-3">
				<span className="min-w-0 truncate">{point.text}</span>
				<span className="flex shrink-0 items-center gap-3 text-muted-foreground">
					{kindSelect}
					<span>{t("exams.point.mastered", { mastered, total: targets.length })}</span>
					<span>· {pointNeedLabel({ ...point, gap: false }, t)}</span>
					{canDeepen && (
						<button type="button" onClick={onDeepen} className={cn(quietBtn, "px-2 py-0.5 text-xs")} data-testid="exam-deepen">
							{t("exams.deepen")}
						</button>
					)}
				</span>
			</div>
			<BlockedBy exam={exam} point={point} />
			<ul className="mt-1 flex flex-col gap-1 pl-4" data-testid="exam-point-targets">
				{targets.map((x) => (
					<li key={x.id}>
						<div className="flex items-start justify-between gap-3">
							<span className={cn("min-w-0", x.mastered ? "text-foreground" : "text-muted-foreground")}>{x.statement}</span>
							<span className={cn("flex shrink-0 items-center gap-1 text-xs tabular-nums", x.state === "mastered" ? "text-ok" : "text-muted-foreground")}>
								{targetStateLabel(x, ideas, t)}
								{x.mastered && <CheckIcon className="size-3.5" aria-hidden />}
							</span>
						</div>
						{x.nodeIds.length > 0 && (
							<ul className="mt-0.5 flex flex-col pl-4 text-xs">
								{x.nodeIds.map((n) => {
									const idea = ideas.get(n);
									return idea ? (
										<IdeaRow
											key={n}
											idea={idea}
											action={
												<button type="button" className={smallBtn} onClick={() => move(n, "extension")}>
													{t("exams.extension.toExtension")}
												</button>
											}
										/>
									) : null;
								})}
							</ul>
						)}
					</li>
				))}
			</ul>
			{point.extension.length > 0 && (
				<div className="mt-1 pl-4" data-testid="exam-extension">
					<button type="button" aria-expanded={extOpen} onClick={() => setExtOpen((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
						<ChevronRightIcon className={cn("size-3.5 transition-transform", extOpen && "rotate-90")} />
						{t("exams.extension.title", { n: point.extension.length })}
					</button>
					{extOpen && (
						<ul className="mt-0.5 flex flex-col gap-0.5 pl-4 text-xs">
							{point.extension.map((n) => {
								const idea = ideas.get(n);
								if (!idea) return null;
								return (
									<li key={n}>
										<ul>
											<IdeaRow
												idea={idea}
												action={
													<span className="flex items-center gap-2">
													<button type="button" className={smallBtn} onClick={() => void sendJson(`/api/exams/${exam.id}/promote`, "POST", { pointId: point.id, ideaId: n })} data-testid="exam-promote">
														{t("exams.extension.promote")}
													</button>
													{picking === n ? (
														<Select
															defaultOpen
															value=""
															size="sm"
															ariaLabel={t("exams.extension.pickTarget")}
															placeholder={t("exams.extension.pickTarget")}
															onChange={(target) => move(n, { target })}
															onDismiss={() => setPicking(null)}
															className="max-w-56"
															options={targets.map((x) => ({ value: x.id, label: x.statement.length > 70 ? `${x.statement.slice(0, 67)}…` : x.statement }))}
														/>
													) : (
														<button type="button" className={smallBtn} onClick={() => setPicking(n)}>
															{t("exams.extension.toPoint")}
														</button>
													)}
													</span>
												}
											/>
										</ul>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			)}
		</li>
	);
}

/** «Contrastar con la guía» (owner 2026-11-06): the differences, chosen
 *  one by one; nothing changes until «Aplicar». */
function ContrastPanel({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const contrast = exam.record.contrast!;
	const missing = contrast.missing ?? [];
	const extras = contrast.extras ?? [];
	const pointText = useMemo(() => new Map(exam.record.blocks.flatMap((b) => b.points.map((p) => [p.id, p.text] as const))), [exam.record.blocks]);
	const [add, setAdd] = useState<Set<string>>(() => new Set(missing.filter((m) => m.inSitting).map((m) => m.id)));
	const [actions, setActions] = useState<Record<string, "extension" | "keep">>(() => Object.fromEntries(extras.map((e) => [e.pointId, "extension" as const])));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = async (method: "PUT" | "DELETE") => {
		setBusy(true);
		setError(null);
		const res = await sendJson(
			`/api/exams/${exam.id}/contrast`,
			method,
			method === "PUT" ? { add: [...add], extras: extras.filter((e) => pointText.has(e.pointId)).map((e) => ({ pointId: e.pointId, action: actions[e.pointId] ?? "extension" })) } : {},
		);
		setBusy(false);
		if (!res.ok) setError(t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	if (contrast.state === "error") {
		const noGuide = contrast.error?.startsWith("no_guide:");
		const reason = noGuide ? contrast.error!.slice("no_guide:".length) : "";
		return (
			<div className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm" data-testid="exam-contrast-panel">
				<p role="alert" className="text-warn">
					{noGuide ? (reason ? t("exams.guide.missing", { reason: reason.replace(/[.\s]+$/, "") }) : t("exams.guide.missingNoReason")) : t("exams.contrast.failed", { error: contrast.error ?? "" })}
				</p>
				<button type="button" className={cn(quietBtn, "self-start")} disabled={busy} onClick={() => void send("DELETE")}>
					{t("exams.contrast.discard")}
				</button>
			</div>
		);
	}
	const shownExtras = extras.filter((e) => pointText.has(e.pointId));
	return (
		<div className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm" data-testid="exam-contrast-panel">
			{missing.length === 0 && shownExtras.length === 0 ? (
				<p>{t("exams.contrast.same")}</p>
			) : (
				<>
					{missing.length > 0 && (
						<div className="flex flex-col gap-1">
							<p className="font-medium">{t("exams.contrast.missing", { n: missing.length })}</p>
							<ul className="flex flex-col gap-1">
								{missing.map((m) => (
									<li key={m.id} className={cn("flex items-start gap-2", !m.inSitting && "opacity-60")}>
										<input
											type="checkbox"
											aria-label={t("exams.contrast.add")}
											checked={add.has(m.id)}
											onChange={(e) =>
												setAdd((cur) => {
													const next = new Set(cur);
													if (e.target.checked) next.add(m.id);
													else next.delete(m.id);
													return next;
												})
											}
											className="mt-1"
										/>
										<span className="min-w-0">
											<span className="text-muted-foreground">{m.blockTitle} · </span>
											{m.text}
											{!m.inSitting && <span className="text-muted-foreground"> · {t("exams.guide.outOfSitting")}</span>}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{shownExtras.length > 0 && (
						<div className="flex flex-col gap-1">
							<p className="font-medium">{t("exams.contrast.extras", { n: shownExtras.length })}</p>
							<ul className="flex flex-col gap-1">
								{shownExtras.map((e) => (
									<li key={e.pointId} className="flex items-center justify-between gap-3">
										<span className="min-w-0">{pointText.get(e.pointId)}</span>
										<Select
											size="sm"
											value={actions[e.pointId] ?? "extension"}
											ariaLabel={pointText.get(e.pointId) ?? t("exams.contrast.toExtension")}
											onChange={(v) => setActions((cur) => ({ ...cur, [e.pointId]: v }))}
											className="shrink-0"
											options={[
												{ value: "extension" as const, label: t("exams.contrast.toExtension") },
												{ value: "keep" as const, label: t("exams.contrast.keep") },
											]}
										/>
									</li>
								))}
							</ul>
						</div>
					)}
				</>
			)}
			{error && <p role="alert" className="text-warn">{error}</p>}
			<div className="flex justify-end gap-2">
				<button type="button" className={quietBtn} disabled={busy} onClick={() => void send("DELETE")} data-testid="exam-contrast-discard">
					{t("exams.contrast.discard")}
				</button>
				{(missing.length > 0 || shownExtras.length > 0) && (
					<button type="button" className={primaryBtn} disabled={busy} onClick={() => void send("PUT")} data-testid="exam-contrast-apply">
						{t("exams.contrast.apply")}
					</button>
				)}
			</div>
		</div>
	);
}

function SyllabusSection({ exam, highlight }: { exam: ExamDetailView; highlight: boolean }) {
	const t = useT();
	const [open, setOpen] = useState<string | null>(null);
	const points = exam.model?.points ?? [];
	const ideas = useMemo(() => new Map((exam.model?.ideas ?? []).map((i) => [i.nodeId, i])), [exam.model]);
	const priority = new Set(exam.record.priorityBlocks);
	const { start } = useStartExamSession(exam.id);
	const unresearched = exam.record.blocks.some((b) => !b.excluded && b.points.some((p) => !p.targets));
	const contrast = exam.record.contrast;
	const startContrast = async () => {
		setKindError(null);
		const res = await sendJson(`/api/exams/${exam.id}/contrast`, "POST", {});
		if (!res.ok) setKindError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	const researching = exam.record.mapping.state === "researching" || exam.record.mapping.state === "running";
	const [kindError, setKindError] = useState<string | null>(null);
	const setKind = async (blockId: string, pointId: string | null, kind: PointKind) => {
		setKindError(null);
		const failed = await changeKind(exam.id, blockId, pointId, kind);
		if (failed) setKindError(failed === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: failed }));
	};
	const kindSelect = (b: SyllabusBlock, pointId: string | null, text: string) => {
		const point = pointId ? b.points.find((p) => p.id === pointId) : undefined;
		return <KindSelect value={point ? pointKind(b, point) : (b.kind ?? "syllabus")} label={t("exams.kind.label", { text })} disabled={researching} onChange={(k) => void setKind(b.id, pointId, k)} />;
	};
	const classify = async () => {
		setKindError(null);
		const res = await sendJson(`/api/exams/${exam.id}/classify`, "POST", {});
		if (!res.ok) setKindError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	const pendingIds = new Set(pendingKindPoints(exam.record));
	const researchPending = async () => {
		setKindError(null);
		const res = await sendJson(`/api/exams/${exam.id}/research`, "POST", { mode: "pending" });
		if (!res.ok) setKindError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	const progress = t("exams.wizard.researching", { i: Math.min((exam.record.research?.done ?? 0) + 1, exam.record.research?.total ?? 1), n: exam.record.research?.total ?? 1, title: exam.record.research?.current ?? "" });
	const togglePriority = (blockId: string) => {
		const next = priority.has(blockId) ? [...priority].filter((b) => b !== blockId) : [...priority, blockId];
		void sendJson(`/api/exams/${exam.id}`, "PUT", { priorityBlocks: next });
	};
	return (
		<section className="flex flex-col gap-3" data-testid="exam-syllabus" id="exam-syllabus">
			<SectionTitle
				right={
					exam.record.status === "active" ? (
						<span className="flex flex-wrap justify-end gap-2">
							{contrast?.state === "running" ? (
								<span className="px-1 text-sm text-muted-foreground" aria-live="polite">
									{t("exams.contrast.running")}
								</span>
							) : researching ? (
								<span className="px-1 text-sm text-muted-foreground" aria-live="polite">
									{exam.record.mapping.state === "running" ? t("exams.wizard.outlining") : progress}
								</span>
							) : (
								<>
									{pendingIds.size > 0 && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} onClick={() => void researchPending()} data-testid="exam-research-pending">
											{t("exams.kind.researchPending", { n: pendingIds.size })}
										</button>
									)}
									{!exam.record.classified && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} onClick={() => void classify()} data-testid="exam-classify">
											{t("exams.syllabus.classify")}
										</button>
									)}
									{unresearched && pendingIds.size === 0 && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} onClick={() => void sendJson(`/api/exams/${exam.id}/research`, "POST", { mode: "missing" })} data-testid="exam-research-syllabus">
											{t("exams.syllabus.research")}
										</button>
									)}
									{!contrast && guideWanted(exam.record.context) && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} onClick={() => void startContrast()} data-testid="exam-contrast">
											{t("exams.contrast.button")}
										</button>
									)}
								</>
							)}
						</span>
					) : undefined
				}
			>
				{t("exams.syllabus.title")}
			</SectionTitle>
			{kindError && <p role="alert" className="px-1 text-sm text-warn">{kindError}</p>}
			<GuideHeader exam={exam} />
			{contrast && contrast.state !== "running" && <ContrastPanel exam={exam} />}
			{highlight && <p className="px-1 text-sm text-muted-foreground">{t("exams.syllabus.prioritizeHint")}</p>}
			<ul className="overflow-hidden rounded-xl border">
				{exam.record.blocks.map((b) => {
					const blockPoints = points.filter((p) => p.blockId === b.id);
					// Only what is studied shows here; instructions have their own sections.
					if (blockPoints.length === 0) return null;
					const score = Math.round(blockScore(blockPoints) * 100);
					const isOpen = open === b.id;
					return (
						<li key={b.id} className="border-b last:border-b-0">
							<div className="flex items-center gap-3 px-4 py-2.5 text-sm">
								<button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
									<ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
									<span className="min-w-0 truncate">{b.title}</span>
								</button>
								{exam.record.status === "active" && kindSelect(b, null, b.title)}
								<span className="w-10 text-right tabular-nums text-muted-foreground">{score}%</span>
								<span className="hidden w-24 sm:block">
									<CoverageBar value={score} target={Math.round(exam.standard.coverage * 100)} label={t("exams.level.bar", { n: score, target: Math.round(exam.standard.coverage * 100) })} />
								</span>
								<button
									type="button"
									aria-pressed={priority.has(b.id)}
									aria-label={t("exams.syllabus.priority", { title: b.title })}
									onClick={() => togglePriority(b.id)}
									className={cn("rounded-md p-1 transition-colors hover:bg-accent", priority.has(b.id) ? "text-warn" : "text-muted-foreground", highlight && !priority.has(b.id) && "ring-1 ring-warn/50")}
								>
									<StarIcon className={cn("size-4", priority.has(b.id) && "fill-current")} />
								</button>
							</div>
							{isOpen && (
								<ul className="pb-2">
									{blockPoints.map((p) =>
										p.targets ? (
											<ResearchedPoint key={p.id} exam={exam} point={p} ideas={ideas} onDeepen={() => void start("deepen", p.id)} kindSelect={exam.record.status === "active" ? kindSelect(b, p.id, p.text) : null} />
										) : (
										<li key={p.id} className="px-4 py-1 pl-10 text-sm">
											<div className="flex items-center justify-between gap-3">
												<span className="min-w-0 truncate">{p.text}</span>
												<span className="flex shrink-0 items-center gap-3 text-muted-foreground">
													{exam.record.status === "active" && kindSelect(b, p.id, p.text)}
													{pendingIds.has(p.id) ? <span className="text-warn">{t("exams.kind.pending")}</span> : pointNeedLabel(p, t)}
												</span>
											</div>
											<BlockedBy exam={exam} point={p} />
											{p.nodeIds.length > 0 && (
												<ul className="mt-0.5 flex flex-col">
													{p.nodeIds.map((n) => {
														const idea = ideas.get(n);
														if (!idea) return null;
														const recall = pct(idea.recallAtExam);
														return (
															<li key={n} className="flex items-center justify-between gap-3 pl-4 text-muted-foreground">
																<span className="min-w-0 truncate">{idea.name}</span>
																<span className="flex shrink-0 items-center gap-1.5 tabular-nums">
																	{ideaLevelLabel(idea, t)}
																	{recall !== null && ` · ${recall}%`}
																	{idea.meets && <CheckIcon className="size-3.5 text-ok" aria-label={t("exams.idea.meets")} />}
																</span>
															</li>
														);
													})}
												</ul>
											)}
										</li>
										),
									)}
								</ul>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** «Instrucciones de la asignatura» / «Instrucciones para el tutor»
 *  (owner 2026-11-06): each instruction point with its rules — edit,
 *  add, delete (saved on blur), and change the point's type. */
function InstructionsSection({ exam, kind }: { exam: ExamDetailView; kind: "rules" | "tutor" }) {
	const t = useT();
	const [blocks, setBlocks] = useState<SyllabusBlock[]>(exam.record.blocks);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setBlocks(exam.record.blocks), [exam.record.blocks]);
	const editable = exam.record.status === "active";
	const researching = exam.record.mapping.state === "researching" || exam.record.mapping.state === "running";
	const points = instructionPoints({ blocks }, kind);
	if (points.length === 0) return null;
	const editRules = (pointId: string, f: (rules: TargetIdea[]) => TargetIdea[]) =>
		setBlocks((list) => list.map((b) => ({ ...b, points: b.points.map((p) => (p.id === pointId ? { ...p, targets: f(p.targets ?? []) } : p)) })));
	const save = async (next = blocks) => {
		const cleaned = next.map((b) => ({ ...b, points: b.points.map((p) => (p.targets ? { ...p, targets: p.targets.map((x) => ({ ...x, statement: x.statement.trim() })).filter((x) => x.statement) } : p)) }));
		const res = await sendJson(`/api/exams/${exam.id}`, "PUT", { blocks: cleaned });
		if (!res.ok) setError(typeof res.body.error === "string" ? res.body.error : t("exams.wizard.saveFailed"));
	};
	const setKind = async (blockId: string, pointId: string, next: PointKind) => {
		setError(null);
		const failed = await changeKind(exam.id, blockId, pointId, next);
		if (failed) setError(failed === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: failed }));
	};
	const input = "min-w-0 flex-1 resize-y rounded-md border border-transparent bg-transparent px-2 py-1 outline-none hover:border-border focus:border-primary/50";
	return (
		<section className="flex flex-col gap-3" data-testid={`exam-instructions-${kind}`}>
			<SectionTitle>{t(`exams.kind.${kind}` as MessageKey)}</SectionTitle>
			{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
			<ul className="overflow-hidden rounded-xl border">
				{points.map((p) => {
					const block = blocks.find((b) => b.id === p.blockId)!;
					return (
						<li key={p.id} className="border-b px-4 py-2.5 text-sm last:border-b-0" data-testid="exam-instruction-point">
							<div className="flex items-center justify-between gap-3">
								<span className="min-w-0 truncate font-medium">{p.text}</span>
								{editable && <KindSelect value={pointKind(block, p)} label={t("exams.kind.label", { text: p.text })} disabled={researching} onChange={(k) => void setKind(p.blockId, p.id, k)} />}
							</div>
							{p.pendingFrom ? (
								<p className="mt-1 pl-4 text-warn">{researching ? t("exams.kind.researching") : t("exams.kind.pending")}</p>
							) : !p.targets && researching ? (
								<p className="mt-1 pl-4 text-muted-foreground">{t("exams.kind.researching")}</p>
							) : (
								<ul className="mt-1 flex flex-col gap-1 pl-4">
									{(p.targets ?? []).map((rule) => (
										<li key={rule.id} className="flex items-start gap-2">
											{editable ? (
												<>
													<textarea
														value={rule.statement}
														rows={1}
														aria-label={t("exams.rules.statement")}
														onChange={(e) => editRules(p.id, (rules) => rules.map((x) => (x.id === rule.id ? { ...x, statement: e.target.value } : x)))}
														onBlur={() => void save()}
														className={input}
														data-testid="exam-rule"
													/>
													<button
														type="button"
														aria-label={t("exams.rules.remove")}
														onClick={() => {
															const next = blocks.map((b) => ({ ...b, points: b.points.map((q) => (q.id === p.id ? { ...q, targets: (q.targets ?? []).filter((x) => x.id !== rule.id) } : q)) }));
															setBlocks(next);
															void save(next);
														}}
														className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
													>
														<XIcon className="size-4" />
													</button>
												</>
											) : (
												<span className="text-muted-foreground">{rule.statement}</span>
											)}
										</li>
									))}
								</ul>
							)}
							{editable && !p.pendingFrom && (
								<button
									type="button"
									className="mt-1 pl-4 text-xs text-muted-foreground hover:text-foreground"
									onClick={() => editRules(p.id, (rules) => [...rules, { id: localId("t_"), statement: "", source: { kind: "user", title: "" }, nodeIds: [] }])}
									data-testid="exam-add-rule"
								>
									+ {t("exams.rules.add")}
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function MockSection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const { state, start } = useStartExamSession(exam.id);
	return (
		<section className="flex flex-col gap-3" data-testid="exam-mock">
			<SectionTitle
				right={
					<button type="button" className={quietBtn} disabled={state === "starting"} onClick={() => void start("mock")}>
						{t("exams.mock.start")}
					</button>
				}
			>
				{t("exams.mock.title")}
			</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.mock.hint")}</p>
		</section>
	);
}

function ArchivedSection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const [grade, setGrade] = useState(exam.realGrade ?? "");
	return (
		<section className="flex flex-col gap-3" data-testid="exam-archived">
			<SectionTitle>{t("exams.archived.title")}</SectionTitle>
			<p className="px-1 text-sm">{t("exams.list.final", { n: pct(exam.final?.coverage) ?? 0, level: presetLabel(exam.final?.preset ?? null, t) })}</p>
			<label className="flex items-center gap-3 px-1 text-sm">
				<span className="text-muted-foreground">{t("exams.archived.realGrade")}</span>
				<input
					value={grade}
					maxLength={100}
					onChange={(e) => setGrade(e.target.value)}
					onBlur={() => grade !== (exam.realGrade ?? "") && void sendJson(`/api/exams/${exam.id}`, "PUT", { realGrade: grade.trim() || null })}
					className="w-32 rounded-md border bg-background px-3 py-1.5"
					data-testid="exam-real-grade"
				/>
			</label>
		</section>
	);
}

/** The «···» menu: the exam page's header, the draft wizard's header and
 *  the draft cards on the list (owner, 2026-11-06: a draft can be deleted
 *  without finishing the wizard). A draft shows only «Eliminar». The menu
 *  and the delete confirmation are portaled (MenuShell) so the list's
 *  rounded overflow-hidden frame cannot clip them. */
export function ExamMenu({
	exam,
	onDeleted,
}: {
	exam: Pick<ExamSummaryView, "id" | "title" | "status" | "examDate" | "standard">;
	/** After a successful delete (the page and the wizard leave for
	 *  /exams; the list refreshes on its own via exams-changed). */
	onDeleted?: () => void;
}) {
	const t = useT();
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const [panel, setPanel] = useState<"menu" | "delete" | null>(null);
	const [editing, setEditing] = useState(false);
	const [date, setDate] = useState(exam.examDate);
	const [standard, setStandard] = useState(exam.standard);
	const [deleting, setDeleting] = useState(false);
	const item = "flex min-h-9 w-full items-center rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent";
	// Outside pointerdown / Esc closes (the sessions context menu's rule:
	// the portaled body carries data-np-menu, the trigger toggles itself).
	useEffect(() => {
		if (panel === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-np-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			setPanel(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setPanel(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [panel]);
	const remove = async () => {
		setDeleting(true);
		const res = await sendJson(`/api/exams/${exam.id}`, "DELETE");
		setDeleting(false);
		setPanel(null);
		if (res.ok) onDeleted?.();
	};
	return (
		<div className="relative">
			<button
				ref={anchorRef}
				type="button"
				data-testid="exam-menu"
				aria-label={t("exams.menu.open")}
				aria-haspopup="menu"
				aria-expanded={panel === "menu"}
				onClick={() => setPanel((v) => (v === null ? "menu" : null))}
				className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<MoreHorizontalIcon className="size-5" />
			</button>
			{panel === "menu" && (
				<MenuShell anchorRef={anchorRef} testid="exam-menu-body" preferredSide="down" menuClass="w-56 rounded-xl border bg-popover p-1.5 shadow-float">
					<div role="menu">
						{exam.status === "active" && (
							<button type="button" role="menuitem" className={item} onClick={() => { setEditing(true); setPanel(null); }}>
								{t("exams.menu.edit")}
							</button>
						)}
						{exam.status === "active" ? (
							<button type="button" role="menuitem" className={item} onClick={() => { setPanel(null); void sendJson(`/api/exams/${exam.id}`, "PUT", { status: "archived" }); }}>
								{t("exams.menu.archive")}
							</button>
						) : exam.status === "archived" ? (
							<button type="button" role="menuitem" className={item} onClick={() => { setPanel(null); void sendJson(`/api/exams/${exam.id}`, "PUT", { status: "active" }); }}>
								{t("exams.menu.unarchive")}
							</button>
						) : null}
						<button type="button" role="menuitem" data-testid="exam-menu-delete" className={cn(item, "text-warn")} onClick={() => setPanel("delete")}>
							{t("exams.menu.delete")}
						</button>
					</div>
				</MenuShell>
			)}
			{editing && (
				<div role="dialog" aria-label={t("exams.menu.edit")} className="absolute right-0 top-10 z-50 flex w-[22rem] flex-col gap-3 rounded-xl border bg-popover p-4 shadow-float">
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.wizard.date")}</span>
						<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldInput} />
					</label>
					<StandardPicker value={standard} onChange={setStandard} />
					<div className="flex justify-end gap-2">
						<button type="button" className={quietBtn} onClick={() => setEditing(false)}>
							{t("exams.menu.cancel")}
						</button>
						<button type="button" className={primaryBtn} onClick={() => { setEditing(false); void sendJson(`/api/exams/${exam.id}`, "PUT", { examDate: date, standard }); }}>
							{t("exams.menu.save")}
						</button>
					</div>
				</div>
			)}
			{panel === "delete" && (
				<MenuShell anchorRef={anchorRef} testid="exam-delete-confirm" preferredSide="down" menuClass="w-72 rounded-xl border bg-popover p-4 shadow-float">
					<div role="alertdialog" aria-label={t("exams.menu.deleteTitle")} className="flex flex-col gap-3">
						<p className="text-sm">{t("exams.menu.deleteBody", { title: exam.title })}</p>
						<div className="flex justify-end gap-2">
							<button type="button" className={quietBtn} disabled={deleting} onClick={() => setPanel(null)}>
								{t("exams.menu.cancel")}
							</button>
							<button type="button" data-testid="exam-delete-confirm-button" className={cn(primaryBtn, "bg-warn hover:bg-warn/90")} disabled={deleting} onClick={() => void remove()}>
								{t("exams.menu.delete")}
							</button>
						</div>
					</div>
				</MenuShell>
			)}
		</div>
	);
}

export function ExamPage({ id }: { id: string }) {
	const t = useT();
	const { locale } = useLocale();
	const router = useRouter();
	const { data, reload } = useExam(id);
	const [highlight, setHighlight] = useState(false);
	if (data === undefined) return <p className="p-10 text-sm text-muted-foreground">{t("exams.loading")}</p>;
	if (data === null) return <p role="alert" className="p-10 text-sm text-warn">{t("exams.loadFailed")}</p>;
	if (data.status === "draft") return <DraftWizard exam={data} reload={reload} />;
	const live = data.status === "active";
	return (
		<Page testid="exam-page">
				<PageHeader
					back={
						<Link href="/exams" className="transition-colors hover:text-foreground">
							{t("exams.page.back")}
						</Link>
					}
					title={data.title}
					subtitle={
						<>
							{dateLabel(data.examDate, locale, { day: "numeric", month: "long" })} ·{" "}
							{data.status === "archived" ? t("exams.list.past") : data.daysLeft === 0 ? t("exams.days.today") : t("exams.days.left", { n: data.daysLeft })}
						</>
					}
					actions={
						<>
							<Link href="/settings/exams" className={buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground" })}>
								<SettingsIcon />
								{t("exams.page.settings")}
							</Link>
							<ExamMenu exam={data} onDeleted={() => router.push("/exams")} />
						</>
					}
				/>
				{live ? (
					<>
						<TodaySection exam={data} />
						<LevelSection
							exam={data}
							onPrioritize={() => {
								setHighlight(true);
								document.getElementById("exam-syllabus")?.scrollIntoView({ behavior: "smooth", block: "start" });
							}}
						/>
						<PlanSection exam={data} />
						<PrerequisitesSection exam={data} />
						<SyllabusSection exam={data} highlight={highlight} />
						<InstructionsSection exam={data} kind="rules" />
						<InstructionsSection exam={data} kind="tutor" />
						{data.daysLeft <= MOCK_SHOW_DAYS && data.daysLeft > 0 && <MockSection exam={data} />}
					</>
				) : (
					<>
						<ArchivedSection exam={data} />
						<SyllabusSection exam={data} highlight={false} />
						<InstructionsSection exam={data} kind="rules" />
						<InstructionsSection exam={data} kind="tutor" />
					</>
				)}
		</Page>
	);
}

// ─── Inicio: «Hoy para tu examen» ───────────────────────────────────────────

function HomeExamRow({ exam }: { exam: ExamSummaryView }) {
	const t = useT();
	const router = useRouter();
	const { state, start } = useStartExamSession(exam.id);
	const open = async () => {
		const res = await fetch(`/api/exams/${exam.id}`).catch(() => null);
		const detail = res?.ok ? ((await res.json()) as ExamDetailView) : null;
		const first = detail?.blocks[0];
		if (first) void start(first.kind, first.prerequisiteId ?? first.pointId);
		else router.push(`/exams/${exam.id}`);
	};
	// Two lines (owner 2026-11-06): the title may truncate, the numbers
	// never do — they own the second line.
	return (
		<ListRow
			href={`/exams/${exam.id}`}
			title={exam.title}
			meta={`${t("exams.list.today", { min: Math.round(exam.todayMinutes) })} · ${exam.daysLeft === 0 ? t("exams.days.today") : t("exams.days.left", { n: exam.daysLeft })}`}
			action={
				<button type="button" className={cn(primaryBtn, "min-w-28")} disabled={state === "starting"} onClick={() => void open()}>
					{state === "starting" ? t("exams.today.starting") : t("exams.today.start")}
				</button>
			}
		/>
	);
}

export function ExamsTodayCard() {
	const t = useT();
	const { data } = useExams();
	const today = (data?.exams ?? []).filter((e) => e.status === "active" && e.todayMinutes > 0).sort((a, b) => a.examDate.localeCompare(b.examDate));
	if (today.length === 0) return null;
	return (
		<section className="flex flex-col gap-3" data-testid="exams-home">
			<SectionTitle>{t("exams.home.title")}</SectionTitle>
			<ListCard>
				{today.map((e) => (
					<HomeExamRow key={e.id} exam={e} />
				))}
			</ListCard>
		</section>
	);
}

// ─── an exam session's batch end ────────────────────────────────────────────

/** Mounted by the chat once every picked idea of an exam session had its
 *  problem: «Parar» back to the exam; «Siguiente tanda» opens the next
 *  session of the same block; nothing left → «Volver al examen». */
export function ExamBatchActions({ examId, kind }: { examId: string; kind: ExamSessionKind }) {
	const t = useT();
	const router = useRouter();
	const { state, start } = useStartExamSession(examId);
	const [more, setMore] = useState<boolean | null>(null);
	useEffect(() => {
		let live = true;
		fetch(`/api/exams/${encodeURIComponent(examId)}`)
			.then((r) => (r.ok ? (r.json() as Promise<ExamDetailView>) : null))
			.then((d) => {
				if (!live) return;
				const m = d?.model;
				if (!m || kind === "mock") return setMore(false);
				if (kind === "placement") return setMore(!m.placement.done);
				if (kind === "review") return setMore(m.ideas.some((i) => i.dueToday));
				const target = MODE_LEVEL[d.standard.mode];
				setMore(m.ideas.some((i) => !i.toTeach && i.level < target));
			})
			.catch(() => live && setMore(false));
		return () => {
			live = false;
		};
	}, [examId, kind]);
	const quiet = "flex h-10 shrink-0 items-center justify-center rounded-[10px] px-4 font-ui text-xs font-medium transition-colors";
	if (more === false) {
		return (
			<button type="button" data-testid="exam-batch-back" onClick={() => router.push(`/exams/${examId}`)} className={cn(quiet, "bg-ok text-background hover:opacity-90")}>
				{t("exams.batch.back")}
			</button>
		);
	}
	return (
		<span className="flex shrink-0 gap-1.5">
			<button type="button" data-testid="exam-batch-stop" onClick={() => router.push(`/exams/${examId}`)} className={cn(quiet, "bg-secondary text-foreground hover:bg-accent")}>
				{t("exams.batch.stop")}
			</button>
			<button type="button" data-testid="exam-batch-next" disabled={more === null || state === "starting"} onClick={() => void start(kind)} className={cn(quiet, "gap-1.5 bg-ok text-background hover:opacity-90 disabled:opacity-50")}>
				{t("exams.batch.next")}
				<ChevronRightIcon className="size-4" />
			</button>
		</span>
	);
}

export { EXAM_PRESETS };

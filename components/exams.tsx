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
import { useServerEvent } from "@/components/server-events";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { useLocale, useT, type Translate } from "@/components/i18n";
import {
	EXAM_PRESETS,
	MODE_LEVEL,
	PRESET_ORDER,
	presetStandard,
	reduceFolders,
	type DemandMode,
	type ExamBlock,
	type ExamDetailView,
	type ExamPreset,
	type ExamSessionKind,
	type ExamStandard,
	type ExamSummaryView,
	type IdeaStatus,
	type KnowledgeFolder,
	type MessageKey,
	type PointStatus,
	type SyllabusBlock,
} from "@/src/core";

// ─── data ───────────────────────────────────────────────────────────────────

interface ExamsListResponse {
	exams: ExamSummaryView[];
	folders: KnowledgeFolder[];
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

export function blockLabel(block: ExamBlock, points: readonly PointStatus[], t: Translate): string {
	switch (block.kind) {
		case "review":
			return t("exams.block.review", { n: block.nodeIds.length });
		case "placement":
			return t("exams.block.placement", { n: block.nodeIds.length });
		case "practice":
			return t("exams.block.practice", { n: block.nodeIds.length });
		case "teach": {
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

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-3 px-1">
			<h2 className="text-lg font-semibold">{children}</h2>
			{right}
		</div>
	);
}

const primaryBtn = "rounded-[10px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50";
const quietBtn = "rounded-[10px] border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50";

/** Coverage vs target: track, fill, a hairline tick at the target. */
function CoverageBar({ value, target, label }: { value: number; target: number; label: string }) {
	return (
		<span className="relative block h-2 rounded-full bg-np-data-track" role="img" aria-label={label}>
			<span className="absolute inset-y-0 left-0 rounded-full bg-np-data" style={{ width: `${Math.min(100, value)}%` }} />
			<span className="absolute -inset-y-1 w-px bg-foreground/60" style={{ left: `${target}%` }} />
		</span>
	);
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
					<span className="min-w-0 truncate font-medium">{exam.title}</span>
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
		<div className="h-full overflow-y-auto" data-testid="exams-page">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-10 px-4 pb-16 pt-10">
				<header className="flex items-center justify-between gap-3 px-1">
					<h1 className="text-[26px] font-semibold leading-[34px] tracking-tight">{t("exams.page.title")}</h1>
					<span className="flex items-center gap-4">
						<Link href="/settings/exams" className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
							<SettingsIcon className="size-4" />
							{t("exams.page.settings")}
						</Link>
						<Link href="/exams/new" className={cn(primaryBtn, "flex items-center gap-1.5")} data-testid="exams-new">
							<PlusIcon className="size-4" />
							{t("exams.page.new")}
						</Link>
					</span>
				</header>
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
								<ul className="overflow-hidden rounded-xl border">
									{groups[key].map((e) => (
										<ExamCard key={e.id} exam={e} />
									))}
								</ul>
							</section>
						),
					)
				)}
			</div>
		</div>
	);
}

// ─── the wizard ─────────────────────────────────────────────────────────────

function StepHeader({ step }: { step: 1 | 2 | 3 | 4 }) {
	const t = useT();
	return (
		<header className="flex items-center justify-between gap-3 px-1">
			<h1 className="text-[26px] font-semibold leading-[34px] tracking-tight">{t("exams.wizard.title")}</h1>
			<ol className="flex gap-1.5 text-sm" aria-label={t("exams.wizard.steps")}>
				{[1, 2, 3, 4].map((n) => (
					<li key={n} aria-current={n === step ? "step" : undefined} className={cn("flex size-7 items-center justify-center rounded-full border tabular-nums", n === step ? "bg-primary text-primary-foreground" : n < step ? "text-foreground" : "text-muted-foreground")}>
						{n}
					</li>
				))}
			</ol>
		</header>
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

/**
 * The wizard's folder tree (owner 2026-11-06): every knowledge folder
 * with ideas, collapsed to the first level, names as on disk, recursive
 * counts. Checking a folder includes everything below it — descendants
 * show checked + dimmed and can't be unchecked alone. The search filters
 * by name (accents folded): matches stay with their ancestors, which open
 * on their own; clearing it restores the hand-opened state. Below, the
 * selected folders with a × each.
 */
export function FolderPicker({ folders, selected, onChange }: { folders: KnowledgeFolder[]; selected: string[]; onChange: (next: string[]) => void }) {
	const t = useT();
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const children = useMemo(() => {
		const map = new Map<string, KnowledgeFolder[]>();
		for (const f of folders) {
			const parent = parentOf(f.path);
			map.set(parent, [...(map.get(parent) ?? []), f]);
		}
		for (const list of map.values()) list.sort((a, b) => folderName(a.path).localeCompare(folderName(b.path)));
		return map;
	}, [folders]);
	const q = foldText(query.trim());
	// While searching: matches, their ancestors (forced open) and — under an
	// opened match — its subtree.
	const filter = useMemo(() => {
		if (!q) return null;
		const matches = new Set(folders.filter((f) => foldText(folderName(f.path)).includes(q)).map((f) => f.path));
		const ancestors = new Set<string>();
		for (const m of matches) for (let p = parentOf(m); p; p = parentOf(p)) ancestors.add(p);
		return { matches, ancestors };
	}, [folders, q]);
	const covered = (path: string) => selected.some((s) => path.startsWith(`${s}/`));
	const toggle = (path: string) => onChange(selected.includes(path) ? selected.filter((s) => s !== path) : reduceFolders([...selected, path]));
	const toggleOpen = (path: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const renderLevel = (parent: string, depth: number, insideMatch: boolean): React.ReactNode[] =>
		(children.get(parent) ?? []).flatMap((f) => {
			const isMatch = filter?.matches.has(f.path) ?? false;
			if (filter && !insideMatch && !isMatch && !filter.ancestors.has(f.path)) return [];
			const kids = children.has(f.path);
			const forced = filter !== null && filter.ancestors.has(f.path);
			const expanded = kids && (forced || open.has(f.path));
			const isCovered = covered(f.path);
			const checked = isCovered || selected.includes(f.path);
			const name = folderName(f.path);
			return [
				<li key={f.path} data-testid="exam-folder" data-path={f.path}>
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
						<label className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm", isCovered && "cursor-default opacity-55")}>
							<input type="checkbox" checked={checked} disabled={isCovered} onChange={() => toggle(f.path)} className="accent-primary" />
							<span className="truncate" title={f.path}>
								{name}
							</span>
							<span className="shrink-0 text-muted-foreground">({f.count})</span>
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
				className="rounded-[10px] border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/50"
			/>
			<div className="max-h-80 overflow-y-auto rounded-[10px] border px-1 py-1.5">
				{rows.length > 0 ? <ul>{rows}</ul> : <p className="px-2 py-1 text-sm text-muted-foreground">{t("exams.wizard.folderNoMatch")}</p>}
			</div>
			{selected.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 text-sm" data-testid="exam-folders-selected">
					<span className="text-muted-foreground">{t("exams.wizard.foldersSelected")}</span>
					{selected.map((path) => (
						<span key={path} title={path} className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 py-0.5 pl-3 pr-1">
							{shortFolder(path)}
							<button type="button" aria-label={t("exams.wizard.folderRemove", { name: folderName(path) })} onClick={() => onChange(selected.filter((s) => s !== path))} className="grid size-5 place-items-center rounded-full hover:bg-accent">
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}
		</fieldset>
	);
}

/** Step 1 — name, date, syllabus text / file / folders → create + map. */
export function NewExamWizard() {
	const t = useT();
	const router = useRouter();
	const { data } = useExams();
	const [title, setTitle] = useState("");
	const [date, setDate] = useState("");
	const [text, setText] = useState("");
	const [fileName, setFileName] = useState<string | null>(null);
	const [folders, setFolders] = useState<string[]>([]);
	const [state, setState] = useState<"idle" | "reading" | "creating" | "error">("idle");
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

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

	const ready = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && (text.trim().length > 0 || folders.length > 0);
	const submit = async () => {
		if (!ready) return;
		setState("creating");
		setError(null);
		const created = await sendJson("/api/exams", "POST", { title: title.trim(), examDate: date, syllabus: { text, fileName, folders } });
		const id = (created.body.exam as { id?: string } | undefined)?.id;
		if (!created.ok || !id) {
			setState("error");
			setError(typeof created.body.error === "string" ? created.body.error : t("exams.wizard.createFailed"));
			return;
		}
		await sendJson(`/api/exams/${id}/map`, "POST");
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
							<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-testid="exam-title" className="rounded-[10px] border bg-background px-3 py-2 outline-none focus:border-primary/50" />
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{t("exams.wizard.date")}</span>
							<input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="exam-date" className="rounded-[10px] border bg-background px-3 py-2 outline-none focus:border-primary/50" />
						</label>
					</div>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={t("exams.wizard.textPlaceholder")}
						rows={10}
						data-testid="exam-text"
						className="mx-1 rounded-[10px] border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
					/>
					<div className="flex flex-wrap items-center gap-3 px-1 text-sm">
						<input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx,.epub" className="hidden" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
						<button type="button" className={quietBtn} disabled={state === "reading"} onClick={() => fileRef.current?.click()} data-testid="exam-file">
							{state === "reading" ? t("exams.wizard.reading") : t("exams.wizard.attach")}
						</button>
						<span className="text-muted-foreground">{fileName ?? t("exams.wizard.formats")}</span>
					</div>
					{(data?.folders.length ?? 0) > 0 && <FolderPicker folders={data!.folders} selected={folders} onChange={setFolders} />}
					{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
					<div className="flex justify-end px-1">
						<button type="button" className={primaryBtn} disabled={!ready || state === "creating" || state === "reading"} onClick={() => void submit()} data-testid="exam-map">
							{state === "creating" ? t("exams.wizard.creating") : t("exams.wizard.map")}
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}

let localSeq = 0;
const localId = (prefix: string) => `${prefix}${Date.now().toString(36)}${++localSeq}`;

/** Start (or retry) the mapping; a missing strong model says so. */
function MapNow({ examId, failure }: { examId: string; failure?: string }) {
	const t = useT();
	const [error, setError] = useState<string | null>(null);
	const run = async () => {
		setError(null);
		const res = await sendJson(`/api/exams/${examId}/map`, "POST");
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.wizard.mapFailed", { error: String(res.body.error ?? "") }));
	};
	return (
		<div className="flex flex-col gap-3 px-1" data-testid="exam-map-now">
			{(failure || error) && <p role="alert" className="text-sm text-warn">{error ?? failure}</p>}
			<button type="button" className={cn(primaryBtn, "self-start")} onClick={() => void run()}>
				{failure ? t("exams.wizard.retry") : t("exams.wizard.map")}
			</button>
		</div>
	);
}

/** Step 2 — the mapping table: edit texts, remove ideas, add/delete points. */
function MappingStep({ exam, onDone }: { exam: ExamDetailView; onDone: () => void }) {
	const t = useT();
	const [blocks, setBlocks] = useState<SyllabusBlock[]>(exam.record.blocks);
	const [open, setOpen] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setBlocks(exam.record.blocks), [exam.record.blocks]);
	const names = useMemo(() => new Map((exam.model?.ideas ?? []).map((i) => [i.nodeId, i.name])), [exam.model]);
	const mapping = exam.record.mapping;

	const edit = (blockId: string, f: (b: SyllabusBlock) => SyllabusBlock | null) =>
		setBlocks((list) => list.map((b) => (b.id === blockId ? f(b) : b)).filter((b): b is SyllabusBlock => b !== null));

	const confirm = async () => {
		setSaving(true);
		setError(null);
		const cleaned = blocks
			.map((b) => ({ ...b, title: b.title.trim(), points: b.points.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text) }))
			.filter((b) => b.title && b.points.length > 0);
		const res = await sendJson(`/api/exams/${exam.id}`, "PUT", { blocks: cleaned });
		setSaving(false);
		if (!res.ok) {
			setError(typeof res.body.error === "string" ? res.body.error : t("exams.wizard.saveFailed"));
			return;
		}
		onDone();
	};

	if (mapping.state === "running") {
		return (
			<p className="px-1 text-sm text-muted-foreground" data-testid="exam-mapping-running">
				{t("exams.wizard.mapping")}
			</p>
		);
	}
	if (mapping.state === "none" && blocks.length === 0) {
		return <MapNow examId={exam.id} />;
	}
	if (mapping.state === "error" && blocks.length === 0) {
		return <MapNow examId={exam.id} failure={mapping.error === "interrupted" ? t("exams.wizard.mapInterrupted") : t("exams.wizard.mapFailed", { error: mapping.error ?? "" })} />;
	}
	const input = "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 outline-none hover:border-border focus:border-primary/50";
	return (
		<section className="flex flex-col gap-4" data-testid="exam-mapping">
			<SectionTitle>{t("exams.wizard.review")}</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.wizard.reviewHint")}</p>
			{blocks.map((b) => (
				<div key={b.id} className="overflow-hidden rounded-xl border">
					<div className="flex items-center gap-2 border-b bg-accent/30 px-2 py-1.5">
						<input value={b.title} onChange={(e) => edit(b.id, (x) => ({ ...x, title: e.target.value }))} aria-label={t("exams.wizard.blockTitle")} className={cn(input, "font-medium")} />
						<button type="button" aria-label={t("exams.wizard.removeBlock", { title: b.title })} onClick={() => edit(b.id, () => null)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
							<XIcon className="size-4" />
						</button>
					</div>
					<ul>
						{b.points.map((p) => (
							<li key={p.id} className="border-b px-2 py-1.5 text-sm last:border-b-0">
								<div className="flex items-center gap-2">
									<input value={p.text} onChange={(e) => edit(b.id, (x) => ({ ...x, points: x.points.map((y) => (y.id === p.id ? { ...y, text: e.target.value } : y)) }))} aria-label={t("exams.wizard.pointText")} className={input} />
									{p.nodeIds.length === 0 ? (
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
								{open === p.id && (
									<ul className="mt-1 flex flex-col gap-1 pl-4">
										{p.nodeIds.map((n) => (
											<li key={n} className="flex items-center justify-between gap-2 text-muted-foreground">
												<span className="min-w-0 truncate">{names.get(n) ?? n}</span>
												<button type="button" onClick={() => edit(b.id, (x) => ({ ...x, points: x.points.map((y) => (y.id === p.id ? { ...y, nodeIds: y.nodeIds.filter((z) => z !== n) } : y)) }))} className="shrink-0 text-xs hover:text-foreground">
													{t("exams.wizard.unlink")}
												</button>
											</li>
										))}
									</ul>
								)}
							</li>
						))}
					</ul>
					<button type="button" onClick={() => edit(b.id, (x) => ({ ...x, points: [...x.points, { id: localId("p_"), text: "", nodeIds: [] }] }))} className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground">
						<PlusIcon className="size-4" />
						{t("exams.wizard.addPoint")}
					</button>
				</div>
			))}
			<button type="button" onClick={() => setBlocks((list) => [...list, { id: localId("b_"), title: t("exams.wizard.newBlock"), points: [] }])} className={cn(quietBtn, "self-start")}>
				{t("exams.wizard.addBlock")}
			</button>
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
						className={cn("rounded-[10px] border px-4 py-2 text-sm transition-colors", value.preset === p ? "border-primary bg-primary/10" : "hover:bg-accent")}
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
						<input type="number" min={50} max={99} value={Math.round(value.recall * 100)} onChange={(e) => onChange({ ...value, preset: null, recall: Math.min(99, Math.max(50, Number(e.target.value) || 50)) / 100 })} className="rounded-[10px] border bg-background px-3 py-2" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.standard.mode")}</span>
						<select value={value.mode} onChange={(e) => onChange({ ...value, preset: null, mode: e.target.value as DemandMode })} className="rounded-[10px] border bg-background px-3 py-2">
							{(Object.keys(MODE_LEVEL) as DemandMode[]).map((m) => (
								<option key={m} value={m}>
									{modeLabel(m, t)}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.standard.coverage")}</span>
						<input type="number" min={5} max={100} value={Math.round(value.coverage * 100)} onChange={(e) => onChange({ ...value, preset: null, coverage: Math.min(100, Math.max(5, Number(e.target.value) || 5)) / 100 })} className="rounded-[10px] border bg-background px-3 py-2" />
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
						className="w-full rounded-[10px] border bg-background px-1 py-2 text-center tabular-nums"
					/>
				</label>
			))}
		</div>
	);
}

/** Steps 3–4 — the standard, then the global weekly budget + forecast. */
function PlanSteps({ exam, step, setStep }: { exam: ExamDetailView; step: 3 | 4; setStep: (s: 2 | 3 | 4) => void }) {
	const t = useT();
	const { locale } = useLocale();
	const [standard, setStandard] = useState<ExamStandard>(exam.standard);
	const [weekly, setWeekly] = useState<number[]>(exam.weeklyMinutes);
	const [preview, setPreview] = useState<{ bestPreset: ExamPreset | null; feasible: boolean; extraPerDay: number } | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (step !== 4) return;
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
	}, [exam.id, standard, weekly, step]);

	const create = async () => {
		setSaving(true);
		setError(null);
		const settings = await fetch("/api/settings").then((r) => r.json()).catch(() => ({})) as { settings?: { exams?: object } };
		const savedWeekly = await sendJson("/api/settings/exams", "PUT", { ...(settings.settings?.exams ?? {}), weeklyMinutes: weekly });
		const activated = savedWeekly.ok ? await sendJson(`/api/exams/${exam.id}`, "PUT", { standard, status: "active" }) : savedWeekly;
		setSaving(false);
		if (!activated.ok) setError(typeof activated.body.error === "string" ? activated.body.error : t("exams.wizard.saveFailed"));
	};

	if (step === 3) {
		return (
			<section className="flex flex-col gap-4">
				<SectionTitle>{t("exams.wizard.standard")}</SectionTitle>
				<StandardPicker value={standard} onChange={setStandard} />
				<div className="flex justify-between px-1">
					<button type="button" className={quietBtn} onClick={() => setStep(2)}>
						{t("exams.wizard.back")}
					</button>
					<button type="button" className={primaryBtn} onClick={() => setStep(4)} data-testid="exam-standard-next">
						{t("exams.wizard.next")}
					</button>
				</div>
			</section>
		);
	}
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
				<button type="button" className={quietBtn} onClick={() => setStep(3)}>
					{t("exams.wizard.back")}
				</button>
				<button type="button" className={primaryBtn} disabled={saving} onClick={() => void create()} data-testid="exam-create-plan">
					{t("exams.wizard.create")}
				</button>
			</div>
		</section>
	);
}

/** A draft resumes at its step: mapping (2) until confirmed, then 3–4. */
function DraftWizard({ exam, reload }: { exam: ExamDetailView; reload: () => void }) {
	const router = useRouter();
	const [step, setStep] = useState<2 | 3 | 4>(2);
	return (
		<div className="h-full overflow-y-auto" data-testid="exam-wizard">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-8 px-4 pb-16 pt-10">
				<StepHeader step={step} />
				<div className="flex items-center justify-between gap-3 px-1">
					<p className="min-w-0 truncate font-medium">{exam.title}</p>
					<ExamMenu exam={exam} onDeleted={() => router.push("/exams")} />
				</div>
				{step === 2 ? (
					<MappingStep
						exam={exam}
						onDone={() => {
							reload();
							setStep(3);
						}}
					/>
				) : (
					<PlanSteps exam={exam} step={step} setStep={setStep} />
				)}
			</div>
		</div>
	);
}

// ─── one exam ───────────────────────────────────────────────────────────────

function TodaySection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const { state, start } = useStartExamSession(exam.id);
	const points = exam.model?.points ?? [];
	const total = Math.round(exam.blocks.reduce((s, b) => s + b.minutes, 0));
	const first = exam.blocks[0];
	return (
		<section className="flex flex-col gap-3" data-testid="exam-today">
			<SectionTitle
				right={
					first ? (
						<button type="button" className={primaryBtn} disabled={state === "starting"} onClick={() => void start(first.kind, first.pointId)} data-testid="exam-start">
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
						<li key={`${b.kind}:${b.pointId ?? i}`} className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0">
							<span className="flex min-w-0 items-center gap-3">
								<span className="tabular-nums text-muted-foreground">{i + 1}</span>
								<span className="min-w-0 truncate">{blockLabel(b, points, t)}</span>
							</span>
							<span className="flex shrink-0 items-center gap-3">
								<span className="tabular-nums text-muted-foreground">~{Math.round(b.minutes)} min</span>
								<button type="button" className="text-muted-foreground hover:text-foreground" disabled={state === "starting"} aria-label={t("exams.today.startBlock", { block: blockLabel(b, points, t) })} onClick={() => void start(b.kind, b.pointId)}>
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
				<CoverageBar value={coverage} target={target} label={t("exams.level.bar", { n: coverage, target })} />
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

/** Planned minutes per day, the next 14 days (one data hue, values in
 *  the tooltip and the sr-only table). */
function PlanSection({ exam }: { exam: ExamDetailView }) {
	const t = useT();
	const { locale } = useLocale();
	const [hover, setHover] = useState<number | null>(null);
	const counts = exam.allocation.slice(0, 14);
	const days = exam.days.slice(0, counts.length);
	if (counts.length === 0) return null;
	const max = Math.max(1, ...counts);
	const label = (i: number) => (i === 0 ? t("exams.plan.today") : dateLabel(days[i]!, locale, { weekday: "short", day: "numeric" }));
	return (
		<section className="flex flex-col gap-3" data-testid="exam-plan">
			<SectionTitle>{t("exams.plan.title")}</SectionTitle>
			<div className="px-1">
				<div className="relative flex h-32 items-end gap-0.5 border-b border-border pt-6">
					{counts.map((n, i) => (
						<div
							key={i}
							role="img"
							tabIndex={0}
							aria-label={t("exams.plan.bar", { date: label(i), n: Math.round(n) })}
							onPointerEnter={() => setHover(i)}
							onPointerLeave={() => setHover((h) => (h === i ? null : h))}
							onFocus={() => setHover(i)}
							onBlur={() => setHover((h) => (h === i ? null : h))}
							className="relative flex h-full flex-1 items-end justify-center outline-none"
						>
							<span className={cn("w-full max-w-6 rounded-t-[4px] bg-np-data transition-opacity", hover !== null && hover !== i && "opacity-60")} style={{ height: n > 0 ? `${Math.max(2, (n / max) * 100)}%` : 0 }} />
							{hover === i && (
								<span className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-sm" style={{ bottom: `calc(${(n / max) * 100}% + 6px)` }}>
									<strong className="font-semibold tabular-nums">{Math.round(n)} min</strong> <span className="text-muted-foreground">{label(i)}</span>
								</span>
							)}
						</div>
					))}
				</div>
				<div className="mt-1 flex gap-0.5 text-[11px] text-muted-foreground" aria-hidden>
					{counts.map((_, i) => (
						<span key={i} className="flex-1 text-center">
							{i === 0 ? t("exams.plan.today") : dateLabel(days[i]!, locale, { weekday: "narrow" })}
						</span>
					))}
				</div>
				<table className="sr-only">
					<caption>{t("exams.plan.title")}</caption>
					<tbody>
						{counts.map((n, i) => (
							<tr key={i}>
								<th scope="row">{label(i)}</th>
								<td>{Math.round(n)} min</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function SyllabusSection({ exam, highlight }: { exam: ExamDetailView; highlight: boolean }) {
	const t = useT();
	const [open, setOpen] = useState<string | null>(null);
	const points = exam.model?.points ?? [];
	const ideas = useMemo(() => new Map((exam.model?.ideas ?? []).map((i) => [i.nodeId, i])), [exam.model]);
	const priority = new Set(exam.record.priorityBlocks);
	const togglePriority = (blockId: string) => {
		const next = priority.has(blockId) ? [...priority].filter((b) => b !== blockId) : [...priority, blockId];
		void sendJson(`/api/exams/${exam.id}`, "PUT", { priorityBlocks: next });
	};
	return (
		<section className="flex flex-col gap-3" data-testid="exam-syllabus" id="exam-syllabus">
			<SectionTitle>{t("exams.syllabus.title")}</SectionTitle>
			{highlight && <p className="px-1 text-sm text-muted-foreground">{t("exams.syllabus.prioritizeHint")}</p>}
			<ul className="overflow-hidden rounded-xl border">
				{exam.record.blocks.map((b) => {
					const blockPoints = points.filter((p) => p.blockId === b.id);
					const score = Math.round(blockScore(blockPoints) * 100);
					const isOpen = open === b.id;
					return (
						<li key={b.id} className="border-b last:border-b-0">
							<div className="flex items-center gap-3 px-4 py-2.5 text-sm">
								<button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
									<ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
									<span className="min-w-0 truncate">{b.title}</span>
								</button>
								<span className="w-10 text-right tabular-nums text-muted-foreground">{score}%</span>
								<span className="w-24">
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
									{blockPoints.map((p) => (
										<li key={p.id} className="px-4 py-1 pl-10 text-sm">
											<div className="flex items-center justify-between gap-3">
												<span className="min-w-0 truncate">{p.text}</span>
												<span className="shrink-0 text-muted-foreground">{pointNeedLabel(p, t)}</span>
											</div>
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
									))}
								</ul>
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
					className="w-32 rounded-[10px] border bg-background px-3 py-1.5"
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
				<MenuShell anchorRef={anchorRef} testid="exam-menu-body" preferredSide="down" menuClass="w-56 rounded-[14px] border bg-popover p-1.5 shadow-float">
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
				<div role="dialog" aria-label={t("exams.menu.edit")} className="absolute right-0 top-10 z-50 flex w-[22rem] flex-col gap-3 rounded-[14px] border bg-popover p-4 shadow-float">
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{t("exams.wizard.date")}</span>
						<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-[10px] border bg-background px-3 py-2" />
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
				<MenuShell anchorRef={anchorRef} testid="exam-delete-confirm" preferredSide="down" menuClass="w-72 rounded-[14px] border bg-popover p-4 shadow-float">
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
		<div className="h-full overflow-y-auto" data-testid="exam-page">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-10 px-4 pb-16 pt-10">
				<header className="flex items-start justify-between gap-3 px-1">
					<div className="flex min-w-0 flex-col gap-1">
						<Link href="/exams" className="text-sm text-muted-foreground hover:text-foreground">
							{t("exams.page.back")}
						</Link>
						<h1 className="truncate text-[26px] font-semibold leading-[34px] tracking-tight">{data.title}</h1>
						<p className="text-sm text-muted-foreground">
							{dateLabel(data.examDate, locale, { day: "numeric", month: "long" })} ·{" "}
							{data.status === "archived" ? t("exams.list.past") : data.daysLeft === 0 ? t("exams.days.today") : t("exams.days.left", { n: data.daysLeft })}
						</p>
					</div>
					<span className="flex items-center gap-2">
						<Link href="/settings/exams" className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
							<SettingsIcon className="size-4" />
							{t("exams.page.settings")}
						</Link>
						<ExamMenu exam={data} onDeleted={() => router.push("/exams")} />
					</span>
				</header>
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
						<SyllabusSection exam={data} highlight={highlight} />
						{data.daysLeft <= MOCK_SHOW_DAYS && data.daysLeft > 0 && <MockSection exam={data} />}
					</>
				) : (
					<>
						<ArchivedSection exam={data} />
						<SyllabusSection exam={data} highlight={false} />
					</>
				)}
			</div>
		</div>
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
		if (first) void start(first.kind, first.pointId);
		else router.push(`/exams/${exam.id}`);
	};
	return (
		<li className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
			<Link href={`/exams/${exam.id}`} className="min-w-0 truncate text-sm hover:underline">
				{t("exams.home.row", { exam: exam.title, min: Math.round(exam.todayMinutes), n: exam.daysLeft })}
			</Link>
			<button type="button" className={primaryBtn} disabled={state === "starting"} onClick={() => void open()}>
				{state === "starting" ? t("exams.today.starting") : t("exams.today.start")}
			</button>
		</li>
	);
}

export function ExamsTodayCard() {
	const t = useT();
	const { data } = useExams();
	const today = (data?.exams ?? []).filter((e) => e.status === "active" && e.todayMinutes > 0).sort((a, b) => a.examDate.localeCompare(b.examDate));
	if (today.length === 0) return null;
	return (
		<section className="flex flex-col gap-3" data-testid="exams-home">
			<h2 className="px-1 text-lg font-semibold">{t("exams.home.title")}</h2>
			<ul className="overflow-hidden rounded-xl border">
				{today.map((e) => (
					<HomeExamRow key={e.id} exam={e} />
				))}
			</ul>
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

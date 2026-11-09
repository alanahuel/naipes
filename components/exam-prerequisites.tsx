"use client";

/**
 * «Conocimientos previos» (owner 2026-11-09; texts approved E): knowledge
 * the syllabus takes for granted. Not counted in the coverage; each one
 * blocks the topics resting on it until it is taught and solved at least
 * at Recordar.
 *
 *   PrerequisitesEditor — Revisar (and the exam page's «Editar»): edit,
 *     remove, add, change the topics that need each one.
 *   PrerequisitesSection — the exam page: each one's standing, «Detectar
 *     conocimientos previos» and its proposal (Aplicar / Descartar).
 */

import { useEffect, useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { SectionTitle } from "@/components/ui/page";
import { Pager, type Paging } from "@/components/ui/pager";
import { useT, type Translate } from "@/components/i18n";
import { pageSlice, type DemandMode, type ExamDetailView, type ExamPrerequisite, type IdeaStatus, type MessageKey, type PrerequisiteOrigin, type PrerequisiteStatus } from "@/src/core";

const primaryBtn = buttonVariants({ variant: "default" });
const quietBtn = buttonVariants({ variant: "outline", size: "sm" });
const smallBtn = "shrink-0 text-xs text-muted-foreground hover:text-foreground";
const input = "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 outline-none hover:border-border focus:border-primary/50";

async function sendJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
	try {
		const res = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { ok: res.ok, body: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
	} catch {
		return { ok: false, body: {} };
	}
}

let seq = 0;
const newId = () => `q_${Date.now().toString(36)}${++seq}`;

const LEVEL_MODE: Record<number, DemandMode | null> = { 0: null, 1: "recall", 2: "discrimination", 3: "composition" };

/** «Por evaluar», «Subiendo · Discriminar · 82 %», «Dominado»… Pure. */
export function prerequisiteStateLabel(q: Pick<PrerequisiteStatus, "state" | "nodeIds">, ideas: ReadonlyMap<string, Pick<IdeaStatus, "level" | "recallAtExam">>, t: Translate): string {
	if (q.state !== "linked") return t(`exams.prereq.state.${q.state}` as MessageKey);
	const linked = q.nodeIds.map((n) => ideas.get(n)).filter((i): i is Pick<IdeaStatus, "level" | "recallAtExam"> => !!i);
	const level = linked.length ? Math.min(...linked.map((i) => i.level)) : 0;
	const recalls = linked.map((i) => i.recallAtExam).filter((r): r is number => r !== null);
	const mode = LEVEL_MODE[level];
	return t("exams.prereq.state.linked", {
		mode: mode ? t(`exams.mode.${mode}` as MessageKey) : t("exams.idea.noLevel"),
		recall: recalls.length ? `${Math.round(Math.min(...recalls) * 100)} %` : "—",
	});
}

function OriginTag({ origin }: { origin: PrerequisiteOrigin }) {
	const t = useT();
	return <span className="shrink-0 rounded-full border px-2 text-xs text-muted-foreground">{t(`exams.prereq.origin.${origin}` as MessageKey)}</span>;
}

/** «Lo necesitan: …» and «Base de: …» lines for one prerequisite. */
function Dependents({ q, pointText, prereqText }: { q: Pick<ExamPrerequisite, "blocks">; pointText: ReadonlyMap<string, string>; prereqText: ReadonlyMap<string, string> }) {
	const t = useT();
	const points = q.blocks.filter((b) => pointText.has(b)).map((b) => pointText.get(b)!);
	const bases = q.blocks.filter((b) => prereqText.has(b)).map((b) => prereqText.get(b)!);
	return (
		<>
			{points.length > 0 && <span>{t("exams.prereq.neededBy", { points: points.join("; ") })}</span>}
			{bases.length > 0 && <span>{t("exams.prereq.baseOf", { prereq: bases.join("; ") })}</span>}
		</>
	);
}

/** Revisar's (and «Editar»'s) list: statement, the topics that need it,
 *  remove, add. Controlled; the caller saves. */
export function PrerequisitesEditor({
	value,
	points,
	onChange,
}: {
	value: readonly ExamPrerequisite[];
	points: ReadonlyArray<{ id: string; text: string }>;
	onChange: (next: ExamPrerequisite[]) => void;
}) {
	const t = useT();
	const [picking, setPicking] = useState<string | null>(null);
	const pointText = useMemo(() => new Map(points.map((p) => [p.id, p.text])), [points]);
	const prereqText = useMemo(() => new Map(value.map((q) => [q.id, q.statement])), [value]);
	const edit = (id: string, f: (q: ExamPrerequisite) => ExamPrerequisite | null) => onChange(value.map((q) => (q.id === id ? f(q) : q)).filter((q): q is ExamPrerequisite => q !== null));
	const add = () => {
		const id = newId();
		onChange([...value, { id, statement: "", source: { kind: "user", title: "" }, nodeIds: [], blocks: [], origin: "user", depth: 1, key: id }]);
		setPicking(id);
	};
	return (
		<section className="flex flex-col gap-3" data-testid="exam-prereq-editor">
			<SectionTitle>{t("exams.prereq.title")}</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.prereq.hint")}</p>
			{value.length > 0 && (
				<ul className="overflow-hidden rounded-xl border">
					{value.map((q) => (
						<li key={q.id} className="border-b px-2 py-1.5 text-sm last:border-b-0" data-testid="exam-prereq-edit">
							<div className="flex items-start gap-2">
								<textarea
									value={q.statement}
									rows={2}
									aria-label={t("exams.prereq.edit")}
									onChange={(e) => edit(q.id, (x) => ({ ...x, statement: e.target.value }))}
									className={cn(input, "resize-y")}
								/>
								<OriginTag origin={q.origin} />
								<button type="button" aria-label={t("exams.prereq.remove")} title={t("exams.prereq.remove")} onClick={() => edit(q.id, () => null)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
									<XIcon className="size-4" />
								</button>
							</div>
							<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
								<Dependents q={q} pointText={pointText} prereqText={prereqText} />
								<button type="button" className={smallBtn} aria-expanded={picking === q.id} onClick={() => setPicking(picking === q.id ? null : q.id)} data-testid="exam-prereq-change-points">
									{t("exams.prereq.changePoints")}
								</button>
							</div>
							{picking === q.id && (
								<ul className="mt-1 flex flex-col gap-1 pl-4">
									{points.map((p) => (
										<li key={p.id}>
											<label className="flex items-start gap-2 text-sm">
												<input
													type="checkbox"
													className="mt-1"
													checked={q.blocks.includes(p.id)}
													onChange={(e) => edit(q.id, (x) => ({ ...x, blocks: e.target.checked ? [...x.blocks, p.id] : x.blocks.filter((b) => b !== p.id) }))}
												/>
												<span className="min-w-0">{p.text}</span>
											</label>
										</li>
									))}
								</ul>
							)}
						</li>
					))}
				</ul>
			)}
			<button type="button" onClick={add} className={cn(quietBtn, "self-start")} data-testid="exam-prereq-add">
				<PlusIcon className="size-4" />
				{t("exams.prereq.add")}
			</button>
		</section>
	);
}

/** What a saved list looks like: statements trimmed, empty ones out. */
export const cleanPrerequisites = (list: readonly ExamPrerequisite[]): ExamPrerequisite[] =>
	list.map((q) => ({ ...q, statement: q.statement.trim() })).filter((q) => q.statement);

/** The exam page's section: each prerequisite's standing; «Editar»;
 *  «Detectar conocimientos previos» and its proposal. */
export function PrerequisitesSection({ exam, paging }: { exam: ExamDetailView; paging?: Paging }) {
	const t = useT();
	const statuses = exam.model?.prerequisites ?? [];
	const record = exam.record.prerequisites ?? [];
	const search = exam.record.prerequisiteSearch;
	const ideas = useMemo(() => new Map((exam.model?.ideas ?? []).map((i) => [i.nodeId, i])), [exam.model]);
	const points = useMemo(() => (exam.model?.points ?? []).map((p) => ({ id: p.id, text: p.text })), [exam.model]);
	const pointText = useMemo(() => new Map(points.map((p) => [p.id, p.text])), [points]);
	const prereqText = useMemo(() => new Map(record.map((q) => [q.id, q.statement])), [record]);
	const [editing, setEditing] = useState<ExamPrerequisite[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyMapping = exam.record.mapping.state !== "done" && exam.record.mapping.state !== "error" && exam.record.mapping.state !== "none";

	const detect = async () => {
		setError(null);
		const res = await sendJson(`/api/exams/${exam.id}/prerequisites`, "POST", {});
		if (!res.ok) setError(res.body.code === "models_not_configured" ? t("exams.wizard.noModel") : t("exams.prereq.failed", { error: String(res.body.error ?? "") }));
	};
	const save = async () => {
		if (!editing) return;
		setBusy(true);
		setError(null);
		const res = await sendJson(`/api/exams/${exam.id}`, "PUT", { prerequisites: cleanPrerequisites(editing) });
		setBusy(false);
		if (res.ok) setEditing(null);
		else setError(typeof res.body.error === "string" ? res.body.error : t("exams.wizard.saveFailed"));
	};

	if (editing) {
		return (
			<div className="flex flex-col gap-3" data-testid="exam-prerequisites">
				<PrerequisitesEditor value={editing} points={points} onChange={setEditing} />
				{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
				<div className="flex justify-end gap-2">
					<button type="button" className={quietBtn} onClick={() => setEditing(null)}>
						{t("common.cancel")}
					</button>
					<button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()} data-testid="exam-prereq-save">
						{t("common.save")}
					</button>
				</div>
			</div>
		);
	}

	const running = search?.state === "running";
	const slice = pageSlice(statuses.length, paging?.page ?? 1);
	const shown = paging ? statuses.slice(slice.start, slice.end) : statuses;
	return (
		<section className="flex flex-col gap-3" data-testid="exam-prerequisites">
			<SectionTitle
				right={
					exam.record.status === "active" ? (
						<span className="flex flex-wrap justify-end gap-2">
							{running ? (
								<span className="px-1 text-sm text-muted-foreground" aria-live="polite" data-testid="exam-prereq-running">
									{t("exams.prereq.running")}
								</span>
							) : (
								<>
									{record.length > 0 && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} onClick={() => setEditing(record.map((q) => ({ ...q })))} data-testid="exam-prereq-edit-all">
											{t("exams.prereq.edit")}
										</button>
									)}
									{!search && (
										<button type="button" className={cn(quietBtn, "px-3 py-1 text-sm")} disabled={busyMapping} onClick={() => void detect()} data-testid="exam-prereq-detect">
											{t("exams.prereq.detect")}
										</button>
									)}
								</>
							)}
						</span>
					) : undefined
				}
			>
				{t("exams.prereq.title")}
			</SectionTitle>
			<p className="px-1 text-sm text-muted-foreground">{t("exams.prereq.hint")}</p>
			{error && <p role="alert" className="px-1 text-sm text-warn">{error}</p>}
			{search && search.state !== "running" && search.mode === "review" && <ProposalPanel exam={exam} onRetry={() => void detect()} />}
			{statuses.length > 0 && (
				<ul className="overflow-hidden rounded-xl border">
					{shown.map((q) => (
						<li key={q.id} className="border-b px-4 py-2 text-sm last:border-b-0" data-testid="exam-prereq">
							<div className="flex items-start justify-between gap-3">
								<span className="min-w-0">{q.statement}</span>
								<span className="flex shrink-0 items-center gap-2 text-muted-foreground">
									<OriginTag origin={q.origin} />
									<span data-testid="exam-prereq-state">{prerequisiteStateLabel(q, ideas, t)}</span>
								</span>
							</div>
							<div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
								<Dependents q={q} pointText={pointText} prereqText={prereqText} />
								{!q.unlocked && q.pointIds.length > 0 && <span className="text-warn">{t("exams.prereq.blocks", { n: q.pointIds.length })}</span>}
							</div>
						</li>
					))}
				</ul>
			)}
			{paging && <Pager page={slice.page} pages={slice.pages} onPage={paging.onPage} testid="exam-prereq-pager" />}
		</section>
	);
}

/** «Conocimientos previos encontrados (N)»: every item pre-checked, with
 *  the placement answers that suggest it; «Aplicar» / «Descartar». */
function ProposalPanel({ exam, onRetry }: { exam: ExamDetailView; onRetry: () => void }) {
	const t = useT();
	const search = exam.record.prerequisiteSearch!;
	const items = useMemo(() => search.items ?? [], [search.items]);
	const pointText = useMemo(() => new Map((exam.model?.points ?? []).map((p) => [p.id, p.text])), [exam.model]);
	const prereqText = useMemo(() => new Map((exam.record.prerequisites ?? []).map((q) => [q.id, q.statement])), [exam.record.prerequisites]);
	const [accept, setAccept] = useState<Set<string>>(() => new Set(items.map((x) => x.id)));
	useEffect(() => setAccept(new Set(items.map((x) => x.id))), [items]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [applied, setApplied] = useState<number | null>(null);
	const send = async (method: "PUT" | "DELETE") => {
		setBusy(true);
		setError(null);
		const res = await sendJson(`/api/exams/${exam.id}/prerequisites`, method, method === "PUT" ? { accept: [...accept] } : undefined);
		setBusy(false);
		if (!res.ok) setError(t("exams.prereq.failed", { error: String(res.body.error ?? "") }));
		else if (method === "PUT") setApplied(typeof res.body.added === "number" ? res.body.added : 0);
	};
	if (applied !== null && applied > 0) {
		return (
			<p role="status" className="px-1 text-sm text-muted-foreground" data-testid="exam-prereq-applied">
				{t("exams.prereq.applied", { n: applied })}
			</p>
		);
	}
	if (search.state === "error") {
		return (
			<div className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm" data-testid="exam-prereq-proposal">
				<p role="alert" className="text-warn">
					{t("exams.prereq.failed", { error: search.error ?? "" })}
				</p>
				<div className="flex gap-2">
					<button type="button" className={quietBtn} disabled={busy} onClick={() => void send("DELETE")}>
						{t("exams.prereq.discard")}
					</button>
					<button type="button" className={quietBtn} disabled={busy} onClick={onRetry} data-testid="exam-prereq-retry">
						{t("exams.prereq.retry")}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm" data-testid="exam-prereq-proposal">
			<p className="font-medium">{t("exams.prereq.found", { n: items.length })}</p>
			{items.length > 0 && (
				<ul className="flex flex-col gap-2">
					{items.map((x) => (
						<li key={x.id} className="flex items-start gap-2">
							<input
								type="checkbox"
								className="mt-1"
								aria-label={x.statement}
								checked={accept.has(x.id)}
								onChange={(e) =>
									setAccept((cur) => {
										const next = new Set(cur);
										if (e.target.checked) next.add(x.id);
										else next.delete(x.id);
										return next;
									})
								}
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span>{x.statement}</span>
								<span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
									<Dependents q={{ blocks: x.points }} pointText={pointText} prereqText={prereqText} />
								</span>
								{x.evidence.map((e, i) => (
									<span key={i} className="text-xs text-muted-foreground">
										{t("exams.prereq.suggestedBy", { problem: e.length > 140 ? `${e.slice(0, 137)}…` : e })}
									</span>
								))}
							</span>
						</li>
					))}
				</ul>
			)}
			{error && <p role="alert" className="text-warn">{error}</p>}
			<div className="flex justify-end gap-2">
				<button type="button" className={quietBtn} disabled={busy} onClick={() => void send("DELETE")} data-testid="exam-prereq-discard">
					{t("exams.prereq.discard")}
				</button>
				{items.length > 0 && (
					<button type="button" className={primaryBtn} disabled={busy || accept.size === 0} onClick={() => void send("PUT")} data-testid="exam-prereq-apply">
						{t("exams.prereq.apply")}
					</button>
				)}
			</div>
		</div>
	);
}

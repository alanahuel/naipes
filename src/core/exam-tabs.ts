/**
 * THE EXAM PAGE'S TABS (owner 2026-11-09): the page stopped being one
 * long scroll. «Sesión de hoy» (or «Resultado» once archived) stays above
 * the tabs; below them Resumen (level, plan, mock) · Temario ·
 * Conocimientos previos · Asignatura · Tutor — the same five for active
 * and archived exams.
 *
 * The open tab lives in the URL (?tab=…, Spanish slugs, owner-approved);
 * no ?tab = Resumen. A tab carries a dot when it asks something of the
 * learner or has work running — nothing for an archived exam, which has
 * no actions.
 */
import { pendingKindPoints, pointKind, type ExamDetailView, type PointKind, type SyllabusBlock } from "./exams.ts";

export type ExamTab = "summary" | "syllabus" | "prior" | "rules" | "tutor";

export const EXAM_TABS: readonly ExamTab[] = ["summary", "syllabus", "prior", "rules", "tutor"];

const SLUGS: Record<ExamTab, string> = { summary: "resumen", syllabus: "temario", prior: "previos", rules: "asignatura", tutor: "tutor" };

/** The URL slug of a tab (?tab=…). */
export const examTabParam = (tab: ExamTab): string => SLUGS[tab];

/** The tab a ?tab value names; anything else (absent, unknown) = Resumen. */
export function examTabFromParam(value: string | null | undefined): ExamTab {
	return EXAM_TABS.find((t) => SLUGS[t] === value) ?? "summary";
}

/** The exam page's href for a tab (Resumen = no ?tab). */
export const examTabHref = (examId: string, tab: ExamTab): string => (tab === "summary" ? `/exams/${examId}` : `/exams/${examId}?tab=${SLUGS[tab]}`);

/** Which tabs carry the «something to do / running» dot. */
export function examTabAlerts(exam: Pick<ExamDetailView, "status" | "infeasible" | "record">): Record<ExamTab, boolean> {
	const none: Record<ExamTab, boolean> = { summary: false, syllabus: false, prior: false, rules: false, tutor: false };
	if (exam.status !== "active") return none;
	const record = exam.record;
	const researching = record.mapping.state === "researching" || record.mapping.state === "running";
	const pending = new Set(pendingKindPoints(record));
	const live = record.blocks.filter((b) => !b.excluded);
	const kindHas = (kind: PointKind, f: (b: SyllabusBlock, p: SyllabusBlock["points"][number]) => boolean) =>
		live.some((b) => b.points.some((p) => pointKind(b, p) === kind && f(b, p)));
	const unresearched = live.some((b) => b.points.some((p) => !p.targets));
	const instruction = (kind: "rules" | "tutor") => kindHas(kind, (_, p) => pending.has(p.id) || (researching && !p.targets));
	const search = record.prerequisiteSearch;
	return {
		summary: exam.infeasible !== null,
		syllabus: researching || record.contrast !== undefined || unresearched || kindHas("syllabus", (_, p) => pending.has(p.id)),
		prior: search !== undefined && (search.state === "running" || search.mode === "review"),
		rules: instruction("rules"),
		tutor: instruction("tutor"),
	};
}

/** «+ Añadir apartado» on Asignatura / Tutor: a hand-written instruction
 *  point (no research — `targets: []`, rules added under it by hand),
 *  appended to the first live block of that type, or to a new block of
 *  that type titled `blockTitle` when there is none. */
export function addInstructionPoint(
	blocks: readonly SyllabusBlock[],
	kind: "rules" | "tutor",
	text: string,
	ids: { block: string; point: string },
	blockTitle: string,
): SyllabusBlock[] {
	const point = { id: ids.point, text: text.trim(), nodeIds: [], targets: [], origin: "user" as const };
	const home = blocks.find((b) => !b.excluded && b.kind === kind);
	if (home) return blocks.map((b) => (b === home ? { ...b, points: [...b.points, point] } : b));
	return [...blocks, { id: ids.block, title: blockTitle, kind, points: [point] }];
}

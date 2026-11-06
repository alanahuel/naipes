/**
 * SPACED REVIEW — the forgetting-curve model («Repaso», owner 2026-11-04).
 *
 * One FSRS card per graph PROPOSITION (ts-fsrs 5.3.1, FSRS-6). Grades are
 * NEVER stored: they derive from what the chat records already hold — the
 * project's "store events, derive state" law. This module is pure
 * (browser-safe, no fs); src/server/review.ts feeds it records and writes
 * the little that cannot be derived (src/store/review.ts).
 *
 * WHERE GRADES COME FROM (owner decisions, 2026-11-04):
 *   TEACH sessions — only the teach phase (from the first nodeId-tagged
 *     quiz call on). Each message belongs to the plan STEP of the NEXT
 *     tagged quiz call at or after it (messages after the last one → the
 *     last step). A proposition whose provenance points at a step's
 *     messages takes that step's LAST «check» answer (predict quizzes never
 *     count; dismissed answers never count):
 *       correct, confidence ≥ threshold (or absent) → Good
 *       correct, confidence < threshold             → Hard
 *       wrong / «I don't know»                      → Again
 *     A teach-session proposition no check covers starts as Good at the
 *     time of its provenance message (the day it was seen).
 *   PRACTICE sessions — every cleanly concluded problem with targets:
 *       solved (no hints) → Good; Easy in composition/discrimination
 *       solvedWithHints R1–R2 → Hard; R3–R5 → Again (none/R0 → Hard)
 *       surrendered → Again; movedOn / dismissed → nothing
 *
 * WHAT IS ENROLLED: propositions with provenance in a teach session, plus
 * propositions of ACTIVATED Obsidian areas (new — released by the daily
 * intake), plus anything practiced (practicing enrolls it). Minus pauses
 * (an origin session, an origin area, or a single proposition).
 *
 * THE SHARED DAILY INTAKE (owner): one cap per day (settings newPerDay).
 * First the history BACKLOG — ideas already overdue when review was
 * activated, most forgotten first — then NEW area ideas (oldest first).
 * Until released, such an idea is invisible to «today». Released lines
 * are persisted (intake.jsonl), so the order never reshuffles.
 *
 * Days roll over at 04:00 local (owner, Anki's convention). Again
 * reschedules to another day (no short-term steps); FSRS fuzz is on.
 */

import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type FSRS, type Grade } from "ts-fsrs";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GraphNode } from "./contracts/graph.ts";
import type { NpMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, problemCallForConclude, problemInputForConclude } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { areaOfPath } from "./areas.ts";

// ─── grades ─────────────────────────────────────────────────────────────────

export type ReviewGrade = "again" | "hard" | "good" | "easy";

const RATING: Record<ReviewGrade, Grade> = {
	again: Rating.Again,
	hard: Rating.Hard,
	good: Rating.Good,
	easy: Rating.Easy,
};

/** Where one grade came from — for the review screen and for tests. */
export type ReviewEventKind = "teach-check" | "teach-seen" | "practice";

/** The demand modes of a practice problem — the exam ladder (owner,
 *  2026-11-05: Recordar → Discriminar → Componer). */
export type DemandMode = "recall" | "discrimination" | "composition";

export const DEMAND_MODES: readonly DemandMode[] = ["recall", "discrimination", "composition"];

/** What a graded event does to the idea's reached mode («Exámenes», owner
 *  2026-11-05): up = clean (no hints, confident) at `mode`; stay = right
 *  but shaky (low confidence or light hints); miss = wrong / heavy hints /
 *  surrendered. Teach checks act at recall. */
export type ModeStep = "up" | "stay" | "miss";

export interface ReviewEvent {
	nodeId: string;
	/** Epoch ms. */
	at: number;
	grade: ReviewGrade;
	kind: ReviewEventKind;
	chatId: string;
	/** The problem's demand mode (practice), "recall" for teach checks. */
	mode?: DemandMode;
	/** Absent = no effect on the reached mode (teach-seen). */
	step?: ModeStep;
}

/** A teach «check» answer → grade (null = does not count). */
export function gradeFromCheck(answer: Pick<QuestionAnswerData, "correct" | "confidence" | "dontKnow" | "dismissed">, confidenceThreshold: number): ReviewGrade | null {
	if (answer.dismissed) return null;
	if (answer.dontKnow) return "again";
	if (answer.correct === undefined) return null;
	if (!answer.correct) return "again";
	if (typeof answer.confidence === "number" && answer.confidence < confidenceThreshold) return "hard";
	return "good";
}

/** A teach check's grade → its mode step (always at recall). */
export function stepFromCheckGrade(grade: ReviewGrade): ModeStep {
	return grade === "good" || grade === "easy" ? "up" : grade === "hard" ? "stay" : "miss";
}

/** A practice conclude → grade (null = does not count). A solve the
 *  learner declared low confidence in (below the threshold) is Hard — the
 *  teach-check rule, extended to practice (owner, 2026-11-05). */
export function gradeFromConclude(outcome: unknown, rung: unknown, mode: unknown, confidence?: number, confidenceThreshold = 70): ReviewGrade | null {
	switch (outcome) {
		case "solved":
			if (typeof confidence === "number" && confidence < confidenceThreshold) return "hard";
			return mode === "composition" || mode === "discrimination" ? "easy" : "good";
		case "solvedWithHints":
			return rung === "R3" || rung === "R4" || rung === "R5" ? "again" : "hard";
		case "surrendered":
			return "again";
		default:
			return null; // movedOn, dismissed, garbage
	}
}

/** A practice conclude → mode step (null = does not count). */
export function stepFromConclude(outcome: unknown, rung: unknown, confidence?: number, confidenceThreshold = 70): ModeStep | null {
	switch (outcome) {
		case "solved":
			return typeof confidence === "number" && confidence < confidenceThreshold ? "stay" : "up";
		case "solvedWithHints":
			return rung === "R3" || rung === "R4" || rung === "R5" ? "miss" : "stay";
		case "surrendered":
			return "miss";
		default:
			return null;
	}
}

const asMode = (v: unknown): DemandMode | undefined => (DEMAND_MODES as readonly unknown[]).includes(v) ? (v as DemandMode) : undefined;

// ─── reading the records ────────────────────────────────────────────────────

export interface ReviewChat {
	id: string;
	kind?: "teach" | "practice";
	createdAt: string;
	messages: readonly NpMessage[];
	/** An exam session («Exámenes»): a mock exam never grades anything —
	 *  it is informative only (owner, 2026-11-05). */
	exam?: { kind: string };
}

type Block = AssistantMessage["content"][number];
type ToolCallBlock = Extract<Block, { type: "toolCall" }>;

const roleOf = (m: NpMessage): string => (m as { role?: string }).role ?? "";
const toolCallsOf = (m: NpMessage): ToolCallBlock[] =>
	roleOf(m) === "assistant" ? ((m as AssistantMessage).content.filter((b) => b.type === "toolCall") as ToolCallBlock[]) : [];

/** Tool call ids whose result came back clean (refused calls never happened). */
function cleanCallIds(messages: readonly NpMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if (roleOf(m) === "toolResult" && !(m as ToolResultMessage).isError) ids.add((m as ToolResultMessage).toolCallId);
	}
	return ids;
}

/** The plan step of a tagged teach quiz call, or null. */
function quizStep(block: ToolCallBlock): string | null {
	if (block.name !== "quiz") return null;
	const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
	return typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null;
}

/**
 * Message → plan step, teach phase only (owner, 2026-11-04): each message
 * belongs to the step of the NEXT tagged quiz call at or after it; the
 * messages after the last tagged call belong to that last step. Messages
 * before the teach phase belong to no step.
 */
export function stepsByMessage(messages: readonly NpMessage[]): Map<string, string> {
	const out = new Map<string, string>();
	const stepAt: (string | null)[] = messages.map((m) => {
		for (const call of toolCallsOf(m)) {
			const step = quizStep(call);
			if (step) return step;
		}
		return null;
	});
	const first = stepAt.findIndex((s) => s !== null);
	if (first < 0) return out;
	let current: string | null = null;
	for (let i = messages.length - 1; i >= first; i--) {
		if (stepAt[i]) current = stepAt[i]!;
		else if (current === null) {
			// Trailing messages: the last tagged step (found walking back).
			for (let j = i; j >= first; j--) if (stepAt[j]) { current = stepAt[j]!; break; }
		}
		if (current) out.set(messages[i]!.id, current);
	}
	return out;
}

/** Each step's LAST graded «check» answer: step → { grade, at }. */
export function lastCheckByStep(messages: readonly NpMessage[], confidenceThreshold: number): Map<string, { grade: ReviewGrade; at: number }> {
	const stepOfCall = new Map<string, string>();
	for (const m of messages) for (const call of toolCallsOf(m)) {
		const step = quizStep(call);
		if (step) stepOfCall.set(call.id, step);
	}
	const out = new Map<string, { grade: ReviewGrade; at: number; order: number }>();
	messages.forEach((m, order) => {
		if (roleOf(m) !== "toolResult") return;
		const result = m as ToolResultMessage;
		const step = stepOfCall.get(result.toolCallId);
		if (!step || result.isError) return;
		const answer = result.details as Partial<QuestionAnswerData> | undefined;
		if (!answer || answer.kind !== "quiz") return;
		// Predictions are asked BEFORE teaching — never a memory signal.
		// Absent type = a pre-role record, when every quiz was a check.
		if (answer.questionType === "predict") return;
		const grade = gradeFromCheck(answer as QuestionAnswerData, confidenceThreshold);
		if (!grade) return;
		const parsed = typeof answer.answeredAt === "string" ? Date.parse(answer.answeredAt) : NaN;
		const at = Number.isFinite(parsed) ? parsed : result.timestamp;
		const prev = out.get(step);
		if (!prev || order > prev.order) out.set(step, { grade, at, order });
	});
	return new Map([...out].map(([k, v]) => [k, { grade: v.grade, at: v.at }]));
}

/** One teach session's grade events for the propositions it touched. */
export function teachEvents(
	chat: ReviewChat,
	nodesOfMessage: ReadonlyMap<string, readonly string[]>,
	confidenceThreshold: number,
): ReviewEvent[] {
	const steps = stepsByMessage(chat.messages);
	const checks = lastCheckByStep(chat.messages, confidenceThreshold);
	const timeOf = new Map(chat.messages.map((m) => [m.id, (m as { timestamp?: number }).timestamp]));
	const fallback = Date.parse(chat.createdAt);
	// node → { steps it appears in, earliest provenance time }
	const touched = new Map<string, { steps: Set<string>; seenAt: number }>();
	for (const [messageId, nodeIds] of nodesOfMessage) {
		const t = timeOf.get(messageId);
		const at = typeof t === "number" ? t : fallback;
		const step = steps.get(messageId);
		for (const nodeId of nodeIds) {
			const entry = touched.get(nodeId) ?? { steps: new Set<string>(), seenAt: at };
			entry.seenAt = Math.min(entry.seenAt, at);
			if (step) entry.steps.add(step);
			touched.set(nodeId, entry);
		}
	}
	const events: ReviewEvent[] = [];
	for (const [nodeId, { steps: nodeSteps, seenAt }] of touched) {
		let graded = false;
		for (const step of nodeSteps) {
			const check = checks.get(step);
			if (!check) continue;
			events.push({ nodeId, at: check.at, grade: check.grade, kind: "teach-check", chatId: chat.id, mode: "recall", step: stepFromCheckGrade(check.grade) });
			graded = true;
		}
		if (!graded && Number.isFinite(seenAt)) {
			events.push({ nodeId, at: seenAt, grade: "good", kind: "teach-seen", chatId: chat.id });
		}
	}
	return events;
}

/** The learner's confidence on a problem: the LAST thinking submission's
 *  (practice-thinking details.confidence, owner 2026-11-05); undefined
 *  when none carried one (records before the slider). */
export function problemConfidence(messages: readonly NpMessage[], problemCallId: string): number | undefined {
	let out: number | undefined;
	for (const m of messages) {
		if (roleOf(m) !== "custom" || (m as { customType?: string }).customType !== "practice-thinking") continue;
		const details = (m as { details?: { problemCallId?: unknown; confidence?: unknown } }).details;
		if (details?.problemCallId === problemCallId && typeof details.confidence === "number") out = details.confidence;
	}
	return out;
}

/** One practice session's grade events (targets must be known nodes). */
export function practiceEvents(chat: ReviewChat, knownNodes: ReadonlySet<string>, confidenceThreshold = 70): ReviewEvent[] {
	const clean = cleanCallIds(chat.messages);
	const resultTime = new Map<string, number>();
	for (const m of chat.messages) {
		if (roleOf(m) === "toolResult") resultTime.set((m as ToolResultMessage).toolCallId, (m as ToolResultMessage).timestamp);
	}
	const events: ReviewEvent[] = [];
	for (const m of chat.messages) {
		for (const call of toolCallsOf(m)) {
			if (call.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(call.id)) continue;
			const args = (call.arguments ?? {}) as { outcome?: unknown; rung?: unknown };
			const posed = problemCallForConclude(chat.messages, call.id);
			const problem = posed?.input;
			const confidence = posed ? problemConfidence(chat.messages, posed.id) : undefined;
			const grade = gradeFromConclude(args.outcome, args.rung, problem?.mode, confidence, confidenceThreshold);
			if (!grade || !Array.isArray(problem?.target)) continue;
			const mode = asMode(problem.mode);
			const step = stepFromConclude(args.outcome, args.rung, confidence, confidenceThreshold);
			const at = resultTime.get(call.id) ?? (m as { timestamp?: number }).timestamp ?? Date.parse(chat.createdAt);
			for (const target of new Set(problem.target)) {
				if (typeof target === "string" && knownNodes.has(target)) {
					events.push({ nodeId: target, at, grade, kind: "practice", chatId: chat.id, ...(mode && step ? { mode, step } : {}) });
				}
			}
		}
	}
	return events;
}

// ─── days ───────────────────────────────────────────────────────────────────

/** The review day rolls over at 04:00 local time (owner, 2026-11-04). */
export const DAY_ROLLOVER_HOUR = 4;

/** Local "YYYY-MM-DD" of the review day containing `ms`. */
export function reviewDay(ms: number): string {
	const d = new Date(ms - DAY_ROLLOVER_HOUR * 3_600_000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Epoch ms when the review day containing `ms` ends (next 04:00 local). */
export function reviewDayEnd(ms: number): number {
	const d = new Date(ms - DAY_ROLLOVER_HOUR * 3_600_000);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, DAY_ROLLOVER_HOUR, 0, 0, 0).getTime();
}

/** Whole review days from `fromDay` to `toDay` ("YYYY-MM-DD"), DST-safe. */
export function daysBetween(fromDay: string, toDay: string): number {
	const utc = (day: string) => {
		const [y, m, d] = day.split("-").map(Number);
		return Date.UTC(y!, m! - 1, d!);
	};
	return Math.round((utc(toDay) - utc(fromDay)) / 86_400_000);
}

// ─── FSRS ───────────────────────────────────────────────────────────────────

export function reviewScheduler(targetRetention: number): FSRS {
	return fsrs(generatorParameters({ request_retention: targetRetention, enable_fuzz: true, enable_short_term: false }));
}

export type CardState = "new" | "review" | "relearning" | "learning";

const STATE_NAME: Record<State, CardState> = {
	[State.New]: "new",
	[State.Learning]: "learning",
	[State.Review]: "review",
	[State.Relearning]: "relearning",
};

/** Replay a proposition's events (any order in, sorted here) → its card. */
export function replayCard(events: readonly ReviewEvent[], scheduler: FSRS): Card | null {
	if (events.length === 0) return null;
	const sorted = [...events].sort((a, b) => a.at - b.at);
	let card = createEmptyCard(new Date(sorted[0]!.at));
	for (const e of sorted) card = scheduler.next(card, new Date(e.at), RATING[e.grade]).card;
	return card;
}

// ─── sources, intake ────────────────────────────────────────────────────────

/** data/review/sources.json — what review covers (see config REVIEW_FILES). */
export interface ReviewSources {
	version: 1;
	/** ISO — when review was first computed (the backlog's reference). */
	activatedAt: string;
	/** Activated Obsidian area ids ("area:<folders>"). */
	areas: string[];
	paused: { sessions: string[]; areas: string[]; nodes: string[] };
}

export function emptyReviewSources(now: number): ReviewSources {
	return { version: 1, activatedAt: new Date(now).toISOString(), areas: [], paused: { sessions: [], areas: [], nodes: [] } };
}

/** One intake.jsonl line: an idea released by the shared daily cap. */
export interface IntakeLine {
	nodeId: string;
	day: string;
	reason: "backlog" | "new";
}

/** Today's releases (owner: ONE shared cap, backlog first — most
 *  forgotten first — then new ideas in the given order). Pure. */
export function planIntake(input: {
	today: string;
	existing: readonly IntakeLine[];
	backlog: ReadonlyArray<{ nodeId: string; retrievability: number }>;
	fresh: readonly string[];
	cap: number;
}): IntakeLine[] {
	const released = new Set(input.existing.map((l) => l.nodeId));
	let room = input.cap - input.existing.filter((l) => l.day === input.today).length;
	const out: IntakeLine[] = [];
	const backlog = [...input.backlog]
		.filter((b) => !released.has(b.nodeId))
		.sort((a, b) => a.retrievability - b.retrievability || (a.nodeId < b.nodeId ? -1 : 1));
	for (const b of backlog) {
		if (room <= 0) break;
		out.push({ nodeId: b.nodeId, day: input.today, reason: "backlog" });
		released.add(b.nodeId);
		room--;
	}
	for (const nodeId of input.fresh) {
		if (room <= 0) break;
		if (released.has(nodeId)) continue;
		out.push({ nodeId, day: input.today, reason: "new" });
		released.add(nodeId);
		room--;
	}
	return out;
}

// ─── the whole model ────────────────────────────────────────────────────────

/** Where an idea belongs on the review screen: its first teach session,
 *  else its Obsidian area, else its first practice session. */
export interface ReviewGroup {
	kind: "session" | "area";
	id: string;
}

export interface ReviewItem {
	nodeId: string;
	name: string;
	group: ReviewGroup;
	state: CardState;
	/** null while new (never graded). */
	stability: number | null;
	difficulty: number | null;
	/** Probability of recall right now, 0–1 (null while new). */
	retrievability: number | null;
	/** Epoch ms; for a new idea, the start of its release day. */
	due: number | null;
	lastReview: number | null;
	reps: number;
	lapses: number;
	paused: boolean;
	/** False while waiting for the daily intake (backlog or new). */
	released: boolean;
	events: ReviewEvent[];
}

export interface ReviewInput {
	now: number;
	nodes: readonly Pick<GraphNode, "id" | "name" | "provenance">[];
	chats: readonly ReviewChat[];
	/** Notes source id ("src_…") → vault-relative file path. */
	sourcePaths: Readonly<Record<string, string>>;
	sources: ReviewSources;
	intake: readonly IntakeLine[];
	settings: { targetRetention: number; newPerDay: number; confidenceThreshold: number };
	/** Ideas of ACTIVE exams («Exámenes», owner 2026-11-05): enrolled,
	 *  exempt from the daily cap (the study budget rules them), held out of
	 *  review until first graded (the placement test grades them), and due
	 *  per `due` (src/core/exams.ts deadlineDue, composed by the server). */
	exams?: {
		nodeIds: ReadonlySet<string>;
		due: (nodeId: string, card: { due: number; stability: number; lastReview: number }) => number;
	};
}

export interface ReviewModel {
	today: string;
	items: ReviewItem[];
	/** Intake lines to persist for today (the caller appends them). */
	newIntake: IntakeLine[];
}

/**
 * The review model: events → cards → enrollment → intake → items. Pure
 * and deterministic for the same input (fuzz is seeded by ts-fsrs from
 * the card and review time).
 */
export function computeReview(input: ReviewInput): ReviewModel {
	const { now, sources, settings } = input;
	const today = reviewDay(now);
	const scheduler = reviewScheduler(settings.targetRetention);
	const activatedAt = Date.parse(sources.activatedAt);
	const known = new Set(input.nodes.map((n) => n.id));
	const chatKind = new Map(input.chats.map((c) => [c.id, c.kind ?? "teach"]));

	// Events, per node.
	const eventsOf = new Map<string, ReviewEvent[]>();
	const add = (e: ReviewEvent) => {
		const list = eventsOf.get(e.nodeId);
		if (list) list.push(e);
		else eventsOf.set(e.nodeId, [e]);
	};
	const nodesOfMessageByChat = new Map<string, Map<string, string[]>>();
	for (const node of input.nodes) {
		for (const p of node.provenance) {
			if (chatKind.get(p.chatId) !== "teach") continue;
			let byMessage = nodesOfMessageByChat.get(p.chatId);
			if (!byMessage) nodesOfMessageByChat.set(p.chatId, (byMessage = new Map()));
			const ids = byMessage.get(p.messageId) ?? [];
			if (!ids.includes(node.id)) ids.push(node.id);
			byMessage.set(p.messageId, ids);
		}
	}
	for (const chat of input.chats) {
		if (chat.exam?.kind === "mock") continue;
		if ((chat.kind ?? "teach") === "practice") practiceEvents(chat, known, settings.confidenceThreshold).forEach(add);
		else {
			const byMessage = nodesOfMessageByChat.get(chat.id);
			if (byMessage) teachEvents(chat, byMessage, settings.confidenceThreshold).forEach(add);
		}
	}

	// Enrollment + grouping.
	const activeAreas = new Set(sources.areas);
	const pausedSessions = new Set(sources.paused.sessions);
	const pausedAreas = new Set(sources.paused.areas);
	const pausedNodes = new Set(sources.paused.nodes);
	const intakeOf = new Map(input.intake.map((l) => [l.nodeId, l]));

	interface Candidate { node: ReviewInput["nodes"][number]; group: ReviewGroup; events: ReviewEvent[]; card: Card | null; paused: boolean; areaId: string | null; inExam: boolean }
	const candidates: Candidate[] = [];
	for (const node of input.nodes) {
		const events = eventsOf.get(node.id) ?? [];
		const teachChat = node.provenance.find((p) => chatKind.get(p.chatId) === "teach")?.chatId ?? null;
		const birth = node.provenance[0]?.chatId;
		const path = birth ? input.sourcePaths[birth] : undefined;
		const areaId = path !== undefined ? areaOfPath(path).id : null;
		const inArea = areaId !== null && activeAreas.has(areaId);
		const inExam = input.exams?.nodeIds.has(node.id) ?? false;
		if (!teachChat && !inArea && !inExam && events.length === 0) continue;
		const practiceChat = events.find((e) => e.kind === "practice")?.chatId ?? null;
		const group: ReviewGroup = teachChat
			? { kind: "session", id: teachChat }
			: areaId
				? { kind: "area", id: areaId }
				: { kind: "session", id: practiceChat ?? "" };
		const paused = pausedNodes.has(node.id) || (group.kind === "session" ? pausedSessions.has(group.id) : pausedAreas.has(group.id));
		candidates.push({ node, group, events, card: replayCard(events, scheduler), paused, areaId, inExam });
	}

	// The shared daily intake: backlog (overdue at activation, nothing
	// since) first, then new area ideas (never graded), oldest first.
	const activationDayEnd = reviewDayEnd(activatedAt);
	const isBacklog = (c: Candidate) =>
		!c.inExam &&
		c.events.length > 0 &&
		c.events.every((e) => e.at < activatedAt) &&
		c.card !== null &&
		c.card.due.getTime() < activationDayEnd;
	const backlog = candidates
		.filter((c) => !c.paused && isBacklog(c))
		.map((c) => ({ nodeId: c.node.id, retrievability: scheduler.get_retrievability(c.card!, new Date(activatedAt), false) }));
	const fresh = candidates.filter((c) => !c.paused && !c.inExam && c.events.length === 0).map((c) => c.node.id);
	const newIntake = planIntake({ today, existing: input.intake, backlog, fresh, cap: settings.newPerDay });
	for (const line of newIntake) intakeOf.set(line.nodeId, line);

	const items: ReviewItem[] = candidates.map((c) => {
		const needsIntake = !c.inExam && (c.events.length === 0 || isBacklog(c));
		const line = intakeOf.get(c.node.id);
		const released = c.inExam ? c.events.length > 0 : !needsIntake || line !== undefined;
		const card = c.card;
		let due: number | null = card ? card.due.getTime() : null;
		if (c.inExam && card && card.last_review && input.exams) {
			due = input.exams.due(c.node.id, { due: card.due.getTime(), stability: card.stability, lastReview: card.last_review.getTime() });
		}
		if (line && needsIntake) {
			const [y, m, d] = line.day.split("-").map(Number);
			const releaseStart = new Date(y!, m! - 1, d!, DAY_ROLLOVER_HOUR).getTime();
			due = due === null ? releaseStart : Math.max(due, releaseStart);
		}
		const lastReview = c.events.length ? Math.max(...c.events.map((e) => e.at)) : null;
		return {
			nodeId: c.node.id,
			name: c.node.name,
			group: c.group,
			state: card ? STATE_NAME[card.state] : "new",
			stability: card ? card.stability : null,
			difficulty: card ? card.difficulty : null,
			retrievability: card ? scheduler.get_retrievability(card, new Date(now), false) : null,
			due,
			lastReview,
			reps: card ? card.reps : 0,
			lapses: card ? card.lapses : 0,
			paused: c.paused,
			released,
			events: [...c.events].sort((a, b) => a.at - b.at),
		};
	});
	items.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || (a.nodeId < b.nodeId ? -1 : 1));
	return { today, items, newIntake };
}

// ─── aggregates ─────────────────────────────────────────────────────────────

/** Visible = enrolled, not paused, released by the intake. */
export const isActive = (item: ReviewItem): boolean => !item.paused && item.released;

/** Due today = active, with a due time before the review day ends. */
export function dueToday(items: readonly ReviewItem[], now: number): ReviewItem[] {
	const end = reviewDayEnd(now);
	return items.filter((i) => isActive(i) && i.due !== null && i.due < end);
}

/** Mean probability of recall over enrolled, already-graded ideas that are
 *  not paused. Ideas still waiting for the daily intake COUNT — they are in
 *  your memory and fading whether or not today's cap reached them (the
 *  intake gates scheduling, not what you know). */
export function meanRetention(items: readonly ReviewItem[]): number | null {
	const rs = items.filter((i) => !i.paused && i.retrievability !== null).map((i) => i.retrievability!);
	return rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null;
}

/** Due counts for the next `days` review days (overdue → day 0). */
export function forecast(items: readonly ReviewItem[], now: number, days: number): number[] {
	const today = reviewDay(now);
	const counts = new Array<number>(days).fill(0);
	for (const i of items) {
		if (!isActive(i) || i.due === null) continue;
		const k = Math.max(0, daysBetween(today, reviewDay(i.due)));
		if (k < days) counts[k]!++;
	}
	return counts;
}

/** Items grouped by their review group, in first-appearance order. */
export function groupItems(items: readonly ReviewItem[]): Array<{ group: ReviewGroup; items: ReviewItem[] }> {
	const out = new Map<string, { group: ReviewGroup; items: ReviewItem[] }>();
	for (const item of items) {
		const key = `${item.group.kind}:${item.group.id}`;
		const entry = out.get(key) ?? { group: item.group, items: [] };
		entry.items.push(item);
		out.set(key, entry);
	}
	return [...out.values()];
}

// ─── sanitizers (the store's read seam) ─────────────────────────────────────

export const CURRENT_REVIEW_SOURCES_VERSION = 1;

const stringList = (v: unknown): string[] =>
	Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];

/** Coerce a sources.json body. null = unusable (absent/corrupt); throws on
 *  a NEWER version — a read-modify-write store must never rewrite what it
 *  doesn't understand (the chat-record law). */
export function sanitizeReviewSources(raw: unknown): ReviewSources | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.version === "number" && r.version > CURRENT_REVIEW_SOURCES_VERSION) {
		throw new Error(`review sources stamped with version ${r.version} > ${CURRENT_REVIEW_SOURCES_VERSION} — this app build is older`);
	}
	if (typeof r.activatedAt !== "string" || !Number.isFinite(Date.parse(r.activatedAt))) return null;
	const paused = (r.paused !== null && typeof r.paused === "object" ? r.paused : {}) as Record<string, unknown>;
	return {
		version: 1,
		activatedAt: r.activatedAt,
		areas: stringList(r.areas),
		paused: { sessions: stringList(paused.sessions), areas: stringList(paused.areas), nodes: stringList(paused.nodes) },
	};
}

export function isIntakeLine(v: unknown): v is IntakeLine {
	if (v === null || typeof v !== "object") return false;
	const l = v as Record<string, unknown>;
	return typeof l.nodeId === "string" && typeof l.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(l.day) && (l.reason === "backlog" || l.reason === "new");
}

// ─── review batches (stage 2, owner 2026-11-04) ─────────────────────────────

/** The next review batch: due ideas, most forgotten first (new ideas —
 *  never graded — after the graded ones), alternating groups round-robin
 *  so topics interleave. Pure. */
export function selectBatch(due: readonly ReviewItem[], size: number): ReviewItem[] {
	const sorted = [...due].sort((a, b) => {
		const ra = a.retrievability ?? Infinity;
		const rb = b.retrievability ?? Infinity;
		return ra - rb || (a.nodeId < b.nodeId ? -1 : 1);
	});
	const queues = groupItems(sorted).map((g) => [...g.items]);
	const out: ReviewItem[] = [];
	while (out.length < size && queues.some((q) => q.length > 0)) {
		for (const q of queues) {
			if (out.length >= size) break;
			const next = q.shift();
			if (next) out.push(next);
		}
	}
	return out;
}

// ─── review notices (stage 2, owner-approved rules 2026-11-04) ──────────────

export type ReviewNoticeKind = "digest" | "evening";

/** One notices.jsonl line. */
export interface ReviewNoticeLine {
	day: string;
	kind: ReviewNoticeKind;
	/** ISO time it was sent. */
	at: string;
	count: number;
}

export function isReviewNoticeLine(v: unknown): v is ReviewNoticeLine {
	if (v === null || typeof v !== "object") return false;
	const l = v as Record<string, unknown>;
	return typeof l.day === "string" && (l.kind === "digest" || l.kind === "evening") && typeof l.at === "string" && typeof l.count === "number";
}

/** Minutes since local midnight of a "HH:MM" clock time. */
const clockMinutes = (hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(Number);
	return h! * 60 + m!;
};

/**
 * Should this notice go out now? (owner rules, 2026-11-04)
 *   digest  — at/after digestTime, before eveningTime (a missed one goes
 *             out at startup until then), once per review day, only with
 *             something due.
 *   evening — at/after eveningTime, once per day, only with something
 *             due AND no review session started today.
 * Times compare against the local wall clock of `now`.
 */
export function shouldSendNotice(input: {
	kind: ReviewNoticeKind;
	now: number;
	digestTime: string;
	eveningTime: string;
	dueCount: number;
	sent: readonly ReviewNoticeLine[];
	reviewStartedToday: boolean;
}): boolean {
	const today = reviewDay(input.now);
	if (input.dueCount <= 0) return false;
	if (input.sent.some((l) => l.day === today && l.kind === input.kind)) return false;
	const d = new Date(input.now);
	const minutes = d.getHours() * 60 + d.getMinutes();
	// Before 04:00 the review day is still yesterday — never notify then.
	if (d.getHours() < DAY_ROLLOVER_HOUR) return false;
	const digest = clockMinutes(input.digestTime);
	const evening = clockMinutes(input.eveningTime);
	if (input.kind === "digest") return minutes >= digest && minutes < evening;
	return minutes >= evening && !input.reviewStartedToday;
}

// ─── review batch progress (stage 3, the session's end-of-batch buttons) ────

/** A review session's batch: the picked ideas (the graph-context marker)
 *  and which of them already had a cleanly concluded problem (dismissals
 *  count — the learner moved on). `done` = every pick covered. Pure. */
export function reviewBatchProgress(messages: readonly NpMessage[]): { picks: string[]; covered: string[]; done: boolean } {
	const marker = messages.find(
		(m) => roleOf(m) === "custom" && (m as { customType?: string }).customType === "graph-context",
	) as { details?: { propositions?: Array<{ id?: unknown }> } } | undefined;
	const picks = (marker?.details?.propositions ?? []).map((p) => p.id).filter((id): id is string => typeof id === "string");
	const clean = cleanCallIds(messages);
	const covered = new Set<string>();
	for (const m of messages) {
		for (const call of toolCallsOf(m)) {
			if (call.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(call.id)) continue;
			const target = problemInputForConclude(messages, call.id)?.target;
			if (Array.isArray(target)) for (const t of target) if (typeof t === "string") covered.add(t);
		}
	}
	const coveredPicks = picks.filter((p) => covered.has(p));
	return { picks, covered: coveredPicks, done: picks.length > 0 && coveredPicks.length === picks.length };
}

// ─── API shapes (GET /api/review; shared by server and components) ──────────

/** An Obsidian area the learner can switch on (from the graph's notes). */
export interface ReviewArea {
	id: string;
	label: string;
	/** Propositions born in this area. */
	count: number;
	active: boolean;
	paused: boolean;
}

export interface ReviewGroupView {
	group: ReviewGroup;
	label: string;
}

export interface ReviewSummary {
	today: string;
	due: Array<ReviewGroupView & { nodeIds: string[] }>;
	dueCount: number;
	retention: { overall: number | null; byGroup: Array<ReviewGroupView & { retention: number | null; count: number }> };
	forecast7: number[];
	forecast30: number[];
	enrolled: number;
	waitingIntake: number;
	reviewedToday: boolean;
}

/** The API's per-idea view (no event log; it can be long). */
export type ReviewItemView = Omit<ReviewItem, "events"> & { label: string };

/** GET /api/review's body. */
export interface ReviewApiResponse {
	summary: ReviewSummary;
	items: ReviewItemView[];
	areas: ReviewArea[];
	sources: ReviewSources;
	settings: { targetRetention: number; newPerDay: number };
}

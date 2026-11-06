/** Exams with a deadline — the pure model («Exámenes», owner 2026-11-05):
 *  src/core/exams.ts + the exam-aware parts of src/core/review.ts.
 *  Synthetic records only — no data dir, no network, no clock. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeMinutes,
	addDays,
	computeExamStatus,
	coverageWith,
	deadlineDue,
	EMPTY_EXAM_CONTEXT,
	folderCheck,
	foldersToRead,
	inExamScope,
	selectionScope,
	toggleFolder,
	sanitizeContext,
	sanitizeMaterials,
	examMoment,
	examWork,
	ideaLevel,
	infeasibility,
	intervalDays,
	isInFolder,
	knowledgeFolders,
	measureDurations,
	planBudget,
	pointProbes,
	presetStandard,
	recallAt,
	reduceFolders,
	sanitizeExamRecord,
	todayBlocks,
	weekdayIndex,
	type ExamChat,
	type ExamRecord,
} from "../src/core/exams.ts";
import {
	computeReview,
	emptyReviewSources,
	gradeFromConclude,
	practiceEvents,
	stepFromConclude,
	type ReviewEvent,
	type ReviewInput,
	type ReviewItem,
} from "../src/core/review.ts";
import type { NpMessage } from "../src/core/native-messages.ts";
import { newThinkingMessage } from "../src/core/native-messages.ts";
import { parseChatInput } from "../src/core/input-events.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseExamSettingsBody } from "../src/server/settings-body.ts";

const T0 = new Date(2026, 10, 2, 10, 0, 0).getTime(); // 2026-11-02 (Mon) 10:00 local
const H = 3_600_000;
const D = 24 * H;

const ev = (over: Partial<ReviewEvent>): ReviewEvent => ({ nodeId: "n1", at: T0, grade: "good", kind: "practice", chatId: "c", ...over });

let seq = 0;
const problem = (id: string, at: number, args: Record<string, unknown>, callId = `p${++seq}`): NpMessage =>
	({ id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "problem", arguments: args }], timestamp: at }) as unknown as NpMessage;
const conclude = (id: string, at: number, args: Record<string, unknown>, callId = `k${++seq}`): NpMessage =>
	({ id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "conclude", arguments: args }], timestamp: at }) as unknown as NpMessage;
const ok = (id: string, at: number, callId: string, name: string): NpMessage =>
	({ id, role: "toolResult", toolCallId: callId, toolName: name, content: [], isError: false, timestamp: at }) as unknown as NpMessage;
const thinking = (problemCallId: string, at: number, confidence?: number): NpMessage => ({ ...newThinkingMessage(problemCallId, "answer", confidence), timestamp: at }) as NpMessage;

/** One problem: pose → thinking (confidence) → conclude. */
function solvedProblem(at: number, args: { target?: string[]; mode?: string; syllabusPoint?: string }, outcome: Record<string, unknown>, confidence?: number): NpMessage[] {
	const pid = `p${++seq}`;
	const kid = `k${++seq}`;
	return [
		problem(`m${++seq}`, at, { statement: "s", modelSolution: "x", mode: args.mode ?? "recall", ...(args.target ? { target: args.target } : {}), ...(args.syllabusPoint ? { syllabusPoint: args.syllabusPoint } : {}) }, pid),
		ok(`m${++seq}`, at, pid, "problem"),
		thinking(pid, at + 60_000, confidence),
		conclude(`m${++seq}`, at + 2 * 60_000, { outcome: "solved", rung: null, verdict: "v", missClass: null, retest: false, ...outcome }, kid),
		ok(`m${++seq}`, at + 2 * 60_000, kid, "conclude"),
	];
}

function exam(over: Partial<ExamRecord> = {}): ExamRecord {
	return {
		version: 2,
		id: "exam_test_1",
		title: "Física",
		examDate: "2026-11-30",
		createdAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0).toISOString(),
		status: "active",
		standard: presetStandard("merit"),
		syllabus: { text: "Tema 1", fileName: null, folders: [], directFolders: [] },
		context: { ...EMPTY_EXAM_CONTEXT },
		materials: [],
		blocks: [
			{ id: "b1", title: "Cinemática", points: [{ id: "pt1", text: "Velocidad", nodeIds: ["n1", "n2"] }, { id: "pt2", text: "Aceleración", nodeIds: [] }] },
		],
		mapping: { state: "done" },
		priorityBlocks: [],
		...over,
	};
}

describe("confidence on practice (owner 2026-11-05)", () => {
	it("a solve with low confidence is Hard and stays; confident is Good and climbs", () => {
		assert.equal(gradeFromConclude("solved", null, "recall", 30, 70), "hard");
		assert.equal(gradeFromConclude("solved", null, "recall", 90, 70), "good");
		assert.equal(gradeFromConclude("solved", null, "composition", undefined, 70), "easy");
		assert.equal(stepFromConclude("solved", null, 30, 70), "stay");
		assert.equal(stepFromConclude("solved", null, 70, 70), "up");
		assert.equal(stepFromConclude("solvedWithHints", "R2"), "stay");
		assert.equal(stepFromConclude("solvedWithHints", "R4"), "miss");
		assert.equal(stepFromConclude("surrendered", null), "miss");
		assert.equal(stepFromConclude("movedOn", null), null);
	});

	it("the thinking message carries the confidence to the model and to details", () => {
		const m = newThinkingMessage("p1", "my answer", 70) as unknown as { content: string; details: { confidence?: number } };
		assert.match(m.content, /Confidence: 70%$/);
		assert.equal(m.details.confidence, 70);
		const bare = newThinkingMessage("p1", "my answer") as unknown as { content: string; details: Record<string, unknown> };
		assert.ok(!bare.content.includes("Confidence"));
		assert.equal("confidence" in bare.details, false);
	});

	it("the thinking input accepts only the confidence stops", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p", text: "t", confidence: 90 }), { type: "thinking", problemCallId: "p", text: "t", confidence: 90 });
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p", text: "t", confidence: 55 }));
	});

	it("practice events read the last submission's confidence and carry mode + step", () => {
		const chat = { id: "c1", kind: "practice" as const, createdAt: new Date(T0).toISOString(), messages: solvedProblem(T0, { target: ["n1"], mode: "discrimination" }, {}, 30) };
		const [e] = practiceEvents(chat, new Set(["n1"]), 70);
		assert.equal(e!.grade, "hard");
		assert.equal(e!.mode, "discrimination");
		assert.equal(e!.step, "stay");
	});
});

describe("the reached mode (owner adaptation rules)", () => {
	const none = new Set<string>();
	it("climbs on clean solves, stays on shaky ones", () => {
		const l = ideaLevel([ev({ step: "up", mode: "recall" }), ev({ at: T0 + D, step: "up", mode: "discrimination" }), ev({ at: T0 + 2 * D, step: "stay", mode: "composition" })], none);
		assert.equal(l.level, 2);
		assert.equal(l.tested, true);
		assert.equal(l.toTeach, false);
	});
	it("a miss drops one mode; two in a row at Recordar → por enseñar; teaching clears it", () => {
		const base = [ev({ step: "up", mode: "discrimination" }), ev({ at: T0 + D, step: "miss", mode: "discrimination" })];
		assert.equal(ideaLevel(base, none).level, 1);
		const twice = [...base, ev({ at: T0 + 2 * D, step: "miss", mode: "recall" })];
		assert.deepEqual(ideaLevel(twice, none), { level: 0, tested: true, placed: false, toTeach: true });
		const retaught = [...twice, ev({ at: T0 + 3 * D, kind: "teach-seen" })];
		assert.equal(ideaLevel(retaught, none).toTeach, false);
	});
	it("in the placement test one miss with no level → por enseñar", () => {
		const l = ideaLevel([ev({ chatId: "place", step: "miss", mode: "recall" })], new Set(["place"]));
		assert.equal(l.placed, true);
		assert.equal(l.toTeach, true);
	});
	it("teach-seen events don't count as tested", () => {
		assert.equal(ideaLevel([ev({ kind: "teach-seen" })], none).tested, false);
	});
});

describe("recall and the deadline", () => {
	it("recallAt and intervalDays invert each other", () => {
		const days = intervalDays(10, 0.9);
		assert.ok(Math.abs(recallAt(10, 0, days * D) - 0.9) < 1e-4);
		assert.ok(Math.abs(days - 10) < 0.05, "FSRS: stability = days to 90%");
	});
	it("pulls the due earlier for a stricter exam target and forces a final-window review", () => {
		const lastReview = T0;
		const normalDue = T0 + 40 * D;
		const due = deadlineDue({ due: normalDue, stability: 30, lastReview, targetRetention: 0.9, deadline: { examDate: "2026-11-30", recall: 0.95, finalWindowDays: 3 } });
		assert.ok(due < normalDue);
		assert.ok(due <= new Date(2026, 10, 27, 4).getTime(), "inside or before the final window");
	});
	it("a review already inside the final window keeps its due", () => {
		const lastReview = new Date(2026, 10, 28, 10).getTime();
		const due = deadlineDue({ due: lastReview + 20 * D, stability: 60, lastReview, targetRetention: 0.9, deadline: { examDate: "2026-11-30", recall: 0.8, finalWindowDays: 3 } });
		assert.equal(due, lastReview + 20 * D);
	});
});

describe("computeReview with exams", () => {
	const nodes = [
		{ id: "n1", name: "Uno", provenance: [{ chatId: "src_a", messageId: "x" }] },
		{ id: "n2", name: "Dos", provenance: [{ chatId: "src_a", messageId: "x" }] },
		{ id: "n3", name: "Tres", provenance: [{ chatId: "src_a", messageId: "x" }] },
	] as unknown as ReviewInput["nodes"];
	const practice = { id: "c1", kind: "practice" as const, createdAt: new Date(T0 - 30 * D).toISOString(), messages: solvedProblem(T0 - 30 * D, { target: ["n1"] }, {}, 90) };
	const input = (exams?: ReviewInput["exams"]): ReviewInput => ({
		now: T0,
		nodes,
		chats: [practice],
		sourcePaths: { src_a: "Física/Notas/a.md" },
		sources: { ...emptyReviewSources(T0 - 60 * D) },
		intake: [],
		settings: { targetRetention: 0.9, newPerDay: 15, confidenceThreshold: 70 },
		exams,
	});
	it("enrolls exam ideas, holds ungraded ones out of review and the cap, and applies the exam due", () => {
		const model = computeReview(input({ nodeIds: new Set(["n1", "n2"]), due: () => T0 - H }));
		const byId = new Map(model.items.map((i) => [i.nodeId, i]));
		assert.ok(byId.has("n2"), "ungraded exam idea is enrolled");
		assert.equal(byId.get("n2")!.released, false, "held for the placement test");
		assert.equal(byId.has("n3"), false, "outside the exam and inactive areas → not enrolled");
		assert.equal(byId.get("n1")!.released, true);
		assert.equal(byId.get("n1")!.due, T0 - H, "the exam's due wins");
		assert.equal(model.newIntake.length, 0, "exam ideas never use the shared cap");
	});
});

describe("syllabus probes and status", () => {
	it("pointProbes: last clean conclude of a syllabusPoint problem decides", () => {
		const chats: ExamChat[] = [
			{
				id: "place1",
				kind: "practice",
				createdAt: new Date(T0).toISOString(),
				exam: { id: "exam_test_1", kind: "placement" },
				messages: [...solvedProblem(T0, { syllabusPoint: "pt2" }, { outcome: "surrendered" }), ...solvedProblem(T0 + H, { syllabusPoint: "pt9" }, {}, 90)],
			},
		];
		const probes = pointProbes(chats, "exam_test_1", 70);
		assert.equal(probes.get("pt2"), "unknown");
		assert.equal(probes.get("pt9"), "known");
		assert.equal(pointProbes(chats, "other", 70).size, 0);
	});

	const item = (nodeId: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
		nodeId,
		name: nodeId,
		group: { kind: "area", id: "a" },
		state: "review",
		stability: 60,
		difficulty: 5,
		retrievability: 0.95,
		due: T0 + 30 * D,
		lastReview: T0 - D,
		reps: 3,
		lapses: 0,
		paused: false,
		released: true,
		events: [],
		...over,
	});

	it("per-point coverage: a point weighs the same however many ideas it has; taught gap points join", () => {
		const items = new Map([
			["n1", item("n1", { events: [ev({ nodeId: "n1", chatId: "place1", step: "up", mode: "discrimination" })] })],
			["n2", item("n2", { events: [ev({ nodeId: "n2", chatId: "place1", step: "up", mode: "recall" })] })],
			["n4", item("n4", { events: [ev({ nodeId: "n4", chatId: "teach1", kind: "teach-check", step: "up", mode: "recall" })] })],
		]);
		const chats: ExamChat[] = [
			{ id: "place1", kind: "practice", createdAt: new Date(T0).toISOString(), exam: { id: "exam_test_1", kind: "placement" }, messages: [] },
			{ id: "teach1", kind: "teach", createdAt: new Date(T0).toISOString(), exam: { id: "exam_test_1", kind: "teach", pointId: "pt2" }, messages: [] },
		];
		const status = computeExamStatus({
			exam: exam(),
			now: T0,
			items,
			names: new Map(),
			chats,
			nodesBornIn: new Map([["teach1", ["n4"]]]),
			confidenceThreshold: 70,
			dueEnd: T0 + D,
		});
		const pt1 = status.points.find((p) => p.id === "pt1")!;
		const pt2 = status.points.find((p) => p.id === "pt2")!;
		assert.equal(pt1.score, 0.5, "n1 at Discriminar meets Notable, n2 at Recordar doesn't");
		assert.deepEqual(pt2.nodeIds, ["n4"]);
		assert.equal(pt2.need, "practice");
		assert.equal(status.coverage, 0.25);
		assert.equal(status.reachedPreset, "pass", "both points fully meet Aprobado");
		assert.equal(status.placement.done, true, "the taught gap point no longer needs probing; n1, n2 placed");
		const ideas = new Map(status.ideas.map((i) => [i.nodeId, i]));
		assert.equal(coverageWith(status.points, ideas, { mode: "recall", recall: 0.8 }), 1);
	});
});

describe("work, budget and today's blocks", () => {
	const status = {
		points: [
			{ id: "pt1", blockId: "b1", text: "a", nodeIds: ["n1"], gap: false, probe: null, taughtSession: false, score: 0, need: "practice" as const },
			{ id: "pt2", blockId: "b2", text: "b", nodeIds: [], gap: true, probe: "known" as const, taughtSession: false, score: 0, need: "consolidate" as const },
		],
		ideas: [{ nodeId: "n1", name: "n1", pointIds: ["pt1"], level: 1 as const, tested: true, placed: true, toTeach: false, recallAtExam: 0.9, meets: false, dueToday: true }],
		placement: { pendingIdeas: [], pendingPoints: [], done: true },
	};
	const durations = { teach: 25, consolidate: 10, problem: 6, review: 2 };
	it("examWork counts only the points needed for the coverage, priorities first", () => {
		const base = { status, examDate: "2026-11-30", now: T0, durations, finalWindowDays: 3, items: new Map() };
		const half = examWork({ ...base, standard: { mode: "discrimination", recall: 0.9, coverage: 0.5 }, priorityBlocks: [] });
		const all = examWork({ ...base, standard: { mode: "discrimination", recall: 0.9, coverage: 1 }, priorityBlocks: [] });
		assert.ok(half.total < all.total);
		const prioritized = examWork({ ...base, standard: { mode: "discrimination", recall: 0.9, coverage: 0.5 }, priorityBlocks: ["b2"] });
		assert.ok(prioritized.teach > 0, "the prioritized gap point is picked first");
		assert.equal(half.teach, 0);
	});
	it("planBudget: earliest deadline first over one weekly budget", () => {
		const plan = planBudget({
			today: "2026-11-02",
			weeklyMinutes: [60, 60, 60, 60, 60, 0, 0],
			exams: [
				{ examId: "late", examDate: "2026-11-20", work: 120 },
				{ examId: "soon", examDate: "2026-11-05", work: 150 },
			],
		});
		assert.deepEqual(plan.allocations.soon!.slice(0, 3), [60, 60, 30]);
		assert.deepEqual(plan.allocations.late!.slice(0, 4), [0, 0, 30, 60]);
		assert.equal(plan.shortfall.soon, 0);
		assert.equal(plan.studyDays.soon, 3);
		const tight = planBudget({ today: "2026-11-02", weeklyMinutes: [10, 10, 10, 10, 10, 10, 10], exams: [{ examId: "e", examDate: "2026-11-04", work: 50 }] });
		assert.equal(tight.shortfall.e, 30);
		assert.deepEqual(infeasibility({ shortfall: 30, daysLeft: 2, allocated: 20, presetWork: { pass: 15, merit: 40, distinction: 90 } }), { shortfall: 30, extraPerDay: 15, bestPreset: "pass" });
	});
	it("planBudget spreads review work over the study days instead of front-loading it", () => {
		const plan = planBudget({ today: "2026-11-02", weeklyMinutes: [60, 60, 60, 60, 60, 60, 60], exams: [{ examId: "e", examDate: "2026-11-12", work: 100, spread: 50 }] });
		const days = plan.allocations.e!;
		assert.equal(days.reduce((s, x) => s + x, 0), 100);
		assert.ok(days.every((x) => x > 0), "every study day before the exam keeps a review share");
		assert.ok(Math.abs(days[9]! - 5) < 1e-9, "the last day carries only its review share");
		assert.equal(plan.shortfall.e, 0);
	});
	it("today's blocks: review, then practice, then teach one point", () => {
		const blocks = todayBlocks({ status, standard: { mode: "discrimination" }, minutes: 60, durations, priorityBlocks: [] });
		assert.deepEqual(blocks.map((b) => b.kind), ["review", "practice", "teach"]);
		assert.equal(blocks[2]!.pointId, "pt2");
		assert.equal(blocks[2]!.short, true);
		const pending = { ...status, placement: { pendingIdeas: ["n1"], pendingPoints: [], done: false } };
		assert.equal(todayBlocks({ status: pending, standard: { mode: "recall" }, minutes: 60, durations, priorityBlocks: [] })[1]!.kind, "placement");
	});
});

describe("durations, days, records, settings", () => {
	it("activeMinutes caps long pauses", () => {
		const m = (t: number) => ({ id: `x${t}`, role: "user", content: "x", timestamp: t }) as unknown as NpMessage;
		assert.equal(activeMinutes([m(0), m(60_000), m(60_000 + 60 * 60_000)]), 6);
	});
	it("measureDurations needs 3 samples per kind", () => {
		const chats: ExamChat[] = [0, 1, 2].map((i) => ({ id: `c${i}`, kind: "practice" as const, createdAt: new Date(T0 + i).toISOString(), messages: solvedProblem(T0, { target: ["n1"] }, {}, 90) }));
		const measured = measureDurations(chats);
		assert.equal(measured.problem, 2);
		assert.equal(measured.teach, null);
	});
	it("day helpers", () => {
		assert.equal(addDays("2026-11-30", 1), "2026-12-01");
		assert.equal(weekdayIndex("2026-11-02"), 0);
		assert.equal(weekdayIndex("2026-11-08"), 6);
		assert.equal(new Date(examMoment("2026-11-30")).getHours(), 9);
	});
	it("sanitizeExamRecord round-trips, clamps and refuses newer versions", () => {
		const e = exam();
		assert.deepEqual(sanitizeExamRecord(JSON.parse(JSON.stringify(e))), e);
		assert.equal(sanitizeExamRecord({ ...e, examDate: "30/11" }), null);
		assert.equal(sanitizeExamRecord({ ...e, standard: { ...e.standard, recall: 2 } })!.standard.recall, 0.99);
		assert.throws(() => sanitizeExamRecord({ ...e, version: 3 }));
	});
	it("exams settings: factory, sanitizer, strict body", () => {
		const resolved = resolveSettings(sanitizeUserSettings({ version: 1, exams: { weeklyMinutes: [1, 2, 3], problemMinutes: 9 } }));
		assert.deepEqual(resolved.exams.weeklyMinutes, [45, 45, 45, 45, 45, 90, 0]);
		assert.equal(resolved.exams.problemMinutes, 9);
		assert.equal(parseExamSettingsBody({ weeklyMinutes: [0, 0, 0, 0, 0, 0, 721] }).ok, false);
		assert.equal(parseExamSettingsBody({ finalWindowDays: 0 }).ok, false);
		assert.deepEqual(parseExamSettingsBody({ weeklyMinutes: [30, 30, 30, 30, 30, 60, 0], teachMinutes: 30 }), { ok: true, settings: { weeklyMinutes: [30, 30, 30, 30, 30, 60, 0], teachMinutes: 30 } });
	});
});

describe("syllabus folders (owner 2026-11-06: any folder, recursive)", () => {
	it("knowledgeFolders: every ancestor folder, recursive counts, root notes skipped", () => {
		const folders = knowledgeFolders(["A/B/x.md", "A/B/C/y.md", "A/z.md", "root.md", "D\\w.md"]);
		assert.deepEqual(folders, [
			{ path: "A", count: 3 },
			{ path: "A/B", count: 2 },
			{ path: "A/B/C", count: 1 },
			{ path: "D", count: 1 },
		]);
	});
	it("reduceFolders drops duplicates and folders under a selected one", () => {
		assert.deepEqual(reduceFolders(["A/B/C", "A/B", "A/B", "AB", "", "D/"]), ["A/B", "AB", "D"]);
	});
	it("isInFolder matches whole segments at any depth", () => {
		assert.ok(isInFolder("A/B/C/y.md", "A/B"));
		assert.ok(!isInFolder("A/BC/y.md", "A/B"));
		assert.ok(isInFolder("A\\B\\y.md", "A/B"));
	});
	it("legacy drafts: areas «area:X/Y» read back as folders, root area dropped", () => {
		const legacy = { ...exam(), syllabus: { text: "", fileName: null, areas: ["area:002 - ÁREAS/011. INFORMÁTICA", "area:/"] } };
		assert.deepEqual(sanitizeExamRecord(legacy)!.syllabus.folders, ["002 - ÁREAS/011. INFORMÁTICA"]);
	});
});

describe("folder selection v2 (owner 2026-11-06: tri-state, any depth)", () => {
	const all = ["A", "A/B", "A/B/C", "A/D", "E"];
	it("a click on a folder sets its whole subtree; a click on a full one clears it", () => {
		let flags = toggleFolder("A", new Set(), all);
		assert.deepEqual([...flags].sort(), ["A", "A/B", "A/B/C", "A/D"]);
		assert.equal(folderCheck("A", flags, all), "on");
		flags = toggleFolder("A/B/C", flags, all);
		assert.equal(folderCheck("A/B/C", flags, all), "off");
		assert.equal(folderCheck("A/B", flags, all), "partial");
		assert.equal(folderCheck("A", flags, all), "partial");
		flags = toggleFolder("A", flags, all); // partial → all on
		assert.equal(folderCheck("A", flags, all), "on");
		flags = toggleFolder("A", flags, all);
		assert.equal(flags.size, 0);
	});
	it("selectionScope: highest full folders recursive, the rest loose notes only", () => {
		let flags = toggleFolder("A", new Set(), all);
		flags = toggleFolder("A/B/C", flags, all);
		assert.deepEqual(selectionScope(flags, all), { folders: ["A/D"], directFolders: ["A", "A/B"] });
		assert.deepEqual(selectionScope(toggleFolder("E", new Set(), all), all), { folders: ["E"], directFolders: [] });
	});
	it("inExamScope: recursive folders at any depth, partial folders' loose notes only", () => {
		const scope = { folders: ["A/D"], directFolders: ["A"] };
		assert.ok(inExamScope("A/D/x/y.md", scope));
		assert.ok(inExamScope("A/z.md", scope));
		assert.ok(!inExamScope("A/B/w.md", scope));
		assert.ok(!inExamScope("E/v.md", scope));
	});
	it("foldersToRead: unread recursive folders + partial folders with unread loose notes, minus watched", () => {
		const info = (path: string, unread: number, directUnread = 0) => ({ path, ideas: 0, notes: unread, unread, direct: directUnread, directUnread });
		const infos = [info("A", 9, 2), info("A/B", 3), info("A/D", 4), info("E", 1), info("W", 5)];
		assert.deepEqual(foldersToRead({ folders: ["A/D", "W"], directFolders: ["A"] }, infos, ["W"]), ["A"]);
		assert.deepEqual(foldersToRead({ folders: ["A/D"], directFolders: ["A/B"] }, infos, []), ["A/D"]);
	});
	it("context and materials sanitize strictly", () => {
		assert.deepEqual(sanitizeContext({ kind: "school", name: " PAU ", sitting: "2027", junk: 1 }), { ...EMPTY_EXAM_CONTEXT, kind: "school", name: "PAU", sitting: "2027" });
		assert.equal(sanitizeContext({ kind: "nope" }).kind, null);
		const at = new Date(T0).toISOString();
		assert.deepEqual(
			sanitizeMaterials([
				{ id: "m1", kind: "file", name: "Tema 1.pdf", file: "m_x.pdf", addedAt: at },
				{ id: "m2", kind: "file", name: "evil", file: "../x", addedAt: at },
				{ id: "m3", kind: "link", name: "Guía", url: "https://example.org/g", addedAt: at },
				{ id: "m4", kind: "link", name: "js", url: "javascript:alert(1)", addedAt: at },
			]).map((m) => m.id),
			["m1", "m3"],
		);
	});
	it("records: v1 files read back with an empty context, no materials, no loose-note folders", () => {
		const legacy = { ...exam(), version: 1, context: undefined, materials: undefined, syllabus: { text: "x", fileName: null, folders: ["A"] } };
		const read = sanitizeExamRecord(legacy)!;
		assert.equal(read.version, 2);
		assert.deepEqual(read.context, EMPTY_EXAM_CONTEXT);
		assert.deepEqual(read.materials, []);
		assert.deepEqual(read.syllabus.directFolders, []);
	});
});

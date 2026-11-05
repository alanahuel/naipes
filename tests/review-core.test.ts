/** Spaced review core («Repaso», owner 2026-11-04): src/core/review.ts.
 *  Synthetic records only — no data dir, no network, no clock. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeReview,
	daysBetween,
	dueToday,
	emptyReviewSources,
	forecast,
	gradeFromCheck,
	gradeFromConclude,
	lastCheckByStep,
	meanRetention,
	planIntake,
	practiceEvents,
	reviewDay,
	reviewDayEnd,
	sanitizeReviewSources,
	stepsByMessage,
	teachEvents,
	type ReviewChat,
	type ReviewInput,
	type ReviewSources,
} from "../src/core/review.ts";
import type { NpMessage } from "../src/core/native-messages.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";

// ─── record builders ────────────────────────────────────────────────────────

const T0 = new Date(2026, 9, 1, 10, 0, 0).getTime(); // 2026-10-01 10:00 local
const H = 3_600_000;
const D = 24 * H;

let seq = 0;
const text = (id: string, at: number, role: "user" | "assistant" = "assistant"): NpMessage =>
	(role === "user"
		? { id, role: "user", content: "x", timestamp: at }
		: { id, role: "assistant", content: [{ type: "text", text: "x" }], timestamp: at }) as unknown as NpMessage;
const call = (id: string, at: number, name: string, args: Record<string, unknown>, callId = `c${++seq}`): NpMessage =>
	({ id, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: at }) as unknown as NpMessage;
const result = (id: string, at: number, callId: string, name: string, details: unknown, isError = false): NpMessage =>
	({ id, role: "toolResult", toolCallId: callId, toolName: name, content: [], details, isError, timestamp: at }) as unknown as NpMessage;
const quiz = (id: string, at: number, nodeId: string, callId: string, type = "check") => call(id, at, "quiz", { nodeId, type }, callId);
const answer = (id: string, at: number, callId: string, over: Record<string, unknown> = {}) =>
	result(id, at, callId, "quiz", { kind: "quiz", questionType: "check", correct: true, confidence: 90, dontKnow: false, answers: [], questionText: "q", answeredAt: new Date(at).toISOString(), ...over });

/** A teach session: m1 m2 [quiz s1] a1 m3 [quiz s2] a2 m4 */
function teachSession(id = "chat_t", over: { a1?: Record<string, unknown>; a2?: Record<string, unknown> } = {}): ReviewChat {
	return {
		id,
		kind: "teach",
		createdAt: new Date(T0).toISOString(),
		messages: [
			text("m0", T0, "user"), // probe phase (before teaching)
			text("m1", T0 + 1 * 60_000),
			quiz("q1", T0 + 2 * 60_000, "s1", "k1"),
			answer("a1", T0 + 3 * 60_000, "k1", over.a1),
			text("m3", T0 + 4 * 60_000),
			quiz("q2", T0 + 5 * 60_000, "s2", "k2"),
			answer("a2", T0 + 6 * 60_000, "k2", over.a2),
			text("m4", T0 + 7 * 60_000),
		],
	};
}

const node = (id: string, provenance: Array<[string, string]>, name = id) => ({
	id,
	name,
	provenance: provenance.map(([chatId, messageId]) => ({ chatId, messageId })),
});

const settings = { targetRetention: 0.9, newPerDay: 15, confidenceThreshold: 70 };
const sourcesAt = (ms: number, over: Partial<ReviewSources> = {}): ReviewSources => ({ ...emptyReviewSources(ms), ...over });
const input = (over: Partial<ReviewInput>): ReviewInput => ({
	now: T0 + 2 * D,
	nodes: [],
	chats: [],
	sourcePaths: {},
	sources: sourcesAt(T0 - D),
	intake: [],
	settings,
	...over,
});

// ─── grades ─────────────────────────────────────────────────────────────────

describe("grade tables (owner 2026-11-04)", () => {
	it("teach checks: confidence threshold, wrong, don't know, dismissed", () => {
		assert.equal(gradeFromCheck({ correct: true, confidence: 70, dontKnow: false }, 70), "good");
		assert.equal(gradeFromCheck({ correct: true, confidence: 69, dontKnow: false }, 70), "hard");
		assert.equal(gradeFromCheck({ correct: true, dontKnow: false }, 70), "good"); // old records: no confidence
		assert.equal(gradeFromCheck({ correct: false, confidence: 95, dontKnow: false }, 70), "again");
		assert.equal(gradeFromCheck({ dontKnow: true }, 70), "again");
		assert.equal(gradeFromCheck({ correct: true, confidence: 90, dontKnow: false, dismissed: true }, 70), null);
	});
	it("practice concludes: modes, hint rungs, ignored outcomes", () => {
		assert.equal(gradeFromConclude("solved", null, "recall"), "good");
		assert.equal(gradeFromConclude("solved", "R0", "composition"), "easy");
		assert.equal(gradeFromConclude("solved", null, "discrimination"), "easy");
		assert.equal(gradeFromConclude("solvedWithHints", "R1", "recall"), "hard");
		assert.equal(gradeFromConclude("solvedWithHints", "R2", "composition"), "hard");
		assert.equal(gradeFromConclude("solvedWithHints", "R3", "recall"), "again");
		assert.equal(gradeFromConclude("solvedWithHints", "R5", "recall"), "again");
		assert.equal(gradeFromConclude("surrendered", null, "recall"), "again");
		assert.equal(gradeFromConclude("movedOn", null, "recall"), null);
		assert.equal(gradeFromConclude("dismissed", null, "recall"), null);
	});
});

// ─── teach mapping ──────────────────────────────────────────────────────────

describe("message → plan step (each message belongs to the NEXT tagged quiz)", () => {
	it("lookahead, trailing messages to the last step, nothing before teaching", () => {
		const steps = stepsByMessage(teachSession().messages);
		assert.equal(steps.get("m0"), undefined);
		assert.equal(steps.get("m1"), undefined); // before the first tagged call: plan/probe phase
		assert.equal(steps.get("q1"), "s1");
		assert.equal(steps.get("a1"), "s2");
		assert.equal(steps.get("m3"), "s2");
		assert.equal(steps.get("q2"), "s2");
		assert.equal(steps.get("a2"), "s2");
		assert.equal(steps.get("m4"), "s2");
	});
	it("no tagged quiz → no steps", () => {
		assert.equal(stepsByMessage([text("m1", T0), call("p", T0, "probe", {})]).size, 0);
	});
	it("each step keeps its LAST check; predictions never count", () => {
		const messages = [
			quiz("q1", T0, "s1", "k1"),
			answer("a1", T0 + 1000, "k1", { correct: false }),
			quiz("q1b", T0 + 2000, "s1", "k1b"),
			answer("a1b", T0 + 3000, "k1b", { correct: true, confidence: 40 }),
			quiz("q2", T0 + 4000, "s2", "k2", "predict"),
			answer("a2", T0 + 5000, "k2", { questionType: "predict", correct: false }),
		];
		const checks = lastCheckByStep(messages, 70);
		assert.deepEqual(checks.get("s1"), { grade: "hard", at: T0 + 3000 });
		assert.equal(checks.has("s2"), false);
	});
});

describe("teach events", () => {
	it("an idea in a checked step takes the check; an idea no check covers is «seen» = Good at its message time", () => {
		const chat = teachSession("chat_t", { a2: { correct: false } });
		const byMessage = new Map([
			["m3", ["n_step2"]],
			["m0", ["n_probe"]],
		]);
		const events = teachEvents(chat, byMessage, 70);
		assert.deepEqual(events.find((e) => e.nodeId === "n_step2"), { nodeId: "n_step2", at: T0 + 6 * 60_000, grade: "again", kind: "teach-check", chatId: "chat_t", mode: "recall", step: "miss" });
		assert.deepEqual(events.find((e) => e.nodeId === "n_probe"), { nodeId: "n_probe", at: T0, grade: "good", kind: "teach-seen", chatId: "chat_t" });
	});
	it("an idea spanning two checked steps gets both checks", () => {
		const events = teachEvents(teachSession(), new Map([["q1", ["n"]], ["m3", ["n"]]]), 70);
		assert.equal(events.filter((e) => e.nodeId === "n" && e.kind === "teach-check").length, 2);
	});
});

describe("practice events", () => {
	const practice = (concludeArgs: Record<string, unknown>, problemArgs: Record<string, unknown>, refused = false): ReviewChat => ({
		id: "chat_p",
		kind: "practice",
		createdAt: new Date(T0).toISOString(),
		messages: [
			call("p1", T0, "problem", { statement: "s", modelSolution: "m", ...problemArgs }, "pc"),
			result("p1r", T0 + 1, "pc", "problem", {}),
			call("c1", T0 + 2 * 60_000, "conclude", concludeArgs, "cc"),
			result("c1r", T0 + 3 * 60_000, "cc", "conclude", {}, refused),
		],
	});
	it("every known target gets the grade at the conclude result's time", () => {
		const events = practiceEvents(practice({ outcome: "solved", rung: null }, { mode: "composition", target: ["n_a", "n_b", "n_gone"] }), new Set(["n_a", "n_b"]));
		assert.deepEqual(events.map((e) => [e.nodeId, e.grade, e.at]), [["n_a", "easy", T0 + 3 * 60_000], ["n_b", "easy", T0 + 3 * 60_000]]);
	});
	it("refused concludes, untagged problems and movedOn count for nothing", () => {
		const known = new Set(["n_a"]);
		assert.equal(practiceEvents(practice({ outcome: "solved" }, { mode: "recall", target: ["n_a"] }, true), known).length, 0);
		assert.equal(practiceEvents(practice({ outcome: "solved" }, { mode: "recall" }), known).length, 0);
		assert.equal(practiceEvents(practice({ outcome: "movedOn" }, { mode: "recall", target: ["n_a"] }), known).length, 0);
	});
});

// ─── days ───────────────────────────────────────────────────────────────────

describe("review days roll over at 04:00 local", () => {
	it("03:59 still belongs to yesterday, 04:00 to today", () => {
		assert.equal(reviewDay(new Date(2026, 10, 4, 3, 59).getTime()), "2026-11-03");
		assert.equal(reviewDay(new Date(2026, 10, 4, 4, 0).getTime()), "2026-11-04");
		assert.equal(reviewDayEnd(new Date(2026, 10, 4, 12).getTime()), new Date(2026, 10, 5, 4).getTime());
		assert.equal(daysBetween("2026-10-30", "2026-11-02"), 3);
	});
});

// ─── intake ─────────────────────────────────────────────────────────────────

describe("the shared daily intake (backlog first, most forgotten first)", () => {
	it("fills the cap with backlog before new ideas, counting today's earlier releases", () => {
		const out = planIntake({
			today: "2026-11-04",
			existing: [{ nodeId: "old", day: "2026-11-04", reason: "backlog" }, { nodeId: "y", day: "2026-11-03", reason: "new" }],
			backlog: [{ nodeId: "b2", retrievability: 0.6 }, { nodeId: "b1", retrievability: 0.2 }, { nodeId: "old", retrievability: 0.1 }],
			fresh: ["y", "f1", "f2"],
			cap: 4,
		});
		assert.deepEqual(out.map((l) => [l.nodeId, l.reason]), [["b1", "backlog"], ["b2", "backlog"], ["f1", "new"]]);
	});
	it("a full day releases nothing more", () => {
		assert.deepEqual(planIntake({ today: "d", existing: [{ nodeId: "a", day: "d", reason: "new" }], backlog: [], fresh: ["b"], cap: 1 }), []);
	});
});

// ─── the whole model ────────────────────────────────────────────────────────

describe("computeReview — enrollment, pauses, intake", () => {
	const teach = teachSession();
	const area = "area:002 - ÁREAS/011. FILOSOFÍA";
	const sourcePaths = { src_1: "002 - ÁREAS/011. FILOSOFÍA/Estoicismo.md", src_2: "003/Otra/Nota.md" };

	it("teach ideas enroll; inactive-area ideas don't; activated-area ideas wait for the intake", () => {
		const nodes = [node("n_teach", [["chat_t", "m3"]]), node("n_area", [["src_1", "src_1"]]), node("n_other", [["src_2", "src_2"]])];
		const before = computeReview(input({ nodes, chats: [teach], sourcePaths }));
		assert.deepEqual(before.items.map((i) => i.nodeId), ["n_teach"]);
		const after = computeReview(input({ nodes, chats: [teach], sourcePaths, sources: sourcesAt(T0 - D, { areas: [area] }) }));
		const fresh = after.items.find((i) => i.nodeId === "n_area")!;
		assert.equal(fresh.state, "new");
		assert.deepEqual(after.newIntake, [{ nodeId: "n_area", day: after.today, reason: "new" }]);
		assert.equal(fresh.released, true);
		assert.equal(fresh.group.kind, "area");
	});

	it("practicing an idea enrolls it, even from an inactive area", () => {
		const practice: ReviewChat = {
			id: "chat_p", kind: "practice", createdAt: new Date(T0).toISOString(),
			messages: [
				call("p1", T0, "problem", { mode: "recall", target: ["n_other"] }, "pc"), result("p1r", T0, "pc", "problem", {}),
				call("c1", T0 + 1000, "conclude", { outcome: "surrendered" }, "cc"), result("c1r", T0 + 1000, "cc", "conclude", {}),
			],
		};
		const model = computeReview(input({ nodes: [node("n_other", [["src_2", "src_2"]])], chats: [practice], sourcePaths }));
		const item = model.items[0]!;
		assert.equal(item.nodeId, "n_other");
		assert.equal(item.lapses + item.reps > 0, true);
		assert.equal(item.released, true);
	});

	it("pauses: by session, by area, by single idea", () => {
		const nodes = [node("n_teach", [["chat_t", "m3"]]), node("n_area", [["src_1", "src_1"]])];
		const base = { nodes, chats: [teach], sourcePaths };
		const paused = (p: Partial<ReviewSources["paused"]>) =>
			computeReview(input({ ...base, sources: sourcesAt(T0 - D, { areas: [area], paused: { sessions: [], areas: [], nodes: [], ...p } }) }));
		assert.equal(paused({ sessions: ["chat_t"] }).items.find((i) => i.nodeId === "n_teach")!.paused, true);
		const areaPaused = paused({ areas: [area] });
		assert.equal(areaPaused.items.find((i) => i.nodeId === "n_area")!.paused, true);
		assert.deepEqual(areaPaused.newIntake, []); // paused ideas never consume the cap
		assert.equal(paused({ nodes: ["n_teach"] }).items.find((i) => i.nodeId === "n_teach")!.paused, true);
	});

	it("history overdue at activation is released gradually, most forgotten first; new history is not capped", () => {
		// 3 ideas seen 60 days before activation → all overdue at activation.
		const old: ReviewChat = { ...teachSession("chat_old"), messages: teachSession("chat_old").messages.map((m) => ({ ...m, timestamp: (m as { timestamp: number }).timestamp - 60 * D })) as NpMessage[] };
		for (const m of old.messages) {
			const d = (m as { details?: { answeredAt?: string } }).details;
			if (d?.answeredAt) d.answeredAt = new Date(Date.parse(d.answeredAt) - 60 * D).toISOString();
		}
		const nodes = [node("n1", [["chat_old", "m0"]]), node("n2", [["chat_old", "m3"]]), node("n3", [["chat_old", "m4"]]), node("n_new", [["chat_t", "m3"]])];
		const now = T0 + 2 * D;
		const first = computeReview(input({ now, nodes, chats: [old, teach], settings: { ...settings, newPerDay: 2 }, sources: sourcesAt(T0 - D) }));
		assert.equal(first.newIntake.length, 2);
		assert.ok(first.newIntake.every((l) => l.reason === "backlog"));
		const waiting = first.items.filter((i) => !i.released).map((i) => i.nodeId);
		assert.equal(waiting.length, 1);
		assert.equal(first.items.find((i) => i.nodeId === "n_new")!.released, true); // after activation: uncapped
		// Next day the last one comes out.
		const second = computeReview(input({ now: now + D, nodes, chats: [old, teach], settings: { ...settings, newPerDay: 2 }, sources: sourcesAt(T0 - D), intake: first.newIntake }));
		assert.deepEqual(second.newIntake.map((l) => l.nodeId), waiting);
		assert.ok(second.items.every((i) => i.released));
	});

	it("is deterministic for the same input (fuzz included)", () => {
		const nodes = [node("n_teach", [["chat_t", "m3"]]), node("n_probe", [["chat_t", "m0"]])];
		const a = computeReview(input({ nodes, chats: [teach] }));
		const b = computeReview(input({ nodes, chats: [teach] }));
		assert.deepEqual(a, b);
	});

	it("aggregates: due today, mean retention, forecast", () => {
		const nodes = [node("n_teach", [["chat_t", "m3"]]), node("n_probe", [["chat_t", "m0"]])];
		const now = T0 + 30 * D;
		const model = computeReview(input({ now, nodes, chats: [teach] }));
		assert.equal(dueToday(model.items, now).length, 2); // a month later both are overdue
		const r = meanRetention(model.items)!;
		assert.ok(r > 0 && r < 0.9);
		const f = forecast(model.items, now, 7);
		assert.equal(f[0], 2);
		assert.equal(f.reduce((s, n) => s + n, 0), 2);
	});
});

describe("sources.json sanitizer", () => {
	it("absent/corrupt → null, lists cleaned, a newer version refuses", () => {
		assert.equal(sanitizeReviewSources(null), null);
		assert.equal(sanitizeReviewSources({ version: 1 }), null);
		const s = sanitizeReviewSources({ version: 1, activatedAt: "2026-11-04T10:00:00.000Z", areas: ["a", "a", 3], paused: { nodes: ["n"] } })!;
		assert.deepEqual(s.areas, ["a"]);
		assert.deepEqual(s.paused, { sessions: [], areas: [], nodes: ["n"] });
		assert.throws(() => sanitizeReviewSources({ version: 2, activatedAt: "2026-11-04T10:00:00.000Z" }), /newer|older/);
	});
});

describe("review settings section", () => {
	it("factory values fill gaps; stored values clamp", () => {
		assert.deepEqual(resolveSettings(sanitizeUserSettings({ version: 1 })).review, {
			targetRetention: 0.9, digestTime: "09:00", eveningTime: "19:00", newPerDay: 15, batchSize: 10, confidenceThreshold: 70,
		});
		const s = sanitizeUserSettings({ version: 1, review: { targetRetention: 0.99, digestTime: "7:30", eveningTime: "25:00", newPerDay: -3, batchSize: 10.6, confidenceThreshold: 150 } })!;
		assert.deepEqual(s.review, { targetRetention: 0.97, digestTime: "07:30", newPerDay: 0, batchSize: 11, confidenceThreshold: 100 });
	});
});

// ─── stage 2: batches and notice rules ──────────────────────────────────────

import { selectBatch, shouldSendNotice, type ReviewItem } from "../src/core/review.ts";

const item = (nodeId: string, group: string, retrievability: number | null): ReviewItem => ({
	nodeId, name: nodeId, group: { kind: "session", id: group }, state: retrievability === null ? "new" : "review",
	stability: null, difficulty: null, retrievability, due: 0, lastReview: null, reps: 0, lapses: 0, paused: false, released: true, events: [],
});

describe("selectBatch — most forgotten first, alternating topics", () => {
	it("round-robins groups ordered by their most forgotten idea; new ideas last; capped", () => {
		const due = [item("a1", "A", 0.5), item("a2", "A", 0.1), item("a3", "A", 0.3), item("b1", "B", 0.2), item("b2", "B", 0.9), item("c1", "C", null)];
		assert.deepEqual(selectBatch(due, 10).map((i) => i.nodeId), ["a2", "b1", "c1", "a3", "b2", "a1"]);
		assert.deepEqual(selectBatch(due, 3).map((i) => i.nodeId), ["a2", "b1", "c1"]);
		assert.deepEqual(selectBatch([], 10), []);
	});
});

describe("shouldSendNotice — the owner's notice rules", () => {
	const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).getTime();
	const base = { digestTime: "09:00", eveningTime: "19:00", dueCount: 5, sent: [], reviewStartedToday: false };
	it("digest: from its time until the evening one (a missed one goes out at startup), never with nothing due", () => {
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(8, 59) }), false);
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(9) }), true);
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(14) }), true);
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(19) }), false);
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(9), dueCount: 0 }), false);
	});
	it("once per review day", () => {
		const sent = [{ day: "2026-11-04", kind: "digest" as const, at: "x", count: 5 }];
		assert.equal(shouldSendNotice({ ...base, kind: "digest", now: at(10), sent }), false);
		assert.equal(shouldSendNotice({ ...base, kind: "evening", now: at(20), sent }), true);
	});
	it("evening: only if nothing was started today; never before 04:00 (still yesterday)", () => {
		assert.equal(shouldSendNotice({ ...base, kind: "evening", now: at(18, 59) }), false);
		assert.equal(shouldSendNotice({ ...base, kind: "evening", now: at(19) }), true);
		assert.equal(shouldSendNotice({ ...base, kind: "evening", now: at(23), reviewStartedToday: true }), false);
		assert.equal(shouldSendNotice({ ...base, kind: "evening", now: new Date(2026, 10, 5, 2).getTime() }), false);
	});
});

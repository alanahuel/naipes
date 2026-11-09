/** «Memoria en el sondeo» (owner, 2026-11-09): the teach probe reads the
 *  learner's memory per idea and its tagged answers count for it.
 *  Synthetic records only — no data dir, no network. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createProberTools, probeQuizTool } from "../src/agent/tools.ts";
import { proberGraphTools } from "../src/agent/tools/graph.ts";
import { ideaMemories, memoryLine, type IdeaMemory } from "../src/core/idea-memory.ts";
import { probeModeOf, probeTargetsOf } from "../src/core/question-core.ts";
import { computeReview, emptyReviewSources, probeEvents, type ReviewChat, type ReviewItem } from "../src/core/review.ts";
import type { NpMessage } from "../src/core/native-messages.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";

// ─── fixtures ────────────────────────────────────────────────────────────────

const T0 = new Date(2026, 9, 1, 10, 0, 0).getTime();
const D = 24 * 3_600_000;

const gnode = (id: string, name: string, chatId = "c1", over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must never leak into the probe's view
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId, messageId: "m1" }],
	...over,
});

function fakeStores(nodes: GraphNode[]): { chatStore: ChatStore; graphStore: GraphStore } {
	const graphStore = {
		readNodes: () => nodes,
		readChains: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
	} as unknown as GraphStore;
	const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
	return { chatStore, graphStore };
}

const baseCtx = {
	chatId: "c-new",
	deliver: () => {},
	jobStore: { createJob: () => ({}), getJob: () => undefined, listJobs: () => [], updateJob: () => {} } as unknown as JobStore,
	spawn: () => {},
};

const memory = (over: Partial<IdeaMemory> = {}): IdeaMemory => ({
	retrievability: 0.82,
	level: 2,
	toTeach: false,
	lastReview: new Date(2026, 9, 30, 12).getTime(),
	lapses: 1,
	...over,
});

const quizArgs = {
	question: "Which?",
	options: [
		{ label: "A", value: "a" },
		{ label: "B", value: "b" },
	],
	explanation: "Because.",
	correctAnswer: "a",
};

const detailsOf = (r: { details?: unknown }) => r.details as string;
const isInvalid = (r: { content: Array<{ type: string; text?: string }> }) => (r.content[0]?.text ?? "").startsWith("Invalid tool input");
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? "";

// ─── the memory line ─────────────────────────────────────────────────────────

describe("memoryLine", () => {
	it("recall, reached mode, last day, lapses — the agent-facing line", () => {
		assert.equal(memoryLine(memory()), "recall 82% · reached discrimination · last 2026-10-30 · lapses 1");
	});
	it("the «to teach» mark rides at the end", () => {
		assert.match(memoryLine(memory({ toTeach: true, level: 0 })), /reached none · .* · to teach$/);
	});
	it("no item / never graded → «no memory yet» (absent, not zero)", () => {
		assert.equal(memoryLine(undefined), "no memory yet");
		assert.equal(memoryLine(memory({ retrievability: null, lastReview: null })), "no memory yet");
	});
});

describe("ideaMemories", () => {
	it("replays the reached mode from the item's events (placement chats from every exam)", () => {
		const item = {
			nodeId: "n1",
			retrievability: 0.9,
			lastReview: T0,
			lapses: 0,
			events: [{ nodeId: "n1", at: T0, grade: "easy", kind: "practice", chatId: "p1", mode: "composition", step: "up" }],
		} as unknown as ReviewItem;
		const out = ideaMemories({ model: { today: "2026-10-01", items: [item], newIntake: [] }, chats: [] });
		assert.deepEqual(out.get("n1"), { retrievability: 0.9, level: 3, toTeach: false, lastReview: T0, lapses: 0 });
	});
});

// ─── the probe's map readers ─────────────────────────────────────────────────

describe("prober graph tools with memory", () => {
	const nodes = [gnode("n1", "Chain rule", "c1", { aliases: ["regla de la cadena"] }), gnode("n2", "Product rule", "c1"), gnode("n3", "Limits", "c2")];
	const mem = new Map([["n1", memory()]]);

	it("list_propositions carries id + memory per idea, never the statement", async () => {
		const tools = proberGraphTools({ ...fakeStores(nodes), memory: () => mem });
		const out = detailsOf(await tools.list_propositions!.execute!("tc", { session: "c1" }));
		assert.match(out, /- Chain rule — n1 · recall 82% · reached discrimination · last 2026-10-30 · lapses 1/);
		assert.match(out, /- Product rule — n2 · no memory yet/);
		assert.ok(!out.includes("statement of"));
	});

	it("without memory (practice) the readers stay exactly as before — names only, no find_ideas", async () => {
		const tools = proberGraphTools(fakeStores(nodes));
		const out = detailsOf(await tools.list_propositions!.execute!("tc", { session: "c1" }));
		assert.match(out, /^- Chain rule$/m);
		assert.ok(!out.includes("n1"));
		assert.equal("find_ideas" in tools, false);
	});

	it("find_ideas searches every session (names, statements, aliases) and answers with name + id + memory", async () => {
		const tools = proberGraphTools({ ...fakeStores(nodes), memory: () => mem });
		const byAlias = detailsOf(await tools.find_ideas!.execute!("tc", { query: "cadena" }));
		assert.match(byAlias, /1 idea\(s\) match:\n- Chain rule — n1 · recall 82%/);
		const byStatement = detailsOf(await tools.find_ideas!.execute!("tc", { query: "statement limits" }));
		assert.match(byStatement, /- Limits — n3 · no memory yet/);
		assert.ok(!byStatement.includes("statement of"));
		const none = detailsOf(await tools.find_ideas!.execute!("tc", { query: "zzz" }));
		assert.match(none, /No idea matches "zzz"/);
	});

	it("createProberTools: memory + graph → find_ideas and the tagged probe; graph alone → the plain probe", () => {
		const stores = fakeStores(nodes);
		const withMemory = createProberTools({ ...baseCtx, ...stores, memory: () => mem });
		assert.ok("find_ideas" in withMemory);
		assert.notEqual(withMemory.probe, probeQuizTool);
		assert.ok("target" in (withMemory.probe!.parameters as { properties: object }).properties);
		const plain = createProberTools({ ...baseCtx, ...stores });
		assert.equal("find_ideas" in plain, false);
		assert.equal("target" in (plain.probe!.parameters as { properties: object }).properties, false);
	});
});

// ─── the tagged probe's call boundary ────────────────────────────────────────

describe("tagged probe", () => {
	const nodes = [gnode("n1", "Chain rule")];
	const probe = createProberTools({ ...baseCtx, ...fakeStores(nodes), memory: () => new Map() }).probe!;
	const run = (args: Record<string, unknown>) => probe.execute!("tc", probe.prepareArguments ? probe.prepareArguments(args) : args);

	it("an untagged question poses as before", async () => {
		assert.ok(!isInvalid(await run(quizArgs)));
	});
	it("target + mode with a known id poses", async () => {
		assert.ok(!isInvalid(await run({ target: ["n1"], mode: "recall", ...quizArgs })));
	});
	it("an unknown id is rejected", async () => {
		const r = await run({ target: ["n9"], mode: "recall", ...quizArgs });
		assert.ok(isInvalid(r));
		assert.match(textOf(r), /"n9"\] is not a known idea/);
	});
	it("mode is required with target, and only with it", async () => {
		assert.match(textOf(await run({ target: ["n1"], ...quizArgs })), /mode is required with target/);
		assert.match(textOf(await run({ mode: "recall", ...quizArgs })), /mode goes only with target/);
	});
	it("names normalize to ids and an empty list heals away", () => {
		assert.deepEqual((probe.prepareArguments!({ target: ["Chain rule"], mode: "recall", ...quizArgs }) as { target: string[] }).target, ["n1"]);
		assert.equal("target" in (probe.prepareArguments!({ target: [], ...quizArgs }) as object), false);
	});
});

describe("probeTargetsOf / probeModeOf", () => {
	it("only the choice probe's raw target counts (free recall never)", () => {
		assert.deepEqual(probeTargetsOf("probe", { target: ["n1", "n1", 3, ""] }), ["n1"]);
		assert.deepEqual(probeTargetsOf("recall", { target: ["n1"] }), []);
		assert.deepEqual(probeTargetsOf("quiz", { target: ["n1"] }), []);
		assert.equal(probeModeOf({ mode: "composition" }), "composition");
		assert.equal(probeModeOf({ mode: "bogus" }), undefined);
	});
});

// ─── the grades ──────────────────────────────────────────────────────────────

let seq = 0;
const probeCall = (args: Record<string, unknown>, callId: string, at: number): NpMessage =>
	({ id: `q${++seq}`, role: "assistant", content: [{ type: "toolCall", id: callId, name: "probe", arguments: { ...quizArgs, ...args } }], timestamp: at }) as unknown as NpMessage;
const probeAnswer = (callId: string, at: number, over: Record<string, unknown> = {}, isError = false): NpMessage =>
	({
		id: `a${++seq}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "probe",
		content: [],
		isError,
		timestamp: at,
		details: { kind: "quiz", tool: "probe", correct: true, confidence: 90, dontKnow: false, answers: [], questionText: "q", answeredAt: new Date(at).toISOString(), ...over },
	}) as unknown as NpMessage;
const teachChat = (messages: NpMessage[], id = "c-new"): ReviewChat => ({ id, kind: "teach", createdAt: new Date(T0).toISOString(), messages });
const known = new Set(["n1", "n2"]);

describe("probeEvents", () => {
	it("clean + confident at recall → Good, up; at discrimination → Easy, up", () => {
		const ev = probeEvents(
			teachChat([
				probeCall({ target: ["n1"], mode: "recall" }, "k1", T0),
				probeAnswer("k1", T0 + 1000),
				probeCall({ target: ["n2"], mode: "discrimination" }, "k2", T0 + 2000),
				probeAnswer("k2", T0 + 3000),
			]),
			known,
		);
		assert.deepEqual(
			ev.map((e) => [e.nodeId, e.grade, e.kind, e.mode, e.step, e.at]),
			[
				["n1", "good", "probe", "recall", "up", T0 + 1000],
				["n2", "easy", "probe", "discrimination", "up", T0 + 3000],
			],
		);
	});

	it("low confidence → Hard, stay; wrong → Again, miss; «I don't know» → Again, miss", () => {
		const ev = probeEvents(
			teachChat([
				probeCall({ target: ["n1"], mode: "composition" }, "k1", T0),
				probeAnswer("k1", T0 + 1, { confidence: 40 }),
				probeCall({ target: ["n1"], mode: "recall" }, "k2", T0 + 2),
				probeAnswer("k2", T0 + 3, { correct: false }),
				probeCall({ target: ["n2"], mode: "recall" }, "k3", T0 + 4),
				probeAnswer("k3", T0 + 5, { dontKnow: true, correct: undefined }),
			]),
			known,
		);
		assert.deepEqual(ev.map((e) => [e.grade, e.step]), [["hard", "stay"], ["again", "miss"], ["again", "miss"]]);
	});

	it("never counts: untagged, dismissed, refused calls, unknown ids, missing mode", () => {
		const ev = probeEvents(
			teachChat([
				probeCall({}, "k1", T0),
				probeAnswer("k1", T0 + 1),
				probeCall({ target: ["n1"], mode: "recall" }, "k2", T0 + 2),
				probeAnswer("k2", T0 + 3, { dismissed: true }),
				probeCall({ target: ["n1"], mode: "recall" }, "k3", T0 + 4),
				probeAnswer("k3", T0 + 5, {}, true),
				probeCall({ target: ["n9"], mode: "recall" }, "k4", T0 + 6),
				probeAnswer("k4", T0 + 7),
				probeCall({ target: ["n1"] }, "k5", T0 + 8),
				probeAnswer("k5", T0 + 9),
			]),
			known,
		);
		assert.deepEqual(ev, []);
	});
});

describe("computeReview with probe answers", () => {
	const nodes = [
		{ id: "n1", name: "Chain rule", provenance: [{ chatId: "src_notes", messageId: "m1" }] }, // notes, area not active
		{ id: "n2", name: "Paused", provenance: [{ chatId: "src_notes", messageId: "m1" }] },
	];
	const chat = teachChat([
		probeCall({ target: ["n1", "n2"], mode: "recall" }, "k1", T0),
		probeAnswer("k1", T0 + 1000),
	]);
	const model = computeReview({
		now: T0 + 2 * D,
		nodes,
		chats: [chat],
		sourcePaths: { src_notes: "Matemáticas/Cálculo/derivadas.md" },
		sources: { ...emptyReviewSources(T0 - D), paused: { sessions: [], areas: [], nodes: ["n2"] } },
		intake: [],
		settings: { targetRetention: 0.9, newPerDay: 15, confidenceThreshold: 70 },
	});

	it("a probed idea outside Repaso is enrolled, graded and grouped under its area", () => {
		const item = model.items.find((i) => i.nodeId === "n1")!;
		assert.ok(item, "enrolled");
		assert.equal(item.reps, 1);
		assert.equal(item.released, true);
		assert.equal(item.paused, false);
		assert.deepEqual(item.group.kind, "area");
	});

	it("a paused idea stays paused (the answer still counts for its card)", () => {
		const item = model.items.find((i) => i.nodeId === "n2")!;
		assert.equal(item.paused, true);
		assert.equal(item.reps, 1);
	});

	it("no teach birth and no area → grouped under the probing session, never an empty id", () => {
		const m = computeReview({
			now: T0 + 2 * D,
			nodes: [{ id: "n1", name: "Chain rule", provenance: [] }],
			chats: [chat],
			sourcePaths: {},
			sources: emptyReviewSources(T0 - D),
			intake: [],
			settings: { targetRetention: 0.9, newPerDay: 15, confidenceThreshold: 70 },
		});
		assert.deepEqual(m.items[0]!.group, { kind: "session", id: "c-new" });
	});
});

// ─── the «Repaso» line ───────────────────────────────────────────────────────

describe("the «Repaso» line", () => {
	const tagged = { target: ["n1"], mode: "recall", ...quizArgs };

	it("the pending dock shows the plain tag — never the idea's name", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="probe" toolCallId="k1" input={tagged} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.match(html, /data-testid="review-tag"[^>]*>Review</);
	});

	it("an untagged probe and a free-recall question carry no tag", () => {
		const plain = renderToStaticMarkup(<QuestionDock toolName="probe" toolCallId="k1" input={quizArgs} expanded onExpand={() => {}} onSubmit={() => {}} />);
		assert.ok(!plain.includes("review-tag"));
		const recallInput = { target: ["n1"], question: "Explain", correctAnswer: "x" };
		const recall = renderToStaticMarkup(
			<QuestionDock toolName="recall" toolCallId="k1" input={recallInput} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(!recall.includes("review-tag"));
	});

	it("the answered card carries the tag (names resolve client-side after the verdict)", () => {
		const answer = { kind: "quiz", tool: "probe", correct: true, confidence: 90, dontKnow: false, answers: [{ index: 1, label: "A" }], options: [{ index: 1, label: "A" }, { index: 2, label: "B" }], correctIndices: [1], questionText: "Which?", answeredAt: new Date(T0).toISOString() };
		const html = renderToStaticMarkup(<AnsweredCard answer={answer as never} input={tagged} />);
		assert.match(html, /data-testid="review-tag"[^>]*>Review</);
		const untagged = renderToStaticMarkup(<AnsweredCard answer={answer as never} input={quizArgs} />);
		assert.ok(!untagged.includes("review-tag"));
	});
});

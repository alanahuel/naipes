/** «Repaso» service end to end (stage 2): an isolated temporary data dir
 *  (NP_DATA_DIR set before any import — each test file is its own
 *  process), synthetic chats and graph. No network, no real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-review-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { getReviewState, reviewNotice, startReviewSession, summarizeReview, updateReviewSources, parseReviewSourcesPatch, resetReviewCache } = await import("../src/server/review.ts");
const { parseReviewSettingsBody, parseDesktopSettingsBody } = await import("../src/server/settings-body.ts");

const now = new Date(2026, 10, 4, 10, 0).getTime();
const t0 = now - 20 * 86_400_000;
fs.mkdirSync(path.join(DIR, "chats"), { recursive: true });
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
const quizAnswer = (at: number) => ({ kind: "quiz", questionType: "check", correct: true, confidence: 90, dontKnow: false, answers: [], questionText: "q", answeredAt: new Date(at).toISOString() });
const chat = (id: string, title: string) => ({
	id, title, createdAt: new Date(t0).toISOString(), updatedAt: new Date(t0).toISOString(),
	messages: [
		{ id: `${id}_m1`, role: "assistant", content: [{ type: "text", text: "x" }], timestamp: t0 },
		{ id: `${id}_q1`, role: "assistant", content: [{ type: "toolCall", id: `${id}_k1`, name: "quiz", arguments: { nodeId: "s1", type: "check" } }], timestamp: t0 + 1 },
		{ id: `${id}_a1`, role: "toolResult", toolCallId: `${id}_k1`, toolName: "quiz", content: [], isError: false, timestamp: t0 + 2, details: quizAnswer(t0 + 2) },
	],
});
for (const c of [chat("chat_a", "Estoicismo"), chat("chat_b", "Física")]) fs.writeFileSync(path.join(DIR, "chats", `${c.id}.json`), JSON.stringify(c));
const nodes = [
	["n_a1", "chat_a", "chat_a_m1"], ["n_a2", "chat_a", "chat_a_a1"], ["n_b1", "chat_b", "chat_b_a1"],
	["n_src", "src_1", "src_1"],
].map(([id, chatId, messageId]) => ({ id, name: `Idea ${id}`, statement: `Statement ${id}`, aliases: [], createdAt: new Date(t0).toISOString(), provenance: [{ chatId, messageId }] }));
fs.writeFileSync(path.join(DIR, "graph", "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
fs.writeFileSync(path.join(DIR, "graph", "sources.json"), JSON.stringify({ src_1: { id: "src_1", filePath: "002 - ÁREAS/011. FILOSOFÍA/Nota.md", importedAt: new Date(t0).toISOString() } }));

describe("review service (isolated data dir)", () => {
	it("summary: labels, due groups, activatable areas", () => {
		const state = getReviewState(now);
		const summary = summarizeReview(state, now, "es");
		assert.equal(summary.dueCount, 3);
		assert.deepEqual(summary.due.map((g) => g.label).sort(), ["Estoicismo", "Física"]);
		assert.deepEqual(state.areas.map((a) => [a.id, a.label, a.count, a.active]), [["area:002 - ÁREAS/011. FILOSOFÍA", "FILOSOFÍA", 1, false]]);
		assert.equal(summary.reviewedToday, false);
	});

	it("activating an area enrolls its ideas through the intake", () => {
		const parsed = parseReviewSourcesPatch({ areas: ["area:002 - ÁREAS/011. FILOSOFÍA"] });
		assert.ok(parsed.ok);
		updateReviewSources(parsed.ok ? parsed.patch : {}, now);
		const state = getReviewState(now);
		assert.ok(state.model.items.some((i) => i.nodeId === "n_src" && i.state === "new"));
		assert.equal(parseReviewSourcesPatch({ areas: "x" }).ok, false);
		assert.equal(parseReviewSourcesPatch({ paused: { nodes: [3] } }).ok, false);
	});

	it("digest notice: wording, once a day; the evening one stops once a review starts", () => {
		const digest = reviewNotice("digest", now);
		assert.equal(digest.notify, true);
		assert.equal(digest.title, "Hoy toca repasar 4 ideas");
		assert.match(digest.body!, /^(Estoicismo \(2\)|Física \(1\)|FILOSOFÍA \(1\)).* y 1 tema más\. Pulsa para empezar\.$/);
		assert.deepEqual(reviewNotice("digest", now + 60_000), { notify: false, count: 4 });
		const started = startReviewSession(now + 2 * 60_000)!;
		assert.ok(started);
		assert.equal(started.opening, "Empecemos el repaso.");
		assert.match(started.title, /^Repaso · 4 nov/);
		assert.equal(started.nodeIds.length, 4);
		const record = JSON.parse(fs.readFileSync(path.join(DIR, "chats", `${started.id}.json`), "utf8"));
		assert.equal(record.kind, "practice");
		assert.deepEqual(record.review, { day: "2026-11-04" });
		assert.equal(record.messages[0].customType, "graph-context");
		assert.equal(record.messages[0].details.propositions.length, 4);
		resetReviewCache();
		assert.equal(reviewNotice("evening", new Date(2026, 10, 4, 19, 30).getTime()).notify, false);
	});

	it("settings sections validate strictly", () => {
		assert.deepEqual(parseReviewSettingsBody({ targetRetention: 0.85, digestTime: "8:30", newPerDay: 20 }), { ok: true, settings: { targetRetention: 0.85, digestTime: "08:30", newPerDay: 20 } });
		assert.equal(parseReviewSettingsBody({ targetRetention: 0.99 }).ok, false);
		assert.equal(parseReviewSettingsBody({ batchSize: 2.5 }).ok, false);
		assert.equal(parseReviewSettingsBody({ digestTime: "20:00", eveningTime: "19:00" }).ok, false);
		assert.deepEqual(parseDesktopSettingsBody({ tray: false }), { ok: true, settings: { tray: false } });
		assert.equal(parseDesktopSettingsBody({ autostart: "yes" }).ok, false);
	});
});

/** «Repaso» stage 3: the tab's pure pieces, rendered statically (English —
 *  the i18n context default in tests), plus the pure helpers. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForecastChart, MemorySection, SourcesSection, beginReview, ideaWhen, topicsLine } from "../components/review.tsx";
import { ReviewSettingsSection, parseIntField } from "../components/settings/review-section.tsx";
import { Composer } from "../components/composer.tsx";
import { translator } from "../components/i18n.tsx";
import { reviewBatchProgress, type ReviewApiResponse, type ReviewItemView, type ReviewSummary } from "../src/core/index.ts";
import type { NpMessage } from "../src/core/native-messages.ts";

const es = translator("es");
const en = translator("en");

const summary = (over: Partial<ReviewSummary> = {}): ReviewSummary => ({
	today: "2026-11-04",
	due: [
		{ group: { kind: "session", id: "c1" }, label: "Estoicismo", nodeIds: ["a", "b", "c"] },
		{ group: { kind: "area", id: "area:x/FÍSICA" }, label: "FÍSICA", nodeIds: ["d", "e"] },
		{ group: { kind: "session", id: "c2" }, label: "Newton", nodeIds: ["f"] },
	],
	dueCount: 6,
	retention: {
		overall: 0.874,
		byGroup: [
			{ group: { kind: "session", id: "c1" }, label: "Estoicismo", retention: 0.91, count: 12 },
			{ group: { kind: "session", id: "c2" }, label: "Newton", retention: 0.78, count: 4 },
			{ group: { kind: "session", id: "c3" }, label: "Nueva", retention: null, count: 2 },
		],
	},
	forecast7: [6, 0, 3, 9, 1, 0, 2],
	forecast30: Array.from({ length: 30 }, (_, i) => i % 4),
	enrolled: 18,
	waitingIntake: 3,
	reviewedToday: false,
	...over,
});

const item = (over: Partial<ReviewItemView>): ReviewItemView => ({
	nodeId: "n1", name: "Amor fati", group: { kind: "session", id: "c1" }, label: "Estoicismo", state: "review",
	stability: 3, difficulty: 5, retrievability: 0.71, due: Date.now(), lastReview: null, reps: 2, lapses: 0, paused: false, released: true, ...over,
});

describe("Repaso pure helpers", () => {
	it("topicsLine: two named topics by size, then a count", () => {
		assert.equal(topicsLine(summary().due, es), "Estoicismo, FÍSICA y 1 más");
		assert.equal(topicsLine(summary().due.slice(0, 2), es), "Estoicismo y FÍSICA");
		assert.equal(topicsLine(summary().due.slice(0, 1), en), "Estoicismo");
		assert.equal(topicsLine([], en), "");
	});
	it("ideaWhen: today / tomorrow / in N days / new / waiting", () => {
		const now = new Date(2026, 10, 4, 12).getTime();
		const at = (d: number) => new Date(2026, 10, 4 + d, 9).getTime();
		assert.equal(ideaWhen({ due: at(-3), state: "review", released: true }, now, es), "hoy");
		assert.equal(ideaWhen({ due: at(1), state: "review", released: true }, now, es), "mañana");
		assert.equal(ideaWhen({ due: at(6), state: "review", released: true }, now, es), "en 6 días");
		assert.equal(ideaWhen({ due: at(0), state: "new", released: true }, now, es), "nueva");
		assert.equal(ideaWhen({ due: null, state: "new", released: false }, now, es), "en espera");
	});
	it("beginReview: stashes the opening and returns the id; nothing due → null", async () => {
		const stashed: string[] = [];
		const ok = (async () => new Response(JSON.stringify({ id: "chat_1", opening: "Empecemos el repaso." }))) as unknown as typeof fetch;
		assert.equal(await beginReview(ok, (id, text) => (stashed.push(`${id}:${text}`), true)), "chat_1");
		assert.deepEqual(stashed, ["chat_1:Empecemos el repaso."]);
		const none = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
		assert.equal(await beginReview(none, () => true), null);
		const bad = (async () => new Response(JSON.stringify({ id: "../x", opening: "x" }))) as unknown as typeof fetch;
		assert.equal(await beginReview(bad, () => true), null);
	});
	it("parseIntField accepts in-range integers only", () => {
		assert.equal(parseIntField("15", 0, 500), 15);
		assert.equal(parseIntField("2.5", 0, 50), null);
		assert.equal(parseIntField("-1", 0, 50), null);
		assert.equal(parseIntField("99", 1, 50), null);
	});
});

describe("Repaso sections (static render)", () => {
	it("memory: hero mean vs target, weakest topic first, ungraded topics left out, sr-only table", () => {
		const html = renderToStaticMarkup(<MemorySection summary={summary()} target={0.9} />);
		assert.match(html, /data-testid="review-mean"[^>]*>87%</);
		assert.ok(html.includes("target 90%"));
		assert.ok(html.indexOf("Newton") < html.indexOf("Estoicismo"), "weakest first");
		assert.ok(!html.includes(">Nueva<"));
		assert.ok(html.includes('class="sr-only"'));
	});
	it("forecast: one column per day, values on hover only (owner 2026-11-06), every bar named for assistive tech", () => {
		const html = renderToStaticMarkup(<ForecastChart counts={[6, 0, 3, 9, 1, 0, 2]} now={new Date(2026, 10, 4).getTime()} />);
		assert.equal((html.match(/role="img"/g) ?? []).length, 7);
		assert.ok(html.includes('aria-label="Today: 6 reviews"'));
		assert.ok(!/>9<\/span>/.test(html) && !/>6<\/span>/.test(html), "no fixed numbers over the bars");
		assert.match(html, /<td>Today: 6 reviews<\/td>/, "the sr-only table carries every value");
	});
	it("sources: sessions and areas with their switches and the intake line", () => {
		const data: ReviewApiResponse = {
			summary: summary(),
			items: [item({}), item({ nodeId: "n2", name: "Memento mori", paused: true, retrievability: null, state: "new" })],
			areas: [{ id: "area:002/FILOSOFÍA", label: "FILOSOFÍA", count: 120, active: false, paused: false }],
			sources: { version: 1, activatedAt: "2026-11-04T10:00:00.000Z", areas: [], paused: { sessions: [], areas: [], nodes: ["n2"] } },
			settings: { targetRetention: 0.9, newPerDay: 15 },
		};
		const html = renderToStaticMarkup(<SourcesSection data={data} now={Date.now()} onSources={() => {}} />);
		assert.ok(html.includes("Estoicismo"));
		assert.ok(html.includes("71% · 2 ideas"));
		assert.ok(html.includes("not active · 120 ideas"));
		assert.ok(html.includes('aria-label="Review the “FILOSOFÍA” area"'));
		assert.match(html, /data-testid="review-intake"[^>]*>15 new ideas a day · 3 waiting</);
	});
	it("settings: the approved rows, stored values shown; desktop rows wait for the desktop bridge", () => {
		const html = renderToStaticMarkup(<ReviewSettingsSection review={{ targetRetention: 0.85, newPerDay: 20 }} desktop={undefined} onReviewChange={() => {}} onDesktopChange={() => {}} />);
		assert.ok(html.includes("Target recall"));
		assert.ok(html.includes(">85%<"));
		assert.ok(html.includes('value="20"'));
		assert.ok(html.includes('value="09:00"'));
		assert.ok(!html.includes("review-tray"), "SSR / browser: no desktop rows");
	});
});

describe("the review batch end", () => {
	const msgs = (concluded: string[][]): NpMessage[] => {
		const out: unknown[] = [{ id: "g", role: "custom", customType: "graph-context", content: "", display: true, details: { propositions: [{ id: "a" }, { id: "b" }] }, timestamp: 0 }];
		concluded.forEach((target, i) => {
			out.push({ id: `p${i}`, role: "assistant", content: [{ type: "toolCall", id: `pc${i}`, name: "problem", arguments: { target } }], timestamp: 1 });
			out.push({ id: `pr${i}`, role: "toolResult", toolCallId: `pc${i}`, toolName: "problem", content: [], isError: false, timestamp: 1 });
			out.push({ id: `c${i}`, role: "assistant", content: [{ type: "toolCall", id: `cc${i}`, name: "conclude", arguments: { outcome: "solved" } }], timestamp: 2 });
			out.push({ id: `cr${i}`, role: "toolResult", toolCallId: `cc${i}`, toolName: "conclude", content: [], isError: false, timestamp: 2 });
		});
		return out as NpMessage[];
	};
	it("done only when every picked idea had a concluded problem", () => {
		assert.equal(reviewBatchProgress(msgs([["a"]])).done, false);
		assert.deepEqual(reviewBatchProgress(msgs([["a"], ["b", "x"]])), { picks: ["a", "b"], covered: ["a", "b"], done: true });
		assert.equal(reviewBatchProgress([]).done, false);
	});
	it("the composer shows the end actions instead of the next-problem button", () => {
		const html = renderToStaticMarkup(
			<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} nextProblem={false} endActions={<span data-testid="ends" />} />,
		);
		assert.ok(html.includes('data-testid="ends"'));
		assert.ok(!html.includes("next-problem-button"));
	});
});

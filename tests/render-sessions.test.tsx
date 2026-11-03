/**
 * Session rows (Naipes stage 4, Clonify's etiquetas): each state is a NAMED,
 * TONED label — working/compacting neutral, «your turn»/«problem waiting»
 * attention — and an idle row shows none. The braille spinner still marks
 * live work. The second line is just how long ago. Mis sesiones adds the
 * archive circle. Pure function of the list item, so SSR pins every state.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, filterSessions, sessionState, timeAgo } from "../components/sessions.tsx";
import { continueWith } from "../components/home.tsx";
import type { ChatListItem } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("idle: no label, no spinner — just the title and how long ago", () => {
		const html = render(item({}));
		assert.ok(!html.includes('data-testid="session-state"'));
		assert.ok(!html.includes("braille-spinner"));
		assert.ok(html.includes("Test session"));
		assert.match(html, /\d{4}-\d{2}-\d{2}/, "older than a week: the ISO date");
	});

	it("your turn: the attention-toned label", () => {
		const html = render(item({ pendingQuestion: true }));
		assert.match(html, /data-tone="attention"[^>]*>Your turn</);
		assert.ok(html.includes("bg-attention-soft text-attention"));
		assert.ok(!html.includes("braille-spinner"), "motion stays reserved for live work");
	});

	it("working: the spinner plus a neutral label", () => {
		const html = render(item({ busy: true }));
		assert.ok(html.includes('data-testid="braille-spinner"'));
		assert.match(html, /data-tone="neutral"[^>]*>Your tutor is working</);
	});

	it("compacting outranks a pending question", () => {
		const html = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(html, />Compacting</);
		assert.doesNotMatch(html, />Your turn</);
	});

	it("practice: the dumbbell, and a posed problem waits with the attention tone", () => {
		const html = render(item({ kind: "practice", pendingProblem: true }));
		assert.match(html, /aria-label="Practice session"/);
		assert.match(html, /data-tone="attention"[^>]*>Problem waiting</);
		assert.doesNotMatch(render(item({})), /Practice session/);
	});

	it("the archive circle shows only where archiving is offered, and reflects the state", () => {
		assert.ok(!render(item({})).includes("session-archive"), "«Seguir con» rows carry none");
		const active = renderToStaticMarkup(<SessionRow chat={item({})} active={false} onOpen={() => {}} onArchiveToggle={() => {}} />);
		assert.match(active, /data-testid="session-archive" aria-pressed="false" aria-label="Archive “Test session”"/);
		const archived = renderToStaticMarkup(<SessionRow chat={item({ archivedAt: "2026-01-03T00:00:00.000Z" })} active={false} onOpen={() => {}} onArchiveToggle={() => {}} />);
		assert.match(archived, /aria-pressed="true" aria-label="Move “Test session” back to Active"/);
	});

	it("the active row is marked by its background", () => {
		assert.ok(render(item({}), true).includes("bg-accent"));
	});
});

describe("sessionState — one named state, by priority", () => {
	it("maps each state to its label and tone; idle is null", () => {
		assert.equal(sessionState(item({})), null);
		assert.deepEqual(sessionState(item({ busy: true })), { label: "sessions.state.working", tone: "neutral" });
		assert.deepEqual(sessionState(item({ pendingQuestion: true })), { label: "sessions.state.yourTurn", tone: "attention" });
		assert.equal(sessionState(item({ pendingProblem: true })), null, "problems only wait in practice sessions");
	});
});

describe("filterSessions — Activas / Archivadas", () => {
	const list = [item({ id: "a", title: "Álgebra" }), item({ id: "b", title: "Biología", archivedAt: "2026-01-03T00:00:00.000Z" }), item({ id: "c", title: "Cálculo", kind: "practice" })];
	it("active hides archived; archived shows only them; kind and query still apply", () => {
		assert.deepEqual(filterSessions(list, "", "all").map((c) => c.id), ["a", "c"]);
		assert.deepEqual(filterSessions(list, "", "all", "archived").map((c) => c.id), ["b"]);
		assert.deepEqual(filterSessions(list, "", "practice").map((c) => c.id), ["c"]);
		assert.deepEqual(filterSessions(list, "bio", "all", "archived").map((c) => c.id), ["b"]);
	});
});

describe("continueWith — «Seguir con» on Inicio", () => {
	it("what needs you first, then the most recent; three at most; never archived", () => {
		const chats = [
			item({ id: "old-idle", updatedAt: "2026-01-01T00:00:00.000Z" }),
			item({ id: "new-idle", updatedAt: "2026-01-05T00:00:00.000Z" }),
			item({ id: "waiting", updatedAt: "2026-01-02T00:00:00.000Z", pendingQuestion: true }),
			item({ id: "archived", updatedAt: "2026-01-06T00:00:00.000Z", archivedAt: "2026-01-06T00:00:00.000Z" }),
			item({ id: "mid-idle", updatedAt: "2026-01-03T00:00:00.000Z" }),
		];
		assert.deepEqual(continueWith(chats).map((c) => c.id), ["waiting", "new-idle", "mid-idle"]);
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date (owner, round 5)", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02", "beyond a week: ISO — unambiguous, sortable");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});


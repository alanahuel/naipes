import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_NOTICES, addNotices, endedSince, extractionNotice, extractionNotices, isExternalHref, jobNotice, reviewNotice, unreadCount, updateNotice, type Notice } from "../components/notices.tsx";
import type { ActivityFeed, FeedJob } from "../components/activity-dock.tsx";

const job = (id: string, chatId = "chat_1", kind: FeedJob["kind"] = "research") =>
	({ id, chatId, kind, title: "Leyes de Newton", status: "running", createdAt: "2026-11-03T10:00:00.000Z", contextLimit: null }) as unknown as FeedJob;
const extraction = (id: string, chatId: string, title = "Nota") => ({ id, chatId, title, phase: "extracting", startedAt: 0 });
const feed = (jobs: FeedJob[], extractions: ActivityFeed["extractions"] = []): ActivityFeed => ({ jobs, extractions });

describe("endedSince — what left the activity feed", () => {
	it("reports ended jobs only — an extraction leaving the feed says nothing about success", () => {
		const prev = feed([job("j1"), job("j2")], [extraction("s1#0", "s1"), extraction("s2", "s2")]);
		const next = feed([job("j2")], []);
		const ended = endedSince(prev, next);
		assert.deepEqual(ended.jobs.map((j) => j.id), ["j1"]);
		assert.deepEqual(Object.keys(ended), ["jobs"]);
	});
});

describe("notice builders", () => {
	const now = new Date("2026-11-03T12:00:00.000Z");
	it("a finished job names its kind; a failed one is amber and says to open it", () => {
		const base = { id: "j1", chatId: "chat_1", kind: "demo" as const, title: "Planck" };
		const ok = jobNotice(base, { status: "done" }, now);
		assert.equal(ok.message, "notices.job.demo");
		assert.equal(ok.tone, "ok");
		assert.equal(ok.href, "/chat/chat_1");
		const failed = jobNotice(base, { status: "error" }, now);
		assert.equal(failed.message, "notices.jobFailed");
		assert.equal(failed.tone, "warn");
	});

	it("extractions coalesce: one names its source, many become a count", () => {
		const one = extractionNotice([{ source: "chat_9", title: "Derivadas", kind: "chat" }], "ok", now);
		assert.equal(one.message, "notices.extractedOne");
		assert.deepEqual(one.vars, { title: "Derivadas" });
		assert.equal(one.href, "/chat/chat_9");
		assert.equal(one.tone, "ok");
		const many = extractionNotice([{ source: "src_a", title: "a.md", kind: "notes" }, { source: "src_b", title: "b.md", kind: "notes" }], "ok", now);
		assert.equal(many.message, "notices.extractedMany");
		assert.deepEqual(many.vars, { n: 2 });
		assert.equal(many.href, "/knowledge");
	});

	it("a failed extraction is amber, never «Pasé a tu grafo», and points where it can be acted on", () => {
		const note = extractionNotice([{ source: "src_a", title: "PC - HACKTHEBOX.md", kind: "notes" }], "failed", now);
		assert.equal(note.message, "notices.extractionFailedOne");
		assert.deepEqual(note.vars, { title: "PC - HACKTHEBOX.md" });
		assert.equal(note.tone, "warn");
		assert.equal(note.href, "/settings/connections");
		const chat = extractionNotice([{ source: "chat_9", title: "Derivadas", kind: "chat" }], "failed", now);
		assert.equal(chat.href, "/chat/chat_9");
		const chats = extractionNotice([{ source: "chat_1", title: "a", kind: "chat" }, { source: "chat_2", title: "b", kind: "chat" }], "failed", now);
		assert.equal(chats.message, "notices.extractionFailedMany");
		assert.equal(chats.href, "/sessions");
		const mixed = extractionNotice([{ source: "chat_1", title: "a", kind: "chat" }, { source: "src_b", title: "b.md", kind: "notes" }], "failed", now);
		assert.equal(mixed.href, "/settings/connections");
	});

	it("a mixed batch splits into one notice per outcome, failures first", () => {
		const notices = extractionNotices(
			[
				{ source: "src_a", title: "a.md", kind: "notes", outcome: "ok" },
				{ source: "src_b", title: "b.md", kind: "notes", outcome: "failed" },
				{ source: "src_c", title: "c.md", kind: "notes", outcome: "ok" },
			],
			now,
		);
		assert.deepEqual(notices.map((n) => n.message), ["notices.extractionFailedOne", "notices.extractedMany"]);
		assert.deepEqual(notices[1]!.vars, { n: 2 });
		assert.notEqual(notices[0]!.id, notices[1]!.id);
		assert.deepEqual(extractionNotices([{ source: "src_a", title: "a.md", kind: "notes", outcome: "ok" }], now).map((n) => n.tone), ["ok"]);
	});
});

describe("the notice list", () => {
	const notice = (id: string, read = false): Notice => ({ id, at: "2026-11-03T12:00:00.000Z", message: "notices.turnDone", vars: { title: "x" }, tone: "ok", read });
	it("newest first, capped, counting unread", () => {
		const list = addNotices([notice("old", true)], [notice("new")]);
		assert.deepEqual(list.map((n) => n.id), ["new", "old"]);
		assert.equal(unreadCount(list), 1);
		const many = addNotices([], Array.from({ length: MAX_NOTICES + 5 }, (_, i) => notice(`n${i}`)));
		assert.equal(many.length, MAX_NOTICES);
	});
});

describe("updateNotice — a newer release seen by a local build (stage 0b)", () => {
	const available = { status: "available" as const, version: "0.2.0", url: "https://github.com/alanahuel/naipes/releases/tag/v0.2.0", notice: "local" as const, revision: 3 };
	it("one notice per version, linking to the release page", () => {
		const n = updateNotice(available, null, new Date("2026-11-04T12:00:00.000Z"))!;
		assert.equal(n.id, "update:0.2.0");
		assert.equal(n.message, "notices.updateAvailable");
		assert.deepEqual(n.vars, { version: "0.2.0" });
		assert.equal(n.href, available.url);
		assert.equal(updateNotice(available, "0.2.0"), null);
		assert.ok(updateNotice({ ...available, version: "0.3.0" }, "0.2.0"));
	});
	it("nothing for other states, missing data or a non-https url", () => {
		for (const status of ["idle", "checking", "up-to-date", "downloaded", "error", "disabled"] as const) {
			assert.equal(updateNotice({ ...available, status }, null), null);
		}
		assert.equal(updateNotice(null, null), null);
		assert.equal(updateNotice({ ...available, version: null }, null), null);
		assert.equal(updateNotice({ ...available, url: null }, null), null);
		assert.equal(updateNotice({ ...available, url: "javascript:alert(1)" }, null), null);
	});
	it("an AUR install's notice has no page: it points at the package manager", () => {
		const n = updateNotice({ ...available, url: null, notice: "pacman" }, null)!;
		assert.equal(n.message, "notices.updateAvailablePackage");
		assert.equal(n.href, undefined);
		assert.equal(updateNotice({ ...available, url: null, notice: "mac" }, null), null);
	});
	it("external hrefs open in the browser; app routes stay in the app", () => {
		assert.equal(isExternalHref(available.url), true);
		assert.equal(isExternalHref("/chat/chat_1"), false);
	});
});

describe("reviewNotice — the bell side of review notices (stage 2)", () => {
	it("digest and evening open Repaso, one notice id per kind and day", () => {
		const d = reviewNotice({ kind: "digest", count: 12 }, new Date("2026-11-04T09:00:00.000Z"));
		assert.equal(d.message, "notices.reviewDigest");
		assert.deepEqual(d.vars, { n: 12 });
		assert.equal(d.href, "/review");
		assert.equal(d.id, "review:digest:2026-11-04");
		assert.equal(reviewNotice({ kind: "evening", count: 3 }).message, "notices.reviewEvening");
	});
});

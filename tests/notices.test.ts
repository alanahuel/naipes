import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_NOTICES, addNotices, endedSince, extractionNotice, jobNotice, unreadCount, type Notice } from "../components/notices.tsx";
import type { ActivityFeed, FeedJob } from "../components/activity-dock.tsx";

const job = (id: string, chatId = "chat_1", kind: FeedJob["kind"] = "research") =>
	({ id, chatId, kind, title: "Leyes de Newton", status: "running", createdAt: "2026-11-03T10:00:00.000Z", contextLimit: null }) as unknown as FeedJob;
const extraction = (id: string, chatId: string, title = "Nota") => ({ id, chatId, title, phase: "extracting", startedAt: 0 });
const feed = (jobs: FeedJob[], extractions: ActivityFeed["extractions"] = []): ActivityFeed => ({ jobs, extractions });

describe("endedSince — what left the activity feed", () => {
	it("reports ended jobs and ended extraction SOURCES (chunk rows of one source end once)", () => {
		const prev = feed([job("j1"), job("j2")], [extraction("s1#0", "s1"), extraction("s1#1", "s1"), extraction("s2", "s2")]);
		const next = feed([job("j2")], [extraction("s2", "s2")]);
		const ended = endedSince(prev, next);
		assert.deepEqual(ended.jobs.map((j) => j.id), ["j1"]);
		assert.deepEqual(ended.extractions, [{ source: "s1", title: "Nota" }]);
	});

	it("a source still running in any chunk has not ended", () => {
		const prev = feed([], [extraction("s1#0", "s1"), extraction("s1#1", "s1")]);
		assert.deepEqual(endedSince(prev, feed([], [extraction("s1#1", "s1")])).extractions, []);
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
		const one = extractionNotice([{ source: "chat_9", title: "Derivadas" }], now);
		assert.equal(one.message, "notices.extractedOne");
		assert.deepEqual(one.vars, { title: "Derivadas" });
		assert.equal(one.href, "/chat/chat_9");
		const many = extractionNotice([{ source: "src_a", title: "a.md" }, { source: "src_b", title: "b.md" }], now);
		assert.equal(many.message, "notices.extractedMany");
		assert.deepEqual(many.vars, { n: 2 });
		assert.equal(many.href, "/knowledge");
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

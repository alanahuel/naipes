/** «Primeros pasos» detectors + the onboarding writer, end to end over an
 *  isolated temporary data dir (NP_DATA_DIR set before any import).
 *  Synthetic chats only — no real data, no network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-onboarding-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { onboardingResponse, applyOnboarding } = await import("../src/server/onboarding.ts");
const { resetReviewCache } = await import("../src/server/review.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

const at = new Date(2026, 10, 1).toISOString();
const writeChat = (record: Record<string, unknown>) => {
	fs.mkdirSync(path.join(DIR, "chats"), { recursive: true });
	fs.writeFileSync(path.join(DIR, "chats", `${record.id}.json`), JSON.stringify({ title: "t", createdAt: at, updatedAt: at, messages: [], ...record }));
	resetReviewCache();
};

describe("onboarding detectors (isolated data dir)", () => {
	it("an empty install has every session/settings step pending", () => {
		const { done, settings } = onboardingResponse();
		assert.deepEqual(settings, {});
		for (const id of ["models", "firstSession", "practice", "folder", "inbox", "review", "exam", "photo", "dictation", "mcp"] as const) {
			assert.equal(done[id], false, id);
		}
	});

	it("sessions flip their steps; a review session is not «practice»", () => {
		writeChat({ id: "chat_t", messages: [] });
		writeChat({ id: "chat_r", kind: "practice", review: { day: "2026-11-01" } });
		let { done } = onboardingResponse();
		assert.equal(done.firstSession, true);
		assert.equal(done.review, true);
		assert.equal(done.practice, false);
		writeChat({ id: "chat_p", kind: "practice" });
		({ done } = onboardingResponse());
		assert.equal(done.practice, true);
	});

	it("settings flip folder, inbox and MCP", () => {
		writeSettings({ version: 1, obsidian: { enabled: true, vaultPath: "/tmp/vault", suggestFolders: true }, mcp: { enabled: true } });
		const { done } = onboardingResponse();
		assert.equal(done.folder, true);
		assert.equal(done.inbox, true);
		assert.equal(done.mcp, true);
	});

	it("ops write only the onboarding section", () => {
		applyOnboarding({ op: "dictationUsed" });
		applyOnboarding({ op: "skip", id: "exam" });
		applyOnboarding({ op: "seen", version: "0.17.0" });
		const record = readSettings();
		assert.equal(record?.mcp && (record.mcp as { enabled?: boolean }).enabled, true);
		assert.equal(record?.onboarding?.lastSeenVersion, "0.17.0");
		assert.deepEqual(record?.onboarding?.skipped, ["exam"]);
		assert.equal(onboardingResponse().done.dictation, true);
	});
});

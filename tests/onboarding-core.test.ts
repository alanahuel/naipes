/** «Primeros pasos» / «Novedades» — the pure registry + view logic
 *  (core/onboarding.ts). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ONBOARDING_ENTRIES,
	ONBOARDING_STEP_IDS,
	applyOnboardingOp,
	compareVersions,
	hasOnboardingEntryFor,
	onboardingNeedsSeen,
	onboardingView,
	parseOnboardingOp,
	sanitizeOnboardingSettings,
	type OnboardingDone,
	type OnboardingStepId,
} from "../src/core/onboarding.ts";
import { MESSAGES } from "../src/core/messages/index.ts";

const none = Object.fromEntries(ONBOARDING_STEP_IDS.map((id) => [id, false])) as Record<OnboardingStepId, boolean>;
const withDone = (...ids: OnboardingStepId[]): OnboardingDone => ({ ...none, ...Object.fromEntries(ids.map((id) => [id, true])) });
const ids = (rows: { entry: { id: string } }[]) => rows.map((r) => r.entry.id);
const V = "0.18.0";

describe("onboarding registry", () => {
	it("holds the 11 approved steps in guide order, 3 phases", () => {
		const steps = ONBOARDING_ENTRIES.filter((e) => e.phase !== undefined);
		assert.deepEqual(ids(steps.map((entry) => ({ entry }))), ["provider", "models", "firstSession", "practice", "folder", "inbox", "review", "exam", "photo", "dictation", "mcp"]);
		assert.deepEqual(steps.map((s) => s.phase), [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
		for (const s of steps) assert.ok(s.target, `${s.id} has a «pruébalo»`);
	});

	it("every shown entry has its title and body in both languages", () => {
		for (const e of ONBOARDING_ENTRIES.filter((x) => !x.silent)) {
			for (const locale of ["es", "en"] as const) {
				for (const part of ["title", "body"]) {
					assert.ok((MESSAGES[locale] as Record<string, unknown>)[`onboarding.entry.${e.id}.${part}`], `${locale} ${e.id}.${part}`);
				}
			}
		}
	});

	it("compares versions numerically", () => {
		assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
		assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
		assert.equal(compareVersions("0.17.1", "0.17.0"), 1);
	});

	it("knows which versions have an entry", () => {
		assert.equal(hasOnboardingEntryFor("0.15.0"), true);
		assert.equal(hasOnboardingEntryFor("0.11.0"), false);
		assert.equal(hasOnboardingEntryFor("0.18.0", [{ id: "x", version: "0.18.0", silent: true }]), true);
	});
});

describe("the guide", () => {
	it("a fresh install sees phase 1 only", () => {
		const view = onboardingView({ settings: undefined, done: none, version: V });
		assert.ok(view && view.mode === "guide");
		assert.equal(view.phase, 1);
		assert.deepEqual(ids(view.rows), ["provider", "models", "firstSession"]);
		assert.equal(view.completed, 0);
		assert.equal(view.total, 11);
	});

	it("done steps stay visible, checked, in the current phase", () => {
		const view = onboardingView({ settings: undefined, done: withDone("provider", "models"), version: V });
		assert.ok(view && view.mode === "guide");
		assert.deepEqual(view.rows.map((r) => r.status), ["done", "done", "pending"]);
		assert.equal(view.completed, 2);
	});

	it("the next phase unlocks when every step is done OR skipped", () => {
		const view = onboardingView({ settings: { skipped: ["firstSession"] }, done: withDone("provider", "models"), version: V });
		assert.ok(view && view.mode === "guide");
		assert.equal(view.phase, 2);
		assert.deepEqual(ids(view.rows), ["practice", "folder", "inbox", "review"]);
		assert.equal(view.completed, 3);
	});

	it("a long-time user lands on what they have not used yet", () => {
		const view = onboardingView({ settings: undefined, done: withDone("provider", "models", "firstSession", "practice", "folder", "inbox", "review", "exam", "photo"), version: V });
		assert.ok(view && view.mode === "guide");
		assert.equal(view.phase, 3);
		assert.deepEqual(view.rows.filter((r) => r.status === "pending").map((r) => r.entry.id), ["dictation", "mcp"]);
	});

	it("nothing pending → no card", () => {
		assert.equal(onboardingView({ settings: undefined, done: withDone(...ONBOARDING_STEP_IDS), version: V }), null);
	});

	it("hidden → only steps newer than the hide come back, ungated", () => {
		const entries = [...ONBOARDING_ENTRIES, { id: "provider", version: "0.19.0", phase: 1 as const, target: { kind: "setup" as const } }];
		const settings = { lastSeenVersion: "0.19.0", hiddenAtVersion: V };
		assert.equal(onboardingView({ settings: { ...settings, lastSeenVersion: V }, done: none, version: V }), null);
		const view = onboardingView({ settings, done: none, version: "0.19.0", entries });
		assert.ok(view && view.mode === "guide");
		assert.equal(view.phase, null);
		assert.deepEqual(ids(view.rows), ["provider"]);
	});

	it("entries from a future version stay out", () => {
		const view = onboardingView({ settings: undefined, done: withDone("provider", "models", "firstSession", "practice", "folder", "inbox", "review", "exam", "photo"), version: "0.14.0" });
		assert.ok(view && view.mode === "guide");
		assert.deepEqual(ids(view.rows), ["exam", "photo", "mcp"]);
		assert.equal(view.total, 10);
	});
});

describe("Novedades", () => {
	it("an update shows the entries newer than the last seen version", () => {
		const view = onboardingView({ settings: { lastSeenVersion: "0.13.0" }, done: withDone("mcp"), version: "0.16.0" });
		assert.ok(view && view.mode === "news");
		assert.deepEqual(view.rows.map((r) => [r.entry.id, r.status]), [["dictation", "pending"], ["batchProgress", "info"], ["probeMemory", "info"]]);
	});

	it("shows even after «Ocultar»; silent entries never show", () => {
		const entries = [{ id: "quiet", version: "0.19.0", silent: true }];
		assert.equal(onboardingView({ settings: { lastSeenVersion: V }, done: none, version: "0.19.0", entries }), null);
		const view = onboardingView({ settings: { lastSeenVersion: "0.15.0", hiddenAtVersion: "0.15.0" }, done: none, version: "0.16.0" });
		assert.ok(view && view.mode === "news");
	});

	it("records the version on a first read and after an update only", () => {
		assert.equal(onboardingNeedsSeen(undefined, V), true);
		assert.equal(onboardingNeedsSeen({ lastSeenVersion: "0.16.0" }, V), true);
		assert.equal(onboardingNeedsSeen({ lastSeenVersion: V }, V), false);
	});
});

describe("ops and the stored section", () => {
	const now = new Date("2026-11-09T10:00:00Z");
	it("parses only well-formed ops", () => {
		assert.deepEqual(parseOnboardingOp({ op: "skip", id: "mcp" }), { op: "skip", id: "mcp" });
		assert.equal(parseOnboardingOp({ op: "skip", id: "nope" }), null);
		assert.equal(parseOnboardingOp({ op: "seen" }), null);
		assert.equal(parseOnboardingOp([]), null);
	});

	it("applies ops: seen never goes back, skip dedupes, first dictation kept", () => {
		let s = applyOnboardingOp(undefined, { op: "seen", version: V }, now);
		s = applyOnboardingOp(s, { op: "seen", version: "0.16.0" }, now);
		assert.equal(s.lastSeenVersion, V);
		s = applyOnboardingOp(s, { op: "skip", id: "mcp" }, now);
		s = applyOnboardingOp(s, { op: "skip", id: "mcp" }, now);
		assert.deepEqual(s.skipped, ["mcp"]);
		s = applyOnboardingOp(s, { op: "dictationUsed" }, now);
		s = applyOnboardingOp(s, { op: "dictationUsed" }, new Date("2027-01-01T00:00:00Z"));
		assert.equal(s.dictationUsedAt, now.toISOString());
		s = applyOnboardingOp(s, { op: "hide", version: V }, now);
		assert.equal(s.hiddenAtVersion, V);
	});

	it("sanitizes junk", () => {
		assert.deepEqual(sanitizeOnboardingSettings({ lastSeenVersion: "x", skipped: ["mcp", "mcp", "bad", 3], dictationUsedAt: "never", extra: 1 }), { skipped: ["mcp"] });
		assert.deepEqual(sanitizeOnboardingSettings(null), {});
	});
});

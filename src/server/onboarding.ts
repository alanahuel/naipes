/**
 * «Primeros pasos» detectors + the onboarding section's single writer
 * (owner, 2026-11-09). Nobody is measured as "new": each step is DONE
 * when the learner's own local state shows it (core/onboarding.ts holds
 * the registry and the view logic).
 */

import {
	applyOnboardingOp,
	slotsConfigured,
	type OnboardingDone,
	type OnboardingOp,
	type OnboardingResponse,
	type OnboardingSettings,
	type UserSettings,
} from "../core";
import { readSettings, writeSettings } from "../store/settings.ts";
import { listExams } from "../store/exams.ts";
import { catalogProviders } from "./model-catalog.ts";
import { getReviewState } from "./review.ts";
import { referencedAttachmentIds } from "./attachments.ts";

/** Each step's detector over the settings record and the stored sessions. */
export function onboardingDone(record: UserSettings | null): OnboardingDone {
	// The review state's chat records (cached); a newer-version review
	// file makes it refuse — the session steps then read as pending.
	let chats: ReturnType<typeof getReviewState>["chats"] = [];
	try {
		chats = getReviewState().chats;
	} catch {
		/* review state unavailable */
	}
	const obsidian = record?.obsidian;
	return {
		provider: catalogProviders().some((p) => p.keyPresent),
		models: slotsConfigured(record?.models),
		firstSession: chats.some((c) => (c.kind ?? "teach") === "teach"),
		practice: chats.some((c) => c.kind === "practice" && !c.review),
		folder: obsidian?.enabled === true && typeof obsidian.vaultPath === "string" && obsidian.vaultPath.trim() !== "",
		inbox: obsidian?.suggestFolders === true,
		review: chats.some((c) => c.review !== undefined),
		exam: listExams().length > 0,
		photo: chats.some((c) => referencedAttachmentIds(c.messages).size > 0),
		dictation: record?.onboarding?.dictationUsedAt !== undefined,
		mcp: record?.mcp?.enabled === true,
	};
}

export function onboardingResponse(): OnboardingResponse {
	const record = readSettings();
	return { settings: record?.onboarding ?? {}, done: onboardingDone(record) };
}

/** Read-modify-write the onboarding section only (no client ever sends
 *  the whole section, so concurrent ops cannot clobber each other). */
export function applyOnboarding(op: OnboardingOp, now = new Date()): OnboardingSettings {
	const record = readSettings() ?? { version: 1 };
	const next = applyOnboardingOp(record.onboarding, op, now);
	writeSettings({ ...record, onboarding: next });
	return next;
}

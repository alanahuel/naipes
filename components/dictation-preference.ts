"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationEngine, isDictationLanguage, isWhisperModelId, sanitizeUserSettings,
	type DictationEngine, type DictationLanguage, type DictationSettings, type UserSettings, type WhisperModelId,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	/** Local Whisper or Deepgram (owner, 2026-11-08) — confirmed with the language. */
	engine: undefined as DictationEngine | undefined,
	whisperModel: undefined as WhisperModelId | undefined,
	saving: false,
	error: null as string | null,
};

export type DictationPreferenceSnapshot = typeof INITIAL;

/** The whole dictation section as confirmed (factory values fill gaps). */
function resolved(section: DictationSettings | undefined) {
	return {
		language: section?.language ?? FACTORY_SETTINGS.dictation.language,
		engine: section?.engine ?? FACTORY_SETTINGS.dictation.engine,
		whisperModel: section?.whisperModel ?? FACTORY_SETTINGS.dictation.whisperModel,
	};
}

/** One confirmed preference and one write in flight, shared by every surface.
 * Holds the WHOLE dictation section: its PUT replaces the section, so every
 * write sends language + engine + model together (a language change must
 * never drop the engine choice).
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const section = resolved(record?.dictation);
				needsRead = false;
				publish({ ...section, error: null });
				return section.language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** Save a new language (the picker) or any other part of the section. */
	function save(change: DictationLanguage | Partial<DictationSettings>): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		const patch: Partial<DictationSettings> = typeof change === "string" ? { language: change } : change;
		const next = {
			language: patch.language ?? snapshot.language,
			engine: patch.engine ?? snapshot.engine ?? FACTORY_SETTINGS.dictation.engine,
			whisperModel: patch.whisperModel ?? snapshot.whisperModel ?? FACTORY_SETTINGS.dictation.whisperModel,
		};
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation;
				if (!isDictationLanguage(confirmed?.language)) throw new Error();
				needsRead = false;
				publish({
					language: confirmed.language,
					engine: isDictationEngine(confirmed.engine) ? confirmed.engine : next.engine,
					whisperModel: isWhisperModelId(confirmed.whisperModel) ? confirmed.whisperModel : next.whisperModel,
					error: null,
				});
				saved();
				return true;
			} catch {
				publish({ error: "Could not save dictation settings. Try again." });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function getLanguage(): Promise<DictationLanguage> {
		return (await getSettings()).language;
	}

	/** The confirmed section — what a dictation run starts with. */
	async function getSettings(): Promise<Required<DictationSettings>> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return resolved(snapshot);
		}
	}

	return {
		load, save, getLanguage, getSettings,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, getLanguage: store.getLanguage, getSettings: store.getSettings };
}

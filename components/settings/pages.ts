/**
 * The settings pages' ids and where each old dialog section lands — pure
 * (no "use client"), so server routes (app/settings/[page]) can call it.
 */

export type SettingsPageId = "ai" | "connections" | "review" | "exams" | "calendar" | "appearance" | "shortcuts" | "advanced" | "language";
export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = ["ai", "connections", "review", "exams", "calendar", "appearance", "shortcuts", "advanced", "language"];
export function isSettingsPage(value: unknown): value is SettingsPageId {
	return typeof value === "string" && (SETTINGS_PAGE_IDS as readonly string[]).includes(value);
}

/** Where an old dialog section (and an optional Keys row) lands now —
 *  every `open(section, row)` caller and the Electron menu route here. */
export function pageForSection(section?: string, row?: string): SettingsPageId {
	if (row === "DEEPGRAM_API_KEY" || row === "WHISPER_MODELS" || row === "TAVILY_API_KEY" || row === "BRAVE_API_KEY") return "connections";
	switch (section) {
		case "obsidian":
			return "connections";
		case "review":
		case "desktop":
			return "review";
		case "exams":
			return "exams";
		case "calendar":
			return "calendar";
		case "appearance":
			return "appearance";
		case "keyboard":
			return "shortcuts";
		case "graph":
		case "general":
			return "advanced";
		case "language":
			return "language";
		default:
			return "ai";
	}
}

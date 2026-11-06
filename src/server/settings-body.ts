/**
 * The shared settings-PUT body parsers — one seam per settings surface.
 * Extracted verbatim from the per-chat route (default-settings wave,
 * 2026-09-18): identical parse, identical errors. The section parsers
 * (settings-storage wave, 2026-09-19) follow the same house rules.
 *
 * Replace-whole semantics: the client sends the complete desired SECTION;
 * absent fields are absent overrides ({} clears everything). No merges, so
 * a stale client can never resurrect a cleared override. Unknown body keys
 * are dropped (same tolerance as parseSettingsBody) — unknown DISK keys are
 * a different concern and are preserved by the sanitizer (core/settings.ts).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHexColor, type ChatSettings } from "../core";
import type {
	AgentSettings,
	AppearanceSettings,
	BackgroundModelRole,
	CompactionSettings,
	GeneralSettings,
	DictationSettings,
	GraphSettings,
	ModelsSettings,
	RoleModelOverride,
} from "../core/settings.ts";
import { isLocale } from "../core/i18n.ts";
import { BACKGROUND_MODEL_ROLES, COMPACTION_THRESHOLD_FLOOR, CONFIRM_ABOVE_RUNS_MIN, EXTRACTION_CHUNK_TOKENS_FLOOR, MODEL_SLOTS, REVIEW_RETENTION_MAX, REVIEW_RETENTION_MIN, normalizeClockTime, normalizeVaultFolder, isThemeMode, isWeeklyMinutes, EXAM_INT_FIELDS, type DesktopSettings, type PhoneSettings, type ExamSettings, type ObsidianSettings, type ReviewSettings } from "../core/settings.ts";
import { WRITABLE_TOOL_KEYS } from "../core/pending.ts";
import { isDictationLanguage } from "../core/dictation.ts";

/** Parsed-or-rejected — `ok: false` carries the 400's error message. */
export type SettingsBodyResult<T> =
	| { ok: true; settings: T }
	| { ok: false; error: string };

export function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
	};
	const settings: ChatSettings = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: "model must be {provider, id}" };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: "thinkingLevel must be a string" };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	// Wave 7 killed the graph-context injection (owner: zero configuration
	// beyond chat models — the prober reads its map through tools now); its
	// budget dial is gone with it. A stale client sending the old key has
	// it silently dropped here (forward-compatible, like any unknown key).
	return { ok: true, settings };
}

// ─── Section parsers (settings-storage wave, 2026-09-19) ────────────────────
// One parser per settings.json section; the route maps the URL section to
// its parser via SETTINGS_SECTIONS below. Same discipline as
// parseSettingsBody: strict on every known field (a bad type/shape is a
// 400, never a silent clamp/drop), unknown keys dropped.

function asRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

/** general: { autoUpdate?: boolean } */
export function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: GeneralSettings = {};
	if (raw.autoUpdate !== undefined) {
		if (typeof raw.autoUpdate !== "boolean") {
			return { ok: false, error: "autoUpdate must be a boolean" };
		}
		settings.autoUpdate = raw.autoUpdate;
	}
	if (raw.language !== undefined) {
		if (!isLocale(raw.language)) return { ok: false, error: "language must be \"es\" or \"en\"" };
		settings.language = raw.language;
	}
	return { ok: true, settings };
}

/** agent.models: only the six known background roles; each override's
 *  fields mirror ChatSettings (model pair + independent thinkingLevel). */
function parseRoleOverride(value: unknown, role: string): { ok: true; override: RoleModelOverride } | { ok: false; error: string } {
	const raw = asRecord(value);
	if (!raw) return { ok: false, error: `${role} must be an object` };
	const override: RoleModelOverride = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof (raw.model as Record<string, unknown>).provider !== "string" ||
			typeof (raw.model as Record<string, unknown>).id !== "string"
		) {
			return { ok: false, error: `${role}.model must be {provider, id}` };
		}
		override.model = {
			provider: (raw.model as { provider: string }).provider,
			id: (raw.model as { id: string }).id,
		};
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: `${role}.thinkingLevel must be a string` };
		}
		override.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, override };
}

/** A boolean map (tools / prompts switches): every value must be boolean. */
function parseBooleanMap(value: unknown, field: string): { map?: Record<string, boolean>; error?: string } {
	if (value === undefined) return {};
	const raw = asRecord(value);
	if (!raw) return { error: `${field} must be an object` };
	const out: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "boolean") return { error: `${field}.${key} must be a boolean` };
		out[key] = entry;
	}
	return { map: out };
}

/** agent: { models?, tools?, prompts? } — model/thinking validity against
 *  the catalog is checked by the route (validateChatSettings discipline);
 *  prompt switch-on membership is checked by the route (needs the store). */
export function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AgentSettings = {};
	if (raw.models !== undefined) {
		const models = asRecord(raw.models);
		if (!models) return { ok: false, error: "models must be an object" };
		const known = BACKGROUND_MODEL_ROLES as readonly string[];
		const parsed: NonNullable<AgentSettings["models"]> = {};
		for (const [role, value] of Object.entries(models)) {
			if (!known.includes(role)) {
				return { ok: false, error: `unknown role "${role}" (supported: ${known.join(", ")})` };
			}
			const override = parseRoleOverride(value, role);
			if (!override.ok) return { ok: false, error: override.error };
			if (Object.keys(override.override).length) parsed[role as BackgroundModelRole] = override.override;
		}
		if (Object.keys(parsed).length) settings.models = parsed;
	}
	const tools = parseBooleanMap(raw.tools, "tools");
	if (tools.error) return { ok: false, error: tools.error };
	if (tools.map) {
		// Unknown tool keys are rejected at WRITE time (user decision
		// 2026-09-19): the delta is inert while unread, but once the bridge
		// honors it a persisted bogus key would drift. The writable set is
		// the job tools + the quizzing-mechanics switch (explain, owner
		// 2026-09-27). The read-side sanitizer stays lenient for
		// forward-compat.
		const supported = WRITABLE_TOOL_KEYS as readonly string[];
		for (const key of Object.keys(tools.map)) {
			if (!supported.includes(key)) {
				return { ok: false, error: `unknown tool "${key}" (supported: ${supported.join(", ")})` };
			}
		}
		settings.tools = tools.map;
	}
	const prompts = parseBooleanMap(raw.prompts, "prompts");
	if (prompts.error) return { ok: false, error: prompts.error };
	if (prompts.map) settings.prompts = prompts.map;
	if (raw.search !== undefined) {
		const search = asRecord(raw.search);
		if (!search) return { ok: false, error: "search must be an object" };
		if (search.engine !== undefined) {
			if (search.engine !== "tavily" && search.engine !== "brave") {
				return { ok: false, error: 'search.engine must be "tavily" or "brave"' };
			}
			settings.search = { engine: search.engine };
		}
	}
	// Prober graph tools (wave 7, owner ruling 2026-09-23): an agent-section
	// subsection, not a tool-toggles key — the mechanism is agent capability
	// (tool registration), the subject is the graph. Strict write side:
	// object shape only; `enabled` boolean when present. Absent = ON.
	if (raw.graphTools !== undefined) {
		const graphTools = asRecord(raw.graphTools);
		if (!graphTools) return { ok: false, error: "graphTools must be an object" };
		if (graphTools.enabled !== undefined && typeof graphTools.enabled !== "boolean") {
			return { ok: false, error: "graphTools.enabled must be a boolean" };
		}
		settings.graphTools = graphTools.enabled === undefined ? {} : { enabled: graphTools.enabled };
	}
	return { ok: true, settings };
}

/** A hex-or-null color field (appearance colors): null = default. */
function parseHexOrNull(value: unknown, field: string): { color?: string | null; error?: string } {
	if (value === null) return { color: null };
	if (typeof value !== "string" || !isHexColor(value)) {
		return { error: `${field} must be a #hex color or null` };
	}
	return { color: value };
}

/** appearance: { mode?, background?, fontFamily?, proseFontSize?,
 *  sessionNameSerif?, mdRendering? } */
export function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: AppearanceSettings = {};
	if (raw.mode !== undefined) {
		if (!isThemeMode(raw.mode)) {
			return { ok: false, error: "mode must be \"system\", \"light\" or \"dark\"" };
		}
		settings.mode = raw.mode;
	}
	if (raw.background !== undefined) {
		const parsed = parseHexOrNull(raw.background, "background");
		if (parsed.error) return { ok: false, error: parsed.error };
		settings.background = parsed.color ?? null;
	}
	if (raw.fontFamily !== undefined) {
		if (raw.fontFamily !== null && (typeof raw.fontFamily !== "string" || !raw.fontFamily.trim())) {
			return { ok: false, error: "fontFamily must be a non-empty string or null" };
		}
		settings.fontFamily = raw.fontFamily as string | null;
	}
	if (raw.proseFontSize !== undefined) {
		if (
			typeof raw.proseFontSize !== "number" ||
			!Number.isInteger(raw.proseFontSize) ||
			raw.proseFontSize < 12 ||
			raw.proseFontSize > 24
		) {
			return { ok: false, error: "proseFontSize must be an integer between 12 and 24" };
		}
		settings.proseFontSize = raw.proseFontSize;
	}
	if (raw.sessionNameSerif !== undefined) {
		if (typeof raw.sessionNameSerif !== "boolean") {
			return { ok: false, error: "sessionNameSerif must be a boolean" };
		}
		settings.sessionNameSerif = raw.sessionNameSerif;
	}
	if (raw.mdRendering !== undefined) {
		const md = asRecord(raw.mdRendering);
		if (!md) return { ok: false, error: "mdRendering must be an object" };
		const rendering: NonNullable<AppearanceSettings["mdRendering"]> = {};
		if (md.headingWeight !== undefined) {
			if (
				typeof md.headingWeight !== "number" ||
				!Number.isInteger(md.headingWeight) ||
				md.headingWeight < 100 ||
				md.headingWeight > 900
			) {
				return { ok: false, error: "mdRendering.headingWeight must be an integer between 100 and 900" };
			}
			rendering.headingWeight = md.headingWeight;
		}
		if (md.boldColor !== undefined) {
			const parsed = parseHexOrNull(md.boldColor, "mdRendering.boldColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.boldColor = parsed.color ?? null;
		}
		if (md.italicColor !== undefined) {
			const parsed = parseHexOrNull(md.italicColor, "mdRendering.italicColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.italicColor = parsed.color ?? null;
		}
		if (Object.keys(rendering).length) settings.mdRendering = rendering;
	}
	return { ok: true, settings };
}

/** graph: the collapsed section { enabled? } (wave 7, owner ruling
 *  2026-09-23): the master switch ONLY — the embedding/clustering/labeling
 *  rungs and the BYOK embeddingModel died with the provider embedder
 *  (clustering is the free birth-session partition, labels are session
 *  names). Old-shape keys in a body are ignored, not rejected. */
export function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	// Wave 7 collapse (owner ruling 2026-09-23) + the extraction-UX
	// redesign (2026-09-24): the section is the master switch and the
	// chunk budget. PUT is replace-whole — a body like {enabled: true} IS
	// the whole section (extractionChunkTokens absent = factory default at
	// resolution); the dead rungs' keys in old records are unread (the
	// sanitizer drops them; see sanitizeGraph).
	const settings: GraphSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		settings.enabled = raw.enabled;
	}
	if (raw.rendering !== undefined) {
		if (typeof raw.rendering !== "boolean") return { ok: false, error: "rendering must be a boolean" };
		settings.rendering = raw.rendering;
	}
	if (raw.extractionChunkTokens !== undefined) {
		if (typeof raw.extractionChunkTokens !== "number" || !Number.isFinite(raw.extractionChunkTokens)) {
			return { ok: false, error: "extractionChunkTokens must be a number" };
		}
		const floored = Math.floor(raw.extractionChunkTokens);
		if (floored < EXTRACTION_CHUNK_TOKENS_FLOOR) {
			// the floor's rationale lives on GraphSettings.extractionChunkTokens:
			// every run pays the graph-carrying prompt overhead — penny-batches
			// cost more per extracted token than the content is worth.
			return {
				ok: false,
				error: `extractionChunkTokens must be at least ${EXTRACTION_CHUNK_TOKENS_FLOOR} (smaller batches waste the per-run graph overhead)`,
			};
		}
		settings.extractionChunkTokens = floored;
	}
	return { ok: true, settings };
}

/** models: { strong?, cheap?, vision? } — the slot tiers (model slots
 *  wave, 2026-09-20). Each slot is the same shape as a role override; a
 *  present-but-empty slot object is rejected (absent slot = unset; say
 *  what you mean). Catalog validity is checked by the route
 *  (validateChatSettings discipline). */
export function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ModelsSettings = {};
	for (const key of Object.keys(raw)) {
		const known = MODEL_SLOTS as readonly string[];
		if (!known.includes(key)) {
			return { ok: false, error: `unknown slot "${key}" (supported: ${known.join(", ")})` };
		}
		const parsed = parseRoleOverride(raw[key], key);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		// BYOK (owner, 2026-09-22): a slot IS a model choice — no factory
		// floor exists, so a thinkingLevel alone can never run; every slot
		// write must carry the model (the level is an optional rider). An
		// absent slot key clears the tier (replace-whole section).
		if (!parsed.override.model) {
			return { ok: false, error: `slot "${key}" must set a model (thinkingLevel alone cannot run — absent slot = unset)` };
		}
		settings[key as (typeof MODEL_SLOTS)[number]] = parsed.override;
	}
	return { ok: true, settings };
}

/** compaction (owner round 14): the context-compaction threshold — the
 *  projected-token budget over which a session summarizes its own history
 *  into the compaction marker. Strict write side: a present
 *  thresholdTokens must be a number at or above the floor (the floor is
 *  anti-churn: each compaction keeps a ~20k-token recent tail, so a
 *  smaller threshold would re-summarize the tail it just wrote). Absent =
 *  factory default 150k at resolution. Replace-whole, like every
 *  section. */
export function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: CompactionSettings = {};
	if (raw.thresholdTokens !== undefined) {
		if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens)) {
			return { ok: false, error: "thresholdTokens must be a number" };
		}
		const floored = Math.floor(raw.thresholdTokens);
		if (floored < COMPACTION_THRESHOLD_FLOOR) {
			return {
				ok: false,
				error: `thresholdTokens must be at least ${COMPACTION_THRESHOLD_FLOOR} (compaction keeps a ~20k-token recent tail — smaller budgets would churn it)`,
			};
		}
		settings.thresholdTokens = floored;
	}
	return { ok: true, settings };
}

/** dictation: { language?: one of Nova-3's supported language codes } */
export function parseDictationSettingsBody(body: unknown): SettingsBodyResult<DictationSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	if (raw.language === undefined) return { ok: true, settings: {} };
	if (!isDictationLanguage(raw.language)) return { ok: false, error: "Unsupported dictation language" };
	return { ok: true, settings: { language: raw.language } };
}

/** obsidian (owner, 2026-11-01): { enabled?: boolean, vaultPath?: absolute
 *  path string, folders?: vault-relative folders, outputFolder?: vault-relative
 *  folder, obsidianFormat?: boolean }. Strict write side: a
 *  bad type or an escaping/relative folder is a 400, never a silent drop. */
export function parseObsidianSettingsBody(body: unknown): SettingsBodyResult<ObsidianSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ObsidianSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
		settings.enabled = raw.enabled;
	}
	if (raw.vaultPath !== undefined) {
		if (typeof raw.vaultPath !== "string") return { ok: false, error: "vaultPath must be a string" };
		const vaultPath = raw.vaultPath.trim();
		if (vaultPath !== "" && !vaultPath.startsWith("/")) return { ok: false, error: "vaultPath must be an absolute path" };
		settings.vaultPath = vaultPath;
	}
	if (raw.folders !== undefined) {
		if (!Array.isArray(raw.folders)) return { ok: false, error: "folders must be an array" };
		const folders: string[] = [];
		for (const folder of raw.folders) {
			const normalized = normalizeVaultFolder(folder);
			if (normalized === null) return { ok: false, error: `invalid vault folder: ${JSON.stringify(folder)}` };
			if (!folders.includes(normalized)) folders.push(normalized);
		}
		settings.folders = folders;
	}
	if (raw.outputFolder !== undefined) {
		const outputFolder = normalizeVaultFolder(raw.outputFolder);
		if (outputFolder === null) return { ok: false, error: `invalid output folder: ${JSON.stringify(raw.outputFolder)}` };
		settings.outputFolder = outputFolder;
	}
	if (raw.obsidianFormat !== undefined) {
		if (typeof raw.obsidianFormat !== "boolean") return { ok: false, error: "obsidianFormat must be a boolean" };
		settings.obsidianFormat = raw.obsidianFormat;
	}
	if (raw.confirmAboveRuns !== undefined) {
		if (!Number.isInteger(raw.confirmAboveRuns) || (raw.confirmAboveRuns as number) < CONFIRM_ABOVE_RUNS_MIN) {
			return { ok: false, error: `confirmAboveRuns must be an integer ≥ ${CONFIRM_ABOVE_RUNS_MIN}` };
		}
		settings.confirmAboveRuns = raw.confirmAboveRuns as number;
	}
	if (raw.suggestFolders !== undefined) {
		if (typeof raw.suggestFolders !== "boolean") return { ok: false, error: "suggestFolders must be a boolean" };
		settings.suggestFolders = raw.suggestFolders;
	}
	if (raw.inboxFolder !== undefined) {
		const inboxFolder = normalizeVaultFolder(raw.inboxFolder);
		if (inboxFolder === null) return { ok: false, error: `invalid inbox folder: ${JSON.stringify(raw.inboxFolder)}` };
		settings.inboxFolder = inboxFolder;
	}
	const output = settings.outputFolder;
	const inbox = settings.inboxFolder;
	if (output !== undefined && inbox !== undefined && (inbox === output || inbox.startsWith(`${output}/`) || output.startsWith(`${inbox}/`))) {
		return { ok: false, error: "the inbox folder and the output folder must not overlap" };
	}
	return { ok: true, settings };
}

/** The section→parser map for PUT /api/settings/[section] (the route also
 *  carries the special prompts sub-resource). */
/** review: every field optional; strict types and ranges (400 otherwise). */
export function parseReviewSettingsBody(body: unknown): SettingsBodyResult<ReviewSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ReviewSettings = {};
	if (raw.targetRetention !== undefined) {
		if (typeof raw.targetRetention !== "number" || !(raw.targetRetention >= REVIEW_RETENTION_MIN && raw.targetRetention <= REVIEW_RETENTION_MAX)) {
			return { ok: false, error: `targetRetention must be a number between ${REVIEW_RETENTION_MIN} and ${REVIEW_RETENTION_MAX}` };
		}
		settings.targetRetention = raw.targetRetention;
	}
	for (const field of ["digestTime", "eveningTime"] as const) {
		if (raw[field] === undefined) continue;
		const time = normalizeClockTime(raw[field]);
		if (!time) return { ok: false, error: `${field} must be "HH:MM"` };
		settings[field] = time;
	}
	const ints: Array<[keyof ReviewSettings & ("newPerDay" | "batchSize" | "confidenceThreshold"), number, number]> = [
		["newPerDay", 0, 500],
		["batchSize", 1, 50],
		["confidenceThreshold", 0, 100],
	];
	for (const [field, min, max] of ints) {
		const v = raw[field];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
			return { ok: false, error: `${field} must be an integer between ${min} and ${max}` };
		}
		settings[field] = v;
	}
	if (settings.digestTime && settings.eveningTime && settings.digestTime >= settings.eveningTime) {
		return { ok: false, error: "digestTime must be earlier than eveningTime" };
	}
	return { ok: true, settings };
}

/** desktop: { tray?: boolean, autostart?: boolean } */
export function parseDesktopSettingsBody(body: unknown): SettingsBodyResult<DesktopSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: DesktopSettings = {};
	for (const field of ["tray", "autostart"] as const) {
		if (raw[field] === undefined) continue;
		if (typeof raw[field] !== "boolean") return { ok: false, error: `${field} must be a boolean` };
		settings[field] = raw[field];
	}
	return { ok: true, settings };
}

/** phone: { enabled?: boolean } (owner, 2026-11-06). */
export function parsePhoneSettingsBody(body: unknown): SettingsBodyResult<PhoneSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	if (raw.enabled === undefined) return { ok: true, settings: {} };
	if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
	return { ok: true, settings: { enabled: raw.enabled } };
}

/** exams: every field optional; strict types and ranges (400 otherwise). */
export function parseExamSettingsBody(body: unknown): SettingsBodyResult<ExamSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings: ExamSettings = {};
	if (raw.weeklyMinutes !== undefined) {
		if (!isWeeklyMinutes(raw.weeklyMinutes)) return { ok: false, error: "weeklyMinutes must be 7 integers between 0 and 720 (Monday first)" };
		settings.weeklyMinutes = [...raw.weeklyMinutes];
	}
	for (const [field, min, max] of EXAM_INT_FIELDS) {
		const v = raw[field];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
			return { ok: false, error: `${field} must be an integer between ${min} and ${max}` };
		}
		settings[field] = v;
	}
	return { ok: true, settings };
}

export const SETTINGS_SECTIONS = {
	general: parseGeneralSettingsBody,
	chat: parseSettingsBody,
	agent: parseAgentSettingsBody,
	appearance: parseAppearanceSettingsBody,
	graph: parseGraphSettingsBody,
	compaction: parseCompactionSettingsBody,
	models: parseModelsSettingsBody,
	dictation: parseDictationSettingsBody,
	obsidian: parseObsidianSettingsBody,
	review: parseReviewSettingsBody,
	exams: parseExamSettingsBody,
	desktop: parseDesktopSettingsBody,
	phone: parsePhoneSettingsBody,
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;

/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./attachments.ts";
export * from "./phone.ts";
export * from "./graph.ts";
export * from "./cached-json.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths, readPromptOverride } from "../agent/prompt-segments.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./keys.ts";
export * from "./search.ts";
export { authStore } from "../store/auth.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export * from "./review.ts";
export * from "./exams.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
export { subscriptionControlsResponse, subscriptionBrowserResponse } from "./web-subscription-http.ts";
export { claudeCodeControlsResponse } from "./claude-code-http.ts";
export { sessionCost } from "./pricing.ts";
// The Obsidian connection (owner, 2026-11-01): overview for the settings
// section, settings-write reconfigure, and the «Resumir» button.
export { vaultOverview, reconfigureVault, startVaultSync, summarizeChatToVault, pendingDocuments, decidePendingDocument, failedNotes, retryFailedNote, inboxOverview, moveInboxNote, dismissInboxSuggestion, addInboxNote, type VaultOverview, type VaultFolder, type PendingDocument, type FailedNote, type InboxOverview, type InboxItem } from "./vault.ts";
export { documentText, isNoteFile, isDocumentFile, joinedText, NOTE_EXTENSIONS, type ConvertedDocument } from "./doc-text.ts";
// «Conexión MCP» (owner, 2026-11-08): the local write API for MCP clients.
export { reconfigureMcpApi, mcpApiStatus, regenerateMcpToken, type McpApiStatus } from "./mcp-api.ts";
export { listMcpDeletions, decideMcpDeletion } from "./mcp-deletions.ts";
// «Primeros pasos» / «Novedades» (owner, 2026-11-09).
export { onboardingResponse, onboardingDone, applyOnboarding } from "./onboarding.ts";
// Local Whisper dictation (owner, 2026-11-08): model downloads + file serving.
export { whisperModelStatuses, startWhisperDownload, cancelOrDeleteWhisperModel, whisperModelFile, type WhisperModelStatus } from "./whisper-models.ts";
export * from "./calendar.ts";

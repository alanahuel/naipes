/**
 * THE KNOWLEDGE-FOLDER CONNECTION (owner, 2026-11-01 as "Obsidian";
 * generalized to any folder 2026-11-04) — both directions between the app
 * and one folder of notes (an Obsidian vault or any plain folder), behind
 * the settings' `obsidian` section. Its `obsidianFormat` switch picks the
 * link style the app writes: `[[wikilinks]]` on, relative Markdown links off.
 *
 * VAULT → GRAPH. The chosen folders are read at server start and watched
 * live (fs.watch, recursive). A note is processed once it has been quiet
 * for QUIET_MS (Obsidian saves while you type). The state file remembers
 * each note's content hash, so an unchanged note costs nothing. Changes
 * REPLACE CLEANLY: the note's previous contribution (its notes source,
 * the same id the manual import would mint for that path) leaves the
 * graph before the new text is extracted; a deleted note's contribution
 * leaves with it — concepts shared with other sources survive (the
 * session-deletion "delete-nodes" semantics). A folder that is deselected
 * is simply no longer read; nothing is removed.
 *
 * APP → VAULT. Under the fixed output folder (core/vault-notes.ts — never
 * read back): one transcript per teaching session and one note per
 * practice session (rewritten after every turn), one note per graph
 * concept (rewritten when the graph changes), and an on-demand prose
 * summary per session (the «Resumir» button — a model call). Only the
 * marker zone and the app's frontmatter keys are ever rewritten.
 *
 * State lives on globalThis (the turn-liveness lesson: Next compiles
 * route entries as separate module instances — one
 * process, one watcher).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit, subscribe } from "../core/events.ts";
import { getGraph } from "../core/graph.ts";
import { deleteChatTraces } from "../core/graph-deletion.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import {
	VAULT_SUBFOLDERS,
	composeManagedNote,
	conceptNoteBody,
	inboxFolderOf,
	isInOutputFolder,
	restampManagedNote,
	managedZoneOf,
	noteLink,
	safeNoteName,
	summaryNoteBody,
	summaryProseOf,
	type FrontmatterFields,
} from "../core/vault-notes.ts";
import { estimateRuns, firstPageOf, type DocSegment } from "../core/doc-chunks.ts";
import { SUGGEST_ALTERNATIVES, folderOf, rankFolders } from "../core/inbox.ts";
import { documentText, isDocumentFile, isNoteFile, joinedText } from "./doc-text.ts";
import { scanNoteFiles } from "../store/vault-scan.ts";
import type { ChatRecord, GraphNode } from "../core/contracts.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { notesSourceId } from "../agent/subagents/extraction.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { extraction } from "./chat-handler.ts";
import { graphRevision } from "./graph.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";

/** A note is extracted once it has been quiet this long. */
export const QUIET_MS = 30_000;
/** Notes extracted at once (the extract stage has its own global cap). */
const WORKERS = 3;
const CHAT_EXPORT_DELAY_MS = 3_000;
const CONCEPT_EXPORT_DELAY_MS = 5_000;

/** The configured vault root, or null when none is set (there is no default:
 *  the folder is chosen once in Settings → Knowledge folder). */
function configuredRoot(vaultPath: string | undefined): string | null {
	return vaultPath ? path.resolve(vaultPath) : null;
}

const STATE_FILE = () => path.join(PATHS.data, "vault", "state.json");

// ─── persisted state ──────────────────────────────────────────────────────────

export interface VaultState {
	version: 1;
	/** The vault root these entries belong to (a root change starts over). */
	root: string;
	/** Synced vault notes: vault-relative path → content hash + source id. */
	notes: Record<string, { hash: string; sourceId: string }>;
	/** Transcript/practice note per chat (vault-relative path). */
	chats: Record<string, string>;
	/** Summary note per chat (vault-relative path). */
	summaries: Record<string, string>;
	/** Concept note path → node id. */
	concepts: Record<string, string>;
	/** Documents waiting for the user's «Leer» (over the confirmation
	 *  threshold; phase 2, 2026-11-04): path → the content it was estimated
	 *  for. `deferred` = «Ahora no» (no new notice until the file changes). */
	pending: Record<string, PendingDocument>;
	/** Path → content hash the user said «Leer» for (bypasses the threshold
	 *  for exactly that content). */
	confirmed: Record<string, string>;
	/** Inbox suggestions the user dismissed (phase 3): path → the content
	 *  and folder dismissed; hidden while both stay the same. */
	dismissed: Record<string, { hash: string; folder: string }>;
	/** Inbox suggestions already announced in the bell: path → "hash|folder". */
	suggested: Record<string, string>;
}

export interface PendingDocument {
	hash: string;
	/** Estimated extraction runs. */
	runs: number;
	/** PDF page count, when known. */
	pages?: number;
	deferred?: boolean;
}

function emptyState(root: string): VaultState {
	return { version: 1, root, notes: {}, chats: {}, summaries: {}, concepts: {}, pending: {}, confirmed: {}, dismissed: {}, suggested: {} };
}

function readState(root: string): VaultState {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf-8")) as Partial<VaultState>;
		if (parsed && parsed.version === 1 && parsed.root === root) {
			return {
				...emptyState(root),
				...parsed,
			} as VaultState;
		}
	} catch {
		/* absent or corrupt — start over (nothing is deleted from the graph) */
	}
	return emptyState(root);
}

function writeState(state: VaultState): void {
	fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
	const tmp = `${STATE_FILE()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"), "utf-8");
	fs.renameSync(tmp, STATE_FILE());
}

// ─── runtime (globalThis) ─────────────────────────────────────────────────────

interface VaultConfig {
	root: string;
	folders: string[];
	outputFolder: string;
	/** Link style of every note the app writes (see the header). */
	obsidianFormat: boolean;
	/** The inbox subfolder while «Sugerir dónde guardar» is on (phase 3);
	 *  null when off. Always read. */
	inboxFolder: string | null;
}

interface VaultRuntime {
	started: boolean;
	config: VaultConfig | null;
	state: VaultState | null;
	watcher: fs.FSWatcher | null;
	quiet: Map<string, NodeJS.Timeout>;
	queue: string[];
	running: Set<string>;
	/** A path changed again while it was being processed. */
	dirty: Set<string>;
	activeWorkers: number;
	chatTimers: Map<string, NodeJS.Timeout>;
	conceptTimer: NodeJS.Timeout | null;
	chatsTimer: NodeJS.Timeout | null;
	lastConceptRevision: number;
	lastError: string | null;
}

function runtime(): VaultRuntime {
	const g = globalThis as typeof globalThis & { __lhVault?: VaultRuntime };
	return (g.__lhVault ??= {
		started: false,
		config: null,
		state: null,
		watcher: null,
		quiet: new Map(),
		queue: [],
		running: new Set(),
		dirty: new Set(),
		activeWorkers: 0,
		chatTimers: new Map(),
		conceptTimer: null,
		chatsTimer: null,
		lastConceptRevision: -1,
		lastError: null,
	});
}

function currentConfig(): VaultConfig | null {
	const { obsidian } = effectiveSettings();
	if (!obsidian.enabled) return null;
	const root = configuredRoot(obsidian.vaultPath);
	if (!root) return null;
	try {
		if (!fs.statSync(root).isDirectory()) return null;
	} catch {
		return null;
	}
	const { outputFolder } = obsidian;
	const inboxFolder = inboxFolderOf(obsidian);
	const folders = obsidian.folders.filter((f) => !isInOutputFolder(f, outputFolder));
	// The inbox is always read, unless a selected folder already covers it.
	if (inboxFolder && !folders.some((f) => isInOutputFolder(inboxFolder, f))) folders.push(inboxFolder);
	return { root, folders, outputFolder, obsidianFormat: obsidian.obsidianFormat, inboxFolder };
}

function state(): VaultState | null {
	const rt = runtime();
	if (!rt.config) return null;
	if (!rt.state || rt.state.root !== rt.config.root) rt.state = readState(rt.config.root);
	return rt.state;
}

function saveState(): void {
	const s = runtime().state;
	if (s) writeState(s);
}

// ─── path rules ───────────────────────────────────────────────────────────────

/** The vault-relative folder the app writes into (the live config's, else the
 *  saved setting's). */
function outputFolder(): string {
	return runtime().config?.outputFolder ?? effectiveSettings().obsidian.outputFolder;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Is this vault-relative path a note the sync reads (Markdown or a
 *  document: .txt, .pdf, .docx, .epub)? */
export function isWatchedNote(relPath: string, folders: readonly string[], outputFolder: string): boolean {
	if (!isNoteFile(relPath)) return false;
	if (relPath.split("/").some((segment) => segment.startsWith("."))) return false;
	if (isInOutputFolder(relPath, outputFolder)) return false;
	return folders.some((folder) => relPath.startsWith(`${folder}/`));
}

function scanFolder(root: string, folder: string, outputFolder: string, out: string[]): void {
	out.push(...scanNoteFiles(root, folder, outputFolder));
}

/** Content hash over the file's BYTES (equal to the former UTF-8 text hash
 *  for every valid Markdown note, so existing state entries stay valid). */
const hashOf = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

// ─── vault → graph ────────────────────────────────────────────────────────────

/** Remove one notes source's whole contribution + its bookkeeping record. */
export function deleteSourceTraces(sourceId: string): void {
	deleteChatTraces(stores.graphStore, sourceId, "delete-nodes");
	stores.graphStore.deleteSource(sourceId);
}

// ─── note settlement (exams read unread folders first, owner 2026-11-06) ────

interface SettleHub {
	listeners: Set<(rel: string) => void>;
	/** Path → the last extraction error (cleared by a later success). */
	failed: Map<string, string>;
}

function settleHub(): SettleHub {
	const g = globalThis as typeof globalThis & { __npVaultSettle?: SettleHub };
	return (g.__npVaultSettle ??= { listeners: new Set(), failed: new Map() });
}

function settle(rel: string, error: string | null): void {
	const hub = settleHub();
	if (error === null) hub.failed.delete(rel);
	else hub.failed.set(rel, error);
	for (const listener of hub.listeners) {
		try {
			listener(rel);
		} catch (err) {
			console.error("[vault] settle listener failed:", err);
		}
	}
}

/** Called after each note's processing ends (success or failure). */
export function onVaultNoteSettled(listener: (rel: string) => void): () => void {
	const hub = settleHub();
	hub.listeners.add(listener);
	return () => hub.listeners.delete(listener);
}

/** Where one note stands: in the graph, failed, waiting for «Leer» (a
 *  big document), or not read yet. */
export function vaultNoteState(rel: string): { state: "done" | "failed" | "waiting" | "pending"; error?: string } {
	const s = state();
	if (s?.notes[rel]) return { state: "done" };
	const error = settleHub().failed.get(rel);
	if (error !== undefined) return { state: "failed", error };
	if (s?.pending[rel]) return { state: "waiting" };
	return { state: "pending" };
}

/** The knowledge folder's folder tree for the exam wizard (owner
 *  2026-11-06): every folder holding note files at any depth — hidden
 *  folders, the output folder and the inbox excluded — with recursive
 *  and direct counts of notes and of notes the connection does not read.
 *  null = no knowledge folder configured. */
export function vaultFolderTree(): { folders: Array<{ path: string; notes: number; unread: number; direct: number; directUnread: number }>; watched: string[] } | null {
	const { obsidian } = effectiveSettings();
	const root = configuredRoot(obsidian.vaultPath);
	if (!root) return null;
	try {
		if (!fs.statSync(root).isDirectory()) return null;
	} catch {
		return null;
	}
	const watched = obsidian.enabled ? obsidian.folders.filter((f) => !isInOutputFolder(f, obsidian.outputFolder)) : [];
	const inbox = obsidian.suggestFolders ? obsidian.inboxFolder : null;
	const counts = new Map<string, { notes: number; unread: number; direct: number; directUnread: number }>();
	const entryOf = (p: string) => {
		let e = counts.get(p);
		if (!e) counts.set(p, (e = { notes: 0, unread: 0, direct: 0, directUnread: 0 }));
		return e;
	};
	const walk = (rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (isInOutputFolder(child, obsidian.outputFolder)) continue;
			if (inbox && (child === inbox || child.startsWith(`${inbox}/`))) continue;
			if (entry.isDirectory()) walk(child);
			else if (rel && entry.isFile() && isNoteFile(entry.name)) {
				const unread = !watched.some((w) => child.startsWith(`${w}/`));
				const segs = rel.split("/");
				for (let i = 1; i <= segs.length; i++) {
					const e = entryOf(segs.slice(0, i).join("/"));
					e.notes++;
					if (unread) e.unread++;
				}
				const own = entryOf(rel);
				own.direct++;
				if (unread) own.directUnread++;
			}
		}
	};
	walk("");
	const folders = [...counts].map(([p, c]) => ({ path: p, ...c })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { folders, watched };
}

/** Every note file in the exam scope under the knowledge folder (paths
 *  vault-relative), for the read-before-mapping progress. */
export function vaultNotesUnder(folders: readonly string[]): string[] {
	const { obsidian } = effectiveSettings();
	const root = configuredRoot(obsidian.vaultPath);
	if (!root) return [];
	const out: string[] = [];
	for (const f of folders) scanFolder(root, f, obsidian.outputFolder, out);
	return [...new Set(out)];
}

function enqueue(rel: string): void {
	const rt = runtime();
	if (rt.running.has(rel)) {
		rt.dirty.add(rel);
		return;
	}
	if (!rt.queue.includes(rel)) rt.queue.push(rel);
	pump();
}

function pump(): void {
	const rt = runtime();
	while (rt.activeWorkers < WORKERS && rt.queue.length > 0) {
		const rel = rt.queue.shift()!;
		if (rt.running.has(rel)) {
			rt.dirty.add(rel);
			continue;
		}
		rt.activeWorkers++;
		rt.running.add(rel);
		void processNote(rel)
			.then(() => settle(rel, null))
			.catch((err) => {
				rt.lastError = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
				console.error(`[vault] ${rel} failed:`, err);
				settle(rel, err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				rt.running.delete(rel);
				rt.activeWorkers--;
				if (rt.dirty.delete(rel)) rt.queue.push(rel);
				pump();
			});
	}
}

async function processNote(rel: string): Promise<void> {
	const rt = runtime();
	const config = rt.config;
	const s = state();
	if (!config || !s) return;
	const abs = path.join(config.root, rel);
	const sourceId = notesSourceId(rel);
	let bytes: Buffer | null = null;
	try {
		bytes = fs.readFileSync(abs);
	} catch {
		bytes = null;
	}

	if (bytes === null) {
		// Moved (phase 3): the same content at a new, untracked path keeps
		// its ideas — re-key instead of removing anything.
		const known = s.notes[rel]?.hash ?? s.pending[rel]?.hash;
		const movedTo = known ? findUntrackedCopy(config, s, known) : null;
		if (movedTo) {
			rekeyNote(s, rel, movedTo);
			return;
		}
		// Deleted: its contribution leaves the graph.
		const hadPending = s.pending[rel] !== undefined || s.confirmed[rel] !== undefined;
		delete s.pending[rel];
		delete s.confirmed[rel];
		if (s.notes[rel]) {
			deleteSourceTraces(s.notes[rel].sourceId);
			delete s.notes[rel];
			saveState();
			console.info(`[vault] removed ${rel}`);
			scheduleConceptExport();
		} else if (hadPending) saveState();
		return;
	}

	const hash = hashOf(bytes);
	if (s.notes[rel]?.hash === hash) return; // unchanged — costs nothing
	if (s.pending[rel]?.hash === hash && s.confirmed[rel] !== hash) return; // still waiting for «Leer»

	// Moved here (phase 3): a known note with this exact content whose old
	// path is gone — re-key it, no extraction.
	if (!s.notes[rel] && !s.pending[rel]) {
		const from = [...Object.entries(s.notes), ...Object.entries(s.pending)].find(
			([other, entry]) => other !== rel && entry.hash === hash && !fs.existsSync(path.join(config.root, other)),
		)?.[0];
		if (from) {
			rekeyNote(s, from, rel);
			return;
		}
	}

	// Documents are converted (cached by hash) and gated by the
	// confirmation threshold BEFORE anything leaves the graph: a big file
	// waiting for «Leer» keeps its previous contribution.
	let text: string;
	let segments: DocSegment[] | undefined;
	if (isDocumentFile(rel)) {
		const doc = await documentText(rel, bytes, hash);
		segments = doc.segments;
		text = joinedText(doc);
		if (doc.ocr === "unavailable" && doc.imagePages.length > 0) {
			emit("vault-notice", { kind: "ocr-missing", path: rel, count: doc.imagePages.length });
		}
		const runs = estimateRuns(segments, effectiveSettings().graph.extractionChunkTokens);
		const threshold = effectiveSettings().obsidian.confirmAboveRuns;
		if (runs > threshold && s.confirmed[rel] !== hash) {
			if (s.pending[rel]?.hash !== hash) {
				s.pending[rel] = { hash, runs, ...(doc.pages !== undefined ? { pages: doc.pages } : {}) };
				saveState();
				emit("vault-notice", { kind: "pending", path: rel, runs, ...(doc.pages !== undefined ? { pages: doc.pages } : {}) });
				console.info(`[vault] ${rel}: ~${runs} runs — waiting for confirmation`);
			}
			return;
		}
	} else {
		text = bytes.toString("utf-8");
	}
	delete s.pending[rel];

	// Replace cleanly: whatever this path contributed before goes first.
	// A legacy manual import of the same file (imported by bare file name
	// before the vault connection existed) is adopted only AFTER the new
	// extraction succeeds (owner, 2026-11-02): a failed run must never
	// leave the graph without the old import.
	if (stores.graphStore.readSources().some((source) => source.id === sourceId)) deleteSourceTraces(sourceId);
	// A note moved earlier keeps its original source id (phase 3): that is
	// the contribution to replace.
	const previousSource = s.notes[rel]?.sourceId;
	if (previousSource && previousSource !== sourceId) deleteSourceTraces(previousSource);
	const base = rel.split("/").pop();
	const legacyIds = s.notes[rel]
		? []
		: stores.graphStore.readSources().filter((legacy) => legacy.filePath === base && legacy.id !== sourceId).map((legacy) => legacy.id);
	const adoptLegacy = () => {
		for (const id of legacyIds) deleteSourceTraces(id);
	};
	delete s.notes[rel];
	saveState();

	if (text.trim().length === 0) {
		adoptLegacy();
		s.notes[rel] = { hash, sourceId };
		saveState();
		return;
	}
	console.info(`[vault] extracting ${rel}`);
	await extraction.importNotes({ filePath: rel, text, ...(segments ? { segments } : {}) });
	adoptLegacy();
	s.notes[rel] = { hash, sourceId };
	delete s.confirmed[rel];
	saveState();
	scheduleConceptExport();
}

/** A watched file, not tracked yet, whose bytes hash to `hash` (the
 *  destination of a move). Only untracked files are hashed. */
function findUntrackedCopy(config: VaultConfig, s: VaultState, hash: string): string | null {
	const present: string[] = [];
	for (const folder of config.folders) scanFolder(config.root, folder, config.outputFolder, present);
	for (const candidate of new Set(present)) {
		if (s.notes[candidate] || s.pending[candidate]) continue;
		try {
			if (hashOf(fs.readFileSync(path.join(config.root, candidate))) === hash) return candidate;
		} catch {
			// vanished meanwhile
		}
	}
	return null;
}

/** Move a note's bookkeeping from `from` to `to` (phase 3): same source id,
 *  same ideas; the source record's file path (and so its area) follows. */
function rekeyNote(s: VaultState, from: string, to: string): void {
	for (const table of [s.notes, s.pending, s.confirmed, s.dismissed] as Array<Record<string, unknown>>) {
		if (table[from] !== undefined) {
			table[to] = table[from];
			delete table[from];
		}
	}
	delete s.suggested[from];
	const sourceId = s.notes[to]?.sourceId;
	const source = sourceId ? stores.graphStore.readSources().find((src) => src.id === sourceId) : undefined;
	if (source) stores.graphStore.upsertSource({ ...source, filePath: to });
	saveState();
	console.info(`[vault] moved ${from} → ${to} (no extraction)`);
	scheduleConceptExport();
}

// ─── the inbox (phase 3) ──────────────────────────────────────────────────────

const within = (rel: string, folder: string) => rel === folder || rel.startsWith(`${folder}/`);

/** Folders a note may move to: inside what is read, never the inbox or the
 *  output folder (and they exist). */
function destinationFolders(config: VaultConfig): string[] {
	const out = new Set<string>();
	const walk = (rel: string) => {
		if (config.inboxFolder && within(rel, config.inboxFolder)) return;
		if (isInOutputFolder(rel, config.outputFolder)) return;
		out.add(rel);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(config.root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) walk(`${rel}/${entry.name}`);
	};
	for (const folder of config.folders) walk(folder);
	return [...out].sort((a, b) => a.localeCompare(b));
}

export interface InboxItem {
	path: string;
	status: "suggested" | "none" | "pending" | "extracting" | "waiting";
	suggestion?: { folder: string; count: number; total: number };
	alternatives: Array<{ folder: string; count: number }>;
}

export interface InboxOverview {
	enabled: boolean;
	inbox: string | null;
	items: InboxItem[];
	/** Every folder «Elegir otra…» may offer. */
	destinations: string[];
}

function inboxFiles(config: VaultConfig): string[] {
	if (!config.inboxFolder) return [];
	const files: string[] = [];
	scanFolder(config.root, config.inboxFolder, config.outputFolder, files);
	return files.sort((a, b) => a.localeCompare(b));
}

/** The inbox with each note's suggestion (graph-only, core/inbox.ts). */
export function inboxOverview(): InboxOverview {
	const rt = runtime();
	const config = rt.config;
	const s = state();
	if (!config || !s || !config.inboxFolder) return { enabled: false, inbox: null, items: [], destinations: [] };
	const destinations = destinationFolders(config);
	const destinationSet = new Set(destinations);
	const graph = getGraph(stores.graphStore);
	const sourceFolder = new Map<string, string>();
	for (const [rel, entry] of Object.entries(s.notes)) {
		if (!within(rel, config.inboxFolder)) sourceFolder.set(entry.sourceId, folderOf(rel));
	}
	const items = inboxFiles(config).map((rel): InboxItem => {
		if (s.pending[rel]) return { path: rel, status: "pending", alternatives: [] };
		if (rt.running.has(rel) || rt.queue.includes(rel) || rt.quiet.has(rel)) return { path: rel, status: "extracting", alternatives: [] };
		const entry = s.notes[rel];
		if (!entry) return { path: rel, status: "waiting", alternatives: [] };
		const ranking = rankFolders(entry.sourceId, graph, sourceFolder, (folder) => destinationSet.has(folder));
		const dismissed = s.dismissed[rel];
		const hidden = ranking.suggestion && dismissed?.hash === entry.hash && dismissed.folder === ranking.suggestion.folder;
		if (!ranking.suggestion || hidden) {
			const alternatives = hidden ? [ranking.suggestion!, ...ranking.alternatives].slice(0, SUGGEST_ALTERNATIVES) : ranking.alternatives;
			return { path: rel, status: "none", alternatives };
		}
		return {
			path: rel,
			status: "suggested",
			suggestion: { ...ranking.suggestion, total: ranking.total },
			alternatives: ranking.alternatives,
		};
	});
	return { enabled: true, inbox: config.inboxFolder, items, destinations };
}

export type InboxActionResult = { ok: true; path?: string } | { ok: false; status: number; error: string };

/** «Mover»: the inbox note goes to `folder` (a destination); a name clash
 *  gets " (2)", " (3)"…; the bookkeeping follows at once (no extraction). */
export function moveInboxNote(rel: string, folder: string): InboxActionResult {
	const config = runtime().config;
	const s = state();
	if (!config || !s || !config.inboxFolder) return { ok: false, status: 409, error: "Folder suggestions are off." };
	if (!within(rel, config.inboxFolder) || !inboxFiles(config).includes(rel)) return { ok: false, status: 404, error: "That file is not in the inbox." };
	if (!destinationFolders(config).includes(folder)) return { ok: false, status: 400, error: "Notes can only move to a folder that is read (not the inbox or the output folder)." };
	const name = rel.split("/").pop()!;
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let to = `${folder}/${name}`;
	for (let n = 2; fs.existsSync(path.join(config.root, to)); n++) to = `${folder}/${stem} (${n})${ext}`;
	fs.renameSync(path.join(config.root, rel), path.join(config.root, to));
	if (s.notes[rel] || s.pending[rel]) rekeyNote(s, rel, to);
	return { ok: true, path: to };
}

/** A note an MCP client leaves in the inbox (owner, 2026-11-08): exactly
 *  «<title>.md» with the text as given — nothing marks its origin; a name
 *  clash gets " (2)", " (3)"…. The sync then reads it like any note. */
export function addInboxNote(title: string, content: string): InboxActionResult {
	const config = currentConfig();
	if (!config?.inboxFolder) return { ok: false, status: 409, error: "The knowledge folder's inbox is off (Settings → Connections → Knowledge folder → «Sugerir dónde guardar»)." };
	const dir = path.join(config.root, config.inboxFolder);
	fs.mkdirSync(dir, { recursive: true });
	const stem = safeNoteName(title);
	for (let n = 1; n < 1000; n++) {
		const rel = `${config.inboxFolder}/${n === 1 ? stem : `${stem} (${n})`}.md`;
		try {
			fs.writeFileSync(path.join(config.root, rel), content, { encoding: "utf-8", flag: "wx" });
			return { ok: true, path: rel };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	return { ok: false, status: 409, error: "Too many notes with that title in the inbox." };
}

/** «Descartar»: hide the current suggestion until the note or the winner changes. */
export function dismissInboxSuggestion(rel: string): InboxActionResult {
	const s = state();
	const item = inboxOverview().items.find((i) => i.path === rel);
	if (!s || !item) return { ok: false, status: 404, error: "That file is not in the inbox." };
	if (!item.suggestion || !s.notes[rel]) return { ok: false, status: 409, error: "There is no suggestion to dismiss." };
	s.dismissed[rel] = { hash: s.notes[rel].hash, folder: item.suggestion.folder };
	saveState();
	return { ok: true };
}

/** Announce NEW inbox suggestions in the bell — one coalesced count. */
function notifySuggestions(): void {
	const s = state();
	if (!s || !runtime().config?.inboxFolder) return;
	const visible = inboxOverview().items.filter((i) => i.status === "suggested");
	let fresh = false;
	const next: Record<string, string> = {};
	for (const item of visible) {
		const key = `${s.notes[item.path]?.hash ?? ""}|${item.suggestion!.folder}`;
		next[item.path] = key;
		if (s.suggested[item.path] !== key) fresh = true;
	}
	const changed = JSON.stringify(next) !== JSON.stringify(s.suggested);
	s.suggested = next;
	if (changed) saveState();
	if (fresh) emit("vault-notice", { kind: "suggestions", count: visible.length });
}

/** Documents waiting for «Leer» (Settings list; deferred ones included). */
export function pendingDocuments(): Array<{ path: string } & PendingDocument> {
	const s = state();
	if (!s) return [];
	return Object.entries(s.pending)
		.map(([rel, entry]) => ({ path: rel, ...entry }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** «Leer» (extract it now, whatever its size) or «Ahora no» (park it until
 *  the file changes). False = no such pending document. */
export function decidePendingDocument(rel: string, decision: "read" | "later"): boolean {
	const s = state();
	const entry = s?.pending[rel];
	if (!s || !entry) return false;
	if (decision === "later") {
		entry.deferred = true;
		saveState();
		return true;
	}
	s.confirmed[rel] = entry.hash;
	delete s.pending[rel];
	saveState();
	enqueue(rel);
	return true;
}

/** Compare the selected folders against the state file and queue every
 *  new, changed, or deleted note. */
function reconcileVault(): void {
	const rt = runtime();
	const config = rt.config;
	const s = state();
	if (!config || !s) return;
	const present: string[] = [];
	for (const folder of config.folders) scanFolder(config.root, folder, config.outputFolder, present);
	const presentSet = new Set(present);
	for (const rel of present) {
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(path.join(config.root, rel));
		} catch {
			continue;
		}
		const hash = hashOf(bytes);
		// A document already waiting for «Leer» with this content stays put.
		if (s.notes[rel]?.hash !== hash && s.pending[rel]?.hash !== hash) enqueue(rel);
	}
	for (const rel of [...Object.keys(s.notes), ...Object.keys(s.pending)]) {
		if (isWatchedNote(rel, config.folders, config.outputFolder) && !presentSet.has(rel)) enqueue(rel);
	}
}

function startWatcher(): void {
	const rt = runtime();
	const config = rt.config;
	if (!config || config.folders.length === 0) return;
	try {
		rt.watcher = fs.watch(config.root, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const rel = toPosix(filename.toString());
			if (!rt.config || !isWatchedNote(rel, rt.config.folders, rt.config.outputFolder)) return;
			const pending = rt.quiet.get(rel);
			if (pending) clearTimeout(pending);
			rt.quiet.set(
				rel,
				setTimeout(() => {
					rt.quiet.delete(rel);
					enqueue(rel);
				}, QUIET_MS),
			);
		});
		rt.watcher.on("error", (err) => {
			rt.lastError = `watcher: ${err.message}`;
			console.error("[vault] watcher failed:", err);
		});
	} catch (err) {
		rt.lastError = `watcher: ${err instanceof Error ? err.message : String(err)}`;
		console.error("[vault] could not watch the vault:", err);
	}
}

function stopWatcher(): void {
	const rt = runtime();
	rt.watcher?.close();
	rt.watcher = null;
	for (const timer of rt.quiet.values()) clearTimeout(timer);
	rt.quiet.clear();
	rt.queue.length = 0;
}

// ─── app → vault ──────────────────────────────────────────────────────────────

function writeIfChanged(abs: string, text: string): boolean {
	let current: string | null = null;
	try {
		current = fs.readFileSync(abs, "utf-8");
	} catch {
		current = null;
	}
	if (current === text) return false;
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.np-tmp`);
	fs.writeFileSync(tmp, text, "utf-8");
	fs.renameSync(tmp, abs);
	return true;
}

function readOrNull(abs: string): string | null {
	try {
		return fs.readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/** A unique vault-relative path for `name` in `folder`, given the paths
 *  already claimed by OTHER owners. */
function claimPath(folder: string, name: string, owner: string, claimed: Record<string, string>): string {
	const base = `${outputFolder()}/${folder}/${safeNoteName(name)}`;
	const taken = (rel: string) => claimed[rel] !== undefined && claimed[rel] !== owner;
	if (!taken(`${base}.md`)) return `${base}.md`;
	return `${base} (${owner.slice(-6)}).md`;
}

/** Move an owner's note when its title changed (the user zone travels). */
function relocate(root: string, from: string | undefined, to: string): void {
	if (!from || from === to) return;
	const src = path.join(root, from);
	const dst = path.join(root, to);
	if (fs.existsSync(src) && !fs.existsSync(dst)) {
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.renameSync(src, dst);
	}
}

/** A link written into the note at `fromRel`, in the configured style. */
function linkFrom(fromRel: string, toRel: string, label?: string, anchor?: string): string {
	return noteLink(runtime().config?.obsidianFormat ?? false, fromRel, toRel, label, anchor);
}

function conceptLinkOf(s: VaultState, fromRel: string, nodeId: string, fallback: string): string {
	const rel = Object.entries(s.concepts).find(([, id]) => id === nodeId)?.[0];
	return rel ? linkFrom(fromRel, rel, fallback) : fallback;
}

function chatConcepts(s: VaultState, fromRel: string, chatId: string, nodes: GraphNode[]): string[] {
	return nodes
		.filter((node) => node.provenance.some((pt) => pt.chatId === chatId))
		.map((node) => conceptLinkOf(s, fromRel, node.id, node.name));
}

function exportChat(chatId: string): void {
	const config = runtime().config;
	const s = state();
	if (!config || !s) return;
	const record = stores.chatStore.getChat(chatId);
	if (!record) return;
	const practice = record.kind === "practice";
	const owners = Object.fromEntries(Object.entries(s.chats).map(([id, rel]) => [rel, id]));
	const rel = claimPath(practice ? VAULT_SUBFOLDERS.practice : VAULT_SUBFOLDERS.transcripts, record.title, chatId, owners);
	relocate(config.root, s.chats[chatId], rel);
	const abs = path.join(config.root, rel);
	const concepts = chatConcepts(s, rel, chatId, getGraph(stores.graphStore).nodes);
	const body = [
		`# ${record.title}`,
		...(s.summaries[chatId] ? ["", `Resumen: ${linkFrom(rel, s.summaries[chatId], "resumen de la sesión")}`] : []),
		...(concepts.length > 0 ? ["", "## Conceptos", "", ...concepts.map((c) => `- ${c}`)] : []),
		"",
		"## Transcripción",
		"",
		sessionMarkdown(record.messages, { anchors: false }),
	].join("\n");
	const next = composeManagedNote(readOrNull(abs), chatFields(record, practice ? "practica" : "transcripcion"), body);
	if (next !== null) writeIfChanged(abs, next);
	if (s.chats[chatId] !== rel) {
		s.chats[chatId] = rel;
		saveState();
	}
}

function chatFields(record: ChatRecord, tipo: string): FrontmatterFields {
	return [
		["tipo", tipo],
		["sesion", record.id],
		["titulo", record.title],
		["creado", record.createdAt],
		["actualizado", record.updatedAt],
		["estado", "activa"],
		["tags", ["naipes", tipo]],
	];
}

/** Session notes whose session was deleted in the app get stamped. */
function reconcileChats(): void {
	const config = runtime().config;
	const s = state();
	if (!config || !s) return;
	const live = new Set(stores.chatStore.listChats().map((chat) => chat.id));
	for (const [chatId, rel] of [...Object.entries(s.chats), ...Object.entries(s.summaries)]) {
		if (live.has(chatId)) continue;
		const abs = path.join(config.root, rel);
		const current = readOrNull(abs);
		const next = current === null ? null : restampManagedNote(current, [["estado", "eliminada"]]);
		if (next !== null) writeIfChanged(abs, next);
	}
	for (const chatId of live) {
		const rel = s.chats[chatId];
		const record = stores.chatStore.getChat(chatId);
		if (!record) continue;
		const practice = record.kind === "practice";
		const owners = Object.fromEntries(Object.entries(s.chats).map(([id, r]) => [r, id]));
		const desired = claimPath(practice ? VAULT_SUBFOLDERS.practice : VAULT_SUBFOLDERS.transcripts, record.title, chatId, owners);
		if (rel !== desired) exportChat(chatId);
	}
}

function exportConcepts(): void {
	const config = runtime().config;
	const s = state();
	if (!config || !s) return;
	const graph = getGraph(stores.graphStore);
	const sourcePath = new Map(stores.graphStore.readSources().map((source) => [source.id, source.filePath]));
	const vaultSources = new Map(Object.entries(s.notes).map(([rel, entry]) => [entry.sourceId, rel]));
	const titles = new Map(stores.chatStore.listChats().map((chat) => [chat.id, chat.title]));

	// 1. Paths: oldest concept keeps the plain name; a stale note with the
	//    same name is reused (re-extraction mints new ids for old ideas).
	const nodes = [...graph.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const next: Record<string, string> = {};
	for (const node of nodes) {
		const plain = `${config.outputFolder}/${VAULT_SUBFOLDERS.concepts}/${safeNoteName(node.name)}.md`;
		const rel = next[plain] === undefined ? plain : claimPath(VAULT_SUBFOLDERS.concepts, node.name, node.id, next);
		next[rel] = node.id;
	}
	const previous = s.concepts;
	s.concepts = next;
	// 2. Write every live concept.
	for (const [rel, nodeId] of Object.entries(next)) {
		const node = graph.nodes.find((n) => n.id === nodeId)!;
		const link = (id: string) => conceptLinkOf(s, rel, id, graph.nodes.find((n) => n.id === id)?.name ?? id);
		const sources: string[] = [];
		for (const chatId of new Set(node.provenance.map((pt) => pt.chatId))) {
			const vaultRel = vaultSources.get(chatId);
			// Document locations (phase 2): one source line per page range /
			// chapter, linked to the first page where the file is a PDF.
			const locs = [...new Set(node.provenance.filter((pt) => pt.chatId === chatId && pt.loc).map((pt) => pt.loc!))];
			if (vaultRel && locs.length > 0) {
				const name = vaultRel.split("/").pop()!;
				for (const loc of locs) {
					const page = /\.pdf$/i.test(vaultRel) ? firstPageOf(loc) : null;
					sources.push(linkFrom(rel, vaultRel, `${name}, ${loc}`, page !== null ? `page=${page}` : undefined));
				}
			} else if (vaultRel) sources.push(linkFrom(rel, vaultRel));
			else if (s.chats[chatId]) sources.push(linkFrom(rel, s.chats[chatId], titles.get(chatId)));
			else if (sourcePath.has(chatId)) {
				const file = sourcePath.get(chatId)!;
				if (locs.length > 0) for (const loc of locs) sources.push(`${file}, ${loc}`);
				else sources.push(file);
			}
			else if (titles.has(chatId)) sources.push(titles.get(chatId)!);
		}
		const body = conceptNoteBody({
			id: node.id,
			name: node.name,
			statement: node.statement,
			aliases: node.aliases,
			derivedFrom: graph.chains.filter((c) => c.conclusion === node.id).map((c) => c.premises.map(link)),
			leadsTo: graph.chains
				.filter((c) => c.premises.includes(node.id))
				.map((c) => ({ conclusion: link(c.conclusion), together: c.premises.filter((p) => p !== node.id).map(link) })),
			sources,
		});
		const abs = path.join(config.root, rel);
		const fields: FrontmatterFields = [
			["tipo", "concepto"],
			["concepto", node.id],
			["aliases", node.aliases.filter((a) => a.length <= 120)],
			["creado", node.createdAt],
			["estado", "activo"],
			["tags", ["naipes", "concepto"]],
		];
		const text = composeManagedNote(readOrNull(abs), fields, body);
		if (text !== null) writeIfChanged(abs, text);
	}

	// 3. Notes whose concept left the graph (and were not reused) get stamped.
	for (const rel of Object.keys(previous)) {
		if (next[rel] !== undefined) continue;
		const abs = path.join(config.root, rel);
		const current = readOrNull(abs);
		const stamped = current === null ? null : restampManagedNote(current, [["estado", "eliminado"]]);
		if (stamped !== null) writeIfChanged(abs, stamped);
	}
	saveState();

	// Session notes list their concepts — refresh them against the new paths.
	for (const chatId of Object.keys(s.chats)) exportChat(chatId);
	// The graph changed: inbox suggestions may have appeared (phase 3).
	notifySuggestions();
}

function scheduleChatExport(chatId: string): void {
	const rt = runtime();
	if (!rt.config) return;
	const pending = rt.chatTimers.get(chatId);
	if (pending) clearTimeout(pending);
	rt.chatTimers.set(
		chatId,
		setTimeout(() => {
			rt.chatTimers.delete(chatId);
			guard(`export ${chatId}`, () => exportChat(chatId));
		}, CHAT_EXPORT_DELAY_MS),
	);
}

function scheduleConceptExport(): void {
	const rt = runtime();
	if (!rt.config) return;
	if (rt.conceptTimer) clearTimeout(rt.conceptTimer);
	rt.conceptTimer = setTimeout(() => {
		rt.conceptTimer = null;
		const revision = graphRevision();
		if (revision === rt.lastConceptRevision) return;
		rt.lastConceptRevision = revision;
		guard("export concepts", exportConcepts);
	}, CONCEPT_EXPORT_DELAY_MS);
}

function scheduleChatsReconcile(): void {
	const rt = runtime();
	if (!rt.config) return;
	if (rt.chatsTimer) clearTimeout(rt.chatsTimer);
	rt.chatsTimer = setTimeout(() => {
		rt.chatsTimer = null;
		guard("reconcile chats", reconcileChats);
	}, CHAT_EXPORT_DELAY_MS);
}

function guard(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		runtime().lastError = `${label}: ${err instanceof Error ? err.message : String(err)}`;
		console.error(`[vault] ${label} failed:`, err);
	}
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

/** Boot entry (GET /api/events — every window opens it on load):
 *  subscribe once, then apply settings. Never under the test runner. */
export function startVaultSync(): void {
	const rt = runtime();
	if (rt.started || process.env.NODE_ENV === "test") return;
	rt.started = true;
	subscribe((event) => {
		if (!runtime().config) return;
		if (event.type === "turn-settled" || event.type === "record-changed") {
			const chatId = (event as { chatId?: unknown }).chatId;
			if (typeof chatId === "string") scheduleChatExport(chatId);
		}
		else if (event.type === "chats-changed") scheduleChatsReconcile();
		else if (event.type === "activity-changed") scheduleConceptExport();
	});
	// The first sync waits for the connection catalogs (owner, 2026-11-02):
	// at boot the Claude Code / ChatGPT / subscription models are not known
	// yet, and every note would fail with "catalog has no model".
	void refreshConnectionCatalog()
		.catch((err) => console.error("[vault] catalog refresh failed:", err))
		.finally(() => reconfigureVault());
}

/** Re-read the settings: restart the watcher, reconcile the folders, and
 *  bring every exported note up to date. Called on boot and after every
 *  write of the `obsidian` settings section. */
export function reconfigureVault(): void {
	const rt = runtime();
	stopWatcher();
	rt.config = currentConfig();
	rt.lastError = null;
	if (!rt.config) return;
	// «Sugerir dónde guardar» on: the inbox exists (phase 3).
	if (rt.config.inboxFolder) fs.mkdirSync(path.join(rt.config.root, rt.config.inboxFolder), { recursive: true });
	startWatcher();
	guard("reconcile vault", reconcileVault);
	rt.lastConceptRevision = -1;
	guard("export concepts", exportConcepts);
	guard("export chats", () => {
		for (const chat of stores.chatStore.listChats()) exportChat(chat.id);
	});
	guard("reconcile chats", reconcileChats);
	guard("refresh summaries", refreshSummaries);
}

/** Rebuild the link lists of every summary note of a live session (owner,
 *  2026-11-04): the model's prose is kept byte for byte, only the concept
 *  and transcript links follow the current link style and paths. No model
 *  call; a note the user took over (markers removed) is left alone. */
function refreshSummaries(): void {
	const config = runtime().config;
	const s = state();
	if (!config || !s) return;
	const nodes = getGraph(stores.graphStore).nodes;
	for (const [chatId, rel] of Object.entries(s.summaries)) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) continue;
		const abs = path.join(config.root, rel);
		const current = readOrNull(abs);
		const zone = current === null ? null : managedZoneOf(current);
		if (current === null || zone === null) continue;
		const newline = zone.indexOf("\n");
		const title = zone.startsWith("# ") ? zone.slice(2, newline === -1 ? undefined : newline) : record.title;
		const body = summaryNoteBody(
			title,
			summaryProseOf(zone),
			chatConcepts(s, rel, chatId, nodes),
			s.chats[chatId] ? linkFrom(rel, s.chats[chatId], record.title) : null,
		);
		const next = composeManagedNote(current, [], body);
		if (next !== null) writeIfChanged(abs, next);
	}
}

// ─── settings UI support ──────────────────────────────────────────────────────

export interface VaultFolder {
	/** Vault-relative POSIX path. */
	path: string;
	/** Readable files inside — notes and documents (recursive, output
	 *  folder excluded). */
	notes: number;
	children: VaultFolder[];
}

export interface VaultOverview {
	root: string;
	exists: boolean;
	folders: VaultFolder[];
	outputFolder: string;
	status: { enabled: boolean; watching: boolean; queued: number; running: number; synced: number; lastError: string | null };
	/** Documents waiting for «Leer». */
	pending: Array<{ path: string } & PendingDocument>;
}

/** The vault's folder tree two levels deep (for the folder checkboxes). */
export function vaultOverview(requestedRoot?: string): VaultOverview {
	const rt = runtime();
	const root = configuredRoot(requestedRoot || effectiveSettings().obsidian.vaultPath) ?? "";
	const out = effectiveSettings().obsidian.outputFolder;
	let exists = false;
	try {
		exists = root !== "" && fs.statSync(root).isDirectory();
	} catch {
		exists = false;
	}
	const list = (rel: string, depth: number): VaultFolder[] => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => (rel ? `${rel}/${e.name}` : e.name))
			.filter((child) => !isInOutputFolder(child, out))
			.sort((a, b) => a.localeCompare(b))
			.map((child) => {
				const notes: string[] = [];
				scanFolder(root, child, out, notes);
				return { path: child, notes: notes.length, children: depth < 2 ? list(child, depth + 1) : [] };
			});
	};
	return {
		root,
		exists,
		folders: exists ? list("", 1) : [],
		outputFolder: out,
		status: {
			enabled: rt.config !== null,
			watching: rt.watcher !== null,
			queued: rt.queue.length + rt.quiet.size,
			running: rt.running.size,
			synced: rt.config ? Object.keys(state()?.notes ?? {}).length : 0,
			lastError: rt.lastError,
		},
		pending: rt.config ? pendingDocuments() : [],
	};
}

// ─── the «Resumir» button ─────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You write the summary note a learner keeps in their notes folder after a learning session.
Write it in the language the session itself is held in. Plain prose paragraphs, no title (the note
already has one): what the session set out to understand, the core ideas that were built and how
they connect, where the learner struggled or changed their mind, and what remains open. Be faithful
to the transcript — do not add material it does not contain. Return only the summary text.`;

export type VaultSummaryOutcome =
	| { ok: true; file: string }
	| { ok: false; status: number; error: string; code?: string };

export async function summarizeChatToVault(chatId: string): Promise<VaultSummaryOutcome> {
	const rt = runtime();
	if (!rt.config) rt.config = currentConfig();
	const config = rt.config;
	const s = state();
	if (!config || !s) return { ok: false, status: 409, error: "The knowledge-folder connection is off (Settings → Connections → Knowledge folder)." };
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Unknown chat" };

	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, ...modelsNotConfigured(["cheap"]) };
	if (!providerKeyPresent(spec.provider)) return { ok: false, status: 503, ...providerKeyMissing(spec.provider, ["cheap"]) };

	const transcript = sessionMarkdown(record.messages, { title: record.title, anchors: false });
	const { text, newMessages } = await runSubagent([], {
		role: "extractor",
		engine: piEngineForSpec(spec),
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		prompt: transcript,
		maxTurns: 1,
	});
	if (newMessages.some((m) => m.role === "assistant" && m.stopReason === "length")) {
		return { ok: false, status: 502, error: "The summary hit the output limit — try again." };
	}
	const summary = text.trim();
	if (!summary) return { ok: false, status: 502, error: "The model returned an empty summary." };

	const owners = Object.fromEntries(Object.entries(s.summaries).map(([id, rel]) => [rel, id]));
	const rel = claimPath(VAULT_SUBFOLDERS.sessions, record.title, chatId, owners);
	relocate(config.root, s.summaries[chatId], rel);
	const concepts = chatConcepts(s, rel, chatId, getGraph(stores.graphStore).nodes);
	const body = summaryNoteBody(record.title, summary, concepts, s.chats[chatId] ? linkFrom(rel, s.chats[chatId], record.title) : null);
	const abs = path.join(config.root, rel);
	const fields: FrontmatterFields = [
		["tipo", "resumen-sesion"],
		["sesion", record.id],
		["titulo", record.title],
		["resumido", new Date().toISOString()],
		["estado", "activa"],
		["tags", ["naipes", "resumen-sesion"]],
	];
	const next = composeManagedNote(readOrNull(abs), fields, body);
	if (next === null) return { ok: false, status: 409, error: `${rel} is no longer managed by the app (its markers were removed).` };
	writeIfChanged(abs, next);
	s.summaries[chatId] = rel;
	saveState();
	exportChat(chatId); // the transcript links back to the summary
	return { ok: true, file: rel };
}

// ─── test seams ───────────────────────────────────────────────────────────────

/** Resolves once no note is queued or being extracted (quiet timers aside). */
export async function whenVaultIdle(): Promise<void> {
	const rt = runtime();
	while (rt.queue.length > 0 || rt.running.size > 0) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Stop watching and forget the configuration (tests; app shutdown). */
export function stopVaultSync(): void {
	const rt = runtime();
	stopWatcher();
	for (const timer of rt.chatTimers.values()) clearTimeout(timer);
	rt.chatTimers.clear();
	if (rt.conceptTimer) clearTimeout(rt.conceptTimer);
	if (rt.chatsTimer) clearTimeout(rt.chatsTimer);
	rt.conceptTimer = null;
	rt.chatsTimer = null;
	rt.config = null;
}

/** Process one path right now, bypassing the queue (tests: the order of a
 *  move's two events). */
export async function syncPathNow(rel: string): Promise<void> {
	await processNote(rel);
}

/** Run the concept + session export now (tests; the scheduled path debounces). */
export function exportVaultNow(): void {
	guard("export concepts", exportConcepts);
	guard("reconcile chats", reconcileChats);
}

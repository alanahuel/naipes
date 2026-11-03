/**
 * THE OBSIDIAN CONNECTION (owner, 2026-11-01) — both directions between the
 * app and one Obsidian vault, behind the settings' `obsidian` section.
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
import { subscribe } from "../core/events.ts";
import { getGraph } from "../core/graph.ts";
import { deleteChatTraces } from "../core/graph-deletion.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import {
	VAULT_SUBFOLDERS,
	composeManagedNote,
	conceptNoteBody,
	isInOutputFolder,
	restampManagedNote,
	safeNoteName,
	wikilink,
	type FrontmatterFields,
} from "../core/vault-notes.ts";
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
 *  the vault is chosen once in Settings → Obsidian). */
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
}

function emptyState(root: string): VaultState {
	return { version: 1, root, notes: {}, chats: {}, summaries: {}, concepts: {} };
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
	return { root, folders: obsidian.folders.filter((f) => !isInOutputFolder(f, outputFolder)), outputFolder };
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

/** Is this vault-relative path a note the sync reads? */
export function isWatchedNote(relPath: string, folders: readonly string[], outputFolder: string): boolean {
	if (!/\.md$/i.test(relPath)) return false;
	if (relPath.split("/").some((segment) => segment.startsWith("."))) return false;
	if (isInOutputFolder(relPath, outputFolder)) return false;
	return folders.some((folder) => relPath.startsWith(`${folder}/`));
}

function scanFolder(root: string, folder: string, outputFolder: string, out: string[]): void {
	const walk = (rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const child = `${rel}/${entry.name}`;
			if (isInOutputFolder(child, outputFolder)) continue;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(child);
		}
	};
	walk(folder);
}

const hashOf = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

// ─── vault → graph ────────────────────────────────────────────────────────────

/** Remove one notes source's whole contribution + its bookkeeping record. */
export function deleteSourceTraces(sourceId: string): void {
	deleteChatTraces(stores.graphStore, sourceId, "delete-nodes");
	stores.graphStore.deleteSource(sourceId);
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
			.catch((err) => {
				rt.lastError = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
				console.error(`[vault] ${rel} failed:`, err);
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
	let text: string | null = null;
	try {
		text = fs.readFileSync(abs, "utf-8");
	} catch {
		text = null;
	}

	if (text === null) {
		// Deleted (or moved away): its contribution leaves the graph.
		if (s.notes[rel]) {
			deleteSourceTraces(s.notes[rel].sourceId);
			delete s.notes[rel];
			saveState();
			console.info(`[vault] removed ${rel}`);
			scheduleConceptExport();
		}
		return;
	}

	const hash = hashOf(text);
	if (s.notes[rel]?.hash === hash) return; // unchanged — costs nothing

	// Replace cleanly: whatever this path contributed before goes first.
	// A legacy manual import of the same file (imported by bare file name
	// before the vault connection existed) is adopted only AFTER the new
	// extraction succeeds (owner, 2026-11-02): a failed run must never
	// leave the graph without the old import.
	if (stores.graphStore.readSources().some((source) => source.id === sourceId)) deleteSourceTraces(sourceId);
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
	await extraction.importNotes({ filePath: rel, text });
	adoptLegacy();
	s.notes[rel] = { hash, sourceId };
	saveState();
	scheduleConceptExport();
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
		let text: string;
		try {
			text = fs.readFileSync(path.join(config.root, rel), "utf-8");
		} catch {
			continue;
		}
		if (s.notes[rel]?.hash !== hashOf(text)) enqueue(rel);
	}
	for (const rel of Object.keys(s.notes)) {
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

function conceptLinkOf(s: VaultState, nodeId: string, fallback: string): string {
	const rel = Object.entries(s.concepts).find(([, id]) => id === nodeId)?.[0];
	return rel ? wikilink(rel, fallback) : fallback;
}

function chatConcepts(s: VaultState, chatId: string, nodes: GraphNode[]): string[] {
	return nodes
		.filter((node) => node.provenance.some((pt) => pt.chatId === chatId))
		.map((node) => conceptLinkOf(s, node.id, node.name));
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
	const concepts = chatConcepts(s, chatId, getGraph(stores.graphStore).nodes);
	const body = [
		`# ${record.title}`,
		...(s.summaries[chatId] ? ["", `Resumen: ${wikilink(s.summaries[chatId], "resumen de la sesión")}`] : []),
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
	const link = (nodeId: string) => {
		const node = graph.nodes.find((n) => n.id === nodeId);
		return conceptLinkOf(s, nodeId, node?.name ?? nodeId);
	};

	// 2. Write every live concept.
	for (const [rel, nodeId] of Object.entries(next)) {
		const node = graph.nodes.find((n) => n.id === nodeId)!;
		const sources: string[] = [];
		for (const chatId of new Set(node.provenance.map((pt) => pt.chatId))) {
			const vaultRel = vaultSources.get(chatId);
			if (vaultRel) sources.push(wikilink(vaultRel));
			else if (s.chats[chatId]) sources.push(wikilink(s.chats[chatId], titles.get(chatId)));
			else if (sourcePath.has(chatId)) sources.push(sourcePath.get(chatId)!);
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
	startWatcher();
	guard("reconcile vault", reconcileVault);
	rt.lastConceptRevision = -1;
	guard("export concepts", exportConcepts);
	guard("export chats", () => {
		for (const chat of stores.chatStore.listChats()) exportChat(chat.id);
	});
	guard("reconcile chats", reconcileChats);
}

// ─── settings UI support ──────────────────────────────────────────────────────

export interface VaultFolder {
	/** Vault-relative POSIX path. */
	path: string;
	/** Markdown notes inside (recursive, output folder excluded). */
	notes: number;
	children: VaultFolder[];
}

export interface VaultOverview {
	root: string;
	exists: boolean;
	folders: VaultFolder[];
	outputFolder: string;
	status: { enabled: boolean; watching: boolean; queued: number; running: number; synced: number; lastError: string | null };
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
	};
}

// ─── the «Resumir» button ─────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You write the summary note a learner keeps in their Obsidian vault after a learning session.
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
	if (!config || !s) return { ok: false, status: 409, error: "The Obsidian connection is off (Settings → Obsidian)." };
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
	const concepts = chatConcepts(s, chatId, getGraph(stores.graphStore).nodes);
	const body = [
		`# ${record.title}`,
		"",
		summary,
		...(concepts.length > 0 ? ["", "## Conceptos", "", ...concepts.map((c) => `- ${c}`)] : []),
		...(s.chats[chatId] ? ["", "## Transcripción", "", `- ${wikilink(s.chats[chatId], record.title)}`] : []),
	].join("\n");
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

/** Run the concept + session export now (tests; the scheduled path debounces). */
export function exportVaultNow(): void {
	guard("export concepts", exportConcepts);
	guard("reconcile chats", reconcileChats);
}

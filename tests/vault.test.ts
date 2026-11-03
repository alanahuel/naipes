/**
 * The Obsidian connection (owner, 2026-11-01): the pure note format
 * (core/vault-notes.ts), the settings section, and the sync/export loop
 * (server/vault.ts) against a temp vault + temp data dir. The extraction
 * pipeline is faked at its importNotes seam: no model, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "np-vault-data-"));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), "np-vault-root-"));
/** The output folder sits inside a watched folder, so exclusion is exercised. */
const OUT = "Recursos/Naipes";
process.env.NP_DATA_DIR = TMP_DATA;

import {
	MARK_END,
	MARK_START,
	USER_ZONE,
	DEFAULT_VAULT_OUTPUT_FOLDER,
	composeManagedNote,
	isInOutputFolder,
	managedZoneOf,
	restampManagedNote,
	safeNoteName,
	wikilink,
} from "../src/core/vault-notes.ts";
import { normalizeVaultFolder, sanitizeUserSettings } from "../src/core/settings.ts";

describe("vault note format", () => {
	it("mints a new note with frontmatter, the app zone and the user zone", () => {
		const text = composeManagedNote(null, [["tipo", "concepto"], ["tags", ["naipes", "concepto"]]], "# Idea\n\nCuerpo")!;
		assert.ok(text.startsWith('---\ntipo: "concepto"\ntags:\n  - "naipes"\n  - "concepto"\n---\n'));
		assert.ok(text.includes(`${MARK_START}\n# Idea\n\nCuerpo\n${MARK_END}`));
		assert.ok(text.trimEnd().endsWith(USER_ZONE));
	});

	it("rewrites only the app zone and the app's keys — user text and keys survive", () => {
		const first = composeManagedNote(null, [["tipo", "concepto"], ["estado", "activo"]], "viejo")!;
		const edited = first
			.replace("---\n", '---\nmi_clave: "mía"\n')
			.replace(`${USER_ZONE}\n\n`, `${USER_ZONE}\n\nMi reflexión personal.\n`);
		const next = composeManagedNote(edited, [["tipo", "concepto"], ["estado", "activo"]], "nuevo")!;
		assert.equal(managedZoneOf(next), "nuevo");
		assert.ok(next.includes("Mi reflexión personal."), "user zone kept");
		assert.ok(next.includes('mi_clave: "mía"'), "user frontmatter key kept");
		assert.equal(next.match(/tipo:/g)?.length, 1, "app key not duplicated");
	});

	it("leaves a note alone once its markers are removed", () => {
		const first = composeManagedNote(null, [["tipo", "concepto"]], "x")!;
		assert.equal(composeManagedNote(first.replace(MARK_END, ""), [["tipo", "concepto"]], "y"), null);
		assert.equal(restampManagedNote(first.replace(MARK_START, ""), [["estado", "eliminado"]]), null);
	});

	it("restamps frontmatter without touching either zone", () => {
		const first = composeManagedNote(null, [["tipo", "transcripcion"], ["estado", "activa"]], "cuerpo")!;
		const stamped = restampManagedNote(first, [["estado", "eliminada"]])!;
		assert.ok(stamped.includes('estado: "eliminada"'));
		assert.ok(!stamped.includes('estado: "activa"'));
		assert.equal(stamped.slice(stamped.indexOf(MARK_START)), first.slice(first.indexOf(MARK_START)));
	});

	it("adopts notes written with the pre-rename learnharness markers", () => {
		const legacy = `---\ntipo: "concepto"\n---\n<!-- learnharness:inicio -->\nViejo\n<!-- learnharness:fin -->\n\n## Mis notas\n\nMío\n`;
		assert.equal(managedZoneOf(legacy), "Viejo");
		const next = composeManagedNote(legacy, [["tipo", "concepto"]], "Nuevo")!;
		assert.ok(next.includes(`${MARK_START}\nNuevo\n${MARK_END}`));
		assert.ok(!next.includes("learnharness:"));
		assert.ok(next.endsWith("## Mis notas\n\nMío\n"));
		assert.ok(restampManagedNote(legacy, [["estado", "eliminada"]])?.includes("<!-- learnharness:inicio -->\nViejo"));
	});

	it("makes safe file names and path links", () => {
		assert.equal(safeNoteName('A/B: "C" [d] #e?'), "A B C d e");
		assert.equal(safeNoteName("   "), "Sin título");
		assert.equal(wikilink("x/y/Nota.md", "Nota"), "[[x/y/Nota|Nota]]");
		assert.equal(DEFAULT_VAULT_OUTPUT_FOLDER, "Naipes");
		assert.ok(isInOutputFolder(`${OUT}/Conceptos/a.md`, OUT));
		assert.ok(!isInOutputFolder("Recursos/other.md", OUT));
		assert.ok(!isInOutputFolder(`${OUT}-old/a.md`, OUT));
	});
});

describe("obsidian settings section", () => {
	it("normalizes folders and refuses escapes", () => {
		assert.equal(normalizeVaultFolder("/a//b/"), "a/b");
		assert.equal(normalizeVaultFolder("a/../b"), null);
		assert.equal(normalizeVaultFolder(""), null);
		const record = sanitizeUserSettings({ version: 1, obsidian: { enabled: true, vaultPath: " /v ", folders: ["a", "a", "../x"], outputFolder: "/Out//Dir/" } });
		assert.deepEqual(record?.obsidian, { enabled: true, vaultPath: "/v", folders: ["a"], outputFolder: "Out/Dir" });
	});

	it("rejects bad PUT bodies", async () => {
		const { parseObsidianSettingsBody } = await import("../src/server/settings-body.ts");
		assert.equal(parseObsidianSettingsBody({ vaultPath: "relative" }).ok, false);
		assert.equal(parseObsidianSettingsBody({ outputFolder: "../escape" }).ok, false);
		assert.equal(parseObsidianSettingsBody({ folders: ["../escape"] }).ok, false);
		assert.deepEqual(parseObsidianSettingsBody({ enabled: true, folders: ["a/"] }), { ok: true, settings: { enabled: true, folders: ["a"] } });
	});
});

// ── the sync/export loop ─────────────────────────────────────────────────────

type VaultModule = typeof import("../src/server/vault.ts");
let vault: VaultModule;
let stores: typeof import("../src/server/stores.ts").stores;
let imports: Array<{ filePath: string; text: string }>;

function write(rel: string, text: string): void {
	const abs = path.join(VAULT, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
}

before(async () => {
	fs.writeFileSync(
		path.join(TMP_DATA, "settings.json"),
		JSON.stringify({ version: 1, obsidian: { enabled: true, vaultPath: VAULT, folders: ["Notas", "Recursos"], outputFolder: OUT } }),
	);
	const handler = await import("../src/server/chat-handler.ts");
	const { notesSourceId } = await import("../src/agent/subagents/extraction.ts");
	stores = (await import("../src/server/stores.ts")).stores;
	vault = await import("../src/server/vault.ts");
	// The fake pipeline: one node per heading line, provenance = the source.
	handler.extraction.importNotes = async ({ filePath, text }) => {
		imports.push({ filePath, text });
		const id = notesSourceId(filePath);
		stores.graphStore.upsertSource({ id, filePath, importedAt: new Date().toISOString() });
		let nodes = 0;
		for (const line of text.split("\n").filter((l) => l.startsWith("# "))) {
			nodes++;
			stores.graphStore.appendNode({
				id: `n_${id.slice(4)}${nodes}`,
				name: line.slice(2),
				statement: `${line.slice(2)} es verdad.`,
				aliases: [],
				createdAt: new Date().toISOString(),
				provenance: [{ chatId: id, messageId: "" }],
			});
		}
		return { nodes, chains: 0 };
	};
});

beforeEach(() => {
	imports = [];
});

after(() => {
	vault.stopVaultSync();
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	fs.rmSync(VAULT, { recursive: true, force: true });
});

const nodeNames = () => [...new Set(stores.graphStore.readNodes().map((n) => n.name))].sort();

describe("vault sync", () => {
	it("reads only the chosen folders, never the output folder", async () => {
		write("Notas/uno.md", "# Gravedad\n");
		write("Diario/privado.md", "# Secreto\n");
		write(`${OUT}/x.md`, "# Bucle\n");
		write(".obsidian/app.md", "# Config\n");
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.deepEqual(imports.map((i) => i.filePath), ["Notas/uno.md"]);
		assert.deepEqual(nodeNames(), ["Gravedad"]);
	});

	it("skips unchanged notes on the next start", async () => {
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.deepEqual(imports, []);
	});

	it("replaces a changed note's contribution cleanly", async () => {
		write("Notas/uno.md", "# Inercia\n");
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.equal(imports.length, 1);
		assert.deepEqual(nodeNames(), ["Inercia"], "the old version's concept is gone");
	});

	it("removes a deleted note's contribution", async () => {
		write("Notas/dos.md", "# Masa\n");
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.deepEqual(nodeNames(), ["Inercia", "Masa"]);
		fs.rmSync(path.join(VAULT, "Notas/uno.md"));
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.deepEqual(nodeNames(), ["Masa"]);
		assert.ok(!stores.graphStore.readSources().some((s) => s.filePath === "Notas/uno.md"), "source record gone");
	});

	it("adopts a legacy manual import of the same file name", async () => {
		const { notesSourceId } = await import("../src/agent/subagents/extraction.ts");
		const legacy = notesSourceId("tres.md");
		stores.graphStore.upsertSource({ id: legacy, filePath: "tres.md", importedAt: new Date().toISOString() });
		stores.graphStore.appendNode({
			id: "n_legacy1", name: "Old English idea", statement: "x", aliases: [], createdAt: new Date().toISOString(),
			provenance: [{ chatId: legacy, messageId: "" }],
		});
		write("Notas/sub/tres.md", "# Energía\n");
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.deepEqual(nodeNames(), ["Energía", "Masa"]);
	});

	it("keeps a legacy manual import when the new extraction fails", async () => {
		const handler = await import("../src/server/chat-handler.ts");
		const { notesSourceId } = await import("../src/agent/subagents/extraction.ts");
		const legacy = notesSourceId("cuatro.md");
		stores.graphStore.upsertSource({ id: legacy, filePath: "cuatro.md", importedAt: new Date().toISOString() });
		stores.graphStore.appendNode({
			id: "n_legacy2", name: "Fuerza", statement: "x", aliases: [], createdAt: new Date().toISOString(),
			provenance: [{ chatId: legacy, messageId: "" }],
		});
		const working = handler.extraction.importNotes;
		handler.extraction.importNotes = async () => {
			throw new Error("catalog has no model");
		};
		try {
			write("Notas/cuatro.md", "# Aceleración\n");
			vault.reconfigureVault();
			await vault.whenVaultIdle();
			assert.ok(nodeNames().includes("Fuerza"), "the legacy import survives the failure");
		} finally {
			handler.extraction.importNotes = working;
		}
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		assert.ok(nodeNames().includes("Aceleración"));
		assert.ok(!nodeNames().includes("Fuerza"), "adopted once the retry succeeds");
	});

	it("writes concept notes and keeps the user's zone across rewrites", () => {
		vault.exportVaultNow();
		const rel = path.join(VAULT, OUT, "Conceptos", "Masa.md");
		const first = fs.readFileSync(rel, "utf-8");
		assert.ok(first.includes("Masa es verdad."));
		assert.ok(first.includes("[[Notas/dos|dos]]"), "links back to the vault note");
		fs.writeFileSync(rel, first.replace(`${USER_ZONE}\n\n`, `${USER_ZONE}\n\nApunte mío.\n`));
		vault.exportVaultNow();
		assert.ok(fs.readFileSync(rel, "utf-8").includes("Apunte mío."));
	});

	it("exports sessions and stamps deleted ones", () => {
		const chat = stores.chatStore.createChat("Leyes de Newton");
		stores.chatStore.saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "Enséñame inercia", timestamp: 0 },
		] as never);
		vault.reconfigureVault();
		const rel = path.join(VAULT, OUT, "Transcripciones", "Leyes de Newton.md");
		const text = fs.readFileSync(rel, "utf-8");
		assert.ok(text.includes('tipo: "transcripcion"'));
		assert.ok(text.includes("Enséñame inercia"));
		stores.chatStore.deleteChat(chat.id);
		vault.exportVaultNow();
		assert.ok(fs.readFileSync(rel, "utf-8").includes('estado: "eliminada"'));
	});
});

/**
 * The knowledge-folder connection (owner, 2026-11-01 as "Obsidian";
 * generalized 2026-11-04): the pure note format (both link styles)
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
	markdownLink,
	noteLink,
	restampManagedNote,
	safeNoteName,
	summaryNoteBody,
	summaryProseOf,
	wikilink,
} from "../src/core/vault-notes.ts";
import { normalizeVaultFolder, resolveObsidianFormat, sanitizeUserSettings } from "../src/core/settings.ts";

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

	it("writes relative, encoded Markdown links", () => {
		assert.equal(markdownLink("Naipes/Conceptos/A.md", "Naipes/Conceptos/Límite.md", "Límite"), "[Límite](L%C3%ADmite.md)");
		assert.equal(
			markdownLink("Naipes/Conceptos/A.md", "Naipes/Transcripciones/Leyes de Newton (abc123).md"),
			"[Leyes de Newton (abc123)](../Transcripciones/Leyes%20de%20Newton%20%28abc123%29.md)",
		);
		assert.equal(markdownLink("Recursos/Naipes/Conceptos/A.md", "Notas/dos.md"), "[dos](../../../Notas/dos.md)");
		assert.equal(markdownLink("A.md", "x/B.md", "a [b]"), "[a \\[b\\]](x/B.md)");
	});

	it("picks the link style from the Obsidian format switch", () => {
		assert.equal(noteLink(true, "Naipes/Conceptos/A.md", "Naipes/Conceptos/B.md", "B"), "[[Naipes/Conceptos/B|B]]");
		assert.equal(noteLink(false, "Naipes/Conceptos/A.md", "Naipes/Conceptos/B.md", "B"), "[B](B.md)");
	});

	it("rebuilds a summary's link lists without touching the prose", () => {
		const prose = "Primer párrafo.\n\nSegundo párrafo con - guion.";
		const old = summaryNoteBody("Sesión", prose, ["[[a|A]]", "B"], "[[t|Sesión]]");
		assert.equal(summaryProseOf(old), prose);
		assert.equal(summaryProseOf(summaryNoteBody("Sesión", prose, [], null)), prose);
		const rebuilt = summaryNoteBody("Sesión", summaryProseOf(old), ["[A](a.md)", "B"], "[Sesión](t.md)");
		assert.ok(rebuilt.includes(prose) && rebuilt.includes("- [A](a.md)") && !rebuilt.includes("[["));
	});
});

describe("obsidian settings section", () => {
	it("normalizes folders and refuses escapes", () => {
		assert.equal(normalizeVaultFolder("/a//b/"), "a/b");
		assert.equal(normalizeVaultFolder("a/../b"), null);
		assert.equal(normalizeVaultFolder(""), null);
		const record = sanitizeUserSettings({ version: 1, obsidian: { enabled: true, vaultPath: " /v ", folders: ["a", "a", "../x"], outputFolder: "/Out//Dir/" } });
		assert.deepEqual(record?.obsidian, { enabled: true, vaultPath: "/v", folders: ["a"], outputFolder: "Out/Dir" });
		assert.equal(sanitizeUserSettings({ version: 1, obsidian: { obsidianFormat: false } })?.obsidian?.obsidianFormat, false);
	});

	it("derives the Obsidian format: on for a pre-switch vault, off for a fresh install", () => {
		assert.equal(resolveObsidianFormat(undefined), false);
		assert.equal(resolveObsidianFormat({ vaultPath: "" }), false);
		assert.equal(resolveObsidianFormat({ vaultPath: "/v" }), true);
		assert.equal(resolveObsidianFormat({ vaultPath: "/v", obsidianFormat: false }), false);
		assert.equal(resolveObsidianFormat({ obsidianFormat: true }), true);
	});

	it("rejects bad PUT bodies", async () => {
		const { parseObsidianSettingsBody } = await import("../src/server/settings-body.ts");
		assert.equal(parseObsidianSettingsBody({ vaultPath: "relative" }).ok, false);
		assert.equal(parseObsidianSettingsBody({ outputFolder: "../escape" }).ok, false);
		assert.equal(parseObsidianSettingsBody({ folders: ["../escape"] }).ok, false);
		assert.deepEqual(parseObsidianSettingsBody({ enabled: true, folders: ["a/"] }), { ok: true, settings: { enabled: true, folders: ["a"] } });
		assert.equal(parseObsidianSettingsBody({ obsidianFormat: "yes" }).ok, false);
		assert.deepEqual(parseObsidianSettingsBody({ obsidianFormat: false }), { ok: true, settings: { obsidianFormat: false } });
	});
});

// ── the sync/export loop ─────────────────────────────────────────────────────

type VaultModule = typeof import("../src/server/vault.ts");
let vault: VaultModule;
let stores: typeof import("../src/server/stores.ts").stores;
let imports: Array<{ filePath: string; text: string; segments?: Array<{ text: string; page?: number }> }>;

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
	const { locLabel } = await import("../src/core/doc-chunks.ts");
	handler.extraction.importNotes = async ({ filePath, text, segments }) => {
		imports.push({ filePath, text, ...(segments ? { segments } : {}) });
		const loc = segments ? locLabel(segments) : undefined;
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
				provenance: [{ chatId: id, messageId: "", ...(loc ? { loc } : {}) }],
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

	it("pins the derived format on write and switches every note's links", async () => {
		const { PUT } = await import("../app/api/settings/[section]/route.ts");
		const { readSettingsRecord, writeSettingsRecord } = await import("../src/server/index.ts");
		const put = (body: unknown) =>
			PUT(new Request("http://localhost/api/settings/obsidian", { method: "PUT", body: JSON.stringify(body) }), {
				params: Promise.resolve({ section: "obsidian" }),
			});
		const section = { enabled: true, vaultPath: VAULT, folders: ["Notas", "Recursos"], outputFolder: OUT };
		const concept = path.join(VAULT, OUT, "Conceptos", "Masa.md");

		// A vault from before the switch: the first write pins ON.
		assert.equal((await put(section)).status, 200);
		assert.equal(readSettingsRecord()?.obsidian?.obsidianFormat, true);
		assert.ok(fs.readFileSync(concept, "utf-8").includes("[[Notas/dos|dos]]"));

		// Off: standard Markdown links, relative to the note.
		assert.equal((await put({ ...section, obsidianFormat: false })).status, 200);
		const plain = fs.readFileSync(concept, "utf-8");
		assert.ok(plain.includes("[dos](../../../Notas/dos.md)"), plain);
		assert.ok(!plain.includes("[["), "no wikilink is left");

		// A fresh install (no vault yet) stays OFF after choosing a folder.
		writeSettingsRecord({ ...readSettingsRecord()!, obsidian: { enabled: false } });
		assert.equal((await put(section)).status, 200);
		assert.equal(readSettingsRecord()?.obsidian?.obsidianFormat, false);
	});

	it("reads a PDF page by page and links its ideas to the page", async () => {
		const { makePdf } = await import("./doc-fixtures.ts");
		fs.writeFileSync(path.join(VAULT, "Notas", "optica.pdf"), makePdf(["# Refraccion", "# Reflexion"]));
		vault.reconfigureVault();
		await vault.whenVaultIdle();
		const pdf = imports.find((i) => i.filePath === "Notas/optica.pdf");
		assert.ok(pdf, "the PDF was extracted");
		assert.deepEqual(pdf!.segments?.map((seg) => seg.page), [1, 2]);
		assert.ok(nodeNames().includes("Refraccion"));
		vault.exportVaultNow();
		const concept = fs.readFileSync(path.join(VAULT, OUT, "Conceptos", "Refraccion.md"), "utf-8");
		assert.ok(concept.includes("[optica.pdf, pp. 1–2](../../../Notas/optica.pdf#page=1)"), concept);
	});

	it("holds a big document for confirmation: notice, «Ahora no», «Leer»", async () => {
		const { PUT } = await import("../app/api/settings/[section]/route.ts");
		const { subscribe } = await import("../src/core/events.ts");
		const { makePdf } = await import("./doc-fixtures.ts");
		const section = { enabled: true, vaultPath: VAULT, folders: ["Notas", "Recursos"], outputFolder: OUT, obsidianFormat: false, confirmAboveRuns: 1 };
		const res = await PUT(new Request("http://localhost/api/settings/obsidian", { method: "PUT", body: JSON.stringify(section) }), {
			params: Promise.resolve({ section: "obsidian" }),
		});
		assert.equal(res.status, 200);
		await vault.whenVaultIdle();
		imports.length = 0;
		const notices: unknown[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "vault-notice") notices.push(event);
		});
		try {
			// Two pages of ~5k tokens each: each page splits in two → 4 runs > 1.
			const long = (word: string) => `# ${word} ${"palabra ".repeat(2500)}`;
			fs.writeFileSync(path.join(VAULT, "Notas", "libro.pdf"), makePdf([long("Grande"), long("Enorme")]));
			vault.reconfigureVault();
			await vault.whenVaultIdle();
			assert.equal(imports.length, 0, "nothing extracted while waiting");
			assert.deepEqual(notices, [{ type: "vault-notice", kind: "pending", path: "Notas/libro.pdf", runs: 4, pages: 2 }]);
			assert.deepEqual(vault.pendingDocuments().map((d) => [d.path, d.runs, d.pages]), [["Notas/libro.pdf", 4, 2]]);

			assert.equal(vault.decidePendingDocument("Notas/libro.pdf", "later"), true);
			vault.reconfigureVault();
			await vault.whenVaultIdle();
			assert.equal(imports.length, 0, "«Ahora no» keeps it parked");
			assert.equal(notices.length, 1, "no second notice for the same content");
			assert.equal(vault.pendingDocuments()[0]?.deferred, true);

			assert.equal(vault.decidePendingDocument("Notas/libro.pdf", "read"), true);
			await vault.whenVaultIdle();
			assert.deepEqual(imports.map((i) => i.filePath), ["Notas/libro.pdf"]);
			assert.deepEqual(vault.pendingDocuments(), []);
			assert.equal(vault.decidePendingDocument("Notas/libro.pdf", "read"), false, "nothing left to decide");
		} finally {
			unsubscribe();
		}
	});
});

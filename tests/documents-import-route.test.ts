/**
 * Manual import of documents (phase 2, owner 2026-11-04): POST
 * /api/graph/import converts PDF/docx/epub/txt and holds a document over
 * the confirmation threshold back as needs_confirmation until the dialog
 * resends it with a "confirm" field. Plus the settings and bell pieces.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "np-docimport-"));
process.env.NP_DATA_DIR = TMP_DATA;
// Small chunks + threshold 1: a ~3k-char document is 2 runs → held back.
fs.writeFileSync(path.join(TMP_DATA, "settings.json"), JSON.stringify({ version: 1, graph: { extractionChunkTokens: 500 }, obsidian: { confirmAboveRuns: 1 } }));

const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction } = await import("../src/server/index.ts");
const { makeDocx, makeEpub } = await import("./doc-fixtures.ts");
const { parseObsidianSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { vaultNotice } = await import("../components/notices.tsx");

const original = extraction.importNotes;
after(() => {
	extraction.importNotes = original;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function request(files: File[], confirm: string[] = []) {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	for (const name of confirm) form.append("confirm", name);
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("converts documents, holds big ones back and imports them once confirmed", async () => {
	const calls: Array<{ filePath: string; segments?: unknown[] }> = [];
	extraction.importNotes = async ({ filePath, segments }) => {
		calls.push({ filePath, ...(segments ? { segments } : {}) });
		return { nodes: 1, chains: 0 };
	};
	const small = new File([makeEpub([{ title: "Uno", body: "Corto" }]) as BlobPart], "corto.epub");
	const big = new File([makeDocx(Array.from({ length: 30 }, (_, i) => ({ text: `Párrafo ${i} ${"texto ".repeat(15)}` }))) as BlobPart], "largo.docx");
	const first = await (await POST(request([small, big]))).json();
	const byName = Object.fromEntries(first.results.map((r: { filePath: string }) => [r.filePath, r]));
	assert.equal(byName["corto.epub"].outcome, "completed");
	assert.equal(byName["largo.docx"].outcome, "needs_confirmation");
	assert.equal(byName["largo.docx"].ok, false);
	assert.ok(byName["largo.docx"].runs > 1);
	assert.deepEqual(calls.map((c) => c.filePath), ["corto.epub"]);
	assert.deepEqual((calls[0]!.segments as Array<{ chapter?: string }>).map((s) => s.chapter), ["Uno"]);

	const second = await (await POST(request([big], ["largo.docx"]))).json();
	assert.equal(second.results[0].outcome, "completed");
	assert.deepEqual(calls.map((c) => c.filePath), ["corto.epub", "largo.docx"]);
});

it("validates the confirmation threshold", () => {
	assert.equal(parseObsidianSettingsBody({ confirmAboveRuns: 0 }).ok, false);
	assert.equal(parseObsidianSettingsBody({ confirmAboveRuns: 2.5 }).ok, false);
	assert.deepEqual(parseObsidianSettingsBody({ confirmAboveRuns: 3 }), { ok: true, settings: { confirmAboveRuns: 3 } });
	assert.equal(sanitizeUserSettings({ version: 1, obsidian: { confirmAboveRuns: -4 } })?.obsidian?.confirmAboveRuns, 1);
});

it("builds the bell notices for folder documents", () => {
	const now = new Date("2026-11-04T10:00:00Z");
	const pending = vaultNotice({ kind: "pending", path: "Libros/libro.pdf", runs: 38, pages: 312 }, now);
	assert.equal(pending.message, "notices.vaultPendingPages");
	assert.deepEqual(pending.vars, { file: "libro.pdf", runs: 38, pages: 312 });
	assert.equal(pending.pendingPath, "Libros/libro.pdf");
	assert.equal(vaultNotice({ kind: "pending", path: "a.docx", runs: 9 }, now).message, "notices.vaultPending");
	const ocr = vaultNotice({ kind: "ocr-missing", path: "scan.pdf", count: 3 }, now);
	assert.equal(ocr.tone, "warn");
	assert.equal(ocr.pendingPath, undefined);
});

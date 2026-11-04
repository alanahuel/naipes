/**
 * Documents in the knowledge folder (phase 2, owner 2026-11-04): segment
 * chunking + location labels (core/doc-chunks.ts), PDF / docx / epub / txt
 * conversion with the OCR seam and the hash cache (server/doc-text.ts), and
 * the desktop np:open-source path guard (electron/knowledge-source.cjs).
 * Fixtures are built in memory (tests/doc-fixtures.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "np-docs-data-"));
process.env.NP_DATA_DIR = TMP_DATA;

import { chunkSegments, estimateRuns, firstPageOf, locLabel } from "../src/core/doc-chunks.ts";
import { makeDocx, makeEpub, makePdf } from "./doc-fixtures.ts";

const { convertDocument, documentText, isDocumentFile, isNoteFile, ocrOverride } = await import("../src/server/doc-text.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => {
	ocrOverride.current = undefined;
});

describe("document segments", () => {
	it("labels page ranges and chapters", () => {
		assert.equal(locLabel([{ text: "a", page: 7 }]), "p. 7");
		assert.equal(locLabel([{ text: "a", page: 45 }, { text: "b", page: 52 }]), "pp. 45–52");
		assert.equal(locLabel([{ text: "a", chapter: "Uno" }]), "cap. «Uno»");
		assert.equal(locLabel([{ text: "a" }]), undefined);
		assert.equal(firstPageOf("pp. 45–52"), 45);
		assert.equal(firstPageOf("p. 7"), 7);
		assert.equal(firstPageOf("cap. «Uno»"), null);
	});

	it("packs pages under the budget without crossing a page", () => {
		const page = (n: number) => ({ text: "x".repeat(400 * 4), page: n }); // 400 tokens each
		const chunks = chunkSegments([1, 2, 3, 4, 5].map(page), 1000);
		assert.deepEqual(chunks.map((c) => c.loc), ["pp. 1–2", "pp. 3–4", "p. 5"]);
		assert.deepEqual(chunks.map((c) => c.firstPage), [1, 3, 5]);
		assert.equal(estimateRuns([1, 2, 3, 4, 5].map(page), 1000), 3);
	});

	it("splits a single over-budget page by line, keeping its location", () => {
		const big = { text: Array.from({ length: 10 }, () => "y".repeat(200 * 4)).join("\n"), page: 3 };
		const chunks = chunkSegments([{ text: "", page: 2 }, big], 500);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.loc === "p. 3"), "empty pages are skipped; pieces keep p. 3");
	});
});

describe("document conversion", () => {
	it("recognizes the readable kinds", () => {
		assert.ok(isNoteFile("a/b.md") && isNoteFile("x.PDF") && isNoteFile("x.epub") && isNoteFile("x.docx") && isNoteFile("x.txt"));
		assert.ok(!isNoteFile("x.png") && !isNoteFile("x.doc"));
		assert.ok(isDocumentFile("x.pdf") && !isDocumentFile("x.md"));
	});

	it("reads a PDF page by page and reports pages without text when OCR is missing", async () => {
		ocrOverride.current = { languages: () => null, recognize: async () => assert.fail("no OCR here") };
		const doc = await convertDocument("libro.pdf", makePdf(["Primera idea del libro", null, "Tercera pagina"]));
		assert.equal(doc.pages, 3);
		assert.deepEqual(doc.segments.map((s) => s.page), [1, 2, 3]);
		assert.equal(doc.segments[0]!.text, "Primera idea del libro");
		assert.deepEqual(doc.imagePages, [2]);
		assert.equal(doc.ocr, "unavailable");
	});

	it("runs local OCR on pages without text when available", async () => {
		const seen: string[][] = [];
		ocrOverride.current = {
			languages: () => ["spa", "eng"],
			recognize: async (png, langs) => {
				assert.ok(png.length > 0, "a rendered page");
				seen.push(langs);
				return "  Texto escaneado  ";
			},
		};
		const doc = await convertDocument("scan.pdf", makePdf(["Con texto suficiente aqui", null]));
		assert.equal(doc.ocr, "done");
		assert.equal(doc.segments[1]!.text, "Texto escaneado");
		assert.deepEqual(seen, [["spa", "eng"]]);
	});

	it("converts a docx to Markdown (headings, lists, tables)", async () => {
		const doc = await convertDocument("apuntes.docx", makeDocx([
			{ text: "Tema", style: "Heading1" },
			{ text: "Subtema", style: "Ttulo2" },
			{ text: "Un párrafo." },
			{ text: "punto", list: true },
		]));
		assert.equal(doc.segments.length, 1);
		assert.equal(doc.segments[0]!.text, "# Tema\n\n## Subtema\n\nUn párrafo.\n\n- punto\n\n| Celda A | Celda B |");
	});

	it("reads an epub in spine order, one chapter per segment", async () => {
		const doc = await convertDocument("libro.epub", makeEpub([{ title: "Uno", body: "Primero" }, { title: "Dos", body: "Segundo <b>fuerte</b>" }]));
		assert.deepEqual(doc.segments.map((s) => s.chapter), ["Uno", "Dos"]);
		assert.equal(doc.segments[1]!.text, "# Dos\n\nSegundo **fuerte**");
	});

	it("reads txt verbatim and rejects a broken docx", async () => {
		const doc = await convertDocument("n.txt", new TextEncoder().encode("hola\nmundo"));
		assert.equal(doc.segments[0]!.text, "hola\nmundo");
		await assert.rejects(convertDocument("roto.docx", new TextEncoder().encode("not a zip")));
	});

	it("caches a conversion by content hash (no second OCR)", async () => {
		let calls = 0;
		ocrOverride.current = { languages: () => ["eng"], recognize: async () => (calls++, "ocr") };
		const bytes = makePdf([null]);
		await documentText("c.pdf", bytes);
		await documentText("c.pdf", bytes);
		assert.equal(calls, 1);
		assert.ok(fs.readdirSync(path.join(TMP_DATA, "vault", "text")).some((f) => f.endsWith(".pdf.json")));
	});

	it("redoes a cached conversion once OCR becomes available", async () => {
		const bytes = makePdf(["Pagina con bastante texto", null, "otra mas"]);
		ocrOverride.current = { languages: () => null, recognize: async () => "x" };
		assert.equal((await documentText("d.pdf", bytes)).ocr, "unavailable");
		ocrOverride.current = { languages: () => ["eng"], recognize: async () => "ahora sí" };
		const again = await documentText("d.pdf", bytes);
		assert.equal(again.ocr, "done");
		assert.equal(again.segments[1]!.text, "ahora sí");
	});
});

describe("np:open-source path guard", () => {
	const require = createRequire(import.meta.url);
	const { knowledgeSourcePath } = require("../electron/knowledge-source.cjs") as { knowledgeSourcePath: (dataDir: string, rel: unknown) => string | null };
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-open-data-"));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-open-root-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "np-open-out-"));
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, obsidian: { vaultPath: root } }));
	fs.mkdirSync(path.join(root, "Libros"));
	fs.writeFileSync(path.join(root, "Libros", "libro.pdf"), "x");
	fs.writeFileSync(path.join(root, "script.sh"), "x");
	fs.writeFileSync(path.join(outside, "secreto.md"), "x");
	fs.symlinkSync(path.join(outside, "secreto.md"), path.join(root, "enlace.md"));
	after(() => {
		for (const dir of [dataDir, root, outside]) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a readable file inside the folder", () => {
		assert.equal(knowledgeSourcePath(dataDir, "Libros/libro.pdf"), fs.realpathSync(path.join(root, "Libros", "libro.pdf")));
	});

	it("refuses escapes, symlinks out, other kinds, folders and bad input", () => {
		assert.equal(knowledgeSourcePath(dataDir, `../${path.basename(outside)}/secreto.md`), null);
		assert.equal(knowledgeSourcePath(dataDir, "enlace.md"), null);
		assert.equal(knowledgeSourcePath(dataDir, "script.sh"), null);
		assert.equal(knowledgeSourcePath(dataDir, "Libros"), null);
		assert.equal(knowledgeSourcePath(dataDir, path.join(root, "Libros", "libro.pdf")), null);
		assert.equal(knowledgeSourcePath(dataDir, 42), null);
		assert.equal(knowledgeSourcePath(path.join(dataDir, "missing"), "Libros/libro.pdf"), null);
	});
});

/**
 * DOCUMENTS → TEXT (knowledge folder phase 2, owner 2026-11-04): PDF, epub,
 * docx and txt become ordered segments (core/doc-chunks.ts) the notes
 * pipeline extracts like any note.
 *
 *   PDF   pdfjs-dist, one segment per page (line breaks from `hasEOL`).
 *         Pages without a text layer (scans) go through LOCAL OCR when a
 *         `tesseract` binary is installed (languages: spa and/or eng among
 *         those it has); without it they are skipped and reported.
 *   docx  fflate opens the zip; word/document.xml → Markdown (headings,
 *         list items, tables as rows), parsed with linkedom.
 *   epub  fflate + the OPF spine order; each chapter's XHTML → Markdown
 *         with turndown; the chapter title is its first heading.
 *   txt   verbatim.
 *
 * Conversions are cached by content hash under data/vault/text/, so an
 * unchanged file is never converted (or OCR'd) twice.
 */

import * as crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser, parseHTML } from "linkedom";
import TurndownService from "turndown";
import { PATHS } from "../../config.ts";
import type { DocSegment } from "../core/doc-chunks.ts";
import { standardFontsDir } from "../agent/subagents/pdf-ops.ts";
import { getHeadless } from "../agent/subagents/headless.ts";

const execFileAsync = promisify(execFile);

// The note-format facts are pure (core/vault-notes.ts — the MCP read side
// lists the inbox without this module's converters); re-exported here.
export { NOTE_EXTENSIONS, DOCUMENT_EXTENSIONS, isNoteFile, isDocumentFile } from "../core/vault-notes.ts";

const extOf = (name: string) => path.extname(name).toLowerCase();

export interface ConvertedDocument {
	segments: DocSegment[];
	/** PDF page count. */
	pages?: number;
	/** PDF pages with no text layer. */
	imagePages: number[];
	/** What happened to `imagePages`: OCR'd, skipped (no tesseract), or n/a. */
	ocr: "done" | "unavailable" | "none";
}

// ─── OCR (local tesseract; test seam) ─────────────────────────────────────────

export interface OcrEngine {
	/** null = no OCR on this machine. */
	languages(): string[] | null;
	recognize(png: Buffer, languages: string[]): Promise<string>;
}

const tesseractEngine: OcrEngine = {
	languages() {
		const probe = spawnSync("tesseract", ["--list-langs"], { encoding: "utf-8", timeout: 10_000 });
		if (probe.error || probe.status !== 0) return null;
		const installed = `${probe.stdout}\n${probe.stderr}`.split(/\s+/).filter((l) => /^[a-z_]{3,}$/i.test(l));
		const wanted = ["spa", "eng"].filter((l) => installed.includes(l));
		return wanted.length > 0 ? wanted : installed.filter((l) => l !== "osd").slice(0, 1);
	},
	async recognize(png, languages) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-ocr-"));
		try {
			const file = path.join(dir, "page.png");
			fs.writeFileSync(file, png);
			const args = [file, "stdout", ...(languages.length > 0 ? ["-l", languages.join("+")] : [])];
			const { stdout } = await execFileAsync("tesseract", args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
			return stdout;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
};

/** Test seam — undefined in production. */
export const ocrOverride: { current?: OcrEngine } = {};
const ocrEngine = (): OcrEngine => ocrOverride.current ?? tesseractEngine;

/** OCR of a photo (exam materials, owner 2026-11-06): null = no OCR on
 *  this machine. */
export async function imageText(bytes: Uint8Array): Promise<string | null> {
	const languages = ocrEngine().languages();
	if (languages === null) return null;
	return ocrEngine().recognize(Buffer.from(bytes), languages);
}

/** A page with less text than this is treated as an image (a scan; a
 *  stray page number survives). OCR only replaces it when it reads more. */
const IMAGE_PAGE_CHARS = 10;

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function pdfToSegments(bytes: Uint8Array): Promise<ConvertedDocument> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await task.promise;
	const segments: DocSegment[] = [];
	const imagePages: number[] = [];
	try {
		for (let page = 1; page <= doc.numPages; page++) {
			const content = await (await doc.getPage(page)).getTextContent();
			let text = "";
			for (const item of content.items as Array<{ str?: unknown; hasEOL?: unknown }>) {
				if (typeof item.str === "string") text += item.str;
				if (item.hasEOL === true) text += "\n";
			}
			text = text.replace(/[ \t]+\n/g, "\n").trim();
			if (text.length < IMAGE_PAGE_CHARS) imagePages.push(page);
			segments.push({ text, page });
		}
	} finally {
		await task.destroy();
	}
	if (imagePages.length === 0) return { segments, pages: segments.length, imagePages, ocr: "none" };
	const languages = ocrEngine().languages();
	if (languages === null) return { segments, pages: segments.length, imagePages, ocr: "unavailable" };
	// Render the scanned pages (pdfjs + Skia, in-process) and read them.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-pdf-"));
	try {
		const file = path.join(dir, "doc.pdf");
		fs.writeFileSync(file, bytes);
		for (const rendered of await getHeadless().renderPdfPages(file, imagePages, { dpi: 200 })) {
			const text = (await ocrEngine().recognize(rendered.png, languages)).trim();
			const segment = segments[rendered.page - 1];
			if (segment && text.length > segment.text.length) segment.text = text;
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return { segments, pages: segments.length, imagePages, ocr: "done" };
}

// ─── docx ─────────────────────────────────────────────────────────────────────

interface XmlNode {
	nodeName: string;
	nodeType: number;
	textContent: string | null;
	childNodes: ArrayLike<XmlNode>;
	getAttribute?(name: string): string | null;
}

const children = (node: XmlNode): XmlNode[] => Array.from(node.childNodes ?? []);
const elements = (node: XmlNode, name: string): XmlNode[] => children(node).filter((c) => c.nodeName === name);

function descendants(node: XmlNode, name: string): XmlNode[] {
	const out: XmlNode[] = [];
	const walk = (n: XmlNode) => {
		for (const child of children(n)) {
			if (child.nodeName === name) out.push(child);
			walk(child);
		}
	};
	walk(node);
	return out;
}

/** A w:p's text: w:t runs, tabs and breaks, in document order. */
function paragraphText(p: XmlNode): string {
	let out = "";
	const walk = (n: XmlNode) => {
		for (const child of children(n)) {
			if (child.nodeName === "w:t") out += child.textContent ?? "";
			else if (child.nodeName === "w:tab") out += "\t";
			else if (child.nodeName === "w:br" || child.nodeName === "w:cr") out += "\n";
			else if (child.nodeName !== "w:pPr" && child.nodeName !== "w:instrText") walk(child);
		}
	};
	walk(p);
	return out;
}

/** Heading level from a paragraph style id ("Heading2", "Ttulo1", "Title"). */
function headingLevel(p: XmlNode): number {
	const style = descendants(p, "w:pStyle")[0]?.getAttribute?.("w:val") ?? "";
	if (/^(title|t[ií]?tulo)$/i.test(style)) return 1;
	const m = /^(heading|t[ií]?tulo|ttulo|berschrift)\s*(\d)$/i.exec(style);
	return m ? Math.min(Number(m[2]), 6) : 0;
}

export function docxToMarkdown(bytes: Uint8Array): string {
	const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
	const xml = files["word/document.xml"];
	if (!xml) throw new Error("not a Word document (word/document.xml is missing)");
	const doc = new DOMParser().parseFromString(strFromU8(xml), "text/xml") as unknown as XmlNode & { documentElement: XmlNode };
	const body = descendants(doc.documentElement, "w:body")[0];
	if (!body) return "";
	const blocks: string[] = [];
	for (const block of children(body)) {
		if (block.nodeName === "w:p") {
			const text = paragraphText(block).trim();
			if (!text) continue;
			const level = headingLevel(block);
			const listed = descendants(block, "w:numPr").length > 0;
			blocks.push(level > 0 ? `${"#".repeat(level)} ${text}` : listed ? `- ${text}` : text);
		} else if (block.nodeName === "w:tbl") {
			for (const row of elements(block, "w:tr")) {
				const cells = elements(row, "w:tc").map((cell) => elements(cell, "w:p").map(paragraphText).join(" ").trim());
				if (cells.some((c) => c.length > 0)) blocks.push(`| ${cells.join(" | ")} |`);
			}
		}
	}
	return blocks.join("\n\n");
}

// ─── epub ─────────────────────────────────────────────────────────────────────

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function resolveIn(base: string, href: string): string {
	const clean = decodeURIComponent(href.split("#")[0]!);
	return path.posix.normalize(path.posix.join(path.posix.dirname(base), clean)).replace(/^\.\//, "");
}

export function epubToSegments(bytes: Uint8Array): DocSegment[] {
	const files = unzipSync(bytes);
	const read = (name: string) => (files[name] ? strFromU8(files[name]!) : null);
	const container = read("META-INF/container.xml");
	if (!container) throw new Error("not an epub (META-INF/container.xml is missing)");
	const parser = new DOMParser();
	const rootfile = descendants(parser.parseFromString(container, "text/xml") as unknown as XmlNode, "rootfile")[0];
	const opfPath = rootfile?.getAttribute?.("full-path");
	const opfText = opfPath ? read(opfPath) : null;
	if (!opfPath || !opfText) throw new Error("not an epub (package document is missing)");
	const opf = parser.parseFromString(opfText, "text/xml") as unknown as XmlNode;
	const manifest = new Map<string, string>();
	for (const item of descendants(opf, "item")) {
		const id = item.getAttribute?.("id");
		const href = item.getAttribute?.("href");
		if (id && href) manifest.set(id, resolveIn(opfPath, href));
	}
	const segments: DocSegment[] = [];
	for (const ref of descendants(opf, "itemref")) {
		const file = manifest.get(ref.getAttribute?.("idref") ?? "");
		const html = file ? read(file) : null;
		if (!file || !html) continue;
		const { document } = parseHTML(html);
		const heading = document.querySelector("h1, h2, h3")?.textContent?.trim();
		const title = heading || document.querySelector("title")?.textContent?.trim() || path.posix.basename(file).replace(/\.x?html?$/i, "");
		const markdown = turndown.turndown(document.body?.innerHTML ?? html).trim();
		if (markdown.length > 0) segments.push({ text: markdown, chapter: title.replace(/\s+/g, " ").slice(0, 80) });
	}
	return segments;
}

// ─── the front door ───────────────────────────────────────────────────────────

/** Convert one document's bytes (by its file name's extension). */
export async function convertDocument(name: string, bytes: Uint8Array): Promise<ConvertedDocument> {
	switch (extOf(name)) {
		case ".pdf":
			return pdfToSegments(bytes);
		case ".docx":
			return { segments: [{ text: docxToMarkdown(bytes) }], imagePages: [], ocr: "none" };
		case ".epub":
			return { segments: epubToSegments(bytes), imagePages: [], ocr: "none" };
		default:
			return { segments: [{ text: Buffer.from(bytes).toString("utf-8") }], imagePages: [], ocr: "none" };
	}
}

const cacheDir = () => path.join(PATHS.data, "vault", "text");
export const contentHash = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** convertDocument behind the content-hash cache. A cached conversion whose
 *  OCR was unavailable is redone once OCR exists (tesseract installed later). */
export async function documentText(name: string, bytes: Uint8Array, hash = contentHash(bytes)): Promise<ConvertedDocument> {
	const file = path.join(cacheDir(), `${hash}${extOf(name)}.json`);
	try {
		const cached = JSON.parse(fs.readFileSync(file, "utf-8")) as ConvertedDocument;
		if (Array.isArray(cached.segments) && !(cached.ocr === "unavailable" && ocrEngine().languages() !== null)) return cached;
	} catch {
		// no cache yet
	}
	const converted = await convertDocument(name, bytes);
	fs.mkdirSync(cacheDir(), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(converted), "utf-8");
	fs.renameSync(tmp, file);
	return converted;
}

/** The joined text of a conversion (logs, empty checks). */
export const joinedText = (doc: ConvertedDocument): string => doc.segments.map((s) => s.text).join("\n\n");

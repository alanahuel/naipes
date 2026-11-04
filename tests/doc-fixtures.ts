/**
 * Synthetic document fixtures for the documents tests (phase 2, 2026-11-04):
 * built in memory — a hand-written PDF (text pages + one page with no text
 * layer), a minimal docx and a minimal epub. No binary files in the repo.
 */
import { strToU8, zipSync } from "fflate";

/** A PDF whose pages each show one line (null = a page with no text). */
export function makePdf(pages: Array<string | null>): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add("");
	const pagesObj = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const line of pages) {
		// Long text is wrapped into many tiny lines: pdf.js drops glyphs that
		// fall outside the page box.
		const escape = (t: string) => t.replace(/[()\\]/g, "\\$&");
		const lines = line === null ? [] : line.length <= 40 ? [line] : (line.match(/.{1,400}/g) ?? []);
		const size = lines.length > 1 || (line?.length ?? 0) > 40 ? 1 : 18;
		const stream = lines.length === 0 ? "" : `BT /F1 ${size} Tf ${size} TL 10 780 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(" ")} ET`;
		const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
	objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return strToU8(out);
}

export function makeDocx(paragraphs: Array<{ text: string; style?: string; list?: boolean }>): Uint8Array {
	const body = paragraphs
		.map(({ text, style, list }) => {
			const pPr = style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? "<w:numPr><w:numId w:val=\"1\"/></w:numPr>" : ""}</w:pPr>` : "";
			return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
		})
		.join("");
	const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Celda A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Celda B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
	return zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") });
}

export function makeEpub(chapters: Array<{ title: string; body: string }>): Uint8Array {
	const files: Record<string, Uint8Array> = {
		mimetype: strToU8("application/epub+zip"),
		"META-INF/container.xml": strToU8(
			'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		),
	};
	const items = chapters.map((_, i) => `<item id="c${i}" href="text/cap%20${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
	// Spine order deliberately differs from manifest order.
	const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
	files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${items}</manifest><spine>${spine}</spine></package>`);
	chapters.forEach(({ title, body }, i) => {
		files[`OEBPS/text/cap ${i}.xhtml`] = strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t${i}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`);
	});
	return zipSync(files);
}

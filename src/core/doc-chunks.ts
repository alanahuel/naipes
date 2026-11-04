/**
 * DOCUMENT SEGMENTS (knowledge folder phase 2, owner 2026-11-04) — pure.
 *
 * A converted document (PDF, epub, docx, txt) arrives as ordered segments:
 * one per PDF page, one per epub chapter, one for a whole docx/txt. The
 * notes pipeline packs them into extraction chunks under the chunk budget
 * WITHOUT crossing a segment boundary unless a single segment is itself
 * over budget (then it splits by line, keeping its location). Each chunk
 * knows what it covers — "pp. 45–52" or «cap. «Título»» — and that label
 * rides the provenance of every idea the chunk creates or touches
 * (ProvenancePoint.loc). No prompt change: location is chunk-granular.
 *
 * Browser-safe: no node imports.
 */

export interface DocSegment {
	text: string;
	/** 1-based PDF page. */
	page?: number;
	/** Epub chapter title (or the spine file name when untitled). */
	chapter?: string;
}

export interface DocChunk {
	text: string;
	/** Human location label, absent when the segments carry none. */
	loc?: string;
	/** First page covered (PDF) — the `#page=` anchor. */
	firstPage?: number;
}

/** Same estimate as everywhere else in the app: chars / 4. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A chunk's location label from the segments it covers. */
export function locLabel(segments: readonly DocSegment[]): string | undefined {
	const pages = segments.map((s) => s.page).filter((p): p is number => typeof p === "number");
	if (pages.length > 0) {
		const first = Math.min(...pages);
		const last = Math.max(...pages);
		return first === last ? `p. ${first}` : `pp. ${first}–${last}`;
	}
	const chapter = segments.find((s) => s.chapter)?.chapter;
	return chapter ? `cap. «${chapter}»` : undefined;
}

/** Split one over-budget text by line (a single over-budget line rides alone). */
function splitByLine(text: string, budget: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		const candidate = current.length === 0 ? line : `${current}\n${line}`;
		if (current.length > 0 && estimateTokens(candidate) > budget) {
			out.push(current);
			current = line;
		} else current = candidate;
	}
	if (current.trim().length > 0) out.push(current);
	return out;
}

/** Pack ordered segments into chunks of ≤ `budget` tokens. */
export function chunkSegments(segments: readonly DocSegment[], budget: number): DocChunk[] {
	const out: DocChunk[] = [];
	let texts: string[] = [];
	let covered: DocSegment[] = [];
	const flush = () => {
		const text = texts.join("\n\n");
		if (text.trim().length > 0) {
			const loc = locLabel(covered);
			const firstPage = covered.find((s) => typeof s.page === "number")?.page;
			out.push({ text, ...(loc ? { loc } : {}), ...(firstPage !== undefined ? { firstPage } : {}) });
		}
		texts = [];
		covered = [];
	};
	for (const segment of segments) {
		if (segment.text.trim().length === 0) continue;
		if (estimateTokens(segment.text) > budget) {
			flush();
			for (const piece of splitByLine(segment.text, budget)) {
				texts = [piece];
				covered = [segment];
				flush();
			}
			continue;
		}
		const candidate = [...texts, segment.text].join("\n\n");
		if (texts.length > 0 && estimateTokens(candidate) > budget) flush();
		texts.push(segment.text);
		covered.push(segment);
	}
	flush();
	return out;
}

/** How many extraction runs a document costs (one per chunk). */
export function estimateRuns(segments: readonly DocSegment[], budget: number): number {
	return chunkSegments(segments, budget).length;
}

/** The first page a "pp. 45–52" / "p. 7" label points at, else null. */
export function firstPageOf(loc: string | undefined): number | null {
	const m = loc ? /^pp?\. (\d+)/.exec(loc) : null;
	return m ? Number(m[1]) : null;
}

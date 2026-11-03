/**
 * THE OBSIDIAN NOTE FORMAT (owner, 2026-11-01) — pure rendering for the
 * app → vault direction. Every note the app writes has three parts:
 *
 *   ---                         frontmatter: the app's keys are rewritten,
 *   tipo: …                     any key the user adds survives untouched
 *   ---
 *   <!-- naipes:inicio --> the APP ZONE: regenerated on every export
 *   …
 *   <!-- naipes:fin -->
 *
 *   ## Mis notas                 the USER ZONE: everything outside the
 *                                markers is never touched by the app
 *
 * A note whose markers were removed is the user's: the app stops writing
 * it (composeManagedNote returns null). Pure core: no IO, no node imports.
 */

/** The default output folder (vault-relative; configurable in Settings →
 *  Obsidian). The output folder is always excluded from reading, so the app
 *  never re-extracts what it wrote itself. */
export const DEFAULT_VAULT_OUTPUT_FOLDER = "Naipes";

export const VAULT_SUBFOLDERS = {
	sessions: "Sesiones",
	transcripts: "Transcripciones",
	practice: "Prácticas",
	concepts: "Conceptos",
} as const;

export const MARK_START = "<!-- naipes:inicio -->";
export const MARK_END = "<!-- naipes:fin -->";
/** Markers written before the LearnHarness → Naipes rename (2026-11-03):
 *  still recognised, and replaced by the current ones on the next export. */
const LEGACY_MARKERS = [["<!-- learnharness:inicio -->", "<!-- learnharness:fin -->"]] as const;

/** The app zone's bounds in `text` (current markers first, then legacy):
 *  `from` is the start marker's index, `to` the index just past the end
 *  marker, `inner` the text between them. null = not a managed note. */
function findZone(text: string): { from: number; to: number; inner: string } | null {
	for (const [open, close] of [[MARK_START, MARK_END], ...LEGACY_MARKERS]) {
		const start = text.indexOf(open);
		const end = start === -1 ? -1 : text.indexOf(close, start);
		if (start !== -1 && end !== -1) return { from: start, to: end + close.length, inner: text.slice(start + open.length, end) };
	}
	return null;
}
export const USER_ZONE = "## Mis notas";

export type FrontmatterValue = string | string[];
export type FrontmatterFields = ReadonlyArray<readonly [string, FrontmatterValue]>;

/** Is a vault-relative path inside the app's own output folder? */
export function isInOutputFolder(relPath: string, outputFolder: string): boolean {
	return relPath === outputFolder || relPath.startsWith(`${outputFolder}/`);
}

/** A title as an Obsidian-safe file name (no extension): strips the
 *  characters file systems or wikilinks choke on, collapses whitespace,
 *  caps the length. Never empty. */
export function safeNoteName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	const capped = cleaned.length > 120 ? cleaned.slice(0, 120).trimEnd() : cleaned;
	return capped.length > 0 ? capped : "Sin título";
}

/** `[[path/without/ext|label]]` — path links resolve even when another
 *  vault note shares the base name. */
export function wikilink(relPath: string, label?: string): string {
	const target = relPath.replace(/\.md$/i, "");
	const text = label ?? target.split("/").pop() ?? target;
	return `[[${target}|${text.replace(/[[\]|]/g, " ")}]]`;
}

function yamlScalar(value: string): string {
	// JSON strings are valid YAML double-quoted scalars.
	return JSON.stringify(value);
}

function renderField(key: string, value: FrontmatterValue): string {
	if (Array.isArray(value)) {
		return value.length === 0 ? `${key}: []` : `${key}:\n${value.map((v) => `  - ${yamlScalar(v)}`).join("\n")}`;
	}
	return `${key}: ${yamlScalar(value)}`;
}

/** Split a note into its frontmatter entries (ordered key → raw lines)
 *  and the rest. No frontmatter = empty entries, rest = whole text. */
function splitFrontmatter(text: string): { entries: Array<[string, string]>; rest: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { entries: [], rest: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { entries: [], rest: normalized };
	const block = normalized.slice(4, end);
	const after = normalized.slice(end + 4).replace(/^\n/, "");
	const entries: Array<[string, string]> = [];
	for (const line of block.split("\n")) {
		const key = /^([A-Za-z0-9_\-áéíóúñÁÉÍÓÚÑ]+):/.exec(line)?.[1];
		if (key !== undefined) entries.push([key, line]);
		else if (entries.length > 0) entries[entries.length - 1]![1] += `\n${line}`;
	}
	return { entries, rest: after };
}

/** The app's fields first (their order), then every key the user added. */
function mergeFrontmatter(existing: Array<[string, string]>, fields: FrontmatterFields): string {
	const managed = new Set(fields.map(([key]) => key));
	const lines = [
		...fields.map(([key, value]) => renderField(key, value)),
		...existing.filter(([key]) => !managed.has(key)).map(([, raw]) => raw),
	];
	return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * The next text of a managed note, or null when the note must not be
 * touched (the user removed a marker). `existing` null = a new note.
 */
export function composeManagedNote(existing: string | null, fields: FrontmatterFields, body: string): string | null {
	const zone = `${MARK_START}\n${body.trim()}\n${MARK_END}`;
	if (existing === null) {
		return `${mergeFrontmatter([], fields)}${zone}\n\n${USER_ZONE}\n\n`;
	}
	const { entries, rest } = splitFrontmatter(existing);
	const found = findZone(rest);
	if (!found) return null;
	return `${mergeFrontmatter(entries, fields)}${rest.slice(0, found.from)}${zone}${rest.slice(found.to)}`;
}

/**
 * Rewrite only some frontmatter fields of a managed note, keeping both
 * zones byte-identical (the "eliminada" stamp). null = not managed.
 */
export function restampManagedNote(existing: string, fields: FrontmatterFields): string | null {
	const { entries, rest } = splitFrontmatter(existing);
	if (!findZone(rest)) return null;
	const replaced = new Map(fields.map(([key, value]) => [key, renderField(key, value)]));
	const keys = new Set(entries.map(([key]) => key));
	const lines = [
		...entries.map(([key, raw]) => replaced.get(key) ?? raw),
		...fields.filter(([key]) => !keys.has(key)).map(([key, value]) => renderField(key, value)),
	];
	return `---\n${lines.join("\n")}\n---\n${rest}`;
}

/** The managed zone's text (between the markers), or null. */
export function managedZoneOf(text: string): string | null {
	return findZone(text)?.inner.trim() ?? null;
}

// ─── concept notes ────────────────────────────────────────────────────────────

export interface ConceptNoteInput {
	id: string;
	name: string;
	statement: string;
	aliases: string[];
	/** Each chain concluding this concept: its premises as wikilinks. */
	derivedFrom: string[][];
	/** Each chain using this concept as a premise: the conclusion link plus
	 *  the other premises it is used together with. */
	leadsTo: Array<{ conclusion: string; together: string[] }>;
	/** Where the concept came from: vault notes and session notes (links). */
	sources: string[];
}

export function conceptNoteBody(input: ConceptNoteInput): string {
	const out: string[] = [`# ${input.name}`, "", input.statement];
	if (input.aliases.length > 0) out.push("", `**También:** ${input.aliases.join(" · ")}`);
	if (input.derivedFrom.length > 0) {
		out.push("", "## Se sigue de", "", ...input.derivedFrom.map((premises) => `- ${premises.join(" + ")}`));
	}
	if (input.leadsTo.length > 0) {
		out.push(
			"",
			"## Permite concluir",
			"",
			...input.leadsTo.map(({ conclusion, together }) =>
				together.length > 0 ? `- ${conclusion} (junto con ${together.join(" + ")})` : `- ${conclusion}`,
			),
		);
	}
	if (input.sources.length > 0) out.push("", "## Fuentes", "", ...input.sources.map((s) => `- ${s}`));
	return out.join("\n");
}

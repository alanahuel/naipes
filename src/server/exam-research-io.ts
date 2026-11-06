/**
 * The exam research's inputs from the outside world (owner-approved
 * 2026-11-06): the search seam — Claude Code's own WebSearch when it is
 * connected (one small `claude -p` call per query, only WebSearch allowed,
 * on the cheap slot's model when that is a Claude Code model), else the
 * configured Tavily/Brave engine — and the learner's material files as
 * text (documents converted, photos OCR'd).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_CODE_MODEL_IDS, CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { ExamMaterial } from "../core/exams.ts";
import type { SearchHit, SearchProvider } from "../core/search.ts";
import { claudeCodeBackgroundAllowed, claudeCodeEnv, findClaudeBinary, refreshClaudeCodeStatus } from "../agent/claude-code-bridge.ts";
import { documentText, imageText, isDocumentFile, joinedText } from "./doc-text.ts";
import { searchProvider } from "./search.ts";
import { effectiveSettings } from "./stores.ts";
import { materialPath } from "../store/exams.ts";

const SEARCH_TIMEOUT_MS = 120_000;

/** The Claude Code model a search call runs on: the cheap slot's, else
 *  the strong slot's, when they are Claude Code models. */
function searchModelId(): string {
	const { models } = effectiveSettings();
	for (const slot of [models.cheap, models.strong]) {
		if (slot?.provider === CLAUDE_CODE_PROVIDER && slot.id) return slot.id;
	}
	return CLAUDE_CODE_MODEL_IDS[CLAUDE_CODE_MODEL_IDS.length - 1]!;
}

/** Parse WebSearch's tool result ("… Links: [{title,url}…] …"). */
export function parseClaudeSearchResult(text: string, count: number): SearchHit[] {
	const at = text.indexOf("Links:");
	if (at < 0) return [];
	const start = text.indexOf("[", at);
	if (start < 0) return [];
	let depth = 0;
	let end = -1;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "[") depth++;
		else if (ch === "]" && --depth === 0) {
			end = i;
			break;
		}
	}
	if (end < 0) return [];
	let links: unknown;
	try {
		links = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(links)) return [];
	const rest = text.slice(end + 1).replace(/\s+/g, " ").trim().slice(0, 600);
	return links
		.filter((l): l is { title?: unknown; url: string } => l !== null && typeof l === "object" && typeof (l as { url?: unknown }).url === "string")
		.slice(0, count)
		.map((l, i) => ({ title: typeof l.title === "string" ? l.title : l.url, url: l.url, snippet: i === 0 ? rest : "" }));
}

/** Pull the WebSearch tool result text out of a stream-json run. */
export function searchResultFromStream(stdout: string): string | null {
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: { type?: string; message?: { content?: Array<{ type?: string; content?: unknown }> } };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "user") continue;
		for (const block of event.message?.content ?? []) {
			if (block.type !== "tool_result") continue;
			if (typeof block.content === "string") return block.content;
			if (Array.isArray(block.content)) return block.content.map((c: { text?: string }) => c.text ?? "").join("\n");
		}
	}
	return null;
}

export function claudeCodeSearchProvider(): SearchProvider {
	return {
		id: "claude-code",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const binary = await findClaudeBinary();
			if (!binary) throw new Error("Claude Code is not installed");
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "np-search-"));
			const prompt = `Use WebSearch exactly once with this query, then stop: ${query}`;
			const args = [
				"-p", "--output-format", "stream-json", "--verbose",
				"--tools", "WebSearch", "--allowedTools", "WebSearch",
				"--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
				"--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
				"--max-turns", "1", "--model", searchModelId(), prompt,
			];
			try {
				const stdout = await new Promise<string>((resolve, reject) => {
					const child = spawn(binary, args, { cwd, env: claudeCodeEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
					let out = "";
					let err = "";
					const timer = setTimeout(() => child.kill("SIGTERM"), SEARCH_TIMEOUT_MS);
					child.stdout.on("data", (d) => (out += d));
					child.stderr.on("data", (d) => (err += d));
					child.on("error", reject);
					child.on("close", () => {
						clearTimeout(timer);
						// max-turns 1 ends the run right after the tool result: a
						// non-zero exit is expected; the result is what matters.
						if (out.trim()) resolve(out);
						else reject(new Error(`Claude Code search failed: ${err.slice(0, 300)}`));
					});
				});
				const result = searchResultFromStream(stdout);
				if (result === null) throw new Error("Claude Code returned no search result");
				return parseClaudeSearchResult(result, count);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

/** The exam research's search (owner-approved order): Claude Code's own
 *  search when connected and allowed in the background, else the
 *  configured engine, else none. */
export async function examSearchProvider(): Promise<SearchProvider | null> {
	await refreshClaudeCodeStatus().catch(() => null);
	if (claudeCodeBackgroundAllowed()) return claudeCodeSearchProvider();
	return searchProvider();
}

// ─── materials ──────────────────────────────────────────────────────────────

const PART_CHARS = 40_000;
const IMAGE_RE = /\.(png|jpe?g|webp|heic)$/i;

const textCache = new Map<string, string>();

async function materialFullText(examId: string, material: ExamMaterial): Promise<string> {
	const key = `${examId}/${material.file}`;
	const cached = textCache.get(key);
	if (cached !== undefined) return cached;
	const file = material.file ? materialPath(examId, material.file) : null;
	if (!file) throw new Error("not a stored file");
	const bytes = new Uint8Array(fs.readFileSync(file));
	let text: string;
	if (/\.(md|txt)$/i.test(material.name)) text = Buffer.from(bytes).toString("utf-8");
	else if (isDocumentFile(material.name)) text = joinedText(await documentText(material.name, bytes));
	else if (IMAGE_RE.test(material.name)) {
		const ocr = await imageText(bytes);
		if (ocr === null) throw new Error("this photo can't be read: OCR (tesseract) is not installed");
		text = ocr;
	} else throw new Error("unsupported material format");
	textCache.set(key, text);
	return text;
}

/** One part of a material's text for read_material. */
export async function readMaterialPart(examId: string, materials: readonly ExamMaterial[], id: string, offset: number): Promise<string> {
	const material = materials.find((m) => m.id === id);
	if (!material) return `read_material: unknown material id ${id}`;
	if (material.kind === "link") return `read_material: ${material.name} is a link — open it with web_fetch (${material.url}).`;
	let text: string;
	try {
		text = await materialFullText(examId, material);
	} catch (err) {
		return `read_material: ${material.name} could not be read — ${err instanceof Error ? err.message : String(err)}`;
	}
	if (!text.trim()) return `read_material: ${material.name} has no readable text.`;
	const part = text.slice(offset, offset + PART_CHARS);
	const next = offset + PART_CHARS < text.length ? `\n\n[… ${text.length - offset - PART_CHARS} more characters — call read_material with offset ${offset + PART_CHARS}]` : "";
	return `${material.name} (characters ${offset}–${offset + part.length} of ${text.length}):\n\n${part}${next}`;
}

"use client";

import { useRef, useState } from "react";
import { translator, useT, type Translate } from "@/components/i18n";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy" | "needs_confirmation";
	/** needs_confirmation: the estimate to show before «Leer». */
	runs?: number;
	pages?: number;
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[], t: Translate = translator("en")): NotesImportResult[] {
	const invalid = () => new Error(t("graph.import.invalidResponse"));
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy", "needs_confirmation"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["runs", "pages"] as const) if (r[field] !== undefined && (!Number.isInteger(r[field]) || r[field]! < 0)) throw invalid();
		if (r.outcome === "needs_confirmation" && r.runs === undefined) throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

/** What the import file pickers accept (Markdown, text and documents). */
export const NOTES_IMPORT_ACCEPT = ".md,.markdown,.txt,.pdf,.docx,.epub";

export async function postNotesImport(files: readonly File[], t: Translate = translator("en"), confirm: readonly string[] = []): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	for (const name of confirm) form.append("confirm", name);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error(t("graph.import.invalidResponse")); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(t("graph.import.requestFailed", { status: response.status, detail }));
	}
	return parseNotesImportResults(body, files, t);
}

/** Only error text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const t = useT();
	const [errors, setErrors] = useState<string[]>([]);
	const [importing, setImporting] = useState(false);
	/** Big documents the server held back (phase 2): «Leer» resends one. */
	const [toConfirm, setToConfirm] = useState<Array<{ file: File; runs: number; pages?: number }>>([]);
	const pending = useRef(false);
	const submit = async (files: File[], confirm: readonly string[] = []) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		setErrors([]);
		try {
			callbacks.onStart?.();
			const results = await postNotesImport(files, t, confirm);
			const held = results.filter((r) => r.outcome === "needs_confirmation");
			setToConfirm((list) => [
				...list.filter((entry) => !files.includes(entry.file)),
				...held.map((r) => ({ file: files[r.requestIndex]!, runs: r.runs!, ...(r.pages !== undefined ? { pages: r.pages } : {}) })),
			]);
			setErrors(results
				.filter((result) => !result.ok && result.outcome !== "needs_confirmation")
				.sort((a, b) => a.requestIndex - b.requestIndex)
				.map((r) => `${r.filePath}: ${r.error}${r.code ? `\n${r.code}${r.provider ? ` — ${r.provider}` : ""}${r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}${r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}` : ""}`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setErrors(files.map((file) => `${file.name}: ${message}`));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		errors, importing, toConfirm,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
		confirmImport: (file: File) => void submit([file], [file.name]),
		dismissImport: (file: File) => setToConfirm((list) => list.filter((entry) => entry.file !== file)),
	};
}

/** The held-back big documents: estimate + «Leer» / «Ahora no». */
export function NotesImportConfirm({ notesImport }: { notesImport: ReturnType<typeof useNotesImport> }) {
	const t = useT();
	return <>{notesImport.toConfirm.map(({ file, runs, pages }) => (
		<div key={file.name} role="alert" className="flex max-w-full flex-wrap items-center gap-2 text-xs text-foreground">
			<span className="min-w-0 break-words">
				{pages !== undefined
					? t("graph.import.confirmPages", { file: file.name, pages, runs })
					: t("graph.import.confirmRuns", { file: file.name, runs })}
			</span>
			<button type="button" className="rounded-sm border border-border px-2 py-0.5 hover:border-muted-foreground/50" disabled={notesImport.importing} onClick={() => notesImport.confirmImport(file)}>
				{t("graph.import.read")}
			</button>
			<button type="button" className="rounded-sm px-2 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => notesImport.dismissImport(file)}>
				{t("graph.import.notNow")}
			</button>
		</div>
	))}</>;
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-warn">{error}</p>
	))}</>;
}

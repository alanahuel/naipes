/**
 * Local Whisper models on disk (owner, 2026-11-08): Settings → Dictation
 * downloads, cancels and deletes them; the renderer's engine reads them
 * through GET /stt-models/… (app/stt-models — outside /api because Web
 * Worker requests never carry the desktop capability header; the files
 * are public, pinned model weights).
 *
 * Layout: <data>/models/whisper/whisper-<id>/<file>. A download writes
 * into whisper-<id>.part/, verifies every file's size AND sha256 against
 * the pinned manifest (core/whisper.ts), then renames the folder into
 * place — a model folder only exists once it is complete. Cancel aborts
 * the fetch and removes the .part folder; delete removes the model folder.
 * Progress lives in memory (one entry per model) and is polled.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	WHISPER_MODELS,
	whisperModel,
	whisperModelBytes,
	whisperModelDir,
	type WhisperModelId,
} from "../core/whisper.ts";

export type WhisperModelState = "missing" | "downloading" | "ready" | "error";

export interface WhisperModelStatus {
	id: WhisperModelId;
	label: string;
	bytes: number;
	state: WhisperModelState;
	/** Bytes received so far (downloading only). */
	received?: number;
	error?: string;
}

interface Download {
	controller: AbortController;
	received: number;
	done: Promise<void>;
}

export function createWhisperModelStore(opts: { root: string; fetch?: typeof fetch }) {
	const doFetch = opts.fetch ?? fetch;
	const downloads = new Map<WhisperModelId, Download>();
	const errors = new Map<WhisperModelId, string>();

	const finalDir = (id: WhisperModelId) => path.join(opts.root, whisperModelDir(id));
	const partDir = (id: WhisperModelId) => finalDir(id) + ".part";

	function ready(id: WhisperModelId): boolean {
		const dir = finalDir(id);
		return whisperModel(id).files.every((f) => {
			try {
				return fs.statSync(path.join(dir, f.path)).size === f.size;
			} catch {
				return false;
			}
		});
	}

	function statuses(): WhisperModelStatus[] {
		return WHISPER_MODELS.map((m) => {
			const base = { id: m.id, label: m.label, bytes: whisperModelBytes(m.id) };
			const dl = downloads.get(m.id);
			if (dl) return { ...base, state: "downloading", received: dl.received };
			if (ready(m.id)) return { ...base, state: "ready" };
			const error = errors.get(m.id);
			return error ? { ...base, state: "error", error } : { ...base, state: "missing" };
		});
	}

	async function fetchFile(id: WhisperModelId, file: (typeof WHISPER_MODELS)[number]["files"][number], dl: Download) {
		const info = whisperModel(id);
		const url = `https://huggingface.co/${info.repo}/resolve/${info.revision}/${file.path}`;
		const res = await doFetch(url, { signal: dl.controller.signal, redirect: "follow" });
		if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${file.path}`);
		const target = path.join(partDir(id), file.path);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const hash = createHash("sha256");
		const out = fs.createWriteStream(target);
		let size = 0;
		try {
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				hash.update(value);
				size += value.byteLength;
				dl.received += value.byteLength;
				if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", resolve));
			}
		} finally {
			await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
		}
		if (size !== file.size || hash.digest("hex") !== file.sha256) {
			throw new Error(`Verification failed for ${file.path}`);
		}
	}

	/** Start (or join) a model download. Already ready → no-op. */
	function start(id: WhisperModelId): void {
		if (downloads.has(id) || ready(id)) return;
		errors.delete(id);
		const dl: Download = { controller: new AbortController(), received: 0, done: Promise.resolve() };
		downloads.set(id, dl);
		dl.done = (async () => {
			try {
				fs.rmSync(partDir(id), { recursive: true, force: true });
				for (const file of whisperModel(id).files) await fetchFile(id, file, dl);
				fs.rmSync(finalDir(id), { recursive: true, force: true });
				fs.renameSync(partDir(id), finalDir(id));
			} catch (e) {
				fs.rmSync(partDir(id), { recursive: true, force: true });
				if (!dl.controller.signal.aborted) {
					errors.set(id, e instanceof Error ? e.message : String(e));
					console.warn(`[whisper] ${id} download failed:`, e);
				}
			} finally {
				downloads.delete(id);
			}
		})();
	}

	/** Downloading → cancel (partial files removed); otherwise delete the
	 *  model folder. Resolves once the disk reflects it. */
	async function cancelOrDelete(id: WhisperModelId): Promise<void> {
		const dl = downloads.get(id);
		if (dl) {
			dl.controller.abort();
			await dl.done;
			return;
		}
		errors.delete(id);
		fs.rmSync(finalDir(id), { recursive: true, force: true });
	}

	/** Absolute path of a servable model file, or null. Only manifest files
	 *  of a READY model resolve — nothing else under the data dir can. */
	function file(dirName: string, relPath: string): { path: string; size: number } | null {
		const model = WHISPER_MODELS.find((m) => whisperModelDir(m.id) === dirName);
		if (!model || downloads.has(model.id)) return null;
		const entry = model.files.find((f) => f.path === relPath);
		if (!entry) return null;
		const abs = path.join(finalDir(model.id), entry.path);
		try {
			const size = fs.statSync(abs).size;
			return size === entry.size ? { path: abs, size } : null;
		} catch {
			return null;
		}
	}

	return { statuses, start, cancelOrDelete, file, ready, whenSettled: (id: WhisperModelId) => downloads.get(id)?.done ?? Promise.resolve() };
}

// One registry per process (globalThis, jobs.ts's pattern): Next can load
// this module once per route bundle, and every route must see the same
// in-flight downloads.
const g = globalThis as typeof globalThis & { __npWhisperModels?: ReturnType<typeof createWhisperModelStore> };
const store = (g.__npWhisperModels ??= createWhisperModelStore({ root: PATHS.whisperModels }));

export const whisperModelStatuses = store.statuses;
export const startWhisperDownload = store.start;
export const cancelOrDeleteWhisperModel = store.cancelOrDelete;
export const whisperModelFile = store.file;

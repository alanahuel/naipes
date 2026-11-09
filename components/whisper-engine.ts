"use client";

/**
 * The local Whisper engine, main-thread side (owner, 2026-11-08): one
 * app-lifetime Web Worker (components/whisper-worker.ts) that keeps the
 * chosen model loaded once the first dictation asked for it.
 *
 * Device: WebGPU when the browser exposes a REAL adapter; otherwise WASM
 * (owner: works anyway, with a notice in Settings — phase 0 measured
 * Small on WASM at ~54 s for 43 s of audio). A SwiftShader / fallback
 * adapter is CPU emulation and counts as "no GPU" (it never finished a
 * transcription in the spike).
 */
import { WHISPER_DTYPE, whisperModelDir, type WhisperModelId } from "@/src/core";
import type { WhisperDevice, WhisperModelRef, WhisperRequest, WhisperResponse } from "@/components/whisper-worker";

export type { WhisperDevice };

/** Phase 0: a SwiftShader adapter never finished a transcription. */
export function isRealGpuAdapter(info: { architecture?: string; vendor?: string; isFallbackAdapter?: boolean } | null | undefined): boolean {
	if (!info) return false;
	if (info.isFallbackAdapter) return false;
	return !/swiftshader/i.test(`${info.architecture ?? ""} ${info.vendor ?? ""}`);
}

type GpuLike = { requestAdapter(): Promise<{ info?: { architecture?: string; vendor?: string; isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null> };

let devicePromise: Promise<WhisperDevice> | null = null;

/** WebGPU with a real GPU, else WASM. Memoized for the window's life. */
export function whisperDevice(): Promise<WhisperDevice> {
	devicePromise ??= (async () => {
		try {
			const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
			const adapter = await gpu?.requestAdapter();
			if (!adapter) return "wasm";
			const info = { ...adapter.info, isFallbackAdapter: adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter };
			return isRealGpuAdapter(info) ? "webgpu" : "wasm";
		} catch {
			return "wasm";
		}
	})();
	return devicePromise;
}

/** A worker that has not said "ready" by then failed to start (its module
 *  threw while evaluating — no error event reaches us for that). */
export const WHISPER_BOOT_TIMEOUT_MS = 30_000;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

function fail(w: Worker, error: Error) {
	for (const entry of pending.values()) entry.reject(error);
	pending.clear();
	w.terminate();
	if (worker === w) worker = null;
}

function ensureWorker(): Worker {
	if (worker) return worker;
	const w = new Worker(new URL("./whisper-worker.ts", import.meta.url), { type: "module" });
	const boot = setTimeout(() => fail(w, new Error("Whisper engine did not start")), WHISPER_BOOT_TIMEOUT_MS);
	w.onmessage = (event: MessageEvent<WhisperResponse>) => {
		const res = event.data;
		if ("ready" in res) {
			clearTimeout(boot);
			return;
		}
		const entry = pending.get(res.id);
		if (!entry) return;
		pending.delete(res.id);
		if (res.ok) entry.resolve(res.text ?? "");
		else entry.reject(new Error(res.error));
	};
	w.onerror = (event) => {
		// A crashed worker fails everything in flight; the next call starts a fresh one.
		clearTimeout(boot);
		fail(w, new Error(event.message || "Whisper engine crashed"));
	};
	worker = w;
	return w;
}

type Request = WhisperRequest extends infer R ? R extends WhisperRequest ? Omit<R, "id" | "device"> : never : never;

async function send(req: Request, transfer: Transferable[] = []): Promise<string> {
	const device = await whisperDevice();
	const id = nextId++;
	const w = ensureWorker();
	return new Promise<string>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		w.postMessage({ ...req, id, device } as WhisperRequest, transfer);
	});
}

const ref = (model: WhisperModelId): WhisperModelRef => ({ dir: whisperModelDir(model), dtype: { ...WHISPER_DTYPE } });

/** Warm the model (called when a run starts — loading overlaps the speech). */
export function prepareWhisper(model: WhisperModelId): Promise<void> {
	return send({ type: "load", model: ref(model) }).then(() => {});
}

/** Transcribe 16 kHz mono PCM. `language` null = auto-detect. */
export function transcribeWhisper(model: WhisperModelId, audio: Float32Array, language: string | null): Promise<string> {
	return send({ type: "transcribe", model: ref(model), audio, language }, [audio.buffer]);
}

/** The worklet's linear16 frames (Int16Array, public/worklets/pcm-capture.js)
 *  → one Float32 buffer (−1..1) at the capture rate (16 kHz). */
export function pcm16ToFloat32(frames: readonly (Int16Array | ArrayBuffer)[]): Float32Array {
	const views = frames.map((f) => (f instanceof Int16Array ? f : new Int16Array(f, 0, f.byteLength >> 1)));
	let total = 0;
	for (const v of views) total += v.length;
	const out = new Float32Array(total);
	let o = 0;
	for (const view of views) {
		for (let i = 0; i < view.length; i++) out[o++] = view[i]! / 32768;
	}
	return out;
}

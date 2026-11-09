/// <reference lib="webworker" />
/**
 * The local Whisper engine's Web Worker (owner, 2026-11-08). Runs
 * transformers.js (web build → onnxruntime-web) off the main thread so the
 * mel spectrogram and decoding loop never jank the page. Driven only by
 * components/whisper-engine.ts.
 *
 * Files come from the app itself, never the network: model weights from
 * GET /stt-models/whisper-<id>/… (a RELATIVE localModelPath — transformers
 * 4.3.2 skips its local metadata check for full URLs, phase-0 finding),
 * the ONNX runtime from /ort/ (scripts/copy-ort-wasm.mjs).
 *
 * Imports NOTHING from the app (not even the core barrel): the barrel
 * pulls markdown helpers that touch `document`, which a worker lacks.
 * The main thread sends the model folder and dtype with every request.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

export type WhisperDevice = "webgpu" | "wasm";

/** The model as the worker needs it: its folder under /stt-models/ and the
 *  per-half dtype (core/whisper.ts whisperModelDir + WHISPER_DTYPE). */
export interface WhisperModelRef {
	dir: string;
	dtype: Record<string, string>;
}

export type WhisperRequest =
	| { type: "load"; id: number; model: WhisperModelRef; device: WhisperDevice }
	| { type: "transcribe"; id: number; model: WhisperModelRef; device: WhisperDevice; audio: Float32Array; language: string | null };

export type WhisperResponse =
	| { id: number; ok: true; text?: string }
	| { id: number; ok: false; error: string }
	/** Posted once the module evaluated — the engine's boot handshake. */
	| { ready: true };

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/stt-models/";
env.useBrowserCache = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = new URL("/ort/", self.location.origin).href;

let loaded: { key: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function load(model: WhisperModelRef, device: WhisperDevice): Promise<AutomaticSpeechRecognitionPipeline> {
	const key = `${model.dir}:${device}`;
	if (loaded?.key === key) return loaded.asr;
	const previous = loaded;
	loaded = null;
	void previous?.asr.then((asr) => asr.dispose()).catch(() => {});
	const asr = pipeline("automatic-speech-recognition", model.dir, {
		device,
		dtype: model.dtype as never,
	}) as Promise<AutomaticSpeechRecognitionPipeline>;
	const entry = { key, asr };
	loaded = entry;
	// A failed load must not stick: the next request retries from scratch.
	asr.catch(() => { if (loaded === entry) loaded = null; });
	return asr;
}

// Requests run strictly in order (one model, one GPU queue).
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<WhisperRequest>) => {
	const req = event.data;
	queue = queue.then(async () => {
		try {
			const asr = await load(req.model, req.device);
			if (req.type === "load") {
				self.postMessage({ id: req.id, ok: true } satisfies WhisperResponse);
				return;
			}
			const out = await asr(req.audio, {
				...(req.language ? { language: req.language } : {}),
				task: "transcribe",
				// Long dictations: 30 s windows, 5 s overlap (Whisper's native span).
				chunk_length_s: 30,
				stride_length_s: 5,
			});
			const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
			self.postMessage({ id: req.id, ok: true, text } satisfies WhisperResponse);
		} catch (e) {
			self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies WhisperResponse);
		}
	});
};

// Boot handshake: a worker whose module fails to evaluate never gets here,
// and the engine fails its requests instead of waiting forever.
self.postMessage({ ready: true } satisfies WhisperResponse);
